'use strict';
/**
 * dex-data / lib/ratio-anchor.js 1.0.0 (2026-09-27) — LST ratios ANCHORED ON THE CHAIN. One rule, two callers:
 *   · the one-time tla-core Action `ratio-reanchor` (history: repairs price-history/ratios + the LST USD rows built on them)
 *   · dex-data's state-history duty (forward: each newly sampled epoch writes the days since the previous one)
 * Pure functions over committed products — no chain access, no clock unless `at` is passed.
 *
 * Why: price-history/ratios was seeded by price-backfill 1.0.0 as INTERPOLATED rows across CoinGecko's dead zone, between an
 * early CoinGecko-derived anchor and the 2026-05-13 archive. dex-data/state-history then read every hub's exchange rate on the
 * chain at every epoch boundary since E97 (2024-09-02) — and the interpolated rows run ampLUNA +10.6 % / bLUNA +4.9 % HIGH in
 * 2024 (SPEC-dex-state-history §7b). Every LST USD row priced as BASE × ratio(interpolated) inherits the error, and so would any
 * cost basis built on it (Milestone A step 3). Validation: on the 2026-05-13+ chain_exact days the state-history points agree
 * within 0.17 % (daily figure vs the boundary instant) — the two sources measure the same thing.
 *
 * Method (stated in every row it writes):
 *   anchors  = each complete state-history epoch's lst_hubs[hub].ratio at its height_time (the block that was read)
 *   day      = the ratio at 12:00 UTC, log-linear between the two anchors that bracket it (a staking-accrual curve is smooth and
 *              monotone between weekly reads; log-linear = constant growth rate across the week) → tier `chain_anchored`
 *   before the first anchor, an existing `interpolated` row is re-interpolated log-linear from the series' first row (the
 *              original early anchor) to the first chain anchor → tier `interpolated_reanchored` (still an estimate, now bounded
 *              by a chain read on the right)
 *   after the last anchor: nothing is written (the next epoch's sample writes those days)
 *   `chain_exact` rows (the 2026-05-13+ archive) are NEVER changed — they are compared and the Δ is reported
 * USD rows: a row whose src is `<BASE>×ratio(interpolated)` is recomputed as base × the new ratio (same day's base row); a missing
 *   LST row inside the anchored span is added as `<BASE>×ratio(chain_anchored)` when the base has a price that day; any other
 *   src (`tla`, `coingecko`, `…(chain_exact)`) is measured and never touched.
 * Repairs are LABELED IN PLACE: `repair: { was, was_tier | was_src, by }` — the first repair's `was` is kept forever (write-once);
 * a re-run on repaired data changes nothing (idempotent — the gate runs it twice).
 */

const VERSION = 'ratio-anchor-1.0.0';
const HUB_BASE = { ampLUNA: 'LUNA', arbLUNA: 'LUNA', bLUNA: 'LUNA', ampCAPA: 'CAPA', ampROAR: 'ROAR' };
const DAY_MS = 86400000;
const r8 = (x) => Math.round(x * 1e8) / 1e8;

function ms(t) { const v = typeof t === 'number' ? t : Date.parse(t); return Number.isFinite(v) ? v : null; }
function noon(day) { return Date.parse(day + 'T12:00:00Z'); }
function dayOf(tMs) { return new Date(tMs).toISOString().slice(0, 10); }
function monthKey(day) { return day.slice(0, 4) + '/' + day.slice(5, 7); }

// epoch records (dex-data/state-history/epochs/<n>.json) → { hub: [{ t, ratio, epoch }] } sorted by time; complete records only
function anchorsFrom(epochRecs) {
  const out = {};
  for (const e of epochRecs || []) {
    if (!e || !e.complete || !e.lst_hubs) continue;
    const t = ms(e.height_time || e.start_time); if (t == null) continue;
    for (const [hub, v] of Object.entries(e.lst_hubs)) {
      if (!HUB_BASE[hub] || !v || !v.ok || !(Number(v.ratio) > 0)) continue;
      (out[hub] = out[hub] || []).push({ t, ratio: Number(v.ratio), epoch: e.epoch });
    }
  }
  for (const h of Object.keys(out)) out[h].sort((a, b) => a.t - b.t);
  return out;
}

// log-linear between two points
function loglin(t, a, b) { if (b.t === a.t) return a.ratio; const f = (t - a.t) / (b.t - a.t); return Math.exp(Math.log(a.ratio) + f * (Math.log(b.ratio) - Math.log(a.ratio))); }

