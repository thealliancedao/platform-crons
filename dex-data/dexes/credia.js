// =============================================================================
// dex-data / dexes / credia.js — Credia LENDING-MARKET adapter (dex-data 1.2.0)
// =============================================================================
// Credia is NOT a swap dex: it is an over-collateralized lending protocol
// (see tla-core/docs/ecosystem-knowledge/credia.facts.json). Its entire market
// state is ONE smart query {"metrics":{}} on the Portfolio contract — the same
// query the Credia app itself uses (credia.query.metrics). Each market
// normalizes to the common pool shape with pool_type 'lending_market'.
//
// Mapping decisions (SPEC'd in CHANGES_PENDING "Credia deep dive" 2026-07-16):
//   - pool_address  = vproxy_addr (the receipt token users hold — for wBTC this
//     is vcawbtc, the TLA gauge's wBTC.creda.a entry), proxy_addr fallback.
//   - tvl_usd       = total_supplied_usd (source-provided, Credia's oracle —
//     recorded as the SOURCE's number; we never compute prices here).
//   - volume/fees   = null (lending markets have no swap volume — honest null).
//   - bucket        = gauge truth join, candidates [vproxy, proxy, underlying].
//   - raw           = full market entry (lending truth: borrowed, collateral,
//     LTV, liquidation params, utilization, APYs, take_rate, isolation,
//     indices, caps) MINUS user_wallet_balance (session artifact, dropped).
//   - Credia's per-asset oracle price lives ONLY in raw.credia_price_usd —
//     asset price_usd stays null; pricing is token-catalog's domain.
// =============================================================================

const { queryContract } = require('../lib/fetch');
const { normalizePool } = require('./_contract');
const { fetchBucketTruth, joinBucket, parseFactoryPair } = require('../lib/bucket-truth');

// Portfolio contract (docs.creda.finance/developers/contract-addresses,
// chain-verified 2026-07-16 — credia.contracts.portfolio).
const PORTFOLIO = 'terra1y6hfmr3lxxj6srduhlfz96x7sga2984pr757a0nrfuqxa9rqxapqcjv4zz';

// First live capture date — no Credia history exists before it.
const CREDIA_TRUST_START = '2026-07-16';

function denomOf(info) {
  if (!info || typeof info !== 'object') return null;
  return info.cw20 || info.native || Object.values(info)[0] || null;
}
// Short, honest display id from a denom (identity is token-catalog's job).
function shortName(denom) {
  if (!denom) return '?';
  if (denom === 'uluna') return 'LUNA';
  if (denom.startsWith('factory/')) return denom.split('/').slice(-2).join('/');
  if (denom.startsWith('ibc/')) return 'ibc/' + denom.slice(4, 10) + '…';
  if (denom.startsWith('terra1')) return denom.slice(0, 12) + '…';
  return denom.slice(0, 20);
}
const num = (v) => (v === null || v === undefined || v === '') ? null : Number(v);

async function capture() {
  // Bucket truth first (memoized lib; failure degrades to honest nulls).
  let truth = null, bucketErrors = null;
  try { truth = await fetchBucketTruth(); if (truth && !truth.ok) bucketErrors = truth.errors || { truth: 'unavailable' }; }
  catch (e) { bucketErrors = { truth: e.message }; }

  const m = await queryContract(PORTFOLIO, { metrics: {} });
  if (!m || !Array.isArray(m.assets) || m.assets.length === 0) {
    throw new Error('credia metrics: unexpected/empty response');
  }

  const pools = m.assets.map((a) => {
    const denom = denomOf(a.info);
    const addr = a.vproxy_addr || a.proxy_addr || denom;
    // Gauge join. Credia markets are SINGLE-ASSET gauge entries, so the pair
    // map (byPair: minter-resolved LPs + uLP factory denoms) usually misses —
    // the truth for singles lives in byAsset keyed by gauge id ('cw20:{addr}'
    // / 'native:{denom}'). Proven: vcawbtc (this wBTC market's vproxy) has NO
    // minter query, so it can ONLY be found via byAsset. Candidate order:
    // receipt (vproxy), proxy, underlying denom — each tried as byAsset key
    // then byPair — plus the parsed factory pair for uLP-style natives.
    const joinAsset = (key) => {
      const hit = truth && truth.ok && truth.byAsset ? truth.byAsset[key] : null;
      if (!hit) return { bucket: null, tla_relevant: false, gauge: null };
      return { bucket: hit.bucket, tla_relevant: true,
        gauge: { gauge_pool_id: key, whitelisted: hit.whitelisted,
          ...(hit.ambiguous_buckets ? { ambiguous_buckets: hit.ambiguous_buckets } : {}) } };
    };
    let jb = { bucket: null, tla_relevant: false, gauge: null }, joined_on = null;
    const isCw20 = (v) => typeof v === 'string' && v.startsWith('terra1');
    const cands = [];
    for (const c of [a.vproxy_addr, a.proxy_addr]) if (c) cands.push(['cw20:' + c, c]);
    if (denom) cands.push([isCw20(denom) ? 'cw20:' + denom : 'native:' + denom, denom]);
    const fp = parseFactoryPair(denom); if (fp) cands.push([null, fp]);
    for (const [assetKey, pairKey] of cands) {
      let j = assetKey ? joinAsset(assetKey) : { tla_relevant: false };
      if (!j.tla_relevant && pairKey) j = joinBucket(truth, pairKey);
      if (j.tla_relevant) { jb = j; joined_on = assetKey || pairKey; break; }
    }
    const raw = { ...a };
    delete raw.user_wallet_balance;              // session artifact — never committed
    raw.credia_price_usd = num(a.price);         // Credia's oracle view, labeled as such
    delete raw.price;
    if (jb.gauge) raw.gauge = jb.gauge;
    if (joined_on) raw.bucket_joined_on = joined_on;

    return normalizePool({
      dex: 'credia',
      pool_address: addr,
      pool_name: `${shortName(denom)} (Credia market)`,
      pool_type: 'lending_market',
      bucket: jb.bucket,
      tla_relevant: jb.tla_relevant,
      assets: [{ symbol: null, denom, amount_raw: a.total_supplied != null ? String(a.total_supplied) : null, decimals: null, price_usd: null }],
      tvl_usd: num(a.total_supplied_usd),
      volume_24h_usd: null,                      // lending market — no swap volume, honest null
      raw,
    });
  });

  return {
    pools,
    meta: {
      captured_at: new Date().toISOString(),
      source: `credia portfolio {"metrics":{}} (${PORTFOLIO.slice(0, 16)}…) — lending markets, not swap pools`,
      pools_total: pools.length,
      platform: {
        total_supplied_usd: num(m.total_supplied_usd),
        total_borrowed_usd: num(m.total_borrowed_usd),
        total_collateral_usd: num(m.total_collateral_usd),
        total_reserves_usd: num(m.total_reserves_usd),
      },
      bucket_source: truth && truth.ok ? 'gauge truth (whitelisted_asset_details)' : 'UNAVAILABLE',
      bucket_errors: bucketErrors,
    },
  };
}

module.exports = { id: 'credia', label: 'Credia', enabled: true, trust_start: CREDIA_TRUST_START, capture };
