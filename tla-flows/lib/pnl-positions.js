'use strict';
/**
 * tla-flows / lib/pnl-positions.js 1.0.0 (2026-09-27) — build-pnl v3: POSITIONS, ROUND TRIPS, VALUE CURVE.
 * Milestone A step 3 (ii). SPEC-portfolio-roundtrip-pnl §3b/§4, SPEC-portfolio-epoch-ledger, SPEC-registry-extensions-pnl §5.
 * Pure — no I/O. pnl.js feeds it events month by month (one month resident), then asks for the per-wallet output.
 *
 * THE MODEL (every leg labeled with its tier: M = measured in the tx · D = derived, method stated · null = honestly blank)
 *   position   = wallet × pool (the LP token / single-asset denom the gauge stakes) × mechanism (non_amplified | amplified)
 *   units      = what the staking contract books: non_amplified → SHARES, amplified → AMPLP. Never mixed, never converted
 *                except through a RATE CURVE (below). A migration non-amp ⇄ amp is a SEGMENT BOUNDARY, not an exit.
 *   rate curve = LP per unit over time, per position key, MEASURED from every event that shows both sides:
 *                  non-amp deposit with provides (provides.share LP ↔ shares minted) · non-amp withdraw with withdraw_liqs
 *                  (LP burned ↔ shares) · amp deposit flow (bond_amount LP ↔ bond_share amplp) · amp withdraw flow
 *                  (LP out ↔ amplp_burned) · dex-data/state-history compounder lp_per_amplp at every epoch · the hourly
 *                  participants snapshot (user_balance ↔ user_shares, "now"). Log-linear between samples (a take rate /
 *                  compounding rate is a constant-rate process between reads); outside the sampled span → the nearest
 *                  sample (tier D, distance stated). A key with no sample at all → unit = LP at par, tier `assumed_par` (counted).
 *   basket     = tokens per LP at a time: dex-data/state-history pair {assets, total_share} at the nearest epoch
 *                boundary (tier D, days away stated; > MAX_BASKET_DAYS → blank). Single-asset gauges: 1 LP = 1 token.
 *   LOT        = one deposit: units, and what went in —
 *                  provides[] assets (both sides, as provided) → tier M
 *                  amp deposit without provides: bond_amount LP × basket at t → tier D
 *                  otherwise units × rate × basket at t → tier D
 *                valued at price-history on the event's UTC day (USD) and in LUNA (USD ÷ LUNA that day).
 *   TRIP       = one withdraw: units consumed FIFO (partial lots consumed proportionally), what came out —
 *                  withdraw_liqs refund_assets → tier M · else LP out (amp: the event amount; non-amp: units × rate) × basket → D
 *                in / out / delta (USD and LUNA) and the attribution identity, exact by construction:
 *                  market_usd = entry basket at EXIT-day prices − in_usd       (what the prices did to what you put in)
 *                  lp_usd     = out_usd − entry basket at exit-day prices      (IL + fees + take rate + compounding, net)
 *                  delta_usd  = out_usd − in_usd = market_usd + lp_usd
 *                Units a withdraw takes beyond the open lots (history before capture, LP moved in by transfer) are
 *                `unmatched` — valued on the out side, no cost basis, counted, never given a phantom zero cost.
 *   SEGMENT    = a withdraw + deposit of the same pool by the same wallet in the same tx with different mechanisms:
 *                the consumed cost basis is CARRIED into the new lot (no realized trip), the boundary is recorded.
 *   REWARDS    = LUNA claims (tla-flows `claims[]`) attributed to pools: a single-pool claim → that pool (M); a claim
 *                listing several pools → split by the wallet's open value in each at that day (D, method stated);
 *                nothing open → `unattributed`. Bribes (tla-voting claim_bribes) → wallet income, per token (M).
 *   VALUE CURVE= at every complete state-history epoch boundary from the wallet's first event: open units → LP (rate at
 *                the boundary) → basket (that epoch's pair state, exact) → USD at that day's price, and LUNA. Pools the
 *                sampler did not read, or tokens with no price, are listed in `missing` — the total is then a lower bound.
 */

const VERSION = 'pnl-positions-1.3.0';   // 1.3.0 (2026-09-28): positions carry moves[] (where their receipts went, named) and held_in when a not-held receipt sits with a custodian (kept open and counted) · 1.2.0 (2026-09-28): a referee answer {reason:'not_held'} marks the position not_held — its open lots stay listed but leave the open totals, unrealized, net and the curve's now point; realized trips and claims are kept (unlike a dispute, which drops the whole position) · 1.1.0 (2026-09-28, owner: LPs "how much the take rate has taken compared to entry so they know how much to top it up with" + realised APRs): every lot keeps the LP tokens it put in (lp_in); positions export open LP in vs now (take-rate drag for non-amplified, compounding growth for amplified, both valued now) and open capital × days for APR
const DAY = 86400000;
const MAX_BASKET_DAYS = 10;           // an event more than 10 days from any epoch read of its pool gets no derived basket
const RATE_BOUNDS = [0.05, 20];       // a sample outside these is a parse error, not a rate — dropped and counted

const norm = (d) => String(d == null ? '' : d).replace(/^(native|cw20):/, '');
const num = (x) => { const n = Number(x); return Number.isFinite(n) ? n : 0; };
const r2 = (x) => Math.round(x * 100) / 100;
const r6 = (x) => Math.round(x * 1e6) / 1e6;
const mechOf = (m) => (m === 'amplified' ? 'amplified' : 'non_amplified');
const keyOf = (pool, mech) => `${pool}|${mechOf(mech)}`;

