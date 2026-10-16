/* lp-scorecard.js 1.4.0 (2026-10-16) — the LP Scorecard math, shared by the page and the lp-grades cron.
 * KEEP IDENTICAL: adao-links-site/lib/lp-scorecard.js  ==  platform-crons/lp-grades/lp-scorecard.js
 * Inputs: lp-grades/series/pools.json (facts only) + grading_config.json `scorecard` (the rubric).
 * Nothing here is opinion: every number is a fact from the series or a weight from the config, and every
 * measured metric is a percentile among the pools in view (100 = best of the field). Null is never zero:
 * a metric with no source is left out and its weight renormalizes. */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.LPScorecard = factory(); })(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var VERSION = 'lp-scorecard-1.4.0';   // 1.4.0 (2026-10-16): sizingCheck — LUNA share vs metric share among the picked pools, bucket split   // 1.3.0 (2026-10-16): declared formulas as bribe-check criteria + formulaFit   // 1.2.0 (2026-10-16): the as-of epoch's pots per pool, PD / other (ep_*)   // 1.1.0 (2026-10-15): grade and rank within each bucket (config rank_within)

  function isNum(x) { return x != null && isFinite(x); }
  function mean(xs) { var a = xs.filter(isNum); return a.length ? a.reduce(function (s, x) { return s + x; }, 0) / a.length : null; }
  function median(xs) { var a = xs.filter(isNum).sort(function (x, y) { return x - y; }); if (!a.length) return null; var m = Math.floor(a.length / 2); return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; }
  function pctile(values, v, dir) {
    var arr = values.filter(isNum); if (!isNum(v) || arr.length < 2) return null;
    var below = 0, eq = 0; for (var i = 0; i < arr.length; i++) { var x = arr[i]; if (x === v) eq++; else if (dir >= 0 ? x < v : x > v) below++; }
    return Math.round(((below + 0.5 * Math.max(0, eq - 1)) / (arr.length - 1)) * 100);
  }
  function addDays(iso, n) { var d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
  function daysBetween(a, b) { return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000); }

  // ---- declared purpose: pair class from the pool name ----
  function pairClass(name, isSingle, cfg) {
    var sy = (cfg && cfg.symbols) || { lst: [], stable: [], bluechip: [] };
    var parts = String(name || '').split(/[-\/]/).map(function (s) { return s.trim(); }).filter(Boolean);
    function has(list, s) { return (list || []).some(function (x) { return x.toLowerCase() === String(s).toLowerCase(); }); }
    if (isSingle || parts.length < 2) return 'single_asset';
    var a = parts[0], b = parts[1];
    var L = function (s) { return s === 'LUNA'; }, Ls = function (s) { return has(sy.lst, s); }, St = function (s) { return has(sy.stable, s); }, Bc = function (s) { return has(sy.bluechip, s); };
    if ((L(a) && St(b)) || (L(b) && St(a))) return 'native_stable';
    if ((L(a) && Ls(b)) || (L(b) && Ls(a)) || (Ls(a) && Ls(b))) return 'lst_correlated';
    if (St(a) && St(b)) return 'stable_stable';
    if (Bc(a) || Bc(b)) return 'bluechip_bridge';
    return 'project';
  }

  // ---- calendar helpers on the series ----
  function lastDayIx(series, date) { var d = series.days, lo = 0, hi = d.length - 1, ans = -1; while (lo <= hi) { var m = (lo + hi) >> 1; if (d[m] <= date) { ans = m; lo = m + 1; } else hi = m - 1; } return ans; }
  function epochOf(series, date) {   // the epoch whose [start, end) holds the date
    var best = null; for (var k in series.epochs) { var e = series.epochs[k]; if (e.start && e.start <= date && (!e.end || date < e.end)) best = Number(k); }
    return best;
  }
  function epochFacts(pool, E, back) {   // the epoch row, or the nearest earlier one within `back` epochs
    for (var i = 0; i <= (back || 0); i++) { var r = pool.e && pool.e[String(E - i)]; if (r && (r.vp != null || r.amt)) return { E: E - i, r: r }; }
    return null;
  }

  /** facts for every pool over one window ending on `asOf` (inclusive). */
  function windowFacts(series, cfg, opt) {
    var sc = cfg.scorecard || cfg; var n = (sc.windows || {})[opt.window] || Number(opt.window) || 30;
    var asOf = opt.asOf || series.days[series.days.length - 1];
    var end = lastDayIx(series, asOf); var start = Math.max(0, end - n + 1);
    var Eend = epochOf(series, asOf), Estart = epochOf(series, series.days[start] || asOf);
    if (Eend != null && Estart != null && Estart >= Eend) Estart = Eend - 1;
    // bucket vote totals of ACTIVE pools at Eend, for the emissions estimate
    var bucketActiveVp = {};
    series.pools.forEach(function (p) { var f = Eend != null ? epochFacts(p, Eend, 0) : null; if (f && f.r.active && p.bucket) bucketActiveVp[p.bucket] = (bucketActiveVp[p.bucket] || 0) + (f.r.vp || 0); });
    var epMeta = Eend != null ? (series.epochs[String(Eend)] || {}) : {};
    var lunaUsd = epMeta.luna_usd || null, annualLuna = epMeta.annual_luna || null;
    var winEpochs = []; if (Eend != null) for (var e = Math.max(Estart != null ? Estart + 1 : Eend, Eend - Math.max(0, Math.ceil(n / 7) - 1)); e <= Eend; e++) winEpochs.push(e);
    var out = [];
    series.pools.forEach(function (p) {
      var f = { id: p.id, name: p.name, names: p.names, dex: p.dex, bucket: p.bucket, is_single: p.is_single, tla: (p.gauge_pool_ids || []).length > 0, first_day: p.first_day };
      f.pair_class = pairClass(p.name, p.is_single, sc);
      f.age_days = p.first_day ? daysBetween(p.first_day, asOf) + 1 : null;
      var tv = [], vv = [], fv = [], days = 0;
      if (p.d && end >= 0) for (var i = start; i <= end; i++) { var t = p.d.tvl[i]; if (t == null) continue; days++; tv.push(t); if (p.d.vol[i] != null) vv.push(p.d.vol[i]); if (p.d.fees[i] != null) fv.push(p.d.fees[i]); }
      f.days = days; f.coverage = n ? days / n : 0;
      var enough = f.coverage >= (sc.min_coverage || 0.6) || (n === 1 && days === 1);
      f.liquidity = enough ? mean(tv) : null;
      f.volume = enough && vv.length >= Math.max(1, Math.ceil(days * 0.5)) ? mean(vv) : null;
      f.fees = enough && fv.length >= Math.max(1, Math.ceil(days * 0.5)) ? mean(fv) : null;
      f.small = f.liquidity != null && f.liquidity < (sc.depth_floor_usd || 0);
      f.efficiency = (f.volume != null && f.liquidity > 0 && !f.small) ? f.volume / f.liquidity : null;
      f.efficiency_raw = (f.volume != null && f.liquidity > 0) ? f.volume / f.liquidity : null;
      // epoch side
      var fe = Eend != null ? epochFacts(p, Eend, 1) : null, fs = Estart != null ? epochFacts(p, Estart, 1) : null;
      f.epoch = fe ? fe.E : null;
      f.active = !!(fe && fe.r.active); f.status = fe ? fe.r.status : null;
      f.bucket_pct = fe && fe.r.bucket_pct != null ? fe.r.bucket_pct : null; f.vp = fe ? fe.r.vp : null;
      f.stickiness = null;
      if (fe && fs && fe.E > fs.E && fe.r.amt && fs.r.amt && fe.r.px && fe.r.px[0] > 0 && fe.r.px[1] > 0) {
        var nowV = fe.r.amt[0] * fe.r.px[0] + fe.r.amt[1] * fe.r.px[1], thenV = fs.r.amt[0] * fe.r.px[0] + fs.r.amt[1] * fe.r.px[1];
        if (thenV > 0) f.stickiness = nowV / thenV;
      }
      var share = (f.active && p.bucket && bucketActiveVp[p.bucket] > 0 && f.vp != null) ? f.vp / bucketActiveVp[p.bucket] : 0;
      f.emissions_luna_ep = (annualLuna && (sc.bucket_share_of_tla || {})[p.bucket] != null) ? annualLuna / 52 * sc.bucket_share_of_tla[p.bucket] * share : null;
      var bU = [], bL = [], pdL = [];
      winEpochs.forEach(function (E) { var r = p.e && p.e[String(E)]; bU.push(r && r.bribe_usd != null ? r.bribe_usd : 0); bL.push(r && r.bribe_luna ? r.bribe_luna : 0); pdL.push(r && r.pd_luna ? r.pd_luna : 0); });
      f.bribes_usd_ep = winEpochs.length ? mean(bU) : null; f.bribes_luna_ep = winEpochs.length ? mean(bL) : null; f.pd_luna_ep = winEpochs.length ? mean(pdL) : null;
      // the as-of epoch's own pots (what bribers placed for THIS round), split PD / everyone else
      var er = Eend != null && p.e ? p.e[String(Eend)] : null;
      f.ep_bribe_usd = er && er.bribe_usd != null ? er.bribe_usd : (er && er.pd_luna && lunaUsd ? er.pd_luna * lunaUsd : 0);
      f.ep_pd_luna = er && er.pd_luna ? er.pd_luna : 0;
      f.ep_pd_usd = f.ep_pd_luna && lunaUsd ? Math.min(f.ep_bribe_usd || Infinity, f.ep_pd_luna * lunaUsd) : 0;
      f.ep_other_usd = Math.max(0, (f.ep_bribe_usd || 0) - f.ep_pd_usd);
      f.ep_bribe_src = er && er.bribe_src || (er && er.bribe_usd != null ? 'harvest' : null);
      var incentivesUsd = (f.emissions_luna_ep != null && lunaUsd ? f.emissions_luna_ep * lunaUsd : 0) + (f.bribes_usd_ep || 0);
      f.incentives_usd_ep = (f.emissions_luna_ep != null || f.bribes_usd_ep) ? incentivesUsd : null;
      f.cost = (f.volume > 0 && f.incentives_usd_ep != null && incentivesUsd > 0) ? incentivesUsd / (f.volume * 7) : null;
      f.support = f.bucket_pct;
      f.purpose = Math.round(((sc.purpose_weights || {})[f.pair_class] != null ? sc.purpose_weights[f.pair_class] : 0.5) * 100);
      out.push(f);
    });
    return { asOf: asOf, window: opt.window, n: n, from: series.days[start], to: series.days[end], epoch: Eend, epochs: winEpochs, luna_usd: lunaUsd, pools: out };
  }

  function presetOf(cfg, id) { var sc = cfg.scorecard || cfg; var ps = sc.presets || []; return ps.filter(function (p) { return p.id === id; })[0] || ps.filter(function (p) { return p.default; })[0] || ps[0]; }
  function letterOf(c, bands) { return c == null ? null : c >= bands.A ? 'A' : c >= bands.B ? 'B' : c >= bands.C ? 'C' : c >= bands.D ? 'D' : 'F'; }

  var BUCKET_ORDER = ['stable', 'project', 'bluechip', 'single'];
  function groupOf(sc) { return (sc.rank_within === 'bucket') ? function (f) { return f.bucket || 'other'; } : function () { return 'all'; }; }
  function groupOrder(sc, gs) { var u = []; gs.forEach(function (g) { if (u.indexOf(g) < 0) u.push(g); }); var order = sc.bucket_order || BUCKET_ORDER; return u.sort(function (a, b) { var ia = order.indexOf(a), ib = order.indexOf(b); return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib); }); }
  // position in its group, 1 = top, 0 = bottom — comparable across groups of different sizes
  function standing(r) { return r.of > 1 ? 1 - (r.rank - 1) / (r.of - 1) : 1; }

  /** base field: TLA pools with trading facts in the window (single-asset gauges carry no trading facts). */
  function inField(f, opt) { if (!f.tla || f.liquidity == null) return false; if (opt && opt.activeOnly && !f.active) return false; return f.liquidity >= ((opt && opt.min_liquidity) || 1000); }

  /** score every pool in the field for a preset (or explicit weights). */
  function scoreField(wf, cfg, presetId, opt) {
    var sc = cfg.scorecard || cfg; var pr = presetOf(cfg, presetId); var w = (opt && opt.weights) || pr.weights; var flt = pr.filter || {};
    var field = wf.pools.filter(function (f) {
      if (!inField(f, opt)) return false;
      if (flt.min_liquidity_usd != null && !(f.liquidity >= flt.min_liquidity_usd)) return false;
      if (flt.max_bucket_pct != null && !(f.bucket_pct == null || f.bucket_pct <= flt.max_bucket_pct)) return false;
      if (flt.max_age_days != null && !(f.age_days != null && f.age_days <= flt.max_age_days)) return false;
      return true;
    });
    var meta = sc.metrics || {};
    // 1.1.0: pools are graded against the other pools IN THEIR BUCKET (config rank_within: "bucket") — emissions are split per
    // bucket, so a stable pool competes with stable pools, not with project pools. rank_within: "all" grades the whole field.
    var byB = groupOf(sc);
    var cols = {}; Object.keys(w).forEach(function (m) { cols[m] = {}; field.forEach(function (f) { var g = byB(f); (cols[m][g] = cols[m][g] || []).push(f[m]); }); });
    var scored = field.map(function (f) { var g = byB(f);
      var parts = {}, ws = 0, acc = 0, wAll = 0;
      Object.keys(w).forEach(function (m) {
        var dir = meta[m] && meta[m].dir != null ? meta[m].dir : 1;
        var v = m === 'purpose' ? f.purpose : pctile(cols[m][g], f[m], dir);
        parts[m] = v; wAll += w[m]; if (v != null) { ws += w[m]; acc += w[m] * v; }
      });
      var composite = (ws > 0 && ws >= 0.5 * wAll) ? Math.round(acc / ws) : null;
      return { f: f, group: g, parts: parts, composite: composite, weight_present: wAll ? ws / wAll : 0, letter: letterOf(composite, sc.letter_bands || { A: 75, B: 60, C: 45, D: 30 }) };
    });
    scored.sort(function (a, b) { return (b.composite == null ? -1 : b.composite) - (a.composite == null ? -1 : a.composite); });
    var seen = {}, ofG = {}; scored.forEach(function (s) { if (s.composite != null) ofG[s.group] = (ofG[s.group] || 0) + 1; });
    scored.forEach(function (s) { if (s.composite == null) { s.rank = null; return; } seen[s.group] = (seen[s.group] || 0) + 1; s.rank = seen[s.group]; s.of = ofG[s.group]; });
    return { preset: pr, weights: w, field: scored, groups: groupOrder(sc, scored.map(function (x) { return x.group; })), rank_within: sc.rank_within || 'all', excluded: wf.pools.filter(function (f) { return f.tla && field.indexOf(f) < 0; }) };
  }

  /** rank of each pool on one metric (or 'allround' = the default preset composite) in each window, at one date. */
  function ranksAcross(series, cfg, asOf, criterion, opt) {
    var sc = cfg.scorecard || cfg; var out = {};
    Object.keys(sc.windows).forEach(function (wk) {
      var wf = windowFacts(series, cfg, { asOf: asOf, window: wk });
      out[wk] = rankMap(wf, cfg, criterion, opt);
    });
    return out;
  }
  /** a declared formula (config bribe_check.formulas): weighted terms, each min-max normalized within the group */
  function formulaScores(wf, cfg, fid, opt) {
    var sc = cfg.scorecard || cfg; var F = ((sc.bribe_check || {}).formulas || {})[fid]; if (!F) return null;
    var byB = F.within === 'all' ? function () { return 'all'; } : function (f) { return f.bucket || 'other'; };
    var terms = Object.keys(F.terms || {}); var groups = {};
    wf.pools.forEach(function (f) { if (!inField(f, opt)) return; if (terms.some(function (t) { return !isNum(f[t]); })) return; (groups[byB(f)] = groups[byB(f)] || []).push(f); });
    var out = {};
    Object.keys(groups).forEach(function (g) { var fs = groups[g]; var mm = {}; terms.forEach(function (t) { var a = fs.map(function (f) { return f[t]; }); mm[t] = [Math.min.apply(null, a), Math.max.apply(null, a)]; });
      fs.forEach(function (f) { var v = 0; terms.forEach(function (t) { var lo = mm[t][0], hi = mm[t][1]; v += F.terms[t] * (hi > lo ? (f[t] - lo) / (hi - lo) : 0); }); out[f.id] = { score: v, group: g }; }); });
    return out;
  }
  function rankMap(wf, cfg, criterion, opt) {
    var sc = cfg.scorecard || cfg; var m = {};
    var fsc = formulaScores(wf, cfg, criterion, opt);
    if (fsc) {
      var ofG = {}, seenF = {}; Object.keys(fsc).forEach(function (id) { ofG[fsc[id].group] = (ofG[fsc[id].group] || 0) + 1; });
      Object.keys(fsc).sort(function (a, b) { return fsc[b].score - fsc[a].score; }).forEach(function (id) { var g = fsc[id].group; seenF[g] = (seenF[g] || 0) + 1; m[id] = { rank: seenF[g], value: fsc[id].score, of: ofG[g], group: g }; });
      return m;
    }
    if (criterion === 'allround' || (sc.presets || []).some(function (p) { return p.id === criterion; })) {
      var s = scoreField(wf, cfg, criterion === 'allround' ? 'allround' : criterion, opt); s.field.forEach(function (x) { if (x.rank != null) m[x.f.id] = { rank: x.rank, value: x.composite, of: x.of, group: x.group }; });
      return m;
    }
    var dir = ((sc.metrics || {})[criterion] || {}).dir || 1; var byB = groupOf(sc);
    var field = wf.pools.filter(function (f) { return inField(f, opt) && isNum(f[criterion]); });
    field.sort(function (a, b) { return dir * (b[criterion] - a[criterion]); });
    var seen = {}, ofG = {}; field.forEach(function (f) { var g = byB(f); ofG[g] = (ofG[g] || 0) + 1; });
    field.forEach(function (f) { var g = byB(f); seen[g] = (seen[g] || 0) + 1; m[f.id] = { rank: seen[g], value: f[criterion], of: ofG[g], group: g }; });
    return m;
  }

  function avgRanks(xs) { var idx = xs.map(function (v, i) { return [v, i]; }).sort(function (a, b) { return a[0] - b[0]; }); var r = new Array(xs.length); for (var i = 0; i < idx.length;) { var j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++; var avg = (i + j) / 2 + 1; for (var k = i; k <= j; k++) r[idx[k][1]] = avg; i = j + 1; } return r; }
  function spearman(xs, ys) {
    if (xs.length < 3) return null; var rx = avgRanks(xs), ry = avgRanks(ys); var mx = mean(rx), my = mean(ry), sxy = 0, sxx = 0, syy = 0;
    for (var i = 0; i < xs.length; i++) { sxy += (rx[i] - mx) * (ry[i] - my); sxx += (rx[i] - mx) * (rx[i] - mx); syy += (ry[i] - my) * (ry[i] - my); }
    return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
  }

  /** where a placement's LUNA went, per pool id, per epoch */
  function allocation(placement) { var a = {}; (placement.legs || []).forEach(function (l) { if (!l.pool || l.luna_per_epoch == null) return; a[l.pool] = (a[l.pool] || 0) + l.luna_per_epoch; }); return a; }
  function placementWindow(placement) { var s = Infinity, e = -Infinity; (placement.legs || []).forEach(function (l) { if (l.start < s) s = l.start; if (l.end > e) e = l.end; }); return { start: s, end: e }; }

  /** Bribe check: on the day before the placement executed, how well does each criterion × window explain the allocation? */
  function bribeCheck(series, cfg, placement, opt) {
    var sc = cfg.scorecard || cfg; var bc = sc.bribe_check || {}; var asOf = addDays(String(placement.executed_at).slice(0, 10), -1);
    var alloc = allocation(placement); var bribedIds = Object.keys(alloc); var total = bribedIds.reduce(function (s, k) { return s + alloc[k]; }, 0);
    var rows = []; var fields = {};
    (bc.windows || Object.keys(sc.windows)).forEach(function (wk) {
      var wf = windowFacts(series, cfg, { asOf: asOf, window: wk });
      (bc.criteria || ['efficiency']).forEach(function (c) {
        var rm = rankMap(wf, cfg, c, opt); var ids = Object.keys(rm);
        if (ids.length < 3) { rows.push({ criterion: c, window: wk, rho: null, n: ids.length }); return; }
        var xs = ids.map(function (id) { return standing(rm[id]); }), ys = ids.map(function (id) { return alloc[id] || 0; });
        var rho = spearman(xs, ys);
        var ranked = bribedIds.filter(function (id) { return rm[id]; }); var N = ranked.length;
        var nIn = {}; ranked.forEach(function (id) { nIn[rm[id].group] = (nIn[rm[id].group] || 0) + 1; });   // top-N is per group: N = pools bribed in that bucket
        var overlap = ids.filter(function (id) { return alloc[id] && rm[id].rank <= (nIn[rm[id].group] || 0); }).length;
        var lunaRanked = ranked.reduce(function (s, id) { return s + alloc[id]; }, 0);
        var lunaTopHalf = ranked.filter(function (id) { return rm[id].rank <= Math.ceil(rm[id].of / 2); }).reduce(function (s, id) { return s + alloc[id]; }, 0);
        var passed = ids.filter(function (id) { return !alloc[id] && ranked.some(function (b) { return rm[b].group === rm[id].group && rm[b].rank > rm[id].rank; }); });
        rows.push({ criterion: c, window: wk, rho: rho == null ? null : Math.round(rho * 100) / 100, n: ids.length, bribed_ranked: N, bribed_unranked: bribedIds.length - N, overlap_topN: overlap, luna_ranked_pct: total ? lunaRanked / total * 100 : null, luna_top_half_pct: lunaRanked ? lunaTopHalf / lunaRanked * 100 : null, passed_over: passed.length });
        fields[c + '|' + wk] = rm;
      });
    });
    var valid = rows.filter(function (r) { return r.rho != null; }).sort(function (a, b) { return b.rho - a.rho; });
    return { asOf: asOf, window: placementWindow(placement), alloc: alloc, luna_total: total, rows: rows, best: valid[0] || null, ranked: valid, fields: fields };
  }

  /** Formula vs actual: if the placement's per-bucket LUNA had been split in proportion to the formula score, where would it go? */
  function formulaFit(series, cfg, placement, fid, windowKey, opt) {
    var asOf = addDays(String(placement.executed_at).slice(0, 10), -1);
    var wf = windowFacts(series, cfg, { asOf: asOf, window: windowKey }); var fsc = formulaScores(wf, cfg, fid, opt) || {};
    var alloc = allocation(placement); var budget = {}, unscored = [];
    Object.keys(alloc).forEach(function (id) { if (fsc[id]) budget[fsc[id].group] = (budget[fsc[id].group] || 0) + alloc[id]; else unscored.push(id); });
    var rows = [], moved = 0, total = 0;
    Object.keys(budget).forEach(function (g) { var ids = Object.keys(fsc).filter(function (id) { return fsc[id].group === g; }); var sum = ids.reduce(function (s, id) { return s + fsc[id].score; }, 0);
      ids.forEach(function (id) { var pred = sum > 0 ? budget[g] * fsc[id].score / sum : 0; var act = alloc[id] || 0; moved += Math.abs(pred - act); total += act; rows.push({ id: id, group: g, score: fsc[id].score, predicted: pred, actual: act }); }); });
    var ids2 = Object.keys(fsc); var rho = spearman(ids2.map(function (id) { return fsc[id].score; }), ids2.map(function (id) { return alloc[id] || 0; }));
    return { asOf: asOf, window: windowKey, rows: rows, unscored: unscored, unscored_luna: unscored.reduce(function (s, id) { return s + alloc[id]; }, 0), placed_differently_pct: total ? moved / 2 / total * 100 : null, rho: rho };
  }

  /** Sizing: among the pools a placement picked, does each pool's share of the LUNA match its share of a metric? */
  function sizingCheck(series, cfg, placement, metric, windowKey, opt) {
    var sc = cfg.scorecard || cfg; var asOf = addDays(String(placement.executed_at).slice(0, 10), -1);
    var wf = windowFacts(series, cfg, { asOf: asOf, window: windowKey }); var by = {}; wf.pools.forEach(function (f) { by[f.id] = f; });
    var grade = {}; scoreField(wf, cfg, 'allround', opt).field.forEach(function (x) { grade[x.f.id] = x; });
    var fsc = formulaScores(wf, cfg, metric, opt);
    var val = function (id) { var f = by[id]; if (!f) return null; if (metric === 'grade') return grade[id] && grade[id].composite != null ? grade[id].composite : null; if (fsc) return fsc[id] ? fsc[id].score : null; return isNum(f[metric]) ? f[metric] : null; };
    var alloc = allocation(placement); var ids = Object.keys(alloc).filter(function (id) { return val(id) != null; }); var skipped = Object.keys(alloc).filter(function (id) { return ids.indexOf(id) < 0; });
    var tl = ids.reduce(function (s, id) { return s + alloc[id]; }, 0), tv = ids.reduce(function (s, id) { return s + val(id); }, 0);
    var rows = ids.map(function (id) { var f = by[id]; var sl = tl ? alloc[id] / tl : 0, sv = tv ? val(id) / tv : 0; var g = grade[id];
      return { id: id, bucket: f.bucket, letter: g ? g.letter : null, rank: g ? g.rank : null, of: g ? g.of : null, luna: alloc[id], luna_share: sl, metric_value: val(id), metric_share: sv, weight: sv > 0 ? sl / sv : null, luna_per_1k_vol_day: f.volume > 0 ? alloc[id] / f.volume * 1000 : null, bucket_pct: f.bucket_pct }; });
    rows.sort(function (a, b) { return b.luna - a.luna; });
    var mis = rows.reduce(function (s, r) { return s + Math.abs(r.luna_share - r.metric_share); }, 0) / 2 * 100;
    // buckets: PD LUNA share vs the bucket's share of all TLA volume and its emission share
    var bL = {}, bV = {}; rows.forEach(function (r) { bL[r.bucket] = (bL[r.bucket] || 0) + r.luna; });
    wf.pools.forEach(function (f) { if (inField(f, opt) && isNum(f.volume)) bV[f.bucket] = (bV[f.bucket] || 0) + f.volume; });
    var tV = Object.keys(bV).reduce(function (s, b) { return s + bV[b]; }, 0);
    var buckets = groupOrder(sc, Object.keys(bV).concat(Object.keys(bL))).map(function (b) { return { bucket: b, luna_share: tl ? (bL[b] || 0) / tl : 0, volume_share: tV ? (bV[b] || 0) / tV : 0, emission_share: (sc.bucket_share_of_tla || {})[b] != null ? sc.bucket_share_of_tla[b] : null }; });
    var cpv = rows.map(function (r) { return r.luna_per_1k_vol_day; }).filter(function (v) { return v > 0; });
    return { asOf: asOf, window: windowKey, metric: metric, rows: rows, skipped: skipped, sized_differently_pct: rows.length > 1 ? mis : null, buckets: buckets,
      cost_spread: cpv.length > 1 ? { min: Math.min.apply(null, cpv), max: Math.max.apply(null, cpv) } : null };
  }

  /** What changed: each bribed pool before the window, during it, and k epochs after — beside the unbribed field's median change. */
  function afterEffect(series, cfg, placement, opt) {
    var sc = cfg.scorecard || cfg; var k = (opt && opt.after != null) ? opt.after : ((sc.bribe_check || {}).after_epochs || 3);
    var w = placementWindow(placement); var alloc = allocation(placement);
    var day0 = addDays(String(placement.executed_at).slice(0, 10), -1);
    var endE = series.epochs[String(w.end)], afterE = series.epochs[String(w.end + k)];
    var lastDay = series.days[series.days.length - 1];
    var dDuring = endE && endE.end ? (endE.end < lastDay ? addDays(endE.end, -1) : lastDay) : lastDay;
    var afterPartial = false;
    var dAfter = afterE && afterE.end ? (afterE.end <= lastDay ? addDays(afterE.end, -1) : (afterE.start && afterE.start <= lastDay ? (afterPartial = true, lastDay) : null)) : null;
    if (!dAfter && endE && endE.end && endE.end < lastDay) { dAfter = lastDay; afterPartial = true; }   // fewer than k epochs have passed — read what has
    var winLen = opt && opt.window ? opt.window : '30d';
    var before = windowFacts(series, cfg, { asOf: day0, window: winLen });
    var during = windowFacts(series, cfg, { asOf: dDuring, window: '7d' });
    var after = dAfter ? windowFacts(series, cfg, { asOf: dAfter, window: '7d' }) : null;
    var by = function (wf) { var m = {}; (wf ? wf.pools : []).forEach(function (f) { m[f.id] = f; }); return m; };
    var B = by(before), D = by(during), A = by(after);
    var metrics = ['liquidity', 'volume', 'efficiency_raw', 'bucket_pct'];
    function chg(a, b) { return (isNum(a) && isNum(b) && a !== 0) ? (b - a) / Math.abs(a) * 100 : null; }
    var rows = Object.keys(B).filter(function (id) { return B[id].tla && (alloc[id] || (B[id].liquidity >= 1000)); }).map(function (id) {
      var r = { id: id, name: B[id].name, bribed: !!alloc[id], luna_per_epoch: alloc[id] || 0, before: {}, during: {}, after: {}, chg_during: {}, chg_after: {} };
      metrics.forEach(function (m) { r.before[m] = B[id][m]; r.during[m] = D[id] ? D[id][m] : null; r.after[m] = A[id] ? A[id][m] : null; r.chg_during[m] = chg(r.before[m], r.during[m]); r.chg_after[m] = chg(r.before[m], r.after[m]); });
      return r;
    });
    var base = {}; ['chg_during', 'chg_after'].forEach(function (ph) { base[ph] = {}; metrics.forEach(function (m) { base[ph][m] = median(rows.filter(function (r) { return !r.bribed; }).map(function (r) { return r[ph][m]; })); }); });
    return { window: w, after_epochs: k, before: { from: before.from, to: before.to }, during: { from: during.from, to: during.to }, after: after ? { from: after.from, to: after.to, partial: afterPartial } : null, rows: rows, unbribed_median: base };
  }

  /** rank of each bribed pool on one criterion at the end of every epoch from the one before the window through `after` epochs past it */
  function rankPath(series, cfg, placement, criterion, windowKey, opt) {
    var w = placementWindow(placement); var k = (opt && opt.after != null) ? opt.after : 3; var alloc = allocation(placement); var lastDay = series.days[series.days.length - 1]; var path = [];
    for (var E = w.start - 1; E <= w.end + k; E++) {
      var em = series.epochs[String(E)]; if (!em || !em.end) continue; var d = addDays(em.end, -1); if (d > lastDay) { if (em.start <= lastDay) d = lastDay; else break; }
      var rm = rankMap(windowFacts(series, cfg, { asOf: d, window: windowKey || '7d' }), cfg, criterion, opt); var of = 0; for (var id in rm) { of = rm[id].of; break; }
      var ranks = {}, ofs = {}; Object.keys(alloc).forEach(function (id) { ranks[id] = rm[id] ? rm[id].rank : null; ofs[id] = rm[id] ? rm[id].of : null; });
      path.push({ epoch: E, asOf: d, of: of, ranks: ranks, ofs: ofs, phase: E < w.start ? 'before' : E <= w.end ? 'paid' : 'after' });
    }
    return path;
  }

  function validate(cfg) {
    var sc = cfg.scorecard || cfg; var errs = [];
    (sc.presets || []).forEach(function (p) { var s = 0; for (var k in p.weights) s += p.weights[k]; if (Math.abs(s - 1) > 1e-9) errs.push('preset ' + p.id + ' weights sum to ' + s); for (var m in p.weights) if (m !== 'purpose' && !(sc.metrics || {})[m]) errs.push('preset ' + p.id + ' uses unknown metric ' + m); });
    if (!sc.windows || !sc.windows[sc.default_window]) errs.push('default_window not in windows');
    return errs;
  }

  return { VERSION: VERSION, pairClass: pairClass, windowFacts: windowFacts, scoreField: scoreField, rankMap: rankMap, ranksAcross: ranksAcross, bribeCheck: bribeCheck, afterEffect: afterEffect, rankPath: rankPath, allocation: allocation, placementWindow: placementWindow, spearman: spearman, validate: validate, presetOf: presetOf, sizingCheck: sizingCheck, formulaScores: formulaScores, formulaFit: formulaFit, groupOrder: groupOrder, standing: standing, epochOf: epochOf, addDays: addDays, median: median };
});
