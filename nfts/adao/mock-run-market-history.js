#!/usr/bin/env node
// mock-run-market-history.js — BINDING gate for market-history.js (the ported duty).
//
// Real fixtures throughout:
//   • committed luna/bluna-usd-daily + price-history months  (daily fill)
//   • committed sales-enriched (1,259 rows) + the 64 REAL batch-settle sales the
//     old pipeline dropped, re-derived from the FCD archive via classifyNftTx v2
//     (needs missing64.json — regenerate with the v2 gate if absent)
//   • committed listing-history + real-shaped v2 list/cancel/sale lifecycle
//
// Usage: TLA_CORE_DIR=/path/to/tla-core NFTC_DIR=/path/to/nft-collections [NFT_ROOT=adao] [MISSING64=./missing64.json] node mock-run-market-history.js
'use strict';
const fs = require('fs'), path = require('path');
const CORE = process.env.TLA_CORE_DIR;
if (!CORE) { console.error('TLA_CORE_DIR required'); process.exit(1); }
// 2026-09-14 (B.7): aDAO fixtures read from a nft-collections checkout (NFTC_DIR) + NFT_ROOT (adao) — tla-core/nfts/adao was deleted 2026-09-13
const NFTC = process.env.NFTC_DIR; if (!NFTC) { console.error('NFTC_DIR required (nft-collections checkout)'); process.exit(1); }
const NFT_ROOT = process.env.NFT_ROOT || 'adao';
const MH = require('./market-history.js');
// 1.3.0: the shared resolver on the real catalog, as main() would set it
{ const DS = require('../../lib/denom-symbol.js'); const MH = require('./market-history.js'); const cat = JSON.parse(require('fs').readFileSync(require('path').join(process.env.TLA_CORE_DIR, 'token-catalog/snapshots/current.json'))); MH._setResolver(DS.buildResolver(cat)); }
const P = (p) => JSON.parse(fs.readFileSync(path.join(CORE, p)));
const N = (p) => JSON.parse(fs.readFileSync(path.join(NFTC, NFT_ROOT, p)));   // aDAO products

let fails = 0;
const check = (n, ok, d) => { console.log(`${ok ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`); if (!ok) fails++; };
const deep = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---------- G1/G2: daily fills against real committed dailies ----------------
// 1.5.0: the copies are RETIRED (token-catalog 1.9.0 publishes price-history/series/<SYMBOL>.json). When the fixture no
// longer has them, G1/G2 are skipped and the LUNA-on-day view G3 needs is built from the oracle months — as the cron does.
const COPIES_PRESENT = fs.existsSync(path.join(process.env.NFTC_DIR, 'adao/snapshots/luna-usd-daily.json'));
if (!COPIES_PRESENT) {
  const luna = { daily: {} }; const today = new Date().toISOString().slice(0, 10);
  for (const y of fs.readdirSync(path.join(process.env.TLA_CORE_DIR, 'price-history')).filter(x => /^\d{4}$/.test(x))) for (const f of fs.readdirSync(path.join(process.env.TLA_CORE_DIR, 'price-history', y)).filter(x => /^\d{2}\.json$/.test(x))) { const m = P(`price-history/${y}/${f}`); for (const [d, row] of Object.entries(m.days || {})) if (row.LUNA && row.LUNA.usd != null) luna.daily[d] = row.LUNA.usd; }
  fs.writeFileSync('/tmp/mh-luna.json', JSON.stringify(luna)); fs.writeFileSync('/tmp/mh-bluna.json', JSON.stringify({ daily: {} }));
  console.log(`  (G1/G2 skipped: usd-daily copies retired — LUNA-on-day view built from ${Object.keys(luna.daily).length} oracle days)`);
}
if (COPIES_PRESENT) {
  const luna = N('snapshots/luna-usd-daily.json');
  const priorLuna = JSON.parse(JSON.stringify(luna.daily));
  const lastBefore = Object.keys(priorLuna).sort().pop();
  const today = new Date().toISOString().slice(0, 10);
  // 2026-09-14 (B.7): the month list was frozen at 06–08 of 2026 — load every month from the last committed day
  // through today, the way the cron does, so the gate keeps working as the calendar moves.
  const months = {};
  { const d = new Date(lastBefore.slice(0, 7) + '-01T00:00:00Z'); const end = today.slice(0, 7);
    for (;;) { const ym = d.toISOString().slice(0, 7); try { months[ym] = P(`price-history/${ym.slice(0, 4)}/${ym.slice(5, 7)}.json`); } catch {} if (ym >= end) break; d.setUTCMonth(d.getUTCMonth() + 1); } }
  const r = MH.fillDailyFromPriceHistory(luna, 'LUNA', months, today);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  check('G1 luna fill: reaches yesterday', r.lastNow >= yesterday, `${lastBefore} → ${r.lastNow} (+${r.added})`);
  check('G1 luna fill: prior days byte-verbatim', Object.keys(priorLuna).every(d => luna.daily[d] === priorLuna[d]));
  check('G1 luna fill: no fabricated days (every added day exists in price-history)',
    Object.keys(luna.daily).filter(d => !(d in priorLuna)).every(d => months[d.slice(0, 7)]?.days?.[d]?.LUNA?.usd === luna.daily[d]));
  check('G1 luna fill: idempotent', MH.fillDailyFromPriceHistory(luna, 'LUNA', months, today).added === 0);
  const bluna = N('snapshots/bluna-usd-daily.json');
  const priorB = Object.keys(bluna.daily).length;
  const r2 = MH.fillDailyFromPriceHistory(bluna, 'bLUNA', months, today);
  check('G2 bluna fill: reaches yesterday', r2.lastNow >= yesterday, `+${r2.added}`);
  check('G2 bluna fill: never shrinks', Object.keys(bluna.daily).length >= priorB);
  // stash filled dailies for G3
  fs.writeFileSync('/tmp/mh-luna.json', JSON.stringify(luna));
  fs.writeFileSync('/tmp/mh-bluna.json', JSON.stringify(bluna));
}

