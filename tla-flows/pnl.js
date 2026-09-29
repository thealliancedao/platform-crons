'use strict';
/**
 * tla-flows / pnl.js — Phase A of SPEC-portfolio-pnl (tla-core/docs/pending-changes/), the WEEKLY P&L ROLLUP DUTY.
 *
 * MOVED 2026-09-13 from tla-core/.github/scripts/tla-flows/build-pnl.js (derive logic verbatim, byte-identical
 * outputs minus builtAt — gated). It was a scheduled Action; rolling up tla-flows' own events is tla-flows'
 * business, so it is a folded duty of org-tla-flows beside `pressure`. LAW: Actions = one-time, Render = scheduled.
 * Fold changes ONLY: reads via `src` (raw reads of the same committed files) instead of a checkout; outputs are
 * RETURNED (Map path → object) and the caller writes ONLY the files whose content changed; per-wallet ledger docs
 * no longer carry builtAt (ledger/index.json + rollup.json do) so an unchanged wallet is never rewritten;
 * fatals throw (PnlFatal) instead of exiting.
 *
 * Pure derive from committed repo data — ZERO chain access. Reads:
 *   tla-flows/events/<YYYY>/<MM>.json   (flow events, classifier v1)
 *   tla-flows/events/index.json         (known_gaps — copied verbatim)
 *   price-history/<YYYY>/<MM>.json      (daily avg USD by symbol)
 *   token-catalog/snapshots/current.json (denom → symbol/decimals)
 *   docs/curated/wallets.json           (labels, registry-first, uniform)
 * Writes:
 *   tla-flows/pnl/rollup.json
 *   tla-flows/pnl/heartbeat.json
 *   tla-flows/pnl/ledger/index.json          (v2 — SPEC-portfolio-epoch-ledger)
 *   tla-flows/pnl/ledger/{address}.json      (per-wallet epoch series)
 *
 * v2 LEDGER (2026-08-03, SPEC-portfolio-epoch-ledger): the SAME event pass
 * additionally buckets every wallet by TLA epoch (docs/epoch_1-300_date.json):
 * per-epoch flow counts, LP-unit DELTAS per pool per unit (amplp/shares kept
 * segregated — never mixed, never converted), and the same Tier-M measured
 * USD legs (zap-in, fees, claimed yield) the rollup carries, just epoch-
 * bucketed. Position VALUE per epoch is NOT here — no historical pool state
 * exists before dex-data (2026-06-26); that tier arrives with the archive
 * state sampler and upgrades in place. Rollup output is unchanged by v2
 * (gate: old-vs-new build byte-identical minus builtAt).
 *
 * Phase A legs (honesty tiers per the spec):
 *   Tier M (measured): zap external inputs (deposit cost.swaps) valued at
 *     event date; swap slippage+fee ledger (spread/commission/maker legs,
 *     ask-asset denominated) valued at event date. Price lookup = exact UTC
 *     day, else nearest PRIOR day within 3 days (fallback counted in meta —
 *     method stated). No forward fill, no today's-price, ever.
 *   Unvalued (honest blank): claims (classifier v1 records no amounts —
 *     Phase B), LP share amounts (no valuation source in Phase A), legs whose
 *     token has no price on/near the event date (e.g. the CAPA hole).
 *
 * Determinism: two runs on identical inputs produce identical rollups except
 * `builtAt` (gate compares with builtAt stripped). All maps sorted.
 */

const PNL_VERSION = 'tla-flows-pnl-1.3.1';   // 1.3.1 (2026-09-29): DAILY build (once per UTC day after 03:30 UTC; PNL_CADENCE=weekly for the old cadence) and an automatic rebuild when the last build was made by an older builder — no PNL=force after a deploy · 1.3.0 (2026-09-28): pnl-positions 1.4.0 — tokens in / out on every trip and position (the page's Tokens lens), open lots' tokens in vs now and their hold value (LP vs hold) · 1.2.5 (2026-09-28): pnl-positions 1.3.1 — moved receipts that tripped the gauge-ceiling check read as moved (named), not disputed · 1.2.4 (2026-09-28): where receipts went — every amplified receipt transfer mapped to its pool and named (custodian / catalog entity / known contract / member / address) → position.moves; a not-held position whose receipt sits with a CUSTODIAN (config CUSTODIANS: the ampCAPA DAO) is held_in, still open, not "not held" (pnl-positions 1.3.0) · 1.2.3 (2026-09-28): the chain referee also says "not held" — a wallet the hourly participants read covered, with NO row for a pool × mechanism the ledger still has open (a receipt staked in a DAO or sent to another address): those lots leave Open now / unrealized / net and the curve's now point (position.not_held, totals.positions_not_held); trips + rewards stay (pnl-positions 1.2.0) · 1.2.2 (2026-09-28): lib/pnl-positions.js 1.1.0 — each open position carries open_lp: LP in vs now (the take-rate drag + top-up on non-amplified, compounding on amplified; unmeasured when no rate sample is near the entry) and capital × days for the APR the page shows · 1.2.1 (2026-09-27): the whole build publishes as ONE commit (lib/git-batch.js), change detection from git trees (no 1,000-file listing cap); pool names in the ledger · 1.2.0 1.2.0 (2026-09-27): build-pnl v3 — positions, FIFO round trips + attribution, value curve per epoch, bribes (lib/pnl-positions.js); catalog symbols from `effective` first · 1.1.1 (2026-09-15): month-at-a-time event folds (heap OOM on Render since the Mon 03:30 build) · 1.1.0: folded into org-tla-flows (build-pnl.js Action retired)
const OUT_DIR = 'tla-flows/pnl';
const PP = require('./lib/pnl-positions');
class PnlFatal extends Error {}

const PRICE_FALLBACK_DAYS = 3; // nearest prior day, method stated in spec

function fail(msg) { throw new PnlFatal(msg); }

// ── Token registry: denom → {symbol, decimals} ──────────────────────────────
async function loadTokenMap(src) {
    const cat = await src.readJson('token-catalog/snapshots/current.json');
    const map = new Map();
    for (const t of cat.tokens || []) {
        const denom = t.denom;
        // 1.2.0: catalog identity from `effective` first (the catalog's stated downstream contract), then `discovered` —
        // 1.1.x read `discovered` only, so tokens named only in the effective layer (ATOM, SWTH, …) were unknown and unpriced
        const sym = t.effective?.symbol || t.discovered?.symbol || null;
        const dec = Number.isFinite(t.effective?.decimals) ? t.effective.decimals : (Number.isFinite(t.discovered?.decimals) ? t.discovered.decimals : null);
        if (denom && sym) map.set(denom, { symbol: sym, decimals: dec ?? 6 });
    }
    if (!map.has('uluna')) fail('token catalog missing uluna — refusing to guess');
    return map;
}

// ── Labels (registry-first, uniform — no special cases) ─────────────────────
async function loadLabels(src) {
    const out = new Map();
    try {
        const w = await src.readJson('docs/curated/wallets.json');
        const entries = Array.isArray(w) ? w : (w.wallets || Object.entries(w).map(([address, v]) =>
            (typeof v === 'string' ? { address, label: v } : { address, ...v })));
        for (const e of entries) {
            const addr = e.address || e.wallet;
            const label = e.label || e.name;
            if (addr && label) out.set(addr, label);
        }
    } catch { /* labels optional — absence is not an error */ }
    return out;
}

