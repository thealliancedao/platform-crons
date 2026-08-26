// =============================================================================
// dex-data / lib / credia-rates.js — Credia RATE HISTORY sidecar (dex-data 1.3.2)
// =============================================================================
// The chain query {"metrics":{}} (dexes/credia.js) is the truth for the current
// hour and the daily snapshots keep one point a day. Credia's app draws its
// charts from an OFF-CHAIN indexer — GraphQL `historyGranularity(market, from,
// pointsPerDay)` at api.creda.finance — with hourly points per market:
// borrow_apr, supply_apr, utilization, totals, oracle price. This module pulls
// that series every run and keeps it, so history exists when a chart or a
// look-back wants it, and publishes the 7-day ranges the site reads live.
//
// Laws: labeled off-chain source (`source` on every file); grow-only monthly
// files merged by (market, created) — an existing point is never overwritten
// (prior-verbatim); never-shrink asserted before write; a failed read of the
// existing month aborts the merge for that month (absent ≠ failed); isolated —
// its failure never affects the core snapshot run. Read-before-write goes
// through the Contents API (read-after-write consistent), not the raw CDN.
//
// Products:
//   dex-data/credia/rates/<yyyy>/<mm>.json  { meta, markets: { <denom>: [point…] } }
//   dex-data/credia/rates/current.json       per-market last-7-day ranges + latest
// =============================================================================

const GRAPHQL = process.env.CREDIA_GRAPHQL || 'https://api.creda.finance/api/graphql';
const WINDOW_DAYS = Number(process.env.CREDIA_RATES_WINDOW_DAYS || 8);
const SOURCE = 'credia indexer — api.creda.finance GraphQL historyGranularity (OFF-CHAIN; chain truth is dex-data/credia/snapshots)';
const QUERY = 'query market($market: String!, $from: DateTime!, $pointsPerDay: Int!) { historyGranularity(market: $market, from: $from, pointsPerDay: $pointsPerDay) { created denom price price_healthy borrow_apr supply_apr supply_index borrow_index utilization total_borrow total_supply total_collateral reserve } }';

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const monthKey = (iso) => iso.slice(0, 7);

function normalize(p) {
  return { t: p.created, price: num(p.price), price_healthy: p.price_healthy == null ? null : !!p.price_healthy, borrow_apr: num(p.borrow_apr), supply_apr: num(p.supply_apr), utilization: num(p.utilization),
    total_borrow: p.total_borrow == null ? null : String(p.total_borrow), total_supply: p.total_supply == null ? null : String(p.total_supply), total_collateral: p.total_collateral == null ? null : String(p.total_collateral), reserve: p.reserve == null ? null : String(p.reserve), supply_index: num(p.supply_index), borrow_index: num(p.borrow_index) };
}

// Merge incoming points into an existing month doc: keyed by (market, t); existing wins; sorted by t.
function mergeMonth(existing, incomingByMarket, nowIso) {
  const doc = existing && existing.markets ? existing : { meta: null, markets: {} };
  let added = 0, kept = 0;
  for (const [market, pts] of Object.entries(incomingByMarket)) {
    const cur = doc.markets[market] || []; const seen = new Set(cur.map(p => p.t));
    for (const p of pts) { if (seen.has(p.t)) { kept++; continue; } cur.push(p); seen.add(p.t); added++; }
    cur.sort((a, b) => a.t < b.t ? -1 : a.t > b.t ? 1 : 0); doc.markets[market] = cur;
  }
  doc.meta = { module: 'dex-data/credia/rates', format_version: 1, source: SOURCE, granularity: 'hourly (pointsPerDay 24)', updated_at: nowIso, markets: Object.keys(doc.markets).length, points: Object.values(doc.markets).reduce((s, a) => s + a.length, 0) };
  return { doc, added, kept };
}
function countPoints(doc) { return doc && doc.markets ? Object.values(doc.markets).reduce((s, a) => s + a.length, 0) : 0; }

