// =============================================================================
// dex-data / lib / eris-apr.js — Eris-convention per-pool LP APR (1.3.3)
// =============================================================================
// Implements AUDIT-eris-apr-pricing.md §Gauge-LP-APR — Eris's OWN displayed
// APR pipeline, source-confirmed 2026-08-02 (Philipp shared the code). The
// VERBATIM LAW applies: replicate their mixed convention exactly, never "clean
// it up", so our published figure reconciles to their screen:
//
//   Stage 1  chain inputs: /terra/alliances + /cosmos/mint/v1beta1/annual_provisions
//   Stage 2  per-gauge pot: totalReward = Σ ACTIVE alliance weights + 1;
//            rewardsPerYear = annual_provisions × weight/totalReward
//   Stage 3  per-pool: incentives = rewardsPerYear × distribution (gauge vote
//            outcome, raw — never normalized); tvl = TLA-STAKED USD ONLY;
//            edge cases verbatim (0/0→0; tvl==0→Infinity, JSON-published as
//            null + flag); incentiveApr = incentivesUsd / tvl
//   Stage 4  displayed:
//            eris_apy_pct = aprToApy(incentive × 0.92) + trading − take
//            eris_apr_pct = incentive − take + trading        (their linear
//            `total` — NOTE: source applies NO 0.92 on the linear variant)
//            trading falls back to 0 in the formula when unknown (their
//            `a.trading ?? of(0)`), published null + flagged.
//
// Deviations from their inputs, stated honestly (published in meta):
//   • trading APR = OUR dex-data fee_apr (their pool service is not queryable)
//   • LUNA price + LP TVL = OUR adapter captures (same class of source)
// Connector→gauge mapping is SELF-DISCOVERING: every alliance whose denom is
// factory/<addr>/… gets its <addr> config-queried; contracts answering with a
// TLA gauge name are ours — zero hardcoded connector addresses.
//
// 1.3.3 (audit 2026-09-10 vs Eris screen): the TLA-staked USD basis has THREE
// labeled paths, tried in order —
//   staked_supply_ratio_x_pool_tvl              adapter TVL (Astroport, Credia)
//   staked_supply_ratio_x_reserve_implied_tvl   pool has reserves + supply but
//                                               NO adapter TVL (SkeletonSwap by
//                                               design: "TVL computed downstream
//                                               from reserves × trusted prices")
//                                               → Σ reserve × token-catalog price,
//                                               every asset must price or null
//   staked_units_x_asset_price                  single-asset gauge entries
// Single entries with no pool record get their name from the catalog symbol.
// KNOWN GAP (flag `single_asset_yield_leg_unmeasured`): Eris's screen adds a
// leg for single-asset gauges beyond incentive − take (2026-09-10: xASTRO
// +17.7 pp, ampCAPA +4.8 pp) that the source-confirmed formula does not carry;
// we publish incentive − take and name the gap rather than guess it.
//
// Honesty rules: components always published; a missing leg nulls the figure
// WITH a reason, never a silent 0 and never a borrowed value. Validation
// against the ground-truth tables (SPEC-lp-apr §7 + CRON-FIXES-BRIEF §2.10)
// happens at deploy; meta carries the pending-validation marker until then.
// =============================================================================
'use strict';

const { STAKING_BUCKETS, BUCKETS } = require('../../config/contracts.js');

const GAUGE_CONTROLLER_ADDR = 'terra1hfksrhchkmsj4qdq33wkksrslnfles6y2l77fmmzeep0xmq24l2smsd3lj';
const ERIS_INCENTIVE_CUT = 0.08;            // the silent 8% netted into displayed APY
const COMPOUND_PERIODS = 365.25;            // their aprToApy periods
const EPOCH_DAYS = 7;                       // rewardsPerEpoch = perYear/365×7 (plain 365, verbatim)

