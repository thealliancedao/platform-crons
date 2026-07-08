#!/usr/bin/env node
// =============================================================================
// mock-run.js — file-based mock run for org-tla-flows (BINDING process rule:
// any cron main-loop change requires this, not just syntax + unit tests).
//
// Drives the REAL run() loop with stubbed transports (T.httpGet /
// T.githubApiRequest monkey-patched) against REAL transactions from the FCD
// archive harvests (tla-core/archive/fcd/lp-*, 55,199 txs from exactly the
// watched contracts). Nothing about the main loop is simulated — only the
// network edges.
//
// Usage:
//   FCD_DIR=/path/to/tla-core/archive/fcd node mock-run.js         # all scenarios
//   FCD_DIR=… node mock-run.js A                                    # one scenario
//
// Scenarios:
//   A  backfill capture of a real window     → counts match direct classification
//   B  incremental follow-up run             → only new events added, dedupe holds
//   C  cursor-held rerun (simulated crash)   → idempotent, no duplicate records
//   D  page-cap                              → status partial, cursor NOT advanced
//   E  409 race on month publish             → retry succeeds
//   F  retention gap                         → known_gaps recorded, cursor advances
//   G  classifier sweep over ALL 55,199 txs  → stats report (flows-fill preview)
// =============================================================================

'use strict';
const fs = require('fs');
const path = require('path');

const FCD_DIR = process.env.FCD_DIR;
if (!FCD_DIR) { console.error('FCD_DIR required (path to tla-core/archive/fcd)'); process.exit(1); }
process.env.GITHUB_TOKEN = process.env.GITHUB_TOKEN || 'mock-token';
process.env.PAGER_PROBE_DELAY = '0'; process.env.PAGER_ERR_BACKOFF = '0'; process.env.PAGER_RETRIES = '20';

const cron = require('./index.js');
const C = require('../config/contracts.js');

// ---------------------------------------------------------------- real data
const LABEL_TO_ADDR = {
  'lp-compounder': C.COMPOUNDER.addr,
  'lp-stable':     C.STAKING_BUCKETS.stable,
  'lp-project':    C.STAKING_BUCKETS.project,
  'lp-bluechip':   C.STAKING_BUCKETS.bluechip,
  'lp-single':     C.STAKING_BUCKETS.single,
  // zapper: not FCD-harvested (zap txs also touch compounder/buckets, so they
  // appear via those harvests); the mock LCD serves it empty — realistic.
};
function loadAll() {
  const byAddr = {};
  for (const [label, addr] of Object.entries(LABEL_TO_ADDR)) {
    const dir = path.join(FCD_DIR, label);
    const state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
    if (state.account !== addr) throw new Error(`ADDRESS DRIFT: harvest ${label} account ${state.account} != config ${addr}`);
    const txs = [];
    // Memory: keep only what the flow classifier + pager touch (txhash, height,
    // timestamp, code, wasm events). Raw parts total >1 GB expanded — messages
    // and non-wasm events are dead weight for THIS classifier and are dropped
    // at load. Fidelity note: classifyFlowTx reads wasm events exclusively.
    for (const p of fs.readdirSync(dir).filter(f => /^part-\d+\.json$/.test(f)).sort()) {
      for (const t of JSON.parse(fs.readFileSync(path.join(dir, p), 'utf8')).txs) {
        txs.push({ txhash: t.txhash, height: t.height, timestamp: t.timestamp, code: t.code || 0,
                   events: (t.events || []).filter(e => e.type === 'wasm') });
      }
    }
    txs.sort((a, b) => a.height - b.height || (a.txhash < b.txhash ? -1 : 1));
    byAddr[addr] = txs;
  }
  return byAddr;
}
const DATA = loadAll();
const ALL_TXS = Object.values(DATA).flat();
console.log(`loaded real dataset: ${ALL_TXS.length} txs across ${Object.keys(DATA).length} contracts (address drift check PASSED)\n`);

