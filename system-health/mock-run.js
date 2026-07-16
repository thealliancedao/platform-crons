#!/usr/bin/env node
'use strict';
// =============================================================================
// system-health mock gate (SPEC-system-health D6 — BINDING before deploy)
// In-memory REPO stub behind T.githubApiRequest. Covers: all-ok pass, one
// violation per invariant, like-for-like skip, missing-input honesty,
// price-history day-key freshness, one-off exemption, history append
// never-shrink, coverage-drop alarm.
// =============================================================================
const M = require('./index.js');

let PASS = 0, FAIL = 0;
function check(name, cond, extra) {
    if (cond) { PASS++; console.log(`  ✓ ${name}`); }
    else      { FAIL++; console.log(`  ✗ ${name}${extra ? ' — ' + JSON.stringify(extra).slice(0, 220) : ''}`); }
}

// ---------------------------------------------------------------------------- repo stub
let REPO = {};
let WRITES = {};
M.T.githubApiRequest = async (method, apiPath, body, accept) => {
    const m = apiPath.match(/\/contents\/([^?]+)/);
    const path = m && decodeURIComponent(m[1]);
    if (method === 'GET') {
        if (accept === 'application/vnd.github.raw') {
            if (path in REPO) return JSON.stringify(REPO[path]);
            const err = new Error('404'); err.statusCode = 404; throw err;
        }
        if (path in REPO) return { sha: 'stub-sha' };
        const err = new Error('404'); err.statusCode = 404; throw err;
    }
    if (method === 'PUT') {
        const obj = JSON.parse(Buffer.from(body.content, 'base64').toString());
        REPO[path] = obj; WRITES[path] = (WRITES[path] || 0) + 1;
        return { ok: true };
    }
    throw new Error('unexpected method ' + method);
};
const NOW = new Date('2026-07-16T12:00:00Z');
M.T.now = () => NOW;

// ---------------------------------------------------------------------------- fixture builders
const H = (iso) => ({ capturedAt: iso, status: 'ok' });
function healthyRepo() {
    const gen = '2026-07-16T10:00:00Z';
    return {
        'member-data/snapshots/current.json': { meta: { generated_at: gen }, system: { vp_voting_per_bucket: { stable: 1000, project: 2000 } } },
        'token-catalog/snapshots/current.json': { meta: { generated_at: gen }, pools: [
            { bucket: 'stable',  gauge_status: 'active', total_vp: String(600 * 1e6), distribution_pct: 0.6, architecture: { pair_address: 'pairA' }, gauge_pool_id: 'g1', underlyings: ['x'] },
            { bucket: 'stable',  gauge_status: 'active', total_vp: String(399 * 1e6), distribution_pct: 0.4, architecture: { pair_address: 'pairB' }, gauge_pool_id: 'g2', underlyings: ['x'] },
            { bucket: 'project', gauge_status: 'active', total_vp: String(1995 * 1e6), distribution_pct: 1.0, architecture: { pair_address: 'pairC' }, gauge_pool_id: 'g3', underlyings: ['x'] },
            { bucket: 'project', gauge_status: 'dewhitelisted', total_vp: String(5000 * 1e6), distribution_pct: 0.9, gauge_pool_id: 'g4' },  // inactive: excluded everywhere, counts unresolved
        ], tokens: [ { denom: 'tokA', discovered: { symbol: 'A' } }, { denom: 'tokB', discovered: {} } ] },   // real shape: list + discovered
        'dex-data/index.json': { meta: {}, dexes: [{ id: 'astroport', enabled: true }] },
        'dex-data/astroport/snapshots/current.json': { meta: { generated_at: gen }, pools: [
            { pool_name: 'P1', pool_address: 'pairA', bucket: 'stable',  tvl_usd: 100, raw: { staked_liquidity_usd: 60 } },
            { pool_name: 'P2', pool_address: 'pairC', bucket: 'project', tvl_usd: 500, raw: { staked_liquidity_usd: 400 } },
            { pool_name: 'NOT-TLA', pool_address: 'pairZ', bucket: null, tvl_usd: 9, raw: { staked_liquidity_usd: 90 } },  // no bucket → INV5 skip; INV2 STILL checks it? yes both sides exist → would violate! keep <= : fix to 5
        ] },
        'tla-voting/events/heartbeat.json': { capturedAt: '2026-07-16T11:00:00Z', status: 'ok' },  // no bribe_capture yet
        'member-data/snapshots/heartbeat.json': { generated_at: '2026-07-16T02:00:00Z', status: 'ok' },   // real shape: generated_at, no capturedAt
        'token-catalog/snapshots/heartbeat.json': H('2026-07-16T10:00:00Z'),
        'dex-data/astroport/snapshots/heartbeat.json': { generated_at: '2026-07-16T11:00:00Z' },
        'dex-data/skeletonswap/snapshots/heartbeat.json': { generated_at: '2026-07-16T11:00:00Z' },
        'tla-voting/vote-state/heartbeat.json': H('2026-07-13T00:00:00Z'),
        'tla-voting/bribe-state/heartbeat.json': H('2026-07-13T00:00:00Z'),
        'tla-voting/distributions/heartbeat.json': H('2026-07-13T00:00:00Z'),
        'nfts/adao/snapshots/heartbeat.json': H('2026-07-16T11:00:00Z'),
        'nfts/adao/flows/heartbeat.json': H('2026-07-16T11:00:00Z'),
        'nfts/adao/provenance/heartbeat.json': { ran_at: '2026-07-08T00:00:00Z' },   // ancient — must be EXEMPT
        'price-history/2026/07.json': { meta: {}, days: { '2026-07-14': {}, '2026-07-15': {} } },   // latest day 26h < 50h → fresh
    };
}
// fix the healthy fixture note above: NOT-TLA pool must satisfy INV2
function fixNotTla(repo) { repo['dex-data/astroport/snapshots/current.json'].pools[2].raw.staked_liquidity_usd = 5; return repo; }