// ── rate curves ─────────────────────────────────────────────────────────────────────────────────────────────────────
function newRates() { return { s: new Map(), dropped: 0, finished: false }; }
function addRate(R, key, t, r, src) {
  if (!(r > RATE_BOUNDS[0] && r < RATE_BOUNDS[1]) || !Number.isFinite(t)) { R.dropped++; return; }
  (R.s.get(key) || R.s.set(key, []).get(key)).push([t, r, src]);
}
function finishRates(R) {
  for (const [k, arr0] of R.s) {
    // one definition per key: where users' own bond/unbond txs sampled the redemption rate (LP per amplp actually paid),
    // the sampler's total_lp/total_amplp is NOT the same quantity (it runs ~0.95 and falling on keys whose redemption rate
    // is ~1.16 and rising, e.g. USDC.n-USDT 2026-09) — so it is used only for keys with no event sample
    const hasEvent = arr0.some(x => x[2] === 'bond' || x[2] === 'unbond');
    const arr = hasEvent ? arr0.filter(x => x[2] !== 'state-history') : arr0; if (hasEvent) R.sh_dropped = (R.sh_dropped || 0) + (arr0.length - arr.length);
    arr.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const out = []; for (const x of arr) { const last = out[out.length - 1]; if (last && last[0] === x[0]) continue; out.push(x); }   // one sample per instant
    R.s.set(k, out);
  }
  R.finished = true; R.state_history_superseded = R.sh_dropped || 0; return R;
}
// → { r, tier: 'event'|'curve'|'nearest'|'assumed_par', days }
function rateAt(R, key, t) {
  const a = R.s.get(key);
  if (!a || !a.length) return { r: 1, tier: 'assumed_par', days: null };
  if (t <= a[0][0]) return { r: a[0][1], tier: t === a[0][0] ? 'event' : 'nearest', days: Math.round((a[0][0] - t) / DAY) };
  const n = a.length; if (t >= a[n - 1][0]) return { r: a[n - 1][1], tier: t === a[n - 1][0] ? 'event' : 'nearest', days: Math.round((t - a[n - 1][0]) / DAY) };
  let lo = 0, hi = n - 1; while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (a[mid][0] <= t) lo = mid; else hi = mid; }
  const [t0, v0] = a[lo], [t1, v1] = a[hi]; if (t === t0) return { r: v0, tier: 'event', days: 0 };
  const f = (t - t0) / (t1 - t0); return { r: Math.exp(Math.log(v0) + f * (Math.log(v1) - Math.log(v0))), tier: 'curve', days: 0 };
}

// rate samples an event carries (pass 1). Returns the number added.
function rateSamplesFromEvent(R, e) {
  if (!e || e.retracted || !e.pool || !e.user) return 0; const t = Date.parse(e.timestamp); let n = 0;
  const mech = mechOf(e.mechanism);
  if (mech === 'non_amplified') {
    const units = num(e.amount);
    if (e.type === 'deposit' && Array.isArray(e.provides) && e.provides.length === 1 && units > 0) { const lp = num(e.provides[0].share); if (lp > 0) { addRate(R, keyOf(e.pool, mech), t, lp / units, 'provide'); n++; } }
    if (e.type === 'withdraw' && Array.isArray(e.withdraw_liqs) && e.withdraw_liqs.length === 1 && units > 0) { const lp = num(e.withdraw_liqs[0].share); if (lp > 0) { addRate(R, keyOf(e.pool, mech), t, lp / units, 'withdraw_liq'); n++; } }
  } else {
    for (const f of e.flows || []) {
      if (f.user !== e.user || mechOf(f.mechanism) !== 'amplified') continue;
      if (f.type === 'deposit' && num(f.bond_amount) > 0 && num(f.bond_share) > 0) { addRate(R, keyOf(e.pool, mech), t, num(f.bond_amount) / num(f.bond_share), 'bond'); n++; }
      if (f.type === 'withdraw' && num(f.amount) > 0 && num(f.amplp_burned) > 0) { addRate(R, keyOf(e.pool, mech), t, num(f.amount) / num(f.amplp_burned), 'unbond'); n++; }
    }
  }
  return n;
}
function rateSamplesFromEpoch(R, rec) {
  const t = Date.parse(rec.height_time || rec.start_time); let n = 0;
  for (const x of (rec.compounder && rec.compounder.rates) || []) if (x && x.asset && num(x.lp_per_amplp) > 0) { addRate(R, keyOf(x.asset, 'amplified'), t, num(x.lp_per_amplp), 'state-history'); n++; }
  return n;
}
function rateSamplesFromParticipants(R, doc) {
  const t = Date.parse(doc && doc.capturedAt); let n = 0; if (!Number.isFinite(t)) return 0;
  for (const m of (doc && doc.members) || []) for (const l of m.lp_positions || []) {
    if (l.is_amplified) continue; const s = num(l.amplp_shares_raw), b = num(l.amplp_balance_raw);
    if (s >= 1e6 && b > 0) { addRate(R, keyOf(l.pool_gauge_id, 'non_amplified'), t, b / s, 'participants-now'); n++; }   // dust (< 1 whole share) says nothing
  }
  return n;
}