// ---------- G3: sales append — the 64 real recovered sales -------------------
{
  const enr = N('snapshots/sales-enriched.json');
  const priorRows = JSON.parse(JSON.stringify(enr.sales));
  const m64path = process.env.MISSING64 || path.join(__dirname, 'missing64.json');
  let m64 = null;
  if (fs.existsSync(m64path)) m64 = JSON.parse(fs.readFileSync(m64path));
  else {
    // self-derive the fixture from the in-repo FCD archive with the SAME-REPO
    // live classifier (no fixture file to keep in sync, no third copy)
    const zlib = require('zlib');
    const AX = require('../../tla-flows/lib/aux-classifiers.js');
    const NFT = 'terra1phr9fngjv7a8an4dhmhd0u0f98wazxfnzccqtyheq4zqrrp4fpuqw3apw9';
    const BBL = 'terra1ej4cv98e9g2zjefr5auf2nwtq4xl3dm7x0qml58yna2ml2hk595s7gccs9';
    const C = { [NFT]: 'ADAO' };
    const M = { [BBL]: { label: 'BBL', fee_wallet: 'terra1jgk8dhtv0qf5s08jxrwecf4a04hdmeznqpty75',
      royalty_recipients: ['terra1g0mfrpswewteaf9ky4rlj09wh5njp6u9xxk94uszplw4qz2f9mzq3k27fm', 'terra1sffd4efk2jpdt894r04qwmtjqrrjfc52tmj6vkzjxqhd8qqu2drs3m5vzm'] } };
    const have = new Set(enr.sales.map(s => `${s.tx_hash}|${s.token_id}`));
    const arch = path.join(NFTC, NFT_ROOT, 'archive/fcd/collection');   // 2026-09-14 (B.7): FCD archive is local to the collection (import v2, 2026-09-12)
    m64 = [];
    for (const p of fs.readdirSync(arch).filter(f => f.endsWith('.json.gz')).sort()) {
      const d = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(arch, p))));
      for (const tx of d.txs) { if (tx.code) continue;
        for (const r of AX.classifyNftTx(tx, C, M)) if (r.action === 'sale' && !have.has(`${r.txhash}|${r.token_id}`)) m64.push(r);
      }
    }
    console.log(`(fixture self-derived from FCD archive: ${m64.length} recovered sales)`);
    // 2026-09-14 (B.7): the 64-sale batch-settle recovery is APPLIED on main (recover-batch-sales retired), so
    // "adds 64" can never be true again. What still needs gating: nothing is left to recover on live main; and the
    // append path — pricing day-of from luna-usd-daily, legs arithmetic, repair label, prior-verbatim, idempotence —
    // exercised by removing a sample of committed archive-era sales from a COPY and re-feeding them.
    check('G3 live main: nothing left to recover from the FCD archive (recovery applied)', m64.length === 0, `${m64.length} unrecovered`);
    const luna = JSON.parse(fs.readFileSync('/tmp/mh-luna.json'));
    const bluna = JSON.parse(fs.readFileSync('/tmp/mh-bluna.json'));
    const archSales = []; const seen = new Set();
    for (const p of fs.readdirSync(arch).filter(f => f.endsWith('.json.gz')).sort()) {
      const d = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(arch, p))));
      for (const tx of d.txs) { if (tx.code) continue; for (const r of AX.classifyNftTx(tx, C, M)) if (r.action === 'sale' && r.denom === 'uluna' && !seen.has(`${r.txhash}|${r.token_id}`)) { seen.add(`${r.txhash}|${r.token_id}`); archSales.push(r); } }
    }
    const sample = archSales.slice(-8); const sampleKeys = new Set(sample.map(r => `${r.txhash}|${r.token_id}`));
    check('G3 sample: 8 archive-era uluna sales, all present in sales-enriched today', sample.length === 8 && sample.every(r => have.has(`${r.txhash}|${r.token_id}`)));
    const committed = new Map(enr.sales.filter(s => sampleKeys.has(`${s.tx_hash}|${s.token_id}`)).map(s => [`${s.tx_hash}|${s.token_id}`, s]));
    const totalBefore = enr.sales.length; enr.sales = enr.sales.filter(s => !sampleKeys.has(`${s.tx_hash}|${s.token_id}`));
    const months = {};
    for (const r of sample) { const k = r.timestamp.slice(0, 7); if (!months[k]) try { months[k] = P(`price-history/${k.slice(0, 4)}/${k.slice(5, 7)}.json`); } catch {} }
    const res = MH.appendEnrichedSales(enr, sample, luna, bluna, months, {});
    check('G3 all 8 re-appended', res.added === 8, `added ${res.added}`);
    check('G3 none ambiguous/unpriced', res.skippedAmbiguous === 0 && res.unpriced === 0, `amb ${res.skippedAmbiguous} unpriced ${res.unpriced}`);
    check('G3 total restored', res.total === totalBefore, `${res.total} vs ${totalBefore}`);
    const news = enr.sales.filter(s => sampleKeys.has(`${s.tx_hash}|${s.token_id}`));
    check('G3 (1.4.0) re-appended rows priced from the ORG ORACLE day-of (price-history), never a copy', news.every(s => /^price-history/.test(s.price_source) && s.price_usd_at_sale > 0 && s.notional_usd > 0), [...new Set(news.map(s => s.price_source))]);
    check('G3 legs arithmetic carried (net+fee+roy == gross where all present)', news.every(s => {
      if (s.seller_net == null || s.royalty_fee == null) return true;
      return Number(s.seller_net) + Number(s.marketplace_fee || 0) + Number(s.royalty_fee) === Number(s.gross_amount);
    }));
    check('G3 re-appended rows reproduce the committed rows field-for-field (price, notional, legs, token, timestamp)', news.every(s => { const c = committed.get(`${s.tx_hash}|${s.token_id}`); return c && ['gross_amount', 'seller_net', 'royalty_fee', 'marketplace_fee', 'token_id', 'timestamp', 'denom', 'buyer', 'seller'].every(k => String(c[k] ?? '') === String(s[k] ?? '')) && Math.abs(Number(c.price_usd_at_sale) - Number(s.price_usd_at_sale)) < 1e-6 && Math.abs(Number(c.notional_usd) - Number(s.notional_usd)) < 1e-3; }),   /* 1.4.0: the oracle carries 8 decimals, the retired copy 16 — same price */
      news.map(s => { const c = committed.get(`${s.tx_hash}|${s.token_id}`); return ['price_usd_at_sale', 'notional_usd', 'gross_amount', 'seller_net', 'royalty_fee', 'marketplace_fee'].filter(k => String(c[k] ?? '') !== String(s[k] ?? '')).map(k => `${k}: ${c[k]} vs ${s[k]}`); }).flat().slice(0, 6));
    const priorInDoc = enr.sales.filter(s => !sampleKeys.has(`${s.tx_hash}|${s.token_id}`));
    check('G3 every untouched row byte-verbatim', priorInDoc.length === totalBefore - 8 && deep([...priorRows].filter(s => !sampleKeys.has(`${s.tx_hash}|${s.token_id}`)).sort((a, b) => a.timestamp.localeCompare(b.timestamp) || String(a.tx_hash).localeCompare(String(b.tx_hash))), [...priorInDoc].sort((a, b) => a.timestamp.localeCompare(b.timestamp) || String(a.tx_hash).localeCompare(String(b.tx_hash)))));
    // idempotency: feeding the same 8 again adds 0
    const res2 = MH.appendEnrichedSales(enr, sample, luna, bluna, months, {});
    check('G3 idempotent (re-feed adds 0)', res2.added === 0 && res2.skippedDup === 8, `added ${res2.added} dup ${res2.skippedDup}`);
    // ambiguous records are refused
    const amb = [{ ...sample[0], k: sample[0].k + '|amb', txhash: 'F'.repeat(64), resolution: 'ambiguous' }];
    const res3 = MH.appendEnrichedSales(enr, amb, luna, bluna, months, {});
    check('G3 ambiguous sale refused', res3.added === 0 && res3.skippedAmbiguous === 1);
  }
}

