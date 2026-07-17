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
//   price-history/{YYYY}/{MM}.json               forward rich price capture (canonical)
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
// STAGE 2b — CURATED OVERRIDE MERGE (Rev 1.5.0)
// Reads docs/curated/token_overrides.json and applies it per the stage-2
// per-field model: `discovered` is never touched (chain-honest); the raw
// curated entry lands in `override`; `effective` is the merged view
// (override value wins, discovered falls through) — the ONE field downstream
// consumers read. A read failure is loud but non-fatal: the snapshot ships
// without the merge and says so, matching prior behavior exactly.
async function applyOverrideLayer(tokens) {
  const stats = { readOk: false, applied: 0, newlyNamed: 0 };
  let entries = {};
  try {
    const ov = await fetchJson(
      `https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_BRANCH}/docs/curated/token_overrides.json?t=${Date.now()}`,
      'token-overrides'
    );
    entries = (ov && ov.tokens) || {};
    stats.readOk = true;
  } catch (e) {
    console.log(`   token_overrides.json read failed: ${e.message}`);
    return stats;
  }
  for (const t of tokens) {
    const e = entries[t.denom];
    if (!e) continue;
    const d = t.discovered || {};
    t.override = { ...e, source: 'docs/curated/token_overrides.json' };
    t.effective = {
      symbol: e.display_name != null ? e.display_name : d.symbol,
      display_name: e.display_name != null ? e.display_name : (d.display_name != null ? d.display_name : d.symbol),
      decimals: e.decimals != null ? e.decimals : d.decimals,
      logo_url: e.logo_url != null ? e.logo_url : d.logo_url,
      subtype: e.subtype != null ? e.subtype : t.subtype,
      coingecko_id: e.coingecko_id != null ? e.coingecko_id : d.coingecko_id,
    };
    if (!Array.isArray(t.identity_flags)) t.identity_flags = [];
    t.identity_flags.push('override_applied');
    stats.applied++;
    if (!d.symbol && t.effective.symbol) stats.newlyNamed++;
  }
  return stats;
}

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
  astroport: 'https://app.astroport.fi/api/trpc/tokens.byChain?input=%7B%22json%22%3A%7B%22chainId%22%3A%22phoenix-1%22%7D%7D',
  skeletonswap: 'https://dex.warlock.backbonelabs.io/api/pools/phoenix-1',
};
const AGREE_TOLERANCE_PCT = 2.0;   // within this of the median counts as "agreeing"
// Trusted anchor denoms for SkeletonSwap pair-implied pricing (price comes from TLA).
const ANCHOR_DENOMS = {
  'uluna': true,
  'ibc/2C962DAB9F57FE0921435426AE75196009FAA1981BF86991203C8411F8980FDB': true, // USDC
  'ibc/9B19062D46CAB50361CE9B0A3E6D0A7A53AC9E7CB361F32A73CC733144A9A9E5': true, // USDt
};

// Query the five LST hubs for their on-chain exchange rate, in the SAME snapshot
// window as the prices. redemption_price = base_token_price × ratio. This is the
// timing-independent truth for LSTs: clean derivatives (ampLUNA/bLUNA) sit ~at
// redemption; strategy LSTs (arbLUNA) genuinely diverge from market — the gap is
// the signal, not noise. xASTRO intentionally excluded (Neutron hub, deferred).
async function fetchLstRatios() {
  const captured_at = new Date().toISOString();
  const entries = Object.entries(C.LST_HUBS);
  const results = await parallelMap(entries, async ([sym, cfg]) => {
    try {
      const data = await queryContract(cfg.hub, cfg.query);
      let ratio = null;
      if (cfg.kind === 'exchange_rates_array') ratio = parseFloat(data?.exchange_rates?.[0]?.[1]);
      else ratio = parseFloat(data?.exchange_rate);
      if (!ratio || !isFinite(ratio)) return [sym, null];
      return [sym, { ratio, hub: cfg.hub, base: cfg.base, base_denom: cfg.baseDenom, lst_denom: cfg.lstDenom, source: 'eris-hub-chain', captured_at }];
    } catch (e) {
      return [sym, null];
    }
  }, Math.min(BATCH_CONCURRENCY, 5));
  const ratios = {};
  let ok = 0;
  for (const [sym, r] of results) { if (r) { ratios[sym] = r; ok++; } }
  return { ratios, ok, total: entries.length, captured_at };
}

