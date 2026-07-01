// =============================================================================
// NFT Flows Cron — event capture (live today.json + monthly history)
// =============================================================================
// Companion to index.js (the heavy inventory cron). Where index.js captures
// STATE ("how the collection is right now"), flows.js captures EVENTS ("what
// happened, as it happens") — sales, listings, delistings, bids, stakes,
// unstakes, breaks, transfers, floor/backing changes.
//
// TWO SPEEDS (RUN_SPEED env):
//   • 'fast' (every ~15 min): marketplace events (sale/listing/delist/bid) +
//     floor + backing. Cheap — lifts fetchMarketplaces/fetchBackingData/
//     fetchPriceData from index.js. Keeps today.json fresh for live site feeds.
//   • 'state' (hourly): ownership/state events (stake/unstake/break/transfer)
//     by diffing the roster (nfts.json + staker sets). Heavier, less frantic.
//   • 'rollup' (once daily, ~23:55): finalize today.json → one dated entry in
//     flows/YYYY/MM.json, then reset today.json for the new day.
//
// STORAGE (mirrors price-history's shape):
//   flows/today.json        ← live: accumulating events[] + current_state{}
//   flows/YYYY/MM.json      ← permanent: one rich entry per day (events + summary)
//   flows/heartbeat.json    ← standard freshness contract
//
// DOCTRINE: honest data. Events are only recorded when actually detected (a
// diff or a marketplace delta). No fabrication. today.json accumulates through
// the day so nothing is missed between refreshes; the rollup collapses it.
// =============================================================================

const https = require('https');
const fs = require('fs');
const path = require('path');

// Reuse the PROVEN fetchers from the inventory cron — never reinvent them.
const inv = require('./index.js');
const {
  fetchMarketplaces, fetchBackingData, fetchPriceData,
  fetchEnterpriseStakers, fetchDaodaoStakers, ADAO_NFT_CONTRACT,
} = inv;

// ---- config ----
const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
const GITHUB_REPO   = process.env.GITHUB_REPO   || 'thealliancedao/tla-core';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const OUTPUT_PATH   = 'nfts/adao/flows';
const RUN_SPEED     = (process.env.RUN_SPEED || 'fast').toLowerCase(); // fast | state | rollup

const RAW = (p) => `https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_BRANCH}/${p}?t=${Date.now()}`;
const TODAY_PATH   = `${OUTPUT_PATH}/today.json`;
const NFTS_URL     = RAW('nfts/adao/snapshots/nfts.json');
const VERSION      = 'nft-flows-0.1.2';  // 0.1.2: baseline vs real-event fix (standing listings not counted as today's events)

