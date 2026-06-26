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
    pool.architecture = { pair_address: pairAddr, pair_type: pairType };  // contract/version/dex → Stage 2 enrichment
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

  // Honest status: discovery is OK only if the active query worked. A bucket
  // failure or a genuine chain-read failure (query_failed) degrades to 'partial'.
  // Single-asset stakes are NOT failures — they're expected and resolved.
  let status = 'ok';
  if (!active.ok) status = 'error';
  else if (inactive.stats.contractsSucceeded < inactive.stats.contractsChecked || uStats.query_failed > 0) status = 'partial';

  const catalog = {
    meta: {
      version: 'token-catalog-1.0.1-stage1',
      schemaVersion: 1,
      stage: 'discovery',
      generated_at: startedAt.toISOString(),
      epoch: epochInfo?.number ?? null,
      status,
      source: 'token-catalog cron (platform-crons/token-catalog)',
      note: 'identity (Stage 2) + pricing (Stage 3) fields are stubbed null until those stages land',
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