// ---------------------------------------------------------------- mock edges
// Mock chain state: the LCD serves only [retentionFloor, head] — like a pruned node.
const M = {
  head: 0, retentionFloor: 0,
  store: {},           // repo path -> content string   (the "committed" tla-core)
  putLog: [],
  fail409: 0,          // fail the next N month PUTs with 409
  failCursorPut: 0,    // fail the next N cursor PUTs hard (crash simulation)
};
function servedTxs(addr) {
  return (DATA[addr] || []).filter(t => t.height >= M.retentionFloor && t.height <= M.head);
}
cron.T.httpGet = async (url) => {
  if (url.includes('/blocks/latest')) return { block: { header: { height: String(M.head) } } };
  if (url.includes('/cosmos/tx/v1beta1/txs?')) {
    const u = new URL(url);
    const q = decodeURIComponent(u.searchParams.get('query'));
    const addr = (q.match(/_contract_address='([^']+)'/) || [])[1];
    const page = Number(u.searchParams.get('page') || 1);
    const limit = Number(u.searchParams.get('limit') || 100);
    const rows = servedTxs(addr).slice((page - 1) * limit, page * limit);
    return { tx_responses: rows };
  }
  if (url.includes('raw.githubusercontent.com')) {
    const m = url.match(/main\/(.+?)(\?|$)/);
    const p = m && m[1];
    if (p && M.store[p] !== undefined) return JSON.parse(M.store[p]);
    throw new Error('HTTP 404 (mock raw)');
  }
  throw new Error('mock httpGet: unhandled ' + url);
};
cron.T.githubApiRequest = async (method, apiPath, body) => {
  const m = apiPath.match(/contents\/(.+?)(\?|$)/);
  const p = m && m[1];
  if (method === 'GET') {
    if (M.store[p] === undefined) { const e = new Error('GitHub GET 404'); e.statusCode = 404; throw e; }
    return { sha: 'sha-' + Buffer.from(M.store[p]).length };
  }
  if (method === 'PUT') {
    if (/\d{4}\/\d{2}\.json$/.test(p) && M.fail409 > 0) { M.fail409--; const e = new Error('GitHub PUT 409 (mock race)'); e.statusCode = 409; throw e; }
    if (p.endsWith('cursor.json') && M.failCursorPut > 0) { M.failCursorPut--; const e = new Error('GitHub PUT 500 (mock crash)'); e.statusCode = 500; throw e; }
    M.store[p] = Buffer.from(body.content, 'base64').toString('utf8');
    M.putLog.push({ p, message: body.message });
    return { content: { path: p } };
  }
  throw new Error('mock githubApiRequest: ' + method + ' ' + apiPath);
};