// ── Price history: SYMBOL@date → usd ────────────────────────────────────────
async function loadPrices(src) {
    const days = new Map(); // 'YYYY-MM-DD' → {SYM: usd}
    const months = [];
    for (const ym of await src.priceMonths()) {
        {
            const d = await src.readJson(`price-history/${ym}.json`);
            months.push(ym);
            for (const [day, toks] of Object.entries(d.days || {})) {
                const m = {};
                for (const [sym, v] of Object.entries(toks)) if (v && typeof v.usd === 'number') m[sym] = v.usd;
                days.set(day, m);
            }
        }
    }
    return { days, months };
}

// ── Epoch calendar: timestamp → TLA epoch number ────────────────────────────
async function loadEpochs(src) {
    const raw = await src.readJson('docs/epoch_1-300_date.json');
    const rows = Object.values(raw)
        .filter(r => r && r.epoch != null && r.start_time)
        .map(r => ({ epoch: Number(r.epoch), start: Date.parse(r.start_time) }))
        .sort((a, b) => a.start - b.start);
    if (!rows.length) fail('epoch calendar empty');
    return (ts) => {
        const t = Date.parse(ts);
        if (!(t >= rows[0].start)) return null;   // pre-genesis — honestly outside
        let lo = 0, hi = rows.length - 1;
        while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (rows[mid].start <= t) lo = mid; else hi = mid - 1; }
        return rows[lo].epoch;
    };
}

function bigAddSigned(aStr, bStr, sign) {
    return (BigInt(aStr) + (sign < 0 ? -BigInt(bStr) : BigInt(bStr))).toString();
}