// Injectable transport (mock gate stubs this; production default wired below).
const CH = { queryContract: null, lcdJson: null, fetchJson: null };
try {
  const F = require('./fetch');
  CH.queryContract = F.queryContract;
  CH.fetchJson = async (url) => JSON.parse((await F.httpRequest(url, { timeoutMs: 15000 })).body);
  CH.lcdJson = async (path) => {
    let lastErr = null;
    for (const base of F.TERRA_LCD_ENDPOINTS) {
      try {
        const res = await F.httpRequest(base + path, { timeoutMs: 15000 });
        return JSON.parse(res.body);
      } catch (e) { lastErr = e; }
    }
    throw new Error(`lcd ${path} failed on both LCDs: ${lastErr && lastErr.message}`);
  };
} catch (_) { /* mock supplies both */ }

// their aprToApy: nominal annual PERCENT in, effective annual PERCENT out,
// compounded over 365.25 periods. aprToApy(100) = 171.4570018…
function aprToApy(aprPct, periods = COMPOUND_PERIODS) {
  if (aprPct == null || !isFinite(aprPct)) return null;
  return (Math.pow(1 + (aprPct / 100) / periods, periods) - 1) * 100;
}

function assetKeyFromInfo(info) {
  if (!info) return null;
  if (info.cw20) return `cw20:${info.cw20}`;
  if (info.native) return `native:${info.native}`;
  // some responses wrap once more: { info: {...} }
  if (info.info) return assetKeyFromInfo(info.info);
  return null;
}

function connectorAddrFromDenom(denom) {
  const parts = String(denom || '').split('/');
  if (parts[0] === 'factory' && parts.length >= 2 && /^terra1[a-z0-9]{20,}$/.test(parts[1])) return parts[1];
  return null;
}

// token-catalog price fallback (1.3.1): the org price home backs up the
// adapter-derived prices so ONE upstream DEX API outage (observed live
// 2026-08-02: astroport tRPC 500s) can't null every USD leg. Priority per
// PRICING-DOCTRINE order tla > coingecko > astroport > skeletonswap; every
// fallback use is source-labeled — adapter prices stay primary when present.
const TOKEN_CATALOG_URL = 'https://raw.githubusercontent.com/thealliancedao/tla-core/main/token-catalog/snapshots/current.json';
async function fetchCatalog(T = CH) {
  if (typeof T.fetchJson !== 'function') return null;
  try { return await T.fetchJson(TOKEN_CATALOG_URL + '?t=' + Date.now()); }
  catch (_) { return null; }
}
// 1.3.3: identity lives under `effective` in the catalog schema (its stated
// contract: "the ONE field downstream should read" — curated override wins,
// discovered falls through). The top-level `decimals` read before this never
// existed → every fallback priced at 6 decimals; wBTC-class assets would have
// been 100× off on that path.
function catalogToken(catalog, denomOrCw20) {
  if (!catalog || !Array.isArray(catalog.tokens)) return null;
  return catalog.tokens.find(x => x.denom === denomOrCw20) || null;
}
function catalogField(t, field) {
  if (!t) return null;
  for (const layer of [t.effective, t, t.discovered]) {
    const v = layer && layer[field];
    if (v != null && v !== '') return v;
  }
  return null;
}
function catalogDecimals(t) {
  const d = catalogField(t, 'decimals');
  return (d != null && isFinite(Number(d))) ? Number(d) : null;
}
function catalogSymbol(catalog, denomOrCw20) {
  const s = catalogField(catalogToken(catalog, denomOrCw20), 'symbol');
  return typeof s === 'string' && s ? s : null;
}
function catalogPrice(catalog, denomOrCw20) {
  const t = catalogToken(catalog, denomOrCw20);
  const prices = t && t.prices;
  if (!prices) return null;
  for (const srcName of ['tla', 'coingecko', 'astroport', 'skeletonswap']) {
    const p = prices[srcName];
    if (p && p.status === 'ok' && p.usd != null && isFinite(Number(p.usd))) {
      const dec = catalogDecimals(t);
      return { price_usd: Number(p.usd), decimals: dec != null ? dec : 6, source: `token-catalog/${srcName}` };
    }
  }
  return null;
}

