'use strict';
// mock-run.js — org-nft-flows against a fake RPC + fake GitHub. Proves: cursor bootstrap from ledger coverage, watch-set
// match, raw-before-ledger, merge by recordKey (no duplicates on a second run), index coverage, cursor written last.
const http = require('http'); const zlib = require('zlib'); const { spawn } = require('child_process'); const fs = require('fs'); const path = require('path');
const PL = 'terra17z7fpaa8kah698xn5tarrcucvualdy4wsztkfc404g3garucpu6qmxp50g', PLV = 'terra127dehd2d6t7ynnezkxkre2w83ze0t7lmghpu6vn4y5mfmwfj5x9qqdh4sz', BBL = 'terra1ej4cv98e9g2zjefr5auf2nwtq4xl3dm7x0qml58yna2ml2hk595s7gccs9';
const reg = JSON.parse(fs.readFileSync(process.env.REGISTRY || path.join(__dirname, '../../../tla-core/docs/curated/nft-collections.json'), 'utf8'));
const files = {}; // fake tla-core
const put = (p, obj) => { files[p] = p.endsWith('.gz') ? zlib.gzipSync(Buffer.from(JSON.stringify(obj))) : Buffer.from(JSON.stringify(obj)); };
put('docs/curated/nft-collections.json', reg);
put('nfts/adao/snapshots/luna-usd-daily.json', { daily: { '2026-09-13': 0.05 } });
put('nfts/pixel/ledger/index.json', { collection: 'pixel', total: 0, by_kind: {}, months: [], coverage: [{ source: 'nfts/raw/pixel:1-1000', from: 1, to: 1000 }], known_gaps: [] });
put('nfts/adao/ledger/index.json', { collection: 'adao', total: 0, by_kind: {}, months: [], coverage: [{ source: 'tla-flows/raw:1-1200', from: 1, to: 1200 }], known_gaps: [] });
put('nfts/tla-locks/ledger/index.json', { collection: 'tla-locks', total: 0, by_kind: {}, months: [], coverage: [{ source: 'tla-flows/raw:1-1200', from: 1, to: 1200 }], known_gaps: [] });
const ev = (c, o) => ({ type: 'wasm', attributes: Object.entries(Object.assign({ _contract_address: c }, o)).map(([k, v]) => ({ key: k, value: String(v) })) });
const blocks = {}; const results = {};
blocks[1003] = { txs: ['dHgx'] }; results[1003] = [{ code: 0, events: [ev(PL, { action: 'send_nft', sender: 'terra1me', recipient: PLV, token_id: 42 }), ev(PLV, { action: 'stake', from: 'terra1me', token_id: 42 })] }];
blocks[1007] = { txs: ['dHgy', 'dHgz'] }; results[1007] = [{ code: 0, events: [ev(BBL, { action: 'deposit', amount: 5000000, from: 'terra1w2', token: 'terra1bluna' })] }, { code: 0, events: [ev('terra1unrelated', { action: 'swap' })] }];
const gh = []; const ghs = http.createServer((req, res) => { let b = ''; req.on('data', c => b += c); req.on('end', () => { const m = req.url.match(/\/contents\/([^?]+)/); const p = m && decodeURIComponent(m[1]); gh.push(req.method + ' ' + p);
  if (req.method === 'GET') { if (!files[p]) { res.statusCode = 404; return res.end('{}'); } if ((req.headers.accept || '').includes('raw')) return res.end(files[p]); return res.end(JSON.stringify({ sha: 'sha-' + p, size: files[p].length })); }
  const body = JSON.parse(b); files[p] = Buffer.from(body.content, 'base64'); res.end('{}'); }); });
