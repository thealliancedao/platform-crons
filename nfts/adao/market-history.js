// =============================================================================
// nfts/adao/market-history.js — forward maintenance of the market-history products
// =============================================================================
// THE PORTED DUTY. sales-enriched.json, listing-history.json, luna-usd-daily.json
// and bluna-usd-daily.json were written by the retired data-repo Action; the
// migration left them with no maintainer (frozen 2026-06). This module carries
// them forward from org products only:
//
//   INPUT  nfts/adao/transfers/YYYY/MM.json  — classifyNftTx v2 records from the
//          tla-flows walker (sale / list / cancel; chain-truth payment legs)
//   INPUT  price-history/YYYY/MM.json        — per-day USD per token (org capture)
//   OUTPUT (merged INTO the same org paths — same file, deeper history, never a
//          side file):
//     • luna-usd-daily.json / bluna-usd-daily.json — day rows appended from
//       price-history; committed days are NEVER rewritten (prior-verbatim).
//     • sales-enriched.json — new sale rows appended, keyed (tx_hash, token_id);
//       committed rows byte-verbatim; never-shrink asserted before publish.
//     • listing-history.json — v2 'list' opens a record, 'cancel'/'sale' closes
//       the matching open segment. Closed segments are committed truth and are
//       never reopened or edited.
//
// Doctrine: honest data. Ambiguous v2 sales (resolution:'ambiguous') are NEVER
// enriched — they are counted and warned loudly for a human decision. A price
// day missing from price-history yields a null-priced row flagged unpriced,
// never a fabricated number. All repairs are labeled (repair field), never silent.
//
// Runs in the inventory job's warm/full pass (same gate as analytics.js).
// =============================================================================
'use strict';
const https = require('https');

const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
const GITHUB_REPO   = process.env.GITHUB_REPO || 'thealliancedao/tla-core';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const NFT_PATH   = process.env.NFT_PATH || 'nfts/adao/snapshots';
const TRANSFERS_PATH = 'nfts/adao/transfers';
const PRICE_PATH = 'price-history';
const VERSION = 'nft-market-history-1.1.0';
const SENTINEL_WINDOW_DAYS = Number(process.env.SENTINEL_WINDOW_DAYS || 60);

// Marketplace payment denoms (chain denom → symbol/decimals). Learned set is
// extended at runtime from historical enriched rows (denom → denom_symbol as
// observed); these constants only guarantee the known venues resolve.
const DENOM_MAP = {
  'uluna': { symbol: 'LUNA', decimals: 6 },
  'terra17aj4ty4sz4yhgm08na8drc0v03v2jwr3waxcqrwhajj729zhl7zqnpc0ml': { symbol: 'bLUNA', decimals: 6 },
  'terra10aa3zdkrc7jwuf8ekl3zq7e7m42vmzqehcmu74e4egc7xkm5kr2s0muyst': { symbol: 'SOLID', decimals: 6 },
  'terra1ecgazyd0waaj3g7l9cmy5gulhxkps2gmxu9ghducvuypjq68mq2s5lvsct': { symbol: 'ampLUNA', decimals: 6 },
};
// Par-priced stables (matches the historical enricher's price_source values).
const PAR_USD = { SOLID: { usd: 1, source: 'solid-par' }, USDC: { usd: 1, source: 'usdc-par' } };