// Reserve-implied pool TVL (1.3.3) — for adapters that capture chain reserves
// but defer pricing (SkeletonSwap). Σ reserve_i × price_i over the pool's
// assets; adapter price → run asset prices → token-catalog, first hit wins and
// is labeled. ANY unpriced asset → null with the offending denom (never a
// partial sum). Returns { tvl_usd, sources[] } | { tvl_usd: null, missing }.
function reserveImpliedTvl(dexPool, assetPrices = {}, catalog = null) {
  const assets = Array.isArray(dexPool && dexPool.assets) ? dexPool.assets : [];
  if (!assets.length) return { tvl_usd: null, missing: 'no_assets' };
  let sum = 0; const sources = [];
  for (const a of assets) {
    const raw = a && a.amount_raw != null ? Number(a.amount_raw) : null;
    if (raw == null || !isFinite(raw)) return { tvl_usd: null, missing: `reserve:${(a && (a.symbol || a.denom)) || '?'}` };
    let price = null, dec = null, src = null;
    if (a.price_usd != null && isFinite(Number(a.price_usd))) { price = Number(a.price_usd); dec = a.decimals; src = 'adapter'; }
    else if (a.denom && assetPrices[a.denom] && assetPrices[a.denom].price_usd != null) { price = Number(assetPrices[a.denom].price_usd); dec = a.decimals != null ? a.decimals : assetPrices[a.denom].decimals; src = 'run-assets'; }
    else if (a.denom && catalog) { const cp = catalogPrice(catalog, a.denom); if (cp) { price = cp.price_usd; dec = a.decimals != null ? a.decimals : cp.decimals; src = cp.source; } }
    if (price == null || !isFinite(price)) return { tvl_usd: null, missing: `price:${a.symbol || a.denom}` };
    const d = (dec != null && isFinite(Number(dec))) ? Number(dec) : 6;
    sum += (raw / Math.pow(10, d)) * price;
    sources.push(src);
  }
  return { tvl_usd: sum, sources };
}

