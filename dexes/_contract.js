// =============================================================================
// dex-data / dexes / _contract.js
// =============================================================================
// The DEX adapter contract. Every DEX module (astroport.js, skeletonswap.js,
// credia.js, ...) exports an object matching this shape. The orchestrator
// (index.js) iterates over whichever DEXes are ENABLED and calls each one's
// `capture()`. This is what makes DEXes independently pluggable:
//
//   - Adding a DEX  = drop a new module in dexes/ + add it to the registry.
//   - Removing a DEX = remove it from the registry (or set enabled:false).
//   - One DEX failing NEVER affects the others (each capture is isolated).
//
// Each adapter is SELF-CONTAINED: it fetches its own source data (per the
// platform doctrine that new crons query sources themselves, not other crons'
// output). It normalizes to the common per-pool shape below so downstream
// grading is DEX-agnostic.
//
// trust_start: each DEX declares the date from which its data is trustworthy
// (SkeletonSwap = post-warlock-fix; pre-trust data must never enter a grade).
// The orchestrator stamps this into output so the grader can exclude pre-trust
// history. See SPEC-grading-and-dex-data.md §6.
// =============================================================================

/**
 * @typedef {Object} DexAdapter
 * @property {string}  id            short id, e.g. 'astroport'
 * @property {string}  label         display name, e.g. 'Astroport'
 * @property {boolean} enabled       master on/off for this DEX
 * @property {string|null} trust_start  ISO date data is trustworthy from, or null
 * @property {function} capture      async () => { pools: NormalizedPool[], meta }
 */

/**
 * Normalized per-pool shape every adapter must produce. Keeps downstream
 * grading DEX-agnostic. Raw/extra DEX-specific fields go under `raw`.
 *
 * @typedef {Object} NormalizedPool
 * @property {string}  dex                 'astroport' | 'skeletonswap' | ...
 * @property {string}  pool_address
 * @property {string}  pool_name           canonical, LUNA-first where applicable
 * @property {string|null} pool_type       'xyk' | 'pcl' | 'stable' | ...
 * @property {string|null} bucket          TLA bucket if gauge-registered, else null
 * @property {boolean} tla_relevant        is this pool registered with a TLA gauge?
 * @property {Object[]} assets             [{ symbol, denom, amount_raw, decimals, price_usd }]
 * @property {number|null} tvl_usd         pool liquidity (USD) at capture
 * @property {number|null} volume_24h_usd  trailing-24h volume (USD)
 * @property {number|null} volume_7d_usd   trailing-7d volume (USD), if available
 * @property {number|null} fees_24h_usd    trailing-24h fees (USD), if available
 * @property {number|null} fee_apr         fee yield rate (decimal), if available
 * @property {string|null} lp_total_supply raw LP token supply (string for precision)
 * @property {Object}  raw                 DEX-specific extras preserved verbatim
 */

// Validate an adapter at registration time so a malformed DEX module fails
// loudly at startup, not silently mid-run.
function assertAdapter(a) {
  const need = ['id', 'label', 'enabled', 'capture'];
  for (const k of need) {
    if (!(k in a)) throw new Error(`DEX adapter missing '${k}': ${JSON.stringify(Object.keys(a))}`);
  }
  if (typeof a.capture !== 'function') throw new Error(`DEX adapter '${a.id}' capture is not a function`);
  return a;
}

// Normalize-helper an adapter can use to guarantee shape + fill defaults.
function normalizePool(p) {
  return {
    dex: p.dex,
    pool_address: p.pool_address,
    pool_name: p.pool_name || '?',
    pool_type: p.pool_type ?? null,
    bucket: p.bucket ?? null,
    tla_relevant: !!p.tla_relevant,
    assets: Array.isArray(p.assets) ? p.assets : [],
    tvl_usd: p.tvl_usd ?? null,
    volume_24h_usd: p.volume_24h_usd ?? null,
    volume_7d_usd: p.volume_7d_usd ?? null,
    fees_24h_usd: p.fees_24h_usd ?? null,
    fee_apr: p.fee_apr ?? null,
    lp_total_supply: p.lp_total_supply ?? null,
    raw: p.raw || {},
  };
}

module.exports = { assertAdapter, normalizePool };
