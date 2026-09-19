#!/usr/bin/env node
// gate-collection-config.mjs — nft-inventory Rev D.1 (collection-agnostic).
//   1. configFromManifest(adao/collection.json) === ADAO_DEFAULT_CONFIG, field by field — the registry holds the literals.
//   2. Pixel Lions resolves from ITS manifest: DAODAO module + DAO core from `governance`, Enterprise legacy from a custodian's
//      ROLE, no backing (Phase 6 off), no break mechanism, venues = bbl only, supply 5000, no Phoenix tier.
//   3. applyCollection(PL) rebinds the classifier: PL's staking module → daodao_staked; aDAO's → user_held; tierOf → base.
//   4. compact-bundle: the aDAO bundle built by 1.3.0 is byte-identical (minus builtAt/builtBy) to the one 1.2.0 builds on the
//      same fixture; a PL bundle carries PL's six trait columns in manifest order and PL's supply.
//   5. (D.2) the run-ally PATH case: index.js loaded exactly as run-ally.js spawns it (COLLECTION=<slug>, NFT_ROOT deleted) resolves
//      NFT_ROOT = the slug for adao AND pixel-lions (the 23:34Z run wrote a stray nft-collections/nfts/adao/ when adao fell back
//      to the pre-migration root); and HAS_CUSTODY is true for aDAO, false for PL (no dao-controlled product without a custody block).
// Usage: NFTC_DIR=<nft-collections with the D.1 adao manifest> SITE_DIR=<aDAO-links-site> MAIN_DIR=<platform-crons main checkout> node gate-collection-config.mjs
import fs from 'fs'; import path from 'path'; import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const NFTC = process.env.NFTC_DIR, SITE = process.env.SITE_DIR, MAIN = process.env.MAIN_DIR;
if (!NFTC || !SITE) { console.error('NFTC_DIR and SITE_DIR required'); process.exit(1); }
let pass = 0, fail = 0; const ok = (m, c, x) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (x !== undefined ? ' → ' + JSON.stringify(x).slice(0, 300) : '')); } };
const M = require('./index.js');
const rj = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const adao = rj(path.join(NFTC, 'adao/collection.json')), pl = rj(path.join(NFTC, 'pixel-lions/collection.json')), venues = rj(path.join(NFTC, 'venues.json'));

console.log('\n== 1. the registry reproduces the aDAO literals ==');
{ const cfg = M.configFromManifest(adao, venues); const d = M.ADAO_DEFAULT_CONFIG; const diffs = [];
  for (const k of Object.keys(d)) if (JSON.stringify(cfg[k]) !== JSON.stringify(d[k])) diffs.push([k, cfg[k], d[k]]);
  ok('every field of ADAO_DEFAULT_CONFIG comes out of adao/collection.json unchanged (' + Object.keys(d).length + ' fields)', diffs.length === 0, diffs);
  ok('25 Phoenix ids from tiers.phoenix.token_ids', cfg.PHOENIX_TOKEN_IDS.length === 25 && cfg.PHOENIX_TOKEN_IDS.includes('745') === false && cfg.PHOENIX_TOKEN_IDS.includes('1128')); }