// ── pool state (baskets per LP) from state-history ───────────────────────────────────────────────────────────────────
function newPools() { return { byPool: new Map(), epochs: [], singles: new Set(), latest: null }; }
function addEpochState(P, rec) {
  if (!rec || !rec.complete) return;
  const t = Date.parse(rec.start_time), day = String(rec.start_time).slice(0, 10);
  P.epochs.push({ epoch: rec.epoch, t, day });
  for (const [pool, x] of Object.entries(rec.pairs || {})) {
    if (!x || !x.ok || !Array.isArray(x.assets) || !(num(x.total_share) > 0)) continue;
    const ts = num(x.total_share);
    (P.byPool.get(pool) || P.byPool.set(pool, []).get(pool)).push({ epoch: rec.epoch, t, basket: x.assets.map(a => ({ denom: norm(a.denom), per: num(a.amount) / ts })) });
  }
  if (!P.latest || rec.epoch > P.latest.epoch) P.latest = { epoch: rec.epoch, t, day };
}
function finishPools(P, singles) {
  for (const s of singles || []) P.singles.add(s);
  for (const arr of P.byPool.values()) arr.sort((a, b) => a.t - b.t);
  P.epochs.sort((a, b) => a.epoch - b.epoch); return P;
}
// → { basket:[{denom, per}], tier, days, epoch } | null
function basketAt(P, pool, t, exactEpoch) {
  if (P.singles.has(pool)) return { basket: [{ denom: norm(pool), per: 1 }], tier: 'single', days: 0, epoch: null };
  const a = P.byPool.get(pool); if (!a || !a.length) return null;
  if (exactEpoch != null) { const x = a.find(z => z.epoch === exactEpoch); return x ? { basket: x.basket, tier: 'epoch', days: 0, epoch: x.epoch } : null; }
  let best = null, bd = Infinity; for (const x of a) { const d = Math.abs(x.t - t); if (d < bd) { bd = d; best = x; } }
  if (!best || bd > MAX_BASKET_DAYS * DAY) return null;
  return { basket: best.basket, tier: 'D', days: Math.round(bd / DAY), epoch: best.epoch };
}

// ── the book ────────────────────────────────────────────────────────────────────────────────────────────────────────
// ctx: { rates, pools, priceUsd(denomBare, day) → usd|null, lunaUsd(day) → usd|null, amountDisplay(denomBare, raw) → number|null }
function newBook() { return { positions: new Map(), bribes: {}, bribes_usd: 0, bribes_luna: 0, bribes_unpriced: 0, unattributed_claims: { luna: 0, usd: 0, n: 0 }, segments: 0, unit_timeline: [] }; }
function pos(book, key) {
  let p = book.positions.get(key);
  if (!p) { const [pool, mech] = key.split('|'); p = { pool, mech, lots: [], trips: [], units_open: 0, unmatched_units: 0, claims: { luna: 0, usd: 0, n: 0, split_n: 0 }, carried_in: 0, deposits: 0, withdraws: 0, tiers: {} }; book.positions.set(key, p); }
  return p;
}
function valueBasket(ctx, items, day) {   // items: [{denom, amount}] display amounts → { usd, luna, priced, missing:[denom] }
  let usd = 0, ok = true; const missing = [];
  for (const it of items) { if (!(it.amount > 0)) continue; const px = ctx.priceUsd(it.denom, day); if (px == null) { ok = false; missing.push(it.denom); continue; } usd += it.amount * px; }
  const L = ctx.lunaUsd(day); return { usd, luna: L ? usd / L : null, priced: ok, missing };
}
function basketItemsFromLp(ctx, basket, lpRaw) {   // tokens for lpRaw raw LP units (display amounts)
  const out = []; for (const b of basket) { const d = ctx.amountDisplay(b.denom, b.per * lpRaw); if (d == null) return null; out.push({ denom: b.denom, amount: d }); } return out;
}
function legsItems(ctx, assets) {   // [{denom, amount raw}] → display items, null if a denom has no decimals
  const out = []; for (const a of assets || []) { const d = ctx.amountDisplay(norm(a.denom), num(a.amount)); if (d == null) return null; if (d > 0) out.push({ denom: norm(a.denom), amount: d }); } return out;
}
const tierCount = (p, k) => { p.tiers[k] = (p.tiers[k] || 0) + 1; };

