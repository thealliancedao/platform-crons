// =============================================================================
// dex-data / dexes / skeletonswap.js
// =============================================================================
// Self-contained SkeletonSwap adapter. Data comes from the warlock backend
// (BackBone Labs), which is the same source token-catalog uses for SS pool
// reserves. warlock returns pools with token_0/token_1, reserves, decimals,
// and tvl_usd.
//
// TRUST START — IMPORTANT: SkeletonSwap data is only trustworthy AFTER the
// warlock fix. Before that it went stale / unreliable. The grader must NOT
// include SS data from before `trust_start`. (SPEC-grading-and-dex-data.md §6.)
// Set the exact fix date below once confirmed; until then it is declared so the
// grader excludes the suspect pre-fix window.
//
// Volume: warlock exposes trailing volume per pool where available; we capture
// it per snapshot and aggregate (sum) in lib/aggregate.js — same doctrine as
// Astroport. Reserves enable depth/slippage simulation downstream.
// =============================================================================

const { fetchJsonWithRetry } = require('../lib/fetch');
const { normalizePool } = require('./_contract');

const WARLOCK_POOLS_URL = 'https://dex.warlock.backbonelabs.io/api/pools/phoenix-1';

// The date from which SkeletonSwap data is trustworthy (post-warlock-fix).
// TODO(confirm): set to the exact warlock-fix date. Using a conservative
// placeholder; the grader reads this to exclude pre-trust SS history.
const SS_TRUST_START = '2026-04-16'; // pre-this SS volume history is suspect (old cron note)

async function fetchWarlockPools() {
  const data = await fetchJsonWithRetry(WARLOCK_POOLS_URL, 'skeletonswap warlock pools');
  const arr = Array.isArray(data) ? data : (data.data || data.pools || []);
  if (!Array.isArray(arr)) throw new Error('warlock pools malformed');
  return arr;
}

function normName(t0, t1) {
  const a = (t0 && t0.symbol) || '?';
  const b = (t1 && t1.symbol) || '?';
  // LUNA-first where applicable, mirroring Astroport canonicalization.
  if (b === 'LUNA') return `LUNA-${a}`;
  return `${a}-${b}`;
}

async function capture() {
  const captured_at = new Date().toISOString();
  const pools = await fetchWarlockPools();

  const normalized = [];
  for (const p of pools) {
    const t0 = p.token_0 || {};
    const t1 = p.token_1 || {};
    const denom = (d) => (d && String(d).startsWith('cw20:') ? String(d).slice(5) : d);

    normalized.push(
      normalizePool({
        dex: 'skeletonswap',
        pool_address: p.pool_address || p.address || p.contract || '?',
        pool_name: normName(t0, t1),
        pool_type: (p.pool_type || p.type || null),
        // SS gauge-bucket assignment (TLA relevance) is resolved by cross-DEX
        // join downstream where needed; warlock itself doesn't carry the TLA
        // bucket. Left null here; tla_relevant determined by the orchestrator's
        // bucket join if/when wired. Capture the pool regardless.
        bucket: null,
        tla_relevant: false,
        assets: [
          { symbol: t0.symbol || null, denom: denom(t0.denom), amount_raw: p.reserve_0 != null ? String(p.reserve_0) : null, decimals: t0.decimals ?? null, price_usd: null },
          { symbol: t1.symbol || null, denom: denom(t1.denom), amount_raw: p.reserve_1 != null ? String(p.reserve_1) : null, decimals: t1.decimals ?? null, price_usd: null },
        ],
        tvl_usd: p.tvl_usd != null ? Number(p.tvl_usd) : null,
        volume_24h_usd: p.volume_24h_usd != null ? Number(p.volume_24h_usd) : (p.volume_24h != null ? Number(p.volume_24h) : null),
        volume_7d_usd: p.volume_7d_usd != null ? Number(p.volume_7d_usd) : null,
        fees_24h_usd: p.fees_24h_usd != null ? Number(p.fees_24h_usd) : null,
        fee_apr: p.apr_7d != null ? Number(p.apr_7d) : (p.fee_apr != null ? Number(p.fee_apr) : null),
        lp_total_supply: p.total_share != null ? String(p.total_share) : null,
        raw: {
          reserve_0: p.reserve_0 != null ? String(p.reserve_0) : null,
          reserve_1: p.reserve_1 != null ? String(p.reserve_1) : null,
          total_share: p.total_share != null ? String(p.total_share) : null,
        },
      })
    );
  }

  return {
    pools: normalized,
    meta: {
      captured_at,
      source: 'warlock /api/pools/phoenix-1',
      pools_total: normalized.length,
    },
  };
}

module.exports = {
  id: 'skeletonswap',
  label: 'Skeleton Swap',
  enabled: true,
  trust_start: SS_TRUST_START, // grader excludes SS data before this date
  capture,
};
