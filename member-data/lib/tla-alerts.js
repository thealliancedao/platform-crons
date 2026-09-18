// member-data/lib/tla-alerts.js — 1.0.0 (2026-09-17) — TLA alert rules, folded into member-data (it owns tla-snapshot).
//
// PURE: evaluate(config, series) → { rows, stats }. No I/O here; index.js loads the config + the daily products and writes
// member-data/tla-alerts/current.json. Every threshold comes from docs/curated/alert-thresholds.json — nothing is a literal
// in this file. Every fired row carries rule · params · raw values, so a reader can see why. Sensitivity: each rule is also
// evaluated at the config's multipliers (0.5× / 1× / 2× of its thresholds) over the history window so the Alert Center can
// show "at this setting: N/month" before anyone changes a number. Rules are re-evaluated from scratch every run (no state).
//
// series = { snapshots: [{date, epoch, pools:[{gauge_pool_id,name,bucket,status,vp,staked_usd}]}] (asc by date),
//            apr: [{date, pools:[{gauge_pool_id,name,gauge,apr}]}], volume: [{date, pools:[{pool_address,name,bucket,vol}]}] }
'use strict';
const VERSION = '1.0.0';
const num = (v) => (v == null || !isFinite(Number(v))) ? null : Number(v);
const D = 864e5;
function scale(params, m) { const o = {}; for (const [k, v] of Object.entries(params || {})) o[k] = (typeof v === 'number' && /^(min_|multiple_)/.test(k)) ? v * m : v; return o; }
function row(o) { return Object.assign({ ts: o.date + 'T00:00:00Z' }, o); }