// one flow event into the book (pass 2, chronological within a month; months in order). migrations: Set of `${tx}|${pool}`.
function applyEvent(book, ctx, e, migrations) {
  if (!e || e.retracted || !e.user || !e.pool || !(e.type === 'deposit' || e.type === 'withdraw')) return;
  const t = Date.parse(e.timestamp), day = String(e.timestamp).slice(0, 10), mech = mechOf(e.mechanism), key = keyOf(e.pool, mech);
  const p = pos(book, key); const isSeg = migrations && migrations.has(`${e.txhash}|${e.pool}`);
  if (e.type === 'deposit') {
    const units = num(e.amount); if (!(units > 0)) return; p.deposits++;
    let items = null, tier = null;
    if (Array.isArray(e.provides) && e.provides.length) { items = legsItems(ctx, e.provides.flatMap(pr => pr.assets || [])); tier = items ? 'M' : null; }
    if (!items) {
      let lpRaw = null;
      if (mech === 'amplified') { const f = (e.flows || []).find(x => x.user === e.user && mechOf(x.mechanism) === 'amplified' && num(x.bond_amount) > 0); if (f) lpRaw = num(f.bond_amount); }
      if (lpRaw == null) { const rr = rateAt(ctx.rates, key, t); lpRaw = units * rr.r; }
      const b = basketAt(ctx.pools, e.pool, t); if (b) { items = basketItemsFromLp(ctx, b.basket, lpRaw); tier = items ? 'D' : null; }
    }
    const v = items ? valueBasket(ctx, items, day) : null;
    // 1.1.0: LP tokens this deposit put in — amplified: the bond amount the flow names; non-amplified: shares × the measured rate that day
    let lpIn = null, lpInOk = false; { if (mech === 'amplified') { const f = (e.flows || []).find(x => x.user === e.user && mechOf(x.mechanism) === 'amplified' && num(x.bond_amount) > 0); if (f) { lpIn = num(f.bond_amount); lpInOk = true; } } if (lpIn == null) { const rr = rateAt(ctx.rates, key, t); lpIn = rr && rr.r > 0 ? units * rr.r : null; lpInOk = !!rr && (rr.tier === 'event' || rr.tier === 'curve' || (rr.tier === 'nearest' && rr.days != null && rr.days <= 7)); } }   // measured = the event's own amount, or a rate sample within 7 days
    let lot = { t, day, units, lp_in: lpIn, lp_in_measured: lpInOk, items, in_usd: v && v.priced ? v.usd : null, in_luna: v && v.priced ? v.luna : null, tier: v && v.priced ? tier : null, missing: v ? v.missing : ['no-basket'] };
    if (isSeg && book._carry && book._carry.tx === e.txhash && book._carry.pool === e.pool) {   // migration: carry the consumed basis
      const c = book._carry; lot = { t: c.t, day: c.day, units, lp_in: lpIn, lp_in_measured: lpInOk, items: c.items, in_usd: c.in_usd, in_luna: c.in_luna, tier: c.tier, carried: { from: c.mech, at: day }, missing: c.missing };
      book._carry = null; book.segments++; p.carried_in++;
    }
    tierCount(p, 'lot:' + (lot.tier || 'blank')); p.lots.push(lot); p.units_open += units;
    book.unit_timeline.push([t, key, units]);
    return;
  }
  // withdraw
  let units = num(e.amount); if (mech === 'amplified') { const f = (e.flows || []).find(x => x.user === e.user && mechOf(x.mechanism) === 'amplified' && num(x.amplp_burned) > 0); units = f ? num(f.amplp_burned) : (() => { const rr = rateAt(ctx.rates, key, t); return rr.r > 0 ? num(e.amount) / rr.r : 0; })(); }
  if (!(units > 0)) return; p.withdraws++;
  // what came out
  let outItems = null, outTier = null;
  if (Array.isArray(e.withdraw_liqs) && e.withdraw_liqs.length) { outItems = legsItems(ctx, e.withdraw_liqs.flatMap(w => w.refund_assets || [])); outTier = outItems ? 'M' : null; }
  if (!outItems) { const lpRaw = mech === 'amplified' ? num(e.amount) : units * rateAt(ctx.rates, key, t).r; const b = basketAt(ctx.pools, e.pool, t); if (b) { outItems = basketItemsFromLp(ctx, b.basket, lpRaw); outTier = outItems ? 'D' : null; } }
  const outV = outItems ? valueBasket(ctx, outItems, day) : null;
  // consume FIFO — each consumed piece is split off its lot first (partial lots consumed proportionally)
  let need = units; const parts = [];
  while (need > 1e-9 && p.lots.length) {
    const lot = p.lots[0]; const take = Math.min(need, lot.units); const f = take / lot.units;
    parts.push({ t: lot.t, day: lot.day, units: take, items: lot.items ? lot.items.map(it => ({ denom: it.denom, amount: it.amount * f })) : null, in_usd: lot.in_usd != null ? lot.in_usd * f : null, in_luna: lot.in_luna != null ? lot.in_luna * f : null, tier: lot.tier });
    if (f >= 1 - 1e-12) p.lots.shift(); else { lot.units -= take; if (lot.lp_in != null) lot.lp_in *= (1 - f); if (lot.items) lot.items = lot.items.map(it => ({ denom: it.denom, amount: it.amount * (1 - f) })); if (lot.in_usd != null) lot.in_usd *= (1 - f); if (lot.in_luna != null) lot.in_luna *= (1 - f); }
    need -= take;
  }
  const matched = units - Math.max(0, need); const unmatched = Math.max(0, need);
  p.units_open = Math.max(0, p.units_open - units); p.unmatched_units += unmatched;
  book.unit_timeline.push([t, key, -units]);
  const sumParts = () => { let in_usd = 0, in_luna = 0, priced = parts.length > 0, items = [], t0 = null, d0 = null, t1 = null; const tiers = new Set();
    for (const c of parts) { if (c.in_usd == null || !c.items) priced = false; else { in_usd += c.in_usd; in_luna += c.in_luna || 0; items.push(...c.items); } if (t0 == null || c.t < t0) { t0 = c.t; d0 = c.day; } if (t1 == null || c.t > t1) t1 = c.t; tiers.add(c.tier); }
    return { in_usd, in_luna, priced, items: mergeItems(items), t0, d0, t1, tiers }; };
  if (isSeg) {   // segment boundary: carry the consumed basis into the paired deposit (same tx), no realized trip
    const S = sumParts();
    book._carry = { tx: e.txhash, pool: e.pool, mech, t: S.t0 != null ? S.t0 : t, day: S.d0 || day,
      items: parts.length ? S.items : outItems, in_usd: parts.length ? (S.priced ? S.in_usd : null) : (outV && outV.priced ? outV.usd : null), in_luna: parts.length ? (S.priced ? S.in_luna : null) : (outV && outV.priced ? outV.luna : null),
      tier: parts.length ? (S.tiers.size === 1 ? [...S.tiers][0] : 'D') : outTier, missing: [] };
    return;
  }
  // realized trip
  const S = sumParts();
  const frac = units > 0 ? matched / units : 0;   // the matched share of what came out (unmatched units carry no basis)
  const out_usd = outV && outV.priced ? outV.usd : null, out_luna = outV && outV.priced ? outV.luna : null;
  const trip = { day, t_open: S.t0 != null ? new Date(S.t0).toISOString().slice(0, 10) : null, t_open_last: S.t1 != null ? new Date(S.t1).toISOString().slice(0, 10) : null,
    units, matched_units: matched, unmatched_units: unmatched || undefined, tier_in: S.priced ? [...S.tiers].sort().join('+') : null, tier_out: outTier, tx: e.txhash };
  if (S.priced && out_usd != null) {
    const outM = out_usd * frac, outLM = out_luna != null ? out_luna * frac : null;
    const entryAtExit = valueBasket(ctx, S.items, day);
    trip.in_usd = r2(S.in_usd); trip.out_usd = r2(outM); trip.delta_usd = r2(outM - S.in_usd);
    trip.in_luna = r6(S.in_luna); trip.out_luna = outLM != null ? r6(outLM) : null; trip.delta_luna = outLM != null ? r6(outLM - S.in_luna) : null;
    if (entryAtExit.priced) { trip.market_usd = r2(entryAtExit.usd - S.in_usd); trip.lp_usd = r2(outM - entryAtExit.usd); }
    if (unmatched > 0) trip.unmatched_out_usd = r2(out_usd * (1 - frac));
    // SUSPECT: an LP round trip that returns > 5× or < 0.1× what went in is far more likely a leg the classifier paired wrong
    // (a provide from another pair in the same tx, a missing side) than a real outcome — kept, labeled, left out of totals
    if (S.in_usd > 1 && (outM / S.in_usd > 5 || outM / S.in_usd < 0.1)) trip.suspect = 'out/in ' + (outM / S.in_usd).toFixed(3);
  } else if (out_usd != null) { trip.out_usd_unbasised = r2(out_usd); }
  tierCount(p, 'trip:' + (trip.delta_usd != null ? 'valued' : 'blank')); p.trips.push(trip);
}
// a trip as one row (columns in TRIP_COLS) — the ledger is read by pages on phones; one array per trip, not one object
const TRIP_COLS = ['day', 'opened', 'units', 'matched_units', 'in_usd', 'out_usd', 'in_luna', 'out_luna', 'market_usd', 'lp_usd', 'tier_in', 'tier_out', 'tx', 'flag'];
function tripRow(x) { const flag = x.suspect ? 'suspect ' + x.suspect : (x.unmatched_units ? 'unmatched ' + x.unmatched_units : (x.out_usd_unbasised != null ? 'no basis, out ' + x.out_usd_unbasised : null));
  return [x.day, x.t_open, x.units, x.matched_units, x.in_usd ?? null, x.out_usd ?? null, x.in_luna ?? null, x.out_luna ?? null, x.market_usd ?? null, x.lp_usd ?? null, x.tier_in, x.tier_out, x.tx, flag]; }