async function fetchPrices(tokens) {
  const captured_at = new Date().toISOString();
  // collect the coingecko ids we'll ask for (discovered)
  const cgIds = [...new Set(tokens.map(t => t.discovered && t.discovered.coingecko_id).filter(Boolean))];
  const cgUrl = PRICE_SOURCES.coingecko + '?ids=' + encodeURIComponent(cgIds.join(',')) + '&vs_currencies=usd';

  // tight parallel batch — one bulk call each → coherent snapshot window
  const [tlaRes, cgRes, astroRes, ssRes] = await Promise.allSettled([
    fetchJson(PRICE_SOURCES.tla, 'tla-prices'),
    cgIds.length ? fetchJson(cgUrl, 'coingecko-price') : Promise.resolve({}),
    fetchJson(PRICE_SOURCES.astroport, 'astroport-tokens'),
    fetchJson(PRICE_SOURCES.skeletonswap, 'skeletonswap-pools'),
  ]);

  const tla = tlaRes.status === 'fulfilled' ? tlaRes.value : null;
  const cg = cgRes.status === 'fulfilled' ? cgRes.value : null;
  const astro = astroRes.status === 'fulfilled' ? astroRes.value : null;
  const ss = ssRes.status === 'fulfilled' ? ssRes.value : null;

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
  // Astroport tokens.byChain: token/denom -> priceUsd (dig the token map from the tRPC envelope)
  const astroByDenom = {};
  const astroMap = findTokenMap(astro);
  if (astroMap) {
    for (const [k, v] of Object.entries(astroMap)) {
      const p = v && v.priceUsd;
      const denom = (v && v.token) || k;
      if (p != null && isFinite(Number(p)) && Number(p) > 0) astroByDenom[denom] = Number(p);
    }
  }
  // SkeletonSwap: anchor-based pair-implied price per token (skip stableswap pools)
  const ssByDenom = buildSkeletonSwapPrices(ss, tlaByDenom);

  return {
    captured_at,
    sources_ok: {
      tla: !!tla,
      coingecko: cgIds.length ? !!cg : null,
      astroport: !!astroMap,
      skeletonswap: !!ss,
    },
    tlaByDenom, cgById, astroByDenom, ssByDenom,
  };
}

// Dig the token map out of Astroport's tRPC envelope (result.data.json or similar).
function findTokenMap(x, depth = 0) {
  if (depth > 8 || x == null) return null;
  if (Array.isArray(x)) { for (const v of x) { const r = findTokenMap(v, depth + 1); if (r) return r; } return null; }
  if (typeof x === 'object') {
    const vals = Object.values(x).filter(v => v && typeof v === 'object' && 'priceUsd' in v);
    if (vals.length > 3) return x;
    for (const v of Object.values(x)) { const r = findTokenMap(v, depth + 1); if (r) return r; }
  }
  return null;
}