// ---- http / github (verbatim from the proven token-catalog/analytics pattern) ----
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'nft-market-history/1.0' }, timeout: 30000 }, (res) => {
      if (res.statusCode === 404) { res.resume(); return resolve(null); }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} ${url}`)); }
      let d = ''; res.on('data', c => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('timeout')); });
  });
}
const bust = (u) => u + (u.includes('?') ? '&' : '?') + 't=' + Date.now();
const RAW = (p) => bust(`https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_BRANCH}/${p}`);

function githubApiRequest(method, apiPath, body = null) {
  return new Promise((resolve, reject) => {
    const opts = { hostname: 'api.github.com', path: apiPath, method,
      headers: { 'User-Agent': 'nft-market-history/1.0', 'Authorization': `Bearer ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github+json' } };
    if (body) opts.headers['Content-Type'] = 'application/json';
    const req = https.request(opts, res => {
      let data = ''; res.on('data', c => data += c);
      res.on('end', () => { let parsed = data; try { parsed = JSON.parse(data); } catch {} resolve({ status: res.statusCode, body: parsed }); });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}
async function publish(filepath, obj, message, maxAttempts = 5) {
  const content = JSON.stringify(obj, null, 1);
  if (!GITHUB_TOKEN) {
    const fs = require('fs'), path = require('path');
    const local = path.join(process.env.LOCAL_OUT || './out', filepath);
    fs.mkdirSync(path.dirname(local), { recursive: true });
    fs.writeFileSync(local, content);
    console.log(`  (no GITHUB_TOKEN) wrote ${local}`);
    return;
  }
  const apiPath = `/repos/${GITHUB_REPO}/contents/${filepath}`;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // fresh SHA inside EVERY attempt (409 = branch race; stale SHA re-use is the classic bug)
    const cur = await githubApiRequest('GET', apiPath + `?ref=${GITHUB_BRANCH}&t=${Date.now()}`);
    const sha = cur.status === 200 ? cur.body.sha : undefined;
    const put = await githubApiRequest('PUT', apiPath, {
      message, branch: GITHUB_BRANCH, sha,
      content: Buffer.from(content).toString('base64'),
    });
    if (put.status === 200 || put.status === 201) { console.log(`  ✅ ${filepath} (${(content.length / 1024).toFixed(1)} KB)`); return; }
    if (put.status === 409 && attempt < maxAttempts) {
      const wait = 500 * attempt + Math.floor(Math.random() * 500);
      console.warn(`  ⚠ 409 on ${filepath} — retrying with fresh sha in ${wait}ms (attempt ${attempt})`);
      await new Promise(r => setTimeout(r, wait));
      continue;
    }
    throw new Error(`publish ${filepath}: HTTP ${put.status} ${JSON.stringify(put.body).slice(0, 200)}`);
  }
}

// =============================================================================
// PURE CORE (gated by mock-run-market-history.js against real committed data)
// =============================================================================

// ---- 1. daily USD forward-fill --------------------------------------------
// doc: { ..., daily: { 'YYYY-MM-DD': usd } }  symbol: 'LUNA' | 'bLUNA'
// priceMonths: { 'YYYY-MM': priceHistoryMonthDoc }   today: 'YYYY-MM-DD' (excluded — partial day)
function fillDailyFromPriceHistory(doc, symbol, priceMonths, today) {
  const daily = doc.daily || {};
  const days = Object.keys(daily).sort();
  const before = { count: days.length, first: days[0], last: days[days.length - 1] };
  let added = 0, missing = [];
  const start = before.last;                      // fill strictly AFTER the last committed day
  const d = new Date(start + 'T00:00:00Z');
  for (;;) {
    d.setUTCDate(d.getUTCDate() + 1);
    const ds = d.toISOString().slice(0, 10);
    if (ds >= today) break;                       // never write the partial current day
    const mon = priceMonths[ds.slice(0, 7)];
    const px = mon && mon.days && mon.days[ds] && mon.days[ds][symbol] ? mon.days[ds][symbol].usd : null;
    if (px == null) { missing.push(ds); continue; }   // honest gap — no carry-forward fabrication
    daily[ds] = px; added++;
  }
  // prior-verbatim + never-shrink (structural: we only ever added new keys)
  const after = Object.keys(daily).sort();
  if (after.length < before.count) throw new Error(`${symbol} daily SHRANK (${before.count} → ${after.length}) — refusing to publish`);
  doc.daily = daily;
  doc.count = after.length;
  doc.maintained_by = VERSION;
  doc.maintained_at = new Date().toISOString();
  if (!String(doc.source || '').includes('price-history')) {
    doc.source = `${doc.source || ''} + org price-history forward-fill (from ${start})`.trim();
  }
  return { added, missing, before, lastNow: after[after.length - 1] };
}

