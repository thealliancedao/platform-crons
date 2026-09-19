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
// 1.2.0: the fake tla-core serves a token-catalog (LUNA is native; bLUNA + USDC by their real denoms) and a bluna-usd-daily series
const CATALOG = { tokens: [{ denom: 'terra17aj4ty4sz4yhgm08na8drc0v03v2jwr3waxcqrwhajj729zhl7zqnpc0ml', effective: { symbol: 'bLUNA', decimals: 6 } }, { denom: 'ibc/2C962DAB9F57FE0921435426AE75196009FAA1981BF86991203C8411F8980FDB', effective: { symbol: 'USDC', decimals: 6 } }, { denom: 'terra1bluna', discovered: { symbol: 'TESTLST', decimals: 6 } }] };
const BLUNA_DAILY = { '2026-09-12': 0.08 };
// 1.3.0: the fake tla-core serves price-history/YYYY/MM.json — THE org oracle — assembled from the mutable day maps above
const ORACLE_HITS = [];
function oracleMonth(mk) { const days = {}; const add = (m, sym) => { for (const [d, usd] of Object.entries(m)) if (d.slice(0, 7).replace('-', '/') === mk) (days[d] = days[d] || {})[sym] = { usd, src: sym === 'bLUNA' && d < '2025-09-11' ? 'LUNA×ratio(interpolated)' : 'coingecko' }; }; add(LUNA_DAILY, 'LUNA'); add(BLUNA_DAILY, 'bLUNA'); for (const d of Object.keys(days)) days[d].USDC = { usd: 1.0001, src: 'coingecko' }; return { meta: { module: 'price-history' }, days }; }
const rpc = http.createServer((req, res) => { const u = new URL('http://x' + req.url); if (u.pathname.endsWith('token-catalog/snapshots/current.json')) return res.end(JSON.stringify(CATALOG)); { const m = /price-history\/(\d{4}\/\d{2})\.json$/.exec(u.pathname); if (m) { ORACLE_HITS.push(u.pathname); const doc = oracleMonth(m[1]); return res.end(JSON.stringify(doc)); } } /* an oracle month is always a file (possibly with no days yet) */ if (u.pathname.endsWith('bluna-usd-daily.json') || u.pathname.endsWith('luna-usd-daily.json')) { LUNA_HITS.push(u.pathname); res.statusCode = 404; return res.end('{}'); } if (u.pathname === '/status') return res.end(JSON.stringify({ result: { sync_info: { latest_block_height: String(HEAD) } } })); const h = Number(u.searchParams.get('height')); if (u.pathname === '/block') return res.end(JSON.stringify({ result: { block: { header: { time: '2026-09-13T01:00:00Z' }, data: { txs: (blocks[h] || {}).txs || [] } } } })); if (u.pathname === '/block_results') return res.end(JSON.stringify({ result: { txs_results: results[h] || [] } })); res.end('{}'); });
(async () => {
  await new Promise(r => ghs.listen(0, r)); await new Promise(r => rpc.listen(0, r));
  const env = Object.assign({}, process.env, { GITHUB_TOKEN: 'x', COLLECTION: 'pixel-lions', TLA_CORE_RAW: 'http://127.0.0.1:' + rpc.address().port + '/', NFTC_RAW: 'http://127.0.0.1:' + rpc.address().port + '/nftc/', GITHUB_API: 'http://127.0.0.1:' + ghs.address().port, RPC_PRIMARY: 'http://127.0.0.1:' + rpc.address().port, RPC_FALLBACK: 'http://127.0.0.1:' + rpc.address().port, PACE_MS: '1', HEAD_LAG: '0' });
  let pass = 0, fail = 0; const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };
  const run = () => new Promise(res => { let out = ''; const p = spawn('node', ['--max-old-space-size=200', path.join(__dirname, 'index.js')], { env }); /* 1.2.1: the heap cap is part of the gate (Render ~256 MB) */ p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { out += d; }); p.on('exit', (code, signal) => res({ status: code, signal, stdout: out })); });   // async: the fake servers live in THIS process
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
  const DECLARED = (fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8').match(/^\/\/ org-nft-flows (\d+\.\d+\.\d+)/m) || [])[1];   // 1.4.1: the heartbeat's version is a relation to the header, never a literal frozen in the gate
  ok(DECLARED && J('pixel-lions/nft-flows/heartbeat.json').version === DECLARED && J('pixel-lions/nft-flows/heartbeat.json').status === 'ok', `heartbeat ${DECLARED} ok (version = the header's)`);
  ok(/by-token: \d+\/\d+ shards/.test(r3.stdout), '1.4.1 by-token rebuild prints its progress line (every 20 shards and at the end)', r3.stdout.split('\n').filter(l => /by-token/.test(l)));
  ok(require('./lib/oracle-usd.js').VERSION === '1.0.0' && typeof require('./lib/oracle-usd.js').makeOracle === 'function', '1.4.1 lib/oracle-usd.js is the pricing rule (required, not copied)');
  // 1.1.4 — BBL buy-now = place_bid + settle + settle_hook in ONE tx (the exact event sequence of aDAO #745 on
  // 2026-09-12, tx C50E1FF…): the classifier read only the venue's FIRST event (place_bid), never saw the settle, and
  // filed every buy-now since 2023 as "venue release without a known verb". 317 sales missing across aDAO/PL.
  { const BLUNA = 'terra17aj4ty4sz4yhgm08na8drc0v03v2jwr3waxcqrwhajj729zhl7zqnpc0ml'; const SELLER = 'terra1sellerbuynow', BUYER = 'terra1buyerbuynow';
    HEAD = 1040; blocks[1035] = { txs: ['dHg5'] }; results[1035] = [{ code: 0, events: [
      ev(BLUNA, { action: 'send', from: BUYER, to: BBL, amount: 200000000 }),
      ev(BBL,   { action: 'place_bid', auction_id: '14765', bid_amount: 200000000, bidder: BUYER, token_id: 555 }),
      ev(BBL,   { action: 'settle', auction_id: '14765', token_id: 555, denom: BLUNA, amount: 200000000, seller: SELLER }),
      ev(BLUNA, { action: 'transfer', amount: 4000000, from: BBL, to: 'terra1jgk8dhtv0qf5s08jxrwecf4a04hdmeznqpty75' }),
      ev(BLUNA, { action: 'transfer', amount: 10000000, from: BBL, to: 'terra1royaltyrecipient' }),
      ev(BLUNA, { action: 'transfer', amount: 186000000, from: BBL, to: SELLER }),
      ev(PL,    { action: 'transfer_nft', recipient: BUYER, sender: BBL, token_id: 555 }),
      ev(BBL,   { action: 'settle_hook' }),
    ] }];
    const r6 = await run(); ok(r6.status === 0 && !/FATAL/.test(r6.stdout), '1.1.4 buy-now run clean');
    const led6 = J('pixel-lions/ledger/2026/09.json'); const tx6 = led6.filter(r => r.height === 1035);
    const sale = tx6.find(r => r.kind === 'sale');
    ok(sale && sale.token_id === '555' && sale.venue === 'bbl', '1.1.4 buy-now classified as SALE #555 on bbl', tx6.map(r => r.kind + (r.note ? '(' + r.note + ')' : '')));
    ok(sale && sale.price && sale.price.amount === '200000000' && sale.price.denom === 'cw20:' + BLUNA && sale.auction_id === '14765', '1.1.4 sale price = settle amount/denom (200 bLUNA), auction_id carried', sale && [sale.price, sale.auction_id]);
    ok(sale && sale.from === SELLER && sale.to === BUYER, '1.1.4 sale from = settle seller, to = NFT recipient (buyer)', sale && [sale.from, sale.to]);
    ok(sale && sale.split && sale.split.legs && sale.split.legs.length === 3 && sale.split.legs.some(l => l.to === SELLER && l.amount === '186000000'), '1.1.4 split legs carried: fee + royalty + seller (186 of 200)', sale && sale.split);
    ok(!tx6.some(r => r.kind === 'venue_out' && /without a known verb/.test(r.note || '')), '1.1.4 no "venue release without a known verb" for a settled buy-now');
    ok(tx6.some(r => r.kind === 'bid' && r.auction_id === '14765'), '1.1.4 the place_bid leg is still recorded as bid (chain truth, same tx)'); }
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
    ok(s12 && s12.usd === null && /^price_history_(not_yet_written:|missing:LUNA:)2026-09-12$/.test(s12.usd_reason) && !('usd_repriced_at' in s12), '1.1.3/1.3.0 09-12 sale untouched — the oracle has not written that day yet (blank beats phantom)', s12);
    ok(gh.filter(x => x === 'PUT pixel-lions/ledger/2026/09.json').length === 1 && !gh.some(x => x.startsWith('PUT pixel-lions/raw/')), '1.1.3 exactly one month-file write, nothing else');
    ok(J('pixel-lions/nft-flows/heartbeat.json').repriced === 1, '1.1.3 heartbeat carries repriced: 1');
    // 1.2.0 — symbols from the catalog on every priced record, USD per symbol, generic reprice
    ok(led5.filter(r => r.price).every(r => 'denom_symbol' in r), '1.2.0 every priced record carries denom_symbol (stamped on the ones that predate the field)');
    ok(s11.denom_symbol === 'LUNA' && s11.denom_decimals === 6 && s11.usd_basis === 'price-history:2026-09-11 (coingecko)', '1.2.0/1.3.0 the LUNA sale says LUNA · usd_basis names the oracle day and its src');
    const dep = led5.find(r => r.kind === 'venue_deposit' && r.price && /terra1bluna$/.test(r.price.denom));
    console.log('    (deposit record: ' + JSON.stringify(dep && { denom: dep.price.denom, sym: dep.denom_symbol, reason: dep.denom_symbol_reason, usd: dep.usd, usd_reason: dep.usd_reason }) + ')');
    ok(dep && dep.denom_symbol === 'TESTLST' && dep.usd == null && /^price_history_missing:TESTLST:/.test(dep.usd_reason), '1.2.0/1.3.0 a catalog-known token the oracle does not price: symbol stamped, usd null with the reason (never a guess)');
    { const led6 = J('pixel-lions/ledger/2026/09.json');
      led6.push({ kind: 'sale', collection: 'pixel-lions', token_id: '902', height: 992, msg_index: 0, txhash: 'SALEBL', ts: '2026-09-12T10:00:00Z', price: { amount: '200000000', denom: 'cw20:terra17aj4ty4sz4yhgm08na8drc0v03v2jwr3waxcqrwhajj729zhl7zqnpc0ml' }, usd: null, usd_reason: 'no_usd_series_for_denom:cw20:terra17aj4ty4sz4yhgm08na8drc0v03v2jwr3waxcqrwhajj729zhl7zqnpc0ml', source: 'forward:org-nft-flows', repair: 'buy-now-settle-1.1.4' });
      led6.push({ kind: 'sale', collection: 'pixel-lions', token_id: '903', height: 993, msg_index: 0, txhash: 'SALEUS', ts: '2026-09-12T11:00:00Z', price: { amount: '15000000', denom: 'ibc/2C962DAB9F57FE0921435426AE75196009FAA1981BF86991203C8411F8980FDB' }, usd: 15, source: 'forward:org-nft-flows' });
      put('pixel-lions/ledger/2026/09.json', led6); gh.length = 0;
      const r5 = await run(); const led7 = J('pixel-lions/ledger/2026/09.json'); const bl = led7.find(r => r.txhash === 'SALEBL'), us = led7.find(r => r.txhash === 'SALEUS');
      ok(r5.status === 0 && bl && bl.denom_symbol === 'bLUNA' && Math.abs(bl.usd - 200 * 0.08) < 1e-9 && bl.usd_basis === 'price-history:2026-09-12 (coingecko)' && bl.usd_repriced_at && !bl.usd_reason && bl.repair === 'buy-now-settle-1.1.4', '1.2.0/1.3.0 a bLUNA buy-now sale written with no USD (the 1.1.4 repair rows) is USD-priced by the reprice pass from the oracle, labeled, everything else untouched', bl);
      ok(us && us.denom_symbol === 'USDC' && us.usd === 15 && !us.usd_repriced_at, '1.2.0 a stable-priced record gets its symbol stamped and its USD is left exactly as written');
      ok(J('pixel-lions/nft-flows/heartbeat.json').symbol_stamped >= 1, '1.2.0 heartbeat reports symbol_stamped');
      ok(led7.length === led6.length, '1.2.0 never-shrink through the stamp + reprice');
      // 1.2.1 — the full sweep: an OLD month listed in the ledger index (not current/previous) gets walked and priced
      const ix = J('pixel-lions/ledger/index.json'); ix.months = [...new Set([...(ix.months || []), '2024/10'])].sort(); put('pixel-lions/ledger/index.json', ix);
      put('pixel-lions/ledger/2024/10.json', [{ kind: 'sale', collection: 'pixel-lions', token_id: '77', height: 12000000, msg_index: 0, txhash: 'OLDBL', ts: '2024-10-18T22:21:00Z', price: { amount: '200000000', denom: 'cw20:terra17aj4ty4sz4yhgm08na8drc0v03v2jwr3waxcqrwhajj729zhl7zqnpc0ml' }, usd: null, usd_reason: 'no_usd_series_for_denom:cw20:terra17aj4ty4sz4yhgm08na8drc0v03v2jwr3waxcqrwhajj729zhl7zqnpc0ml', source: 'forward:org-nft-flows', repair: 'buy-now-settle-1.1.4' }]);
      BLUNA_DAILY['2024-10-18'] = 0.5; LUNA_DAILY['2024-10-18'] = 0.36; gh.length = 0;   // 1.3.0: the oracle carries bLUNA through the CoinGecko hole (LUNA×ratio)
      const r6 = await run(); const old = J('pixel-lions/ledger/2024/10.json')[0]; const hb6 = J('pixel-lions/nft-flows/heartbeat.json');
      ok(r6.status === 0 && old.denom_symbol === 'bLUNA' && Math.abs(old.usd - 100) < 1e-9 && old.usd_basis === 'price-history:2024-10-18 (LUNA×ratio(interpolated))' && old.usd_repriced_at, '1.2.1/1.3.0 an old month listed in the index is walked: the 2024 bLUNA repair row is priced by the oracle, the basis says the day and the oracle\'s own src', old);
      console.log("    (hb6: " + JSON.stringify({w: hb6.months_walked, t: hb6.months_touched, keys: Object.keys(hb6)}) + ")"); ok(hb6.months_walked >= 2 && (hb6.months_touched || []).includes('2024/10'), '1.2.1 heartbeat reports months_walked / months_touched', [hb6.months_walked, hb6.months_touched]);
      { const m = J('pixel-lions/ledger/2024/10.json'); m.push({ kind: 'sale', collection: 'pixel-lions', token_id: '78', height: 12000500, msg_index: 0, txhash: 'FARBL', ts: '2024-10-30T00:00:00Z', price: { amount: '100000000', denom: 'cw20:terra17aj4ty4sz4yhgm08na8drc0v03v2jwr3waxcqrwhajj729zhl7zqnpc0ml' }, usd: null, usd_reason: 'no_usd_series_for_denom:cw20:terra17aj4ty4sz4yhgm08na8drc0v03v2jwr3waxcqrwhajj729zhl7zqnpc0ml', source: 'forward:org-nft-flows' }); put('pixel-lions/ledger/2024/10.json', m); }
      gh.length = 0; const r6b = await run(); const far = J('pixel-lions/ledger/2024/10.json').find(r => r.txhash === 'FARBL');
      ok(r6b.status === 0 && far.usd == null && far.usd_reason === 'price_history_missing:bLUNA:2024-10-30' && far.denom_symbol === 'bLUNA', '1.3.0 a day the oracle has but not for this symbol stays null with an exact reason (never a guess)', far);
      { const m = J('pixel-lions/ledger/2024/10.json'); m.push({ kind: 'sale', collection: 'pixel-lions', token_id: '79', height: 12000600, msg_index: 0, txhash: 'COPYBL', ts: '2024-10-18T12:00:00Z', price: { amount: '100000000', denom: 'cw20:terra17aj4ty4sz4yhgm08na8drc0v03v2jwr3waxcqrwhajj729zhl7zqnpc0ml' }, denom_symbol: 'bLUNA', usd: 60, usd_basis: 'bluna-usd-daily:2024-10-18', unit_usd: 0.6, source: 'forward:org-nft-flows' }); m.push({ kind: 'sale', collection: 'pixel-lions', token_id: '80', height: 12000601, msg_index: 0, txhash: 'COPYLU', ts: '2024-10-18T13:00:00Z', price: { amount: '100000000', denom: 'uluna' }, denom_symbol: 'LUNA', usd: 36, luna_usd: 0.36, usd_basis: 'luna-usd-daily:2024-10-18', source: 'forward:org-nft-flows' }); put('pixel-lions/ledger/2024/10.json', m); }
      gh.length = 0; const r6c = await run(); const cb = J('pixel-lions/ledger/2024/10.json').find(r => r.txhash === 'COPYBL'), cl = J('pixel-lions/ledger/2024/10.json').find(r => r.txhash === 'COPYLU');
      ok(r6c.status === 0 && Math.abs(cb.usd - 50) < 1e-9 && cb.usd_prev === 60 && cb.usd_prev_basis === 'bluna-usd-daily:2024-10-18' && /^price-history:2024-10-18/.test(cb.usd_basis) && cb.usd_repriced_at, '1.3.0 a bLUNA row priced from the CoinGecko copy (60) is re-priced by the oracle (50), the old number kept beside it', cb);
      ok(cl && Math.abs(cl.usd - 36) < 1e-9 && !('usd_prev' in cl) && /^price-history:2024-10-18/.test(cl.usd_basis), '1.3.0 a LUNA row priced from the copy has the same number — relabeled to the oracle, no usd_prev (a relabel is not a repair)', cl);
      gh.length = 0; const r7 = await run(); const hb7 = J('pixel-lions/nft-flows/heartbeat.json');
      ok(r7.status === 0 && (hb7.months_touched || []).length === 0 && hb7.months_walked >= 2, '1.2.1 a second sweep is a no-op: every month walked, none touched (the ledger is fully labeled)', [hb7.months_walked, hb7.months_touched]); }
    gh.length = 0; const r5 = await run(); ok(r5.status === 0 && !gh.some(x => x.startsWith('PUT pixel-lions/ledger/2026/')), '1.1.3 fifth run: nothing left to re-price, month file NOT rewritten', gh.filter(x => x.startsWith('PUT')));
    ok(J('pixel-lions/nft-flows/heartbeat.json').repriced === 0, '1.1.3 heartbeat repriced: 0 on a no-op pass'); }
  // 1.4.0 — by-token shards: the read shape for "open an NFT → its journey"
  console.log('\n== 1.4.0 by-token shards ==');
  { const bi = J('pixel-lions/ledger/by-token/index.json'); ok(bi && bi.shard_size === 100 && bi.shards['000'] && bi.shards['000'].records >= 2, 'by-token/index.json: shard_size 100, shard 000 listed with its record count');
    const s0 = J('pixel-lions/ledger/by-token/000.json'); ok(s0.tokens['42'] && s0.tokens['42'].some(r => r.kind === 'stake') && s0.tokens['77'] && s0.tokens['77'].some(r => r.kind === 'stake') && s0.range[0] === 0 && s0.range[1] === 99, 'shard 000 holds #42 and #77 with their stake records (range 0–99)', Object.keys(s0.tokens));
    const s5 = J('pixel-lions/ledger/by-token/005.json'); ok(s5 && s5.tokens['555'] && s5.tokens['555'].some(r => r.kind === 'sale' && r.price.amount === '200000000'), 'shard 005 holds the #555 buy-now sale', s5 && Object.keys(s5.tokens));
    ok(Object.values(s0.tokens).flat().every(r => !r.superseded_by), 'no superseded row in any shard');
    // a superseded row appears in the ledger → its token's shard is NOT rebuilt on a nothing-new run (nothing dirty) and never carries it
    { const m = J('pixel-lions/ledger/2024/10.json'); m.push({ kind: 'venue_out', collection: 'pixel-lions', token_id: '77', height: 12000700, msg_index: 0, txhash: 'SUPX', ts: '2024-10-31T00:00:00Z', source: 'forward:org-nft-flows', superseded_by: 'SUPX|0|sale|pixel-lions|77|-', repair: 'x' }); put('pixel-lions/ledger/2024/10.json', m); }
    gh.length = 0; const r8 = await run(); ok(r8.status === 0 && !gh.some(x => x.startsWith('PUT pixel-lions/ledger/by-token/')), 'nothing-new run with nothing dirty: no by-token shard rewritten (changed-files-only)', gh.filter(x => x.startsWith('PUT')));
    const hb8 = J('pixel-lions/nft-flows/heartbeat.json'); ok(hb8.by_token && hb8.by_token.shards_rebuilt === 0, 'heartbeat by_token: 0 shards rebuilt on a clean run', hb8.by_token);
    const env2 = Object.assign({}, env, { BY_TOKEN_ALL: '1' }); gh.length = 0;
    const r9 = await new Promise(res => { let out = ''; const p = spawn('node', ['--max-old-space-size=200', path.join(__dirname, 'index.js')], { env: env2 }); p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { out += d; }); p.on('exit', (code) => res({ status: code, stdout: out })); });
    const hb9 = J('pixel-lions/nft-flows/heartbeat.json'); ok(r9.status === 0 && hb9.by_token && hb9.by_token.mode === 'all' && hb9.by_token.shards_rebuilt >= 2, 'BY_TOKEN_ALL=1 rebuilds every shard', hb9.by_token);
    const s0b = J('pixel-lions/ledger/by-token/000.json'); ok(!s0b.tokens['77'].some(r => r.txhash === 'SUPX') && s0b.tokens['77'].some(r => r.kind === 'stake'), 'full rebuild: the superseded venue_out of #77 is excluded, its live rows stay', s0b.tokens['77'].map(r => r.kind));
    ok(!gh.some(x => x === 'PUT pixel-lions/ledger/by-token/000.json') && r9.status === 0, 'full rebuild writes only shards whose content changed (000 unchanged → not written)', gh.filter(x => x.startsWith('PUT pixel-lions/ledger/by-token')));
  }
  ok(LUNA_HITS.length === 0 && ORACLE_HITS.length >= 1 && ORACLE_HITS.every(p => /\/price-history\/\d{4}\/\d{2}\.json$/.test(p)), '1.3.0: prices come ONLY from the org oracle price-history/YYYY/MM.json (no per-collection usd-daily read at all) — ' + JSON.stringify([...new Set(LUNA_HITS)]));
  ok(!J('pixel-lions/nft-flows/heartbeat.json').errors.some(e => /usd-daily|price-history/.test(e)), '1.1.2/1.3.0: no price-source error in the heartbeat');
  ghs.close(); rpc.close(); console.log(`\n${pass}/${pass + fail} passed`); process.exit(fail ? 1 : 0);
})();
