// =============================================================================
// dex-data / dexes / astroport.js
// =============================================================================
// Self-contained Astroport adapter. Discovery + capture proven in the old
// astroport-snapshot cron (mined, not inherited wholesale):
//
//   Discovery: Astroport `pools.getAll` (tRPC) returns ALL phoenix-1 pools with
//   pre-computed name / TVL / volume / fees / assets. Bucket labels come from
//   lib/bucket-truth.js — the gauge's own `whitelisted_asset_details`
//   classification (1.1.0 fix; the old `total_staked_balances`-membership
//   derivation mislabeled cross-bucket strays: LUNA-SOLID, USDC-USDT,
//   LUNA-WHALE). Pools with no TLA gauge registration are kept but flagged
//   tla_relevant:false (we capture the whole DEX context; the grader filters
//   to TLA-relevant).
//
// NOTE on volume: pools.getAll gives pre-computed trailing 24h volume + fees.
// We capture these per snapshot. The CORRECT aggregation (volume=sum over a
// window, liquidity=avg) happens in lib/aggregate.js over the accumulated
// snapshots — NOT here, and NOT via the old cron's /42 averaging bug.
// =============================================================================

const { fetchJsonWithRetry } = require('../lib/fetch');
const { normalizePool } = require('./_contract');
const { fetchBucketTruth, joinBucket } = require('../lib/bucket-truth');

const ASTROPORT_TRPC_BASE = 'https://app.astroport.fi/api/trpc';

async function fetchAllPools() {
  const input = encodeURIComponent(JSON.stringify({ json: { chainId: 'phoenix-1' } }));
  const url = `${ASTROPORT_TRPC_BASE}/pools.getAll?input=${input}`;
  const data = await fetchJsonWithRetry(url, 'astroport pools.getAll');
  const pools = data?.result?.data?.json;
  if (!Array.isArray(pools)) throw new Error('pools.getAll malformed');
  return pools;
}

// LUNA-first canonical name (Astroport stores alphabetical). LST tokens
// (ampLUNA/bLUNA/arbLUNA/stLUNA) are NOT plain LUNA — only swap literal "LUNA".
function canonicalizeName(rawName) {
  if (!rawName) return '?';
  const parts = rawName.split(/\s*-\s*/).map((s) => s.trim());
  if (parts.length !== 2) return rawName;
  if (parts[1] === 'LUNA') return `LUNA-${parts[0]}`;
  return `${parts[0]}-${parts[1]}`;
}

async function capture() {
  const captured_at = new Date().toISOString();
  const pools = await fetchAllPools();
  // Gauge truth (whitelisted_asset_details) — NEVER staked-membership. On total
  // truth failure buckets stay null + errors recorded: honest > guessed.
  let truth = null;
  try { truth = await fetchBucketTruth(); }
  catch (e) { truth = { ok: false, byPair: {}, errors: { all: e.message } }; }

  const normalized = [];
  let tlaCount = 0;
  for (const p of pools) {
    const { bucket, tla_relevant, gauge } = joinBucket(truth, p.poolAddress);
    if (tla_relevant) tlaCount++;

    normalized.push(
      normalizePool({
        dex: 'astroport',
        pool_address: p.poolAddress,
        pool_name: canonicalizeName(p.name),
        pool_type: p.poolType || null,
        bucket,
        tla_relevant,
        assets: (p.assets || []).map((a) => ({
          symbol: a.symbol || null,
          denom: a.denom || a.address || null,
          amount_raw: a.amount != null ? String(a.amount) : null,
          decimals: a.precision ?? a.decimals ?? null,
          price_usd: a.priceUsd ?? a.price_usd ?? null,
        })),
        tvl_usd: p.poolLiquidityUsd ?? null,
        volume_24h_usd: p.dayVolumeUsd ?? null,
        volume_7d_usd: p.weekVolumeUsd ?? null,
        fees_24h_usd: p.tradingFees?.day ?? null,
        fee_apr: p.tradingFees?.apr ?? null,
        lp_total_supply: p.poolLiquidity != null ? String(p.poolLiquidity) : null,
        raw: {
          raw_name: p.name,
          staked_liquidity_usd: p.poolStakedLiquidityUsd ?? null,
          deprecated: p.deprecated ?? p.isDeprecated ?? null,
          ...(gauge ? { gauge } : {}),
        },
      })
    );
  }

  return {
    pools: normalized,
    meta: {
      captured_at,
      source: 'astroport pools.getAll + gauge whitelisted_asset_details (bucket truth)',
      bucket_source: 'whitelisted_asset_details (gauge truth) — 1.1.0, staked-membership derivation retired',
      pools_total: normalized.length,
      pools_tla_relevant: tlaCount,
      bucket_errors: (truth && truth.ok) ? (truth.errors || null) : ((truth && truth.errors) || { all: 'bucket truth unavailable' }),
      minter_errors: (truth && truth.minter_errors) || null,
    },
  };
}

module.exports = {
  id: 'astroport',
  label: 'Astroport',
  enabled: true,
  // Astroport capture is reasonably trusted; the averaging METHOD is what was
  // fixed (sum vs avg in lib/aggregate.js). No hard trust_start cutoff, but the
  // averaging method note is recorded in the spec. Set a date here if a specific
  // trust cutoff is later established.
  trust_start: null,
  capture,
};