// ---- 2. sales-enriched append ---------------------------------------------
// enr: the committed sales-enriched doc. v2sales: transfer records action==='sale'.
// lunaDaily/blunaDaily: the (already forward-filled) daily docs. priceMonths as above.
function appendEnrichedSales(enr, v2sales, lunaDaily, blunaDaily, priceMonths, denomMapLearned) {
  const have = new Set(enr.sales.map(s => `${s.tx_hash}|${s.token_id}`));
  const denomMap = { ...DENOM_MAP, ...denomMapLearned };
  const priorCount = enr.sales.length;
  const priorJson = JSON.stringify(enr.sales);    // byte-verbatim assert base
  const salesByToken = {};
  for (const s of enr.sales) (salesByToken[String(s.token_id)] = salesByToken[String(s.token_id)] || []).push(s);

  const dayUsd = (symbol, day) => {
    if (PAR_USD[symbol]) return { usd: PAR_USD[symbol].usd, source: PAR_USD[symbol].source };
    if (symbol === 'LUNA' && lunaDaily.daily[day] != null) return { usd: lunaDaily.daily[day], source: 'luna-usd-daily' };
    if (symbol === 'bLUNA' && blunaDaily.daily[day] != null) return { usd: blunaDaily.daily[day], source: 'bluna-usd-daily' };
    const mon = priceMonths[day.slice(0, 7)];
    const px = mon && mon.days && mon.days[day] && mon.days[day][symbol] ? mon.days[day][symbol].usd : null;
    return px != null ? { usd: px, source: 'price-history' } : { usd: null, source: 'unpriced' };
  };

  let added = 0, skippedAmbiguous = 0, skippedDup = 0, unpriced = 0;
  const incoming = [...v2sales].sort((a, b) => (a.height - b.height) || String(a.k).localeCompare(String(b.k)));
  for (const r of incoming) {
    if (r.resolution === 'ambiguous') { skippedAmbiguous++; continue; }   // never enrich a guess
    const key = `${r.txhash}|${r.token_id}`;
    if (have.has(key)) { skippedDup++; continue; }
    const dm = denomMap[r.denom] || null;
    const symbol = dm ? dm.symbol : (r.denom || 'unknown');
    const decimals = dm ? dm.decimals : 6;
    const day = (r.timestamp || '').slice(0, 10);
    const px = dayUsd(symbol, day);
    if (px.usd == null) unpriced++;
    const amount = r.gross_amount != null ? Number(r.gross_amount) / 10 ** decimals : null;
    const lunaPx = lunaDaily.daily[day] != null ? lunaDaily.daily[day] : null;
    const notional = (amount != null && px.usd != null) ? +(amount * px.usd).toFixed(4) : null;
    const lunaEquiv = (notional != null && lunaPx) ? +(notional / lunaPx).toFixed(6) : (symbol === 'LUNA' ? amount : null);
    const prior = (salesByToken[String(r.token_id)] || []).filter(s => s.timestamp < r.timestamp);
    const prev = prior.sort((a, b) => a.timestamp.localeCompare(b.timestamp))[prior.length - 1] || null;
    const row = {
      tx_hash: r.txhash, block: Number(r.height), timestamp: r.timestamp,
      listing_id: r.auction_id != null ? Number(r.auction_id) : null,
      token_id: String(r.token_id),
      seller: r.seller || null, buyer: r.buyer || null,
      denom: r.denom || null, denom_symbol: symbol,
      gross_amount: r.gross_amount != null ? String(r.gross_amount) : null,
      seller_net: r.seller_net != null ? String(r.seller_net) : null,
      marketplace_fee: r.marketplace_fee != null ? String(r.marketplace_fee) : '0',
      royalty_fee: r.royalty_fee != null ? String(r.royalty_fee) : null,
      royalty_recipient: r.royalty_recipient || null,
      marketplace: r.contract_label && /atrium/i.test(r.contract_label) ? 'Atrium'
                 : r.contract_label && /boost|launch/i.test(r.contract_label) ? 'Boost' : 'BBL',
      sale_number: prior.length + 1,
      amount, luna_equiv: lunaEquiv,
      price_usd_at_sale: px.usd, price_source: px.source,
      notional_usd: notional,
      value_today_usd: null,      // stamped below once spot is known
      denom_spot_usd: px.usd,
      acquired_at: prev ? prev.timestamp : null,
      basis_kind: prev ? 'sale' : null,
      hold_days: prev ? +(((Date.parse(r.timestamp) - Date.parse(prev.timestamp)) / 86400000).toFixed(1)) : null,
      captured_by: VERSION,
      // labeled repair when the row predates the freeze (recovered history, not forward capture)
      ...(r.timestamp < '2026-06-13' ? { repair: 'batch-settle-recovery' } : {}),
    };
    enr.sales.push(row);
    (salesByToken[String(r.token_id)] = salesByToken[String(r.token_id)] || []).push(row);
    have.add(key); added++;
  }
  // value_today_usd for the rows added THIS call (spot = latest known LUNA day)
  const lastLunaDay = Object.keys(lunaDaily.daily).sort().pop();
  const spot = lunaDaily.daily[lastLunaDay];
  const priorKeys = new Set(JSON.parse(priorJson).map(s => `${s.tx_hash}|${s.token_id}`));
  for (const s of enr.sales) if (!priorKeys.has(`${s.tx_hash}|${s.token_id}`) && s.value_today_usd == null && s.luna_equiv != null && spot != null) {
    s.value_today_usd = +(s.luna_equiv * spot).toFixed(4);
  }
  enr.sales.sort((a, b) => a.timestamp.localeCompare(b.timestamp) || String(a.tx_hash).localeCompare(String(b.tx_hash)));
  // laws: rows present at ENTRY of this call stay byte-verbatim; never-shrink.
  // ("prior" is positional — keyed at entry — not a stamp, so re-runs over
  // already-committed appends pass idempotently.)
  const priorRows = enr.sales.filter(s => priorKeys.has(`${s.tx_hash}|${s.token_id}`));
  if (priorRows.length !== priorCount) throw new Error(`sales-enriched prior-row count changed (${priorCount} → ${priorRows.length}) — refusing`);
  const priorNow = JSON.stringify([...JSON.parse(priorJson)].sort((a, b) => a.timestamp.localeCompare(b.timestamp) || String(a.tx_hash).localeCompare(String(b.tx_hash))));
  const priorInDoc = JSON.stringify(priorRows);
  if (priorNow !== priorInDoc) throw new Error('sales-enriched prior rows are NOT byte-verbatim — refusing to publish');
  enr.count = enr.sales.length;
  enr.maintained_by = VERSION;
  enr.maintained_at = new Date().toISOString();
  return { added, skippedAmbiguous, skippedDup, unpriced, total: enr.sales.length };
}

