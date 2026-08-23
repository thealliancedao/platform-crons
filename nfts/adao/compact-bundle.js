// =============================================================================
// nfts/adao/compact-bundle.js — the first-paint bundle (explorer perf, task 7)
// =============================================================================
// The explorer's first paint currently costs 16.3MB: metadata 6.6 + nfts.json
// 6.5 + two rarity files 3.1. Everything the FIRST RENDER needs — traits,
// grade, both ranks, status, listing price — fits in one dict-encoded product
// well under 1MB. Owners, listing details and per-sale history hydrate from
// the full products in the background; BBL grade detail stays lazy.
//
//   INPUT  nfts/adao/snapshots/nfts.json          (committed, this repo's cron)
//   INPUT  adao rarity (intended)                 (nft-collections repo)
//   INPUT  site metadata + BBL rarity             (aDAO-links-site repo)
//   OUTPUT nfts/adao/snapshots/explorer-bundle.json
//
// Format: { schemaVersion, builtAt, fields, flagBits, dict, rows } — rows are
// positional arrays, trait strings dict-encoded (5 traits × 10k rows as small
// ints), flags one bitmask. The page decodes with the shipped dict; a field it
// doesn't recognize is ignored (forward-compatible).
//
// Laws: derived VIEW of committed products — rebuilt whole each warm/full,
// never merged, no history of its own. Counts must reconcile to nfts.json or
// the module REFUSES to publish (a fast wrong bundle is worse than a slow
// right page).
// =============================================================================
'use strict';
const https = require('https');

const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
const GITHUB_REPO   = process.env.GITHUB_REPO || 'thealliancedao/tla-core';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const NFT_PATH = process.env.NFT_PATH || 'nfts/adao/snapshots';
const SITE_RAW = 'https://raw.githubusercontent.com/thealliancedao/aDAO-links-site/main';
const RARITY_URL = process.env.RARITY_URL ||
  'https://raw.githubusercontent.com/thealliancedao/nft-collections/main/adao/rarity/adao-rarity-intended.json';
const VERSION = 'nft-compact-bundle-1.0.0';

// One bit per classification flag; the page ANDs against these names, so adding
// a bit is additive and renaming one is a breaking change — don't.
const FLAG_BITS = {
  unminted: 1, broken: 2, daodao_staked: 4, enterprise_staked: 8,
  treasury_held: 16, bbl_listed: 32, boost_listed: 64, atrium_listed: 128,
  daodao_pending_claim: 256, daodao_custody_unattributed: 512,
  user_held: 1024, enterprise_dao_broken: 2048, dao_wallet_8ywv_held: 4096,
};

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url + (url.includes('?') ? '&' : '?') + 't=' + Date.now(),
      { headers: { 'User-Agent': 'nft-compact-bundle/1.0' }, timeout: 60000 }, (res) => {
        if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} ${url}`)); }
        let d = ''; res.on('data', c => (d += c));
        res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
      }).on('error', reject).on('timeout', function () { this.destroy(new Error('timeout')); });
  });
}
const RAW = (p) => `https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_BRANCH}/${p}`;

function githubApiRequest(method, apiPath, body = null) {
  return new Promise((resolve, reject) => {
    const opts = { hostname: 'api.github.com', path: apiPath, method,
      headers: { 'User-Agent': 'nft-compact-bundle/1.0', 'Authorization': `Bearer ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github+json' } };
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
async function publish(filepath, content, message, maxAttempts = 5) {
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
    const cur = await githubApiRequest('GET', apiPath + `?ref=${GITHUB_BRANCH}&t=${Date.now()}`);
    const sha = cur.status === 200 ? cur.body.sha : undefined;
    const put = await githubApiRequest('PUT', apiPath, { message, branch: GITHUB_BRANCH, sha, content: Buffer.from(content).toString('base64') });
    if (put.status === 200 || put.status === 201) { console.log(`  ✅ ${filepath} (${(content.length / 1024).toFixed(0)} KB)`); return; }
    if (put.status === 409 && attempt < maxAttempts) { await new Promise(r => setTimeout(r, 500 * attempt + Math.random() * 500)); continue; }
    throw new Error(`publish ${filepath}: HTTP ${put.status}`);
  }
}