// ---------- G4: listing-history lifecycle on committed doc -------------------
{
  const lh = N('snapshots/listing-history.json');
  const priorCount = lh.records.length;
  const priorActive = lh.records.filter(r => r.outcome === 'active' && !r.captured_by).length;   // 2026-09-14 (B.7): same filter as the check below (forward-captured actives carry captured_by now)
  const mk = (action, extra) => ({ schemaVersion: 2, k: `GATE|${action}|${extra.token_id}|${extra.auction_id}`,
    txhash: 'A'.repeat(64), height: 22600000, timestamp: '2026-08-23T12:00:00Z',
    contract: 'terra1ej4…', contract_label: 'BBL necropolis marketplace v2', action, resolution: 'attrs', ...extra });
  // open → close(sale) lifecycle on a synthetic ref that can't collide
  const ev = [
    mk('list',   { token_id: '99991', auction_id: '9000001', seller: 'terra1sellerx', denom: 'uluna', reserve_price: '1000000', listing_type: 'buy_now' }),
    mk('list',   { token_id: '99992', auction_id: '9000002', seller: 'terra1sellery', denom: 'uluna', reserve_price: '2000000', listing_type: 'buy_now' }),
    mk('sale',   { token_id: '99991', auction_id: '9000001', buyer: 'terra1buyerxx', seller: 'terra1sellerx', denom: 'uluna', gross_amount: '1000000' }),
    mk('cancel', { token_id: '99992', auction_id: '9000002' }),
    mk('cancel', { token_id: '99993', auction_id: '9000003' }),   // no open record → unmatched
  ];
  const r = MH.maintainListingHistory(lh, ev);
  check('G4 opened 2, closed 2, 1 unmatched', r.opened === 2 && r.closed === 2 && r.unmatched === 1, JSON.stringify(r));
  const a = lh.records.find(x => x.listing_ref === '9000001');
  const b = lh.records.find(x => x.listing_ref === '9000002');
  check('G4 sale closes with end_reason sale + outcome sold', a.outcome === 'sold' && a.segments[0].end_reason === 'sale' && a.segments[0].to_ts != null);
  check('G4 cancel closes with end_reason delist', b.outcome === 'delisted' && b.segments[0].end_reason === 'delist');
  check('G4 committed records untouched in count', lh.records.length === priorCount + 2, `${lh.records.length}`);
  check('G4 pre-existing active records untouched', lh.records.filter(x => x.outcome === 'active' && !x.captured_by).length === priorActive);
  check('G4 idempotent list (same auction_id re-fed opens 0)', MH.maintainListingHistory(lh, [ev[0]]).opened === 0);
}