console.log('\n== 2. Pixel Lions from its own manifest ==');
const plc = M.configFromManifest(pl, venues);
ok('contract + DAO core + DAODAO staking module from the manifest', plc.NFT_CONTRACT === pl.nft_contract && plc.DAO_MAIN_WALLET === pl.governance.dao_address && plc.DAODAO_STAKING_CONTRACT === pl.governance.staking_contract, plc);
ok('Enterprise legacy custodian resolved by ROLE from capture.custodians', plc.ENTERPRISE_NFT_STAKING === Object.entries(pl.capture.custodians).find(([, c]) => c.role === 'enterprise_staking')[0]);
ok('no backing token, no break mechanism, no Phoenix tier, no treasury/council wallets', plc.BACKING_CW20 === null && plc.BREAK_MECHANISM === false && plc.PHOENIX_TOKEN_IDS.length === 0 && plc.DAO_TREASURY_CONTRACT === null && plc.DAO_WALLET_8YWV === null, plc);
ok(`venues = the manifest's marketplaces, in its order (${pl.marketplaces.map(m => m.key).join(', ')}), supply = the manifest's`, JSON.stringify(plc.VENUES) === JSON.stringify(pl.marketplaces.map(m => m.key).filter(k => venues.venues[k])) && plc.supply === Number(pl.supply), [plc.VENUES, plc.supply]);   // D.2: a relation — the chain names the venues (PL's first run found Atrium + Boost) and the registry follows
ok('HAS_CUSTODY: aDAO true (custody block), PL false (none) — dao-controlled publishes only with a custody block', M.configFromManifest(adao, venues).HAS_CUSTODY === true && plc.HAS_CUSTODY === false, [M.configFromManifest(adao, venues).HAS_CUSTODY, plc.HAS_CUSTODY]);

console.log('\n== 3. applyCollection rebinds the classifier ==');
{ M.applyCollection(plc);
  const a = M.classifyOwner(plc.DAODAO_STAKING_CONTRACT, false), b = M.classifyOwner(M.ADAO_DEFAULT_CONFIG.DAODAO_STAKING_CONTRACT, false), c = M.classifyOwner(plc.ENTERPRISE_NFT_STAKING, false), d = M.classifyOwner(plc.DAO_MAIN_WALLET, false);
  ok('PL staking module → daodao_staked; aDAO\'s module → user_held (a stranger to this collection)', a.daodao_staked && !a.user_held && b.user_held && !b.daodao_staked, [a, b]);
  ok('PL Enterprise custodian → enterprise_staked; PL DAO core → unminted', c.enterprise_staked && d.unminted);
  ok('tierOf: no break, no Phoenix → base for every token', M.tierOf({ id: '1128', broken: false }) === 'base' && M.tierOf({ id: '1', broken: false }) === 'base');
  ok('getCollection() is PL now', M.getCollection().slug === 'pixel-lions');
  M.applyCollection(M.ADAO_DEFAULT_CONFIG);
  ok('back to aDAO: tierOf #1128 = phoenix, #745 = base, broken = broken', M.tierOf({ id: '1128', broken: false }) === 'phoenix' && M.tierOf({ id: '745', broken: false }) === 'base' && M.tierOf({ id: '1128', broken: true }) === 'broken'); }

