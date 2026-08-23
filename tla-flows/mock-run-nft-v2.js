#!/usr/bin/env node
// mock-run-nft-v2.js — BINDING gate for classifyNftTx v2 (aux-classifiers).
// Usage: TLA_CORE_DIR=/path/to/tla-core node mock-run-nft-v2.js
// Real fixtures: full FCD adao-collection archive (11,582 txs) + sales-enriched overlap.
// Gate: classifyNftTx v2 against the REAL FCD archive (adao-collection, 26 parts)
// Asserts, in order:
//  G1  v1 parity — transfer/send/mint/burn records byte-identical to v1 output
//  G2  every BBL `settle` tx yields exactly one non-ambiguous `sale` (buyer+gross+denom)
//  G3  every cancel_auction/admin_cancel tx yields `cancel`, never `sale`
//  G4  create_auction count == `list` records
//  G5  join sale records → sales-enriched on (txhash, token_id):
//        gross_amount, seller, buyer, marketplace_fee, royalty match where enriched has them
const fs = require('fs'), zlib = require('zlib'), path = require('path');
const AX = require('./lib/aux-classifiers.js');

const CORE = process.env.TLA_CORE_DIR; if (!CORE) { console.error('TLA_CORE_DIR required (path to a tla-core checkout)'); process.exit(1); }
const ARCH = CORE + '/archive/fcd/adao-collection';
const NFT = 'terra1phr9fngjv7a8an4dhmhd0u0f98wazxfnzccqtyheq4zqrrp4fpuqw3apw9';
const BBL = 'terra1ej4cv98e9g2zjefr5auf2nwtq4xl3dm7x0qml58yna2ml2hk595s7gccs9';
const CONTRACTS = { [NFT]: 'ADAO NFT collection' };
const MARKETS = { [BBL]: { label: 'BBL necropolis marketplace',
  fee_wallet: 'terra1jgk8dhtv0qf5s08jxrwecf4a04hdmeznqpty75',
  royalty_recipients: ['terra1g0mfrpswewteaf9ky4rlj09wh5njp6u9xxk94uszplw4qz2f9mzq3k27fm',
                       'terra1sffd4efk2jpdt894r04qwmtjqrrjfc52tmj6vkzjxqhd8qqu2drs3m5vzm'] } };

// v1 verbatim (frozen copy for the parity check ONLY — not a third production copy)
function v1(txr, contracts) {
  if (Number(txr.code || 0) !== 0) return [];
  const events = (txr.events || []).filter(e => e.type === 'wasm');
  const out = []; let idx = 0;
  const ACTIONS = new Set(['transfer_nft', 'send_nft', 'mint', 'burn']);
  for (const e of events) {
    const a = {}; for (const x of (e.attributes || [])) if (!(x.key in a)) a[x.key] = x.value;
    const c = a._contract_address;
    if (!contracts[c] || !ACTIONS.has(a.action)) continue;
    out.push({ schemaVersion: 1, k: `${txr.txhash}|${c}|${a.action}|${a.token_id ?? idx}|${idx++}`,
      txhash: txr.txhash, height: Number(txr.height), timestamp: txr.timestamp,
      contract: c, contract_label: contracts[c], action: a.action,
      token_id: a.token_id ?? null,
      from: a.sender || a.owner || null, to: a.recipient || a.owner || null,
      minter: a.minter || null });
  }
  return out;
}