// ---- small utils ----
function todayStr(d = new Date()) { return d.toISOString().slice(0, 10); }
function monthPath(dateStr) { const [y, m] = dateStr.split('-'); return `${OUTPUT_PATH}/${y}/${m}.json`; }
function nowIso() { return new Date().toISOString(); }

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'nft-flows/0.1' }, timeout: 30000 }, (res) => {
      if (res.statusCode === 404) { res.resume(); return resolve(null); }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} ${url}`)); }
      let d = ''; res.on('data', c => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('timeout')); });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// today.json shape:
//   { date, updated_at, version,
//     events: [ {time, type, token_id, ...typed fields} ],   // accumulates all day
//     listing_index: { "MKT:internal_id": {token_id,price_raw,denom,seller} },
//       // snapshot of the last-seen listing set, so next run can diff
//     current_state: { floor_by_tier, listed_counts, backing, prices, ... } }
// Event types: sale, listing, delisting, price_change, bid,
//              stake, unstake, break, transfer.
// ─────────────────────────────────────────────────────────────────────────────

function emptyToday(dateStr, carryListingIndex = null) {
  return {
    date: dateStr, updated_at: nowIso(), version: VERSION,
    // carry the prior day's listing set forward as this day's baseline, so the
    // FIRST run of a new day can already detect overnight changes (rather than
    // re-recording every standing listing as a fake "new listing").
    events: [], listing_index: carryListingIndex || {}, staker_index: null,
    current_state: {},
  };
}

// Load today.json; if it's for a prior date (missed rollup), we still return it
// so the caller can roll it up first. Null → none exists yet.
async function loadToday() {
  try { return await httpGetJson(RAW(TODAY_PATH)); }
  catch { return null; }
}

// Build a listing_index keyed by "MKT:internal_id" from a flat listings array.
function indexListings(listings) {
  const idx = {};
  for (const l of listings) {
    const key = `${l.marketplace}:${l.internal_id}`;
    idx[key] = {
      token_id: String(l.token_id),
      price_raw: l.price_raw != null ? String(l.price_raw) : null,
      denom: l.denom || null,
      seller: l.seller || null,
      listing_type: l.listing_type || null,
    };
  }
  return idx;
}

// Diff prior listing_index vs current → listing / delisting / price_change events.
// NOTE: a delisting is EITHER a sale or a cancel. We can't tell from listings
// alone; the 'state' pass (or a future sales feed) reconciles delisting→sale.
// Here we emit 'delisting' and let the rollup/sales-join upgrade it if it was a sale.
function diffListings(priorIdx, curIdx, t) {
  const events = [];
  const prior = priorIdx || {};
  // new + changed
  for (const [key, cur] of Object.entries(curIdx)) {
    const was = prior[key];
    if (!was) {
      events.push({ time: t, type: 'listing', token_id: cur.token_id,
        marketplace: key.split(':')[0], price_raw: cur.price_raw,
        denom: cur.denom, seller: cur.seller, listing_type: cur.listing_type });
    } else if (was.price_raw !== cur.price_raw) {
      events.push({ time: t, type: 'price_change', token_id: cur.token_id,
        marketplace: key.split(':')[0], from_price_raw: was.price_raw,
        to_price_raw: cur.price_raw, denom: cur.denom });
    }
  }
  // gone → delisting (sale or cancel; reconciled later)
  for (const [key, was] of Object.entries(prior)) {
    if (!curIdx[key]) {
      events.push({ time: t, type: 'delisting', token_id: was.token_id,
        marketplace: key.split(':')[0], price_raw: was.price_raw, denom: was.denom });
    }
  }
  return events;
}

function countByMarket(listings) {
  const c = {};
  for (const l of listings) c[l.marketplace] = (c[l.marketplace] || 0) + 1;
  return c;
}

// FAST PASS: marketplace events + floor/backing current_state. ~15 min cadence.
async function runFast(doc) {
  const t = nowIso();
  const mk = await fetchMarketplaces();
  // fetchMarketplaces returns { bbl, atrium, boost, listingWarnings } — three
  // arrays, each item already carrying its own `marketplace` field. Flatten them.
  const listings = [
    ...(mk.bbl || []),
    ...(mk.atrium || []),
    ...(mk.boost || []),
  ];
  const curIdx = indexListings(listings);

  // BASELINE vs EVENT distinction:
  //   • If we have NO prior listing_index yet (cold start / first run of the day),
  //     the currently-live listings are STANDING STATE, not things that happened
  //     today — so we record them as the baseline WITHOUT emitting events.
  //   • Once a baseline exists, only CHANGES from it (new listing, delisting,
  //     price change) are real events. That's what the live feed cares about.
  const hasBaseline = doc.listing_index && Object.keys(doc.listing_index).length > 0;
  let listingEvents = [];
  if (hasBaseline) {
    listingEvents = diffListings(doc.listing_index, curIdx, t);
    doc.events.push(...listingEvents);
  } else {
    console.log(`  baseline set: ${listings.length} standing listings recorded (not counted as today's events)`);
  }
  doc.listing_index = curIdx;
  doc.baseline_set_at = doc.baseline_set_at || t;

  // backing + prices for current_state (cheap)
  let backing = null, prices = null;
  try { prices = await fetchPriceData(); } catch (e) { console.warn('  ⚠ price:', e.message); }
  // unbroken count isn't known in the fast pass (no roster) — backing balance still useful
  try { backing = await fetchBackingData(0); } catch (e) { console.warn('  ⚠ backing:', e.message); }

  doc.current_state = {
    ...doc.current_state,
    updated_at: t,
    listed_counts: countByMarket(listings),
    listings_total: listings.length,
    ampluna_balance: backing ? backing.ampluna_balance : (doc.current_state.ampluna_balance ?? null),
    luna_usd: prices ? prices.luna_usd : (doc.current_state.luna_usd ?? null),
    ampluna_usd: prices ? prices.ampluna_usd : (doc.current_state.ampluna_usd ?? null),
  };
  doc.updated_at = t;
  console.log(`  fast: ${listingEvents.length} listing events, ${listings.length} live listings`);
  return doc;
}

