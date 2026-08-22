// =============================================================================
// Address-Catalog Cron — the platform's single "who do we track" registry
// =============================================================================
//
// WHY THIS EXISTS
// ---------------
// Member/holder discovery was happening in five places (adao-positions,
// adao-allies, tla-locks, tla-participants, tla-chain-registry), each
// re-deriving "who exists." This cron does it ONCE: it reads a config (TRACKED),
// discovers every address per the right method, resolves PFPK handles, applies
// each entity's retention rule, and writes ONE catalog file. Every portfolio /
// history cron then reads this catalog instead of re-discovering — discovery is
// done once, and onboarding a new ally is a single config row.
//
// EXTENSIBILITY (the give-back model)
// -----------------------------------
// Adding an ally = append ONE row to TRACKED, e.g. a future Solid alliance:
//   { slug:'solid', name:'Solid', stakeType:'cw20', retention:'registered_only',
//     type:'ally_member', coreAddress:'terra1...' }
// The catalog resolves its voting module, pulls stakers, keeps the registered
// (named) ones, tags them, and every downstream cron starts tracking them on the
// next run. No code changes anywhere else.
//
// DISCOVERY METHODS (stakeType)
//   nft   -> daoVotingCw721Staked   (NFTs staked to a DAODAO DAO)
//   cw20  -> daoVotingCw20Staked    (cw20 token staked, e.g. ROAR)
//   token -> daoVotingTokenStaked   (native / tokenfactory staked)
//   lock  -> veLUNA CW721 all_tokens enumeration + owner_of  (no DAO core)
//
// RETENTION
//   all              -> keep EVERY address (named + anonymous). Our own entities;
//                       anonymous kept "for the record" with handle:null.
//   registered_only  -> keep only PFPK-named addresses. Allies (give-back to
//                       identifiable community members). Anonymous are counted
//                       but NOT stored.
//
// OUTPUT — into the unified `tla-core` repo as the `catalog` module, following the
// module/product/files layout (snapshots product):
//   catalog/snapshots/current.json      full registry (addresses + slug blocks +
//                                        by-address index + structural contracts)
//   catalog/snapshots/daily/{date}.json forward-only daily snapshot (history accrues)
//   catalog/snapshots/index.json        manifest (latest pointers + counts)
//   catalog/snapshots/heartbeat.json    standard heartbeat (read by system-health)
// Forward-only: starts capturing the day it goes live; no backfill. Membership moves
// slowly, so this module is daily + simple — no intra-hour tiers.
//
// Structural addresses come from config/contracts.js (single source). Reuses the
// shared engine in platform-crons/lib (capture-engine, ally-capture).
// Render: service root platform-crons/address-catalog, build `npm i`, start
//   `node address-catalog.js`, env GITHUB_TOKEN (scoped to thealliancedao/tla-core)
//   + optional GITHUB_REPO (defaults to thealliancedao/tla-core).
// =============================================================================

'use strict';
const fs = require('fs');
const https = require('https');

const {
  queryContract,
  fetchJson,
  parallelMap,
  bech32AddressToHex,
  currentEpochInfo,
  PFPK_BASE_URL,
  PFPK_TIMEOUT_MS,
  BATCH_CONCURRENCY,
  TLA_VOTING_ESCROW,
} = require('../lib/capture-engine.js');

const { resolveVotingModule, fetchStakers } = require('../lib/ally-capture.js');

// Single source of truth for structural addresses (see config/contracts.js).
const C = require('../config/contracts.js');

