// =============================================================================
// tla-voting / lib / vote-state.js — per-period vote-state harvest
// =============================================================================
// SPEC-tla-voting-capture-fix §3 (approved 2026-07-15). The COMPLETENESS +
// ATTRIBUTION layer the Rev 4 verdict forced: the gauge's `gauge/vote` wasm
// event emits only {action, vp} — wrapped votes CANNOT be attributed from
// events. So once per period this harvest asks the chain directly:
//
//   escrow all_tokens → lock_info per token → distinct OWNERS (the complete
//   possible electorate, enumerated FRESH every harvest — never a hardcoded
//   list; D4) ∪ wallets_seen (cumulative — keeps recently-withdrawn voters
//   visible one more period) → gauge user_info per wallet → the full
//   allocation WITH period stamps.
//
// Any gauge_votes entry stamped P = that actor voted in P. Votion vaults,
// DAO DAO executions, Polytone proxies, and silent tx-index drops are all
// caught BY CONSTRUCTION — this layer never watches transactions at all, and
// the gauge cannot forget. The FIRST harvest is the heal of the Rev 4 misses.
//
// PERIOD-STAMP FIELD CAVEAT: the stamp's exact field name inside each
// gauge_votes entry is probe-observed but not yet pinned in queries.md. The
// parser is tolerant (`period` / `vote_period` / `last_vote_period`) AND every
// record retains `raw_gauge_votes` VERBATIM — if the field name differs, no
// information is lost and a one-line parser fix + reprocess recovers stamps.
// Pin it with one browser probe before relying on stamp-derived fields.
//
// TIMING HONESTY (spec §3): user_info returns CURRENT state; stamps carry only
// the LAST vote period per gauge. Harvest early in each period → the previous
// period's final allocations are intact except immediate re-voters (entries
// stamped > harvested period are flagged post_flip_change, never guessed).
// Pre-harvest history beyond each actor's last-vote stamp is honestly
// unrecoverable — the chain never emitted it.
//
// SELF-START: unlike the event streams, vote-state MAY start itself — an empty
// product has no history to clobber, and the first harvest is the heal.
// Dedup ((period,wallet)) + never-shrink still apply on every write.
//
// COMPLETION MODE (F2 without all-or-nothing): individual user_info failures
// land in index.pending_wallets; last_harvested_period advances ONLY when
// pending is empty. The next run retries pending only (state is retained —
// lateness within the period is free). A FAILED ENUMERATION (all_tokens /
// lock_info) aborts the whole harvest instead: an incomplete universe is the
// exact failure mode this layer exists to close (reconcile rule).
//
// vote_capture (SPEC-tla-voting-reconcile §4 fold-in): on full harvests, the
// events replay (last event per wallet|gauge) is compared against the SAME
// user_info results → MATCH / MISMATCH / CHAIN_ONLY / EVENTS_ONLY counts +
// match_rate — the permanent capture-integrity alarm, published in the cron
// heartbeat. Skipped in completion mode (partial universe = invalid rate).
// =============================================================================
'use strict';

const C = require('../../config/contracts.js');
const D = require('./distributions.js');   // httpGetHard, fetchDistributions, sleep — one transport, zero drift

const LCD_PRIMARY  = process.env.LCD_PRIMARY  || 'https://terra-lcd.publicnode.com';
const LCD_FALLBACK = process.env.LCD_FALLBACK || 'https://terra-rest.publicnode.com';

const GAUGE_CONTROLLER = C.GAUGE_CONTROLLER.addr;
const VOTING_ESCROW    = C.VOTING_ESCROW.addr;

const VS_DIR = 'tla-voting/vote-state';
const VS_SCHEMA_VERSION = 1;
const ALL_TOKENS_PAGE = 30;
const CONC = Number(process.env.VS_CONCURRENCY || 5);   // ≤5 — publicnode tolerance (binding)
const PACE_MS = Number(process.env.VS_PACE_MS || 150);
const FETCH_RETRIES = 3;
const DETAIL_CAP = 25;

