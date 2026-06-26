// =============================================================================
// dex-data / dexes / skeletonswap.js
// =============================================================================
// Self-contained SkeletonSwap adapter — TRUSTWORTHY-SOURCE-ONLY.
//
// IMPORTANT lesson (confirmed against the proven old SS cron): the warlock bulk
// endpoint (dex.warlock.backbonelabs.io/api/pools/phoenix-1) is the STALE source
// the old cron deliberately moved OFF — it is the reason `trust_start` exists.
// We do NOT use it. The proven, trustworthy path is:
//
//   1. METADATA from pools_list.json (pool_id/name, swap_address, pool_assets[]
//      with symbol+decimals).
//   2. RESERVES queried DIRECTLY from chain per pool: {"pool":{}} smart query ->
//      data.assets[0].amount / [1].amount / total_share (raw chain integers).
//
// HONEST NULLS — fail honest, never fake:
//   - VOLUME: SkeletonSwap has NO trustworthy volume source (the old cron writes
//     it empty with the note "no trustworthy source"). We null it. We do NOT pull
//     warlock's unreliable volume to make pools look votable. A pool with no
//     trustworthy data shows nothing rather than a fabricated number — which is
//     correct pressure on the DEX/project to expose proper data, not on us to
//     subsidize its absence.
//   - TVL: left null at capture. Pricing is token-catalog's domain; TVL is
//     computed downstream by joining these trustworthy chain reserves to
//     token-catalog's trustworthy prices. We never invent a price here.
//
// What we DO capture (all trustworthy, from chain): reserves, total_share,
// pool identity + decimals. That's enough for depth/liquidity once joined to
// prices; volume stays honestly unavailable.
// =============================================================================

const { fetchJsonWithRetry, queryContract } = require('../lib/fetch');
const { normalizePool } = require('./_contract');

const POOLS_LIST_URL = 'https://skeletonswap.backbonelabs.io/mainnet/phoenix-1/pools_list.json';

// SkeletonSwap data is only trustworthy AFTER the warlock-era fix. The grader
// excludes pre-trust history. (Set to the confirmed fix date.)
const SS_TRUST_START = '2026-04-16';

// Bounded concurrency for per-pool chain queries (publicnode LCD; keep modest).
const POOL_QUERY_CONCURRENCY = 4;

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      try { results[i] = { ok: true, value: await fn(items[i], i) }; }
      catch (e) { results[i] = { ok: false, error: e }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function fetchPoolsList() {
  const data = await fetchJsonWithRetry(POOLS_LIST_URL, 'skeletonswap pools_list');
  // pools_list.json is an array of pool metadata, or wraps it under a key.
  const arr = Array.isArray(data) ? data : (data.pools || data.data || []);
  if (!Array.isArray(arr) || arr.length === 0) throw new Error('pools_list.json empty/malformed');
  return arr;
}

// Reserves DIRECT from chain (the trustworthy source). {"pool":{}} ->
// data.assets[].amount + total_share, raw chain integers (no decimal scaling).
async function queryReserves(swapAddress) {
  const d = await queryContract(swapAddress, { pool: {} });
  if (!d || !Array.isArray(d.assets) || d.assets.length < 2) {
    throw new Error(`unexpected pool response for ${swapAddress}`);
  }
  return {
    reserve_0: d.assets[0].amount != null ? String(d.assets[0].amount) : null,
    reserve_1: d.assets[1].amount != null ? String(d.assets[1].amount) : null,
    total_share: d.total_share != null ? String(d.total_share) : null,
  };
}

function poolName(meta) {
  // pool_id is the canonical SS name (e.g. "LUNA-ampLUNA"). Keep as-is.
  return meta.pool_id || meta.pool_name || '?';
}

async function capture() {
  const captured_at = new Date().toISOString();
  const metas = await fetchPoolsList();

  // Query reserves from chain for every pool (bounded concurrency).
  const reserveResults = await mapWithConcurrency(
    metas, POOL_QUERY_CONCURRENCY, (m) => queryReserves(m.swap_address)
  );

  const normalized = [];
  let chainOk = 0, chainFail = 0;
  for (let i = 0; i < metas.length; i++) {
    const meta = metas[i];
    const res = reserveResults[i];
    const assets = Array.isArray(meta.pool_assets) ? meta.pool_assets : [];

    let reserve_0 = null, reserve_1 = null, total_share = null;
    let chain_status = 'failed';
    if (res.ok) {
      ({ reserve_0, reserve_1, total_share } = res.value);
      chain_status = 'ok';
      chainOk++;
    } else {
      chainFail++;
    }

    normalized.push(
      normalizePool({
        dex: 'skeletonswap',
        pool_address: meta.swap_address || '?',
        pool_name: poolName(meta),
        pool_type: meta.pool_type || null, // null if pools_list doesn't carry it
        bucket: null,            // TLA-relevance join is downstream
        tla_relevant: false,
        assets: assets.slice(0, 2).map((a, idx) => ({
          symbol: a.symbol || null,
          denom: a.denom || a.address || null,
          // reserves from CHAIN (trustworthy), matched to asset order
          amount_raw: idx === 0 ? reserve_0 : reserve_1,
          decimals: a.decimals ?? null,
          price_usd: null,       // pricing is token-catalog's domain (join downstream)
        })),
        tvl_usd: null,           // HONEST: computed downstream from reserves x trusted prices
        volume_24h_usd: null,    // HONEST: SS has no trustworthy volume source
        volume_7d_usd: null,     // HONEST: same
        fees_24h_usd: null,      // HONEST: same
        fee_apr: null,           // HONEST: same
        lp_total_supply: total_share,
        raw: {
          reserve_0, reserve_1, total_share,
          chain_status,          // 'ok' | 'failed' — per-pool reserve query result
          pool_id: meta.pool_id || null,
        },
      })
    );
  }

  return {
    pools: normalized,
    meta: {
      captured_at,
      source: 'pools_list.json (metadata) + direct chain {"pool":{}} (reserves)',
      pools_total: normalized.length,
      chain_ok: chainOk,
      chain_failed: chainFail,
      volume_note: 'SkeletonSwap has no trustworthy volume source — volume fields are honestly null, not fabricated.',
      tvl_note: 'TVL null at capture; computed downstream from chain reserves x token-catalog prices.',
    },
  };
}

module.exports = {
  id: 'skeletonswap',
  label: 'Skeleton Swap',
  enabled: true,
  trust_start: SS_TRUST_START,
  capture,
};