// -----------------------------------------------------------------------------
// CONFIG — the entire "who do we track" policy lives here. One row per entity.
// To onboard a new ally: append a row. Nothing else in the platform changes.
// -----------------------------------------------------------------------------
const TRACKED = [
  // ---- OUR entities — retention 'all' (registered + anonymous, kept for record)
  {
    slug: 'adao',
    name: 'Alliance DAO',
    stakeType: 'nft',
    retention: 'all',
    type: 'adao_staker',
    coreAddress:  C.DAO_MAIN_WALLET.addr,  // single source: config/contracts.js
    votingModule: 'terra1c57ur376szdv8rtes6sa9nst4k536dynunksu8tx5zu4z5u3am6qmvqx47', // proven (adao-positions); resolveVotingModule(core) used if omitted
  },
  {
    slug: 'tla_locks',
    name: 'TLA Lock Holders',
    stakeType: 'lock',
    retention: 'all',
    type: 'lock_holder',
    // no DAO core — discovered by enumerating the veLUNA voting-escrow CW721
  },

  // ---- ALLIES — retention 'registered_only' (give-back: identifiable members only)
  {
    slug: 'pixellions',
    name: 'Pixel Lions',
    stakeType: 'nft',
    retention: 'registered_only',
    type: 'ally_member',
    coreAddress: 'terra1c690mdrwdetnr09zfk3tf9xz9jhrgd9wpjyf3tuccj74ql09eqmq6sh7en',
  },
  {
    slug: 'liondao',
    name: 'Lion DAO',
    stakeType: 'cw20',
    retention: 'registered_only',
    type: 'ally_member',
    coreAddress: 'terra1tkersa2mqwy2h8exj799qx2xrhdu0dkymk9psp6v0k4kz4tkxucssgluec',
  },
];

const GITHUB_TOKEN    = process.env.GITHUB_TOKEN;
const GITHUB_REPO     = process.env.GITHUB_REPO   || 'thealliancedao/tla-core';
const GITHUB_BRANCH   = process.env.GITHUB_BRANCH || 'main';
const RUN_EVERY_HOURS = Number(process.env.RUN_EVERY_HOURS || 24); // catalog cadence (membership moves slowly)
// Curated ENTITY register — collective/public wallets (treasuries, multisigs,
// protocol bribers, DAOs). Owner-edited; this cron publishes it as
// `entities` so every page/agent reads ONE list (no hardcoded labels in pages).
const CURATED_WALLETS_URL = `https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_BRANCH}/docs/curated/wallets.json`;
// 1.3.0 (2026-08-22): ONE trust product. Merges the explicit trust register with
// wallets.json, known_contracts.json, every dao-originations registry, the
// structural config and the live gauge/pool snapshots → catalog/trusted/current.json.
// See trusted-catalog.js (pure builder, gated on real fixtures).
const { buildTrusted } = require('./trusted-catalog.js');
const RAW = `https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_BRANCH}`;
const DAO_REPO_RAW = `https://raw.githubusercontent.com/${process.env.DAO_REPO || 'thealliancedao/dao-originations'}/${GITHUB_BRANCH}`;
const TRUST_SRC = {
  curated: `${RAW}/docs/curated/trusted-addresses.json`,
  known: `${RAW}/docs/curated/known_contracts.json`,
  snapshot: `${RAW}/member-data/tla-snapshot/current.json`,
  astro: `${RAW}/dex-data/astroport/snapshots/current.json`,
};
const DAO_FOLDERS = ['adao', 'lion-dao', 'pixel-lions', 'capapult', 'terra'];
async function buildTrustedProduct(wallets) {
  const get = async (u, tag) => { try { return await fetchJson(u, tag, 15000); } catch (e) { console.log(`  ⚠ trusted: ${tag} unavailable (${e.message.slice(0, 60)})`); return null; } };
  const [curated, known, snapshot, astro] = await Promise.all([get(TRUST_SRC.curated, 'trusted-addresses'), get(TRUST_SRC.known, 'known-contracts'), get(TRUST_SRC.snapshot, 'tla-snapshot'), get(TRUST_SRC.astro, 'astroport')]);
  const daoRegs = {};
  for (const d of DAO_FOLDERS) daoRegs[d] = await get(`${DAO_REPO_RAW}/${d}/governance/registry.json`, `registry:${d}`);
  const contracts = { gauge_controller: C.GAUGE_CONTROLLER, voting_escrow: C.VOTING_ESCROW, bribe_manager: C.BRIBE_MANAGER, compounder: C.COMPOUNDER, zapper: C.ZAPPER, dao_main_wallet: C.DAO_MAIN_WALLET };
  const out = buildTrusted({ curated, wallets, known, contracts, daoRegs, snapshot, astro, generatedAt: new Date().toISOString() });
  out.meta.inputs = { curated: !!curated, wallets: !!wallets, known: !!known, snapshot: !!snapshot, astro: !!astro, dao_registries: DAO_FOLDERS.filter(d => daoRegs[d]) };
  if (!curated) out.meta.status = 'degraded';   // the register is the point; without it the product is only the old labels
  return out;
}