function addDays(dateStr, n) {
    const d = new Date(dateStr + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
}

// returns {usd, date_used} or null. Exact day, else ≤3 days PRIOR. Never forward.
function priceAt(prices, symbol, date, meta) {
    for (let i = 0; i <= PRICE_FALLBACK_DAYS; i++) {
        const d = i === 0 ? date : addDays(date, -i);
        const day = prices.days.get(d);
        if (day && typeof day[symbol] === 'number') {
            if (i > 0) meta.price_fallback_legs++;
            return { usd: day[symbol], date_used: d };
        }
        const imp = prices.implied && prices.implied.get(`${symbol}|${d}`);
        if (imp) { meta.implied_price_legs = (meta.implied_price_legs || 0) + 1; return { usd: imp.usd, date_used: d, tier: 'implied_from_swaps' }; }
    }
    return null;
}

// ── Wallet accumulator ──────────────────────────────────────────────────────
function newWallet() {
    return {
        counts: { deposit: 0, withdraw: 0, claim: 0 },
        first_event: null, last_event: null,
        first_by_type: {}, last_by_type: {},
        eras: { fcd: false, walker: false },
        zap_inputs: {},          // SYM → {amount_display, usd_at_event, valued_legs, unvalued_legs}
        zap_inputs_unknown: {},  // denom (no symbol) → {amount_raw_sum, legs}
        fees: {},                // SYM → {spread_display, commission_display, maker_display, usd_at_event, valued_legs, unvalued_legs}
        fees_unknown_legs: 0,
        lp_amounts: { deposit_shares_raw: '0', deposit_lp_raw: '0', withdraw_lp_raw: '0', withdraw_shares_raw: '0' },
        deposits_with_cost: 0,
        claims: { count: 0, valued: false, reason: 'amounts not captured (classifier v1) — Phase B enrichment' },
        claimed_yield: { luna_display: 0, usd_at_event: 0, valued_events: 0, unvalued_price_events: 0, v1_unmeasured_events: 0, measured_records: 0 },
        by_pool: {},   // pool -> {deposits, withdraws, claims, claim_usd_at_event}
        // v2 ledger: epoch → bucket. Filled in the same pass; written sharded.
        epochs: {},    // E -> {c:{dep,wdr,clm}, zap_usd, fees_usd, clm_luna, clm_usd, pools:{pool:{units:{unit:signedRaw}, dep, wdr}}}
        pre_calendar_events: 0,
    };
}

function bigAdd(aStr, bStr) { return (BigInt(aStr) + BigInt(bStr)).toString(); }

// ---- implied-price derivation (Phase B.1) ----------------------------------
// Tokens in the historical price gaps (CAPA/SOLID CoinGecko hole, ampROAR
// never listed) appear constantly in our own captured zap swap legs — each leg
// is an EXECUTED trade with both amounts. Where exactly one side has a
// price-history quote that day, the other side's implied price falls out.
// Daily median across all observations; used only as a FALLBACK tier, labeled
// in meta. WHALE-class tokens stay unpriced by standing doctrine.
const IMPLIED_EXCLUDE = new Set(['WHALE', 'bWHALE', 'ampWHALE']);
// 1.1.1: split into FOLD (per month, accumulates observations) + FINISH (medians). buildImpliedPrices() keeps its old
// signature for gates that already hold the months — it is the same fold + finish, so old and new are identical.
function buildImpliedPricesFold(obs, monthEvents, tokenMap, prices, meta) {
    obs = obs instanceof Map ? obs : new Map(); // 'SYM|date' -> [prices]
    for (const events of monthEvents) {
        for (const e of events) {
            const date = (e.timestamp || '').slice(0, 10);
            const swaps = e.cost && Array.isArray(e.cost.swaps) ? e.cost.swaps : [];
            for (const sw of swaps) {
                const off = tokenMap.get(sw.offer_asset), ask = tokenMap.get(sw.ask_asset);
                if (!off || !ask) continue;
                const day = prices.days.get(date) || {};
                const offP = day[off.symbol], askP = day[ask.symbol];
                const offAmt = Number(sw.offer_amount || 0) / 10 ** off.decimals;
                const askAmt = Number(sw.return_amount || 0) / 10 ** ask.decimals;
                if (!(offAmt > 0 && askAmt > 0)) continue;
                if (typeof offP === 'number' && typeof askP !== 'number' && !IMPLIED_EXCLUDE.has(ask.symbol)) {
                    (obs.get(`${ask.symbol}|${date}`) || obs.set(`${ask.symbol}|${date}`, []).get(`${ask.symbol}|${date}`)).push(offAmt * offP / askAmt);
                } else if (typeof askP === 'number' && typeof offP !== 'number' && !IMPLIED_EXCLUDE.has(off.symbol)) {
                    (obs.get(`${off.symbol}|${date}`) || obs.set(`${off.symbol}|${date}`, []).get(`${off.symbol}|${date}`)).push(askAmt * askP / offAmt);
                }
            }
        }
    }
    return obs;
}
function finishImpliedPrices(obs, meta) {
    const implied = new Map(); // 'SYM|date' -> {usd, n}
    for (const [k, arr] of (obs instanceof Map ? obs : new Map())) {
        arr.sort((x, y) => x - y);
        implied.set(k, { usd: arr[Math.floor(arr.length / 2)], n: arr.length });
    }
    if (meta) meta.implied_price_points = implied.size;
    return implied;
}
function buildImpliedPrices(monthEvents, tokenMap, prices, meta) {
    return finishImpliedPrices(buildImpliedPricesFold(new Map(), monthEvents, tokenMap, prices, meta), meta);
}

function epochBucket(w, E) {
    return w.epochs[E] || (w.epochs[E] = { c: { dep: 0, wdr: 0, clm: 0 }, zap_usd: 0, fees_usd: 0, clm_luna: 0, clm_usd: 0, pools: {} });
}

async function buildPnl(src, { now = () => new Date() } = {}) {
    const out = { files: new Map(), summary: null };
    const tokenMap = await loadTokenMap(src);
    const epochOf = await loadEpochs(src);
    const labels = await loadLabels(src);
    const prices = await loadPrices(src);
    const index = await src.readJson('tla-flows/events/index.json');

    // FCD/walker era boundary from the recorded gap (fall back to spec constant)
    const gap = (index.known_gaps || [])[0] || null;
    const fcdEndHeight = gap ? gap.from_height : 13737811;

    const meta = {
        events_read: 0, by_type: { deposit: 0, withdraw: 0, claim: 0 },
        null_user_events: { deposit: 0, withdraw: 0, claim: 0 },
        retracted_events: { deposit: 0, withdraw: 0, claim: 0 },   // rewalk-by-hash labels (not member flows) — counted, never valued
        months_read: [], price_fallback_legs: 0,
        unpriced_input_legs: 0, unpriced_fee_legs: 0,
        unknown_denoms: {},
    };
    meta.vault_claim_denoms = {};
    const wallets = new Map();
    const W = (addr) => { if (!wallets.has(addr)) wallets.set(addr, newWallet()); return wallets.get(addr); };

    // deterministic month order (events/index.json months_present is the committed listing)
    const monthKeys = []; for (const [y, ms] of Object.entries(index.months_present || {}).sort()) for (const m of [...ms].sort()) monthKeys.push(`${y}/${m}`);
    if (monthKeys.length === 0) fail('no event month files found');
    // 1.1.1 (2026-09-15): NEVER hold every event month at once. 1.1.0 read all 26 months (273 MB of JSON) into an array
    // — fine on the 7 GB GitHub runner the Action used, fatal on Render's ~256 MB heap: every org-tla-flows run since
    // Mon 2026-09-14 03:30 UTC died at this step with "JavaScript heap out of memory" (the epoch-203 rollup never
    // built, the run's heartbeat was lost whenever it died). The build makes two passes; each pass now READS a month,
    // folds it, and drops it — the months are re-read for the second pass (network is cheap, memory is not). Output
    // is byte-identical to 1.1.0 (gate: old-vs-new build minus builtAt).
    const readMonth = async (ym) => { const events = await src.readJson(`tla-flows/events/${ym}.json`); if (!Array.isArray(events)) fail(`tla-flows/events/${ym}.json is not an event array`); return events; };
    const eachMonth = async function* () { for (const ym of monthKeys) yield await readMonth(ym); };
    // pass 1 — implied prices (fold per month)
    // pass 1 also folds the v3 RATE SAMPLES and finds the non-amp ⇄ amp MIGRATIONS (same tx, same wallet, same pool, withdraw
    // under one mechanism + deposit under the other) — a segment boundary, never a realized exit
    const rates = PP.newRates(); const migrations = new Set(); const v3meta = { rate_samples: { events: 0, state_history: 0, participants_now: 0 }, migrations: 0 };
    { let obs = new Map(); for await (const events of eachMonth()) { obs = buildImpliedPricesFold(obs, [events], tokenMap, prices, meta);
        const byTx = new Map();
        for (const e of events) { v3meta.rate_samples.events += PP.rateSamplesFromEvent(rates, e);
          if (!e.retracted && e.user && e.pool && (e.type === 'deposit' || e.type === 'withdraw')) { const k = `${e.txhash}|${e.pool}|${e.user}`; (byTx.get(k) || byTx.set(k, new Set()).get(k)).add(`${e.type}:${PP.mechOf(e.mechanism)}`); } }
        for (const [k, set] of byTx) { const w = [...set].filter(x => x.startsWith('withdraw:')).map(x => x.split(':')[1]), d = [...set].filter(x => x.startsWith('deposit:')).map(x => x.split(':')[1]); if (w.length && d.length && w.some(m => d.some(n => n !== m))) { const [tx, pool] = k.split('|'); migrations.add(`${tx}|${pool}`); } }
      } prices.implied = finishImpliedPrices(obs, meta); }
    v3meta.migrations = migrations.size;
    // pool state + compounder rates from dex-data/state-history (every complete epoch), the hourly participants "now" sample
    const pools = PP.newPools(); let shIndex = null;
    try { shIndex = await src.readJson('dex-data/state-history/index.json'); } catch { shIndex = null; }
    for (const row of (shIndex && shIndex.epochs) || []) { if (!row.complete) continue; let rec = null; try { rec = await src.readJson(`dex-data/state-history/epochs/${row.epoch}.json`); } catch { rec = null; } if (!rec) continue; PP.addEpochState(pools, rec); v3meta.rate_samples.state_history += PP.rateSamplesFromEpoch(rates, rec); }
    PP.finishPools(pools, ((shIndex && shIndex.singles) || []).map(x => x.key));
    pools.names = new Map(); for (const x of [...((shIndex && shIndex.pairs) || []), ...((shIndex && shIndex.singles) || [])]) if (x && x.key && x.name) pools.names.set(x.key, x.name);   // names are data: the sampler's index names every pool it saw
    try { const part = await src.readJson('member-data/participants/current.json'); v3meta.rate_samples.participants_now = PP.rateSamplesFromParticipants(rates, part); v3meta.participants_as_of = part.capturedAt || null; } catch { v3meta.participants_as_of = null; }
    PP.finishRates(rates); v3meta.rate_samples.dropped = rates.dropped; v3meta.rate_samples.state_history_superseded_by_redemptions = rates.state_history_superseded; v3meta.rate_keys = rates.s.size; v3meta.state_history_epochs = pools.epochs.length; v3meta.as_of_epoch = pools.latest ? pools.latest.epoch : null;
    const symDec = (d) => tokenMap.get(PP.norm(d)) || null; const v3pm = { price_fallback_legs: 0, implied_price_legs: 0 }; v3meta.pricing = v3pm;
    const ctx = { rates, pools,
      symbolOf: (d) => { const t = symDec(d); return t ? t.symbol : null; },
      amountDisplay: (d, raw) => { const t = symDec(d); return t ? Number(raw) / 10 ** t.decimals : null; },
      priceUsd: (d, day) => { const t = symDec(d); if (!t) return null; const p = priceAt(prices, t.symbol, day, v3pm); return p ? p.usd : null; },
      lunaUsd: (day) => { const p = priceAt(prices, 'LUNA', day, v3pm); return p ? p.usd : null; } };   // own counters — Phase A's pricing_meta stays Phase A's
    // dispute referees (1.2.0): the gauge totals now (tla-snapshot) and the hourly participants valuation per wallet × pool × mechanism
    { const ceil = new Map(), ref = new Map();
      try { const snap = await src.readJson('member-data/tla-snapshot/current.json'); for (const pl of snap.pools || []) if (pl.gauge_pool_id && Number(pl.staked_in_tla_usd) > 0) ceil.set(pl.gauge_pool_id, Math.max(ceil.get(pl.gauge_pool_id) || 0, Number(pl.staked_in_tla_usd))); } catch { /* no ceiling — the check degrades to participants only */ }
      const readW = new Set();   // 1.2.3: wallets the hourly read covered — for them, NO row for a pool means none held
      try { const part = await src.readJson('member-data/participants/current.json'); for (const m of part.members || []) { if (Array.isArray(m.lp_positions)) readW.add(m.wallet); } for (const m of part.members || []) for (const l of m.lp_positions || []) { const k = `${m.wallet}|${l.pool_gauge_id}|${l.is_amplified ? 'amplified' : 'non_amplified'}`; if (Number.isFinite(Number(l.estimated_position_usd))) ref.set(k, (ref.get(k) || 0) + Number(l.estimated_position_usd)); } } catch { /* none */ }
      ctx.check = (wallet, pool, mech, usd) => {
        // 1.2.5: a wallet the hourly read covered with NO row here is "not held" first — the position is not in the wallet, whatever its size
        if (wallet && readW.has(wallet) && ref.get(`${wallet}|${pool}|${mech}`) == null && usd >= 1) return { reason: 'not_held', ours_usd: Math.round(usd * 100) / 100, participants_usd: 0 };
        const c = ceil.get(pool); if (c != null && usd > Math.max(2 * c, 1000)) return { reason: 'ceiling', ours_usd: Math.round(usd * 100) / 100, gauge_total_usd: Math.round(c * 100) / 100 };
        if (wallet) { const r = ref.get(`${wallet}|${pool}|${mech}`); if (r != null && Math.abs(usd - r) > Math.max(50, 0.5 * Math.max(usd, r))) return { reason: 'participants', ours_usd: Math.round(usd * 100) / 100, participants_usd: Math.round(r * 100) / 100 };
          // 1.2.3 (owner 2026-09-28: ampCAPA + wBTC.osmo-wBTC.axl "open" — receipts that left the wallet by transfer): the read covered this
          // wallet and found NOTHING in this pool × mechanism → the open lots are not held here (staked in a DAO, sent to another address).
          // Not a dispute: the trips and rewards stay; only the open lots leave Open now / unrealized / net and the curve's "now" point.
          if (r == null && readW.has(wallet) && usd >= 1) return { reason: 'not_held', ours_usd: Math.round(usd * 100) / 100, participants_usd: 0 }; }
        return null; };
      v3meta.referees = { gauge_ceilings: ceil.size, participant_positions: ref.size, wallets_read: readW.size }; }
    // 1.2.4 WHERE RECEIPTS WENT (owner 2026-09-28: "show what address it was sent to — its name if registered — and fix it for anyone,
    // any LP, not just this one"): every amplified receipt transfer in tla-flows/transfers (captured since 2025-01), mapped to its
    // pool by the receipt denom (the compounder's amp_denom → underlying LP, archived registry amplp_mappings — fixed once a vault
    // exists), aggregated per wallet × pool × counterparty. Counterparties are named: a CUSTODIAN (config/contracts.js — the receipt
    // is still the member's), an org-catalog entity, a known contract, a member's name, else the bare address.
    { const C = require('../config/contracts.js');
      const recPool = new Map(); try { const reg = await src.readJson('docs/archive/legacy-registry/tla-chain-registry-2026-08-11.json'); for (const [d, m] of Object.entries(reg.amplp_mappings || {})) if (m && m.underlying_lp_address) recPool.set(d, (m.underlying_lp_type === 'cw20' ? 'cw20:' : 'native:') + m.underlying_lp_address); } catch { /* no map → no destinations, never guessed */ }
      const names = new Map(); const put = (a, label, kind) => { if (a && label && !names.has(a)) names.set(a, { label, kind }); };
      for (const cu of (C.CUSTODIANS || [])) put(cu.address, cu.label, 'custodian');
      try { const ac = await src.readJson('catalog/snapshots/current.json'); for (const [a, e] of Object.entries(ac.entities || {})) put(a, e.label, 'entity'); for (const [a, e] of Object.entries(ac.by_address || {})) put(a, e.handle, 'member'); } catch { /* labels are optional */ }
      try { const kc = await src.readJson('docs/curated/known_contracts.json'); for (const c of (kc.contracts || [])) put(c.address, c.name, 'contract'); } catch { /* optional */ }
      try { const part = await src.readJson('member-data/participants/current.json'); for (const m of part.members || []) put(m.wallet, m.name, 'member'); } catch { /* optional */ }
      const byW = new Map(); let nT = 0, nMapped = 0;
      for (const ym of monthKeys) { let rows = null; try { rows = await src.readJson(`tla-flows/transfers/${ym}.json`); } catch { rows = null; } if (!Array.isArray(rows)) continue;
        for (const t of rows) { nT++; const pool = recPool.get(t.denom); if (!pool || !t.from || !t.to) continue; nMapped++; const amt = Number(t.amount) || 0; const day = String(t.timestamp || '').slice(0, 10);
          for (const [w, cp, dir] of [[t.from, t.to, 'out'], [t.to, t.from, 'in']]) { const pm = byW.get(w) || byW.set(w, new Map()).get(w); const cm = pm.get(pool) || pm.set(pool, new Map()).get(pool);
            const x = cm.get(cp) || cm.set(cp, { out_units: 0, in_units: 0, first_day: day, last_day: day, last_tx: t.txhash }).get(cp); x[dir + '_units'] += amt; if (day < x.first_day) x.first_day = day; if (day >= x.last_day) { x.last_day = day; x.last_tx = t.txhash; } } } }
      const cust = new Map((C.CUSTODIANS || []).map(c => [c.address, c]));
      ctx.moves = { of: (wallet, pool, mech) => { if (mech !== 'amplified') return null; const cm = byW.get(wallet) && byW.get(wallet).get(pool); if (!cm) return null;
          return [...cm.entries()].map(([to, x]) => { const n = names.get(to) || null; const c = cust.get(to); return { to, label: n ? n.label : null, kind: n ? n.kind : null, custodian_key: c ? c.key : undefined, out_units: x.out_units, in_units: x.in_units, net_units: x.out_units - x.in_units, first_day: x.first_day, last_day: x.last_day, last_tx: x.last_tx }; })
            .sort((a, b) => b.net_units - a.net_units).slice(0, 6); } };
      v3meta.receipt_moves = { transfers_read: nT, mapped_to_pools: nMapped, receipt_denoms_mapped: recPool.size, labels: names.size, map_source: 'docs/archive/legacy-registry/tla-chain-registry-2026-08-11.json amplp_mappings' }; }
    const books = new Map(); const BOOK = (a) => books.get(a) || books.set(a, PP.newBook()).get(a);
    meta.months_read = [...monthKeys];

    const resolveTok = (denom) => {
        const t = tokenMap.get(denom);
        if (!t) { meta.unknown_denoms[denom] = (meta.unknown_denoms[denom] || 0) + 1; return null; }
        return t;
    };

    const valueLeg = (w, bucket, denom, amountRaw, date) => {
        // bucket: w.zap_inputs or w.fees-style accumulation for one token amount.
        // v2: returns the leg's usd (0 when unvalued) so the epoch ledger can
        // carry the SAME figure — one valuation, two views, no drift possible.
        const amt = BigInt(amountRaw || '0');
        if (amt === 0n) return 0;
        const tok = resolveTok(denom);
        if (!tok) {
            const u = w.zap_inputs_unknown[denom] || (w.zap_inputs_unknown[denom] = { amount_raw_sum: '0', legs: 0 });
            u.amount_raw_sum = bigAdd(u.amount_raw_sum, amountRaw); u.legs++;
            meta.unpriced_input_legs++;
            return 0;
        }
        const disp = Number(amt) / 10 ** tok.decimals;
        const e = bucket[tok.symbol] || (bucket[tok.symbol] = { amount_display: 0, usd_at_event: 0, valued_legs: 0, unvalued_legs: 0 });
        e.amount_display += disp;
        const p = priceAt(prices, tok.symbol, date, meta);
        if (p) { e.usd_at_event += disp * p.usd; e.valued_legs++; return disp * p.usd; }
        e.unvalued_legs++; meta.unpriced_input_legs++;
        return 0;
    };

    for await (const events0 of eachMonth()) {   // pass 2 — wallet ledger, one month resident at a time
        // 1.2.0: stable order — height, then within a tx a withdraw before a deposit (a migration's exit precedes its entry)
        const events = events0.map((e, i) => [e, i]).sort((a, b) => (a[0].height - b[0].height) || (a[0].txhash === b[0].txhash ? ((a[0].type === 'withdraw' ? 0 : 1) - (b[0].type === 'withdraw' ? 0 : 1)) : 0) || (a[1] - b[1])).map(x => x[0]);
        for (const e of events) {
            if (!e.retracted && e.user) { if (e.type === 'claim') PP.applyClaim(BOOK(e.user), ctx, e); else PP.applyEvent(BOOK(e.user), ctx, e, migrations); }
            meta.events_read++;
            const type = e.type;
            if (!(type in meta.by_type)) continue;
            meta.by_type[type]++;
            if (e.retracted) { meta.retracted_events[type]++; continue; }
            if (!e.user) { meta.null_user_events[type]++; continue; }
            const w = W(e.user);
            const date = (e.timestamp || '').slice(0, 10);
            w.counts[type]++;
            if (!w.first_event || e.timestamp < w.first_event) w.first_event = e.timestamp;
            if (!w.last_event || e.timestamp > w.last_event) w.last_event = e.timestamp;
            if (!w.first_by_type[type] || e.timestamp < w.first_by_type[type]) w.first_by_type[type] = e.timestamp;
            if (!w.last_by_type[type] || e.timestamp > w.last_by_type[type]) w.last_by_type[type] = e.timestamp;
            if (e.height <= fcdEndHeight) w.eras.fcd = true; else w.eras.walker = true;
            const E = epochOf(e.timestamp);
            if (E == null) w.pre_calendar_events++;
            const eb = E != null ? epochBucket(w, E) : null;
            if (eb) eb.c[type === 'deposit' ? 'dep' : type === 'withdraw' ? 'wdr' : 'clm']++;
            for (const cc of (e.claimed_coins || [])) meta.vault_claim_denoms[cc.denom] = (meta.vault_claim_denoms[cc.denom] || 0) + 1;

            if (type === 'claim') {
                w.claims.count++;
                if (Array.isArray(e.claims) && e.claims.length) {
                    w.claimed_yield.measured_records++;
                    // Phase B: wallet claim rewards are LUNA — evidenced by the
                    // vault claim callbacks, which name the denom explicitly
                    // (build-time census below guards this; a non-LUNA denom
                    // flips valuation off rather than mispricing).
                    for (const cl of e.claims) {
                        const amt = Number(cl.reward_amount || 0) / 1e6;
                        if (!(amt > 0)) continue;
                        w.claimed_yield.luna_display += amt;
                        if (eb) eb.clm_luna += amt;
                        const p = priceAt(prices, 'LUNA', date, meta);
                        if (p) { w.claimed_yield.usd_at_event += amt * p.usd; w.claimed_yield.valued_events++; if (eb) eb.clm_usd += amt * p.usd; }
                        else { w.claimed_yield.unvalued_price_events++; meta.unpriced_input_legs++; }
                        if (cl.pool) {
                            const bp = (w.by_pool[cl.pool] ||= { deposits: 0, withdraws: 0, claims: 0, claim_usd_at_event: 0 });
                            bp.claims++;
                            if (p) bp.claim_usd_at_event += amt * p.usd;
                        }
                    }
                } else {
                    w.claimed_yield.v1_unmeasured_events++;
                }
                continue;
            }
            if (e.pool) {
                const bp = (w.by_pool[e.pool] ||= { deposits: 0, withdraws: 0, claims: 0, claim_usd_at_event: 0 });
                if (type === 'deposit') bp.deposits++; else if (type === 'withdraw') bp.withdraws++;
            }

            // LP amounts recorded raw, per unit — NOT valued in Phase A
            if (e.amount) {
                const key = `${type}_${e.amount_unit === 'shares' ? 'shares' : 'lp'}_raw`;
                if (w.lp_amounts[key] !== undefined) w.lp_amounts[key] = bigAdd(w.lp_amounts[key], e.amount);
                // v2 ledger: signed unit delta per (pool, unit) per epoch —
                // amplp and shares NEVER mix (no historical exchange rates to
                // convert honestly; the segregation IS the honesty).
                if (eb && e.pool) {
                    const pp = eb.pools[e.pool] || (eb.pools[e.pool] = { units: {}, dep: 0, wdr: 0 });
                    const unit = e.amount_unit || 'unknown';
                    pp.units[unit] = bigAddSigned(pp.units[unit] || '0', e.amount, type === 'withdraw' ? -1 : 1);
                    if (type === 'deposit') pp.dep++; else if (type === 'withdraw') pp.wdr++;
                }
            }

            const swaps = e.cost && Array.isArray(e.cost.swaps) ? e.cost.swaps : null;
            if (!swaps || swaps.length === 0) continue;
            if (type === 'deposit') w.deposits_with_cost++;

            // Tier M leg 1: external inputs = offer assets that are no leg's ask
            if (type === 'deposit') {
                const asks = new Set(swaps.map(s => s.ask_asset));
                for (const s of swaps) {
                    if (asks.has(s.offer_asset)) continue; // internal hop
                    const legUsd = valueLeg(w, w.zap_inputs, s.offer_asset, s.offer_amount, date);
                    if (eb) eb.zap_usd += legUsd;
                }
            }

            // Tier M leg 2: fee ledger — spread/commission/maker in ASK asset
            for (const s of swaps) {
                const tok = resolveTok(s.ask_asset);
                const legs = [['spread', s.spread_amount], ['commission', s.commission_amount], ['maker', s.maker_fee_amount]];
                if (!tok) {
                    if (legs.some(([, v]) => v && BigInt(v) > 0n)) { w.fees_unknown_legs++; meta.unpriced_fee_legs++; }
                    continue;
                }
                const f = w.fees[tok.symbol] || (w.fees[tok.symbol] = {
                    spread_display: 0, commission_display: 0, maker_display: 0,
                    usd_at_event: 0, valued_legs: 0, unvalued_legs: 0,
                });
                let legTotal = 0;
                for (const [name, v] of legs) {
                    if (!v || BigInt(v) === 0n) continue;
                    const disp = Number(BigInt(v)) / 10 ** tok.decimals;
                    f[`${name}_display`] += disp;
                    legTotal += disp;
                }
                if (legTotal === 0) continue;
                const p = priceAt(prices, tok.symbol, date, meta);
                if (p) { f.usd_at_event += legTotal * p.usd; f.valued_legs++; if (eb) eb.fees_usd += legTotal * p.usd; }
                else { f.unvalued_legs++; meta.unpriced_fee_legs++; }
            }
        }
    }

    // pass 3 (1.2.0) — bribe income: tla-voting/events/rewards claim_bribes (coins per token), one month resident at a time
    v3meta.bribe_claims = 0; v3meta.bribe_months = [];
    try {
        const vix = await src.readJson('tla-voting/events/index.json'); const mp = (vix.streams && vix.streams.rewards && vix.streams.rewards.months_present) || {};
        for (const [y, ms] of Object.entries(mp).sort()) for (const m of [...ms].sort()) { const arr = await src.readJson(`tla-voting/events/rewards/${y}/${m}.json`); v3meta.bribe_months.push(`${y}/${m}`);
            for (const r of Array.isArray(arr) ? arr : []) if (r.type === 'claim_bribes' && r.wallet) { PP.applyBribe(BOOK(r.wallet), ctx, r); v3meta.bribe_claims++; } }
    } catch (e) { v3meta.bribe_error = String(e.message || e); }
    // v3 per-wallet output (positions, trips, attribution, value curve)
    const v3 = new Map(); for (const [a, b] of books) v3.set(a, PP.walletOutput(b, ctx, a));

    // ── Assemble rollup (sorted, deterministic) ─────────────────────────────
    const sortObj = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
    const walletRows = [...wallets.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([address, w]) => ({
            address,
            label: labels.get(address) || null,
            counts: w.counts,
            first_event: w.first_event, last_event: w.last_event,
            first_by_type: sortObj(w.first_by_type), last_by_type: sortObj(w.last_by_type),
            eras: w.eras,
            deposits_with_cost: w.deposits_with_cost,
            zap_inputs: sortObj(w.zap_inputs),
            zap_inputs_unknown: sortObj(w.zap_inputs_unknown),
            zap_input_usd_at_event: Object.values(w.zap_inputs).reduce((s, x) => s + x.usd_at_event, 0),
            fees: sortObj(w.fees),
            fees_unknown_legs: w.fees_unknown_legs,
            fees_usd_at_event: Object.values(w.fees).reduce((s, x) => s + x.usd_at_event, 0),
            lp_amounts: w.lp_amounts,
            claims: {
                count: w.claims.count,
                measured_records: w.claimed_yield.measured_records,
                v1_unmeasured_records: w.claimed_yield.v1_unmeasured_events,
                pool_claim_entries: w.claimed_yield.valued_events + w.claimed_yield.unvalued_price_events,
                note: w.claimed_yield.v1_unmeasured_events > 0 ? 'v1-era claims carry no amounts until the E2 re-derive' : undefined,
            },
            claimed_yield: {
                luna_display: w.claimed_yield.luna_display,
                usd_at_event: w.claimed_yield.usd_at_event,
                valued_events: w.claimed_yield.valued_events,
                unvalued_price_events: w.claimed_yield.unvalued_price_events,
            },
            by_pool: sortObj(w.by_pool),
            v3: v3.has(address) ? v3.get(address).totals : undefined,
        }));

    const bribeOnly = [...v3.keys()].filter(a => !wallets.has(a)).sort();   // voters with bribe income but no LP flow event
    const totals = {
        wallets: walletRows.length,
        fees_usd_at_event: walletRows.reduce((s, r) => s + r.fees_usd_at_event, 0),
        zap_input_usd_at_event: walletRows.reduce((s, r) => s + r.zap_input_usd_at_event, 0),
        claims_recorded: walletRows.reduce((s, r) => s + r.claims.count, 0),
        claimed_yield_usd_at_event: walletRows.reduce((s, r) => s + r.claimed_yield.usd_at_event, 0),
        claimed_yield_luna: walletRows.reduce((s, r) => s + r.claimed_yield.luna_display, 0),
        v3: (() => { const T = { positions_disputed: 0, open_value_usd: 0, open_cost_usd: 0, realized_delta_usd: 0, market_usd: 0, lp_usd: 0, claims_usd: 0, bribes_usd: 0, net_usd: 0, trips_valued: 0, trips_blank: 0 };
          for (const [, o] of v3) { const t = o.totals; T.open_value_usd += t.open.value_usd; T.open_cost_usd += t.open.cost_usd; T.realized_delta_usd += t.realized.delta_usd; T.market_usd += t.realized.market_usd; T.lp_usd += t.realized.lp_usd; T.claims_usd += t.rewards.claims_usd; T.bribes_usd += t.rewards.bribes_usd; T.net_usd += t.net_usd; T.trips_valued += t.realized.trips_valued; T.trips_blank += t.realized.trips_blank; T.trips_suspect = (T.trips_suspect || 0) + (t.realized.trips_suspect || 0); T.positions_disputed += t.positions_disputed || 0; T.positions_not_held = (T.positions_not_held || 0) + (t.positions_not_held || 0); T.not_held_usd = (T.not_held_usd || 0) + (t.not_held_usd || 0); }
          for (const k of Object.keys(T)) if (!/trips|disputed|positions_not_held/.test(k)) T[k] = Math.round(T[k] * 100) / 100; T.wallets = v3.size; T.bribe_only_wallets = bribeOnly.length; return T; })(),
    };

    // ── Honesty assertions (abort — never publish inconsistent data) ────────
    for (const t of ['deposit', 'withdraw', 'claim']) {
        const sum = walletRows.reduce((s, r) => s + r.counts[t], 0) + meta.null_user_events[t] + meta.retracted_events[t];
        if (sum !== meta.by_type[t]) fail(`${t} reconcile ${sum} != ${meta.by_type[t]}`);
    }
    const claimSum = walletRows.reduce((s, r) => s + r.counts.claim, 0);
    if (totals.claims_recorded !== claimSum) fail('claims total mismatch');
    for (const r of walletRows) if (r.claims.measured_records + r.claims.v1_unmeasured_records !== r.claims.count)
        fail(`claim record reconcile ${r.address}: ${r.claims.measured_records}+${r.claims.v1_unmeasured_records} != ${r.claims.count}`);
    const vd = Object.keys(meta.vault_claim_denoms || {});
    if (vd.some(x => x !== 'native:uluna')) fail(`reward-denom guard: non-LUNA vault claim denom observed (${vd.join(',')}) — valuation method invalid, refusing to publish`);

    const builtAt = now().toISOString();
    const rollup = {
        schemaVersion: 1,
        spec: 'docs/pending-changes/SPEC-portfolio-pnl.md (Phase A)',
        builtAt,
        phase: 'B',
        method: {
            valuation: `usd at event UTC date from price-history daily avg; fallback nearest PRIOR day <= ${PRICE_FALLBACK_DAYS}d (counted); never forward, never build-time prices`,
            zap_inputs: 'deposit cost.swaps offer assets that are no leg ask_asset (external inputs); lower bound — direct (non-swap) provide legs are not visible to classifier v1',
            fees: 'per swap leg: spread + commission + maker, denominated in ask asset',
            implied_prices: 'gap tokens (e.g. CAPA/SOLID CoinGecko hole, ampROAR) valued from OUR OWN captured swap executions — daily median of implied prices where the counter-asset has a quote; a labeled derived tier, never applied to WHALE-class (unpriced by doctrine)',
            claims: 'v2 claim arrays valued as LUNA at claim-day price — reward denom evidenced by the vault claim callback census (guarded at build: any non-LUNA vault denom disables valuation rather than mispricing); v1-era claims stay unmeasured until the E2 re-derive',
            lp_amounts: 'recorded raw per unit, unvalued in Phase A',
            v3: 'lib/pnl-positions.js ' + PP.VERSION + ' — positions per pool × mechanism in contract units (shares / amplp); LOTS at deposit valued from the provided legs (M) or units × measured rate × pair basket (D); TRIPS at withdraw FIFO, proportional, valued from refund legs (M) or derived (D); market_usd = entry basket at exit prices − in, lp_usd = out − entry basket at exit prices (IL + fees + take rate + compounding); non-amp ⇄ amp migrations carry basis (segment, not an exit); open value at the latest state-history epoch; claims split by open value when a claim lists several pools; bribes from tla-voting claim_bribes; net = realized Δ + unrealized + claims + bribes, in USD and LUNA',
        },
        sources: {
            events_index_counts: index.by_type || null,
            events_read: meta.events_read,
            events_by_type: meta.by_type,
            null_user_events: meta.null_user_events,
            retracted_events: meta.retracted_events,
            months_read: meta.months_read,
            price_history_months: prices.months,
            known_gaps: index.known_gaps || [],
            fcd_walker_boundary_height: fcdEndHeight,
            v3: v3meta,
            bribe_only_wallets: bribeOnly,
        },
        pricing_meta: {
            price_fallback_legs: meta.price_fallback_legs,
            implied_price_points: meta.implied_price_points || 0,
            implied_price_legs: meta.implied_price_legs || 0,
            unpriced_input_legs: meta.unpriced_input_legs,
            unpriced_fee_legs: meta.unpriced_fee_legs,
            unknown_denoms: sortObj(meta.unknown_denoms),
        },
        totals,
        wallets: walletRows,
    };

    out.files.set(`${OUT_DIR}/rollup.json`, rollup);
    out.files.set(`${OUT_DIR}/heartbeat.json`, {
        schemaVersion: 1, product: 'tla-flows/pnl', builder: `${PNL_VERSION} (org-tla-flows daily duty)`,
        builtAt, status: 'ok',
        wallet_count: totals.wallets,
        events_read: meta.events_read,
        fees_usd_at_event: totals.fees_usd_at_event,
        zap_input_usd_at_event: totals.zap_input_usd_at_event,
        v3: totals.v3,
    });

    // ── v2 LEDGER write-out (SPEC-portfolio-epoch-ledger) ───────────────────
    const LEDGER_DIR = `${OUT_DIR}/ledger`;
    let ledgerFiles = 0, negFlagWallets = 0, preCalTotal = 0;
    const epochSpan = { min: null, max: null };
    for (const [address, w] of [...wallets.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        const eKeys = Object.keys(w.epochs).map(Number).sort((a, b) => a - b);
        preCalTotal += w.pre_calendar_events;
        if (!eKeys.length) continue;
        if (epochSpan.min === null || eKeys[0] < epochSpan.min) epochSpan.min = eKeys[0];
        if (epochSpan.max === null || eKeys[eKeys.length - 1] > epochSpan.max) epochSpan.max = eKeys[eKeys.length - 1];
        // reconcile: Σ epoch counts + pre-calendar == wallet counts — abort on drift
        const sums = { dep: 0, wdr: 0, clm: 0 };
        for (const E of eKeys) { const b = w.epochs[E]; sums.dep += b.c.dep; sums.wdr += b.c.wdr; sums.clm += b.c.clm; }
        const pre = w.pre_calendar_events;
        if (sums.dep + sums.wdr + sums.clm + pre !== w.counts.deposit + w.counts.withdraw + w.counts.claim)
            fail(`ledger epoch reconcile ${address}: ${sums.dep + sums.wdr + sums.clm}+${pre} != ${w.counts.deposit + w.counts.withdraw + w.counts.claim}`);
        // cumulative per pool|unit at head + negative-dip census (unit-mix or
        // missing-capture flags — counted and listed, never hidden or clamped)
        const cum = {}; const negFlags = [];
        for (const E of eKeys) {
            const b = w.epochs[E];
            for (const [pool, pp] of Object.entries(b.pools)) {
                for (const [unit, delta] of Object.entries(pp.units)) {
                    const k = `${pool}|${unit}`;
                    cum[k] = bigAdd(cum[k] || '0', delta);
                    if (BigInt(cum[k]) < 0n && !negFlags.includes(k)) negFlags.push(k);
                }
            }
        }
        if (negFlags.length) negFlagWallets++;
        const sortObj2 = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
        const doc = {
            schemaVersion: 1,
            spec: 'docs/pending-changes/SPEC-portfolio-epoch-ledger.md',
            address,
            // builtAt intentionally absent since the fold (1.1.0): ledger/index.json carries it; an unchanged wallet is not rewritten
            method: {
                buckets: 'every captured flow event bucketed by TLA epoch (docs/epoch_1-300_date.json start_times)',
                units: 'LP-unit deltas per pool per unit (amplp/shares segregated — no historical exchange rates exist to convert honestly)',
                usd_legs: 'identical Tier-M figures as rollup.json (same valuation calls), epoch-bucketed: zap-in, swap fees, claimed LUNA yield at claim-day price',
                value_curve: 'v3 (1.2.0): v3.value_curve — open units at every complete state-history epoch boundary (E97+) → LP (measured rate) → that epoch\'s pair basket → USD at that day\'s price, and LUNA; pools not sampled or unpriced are listed in `missing` (the total is then a lower bound)',
            },
            epoch_span: [eKeys[0], eKeys[eKeys.length - 1]],
            v3: v3.get(address),
            pre_calendar_events: pre || undefined,
            negative_unit_flags: negFlags.length ? negFlags.sort() : undefined,
            cumulative_units_at_head: sortObj2(cum),
            epochs: Object.fromEntries(eKeys.map(E => {
                const b = w.epochs[E];
                return [E, {
                    c: b.c,
                    zap_usd: b.zap_usd || undefined,
                    fees_usd: b.fees_usd || undefined,
                    clm_luna: b.clm_luna || undefined,
                    clm_usd: b.clm_usd || undefined,
                    pools: Object.fromEntries(Object.entries(b.pools).sort(([a], [b2]) => a.localeCompare(b2)).map(([pool, pp]) => [pool, { dep: pp.dep || undefined, wdr: pp.wdr || undefined, units: sortObj2(pp.units) }])),
                }];
            })),
        };
        out.files.set(`${LEDGER_DIR}/${address}.json`, doc);
        ledgerFiles++;
    }
    for (const address of bribeOnly) { out.files.set(`${LEDGER_DIR}/${address}.json`, { schemaVersion: 1, spec: 'docs/pending-changes/SPEC-portfolio-epoch-ledger.md', address, note: 'bribe income only — no LP flow event captured for this wallet', v3: v3.get(address) }); ledgerFiles++; }
    out.files.set(`${LEDGER_DIR}/index.json`, {
        schemaVersion: 1,
        spec: 'docs/pending-changes/SPEC-portfolio-epoch-ledger.md',
        builtAt,
        wallet_files: ledgerFiles,
        epoch_span: [epochSpan.min, epochSpan.max],
        pre_calendar_events_total: preCalTotal,
        negative_unit_flag_wallets: negFlagWallets,
        note: 'per-wallet epoch series at ledger/{address}.json — flow counts, segregated LP-unit deltas, Tier-M measured USD legs. Value curve absent by design until the archive state sampler.',
    });

    console.log(`OK: ${totals.wallets} wallets, ${meta.events_read} events`);
    console.log(`  ledger: ${ledgerFiles} wallet files, epochs ${epochSpan.min}→${epochSpan.max}, neg-unit-flag wallets: ${negFlagWallets}, pre-calendar events: ${preCalTotal}`);
    console.log(`  DAO-wide fees (usd@event):      ${totals.fees_usd_at_event.toFixed(2)}`);
    console.log(`  DAO-wide zap inputs (usd@event): ${totals.zap_input_usd_at_event.toFixed(2)}`);
    console.log(`  claims recorded:                 ${totals.claims_recorded} (yield valued: ${totals.claimed_yield_luna.toFixed(0)} LUNA ≈ ${totals.claimed_yield_usd_at_event.toFixed(2)} usd@event)`);
    console.log(`  unpriced legs: inputs=${meta.unpriced_input_legs} fees=${meta.unpriced_fee_legs} fallback=${meta.price_fallback_legs}`);
    out.summary = { wallets: totals.wallets, events: meta.events_read, ledger_files: ledgerFiles, epoch_span: [epochSpan.min, epochSpan.max], builtAt };
    return out;
}

const serialize = (o) => JSON.stringify(o, null, 1) + '\n';   // the Action's exact on-disk format
module.exports = { buildPnl, PnlFatal, PNL_VERSION, OUT_DIR, serialize };

// ── The weekly duty wrapper (org-tla-flows 3.4.0) ────────────────────────────────────────────────────────────────
// Runs once per TLA epoch, on the first tla-flows run at/after Monday 03:30 UTC (the Action's old slot — after the
// Sunday voting rollup window), or when PNL=force. Reads the committed inputs via raw, derives, then writes ONLY the
// files whose content differs from what is on main (git blob sha compare via one directory listing per folder), so a
// week where nothing changed for a wallet costs no commit for it.
//   deps: { fetchJson(url), listDir(repoPath) → [{path, sha}] | null, publishFile(path, content, msg), rawBase, env, now }
const crypto = require('crypto');
const EPOCH_GENESIS_MS = Date.parse('2022-10-31T00:00:00Z'), EPOCH_MS = 7 * 86400000;
const epochOf = (ms) => Math.floor((ms - EPOCH_GENESIS_MS) / EPOCH_MS) + 1;
const blobSha = (buf) => crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
async function runPnlDuty({ fetchJson, listDir, publishFile, publishBatch, rawBase, env = process.env, now = () => new Date() }) {
  const out = { status: 'skipped', reason: null, written: 0, unchanged: 0 };
  if (env.PNL === '0') { out.reason = 'PNL=0'; return out; }
  const t = now(); const force = env.PNL === 'force';
  // 1.3.1 gate (owner 2026-09-29: "should P&L run more often than weekly?"): DAILY by default — once per UTC day at/after 03:30 UTC (the
  // daily prices and ratios are in by then); PNL_CADENCE=weekly keeps the old once-per-epoch (Mon 03:30 UTC). A build made by an OLDER
  // builder version is rebuilt on the next run by itself — no PNL=force needed after a deploy (and none to forget to remove).
  const hb = await fetchJson(`${rawBase}/tla-flows/pnl/heartbeat.json?t=${Date.now()}`).catch(() => null);
  const builtEpoch = hb && hb.builtAt ? epochOf(Date.parse(hb.builtAt)) : 0; const curEpoch = epochOf(t.getTime());
  const intoEpochMs = t.getTime() - (EPOCH_GENESIS_MS + (curEpoch - 1) * EPOCH_MS);
  const builtDay = hb && hb.builtAt ? String(hb.builtAt).slice(0, 10) : ''; const today = t.toISOString().slice(0, 10);
  const pastHour = t.getUTCHours() * 60 + t.getUTCMinutes() >= 3 * 60 + 30;
  const staleBuilder = !!(hb && hb.builder && !String(hb.builder).startsWith(PNL_VERSION));
  const weekly = String(env.PNL_CADENCE || 'daily') === 'weekly';
  const due = weekly ? (curEpoch > builtEpoch && intoEpochMs >= 3.5 * 3600000) : (builtDay < today && pastHour);
  if (!force && !due && !staleBuilder) { out.reason = weekly ? (curEpoch > builtEpoch ? `epoch ${curEpoch} started, builds at Mon 03:30 UTC` : `epoch ${curEpoch} already built (${hb && hb.builtAt})`) : (builtDay >= today ? `already built today (${hb && hb.builtAt})` : 'builds after 03:30 UTC'); return out; }
  if (staleBuilder && !force && !due) console.log(`  pnl: the last build was made by ${hb.builder} — rebuilding with ${PNL_VERSION}`);
  // derive
  const src = {
    readJson: (p) => fetchJson(`${rawBase}/${p}?t=${Date.now()}`),
    priceMonths: async () => { const ms = []; const y0 = 2022, m0 = 1; const yN = t.getUTCFullYear(), mN = t.getUTCMonth() + 1;
      for (let y = y0; y <= yN; y++) for (let m = (y === y0 ? m0 : 1); m <= (y === yN ? mN : 12); m++) { const ym = `${y}/${String(m).padStart(2, '0')}`; try { await fetchJson(`${rawBase}/price-history/${ym}.json?t=${Date.now()}`); ms.push(ym); } catch (e) { if (!/HTTP 404/.test(String(e.message))) throw e; } }
      return ms; },
  };
  const built = await buildPnl(src, { now });
  // write only what changed: one listing per folder → blob shas of what is on main
  const onMain = new Map();
  for (const dir of [OUT_DIR, `${OUT_DIR}/ledger`]) { const list = await listDir(dir); for (const f of list || []) if (f.sha) onMain.set(f.path, f.sha); }
  // 1.2.1: ONE commit for the whole build when the caller gives publishBatch (lib/git-batch.js) — the per-file path took ~20 min
  // for ~790 files and a second run collided with the first; per-file stays as the fallback (and for the gate's old harness)
  const changed = [];
  for (const [p, obj] of built.files) {
    const content = serialize(obj); const sha = blobSha(Buffer.from(content));
    if (onMain.get(p) === sha) { out.unchanged++; continue; }
    changed.push({ path: p, content });
  }
  if (publishBatch && changed.length) { const r = await publishBatch(changed, `tla-flows/pnl: rollup ${t.toISOString().slice(0, 10)} (epoch ${curEpoch}) — ${changed.length} files`); out.written = changed.length; out.commit = r && r.commit; out.batch = { chunks: r && r.chunks, attempts: r && r.attempts }; }
  else for (const f of changed) { await publishFile(f.path, f.content, `tla-flows/pnl: rollup ${t.toISOString().slice(0, 10)} (epoch ${curEpoch})`); out.written++; }
  out.status = 'ok'; out.epoch = curEpoch; out.summary = built.summary; out.files = built.files.size;
  return out;
}
module.exports.runPnlDuty = runPnlDuty; module.exports.epochOfMs = epochOf;
