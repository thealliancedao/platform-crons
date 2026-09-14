#!/usr/bin/env node
// mock-run-compact-bundle.js — BINDING gate for the first-paint bundle.
// Real committed inputs: NFTC_DIR/<NFT_ROOT>/snapshots nfts.json + summary.json, SITE_DIR metadata/rarity.
// Usage: NFTC_DIR=... SITE_DIR=... [NFT_ROOT=adao] node mock-run-compact-bundle.js
'use strict';
const fs = require('fs'), path = require('path');
// 2026-09-14 (B.7): aDAO fixtures read from a nft-collections checkout (NFTC_DIR) + NFT_ROOT (adao) — tla-core/nfts/adao was deleted 2026-09-13
const NFTC = process.env.NFTC_DIR, SITE = process.env.SITE_DIR, NFT_ROOT = process.env.NFT_ROOT || 'adao';
if (!NFTC || !SITE) { console.error('NFTC_DIR and SITE_DIR required'); process.exit(1); }
const CB = require('./compact-bundle.js');
const nftsDoc = JSON.parse(fs.readFileSync(path.join(NFTC, NFT_ROOT, 'snapshots/nfts.json')));
const summaryDoc = JSON.parse(fs.readFileSync(path.join(NFTC, NFT_ROOT, 'snapshots/summary.json')));
const meta = JSON.parse(fs.readFileSync(path.join(SITE, 'assets/nft-metadata/all_nfts_metadata.json')));
const ri = JSON.parse(fs.readFileSync(path.join(SITE, 'assets/nft-metadata/adao-rarity-intended.json')));
const rb = JSON.parse(fs.readFileSync(path.join(SITE, 'assets/nft-metadata/adao-rarity-bbl.json')));
let fails = 0;
const check = (n, ok, d) => { console.log(`${ok ? '✓' : '✗'} ${n}${d ? ' — ' + d : ''}`); if (!ok) fails++; };

const b = CB.buildBundle(nftsDoc, summaryDoc, meta, ri, rb);
const json = JSON.stringify(b);
check('rows: exactly 10,000, id-sorted', b.rows.length === 10000 && b.rows[0][0] === 1 && b.rows[9999][0] === 10000);
check('size: under 1.2 MB (first-paint budget)', json.length < 1.2e6, `${(json.length / 1024).toFixed(0)} KB`);
// decode #6192 and compare traits against raw metadata
const F = Object.fromEntries(b.fields.map((f, i) => [f, i]));
const row = b.rows.find(r => r[F.id] === 6192);
const m6192 = meta.find(m => String(m.id) === '6192');
const attr = (t) => (m6192.attributes.find(a => a.trait_type === t) || {}).value ?? null;
const dec = (t, v) => v >= 0 ? b.dict[t][v] : null;
check('#6192 traits round-trip through the dict',
  dec('Planet', row[F.planet]) === attr('Planet') && dec('Inhabitant', row[F.inhabitant]) === attr('Inhabitant')
  && dec('Object', row[F.object]) === attr('Object') && dec('Rarity', row[F.rarity]) === attr('Rarity'));
// flags reconcile to summary (module throws on mismatch — assert the good path AND the counts)
const bit = b.flagBits;
const cnt = (mask) => b.rows.filter(r => r[F.flags] & mask).length;
const S = summaryDoc;
check('flags: daodao_staked count matches summary', cnt(bit.daodao_staked) === S.daodao_staked_count, `${cnt(bit.daodao_staked)}`);
check('flags: pending 17 + unattributed 2 carried', cnt(bit.daodao_pending_claim) === S.daodao_pending_claim_count && cnt(bit.daodao_custody_unattributed) === S.daodao_custody_unattributed_count, `${cnt(bit.daodao_pending_claim)}+${cnt(bit.daodao_custody_unattributed)}`);
check('flags: unminted 5,828', cnt(bit.unminted) === S.unminted_count, `${cnt(bit.unminted)}`);
// listing prices present for listed tokens
const listedRows = b.rows.filter(r => r[F.flags] & (bit.bbl_listed | bit.boost_listed | bit.atrium_listed));
// 2026-09-14 (B.7): '>= 60 listed' was a literal from the gate's writing day; the bundle's listed rows must equal the
// snapshot summary's own per-venue counts (bbl + atrium + boost) — the same numbers the site's headline shows.
const listedExpected = (S.bbl_listed_count || 0) + (S.atrium_listed_count || 0) + (S.boost_listed_count || 0);
check('listings: listed rows = summary bbl+atrium+boost counts, and listed rows carry price_usd', listedRows.length === listedExpected && listedRows.some(r => r[F.listing_usd] != null), `${listedRows.length} listed vs summary ${listedExpected}, ${listedRows.filter(r => r[F.listing_usd] != null).length} priced`);
// ranks: spot-check #100 and #6192 against the intended rarity records
{
  const recs = ri.records;
  const byId = new Map(recs.map(t => [String(t.token_id), t]));
  for (const id of ['100', '6192']) {
    const rr = byId.get(id);
    const row2 = b.rows.find(r => r[F.id] === Number(id));
    check(`ranks: intended rank + pct match rarity records (#${id})`,
      row2[F.intended_rank] === rr.intended_rank && row2[F.intended_pct] === rr.percentile,
      `${row2[F.intended_rank]} @ ${row2[F.intended_pct]}%`);
  }
}
// refusal path: a poisoned summary must throw, never publish quietly
let threw = false;
try { CB.buildBundle(nftsDoc, { ...S, daodao_staked_count: S.daodao_staked_count + 1 }, meta, ri, rb); }
catch (e) { threw = true; }
check('refusal: summary mismatch throws (never a fast wrong bundle)', threw);
console.log(fails === 0 ? '\nGATE PASS' : `\nGATE FAIL (${fails})`);
process.exit(fails === 0 ? 0 : 1);