// -----------------------------------------------------------------------------
// PFPK handle resolution — for ALL methods (incl. locks), not just ally stakers.
// Failures leave handle:null (never throws away an address on a name miss).
// -----------------------------------------------------------------------------
async function resolveHandles(rows) {
  let named = 0;
  await parallelMap(rows, async (m) => {
    try {
      const hex = bech32AddressToHex(m.address);
      const data = await fetchJson(PFPK_BASE_URL + hex, 'pfpk', PFPK_TIMEOUT_MS);
      if (data && data.name && String(data.name).trim()) { m.handle = String(data.name).trim(); named++; }
      else m.handle = null;
    } catch { m.handle = null; }
  }, BATCH_CONCURRENCY);
  return named;
}

// -----------------------------------------------------------------------------
// DISCOVERY: lock holders — veLUNA CW721 all_tokens enumeration + owner_of.
// Mirrors tla-participants exactly (null != [] guard; per-owner lock tally).
// -----------------------------------------------------------------------------
async function discoverLockHolders() {
  const numTokens = await queryContract(TLA_VOTING_ESCROW, { num_tokens: {} });
  const expected = numTokens && typeof numTokens.count === 'number' ? numTokens.count : null;

  const tokenIds = [];
  let startAfter, pages = 0, enumerationOk = true;
  while (true) {
    const query = { all_tokens: { limit: 100, ...(startAfter !== undefined ? { start_after: startAfter } : {}) } };
    const page = await queryContract(TLA_VOTING_ESCROW, query);
    pages++;
    if (page === null) {                       // failed query (NOT end-of-list)
      enumerationOk = false;
      console.error(`  ✗ all_tokens page ${pages} returned null — enumeration INCOMPLETE`);
      break;
    }
    const ids = Array.isArray(page.tokens) ? page.tokens : [];
    if (ids.length === 0) break;               // genuine end of enumeration
    tokenIds.push(...ids);
    startAfter = ids[ids.length - 1];
    if (ids.length < 100) break;               // last partial page
    if (pages > 60) { console.warn('  ⚠ all_tokens > 60 pages — stopping defensively'); enumerationOk = false; break; }
  }
  console.log(`  enumerated ${tokenIds.length} lock token_ids across ${pages} page(s)`);
  if (expected != null && tokenIds.length < expected && enumerationOk) {
    console.warn(`  ⚠ enumerated ${tokenIds.length} < expected ${expected} — possible truncation`);
    enumerationOk = false;
  }

  const owners = new Map();   // address -> lock count
  let ownerErrors = 0;
  await parallelMap(tokenIds, async (tokenId) => {
    const res = await queryContract(TLA_VOTING_ESCROW, { owner_of: { token_id: tokenId } });
    if (res && res.owner) owners.set(res.owner, (owners.get(res.owner) || 0) + 1);
    else ownerErrors++;
  }, BATCH_CONCURRENCY);
  console.log(`  ✓ ${owners.size} unique lock holders (${ownerErrors} owner_of errors)`);

  const rows = [...owners.entries()].map(([address, n]) => ({
    address, stake_raw: n, vp_pct_of_dao: 0, source: 'veluna_cw721',
  }));
  return {
    rows,
    total_tokens: tokenIds.length,
    expected,
    complete: enumerationOk && ownerErrors === 0,
  };
}

// -----------------------------------------------------------------------------
// DISCOVERY: DAODAO stakers (nft / cw20 / token) via voting module + topStakers.
// votingModule resolved from the DAO core unless an override is given.
// -----------------------------------------------------------------------------
async function discoverStakers(entry) {
  let vm = entry.votingModule || null;
  if (!vm) {
    if (!entry.coreAddress) return { rows: null, voting_module: null, error: 'no coreAddress / votingModule' };
    vm = await resolveVotingModule(entry.coreAddress);
  }
  if (!vm) return { rows: null, voting_module: null, error: 'could not resolve voting module' };

  const stakers = await fetchStakers(vm, entry.stakeType);   // [{address, stake_raw, vp_pct_of_dao, source}] | null
  if (!stakers) return { rows: null, voting_module: vm, error: 'topStakers query failed' };

  const rows = stakers.map(s => ({
    address: s.address, stake_raw: s.stake_raw, vp_pct_of_dao: s.vp_pct_of_dao, source: s.source,
  }));
  return { rows, voting_module: vm, error: null };
}