// ---------------------------------------------------------------- assertions
let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`  ✅ ${name}`);
  else { failures++; console.error(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
}
const monthOf = (p) => JSON.parse(M.store['tla-flows/events/' + p] || '[]');
const cursorOf = () => M.store['tla-flows/events/cursor.json'] ? JSON.parse(M.store['tla-flows/events/cursor.json']) : null;
const indexOf = () => M.store['tla-flows/events/index.json'] ? JSON.parse(M.store['tla-flows/events/index.json']) : null;
const hbOf = () => JSON.parse(M.store['tla-flows/events/heartbeat.json']);
function directClassify(from, to) {
  const seen = new Set(); const out = [];
  for (const t of ALL_TXS) {
    if (t.height < from || t.height > to) continue;
    if (seen.has(t.txhash)) continue; seen.add(t.txhash);
    const r = cron.classifyFlowTx(t); if (r) out.push(r);
  }
  return out;
}

// A real busy window: Sept 2024 (heights ≈ 11,888,000 – 12,310,000)
const W1_FROM = 11888319, W1_MID = 12103862, W1_END = 12310000;

async function scenarioA() {
  console.log('— A: backfill capture of a real window —');
  M.store = {}; M.putLog = [];
  M.head = W1_MID; M.retentionFloor = 0;
  process.env.TLA_START_HEIGHT = String(W1_FROM);
  await cron.run();
  delete process.env.TLA_START_HEIGHT;
  const expect = directClassify(W1_FROM, W1_MID);
  const stored = Object.keys(M.store).filter(k => /\d{4}\/\d{2}\.json$/.test(k)).map(k => monthOf(k.replace('tla-flows/events/', ''))).flat();
  check('captured == direct classification', stored.length === expect.length, `${stored.length} vs ${expect.length}`);
  check('cursor advanced to head', cursorOf() && cursorOf().head_height_at_last_run === W1_MID);
  check('heartbeat ok', hbOf().status === 'ok');
  check('index totals match', indexOf().total_events === expect.length);
  const hashes = new Set(stored.map(r => r.txhash));
  check('no duplicate txhashes', hashes.size === stored.length);
  return expect.length;
}
async function scenarioB(prevCount) {
  console.log('— B: incremental follow-up —');
  M.head = W1_END;
  await cron.run();
  const expect = directClassify(W1_FROM, W1_END);
  check('incremental added only the delta', indexOf().total_events === expect.length, `${indexOf().total_events} vs ${expect.length}`);
  check('cursor advanced', cursorOf().head_height_at_last_run === W1_END);
  return expect.length;
}
async function scenarioC(total) {
  console.log('— C: cursor-held rerun (crash between month publish and cursor) —');
  M.head = W1_END + 20000;
  M.failCursorPut = 1;                     // month publishes land, cursor "crashes"
  await cron.run();
  check('cursor held at pre-crash height', cursorOf().head_height_at_last_run === W1_END);
  check('heartbeat partial after crash', hbOf().status !== 'ok');
  const afterCrash = indexOf().total_events;
  await cron.run();                        // rerun re-reads the same window
  const expect = directClassify(W1_FROM, W1_END + 20000);
  check('rerun idempotent — no duplicates', indexOf().total_events === expect.length, `${indexOf().total_events} vs ${expect.length} (post-crash ${afterCrash})`);
  check('cursor advanced after clean rerun', cursorOf().head_height_at_last_run === W1_END + 20000);
}
async function scenarioD() {
  console.log('— D: page-cap → partial, cursor NOT advanced —');
  // Fresh child-process world isn't needed: MAX_PAGES is module-const, so we
  // instead widen the served window so one contract exceeds 60 pages (6,000 txs).
  M.store = {}; M.putLog = [];
  M.head = 13736494; M.retentionFloor = 0;              // serve EVERYTHING (lp-project = 14.5k txs)
  process.env.TLA_START_HEIGHT = String(8094215);
  await cron.run().catch(e => console.log('  (run error path: ' + e.message + ')'));
  delete process.env.TLA_START_HEIGHT;
  check('cursor NOT advanced on page-cap', cursorOf() === null);
  check('heartbeat partial', hbOf().status === 'partial');
}
async function scenarioE() {
  console.log('— E: 409 race on month publish → retry succeeds —');
  M.store = {}; M.putLog = [];
  M.head = W1_MID; M.retentionFloor = 0; M.fail409 = 2;
  process.env.TLA_START_HEIGHT = String(W1_FROM);
  await cron.run();
  delete process.env.TLA_START_HEIGHT;
  const expect = directClassify(W1_FROM, W1_MID);
  check('events landed despite 409s', indexOf() && indexOf().total_events === expect.length);
  check('cursor advanced', cursorOf() && cursorOf().head_height_at_last_run === W1_MID);
}
async function scenarioF() {
  console.log('— F: retention gap → recorded honestly, cursor advances —');
  // committed cursor far below what the "pruned node" still serves
  M.store = {
    'tla-flows/events/cursor.json': JSON.stringify({ schemaVersion: 1, head_height_at_last_run: W1_FROM }),
    'tla-flows/events/index.json': JSON.stringify({ schemaVersion: 1, total_events: 5, by_type: { claim: 5 }, months_present: {}, known_gaps: [], first_date: '2024-09-01', latest_date: '2024-09-01', latest_height: W1_FROM }),
  };
  M.putLog = [];
  M.head = 13700000; M.retentionFloor = 13650000;       // node retains only the recent slice
  await cron.run();
  const idx = indexOf();
  check('known_gap recorded', idx.known_gaps.length === 1 && idx.known_gaps[0].from_height === W1_FROM + 1);
  check('heartbeat carries the gap', (hbOf().known_gaps || []).length === 1);
  check('cursor advanced past the gap', cursorOf().head_height_at_last_run === 13700000);
  check('never-shrink: prior totals kept', idx.total_events >= 5);
}
function scenarioG() {
  console.log('— G: classifier sweep over the FULL archive (flows-fill preview) —');
  const seen = new Set(); const by = { deposit: 0, withdraw: 0, claim: 0 }; const mech = {}; let zap = 0, cost = 0, failedSkipped = 0, unclassified = 0;
  for (const t of ALL_TXS) {
    if (seen.has(t.txhash)) continue; seen.add(t.txhash);
    if (Number(t.code || 0) !== 0) { failedSkipped++; continue; }
    const r = cron.classifyFlowTx(t);
    if (!r) { unclassified++; continue; }
    by[r.type] = (by[r.type] || 0) + 1;
    const mk = `${r.type}/${r.mechanism}`; mech[mk] = (mech[mk] || 0) + 1;
    if (r.via_zap) zap++;
    if (r.cost) cost++;
  }
  console.log(`  unique txs: ${seen.size} | failed skipped: ${failedSkipped} | classified: ${by.deposit + by.withdraw + by.claim} | non-flow: ${unclassified}`);
  console.log(`  by type: ${JSON.stringify(by)}`);
  console.log(`  by mechanism: ${JSON.stringify(mech)}`);
  console.log(`  via_zap: ${zap} | with cost receipts: ${cost}`);
  check('classifier produced flows from real archive', by.deposit + by.withdraw + by.claim > 0);
}

(async () => {
  const only = process.argv[2];
  const runIf = (k, fn, ...a) => (!only || only === k) ? fn(...a) : Promise.resolve();
  const n1 = await runIf('A', scenarioA);
  await runIf('B', scenarioB, n1);
  await runIf('C', scenarioC);
  await runIf('D', scenarioD);
  await runIf('E', scenarioE);
  await runIf('F', scenarioF);
  await runIf('G', () => Promise.resolve(scenarioG()));
  console.log(failures ? `\n❌ ${failures} check(s) FAILED` : '\n✅ ALL CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})();