console.log('\n== 4. compact-bundle differential (aDAO byte-identical) + a PL bundle shape ==');
{ const nfts = rj(path.join(NFTC, 'adao/snapshots/nfts.json')), sum = rj(path.join(NFTC, 'adao/snapshots/summary.json'));
  const meta = rj(path.join(SITE, 'assets/nft-metadata/all_nfts_metadata.json')); const ri = rj(path.join(NFTC, 'adao/rarity/adao-rarity-intended.json'));
  let rb = null; try { rb = rj(path.join(SITE, 'assets/nft-metadata/adao-rarity-bbl.json')); } catch { }
  const strip = (b) => { const c = JSON.parse(JSON.stringify(b)); delete c.builtAt; delete c.builtBy; return JSON.stringify(c); };
  const mine = require('./compact-bundle.js').buildBundle(nfts, sum, meta, ri, rb);
  if (MAIN) { const theirs = require(path.join(MAIN, 'nfts/adao/compact-bundle.js')).buildBundle(nfts, sum, meta, ri, rb); ok('aDAO bundle: 1.3.0 output === 1.2.0 output on the same fixture (builtAt/builtBy aside)', strip(mine) === strip(theirs), [mine.fields, theirs.fields]); }
  else console.log('    (MAIN_DIR not given — differential skipped)');
  ok('aDAO bundle fields, in order', JSON.stringify(mine.fields) === JSON.stringify(['id', 'planet', 'inhabitant', 'object', 'weather', 'light', 'rarity', 'intended_rank', 'intended_pct', 'bbl_rank', 'flags', 'listing_usd']), mine.fields);
  // PL: a synthetic nfts doc (5,000 user-held records — inventory has not run for PL yet) + the REAL PL metadata + rarity
  process.env.COLLECTION = 'pixel-lions'; process.env.COLLECTION_TRAITS = pl.traits.map(t => t.name).join(','); process.env.COLLECTION_SUPPLY = '5000';
  delete require.cache[require.resolve('./compact-bundle.js')]; const CBpl = require('./compact-bundle.js');
  const plMeta = rj(path.join(NFTC, 'pixel-lions/metadata/metadata.json')), plRar = rj(path.join(NFTC, 'pixel-lions/rarity/rarity.json'));
  const plNfts = { capturedAt: '2026-09-18T00:00:00Z', records: plMeta.map(m => ({ id: String(m.id), owner: 'terra1someone', user_held: true, broken: false, listing: null })) };
  const plSum = { unminted_count: 0, daodao_staked_count: 0, broken_count: 0, bbl_listed_count: 0, daodao_pending_claim_count: 0, daodao_custody_unattributed_count: 0 };
  let plb = null, err = null; try { plb = CBpl.buildBundle(plNfts, plSum, plMeta, plRar, null); } catch (e) { err = e.message; }
  ok('PL bundle builds from PL metadata + rarity: fields = id + Back/Body/Eyes/Face/Mane/Prop + ranks + flags', plb && JSON.stringify(plb.fields) === JSON.stringify(['id', 'back', 'body', 'eyes', 'face', 'mane', 'prop', 'intended_rank', 'intended_pct', 'bbl_rank', 'flags', 'listing_usd']), err || (plb && plb.fields));
  ok('PL bundle: 5,000 rows, dictionaries per PL trait (Mane has 31 values), rank column filled from rarity.json', plb && plb.rows.length === 5000 && plb.dict.Mane && plb.dict.Mane.length === 31 && plb.rows.filter(r => r[7] != null).length >= 4990, plb && [plb.rows.length, plb.dict.Mane && plb.dict.Mane.length, plb.rows.filter(r => r[7] != null).length]); }
console.log('\n== 5. the run-ally PATH case (D.2): a child process exactly as run-ally.js spawns it ==');
{ const { spawnSync } = await import('node:child_process');
  const paths = (slug) => { const env = Object.assign({}, process.env, { COLLECTION: slug, GITHUB_TOKEN: 'x' }); delete env.NFT_ROOT; const r = spawnSync(process.execPath, ['--max-old-space-size=200', '-e', "const M=require('./index.js'); console.log(JSON.stringify(M.PATHS))"], { cwd: path.dirname(new URL(import.meta.url).pathname), env, encoding: 'utf8' }); try { return JSON.parse(r.stdout.trim().split('\n').pop()); } catch { return { error: (r.stderr || r.stdout).slice(0, 300) }; } };
  const a = paths('adao'), p = paths('pixel-lions');
  ok('COLLECTION=adao, NFT_ROOT unset (run-ally) → NFT_ROOT "adao", OUTPUT_PATH under it, never nfts/adao', a.NFT_ROOT === 'adao' && String(a.OUTPUT_PATH).startsWith('adao/') && !/nfts\/adao/.test(JSON.stringify(a)), a);
  ok('COLLECTION=pixel-lions, NFT_ROOT unset → NFT_ROOT "pixel-lions", OUTPUT_PATH under it', p.NFT_ROOT === 'pixel-lions' && String(p.OUTPUT_PATH).startsWith('pixel-lions/'), p);
  const ra = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'run-ally.js'), 'utf8');
  ok('run-ally.js deletes NFT_ROOT from the child env and sets COLLECTION=<slug> (the slug is the root, always)', /delete env\.NFT_ROOT/.test(ra) && /COLLECTION: slug/.test(ra)); }
console.log(`\n=== GATE collection-config: ${pass} passed, ${fail} failed ===`); process.exit(fail ? 1 : 0);
