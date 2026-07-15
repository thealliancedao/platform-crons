// =============================================================================
// dex-data / lib / bucket-truth.js — gauge-truth bucket classification (1.1.0)
// =============================================================================
// THE FIX (defect register #8, evidence 2026-07-15): bucket labels were derived
// from `total_staked_balances` MEMBERSHIP on the 4 staking contracts — i.e.
// where LP happens to be STAKED — which disagrees with the gauge's own
// classification exactly where cross-bucket strays exist. Cross-check against
// token-catalog's gauge truth found 3 Astroport mislabels (LUNA-SOLID
// stable→project, USDC-USDT bluechip→single, LUNA-WHALE null→project) and the
// SkeletonSwap adapter labeling NOTHING (27 gauge pools bucket:null).
//
// THE TRUTH SOURCE: `whitelisted_asset_details` on the same 4 bucket contracts
// — the gauge's own classification, the COMPLETE set (active + below-threshold
// + dewhitelisted, each flagged `whitelisted:true|false`). Same source
// token-catalog's discovery uses (its Phase-0 scar: this query, NOT
// `whitelisted_assets`, which is active-only).
//
// PAIR RESOLUTION (so BOTH adapters join on pool_address, self-contained,
// no reads of other crons' output):
//   cw20 LP asset    -> `{minter:{}}` on the LP token -> pair address
//   native factory LP -> `factory/{pair}/…uLP` denom  -> pair address parsed
//   single-asset gauge entries resolve to non-pair addresses (or fail minter);
//   harmless — no dex pool carries that pool_address. Everything is also kept
//   in byAsset so nothing is dropped.
//
// AMBIGUITY, HONESTLY: an asset appearing under MULTIPLE buckets keeps ALL
// appearances. Resolution prefers whitelisted:true entries; among several the
// first in canonical bucket order wins and `ambiguous_buckets` carries the
// rest — flagged, never silently picked. Dewhitelisted-only assets keep their
// bucket with `whitelisted:false` (still gauge-registered, take-rate exposed).
//
// FAILURE, HONESTLY: per-bucket query failures are recorded and the map builds
// from what succeeded; if EVERY bucket query fails, ok:false — adapters emit
// bucket:null + meta.bucket_errors. We never fall back to staked-membership:
// a missing label is honest, a wrong one is not.
//
// Memoized per process — the orchestrator runs adapters sequentially in one
// process, so the ~4 + N-minter queries happen once per run.
// =============================================================================
'use strict';

const { STAKING_BUCKETS, BUCKETS } = require('../../config/contracts.js');

// Injectable chain access (mock gate stubs this; production default wired below).
const CH = { queryContract: null };
try { CH.queryContract = require('./fetch').queryContract; } catch (_) { /* mock supplies it */ }

const MINTER_CONCURRENCY = 4;

function parseFactoryPair(nativeDenom) {
    // factory/{pairAddr}/.../uLP — pair addr is the 2nd segment, uLP the last
    const parts = String(nativeDenom || '').split('/');
    if (parts[0] === 'factory' && parts.length >= 3 && parts[parts.length - 1] === 'uLP') return parts[1];
    return null;
}

async function mapWithConcurrency(items, limit, fn) {
    const results = new Array(items.length);
    let idx = 0;
    async function worker() {
        while (true) {
            const i = idx++;
            if (i >= items.length) return;
            try { results[i] = { ok: true, value: await fn(items[i], i) }; }
            catch (e) { results[i] = { ok: false, error: e }; }
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, Math.max(items.length, 1)) }, worker));
    return results;
}

// Resolve one asset's bucket appearances -> { bucket, whitelisted,
// ambiguous_buckets? } per the honesty rules above. Pure — mock-gated directly.
function resolveBucket(appearances) {
    const on = appearances.filter(a => a.whitelisted);
    const pick = (list) => {
        const ordered = BUCKETS.filter(b => list.some(a => a.bucket === b));
        return { bucket: ordered[0], others: ordered.slice(1) };
    };
    if (on.length) {
        const { bucket, others } = pick(on);
        return { bucket, whitelisted: true, ...(others.length || appearances.length > on.length
            ? { ambiguous_buckets: [...new Set(appearances.filter(a => a.bucket !== bucket).map(a => a.bucket))] } : {}) };
    }
    const { bucket, others } = pick(appearances);
    return { bucket, whitelisted: false, ...(others.length ? { ambiguous_buckets: others } : {}) };
}