// 7-day ranges per market from the merged docs (this month + previous month).
function buildCurrent(docs, markets, nowMs) {
  const cutoff = nowMs - 7 * 86400000; const out = {};
  for (const m of markets) {
    const pts = [].concat(...docs.map(d => (d && d.markets && d.markets[m]) || [])).filter(p => Date.parse(p.t) >= cutoff).sort((a, b) => a.t < b.t ? -1 : 1);
    if (!pts.length) { out[m] = { points_7d: 0 }; continue; }
    const rng = (k) => { const v = pts.map(p => p[k]).filter(x => x != null); return v.length ? { min: Math.min(...v), max: Math.max(...v), latest: pts[pts.length - 1][k], first: pts[0][k] } : null; };
    out[m] = { points_7d: pts.length, from: pts[0].t, to: pts[pts.length - 1].t, borrow_apr: rng('borrow_apr'), supply_apr: rng('supply_apr'), utilization: rng('utilization'), price: rng('price'), price_healthy_all: pts.every(p => p.price_healthy !== false) };
  }
  return out;
}

async function fetchMarket(httpRequest, market, fromIso) {
  const body = JSON.stringify({ operationName: 'market', variables: { market, from: fromIso, pointsPerDay: 24 }, query: QUERY });
  const res = await httpRequest(GRAPHQL, { method: 'POST', body, headers: { Accept: 'application/json' }, timeoutMs: 20000 });
  const j = JSON.parse(res.body); const arr = j && j.data && j.data.historyGranularity;
  if (!Array.isArray(arr)) throw new Error(`no historyGranularity for ${market.slice(0, 16)}: ${String(res.body).slice(0, 120)}`);
  return arr.map(normalize).filter(p => p.t);
}

// runCrediaRates({ markets, httpRequest, readJson, writeJson, now }) → { status, markets, added, kept, files }
//   readJson(repoPath) → object | null (404) | throws (failure)     writeJson(repoPath, obj)
async function runCrediaRates({ markets, httpRequest, readJson, writeJson, now = new Date() }) {
  const nowIso = now.toISOString(); const fromIso = new Date(now.getTime() - WINDOW_DAYS * 86400000).toISOString();
  const byMonth = {}; const errors = []; let fetched = 0;
  for (const m of markets) {
    try { const pts = await fetchMarket(httpRequest, m, fromIso); fetched++; for (const p of pts) { const mk = monthKey(p.t); (byMonth[mk] = byMonth[mk] || {}); (byMonth[mk][m] = byMonth[mk][m] || []).push(p); } }
    catch (e) { errors.push({ market: m, error: String(e && e.message || e) }); }
  }
  if (!fetched) return { status: 'failed', error: 'no market answered', errors };
  const written = []; const docs = [];
  let added = 0, kept = 0;
  for (const [mk, incoming] of Object.entries(byMonth).sort()) {
    const [y, mo] = mk.split('-'); const repoPath = `dex-data/credia/rates/${y}/${mo}.json`;
    let existing; try { existing = await readJson(repoPath); } catch (e) { errors.push({ month: mk, error: 'read failed — merge skipped (absent ≠ failed): ' + String(e && e.message || e) }); continue; }
    const before = countPoints(existing);
    const { doc, added: a, kept: k } = mergeMonth(existing, incoming, nowIso); added += a; kept += k;
    if (countPoints(doc) < before) throw new Error(`never-shrink violated for ${repoPath}: ${before} → ${countPoints(doc)}`);
    docs.push(doc);
    if (a > 0 || !existing) { await writeJson(repoPath, doc); written.push(repoPath); }
  }
  const current = { meta: { module: 'dex-data/credia/rates', format_version: 1, source: SOURCE, generated_at: nowIso, window_days: 7, markets: markets.length, markets_answered: fetched, errors: errors.length ? errors : null }, ranges: buildCurrent(docs, markets, now.getTime()) };
  await writeJson('dex-data/credia/rates/current.json', current); written.push('dex-data/credia/rates/current.json');
  return { status: errors.length ? 'partial' : 'ok', markets: markets.length, answered: fetched, added, kept, files: written, errors, current };
}

module.exports = { runCrediaRates, mergeMonth, buildCurrent, normalize, SOURCE, GRAPHQL };