(async () => {
    console.log('— R1: all-ok pass —');
    REPO = fixNotTla(healthyRepo()); WRITES = {};
    let out = await M.run();
    check('R1 overall skipped-not-violation (bribe_capture pending)', out.meta.status === 'skipped', out.meta.status);
    for (const k of ['bucket_vp_consistency', 'staked_le_depth', 'distribution_fractions_sum', 'bucket_label_agreement', 'heartbeat_freshness', 'identity_resolution'])
        check(`R1 ${k} ok`, out.invariants[k].status === 'ok', out.invariants[k]);
    check('R1 tribute skipped + declared', out.invariants.tribute_stream_coverage.status === 'skipped' && /not yet published/.test(out.invariants.tribute_stream_coverage.detail));
    check('R1 INV1 measured rows carry both sides', Array.isArray(out.invariants.bucket_vp_consistency.measured) && out.invariants.bucket_vp_consistency.measured[0].catalog_active_sum_vp > 0);
    check('R1 INV7 counts inactive-unresolved pool', out.invariants.identity_resolution.measured.unresolved_pools === 1 && out.invariants.identity_resolution.measured.tokens_without_identity === 1, out.invariants.identity_resolution.measured);
    check('R1 current.json written', WRITES['system-health/current.json'] === 1);
    check('R1 history appended', REPO['system-health/history/2026/07.json'].runs.length === 1);
    check('R1 heartbeat written', REPO['system-health/heartbeat.json'].version.includes('system-health'));
    check('R1 one-off exempt', JSON.stringify(out.invariants.heartbeat_freshness.measured).includes('exempt (one-off)'));

    console.log('— R2: one violation per invariant —');
    // INV1 drift: member stable 1000 vs catalog 999 ok; bump member to 1200 (20% drift)
    REPO['member-data/snapshots/current.json'].system.vp_voting_per_bucket.stable = 1200;
    // INV2: staked > tvl
    REPO['dex-data/astroport/snapshots/current.json'].pools[0].raw.staked_liquidity_usd = 150;
    // INV3: break a fraction
    REPO['token-catalog/snapshots/current.json'].pools[1].distribution_pct = 0.35;
    // INV5: catalog says project for pairA while dex says stable
    REPO['token-catalog/snapshots/current.json'].pools[0].bucket = 'project';
    // INV6: stale product
    REPO['token-catalog/snapshots/heartbeat.json'].capturedAt = '2026-07-15T00:00:00Z';   // 36h > 6h
    out = await M.run();
    check('R2 INV1 violation names #4', out.invariants.bucket_vp_consistency.status === 'violation' && /#4/.test(out.invariants.bucket_vp_consistency.detail), out.invariants.bucket_vp_consistency);
    check('R2 INV2 violation lists pool', out.invariants.staked_le_depth.status === 'violation' && out.invariants.staked_le_depth.measured[0].pool === 'P1');
    check('R2 INV3 violation names bucket', out.invariants.distribution_fractions_sum.status === 'violation' && 'stable' in out.invariants.distribution_fractions_sum.measured);
    check('R2 INV5 violation carries both stamps', out.invariants.bucket_label_agreement.status === 'violation' && out.invariants.bucket_label_agreement.measured[0].catalog_as_of, out.invariants.bucket_label_agreement.measured);
    check('R2 INV6 violation lists stale product', out.invariants.heartbeat_freshness.status === 'violation' && JSON.stringify(out.invariants.heartbeat_freshness.measured.stale).includes('token-catalog'));
    check('R2 overall = violation', out.meta.status === 'violation');
    check('R2 history now 2 runs (never-shrink)', REPO['system-health/history/2026/07.json'].runs.length === 2);

    console.log('— R3: like-for-like skip + missing-input honesty —');
    REPO = fixNotTla(healthyRepo());
    REPO['member-data/snapshots/current.json'].meta.generated_at = '2026-07-15T23:00:00Z';   // different DAY
    delete REPO['token-catalog/snapshots/current.json'];                                     // catalog missing entirely
    delete REPO['dex-data/astroport/snapshots/current.json'];
    out = await M.run();
    check('R3 INV1 skipped (catalog absent)', out.invariants.bucket_vp_consistency.status === 'skipped');
    check('R3 INV3 skipped + declared', out.invariants.distribution_fractions_sum.status === 'skipped' && /absent/.test(out.invariants.distribution_fractions_sum.detail));
    check('R3 INV2 skipped (no dex)', out.invariants.staked_le_depth.status === 'skipped');
    check('R3 INV5 skipped', out.invariants.bucket_label_agreement.status === 'skipped');
    check('R3 no crash, overall violation (catalog heartbeat present but current absent → freshness still evaluates)', ['violation', 'skipped'].includes(out.meta.status));

    console.log('— R3b: same-epoch different-day skip (addendum) —');
    REPO = fixNotTla(healthyRepo());
    REPO['member-data/snapshots/current.json'].meta.generated_at = '2026-07-15T23:59:00Z';
    out = await M.run();
    check('R3b INV1 skipped on day mismatch', out.invariants.bucket_vp_consistency.status === 'skipped' && /same day/.test(out.invariants.bucket_vp_consistency.detail));

    console.log('— R4: price-history day-key freshness —');
    REPO = fixNotTla(healthyRepo());
    REPO['price-history/2026/07.json'].days = { '2026-07-10': {} };   // 6 days old > 50h
    out = await M.run();
    check('R4 price-history stale via day key', out.invariants.heartbeat_freshness.status === 'violation' && JSON.stringify(out.invariants.heartbeat_freshness.measured.stale).includes('price-history'));

    console.log('— R5: coverage drop alarm —');
    REPO = fixNotTla(healthyRepo());
    REPO['tla-voting/events/heartbeat.json'].bribe_capture = { mean: 0.9, per_denom: { uluna: 0.95, astro: 0.9 } };
    out = await M.run();   // first observation — baseline
    check('R5a first observation ok (no baseline)', out.invariants.tribute_stream_coverage.status === 'ok' && /first observation/.test(out.invariants.tribute_stream_coverage.detail));
    REPO['tla-voting/events/heartbeat.json'].bribe_capture = { mean: 0.8, per_denom: { uluna: 0.7, astro: 0.9 } };   // uluna dropped
    out = await M.run();
    check('R5b drop → violation with denom named', out.invariants.tribute_stream_coverage.status === 'violation' && out.invariants.tribute_stream_coverage.measured.drops[0].denom === 'uluna', out.invariants.tribute_stream_coverage.measured);
    REPO['tla-voting/events/heartbeat.json'].bribe_capture = { mean: 0.92, per_denom: { uluna: 0.96, astro: 0.9 } };   // recovered/increase
    out = await M.run();
    check('R5c increase → ok, no drops', out.invariants.tribute_stream_coverage.status === 'ok' && /no drops/.test(out.invariants.tribute_stream_coverage.detail));

    console.log('— R6: history never-shrink guard —');
    REPO['system-health/history/2026/07.json'].runs.length ? null : null;
    const runsBefore = REPO['system-health/history/2026/07.json'].runs.length;
    out = await M.run();
    check('R6 append exactly one', REPO['system-health/history/2026/07.json'].runs.length === runsBefore + 1);
    check('R6 run summary carries coverage baseline', REPO['system-health/history/2026/07.json'].runs.at(-1).tribute_coverage.per_denom.uluna === 0.96);

    console.log(`\n=== MOCK GATE: ${PASS} passed, ${FAIL} failed ===`);
    process.exit(FAIL ? 1 : 0);
})().catch(e => { console.error('GATE CRASH:', e); process.exit(1); });
