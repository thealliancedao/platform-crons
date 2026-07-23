#!/usr/bin/env node
// =============================================================================
// mock-run.js — file-based mock run for org-tla-flows Rev C (block-walker).
// BINDING process rule: any main-loop change requires this suite to pass.
//
// Drives the REAL run() loop with stubbed transports against:
//  • the REAL RPC probe block 21,823,668 (captured live 2026-07-08) — verbatim
//  • synthetic blocks built from REAL FCD LP transactions grouped by height
//    (events are the real chain events; raw tx bytes are deterministic stand-ins,
//    so walker-computed hashes are internally consistent but not chain hashes)
//
// Usage: FCD_DIR=/path/to/tla-core/archive/fcd node mock-run.js [scenario]
// Scenarios: R real-block fixture · A capture==direct · B incremental ·
//   C crash-rewind idempotency · D block budget / catch-up · F pruned gap ·
//   G watched-contract gate · N noise & call-efficiency
// =============================================================================
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FCD_DIR = process.env.FCD_DIR;
if (!FCD_DIR) { console.error('FCD_DIR required'); process.exit(1); }
process.env.GITHUB_TOKEN = process.env.GITHUB_TOKEN || 'mock-token';

const cron = require('./index.js');
const C = require('../config/contracts.js');

// ---------------------------------------------------------------- real FCD data → synthetic chain
const LABELS = { 'lp-compounder': C.COMPOUNDER.addr, 'lp-stable': C.STAKING_BUCKETS.stable,
  'lp-project': C.STAKING_BUCKETS.project, 'lp-bluechip': C.STAKING_BUCKETS.bluechip, 'lp-single': C.STAKING_BUCKETS.single };
const CHAIN = new Map();   // height -> [{fakeB64, code, events, realHash, ts}]
{
  const seen = new Set();
  for (const [label, addr] of Object.entries(LABELS)) {
    const dir = path.join(FCD_DIR, label);
    const state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
    if (state.account !== addr) throw new Error(`ADDRESS DRIFT: ${label} ${state.account} != config ${addr}`);
    for (const p of fs.readdirSync(dir).filter(f => /^part-\d+\.json$/.test(f)).sort()) {
      for (const t of JSON.parse(fs.readFileSync(path.join(dir, p), 'utf8')).txs) {
        if (seen.has(t.txhash)) continue; seen.add(t.txhash);
        const entry = { fakeB64: Buffer.from(t.txhash).toString('base64'), code: t.code || 0,
          events: (t.events || []).filter(e => e.type === 'wasm'), realHash: t.txhash, ts: t.timestamp };
        if (!CHAIN.has(t.height)) CHAIN.set(t.height, []);
        CHAIN.get(t.height).push(entry);
      }
    }
  }
  console.log(`synthetic chain built from ${seen.size} real txs across ${CHAIN.size} heights (address drift check PASSED)\n`);
}