// ---- 3. listing-history maintenance ---------------------------------------
// lh: committed listing-history doc. v2events: transfer records with action list/cancel/sale.
function maintainListingHistory(lh, v2events) {
  const recs = lh.records;
  const priorClosed = recs.filter(r => r.outcome !== 'active').length;
  const marketOf = (r) => r.contract_label && /atrium/i.test(r.contract_label) ? 'Atrium'
                        : r.contract_label && /boost|launch/i.test(r.contract_label) ? 'Boost' : 'BBL';
  const openByRef = new Map(), openByTok = new Map();
  // dedupe against EVERYTHING ever recorded, not just open records: the scan
  // window overlaps between runs, so a list event whose record has since been
  // CLOSED would otherwise re-open a phantom active listing every run.
  const seenRef = new Set(), seenCreateTx = new Set();
  for (const r of recs) {
    if (r.listing_ref != null) seenRef.add(`${r.marketplace}:${r.listing_ref}`);
    if (r.create_tx) seenCreateTx.add(`${r.create_tx}|${r.token_id}`);
    if (r.outcome !== 'active') continue;
    if (r.listing_ref != null) openByRef.set(`${r.marketplace}:${r.listing_ref}`, r);
    openByTok.set(`${r.marketplace}:${r.token_id}`, r);
  }
  let opened = 0, closed = 0, unmatched = 0;
  // order: height, then lifecycle rank (a list precedes its close at equal height), then key
  const rank = { list: 0, cancel: 1, sale: 1 };
  const sorted = [...v2events].sort((a, b) => (a.height - b.height)
    || ((rank[a.action] ?? 2) - (rank[b.action] ?? 2)) || String(a.k).localeCompare(String(b.k)));
  for (const e of sorted) {
    const mkt = marketOf(e);
    if (e.action === 'list') {
      const ref = e.auction_id != null ? String(e.auction_id) : null;
      if (ref != null && seenRef.has(`${mkt}:${ref}`)) continue;        // ever recorded (open OR closed) — idempotent
      if (ref == null && seenCreateTx.has(`${e.txhash}|${e.token_id}`)) continue;
      const rec = { token_id: String(e.token_id), marketplace: mkt,
        listing_ref: ref, seller: e.seller || null,
        segments: [{ price: e.reserve_price != null ? String(e.reserve_price) : null,
          denom: e.denom || null, from_ts: e.timestamp, from_height: Number(e.height),
          to_ts: null, end_reason: 'still_listed' }],
        listing_type: e.listing_type || null, outcome: 'active', create_tx: e.txhash,
        captured_by: VERSION };
      recs.push(rec); opened++;
      if (ref != null) { openByRef.set(`${mkt}:${ref}`, rec); seenRef.add(`${mkt}:${ref}`); }
      seenCreateTx.add(`${e.txhash}|${e.token_id}`);
      openByTok.set(`${mkt}:${e.token_id}`, rec);
    } else if (e.action === 'cancel' || e.action === 'sale') {
      const ref = e.auction_id != null ? String(e.auction_id) : null;
      const rec = (ref != null && openByRef.get(`${mkt}:${ref}`)) || openByTok.get(`${mkt}:${e.token_id}`) || null;
      if (!rec) { unmatched++; continue; }                              // warned by caller — never invent a record
      const seg = rec.segments[rec.segments.length - 1];
      if (seg && seg.to_ts == null) {
        seg.to_ts = e.timestamp; seg.to_height = Number(e.height);
        seg.end_reason = e.action === 'sale' ? 'sale' : 'delist';
      }
      rec.outcome = e.action === 'sale' ? 'sold' : 'delisted';
      rec.closed_by = VERSION;
      if (ref != null) openByRef.delete(`${mkt}:${ref}`);
      openByTok.delete(`${mkt}:${e.token_id}`);
      closed++;
    }
  }
  // laws: closed records are committed truth — count can only grow
  const closedNow = recs.filter(r => r.outcome !== 'active').length;
  if (closedNow < priorClosed) throw new Error(`listing-history closed-record count SHRANK (${priorClosed} → ${closedNow}) — refusing`);
  lh.count = recs.length;
  lh.counts = recs.reduce((m, r) => { m[r.outcome] = (m[r.outcome] || 0) + 1; return m; }, {});
  lh.maintained_by = VERSION;
  lh.maintained_at = new Date().toISOString();
  return { opened, closed, unmatched, total: recs.length };
}

