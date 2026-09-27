'use strict';
// mock-run-ratio-anchor.js — BINDING gate for lib/ratio-anchor.js 1.0.0 + state-history 1.2.0's forward ratio days.
// Real committed inputs from a tla-core checkout (every state-history epoch, every price-history + ratios month); nothing
// is fetched, writes go to memory. Usage: TLA_CORE_DIR=<tla-core checkout> node --max-old-space-size=200 mock-run-ratio-anchor.js
//   G1 anchors: one per complete epoch per hub, E97 first
//   G2 the chain agrees with the 2026-05-13+ chain_exact archive (< 0.5 %) — the two sources measure the same thing
//   G3 the error it repairs is real: ampLUNA 2024 interpolated rows ≥ +8 % high on average; bLUNA ≥ +3 %
//   G4 every anchored day sits between its two bracketing chain reads (log-linear never overshoots)
//   G5 labels: repaired rows keep repair.was = the old value; added rows carry added_by; chain_exact rows byte-identical
//   G6 untouched: every non-LST price row, every measured LST USD row (tla / coingecko / chain_exact) unchanged
//   G7 USD = base × anchored ratio on every row it wrote
//   G8 idempotent: a second run changes 0 rows, 0 months
//   G9 forward (writeForwardRatios): with the newest week removed, the duty writes exactly those days, equal to the history run
//   G10 forward writes ratios only (no price-history file), and a second forward run writes nothing
const fs = require('fs'), path = require('path');
const SRC = process.env.TLA_CORE_DIR; if (!SRC) { console.error('TLA_CORE_DIR required'); process.exit(1); }
const RA = require('./lib/ratio-anchor'); const SH = require('./lib/state-history');
let pass = 0, fail = 0; const check = (n, ok, x) => { if (ok) { pass++; console.log('  ✅ ' + n); } else { fail++; console.log('  ❌ ' + n + (x != null ? ' — ' + JSON.stringify(x).slice(0, 300) : '')); } };
const J = (p) => JSON.parse(fs.readFileSync(path.join(SRC, p), 'utf8'));
const clone = (o) => JSON.parse(JSON.stringify(o));
const epochs = fs.readdirSync(path.join(SRC, 'dex-data/state-history/epochs')).filter(f => /^\d+\.json$/.test(f)).map(f => J('dex-data/state-history/epochs/' + f)).sort((a, b) => a.epoch - b.epoch);
const loadMonths = (dir) => { const m = new Map(); for (const y of fs.readdirSync(path.join(SRC, dir)).filter(x => /^20\d\d$/.test(x))) for (const f of fs.readdirSync(path.join(SRC, dir, y)).filter(x => /^\d\d\.json$/.test(x))) m.set(`${y}/${f.slice(0, 2)}`, J(`${dir}/${y}/${f}`)); return m; };
const R0 = loadMonths('price-history/ratios'), P0 = loadMonths('price-history');
const LST = Object.keys(RA.HUB_BASE);
(async () => {
  console.log('— history (the tla-core ratio-reanchor Action\'s call)');
  const A = RA.anchorsFrom(epochs);
  const complete = epochs.filter(e => e.complete).length;
  check(`G1 anchors: ${complete} complete epochs → ${complete} per hub (${LST.join(', ')}), first = E${epochs[0].epoch}`, LST.every(h => A[h] && A[h].length === complete && A[h][0].epoch === epochs[0].epoch), LST.map(h => [h, A[h] && A[h].length]));
  const R = new Map([...R0].map(([k, v]) => [k, clone(v)])), P = new Map([...P0].map(([k, v]) => [k, clone(v)]));
  const r = RA.reanchor({ ratioMonths: R, priceMonths: P, anchors: A, opts: { by: 'gate', at: 'gate' } });
  const rep = r.report;
  check('G2 chain vs chain_exact archive: max |Δ| < 0.5 % on every hub that has both — ' + LST.filter(h => rep[h].chain_exact_kept).map(h => h + ' ' + rep[h].chain_exact_max_abs_delta_pct.toFixed(3) + '% (' + rep[h].chain_exact_kept + ' days)').join(' · '), LST.every(h => !rep[h].chain_exact_kept || rep[h].chain_exact_max_abs_delta_pct < 0.5));
  const y24 = (h) => { const xs = []; for (const [k, doc] of R) if (k.startsWith('2024/')) for (const v of Object.values(doc.days)) if (v[h] && v[h].repair && v[h].tier === 'chain_anchored') xs.push(v[h].repair.was / v[h].ratio - 1); return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length * 100 : null; };
  const a24 = y24('ampLUNA'), b24 = y24('bLUNA');
  check(`G3 the repaired error is real: 2024 interpolated rows were ampLUNA ${a24 && a24.toFixed(1)}% / bLUNA ${b24 && b24.toFixed(1)}% high`, a24 >= 8 && b24 >= 3, { a24, b24 });
  let between = 0, outside = 0; for (const h of LST) for (const [k, doc] of R) for (const [day, v] of Object.entries(doc.days)) { const x = v[h]; if (!x || x.tier !== 'chain_anchored') continue; const [ea, eb] = x.anchors; const pa = A[h].find(p => p.epoch === ea), pb = A[h].find(p => p.epoch === eb); const lo = Math.min(pa.ratio, pb.ratio) - 1e-8, hi = Math.max(pa.ratio, pb.ratio) + 1e-8; if (x.ratio >= lo && x.ratio <= hi) between++; else outside++; }
  check(`G4 ${between} anchored days all sit between their two chain reads`, outside === 0 && between > 2000, { between, outside });
  const firstRow = {}; for (const h of LST) { const ds = []; for (const [, doc] of R0) for (const [day, v] of Object.entries(doc.days)) if (v[h]) ds.push(day); ds.sort(); if (ds.length && R0.get(RA.monthKey(ds[0])).days[ds[0]][h].tier === 'interpolated' && Date.parse(ds[0] + 'T12:00:00Z') < A[h][0].t) firstRow[h] = ds[0]; }   // only a series that starts BEFORE the first chain read has a left anchor
  let lab = { rep: 0, repBad: 0, add: 0, addBad: 0, exact: 0, exactBad: 0 };
  for (const [k, doc] of R) { const old = R0.get(k); for (const [day, v] of Object.entries(doc.days)) for (const h of LST) { const x = v[h]; if (!x) continue; const o = old && old.days[day] && old.days[day][h];
    if (o && o.tier === 'chain_exact') { lab.exact++; if (JSON.stringify(o) !== JSON.stringify(x)) lab.exactBad++; }
    else if (o && firstRow[h] === day) { lab.leftAnchor = (lab.leftAnchor || 0) + 1; if (JSON.stringify(o) !== JSON.stringify(x)) lab.repBad++; }   // the series' first row is the left anchor of the pre-E97 re-interpolation — kept as is
    else if (o) { lab.rep++; if (!x.repair || x.repair.was !== o.ratio || x.repair.was_tier !== o.tier) { lab.repBad++; (lab.bad = lab.bad || []).push([h, day, o.tier, x.tier]); } }
    else { lab.add++; if (x.added_by !== 'gate') lab.addBad++; } } }
  check(`G5 labels: ${lab.rep} repaired keep repair.was, ${lab.add} added carry added_by, ${lab.exact} chain_exact byte-identical, ${lab.leftAnchor || 0} series-first rows kept as the left anchor`, !lab.repBad && !lab.addBad && !lab.exactBad && lab.rep > 1000 && (lab.leftAnchor || 0) === Object.keys(firstRow).length, lab);
  let moved = 0, measuredKept = 0; for (const [k, doc] of P) { const old = P0.get(k); for (const [day, v] of Object.entries(old.days)) for (const [s, o] of Object.entries(v)) { const x = doc.days[day][s]; const lstInterp = LST.includes(s) && /×ratio\(interpolated\)$/.test(o.src || ''); if (lstInterp) continue; if (JSON.stringify(o) !== JSON.stringify(x)) moved++; else if (LST.includes(s)) measuredKept++; } }
  check(`G6 untouched: 0 non-LST or measured LST price rows changed (${measuredKept} measured LST rows kept)`, moved === 0 && measuredKept > 0, { moved });
  let usdOk = 0, usdBad = 0; for (const [k, doc] of P) for (const [day, v] of Object.entries(doc.days)) for (const h of LST) { const x = v[h]; if (!x || !/ratio\((chain_anchored|interpolated_reanchored)\)$/.test(x.src || '')) continue; const rr = R.get(k).days[day][h]; const b = v[RA.HUB_BASE[h]]; if (Math.abs(x.usd - Math.round(b.usd * rr.ratio * 1e8) / 1e8) < 1e-12) usdOk++; else usdBad++; }
  check(`G7 ${usdOk} written USD rows = base × anchored ratio (same day)`, usdBad === 0 && usdOk > 2000, { usdOk, usdBad });
  const r2 = RA.reanchor({ ratioMonths: R, priceMonths: P, anchors: A, opts: { by: 'gate', at: 'gate2' } });
  check('G8 idempotent: second run changes 0 months, 0 rows', r2.changedRatio.size === 0 && r2.changedPrice.size === 0 && Object.values(r2.report).every(x => x.repaired + x.added + x.pre_anchor_reinterpolated + x.usd_repaired + x.usd_added === 0), [...r2.changedRatio]);

  console.log('— forward (dex-data state-history 1.2.0: writeForwardRatios after a new complete epoch)');
  const last = epochs[epochs.length - 1], prev = epochs[epochs.length - 2];
  const lastWeek = RA.spanDays(RA.anchorsFrom([prev, last]).ampLUNA);
  const S = new Map(); for (const [k, doc] of R) S.set(`price-history/ratios/${k}.json`, clone(doc));
  for (const d of lastWeek) { const doc = S.get(`price-history/ratios/${RA.monthKey(d)}.json`); if (doc && doc.days[d] && doc.days[d].ampLUNA && doc.days[d].ampLUNA.anchors[0] === prev.epoch) delete doc.days[d]; }
  const writes = []; const readJson = async (p) => (S.has(p) ? clone(S.get(p)) : null); const writeJson = async (p, o) => { writes.push(p); S.set(p, clone(o)); };
  const byEp = new Map(epochs.map(e => [e.epoch, e])); const readEpoch = async (ep) => clone(byEp.get(ep));
  const out = await SH.writeForwardRatios({ readJson, writeJson, readEpoch, epochs: epochs.map(e => e.epoch), now: () => new Date('2026-09-28T00:05:00Z') });
  let same = 0, diff = 0; for (const d of lastWeek) { const got = S.get(`price-history/ratios/${RA.monthKey(d)}.json`).days[d]; const want = R.get(RA.monthKey(d)).days[d]; for (const h of LST) { if (!want[h] || want[h].tier !== 'chain_anchored' || want[h].anchors[0] !== prev.epoch) continue; if (got && got[h] && got[h].ratio === want[h].ratio && String(got[h].anchors) === String(want[h].anchors)) same++; else diff++; } }
  check(`G9 forward E${prev.epoch}→E${last.epoch}: ${lastWeek.length} days × ${LST.length} hubs rewritten, ${same} rows equal to the history run (one rule)`, diff === 0 && same === lastWeek.length * LST.length && out.from === prev.epoch && out.to === last.epoch, { same, diff, out });
  check('G10 forward writes price-history/ratios only (no USD rows), and a second forward run writes nothing', writes.length > 0 && writes.every(p => p.startsWith('price-history/ratios/')) && await (async () => { const n = writes.length; await SH.writeForwardRatios({ readJson, writeJson, readEpoch, epochs: epochs.map(e => e.epoch), now: () => new Date('2026-09-28T01:05:00Z') }); return writes.length === n; })(), writes);
  console.log(`\n${pass}/${pass + fail} passed`); process.exit(fail ? 1 : 0);
})().catch(e => { console.error('GATE CRASH', e); process.exit(1); });
