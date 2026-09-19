// =============================================================================
// nfts/nft-inventory/market-history.js — maintenance of the market-history products, FROM THE LEDGER
// =============================================================================
// 1.6.0 (2026-09-19, owner): THE SOURCE IS THE LEDGER. sales-enriched / listing-history are maintained from
//   <root>/ledger/YYYY/MM.json (org-nft-flows: every list / delist / sale on chain, priced by the org oracle, superseded
//   rows skipped) instead of the tla-flows NFT aux `transfers/` leg — this is market-history's leg of B.2 (retire the
//   transfers reader), and the seed for a NEW collection (B.6): with no committed docs, both are built from the whole
//   ledger, one month (and its oracle month) in memory at a time. aDAO: forward window unchanged (enriched tail − 32 d),
//   committed rows byte-verbatim; gate = the ledger reproduces every committed row field-for-field on the overlap.
//   The unresolved-exit sentinel is the ledger's own `venue_out` rows (a venue release the classifier could not name).
//   SCAN_ALL=1 walks every ledger month once (a one-time deepen for a collection whose docs predate the ledger).
// THE PORTED DUTY. sales-enriched.json, listing-history.json, luna-usd-daily.json
// and bluna-usd-daily.json were written by the retired data-repo Action; the
// migration left them with no maintainer (frozen 2026-06). This module carries
// them forward from org products only:
//
//   INPUT  <root>/ledger/YYYY/MM.json           — org-nft-flows ledger records (1.6.0; was the tla-flows transfers leg)
//          list / delist / sale with chain-truth payment legs, superseded rows skipped
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
// ---- 2026-09-12 aDAO migration (NFT_ROOT / DATA_REPO) --------------------------------
// GITHUB_REPO = where THIS cron WRITES its aDAO products (today tla-core; becomes nft-collections).
// DATA_REPO   = where the TLA-side products it READS live (network-and-prices, price-history,
//               token-catalog, tla-voting) — always tla-core, never follows GITHUB_REPO.
// NFT_ROOT    = the aDAO folder inside GITHUB_REPO ('nfts/adao' today; 'adao' in nft-collections).
// Defaults reproduce the pre-migration layout exactly, so this change is a no-op until the env flips.
const DATA_REPO     = process.env.DATA_REPO || 'thealliancedao/tla-core';
const NFT_ROOT      = String(process.env.NFT_ROOT || 'nfts/adao').replace(/^\/+|\/+$/g, '');
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const NFT_PATH   = process.env.NFT_PATH || `${NFT_ROOT}/snapshots`;
const LEDGER_PATH = `${NFT_ROOT}/ledger`;   // 1.6.0: the source (was `${NFT_ROOT}/transfers`, the tla-flows aux leg)
const SCAN_ALL = /^1|true$/i.test(String(process.env.SCAN_ALL || ''));
const PRICE_PATH = 'price-history';
const VERSION = 'nft-market-history-1.6.0';   // 1.6.0 (2026-09-19): source = the ledger; seeds a new collection; sentinel = venue_out ·   // 1.5.0 (2026-09-18): the luna/bluna-usd-daily copies are RETIRED — not read, not written (token-catalog 1.9.0 publishes price-history/series/<SYMBOL>.json for readers that need one long series); luna_equiv and value_today read the oracle month for the day / the latest oracle day ·   // 1.4.1 (2026-09-18): listing-history IS published when segments were stamped (1.4.0 stamped 3,172 in memory and skipped the write); the usd-daily rebuild log separates value corrections from precision rewrites ·   // 1.4.0 (2026-09-18, owner): the ORG PRICE ORACLE (tla-core/price-history) is the only source for past USD — dayUsd reads it first; luna/bluna-usd-daily are rebuilt from it every run (they were CoinGecko market charts: bLUNA differed from the oracle by up to 30% on 261 days) and kept only for the three pages that still read them ·   // 1.3.0 (2026-09-18): denom → symbol from THE shared resolver (lib/denom-symbol.js, token-catalog effective layer); listing-history segments carry denom_symbol; the local DENOM_MAP is a last resort only when the catalog read fails · 1.2.0 (2026-09-12): NFT_ROOT + DATA_REPO (TLA-side reads pinned to tla-core)
const SENTINEL_WINDOW_DAYS = Number(process.env.SENTINEL_WINDOW_DAYS || 60);

