// =============================================================================
// Token-Catalog Cron — STAGE 1: DISCOVERY (the WORTH layer's foundation)
// =============================================================================
//
// WHY THIS EXISTS
// ---------------
// "You can't price what you don't know exists." Before token-catalog can value
// anything, it must enumerate the COMPLETE set of pools in TLA (active AND
// inactive) and resolve every LP to its underlying tokens. That token set is the
// price list — pricing (Stage 3) values exactly what discovery finds, nothing
// more (not all of Astroport/SkeletonSwap/Credia — only what's in TLA).
//
// This cron consolidates the discovery half of three legacy crons
// (network-and-prices, contract-token-catalog, chain/tla-registry) into one
// forward-only capture. It is built in STAGES so each is verifiable on a parallel
// run before the next is layered on:
//   STAGE 1 (this file) — discovery: pools (active+inactive) + underlying tokens
//   STAGE 2 (next)      — identity: native/IBC/wrapped, route, logo, variations,
//                         + the per-field override layer (token_overrides.json)
//   STAGE 3 (next)      — pricing: DEX / TLA-hub / CoinGecko + agreement (#9)
// Reserves & slippage (#10/#11) are deliberately OUT — those are the dex-data
// domain.
//
// DISCOVERY CHAIN (grounded in queries.md + proven in tla-registry)
//   1. ACTIVE pools   — gauge `distributions` (active set + vote %).
//   2. INACTIVE pools — `whitelisted_asset_details` on each of the 4 staking
//                       buckets. Returns the COMPLETE set incl. below-threshold
//                       and dewhitelisted, each flagged `whitelisted:true|false`
//                       with take-rate metadata. (Phase-0 scar: this query, NOT
//                       `whitelisted_assets`, which is active-only.)
//   3. UNDERLYINGS    — for each LP: cw20 LP → `minter` → pair → `pair{}`
//                       asset_infos; native/factory LP → pair from
//                       `factory/{addr}/` denom → `pair{}`. Each underlying denom
//                       is distinct (wBTC.axl ≠ wBTC.eureka — variations are
//                       preserved, resolved in Stage 2).
//
// OUTPUT — tla-core `token-catalog` module, snapshots product (progressively
// enriched: Stage 2/3 add fields to the SAME current.json; the page reads it
// throughout):
//   token-catalog/snapshots/current.json        pools[] + tokens[]
//   token-catalog/snapshots/daily/{date}.json   forward-only daily snapshot
//   token-catalog/snapshots/index.json          manifest
//   token-catalog/snapshots/heartbeat.json      standard heartbeat
//
// Structural addresses come from config/contracts.js (single source). Reuses the
// shared engine (capture-engine: queryContract, parallelMap, currentEpochInfo).
// Render: root platform-crons/token-catalog, build `npm i`, start
//   `node token-catalog.js`, env GITHUB_TOKEN (scoped thealliancedao/tla-core).
// =============================================================================

'use strict';
const fs = require('fs');
const https = require('https');

const {
  queryContract,
  parallelMap,
  currentEpochInfo,
  BATCH_CONCURRENCY,
  fetchJson,
  TERRA_LCD_PRIMARY,
  TERRA_LCD_FALLBACK,
} = require('../lib/capture-engine.js');

// Single source of truth for structural addresses (see config/contracts.js).
const C = require('../config/contracts.js');

const GITHUB_TOKEN    = process.env.GITHUB_TOKEN;
const GITHUB_REPO     = process.env.GITHUB_REPO   || 'thealliancedao/tla-core';
const GITHUB_BRANCH   = process.env.GITHUB_BRANCH || 'main';
const RUN_EVERY_HOURS = Number(process.env.RUN_EVERY_HOURS || 6); // pricing wants fresher than catalog; discovery alone is cheap

// Bucket name -> staking contract (from config). The gauge returns bucket NAMES.
const BUCKET_CONTRACTS = C.STAKING_BUCKETS;

// -----------------------------------------------------------------------------
// cw2 contract_info via raw storage (LCD /raw/). Astroport/WW pair contracts
// reject {contract_info:{}} as a smart query but DO store {contract,version} at
// the standard cw2 raw key. Lifted verbatim from tla-registry (Rev 0.15 fix).
// Gives us the DEX label (Astroport vs Skeleton Swap) + version — what makes two
// same-pair pools on different DEXes distinguishable.
// -----------------------------------------------------------------------------
async function queryContractRaw(contractAddr, storageKey) {
  const keyB64 = Buffer.from(storageKey, 'utf-8').toString('base64');
  const path = `/cosmwasm/wasm/v1/contract/${contractAddr}/raw/${keyB64}`;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const r = await fetchJson(TERRA_LCD_PRIMARY + path, `cw2 ${contractAddr.slice(0,10)}`);
      if (!r?.data) return null;
      try { return JSON.parse(Buffer.from(r.data, 'base64').toString('utf-8')); } catch { return null; }
    } catch { if (attempt < 2) await new Promise(res => setTimeout(res, 200 + Math.random() * 300)); }
  }
  try {
    const r = await fetchJson(TERRA_LCD_FALLBACK + path, `cw2 ${contractAddr.slice(0,10)} fb`);
    if (!r?.data) return null;
    try { return JSON.parse(Buffer.from(r.data, 'base64').toString('utf-8')); } catch { return null; }
  } catch { return null; }
}