function mergeItems(items) { const m = new Map(); for (const it of items) m.set(it.denom, (m.get(it.denom) || 0) + it.amount); return [...m].map(([denom, amount]) => ({ denom, amount })); }

// a LUNA claim: [{ pool: 'a,b,c', reward_amount }] (display LUNA = raw / 1e6)
function applyClaim(book, ctx, e) {
  if (!e || e.retracted || !e.user || e.type !== 'claim' || !Array.isArray(e.claims)) return;
  const t = Date.parse(e.timestamp), day = String(e.timestamp).slice(0, 10); const L = ctx.lunaUsd(day);
  for (const c of e.claims) {
    const luna = num(c.reward_amount) / 1e6; if (!(luna > 0)) continue; const usd = L ? luna * L : null;
    const pools = String(c.pool || '').split(',').filter(Boolean);
    // open positions among the listed pools (either mechanism — the claim is the gauge's, per pool)
    const open = []; for (const pl of pools) for (const mech of ['non_amplified', 'amplified']) { const p = book.positions.get(keyOf(pl, mech)); if (p && p.units_open > 0) open.push(p); }
    if (!open.length) { book.unattributed_claims.luna += luna; if (usd != null) book.unattributed_claims.usd += usd; book.unattributed_claims.n++; continue; }
    if (open.length === 1) { const p = open[0]; p.claims.luna += luna; if (usd != null) p.claims.usd += usd; p.claims.n++; continue; }
    // split by open value at that day (units → LP → basket → USD); a position we cannot value gets its equal share of the rest
    const vals = open.map(p => { const rr = rateAt(ctx.rates, `${p.pool}|${p.mech}`, t); const b = basketAt(ctx.pools, p.pool, t); if (!b) return null; const items = basketItemsFromLp(ctx, b.basket, p.units_open * rr.r); if (!items) return null; const v = valueBasket(ctx, items, day); return v.priced ? v.usd : null; });
    const known = vals.filter(v => v != null && v > 0); const tot = known.reduce((a, b) => a + b, 0);
    open.forEach((p, i) => { const w = tot > 0 && vals[i] != null ? vals[i] / tot * (known.length / open.length) : 1 / open.length; const l = luna * w; p.claims.luna += l; if (usd != null) p.claims.usd += usd * w; p.claims.n++; p.claims.split_n++; });
  }
}
// tla-voting rewards: kind wallet_claim, type claim_bribes, coins [{amount, denom}]
function applyBribe(book, ctx, r) {
  if (!r || r.type !== 'claim_bribes' || !Array.isArray(r.coins)) return; const day = String(r.timestamp).slice(0, 10); const L = ctx.lunaUsd(day);
  for (const c of r.coins) {
    const d = norm(c.denom); const amt = ctx.amountDisplay(d, num(c.amount)); if (amt == null || !(amt > 0)) { book.bribes_unpriced++; continue; }
    const px = ctx.priceUsd(d, day); const sym = ctx.symbolOf(d) || d;
    const b = book.bribes[sym] || (book.bribes[sym] = { amount: 0, usd: 0, luna: 0, n: 0, unpriced: 0 }); b.amount += amt; b.n++;
    if (px == null) { b.unpriced++; book.bribes_unpriced++; continue; } b.usd += amt * px; book.bribes_usd += amt * px; if (L) { b.luna += amt * px / L; book.bribes_luna += amt * px / L; }
  }
}