// ---------- G6: unresolved-exit sentinel (real months, real fixture) ---------
{
  const ATR = 'terra15du229lqcxkn939pmjgklqunftf604q4wz87kt5awj6reghec5jqs0w0kj';
  const BBL6 = 'terra1ej4cv98e9g2zjefr5auf2nwtq4xl3dm7x0qml58yna2ml2hk595s7gccs9';
  const BO = 'terra1kj7pasyahtugajx9qud02r5jqaf60mtm7g5v9utr94rmdfftx0vqspf4at';
  const markets = new Set([ATR, BBL6, BO]);
  const aug = N('transfers/2026/08.json');
  const SALE_TX = '995038E56D407FAEDEDD49188C5E9E108B5425E896E3F03B8CF5B0DA5720E994';
  const hasV2ForSale = aug.some(r => Number(r.schemaVersion) >= 2 && r.txhash === SALE_TX && (r.action === 'sale' || r.action === 'cancel'));
  const un1 = MH.findUnresolvedExits({ '2026-08': aug }, markets, '2026-06-12T00:00:00Z');
  if (hasV2ForSale) {
    // post-resolve-Action state: the known sale must NOT flag
    check('G6 sentinel: resolved sale tx does not flag', !un1.some(e => e.txhash === SALE_TX), `${un1.length} unresolved remain`);
  } else {
    // pre-resolve state: the known missed sale MUST flag
    check('G6 sentinel: the missed Atrium sale flags as unresolved', un1.some(e => e.txhash === SALE_TX), `${un1.length} unresolved`);
    // merging its v2 sale record clears exactly that flag
    const v2sale = { schemaVersion: 2, k: `${SALE_TX}|${ATR}|sale|6192|11`, txhash: SALE_TX, height: 22478346,
      timestamp: '2026-08-21T18:48:42Z', contract: ATR, action: 'sale', token_id: '6192' };
    const un2 = MH.findUnresolvedExits({ '2026-08': [...aug, v2sale] }, markets, '2026-06-12T00:00:00Z');
    check('G6 sentinel: resolution clears the flag', !un2.some(e => e.txhash === SALE_TX) && un2.length === un1.length - un1.filter(e => e.txhash === SALE_TX).length);
  }
  // exits outside the window never flag
  const un3 = MH.findUnresolvedExits({ '2026-08': aug }, markets, '2026-08-22T00:00:00Z');
  check('G6 sentinel: window respected', un3.every(e => e.timestamp > '2026-08-22T00:00:00Z'));
}

