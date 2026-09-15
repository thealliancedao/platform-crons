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

const PNL_VERSION = 'tla-flows-pnl-1.1.1';   // 1.1.1 (2026-09-15): month-at-a-time event folds (heap OOM on Render since the Mon 03:30 build) · 1.1.0: folded into org-tla-flows (build-pnl.js Action retired)
const OUT_DIR = 'tla-flows/pnl';
class PnlFatal extends Error {}

const PRICE_FALLBACK_DAYS = 3; // nearest prior day, method stated in spec

function fail(msg) { throw new PnlFatal(msg); }

// ── Token registry: denom → {symbol, decimals} ──────────────────────────────
async function loadTokenMap(src) {
    const cat = await src.readJson('token-catalog/snapshots/current.json');
    const map = new Map();
    for (const t of cat.tokens || []) {
        const denom = t.denom;
        const sym = t.discovered?.symbol || null;
        const dec = Number.isFinite(t.discovered?.decimals) ? t.discovered.decimals : null;
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
    { let obs = new Map(); for await (const events of eachMonth()) obs = buildImpliedPricesFold(obs, [events], tokenMap, prices, meta); prices.implied = finishImpliedPrices(obs, meta); }
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

    for await (const events of eachMonth()) {   // pass 2 — wallet ledger, one month resident at a time
        for (const e of events) {
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
        }));

    const totals = {
        wallets: walletRows.length,
        fees_usd_at_event: walletRows.reduce((s, r) => s + r.fees_usd_at_event, 0),
        zap_input_usd_at_event: walletRows.reduce((s, r) => s + r.zap_input_usd_at_event, 0),
        claims_recorded: walletRows.reduce((s, r) => s + r.claims.count, 0),
        claimed_yield_usd_at_event: walletRows.reduce((s, r) => s + r.claimed_yield.usd_at_event, 0),
        claimed_yield_luna: walletRows.reduce((s, r) => s + r.claimed_yield.luna_display, 0),
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
        schemaVersion: 1, product: 'tla-flows/pnl', builder: `${PNL_VERSION} (org-tla-flows weekly duty)`,
        builtAt, status: 'ok',
        wallet_count: totals.wallets,
        events_read: meta.events_read,
        fees_usd_at_event: totals.fees_usd_at_event,
        zap_input_usd_at_event: totals.zap_input_usd_at_event,
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
                value_curve: 'NOT present — no pool state exists before dex-data (2026-06-26); the archive state sampler upgrades this tier in place',
            },
            epoch_span: [eKeys[0], eKeys[eKeys.length - 1]],
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
async function runPnlDuty({ fetchJson, listDir, publishFile, rawBase, env = process.env, now = () => new Date() }) {
  const out = { status: 'skipped', reason: null, written: 0, unchanged: 0 };
  if (env.PNL === '0') { out.reason = 'PNL=0'; return out; }
  const t = now(); const force = env.PNL === 'force';
  // gate: current epoch newer than the last build's epoch, and ≥ 3.5 h into the epoch (Mon 03:30 UTC)
  const hb = await fetchJson(`${rawBase}/tla-flows/pnl/heartbeat.json?t=${Date.now()}`).catch(() => null);
  const builtEpoch = hb && hb.builtAt ? epochOf(Date.parse(hb.builtAt)) : 0; const curEpoch = epochOf(t.getTime());
  const intoEpochMs = t.getTime() - (EPOCH_GENESIS_MS + (curEpoch - 1) * EPOCH_MS);
  if (!force && !(curEpoch > builtEpoch && intoEpochMs >= 3.5 * 3600000)) { out.reason = curEpoch > builtEpoch ? `epoch ${curEpoch} started, builds at Mon 03:30 UTC` : `epoch ${curEpoch} already built (${hb && hb.builtAt})`; return out; }
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
  for (const [p, obj] of built.files) {
    const content = serialize(obj); const sha = blobSha(Buffer.from(content));
    if (onMain.get(p) === sha) { out.unchanged++; continue; }
    await publishFile(p, content, `tla-flows/pnl: weekly rollup (epoch ${curEpoch})`); out.written++;
  }
  out.status = 'ok'; out.epoch = curEpoch; out.summary = built.summary; out.files = built.files.size;
  return out;
}
module.exports.runPnlDuty = runPnlDuty; module.exports.epochOfMs = epochOf;