function evalRules(cfg, series, mult) {
  const out = [];
  const T = cfg.tla || {};
  const P = (r) => scale((T[r] && T[r].params) || {}, mult);
  const on = (r) => T[r] && T[r].enabled !== false;
  const snaps = series.snapshots || [];
  // --- gauge set + epoch flip + VP moves (tla-snapshot daily) ---
  for (let i = 1; i < snaps.length; i++) {
    const a = snaps[i - 1], b = snaps[i]; const sameEpoch = a.epoch != null && b.epoch != null && a.epoch === b.epoch;
    const byA = Object.fromEntries(a.pools.map(p => [p.gauge_pool_id, p])), byB = Object.fromEntries(b.pools.map(p => [p.gauge_pool_id, p]));
    if (on('gauge_set_change')) {
      const p = P('gauge_set_change'); const nm = (x, g) => (x.name && !/^(cw20|native):/.test(x.name)) ? x.name : `an unnamed ${x.bucket || ''} gauge (${String(g).replace(/^(cw20|native):/, '').slice(0, 12)}…)`;
      // plain words for the status vocabulary of tla-snapshot: active · voted_but_below_threshold · zero_vp
      const MEAN = { 'voted_but_below_threshold>active': (n) => `${n} is back above the vote threshold — it earns TLA emissions again this epoch`, 'active>voted_but_below_threshold': (n) => `${n} dropped below the vote threshold — it stops earning TLA emissions until votes return`, 'active>zero_vp': (n) => `${n} lost every vote — no emissions`, 'zero_vp>active': (n) => `${n} went from no votes to earning emissions`, 'voted_but_below_threshold>zero_vp': (n) => `${n} lost its remaining votes`, 'zero_vp>voted_but_below_threshold': (n) => `${n} has votes again, still below the threshold` };
      const big = (x, y) => Math.max(num(x && x.vp) || 0, num(y && y.vp) || 0) >= p.min_vp;
      for (const [g, x] of Object.entries(byB)) { const q = byA[g]; if (!q) { if (big(x)) out.push(row({ date: b.date, rule: 'gauge_set_change', kind: 'added', gauge_pool_id: g, name: x.name, bucket: x.bucket, label: `${nm(x, g)} joined the TLA gauge list (${x.bucket} bucket)`, value: `${((num(x.vp) || 0) / 1e6).toFixed(2)}M VP · ${x.status || ''}`, raw: { status: x.status, vp: x.vp } })); }
        else if ((q.status || '') !== (x.status || '') && big(x, q)) { const f = MEAN[`${q.status}>${x.status}`]; const v0 = num(q.vp) || 0, v1 = num(x.vp) || 0, dpct = v0 ? (v1 - v0) / v0 * 100 : null; const vpTxt = dpct != null && Math.abs(dpct) >= 10 ? ` (VP ${(v0 / 1e6).toFixed(2)}M → ${(v1 / 1e6).toFixed(2)}M, ${dpct >= 0 ? '+' : ''}${dpct.toFixed(0)}%)` : '';
          out.push(row({ date: b.date, rule: 'gauge_set_change', kind: 'status', gauge_pool_id: g, name: x.name, bucket: x.bucket, label: (f ? f(nm(x, g)) : `${nm(x, g)}: ${q.status || '?'} → ${x.status || '?'}`) + vpTxt, value: `status ${q.status || '?'} → ${x.status || '?'} · ${(v1 / 1e6).toFixed(2)}M VP now`, raw: { from: q.status, to: x.status, vp_from: v0, vp_to: v1, vp_pct: dpct } })); } }
      for (const [g, q] of Object.entries(byA)) if (!byB[g] && big(q)) out.push(row({ date: b.date, rule: 'gauge_set_change', kind: 'removed', gauge_pool_id: g, name: q.name, bucket: q.bucket, label: `${nm(q, g)} left the TLA gauge list (${q.bucket} bucket)`, value: `was ${((num(q.vp) || 0) / 1e6).toFixed(2)}M VP · ${q.status || ''}`, raw: { was: q.status, vp: q.vp } }));
    }
    const bucketsA = {}, bucketsB = {}; for (const p of a.pools) bucketsA[p.bucket] = (bucketsA[p.bucket] || 0) + (num(p.vp) || 0); for (const p of b.pools) bucketsB[p.bucket] = (bucketsB[p.bucket] || 0) + (num(p.vp) || 0);
    if (!sameEpoch && on('epoch_flip')) {
      const moves = Object.keys(bucketsB).map(k => ({ bucket: k, from: bucketsA[k] || 0, to: bucketsB[k] || 0 })).map(m => Object.assign(m, { pct: m.from ? (m.to - m.from) / m.from * 100 : null }));
      const tot = Object.values(bucketsB).reduce((s, v) => s + v, 0);
      out.push(row({ date: b.date, rule: 'epoch_flip', kind: 'epoch', epoch: b.epoch, label: `Epoch ${b.epoch} started — votes settled, rewards distributed · ${Math.round(tot / 1e6 * 10) / 10}M VP locked across ${moves.length} buckets`, value: 'bucket VP at the flip vs the day before: ' + moves.map(m => `${m.bucket} ${m.pct == null ? '' : (m.pct >= 0 ? '+' : '') + m.pct.toFixed(1) + '%'}`).join(' · '), raw: { buckets: moves, total_vp: tot } }));
      continue;   // boundary day: VP rules skip it
    }
    if (on('bucket_vp_move')) { const p = P('bucket_vp_move'); for (const k of Object.keys(bucketsB)) { const f = bucketsA[k] || 0, t = bucketsB[k] || 0; if (f < p.min_vp) continue; const pct = (t - f) / f * 100; if (Math.abs(pct) >= p.min_pct && Math.abs(t - f) >= p.min_vp) out.push(row({ date: b.date, rule: 'bucket_vp_move', bucket: k, label: `${k} bucket VP ${pct >= 0 ? 'up' : 'down'} ${Math.abs(pct).toFixed(1)}% inside epoch ${b.epoch}`, value: `${(f / 1e6).toFixed(2)}M → ${(t / 1e6).toFixed(2)}M VP`, raw: { from: f, to: t, pct } })); } }
    if (on('pool_vp_move')) { const p = P('pool_vp_move'); for (const [g, q] of Object.entries(byB)) { const f = num(byA[g] && byA[g].vp), t = num(q.vp); if (f == null || t == null || f < p.min_vp) continue; const pct = (t - f) / f * 100; if (Math.abs(pct) >= p.min_pct && Math.abs(t - f) >= p.min_vp) out.push(row({ date: b.date, rule: 'pool_vp_move', gauge_pool_id: g, name: q.name, bucket: q.bucket, label: `${q.name || g} VP ${pct >= 0 ? 'up' : 'down'} ${Math.abs(pct).toFixed(0)}%`, value: `${(f / 1e6).toFixed(2)}M → ${(t / 1e6).toFixed(2)}M VP`, raw: { from: f, to: t, pct } })); } }
    if (on('pool_liquidity_move')) { const p = P('pool_liquidity_move'); for (const [g, q] of Object.entries(byB)) { const f = num(byA[g] && byA[g].staked_usd), t = num(q.staked_usd); if (f == null || t == null || f < p.min_usd) continue; const pct = (t - f) / f * 100; if (Math.abs(pct) >= p.min_pct && Math.abs(t - f) >= p.min_usd) out.push(row({ date: b.date, rule: 'pool_liquidity_move', gauge_pool_id: g, name: q.name, bucket: q.bucket, label: `${q.name || g} staked liquidity ${pct >= 0 ? 'up' : 'down'} ${Math.abs(pct).toFixed(0)}%`, value: `$${Math.round(f).toLocaleString()} → $${Math.round(t).toLocaleString()}`, raw: { from: f, to: t, pct } })); } }
  }
  // --- APR (eris-apr daily) ---
  const boundary = new Set(); for (let i = 1; i < snaps.length; i++) if (snaps[i - 1].epoch != null && snaps[i].epoch != null && snaps[i - 1].epoch !== snaps[i].epoch) boundary.add(snaps[i].date);
  if (on('pool_apr_move')) { const p = P('pool_apr_move'); const apr = series.apr || []; for (let i = 1; i < apr.length; i++) { const A = Object.fromEntries(apr[i - 1].pools.map(x => [x.gauge_pool_id, x])), B = apr[i]; if (boundary.has(B.date)) continue; /* APR resets with the pots at the flip */ for (const x of B.pools) { const f = num(A[x.gauge_pool_id] && A[x.gauge_pool_id].apr), t = num(x.apr); if (f == null || t == null) continue; const pts = t - f, rel = f ? Math.abs(pts) / f * 100 : null; if (Math.abs(pts) >= p.min_points && rel != null && rel >= p.min_rel_pct) out.push(row({ date: B.date, rule: 'pool_apr_move', gauge_pool_id: x.gauge_pool_id, name: x.name, bucket: x.gauge, label: `${x.name || x.gauge_pool_id} APR ${pts >= 0 ? 'up' : 'down'} ${Math.abs(pts).toFixed(1)} pts (${rel.toFixed(0)}%)`, value: `${f.toFixed(1)}% → ${t.toFixed(1)}%`, raw: { from: f, to: t, pts, rel } })); } } }
  // --- volume (dex daily) ---
  if (on('pool_volume_spike')) { const p = P('pool_volume_spike'); const vol = series.volume || []; for (let i = 0; i < vol.length; i++) { const day = vol[i]; const hist = vol.slice(Math.max(0, i - p.median_days), i); if (hist.length < Math.min(7, p.median_days)) continue; for (const x of day.pools) { const v = num(x.vol); if (v == null || v < p.min_usd) continue; const past = hist.map(h => { const y = h.pools.find(z => z.pool_address === x.pool_address); return y ? num(y.vol) : null; }).filter(z => z != null && z > 0).sort((a2, b2) => a2 - b2); if (past.length < 5) continue; const med = past[Math.floor(past.length / 2)]; if (med > 0 && v >= p.multiple_of_median * med) out.push(row({ date: day.date, rule: 'pool_volume_spike', pool_address: x.pool_address, name: x.name, bucket: x.bucket, label: `${x.name || x.pool_address} volume ${(v / med).toFixed(1)}× its ${p.median_days}d median`, value: `$${Math.round(v).toLocaleString()} vs median $${Math.round(med).toLocaleString()}`, raw: { vol: v, median: med, multiple: v / med } })); } } }
  return out;
}

