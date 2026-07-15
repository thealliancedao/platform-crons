// =============================================================================
// tla-voting / lib / rollups.js — rollups.json schema 4 (build #2)
// SPEC-tla-voting-rollups (approved 2026-07-15). Layer 3 — recomputable
// forever; a bug here costs a recompute, never touches the streams.
//
// THE HONEST MERGE: voters = vote-state ∪ events. Schema 3 was event-only —
// blind to every contract-path voter the capture fix surfaced (aDAO's
// treasury vote, both Votion vaults, the whale's re-vote). State wins;
// events add tx-level detail where they can see; `events_visibility` says
// which is which. Pots are GONE — distributions/history.json is the one
// truth (pointer left in their place).
//
// THE THREE-NUMBER CLAIMS MODEL (D4): per wallet per token —
//   amount            what you received (raw + decimals-adjusted)
//   usd_at_claim      Σ per-claim amount × price on the claim date
//                     ("if sold when claimed" — an immutable fact)
//   usd_at_build      amount × latest price at rollup build (FALLBACK; the
//                     site computes live today-value as amount × live price)
// Earned = claimed (this file) + live pending (user_claimable +
// user_pending_rebase, display-side — recipe in the README). No pot-share
// reconstruction anywhere: every number is chain truth or declared missing.
//
// Honesty ledger lives IN the file: claim_coverage windows (the
// 2025-01-08→2026-06-14 hole is declared, not hidden), bribers_coverage_note
// (~97% blind pending build #3), per-voter events_visibility, unpriced[]
// for unjoinable denoms (never dropped, never guessed).
//
// Pure derived: reads ONLY committed repo files (no chain calls). Rebuilt on
// harvest runs + FORCE_ROLLUPS=1. Any source read failure aborts THIS step
// only (streams/state products unaffected).
// =============================================================================
'use strict';

const ROLLUPS_SCHEMA = 4;
const OUT = 'tla-voting/events/rollups.json';
const VS_DIR = 'tla-voting/vote-state';
const TOKEN_CATALOG = 'token-catalog/snapshots/current.json';
const PRICE_DIR = 'price-history';
const DISTRIBUTIONS_POINTER = 'tla-voting/distributions/history.json';
// The escrow's underlying — withdraws pay this out; system constant, not a guess.
const AMPLUNA_DENOM = 'cw20:terra1ecgazyd0waaj3g7l9cmy5gulhxkps2gmxu9ghducvuypjq68mq2s5lvsct';
const PRICE_SEARCH_DAYS = 7;

const CLAIM_TYPES = new Set(['claim_bribes', 'claim_rebase', 'compound']);
const LOCK_IN_TYPES = new Set(['lock_create', 'lock_extend_amount', 'lock_deposit_for']);
const LOCK_OUT_TYPES = new Set(['withdraw']);

// Reward-stream capture coverage (SPEC D7). The hole is the archive-node
// backfill target — declared here so no consumer mistakes a partial total
// for a lifetime total.
const CLAIM_COVERAGE = [
    { from: 'genesis (2024-08-27)', to: '2025-01-07', source: 'fcd frozen archive' },
    { from: '2025-01-08', to: '2026-06-14', source: 'HOLE — archive-node backfill queued (claims in this window are NOT yet counted)' },
    { from: '2026-06-15', to: 'builtAt', source: 'tx_search seed + block walker (2.0.0+)' },
];

const dayOf = (ts) => String(ts || '').slice(0, 10);
const monthPathOf = (dateStr) => `${PRICE_DIR}/${dateStr.slice(0, 4)}/${dateStr.slice(5, 7)}.json`;
function shiftDay(dateStr, delta) {
    const d = new Date(dateStr + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + delta);
    return d.toISOString().slice(0, 10);
}

async function readAllMonths(apiGetJson, baseDir, monthsPresent) {
    const out = [];
    for (const yyyy of Object.keys(monthsPresent || {}).sort()) {
        for (const mm of monthsPresent[yyyy]) {
            const r = await apiGetJson(`${baseDir}/${yyyy}/${mm}.json`);
            if (!r.ok) throw new Error(`rollups: month read failed ${baseDir}/${yyyy}/${mm}`);
            if (Array.isArray(r.data)) out.push(...r.data);
        }
    }
    return out;
}

// ---- token join (D5): canonical denom -> { symbol, decimals } ----------------
function buildTokenMap(catalog) {
    const map = new Map();
    for (const t of catalog?.tokens || []) {
        const sym = t?.discovered?.symbol, dec = t?.discovered?.decimals;
        if (!t.denom || !sym) continue;
        map.set(t.denom, { symbol: sym, decimals: Number.isFinite(dec) ? dec : 6 });
    }
    return map;
}
const bareDenom = (canonical) => String(canonical || '').replace(/^(native:|cw20:)/, '');

