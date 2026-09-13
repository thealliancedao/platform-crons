'use strict';
// mock-run.js — org-nft-flows against a fake RPC + fake GitHub. Proves: cursor bootstrap from ledger coverage, watch-set
// match, raw-before-ledger, merge by recordKey (no duplicates on a second run), index coverage, cursor written last.
const http = require('http'); const zlib = require('zlib'); const { spawn } = require('child_process'); const fs = require('fs'); const path = require('path');
const PL = 'terra17z7fpaa8kah698xn5tarrcucvualdy4wsztkfc404g3garucpu6qmxp50g', PLV = 'terra127dehd2d6t7ynnezkxkre2w83ze0t7lmghpu6vn4y5mfmwfj5x9qqdh4sz', BBL = 'terra1ej4cv98e9g2zjefr5auf2nwtq4xl3dm7x0qml58yna2ml2hk595s7gccs9';
const NC = process.env.NC || path.join(__dirname, '../../../nft-collections'); const venues = JSON.parse(fs.readFileSync(path.join(NC, 'venues.json'), 'utf8')); const plc = JSON.parse(fs.readFileSync(path.join(NC, 'pixel-lions/collection.json'), 'utf8'));
const files = {}; // fake tla-core
const put = (p, obj) => { files[p] = p.endsWith('.gz') ? zlib.gzipSync(Buffer.from(JSON.stringify(obj))) : Buffer.from(JSON.stringify(obj)); };
put('venues.json', venues); put('pixel-lions/collection.json', plc);
put('pixel-lions/ledger/index.json', { collection: 'pixel-lions', total: 0, by_kind: {}, months: [], coverage: [{ source: 'pixel-lions/raw:1-1000', from: 1, to: 1000 }], known_gaps: [] });
const ev = (c, o) => ({ type: 'wasm', attributes: Object.entries(Object.assign({ _contract_address: c }, o)).map(([k, v]) => ({ key: k, value: String(v) })) });
const blocks = {}; const results = {}; let HEAD = 1020;
blocks[1003] = { txs: ['dHgx'] }; results[1003] = [{ code: 0, events: [ev(PL, { action: 'send_nft', sender: 'terra1me', recipient: PLV, token_id: 42 }), ev(PLV, { action: 'stake', from: 'terra1me', token_id: 42 })] }];
blocks[1007] = { txs: ['dHgy', 'dHgz'] }; results[1007] = [{ code: 0, events: [ev(BBL, { action: 'deposit', amount: 5000000, from: 'terra1w2', token: 'terra1bluna' })] }, { code: 0, events: [ev('terra1unrelated', { action: 'swap' })] }];
const gh = []; const ghs = http.createServer((req, res) => { let b = ''; req.on('data', c => b += c); req.on('end', () => { const m = req.url.match(/\/contents\/([^?]+)/); const p = m && decodeURIComponent(m[1]); gh.push(req.method + ' ' + p);
  if (req.method === 'GET') { if (!files[p]) { res.statusCode = 404; return res.end('{}'); } if ((req.headers.accept || '').includes('raw')) return res.end(files[p]); return res.end(JSON.stringify({ sha: 'sha-' + p, size: files[p].length })); }
  const body = JSON.parse(b); files[p] = Buffer.from(body.content, 'base64'); res.end('{}'); }); });
