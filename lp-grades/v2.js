'use strict';
// lp-grades/v2.js — the five-lens grade ("what is a vote worth here?") — 2026-08-25
// SPEC-lp-grades-v2 §2. Runs INSIDE the existing lp-grades cron on the pools it has
// already assembled (v1 scores stay as-is; v2 is added per pool as `v2`).
//
// Every measured component is a PERCENTILE among the active pools graded this epoch
// (0 = lowest, 100 = highest, "vs the other active pools" — said on the page), so the
// letters spread across the field instead of clustering at C/D. Purpose is declared
// (config table) and the threshold cushion is absolute, because those are not
// competitions. Null-vs-0: a missing component is excluded from its lens and lowers
// confidence; it is never scored as zero.
const CONFIG_V2 = {
  config_version: '2.0.0',
  lens_weights: { purpose: 0.20, work: 0.25, efficiency: 0.15, durability: 0.25, governance: 0.15 },
  // D1 (owner 2026-08-25): what the chain needs each kind of pool for. Adjustable by DAO prop.
  purpose_weights: { native_stable: 1.0, lst_correlated: 0.9, bluechip_bridge: 0.7, stable_stable: 0.6, project: 0.5, single_asset: 0.5 },
  letter_bands: { A: 75, B: 60, C: 45, D: 30 },            // composite ≥ band → letter; below D → F
  streak_min_letter: 'C',                                  // "solid" = composite letter ≥ C
  cushion_full_pct: 3,                                     // bucket_pct − 1% ≥ this → cushion score 100
  symbols: {
    lst: ['ampLUNA', 'arbLUNA', 'bLUNA', 'stLUNA', 'boneLUNA', 'ampROAR', 'ampCAPA'],
    stable: ['USDC', 'USDT', 'USDt', 'EURe', 'axlUSDC', 'axlUSDT', 'SOLID'],
    bluechip: ['wBTC', 'WBTC', 'wBTC.osmo', 'wBTC.axl', 'wBTC.creda.a', 'ATOM', 'INJ', 'PAXG', 'wstETH', 'ETH', 'dATOM'],
  },
};

const LETTER_ORD = { A: 4, B: 3, C: 2, D: 1, F: 0 };
function pairClass(name, isSingle, cfg = CONFIG_V2) {
  const parts = String(name || '').split(/[-/]/).map(s => s.trim()).filter(Boolean);
  const has = (list, s) => list.some(x => x.toLowerCase() === s.toLowerCase());
  const isL = (s) => s === 'LUNA', isLst = (s) => has(cfg.symbols.lst, s), isSt = (s) => has(cfg.symbols.stable, s), isBc = (s) => has(cfg.symbols.bluechip, s);
  if (isSingle || parts.length < 2) return 'single_asset';
  const [a, b] = parts;
  if ((isL(a) && isSt(b)) || (isL(b) && isSt(a))) return 'native_stable';
  if ((isL(a) && isLst(b)) || (isL(b) && isLst(a)) || (isLst(a) && isLst(b))) return 'lst_correlated';
  if (isSt(a) && isSt(b)) return 'stable_stable';
  if (isBc(a) || isBc(b)) return 'bluechip_bridge';
  return 'project';
}
const ilClassScore = { native_stable: 40, lst_correlated: 95, bluechip_bridge: 40, stable_stable: 100, project: 20, single_asset: 100 };   // exposure to divergence loss, higher = safer

function percentile(values, v, higherIsBetter = true) {
  const arr = values.filter(x => x != null && isFinite(x));
  if (v == null || !isFinite(v) || arr.length < 2) return null;
  const below = arr.filter(x => higherIsBetter ? x < v : x > v).length, eq = arr.filter(x => x === v).length;
  return Math.round(((below + 0.5 * Math.max(0, eq - 1)) / (arr.length - 1)) * 100);
}
const mean = (xs) => { const a = xs.filter(x => x != null && isFinite(x)); return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null; };
const letterOf = (c, bands) => c == null ? null : c >= bands.A ? 'A' : c >= bands.B ? 'B' : c >= bands.C ? 'C' : c >= bands.D ? 'D' : 'F';

/**
 * computeV2
 * @param pools  the cron's assembled pool rows (v1 shape: name, bucket, is_single, vp, pct_of_bucket, staked_usd, depth_usd, scores.A.parts/util_weekly_ratio, scores.B.parts, take_flow_epoch_usd, state)
 * @param ctx   { snapshotPools (tla-snapshot pools: rewards.weekly_emissions_usd, amp_lp), psHistory, votionByGauge {gauge|bare: current_vp}, votionRate ($/1M VP), runwayPots {gauge|bare: usdFundedForPeriod}, votedPeriod, pdShareByGauge {gauge|bare: pdLunaPerEpoch}, lunaUsd, archive: [{epoch, byGauge:{gauge_pool_id: letter}}] newest-first }
 */