// ─── GitHub write helpers (verbatim from the proven token-catalog cron) ──────
function githubApiRequest(method, apiPath, body = null) {
  return new Promise((resolve, reject) => {
    const opts = { hostname: 'api.github.com', path: apiPath, method,
      headers: { 'User-Agent': 'nft-flows-cron/0.1', 'Authorization': `Bearer ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github+json' } };
    if (body) opts.headers['Content-Type'] = 'application/json';
    const req = https.request(opts, res => {
      let data = ''; res.on('data', c => data += c);
      res.on('end', () => { let parsed = data; try { parsed = JSON.parse(data); } catch {} resolve({ status: res.statusCode, body: parsed, raw: data }); });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}
async function publishFile(filePath, content, message, maxAttempts = 5) {
  const apiPath = `/repos/${GITHUB_REPO}/contents/${filePath}`;
  const b64 = Buffer.from(content).toString('base64');
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let sha = null;
    const getRes = await githubApiRequest('GET', apiPath + `?ref=${GITHUB_BRANCH}`);
    if (getRes.status >= 200 && getRes.status < 300) sha = getRes.body && getRes.body.sha;
    const body = { message, content: b64, branch: GITHUB_BRANCH };
    if (sha) body.sha = sha;
    const putRes = await githubApiRequest('PUT', apiPath, body);
    if (putRes.status >= 200 && putRes.status < 300) return putRes.body;
    if (putRes.status === 409 || putRes.status === 422) {
      lastErr = new Error(`PUT ${filePath}: ${putRes.status} (sha conflict ${attempt}/${maxAttempts})`);
      await new Promise(r => setTimeout(r, 300 * attempt + Math.floor(Math.random() * 400)));
      continue;
    }
    throw new Error(`PUT ${filePath}: ${putRes.status} ${String(putRes.raw).slice(0, 200)}`);
  }
  throw lastErr || new Error(`PUT ${filePath}: failed after ${maxAttempts} attempts`);
}

// ─── ROLLUP: collapse today.json → one dated entry in flows/YYYY/MM.json ──────
// Called by the 'rollup' pass (end of day). Summarizes the day's accumulated
// events into aggregates, merges into the month-file (per-day, merge-safe),
// then resets today.json for the new day.
function summarizeDay(doc) {
  const ev = doc.events || [];
  const byType = {};
  for (const e of ev) byType[e.type] = (byType[e.type] || 0) + 1;
  const sales = ev.filter(e => e.type === 'sale');
  const uniqueTraded = new Set(sales.map(s => s.token_id));
  const volLuna = sales.reduce((s, e) => s + (Number(e.price_luna) || 0), 0);
  const volUsd  = sales.reduce((s, e) => s + (Number(e.price_usd)  || 0), 0);
  return {
    event_count: ev.length,
    by_type: byType,
    sales_count: sales.length,
    sales_volume_luna: volLuna || null,
    sales_volume_usd: volUsd || null,
    unique_tokens_traded: uniqueTraded.size,
    new_listings: byType.listing || 0,
    delistings: byType.delisting || 0,
    price_changes: byType.price_change || 0,
    breaks: byType.break || 0,
    stakes: byType.stake || 0,
    unstakes: byType.unstake || 0,
    transfers: byType.transfer || 0,
    // end-of-day snapshot of current_state (floor/backing at close)
    close_state: doc.current_state || {},
  };
}

async function runRollup(doc) {
  const dateStr = doc.date;
  const summary = summarizeDay(doc);
  const dayEntry = { events: doc.events || [], summary, rolled_up_at: nowIso() };

  // merge into month-file (per-day merge-safe)
  const mp = monthPath(dateStr);
  let monthDoc = null;
  try { monthDoc = await httpGetJson(RAW(mp)); } catch { /* new month */ }
  if (!monthDoc || !monthDoc.days) monthDoc = { meta: { module: 'nft-flows', format_version: 1 }, days: {} };
  monthDoc.days[dateStr] = dayEntry;
  monthDoc.meta = { ...monthDoc.meta, module: 'nft-flows', format_version: 1, updated_at: nowIso() };

  if (GITHUB_TOKEN) {
    await publishFile(mp, JSON.stringify(monthDoc, null, 2),
      `nft-flows: rollup ${dateStr} (${summary.event_count} events, ${summary.sales_count} sales)`);
    console.log(`  ✓ rolled up ${dateStr} → ${mp} (${summary.event_count} events)`);
    // reset today.json for the NEW day — but carry the prior day's listing set
    // forward as the baseline, so day-1 runs detect overnight changes (not a
    // whole day of fake "new listings").
    const fresh = emptyToday(todayStr(), doc.listing_index);
    await publishFile(TODAY_PATH, JSON.stringify(fresh, null, 2), `nft-flows: reset today for ${fresh.date}`);
    console.log(`  ✓ reset today.json → ${fresh.date} (baseline carried: ${Object.keys(doc.listing_index || {}).length} listings)`);
  } else {
    console.log('  (no GITHUB_TOKEN — rollup computed but not published)');
    console.log('  summary:', JSON.stringify(summary));
  }
  return doc;
}

// ─── publish today.json (fast/state passes) ──────────────────────────────────
async function publishToday(doc) {
  doc.updated_at = nowIso();
  if (!GITHUB_TOKEN) { console.log('  (no GITHUB_TOKEN — today.json not published)'); return; }
  await publishFile(TODAY_PATH, JSON.stringify(doc), `nft-flows: today ${doc.date} (${doc.events.length} events)`);
  await publishFile(`${OUTPUT_PATH}/heartbeat.json`, JSON.stringify({
    schemaVersion: 1, cron: 'nft-flows', runSpeed: RUN_SPEED, status: 'ok',
    capturedAt: nowIso(), capturedAtUnix: Date.now(),
    stats: { events_today: doc.events.length, listings: doc.current_state?.listings_total ?? null },
  }, null, 2), `nft-flows heartbeat (${RUN_SPEED})`);
  console.log(`  ✓ today.json + heartbeat (${doc.events.length} events)`);
}

async function run() {
  console.log(`🌊 NFT Flows Cron ${VERSION} — speed=${RUN_SPEED} — ${nowIso()}`);
  const dateStr = todayStr();

  let doc = await loadToday();

  // SINGLE-CRON MODEL: every ~15-min run does the fast pass, and whenever the
  // date has flipped, that run FIRST rolls up the now-complete prior day into
  // its month-file and resets today.json. So the day's final run naturally
  // accumulates, and the first run after midnight finalizes it — no separate
  // rollup job, no counting runs, and it self-heals if a run is skipped.
  if (doc && doc.date && doc.date !== dateStr) {
    console.log(`  ↻ date flipped ${doc.date} → ${dateStr}: rolling up the complete prior day first`);
    const carry = doc.listing_index;   // preserve yesterday's listing set as today's baseline
    await runRollup(doc);              // finalizes prior day → month-file + resets today.json
    doc = emptyToday(dateStr, carry);  // start the new day with the baseline carried
  }
  if (!doc || doc.date !== dateStr) doc = emptyToday(dateStr, doc && doc.listing_index);

  // RUN_SPEED still selects WHICH capture this run does (both append to today.json):
  //   'fast'  (default, every run)  → marketplace events + floor/backing state
  //   'state' (Phase 2, less often) → stake/unstake/break/transfer via roster diff
  // 'rollup' remains available as a MANUAL/forced finalize if ever needed.
  if (RUN_SPEED === 'rollup') {
    if (doc && doc.events && doc.events.length) await runRollup(doc);
    else console.log('  (forced rollup: nothing to roll up)');
    return;
  }

  if (RUN_SPEED === 'fast') doc = await runFast(doc);
  // 'state' pass = Phase 2, appends to the same events[].

  await publishToday(doc);
  console.log(`  events accumulated today: ${doc.events.length}`);
}

if (require.main === module) {
  run().catch(e => { console.error('FATAL', e); process.exit(1); });
}
module.exports = { run };