const rpc = http.createServer((req, res) => { const u = new URL('http://x' + req.url); if (u.pathname === '/status') return res.end(JSON.stringify({ result: { sync_info: { latest_block_height: '1020' } } })); const h = Number(u.searchParams.get('height')); if (u.pathname === '/block') return res.end(JSON.stringify({ result: { block: { header: { time: '2026-09-13T01:00:00Z' }, data: { txs: (blocks[h] || {}).txs || [] } } } })); if (u.pathname === '/block_results') return res.end(JSON.stringify({ result: { txs_results: results[h] || [] } })); res.end('{}'); });
(async () => {
  await new Promise(r => ghs.listen(0, r)); await new Promise(r => rpc.listen(0, r));
  const env = Object.assign({}, process.env, { GITHUB_TOKEN: 'x', GITHUB_API: 'http://127.0.0.1:' + ghs.address().port, RPC_PRIMARY: 'http://127.0.0.1:' + rpc.address().port, RPC_FALLBACK: 'http://127.0.0.1:' + rpc.address().port, PACE_MS: '1', HEAD_LAG: '0' });
  let pass = 0, fail = 0; const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
  const run = () => new Promise(res => { let out = ''; const p = spawn('node', [path.join(__dirname, 'index.js')], { env }); p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { out += d; }); p.on('exit', (code, signal) => res({ status: code, signal, stdout: out })); });   // async: the fake servers live in THIS process
  const r1 = await run(); console.log(r1.stdout.split('\n').filter(l => /cursor|walked|done|FATAL/.test(l)).join('\n'));
  const J = (p) => JSON.parse(p.endsWith('.gz') ? zlib.gunzipSync(files[p]) : files[p]);
  ok(/cursor bootstrapped from ledger coverage: 1000/.test(r1.stdout), 'cursor bootstrapped from the LOWEST ledger coverage (pixel 1000, not 1200)');
  ok(files['nfts/raw/pixel/forward/2026-09-13.json.gz'] && J('nfts/raw/pixel/forward/2026-09-13.json.gz').some(t => t.h === 1003) && J('nfts/raw/pixel/forward/2026-09-13.json.gz').some(t => t.h === 1007), 'raw day file for pixel holds the stake tx + the venue-only BBL tx (archived under every collection on that venue)');
  const led = J('nfts/pixel/ledger/2026/09.json'); ok(led.length >= 2 && led.some(r => r.kind === 'stake' && r.token_id === '42') && led.some(r => r.kind === 'venue_deposit'), 'ledger month: stake #42 + the BBL deposit (venue-level, copied to collections on BBL)');
  ok(J('nfts/adao/ledger/2026/09.json').some(r => r.kind === 'venue_deposit'), 'BBL deposit also under aDAO (lists on BBL)');
  ok(!files['nfts/tla-locks/ledger/2026/09.json'], 'nothing written for tla-locks (not on BBL, no lock tx)');
  const ix = J('nfts/pixel/ledger/index.json'); ok(ix.coverage.some(c => c.source === 'forward:org-nft-flows' && c.from === 1001 && c.to === 1020) && ix.total === led.length, 'index: forward coverage 1001→1020, total = records');
  ok(J('nfts/ledger-cursor.json').height === 1020, 'cursor → 1020');
  const order = gh.filter(x => x.startsWith('PUT')).map(x => x.slice(4)); ok(order.indexOf('nfts/raw/pixel/forward/2026-09-13.json.gz') < order.indexOf('nfts/pixel/ledger/2026/09.json') && order.indexOf('nfts/ledger-cursor.json') > order.lastIndexOf('nfts/pixel/ledger/index.json'), 'write order: raw → ledger → index → cursor');
  const hb = J('nfts/nft-flows/heartbeat.json'); ok(hb.status === 'ok' && hb.matched === 2, 'heartbeat ok, matched 2 (unrelated swap ignored)');
  const r2 = await run(); ok(r2.status === 0 && /nothing new/.test(r2.stdout), 'second run: nothing new, exits clean'); ok(J('nfts/pixel/ledger/2026/09.json').length === led.length, 'ledger unchanged on re-run');
  ghs.close(); rpc.close(); console.log(`\n${pass}/${pass + fail} passed`); process.exit(fail ? 1 : 0);
})();
