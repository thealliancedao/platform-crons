#!/usr/bin/env node
'use strict';
// mock-run-price-history-heartbeat.js — B.5 (2026-09-14): the live appendToPriceHistory + publishPriceHistoryHeartbeat
// with publishFile captured. The month-file read stays real (read-only raw.githubusercontent). No third copy.
const M = require('./token-catalog.js');
let PASS = 0, FAIL = 0; const ok = (n, c, x) => { if (c) { PASS++; console.log('  ✓', n); } else { FAIL++; console.log('  ✗', n, x === undefined ? '' : JSON.stringify(x).slice(0, 300)); } };
const PUB = {}; let failNext = null;
M._test.setPublishFile(async (path, content, msg) => { if (failNext && path.startsWith(failNext)) { const e = new Error('GitHub PUT ' + path + ': 500 simulated'); throw e; } PUB[path] = { doc: JSON.parse(content), msg }; return { ok: true }; });
const catalog = { tokens: [
  { effective: { symbol: 'LUNA' }, discovered: { symbol: 'LUNA' }, prices: { tla: { usd: 0.0453 } }, price_confidence: 'high' },
  { effective: { symbol: 'ASTRO' }, discovered: { symbol: 'ASTRO' }, prices: { astroport: { usd: 0.0021 } } },
  { discovered: { symbol: 'NOPRICE' }, prices: {} },
] };
const day = new Date().toISOString().slice(0, 10); const started = new Date();
(async () => {
  console.log('— R1: append ok → heartbeat ok —');
  let r = await M.appendToPriceHistory(catalog, day);
  ok('append returns ok with 2 tokens (unpriced token skipped)', r && r.status === 'ok' && r.tokens === 2 && r.day === day, r);
  ok('append published the month file', PUB[r.file] && PUB[r.file].doc.days[day].LUNA.usd === 0.0453, Object.keys(PUB));
  ok('month file merged, not replaced (prior days kept)', Object.keys(PUB[r.file].doc.days).length > 1 && PUB[r.file].doc.meta.module === 'price-history');
  await M.publishPriceHistoryHeartbeat(r, started);
  let hb = PUB['price-history/heartbeat.json'] && PUB['price-history/heartbeat.json'].doc;
  ok('heartbeat written: status ok, capturedAt, day, tokens_appended 2, month_file', hb && hb.status === 'ok' && hb.capturedAt && hb.day === day && hb.tokens_appended === 2 && hb.month_file === r.file && hb.product === 'price-history', hb);
  ok('heartbeat commit message names the status', /heartbeat ok/.test(PUB['price-history/heartbeat.json'].msg));

  console.log('— R2: append failure is swallowed AND reported —');
  delete PUB['price-history/heartbeat.json']; failNext = 'price-history/2';
  r = await M.appendToPriceHistory(catalog, day);
  ok('append failure swallowed (no throw), result failed + reason', r.status === 'failed' && /500 simulated/.test(r.reason) && r.file === null, r);
  failNext = null; await M.publishPriceHistoryHeartbeat(r, started);
  hb = PUB['price-history/heartbeat.json'].doc;
  ok('heartbeat status failed with the reason (system-health 1.0.7 raises this)', hb.status === 'failed' && /500 simulated/.test(hb.reason) && hb.tokens_appended === 0, hb);

  console.log('— R3: nothing priced → failed, not a silent return —');
  r = await M.appendToPriceHistory({ tokens: [{ discovered: { symbol: 'X' }, prices: {} }] }, day);
  ok('no priced tokens → status failed, reason says so', r.status === 'failed' && /no priced tokens/.test(r.reason), r);

  console.log('— R4: heartbeat publish failure never throws —');
  failNext = 'price-history/heartbeat.json'; let threw = false;
  try { await M.publishPriceHistoryHeartbeat({ status: 'ok', reason: null, day, tokens: 2, file: 'x' }, started); } catch { threw = true; }
  ok('heartbeat write failure is swallowed', !threw);
  console.log(`\n=== MOCK GATE price-history heartbeat: ${PASS} passed, ${FAIL} failed ===`); process.exit(FAIL ? 1 : 0);
})();