// SkeletonSwap warlock pools → token denom -> USD via anchor side.
// price_token = (reserve_anchor_human / reserve_token_human) × anchor_price.
// Constant-product only; stableswap reserve ratios ≠ price ratio, so skip them.
// LIQUIDITY FLOOR: a near-empty pool (e.g. 3 LUNA + a dust counter-reserve) will
// still produce a number, but it's noise. Skip pools below SS_MIN_TVL_USD so dust
// pools can't manufacture fake prices. (Lesson from the old engine's thin-pool scars.)
const SS_MIN_TVL_USD = 500;
function buildSkeletonSwapPrices(pools, tlaByDenom) {
  const out = {};
  if (!pools) return out;
  const arr = Array.isArray(pools) ? pools : (pools.data || pools.pools || []);
  for (const p of arr) {
    const ptype = (p.pool_type || p.type || '').toString().toLowerCase();
    if (ptype.includes('stable')) continue;
    const tvl = Number(p.tvl_usd);
    if (!isFinite(tvl) || tvl < SS_MIN_TVL_USD) continue;   // skip dust pools
    const t0 = p.token_0 || {}, t1 = p.token_1 || {};
    const r0 = Number(p.reserve_0), r1 = Number(p.reserve_1);
    if (!r0 || !r1) continue;
    const norm = d => (d && d.startsWith('cw20:')) ? d.slice(5) : d;
    const d0 = norm(t0.denom), d1 = norm(t1.denom);
    const dec0 = t0.decimals ?? 6, dec1 = t1.decimals ?? 6;
    const h0 = r0 / 10 ** dec0, h1 = r1 / 10 ** dec1;
    if (ANCHOR_DENOMS[d1] && tlaByDenom[d1] && h0) out[d0] = out[d0] ?? (h1 / h0) * tlaByDenom[d1];
    else if (ANCHOR_DENOMS[d0] && tlaByDenom[d0] && h1) out[d1] = out[d1] ?? (h0 / h1) * tlaByDenom[d0];
  }
  return out;
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

function attachPricesAndGrade(tokens, priced, lstData, weights) {
  let pricedCount = 0;
  // map LST denom -> its ratio record for quick lookup
  const ratioByDenom = {};
  for (const r of Object.values(lstData.ratios)) ratioByDenom[r.lst_denom] = r;

  for (const t of tokens) {
    const denom = t.denom;
    const cgId = t.discovered && t.discovered.coingecko_id;
    const tlaUsd = priced.tlaByDenom[denom];
    const cgUsd = cgId ? priced.cgById[cgId] : undefined;

    const sourceUsd = {};
    sourceUsd.tla = { usd: tlaUsd != null ? tlaUsd : null, captured_at: priced.captured_at, status: tlaUsd != null ? 'ok' : 'no_data' };
    sourceUsd.coingecko = { usd: cgUsd != null ? cgUsd : null, captured_at: priced.captured_at, status: cgUsd != null ? 'ok' : (cgId ? 'no_data' : 'no_id') };
    const astroUsd = priced.astroByDenom[denom];
    const ssUsd = priced.ssByDenom[denom];
    sourceUsd.astroport = { usd: astroUsd != null ? astroUsd : null, captured_at: priced.captured_at, status: astroUsd != null ? 'ok' : 'no_data' };
    sourceUsd.skeletonswap = { usd: ssUsd != null ? ssUsd : null, pair_implied: ssUsd != null ? true : undefined, captured_at: priced.captured_at, status: ssUsd != null ? 'ok' : 'no_data' };

    // ---- LST redemption cross-check (on-chain hub ratio × base price) ----
    // Doctrine (proven vs CoinGecko in the old engine): the HUB-RATIO redemption
    // price is the ROBUST, accurate number. The market/TLA price is a weaker read
    // that can run above/below it (thin pools, strategy LSTs, timing). We surface
    // BOTH and the gap, describe it neutrally, and only flag LARGE gaps (>10%) for
    // human review — never auto-alarm on normal drift.
    const lr = ratioByDenom[denom];
    if (lr) {
      const basePrice = priced.tlaByDenom[lr.base_denom];
      const redemption = (basePrice != null && isFinite(basePrice)) ? basePrice * lr.ratio : null;
      let gap_pct = null;
      if (redemption != null && tlaUsd != null && redemption > 0) {
        gap_pct = Number(((tlaUsd - redemption) / redemption * 100).toFixed(3));  // +: market above redemption
      }
      const absGap = gap_pct != null ? Math.abs(gap_pct) : null;
      t.lst = {
        is_lst: true,
        hub_ratio: lr.ratio,
        base: lr.base,
        redemption_price: redemption,     // robust/primary (LUNA × hub ratio)
        market_price: tlaUsd != null ? tlaUsd : null,  // weaker cross-check (TLA feed)
        market_vs_redemption_pct: gap_pct,             // + = market above redemption value
        review_flag: absGap != null ? absGap > C.LST_REVIEW_FLAG_PCT : null,
        note: gap_pct == null ? 'redemption needs base price'
            : absGap <= C.LST_DIVERGENCE_FLAG_PCT ? 'market ≈ redemption value'
            : absGap > C.LST_REVIEW_FLAG_PCT ? 'market sits well off redemption — review (thin pool, depeg, or timing)'
            : `market sits ${gap_pct > 0 ? 'above' : 'below'} redemption value`,
        captured_at: lr.captured_at,
      };
    }

    const conf = priceConfidence(
      Object.fromEntries(Object.entries(sourceUsd).filter(([, s]) => s.usd != null))
    );

    t.prices = sourceUsd;
    t.snapshot_window_ms = 0;
    t.price_confidence = conf;
    if (conf.sources_available > 0) pricedCount++;

    // ---- composite overall grade ----
    const idScore = (t.scoring && t.scoring.identity && t.scoring.identity.score != null) ? t.scoring.identity.score : null;
    const pScore = conf.score;
    let overall = null, partial = false;
    if (pScore != null && idScore != null) {
      overall = Math.round(weights.price * pScore + weights.identity * idScore);
    } else if (idScore != null && pScore == null) {
      overall = idScore; partial = true;
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
        let parsed = data; try { parsed = JSON.parse(data); } catch {}
        // Resolve with status + body so callers can react to specific codes
        // (e.g. 409 sha-conflict). Non-2xx no longer auto-throws.
        resolve({ status: res.statusCode, body: parsed, raw: data });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}
// Commit a file with 409-conflict retry. Multiple crons write to the same repo,
// so the file's sha can change between our GET and PUT (another cron committed
// first) -> GitHub returns 409 "is at X but expected Y". We re-fetch the fresh
// sha and retry. This is the standard pattern for concurrent writers to the
// contents API; almost all collisions resolve on the first retry.
async function publishFile(filePath, content, message, maxAttempts = 5) {
  const apiPath = `/repos/${GITHUB_REPO}/contents/${filePath}`;
  const b64 = Buffer.from(content).toString('base64');
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // (re)fetch current sha each attempt so a stale sha can't persist
    let sha = null;
    const getRes = await githubApiRequest('GET', apiPath + `?ref=${GITHUB_BRANCH}`);
    if (getRes.status >= 200 && getRes.status < 300) sha = getRes.body && getRes.body.sha;
    // (404 on GET = new file, sha stays null — fine)

    const body = { message, content: b64, branch: GITHUB_BRANCH };
    if (sha) body.sha = sha;
    const putRes = await githubApiRequest('PUT', apiPath, body);

    if (putRes.status >= 200 && putRes.status < 300) return putRes.body; // success
    if (putRes.status === 409 || putRes.status === 422) {
      // sha conflict (another cron committed between our GET and PUT) — back off
      // a touch and retry with a freshly-fetched sha.
      lastErr = new Error(`GitHub PUT ${filePath}: ${putRes.status} (sha conflict, attempt ${attempt}/${maxAttempts})`);
      await new Promise(r => setTimeout(r, 300 * attempt + Math.floor(Math.random() * 400)));
      continue;
    }
    // any other non-2xx is a real error — surface it
    throw new Error(`GitHub PUT ${filePath}: ${putRes.status} ${String(putRes.raw).slice(0, 200)}`);
  }
  throw lastErr || new Error(`GitHub PUT ${filePath}: failed after ${maxAttempts} attempts`);
}

// -----------------------------------------------------------------------------
// MAIN
// -----------------------------------------------------------------------------
// ── price-history forward-append (additive; July 2026 clean break) ───────────
// After writing its own snapshot, token-catalog appends today's lean RICH price
// row into the canonical price-history/ month-file. This makes price-history
// self-sustaining: backfill seeded the past, this carries it forward. Uses only
// in-memory data (token.discovered.symbol + token.prices) — no extra fetch.
// Fully isolated: any failure here is logged and swallowed so the core cron is
// never affected. Format matches SPEC-price-history-format.md (rich tier).
async function appendToPriceHistory(catalog, dayStr) {
  try {
    const [year, month] = dayStr.split('-'); // YYYY, MM
    const filePath = `price-history/${year}/${month}.json`;

    // Build today's rich price row: { SYM: {usd, src, confidence, sources} }
    const PRICE_SRCS = ['tla', 'astroport', 'coingecko', 'skeletonswap'];
    const row = {};
    for (const t of (catalog.tokens || [])) {
      const sym = t.discovered && t.discovered.symbol;
      if (!sym) continue; // only named tokens
      const p = t.prices || {};
      const sources = {};
      for (const s of PRICE_SRCS) sources[s] = (p[s] && p[s].usd != null) ? Number(p[s].usd) : null;
      let usd = null, src = null;
      for (const s of PRICE_SRCS) { if (sources[s] != null) { usd = sources[s]; src = s; break; } }
      if (usd == null) continue; // no price today → skip token (honest: no fabrication)
      row[sym] = { usd, src, confidence: t.price_confidence || null, sources };
    }
    if (Object.keys(row).length === 0) { console.log('  (price-history: no priced tokens to append)'); return; }

    // Read existing month-file (if any), merge today's day (per-token merge-safe).
    let monthDoc = null;
    try {
      const existing = await fetchJson(
        `https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_BRANCH}/${filePath}?t=${Date.now()}`,
        'price-history-month'
      );
      if (existing && existing.days) monthDoc = existing;
    } catch { /* file may not exist yet — that's fine */ }
    if (!monthDoc) monthDoc = { meta: { module: 'price-history', format_version: 1 }, days: {} };

    monthDoc.days[dayStr] = { ...(monthDoc.days[dayStr] || {}), ...row };
    monthDoc.meta = {
      module: 'price-history', format_version: 1,
      ...(monthDoc.meta || {}),
      updated_at: new Date().toISOString(),
      note: 'rich forward capture (token-catalog)',
    };

    await publishFile(filePath, JSON.stringify(monthDoc, null, 2),
      `price-history: append ${dayStr} (${Object.keys(row).length} tokens)`);
    console.log(`  ✓ price-history/${year}/${month}.json — appended ${dayStr} (${Object.keys(row).length} tokens)`);
  } catch (e) {
    // NEVER let this break the core cron.
    console.warn(`  ⚠ price-history append skipped: ${e.message}`);
  }
}


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

  console.log('🧷 Stage 2b: applying curated override layer (token_overrides.json)...');
  // Rev 1.5.0 — the override layer was write-only until now: humans curated it,
  // nothing consumed it. `discovered` stays untouched (honest); overrides land
  // in `override` (raw curated entry) + `effective` (override-over-discovered,
  // the field consumers like tla-voting's buildTokenMap should read).
  const ovStats = await applyOverrideLayer(tokens);
  console.log(`   overrides: ${ovStats.applied} applied (${ovStats.newlyNamed} previously unnamed now identified)${ovStats.readOk ? '' : ' — CURATED FILE READ FAILED, snapshot ships without merge'}`);

  console.log('🔐 Stage 2.1: verifying coingecko ids + scoring identity...');
  const weights = { price: 0.75, identity: 0.25 };  // default; editable via curated/scoring_weights.json (read by tools)
  const cgIndex = await fetchCgIndex();
  const verifyStats = verifyAndScore(tokens, cgIndex, weights);
  console.log(`   verification: ${verifyStats.confirmed} cg-confirmed, ${verifyStats.mismatched} mismatch (cg index ${verifyStats.indexOk ? 'ok' : 'MISSING — run the CoinGecko Action'})`);

  console.log('💲 Stage 3: pricing (snapshot-coherent) + LST ratios + composite grade...');
  const [priced, lstData] = await Promise.all([fetchPrices(tokens), fetchLstRatios()]);
  const priceStats = attachPricesAndGrade(tokens, priced, lstData, weights);
  console.log(`   pricing: ${priceStats.pricedCount}/${tokens.length} priced (tla ${priced.sources_ok.tla ? 'ok' : 'FAIL'}, cg ${priced.sources_ok.coingecko === null ? 'n/a' : priced.sources_ok.coingecko ? 'ok' : 'FAIL'}, astro ${priced.sources_ok.astroport ? 'ok' : 'FAIL'}, ss ${priced.sources_ok.skeletonswap ? 'ok' : 'FAIL'})`);
  console.log(`   lst ratios: ${lstData.ok}/${lstData.total} hubs (${Object.keys(lstData.ratios).join(', ') || 'none'})`);

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
      version: 'token-catalog-1.5.0-stage3.1',
      schemaVersion: 3,
      stage: 'discovery+identity+verification+pricing+dex',
      generated_at: startedAt.toISOString(),
      epoch: epochInfo?.number ?? null,
      status,
      source: 'token-catalog cron (platform-crons/token-catalog)',
      note: 'four-source snapshot-coherent pricing (TLA, CoinGecko, Astroport, SkeletonSwap pair-implied) + LST redemption cross-check + composite grade. SkeletonSwap prices are anchor-derived from constant-product pools (stableswap skipped). Overrides merge on read.',
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
      lst_ratios_ok: lstData.ok,
      lst_ratios_total: lstData.total,
      lst_ratios: lstData.ratios,
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
    latest: 'current.json',
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
    // (daily/ snapshot retired — price-history/ is the canonical forward capture.)
    // Forward-append today's rich price row into canonical price-history (isolated).
    await appendToPriceHistory(catalog, dayStr);
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
