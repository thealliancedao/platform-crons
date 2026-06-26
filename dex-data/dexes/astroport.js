// =============================================================================
// dex-data / dexes / astroport.js
// =============================================================================
// Self-contained Astroport adapter. Discovery + capture proven in the old
// astroport-snapshot cron (mined, not inherited wholesale):
//
//   Discovery: Astroport `pools.getAll` (tRPC) returns ALL phoenix-1 pools with
//   pre-computed name / TVL / volume / fees / assets. Cross-reference each pool
//   against the 4 TLA staking contracts' `total_staked_balances` to attach a
//   bucket label (active+inactive). Pools with no TLA gauge registration are
//   kept but flagged tla_relevant:false (we capture the whole DEX context; the
//   grader filters to TLA-relevant).
//
// NOTE on volume: pools.getAll gives pre-computed trailing 24h volume + fees.
// We capture these per snapshot. The CORRECT aggregation (volume=sum over a
// window, liquidity=avg) happens in lib/aggregate.js over the accumulated
// snapshots — NOT here, and NOT via the old cron's /42 averaging bug.
// =============================================================================

const { fetchJsonWithRetry, queryContract } = require('../lib/fetch');
const { normalizePool } = require('./_contract');

const ASTROPORT_TRPC_BASE = 'https://app.astroport.fi/api/trpc';

// TLA staking contracts (one per bucket). total_staked_balances on each returns
// the COMPLETE list of LP tokens registered with that gauge — active + inactive
// (Eris UI's "Inactive"). Proven the right discovery source (vs gauge_infos:next
// or distributions which only show active). These mirror config/contracts.js
// STAKING_BUCKETS; kept here so the adapter is self-contained, but if dex-data
// later imports the shared config, swap to that.
const TLA_STAKING_CONTRACTS = {
  stable:   'terra1v399cx9drllm70wxfsgvfe694tdsd9x96p9ha36w7muffe4znlusqswspq',
  project:  'terra1awq6t7jfakg9wfjn40fk3wzwmd57mvrqtt3a39z9rmet7wdjj3ysgw3lpa',
  bluechip: 'terra14mmvqn0kthw6sre75vku263lafn5655mkjdejqjedjga4cw0qx2qlf4arv',
  single:   'terra1qdz5qgafx88kp5mf6m2tah8742g4u5g2cek0m3jrgssexexk7g4qw6e23k',
};

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

// Build poolAddress -> bucket from the 4 staking contracts (active + inactive).
async function buildBucketMap(pools) {
  const lpToPool = new Map();
  for (const p of pools) if (p.lpAddress && p.poolAddress) lpToPool.set(p.lpAddress, p.poolAddress);

  const bucketByPool = {};
  const results = await Promise.all(
    Object.entries(TLA_STAKING_CONTRACTS).map(async ([bucket, addr]) => {
      try {
        const data = await queryContract(addr, { total_staked_balances: {} });
        return { bucket, entries: Array.isArray(data) ? data : [], ok: Array.isArray(data) };
      } catch (e) {
        return { bucket, entries: [], ok: false, error: e.message };
      }
    })
  );
  const bucketErrors = {};
  for (const { bucket, entries, ok, error } of results) {
    if (!ok) bucketErrors[bucket] = error || 'query failed';
    for (const entry of entries) {
      const info = entry?.asset?.info;
      if (!info) continue;
      let poolAddr = null;
      if (info.cw20) poolAddr = lpToPool.get(info.cw20);
      else if (info.native) {
        const parts = info.native.split('/');
        if (parts[0] === 'factory' && parts.length >= 3 && parts[parts.length - 1] === 'uLP') poolAddr = parts[1];
      }
      if (poolAddr && !bucketByPool[poolAddr]) bucketByPool[poolAddr] = bucket; // first-write wins
    }
  }
  return { bucketByPool, bucketErrors };
}

async function capture() {
  const captured_at = new Date().toISOString();
  const pools = await fetchAllPools();
  const { bucketByPool, bucketErrors } = await buildBucketMap(pools);

  const normalized = [];
  let tlaCount = 0;
  for (const p of pools) {
    const bucket = bucketByPool[p.poolAddress] || null;
    const tla_relevant = bucket != null;
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
        },
      })
    );
  }

  return {
    pools: normalized,
    meta: {
      captured_at,
      source: 'astroport pools.getAll + TLA staking contracts',
      pools_total: normalized.length,
      pools_tla_relevant: tlaCount,
      bucket_errors: Object.keys(bucketErrors).length ? bucketErrors : null,
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