let memo = null;

async function fetchBucketTruth() {
    if (memo) return memo;
    const queryContract = CH.queryContract;
    if (typeof queryContract !== 'function') throw new Error('bucket-truth: no queryContract available');

    const errors = {};
    const appearancesByAsset = new Map();   // assetKey -> [{bucket, whitelisted}]
    const infoByAsset = new Map();          // assetKey -> raw info (for pair resolution)
    let bucketsOk = 0;

    for (const [bucket, addr] of Object.entries(STAKING_BUCKETS)) {
        let result = null;
        try { result = await queryContract(addr, { whitelisted_asset_details: {} }); }
        catch (e) { errors[bucket] = e.message || 'query failed'; continue; }
        let list = result;
        if (result && typeof result === 'object' && !Array.isArray(result)) {
            list = result.data || result.assets || result.whitelisted_assets || result.list || [];
        }
        if (!Array.isArray(list)) { errors[bucket] = 'unexpected response shape'; continue; }
        bucketsOk++;
        for (const entry of list) {
            const info = entry && entry.info;
            const key = info && (info.cw20 ? `cw20:${info.cw20}` : info.native ? `native:${info.native}` : null);
            if (!key) continue;
            if (!appearancesByAsset.has(key)) { appearancesByAsset.set(key, []); infoByAsset.set(key, info); }
            appearancesByAsset.get(key).push({ bucket, whitelisted: entry.whitelisted === true });
        }
    }

    const byAsset = {};   // assetKey -> { bucket, whitelisted, ambiguous_buckets? }
    for (const [key, apps] of appearancesByAsset) byAsset[key] = resolveBucket(apps);

    // pair resolution
    const byPair = {};    // pairAddr -> { ...byAsset entry, gauge_pool_id }
    const cw20Keys = [], minterErrors = {};
    for (const [key, info] of infoByAsset) {
        if (info.native) {
            const pair = parseFactoryPair(info.native);
            if (pair) byPair[pair] = { ...byAsset[key], gauge_pool_id: key };
        } else if (info.cw20) cw20Keys.push(key);
    }
    const minterResults = await mapWithConcurrency(cw20Keys, MINTER_CONCURRENCY, async (key) => {
        const d = await queryContract(infoByAsset.get(key).cw20, { minter: {} });
        const pair = d && (d.minter || (d.data && d.data.minter));
        if (!pair) throw new Error('no minter in response');
        return pair;
    });
    minterResults.forEach((r, i) => {
        const key = cw20Keys[i];
        if (r.ok) byPair[r.value] = { ...byAsset[key], gauge_pool_id: key };
        else minterErrors[key] = r.error.message || 'minter query failed';
    });

    memo = {
        ok: bucketsOk > 0,
        source: 'whitelisted_asset_details (gauge truth) + LP minter pair resolution',
        byPair, byAsset,
        errors: Object.keys(errors).length ? errors : null,
        minter_errors: Object.keys(minterErrors).length ? minterErrors : null,
        stats: { buckets_ok: bucketsOk, assets: appearancesByAsset.size, pairs_resolved: Object.keys(byPair).length },
    };
    return memo;
}

// Pure join an adapter applies per pool — mock-gated directly.
// Returns { bucket, tla_relevant, gauge } where gauge carries the honest
// extras (whitelisted flag, ambiguity, gauge_pool_id) for `raw`.
function joinBucket(truth, poolAddress) {
    const hit = truth && truth.ok ? truth.byPair[poolAddress] : null;
    if (!hit) return { bucket: null, tla_relevant: false, gauge: null };
    return {
        bucket: hit.bucket,
        tla_relevant: true,
        gauge: {
            gauge_pool_id: hit.gauge_pool_id,
            whitelisted: hit.whitelisted,
            ...(hit.ambiguous_buckets ? { ambiguous_buckets: hit.ambiguous_buckets } : {}),
        },
    };
}

const _resetForTests = () => { memo = null; };

module.exports = { fetchBucketTruth, joinBucket, resolveBucket, parseFactoryPair, CH, _resetForTests };
