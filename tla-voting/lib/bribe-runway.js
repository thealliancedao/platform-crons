'use strict';
// =============================================================================
// tla-voting / lib / bribe-runway.js — SPEC-bribe-runway v1 (2026-07-30)
//
// "How long do this pool's bribes keep flowing?" — answered from STATE TRUTH:
// the manager's per-period pots are queryable for FUTURE periods, so we probe
// head..head+CAP until pots go empty and publish a per-pool runway. Because
// this reads pots (not events) it INCLUDES unattributed hole-era bribes
// (Solid's CAPA batches, PD, everything) — the feature works pre-E2 by design.
// Honest edges: pots carry no payer (that's E2's job); a linear-distribution
// bribe tapers per-period rather than cliffing, which per-period amounts show.
//
// Runs every forward cron pass (≤ CAP+1 pot queries, sequential) so a freshly
// added bribe appears on the runway within the hour. Product:
//   tla-voting/bribe-state/runway.json  { meta, pools: [ {pool, gauge,
//     last_funded_period, epochs_left, funded_periods, by_denom:{denom:
//     {last_period, periods_funded, total_remaining_raw, per_period}}} ] }
// epochs_left = last_funded_period − head (0 = expires after the current
// epoch). expires_approx = capturedAt + epochs_left weeks — labeled approx.
// =============================================================================

const { CH, fetchBribes } = require('./bribe-state.js');

const RUNWAY_CAP = Number(process.env.BRIBE_RUNWAY_CAP || 26);   // ~6 months ahead
const RUNWAY_PATH = 'tla-voting/bribe-state/runway.json';

function normAsset(a) {
    if (a == null) return null;
    if (typeof a === 'string') return a;
    if (a.cw20) return `cw20:${a.cw20}`;
    if (a.native) return `native:${a.native}`;
    return JSON.stringify(a);
}

// pure — gated on fixtures
function computeRunway(head, potsByPeriod, capturedAt) {
    const pools = new Map();   // pool -> { gauge, by_denom: Map }
    const periods = [...potsByPeriod.keys()].sort((a, b) => a - b);
    for (const per of periods) {
        for (const b of potsByPeriod.get(per) || []) {
            const pool = normAsset(b.asset);
            if (!pool) continue;
            const p = pools.get(pool) || { gauge: b.gauge || null, by_denom: new Map() };
            p.gauge = p.gauge || b.gauge || null;
            for (const c of b.assets || []) {
                const den = normAsset(c.info) || c.denom || null;
                const amt = BigInt(String(c.amount || '0'));
                if (!den || amt === 0n) continue;
                const d = p.by_denom.get(den) || { last_period: per, periods_funded: 0, total_remaining_raw: 0n, per_period: {} };
                d.last_period = Math.max(d.last_period, per);
                d.periods_funded++;
                d.total_remaining_raw += amt;
                d.per_period[per] = amt.toString();
                p.by_denom.set(den, d);
            }
            if (p.by_denom.size) pools.set(pool, p);
        }
    }
    const out = [...pools.entries()].map(([pool, p]) => {
        const denoms = {};
        let last = head;
        for (const [den, d] of [...p.by_denom.entries()].sort()) {
            denoms[den] = { last_period: d.last_period, periods_funded: d.periods_funded, total_remaining_raw: d.total_remaining_raw.toString(), per_period: d.per_period };
            last = Math.max(last, d.last_period);
        }
        const left = last - head;
        return {
            pool, gauge: p.gauge,
            last_funded_period: last,
            epochs_left: left,
            expires_approx: new Date(Date.parse(capturedAt) + left * 7 * 864e5).toISOString().slice(0, 10),
            by_denom: denoms,
        };
    }).sort((a, b) => a.epochs_left - b.epochs_left || a.pool.localeCompare(b.pool));
    return out;
}

