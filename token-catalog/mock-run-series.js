#!/usr/bin/env node
// mock-run-series.js — gate for Rev 1.9.0: price-history/series/<SYMBOL>.json derived from the REAL month files.
// Usage: TLA_CORE_DIR=<tla-core> node --max-old-space-size=200 mock-run-series.js
'use strict';
const fs = require('fs'), path = require('path');
const CORE = process.env.TLA_CORE_DIR; if (!CORE) { console.error('TLA_CORE_DIR required'); process.exit(1); }
process.env.GITHUB_TOKEN = process.env.GITHUB_TOKEN || 'x';
const TC = require('./token-catalog.js');
let fails = 0; const check = (n, ok, d) => { console.log(`${ok ? '✓' : '✗'} ${n}${d !== undefined ? ' — ' + JSON.stringify(d).slice(0, 200) : ''}`); if (!ok) fails++; };
const store = {};   // published files
TC._test.setPublishFile(async (p, content) => { store[p] = JSON.parse(content); });
TC._test.setSeriesFetchJson(async (url) => { const m = /price-history\/(series\/[^?]+|\d{4}\/\d{2})\.json/.exec(url); if (!m) throw new Error('unstubbed ' + url);
  if (m[1].startsWith('series/')) { const p = 'price-history/' + m[1] + '.json'; if (store[p]) return store[p]; throw new Error('404'); }
  const f = path.join(CORE, 'price-history', m[1] + '.json'); if (!fs.existsSync(f)) throw new Error('404'); return JSON.parse(fs.readFileSync(f)); });
(async () => {
  const months = fs.readdirSync(path.join(CORE, 'price-history')).filter(y => /^\d{4}$/.test(y)).sort().flatMap(y => fs.readdirSync(path.join(CORE, 'price-history', y)).filter(f => /^\d{2}\.json$/.test(f)).sort().map(f => y + '/' + f.slice(0, 2)));
  const lastMk = months[months.length - 1]; const lastDoc = JSON.parse(fs.readFileSync(path.join(CORE, 'price-history', lastMk + '.json'))); const lastDay = Object.keys(lastDoc.days).sort().pop();
  // expected: every (day, symbol) across every month file
  const expect = {}; for (const mk of months) { const d = JSON.parse(fs.readFileSync(path.join(CORE, 'price-history', mk + '.json'))); for (const [day, row] of Object.entries(d.days || {})) for (const [sym, c] of Object.entries(row)) if (c && c.usd != null) (expect[sym] = expect[sym] || {})[day] = Number(c.usd); }
  console.log(`oracle: ${months.length} month files, last day ${lastDay}, ${Object.keys(expect).length} symbols`);
  const r1 = await TC.maintainPriceSeries(null, lastDay, lastDoc);
  const syms = Object.keys(lastDoc.days[lastDay]);
  check(`first run seeds one series per symbol priced on ${lastDay} (${syms.length}) from every month file`, r1.seeded === syms.length && r1.appended === 0 && r1.failed === 0, r1);
  const L = store['price-history/series/LUNA.json'], B = store['price-history/series/bLUNA.json'];
  check('LUNA series = every LUNA day in every month file (count and values identical), sorted ascending', L && Object.keys(L.daily).length === Object.keys(expect.LUNA).length && Object.keys(L.daily).every((d, i, a) => (i === 0 || a[i - 1] < d) && L.daily[d] === expect.LUNA[d]), L && [Object.keys(L.daily).length, Object.keys(expect.LUNA).length, Object.keys(L.daily)[0]]);
  check('bLUNA series covers the CoinGecko hole (2024-05 → 2025-08 present) with the oracle\'s src carried per day', B && ['2024-10-18', '2025-03-15', '2025-06-01'].every(d => B.daily[d] != null && /ratio/.test(B.src[d] || '')), B && ['2024-10-18', '2025-03-15'].map(d => [B.daily[d], B.src[d]]));
  check('every series says what it is (symbol, unit, source names the oracle) and is a single sorted daily map', syms.every(s => { const d = store[`price-history/series/${encodeURIComponent(s)}.json`]; return d && d.symbol === s && d.unit === 'usd' && /price-history/.test(d.source) && d.count === Object.keys(d.daily).length; }));
  const r2 = await TC.maintainPriceSeries(null, lastDay, lastDoc);
  check('second run with the same day: nothing seeded, nothing appended, all unchanged (no churn)', r2.seeded === 0 && r2.appended === 0 && r2.unchanged === syms.length, r2);
  const nextDay = new Date(Date.parse(lastDay + 'T00:00:00Z') + 864e5).toISOString().slice(0, 10); const nd = { days: { [nextDay]: Object.fromEntries(syms.map(s => [s, { usd: lastDoc.days[lastDay][s].usd * 1.01, src: 'coingecko' }])) } };
  const r3 = await TC.maintainPriceSeries(null, nextDay, nd);
  check('a new day appends to every existing series (read → add → write), values from the month row', r3.appended === syms.length && r3.seeded === 0 && Math.abs(store['price-history/series/LUNA.json'].daily[nextDay] - lastDoc.days[lastDay].LUNA.usd * 1.01) < 1e-12, r3);
  console.log(`\nrss ${Math.round(process.memoryUsage().rss / 1048576)} MB\n=== PRICE SERIES GATE (1.9.0): ${fails ? 'FAIL' : 'PASS'} — ${fails} failed ===`); process.exit(fails ? 1 : 0);
})().catch(e => { console.error('gate crashed:', e); process.exit(1); });