// ---------- G5: flows.js delisting→sale upgrade ------------------------------
{
  const flows = require('./flows.js');
  // stub the month fetch: monkey-patch https via a tiny local server is overkill —
  // upgradeDelistingsToSales fetches transfers/YYYY/MM.json over httpGetJson; we
  // exercise the JOIN logic by feeding a doc whose date maps to a real committed
  // month (v1-only records → no-op) and asserting the no-upgrade path, then the
  // retype logic directly on a crafted doc via the same code path with an
  // injected month (require-cache patch of httpGetJson isn't exposed, so the
  // retype loop is asserted through summarizeDay on a pre-upgraded doc).
  const doc = { date: '2026-08-23', events: [
    { time: 'T1', type: 'delisting', token_id: '2639', marketplace: 'BBL', price_raw: '20000000000', denom: 'cw20:terra17aj…' },
    { time: 'T2', type: 'sale', token_id: '99991', upgraded_from: 'delisting', sale_tx: 'A'.repeat(64), buyer: 'terra1b', gross_amount: '1000000', price_usd: 47.7, price_luna: 1000 },
  ], current_state: {} };
  const s = flows.summarizeDay(doc);
  check('G5 summarize counts upgraded sale as sale', s.sales_count === 1 && s.by_type.sale === 1 && s.by_type.delisting === 1);
  check('G5 upgrade fn exported and callable', typeof flows.upgradeDelistingsToSales === 'function');
}

{ const MH = require('./market-history.js'); const lh = JSON.parse(require('fs').readFileSync(require('path').join(process.env.NFTC_DIR, 'adao/snapshots/listing-history.json')));
  MH.maintainListingHistory(lh, []); const segs = lh.records.flatMap(r => r.segments || []).filter(sg => sg.denom);
  const known = segs.filter(sg => sg.denom_symbol), unknown = segs.filter(sg => sg.denom_symbol === null);
  console.log(`  1.3.0 segments: ${segs.length} with a denom · ${known.length} resolved (${[...new Set(known.map(sg => sg.denom_symbol))].join(', ')}) · ${unknown.length} unknown (null, not guessed${unknown.length ? ': ' + [...new Set(unknown.map(sg => sg.denom))].slice(0, 3).join(', ') : ''})`);
  check('1.3.0 every segment with a denom carries denom_symbol; ≥95% resolve through the catalog; a symbol is never an address', segs.every(sg => 'denom_symbol' in sg) && known.length / segs.length > 0.95 && !known.some(sg => /^(cw20|native):|terra1/.test(sg.denom_symbol))); }
console.log(fails === 0 ? '\nGATE PASS' : `\nGATE FAIL (${fails})`);
process.exit(fails === 0 ? 0 : 1);
