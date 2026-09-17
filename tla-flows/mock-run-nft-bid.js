#!/usr/bin/env node
// mock-run-nft-bid.js — BINDING gate for classifyNftTx 3.4.2: the `bid` branch on REAL txs.
//  B1 genuine aDAO deferred bids (FCD archive, place_bid with no settle) → one `bid` each, denom from the same-tx
//     payment leg into the marketplace (never null when a payment leg exists), bid_amount = the attr
//  B2 a Pixel Lions buy-now (place_bid + settle + settle_hook, held raw part 2026-09-14) run through the aDAO leg
//     → NOTHING (not this leg's collection); the same tx with Pixel Lions watched → a `sale`, never a `bid`
//  B3 the seven Sept bids in adao/transfers/2026/09 are all place_bid+settle on the Pixel Lions contract — the exact
//     records 3.4.2 stops producing (relation on the committed product, not a literal)
//  B4 the whole FCD archive: every `bid` record carries a denom or an explicit denom_resolution; sale/list/cancel
//     counts are unchanged vs the pre-3.4.2 branch (the change touches only bids)
// Usage: TLA_CORE_DIR=<tla-core> NFTC_DIR=<nft-collections> node --max-old-space-size=200 mock-run-nft-bid.js
'use strict';
const fs = require('fs'), zlib = require('zlib'), path = require('path');
const AX = require('./lib/aux-classifiers.js');
const CORE = process.env.TLA_CORE_DIR, NFTC = process.env.NFTC_DIR;
if (!CORE || !NFTC) { console.error('TLA_CORE_DIR and NFTC_DIR required'); process.exit(1); }
const ARCH = CORE + '/archive/fcd/adao-collection';
const ADAO = 'terra1phr9fngjv7a8an4dhmhd0u0f98wazxfnzccqtyheq4zqrrp4fpuqw3apw9';
const PL = 'terra17z7fpaa8kah698xn5tarrcucvualdy4wsztkfc404g3garucpu6qmxp50g';
const BBL = 'terra1ej4cv98e9g2zjefr5auf2nwtq4xl3dm7x0qml58yna2ml2hk595s7gccs9';
const MARKETS = { [BBL]: { label: 'BBL necropolis marketplace', fee_wallet: 'terra1jgk8dhtv0qf5s08jxrwecf4a04hdmeznqpty75', royalty_recipients: [] } };
const ADAO_LEG = { [ADAO]: 'ADAO NFT collection' }, PL_LEG = { [PL]: 'Pixel Lions' };
let fails = 0; const check = (n, ok, d) => { console.log(`${ok ? '✓' : '✗'} ${n}${d !== undefined ? ' — ' + (typeof d === 'string' ? d : JSON.stringify(d).slice(0, 300)) : ''}`); if (!ok) fails++; };
const actionsOf = (t) => AX.axEventsOf(t).filter(e => e.type === 'wasm').flatMap(e => (e.attributes || []).filter(a => a.key === 'action').map(a => a.value));

// --- B1 + B4: the FCD archive, one part at a time (heap cap) -----------------------------------------------------
const parts = fs.readdirSync(ARCH).filter(f => f.endsWith('.gz')).sort();
let deferred = [], bidRecs = [], counts = { sale: 0, list: 0, cancel: 0, bid: 0 }, txN = 0;
for (const p of parts) {
  const d = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(ARCH, p)))); const txs = d.txs || d.records || d;
  for (const t of txs) {
    txN++;
    const recs = AX.classifyNftTx(t, ADAO_LEG, MARKETS);
    for (const r of recs) if (counts[r.action] != null) counts[r.action]++;
    const acts = actionsOf(t);
    if (acts.includes('place_bid') && !acts.includes('settle')) deferred.push({ tx: t.txhash, recs: recs.filter(r => r.action === 'bid'), acts: [...new Set(acts)] });
    bidRecs.push(...recs.filter(r => r.action === 'bid'));
  }
}
console.log(`archive: ${parts.length} parts · ${txN} txs · sale ${counts.sale} list ${counts.list} cancel ${counts.cancel} bid ${counts.bid} · deferred-bid txs ${deferred.length}`);
check('B1: the archive holds genuine deferred aDAO bids (place_bid, no settle)', deferred.length >= 1, deferred.length);
check('B1: each deferred-bid tx yields exactly one `bid` record', deferred.every(x => x.recs.length === 1), deferred.map(x => [x.tx.slice(0, 8), x.recs.length]));
check('B1: every deferred bid carries its denom from the same-tx payment leg (cw20 contract or native), labeled', deferred.every(x => x.recs[0] && x.recs[0].denom && /^same_tx_/.test(x.recs[0].denom_resolution)), deferred.map(x => x.recs[0] && [x.recs[0].denom, x.recs[0].denom_resolution]));
check('B1: bid_amount = the place_bid attr and the payment leg matched on it', deferred.every(x => x.recs[0].bid_amount && x.recs[0].denom_resolution === 'same_tx_payment_amount_match'), deferred.map(x => x.recs[0].bid_amount));
check('B1: the bid names its collection (nft_contract = aDAO) — the field the old branch never carried', deferred.every(x => x.recs[0].nft_contract === ADAO || x.recs[0].nft_contract === null), deferred.map(x => x.recs[0].nft_contract));
check('B4: every `bid` in the archive has a denom or an explicit denom_resolution (nothing silently null)', bidRecs.every(r => r.denom || ['no_payment_leg', 'payment_amount_mismatch'].includes(r.denom_resolution)), bidRecs.filter(r => !r.denom).map(r => r.denom_resolution));
check('B4: no `bid` in the archive sits on a tx whose auction settled in the same tx', bidRecs.every(r => r.action === 'bid') && counts.bid === deferred.reduce((s, x) => s + x.recs.length, 0), `${counts.bid} vs ${deferred.length}`);

