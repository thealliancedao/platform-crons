'use strict';
/**
 * lib/credia-reader.js 1.0.0 (2026-09-27) — ONE reader for a wallet's Credia position, for every job that needs it:
 *   ally-positions (Lion DAO roster, hourly) · member-data tla-participants (every TLA participant, hourly) · next: the app / planner
 * Moved out of ally-positions 1.5.0 (same code, no copy). The Credia Portfolio contract answers, per wallet:
 *   { supplied:[{info, vamount, amount, value, collateral, lt_value, ltv_value}], borrowed:[same shape], total_supplied_value,
 *     total_collateral_value, total_lt_value, total_ltv_value, total_borrowed_value, lt_health_factor, ltv_health_factor,
 *     unhealthy_prices, max_liquidation_usd, emode }   (captured raw: tla-core docs/fixtures/2026-09-27/credia-portfolio-ryan.json)
 * `value` is USD at Credia's own oracle — the venue's contract is the source, not our feed. A health factor under 1 = liquidatable.
 * The old shape ({ supplies / borrows }, no values) is still parsed (the 1.1.0 path) so nothing breaks if Credia changes it back.
 *   parsePortfolio(pf, { markets, resolve }) → pure
 *   readCredia(wallet, { queryContract, markets, resolve }) → one contract query per wallet
 */
const VERSION = 'credia-reader-1.0.0';
const num = (x) => { if (x == null || x === '') return null; const n = Number(x); return Number.isFinite(n) ? n : null; };
function assetDenom(info) { if (!info) return null; if (typeof info === 'string') return info; if (info.native) return typeof info.native === 'string' ? info.native : (info.native.denom || null); if (info.cw20) return typeof info.cw20 === 'string' ? info.cw20 : (info.cw20.contract_addr || null); if (info.denom) return info.denom; if (info.contract_addr) return info.contract_addr; return null; }

function parsePortfolio(pf, o) {
  o = o || {}; const markets = o.markets || [];
  const decOf = (d) => { const m = markets.find(x => x.denom === d); if (m) return { dec: m.decimals, sym: m.symbol }; const r = o.resolve ? o.resolve(d) : null; return r && r.symbol ? { dec: r.decimals, sym: r.symbol } : null; };
  const rowOf = (x, kind) => { const d = assetDenom(x.info || x.asset_info || x.asset || x); const k = decOf(d); const amt = x.amount != null ? String(x.amount) : null;
    return { market: d, symbol: k ? k.sym : (/\/amplp$/.test(d || '') ? 'ampLP (TLA compounder receipt)' : null), amount_raw: amt, vamount_raw: x.vamount != null ? String(x.vamount) : null,
      amount_human: k && amt != null ? Number(amt) / Math.pow(10, k.dec) : null, usd_value: num(x.value), collateral: kind === 'supplied' ? x.collateral !== false : undefined,
      lt_value_usd: num(x.lt_value), ltv_value_usd: num(x.ltv_value), price_source: 'credia portfolio contract (its oracle)' }; };
  if (pf == null) return { error: 'portfolio query failed' };
  const sup = pf.supplied || pf.supplies || null, bor = pf.borrowed || pf.borrows || pf.borrow || pf.portfolio_borrow || (pf.portfolio && (pf.portfolio.borrows || pf.portfolio.borrow)) || null;
  if (Array.isArray(sup) && (pf.total_supplied_value != null || sup.some(x => x.value != null))) {
    const supplied = sup.map(x => rowOf(x, 'supplied')); const debt = Array.isArray(bor) ? bor.map(x => rowOf(x, 'borrowed')) : [];
    const health = { lt_health_factor: num(pf.lt_health_factor), ltv_health_factor: num(pf.ltv_health_factor), total_supplied_usd: num(pf.total_supplied_value), total_collateral_usd: num(pf.total_collateral_value),
      total_lt_usd: num(pf.total_lt_value), total_ltv_usd: num(pf.total_ltv_value), total_borrowed_usd: num(pf.total_borrowed_value), max_liquidation_usd: pf.max_liquidation_usd != null ? num(pf.max_liquidation_usd) : null,
      unhealthy_prices: Array.isArray(pf.unhealthy_prices) ? pf.unhealthy_prices : [], emode: pf.emode != null ? pf.emode : (pf.emode_group != null ? pf.emode_group : null),
      note: "Credia's own view: a health factor under 1 is liquidatable; lt = liquidation threshold, ltv = borrow limit; values in USD at Credia's oracle" };
    const supplied_usd = health.total_supplied_usd != null ? health.total_supplied_usd : supplied.reduce((s, x) => s + (x.usd_value || 0), 0);
    const debt_usd = health.total_borrowed_usd != null ? health.total_borrowed_usd : debt.reduce((s, x) => s + (x.usd_value || 0), 0);
    return { shape: 'supplied_borrowed', supplied, debt, health, supplied_usd, debt_usd, net_usd: supplied_usd - debt_usd };
  }
  if (Array.isArray(bor)) return { shape: 'legacy_borrows', legacy_borrows: bor };
  return { error: 'portfolio response has neither supplied/borrowed nor borrows (shape unknown — raw kept)' };
}

async function readCredia(wallet, o) {
  let pf = null; try { pf = await o.queryContract(o.portfolioContract, { portfolio: { address: wallet } }); } catch (e) { pf = null; }
  const r = parsePortfolio(pf, o);
  return Object.assign({ raw: pf }, r);
}

module.exports = { VERSION, parsePortfolio, readCredia, assetDenom };
