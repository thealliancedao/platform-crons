// =============================================================================
// dex-data / dexes / credia.js  — PLACEHOLDER
// =============================================================================
// Credia DEX adapter — not yet built. Disabled so the orchestrator skips it
// cleanly. This file exists so adding Credia later is "fill in capture() +
// flip enabled:true" with zero changes to other DEXes or the orchestrator —
// the whole point of the per-DEX separation.
//
// When building: mirror astroport.js / skeletonswap.js — fetch Credia's own
// source, normalize each pool via normalizePool() to the common shape, return
// { pools, meta }. Set trust_start if Credia data has a known reliable-from
// date. Then set enabled:true and add it to the registry in index.js (it's
// already listed there, disabled).
// =============================================================================

async function capture() {
  // Not implemented. Returns empty so a stray enable doesn't crash the run.
  return {
    pools: [],
    meta: {
      captured_at: new Date().toISOString(),
      source: 'credia (placeholder — not implemented)',
      pools_total: 0,
      note: 'Credia adapter is a placeholder. See file header to build it.',
    },
  };
}

module.exports = {
  id: 'credia',
  label: 'Credia',
  enabled: false, // <- flip to true once capture() is implemented
  trust_start: null,
  capture,
};
