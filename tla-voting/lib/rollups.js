// =============================================================================
// tla-voting / lib / rollups.js — rollups.json schema 5 (build #2 + #3.5)
// SPEC-tla-voting-rollups (approved 2026-07-15) + the #3.5 bribers upgrade
// (SPEC-tla-voting-bribe-state D8 rider). Layer 3 — recomputable forever;
// a bug here costs a recompute, never touches the streams.
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
// 2025-01-08→2026-06-14 hole is declared, not hidden), per-voter
// events_visibility, unpriced[] for unjoinable denoms (never dropped, never
// guessed), and — since schema 5 — bribe_ledger, which RETIRED the
// bribers_coverage_note by replacing the "~97% blind" label with measured
// numbers: per-period per-denom state totals (bribe-state, the complete
// chain ledger) vs event-attributed amounts, unattributed remainder
// explicit. THE NO-DIVISION LAW (Rev 7): raw amounts are never apportioned
// here — an event spanning multiple epochs is attributed in full ONLY to
// lifetime sums, never split across periods (bribe_capture's linear split
// is a heartbeat COVERAGE metric, not ledger math). Events for periods the
// state harvest hasn't reached land in events_outside_state — declared,
// never skewing a remainder.
//
// Pure derived: reads ONLY committed repo files (no chain calls). Rebuilt on
// harvest runs + FORCE_ROLLUPS=1. Any source read failure aborts THIS step
// only (streams/state products unaffected).
// =============================================================================
'use strict';

const ROLLUPS_SCHEMA = 6;
const OUT = 'tla-voting/events/rollups.json';
const VS_DIR = 'tla-voting/vote-state';
const BS_DIR = 'tla-voting/bribe-state';
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
        // schema 6: prefer the catalog's `effective` view (curated override layer
        // merged by token-catalog 1.5.0+); fall through to `discovered` so older
        // snapshots keep working identically.
        const sym = t?.effective?.symbol ?? t?.discovered?.symbol;
        const dec = (t?.effective?.decimals != null) ? t.effective.decimals : t?.discovered?.decimals;
        if (!t.denom || !sym) continue;
        map.set(t.denom, { symbol: sym, decimals: Number.isFinite(dec) ? dec : 6 });
    }
    return map;
}
const bareDenom = (canonical) => String(canonical || '').replace(/^(native:|cw20:)/, '');
// state-record asset info -> canonical denom (mirror of index.js
// normalizeAssetId; duplicated 6 lines to avoid a circular require)
function canonicalOfInfo(info) {
    if (info == null) return null;
    if (typeof info === 'string') return info;
    if (info.token?.contract_addr) return `cw20:${info.token.contract_addr}`;
    if (info.native_token?.denom) return `native:${info.native_token.denom}`;
    if (info.cw20) return `cw20:${info.cw20}`;
    if (info.native) return `native:${info.native}`;
    return JSON.stringify(info);
}
const addBig = (obj, key, amt) => { obj[key] = (BigInt(obj[key] || '0') + BigInt(String(amt))).toString(); };