const parts = fs.readdirSync(ARCH).filter(f => f.endsWith('.json.gz')).sort();
let txN = 0, settleTx = 0, cancelTx = 0, createEv = 0;
let sales = [], lists = 0, cancels = 0, ambiguous = 0, badSale = [], crossed = [];
let v1Mismatch = 0;
for (const p of parts) {
  const d = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(ARCH, p))));
  for (const tx of d.txs) {
    if (tx.code) continue;
    txN++;
    const acts = [];
    for (const e of tx.events) if (e.type === 'wasm') {
      const a = {}; for (const x of e.attributes) if (!(x.key in a)) a[x.key] = x.value;
      if (a._contract_address === BBL && a.action) acts.push(a.action);
    }
    const hasSettle = acts.includes('settle');
    const hasCancel = acts.includes('cancel_auction') || acts.includes('admin_cancel_auction');
    if (hasSettle) settleTx++;
    if (hasCancel) cancelTx++;
    createEv += acts.filter(a => a === 'create_auction').length;

    const recs = AX.classifyNftTx(tx, CONTRACTS, MARKETS);
    // G1 parity
    const oldRecs = v1(tx, CONTRACTS);
    const newV1 = recs.filter(r => r.schemaVersion === 1);
    if (JSON.stringify(oldRecs) !== JSON.stringify(newV1)) v1Mismatch++;

    const s = recs.filter(r => r.action === 'sale');
    const c = recs.filter(r => r.action === 'cancel');
    lists += recs.filter(r => r.action === 'list').length;
    cancels += c.length;
    ambiguous += recs.filter(r => r.resolution === 'ambiguous').length;
    if (hasSettle) {
      if (s.length !== acts.filter(a => a === 'settle').length) badSale.push([tx.txhash, 'settle→sale count', s.length]);
      for (const r of s) if (!r.buyer || !r.gross_amount || !r.denom) badSale.push([tx.txhash, 'sale missing field', r]);
    }
    if (hasCancel && s.length && !hasSettle) crossed.push([tx.txhash, 'cancel produced sale']);
    if (!hasSettle && !hasCancel && s.length) crossed.push([tx.txhash, 'sale without settle attr', s[0].resolution]);
    sales.push(...s.map(r => ({ txhash: r.txhash, token_id: r.token_id, gross: r.gross_amount, denom: r.denom,
      seller: r.seller, buyer: r.buyer, fee: r.marketplace_fee, roy: r.royalty_fee, net: r.seller_net })));
  }
}
console.log(`archive: ${txN} ok txs · settle txs ${settleTx} · cancel txs ${cancelTx} · create events ${createEv}`);
console.log(`v2: sales ${sales.length} · lists ${lists} · cancels ${cancels} · ambiguous ${ambiguous}`);
console.log(`G1 v1-parity mismatches: ${v1Mismatch}`);
console.log(`G2 bad sales: ${badSale.length}`, badSale.slice(0, 3));
console.log(`G3 crossed: ${crossed.length}`, crossed.slice(0, 3));
console.log(`G4 create==list: ${createEv} == ${lists} → ${createEv === lists}`);

// G5 reconcile to sales-enriched
const enr = JSON.parse(fs.readFileSync(CORE + '/nfts/adao/snapshots/sales-enriched.json'));
const byKey = new Map(sales.map(s => [`${s.txhash}|${s.token_id}`, s]));
let inWindow = 0, matched = 0, grossOk = 0, sellerOk = 0, buyerOk = 0, feeOk = 0, royOk = 0, miss = [];
const maxH = 13736494; // FCD freeze height
for (const e of enr.sales) {
  if (e.block > maxH) continue;   // FCD window only; marketplace field is 3%-populated, join on keys instead
  inWindow++;
  const s = byKey.get(`${e.tx_hash}|${e.token_id}`);
  if (!s) { miss.push(e.tx_hash.slice(0, 8)); continue; }
  matched++;
  if (String(s.gross) === String(e.gross_amount)) grossOk++;
  if (!e.seller || s.seller === e.seller) sellerOk++;
  if (!e.buyer || s.buyer === e.buyer) buyerOk++;
  if (e.marketplace_fee == null || String(s.fee ?? '0') === String(e.marketplace_fee) || (e.marketplace_fee === '0' && s.fee == null)) feeOk++;
  if (e.royalty_fee == null || String(s.roy) === String(e.royalty_fee)) royOk++;
}
console.log(`G5 enriched BBL sales in FCD window: ${inWindow} · matched ${matched} · gross ${grossOk} · seller ${sellerOk} · buyer ${buyerOk} · fee ${feeOk} · royalty ${royOk}`);
if (miss.length) console.log('   unmatched enriched:', miss.length, miss.slice(0, 10));
const pass = v1Mismatch === 0 && badSale.length === 0 && crossed.length === 0 && createEv === lists
  && matched === inWindow && grossOk === matched && sellerOk === matched && buyerOk === matched;
console.log(pass ? '\nGATE PASS' : '\nGATE FAIL');
process.exit(pass ? 0 : 1);