// the anchored ratio for a day, or null outside the anchored span → { ratio, anchors: [eA, eB] }
function ratioOnDay(list, day) {
  if (!list || list.length < 2) return null;
  const t = noon(day); if (t < list[0].t || t > list[list.length - 1].t) return null;
  let i = 0; while (i < list.length - 2 && list[i + 1].t < t) i++;
  const a = list[i], b = list[i + 1];
  return { ratio: r8(loglin(t, a, b)), anchors: [a.epoch, b.epoch] };
}

// every day in the anchored span of a hub (inclusive of the first and last anchor days whose noon falls inside)
function spanDays(list) {
  if (!list || list.length < 2) return [];
  const out = []; let d = dayOf(list[0].t); if (noon(d) < list[0].t) d = dayOf(noon(d) + DAY_MS);
  for (let t = noon(d); t <= list[list.length - 1].t; t += DAY_MS) out.push(dayOf(t));
  return out;
}

/**
 * The whole repair over in-memory month maps.
 *   ratioMonths: Map 'YYYY/MM' → month doc { meta, days: { day: { HUB: { ratio, base, tier } } } }   (price-history/ratios)
 *   priceMonths: Map 'YYYY/MM' → month doc { meta, days: { day: { SYM: { usd, src, … } } } }          (price-history)
 *   anchors:     anchorsFrom(epochs)
 *   opts:        { by, at, usd: true|false, preAnchor: true|false (the forward duty passes both false), hubs? }
 * Returns { ratioMonths, priceMonths, changedRatio: Set<month>, changedPrice: Set<month>, report } — the maps are mutated in place
 * (callers pass their own copies) and new months are created only for ratio rows the anchors add.
 */
