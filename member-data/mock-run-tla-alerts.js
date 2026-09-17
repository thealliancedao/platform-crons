#!/usr/bin/env node
// mock-run-tla-alerts.js — BINDING calibration gate for lib/tla-alerts.js: the rules replayed over the REAL daily history
// (tla-snapshot daily · eris-apr daily · astroport daily) with the committed alert-thresholds.json. It asserts the thing the
// owner asked for — alerts when it matters, not nuisance: every ENABLED rule fires at most MAX_PER_MONTH at 1× and is not
// dead over the history; and it prints the sensitivity table so a threshold change is judged on numbers, not vibes.
// Usage: TLA_CORE_DIR=<tla-core> node --max-old-space-size=200 mock-run-tla-alerts.js
'use strict';
const fs = require('fs'), path = require('path');
const A = require('./lib/tla-alerts.js');
const CORE = process.env.TLA_CORE_DIR; if (!CORE) { console.error('TLA_CORE_DIR required'); process.exit(1); }
const MAX_PER_MONTH = Number(process.env.MAX_PER_MONTH || 12);
let fails = 0; const check = (n, ok, d) => { console.log(`${ok ? '✓' : '✗'} ${n}${d !== undefined ? ' — ' + (typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 300) : ''}`); if (!ok) fails++; };
const cfg = JSON.parse(fs.readFileSync(path.join(CORE, 'docs/curated/alert-thresholds.json')));
const readDaily = (dir, adapt) => { const out = []; if (!fs.existsSync(dir)) return out; for (const f of fs.readdirSync(dir).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort()) { try { out.push(adapt(JSON.parse(fs.readFileSync(path.join(dir, f))), f.slice(0, 10))); } catch (e) { } } return out; };
const series = { snapshots: readDaily(path.join(CORE, 'member-data/tla-snapshot/daily'), A.snapshotOf), apr: readDaily(path.join(CORE, 'dex-data/eris-apr/daily'), A.aprOf), volume: readDaily(path.join(CORE, 'dex-data/astroport/snapshots/daily'), A.volumeOf) };
const last = series.snapshots[series.snapshots.length - 1]; const now = Date.parse(last.date + 'T23:59:00Z');
console.log(`history: snapshots ${series.snapshots.length} (${series.snapshots[0].date} → ${last.date}) · apr days ${series.apr.length} · volume days ${series.volume.length}`);
const R = A.evaluate(cfg, series, { now });
console.log(`\nrule                    on   30d  90d   /month @0.5×  @1×  @2×`);
for (const [k, s] of Object.entries(R.stats)) console.log(`${k.padEnd(23)} ${s.enabled ? 'on ' : 'off'}  ${String(s.fired_30d).padStart(3)}  ${String(s.fired_90d).padStart(3)}         ${String(s.per_month_at['0.5']).padStart(5)} ${String(s.per_month_at['1']).padStart(4)} ${String(s.per_month_at['2']).padStart(4)}`);
console.log('');
for (const [k, s] of Object.entries(R.stats)) { if (!s.enabled) { check(`${k}: off in the config (documented) — evaluated for the table only`, true); continue; }
  check(`${k}: fires ≤ ${MAX_PER_MONTH}/month at 1× (${s.per_month_at['1']}/month) — not a nuisance`, s.per_month_at['1'] <= MAX_PER_MONTH);
  check(`${k}: fired at least once over ${R.history.days}d at 0.5× or 1× (${s.per_month_at['0.5']}/month @0.5×) — not dead`, (s.fired_90d > 0) || s.per_month_at['0.5'] > 0); }
check('every fired row carries rule · label · value · raw · ts', R.rows.every(r => r.rule && r.label && 'value' in r && r.raw && r.ts));
check('epoch_flip fires exactly once per Monday in the kept window', R.rows.filter(r => r.rule === 'epoch_flip').every(r => new Date(r.ts).getUTCDay() === 1) && new Set(R.rows.filter(r => r.rule === 'epoch_flip').map(r => r.raw && r.epoch)).size === R.rows.filter(r => r.rule === 'epoch_flip').length);
check('VP rules never fire on a boundary day (the flip card carries that)', !R.rows.some(r => /vp_move/.test(r.rule) && series.snapshots.some((s, i) => i > 0 && s.date === r.date && series.snapshots[i - 1].epoch !== s.epoch)));
const half = A.scale({ min_pct: 3, min_vp: 500000, median_days: 28 }, 0.5); check('sensitivity scales min_*/multiple_* only (median_days untouched)', half.min_pct === 1.5 && half.min_vp === 250000 && half.median_days === 28);
console.log('\nlast 12 fired rows:'); for (const r of R.rows.slice(0, 12)) console.log(`  ${r.date} ${r.rule.padEnd(20)} ${r.label}  · ${r.value}`);
console.log(`\nrss ${Math.round(process.memoryUsage().rss / 1048576)} MB\n=== TLA ALERTS CALIBRATION GATE: ${fails ? 'FAIL' : 'PASS'} — ${fails} failed ===`); process.exit(fails ? 1 : 0);