// ---- 4. unresolved-exit sentinel -------------------------------------------
// THE "NEVER AGAIN" INVARIANT. Every NFT that leaves a marketplace contract did
// so as a SALE or a DELIST — there is no third thing. So every v1 exit record
// (transfer_nft/send_nft FROM a registry marketplace) must have a v2 sale or
// cancel record for the same tx. Any exit without one is a coverage hole and
// gets screamed about — a heartbeat warning, not a lucky catch two days later
// (which is exactly how the 2026-08-21 Atrium sale of #6192 was found).
function findUnresolvedExits(monthDocs, marketAddrs, sinceIso) {
  const resolvedTx = new Set();
  const exits = [];
  for (const doc of Object.values(monthDocs)) {
    for (const r of (doc || [])) {
      if (Number(r.schemaVersion) >= 2 && (r.action === 'sale' || r.action === 'cancel')) resolvedTx.add(r.txhash);
      if (Number(r.schemaVersion) === 1 && (r.action === 'transfer_nft' || r.action === 'send_nft')
          && marketAddrs.has(r.from) && r.timestamp > sinceIso) {
        exits.push({ txhash: r.txhash, token_id: r.token_id, from: r.from, timestamp: r.timestamp });
      }
    }
  }
  return exits.filter(e => !resolvedTx.has(e.txhash));
}

