// gate-nft-aux.mjs — BINDING gate for v3.3 (NFT_AUX_REPO / NFT_AUX_ROOT).
// Drives the REAL run() with stubbed transports over a 3-block synthetic chain holding ONE aDAO transfer_nft tx,
// a capture-registry that watches the aDAO NFT contract, and no priors. Records every GitHub read/write with the
// repo it was addressed to. Runs the harness against a LIVE checkout and this PATCHED one:
//   R1 default env  — patched == live: identical (repo, path) sets for every read and write (the change is a no-op)
//   R2 flipped env  — the NFT month file is read from and written to nft-collections under adao/transfers/;
//                     everything else (events, cursor, index, heartbeat, other aux streams) still goes to tla-core
// Usage: node gate-nft-aux.mjs <live-tla-flows-dir> <patched-tla-flows-dir>
import { spawnSync } from 'node:child_process';
const [LIVE, PATCHED] = process.argv.slice(2);
let pass = 0, fail = 0; const ck = (n, c, x) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (x ? ' — ' + JSON.stringify(x).slice(0, 400) : '')); } };
const HARNESS = String.raw`
'use strict';
const path = require('path'); const DIR = process.env.HARNESS_DIR; const cron = require(path.resolve(DIR, 'index.js'));
const NFT = 'terra1phr9fngjv7a8an4dhmhd0u0f98wazxfnzccqtyheq4zqrrp4fpuqw3apw9';
const H0 = 22800000; const TS = '2026-09-12T20:00:00Z';
const TX = { hash: 'AA11'.repeat(16), code: 0, events: [{ type: 'wasm', attributes: [
  { key: '_contract_address', value: NFT }, { key: 'action', value: 'transfer_nft' }, { key: 'sender', value: 'terra1sender' }, { key: 'recipient', value: 'terra1recipient' }, { key: 'token_id', value: '4242' } ] }] };
const REG = { contracts: [{ address: NFT, label: 'ADAO NFT collection', streams: ['nft_transfers'] }] };
const store = { 'tla-voting/capture-registry.json': JSON.stringify(REG) };
const hits = { reads: [], writes: [] };
cron.T.httpGet = async (url) => {
  if (url.includes('/status')) return { result: { sync_info: { latest_block_height: String(H0 + 2) } } };
  if (url.includes('/block_results?height=')) { const N = Number(url.split('height=')[1]); return { result: { txs_results: N === H0 + 1 ? [{ code: 0, events: TX.events }] : [] } }; }
  if (url.includes('/block?height=')) { const N = Number(url.split('height=')[1]); return { result: { block: { header: { time: TS.replace('Z', '.000000000Z') }, data: { txs: N === H0 + 1 ? [Buffer.from(TX.hash).toString('base64')] : [] } } } }; }
  if (url.includes('raw.githubusercontent.com')) { const p = (url.match(/main\/(.+?)(\?|$)/) || [])[1]; if (store[p] !== undefined) return JSON.parse(store[p]); throw new Error('HTTP 404 (mock raw)'); }
  throw new Error('unhandled ' + url);
};
cron.T.githubApiRequest = async (method, apiPath, body, accept) => {
  const repo = (apiPath.match(/^\/repos\/([^/]+\/[^/]+)\//) || [])[1]; const p = (apiPath.match(/contents\/(.+?)(\?|$)/) || [])[1];
  if (method === 'GET') { hits.reads.push(repo + ' ' + p); if (store[p] === undefined) { const e = new Error('404'); e.statusCode = 404; throw e; }
    if (accept && accept.startsWith('application/vnd.github.raw')) return JSON.parse(store[p]); return { sha: 's' + store[p].length }; }
  if (method === 'PUT') { hits.writes.push(repo + ' ' + p); store[p] = Buffer.from(body.content, 'base64').toString('utf8'); return { ok: 1 }; }
  throw new Error('mock gh: ' + method);
};
cron.T.now = () => new Date('2026-09-12T20:05:00Z');
process.env.TLA_START_HEIGHT = String(H0); process.env.MAX_BLOCKS_PER_RUN = '10'; process.env.GITHUB_TOKEN = 'x';
(async () => { try { await cron.run(); } catch (e) { hits.error = e.message; }
  const nftKey = Object.keys(store).find(k => /transfers\/2026\/09\.json$/.test(k)); hits.nftFile = nftKey || null; hits.nftRecords = nftKey ? JSON.parse(store[nftKey]).length : 0;
  hits.reads = [...new Set(hits.reads)].sort(); hits.writes = [...new Set(hits.writes)].sort();
  console.log('@@' + JSON.stringify(hits)); })();
`;
const drive = (dir, env) => { const r = spawnSync('node', ['-e', HARNESS], { env: { PATH: process.env.PATH, HARNESS_DIR: dir, GITHUB_TOKEN: 'x', ...env }, encoding: 'utf8', timeout: 60000 }); const line = (r.stdout + r.stderr).split('\n').find(l => l.startsWith('@@')); if (!line) return { error: (r.stdout + r.stderr).slice(-600), reads: [], writes: [] }; return JSON.parse(line.slice(2)); };
console.log('— R1 default env: patched == live —');
const a = drive(LIVE, {}), b = drive(PATCHED, {});
ck('live harness ran to the NFT publish', a.nftFile === 'nfts/adao/transfers/2026/09.json' && a.nftRecords === 1, a);
ck('patched reads == live reads', JSON.stringify(a.reads) === JSON.stringify(b.reads), { live: a.reads, patched: b.reads });
ck('patched writes == live writes', JSON.stringify(a.writes) === JSON.stringify(b.writes), { live: a.writes, patched: b.writes });
ck('every default-env read/write is tla-core', [...b.reads, ...b.writes].every(x => x.startsWith('thealliancedao/tla-core ')), b);
console.log('— R2 flipped: NFT_AUX_REPO=nft-collections · NFT_AUX_ROOT=adao/transfers —');
const c = drive(PATCHED, { NFT_AUX_REPO: 'thealliancedao/nft-collections', NFT_AUX_ROOT: '/adao/transfers/' });
ck('NFT month file written under adao/transfers/ with the record', c.nftFile === 'adao/transfers/2026/09.json' && c.nftRecords === 1, c);
ck('NFT month read AND write addressed to nft-collections', c.reads.includes('thealliancedao/nft-collections adao/transfers/2026/09.json') && c.writes.includes('thealliancedao/nft-collections adao/transfers/2026/09.json'), { reads: c.reads, writes: c.writes });
ck('nothing under nfts/adao touched', [...c.reads, ...c.writes].every(x => !x.includes('nfts/adao')), c);
ck('the ONLY nft-collections traffic is the NFT stream', [...c.reads, ...c.writes].filter(x => x.startsWith('thealliancedao/nft-collections ')).every(x => x.endsWith(' adao/transfers/2026/09.json')), c);
ck('events + cursor + index + heartbeat still written to tla-core', ['tla-flows/events/cursor.json', 'tla-flows/events/heartbeat.json'].every(p => c.writes.includes('thealliancedao/tla-core ' + p)), c.writes);
ck('core traffic identical to default env apart from the NFT stream', JSON.stringify(b.writes.filter(x => !x.includes('transfers/2026'))) === JSON.stringify(c.writes.filter(x => !x.includes('transfers/2026'))), { b: b.writes, c: c.writes });
console.log(`\n=== NFT-AUX GATE: ${pass} passed, ${fail} failed ===`); process.exit(fail ? 1 : 0);