// ---------------------------------------------------------------------------
// Stage 1+2 capture — all chain inputs, defensively parsed, nothing inferred.
// ---------------------------------------------------------------------------
async function captureInputs(T = CH) {
  const nowMs = Date.now();
  const out = { errors: {} };

  // /terra/alliances
  let alliances = [];
  try {
    const a = await T.lcdJson('/terra/alliances?pagination.limit=200');
    alliances = Array.isArray(a && a.alliances) ? a.alliances : Array.isArray(a) ? a : [];
  } catch (e) { out.errors.alliances = String(e && e.message || e); }

  // annual provisions (uluna Dec string)
  let annualProvisionsUluna = null;
  try {
    const p = await T.lcdJson('/cosmos/mint/v1beta1/annual_provisions');
    const v = p && (p.annual_provisions != null ? p.annual_provisions : p);
    const n = Number(v);
    if (isFinite(n) && n > 0) annualProvisionsUluna = n;
    else out.errors.annual_provisions = `unparseable: ${String(v).slice(0, 40)}`;
  } catch (e) { out.errors.annual_provisions = String(e && e.message || e); }

  // active filter + totalReward — verbatim: Σ active weights + 1
  const active = alliances.filter(a => {
    const t = Date.parse(a.reward_start_time || '');
    return isFinite(t) && t < nowMs;
  });
  const totalRewardWeight = active.reduce((s, a) => s + (Number(a.reward_weight) || 0), 0) + 1;

  // connector self-discovery: factory/<addr>/… denoms whose config names a TLA gauge
  const perGauge = {};        // gauge -> { connector, denom, reward_weight, reward_pct, active, rewards_* }
  for (const a of alliances) {
    const addr = connectorAddrFromDenom(a.denom);
    if (!addr) continue;
    let cfg = null;
    try { cfg = await T.queryContract(addr, { config: {} }); } catch (_) { continue; }
    const gauge = cfg && cfg.gauge;
    if (!gauge || !BUCKETS.includes(gauge)) continue;
    const isActive = (() => { const t = Date.parse(a.reward_start_time || ''); return isFinite(t) && t < nowMs; })();
    const weight = Number(a.reward_weight) || 0;
    const rewardPct = isActive ? weight / totalRewardWeight : 0;   // verbatim: not-yet-active ⇒ 0
    const rewardsPerYearLuna = annualProvisionsUluna != null ? (annualProvisionsUluna / 1e6) * rewardPct : null;
    let rewardsUpdate = null;
    const last = Date.parse(a.last_reward_change_time || '');
    const secs = Number(String(a.reward_change_interval || '').replace(/s$/, ''));
    if (isFinite(last) && isFinite(secs)) rewardsUpdate = new Date(last + secs * 1000).toISOString();
    perGauge[gauge] = {
      connector: addr, alliance_denom: a.denom, reward_weight: weight, active: isActive,
      reward_pct: rewardPct,
      rewards_per_year_luna: rewardsPerYearLuna,
      rewards_per_epoch_luna: rewardsPerYearLuna != null ? rewardsPerYearLuna / 365 * EPOCH_DAYS : null,
      reward_start_time: a.reward_start_time || null,
      rewards_update: rewardsUpdate,
    };
  }
  if (!Object.keys(perGauge).length) out.errors.connectors = 'no TLA gauge connector discovered among alliances';

  // Stage 3 inputs — gauge controller distributions (raw, never normalized)
  const distByGauge = {};     // gauge -> [{ key, distribution }]
  const distSumByGauge = {};
  try {
    const res = await T.queryContract(GAUGE_CONTROLLER_ADDR, { distributions: { time: 'current' } });
    const list = Array.isArray(res) ? res : (res && (res.distributions || res.data)) || [];
    for (const g of list) {
      const gauge = g && g.gauge;
      if (!gauge || !BUCKETS.includes(gauge)) continue;
      const assets = Array.isArray(g.assets) ? g.assets : [];
      distByGauge[gauge] = assets
        .map(en => ({ key: assetKeyFromInfo(en.asset ?? en.info ?? en), distribution: Number(en.distribution) }))
        .filter(x => x.key && isFinite(x.distribution));
      distSumByGauge[gauge] = distByGauge[gauge].reduce((s, x) => s + x.distribution, 0);
    }
    if (!Object.keys(distByGauge).length) out.errors.distributions = 'controller distributions empty/unparseable';
  } catch (e) { out.errors.distributions = String(e && e.message || e); }

  // per-bucket TLA-staked balances + yearly_take_rate (same 4 contracts)
  const stakedByGaugeAsset = {};   // gauge -> { key -> rawUnits }
  const takeByGaugeAsset = {};     // gauge -> { key -> fraction|null }
  for (const [gauge, addr] of Object.entries(STAKING_BUCKETS)) {
    try {
      const res = await T.queryContract(addr, { total_staked_balances: {} });
      const list = Array.isArray(res) ? res : (res && (res.assets || res.data || res.balances)) || [];
      const m = {};
      for (const en of list) {
        const key = assetKeyFromInfo(en.asset ?? en.info ?? en);
        const bal = Number(en.balance ?? en.amount ?? (en.asset && en.asset.amount));
        if (key && isFinite(bal)) m[key] = bal;
      }
      stakedByGaugeAsset[gauge] = m;
    } catch (e) { out.errors[`staked_${gauge}`] = String(e && e.message || e); }
    try {
      const res = await T.queryContract(addr, { whitelisted_asset_details: {} });
      let list = res;
      if (res && typeof res === 'object' && !Array.isArray(res)) list = res.data || res.assets || res.list || [];
      const m = {};
      for (const en of (Array.isArray(list) ? list : [])) {
        const key = assetKeyFromInfo(en.info ?? en.asset ?? en);
        if (!key) continue;
        const raw = (en.config ? (en.config.yearly_take_rate ?? en.config.take_rate) : null) ?? en.yearly_take_rate;
        const n = raw != null ? Number(raw) : null;
        m[key] = (n != null && isFinite(n) && n >= 0 && n < 1) ? n : null;
      }
      takeByGaugeAsset[gauge] = m;
    } catch (e) { out.errors[`take_${gauge}`] = String(e && e.message || e); }
  }

  return {
    ...out,
    captured_at: new Date().toISOString(),
    annual_provisions_uluna: annualProvisionsUluna,
    annual_provisions_luna: annualProvisionsUluna != null ? annualProvisionsUluna / 1e6 : null,
    total_reward_weight: totalRewardWeight,
    alliances_active_count: active.length,
    per_gauge: perGauge,
    dist_by_gauge: distByGauge,
    dist_sum_by_gauge: distSumByGauge,
    staked_by_gauge_asset: stakedByGaugeAsset,
    take_by_gauge_asset: takeByGaugeAsset,
  };
}