// ---- bribe_ledger (#3.5): state totals vs event attribution ------------------
// bribeStateIndex: null = product not deployed/started yet (declared, not an
// error); read FAILURES throw upstream (abort the rollups step, spec conduct).
function buildBribeLedger(bsIndex, bsRecords, bribeEvents) {
    if (!bsIndex) return {
        status: 'awaiting bribe-state (build #3) — no index committed yet',
        source: `${BS_DIR}/`,
    };
    const harvested = new Set();
    const periods = {};   // "N" -> { by_denom: { canonical: {state, attributed, unattributed} } }
    for (const rec of bsRecords) {
        if (rec?.period == null || harvested.has(rec.period)) continue;   // dedup safety
        harvested.add(rec.period);
        const slot = (periods[String(rec.period)] ||= { by_denom: {} });
        for (const b of rec.buckets || []) for (const a of b.assets || []) {
            const den = canonicalOfInfo(a.info);
            if (!den || !/^\d+$/.test(String(a.amount))) continue;
            const d = (slot.by_denom[den] ||= { state: '0', attributed: '0' });
            addBig(d, 'state', a.amount);
        }
    }
    // events: single-period → exact per-period attribution; multi-period /
    // unknown-epoch → lifetime-only (full amount, NEVER divided); events whose
    // period the harvest hasn't reached → events_outside_state.
    const lifetime = {};            // canonical -> {state, attributed_exact, attributed_spanning}
    const outside = {};             // canonical -> amount (declared)
    let spanningCount = 0, outsideCount = 0;
    for (const p of Object.keys(periods)) for (const [den, d] of Object.entries(periods[p].by_denom)) {
        const l = (lifetime[den] ||= { state: '0', attributed_exact: '0', attributed_spanning: '0' });
        addBig(l, 'state', d.state);
    }
    for (const ev of bribeEvents) {
        if (ev.type !== 'bribe_add' || !Array.isArray(ev.coins)) continue;
        const single = ev.epoch_start != null && (ev.epoch_end == null || ev.epoch_end === ev.epoch_start);
        for (const c of ev.coins) {
            if (!c?.denom || !/^\d+$/.test(String(c.amount))) continue;
            const l = (lifetime[c.denom] ||= { state: '0', attributed_exact: '0', attributed_spanning: '0' });
            if (single && harvested.has(ev.epoch_start)) {
                const slot = periods[String(ev.epoch_start)].by_denom[c.denom]
                    ||= { state: '0', attributed: '0' };
                addBig(slot, 'attributed', c.amount);
                addBig(l, 'attributed_exact', c.amount);
            } else if (single) {
                addBig(outside, c.denom, c.amount); outsideCount++;
            } else {
                addBig(l, 'attributed_spanning', c.amount); spanningCount++;
            }
        }
    }
    // remainders — clamped at zero; an event surplus is DECLARED, not negated
    for (const p of Object.values(periods)) for (const d of Object.values(p.by_denom)) {
        const rem = BigInt(d.state) - BigInt(d.attributed);
        d.unattributed = (rem > 0n ? rem : 0n).toString();
        if (rem < 0n) d.event_surplus = (-rem).toString();
    }
    const lifetimeOut = {};
    for (const [den, l] of Object.entries(lifetime)) {
        const rem = BigInt(l.state) - BigInt(l.attributed_exact) - BigInt(l.attributed_spanning);
        lifetimeOut[den] = { ...l, unattributed: (rem > 0n ? rem : 0n).toString(),
            ...(rem < 0n ? { event_surplus: (-rem).toString() } : {}) };
    }
    return {
        source: `${BS_DIR}/ (complete per-period chain ledger) + events (attribution)`,
        state_through_period: bsIndex.last_harvested_period ?? null,
        walked_down_to: bsIndex.walked_down_to ?? null,
        floor_period: bsIndex.floor_period ?? null,
        semantics: 'state = the manager\u2019s verbatim per-period totals; attributed = event-derived (direct + v6 promoted), single-period events only per period; spanning/unknown-epoch events count toward lifetime ONLY (full amounts, never divided); unattributed = state \u2212 attributed, clamped \u2265 0 with any surplus declared',
        periods,
        lifetime: lifetimeOut,
        events_outside_state: outsideCount ? { by_denom: outside, event_coin_count: outsideCount, note: 'single-period bribe events for periods the state harvest has not reached (pre-floor or ahead of head)' } : undefined,
        spanning_event_coin_count: spanningCount || undefined,
    };
}

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

    // -- bribe-state (#3.5): the complete chain ledger joins the build --------
    const bsIdxR = await apiGetJson(`${BS_DIR}/index.json`);
    if (!bsIdxR.ok) throw new Error('rollups: bribe-state index read failed');
    const bsIndex = bsIdxR.data || null;                    // null = not deployed yet (declared)
    let bsRecords = [];
    if (bsIndex) bsRecords = await readAllMonths(apiGetJson, BS_DIR, bsIndex.months_present);
    const bribe_ledger = buildBribeLedger(bsIndex, bsRecords, bribes);

    // -- bribers (schema 6 — SPEC-tla-voting-briber-board): priced, labeled
    //    leaderboard. Event-derived attribution remains the ONLY per-briber
    //    source; completeness is MEASURED in bribe_ledger. Value basis (D2/D3):
    //    gross placed from the add tx's coins; fee_funds never counted;
    //    usd_at_placement immutable (price on tx date), usd_at_build fallback;
    //    live today-value stays display-side. Unnameable denoms ride in
    //    `unpriced` with raw amounts — a `display` field is allowed only when a
    //    committed trace record exists (PROBES-denom-traces).
    const walletsR = await apiGetJson('docs/curated/wallets.json');
    const walletLabels = (walletsR.ok && walletsR.data && walletsR.data.wallets) || {};
    // Identity from committed PROBES-denom-traces (trace-verified 2026-07-17);
    // bribe-only tokens are outside token-catalog scope by design.
    const BRIBE_ONLY_DISPLAY = {
        'ibc/B2AA4C3CD19954859C3B537EC0705640AFC01075F52993D9AC5E73F07F0386CC': 'DGN',
    };
    const bribersBy = new Map();
    for (const ev of bribes) {
        if (!ev.briber) continue;
        let b = bribersBy.get(ev.briber);
        if (!b) {
            b = { event_count: 0, withdraw_event_count: 0, via: { msg: 0, wasm_event: 0 },
                  first_bribe: null, last_bribe: null,
                  totals: { usd_at_placement: 0, usd_at_build: 0, by_token: {}, unpriced: {} },
                  by_pool: {}, by_epoch: {} };
            bribersBy.set(ev.briber, b);
        }
        if (ev.type !== 'bribe_add') {
            if (String(ev.type || '').includes('withdraw_bribes')) b.withdraw_event_count++;
            continue;
        }
        const epoch = ev.epoch_start ?? (epochOf ? epochOf(ev.timestamp) : null);
        b.event_count++;
        b.via[ev.via === 'wasm_event' ? 'wasm_event' : 'msg']++;
        const date = dayOf(ev.timestamp);
        if (date) {
            if (!b.first_bribe || date < b.first_bribe) b.first_bribe = date;
            if (!b.last_bribe || date > b.last_bribe) b.last_bribe = date;
        }
        const ek = String(epoch ?? 'unknown');
        const slot = (b.by_epoch[ek] ||= { pools: {}, coins: {} });
        if (ev.pool) slot.pools[ev.pool] = (slot.pools[ev.pool] || 0) + 1;
        const pslot = ev.pool ? (b.by_pool[ev.pool] ||= { bribe_count: 0, by_token: {} }) : null;
        if (pslot) pslot.bribe_count++;
        for (const coin of ev.coins || []) {
            if (!coin?.denom || !/^\d+$/.test(String(coin.amount))) continue;
            slot.coins[coin.denom] = (BigInt(slot.coins[coin.denom] || '0') + BigInt(String(coin.amount))).toString();
            const bare = bareDenom(coin.denom);
            const tk = tokenMap.get(bare);
            if (tk && tk.symbol) {
                const amt = Number(coin.amount) / 10 ** tk.decimals;
                const p = await prices.priceOn(tk.symbol, date);
                const tt = (b.totals.by_token[tk.symbol] ||= { amount_display: 0, usd_at_placement: 0, usd_at_build: 0, unpriced_events: 0 });
                tt.amount_display += amt;
                if (p != null) { tt.usd_at_placement += amt * p; b.totals.usd_at_placement += amt * p; }
                else tt.unpriced_events++;
                if (pslot) {
                    const pt = (pslot.by_token[tk.symbol] ||= { amount_display: 0, usd_at_placement: 0 });
                    pt.amount_display += amt;
                    if (p != null) pt.usd_at_placement += amt * p;
                }
            } else {
                const disp = BRIBE_ONLY_DISPLAY[bare];
                const u = (b.totals.unpriced[bare] ||= { amount: '0', bribe_events: 0, ...(disp ? { display: disp } : {}) });
                addBig(u, 'amount', coin.amount);
                u.bribe_events++;
                if (pslot) {
                    const key = disp || bare;
                    const pu = (pslot.by_token[key] ||= { amount_raw: '0', unpriced: true });
                    addBig(pu, 'amount_raw', coin.amount);
                }
            }
        }
    }
    // usd_at_build: latest price × lifetime token total (second pass, per symbol).
    // latestPrice returns { usd, as_of } — same contract the claims pass uses.
    for (const b of bribersBy.values()) {
        for (const [sym, tt] of Object.entries(b.totals.by_token)) {
            const lpR = await prices.latestPrice(sym, builtDate);
            const lp = lpR && typeof lpR.usd === 'number' ? lpR.usd : null;
            if (lp != null) { tt.usd_at_build = tt.amount_display * lp; b.totals.usd_at_build += tt.usd_at_build; }
        }
    }
    const bribers = [...bribersBy.entries()]
        .map(([briber, b]) => ({ briber, label: (walletLabels[briber] && walletLabels[briber].label) || null, ...b }))
        // D6 ordering: usd_at_placement desc; ties / all-unpriced bribers rank
        // after priced ones by bribe_count — never ranked by invented USD.
        .sort((a, b) => (b.totals.usd_at_placement - a.totals.usd_at_placement) || (b.event_count - a.event_count) || (a.briber < b.briber ? -1 : 1));
    const bribers_order = bribers.map(x => x.briber);

    const rollups = {
        schemaVersion: ROLLUPS_SCHEMA,
        spec: 'docs/pending-changes/SPEC-tla-voting-rollups.md',
        builtAt,
        built_on_period: vsIndex.last_harvested_period ?? null,
        sources: {
            vote_state_through_period: vsIndex.last_harvested_period ?? null,
            bribe_state_through_period: bsIndex ? (bsIndex.last_harvested_period ?? null) : null,
            bribe_state_floor: bsIndex ? (bsIndex.floor_period ?? null) : null,
            events_index_counts: Object.fromEntries(Object.entries(index.streams || {}).map(([s, m]) => [s, m.count])),
            distributions_pointer: DISTRIBUTIONS_POINTER,
        },
        claim_coverage: CLAIM_COVERAGE.map(c => ({ ...c, to: c.to === 'builtAt' ? builtAt : c.to })),
        pending_recipe: 'live earned = claims.totals + user_claimable(gauge) + user_pending_rebase(gauge), display-side — see README',
        voter_count: voters.length,
        voters,
        bribers,
        bribers_order,
        bribe_ledger,
        pots: { moved_to: DISTRIBUTIONS_POINTER, note: 'schema-3 event-derived pots retired; distributions is the chain-complete per-period ledger' },
    };
    await publishFile(OUT, JSON.stringify(rollups), `rollups schema 6: ${voters.length} voters, built on period ${rollups.built_on_period}`);
    return { voters: voters.length, bribers: bribers.length, built_on_period: rollups.built_on_period };
}

module.exports = { buildRollups4, buildBribeLedger, ROLLUPS_SCHEMA, buildTokenMap, makePriceLookup, bareDenom, CLAIM_COVERAGE };