// Map a cw2 contract name → { contract, version, dex }.
function dexFromContract(cw2) {
  let contract = cw2?.contract || null;
  if (contract && contract.startsWith('crates.io:')) contract = contract.slice(10);
  let dex = null;
  if (contract) {
    if (contract.startsWith('white_whale')) dex = 'Skeleton Swap';
    else if (contract.startsWith('astroport')) dex = 'Astroport';
    // non-DEX contracts (Eris vaults etc.) stay dex:null but keep contract/version
  }
  return { contract, version: cw2?.version || null, dex };
}

// -----------------------------------------------------------------------------
// STAGE 1a — ACTIVE pools: gauge `distributions` (active set + vote %).
// Faithful port of tla-registry's distributions parse (handles both the
// array-pair and object response shapes seen across gauge versions).
// -----------------------------------------------------------------------------
async function fetchActivePools() {
  const distributionsRaw = await queryContract(C.GAUGE_CONTROLLER.addr, { distributions: {} });
  const pools = [];
  const bucketStats = {};
  let ok = false;

  if (distributionsRaw && Array.isArray(distributionsRaw)) {
    ok = true;
    for (const gaugeEntry of distributionsRaw) {
      let gaugeName, gaugeData;
      if (Array.isArray(gaugeEntry) && gaugeEntry.length >= 2) { gaugeName = gaugeEntry[0]; gaugeData = gaugeEntry[1]; }
      else if (gaugeEntry && typeof gaugeEntry === 'object') { gaugeName = gaugeEntry.gauge || gaugeEntry.bucket || gaugeEntry.name; gaugeData = gaugeEntry; }
      if (!gaugeName || !gaugeData) continue;

      const dists = gaugeData.assets || gaugeData.distribution || gaugeData.distributions || [];
      bucketStats[gaugeName] = { total_gauge_vp: gaugeData.total_gauge_vp || gaugeData.total_vp || null, pool_count: 0 };

      for (const d of (Array.isArray(dists) ? dists : [])) {
        const asset = d.asset || d[0];
        const distribution = d.distribution ?? d[1] ?? null;
        const total_vp = d.total_vp ?? d[2] ?? null;
        if (!asset) continue;
        const gaugePoolId = asset.cw20 ? `cw20:${asset.cw20}` : asset.native ? `native:${asset.native}` : `unknown:${JSON.stringify(asset)}`;
        pools.push({
          gauge_pool_id: gaugePoolId,
          bucket: gaugeName,
          lp_address: asset.cw20 || asset.native || null,
          lp_type: asset.cw20 ? 'cw20' : asset.native ? 'native' : 'unknown',
          asset_raw: asset,
          gauge_status: 'active',
          distribution_pct: distribution != null ? Number(distribution) : null,
          total_vp: total_vp != null ? String(total_vp) : null,
          take_rate: null,
        });
        bucketStats[gaugeName].pool_count++;
      }
    }
  }
  console.log(`  active: ${pools.length} pools across ${Object.keys(bucketStats).length} buckets ${ok ? '' : '(QUERY FAILED)'}`);
  return { pools, ok, bucketStats };
}

// -----------------------------------------------------------------------------
// STAGE 1b — INACTIVE pools: `whitelisted_asset_details` per bucket.
// Faithful port of tla-registry's expandToInactiveLPs. Returns LPs beyond the
// active set: below-threshold (whitelisted:true) and dewhitelisted
// (whitelisted:false, still take-rate exposed). Per-bucket failure is non-fatal.
// -----------------------------------------------------------------------------
async function fetchInactivePools(activePools) {
  const extraPools = [];
  const activeKeys = new Set(activePools.map(p => p.gauge_pool_id));
  const stats = { contractsChecked: 0, contractsSucceeded: 0, belowThreshold: 0, dewhitelisted: 0 };

  for (const [bucketName, stakingAddr] of Object.entries(BUCKET_CONTRACTS)) {
    if (!stakingAddr) continue;
    stats.contractsChecked++;
    const result = await queryContract(stakingAddr, { whitelisted_asset_details: {} });
    if (!result) { console.warn(`  ⚠ whitelisted_asset_details[${bucketName}] failed — active-only for this bucket`); continue; }
    stats.contractsSucceeded++;

    let assetList = result;
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      assetList = result.data || result.assets || result.whitelisted_assets || result.list || [];
    }
    if (!Array.isArray(assetList)) continue;

    for (const entry of assetList) {
      const info = entry?.info;
      if (!info || typeof info !== 'object') continue;
      const lpAddr = info.cw20 || info.native;
      if (!lpAddr) continue;

      const gaugePoolId = info.cw20 ? `cw20:${info.cw20}` : `native:${info.native}`;
      if (activeKeys.has(gaugePoolId)) continue;  // already active

      const isWhitelisted = entry.whitelisted === true;
      const cfg = entry.config || {};
      const gaugeStatus = isWhitelisted ? 'inactive_below_threshold' : 'dewhitelisted';
      if (isWhitelisted) stats.belowThreshold++; else stats.dewhitelisted++;

      let stakeMechanism = null;
      if (cfg.stake_config === 'default') stakeMechanism = 'default';
      else if (cfg.stake_config && typeof cfg.stake_config === 'object') stakeMechanism = Object.keys(cfg.stake_config)[0] || null;

      extraPools.push({
        gauge_pool_id: gaugePoolId,
        bucket: bucketName,
        lp_address: lpAddr,
        lp_type: info.cw20 ? 'cw20' : 'native',
        asset_raw: info,
        gauge_status: gaugeStatus,
        distribution_pct: 0,
        total_vp: null,
        take_rate: {
          yearly_rate: cfg.yearly_take_rate || null,
          taken_raw: cfg.taken || null,
          harvested_raw: cfg.harvested || null,
          last_taken_s: cfg.last_taken_s || null,
          stake_mechanism: stakeMechanism,
        },
      });
      activeKeys.add(gaugePoolId);
    }
  }
  console.log(`  inactive: ${extraPools.length} extra (${stats.belowThreshold} below-threshold, ${stats.dewhitelisted} dewhitelisted) from ${stats.contractsSucceeded}/${stats.contractsChecked} buckets`);
  return { extraPools, stats };
}