const sleep = D.sleep;

// ---- chain access (injectable: mock-run.js replaces CH.* — the reconcile
// MOCK_FIXTURES pattern, module-level so the whole surface stubs from one place)
function smartPath(addr, queryObj) {
    const b64 = Buffer.from(JSON.stringify(queryObj)).toString('base64');
    return `/cosmwasm/wasm/v1/contract/${addr}/smart/${encodeURIComponent(b64)}`;
}
async function realQueryContract(addr, queryObj) {
    let lastErr = null;
    for (let attempt = 0; attempt < FETCH_RETRIES; attempt++) {
        const base = attempt % 2 === 0 ? LCD_PRIMARY : LCD_FALLBACK;
        try {
            const res = await D.httpGetHard(base + smartPath(addr, queryObj));
            return res && res.data !== undefined ? res.data : res;
        } catch (e) {
            lastErr = e;
            if (e.statusCode && e.body && /query wasm contract failed|not found|Generic error|ve3_shared/i.test(e.body)) { e.contractError = true; throw e; }
            await sleep(250 * (attempt + 1));
        }
    }
    throw lastErr || new Error('queryContract exhausted retries');
}
const CH = {
    queryContract: realQueryContract,
    fetchDistributions: D.fetchDistributions,
};

async function numTokens() { const d = await CH.queryContract(VOTING_ESCROW, { num_tokens: {} }); return Number(d?.count); }
async function allTokens() {
    const out = [];
    let startAfter;
    for (;;) {
        const q = { all_tokens: { limit: ALL_TOKENS_PAGE, ...(startAfter ? { start_after: startAfter } : {}) } };
        const d = await CH.queryContract(VOTING_ESCROW, q);   // throws on failure — never coerced to [] (F2)
        const toks = d?.tokens;
        if (!Array.isArray(toks)) throw new Error('all_tokens: unexpected shape');
        if (toks.length === 0) break;                          // genuine end ≠ failure
        out.push(...toks);
        startAfter = toks[toks.length - 1];
        await sleep(PACE_MS);
    }
    return out;
}
const lockInfo = (tokenId) => CH.queryContract(VOTING_ESCROW, { lock_info: { token_id: String(tokenId), time: 'current' } });
const userInfo = (wallet)  => CH.queryContract(GAUGE_CONTROLLER, { user_info: { user: wallet, time: 'next' } });