// the value curve: open units at each complete epoch boundary since the wallet's first event
function valueCurve(book, ctx) {
  const tl = book.unit_timeline.slice().sort((a, b) => a[0] - b[0]); if (!tl.length) return [];
  const first = tl[0][0]; const units = new Map(); let i = 0; const out = [];
  for (const ep of ctx.pools.epochs) {
    if (ep.t < first) continue;
    while (i < tl.length && tl[i][0] < ep.t) { const [, k, d] = tl[i]; units.set(k, Math.max(0, (units.get(k) || 0) + d)); i++; }
    let usd = 0; const by = {}; const missing = [];
    for (const [k, u] of units) {
      if (!(u > 0)) continue; const [pool] = k.split('|'); if (book.disputed && book.disputed.has(k)) { missing.push(pool + ' (disputed)'); continue; } const rr = rateAt(ctx.rates, k, ep.t); const b = basketAt(ctx.pools, pool, ep.t, ctx.pools.singles.has(pool) ? null : ep.epoch);
      if (!b) { missing.push(pool); continue; } const items = basketItemsFromLp(ctx, b.basket, u * rr.r); if (!items) { missing.push(pool); continue; }
      const v = valueBasket(ctx, items, ep.day); if (!v.priced) { missing.push(pool); continue; } usd += v.usd; by[pool] = (by[pool] || 0) + v.usd;
    }
    const L = ctx.lunaUsd(ep.day); if (!Object.keys(by).length && !missing.length) { out.push({ e: ep.epoch, usd: 0, luna: 0 }); continue; }
    out.push({ e: ep.epoch, usd: r2(usd), luna: L ? r6(usd / L) : null, pools: Object.fromEntries(Object.entries(by).sort().map(([k, v]) => [k, r2(v)])), missing: missing.length ? [...new Set(missing)].sort() : undefined });
  }
  // the NOW point: units after every captured event (this week's too), valued like open positions (latest epoch's state + day)
  const latest = ctx.pools.latest; if (latest) { while (i < tl.length) { const [, k, d] = tl[i]; units.set(k, Math.max(0, (units.get(k) || 0) + d)); i++; }
    let usd = 0; const by = {}; const missing = [];
    for (const [k, u] of units) { if (!(u > 0)) continue; const [pool] = k.split('|'); if (book.disputed && book.disputed.has(k)) { missing.push(pool + ' (disputed)'); continue; } if (book.notHeld && book.notHeld.has(k)) continue; const rr = rateAt(ctx.rates, k, latest.t); const b = basketAt(ctx.pools, pool, latest.t, ctx.pools.singles.has(pool) ? null : latest.epoch); if (!b) { missing.push(pool); continue; } const items = basketItemsFromLp(ctx, b.basket, u * rr.r); if (!items) { missing.push(pool); continue; } const v = valueBasket(ctx, items, latest.day); if (!v.priced) { missing.push(pool); continue; } usd += v.usd; by[pool] = (by[pool] || 0) + v.usd; }
    const L = ctx.lunaUsd(latest.day); out.push({ e: 'now', usd: r2(usd), luna: L ? r6(usd / L) : null, pools: Object.fromEntries(Object.entries(by).sort().map(([k, v]) => [k, r2(v)])), missing: missing.length ? [...new Set(missing)].sort() : undefined }); }
  return out;
}