function evaluate(config, series, opts) {
  const now = (opts && opts.now) || Date.now();
  const S = config.sensitivity || {}; const mults = S.multipliers || [0.5, 1, 2]; const histDays = S.history_days || 90, keepDays = S.keep_rows_days || 30;
  const histCut = new Date(now - histDays * D).toISOString().slice(0, 10), keepCut = new Date(now - keepDays * D).toISOString().slice(0, 10);
  const trimmed = { snapshots: (series.snapshots || []).filter(s => s.date >= histCut), apr: (series.apr || []).filter(s => s.date >= histCut), volume: (series.volume || []) };   // volume keeps its median lead-in
  const rulesOn = Object.entries(config.tla || {}).map(([k, v]) => [k, v]);
  const stats = {}; for (const [k, v] of rulesOn) stats[k] = { enabled: v.enabled !== false, params: v.params || {}, description: v.description || '', fired_30d: 0, fired_90d: 0, per_month_at: {} };
  for (const m of mults) {
    const rows = evalRules(config, trimmed, m).filter(r => r.date >= histCut);
    const months = Math.max(1, histDays / 30.4);
    for (const k of Object.keys(stats)) { const n = rows.filter(r => r.rule === k).length; stats[k].per_month_at[String(m)] = Math.round(n / months * 10) / 10; if (m === 1) { stats[k].fired_90d = n; stats[k].fired_30d = rows.filter(r => r.rule === k && r.date >= keepCut).length; } }
  }
  const rows1 = evalRules(config, trimmed, 1).filter(r => r.date >= keepCut).sort((a, b) => b.date.localeCompare(a.date));
  return { version: VERSION, evaluated_at: new Date(now).toISOString(), history: { days: histDays, from: histCut, snapshots: trimmed.snapshots.length, apr_days: trimmed.apr.length, volume_days: trimmed.volume.length }, rows: rows1, stats, multipliers: mults };
}
// adapters: raw product docs → series shapes (kept here so the mock and the cron share one reading)
function snapshotOf(doc, date) { return { date, epoch: doc.epoch && doc.epoch.currentEpoch != null ? doc.epoch.currentEpoch : null, pools: (doc.pools || []).map(p => ({ gauge_pool_id: p.gauge_pool_id, name: p.name, bucket: p.bucket, status: p.status, vp: p.voting_power && p.voting_power.vp_human, staked_usd: p.staked_in_tla_usd })) }; }
function aprOf(doc, date) { return { date, pools: (doc.pools || []).map(p => ({ gauge_pool_id: p.gauge_pool_id, name: p.pool_name, gauge: p.gauge, apr: p.eris_apr_pct })) }; }
function volumeOf(doc, date) { const pools = Array.isArray(doc.pools) ? doc.pools : Object.values(doc.pools || {}); return { date, pools: pools.filter(p => p.tla_relevant).map(p => ({ pool_address: p.pool_address, name: p.pool_name, bucket: p.bucket, vol: p.volume_24h_usd })) }; }
module.exports = { VERSION, evaluate, evalRules, snapshotOf, aprOf, volumeOf, scale };