// -----------------------------------------------------------------------------
// STAGE 1c — UNDERLYINGS: resolve each LP to its underlying token denoms.
// Faithful port of buildLpUniverse's pair-resolution path. cw20 LP → minter →
// pair → pair{}.asset_infos; native/factory LP → pair from factory/{addr}/ →
// pair{}. Architecture: pair_type + pair_address captured here; contract/version
// /dex (cw2 raw read) deferred to a later enrichment (needs queryContractRaw).
// -----------------------------------------------------------------------------
async function resolveUnderlyings(pools) {
  // resolution outcomes:
  //   'lp'           — two-sided LP, underlyings resolved
  //   'single_asset' — no pair by design (xASTRO, wBTC.creda.a, ampCAPA, …); the
  //                    underlying IS the staked token. NOT a failure.
  //   'query_failed' — a minter/pair query returned null (real chain-read failure).
  //                    This is the ONLY outcome that degrades status.
  const stats = { total: pools.length, lp: 0, single_asset: 0, query_failed: 0 };

  await parallelMap(pools, async (pool) => {
    const raw = pool.asset_raw || {};
    const lpAddr = raw.cw20 || raw.native;
    pool.underlyings = [];
    pool.architecture = null;
    pool.pool_kind = 'lp';        // refined below
    pool.resolution = null;

    if (!lpAddr) { pool.pool_kind = 'single_asset'; pool.resolution = 'single_asset'; stats.single_asset++; return; }

    // Resolve the pair address.
    let pairAddr = null;
    if (raw.native) {
      const m = lpAddr.match(/^factory\/(terra1[a-z0-9]+)\//);
      pairAddr = m ? m[1] : null;
      if (!pairAddr) {
        // A bare native/IBC denom staked directly = single-asset (e.g. xASTRO ibc/…).
        pool.pool_kind = 'single_asset'; pool.resolution = 'single_asset';
        pool.underlyings = [lpAddr];   // underlying = the staked token itself
        stats.single_asset++; return;
      }
    } else {
      const minterResp = await queryContract(lpAddr, { minter: {} });
      // null = the cw20 has no minter (not an LP token) → single-asset stake, NOT a
      // chain failure. (A genuine transport failure would also land here, but these
      // are a small, known, dewhitelist-stable set; we don't degrade status on it.)
      pairAddr = minterResp?.minter || minterResp?.address || null;
      if (!pairAddr) {
        pool.pool_kind = 'single_asset'; pool.resolution = 'single_asset';
        pool.underlyings = [lpAddr];   // underlying = the staked token itself
        stats.single_asset++; return;
      }
    }

    const pairResp = await queryContract(pairAddr, { pair: {} });
    if (pairResp === null) {
      // The pair query itself failed to return — a real chain-read failure.
      pool.resolution = 'query_failed'; stats.query_failed++; return;
    }
    if (!Array.isArray(pairResp.asset_infos) || pairResp.asset_infos.length < 2) {
      // Resolved but not a two-sided pair → treat as single-asset.
      pool.pool_kind = 'single_asset'; pool.resolution = 'single_asset';
      pool.underlyings = [lpAddr];
      stats.single_asset++; return;
    }

    // Normalize pair_type (string or object form across Astroport versions).
    const ptRaw = pairResp.pair_type;
    let pairType = typeof ptRaw === 'string' ? ptRaw : (ptRaw && typeof ptRaw === 'object' ? Object.keys(ptRaw)[0] : null);
    if (pairType === 'stable_swap') pairType = 'stable';
    else if (pairType === 'xyk') pairType = 'constant_product';

    const u = [];
    for (const info of pairResp.asset_infos) {
      const t = info.token?.contract_addr || info.native_token?.denom;
      if (t) u.push(t);
    }
    pool.underlyings = u;
    pool.pool_kind = 'lp';
    pool.resolution = 'lp';
    // Architecture: pair_type from pair{}, + DEX/contract/version from cw2 raw read.
    const cw2 = await queryContractRaw(pairAddr, 'contract_info');
    const arch = dexFromContract(cw2);
    // Astroport's concentrated pairs report pair_type 'custom' — resolve via contract name.
    if (pairType === 'custom' && arch.contract && arch.contract.includes('concentrated')) pairType = 'concentrated';
    pool.architecture = { pair_address: pairAddr, pair_type: pairType, ...arch };
    stats.lp++;
  }, BATCH_CONCURRENCY);

  console.log(`  resolution: ${stats.lp} LPs, ${stats.single_asset} single-asset, ${stats.query_failed} query-failed`);
  return stats;
}

// -----------------------------------------------------------------------------
// STAGE 1d — assemble the unique token set (the price list).
// Each distinct denom is its own token (variations preserved). Identity and
// price fields are stubbed null here — Stage 2/3 fill them (anticipated schema).
// -----------------------------------------------------------------------------
function assembleTokens(pools) {
  const byDenom = {};
  for (const pool of pools) {
    for (const denom of (pool.underlyings || [])) {
      const tok = byDenom[denom] || (byDenom[denom] = {
        denom,
        kind: denom.startsWith('terra1') ? 'cw20' : denom.startsWith('ibc/') ? 'ibc' : denom.startsWith('factory/') ? 'factory' : 'native',
        found_in_pools: [],
        // STAGE 2 (identity, override blocks): symbol, name, decimals, route, logo, variation_of, coingecko_id
        // STAGE 3 (pricing): prices{ dex, hub, coingecko }, agreement
      });
      if (!tok.found_in_pools.includes(pool.gauge_pool_id)) tok.found_in_pools.push(pool.gauge_pool_id);
    }
  }
  return Object.values(byDenom).sort((a, b) => b.found_in_pools.length - a.found_in_pools.length);
}

// -----------------------------------------------------------------------------
// STAGE 2 — IDENTITY (discovered): symbol, decimals, logo, coingecko_id, variations.
//
// Doctrine: the cron writes only what it DISCOVERS. The cosmos chain-registry is
// the authoritative discovered source (canonical symbol/decimals/logo/cg_id +
// bridge traces). SkeletonSwap backfills logos for wrapped tokens the registry
// doesn't list. Tokens that NO feed authoritatively names are left with a null
// discovered symbol — that is honest, and the curated override is where their
// name legitimately lives (merged on read by the page, never written here).
//
// CG-verification, acquisition_class, and identity scoring build ON this in 2.1.
// -----------------------------------------------------------------------------
const IDENTITY_SOURCES = {
  chain_registry: 'https://raw.githubusercontent.com/cosmos/chain-registry/master/terra2/assetlist.json',
  skeletonswap:   'https://dex.warlock.backbonelabs.io/api/pools/phoenix-1',
};

// Fetch the identity feeds. Each is best-effort: a failure degrades THAT source
// to null (recorded in identity_stats.sources_ok), never the whole run.
async function fetchIdentitySources() {
  const out = { chain_registry: null, skeletonswap: null };
  const ok = {};
  try { out.chain_registry = await fetchJson(IDENTITY_SOURCES.chain_registry, 'chain-registry'); }
  catch (e) { out.chain_registry = null; }
  ok.chain_registry = !!(out.chain_registry && Array.isArray(out.chain_registry.assets));
  try { out.skeletonswap = await fetchJson(IDENTITY_SOURCES.skeletonswap, 'skeletonswap-pools'); }
  catch (e) { out.skeletonswap = null; }
  ok.skeletonswap = !!out.skeletonswap;
  return { feeds: out, ok };
}

// Index chain-registry by denom (and cw20:addr → addr). Pulls symbol, decimals,
// logo, coingecko_id, and bridge counterparty denoms (for 2.1 verification).
function indexChainRegistry(assetlist) {
  const map = {};
  if (!assetlist || !Array.isArray(assetlist.assets)) return map;
  for (const a of assetlist.assets) {
    const base = a.base;
    if (!base) continue;
    const units = a.denom_units || [];
    let decimals = null;
    const disp = a.display;
    for (const u of units) if (u.denom === disp) decimals = u.exponent;
    if (decimals == null) decimals = units.reduce((m, u) => Math.max(m, u.exponent || 0), 0) || null;
    const img = (a.images && a.images[0]) || {};
    const uris = a.logo_URIs || {};
    const rec = {
      symbol: a.symbol || null,
      decimals,
      logo_url: img.png || img.svg || uris.png || uris.svg || null,
      coingecko_id: a.coingecko_id || null,
      bridge_traces: (a.traces || []).map(t => t.counterparty && t.counterparty.base_denom).filter(Boolean),
    };
    map[base] = rec;
    if (base.startsWith('cw20:')) map[base.slice(5)] = rec;
  }
  return map;
}

// Index SkeletonSwap pools → denom → { symbol, decimals, logo_url }.
function indexSkeletonSwap(pools) {
  const map = {};
  if (!pools) return map;
  const arr = Array.isArray(pools) ? pools : (pools.data || pools.pools || []);
  for (const p of arr) {
    for (const tk of [p.token_0, p.token_1]) {
      if (!tk || !tk.denom) continue;
      let d = tk.denom;
      if (d.startsWith('cw20:')) d = d.slice(5);
      if (!map[d]) map[d] = { symbol: tk.symbol || null, decimals: tk.decimals ?? null, logo_url: tk.logo_url || null };
    }
  }
  return map;
}

// Strip a trailing .suffix (wBTC.atom → wBTC) to group variations of a base asset.
function baseSymbol(sym) {
  if (!sym) return null;
  return sym.replace(/\.[a-z0-9]+$/i, '');
}

function enrichIdentity(tokens, indexed) {
  const cr = indexed.chain_registry || {};
  const ss = indexed.skeletonswap || {};
  let symbolsResolved = 0, logosResolved = 0;

  for (const t of tokens) {
    const d = t.denom;
    const crRec = cr[d] || cr['cw20:' + d] || null;
    const ssRec = ss[d] || null;

    // subtype is the on-chain kind, exposed as a discovered identity field
    t.subtype = t.kind;

    // discovered identity — chain-registry authoritative; SS backfills logo only.
    const symbol = (crRec && crRec.symbol) || null;
    const decimals = (crRec && crRec.decimals != null) ? crRec.decimals
                   : (ssRec && ssRec.decimals != null) ? ssRec.decimals : null;
    const logo_url = (crRec && crRec.logo_url) || (ssRec && ssRec.logo_url) || null;
    const coingecko_id = (crRec && crRec.coingecko_id) || null;

    t.discovered = {
      symbol,
      display_name: symbol,        // discovered display defaults to symbol; override can refine
      decimals,
      logo_url,
      coingecko_id,
      variation_of: baseSymbol(symbol),
    };
    // raw per-source records, for transparency + 2.1 verification (never the price)
    t.sources = {
      chain_registry: crRec,
      skeletonswap: ssRec ? { symbol: ssRec.symbol, decimals: ssRec.decimals, logo_url: ssRec.logo_url } : null,
    };
    // honest flags
    t.identity_flags = [];
    if (!symbol) t.identity_flags.push('no_discovered_symbol');      // override is its rightful home
    if (!coingecko_id) t.identity_flags.push('no_discovered_coingecko_id');
    // cross-source symbol disagreement (when SS also names it)
    if (symbol && ssRec && ssRec.symbol &&
        baseSymbol(symbol).toLowerCase() !== baseSymbol(ssRec.symbol).toLowerCase()) {
      t.identity_flags.push(`cross_source_name_mismatch:cr=${symbol},ss=${ssRec.symbol}`);
    }

    if (symbol) symbolsResolved++;
    if (logo_url) logosResolved++;
  }

  // variation groups: base symbol → [denoms] where >1 variant exists
  const groups = {};
  for (const t of tokens) {
    const b = t.discovered.variation_of;
    if (!b) continue;
    (groups[b] = groups[b] || []).push(t.denom);
  }
  for (const t of tokens) {
    const b = t.discovered.variation_of;
    t.discovered.has_variations = !!(b && groups[b] && groups[b].length > 1);
  }

  return { symbolsResolved, logosResolved, total: tokens.length };
}

// -----------------------------------------------------------------------------
// STAGE 2.1 — VERIFICATION + IDENTITY SCORE
//
// Verifies each token's DISCOVERED coingecko_id against CoinGecko's own terra-2
// index (built by the manual GitHub Action, committed to tla-core/curated). Then
// computes the identity sub-score — honest about provenance:
//
//   cg_confirmed      CoinGecko's terra-2 index maps this cw20 address → the same
//                     id we discovered. Strongest: CG itself confirms it.
//   registry_assigned The cosmos chain-registry assigns this id, but CG doesn't
//                     index the token on terra-2 (normal for IBC/native — CG
//                     indexes those on their origin chain). Trustworthy source,
//                     not CG-self-confirmed. (Full bridge-origin verification is a
//                     future step needing CG's multi-chain index — see spec.)
//   mismatch          CG's index has a DIFFERENT id for this address. Red flag.
//   no_mapping        No coingecko_id discovered at all.
//
// Identity score (0–100) composes: cg state + symbol presence + logo presence +
// cross-source name agreement. This is the IDENTITY sub-score only; the composite
// overall grade (price 0.75 / identity 0.25) is computed once pricing (Stage 3)
// lands, using the editable scoring_weights config.
// -----------------------------------------------------------------------------
const CG_INDEX_URL = 'https://raw.githubusercontent.com/thealliancedao/tla-core/main/docs/curated/coingecko-terra2-index.json';

async function fetchCgIndex() {
  try {
    const idx = await fetchJson(CG_INDEX_URL, 'coingecko-index');
    if (idx && idx.by_address) {
      const m = {};
      for (const [a, id] of Object.entries(idx.by_address)) m[a.toLowerCase()] = id;
      return { byAddress: m, meta: idx._meta || null, ok: true };
    }
  } catch (e) { /* index missing/unreachable — verification degrades, not fatal */ }
  return { byAddress: {}, meta: null, ok: false };
}

function verifyAndScore(tokens, cgIndex, weights) {
  const ba = cgIndex.byAddress || {};
  let confirmed = 0, mismatched = 0;

  for (const t of tokens) {
    const dsc = t.discovered || {};
    const claimed = dsc.coingecko_id || null;
    const denom = t.denom;
    const addr = denom.startsWith('terra1') ? denom.toLowerCase() : null;  // cw20 verifies by contract address

    let match;
    if (!claimed) {
      match = 'no_mapping';
    } else if (addr && ba[addr]) {
      match = (ba[addr] === claimed) ? 'cg_confirmed' : 'mismatch';
      if (match === 'cg_confirmed') confirmed++; else mismatched++;
    } else {
      // claimed id present, but not a cw20 confirmable on terra-2 → trust the
      // discovery source (chain-registry) but mark it as registry-assigned.
      match = 'registry_assigned';
    }

    // ---- identity sub-score ----
    let score = 100;
    const inputs = {};
    if (match === 'cg_confirmed')        { inputs.coingecko = 0;   }
    else if (match === 'registry_assigned') { score -= 5;  inputs.coingecko = -5; }
    else if (match === 'mismatch')       { score -= 30; inputs.coingecko = -30; }
    else /* no_mapping */                { score -= 25; inputs.coingecko = -25; }

    if (!dsc.symbol)   { score -= 15; inputs.no_discovered_symbol = -15; }  // identity rests entirely on override
    if (!dsc.logo_url) { score -= 10; inputs.no_logo = -10; }
    if ((t.identity_flags || []).some(f => f.startsWith('cross_source_name_mismatch'))) {
      score -= 15; inputs.cross_source_name_mismatch = -15;
    }
    score = Math.max(0, Math.min(100, score));

    t.scoring = {
      identity: { score, match, inputs },
      price: null,                 // Stage 3
      overall: null,               // computed when price lands, via weights
      weights: { price: weights.price, identity: weights.identity },
    };
    // surface the match in flags too (descriptive)
    if (match === 'mismatch') t.identity_flags.push(`coingecko_mismatch:claimed=${claimed},cg_index=${ba[addr]}`);
  }

  return { confirmed, mismatched, indexOk: cgIndex.ok };
}

// -----------------------------------------------------------------------------
// STAGE 3 — PRICING (snapshot-coherent, multi-source) + composite grade
//
// Each source is ONE bulk call, fetched in a tight parallel batch so all prices
// share a coherent capture window (prices fetched seconds apart turn normal market
// movement into a fake spread). Every price is stamped with its capture instant;
// spread is computed only across reads inside one window.
//
// 3.0 wires the two DIRECT-USD canonical sources:
//   TLA       backend.erisprotocol.com/prices   denom -> price_usd (what the TLA UI shows)
//   CoinGecko simple/price?ids=...              coingecko_id -> usd (external reference)
// Astroport (direct) + SkeletonSwap (pair-implied) join in 3.1 — the confidence
// math below is source-count-agnostic, so they plug in without changes.
//
// Confidence is DESCRIPTIVE: more independent sources that agree -> higher grade;
// a single source is simply lower-confidence, stated neutrally. Wide divergence is
// a token-health signal (LP risk), never an accusation.
// -----------------------------------------------------------------------------
const PRICE_SOURCES = {
  tla: 'https://backend.erisprotocol.com/prices',
  coingecko: 'https://api.coingecko.com/api/v3/simple/price',
};
const AGREE_TOLERANCE_PCT = 2.0;   // within this of the median counts as "agreeing"

async function fetchPrices(tokens) {
  const captured_at = new Date().toISOString();
  // collect the coingecko ids we'll ask for (discovered)
  const cgIds = [...new Set(tokens.map(t => t.discovered && t.discovered.coingecko_id).filter(Boolean))];
  const cgUrl = PRICE_SOURCES.coingecko + '?ids=' + encodeURIComponent(cgIds.join(',')) + '&vs_currencies=usd';

  // tight parallel batch — one bulk call each
  const [tlaRes, cgRes] = await Promise.allSettled([
    fetchJson(PRICE_SOURCES.tla, 'tla-prices'),
    cgIds.length ? fetchJson(cgUrl, 'coingecko-price') : Promise.resolve({}),
  ]);

  const tla = tlaRes.status === 'fulfilled' ? tlaRes.value : null;
  const cg = cgRes.status === 'fulfilled' ? cgRes.value : null;

  // index TLA: denom -> price_usd (shape: denom -> { price_usd, decimals, display, coingecko_id? })
  const tlaByDenom = {};
  if (tla && typeof tla === 'object') {
    for (const [denom, v] of Object.entries(tla)) {
      const p = (v && (v.price_usd ?? v.priceUsd ?? v.price));
      if (p != null && isFinite(Number(p))) tlaByDenom[denom] = Number(p);
    }
  }
  // index CoinGecko: id -> usd (shape: id -> { usd })
  const cgById = {};
  if (cg && typeof cg === 'object') {
    for (const [id, v] of Object.entries(cg)) {
      const p = v && v.usd;
      if (p != null && isFinite(Number(p))) cgById[id] = Number(p);
    }
  }
  return {
    captured_at,
    sources_ok: { tla: !!tla, coingecko: cgIds.length ? !!cg : null },
    tlaByDenom, cgById,
  };
}

function median(nums) {
  const s = nums.slice().sort((a, b) => a - b);
  const n = s.length;
  if (!n) return null;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

// Compute confidence over WHATEVER source usd prices are present (1..N).
function priceConfidence(sourceUsd) {
  const vals = Object.values(sourceUsd).map(s => s.usd).filter(v => v != null && isFinite(v));
  const n = vals.length;
  const flags = [];
  if (n === 0) return { sources_available: 0, sources_agreeing: 0, spread_pct: null, score: null, flags: ['no_price_source'] };

  const med = median(vals);
  const spread_pct = med > 0 ? ((Math.max(...vals) - Math.min(...vals)) / med) * 100 : 0;
  const agreeing = vals.filter(v => med > 0 && Math.abs(v - med) / med * 100 <= AGREE_TOLERANCE_PCT).length;

  let score;
  if (n === 1) { score = 55; flags.push('single_source'); }            // a price, but nothing to cross-check
  else if (spread_pct < 1)  score = 100;
  else if (spread_pct < AGREE_TOLERANCE_PCT) score = 90;
  else if (spread_pct < 5)  { score = 70; flags.push('minor_divergence'); }
  else { score = 50; flags.push('wide_divergence'); }                  // sources genuinely disagree → LP risk signal

  return { sources_available: n, sources_agreeing: agreeing, spread_pct: Number(spread_pct.toFixed(3)), score, flags };
}

function attachPricesAndGrade(tokens, priced, weights) {
  let pricedCount = 0;
  for (const t of tokens) {
    const denom = t.denom;
    const cgId = t.discovered && t.discovered.coingecko_id;
    const tlaUsd = priced.tlaByDenom[denom];
    const cgUsd = cgId ? priced.cgById[cgId] : undefined;

    const sourceUsd = {};
    sourceUsd.tla = { usd: tlaUsd != null ? tlaUsd : null, captured_at: priced.captured_at, status: tlaUsd != null ? 'ok' : 'no_data' };
    sourceUsd.coingecko = { usd: cgUsd != null ? cgUsd : null, captured_at: priced.captured_at, status: cgUsd != null ? 'ok' : (cgId ? 'no_data' : 'no_id') };

    const conf = priceConfidence(
      Object.fromEntries(Object.entries(sourceUsd).filter(([, s]) => s.usd != null))
    );

    t.prices = sourceUsd;
    t.snapshot_window_ms = 0;   // 3.0 fetches in one batch; real window populated when DEX feeds carry own timestamps (3.1)
    t.price_confidence = conf;
    if (conf.sources_available > 0) pricedCount++;

    // ---- composite overall grade (now real) ----
    const idScore = (t.scoring && t.scoring.identity && t.scoring.identity.score != null) ? t.scoring.identity.score : null;
    const pScore = conf.score;
    let overall = null, partial = false;
    if (pScore != null && idScore != null) {
      overall = Math.round(weights.price * pScore + weights.identity * idScore);
    } else if (idScore != null && pScore == null) {
      overall = idScore; partial = true;   // no price yet — don't fake a 0; grade on identity, mark partial
    } else if (pScore != null && idScore == null) {
      overall = pScore; partial = true;
    }
    t.scoring = t.scoring || {};
    t.scoring.price = pScore;
    t.scoring.overall = overall;
    t.scoring.partial = partial;
    t.scoring.weights = { price: weights.price, identity: weights.identity };
  }
  return { pricedCount };
}

// -----------------------------------------------------------------------------
// GitHub publish (standard platform helper)
// -----------------------------------------------------------------------------
function githubApiRequest(method, apiPath, body = null) {
  return new Promise((resolve, reject) => {
    const opts = { hostname: 'api.github.com', path: apiPath, method,
      headers: { 'User-Agent': 'token-catalog-cron/1.0', 'Authorization': `Bearer ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github+json' } };
    if (body) opts.headers['Content-Type'] = 'application/json';
    const req = https.request(opts, res => {
      let data = ''; res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) { try { resolve(JSON.parse(data)); } catch { resolve(data); } }
        else reject(new Error(`GitHub ${method} ${apiPath}: ${res.statusCode} ${data.slice(0, 200)}`));
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}
async function publishFile(filePath, content, message) {
  const apiPath = `/repos/${GITHUB_REPO}/contents/${filePath}`;
  let sha = null;
  try { sha = (await githubApiRequest('GET', apiPath + `?ref=${GITHUB_BRANCH}`)).sha; } catch (e) { /* new file */ }
  const body = { message, content: Buffer.from(content).toString('base64'), branch: GITHUB_BRANCH };
  if (sha) body.sha = sha;
  return githubApiRequest('PUT', apiPath, body);
}

// -----------------------------------------------------------------------------
// MAIN
// -----------------------------------------------------------------------------
async function run() {
  const startedAt = new Date();
  const dayStr = startedAt.toISOString().slice(0, 10);
  const epochInfo = currentEpochInfo();
  console.log(`\n🚀 Token-Catalog (Stage 1: discovery) — ${startedAt.toISOString()}\n`);

  console.log('🔎 Discovering pools...');
  const active = await fetchActivePools();
  const inactive = await fetchInactivePools(active.pools);
  const pools = [...active.pools, ...inactive.extraPools];

  console.log('🔗 Resolving underlyings...');
  const uStats = await resolveUnderlyings(pools);

  const tokens = assembleTokens(pools);
  console.log(`\n  → ${pools.length} pools, ${tokens.length} unique underlying tokens`);

  console.log('🪪 Stage 2: resolving discovered identity...');
  const idSrc = await fetchIdentitySources();
  const indexed = {
    chain_registry: indexChainRegistry(idSrc.feeds.chain_registry),
    skeletonswap: indexSkeletonSwap(idSrc.feeds.skeletonswap),
  };
  const idStats = enrichIdentity(tokens, indexed);
  console.log(`   identity: ${idStats.symbolsResolved}/${idStats.total} symbols, ${idStats.logosResolved}/${idStats.total} logos (chain-registry ${idSrc.ok.chain_registry ? 'ok' : 'FAILED'}, skeletonswap ${idSrc.ok.skeletonswap ? 'ok' : 'best-effort-miss'})`);

  console.log('🔐 Stage 2.1: verifying coingecko ids + scoring identity...');
  const weights = { price: 0.75, identity: 0.25 };  // default; editable via curated/scoring_weights.json (read by tools)
  const cgIndex = await fetchCgIndex();
  const verifyStats = verifyAndScore(tokens, cgIndex, weights);
  console.log(`   verification: ${verifyStats.confirmed} cg-confirmed, ${verifyStats.mismatched} mismatch (cg index ${verifyStats.indexOk ? 'ok' : 'MISSING — run the CoinGecko Action'})`);

  console.log('💲 Stage 3: pricing (snapshot-coherent) + composite grade...');
  const priced = await fetchPrices(tokens);
  const priceStats = attachPricesAndGrade(tokens, priced, weights);
  console.log(`   pricing: ${priceStats.pricedCount}/${tokens.length} tokens priced (tla ${priced.sources_ok.tla ? 'ok' : 'FAILED'}, coingecko ${priced.sources_ok.coingecko === null ? 'n/a' : priced.sources_ok.coingecko ? 'ok' : 'FAILED'})`);

  // Honest status: discovery is OK only if the active query worked. A bucket
  // failure or a genuine chain-read failure (query_failed) degrades to 'partial'.
  // Single-asset stakes are NOT failures — they're expected and resolved.
  let status = 'ok';
  if (!active.ok) status = 'error';
  else if (inactive.stats.contractsSucceeded < inactive.stats.contractsChecked || uStats.query_failed > 0) status = 'partial';
  // chain-registry is the authoritative identity source; if it failed, identity is degraded
  else if (!idSrc.ok.chain_registry) status = 'partial';
  // TLA is the canonical price source; if it failed, pricing is degraded
  else if (!priced.sources_ok.tla) status = 'partial';

  const catalog = {
    meta: {
      version: 'token-catalog-1.3.0-stage3',
      schemaVersion: 3,
      stage: 'discovery+identity+verification+pricing',
      generated_at: startedAt.toISOString(),
      epoch: epochInfo?.number ?? null,
      status,
      source: 'token-catalog cron (platform-crons/token-catalog)',
      note: 'discovered identity + coingecko verification + snapshot-coherent pricing (TLA + CoinGecko) + composite grade. Astroport/SkeletonSwap DEX divergence joins in 3.1. Overrides merge on read (never written here).',
    },
    counts: {
      pools_total: pools.length,
      pools_active: active.pools.length,
      pools_inactive: inactive.extraPools.length,
      pools_below_threshold: inactive.stats.belowThreshold,
      pools_dewhitelisted: inactive.stats.dewhitelisted,
      unique_tokens: tokens.length,
    },
    discovery_stats: {
      active_query_ok: active.ok,
      buckets_succeeded: inactive.stats.contractsSucceeded,
      buckets_checked: inactive.stats.contractsChecked,
      underlyings: uStats,
    },
    identity_stats: {
      sources_ok: idSrc.ok,
      symbols_resolved: idStats.symbolsResolved,
      logos_resolved: idStats.logosResolved,
      total_tokens: idStats.total,
      cg_index_ok: verifyStats.indexOk,
      cg_confirmed: verifyStats.confirmed,
      cg_mismatch: verifyStats.mismatched,
    },
    pricing_stats: {
      sources_ok: priced.sources_ok,
      tokens_priced: priceStats.pricedCount,
      total_tokens: tokens.length,
      captured_at: priced.captured_at,
    },
    pools,
    tokens,
  };

  const heartbeat = {
    schemaVersion: 1,
    cron: 'token-catalog',
    capturedAt: startedAt.toISOString(),
    capturedAtUnix: startedAt.getTime(),
    runId: `tokcat-${startedAt.getTime()}`,
    runMode: 'stage1-discovery',
    status,
    stats: {
      currentEpoch: epochInfo?.number ?? null,
      pools_total: pools.length,
      pools_active: active.pools.length,
      pools_inactive: inactive.extraPools.length,
      unique_tokens: tokens.length,
    },
    next_expected_run_at: new Date(startedAt.getTime() + (RUN_EVERY_HOURS + 1) * 3600 * 1000).toISOString(),
  };

  const index = {
    schemaVersion: 1, module: 'token-catalog', product: 'snapshots',
    latest: 'current.json', latest_daily: `daily/${dayStr}.json`,
    updated_at: startedAt.toISOString(), stage: 'discovery',
    counts: catalog.counts,
  };

  const catContent = JSON.stringify(catalog, null, 2);
  const hbContent  = JSON.stringify(heartbeat, null, 2);
  const idxContent = JSON.stringify(index, null, 2);
  fs.writeFileSync('token-catalog.json', catContent);
  fs.writeFileSync('heartbeat.json', hbContent);

  if (GITHUB_TOKEN) {
    await publishFile('token-catalog/snapshots/current.json', catContent, `token-catalog ${status} — ${pools.length} pools, ${tokens.length} tokens`);
    console.log('  ✓ token-catalog/snapshots/current.json');
    await publishFile(`token-catalog/snapshots/daily/${dayStr}.json`, catContent, `token-catalog daily ${dayStr} — ${status}`);
    console.log(`  ✓ token-catalog/snapshots/daily/${dayStr}.json`);
    await publishFile('token-catalog/snapshots/index.json', idxContent, `token-catalog index — ${dayStr}`);
    console.log('  ✓ token-catalog/snapshots/index.json');
    await publishFile('token-catalog/snapshots/heartbeat.json', hbContent, `heartbeat ${status}`);
    console.log('  ✓ token-catalog/snapshots/heartbeat.json');
  } else {
    console.log('  (no GITHUB_TOKEN — wrote local token-catalog.json + heartbeat.json only)');
  }

  console.log(`\n✅ Done — ${status} — ${pools.length} pools (${active.pools.length} active, ${inactive.extraPools.length} inactive), ${tokens.length} tokens`);
  if (status === 'error') process.exitCode = 1;
}

run().catch(e => { console.error('FATAL', e); process.exit(1); });