// ---- bounded-concurrency map that PRESERVES failures (null ≠ empty; F2)
async function mapLimit(items, limit, fn) {
    const results = new Array(items.length);
    let i = 0;
    async function worker() {
        for (;;) {
            const idx = i++;
            if (idx >= items.length) return;
            try { results[idx] = { ok: true, value: await fn(items[idx], idx) }; }
            catch (e) { results[idx] = { ok: false, error: String(e.message || e) }; }
            await sleep(PACE_MS);
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}

// ---- normalization (lifted from reconcile.js — verified against production)
function normalizeAssetId(asset) {
    if (asset == null) return null;
    if (typeof asset === 'string') return asset;
    if (asset.cw20) return `cw20:${asset.cw20}`;
    if (asset.native) return `native:${asset.native}`;
    if (asset.token?.contract_addr) return `cw20:${asset.token.contract_addr}`;
    if (asset.native_token?.denom) return `native:${asset.native_token.denom}`;
    return JSON.stringify(asset);
}
function normAlloc(votes) {
    const o = {};
    for (const v of votes || []) {
        if (!Array.isArray(v) || v.length < 2) continue;
        const k = normalizeAssetId(v[0]), b = Number(v[1]);
        if (k && b > 0) o[k] = (o[k] || 0) + b;
    }
    return o;
}
function allocEqual(a, b) {
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) if (a[k] !== b[k]) return false;
    return true;
}
// Tolerant stamp extraction — see the header caveat. Raw entry is retained
// verbatim regardless, so an unrecognized field name loses nothing.
function stampOf(gvEntry) {
    for (const f of ['period', 'vote_period', 'last_vote_period']) {
        const v = gvEntry?.[f];
        if (v != null && Number.isFinite(Number(v))) return Number(v);
    }
    return null;
}

// ---- record builder (spec §3 schema v1)
function buildRecord(period, wallet, ui, capturedAt) {
    const gvRaw = Array.isArray(ui?.gauge_votes) ? ui.gauge_votes : [];
    const gauge_votes = gvRaw.map(g => {
        const period_stamp = stampOf(g);
        return {
            gauge: g.gauge ?? null,
            period_stamp,
            votes: Object.entries(normAlloc(g.votes)),
            post_flip_change: period_stamp != null && period_stamp > period,
        };
    }).filter(g => g.votes.length);
    const fixed = String(ui?.fixed_amount ?? '0');
    const boost = String(ui?.voting_power ?? '0');
    let total = null;
    try { total = (BigInt(fixed) + BigInt(boost)).toString(); } catch { /* non-integer strings stay null */ }
    return {
        schemaVersion: VS_SCHEMA_VERSION, period, wallet,
        vp: { fixed, boost, total },                    // VP law: total = fixed + boost
        gauge_votes,
        voted_this_period: gauge_votes.some(g => g.period_stamp === period),
        raw_gauge_votes: gvRaw,                          // verbatim — stamp-field insurance
        capturedAt, source: 'state-harvest',
    };
}

// ---- vote_capture: events replay vs the SAME user_info results
function computeVoteCapture(voteEvents, uiByWallet, failedWallets) {
    const replay = new Map();     // `${wallet}|${gauge}` -> last vote event
    for (const ev of voteEvents) {
        if (ev.type !== 'vote' || !ev.wallet || ev.gauge == null) continue;
        replay.set(`${ev.wallet}|${ev.gauge}`, ev);      // events pre-sorted by height
    }
    const chainSlots = new Map();
    for (const [wallet, ui] of uiByWallet) {
        for (const g of (Array.isArray(ui?.gauge_votes) ? ui.gauge_votes : [])) {
            const alloc = normAlloc(g.votes);
            if (Object.keys(alloc).length) chainSlots.set(`${wallet}|${g.gauge}`, alloc);
        }
    }
    const counts = { MATCH: 0, MISMATCH: 0, CHAIN_ONLY: 0, EVENTS_ONLY: 0 };
    const details = { MISMATCH: [], CHAIN_ONLY: [], EVENTS_ONLY: [] };
    for (const slot of new Set([...chainSlots.keys(), ...replay.keys()])) {
        const wallet = slot.split('|')[0];
        if (failedWallets.has(wallet)) continue;         // unknown, not judged
        if (!uiByWallet.has(wallet)) continue;           // outside the harvested universe
        const chainAlloc = chainSlots.get(slot);
        const ev = replay.get(slot);
        const evAlloc = ev ? normAlloc(ev.votes) : null;
        const evEmpty = !evAlloc || Object.keys(evAlloc).length === 0;
        if (chainAlloc && !evEmpty) {
            if (allocEqual(chainAlloc, evAlloc)) counts.MATCH++;
            else { counts.MISMATCH++; if (details.MISMATCH.length < DETAIL_CAP) details.MISMATCH.push({ slot, last_event_height: ev.height }); }
        } else if (chainAlloc && evEmpty) {
            counts.CHAIN_ONLY++; if (details.CHAIN_ONLY.length < DETAIL_CAP) details.CHAIN_ONLY.push({ slot });
        } else if (!chainAlloc && !evEmpty) {
            counts.EVENTS_ONLY++; if (details.EVENTS_ONLY.length < DETAIL_CAP) details.EVENTS_ONLY.push({ slot, last_event_height: ev.height });
        }
    }
    const judged = counts.MATCH + counts.MISMATCH + counts.CHAIN_ONLY + counts.EVENTS_ONLY;
    return { counts, match_rate_pct: judged ? +(100 * counts.MATCH / judged).toFixed(2) : null, judged, details };
}

// ---- the harvest step (called from index.js run(); reads/writes injected)
async function forwardVoteState({ publishFile, apiGetJson, readVoteEvents, log = console }) {
    const capturedAt = new Date().toISOString();

    // current FINALIZED period = distributions head (one authoritative source)
    const cur = await CH.fetchDistributions('current');
    if (!cur.ok) throw new Error(`period discovery failed: ${cur.error}`);
    const period = cur.period;

    const ir = await apiGetJson(`${VS_DIR}/index.json`);
    if (!ir.ok) throw new Error('vote-state index read failed — refusing to run on unknown state');
    const idx = ir.data || {
        schemaVersion: VS_SCHEMA_VERSION, module: 'tla-voting', product: 'vote-state',
        last_harvested_period: null, wallets_seen: [], months_present: {}, pending_wallets: [], counts: { records: 0 },
    };

    const pending = Array.isArray(idx.pending_wallets) ? idx.pending_wallets : [];
    // completion mode: a prior run for THIS period left failed wallets behind.
    // (Keyed on pending_period, not last_harvested_period — a FIRST harvest with
    // failures has last_harvested_period null but still needs completion.)
    const completionMode = pending.length > 0 && idx.pending_period === period;
    if (pending.length > 0 && idx.pending_period !== period) {
        // the period moved past the pending set — a fresh full harvest re-covers
        // those wallets via the universe union; stale pending is dropped
        log.warn(`  ⚠ vote-state: dropping ${pending.length} pending wallet(s) from period ${idx.pending_period} — period is now ${period}, full harvest re-covers them`);
    }
    if (idx.last_harvested_period != null && idx.last_harvested_period >= period && !completionMode) {
        return { skipped: true, reason: 'up to date', period };
    }

    // ---- universe
    let universe;
    if (completionMode) {
        universe = [...pending];
        log.log(`  vote-state: completion mode — retrying ${universe.length} pending wallet(s) for period ${period}`);
    } else {
        // fresh enumeration EVERY harvest (D4). Failure here aborts the whole
        // harvest: an incomplete universe invalidates completeness.
        const nt = await numTokens();
        const tokenIds = await allTokens();
        if (tokenIds.length !== nt) throw new Error(`all_tokens walk (${tokenIds.length}) != num_tokens (${nt}) — enumeration incomplete, aborting harvest`);
        const li = await mapLimit(tokenIds, CONC, (t) => lockInfo(t));
        const owners = new Set();
        const lockFails = [];
        li.forEach((r, i2) => {
            if (!r.ok || !r.value || !r.value.owner) { lockFails.push(`lock_info ${tokenIds[i2]}: ${r.ok ? 'no owner' : r.error}`); return; }
            owners.add(r.value.owner);
        });
        if (lockFails.length) throw new Error(`lock_info failures (${lockFails.length}/${tokenIds.length}) — universe incomplete, aborting harvest: ${lockFails[0]}`);
        universe = [...new Set([...owners, ...(idx.wallets_seen || [])])];
        log.log(`  vote-state: period ${period} — ${tokenIds.length} locks, ${owners.size} owners, universe ${universe.length}`);
    }

    // ---- user_info per wallet (individual failures → pending, not fatal; F2)
    const uiRes = await mapLimit(universe, CONC, (w) => userInfo(w));
    const uiByWallet = new Map();
    const failed = [];
    universe.forEach((w, i2) => {
        const r = uiRes[i2];
        if (!r.ok) { failed.push(w); return; }
        uiByWallet.set(w, r.value || {});
    });

    // ---- records for succeeded wallets → touched month file
    const records = [...uiByWallet.entries()].map(([w, ui]) => buildRecord(period, w, ui, capturedAt));
    const votedCount = records.filter(r => r.voted_this_period).length;

    const [yyyy, mm] = [capturedAt.slice(0, 4), capturedAt.slice(5, 7)];
    const monthPath = `${VS_DIR}/${yyyy}/${mm}.json`;
    const mr = await apiGetJson(monthPath);
    if (!mr.ok) throw new Error(`vote-state month read failed: ${monthPath}`);
    const existing = Array.isArray(mr.data) ? mr.data : [];
    const byKey = new Map(existing.map(r => [`${r.period}|${r.wallet}`, r]));
    let added = 0;
    for (const r of records) { const k = `${r.period}|${r.wallet}`; if (!byKey.has(k)) { byKey.set(k, r); added++; } }
    const merged = [...byKey.values()].sort((a, b) => a.period - b.period || (a.wallet < b.wallet ? -1 : 1));
    if (merged.length < existing.length) throw new Error(`vote-state never-shrink violation: ${merged.length} < ${existing.length}`);
    if (added > 0) await publishFile(monthPath, JSON.stringify(merged), `vote-state ${yyyy}/${mm}: period ${period} +${added} (${merged.length} total)`);

    // ---- vote_capture (full harvests only — a partial universe = invalid rate)
    let vote_capture = null;
    if (!completionMode) {
        try {
            const voteEvents = await readVoteEvents();
            vote_capture = computeVoteCapture(voteEvents, uiByWallet, new Set(failed));
            log.log(`  vote-state: vote_capture ${JSON.stringify(vote_capture.counts)} match_rate ${vote_capture.match_rate_pct}%`);
        } catch (e) {
            vote_capture = { unavailable: String(e.message || e) };
            log.warn(`  ⚠ vote_capture unavailable this run: ${e.message}`);
        }
    }

    // ---- index + heartbeat (period advances ONLY when nothing is pending)
    const wallets_seen = [...new Set([...(idx.wallets_seen || []), ...uiByWallet.keys()])].sort();
    const newIdx = {
        schemaVersion: VS_SCHEMA_VERSION, module: 'tla-voting', product: 'vote-state',
        spec: 'docs/pending-changes/SPEC-tla-voting-capture-fix.md',
        updatedAt: capturedAt,
        last_harvested_period: failed.length === 0 ? period : (idx.last_harvested_period ?? null),
        pending_wallets: failed,
        pending_period: failed.length ? period : undefined,
        wallets_seen,
        months_present: (() => { const mp = { ...(idx.months_present || {}) }; ((mp[yyyy] ||= []).includes(mm)) || mp[yyyy].push(mm); mp[yyyy].sort(); return mp; })(),
        counts: { records: (idx.counts?.records || 0) + added, last_harvest_wallets: uiByWallet.size, last_harvest_voted: votedCount },
        stamp_field_note: 'period stamps parsed tolerantly (period/vote_period/last_vote_period); raw_gauge_votes retained verbatim per record — pin the field via probe (spec §3)',
    };
    await publishFile(`${VS_DIR}/index.json`, newIdx, `vote-state index: period ${newIdx.last_harvested_period}${failed.length ? ` (${failed.length} pending)` : ''}`);
    await publishFile(`${VS_DIR}/heartbeat.json`, {
        schemaVersion: VS_SCHEMA_VERSION, cron: 'tla-voting', product: 'vote-state',
        capturedAt, runMode: completionMode ? 'completion' : 'harvest',
        status: failed.length ? 'partial' : 'ok',
        period, wallets: uiByWallet.size, voted: votedCount, added,
        pending_wallets: failed.length ? failed : undefined,
        vote_capture: vote_capture && vote_capture.counts ? { ...vote_capture.counts, match_rate_pct: vote_capture.match_rate_pct } : undefined,
    }, `vote-state heartbeat ${failed.length ? 'partial' : 'ok'}`);

    return { period, wallets: uiByWallet.size, voted: votedCount, added, pending: failed.length, vote_capture: vote_capture && vote_capture.counts ? { ...vote_capture.counts, match_rate_pct: vote_capture.match_rate_pct } : undefined };
}

module.exports = { forwardVoteState, CH, VS_DIR, VS_SCHEMA_VERSION, buildRecord, computeVoteCapture, normAlloc, stampOf, mapLimit };