// per-wallet output (open positions valued at the latest epoch, realized trips, attribution totals)
function walletOutput(book, ctx, address) {
  const latest = ctx.pools.latest; const positions = {}; const T = { disputed: 0, in_usd: 0, out_usd: 0, delta_usd: 0, in_luna: 0, out_luna: 0, delta_luna: 0, market_usd: 0, lp_usd: 0, trips_valued: 0, trips_blank: 0,
    open_cost_usd: 0, open_cost_luna: 0, open_value_usd: 0, open_value_luna: 0, open_unvalued: 0, claims_luna: 0, claims_usd: 0, unmatched_units_positions: 0 };
  for (const [key, p] of [...book.positions].sort(([a], [b]) => a.localeCompare(b))) {
    const trips = p.trips; const tv = trips.filter(x => x.delta_usd != null && !x.suspect); const ts = trips.filter(x => x.suspect).length;
    const R = { in_usd: 0, out_usd: 0, delta_usd: 0, in_luna: 0, out_luna: 0, delta_luna: 0, market_usd: 0, lp_usd: 0 };
    for (const x of tv) { R.in_usd += x.in_usd; R.out_usd += x.out_usd; R.delta_usd += x.delta_usd; R.in_luna += x.in_luna || 0; R.out_luna += x.out_luna || 0; R.delta_luna += x.delta_luna || 0; R.market_usd += x.market_usd || 0; R.lp_usd += x.lp_usd || 0; }
    // open lots: cost and value now (the latest complete epoch's state + day)
    let cost_usd = 0, cost_luna = 0, costOk = true; for (const l of p.lots) { if (l.in_usd == null) costOk = false; else { cost_usd += l.in_usd; cost_luna += l.in_luna || 0; } }
    let value = null;
    if (p.units_open > 0 && latest) { const rr = rateAt(ctx.rates, key, latest.t); const b = basketAt(ctx.pools, p.pool, latest.t, ctx.pools.singles.has(p.pool) ? null : latest.epoch); if (b) { const items = basketItemsFromLp(ctx, b.basket, p.units_open * rr.r); if (items) { const v = valueBasket(ctx, items, latest.day); if (v.priced) value = { usd: v.usd, luna: v.luna, rate_tier: rr.tier }; } } }
    // DISPUTE CHECK — a part cannot exceed the whole, and the hourly chain read is the referee where it exists:
    //   ceiling: open value > max(2 × the gauge's total staked USD now, $1,000) → impossible (units or decimals misread)
    //   participants: the hourly participants product values the same wallet × pool × mechanism; off by > 50 % and > $50 → disputed
    // A disputed position is listed with both figures and left OUT of every total (open, realized, curve) — never averaged in.
    let dispute = null;
    if (ctx.check && value) { dispute = ctx.check(address, p.pool, p.mech, value.usd); }
    // 1.3.0: where this position's receipts went (ctx.moves, pnl.js 1.2.4). A receipt the chain read cannot find in the wallet but
    // that sits with a CUSTODIAN is still the member's: held_in, lots stay open and counted — not "not held".
    const moves = ctx.moves ? ctx.moves.of(address, p.pool, p.mech) : null; let heldIn = null;
    if (dispute && dispute.reason === 'not_held' && moves) { const c = moves.find(x => x.custodian_key && x.net_units > 0); if (c) { heldIn = { where: c.label, custodian: c.to, key: c.custodian_key, net_units: c.net_units, since: c.first_day }; dispute = null; } }
    let notHeld = null; if (dispute && dispute.reason === 'not_held') { notHeld = dispute; dispute = null; (book.notHeld = book.notHeld || new Set()).add(key); }   // 1.2.0: see pnl.js 1.2.3
    if (dispute) { (book.disputed = book.disputed || new Set()).add(key); }
    // 1.1.0 LP in vs now (open lots): non-amplified loses LP to the take rate (the drag, and the top-up that restores it);
    //   amplified compounds (growth). Valued at today's value per LP. Capital × days = Σ lot cost × days held → the APR denominator.
    let lpBlock;
    if (p.lots.length && latest) { const lpIn = p.lots.every(l => l.lp_in != null) ? p.lots.reduce((s, l) => s + l.lp_in, 0) : null; const rrN = rateAt(ctx.rates, key, latest.t); const lpNow = rrN && rrN.r > 0 ? p.units_open * rrN.r : null;
      const measured = p.lots.every(l => l.lp_in_measured);
      const perLpUsd = value && lpNow > 0 ? value.usd / lpNow : null; const perLpLuna = value && lpNow > 0 && value.luna != null ? value.luna / lpNow : null; const d = lpIn != null && lpNow != null ? lpIn - lpNow : null;
      const capUsd = costOk ? p.lots.reduce((s, l) => s + l.in_usd * Math.max(0, (latest.t - l.t) / 864e5), 0) : null; const capLuna = costOk ? p.lots.reduce((s, l) => s + (l.in_luna || 0) * Math.max(0, (latest.t - l.t) / 864e5), 0) : null;
      lpBlock = { lp_in_raw: lpIn != null ? r6(lpIn) : null, lp_now_raw: lpNow != null ? r6(lpNow) : null, lp_rate_tier: rrN ? rrN.tier : undefined,
        take_rate: p.mech === 'non_amplified' && !measured ? { unmeasured: true, why: 'no share-rate sample near when these lots went in — the LP they started with is not known, so the drag is not guessed' } : p.mech === 'non_amplified' && d != null && d > 0 ? { lp_raw: r6(d), pct: lpIn > 0 ? r6(d / lpIn) : null, usd: perLpUsd != null ? r2(d * perLpUsd) : null, luna: perLpLuna != null ? r6(d * perLpLuna) : null, note: 'LP tokens the take rate removed since these lots went in = the top-up that restores them' } : undefined,
        amp_growth: p.mech === 'amplified' && measured && d != null && d < 0 ? { lp_raw: r6(-d), pct: lpIn > 0 ? r6(-d / lpIn) : null, usd: perLpUsd != null ? r2(-d * perLpUsd) : null } : undefined,
        open_since: p.lots.reduce((m, l) => (m == null || l.day < m ? l.day : m), null), capital_days_usd: capUsd != null ? r2(capUsd) : null, capital_days_luna: capLuna != null ? r6(capLuna) : null, as_of_day: latest.day }; }
    positions[key] = { pool: p.pool, name: (ctx.pools.names && ctx.pools.names.get(p.pool)) || undefined, mechanism: p.mech, disputed: dispute || undefined, not_held: notHeld || undefined, held_in: heldIn || undefined, moves: moves && moves.length ? moves : undefined, open_lp: lpBlock, deposits: p.deposits, withdraws: p.withdraws, units_open: p.units_open > 0 ? p.units_open : 0, lots_open: p.lots.length,
      open_cost_usd: p.lots.length ? (costOk ? r2(cost_usd) : null) : 0, open_cost_luna: p.lots.length ? (costOk ? r6(cost_luna) : null) : 0,
      open_value_usd: value ? r2(value.usd) : (p.units_open > 0 ? null : 0), open_value_luna: value ? r6(value.luna) : (p.units_open > 0 ? null : 0), rate_tier: value ? value.rate_tier : undefined,
      realized: { trips: trips.length, valued: tv.length, suspect: ts || undefined, in_usd: r2(R.in_usd), out_usd: r2(R.out_usd), delta_usd: r2(R.delta_usd), in_luna: r6(R.in_luna), out_luna: r6(R.out_luna), delta_luna: r6(R.delta_luna), market_usd: r2(R.market_usd), lp_usd: r2(R.lp_usd) },
      claims: { luna: r6(p.claims.luna), usd: r2(p.claims.usd), n: p.claims.n, split_by_value: p.claims.split_n || undefined },
      unmatched_units: p.unmatched_units > 0 ? p.unmatched_units : undefined, carried_in: p.carried_in || undefined, tiers: p.tiers, trips: trips.map(tripRow) };
    if (dispute) { T.disputed = (T.disputed || 0) + 1; continue; }
    T.in_usd += R.in_usd; T.out_usd += R.out_usd; T.delta_usd += R.delta_usd; T.in_luna += R.in_luna; T.out_luna += R.out_luna; T.delta_luna += R.delta_luna; T.market_usd += R.market_usd; T.lp_usd += R.lp_usd;
    T.trips_valued += tv.length; T.trips_suspect = (T.trips_suspect || 0) + ts; T.trips_blank += trips.length - tv.length - ts; T.claims_luna += p.claims.luna; T.claims_usd += p.claims.usd; if (p.unmatched_units > 0) T.unmatched_units_positions++;
    if (notHeld) { T.not_held = (T.not_held || 0) + 1; T.not_held_usd = (T.not_held_usd || 0) + notHeld.ours_usd; }
    if (p.lots.length && !notHeld) { if (costOk) { T.open_cost_usd += cost_usd; T.open_cost_luna += cost_luna; } if (value) { T.open_value_usd += value.usd; T.open_value_luna += value.luna || 0; } else T.open_unvalued++; }
  }
  const unreal_usd = T.open_value_usd - T.open_cost_usd, unreal_luna = T.open_value_luna - T.open_cost_luna;
  const totals = { as_of_epoch: latest ? latest.epoch : null, as_of_day: latest ? latest.day : null,
    realized: { in_usd: r2(T.in_usd), out_usd: r2(T.out_usd), delta_usd: r2(T.delta_usd), in_luna: r6(T.in_luna), out_luna: r6(T.out_luna), delta_luna: r6(T.delta_luna), market_usd: r2(T.market_usd), lp_usd: r2(T.lp_usd), trips_valued: T.trips_valued, trips_blank: T.trips_blank, trips_suspect: T.trips_suspect || undefined },
    open: { cost_usd: r2(T.open_cost_usd), cost_luna: r6(T.open_cost_luna), value_usd: r2(T.open_value_usd), value_luna: r6(T.open_value_luna), unrealized_usd: r2(unreal_usd), unrealized_luna: r6(unreal_luna), positions_unvalued: T.open_unvalued },
    rewards: { claims_luna: r6(T.claims_luna + book.unattributed_claims.luna), claims_usd: r2(T.claims_usd + book.unattributed_claims.usd), unattributed_luna: r6(book.unattributed_claims.luna), bribes_usd: r2(book.bribes_usd), bribes_luna: r6(book.bribes_luna), bribes_unpriced_coins: book.bribes_unpriced || undefined },
    segments: book.segments || undefined, positions_with_unmatched_units: T.unmatched_units_positions || undefined, positions_disputed: T.disputed || undefined, positions_not_held: T.not_held || undefined, not_held_usd: T.not_held_usd ? r2(T.not_held_usd) : undefined };
  // net = realized Δ + unrealized + TLA rewards (claims + bribes). Fees/zap costs are inside the basis already (provides legs are post-swap).
  totals.net_usd = r2(T.delta_usd + unreal_usd + T.claims_usd + book.unattributed_claims.usd + book.bribes_usd);
  totals.net_luna = r6(T.delta_luna + unreal_luna + T.claims_luna + book.unattributed_claims.luna + book.bribes_luna);
  const curve = valueCurve(book, ctx); const pidx = []; const ix = (k) => { let i = pidx.indexOf(k); if (i < 0) { pidx.push(k); i = pidx.length - 1; } return i; };
  const curveRows = curve.map(c => ({ e: c.e, usd: c.usd, luna: c.luna, p: c.pools ? Object.fromEntries(Object.entries(c.pools).map(([k, v]) => [ix(k), v])) : undefined, m: c.missing ? c.missing.map(k => ix(k.replace(' (disputed)', ''))) : undefined }));
  return { trip_cols: TRIP_COLS, curve_pools: pidx, totals, positions, bribes: Object.fromEntries(Object.entries(book.bribes).sort().map(([k, v]) => [k, { amount: r6(v.amount), usd: r2(v.usd), luna: r6(v.luna), n: v.n, unpriced: v.unpriced || undefined }])), value_curve: curveRows };
}

module.exports = { TRIP_COLS, VERSION, norm, keyOf, mechOf, newRates, addRate, finishRates, rateAt, rateSamplesFromEvent, rateSamplesFromEpoch, rateSamplesFromParticipants,
  newPools, addEpochState, finishPools, basketAt, newBook, applyEvent, applyClaim, applyBribe, valueCurve, walletOutput, MAX_BASKET_DAYS };