// =============================================================================
// PURE CORE (gated by mock-run-compact-bundle.js on the real committed inputs)
// =============================================================================
function buildBundle(nftsDoc, summaryDoc, metadata, rarityIntended, rarityBbl) {
  const records = nftsDoc.records;
  if (!Array.isArray(records) || records.length !== 10000) throw new Error(`nfts.json integrity: expected 10000 records, got ${records && records.length}`);
  const metaById = new Map(metadata.map(m => [String(m.id), m]));
  // rarity files: accept either {tokens:{id:{rank,percentile,...}}} or array shapes
  const rankOf = (doc) => {
    if (!doc) return () => ({});
    const list = Array.isArray(doc) ? doc : (doc.records || doc.tokens || null);
    if (Array.isArray(list)) { const m = new Map(list.map(t => [String(t.id ?? t.token_id), t])); return (id) => m.get(id) || {}; }
    const srcMap = doc.tokens || doc;
    return (id) => srcMap[id] || {};
  };
  const ri = rankOf(rarityIntended), rb = rankOf(rarityBbl);

  // dictionaries per trait — small string tables the page ships once
  const TRAITS = ['Planet', 'Inhabitant', 'Object', 'Weather', 'Light', 'Rarity'];
  const dict = Object.fromEntries(TRAITS.map(t => [t, []]));
  const idx = Object.fromEntries(TRAITS.map(t => [t, new Map()]));
  const enc = (t, v) => {
    if (v == null) return -1;
    let i = idx[t].get(v);
    if (i === undefined) { i = dict[t].length; dict[t].push(v); idx[t].set(v, i); }
    return i;
  };

  const rows = [];
  const counts = {};                      // bit-name → count, reconciled below
  for (const r of records) {
    const id = String(r.id);
    const meta = metaById.get(id);
    const attrs = {}; for (const a of (meta && meta.attributes || [])) attrs[a.trait_type] = a.value;
    let flags = 0;
    for (const [k, bit] of Object.entries(FLAG_BITS)) if (r[k]) { flags |= bit; counts[k] = (counts[k] || 0) + 1; }
    const rI = ri(id), rB = rb(id);
    const listPx = r.listing && r.listing.price_usd != null ? Math.round(r.listing.price_usd * 100) / 100 : null;
    rows.push([
      Number(id),
      enc('Planet', attrs.Planet), enc('Inhabitant', attrs.Inhabitant), enc('Object', attrs.Object),
      enc('Weather', attrs.Weather), enc('Light', attrs.Light), enc('Rarity', attrs.Rarity),
      rI.rank ?? rI.intended_rank ?? null, rI.percentile ?? null,
      rB.rank ?? rB.bbl_rank ?? null,
      flags, listPx,
    ]);
  }
  rows.sort((a, b) => a[0] - b[0]);

  // reconcile — the bundle must agree with nfts.json or it doesn't ship
  const sum = summaryDoc || {};   // summary.json — a separate committed product, not a field of nfts.json
  const mustMatch = [
    ['unminted', sum.unminted_count], ['daodao_staked', sum.daodao_staked_count],
    ['broken', sum.broken_count], ['bbl_listed', sum.bbl_listed_count],
    ['daodao_pending_claim', sum.daodao_pending_claim_count],
    ['daodao_custody_unattributed', sum.daodao_custody_unattributed_count],
  ];
  for (const [k, expect] of mustMatch) {
    if (expect != null && (counts[k] || 0) !== expect) throw new Error(`bundle/summary mismatch on ${k}: bundle ${counts[k] || 0} vs summary ${expect} — refusing to publish`);
  }
  const withMeta = rows.filter(r => r[1] >= 0).length;
  if (withMeta < 9990) throw new Error(`metadata join too thin: ${withMeta}/10000 rows carry traits — refusing`);

  return {
    schemaVersion: 1, builtAt: new Date().toISOString(), builtBy: VERSION,
    note: 'first-paint bundle — derived view of nfts.json + metadata + rarity; rebuilt whole each warm/full; owners & listing detail hydrate from the full products',
    fields: ['id', 'planet', 'inhabitant', 'object', 'weather', 'light', 'rarity', 'intended_rank', 'intended_pct', 'bbl_rank', 'flags', 'listing_usd'],
    flagBits: FLAG_BITS,
    dict, rows,
    source: { nfts_captured_at: nftsDoc.capturedAt || null, records: records.length },
  };
}

async function main() {
  console.log(`\n${VERSION} — first-paint bundle`);
  const [nftsDoc, summaryDoc, metadata, rarityIntended, rarityBbl] = await Promise.all([
    fetchJson(RAW(`${NFT_PATH}/nfts.json`)),
    fetchJson(RAW(`${NFT_PATH}/summary.json`)),
    fetchJson(`${SITE_RAW}/assets/nft-metadata/all_nfts_metadata.json`),
    fetchJson(RARITY_URL),
    fetchJson(`${SITE_RAW}/assets/nft-metadata/adao-rarity-bbl.json`).catch(() => null),
  ]);
  const bundle = buildBundle(nftsDoc, summaryDoc, metadata, rarityIntended, rarityBbl);
  const content = JSON.stringify(bundle);
  console.log(`  rows ${bundle.rows.length} · dict ${Object.values(bundle.dict).reduce((s, d) => s + d.length, 0)} strings · ${(content.length / 1024).toFixed(0)} KB`);
  await publish(`${NFT_PATH}/explorer-bundle.json`, content, `compact-bundle: ${bundle.rows.length} rows (${(content.length / 1024).toFixed(0)} KB)`);
  console.log('  done');
}

module.exports = { main, buildBundle, FLAG_BITS };
if (require.main === module) main().catch(e => { console.error('compact-bundle failed:', e.message); process.exit(1); });