// ---------------------------------------------------------------- the REAL probe block (2026-07-08, verbatim shapes)
const PROBE_H = 21823668;
const PROBE_B64 = "CokFCt8CCiQvY29zbXdhc20ud2FzbS52MS5Nc2dFeGVjdXRlQ29udHJhY3QStgIKLHRlcnJhMWt2djIyOXB5cHZlNWxyNnZlN3FjYW1jc2NqMHlsbnRodG5nbmsyEkB0ZXJyYTF6bHk5OGd2Y2VjNTRtM2NheGxxZXhjZTdydXM2cnpncGx6N2VrZXRzZHo3bmg3NTBoMnJxdnU4dXp4Glx7InVuc3Rha2UiOnsicmVjaXBpZW50IjoidGVycmExcWRqc3hzdjk2YWFncmR4ejgzZ3d0ams4cXZmMm1yZzR5OHkzZHFqeGc1NTZsbTc5cGc1cWRnbWF4bCJ9fSpmClhmYWN0b3J5L3RlcnJhMXpseTk4Z3ZjZWM1NG0zY2F4bHFleGNlN3J1czZyemdwbHo3ZWtldHNkejduaDc1MGgycnF2dTh1engvNC9wcm9qZWN0L2FtcGxwEgoxMzIzMjYwNDgwCo4CCiQvY29zbXdhc20ud2FzbS52MS5Nc2dFeGVjdXRlQ29udHJhY3QS5QEKLHRlcnJhMWt2djIyOXB5cHZlNWxyNnZlN3FjYW1jc2NqMHlsbnRodG5nbmsyEkB0ZXJyYTFxZGpzeHN2OTZhYWdyZHh6ODNnd3RqazhxdmYybXJnNHk4eTNkcWp4ZzU1NmxtNzlwZzVxZGdtYXhsGnN7IndpdGhkcmF3X2xwIjp7InN0YWdlIjp7ImFzdHJvcG9ydCI6eyJwYWlyIjoidGVycmExbndlcGV6bTNtZ2h5eG03ZmpmaGZyMmQ0andxem5kdG5jZjl0Y2xndW5xZmN3aGU1Mm1wcTRzeGFxciJ9fX19EhR3d3cuZXJpc3Byb3RvY29sLmNvbRJoClAKRgofL2Nvc21vcy5jcnlwdG8uc2VjcDI1NmsxLlB1YktleRIjCiEDGTGxKvJLJyNCUEH4gvkhBW2wF03ld6eHQdWmZK2OlyMSBAoCCH8YDBIUCg4KBXVsdW5hEgUzMDEwNxCa8FsaQB0SR+rDhU2mpiWgMvD8EnO2tBMsG0vFy47LNZJFO83KZDTUkoVDXoeIYXKIT96HHThFcatMxJUY7tRF55ZnnDk=";
const PROBE_HASH = "2334BA2BB22590AD55122090D58CA85D8B16341B691860CEF33180DC761F26AE";
const PROBE_EVENTS = [
 {type:"coin_spent",attributes:[{key:"spender",value:"terra1kvv229pypve5lr6ve7qcamcscj0ylnthtngnk2"},{key:"amount",value:"30107uluna"}]},
 {type:"wasm",attributes:[{key:"_contract_address",value:C.COMPOUNDER.addr},{key:"action",value:"asset-compounding/unstake"},{key:"user",value:"terra1kvv229pypve5lr6ve7qcamcscj0ylnthtngnk2"},{key:"recipient",value:C.ZAPPER.addr},{key:"returned",value:"cw20:terra14lul8rjcad0jeuu680n4q7dwgxjkr6mqzx8umyewj8c6xn93squqllleht:5105483074"}]},
 {type:"wasm",attributes:[{key:"_contract_address",value:C.STAKING_BUCKETS.project},{key:"action",value:"asset/unstake"},{key:"amount",value:"5105483073"},{key:"share",value:"6149715367"},{key:"user",value:C.COMPOUNDER.addr}]},
 {type:"wasm",attributes:[{key:"_contract_address",value:C.ZAPPER.addr},{key:"action",value:"zapper/withdraw_lp"}]},
 {type:"wasm",attributes:[{key:"_contract_address",value:"terra1nwepezm3mghyxm7fjfhfr2d4jwqzndtncf9tclgunqfcwhe52mpq4sxaqr"},{key:"action",value:"withdraw_liquidity"},{key:"refund_assets",value:"67815944468ibc/8D8A…, 441992532uluna"}]},
];

// ---------------------------------------------------------------- mock chain-state + transports
const M = { head: 0, prunedBelow: 0, store: {}, calls: { block: 0, results: 0 }, failCursorPut: 0, probeInWindow: false };
function blockAt(N) {
  if (N < M.prunedBelow) return { error: { message: `height ${N} is not available, lowest height is ${M.prunedBelow}` } };
  if (M.probeInWindow && N === PROBE_H) return { result: { block: { header: { time: '2026-07-08T22:32:28.566757743Z' }, data: { txs: [PROBE_B64] } } } };
  const txs = CHAIN.get(N) || [];
  const time = txs.length ? txs[0].ts : '2024-09-15T00:00:00Z';
  return { result: { block: { header: { time: time.replace('Z', '.000000000Z') }, data: { txs: txs.map(t => t.fakeB64) } } } };
}
function resultsAt(N) {
  if (M.probeInWindow && N === PROBE_H) return { result: { txs_results: [{ code: 0, events: PROBE_EVENTS }], finalize_block_events: [{ type: 'rewards', attributes: [] }] } };
  const txs = CHAIN.get(N) || [];
  return { result: { txs_results: txs.map(t => ({ code: t.code, events: t.events })) } };
}
cron.T.httpGet = async (url) => {
  if (url.includes('/status')) return { result: { sync_info: { latest_block_height: String(M.head) } } };
  if (url.includes('/block_results?height=')) { M.calls.results++; const N = Number(url.split('height=')[1]); const r = resultsAt(N); if (r.error) throw new Error(r.error.message); return r; }
  if (url.includes('/block?height=')) { M.calls.block++; const N = Number(url.split('height=')[1]); const r = blockAt(N); if (r.error) throw new Error(r.error.message); return r; }
  if (url.includes('raw.githubusercontent.com')) {
    const p = (url.match(/main\/(.+?)(\?|$)/) || [])[1];
    if (p && M.store[p] !== undefined) return JSON.parse(M.store[p]);
    throw new Error('HTTP 404 (mock raw)');
  }
  throw new Error('mock httpGet: unhandled ' + url);
};
cron.T.githubApiRequest = async (method, apiPath, body, accept) => {
  const p = (apiPath.match(/contents\/(.+?)(\?|$)/) || [])[1];
  if (method === 'GET') { if (M.store[p] === undefined) { const e = new Error('404'); e.statusCode = 404; throw e; }
    if (accept === 'application/vnd.github.raw') return JSON.parse(M.store[p]);
    return { sha: 's' + M.store[p].length, content: Buffer.from(M.store[p]).toString('base64') }; }
  if (method === 'PUT') {
    if (p.endsWith('cursor.json') && M.failCursorPut > 0) { M.failCursorPut--; const e = new Error('mock 500'); e.statusCode = 500; throw e; }
    M.store[p] = Buffer.from(body.content, 'base64').toString('utf8'); return { ok: 1 };
  }
  throw new Error('mock gh: ' + method);
};