const LUNA_HITS = []; const LUNA_DAILY = { '2026-09-13': 0.05 };   // 1.1.3: mutable — a day "arrives" mid-gate   // 1.1.2: the exact path the cron asks for — the 404 of 2026-09-13 was a right suffix on the wrong repo
const rpc = http.createServer((req, res) => { const u = new URL('http://x' + req.url); if (u.pathname.endsWith('luna-usd-daily.json')) { LUNA_HITS.push(u.pathname); return res.end(JSON.stringify({ daily: LUNA_DAILY })); } if (u.pathname === '/status') return res.end(JSON.stringify({ result: { sync_info: { latest_block_height: String(HEAD) } } })); const h = Number(u.searchParams.get('height')); if (u.pathname === '/block') return res.end(JSON.stringify({ result: { block: { header: { time: '2026-09-13T01:00:00Z' }, data: { txs: (blocks[h] || {}).txs || [] } } } })); if (u.pathname === '/block_results') return res.end(JSON.stringify({ result: { txs_results: results[h] || [] } })); res.end('{}'); });
(async () => {
  await new Promise(r => ghs.listen(0, r)); await new Promise(r => rpc.listen(0, r));
  const env = Object.assign({}, process.env, { GITHUB_TOKEN: 'x', COLLECTION: 'pixel-lions', TLA_CORE_RAW: 'http://127.0.0.1:' + rpc.address().port + '/', NFTC_RAW: 'http://127.0.0.1:' + rpc.address().port + '/nftc/', GITHUB_API: 'http://127.0.0.1:' + ghs.address().port, RPC_PRIMARY: 'http://127.0.0.1:' + rpc.address().port, RPC_FALLBACK: 'http://127.0.0.1:' + rpc.address().port, PACE_MS: '1', HEAD_LAG: '0' });
  let pass = 0, fail = 0; const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
  const run = () => new Promise(res => { let out = ''; const p = spawn('node', [path.join(__dirname, 'index.js')], { env }); p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { out += d; }); p.on('exit', (code, signal) => res({ status: code, signal, stdout: out })); });   // async: the fake servers live in THIS process
  const r1 = await run(); console.log(r1.stdout.split('\n').filter(l => /cursor|walked|done|FATAL/.test(l)).join('\n'));
  const J = (p) => JSON.parse(p.endsWith('.gz') ? zlib.gunzipSync(files[p]) : files[p]);
  ok(/cursor bootstrapped from pixel-lions ledger coverage: 1000/.test(r1.stdout), 'cursor bootstrapped from THIS collection\'s ledger coverage');
  ok(files['pixel-lions/raw/forward/2026-09-13.json.gz'] && J('pixel-lions/raw/forward/2026-09-13.json.gz').some(t => t.h === 1003) && J('pixel-lions/raw/forward/2026-09-13.json.gz').some(t => t.h === 1007), 'raw day file for pixel holds the stake tx + the venue-only BBL tx (archived under every collection on that venue)');
  const led = J('pixel-lions/ledger/2026/09.json'); ok(led.length >= 2 && led.some(r => r.kind === 'stake' && r.token_id === '42') && led.some(r => r.kind === 'venue_deposit'), 'ledger month: stake #42 + the BBL deposit (venue-level, copied to collections on BBL)');
  ok(!Object.keys(files).some(k => k.startsWith('adao/') || k.startsWith('tla-locks/')), 'nothing written outside pixel-lions/ (one service, one folder)');
  const ix = J('pixel-lions/ledger/index.json'); ok(ix.coverage.some(c => c.source === 'forward:org-nft-flows' && c.from === 1001 && c.to === 1020) && ix.total === led.length, 'index: forward coverage 1001→1020, total = records');
  ok(J('pixel-lions/ledger/cursor.json').height === 1020, 'cursor → 1020');
  const order = gh.filter(x => x.startsWith('PUT')).map(x => x.slice(4)); ok(order.indexOf('pixel-lions/raw/forward/2026-09-13.json.gz') < order.indexOf('pixel-lions/ledger/2026/09.json') && order.indexOf('pixel-lions/ledger/cursor.json') > order.lastIndexOf('pixel-lions/ledger/index.json'), 'write order: raw → ledger → index → cursor');
  const hb = J('pixel-lions/nft-flows/heartbeat.json'); ok(hb.status === 'ok' && hb.matched === 2 && hb.cron === 'org-nft-flows-pixel-lions', 'heartbeat ok, matched 2 (unrelated swap ignored), cron named per collection');
  const r2 = await run(); ok(r2.status === 0 && /nothing new/.test(r2.stdout), 'second run: nothing new, exits clean'); ok(J('pixel-lions/ledger/2026/09.json').length === led.length, 'ledger unchanged on re-run');
  // 1.1.1 regression — the 2026-09-13 tla-locks failure: a SECOND match on the same UTC day makes the cron READ the
  // existing raw/forward/<day>.json.gz through the raw media type; bodies must arrive as bytes (utf8-mangled gzip →
  // 'incorrect header check', every run failed, cursor frozen at 08:45 while the heartbeat stayed fresh).
  HEAD = 1030; blocks[1025] = { txs: ['dHg0'] }; results[1025] = [{ code: 0, events: [ev(PL, { action: 'send_nft', sender: 'terra1you', recipient: PLV, token_id: 77 }), ev(PLV, { action: 'stake', from: 'terra1you', token_id: 77 })] }];
  const r3 = await run(); ok(r3.status === 0 && !/incorrect header check|FATAL/.test(r3.stdout), 'third run (same-day 2nd match): reads the existing gz part cleanly, no FATAL', r3.stdout.split('\n').filter(l => /FATAL|header/.test(l)).join(' | '));
  const part = J('pixel-lions/raw/forward/2026-09-13.json.gz'); ok(part.length === 3 && part.some(t => t.h === 1025) && part.some(t => t.h === 1003), 'gz part merged: 3 txs (prior 2 kept + new)', part.map(t => t.h));
  ok(J('pixel-lions/ledger/2026/09.json').some(r => r.token_id === '77'), 'ledger gained the new stake #77'); ok(J('pixel-lions/ledger/cursor.json').height === 1030, 'cursor → 1030');
  ok(J('pixel-lions/nft-flows/heartbeat.json').version === '1.1.3' && J('pixel-lions/nft-flows/heartbeat.json').status === 'ok', 'heartbeat 1.1.3 ok');
  // 1.1.3 — re-price pass: two LUNA-priced sales sit in the month file with usd:null because their day was not in
  // luna-usd-daily when they were written. Day 09-11 now arrives in the series; 09-12 still has not.
  { const led4 = J('pixel-lions/ledger/2026/09.json'); const n0 = led4.length;
    led4.push({ kind: 'sale', collection: 'pixel-lions', token_id: '900', height: 990, msg_index: 0, txhash: 'SALE11', ts: '2026-09-11T10:00:00Z', price: { amount: '40000000', denom: 'uluna' }, usd: null, usd_reason: 'luna_usd_daily_missing:2026-09-11', source: 'forward:org-nft-flows' });
    led4.push({ kind: 'sale', collection: 'pixel-lions', token_id: '901', height: 991, msg_index: 0, txhash: 'SALE12', ts: '2026-09-12T10:00:00Z', price: { amount: '10000000', denom: 'uluna' }, usd: null, usd_reason: 'luna_usd_daily_missing:2026-09-12', source: 'forward:org-nft-flows' });
    put('pixel-lions/ledger/2026/09.json', led4); LUNA_DAILY['2026-09-11'] = 0.048; gh.length = 0;
    const r4 = await run(); ok(r4.status === 0 && /nothing new/.test(r4.stdout) && /repriced 1 record/.test(r4.stdout), '1.1.3 fourth run (nothing new by cursor): re-price pass still runs, 1 record', r4.stdout.split('\n').filter(l => /repriced|FATAL/.test(l)).join(' | '));
    const led5 = J('pixel-lions/ledger/2026/09.json'); const s11 = led5.find(r => r.txhash === 'SALE11'), s12 = led5.find(r => r.txhash === 'SALE12');
    ok(led5.length === n0 + 2, '1.1.3 never-shrink: record count unchanged by the re-price');
    ok(s11 && Math.abs(s11.usd - 40 * 0.048) < 1e-9 && s11.luna_usd === 0.048 && !('usd_reason' in s11) && /^\d{4}-\d{2}-\d{2}T/.test(s11.usd_repriced_at), '1.1.3 09-11 sale priced (40 LUNA × 0.048), reason removed, LABELED usd_repriced_at', s11);
    ok(s11.price.amount === '40000000' && s11.height === 990 && s11.ts === '2026-09-11T10:00:00Z', '1.1.3 event fields verbatim (only the USD derivation changed)');
    ok(s12 && s12.usd === null && s12.usd_reason === 'luna_usd_daily_missing:2026-09-12' && !('usd_repriced_at' in s12), '1.1.3 09-12 sale untouched — its day is still missing (blank beats phantom)', s12);
    ok(gh.filter(x => x === 'PUT pixel-lions/ledger/2026/09.json').length === 1 && !gh.some(x => x.startsWith('PUT pixel-lions/raw/')), '1.1.3 exactly one month-file write, nothing else');
    ok(J('pixel-lions/nft-flows/heartbeat.json').repriced === 1, '1.1.3 heartbeat carries repriced: 1');
    gh.length = 0; const r5 = await run(); ok(r5.status === 0 && !gh.some(x => x.startsWith('PUT pixel-lions/ledger/2026/')), '1.1.3 fifth run: nothing left to re-price, month file NOT rewritten', gh.filter(x => x.startsWith('PUT')));
    ok(J('pixel-lions/nft-flows/heartbeat.json').repriced === 0, '1.1.3 heartbeat repriced: 0 on a no-op pass'); }
  ok(LUNA_HITS.length >= 1 && LUNA_HITS.every(p => p === '/nftc/adao/snapshots/luna-usd-daily.json'), '1.1.2: luna-usd-daily read from nft-collections/adao/snapshots (never tla-core/nfts/adao) — ' + JSON.stringify([...new Set(LUNA_HITS)]));
  ok(!J('pixel-lions/nft-flows/heartbeat.json').errors.some(e => /luna-usd-daily/.test(e)), '1.1.2: no luna-usd-daily error in the heartbeat');
  ghs.close(); rpc.close(); console.log(`\n${pass}/${pass + fail} passed`); process.exit(fail ? 1 : 0);
})();