// ---- price lookup with lazy month cache (D5) ---------------------------------
function makePriceLookup(apiGetJson, log) {
    const monthCache = new Map(); // path -> days{} | null(absent) ; failures THROW
    async function daysFor(dateStr) {
        const p = monthPathOf(dateStr);
        if (!monthCache.has(p)) {
            const r = await apiGetJson(p);
            if (!r.ok) throw new Error(`rollups: price month read failed ${p}`);
            monthCache.set(p, r.data ? (r.data.days || {}) : null);
        }
        return monthCache.get(p);
    }
    // nearest prior day within 7, else nearest after within 7, else null
    async function priceOn(symbol, dateStr) {
        for (let d = 0; d <= PRICE_SEARCH_DAYS; d++) {
            const day = shiftDay(dateStr, -d);
            const days = await daysFor(day);
            const usd = days && days[day] && days[day][symbol] && days[day][symbol].usd;
            if (typeof usd === 'number') return usd;
        }
        for (let d = 1; d <= PRICE_SEARCH_DAYS; d++) {
            const day = shiftDay(dateStr, d);
            const days = await daysFor(day);
            const usd = days && days[day] && days[day][symbol] && days[day][symbol].usd;
            if (typeof usd === 'number') return usd;
        }
        return null;
    }
    // latest available price for a symbol at build time (usd_at_build basis)
    async function latestPrice(symbol, builtAtDate) {
        for (let d = 0; d <= 40; d++) {
            const day = shiftDay(builtAtDate, -d);
            const days = await daysFor(day);
            const usd = days && days[day] && days[day][symbol] && days[day][symbol].usd;
            if (typeof usd === 'number') return { usd, as_of: day };
        }
        return null;
    }
    return { priceOn, latestPrice };
}

