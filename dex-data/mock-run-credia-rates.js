#!/usr/bin/env node
// dex-data 1.3.2 mock gate — Credia rate-history sidecar on the REAL indexer responses
// (fixtures/credia-rates-2026-08-26.json, from the owner's HAR): merge law, never-shrink,
// prior-verbatim, 7-day ranges, isolation on a failed read.
const CR = require('./lib/credia-rates');
const FIX = require('./fixtures/credia-rates-2026-08-26.json').responses;
let PASS = 0, FAIL = 0; const check = (n, ok, x) => { if (ok) { PASS++; console.log('  ✓ ' + n); } else { FAIL++; console.log('  ✗ ' + n + (x !== undefined ? ' — ' + JSON.stringify(x).slice(0, 220) : '')); } };
const NOW = new Date('2026-08-26T19:30:00Z');
const REPO = {}; let calls = 0;
const httpRequest = async (url, opts) => { calls++; const v = JSON.parse(opts.body).variables; const pts = FIX[v.market]; if (!pts) throw new Error('HTTP 400 unknown market'); return { status: 200, body: JSON.stringify({ data: { historyGranularity: pts } }) }; };
const readJson = async (p) => (p in REPO ? JSON.parse(JSON.stringify(REPO[p])) : null);
const writeJson = async (p, o) => { REPO[p] = o; };
(async () => {
  console.log('dex-data credia-rates mock gate');
  const markets = ['uluna', 'terra1ecgazyd0waaj3g7l9cmy5gulhxkps2gmxu9ghducvuypjq68mq2s5lvsct', 'ibc/NOT_IN_FIXTURE'];
  const r1 = await CR.runCrediaRates({ markets, httpRequest, readJson, writeJson, now: NOW });
  const aug = REPO['dex-data/credia/rates/2026/08.json'];
  check('R1 first run: 2/3 markets answered (one indexer error recorded), status partial, month file + current written', r1.answered === 2 && r1.status === 'partial' && aug && REPO['dex-data/credia/rates/current.json'], r1);
  check('R2 real series kept verbatim: 188 hourly points per market, sorted, labeled off-chain', aug.markets.uluna.length === 188 && aug.markets.uluna[0].t < aug.markets.uluna[187].t && /OFF-CHAIN/.test(aug.meta.source) && aug.meta.points === 376, aug.meta);
  const cur = REPO['dex-data/credia/rates/current.json'].ranges.uluna;
  const win = FIX.uluna.filter(p => Date.parse(p.created) >= NOW.getTime() - 7 * 86400000); const exMin = Math.min(...win.map(p => p.borrow_apr)), exMax = Math.max(...win.map(p => p.borrow_apr));
  check('R3 7-day range for LUNA = min/max of the real points inside the window (9.0%–14.2%), latest = newest point, utilization range present', Math.abs(cur.borrow_apr.min - exMin) < 1e-12 && Math.abs(cur.borrow_apr.max - exMax) < 1e-12 && cur.borrow_apr.latest === win[win.length - 1].borrow_apr && cur.utilization && cur.points_7d === win.length, cur);
  // second run: same points → nothing added, month file not rewritten, current refreshed
  const before = JSON.stringify(aug); delete REPO['dex-data/credia/rates/current.json'];
  const r2 = await CR.runCrediaRates({ markets, httpRequest, readJson, writeJson, now: NOW });
  check('R4 idempotent: 0 added, 376 kept, month file untouched, current re-published', r2.added === 0 && r2.kept === 376 && JSON.stringify(REPO['dex-data/credia/rates/2026/08.json']) === before && REPO['dex-data/credia/rates/current.json'], [r2.added, r2.kept]);
  // prior-verbatim: mutate the fixture's value for an existing timestamp → existing wins
  const t0 = FIX.uluna[10].created; const orig = FIX.uluna[10].borrow_apr; FIX.uluna[10].borrow_apr = 9.99;
  await CR.runCrediaRates({ markets, httpRequest, readJson, writeJson, now: NOW });
  check('R5 prior-verbatim: a re-served point with a different value does NOT overwrite the committed one', REPO['dex-data/credia/rates/2026/08.json'].markets.uluna.find(p => p.t === t0).borrow_apr === orig);
  FIX.uluna[10].borrow_apr = orig;
  // never-shrink + failed read isolation
  const bad = async (p) => { if (/2026\/08/.test(p)) throw new Error('HTTP 500 read failed'); return readJson(p); };
  const r3 = await CR.runCrediaRates({ markets, httpRequest, readJson: bad, writeJson, now: NOW });
  check('R6 failed read of the month file → merge skipped for that month (recorded), nothing overwritten, current still published', r3.errors.some(e => /read failed/.test(e.error)) && JSON.stringify(REPO['dex-data/credia/rates/2026/08.json']) === before, r3.errors);
  // month boundary: points spanning two months land in two files
  const now2 = new Date('2026-09-02T12:00:00Z'); const shifted = { uluna: FIX.uluna.map(p => ({ ...p, created: new Date(Date.parse(p.created) + 7 * 86400000).toISOString() })) };
  const http2 = async (url, opts) => ({ status: 200, body: JSON.stringify({ data: { historyGranularity: shifted[JSON.parse(opts.body).variables.market] || [] } }) });
  const r4 = await CR.runCrediaRates({ markets: ['uluna'], httpRequest: http2, readJson, writeJson, now: now2 });
  check('R7 window crossing a month boundary writes both month files, grow-only', r4.files.includes('dex-data/credia/rates/2026/08.json') && r4.files.includes('dex-data/credia/rates/2026/09.json') && REPO['dex-data/credia/rates/2026/08.json'].markets.uluna.length > 188, r4.files);
  check('R8 one POST per market per run', calls === 3 * 4);
  console.log(`\n${PASS} passed, ${FAIL} failed`); process.exit(FAIL ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