function computeV2(pools, ctx, cfg = CONFIG_V2) {
  const active = pools.filter(p => p.state === 'graded' || p.gaugeActive);
  const snapBy = {}; for (const s of ctx.snapshotPools || []) if (s.gauge_pool_id) snapBy[s.gauge_pool_id] = s;
  const key = (p) => String(p.bucket || '').toLowerCase() + '|' + String(p.gauge_pool_id || '').replace(/^(cw20|native):/, '');
  // ---- raw components per pool ----
  const raw = active.map(p => {
    const s = snapBy[p.gauge_pool_id] || {};
    const util = p.scores?.A?.util_weekly_ratio ?? null;
    const depth = p.depth_usd ?? null;
    const slip = p.scores?.A?.slip_worst_pct ?? null;                       // lower better
    const emisWk = s.rewards?.weekly_emissions_usd ?? null;
    const weeklyVol = (util != null && depth != null) ? util * depth : null;
    const emisPerVol = (emisWk != null && weeklyVol > 0) ? emisWk / weeklyVol : null;          // $ emissions per $ traded — lower better
    const emisPerStaked = (emisWk != null && p.staked_usd > 0) ? emisWk / p.staked_usd : null;  // lower better
    // durability: price-neutral retention over 4 epochs from pool-status amounts × latest prices
    let retention = null;
    const hist = (ctx.psHistory?.pools || []).find(x => x.gauge_pool_id === p.gauge_pool_id);
    if (hist && hist.epochs) {
      const eps = Object.keys(hist.epochs).map(Number).sort((a, b) => a - b); const last = eps[eps.length - 1], back = eps.find(e => e >= last - 4) ?? null;
      const e1 = hist.epochs[String(last)], e0 = back != null ? hist.epochs[String(back)] : null;
      if (e1 && e0 && e1.a0_px > 0 && (e1.a0_amt > 0 || e1.a1_amt > 0) && (e0.a0_amt > 0 || e0.a1_amt > 0)) {
        const now = (e1.a0_amt || 0) * (e1.a0_px || 0) + (e1.a1_amt || 0) * (e1.a1_px || 0);
        const then = (e0.a0_amt || 0) * (e1.a0_px || 0) + (e0.a1_amt || 0) * (e1.a1_px || 0);   // THEN's amounts at NOW's prices = price-neutral
        retention = then > 0 ? now / then : null;
      }
    }
    const amp = s.amp_lp && s.amp_lp.ratio_type === 'amplified' ? 1 : (s.amp_lp ? 0 : null);
    const b1 = p.scores?.B?.parts?.durability_B1 ?? null;
    const cls = pairClass(p.name, p.is_single, cfg);
    const k = key(p);
    const votionVp = ctx.votionByGauge?.[k] ?? null;
    const mercenary = (votionVp != null && p.vp > 0) ? votionVp / p.vp : null;                    // lower better
    const potUsd = ctx.runwayPots?.[k] ?? null;
    const bribeRate = (potUsd != null && p.vp > 50000) ? potUsd / (p.vp / 1e6) : (potUsd === 0 ? 0 : null);
    const bribeDependence = (bribeRate != null && ctx.votionRate > 0) ? bribeRate / ctx.votionRate : null;  // lower better (a pool paying above Votion's rate is renting its votes)
    const cushion = p.pct_of_bucket != null ? Math.max(0, p.pct_of_bucket - 1) : null;
    const pdShare = (ctx.pdShareByGauge?.[k] != null && potUsd > 0 && ctx.lunaUsd > 0) ? Math.min(1, (ctx.pdShareByGauge[k] * ctx.lunaUsd) / potUsd) : (potUsd === 0 ? 0 : null);  // lower better
    return { p, k, cls, util, depth, slip, emisPerVol, emisPerStaked, retention, amp, b1, mercenary, bribeDependence, cushion, pdShare };
  });
  const col = (f) => raw.map(f);
  const U = { util: col(r => r.util), depth: col(r => r.depth), slip: col(r => r.slip), epv: col(r => r.emisPerVol), eps: col(r => r.emisPerStaked), ret: col(r => r.retention), merc: col(r => r.mercenary), dep: col(r => r.bribeDependence), pd: col(r => r.pdShare) };
  const out = {};
  const distribution = { A: 0, B: 0, C: 0, D: 0, F: 0 };
  for (const r of raw) {
    const purpose = Math.round((cfg.purpose_weights[r.cls] ?? 0.5) * 100);
    const work = { utilization: percentile(U.util, r.util), depth: percentile(U.depth, r.depth), exit_slippage: percentile(U.slip, r.slip, false) };
    const efficiency = { emissions_per_volume: percentile(U.epv, r.emisPerVol, false), emissions_per_staked: percentile(U.eps, r.emisPerStaked, false) };
    const durability = { retention_4ep: percentile(U.ret, r.retention), il_class: ilClassScore[r.cls] ?? null, amp_share: r.amp == null ? null : r.amp * 100, asset_durability: r.b1 };
    const governance = { mercenary_share: percentile(U.merc, r.mercenary, false), bribe_dependence: percentile(U.dep, r.bribeDependence, false), threshold_cushion: r.cushion == null ? null : Math.round(Math.min(1, r.cushion / cfg.cushion_full_pct) * 100), pd_dependence: percentile(U.pd, r.pdShare, false) };
    const lenses = { purpose: { score: purpose, class: r.cls, parts: {} }, work: { score: mean(Object.values(work)), parts: work }, efficiency: { score: mean(Object.values(efficiency)), parts: efficiency }, durability: { score: mean(Object.values(durability)), parts: durability }, governance: { score: mean(Object.values(governance)), parts: governance } };
    for (const l of Object.values(lenses)) if (l.score != null) l.score = Math.round(l.score);
    const present = Object.entries(cfg.lens_weights).filter(([id]) => lenses[id].score != null);
    const wsum = present.reduce((s, [, w]) => s + w, 0);
    const composite = wsum > 0 ? Math.round(present.reduce((s, [id, w]) => s + w * lenses[id].score, 0) / wsum) : null;
    const letter = letterOf(composite, cfg.letter_bands);
    // components missing → confidence
    const total = Object.values(lenses).reduce((s, l) => s + Math.max(1, Object.keys(l.parts).length), 0);
    const missing = Object.values(lenses).reduce((s, l) => s + Object.values(l.parts).filter(v => v == null).length, 0);
    const confidence = missing === 0 ? 'firm' : missing <= 2 ? 'provisional' : 'thin';
    // streak: consecutive epochs (this one + archived) at ≥ streak_min_letter; archive rows are v2 when present, else v1 grade labeled
    let streak = letter && LETTER_ORD[letter] >= LETTER_ORD[cfg.streak_min_letter] ? 1 : 0; let streakBasis = 'v2';
    if (streak) for (const a of ctx.archive || []) { const L = a.byGauge[r.p.gauge_pool_id]; if (!L) break; if (LETTER_ORD[String(L.letter).replace('+', '')] >= LETTER_ORD[cfg.streak_min_letter]) { streak++; if (L.basis === 'v1') streakBasis = 'v1-backfilled'; } else break; }
    // why: strongest and weakest lens in one line
    const ranked = Object.entries(lenses).filter(([, l]) => l.score != null).sort((a, b) => b[1].score - a[1].score);
    const why = ranked.length ? `strongest: ${ranked[0][0]} ${ranked[0][1].score} · weakest: ${ranked[ranked.length - 1][0]} ${ranked[ranked.length - 1][1].score}` : 'ungradeable';
    if (letter) distribution[letter]++;
    out[r.p.gauge_pool_id] = { letter, composite, lenses, confidence, streak, streak_basis: streakBasis, pair_class: r.cls, why, raw: { util: r.util, depth: r.depth, slip_worst_pct: r.slip, emissions_per_volume: r.emisPerVol, emissions_per_staked: r.emisPerStaked, retention_4ep: r.retention, mercenary_share: r.mercenary, bribe_rate_vs_votion: r.bribeDependence, cushion_pct: r.cushion, pd_share_of_pot: r.pdShare } };
  }
  return { byGauge: out, meta: { config_version: cfg.config_version, lens_weights: cfg.lens_weights, purpose_weights: cfg.purpose_weights, letter_bands: cfg.letter_bands, scoring: 'measured components are percentiles among the active pools graded this epoch (higher = better after direction); purpose is declared; threshold cushion is absolute (full marks at ' + cfg.cushion_full_pct + ' pp above 1%)', distribution, graded: raw.length } };
}

module.exports = { computeV2, pairClass, percentile, CONFIG_V2, LETTER_ORD };