// =============================================================================
// IO shell
// =============================================================================
function monthsBetween(fromDay, toDay) {
  const out = []; const d = new Date(fromDay.slice(0, 7) + '-01T00:00:00Z');
  for (;;) { const m = d.toISOString().slice(0, 7); out.push(m); if (m >= toDay.slice(0, 7)) break; d.setUTCMonth(d.getUTCMonth() + 1); }
  return out;
}

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  console.log(`\n${VERSION} — market-history forward maintenance`);
  const [enr, lh, lunaDaily, blunaDaily] = await Promise.all([
    fetchJson(RAW(`${NFT_PATH}/sales-enriched.json`)),
    fetchJson(RAW(`${NFT_PATH}/listing-history.json`)),
    fetchJson(RAW(`${NFT_PATH}/luna-usd-daily.json`)),
    fetchJson(RAW(`${NFT_PATH}/bluna-usd-daily.json`)),
  ]);
  if (!enr || !lh || !lunaDaily || !blunaDaily) {
    console.error('  ✗ a committed input is unreadable — honest skip (no partial maintenance)');
    return;
  }
  // price-history months: from the older of the two daily tails through today
  const lastLuna = Object.keys(lunaDaily.daily).sort().pop();
  const lastBluna = Object.keys(blunaDaily.daily).sort().pop();
  const fromDay = lastLuna < lastBluna ? lastLuna : lastBluna;
  const months = monthsBetween(fromDay, today);
  const priceMonths = {};
  await Promise.all(months.map(async m => { priceMonths[m] = await fetchJson(RAW(`${PRICE_PATH}/${m.slice(0, 4)}/${m.slice(5, 7)}.json`)); }));

  // 1) daily fills
  const f1 = fillDailyFromPriceHistory(lunaDaily, 'LUNA', priceMonths, today);
  console.log(`  luna-usd-daily: +${f1.added} days (→ ${f1.lastNow})${f1.missing.length ? ` · ${f1.missing.length} days missing in price-history (left blank)` : ''}`);
  const f2 = fillDailyFromPriceHistory(blunaDaily, 'bLUNA', priceMonths, today);
  console.log(`  bluna-usd-daily: +${f2.added} days (→ ${f2.lastNow})${f2.missing.length ? ` · ${f2.missing.length} days missing (left blank)` : ''}`);

  // 2+3) v2 transfer records since the enriched tail (scan tail month − 1 → today, dedupe handles overlap)
  const lastSale = enr.sales.map(s => s.timestamp).sort().pop() || '2023-12-01T00:00:00Z';
  const scanFrom = new Date(Date.parse(lastSale) - 32 * 86400000).toISOString().slice(0, 10);
  const tMonths = monthsBetween(scanFrom, today);
  const v2 = []; const tDocs = {};
  await Promise.all(tMonths.map(async m => {
    const doc = await fetchJson(RAW(`${TRANSFERS_PATH}/${m.slice(0, 4)}/${m.slice(5, 7)}.json`));
    tDocs[m] = doc;
    for (const r of (doc || [])) if (Number(r.schemaVersion) >= 2 && ['sale', 'list', 'cancel'].includes(r.action)) v2.push(r);
  }));
  const denomLearned = {};
  for (const s of enr.sales) if (s.denom && s.denom_symbol && !DENOM_MAP[s.denom]) denomLearned[s.denom] = { symbol: s.denom_symbol, decimals: 6 };

  const sres = appendEnrichedSales(enr, v2.filter(r => r.action === 'sale'), lunaDaily, blunaDaily, priceMonths, denomLearned);
  console.log(`  sales-enriched: +${sres.added} (dup ${sres.skippedDup}, ambiguous SKIPPED ${sres.skippedAmbiguous}, unpriced ${sres.unpriced}) → ${sres.total}`);
  if (sres.skippedAmbiguous) console.warn(`  ⚠ ${sres.skippedAmbiguous} ambiguous v2 sale(s) NOT enriched — need a human decision (raw attrs are in transfers)`);

  const lres = maintainListingHistory(lh, v2);   // sale records close listings too
  console.log(`  listing-history: +${lres.opened} opened, ${lres.closed} closed${lres.unmatched ? `, ⚠ ${lres.unmatched} unmatched close(s)` : ''} → ${lres.total}`);

  // 4) unresolved-exit sentinel over the trailing window (registry marketplaces)
  let unresolved = [];
  try {
    const reg = await fetchJson(RAW('tla-voting/capture-registry.json'));
    const marketAddrs = new Set((reg && reg.contracts || []).filter(c => (c.streams || []).includes('nft_marketplace')).map(c => c.address));
    if (marketAddrs.size) {
      const sinceIso = new Date(Date.now() - SENTINEL_WINDOW_DAYS * 86400000).toISOString();
      const sMonths = monthsBetween(sinceIso.slice(0, 10), today);
      const sDocs = {};
      await Promise.all(sMonths.map(async m => {
        sDocs[m] = tDocs[m] !== undefined ? tDocs[m] : await fetchJson(RAW(`${TRANSFERS_PATH}/${m.slice(0, 4)}/${m.slice(5, 7)}.json`));
      }));
      unresolved = findUnresolvedExits(sDocs, marketAddrs, sinceIso);
      if (unresolved.length) {
        console.warn(`  ⚠⚠ SENTINEL: ${unresolved.length} marketplace exit(s) in the last ${SENTINEL_WINDOW_DAYS}d have NO sale/cancel resolution — every exit is one or the other; these are coverage holes:`);
        for (const e of unresolved.slice(0, 20)) console.warn(`     ${e.timestamp.slice(0, 10)} #${e.token_id} tx ${e.txhash.slice(0, 10)}… from …${e.from.slice(-6)}`);
        if (unresolved.length > 20) console.warn(`     … and ${unresolved.length - 20} more`);
      } else {
        console.log(`  ✓ sentinel: every marketplace exit in the last ${SENTINEL_WINDOW_DAYS}d resolves to a sale or cancel`);
      }
    } else console.warn('  ⚠ sentinel skipped: no nft_marketplace entries readable from registry');
  } catch (e) { console.warn(`  ⚠ sentinel errored (non-fatal): ${e.message}`); }

  // publish (order: dailies first — the enricher's numbers cite them)
  await publish(`${NFT_PATH}/luna-usd-daily.json`, lunaDaily, `market-history: luna-usd-daily +${f1.added} days`);
  await publish(`${NFT_PATH}/bluna-usd-daily.json`, blunaDaily, `market-history: bluna-usd-daily +${f2.added} days`);
  if (sres.added) await publish(`${NFT_PATH}/sales-enriched.json`, enr, `market-history: +${sres.added} sales (→ ${sres.total})`);
  else console.log('  sales-enriched unchanged — skipped publish');
  if (lres.opened || lres.closed) await publish(`${NFT_PATH}/listing-history.json`, lh, `market-history: listings +${lres.opened}/−${lres.closed}`);
  else console.log('  listing-history unchanged — skipped publish');
  await publish(`${NFT_PATH}/market-history-heartbeat.json`, {
    schemaVersion: 1, cron: 'nft-market-history', version: VERSION, status: 'ok',
    capturedAt: new Date().toISOString(),
    stats: { luna_days_added: f1.added, bluna_days_added: f2.added,
      sales_added: sres.added, sales_ambiguous_skipped: sres.skippedAmbiguous,
      listings_opened: lres.opened, listings_closed: lres.closed, unmatched_closes: lres.unmatched,
      unresolved_exits: unresolved.length,
      unresolved_exit_txs: unresolved.slice(0, 20).map(e => ({ tx: e.txhash, token_id: e.token_id, at: e.timestamp })) },
    sentinel_window_days: SENTINEL_WINDOW_DAYS,
  }, 'market-history heartbeat');
  console.log('  done');
}

module.exports = { main, fillDailyFromPriceHistory, appendEnrichedSales, maintainListingHistory, findUnresolvedExits, DENOM_MAP };
if (require.main === module) main().catch(e => { console.error('market-history failed:', e.message); process.exit(1); });