// ---------------------------------------------------------------------------
// Stage 3+4 compose — PURE. dexPools = concat of adapter snapshot pools.
// assetPrices (optional) = { denomOrCw20 -> { price_usd, decimals } } for
// single-asset gauge entries that never appear as an LP pair.
// ---------------------------------------------------------------------------
function composeErisApr(inputs, dexPools = [], assetPrices = {}, catalog = null) {
  // LUNA price: adapters' own asset captures (median) PRIMARY; token-catalog
  // fallback (labeled) when no adapter carried uluna this run.
  const lunaPrices = [];
  for (const p of dexPools) for (const a of (p.assets || [])) {
    if (a && a.denom === 'uluna' && a.price_usd != null && isFinite(a.price_usd)) lunaPrices.push(Number(a.price_usd));
  }
  lunaPrices.sort((x, y) => x - y);
  let lunaUsd = lunaPrices.length ? lunaPrices[Math.floor(lunaPrices.length / 2)] : null;
  let lunaSource = lunaUsd != null ? 'adapter uluna asset prices (median)' : null;
  if (lunaUsd == null && catalog) {
    const cp = catalogPrice(catalog, 'uluna');
    if (cp) { lunaUsd = cp.price_usd; lunaSource = cp.source + ' (fallback)'; }
  }

  // dex pool join index by gauge_pool_id
  const poolByKey = {};
  for (const p of dexPools) {
    const key = p && p.raw && p.raw.gauge && p.raw.gauge.gauge_pool_id;
    if (key && !poolByKey[key]) poolByKey[key] = p;
  }

  const pools = [];
  for (const [gauge, entries] of Object.entries(inputs.dist_by_gauge || {})) {
    const g = (inputs.per_gauge || {})[gauge] || null;
    for (const en of entries) {
      const key = en.key;
      const flags = [];
      const stakedRaw = ((inputs.staked_by_gauge_asset || {})[gauge] || {})[key];
      const takeFrac = ((inputs.take_by_gauge_asset || {})[gauge] || {})[key];
      const dexPool = poolByKey[key] || null;

      // incentives (verbatim: rewardsPerYear × raw distribution)
      const incentivesLunaYear = (g && g.rewards_per_year_luna != null) ? g.rewards_per_year_luna * en.distribution : null;
      const incentivesUsdYear = (incentivesLunaYear != null && lunaUsd != null) ? incentivesLunaYear * lunaUsd : null;
      if (incentivesUsdYear == null) flags.push(lunaUsd == null ? 'luna_price_unavailable' : 'gauge_incentives_unavailable');

      // TLA-staked USD — supply-ratio × TVL (unit-free), else single-asset price
      let stakedUsd = null, stakedBasis = null, poolTvlImplied = null;
      if (stakedRaw === 0) {
        stakedUsd = 0; stakedBasis = 'staked_zero';   // zero units = $0 by identity, no price needed
      } else if (stakedRaw != null && dexPool && dexPool.tvl_usd != null && dexPool.lp_total_supply != null && Number(dexPool.lp_total_supply) > 0) {
        stakedUsd = (stakedRaw / Number(dexPool.lp_total_supply)) * Number(dexPool.tvl_usd);
        stakedBasis = 'staked_supply_ratio_x_pool_tvl';
      } else if (stakedRaw != null && dexPool && dexPool.tvl_usd == null && dexPool.lp_total_supply != null && Number(dexPool.lp_total_supply) > 0) {
        // 1.3.3: adapter deferred pricing (SkeletonSwap) — reserves × trusted prices
        const ri = reserveImpliedTvl(dexPool, assetPrices, catalog);
        if (ri.tvl_usd != null) {
          stakedUsd = (stakedRaw / Number(dexPool.lp_total_supply)) * ri.tvl_usd;
          stakedBasis = `staked_supply_ratio_x_reserve_implied_tvl (${Array.from(new Set(ri.sources)).join('+')})`;
          poolTvlImplied = ri.tvl_usd;
        } else {
          flags.push(`reserve_tvl_unpriced:${ri.missing}`);
        }
      } else if (stakedRaw != null && !dexPool) {
        const ident = key.startsWith('cw20:') ? key.slice(5) : key.startsWith('native:') ? key.slice(7) : null;
        let ap = ident != null ? assetPrices[ident] : null;
        let apSource = 'adapter';
        if ((!ap || ap.price_usd == null) && ident != null && catalog) {
          const cp = catalogPrice(catalog, ident);
          if (cp) { ap = cp; apSource = cp.source + ' (fallback)'; }
        }
        if (ap && ap.price_usd != null && isFinite(ap.price_usd)) {
          const dec = ap.decimals != null ? Number(ap.decimals) : 6;
          stakedUsd = (stakedRaw / Math.pow(10, dec)) * Number(ap.price_usd);
          stakedBasis = apSource === 'adapter' ? 'staked_units_x_asset_price' : `staked_units_x_asset_price (${apSource})`;
        }
      }
      if (stakedUsd == null) {
        if (stakedRaw == null) flags.push('staked_balance_unavailable');
        else flags.push('staked_usd_unavailable');
      }

      // incentiveApr — edge cases VERBATIM (0/0 → 0; tvl==0 → Infinity → null+flag)
      let incentivePct = null;
      if (incentivesUsdYear != null && stakedUsd != null) {
        if (stakedUsd === 0 && incentivesUsdYear === 0) incentivePct = 0;
        else if (stakedUsd === 0) { incentivePct = null; flags.push('infinite_apr_zero_tvl'); }
        else incentivePct = (incentivesUsdYear / stakedUsd) * 100;
      }

      // trading leg: OUR fee_apr (percent). Verbatim `trading ?? 0` in the formula.
      const tradingPct = dexPool && dexPool.fee_apr != null && isFinite(dexPool.fee_apr) ? Number(dexPool.fee_apr) : null;
      if (tradingPct == null) flags.push('trading_apr_assumed_zero');
      const tradingForFormula = tradingPct != null ? tradingPct : 0;

      const takePct = takeFrac != null ? takeFrac * 100 : null;
      if (takePct == null) flags.push('take_rate_unavailable');

      // 1.3.3: single-asset entries — name from the catalog, and the named gap
      let singleName = null;
      if (!dexPool) {
        const ident = key.startsWith('cw20:') ? key.slice(5) : key.startsWith('native:') ? key.slice(7) : null;
        singleName = ident != null ? catalogSymbol(catalog, ident) : null;
        flags.push('single_asset_yield_leg_unmeasured');
      }

      // Stage 4 — both variants, source-verbatim
      let erisAprPct = null, erisApyPct = null;
      if (incentivePct != null && takePct != null) {
        erisAprPct = incentivePct - takePct + tradingForFormula;                       // their linear `total` (no 0.92)
        erisApyPct = aprToApy(incentivePct * (1 - ERIS_INCENTIVE_CUT)) + tradingForFormula - takePct;
      }

      pools.push({
        gauge_pool_id: key,
        gauge,
        pool_address: dexPool ? dexPool.pool_address : null,
        pool_name: dexPool ? dexPool.pool_name : singleName,
        pool_name_source: dexPool ? 'adapter' : (singleName ? 'token-catalog symbol' : null),
        dex: dexPool ? dexPool.dex : null,
        ...(poolTvlImplied != null ? { pool_tvl_usd_reserve_implied: poolTvlImplied } : {}),
        distribution: en.distribution,
        incentives_luna_per_year: incentivesLunaYear,
        incentives_luna_per_epoch: incentivesLunaYear != null ? incentivesLunaYear / 365 * EPOCH_DAYS : null,
        incentives_usd_per_year: incentivesUsdYear,
        tla_staked_raw: stakedRaw != null ? stakedRaw : null,
        tla_staked_usd: stakedUsd,
        tla_staked_usd_basis: stakedBasis,
        incentive_apr_pct: incentivePct,
        trading_apr_pct: tradingPct,
        yearly_take_rate_pct: takePct,
        eris_cut_pct: ERIS_INCENTIVE_CUT * 100,
        eris_apr_pct: erisAprPct,
        eris_apy_pct: erisApyPct,
        ...(flags.length ? { flags } : {}),
      });
    }
  }

  const distSumDeviations = {};
  for (const [gauge, sum] of Object.entries(inputs.dist_sum_by_gauge || {})) {
    if (Math.abs(sum - 1) > 0.02) distSumDeviations[gauge] = sum;   // reported, NEVER normalized (verbatim law)
  }

  return {
    meta: {
      generated_at: inputs.captured_at || new Date().toISOString(),
      method: 'AUDIT-eris-apr-pricing §Gauge-LP-APR (source-confirmed 2026-08-02) — verbatim mixed convention: apy = aprToApy(incentive×0.92, 365.25) + trading − take; apr(linear total) = incentive − take + trading (no 0.92, per source); trading??0 in formula; edge cases verbatim (0/0→0, tvl==0→Infinity published null+flag); distributions raw, never normalized.',
      substitutions: 'trading_apr = dex-data fee_apr (their pool service not queryable); LUNA price + LP TVL from dex-data adapter captures.',
      validation: 'pending ground-truth reconciliation (SPEC-lp-apr §7 4-pool + CRON-FIXES-BRIEF §2.10 19-pool) — run at deploy before pages consume.',
      luna_price_used_usd: lunaUsd,
      luna_price_source: lunaSource,
      annual_provisions_luna: inputs.annual_provisions_luna ?? null,
      total_reward_weight: inputs.total_reward_weight ?? null,
      alliances_active_count: inputs.alliances_active_count ?? null,
      dist_sum_deviations: Object.keys(distSumDeviations).length ? distSumDeviations : null,
      input_errors: inputs.errors && Object.keys(inputs.errors).length ? inputs.errors : null,
      pools_total: pools.length,
      pools_fully_priced: pools.filter(p => p.eris_apy_pct != null).length,
    },
    alliance: { per_gauge: inputs.per_gauge || {} },
    pools,
  };
}

// Orchestrator entry: capture + compose in one call.
async function runErisApr(dexPools, assetPrices, T = CH) {
  const inputs = await captureInputs(T);
  const catalog = await fetchCatalog(T);
  return composeErisApr(inputs, dexPools, assetPrices || {}, catalog);
}

module.exports = { runErisApr, captureInputs, composeErisApr, aprToApy, assetKeyFromInfo, connectorAddrFromDenom, fetchCatalog, catalogPrice, catalogSymbol, reserveImpliedTvl, CH, ERIS_INCENTIVE_CUT };