function reanchor({ ratioMonths, priceMonths, anchors, opts = {} }) {
  const by = opts.by || VERSION; const doUsd = opts.usd !== false;
  const changedRatio = new Set(), changedPrice = new Set();
  const report = {};
  const hubs = (opts.hubs || Object.keys(HUB_BASE)).filter(h => anchors[h] && anchors[h].length >= 2);
  const getR = (day) => { const k = monthKey(day); if (!ratioMonths.has(k)) ratioMonths.set(k, { meta: { module: 'price-history', format_version: 1, note: 'daily LST ratios' }, days: {} }); return ratioMonths.get(k); };
  for (const hub of hubs) {
    const base = HUB_BASE[hub], list = anchors[hub];
    const rep = report[hub] = { anchors: list.length, first_anchor: dayOf(list[0].t), last_anchor: dayOf(list[list.length - 1].t), repaired: 0, added: 0, unchanged: 0, chain_exact_kept: 0, chain_exact_max_abs_delta_pct: 0,
      pre_anchor_reinterpolated: 0, delta_pct: { n: 0, sum: 0, max: 0, max_day: null }, usd_repaired: 0, usd_added: 0, usd_kept_measured: 0, usd_no_base: 0 };
    // 1. the anchored span
    for (const day of spanDays(list)) {
      const a = ratioOnDay(list, day); if (!a) continue;
      const doc = getR(day); const row = (doc.days[day] = doc.days[day] || {})[hub];
      if (row && row.tier === 'chain_exact') { rep.chain_exact_kept++; const d = Math.abs(row.ratio / a.ratio - 1) * 100; if (d > rep.chain_exact_max_abs_delta_pct) rep.chain_exact_max_abs_delta_pct = r8(d); continue; }
      const next = { ratio: a.ratio, base, tier: 'chain_anchored', anchors: a.anchors };
      if (row && row.tier === 'chain_anchored' && row.ratio === next.ratio && String(row.anchors) === String(next.anchors)) { rep.unchanged++; continue; }
      if (row && row.tier !== 'chain_anchored') {
        next.repair = row.repair || { was: row.ratio, was_tier: row.tier || null, by };
        const d = (row.ratio / a.ratio - 1) * 100; rep.delta_pct.n++; rep.delta_pct.sum += d; if (Math.abs(d) > Math.abs(rep.delta_pct.max)) { rep.delta_pct.max = r8(d); rep.delta_pct.max_day = day; }
        rep.repaired++;
      } else if (row) { if (row.repair) next.repair = row.repair; if (row.added_by) next.added_by = row.added_by; rep.repaired++; }
      else { next.added_by = by; rep.added++; }
      doc.days[day][hub] = next; changedRatio.add(monthKey(day));
    }
    // 2. before the first anchor: re-interpolate the series' own interpolated rows from its first row to the first chain read
    const first = list[0];
    const priorDays = [];
    for (const [k, doc] of ratioMonths) for (const [day, v] of Object.entries(doc.days || {})) if (v[hub] && noon(day) < first.t) priorDays.push(day);   // by the day's noon — the first anchor's own calendar day can fall before it
    priorDays.sort();
    if (opts.preAnchor !== false && priorDays.length >= 2) {   // the forward duty passes preAnchor:false (it sees two anchors only)
      const leftDay = priorDays[0]; const left = ratioMonths.get(monthKey(leftDay)).days[leftDay][hub];
      const leftPt = { t: noon(leftDay), ratio: left.repair ? left.repair.was : left.ratio, epoch: null };
      for (const day of priorDays.slice(1)) {
        const doc = ratioMonths.get(monthKey(day)); const row = doc.days[day][hub];
        if (row.tier === 'chain_exact') continue;
        if (!(row.tier === 'interpolated' || row.tier === 'interpolated_reanchored')) continue;
        const v = r8(loglin(noon(day), leftPt, first));
        if (row.tier === 'interpolated_reanchored' && row.ratio === v) { rep.unchanged++; continue; }
        const next = { ratio: v, base, tier: 'interpolated_reanchored', anchors: ['first_row:' + leftDay, first.epoch], repair: row.repair || { was: row.ratio, was_tier: row.tier, by } };
        doc.days[day][hub] = next; changedRatio.add(monthKey(day)); rep.pre_anchor_reinterpolated++;
      }
    }
    rep.delta_pct.mean = rep.delta_pct.n ? r8(rep.delta_pct.sum / rep.delta_pct.n) : null; delete rep.delta_pct.sum;
  }
  // 3. USD rows built on the ratio
  if (doUsd && priceMonths) {
    for (const hub of hubs) {
      const base = HUB_BASE[hub], rep = report[hub];
      const srcOld = base + '×ratio(interpolated)';
      for (const [k, rdoc] of ratioMonths) {
        const pdoc = priceMonths.get(k); if (!pdoc) continue;
        for (const [day, v] of Object.entries(rdoc.days || {})) {
          const r = v[hub]; if (!r || !(r.tier === 'chain_anchored' || r.tier === 'interpolated_reanchored')) continue;
          const pday = pdoc.days && pdoc.days[day]; if (!pday) continue;
          const b = pday[base]; const row = pday[hub];
          const src = base + '×ratio(' + r.tier + ')';
          if (row && row.src !== srcOld && row.src !== src) { rep.usd_kept_measured++; continue; }   // tla / coingecko / chain_exact: measured, never touched
          if (!b || !(Number(b.usd) > 0)) { if (!row) rep.usd_no_base++; continue; }
          const usd = r8(Number(b.usd) * r.ratio);
          if (row && row.src === src && row.usd === usd) continue;
          const next = { usd, src };
          if (row) { next.repair = row.repair || { was: row.usd, was_src: row.src, by }; if (row.added_by) next.added_by = row.added_by; rep.usd_repaired++; }
          else { next.added_by = by; rep.usd_added++; }
          pday[hub] = next; changedPrice.add(k);
        }
      }
    }
  }
  // 4. month meta: one repair entry per month file changed (idempotent — not re-added)
  const stamp = (doc, what) => { const m = doc.meta = doc.meta || {}; const rs = m.repairs = m.repairs || []; if (!rs.some(x => x.repair === 'ratio-reanchor' && x.by === by)) rs.push({ repair: 'ratio-reanchor', by, at: opts.at || null, what, method: 'state-history chain reads per epoch; log-linear by day at 12:00 UTC; rows labeled in place (repair.was kept)' }); };
  for (const k of changedRatio) stamp(ratioMonths.get(k), 'LST ratios → chain_anchored / interpolated_reanchored');
  for (const k of changedPrice) stamp(priceMonths.get(k), 'LST USD rows built on the interpolated ratio → base × anchored ratio');
  return { ratioMonths, priceMonths, changedRatio, changedPrice, report };
}

module.exports = { VERSION, HUB_BASE, anchorsFrom, ratioOnDay, spanDays, reanchor, loglin, monthKey };