// Source classes (Camron 2026-07-30: replace the "auto-bribed" pattern-guess
// with EVIDENCE tags): who funds a pool comes from ATTRIBUTED bribe events
// whose span reaches the present — never inferred from pot shape. Classes:
//   dex     — the four staking-bucket/tribute contracts recycling Astroport
//             take-rate fees (their weekly placements ARE captured events)
//   pd      — Phoenix Directive DAO
//   project — any wallet the curated registry labels as a protocol/treasury
//   user    — every other wallet (individuals)
// A pool whose pots exceed what attributed events explain gets
// has_unattributed: true — stated, never guessed away (hole-era money).
const DEX_SUPPORT_SET = new Set([
    'terra1v399cx9drllm70wxfsgvfe694tdsd9x96p9ha36w7muffe4znlusqswspq',
    'terra1awq6t7jfakg9wfjn40fk3wzwmd57mvrqtt3a39z9rmet7wdjj3ysgw3lpa',
    'terra14mmvqn0kthw6sre75vku263lafn5655mkjdejqjedjga4cw0qx2qlf4arv',
    'terra1qdz5qgafx88kp5mf6m2tah8742g4u5g2cek0m3jrgssexexk7g4qw6e23k',
]);
const PD_PROTOCOL = 'Phoenix Directive';
function classifyFunder(addr, reg) {
    if (DEX_SUPPORT_SET.has(addr)) return { cls: 'dex', label: 'DEX support (take-rate recycler)' };
    const e = reg && reg[addr];
    if (e && e.protocol === PD_PROTOCOL) return { cls: 'pd', label: e.label || 'Phoenix Directive' };
    if (e && ['protocol', 'treasury', 'multisig', 'dao'].includes(e.subtype)) return { cls: 'project', label: e.label || addr.slice(-8) };
    return { cls: 'user', label: (e && e.label) || `${addr.slice(0, 8)}\u2026${addr.slice(-6)}` };
}
function buildFunders(head, bribeEvents, reg) {
    const byPool = new Map();   // pool -> Map(briber -> {thru, tokens:Set})
    for (const ev of bribeEvents || []) {
        if (ev.type !== 'bribe_add' || !ev.pool || !ev.briber) continue;
        const thru = ev.epoch_end ?? ev.epoch_start ?? null;
        if (thru == null || thru < head) continue;
        const m = byPool.get(ev.pool) || new Map();
        const f = m.get(ev.briber) || { thru: thru, tokens: new Set() };
        f.thru = Math.max(f.thru, thru);
        for (const c of ev.coins || []) if (c?.denom) f.tokens.add(c.denom);
        m.set(ev.briber, f); byPool.set(ev.pool, m);
    }
    const out = new Map();
    for (const [pool, m] of byPool) {
        out.set(pool, [...m.entries()].map(([addr, f]) => {
            const c = classifyFunder(addr, reg);
            return { briber: addr, label: c.label, class: c.cls, thru: f.thru, tokens: [...f.tokens].sort() };
        }).sort((a, b) => b.thru - a.thru));
    }
    return out;
}

async function forwardBribeRunway({ publishFile, readBribeEvents = null, apiGetJson = null, log = console }) {
    const capturedAt = new Date().toISOString();
    const cur = await CH.fetchDistributions('current');
    if (!cur.ok) throw new Error(`runway: period discovery failed: ${cur.error}`);
    const head = cur.period;

    const pots = new Map();
    const now = await fetchBribes('current');
    if (now.ok) pots.set(head, now.buckets);
    let probedThrough = head;
    for (let per = head + 1; per <= head + RUNWAY_CAP; per++) {
        const r = await fetchBribes(per);
        if (r.ok) { pots.set(per, r.buckets); probedThrough = per; continue; }
        if (r.floor) { probedThrough = per; break; }   // empty = end of funded runway
        throw new Error(`runway: transient failure probing p${per}: ${r.error}`);
    }

    const poolsOut = computeRunway(head, pots, capturedAt);

    // v1.1 funders overlay (evidence tags) — fail-open: if events/registry are
    // unavailable this run, pools ship without funders rather than blocking.
    try {
        let reg = null;
        if (apiGetJson) { const rr = await apiGetJson('docs/curated/wallets.json'); reg = rr && rr.ok ? (rr.data.wallets || rr.data) : null; }
        const evs = readBribeEvents ? await readBribeEvents() : null;
        const funders = buildFunders(head, evs, reg);
        for (const p of poolsOut) {
            const f = funders.get(p.pool) || [];
            p.funders = f;
            const fThru = f.length ? Math.max(...f.map(x => x.thru)) : null;
            const fTokens = new Set(f.flatMap(x => x.tokens));
            const potTokens = Object.keys(p.by_denom || {});
            p.has_unattributed = (fThru == null || fThru < p.last_funded_period) || potTokens.some(d => !fTokens.has(d));
        }
    } catch (e) { log.warn(`  runway funders overlay skipped: ${e.message}`); for (const p of poolsOut) { p.funders = p.funders || []; p.has_unattributed = true; } }
    const product = {
        schemaVersion: 1,
        product: 'tla-voting/bribe-runway',
        spec: 'docs/pending-changes/SPEC-bribe-runway.md',
        capturedAt,
        method: 'manager per-period pot state probed forward from the current epoch until pots go empty — state truth, so unattributed (hole-era) bribes are INCLUDED; payers are not named here (attribution is the event streams\u2019 job). Linear-distribution bribes taper: read per_period, not just the end date. expires_approx = capturedAt + epochs_left weeks (approximate, labeled).',
        current_period: head,
        probed_through: probedThrough,
        probe_cap: RUNWAY_CAP,
        pool_count: poolsOut.length,
        expiring_this_epoch: poolsOut.filter(p => p.epochs_left === 0).map(p => p.pool),
        pools: poolsOut,
    };
    await publishFile(RUNWAY_PATH, product, `bribe-runway: p${head} · ${poolsOut.length} funded pools · ${product.expiring_this_epoch.length} expiring`);
    return { head, probed_through: probedThrough, pool_count: poolsOut.length, expiring: product.expiring_this_epoch.length };
}

module.exports = { forwardBribeRunway, computeRunway, buildFunders, classifyFunder, RUNWAY_PATH, RUNWAY_CAP };