// Marketplace payment denoms (chain denom → symbol/decimals). Learned set is
// extended at runtime from historical enriched rows (denom → denom_symbol as
// observed); these constants only guarantee the known venues resolve.
const DS = require('../../lib/denom-symbol.js');   // 1.3.0
let RESOLVE = null;                                  // token-catalog resolver, set in main(); null → DENOM_MAP fallback
function symbolFor(denom) { if (!denom) return null; if (RESOLVE) { const r = RESOLVE(denom); if (r.symbol) return r.symbol; } const dm = DENOM_MAP[DS.bare(denom)]; return dm ? dm.symbol : null; }
const DENOM_MAP = {   // 1.3.0: FALLBACK ONLY (catalog unreachable) — never the first answer
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
const RAW_DATA = (p) => bust(`https://raw.githubusercontent.com/${DATA_REPO}/${GITHUB_BRANCH}/${p}`);   // TLA-side reads

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
// 1.4.0: the usd-daily copies are REBUILT from the oracle — every day the oracle has overwrites the copy (the copies had
// CoinGecko market prices for bLUNA that disagree with the oracle's LUNA×ratio by up to 30%). Idempotent; counts changes.
function syncDailyFromOracle(doc, symbol, priceMonths) {
  const daily = doc.daily || (doc.daily = {}); let changed = 0, precision = 0, added = 0, covered = 0;
  for (const mon of Object.values(priceMonths)) for (const [d, row] of Object.entries((mon && mon.days) || {})) { const px = row && row[symbol] ? row[symbol].usd : null; if (px == null) continue; covered++; const prev = daily[d];
    if (prev === px) continue; daily[d] = px;
    if (prev == null) added++; else if (Math.abs(prev - px) > Math.abs(px) * 5e-3) changed++; else precision++;   // a value correction vs the same number at fewer decimals
  }
  if (changed || precision || added) { doc.source = 'org price-history (tla-core) — rebuilt 2026-09-18; forward-filled from the same oracle'; doc.rebuilt_from_oracle_at = new Date().toISOString(); }
  return { changed, precision, added, covered };
}
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
    // 1.4.0: the oracle first — always the same price for the same day, whoever asks
    const mon = priceMonths[day.slice(0, 7)];
    const px = mon && mon.days && mon.days[day] && mon.days[day][symbol] ? mon.days[day][symbol].usd : null;
    if (px != null) return { usd: px, source: 'price-history' + (mon.days[day][symbol].src ? ':' + mon.days[day][symbol].src : '') };
    if (PAR_USD[symbol]) return { usd: PAR_USD[symbol].usd, source: PAR_USD[symbol].source };
    if (DS.isStableSymbol(symbol)) return { usd: 1, source: 'stable-par' };   // 1.6.0: by catalog symbol (USDC.n, USDC.inj, USDT …), the same rule the ledger prices with
    return { usd: null, source: 'unpriced' };
  };

  let added = 0, skippedAmbiguous = 0, skippedDup = 0, unpriced = 0;
  const incoming = [...v2sales].sort((a, b) => (a.height - b.height) || String(a.k).localeCompare(String(b.k)));
  for (const r of incoming) {
    if (r.resolution === 'ambiguous') { skippedAmbiguous++; continue; }   // never enrich a guess
    const key = `${r.txhash}|${r.token_id}`;
    if (have.has(key)) { skippedDup++; continue; }
    const dm = denomMap[r.denom] || null;
    const symbol = symbolFor(r.denom) || (dm ? dm.symbol : (r.denom || 'unknown'));   // 1.3.0: catalog first
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
      marketplace: marketOfEvent(r),
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
  // 1.3.0: segments written before the field get denom_symbol on the next maintenance pass (a label, never a price)
  let stampedSegs = 0; for (const r of (lh && lh.records) || []) for (const sg of r.segments || []) if (sg && sg.denom && sg.denom_symbol === undefined) { sg.denom_symbol = symbolFor(sg.denom); stampedSegs++; }
  if (stampedSegs) console.log(`  listing-history: denom_symbol stamped on ${stampedSegs} segment(s)`);
  const recs = lh.records;
  const priorClosed = recs.filter(r => r.outcome !== 'active').length;
  const marketOf = marketOfEvent;
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
  // order: height, then msg_index, then lifecycle rank — a CLOSE precedes an OPEN at the same height (1.6.0: Atrium's price
  // update is delist + list in ONE tx; opening first let the close land on the new record and left the old one active
  // forever — #6192), then key
  const rank = { cancel: 0, sale: 0, exit: 0, list: 1 };
  const sorted = [...v2events].sort((a, b) => (a.height - b.height) || ((a.msg_index || 0) - (b.msg_index || 0))
    || ((rank[a.action] ?? 2) - (rank[b.action] ?? 2)) || String(a.k).localeCompare(String(b.k)));
  for (const e of sorted) {
    const mkt = marketOf(e);
    if (e.action === 'list') {
      const ref = e.auction_id != null ? String(e.auction_id) : null;
      if (ref != null && seenRef.has(`${mkt}:${ref}`)) continue;        // ever recorded (open OR closed) — idempotent
      if (ref == null && seenCreateTx.has(`${e.txhash}|${e.token_id}`)) continue;
      // 1.6.0: a new listing of a token still open on the same venue closes the open record first (BBL relist without a
      // captured cancel — #1657 sat "active" under its first auction id after selling under the second): end_reason
      // 'relisted', outcome delisted — the old escrow ended; the new record is the listing that is live.
      const prev = openByTok.get(`${mkt}:${e.token_id}`);
      if (prev) { const sg = prev.segments[prev.segments.length - 1]; if (sg && sg.to_ts == null) { sg.to_ts = e.timestamp; sg.to_height = Number(e.height); sg.end_reason = 'relisted'; } prev.outcome = 'delisted'; prev.closed_by = VERSION; if (prev.listing_ref != null) openByRef.delete(`${mkt}:${prev.listing_ref}`); closed++; }
      const rec = { token_id: String(e.token_id), marketplace: mkt,
        listing_ref: ref, seller: e.seller || null,
        segments: [{ price: e.reserve_price != null ? String(e.reserve_price) : null,
          denom: e.denom || null, denom_symbol: symbolFor(e.denom), from_ts: e.timestamp, from_height: Number(e.height),   // 1.3.0
          to_ts: null, end_reason: 'still_listed' }],
        listing_type: e.listing_type || null, outcome: 'active', create_tx: e.txhash,
        captured_by: VERSION };
      recs.push(rec); opened++;
      if (ref != null) { openByRef.set(`${mkt}:${ref}`, rec); seenRef.add(`${mkt}:${ref}`); }
      seenCreateTx.add(`${e.txhash}|${e.token_id}`);
      openByTok.set(`${mkt}:${e.token_id}`, rec);
    } else if (e.action === 'cancel' || e.action === 'sale' || e.action === 'exit') {
      const ref = e.auction_id != null ? String(e.auction_id) : null;
      const rec = (ref != null && openByRef.get(`${mkt}:${ref}`)) || openByTok.get(`${mkt}:${e.token_id}`) || null;
      if (!rec) { if (e.action !== 'exit') unmatched++; continue; }    // warned by caller — never invent a record (an exit with nothing open is nothing)
      const seg = rec.segments[rec.segments.length - 1];
      if (seg && seg.to_ts == null) {
        seg.to_ts = e.timestamp; seg.to_height = Number(e.height);
        seg.end_reason = e.action === 'sale' ? 'sale' : e.action === 'exit' ? 'venue_exit' : 'delist';
      }
      rec.outcome = e.action === 'sale' ? 'sold' : e.action === 'exit' ? 'unknown' : 'delisted';
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
  return { opened, closed, unmatched, total: recs.length, stamped: stampedSegs };
}

// ---- 3b. the ledger → maintenance events (1.6.0) ---------------------------------
// A ledger record (org-nft-flows classify.js) becomes the event shape appendEnrichedSales / maintainListingHistory have
// always consumed. Nothing is inferred: seller = from, buyer = to, the split legs name the fee (the venue's fee wallet
// from venues.json), the royalty (any other non-seller leg) and the seller's net. Superseded rows are never events.
const bareDenom = (d) => DS.bare(d);
const VENUE_MARKET = { bbl: 'BBL', atrium: 'Atrium', boost: 'Boost' };
function ledgerToEvents(rows, venues) {
  const feeWallets = {}; for (const [k, v] of Object.entries((venues && venues.venues) || {})) if (v && v.fee_wallet) feeWallets[k] = v.fee_wallet;
  const labelOf = (k) => VENUE_MARKET[k] || ((venues && venues.venues && venues.venues[k] && venues.venues[k].label) || k || 'BBL');
  const out = [];
  for (const r of rows || []) {
    if (!r || r.superseded_by || r.token_id == null) continue;
    const base = { txhash: r.txhash, height: Number(r.height), timestamp: String(r.ts || '').slice(0, 19) + 'Z', token_id: String(r.token_id),
      auction_id: r.auction_id != null ? r.auction_id : (r.listing_id != null ? r.listing_id : null), contract_label: labelOf(r.venue), venue: r.venue,
      msg_index: Number(r.msg_index) || 0, k: `${r.txhash}|${r.msg_index}|${r.kind}`, schemaVersion: 2 };
    if (r.kind === 'sale') {
      const seller = r.from || null, fee = feeWallets[r.venue] || null; let mfee = null, roy = null, royTo = null, net = null;
      if (r.split && Array.isArray(r.split.legs)) {   // BBL: the settle's transfer legs, attributed by recipient
        for (const l of r.split.legs) { if (fee && l.to === fee) mfee = l.amount; else if (seller && l.to === seller) net = l.amount; else if (roy == null) { roy = l.amount; royTo = l.to; } }
      } else if (r.split && (r.split.fee != null || r.split.royalty != null || r.split.seller != null)) {   // Boost / Atrium: the contract's own split attributes
        mfee = r.split.fee != null ? String(r.split.fee) : null; roy = r.split.royalty != null ? String(r.split.royalty) : null; net = r.split.seller != null ? String(r.split.seller) : null;
      }
      out.push({ ...base, action: 'sale', seller, buyer: r.to || null, denom: r.price ? bareDenom(r.price.denom) : null, gross_amount: r.price ? r.price.amount : null,
        seller_net: net, marketplace_fee: mfee, royalty_fee: roy, royalty_recipient: royTo, via_offer: !!r.via_offer });
    } else if (r.kind === 'list') {
      out.push({ ...base, action: 'list', seller: r.from || null, reserve_price: r.price ? r.price.amount : null, denom: r.price ? r.price.denom : null /* listing segments keep the chain spelling (cw20:…), as the committed records do */, listing_type: r.auction_type || r.listing_type || null });
    } else if (r.kind === 'delist') {
      out.push({ ...base, action: 'cancel', seller: r.to || null });
    } else if (r.kind === 'venue_out') {
      out.push({ ...base, action: 'exit', note: r.note || null });   // a venue release the classifier could not name: closes the record as unknown, never as a sale or a delist
    }
  }
  return out;
}
// 1.6.0: marketOf reads the venue key first (the ledger names it); the label regex stays for the v2 shapes the gates feed
function marketOfEvent(e) { return (e.venue && VENUE_MARKET[e.venue]) || (e.contract_label && /atrium/i.test(e.contract_label) ? 'Atrium' : e.contract_label && /boost|launch/i.test(e.contract_label) ? 'Boost' : (e.venue && !VENUE_MARKET[e.venue] ? e.contract_label : 'BBL')); }

// ---- 4. unresolved-exit sentinel -------------------------------------------
// THE "NEVER AGAIN" INVARIANT. Every NFT that leaves a marketplace contract did so as a SALE or a DELIST — there is no
// third thing. 1.6.0: the ledger already says so — a venue release the classifier could not name is a live `venue_out`
// row ("venue release without a known verb"); a later repair supersedes it with the sale/delist it was (the #745 case),
// and superseded rows never count. So the sentinel is: live venue_out rows inside the window.
function findUnresolvedExits(monthRows, sinceIso) {
  const exits = [];
  for (const rows of Object.values(monthRows)) for (const r of (rows || [])) {
    if (r.kind === 'venue_out' && !r.superseded_by && String(r.ts) > sinceIso) exits.push({ txhash: r.txhash, token_id: String(r.token_id), from: r.from, timestamp: String(r.ts).slice(0, 19) + 'Z', note: r.note || null, venue: r.venue || null });
  }
  return exits;
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
  console.log(`\n${VERSION} — market-history maintenance from the ledger (${LEDGER_PATH})`);
  try { RESOLVE = DS.buildResolver(await fetchJson(RAW_DATA('token-catalog/snapshots/current.json'))); console.log(`  token-catalog: ${RESOLVE.size} denoms resolvable`); } catch (e) { console.warn('  ⚠ token-catalog read failed — DENOM_MAP fallback in force: ' + e.message); }
  const [ix, venues, manifest] = await Promise.all([fetchJson(RAW(`${LEDGER_PATH}/index.json`)), fetchJson(RAW('venues.json')), fetchJson(RAW(`${NFT_ROOT}/collection.json`))]);
  if (!ix || !Array.isArray(ix.months)) { console.warn(`  ✗ ${LEDGER_PATH}/index.json unreadable or no months — honest skip (no ledger, no market history)`); return; }
  let [enr, lh] = await Promise.all([fetchJson(RAW(`${NFT_PATH}/sales-enriched.json`)), fetchJson(RAW(`${NFT_PATH}/listing-history.json`))]);
  // 1.6.0: a collection with no market-history yet is SEEDED from its whole ledger (B.6). Both docs or neither: a half seed is a phantom.
  const seed = !enr && !lh;
  if (!seed && (!enr || !lh)) { console.error('  ✗ one committed doc is unreadable and the other is not — honest skip (no partial maintenance)'); return; }
  const slug = (ix.collection || NFT_ROOT.split('/').pop());
  if (seed) {
    console.log(`  no sales-enriched / listing-history for ${slug} — seeding both from the ledger (${ix.months.length} months, ${ix.total} records)`);
    enr = { schemaVersion: 1, collection: slug, builtAt: new Date().toISOString(), built_from: `${LEDGER_PATH} (org-nft-flows ledger, ${VERSION})`, spot_luna_usd: null, count: 0, sales: [] };
    lh = { schemaVersion: 1, builtAt: new Date().toISOString(), source: `${LEDGER_PATH} (org-nft-flows ledger: list opens, delist/sale closes; ${VERSION})`, nft_contract: (manifest && manifest.nft_contract) || null,
      note: 'One record per marketplace listing. BBL price changes are cancel+recreate on-chain, so each auction_id is one price segment. Outcomes: sold (matched sale), delisted (token left the marketplace, no sale), active (still escrowed + live), unknown.',
      counts: {}, live_listings_missing_create: [], count: 0, records: [] };
  }
  // months to walk: the forward window (enriched tail − 32 d → today) unless seeding or SCAN_ALL — then every ledger month, in order
  const lastSale = enr.sales.map(s => s.timestamp).sort().pop() || null;
  const scanFrom = lastSale ? new Date(Date.parse(lastSale) - 32 * 86400000).toISOString().slice(0, 10) : null;
  const all = (seed || SCAN_ALL || !scanFrom);
  const months = ix.months.map(m => m.replace('/', '-')).filter(m => all || m >= scanFrom.slice(0, 7)).sort();
  console.log(`  scan: ${all ? 'every ledger month' : `from ${scanFrom}`} → ${months.length} month(s)`);
  // today's spot (latest LUNA day in the current oracle month, else the previous) — value_today_usd for rows added this run
  const spotLuna = { day: null, usd: null };
  for (const back of [0, 1]) { const d = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - back, 1)); const mk = `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}`; const mon = await fetchJson(RAW_DATA(`${PRICE_PATH}/${mk}.json`)); const days = Object.keys((mon && mon.days) || {}).filter(dd => mon.days[dd].LUNA && mon.days[dd].LUNA.usd != null).sort(); if (days.length) { spotLuna.day = days[days.length - 1]; spotLuna.usd = mon.days[spotLuna.day].LUNA.usd; break; } }
  const denomLearned = {};
  for (const s of enr.sales) if (s.denom && s.denom_symbol && !DENOM_MAP[s.denom]) denomLearned[s.denom] = { symbol: s.denom_symbol, decimals: 6 };
  const sres = { added: 0, skippedDup: 0, skippedAmbiguous: 0, unpriced: 0, total: enr.sales.length };
  const lres = { opened: 0, closed: 0, unmatched: 0, stamped: 0, total: lh.records.length };
  const sentinelSince = new Date(Date.now() - SENTINEL_WINDOW_DAYS * 86400000).toISOString();
  const sentinelMonths = new Set(monthsBetween(sentinelSince.slice(0, 10), today)); const sentinelRows = {};
  const blunaDaily = { daily: {} };   // unused since 1.4.0 (dayUsd reads the oracle); kept for the call signature
  // one ledger month + its oracle month in memory at a time (Render heap) — read → fold → drop
  for (const m of months) {
    const mk = m.replace('-', '/');
    const rows = await fetchJson(RAW(`${LEDGER_PATH}/${mk}.json`)); if (!Array.isArray(rows)) continue;
    const mon = await fetchJson(RAW_DATA(`${PRICE_PATH}/${mk}.json`));
    const priceMonths = { [m]: mon };
    const lunaDaily = { daily: {} }; for (const [d, row] of Object.entries((mon && mon.days) || {})) if (row.LUNA && row.LUNA.usd != null) lunaDaily.daily[d] = row.LUNA.usd;
    if (spotLuna.day) lunaDaily.daily[spotLuna.day] = spotLuna.usd;   // the spot rows added this run are valued at
    const ev = ledgerToEvents(rows, venues);
    const r1 = appendEnrichedSales(enr, ev.filter(e => e.action === 'sale'), lunaDaily, blunaDaily, priceMonths, denomLearned);
    const r2 = maintainListingHistory(lh, ev);
    for (const k of ['added', 'skippedDup', 'skippedAmbiguous', 'unpriced']) sres[k] += r1[k];
    for (const k of ['opened', 'closed', 'unmatched', 'stamped']) lres[k] += r2[k];
    if (r1.added || r2.opened || r2.closed) console.log(`  ${mk}: sales +${r1.added}${r1.unpriced ? ` (${r1.unpriced} unpriced)` : ''} · listings +${r2.opened}/−${r2.closed}${r2.unmatched ? ` · ⚠ ${r2.unmatched} unmatched close(s)` : ''}`);
    if (sentinelMonths.has(m)) sentinelRows[m] = rows.filter(r => r.kind === 'venue_out');
  }
  sres.total = enr.sales.length; lres.total = lh.records.length;
  if (spotLuna.usd != null) enr.spot_luna_usd = spotLuna.usd;
  console.log(`  sales-enriched: +${sres.added} (dup ${sres.skippedDup}, unpriced ${sres.unpriced}) → ${sres.total}`);
  console.log(`  listing-history: +${lres.opened} opened, ${lres.closed} closed${lres.unmatched ? `, ⚠ ${lres.unmatched} unmatched close(s)` : ''} → ${lres.total}`);
  // 4) unresolved-exit sentinel: live venue_out rows in the trailing window (the months above cover it; fetch any missing)
  for (const m of sentinelMonths) if (!(m in sentinelRows)) { const rows = await fetchJson(RAW(`${LEDGER_PATH}/${m.replace('-', '/')}.json`)); sentinelRows[m] = Array.isArray(rows) ? rows.filter(r => r.kind === 'venue_out') : []; }
  const unresolved = findUnresolvedExits(sentinelRows, sentinelSince);
  if (unresolved.length) {
    console.warn(`  ⚠⚠ SENTINEL: ${unresolved.length} marketplace exit(s) in the last ${SENTINEL_WINDOW_DAYS}d the ledger could not name as a sale or delist (live venue_out rows) — coverage holes:`);
    for (const e of unresolved.slice(0, 20)) console.warn(`     ${e.timestamp.slice(0, 10)} #${e.token_id} tx ${e.txhash.slice(0, 10)}… from …${String(e.from || '').slice(-6)}${e.note ? ' — ' + e.note : ''}`);
    if (unresolved.length > 20) console.warn(`     … and ${unresolved.length - 20} more`);
  } else console.log(`  ✓ sentinel: every marketplace exit in the last ${SENTINEL_WINDOW_DAYS}d is a sale or a delist on the ledger`);

  // publish (changed docs only; a seed publishes both)
  if (seed || sres.added) await publish(`${NFT_PATH}/sales-enriched.json`, enr, `market-history: ${seed ? 'seed' : '+' + sres.added + ' sales'} (→ ${sres.total})`);
  else console.log('  sales-enriched unchanged — skipped publish');
  if (seed || lres.opened || lres.closed || lres.stamped) await publish(`${NFT_PATH}/listing-history.json`, lh, `market-history: ${seed ? 'seed' : 'listings +' + lres.opened + '/−' + lres.closed}${lres.stamped ? ` · denom_symbol on ${lres.stamped} segment(s)` : ''}`);
  else console.log('  listing-history unchanged — skipped publish');
  await publish(`${NFT_PATH}/market-history-heartbeat.json`, {
    schemaVersion: 1, cron: 'nft-market-history', version: VERSION, status: 'ok',
    capturedAt: new Date().toISOString(), source: LEDGER_PATH, seeded: seed, months_scanned: months.length,
    stats: { sales_added: sres.added, sales_unpriced: sres.unpriced, sales_total: sres.total,
      listings_opened: lres.opened, listings_closed: lres.closed, unmatched_closes: lres.unmatched, listings_total: lres.total,
      unresolved_exits: unresolved.length,
      unresolved_exit_txs: unresolved.slice(0, 20).map(e => ({ tx: e.txhash, token_id: e.token_id, at: e.timestamp, note: e.note })) },
    sentinel_window_days: SENTINEL_WINDOW_DAYS,
  }, 'market-history heartbeat');
  console.log('  done');
}

module.exports = { main, fillDailyFromPriceHistory, appendEnrichedSales, maintainListingHistory, findUnresolvedExits, ledgerToEvents, marketOfEvent, DENOM_MAP, symbolFor, _setResolver: (r) => { RESOLVE = r; }, PATHS: { GITHUB_REPO, DATA_REPO, NFT_ROOT, NFT_PATH, LEDGER_PATH, PRICE_PATH, RAW, RAW_DATA } };
if (require.main === module) main().catch(e => { console.error('market-history failed:', e.message); process.exit(1); });
