'use strict';
// =============================================================================
// nfts/nft-inventory / watch.js 1.0.0 (2026-10-13) — one small file per collection for a phone: each tier's floor, its 7-day average,
// the 24 h change, whether a fresh listing just set a new floor, and the average of the tier's last 3 sales (USD at the time of each sale).
// -----------------------------------------------------------------------------
// Owner (2026-10-13, a wallet dashboard's home NFT tiles): "follow the floor price of these collections in a compact way — 7d avg and 24 hr change,
// highlight if it was recently listed new FP … values based on FP of holdings … and avg of past 3 sales in USD at the time of the sale".
// A pure join over this job's own files — floor-history.json (daily per-tier listing floors), sales-enriched.json, listing-first-seen.json,
// nfts.json (each token's tier today) and collection.json (tier id sets). No chain reads.
// Tiers: a backed collection with a break mechanism → broken / base (unbroken, not a named tier) / named tiers (collection.json tiers,
// e.g. aDAO "phoenix"); otherwise every token is "base". Output: <NFT_ROOT>/snapshots/watch.json
// =============================================================================
const VERSION = 'nft-watch-1.0.0';
const num = (x) => (x == null || x === '' || !isFinite(Number(x))) ? null : Number(x);
const r2 = (x) => (x == null || !isFinite(x)) ? null : Math.round(x * 100) / 100;

function tierOfFactory(collection, records) {
  const named = new Map(); for (const [k, t] of Object.entries((collection && collection.tiers) || {})) for (const id of t.token_ids || []) named.set(String(id), k);
  const broken = new Set((records || []).filter(r => r && r.broken).map(r => String(r.id)));
  return (id) => broken.has(String(id)) ? 'broken' : named.get(String(id)) || 'base';
}

// pure: → { tiers: { <tier>: { floor_usd, floor_7d_avg_usd, change_24h_pct, new_floor, listed_count, last3: { avg_usd, sales[] } } } }
function computeWatch({ collection, records, floorRows, sales, firstSeen, now = new Date() }) {
  const tierOf = tierOfFactory(collection, records);
  const rows = (floorRows || []).filter(r => r && r.per_tier).sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const last = rows[rows.length - 1], prev = rows[rows.length - 2];
  const tiers = {};
  const names = new Set([...Object.keys((last && last.per_tier) || {}), ...Object.keys((collection && collection.tiers) || {}), 'base']);
  const fresh = new Set(Object.values((firstSeen && firstSeen.entries) || {}).filter(e => e && e.first_seen_at && Date.parse(e.first_seen_at) >= now.getTime() - 36 * 3600e3).map(e => tierOf(e.token_id)));
  for (const t of names) {
    const fl = (r) => num(r && r.per_tier && r.per_tier[t] && r.per_tier[t].listing_floor_usd);
    const f = fl(last), p = fl(prev);
    const wk = rows.slice(-7).map(fl).filter(v => v != null);
    const s = (sales || []).filter(x => x && x.token_id != null && num(x.notional_usd) > 0 && x.timestamp && tierOf(x.token_id) === t)
      .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp))).slice(0, 3);
    tiers[t] = {
      floor_usd: r2(f), floor_7d_avg_usd: wk.length ? r2(wk.reduce((a, v) => a + v, 0) / wk.length) : null, days_in_avg: wk.length,
      change_24h_pct: f != null && p != null && p > 0 ? r2((f / p - 1) * 100) : null,
      new_floor: !!(f != null && p != null && f < p && fresh.has(t)),
      listed_count: last && last.per_tier[t] ? num(last.per_tier[t].listed_count) : null,
      last3: s.length ? { avg_usd: r2(s.reduce((a, x) => a + num(x.notional_usd), 0) / s.length), n: s.length,
        sales: s.map(x => ({ token_id: String(x.token_id), at: x.timestamp, usd: r2(num(x.notional_usd)), marketplace: x.marketplace || null })) } : null,
    };
  }
  return { as_of: last ? last.date : null, tiers, method: 'floor = cheapest live listing of the tier (floor-history); 7d avg = mean of the last 7 daily floors; 24 h = today vs the day before; new_floor = the floor fell and a listing of that tier was first seen in the last 36 h; last3 = the tier\'s last 3 sales, USD at each sale\'s day (oracle)' };
}

async function run(deps) {
  const { readJson, publish, root, log = console.log, now = new Date() } = deps;
  const S = `${root}/snapshots`;
  const [collection, nfts, floor, enr, first] = await Promise.all([readJson(`${root}/collection.json`), readJson(`${S}/nfts.json`), readJson(`${S}/floor-history.json`), readJson(`${S}/sales-enriched.json`), readJson(`${S}/listing-first-seen.json`)]);
  if (!floor || !Array.isArray(floor.rows)) { log('  watch: no floor history — skipped'); return { status: 'skipped' }; }
  const body = computeWatch({ collection, records: (nfts && (nfts.records || (nfts.data && nfts.data.records))) || [], floorRows: floor.rows, sales: (enr && enr.sales) || [], firstSeen: first, now });
  const doc = { schemaVersion: 1, product: 'nfts/watch', version: VERSION, generated_at: now.toISOString(), collection: root, name: (collection && collection.name) || root, ...body };
  await publish(`${S}/watch.json`, doc, `nft watch: ${Object.entries(body.tiers).map(([t, x]) => `${t} ${x.floor_usd ?? '—'}`).join(' · ')}`);
  log(`  watch: ${Object.entries(body.tiers).map(([t, x]) => `${t} floor ${x.floor_usd ?? '—'} (7d ${x.floor_7d_avg_usd ?? '—'}, 24h ${x.change_24h_pct ?? '—'}%)${x.new_floor ? ' NEW' : ''}`).join(' · ')}`);
  return { status: 'ok', doc };
}
module.exports = { VERSION, computeWatch, tierOfFactory, run };