// ---- the build ----------------------------------------------------------------
async function buildRollups4({ apiGetJson, publishFile, epochOf, log = console }) {
    const builtAt = new Date().toISOString();
    const builtDate = dayOf(builtAt);

    // -- sources (any failure throws — rollup aborts whole, never half-truths)
    const ir = await apiGetJson('tla-voting/events/index.json');
    if (!ir.ok || !ir.data) throw new Error('rollups: events index unavailable');
    const index = ir.data;
    const vir = await apiGetJson(`${VS_DIR}/index.json`);
    if (!vir.ok || !vir.data) throw new Error('rollups: vote-state index unavailable');
    const vsIndex = vir.data;
    const tcr = await apiGetJson(TOKEN_CATALOG);
    if (!tcr.ok || !tcr.data) throw new Error('rollups: token-catalog unavailable');
    const tokenMap = buildTokenMap(tcr.data);

    const votes = await readAllMonths(apiGetJson, 'tla-voting/events/votes', index.streams?.votes?.months_present);
    const locks = await readAllMonths(apiGetJson, 'tla-voting/events/locks', index.streams?.locks?.months_present);
    const bribes = await readAllMonths(apiGetJson, 'tla-voting/events/bribes', index.streams?.bribes?.months_present);
    const rewards = await readAllMonths(apiGetJson, 'tla-voting/events/rewards', index.streams?.rewards?.months_present);
    const stateRecords = await readAllMonths(apiGetJson, VS_DIR, vsIndex.months_present);
    const prices = makePriceLookup(apiGetJson, log);

    // -- latest state per wallet (max period wins)
    const stateBy = new Map();
    for (const r of stateRecords) {
        const cur = stateBy.get(r.wallet);
        if (!cur || r.period > cur.period) stateBy.set(r.wallet, r);
    }

    // -- event-side vote detail
    const votesBy = new Map();
    for (const ev of votes) {
        if (ev.type !== 'vote' || !ev.wallet) continue;
        const epoch = epochOf ? epochOf(ev.timestamp) : null;
        let v = votesBy.get(ev.wallet);
        if (!v) { v = { event_count: 0, first_vote_epoch: null, last_vote_epoch: null, pools: new Map() }; votesBy.set(ev.wallet, v); }
        v.event_count++;
        if (epoch != null) {
            if (v.first_vote_epoch == null || epoch < v.first_vote_epoch) v.first_vote_epoch = epoch;
            if (v.last_vote_epoch == null || epoch > v.last_vote_epoch) v.last_vote_epoch = epoch;
        }
        for (const pair of ev.votes || []) {
            const asset = Array.isArray(pair) ? pair[0] : null;
            if (asset) v.pools.set(asset, (v.pools.get(asset) || 0) + 1);
        }
    }

    // -- lock aggregates (canonical only; amount+denom-bearing events summed,
    //    the rest counted honestly)
    const locksBy = new Map();
    for (const ev of locks) {
        if (!ev.canonical || !ev.wallet) continue;
        let l = locksBy.get(ev.wallet);
        if (!l) { l = { canonical_event_count: 0, first_lock_ts: null, net: new Map(), no_amount: 0 }; locksBy.set(ev.wallet, l); }
        l.canonical_event_count++;
        if (ev.type === 'lock_create' && (!l.first_lock_ts || ev.timestamp < l.first_lock_ts)) l.first_lock_ts = ev.timestamp;
        const amt = ev.amount != null ? String(ev.amount) : null;
        const dir = LOCK_IN_TYPES.has(ev.type) ? 'in' : (LOCK_OUT_TYPES.has(ev.type) ? 'out' : null);
        if (!dir) continue;
        if (!amt || !/^\d+$/.test(amt)) { l.no_amount++; continue; }
        const denom = typeof ev.asset === 'string' && ev.asset ? ev.asset : AMPLUNA_DENOM;
        const slot = l.net.get(denom) || { in: 0n, out: 0n };
        slot[dir] += BigInt(amt);
        l.net.set(denom, slot);
    }

    // -- claims (D4: the three-number model)
    const claimsBy = new Map();
    const symbolsUsed = new Set();
    for (const ev of rewards) {
        if (ev.kind !== 'wallet_claim' || !CLAIM_TYPES.has(ev.type) || !ev.wallet) continue;
        let c = claimsBy.get(ev.wallet);
        if (!c) { c = { claim_tx_count: 0, paid_claim_count: 0, byDenom: new Map(), unpriced: [], first: null, last: null }; claimsBy.set(ev.wallet, c); }
        c.claim_tx_count++;
        if (!Array.isArray(ev.coins) || !ev.coins.length) continue;   // true zero-claim — counted, not paid
        c.paid_claim_count++;
        if (!c.first || ev.timestamp < c.first) c.first = ev.timestamp;
        if (!c.last || ev.timestamp > c.last) c.last = ev.timestamp;
        for (const coin of ev.coins) {
            if (!coin || !coin.denom || !/^\d+$/.test(String(coin.amount))) continue;
            const tok = tokenMap.get(bareDenom(coin.denom));
            if (!tok) {
                c.unpriced.push({ denom: coin.denom, amount: String(coin.amount), date: dayOf(ev.timestamp), reason: 'denom not in token-catalog' });
                continue;
            }
            symbolsUsed.add(tok.symbol);
            let slot = c.byDenom.get(coin.denom);
            if (!slot) { slot = { symbol: tok.symbol, decimals: tok.decimals, amount: 0n, usd_at_claim: 0, claim_count: 0, unpriced_amount: 0n }; c.byDenom.set(coin.denom, slot); }
            const amt = BigInt(String(coin.amount));
            slot.amount += amt; slot.claim_count++;
            const px = await prices.priceOn(tok.symbol, dayOf(ev.timestamp));
            if (px == null) {
                slot.unpriced_amount += amt;
                c.unpriced.push({ denom: coin.denom, amount: String(coin.amount), date: dayOf(ev.timestamp), reason: `no ${tok.symbol} price within ±${PRICE_SEARCH_DAYS}d` });
            } else {
                slot.usd_at_claim += (Number(amt) / 10 ** tok.decimals) * px;
            }
        }
    }
    // usd_at_build: one latest price per symbol
    const buildPx = new Map();
    for (const sym of symbolsUsed) buildPx.set(sym, await prices.latestPrice(sym, builtDate));

    // -- voters: state ∪ events, VP-desc, withdrawn history kept
    const wallets = new Set([...stateBy.keys(), ...votesBy.keys(), ...locksBy.keys(), ...claimsBy.keys()]);
    const voters = [];
    for (const w of wallets) {
        const st = stateBy.get(w) || null;
        const ve = votesBy.get(w) || null;
        const lk = locksBy.get(w) || null;
        const cl = claimsBy.get(w) || null;
        const by_token = {};
        let totClaim = 0, totBuild = 0;
        if (cl) for (const [denom, s] of cl.byDenom) {
            const bp = buildPx.get(s.symbol);
            const usdBuild = bp ? (Number(s.amount) / 10 ** s.decimals) * bp.usd : null;
            by_token[s.symbol] = {
                denom, decimals: s.decimals,
                amount: s.amount.toString(),
                amount_display: +(Number(s.amount) / 10 ** s.decimals).toFixed(6),
                usd_at_claim: +s.usd_at_claim.toFixed(2),
                usd_at_build: usdBuild != null ? +usdBuild.toFixed(2) : null,
                claim_count: s.claim_count,
                unpriced_amount: s.unpriced_amount > 0n ? s.unpriced_amount.toString() : undefined,
            };
            totClaim += s.usd_at_claim; if (usdBuild != null) totBuild += usdBuild;
        }
        voters.push({
            wallet: w,
            events_visibility: ve ? 'full' : 'none',
            state: st ? { vp: st.vp, gauges: st.gauge_votes, voted_this_period: st.voted_this_period, as_of_period: st.period } : null,
            votes: ve ? {
                event_count: ve.event_count, first_vote_epoch: ve.first_vote_epoch, last_vote_epoch: ve.last_vote_epoch,
                pools_voted: [...ve.pools.entries()].map(([asset, times]) => ({ asset, times })).sort((a, b) => b.times - a.times),
            } : null,
            locks: lk ? {
                canonical_event_count: lk.canonical_event_count, first_lock_ts: lk.first_lock_ts,
                net_by_denom: Object.fromEntries([...lk.net.entries()].map(([d, s]) => [d, { in: s.in.toString(), out: s.out.toString() }])),
                events_without_amounts: lk.no_amount || undefined,
            } : null,
            claims: cl ? {
                claim_tx_count: cl.claim_tx_count, paid_claim_count: cl.paid_claim_count,
                by_token,
                unpriced: cl.unpriced.length ? cl.unpriced : undefined,
                totals: { usd_at_claim: +totClaim.toFixed(2), usd_at_build: +totBuild.toFixed(2) },
                first_claim_ts: cl.first, last_claim_ts: cl.last,
                amounts_note: 'compound events pre-2.1.0 carry no amounts (classifier v5 fills them forward; historical fill queued)',
            } : null,
        });
    }
    voters.sort((a, b) => {
        const av = a.state ? Number(BigInt(a.state.vp.total || '0') / 1000n) : -1;
        const bv = b.state ? Number(BigInt(b.state.vp.total || '0') / 1000n) : -1;
        return bv - av || (a.wallet < b.wallet ? -1 : 1);
    });

    // -- bribers (event-derived; blind spot declared, fixed by build #3)
    const bribersBy = new Map();
    for (const ev of bribes) {
        if (ev.type !== 'bribe_add' || !ev.briber) continue;
        const epoch = ev.epoch_start ?? (epochOf ? epochOf(ev.timestamp) : null);
        let b = bribersBy.get(ev.briber);
        if (!b) { b = { event_count: 0, by_epoch: {} }; bribersBy.set(ev.briber, b); }
        b.event_count++;
        const ek = String(epoch ?? 'unknown');
        const slot = (b.by_epoch[ek] ||= { pools: {}, coins: {} });
        if (ev.pool) slot.pools[ev.pool] = (slot.pools[ev.pool] || 0) + 1;
        for (const coin of ev.coins || []) {
            if (!coin?.denom || !/^\d+$/.test(String(coin.amount))) continue;
            slot.coins[coin.denom] = (BigInt(slot.coins[coin.denom] || '0') + BigInt(String(coin.amount))).toString();
        }
    }
    const bribers = [...bribersBy.entries()].map(([briber, b]) => ({ briber, ...b })).sort((a, b) => b.event_count - a.event_count);

    const rollups = {
        schemaVersion: ROLLUPS_SCHEMA,
        spec: 'docs/pending-changes/SPEC-tla-voting-rollups.md',
        builtAt,
        built_on_period: vsIndex.last_harvested_period ?? null,
        sources: {
            vote_state_through_period: vsIndex.last_harvested_period ?? null,
            events_index_counts: Object.fromEntries(Object.entries(index.streams || {}).map(([s, m]) => [s, m.count])),
            distributions_pointer: DISTRIBUTIONS_POINTER,
        },
        claim_coverage: CLAIM_COVERAGE.map(c => ({ ...c, to: c.to === 'builtAt' ? builtAt : c.to })),
        pending_recipe: 'live earned = claims.totals + user_claimable(gauge) + user_pending_rebase(gauge), display-side — see README',
        voter_count: voters.length,
        voters,
        bribers,
        bribers_coverage_note: '~97% blind to contract-initiated add_bribe (take-rate tributes) until build #3 — present, NOT complete',
        pots: { moved_to: DISTRIBUTIONS_POINTER, note: 'schema-3 event-derived pots retired; distributions is the chain-complete per-period ledger' },
    };
    await publishFile(OUT, JSON.stringify(rollups), `rollups schema 4: ${voters.length} voters, built on period ${rollups.built_on_period}`);
    return { voters: voters.length, bribers: bribers.length, built_on_period: rollups.built_on_period };
}

module.exports = { buildRollups4, ROLLUPS_SCHEMA, buildTokenMap, makePriceLookup, bareDenom, CLAIM_COVERAGE };
