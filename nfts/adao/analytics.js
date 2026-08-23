// =============================================================================
// nfts/adao/analytics.js
// =============================================================================
// Collection analytics for holder decision-making. Reads the inventory cron's
// outputs + the canonical rarity file and computes the metrics holders want:
//
//   - Floor price by rarity GRADE (1-40) — how floor tracks with rarity.
//   - Floor price by OBJECT trait (40 traits).
//   - Sales analytics (ALL-TIME, from existing sales-history.json back to 2023):
//       per grade & per object: count, avg price, total volume (LUNA + USD),
//       most-sold / most-sought-after.
//   - Backing-to-floor ratio (is a tier trading above/below its ampLUNA backing?).
//   - Rarity percentile surfaced per NFT ("rarer than X%").
//
// DESIGN: a SEPARATE module from the 2,200-line inventory cron — it READS that
// cron's outputs rather than touching its proven logic. Runs after the inventory
// cron (or on its own schedule). Honest nulls: a grade/object with too few
// listings or sales shows null, never a fabricated floor.
//
// All sales data ALREADY EXISTS (sales-history.json, captured back to 2023-12) —
// this is a JOIN, not a backfill. The rarity file maps every token_id -> grade +
// object + percentile.
// =============================================================================

const https = require('https');

const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
const GITHUB_REPO   = process.env.GITHUB_REPO || 'thealliancedao/tla-core';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const NFT_PATH = process.env.NFT_PATH || 'nfts/adao/snapshots';

// Canonical rarity metadata (token_id -> grade 1-40, object trait, percentile).
// ORG 2026-08-11: defipatriot/nft-metadata is DELETED (404). Rarity is a
// per-collection artifact and lives in the NFT tenant repo.
const RARITY_URL = process.env.RARITY_URL ||
  'https://raw.githubusercontent.com/thealliancedao/nft-collections/main/adao/rarity/adao-rarity-intended.json';

// Min samples before we publish a floor/median (else null — no fake floors).
const MIN_LISTINGS_FOR_FLOOR = 2;
const MIN_SALES_FOR_AVG = 2;

const VERSION = 'nft-analytics-1.0.0';