// -----------------------------------------------------------------------------
// GitHub publish (mirrors the platform's standard helper)
// -----------------------------------------------------------------------------
function githubApiRequest(method, apiPath, body = null) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'api.github.com', path: apiPath, method,
      headers: {
        'User-Agent': 'address-catalog-cron/1.0',
        'Authorization': `Bearer ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github+json',
      },
    };
    if (body) opts.headers['Content-Type'] = 'application/json';
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); } catch { resolve(data); }
        } else reject(new Error(`GitHub ${method} ${apiPath}: ${res.statusCode} ${data.slice(0, 200)}`));
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// PUBLISHER RETRY (2026-08-12). Twelve org jobs write to tla-core, so main
// advances between our sha read and the PUT — 409 "is at X but expected Y" is
// routine, not exceptional. GitHub also returns transient 5xx ("No server is
// currently available"), which is not our fault and not permanent. Both are
// retried with a FRESH sha per attempt and jittered backoff; a stale sha is
// never reused. Anything else still throws immediately.
// This cron died mid-run on 2026-08-18: heartbeat.json hit a 409 AFTER
// current.json and the daily snapshot had already published, so the run looked
// "fresh" to the site while the job was actually failing.
async function publishFile(filePath, content, message, maxAttempts = 5) {
  const apiPath = `/repos/${GITHUB_REPO}/contents/${filePath}`;
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let sha = null;
    try { sha = (await githubApiRequest('GET', apiPath + `?ref=${GITHUB_BRANCH}`)).sha; } catch (e) { /* new file */ }
    const body = { message, content: Buffer.from(content).toString('base64'), branch: GITHUB_BRANCH };
    if (sha) body.sha = sha;
    try {
      return await githubApiRequest('PUT', apiPath, body);
    } catch (e) {
      lastErr = e;
      const msg = String((e && e.message) || '');
      const retryable = /\b(409|422|5\d\d)\b/.test(msg);
      if (!retryable || attempt === maxAttempts) throw e;
      const wait = 400 * attempt + Math.floor(Math.random() * 400);
      console.warn(`  ↻ publish retry ${attempt}/${maxAttempts - 1} — ${msg.slice(0, 70)} — waiting ${wait}ms`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

// -----------------------------------------------------------------------------
// MAIN
// -----------------------------------------------------------------------------
async function run() {
  const startedAt = new Date();
  const epochInfo = currentEpochInfo();
  console.log(`\n🚀 Address-Catalog — ${startedAt.toISOString()} — ${TRACKED.length} tracked entities\n`);

  // ---- curated entities (docs/curated/wallets.json) → published `entities` -----
  // Fail-soft: a fetch miss publishes entities:{} with a loud log, never a guessed list.
  let entities = {}, entitiesStatus = 'ok', curWallets = null;
  try {
    const cur = await fetchJson(CURATED_WALLETS_URL, 'curated-wallets', 15000); curWallets = cur;
    for (const [addr, v] of Object.entries(cur?.wallets || {})) {
      if (!/^terra1[02-9ac-hj-np-z]{38,58}$/.test(addr) || !v?.label) continue;
      entities[addr] = { label: String(v.label), subtype: v.subtype || null, protocol: v.protocol || null, flags: Array.isArray(v.flags) ? v.flags : [] };
    }
    if (!entities[C.DAO_MAIN_WALLET.addr]) { entitiesStatus = 'drift'; console.log(`  ⚠ entities drift: dao_main_wallet ${C.DAO_MAIN_WALLET.addr} is not in docs/curated/wallets.json`); }
    console.log(`  ✓ ${Object.keys(entities).length} curated entities (docs/curated/wallets.json)`);
  } catch (e) { entitiesStatus = 'missing'; console.log(`  ✗ curated wallets unavailable: ${e.message.slice(0, 80)} — publishing entities:{}`); }

  const slugBlocks = [];
  const addresses = [];   // one row per (address, slug)

  for (const entry of TRACKED) {
    console.log(`\n🔎 ${entry.name} [${entry.slug}] — ${entry.stakeType}, retention=${entry.retention}`);
    let rows = null, voting_module = null, error = null, complete = true, expected = null, totalTokens = null;

    try {
      if (entry.stakeType === 'lock') {
        const d = await discoverLockHolders();
        rows = d.rows; complete = d.complete; expected = d.expected; totalTokens = d.total_tokens;
      } else {
        const d = await discoverStakers(entry);
        rows = d.rows; voting_module = d.voting_module; error = d.error;
      }
    } catch (e) { error = e.message; }

    if (!rows) {
      console.error(`  ✗ discovery failed: ${error}`);
      slugBlocks.push({
        slug: entry.slug, name: entry.name, type: entry.type, stake_type: entry.stakeType,
        retention: entry.retention, status: 'error', voting_module,
        total_count: 0, registered_count: 0, kept_count: 0, error,
      });
      continue;
    }

    const total = rows.length;
    console.log(`  ✓ ${total} discovered`);

    const named = await resolveHandles(rows);
    console.log(`  ✓ ${named}/${total} have PFPK handles`);

    // retention rule: allies keep only named; our entities keep everyone
    const kept = entry.retention === 'registered_only' ? rows.filter(r => r.handle) : rows;
    if (entry.retention === 'registered_only' && total - kept.length > 0)
      console.log(`  → registered_only: kept ${kept.length}, dropped ${total - kept.length} anonymous`);

    for (const r of kept) {
      addresses.push({
        address: r.address,
        slug: entry.slug,
        type: entry.type,
        handle: r.handle || null,
        retention: entry.retention,
        stake_raw: r.stake_raw ?? null,       // nft count / staked-token raw / lock count
        vp_pct_of_dao: r.vp_pct_of_dao ?? 0,
        source: r.source,
      });
    }

    const incomplete = (entry.stakeType === 'lock') ? !complete : false;
    slugBlocks.push({
      slug: entry.slug, name: entry.name, type: entry.type, stake_type: entry.stakeType,
      retention: entry.retention, status: incomplete ? 'partial' : 'ok', voting_module,
      total_count: total, registered_count: named, kept_count: kept.length,
      ...(totalTokens != null ? { lock_tokens: totalTokens, lock_expected: expected } : {}),
      error: null,
    });
  }

  // by-address index — an address can belong to several slugs (e.g. aDAO staker
  // who also holds a TLA lock). Downstream crons read this to know "who + how".
  const byAddress = {};
  for (const a of addresses) {
    const e = byAddress[a.address] || (byAddress[a.address] = { handle: a.handle, memberships: [] });
    if (!e.handle && a.handle) e.handle = a.handle;
    e.memberships.push({ slug: a.slug, type: a.type, stake_raw: a.stake_raw, vp_pct_of_dao: a.vp_pct_of_dao });
  }

  const statuses = slugBlocks.map(s => s.status);
  let overall = 'ok';
  if (statuses.length && statuses.every(s => s === 'error')) overall = 'error';
  else if (statuses.some(s => s !== 'ok')) overall = 'partial';

  const dayStr = startedAt.toISOString().slice(0, 10);   // YYYY-MM-DD (forward-only daily)

  const catalog = {
    meta: {
      version: 'address-catalog-1.3.0',   // 1.2.0: +entities (curated wallets register) · 1.3.0: +catalog/trusted product
      schemaVersion: 1,
      generated_at: startedAt.toISOString(),
      epoch: epochInfo?.number ?? null,
      status: overall,
      source: 'address-catalog cron (platform-crons/address-catalog)',
    },
    retention_policy: Object.fromEntries(TRACKED.map(t => [t.slug, t.retention])),
    slugs: slugBlocks,
    counts: {
      total_address_rows: addresses.length,
      unique_addresses: Object.keys(byAddress).length,
      by_slug: Object.fromEntries(slugBlocks.map(s => [s.slug, s.kept_count ?? 0])),
    },
    // Curated entity register (docs/curated/wallets.json) — labels for
    // collective/public wallets. Pages read THIS; none may hardcode a label.
    entities,
    entities_status: entitiesStatus,
    // Structural contracts published for downstream/site convenience. Source of
    // truth is config/contracts.js — this is a generated copy, never hand-edited.
    contracts: {
      gauge_controller: { addr: C.GAUGE_CONTROLLER.addr, role: C.GAUGE_CONTROLLER.role },
      voting_escrow:    { addr: C.VOTING_ESCROW.addr,    role: C.VOTING_ESCROW.role },
      bribe_manager:    { addr: C.BRIBE_MANAGER.addr,    role: C.BRIBE_MANAGER.role },
      compounder:       { addr: C.COMPOUNDER.addr,       role: C.COMPOUNDER.role },
      dao_main_wallet:  { addr: C.DAO_MAIN_WALLET.addr,  role: C.DAO_MAIN_WALLET.role },
      arb_luna_hub:     { addr: C.ARB_LUNA_HUB.addr,     role: C.ARB_LUNA_HUB.role },
      staking_buckets:  C.STAKING_BUCKETS,
    },
    addresses,
    by_address: byAddress,
  };

  const heartbeat = {
    schemaVersion: 1,
    cron: 'address-catalog',
    capturedAt: startedAt.toISOString(),
    capturedAtUnix: startedAt.getTime(),
    runId: `catalog-${startedAt.getTime()}`,
    runMode: 'daily',
    status: overall,
    stats: {
      currentEpoch: epochInfo?.number ?? null,
      unique_addresses: Object.keys(byAddress).length,
      total_address_rows: addresses.length,
      by_slug: Object.fromEntries(slugBlocks.map(s => [s.slug, s.kept_count ?? 0])),
    },
    next_expected_run_at: new Date(startedAt.getTime() + (RUN_EVERY_HOURS + 1) * 3600 * 1000).toISOString(),
  };

  // Lightweight manifest — recomputed each run (no prior-state read; forward-only).
  const index = {
    schemaVersion: 1,
    module: 'catalog',
    product: 'snapshots',
    latest: 'current.json',
    latest_daily: `daily/${dayStr}.json`,
    updated_at: startedAt.toISOString(),
    counts: {
      unique_addresses: Object.keys(byAddress).length,
      total_address_rows: addresses.length,
      by_slug: Object.fromEntries(slugBlocks.map(s => [s.slug, s.kept_count ?? 0])),
    },
  };

  const catContent = JSON.stringify(catalog, null, 2);
  const hbContent  = JSON.stringify(heartbeat, null, 2);
  const idxContent = JSON.stringify(index, null, 2);
  fs.writeFileSync('catalog.json', catContent);
  fs.writeFileSync('heartbeat.json', hbContent);

  if (GITHUB_TOKEN) {
    // Write order: current → daily → index → heartbeat LAST (per storage design).
    await publishFile('catalog/snapshots/current.json', catContent, `catalog ${overall} — ${Object.keys(byAddress).length} addresses`);
    console.log('  ✓ catalog/snapshots/current.json');
    await publishFile(`catalog/snapshots/daily/${dayStr}.json`, catContent, `catalog daily ${dayStr} — ${overall}`);
    console.log(`  ✓ catalog/snapshots/daily/${dayStr}.json`);
    await publishFile('catalog/snapshots/index.json', idxContent, `catalog index — ${dayStr}`);
    console.log('  ✓ catalog/snapshots/index.json');
    await publishFile('catalog/snapshots/heartbeat.json', hbContent, `heartbeat ${overall}`);
    // 1.3.0 trust product — after the catalog, never blocks it
    try {
      const trusted = await buildTrustedProduct(curWallets);
      for (const i of trusted.meta.issues) console.log(`  ⚠ trusted-addresses: ${i}`);
      await publishFile('catalog/trusted/current.json', JSON.stringify(trusted, null, 1), `trusted ${trusted.meta.status} — ${trusted.addresses.length} addresses, ${trusted.meta.counts.human_only} human-only`);
      console.log(`  ✓ trusted product: ${trusted.addresses.length} addresses (${JSON.stringify(trusted.meta.counts.by_method)})`);
    } catch (e) { console.log(`  ✗ trusted product failed: ${e.message.slice(0, 120)}`); }
    console.log('  ✓ catalog/snapshots/heartbeat.json');
  } else {
    console.log('  (no GITHUB_TOKEN — wrote local catalog.json + heartbeat.json only)');
  }

  console.log(`\n✅ Done — ${overall} — ${Object.keys(byAddress).length} unique addresses across ${slugBlocks.length} entities`);
  for (const s of slugBlocks) console.log(`   ${s.slug.padEnd(12)} ${String(s.kept_count).padStart(5)} kept  (${s.total_count} total, ${s.registered_count} named) — ${s.status}`);
  if (overall === 'error') process.exitCode = 1;
}

run().catch(e => { console.error('FATAL', e); process.exit(1); });