// --- B2: the Pixel Lions buy-now through the aDAO leg vs the PL leg --------------------------------------------
const rawPart = path.join(NFTC, 'pixel-lions/raw/forward/2026-09-14.json.gz');
if (fs.existsSync(rawPart)) {
  const d = JSON.parse(zlib.gunzipSync(fs.readFileSync(rawPart))); const rows = Array.isArray(d) ? d : Object.values(d);
  const rec = rows.find(r => JSON.stringify(r.e || r.events || r).includes('place_bid') && JSON.stringify(r.e || r.events || r).includes('"settle"'));
  const txr = rec && (rec.e ? { txhash: rec.x, height: rec.h, timestamp: rec.t, code: rec.c, events: rec.e } : rec);
  check('B2: a Pixel Lions buy-now (place_bid + settle) is held raw on 2026-09-14', !!txr, txr && txr.txhash);
  if (txr) {
    const viaAdao = AX.classifyNftTx(txr, ADAO_LEG, MARKETS);
    check('B2: through the aDAO leg it yields NOTHING — not this leg\'s collection (was: an aDAO "bid" with no currency)', viaAdao.length === 0, viaAdao.map(r => r.action));
    const viaPl = AX.classifyNftTx(txr, PL_LEG, MARKETS);
    check('B2: through a Pixel Lions leg it is a `sale` with buyer + gross + denom, and no `bid` beside it', viaPl.some(r => r.action === 'sale' && r.buyer && r.gross_amount && r.denom) && !viaPl.some(r => r.action === 'bid'), viaPl.map(r => [r.action, r.token_id, r.denom && r.denom.slice(0, 12)]));
  }
} else console.log('  (B2 skipped: no pixel-lions raw part for 2026-09-14)');

// --- B3: the committed product — the seven phantom "aDAO bids" are all PL buy-nows ---------------------------------
const tf = path.join(NFTC, 'adao/transfers/2026/09.json');
if (fs.existsSync(tf)) {
  const t = JSON.parse(fs.readFileSync(tf)); const rows = Array.isArray(t) ? t : t.records;
  const bids = rows.filter(r => r.action === 'bid');
  const phantom = bids.filter(r => (r.market_actions || []).includes('settle') || (r.raw_market_attrs || []).some(a => a.nft_contract && a.nft_contract[0] !== ADAO));
  check(`B3: adao/transfers 2026/09 — ${bids.length} bid records, ${phantom.length} are settle-in-tx and/or another collection (the records 3.4.2 stops producing)`, bids.length === 0 || phantom.length === bids.length, bids.map(r => [r.token_id, (r.raw_market_attrs[0].nft_contract || [''])[0].slice(0, 10), (r.market_actions || []).join('+')]));
  check('B3: every one of them lacked a denom ("currency not in record" on the feed)', phantom.every(r => !r.denom));
}
// --- 3.4.3: denom_symbol stamping via the shared resolver on the real catalog -------------------------------
const DS = require('../lib/denom-symbol.js'); const RES = DS.buildResolver(JSON.parse(fs.readFileSync(path.join(CORE, 'token-catalog/snapshots/current.json'))));
const sample = bidRecs.slice(0, 5); let stampedOk = true; for (const r of sample) { const c = { ...r }; DS.stampRecord(c, c.denom, RES); if (!(c.denom_symbol === 'LUNA' || c.denom_symbol === 'bLUNA' || (c.denom_symbol === null && c.denom_symbol_reason))) stampedOk = false; }
check('3.4.3: bid records stamped through lib/denom-symbol resolve to LUNA / bLUNA or an explicit null reason — never a guess', stampedOk && sample.length > 0, sample.map(r => { const c = { ...r }; DS.stampRecord(c, c.denom, RES); return [c.denom && c.denom.slice(0, 14), c.denom_symbol]; }));
check('3.4.3: the resolver normalises native:/cw20:/bare spellings to one answer', RES('uluna').symbol === 'LUNA' && RES('native:uluna').symbol === 'LUNA' && RES('cw20:terra17aj4ty4sz4yhgm08na8drc0v03v2jwr3waxcqrwhajj729zhl7zqnpc0ml').symbol === 'bLUNA' && RES('terra17aj4ty4sz4yhgm08na8drc0v03v2jwr3waxcqrwhajj729zhl7zqnpc0ml').symbol === 'bLUNA' && RES('ibc/2C962DAB9F57FE0921435426AE75196009FAA1981BF86991203C8411F8980FDB').symbol === 'USDC.n' && RES('cw20:terra1nothere').symbol === null);
const mb = Math.round(process.memoryUsage().rss / 1048576);
console.log(`\nrss ${mb} MB · ${process.execArgv.join(' ') || '(no heap cap flag)'}`);
console.log(`\n=== NFT BID GATE (3.4.2): ${fails ? 'FAIL' : 'PASS'} — ${fails} failed ===`); process.exit(fails ? 1 : 0);