// ---------------------------------------------------------------- helpers
let failures = 0;
const check = (n, c, d) => c ? console.log(`  ✅ ${n}`) : (failures++, console.error(`  ❌ ${n}${d ? ' — ' + d : ''}`));
const idx = () => M.store['tla-flows/events/index.json'] ? JSON.parse(M.store['tla-flows/events/index.json']) : null;
const cur = () => M.store['tla-flows/events/cursor.json'] ? JSON.parse(M.store['tla-flows/events/cursor.json']) : null;
const hb = () => JSON.parse(M.store['tla-flows/events/heartbeat.json']);
const allEvents = () => Object.keys(M.store).filter(k => /\d{4}\/\d{2}\.json$/.test(k)).flatMap(k => JSON.parse(M.store[k]));
function direct(from, to) {
  const out = [];
  for (const [h, txs] of CHAIN) { if (h < from || h > to) continue;
    for (const t of txs) { if (!cron.touchesWatched(t.events)) continue;
      const r = cron.classifyFlowTx({ txhash: t.realHash, height: h, timestamp: t.ts, code: t.code, events: t.events }); if (r) out.push(r); } }
  return out;
}
const fresh = () => { M.store = {}; M.calls = { block: 0, results: 0 }; M.prunedBelow = 0; M.probeInWindow = false; M.failCursorPut = 0; };
const env = (o) => { for (const k in o) o[k] == null ? delete process.env[k] : process.env[k] = String(o[k]); };

// Dense real window (~4k blocks around Sept 2024 with genuine LP activity)
const W_FROM = 11888319, W_MID = 11892319, W_END = 11896319;