// ---- http ----
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'nft-analytics/1.0' }, timeout: 30000 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} ${url}`)); }
      let d = ''; res.on('data', c => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('timeout')); });
  });
}
const bust = (u) => u + (u.includes('?') ? '&' : '?') + 't=' + Date.now();

// ---- helpers ----
function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function lunaOf(sale) {
  const a = Number(sale.gross_amount);
  return Number.isFinite(a) && sale.denom === 'uluna' ? a / 1e6 : null;
}

async function main() {
  console.log(`${VERSION} — collection analytics`);

  // 1) Load inputs: rarity map, the cron's nfts.json, and sales history.
  const [rarityDoc, nftsDoc, salesDoc, enrichedDoc] = await Promise.all([
    fetchJson(bust(RARITY_URL)),
    fetchJson(bust(`https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_BRANCH}/${NFT_PATH}/nfts.json`)),
    fetchJson(bust(`https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_BRANCH}/${NFT_PATH}/sales-history.json`)).catch(() => null),
    // Per-sale enriched ledger — powers the EXPLORER analytics block below.
    fetchJson(bust(`https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_BRANCH}/${NFT_PATH}/sales-enriched.json`)).catch(() => null),
  ]);

  const rarity = rarityDoc.records || rarityDoc;
  const gradeByToken = new Map();
  const objectByToken = new Map();
  const pctByToken = new Map();
  for (const r of rarity) {
    gradeByToken.set(String(r.token_id), r.grade);
    objectByToken.set(String(r.token_id), r.object);
    pctByToken.set(String(r.token_id), r.percentile);
  }

  // nfts.json wraps its array under `records` (not `nfts`); fall back defensively.
  const nfts = nftsDoc.records || nftsDoc.nfts || (Array.isArray(nftsDoc) ? nftsDoc : []);
  // sales-history.json: array of sale records (newest-first); also tolerate wrappers.
  const sales = salesDoc ? (salesDoc.records || salesDoc.sales || (Array.isArray(salesDoc) ? salesDoc : [])) : [];
  console.log(`  inputs: ${rarity.length} rarity, ${nfts.length} nfts, ${sales.length} sales`);

  // 2) FLOOR BY GRADE + BY OBJECT (live listings from nfts.json).
  // Each NFT may carry a listing with a usd/luna price; bucket by grade & object.
  const listingsByGrade = new Map();   // grade -> [prices]
  const listingsByObject = new Map();
  const backingByGrade = new Map();    // grade -> [backing_usd] (for backing-to-floor)
  for (const n of nfts) {
    const tid = String(n.id ?? n.token_id);
    const grade = gradeByToken.get(tid);
    const object = objectByToken.get(tid);
    if (n.broken) continue; // unbroken only for rarity floors (your spec)
    // listing price (shape varies; try common fields)
    const lp = n.listing && (n.listing.price_usd ?? n.listing.notional_usd ?? n.listing.price);
    if (lp != null && grade != null) {
      if (!listingsByGrade.has(grade)) listingsByGrade.set(grade, []);
      listingsByGrade.get(grade).push(Number(lp));
      if (object) { if (!listingsByObject.has(object)) listingsByObject.set(object, []); listingsByObject.get(object).push(Number(lp)); }
    }
    // backing for backing-to-floor ratio
    const bk = n.backing_usd ?? n.backing ?? (n.backing_ampluna && n.backing_ampluna_usd);
    if (bk != null && grade != null) { if (!backingByGrade.has(grade)) backingByGrade.set(grade, []); backingByGrade.get(grade).push(Number(bk)); }
  }

  const floorByGrade = {};
  for (let g = 1; g <= 40; g++) {
    const ls = listingsByGrade.get(g) || [];
    const backs = backingByGrade.get(g) || [];
    const floor = ls.length >= MIN_LISTINGS_FOR_FLOOR ? Math.min(...ls) : null;
    const avgBacking = backs.length ? backs.reduce((a, c) => a + c, 0) / backs.length : null;
    floorByGrade[g] = {
      listed_count: ls.length,
      floor_usd: floor,
      median_listing_usd: ls.length >= MIN_LISTINGS_FOR_FLOOR ? median(ls) : null,
      avg_backing_usd: avgBacking != null ? Number(avgBacking.toFixed(2)) : null,
      // backing-to-floor: >1 means floor is BELOW backing (underpriced vs backing)
      backing_to_floor: (floor && avgBacking) ? Number((avgBacking / floor).toFixed(3)) : null,
    };
  }

  const floorByObject = {};
  for (const [obj, ls] of listingsByObject) {
    floorByObject[obj] = {
      listed_count: ls.length,
      floor_usd: ls.length >= MIN_LISTINGS_FOR_FLOOR ? Math.min(...ls) : null,
    };
  }

  // 3) SALES ANALYTICS (all-time, from sales-history.json).
  const salesByGrade = {};
  const salesByObject = {};
  let allTimeLuna = 0, allTimeCount = 0;
  const ensureG = (g) => (salesByGrade[g] ||= { count: 0, total_luna: 0, prices: [] });
  const ensureO = (o) => (salesByObject[o] ||= { count: 0, total_luna: 0, prices: [] });
  for (const s of sales) {
    const luna = lunaOf(s);
    if (luna == null) continue;
    allTimeLuna += luna; allTimeCount++;
    const tid = String(s.token_id);
    const g = gradeByToken.get(tid); const o = objectByToken.get(tid);
    if (g != null) { const e = ensureG(g); e.count++; e.total_luna += luna; e.prices.push(luna); }
    if (o != null) { const e = ensureO(o); e.count++; e.total_luna += luna; e.prices.push(luna); }
  }
  // finalize: avg + median per bucket
  for (const map of [salesByGrade, salesByObject]) {
    for (const k of Object.keys(map)) {
      const e = map[k];
      e.avg_luna = e.count >= MIN_SALES_FOR_AVG ? Number((e.total_luna / e.count).toFixed(2)) : null;
      e.median_luna = e.count >= MIN_SALES_FOR_AVG ? Number(median(e.prices).toFixed(2)) : null;
      e.total_luna = Number(e.total_luna.toFixed(2));
      delete e.prices; // don't bloat output
    }
  }
  // most-sold / most-sought-after rankings
  const mostSoldObjects = Object.entries(salesByObject)
    .sort((a, b) => b[1].count - a[1].count).slice(0, 20)
    .map(([object, v]) => ({ object, sales: v.count, avg_luna: v.avg_luna, total_luna: v.total_luna }));

  // 4) Output
  const out = {
    meta: {
      version: VERSION, generated_at: new Date().toISOString(),
      sales_window: sales.length ? { from: sales[sales.length - 1]?.timestamp, to: sales[0]?.timestamp, note: 'all-time from sales-history.json' } : null,
      note: 'Floors from live listings (unbroken). Sales analytics all-time from captured history. Honest nulls below sample thresholds.',
    },
    all_time: {
      total_sales: allTimeCount,
      total_volume_luna: Number(allTimeLuna.toFixed(2)),
    },
    floor_by_grade: floorByGrade,         // 1..40: listed_count, floor, backing-to-floor
    floor_by_object: floorByObject,        // per trait
    sales_by_grade: salesByGrade,          // count, avg, median, total LUNA
    sales_by_object: salesByObject,
    most_sold_objects: mostSoldObjects,    // sought-after ranking
  };

  await publish(`${NFT_PATH}/analytics.json`, out, 'nft-analytics: collection metrics');

  // ===========================================================================
  // EXPLORER BLOCK (added 2026-08-11) — nft-analytics.json
  // ---------------------------------------------------------------------------
  // nft-explorer-app.js REQUIRES a feed with volume/leaderboards/monthly/
  // royalties/flips/hold_time_days/denom_split/sale_number_distribution (it
  // throws without volume+leaderboards). Its legacy producer no longer exists
  // in any repo. Every field is derivable from sales-enriched.json, which the
  // org NFT cron already writes — so this is a JOIN, not new capture, and it
  // ships inside the same job rather than as another cron.
  // ===========================================================================
  const esales = (enrichedDoc && Array.isArray(enrichedDoc.sales)) ? enrichedDoc.sales : [];
  if (esales.length) {
    const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
    const sorted = [...esales].sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));

    const volume = {
      sales_count: esales.length,
      luna_equiv_total: Number(esales.reduce((s, x) => s + num(x.luna_equiv), 0).toFixed(2)),
      usd_at_sale: Number(esales.reduce((s, x) => s + num(x.notional_usd), 0).toFixed(2)),
      value_today_usd: Number(esales.reduce((s, x) => s + num(x.value_today_usd), 0).toFixed(2)),
      spot_luna_usd: enrichedDoc.spot_luna_usd ?? null,
      tokens: new Set(esales.map(x => x.token_id)).size,
      note: 'derived from sales-enriched.json (org NFT layer)',
    };

    const tally = (keyFn, valFn) => {
      const m = new Map();
      for (const x of esales) {
        const k = keyFn(x); if (k == null || k === '') continue;
        const e = m.get(k) || { count: 0, luna: 0, usd: 0 };
        e.count++; e.luna += num(x.luna_equiv); e.usd += num(valFn ? valFn(x) : x.notional_usd);
        m.set(k, e);
      }
      return m;
    };
    const rank = (m, keyName) => [...m.entries()]
      .sort((a, b) => b[1].luna - a[1].luna).slice(0, 20)
      .map(([k, v]) => ({ [keyName]: k, sales: v.count, luna: Number(v.luna.toFixed(2)), usd: Number(v.usd.toFixed(2)) }));

    const leaderboards = {
      top_buyers: rank(tally(x => x.buyer), 'address'),
      top_sellers: rank(tally(x => x.seller), 'address'),
      most_traded_tokens: [...tally(x => x.token_id).entries()]
        .sort((a, b) => b[1].count - a[1].count).slice(0, 20)
        .map(([token_id, v]) => ({ token_id, sales: v.count, luna: Number(v.luna.toFixed(2)) })),
    };

    const monthlyMap = new Map();
    for (const x of esales) {
      const mk = String(x.timestamp || '').slice(0, 7); if (mk.length !== 7) continue;
      const e = monthlyMap.get(mk) || { month: mk, sales: 0, luna: 0, usd: 0 };
      e.sales++; e.luna += num(x.luna_equiv); e.usd += num(x.notional_usd);
      monthlyMap.set(mk, e);
    }
    const monthly = [...monthlyMap.values()].sort((a, b) => a.month.localeCompare(b.month))
      .map(m => ({ ...m, luna: Number(m.luna.toFixed(2)), usd: Number(m.usd.toFixed(2)) }));

    const denom_split = {};
    for (const x of esales) {
      const d = x.denom_symbol || x.denom || 'unknown';
      denom_split[d] = denom_split[d] || { count: 0, luna: 0 };
      denom_split[d].count++; denom_split[d].luna = Number((denom_split[d].luna + num(x.luna_equiv)).toFixed(2));
    }

    const sale_number_distribution = {};
    for (const x of esales) {
      const n = x.sale_number; if (n == null) continue;
      const k = String(n);
      sale_number_distribution[k] = (sale_number_distribution[k] || 0) + 1;
    }

    const holds = esales.map(x => num(x.hold_days)).filter(h => h > 0).sort((a, b) => a - b);
    const hold_time_days = holds.length ? {
      count: holds.length,
      min: holds[0], max: holds[holds.length - 1],
      median: holds[Math.floor(holds.length / 2)],
      avg: Number((holds.reduce((s, h) => s + h, 0) / holds.length).toFixed(1)),
    } : {};

    // A "flip" = a sale whose hold_days is short. Threshold declared, not hidden.
    const FLIP_DAYS = 30;
    const flipSales = esales.filter(x => num(x.hold_days) > 0 && num(x.hold_days) <= FLIP_DAYS);
    const flips = {
      threshold_days: FLIP_DAYS,
      count: flipSales.length,
      pct_of_sales: esales.length ? Number((flipSales.length / esales.length * 100).toFixed(1)) : 0,
      luna: Number(flipSales.reduce((s, x) => s + num(x.luna_equiv), 0).toFixed(2)),
    };

    const spotLunaUsd = enrichedDoc && enrichedDoc.spot_luna_usd != null ? Number(enrichedDoc.spot_luna_usd) : null;
    const royaltySales = esales.filter(x => num(x.royalty_fee) > 0);
    // Denom-correct royalty totals. The old total_royalty_luna summed RAW
    // royalty_fee micro-units ACROSS denoms (uluna + ubLUNA + ...) — a unit-
    // mixing number no display could use honestly. Each sale's royalty share
    // is priced through that sale's own day pricing instead:
    //   royalty_luna  = Σ luna_equiv    × (royalty_fee / gross)
    //   royalty_usd_at_sale = Σ notional_usd × (royalty_fee / gross)
    const royShare = (x, base) => {
      const g = num(x.gross_amount); const r = num(x.royalty_fee);
      return (g > 0 && r > 0 && num(base) > 0) ? num(base) * (r / g) : 0;
    };
    const royaltyByDenom = {};
    for (const x of royaltySales) {
      const k = x.denom_symbol || x.denom || 'unknown';
      royaltyByDenom[k] = Number(((royaltyByDenom[k] || 0) + num(x.royalty_fee) / 1e6).toFixed(6));
    }
    const royaltyLuna = Number(royaltySales.reduce((s, x) => s + royShare(x, x.luna_equiv), 0).toFixed(6));
    const royalties = {
      sales_with_royalty: royaltySales.length,
      royalty_by_denom: royaltyByDenom,            // token units per payment denom
      royalty_luna: royaltyLuna,                   // LUNA-equiv, via each sale's day pricing
      royalty_usd_at_sale: Number(royaltySales.reduce((s, x) => s + royShare(x, x.notional_usd), 0).toFixed(2)),
      royalty_usd_today: spotLunaUsd != null ? Number((royaltyLuna * spotLunaUsd).toFixed(2)) : null,
      recipients: [...new Set(royaltySales.map(x => x.royalty_recipient).filter(Boolean))],
    };

    // Live listings grouped by marketplace, with each one's own floor. Uses the
    // inventory doc (complete), not the sales ledger (marketplace mostly null).
    const listingsByMarketplace = (() => {
      const out = {};
      const recs = Array.isArray(nftsDoc?.records) ? nftsDoc.records : Object.values(nftsDoc?.records || {});
      for (const r of recs) {
        const l = r && r.listing;
        if (!l) continue;
        const mk = l.marketplace || 'Unknown';
        const e = out[mk] || (out[mk] = { count: 0, floor_usd: null, denoms: {} });
        e.count++;
        const usd = Number(l.price_usd);
        if (Number.isFinite(usd) && usd > 0) {
          e.floor_usd = e.floor_usd == null ? usd : Math.min(e.floor_usd, usd);
        }
        const sym = l.price_token_symbol || l.denom || 'unknown';
        e.denoms[sym] = (e.denoms[sym] || 0) + 1;
      }
      for (const k of Object.keys(out)) {
        if (out[k].floor_usd != null) out[k].floor_usd = Number(out[k].floor_usd.toFixed(2));
      }
      return out;
    })();

    const explorer = {
      schemaVersion: 2,
      collection: enrichedDoc.collection ?? out.meta?.collection ?? 'adao',
      builtAt: new Date().toISOString(),
      source: 'org nfts/adao analytics.js — derived from sales-enriched.json',
      volume, leaderboards, monthly, denom_split, sale_number_distribution,
      hold_time_days, flips, royalties,
      // CURRENT listings by marketplace (added 2026-08-12). Derived from
      // nfts.json, which carries a complete live listing per token — so this is
      // exact, not sampled.
      //
      // NOTE, deliberately absent: a HISTORICAL sales-by-marketplace breakdown.
      // sales-enriched carries `marketplace` on only 38 of 1,259 sales (3%),
      // so any such split would be a guess dressed up as a statistic. If the
      // sales walker ever resolves marketplace from the tx target reliably,
      // add it here — until then the honest answer is that we don't know.
      listings_by_marketplace: listingsByMarketplace,
      first_sale: sorted.length ? { token_id: sorted[sorted.length - 1].token_id, date: sorted[sorted.length - 1].timestamp, notional_usd: sorted[sorted.length - 1].notional_usd } : null,
      last_sale: sorted.length ? { token_id: sorted[0].token_id, date: sorted[0].timestamp, notional_usd: sorted[0].notional_usd } : null,
      // Declared-absent rather than faked: the legacy feed carried bLUNA oracle
      // curves from a producer that no longer exists. Null until an org source does.
      bluna_pricing: null,
      bluna_ratio_curve: null,
      oracle_span: null,
    };
    await publish(`${NFT_PATH}/nft-analytics.json`, explorer, 'nft-analytics: explorer feed (from sales-enriched)');
    console.log(`  explorer feed: ${volume.sales_count} sales, ${monthly.length} months, ${leaderboards.top_buyers.length} buyers ranked`);
  } else {
    console.log('  explorer feed SKIPPED — sales-enriched.json unavailable (honest skip, no fabricated feed)');
  }
  await publish(`${NFT_PATH}/analytics-heartbeat.json`, {
    version: VERSION, generated_at: new Date().toISOString(), status: 'ok',
    all_time_sales: allTimeCount, all_time_volume_luna: out.all_time.total_volume_luna,
    grades_with_floor: Object.values(floorByGrade).filter(g => g.floor_usd != null).length,
  }, 'nft-analytics: heartbeat');

  console.log(`  all-time: ${allTimeCount} sales, ${out.all_time.total_volume_luna.toLocaleString()} LUNA`);
  console.log(`  grades with a floor: ${Object.values(floorByGrade).filter(g => g.floor_usd != null).length}/40`);
  console.log('  done');
}

// ---- github (409-retry, fleet pattern) ----
function ghApi(method, apiPath, body = null) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: 'api.github.com', path: apiPath, method,
      headers: { Authorization: `token ${GITHUB_TOKEN}`, 'User-Agent': 'nft-analytics/1.0', Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' } },
      (res) => { let d = ''; res.on('data', c => (d += c)); res.on('end', () => { let p = d; try { p = JSON.parse(d); } catch {} resolve({ status: res.statusCode, body: p }); }); });
    req.on('error', reject); if (body) req.write(JSON.stringify(body)); req.end();
  });
}
async function publish(filepath, obj, message, maxAttempts = 5) {
  const content = JSON.stringify(obj, null, 2);
  if (!GITHUB_TOKEN) { const fs = require('fs'), path = require('path'); const local = path.join(process.env.LOCAL_OUT || './out', filepath); fs.mkdirSync(path.dirname(local), { recursive: true }); fs.writeFileSync(local, content); return true; }
  const apiPath = `/repos/${GITHUB_REPO}/contents/${filepath}`;
  const b64 = Buffer.from(content).toString('base64');
  for (let a = 1; a <= maxAttempts; a++) {
    const ex = await ghApi('GET', `${apiPath}?ref=${GITHUB_BRANCH}`);
    const sha = ex.body && ex.body.sha;
    const put = await ghApi('PUT', apiPath, { message, content: b64, branch: GITHUB_BRANCH, ...(sha ? { sha } : {}) });
    if (put.status === 200 || put.status === 201) return true;
    if (put.status === 409 || put.status === 422) { await new Promise(r => setTimeout(r, 300 * a + Math.random() * 400)); continue; }
    return false;
  }
  return false;
}

module.exports = { main };
if (require.main === module) main().catch(e => { console.error('fatal:', e); process.exit(1); });