// ---------------------------------------------------------------- scenarios
async function R() {
  console.log('— R: the REAL probe block, verbatim —');
  fresh(); M.probeInWindow = true; M.head = PROBE_H + 2;
  env({ TLA_START_HEIGHT: PROBE_H - 2, MAX_BLOCKS_PER_RUN: 100 });
  await cron.run(); env({ TLA_START_HEIGHT: null });
  const evs = allEvents();
  check('exactly one record', evs.length === 1, String(evs.length));
  const r = evs[0] || {};
  check('txhash = chain-verified SHA256', r.txhash === PROBE_HASH, r.txhash);
  check('classified withdraw/amplified via_zap', r.type === 'withdraw' && r.mechanism === 'amplified' && r.via_zap === true);
  check('timestamp from block header', r.timestamp === '2026-07-08T22:32:28Z', r.timestamp);
  check('cursor advanced to head', cur().last_block === PROBE_H + 2);
}
async function A() {
  console.log('— A: capture == direct classification (real events) —');
  fresh(); M.head = W_MID;
  env({ TLA_START_HEIGHT: W_FROM, MAX_BLOCKS_PER_RUN: 10000 });
  await cron.run(); env({ TLA_START_HEIGHT: null });
  const expect = direct(W_FROM, W_MID), got = allEvents();
  check('counts match', got.length === expect.length, `${got.length} vs ${expect.length}`);
  check('no duplicate hashes', new Set(got.map(r => r.txhash)).size === got.length);
  check('heartbeat ok, mode bootstrap', hb().status === 'ok' && hb().runMode === 'bootstrap');
}
async function B() {
  console.log('— B: incremental —');
  M.head = W_END; env({ MAX_BLOCKS_PER_RUN: 10000 });
  await cron.run();
  const expect = direct(W_FROM, W_END);
  check('delta only', idx().total_events === expect.length, `${idx().total_events} vs ${expect.length}`);
  check('cursor at head', cur().last_block === W_END);
}
async function Cx() {
  console.log('— C: crash-rewind idempotency —');
  M.head = W_END + 2000; M.failCursorPut = 1; env({ MAX_BLOCKS_PER_RUN: 10000 });
  await cron.run();
  check('cursor held', cur().last_block === W_END);
  check('heartbeat partial', hb().status === 'partial');
  await cron.run();
  const expect = direct(W_FROM, W_END + 2000);
  check('rerun idempotent', idx().total_events === expect.length, `${idx().total_events} vs ${expect.length}`);
  check('cursor advanced', cur().last_block === W_END + 2000);
}
async function D() {
  console.log('— D: block budget / catch-up —');
  fresh(); M.head = W_FROM + 6000;
  env({ TLA_START_HEIGHT: W_FROM, MAX_BLOCKS_PER_RUN: 2000 });
  await cron.run(); env({ TLA_START_HEIGHT: null });
  check('cursor at budget edge', cur().last_block === W_FROM + 1999, String(cur().last_block));
  check('mode catch-up + note', hb().runMode === 'catch-up' && /catching-up/.test(hb().note || ''));
  await cron.run(); await cron.run(); await cron.run();
  check('caught up to head', cur().last_block === W_FROM + 6000);
  const expect = direct(W_FROM, W_FROM + 6000);
  check('nothing lost across budget splits', idx().total_events === expect.length, `${idx().total_events} vs ${expect.length}`);
}
async function F() {
  console.log('— F: pruned blocks → exact gap, cursor jumps —');
  fresh(); M.head = W_FROM + 3000; M.prunedBelow = W_FROM + 1000;
  M.store['tla-flows/events/cursor.json'] = JSON.stringify({ schemaVersion: 2, last_block: W_FROM - 1 });
  M.store['tla-flows/events/index.json'] = JSON.stringify({ schemaVersion: 2, total_events: 0, by_type: {}, months_present: {}, known_gaps: [] });
  env({ MAX_BLOCKS_PER_RUN: 10000 });
  await cron.run();
  const g = (idx().known_gaps || [])[0];
  check('gap has exact bounds', g && g.from_height === W_FROM && g.to_height === W_FROM + 999, JSON.stringify(g));
  check('cursor advanced past gap', cur().last_block === W_FROM + 3000);
  check('heartbeat carries gap', (hb().known_gaps || []).length === 1);
}
async function G() {
  console.log('— G: watched-contract gate —');
  const foreign = { txhash: 'X', height: 1, timestamp: '2026-01-01T00:00:00Z', code: 0,
    events: [{ type: 'wasm', attributes: [{ key: '_contract_address', value: 'terra1someotherprotocolxxxxxxxxxxxxxxxxxxxxxxx' }, { key: 'action', value: 'claim_rewards' }, { key: 'user', value: 'terra1abc' }] }] };
  check('foreign claim does NOT classify (gate)', !cron.touchesWatched(foreign.events));
  // v2 tightened claim detection to WATCHED contracts — assert defense in depth
  check('classifier v2 ALSO rejects foreign claims (defense in depth)', cron.classifyFlowTx(foreign) === null);
}
async function N() {
  console.log('— N: noise & call-efficiency —');
  fresh(); M.head = 5000_100;   // a window with zero CHAIN entries → all empty blocks
  env({ TLA_START_HEIGHT: 5000_001, MAX_BLOCKS_PER_RUN: 10000 });
  await cron.run(); env({ TLA_START_HEIGHT: null });
  check('empty blocks skip /block_results', M.calls.results === 0, String(M.calls.results));
  check('zero records from empty chain', allEvents().length === 0);
  check('cursor still advances', cur().last_block === 5000_100);
}

(async () => {
  const only = process.argv[2];
  const S = { R, A, B, C: Cx, D, F, G, N };
  for (const k of ['R', 'A', 'B', 'C', 'D', 'F', 'G', 'N']) if (!only || only === k) await S[k]();
  console.log(failures ? `\n❌ ${failures} check(s) FAILED` : '\n✅ ALL CHECKS PASSED');
  process.exit(failures ? 1 : 0);
})();
