#!/usr/bin/env node
/* ============================================================================
 * ally-positions/index.js 1.1.0 (2026-09-22) — POSITIONS for an ally's wallet roster (crons per ally).
 * 1.1.0 (after the owner's row-for-row audit vs phoenix.money + the DAODAO treasuries, 2026-09-21 late):
 *   - PRICE BY DENOM FIRST. network-and-prices keys by its own symbol (WBTC, WSTETH) while the catalog says wBTC.atom /
 *     wstETH; every feed entry with a phoenix-1 market carries its denom, so the reader indexes the feed by denom and looks
 *     the row's denom up before falling back to the catalog symbol (`price_key` / `price_match` on the row say which key
 *     priced it). A denom the catalog lacks but the feed prices (USDC.inj) is priced with symbol_reason kept — the feed's
 *     catalog_symbol_drift gate is what watches that upstream.
 *   - RECEIPTS ARE LABELED, NEVER PRICED TWICE. A `factory/<compounder>/…` balance is the compounder receipt the engine
 *     already values in lp_positions; a Credia vproxy balance is the collateral the Credia reader values. Both stay in
 *     `balances` as rows with held_as / valued_in and NO usd_value (a priced receipt would double the position).
 *   - CREDIA READER. Collateral per market = the wallet's vproxy (receipt) balance × the market's supply_index (the
 *     receipt IS the virtual amount; docs: real = vamount × index), priced by OUR feed (denom first) with Credia's own
 *     oracle price beside it as a check. Debt from {portfolio:{address}} on the Portfolio contract (borrows × borrow_index);
 *     the response is parsed shape-tolerantly and kept raw; an unparsable/failed read leaves debt null with the reason.
 *     Markets and indices come from dex-data/credia/snapshots/current.json (one source, already captured hourly).
 *   - KNOWN CW20s. tenants.json `known_cw20s` lists cw20s the catalog does not carry (pyROAR on the DAO treasury …);
 *     read like catalog cw20s, symbol_source labeled.
 *   - GATE #0 BY SECTION. The wallet total hid two errors cancelling (ours short on balances + Credia, theirs short on five
 *     compounder receipts priced $0). reconciliation now publishes ours vs theirs per SECTION per wallet (balances · tla ·
 *     compounder · locks · credia · votion) with `reference_as_of` (the fixture's date) and their own $0-with-amount rows.
 * 1.1.1: `daily/index.json` — depth is a product: every page's trend reads this series (one small row per archived day,
 *   merged never-shrink, same-day overwrite) instead of fetching every daily file.
 * 1.0.1: LCD read errors surfaced on the row, validator account skips the TLA engine, gate-#0 reference from tenants.json.
 * ----------------------------------------------------------------------------
 * ONE engine, one Render service per ally: `TENANT=liondao node ally-positions/index.js`. The roster, the validator, the
 * staking contracts and the DAO folder all come from tla-core/docs/curated/tenants.json — this file holds no address.
 *
 * Per wallet (the same engine member-data runs for every TLA participant — lib/capture-engine.js: TLA staked
 * amp / non-amp post-take, locks + VP, pending rewards / bribes / rebase, compounder receipts priced through the
 * compounder's own rates) PLUS what the engine does not read and phoenix.money does not show:
 *   balances     — every bank denom + every catalog cw20, symbol from the token-catalog `effective` layer
 *                  (lib/denom-symbol.js), USD from network-and-prices; unpriced rows KEPT with their reason
 *   delegations  — LUNA delegated per validator + unclaimed rewards; the ally's own validator marked
 *   validator    — the validator's commission accrued (the account is a position too)
 *   votion       — the wallet's rows in tla-core/votion/snapshots/vaults.json
 *   nfts         — held / staked counts per collection of the tenant (nft-collections summary.json)
 *   credia       — NOT READ YET (no reader for the market contract's user positions) → null with the reason
 *
 * Roll-up per role (treasury / ops / msig / validator) and for the DAO; every USD basis labeled; null ≠ 0.
 * Writes dao-originations/<dao>/positions/current.json · daily/<date>.json · heartbeat.json (write-once per day,
 * same-day overwrite). GATE #0: if docs/fixtures/<date>/phoenix-money-liondao-portfolio.json is on tla-core, the run
 * publishes a side-by-side (our USD per wallet vs theirs) in current.json.reconciliation — the venue's UI is not the
 * oracle, it is the check.
 * ========================================================================== */
'use strict';
const https = require('https');
const fs = require('fs');
const path = require('path');
const E = require('../lib/capture-engine.js');
const { buildResolver } = require('../lib/denom-symbol.js');

const VERSION = '1.4.0';   // 1.4.0 (2026-09-26, owner: "do we have things capturing data so we can power trends?"): history-forward.js — every run keeps history/daily.json going (closed days read at height on the public node; latest-state fallback at 23:xx UTC) and rewrites today's row of history/markets.json (ROAR / pyROAR / ROAR20 prices, holder counts, Burning Lions minted + holders); HISTORY_FORWARD=off disables it; a failure never fails the positions run. 1.3.0 (2026-09-26, owner: "what do we need to get the ROAR20 price pulled in?"): every hourly run also captures ROAR20's market server-side (roar20-market.js: DexScreener → GeckoTerminal → Jupiter) into <dao>/roar20/market.json + an hourly market-history.json; ROAR20_MARKET=off disables it; a failure never fails the positions run.
//   // 1.2.3: fix — main() has no ctx; the holders root comes from doc.product. 1.2.2 (2026-09-22, owner): the holders duty runs inside this job once every ≥20 h (holdersDue) — no second service; env HELIUS_API_KEY here. 1.2.1 (2026-09-22, first live run): epoch dates as ISO (at_time ns); DROGO named via the registry. 1.2.0 (2026-09-22): pl_rewards — the pixeLions DAODAO rewards distributor (found by a claim tx): distributions with their emission rates (raw kept), APR as arithmetic on rate ÷ staked count × price ÷ floor, pending per roster wallet. 1.1.1:   // 1.1.1 (2026-09-22): daily/index.json — the DAILY SERIES the pages chart (one row per archived day: known, liabilities, by section, by wallet, VP, prices, commission, the gate-#0 delta); write-once per day, never-shrink
const C = require('../config/contracts.js');
const COMPOUNDER_PREFIX = `factory/${C.COMPOUNDER.addr}/`;
const CREDIA_PORTFOLIO = C.CREDIA.portfolio;
const TENANT = process.env.TENANT || 'liondao';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO || 'thealliancedao/dao-originations';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const OUT_ROOT = process.env.OUT_ROOT || null;   // default: tenants.json daos[0] (the DAO folder in dao-originations)
const CORE = 'https://raw.githubusercontent.com/thealliancedao/tla-core/main/';
const NFTC = 'https://raw.githubusercontent.com/thealliancedao/nft-collections/main/';
const LCD = E.TERRA_LCD_PRIMARY;

// ---------------------------------------------------------------- helpers
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const sum = (arr) => { let t = 0, any = false; for (const v of arr) if (Number.isFinite(v)) { t += v; any = true; } return any ? t : null; };
const day = () => new Date().toISOString().slice(0, 10);
const lastLcdError = {};
async function lcd(p, label) { try { return await E.fetchJson(LCD + p, label || p.slice(0, 40)); } catch (e) { try { return await E.fetchJson(E.TERRA_LCD_FALLBACK + p, label); } catch (e2) { lastLcdError[p] = `${e.message} · fallback: ${e2.message}`; return null; } } }
async function lcdPaged(p, key, max = 20) { let out = [], next = null, n = 0; do { const r = await lcd(p + (p.includes('?') ? '&' : '?') + 'pagination.limit=500' + (next ? '&pagination.key=' + encodeURIComponent(next) : '')); if (!r) return n ? out : null; out = out.concat(r[key] || []); next = r.pagination && r.pagination.next_key; n++; } while (next && n < max); return out; }

// ---------------------------------------------------------------- readers the engine lacks
async function readBalances(wallet, ctx) {
  const bank = await E.fetchBankBalances(wallet);
  const rows = [];
  for (const b of bank) {
    const amt = num(b.amount); if (!amt) continue;
    const r = ctx.resolve(b.denom); const dec = r.decimals != null ? r.decimals : 6; const human = amt / Math.pow(10, dec);
    rows.push(priceRow({ kind: 'native', denom: b.denom, symbol: r.symbol, symbol_reason: r.symbol ? null : r.reason, amount_raw: b.amount, amount_human: human }, ctx));
  }
  await E.parallelMap(ctx.cw20s, async (t) => {
    const bal = await E.queryContract(t.denom, { balance: { address: wallet } });
    const amt = bal ? num(bal.balance) : null; if (!amt) return;
    const human = amt / Math.pow(10, t.decimals);
    rows.push(priceRow({ kind: 'cw20', denom: t.denom, symbol: t.symbol, symbol_reason: t.symbol ? null : 'not_in_token_catalog', symbol_source: t.symbol_source || 'token-catalog', amount_raw: bal.balance, amount_human: human }, ctx));
  }, 5);
  rows.sort((a, b) => (b.usd_value || 0) - (a.usd_value || 0));
  return rows;
}
// 1.1.0 — a receipt is a position held elsewhere in this same document; it is named here and valued THERE, never here.
function receiptKind(denom, ctx) {
  if (denom.startsWith(COMPOUNDER_PREFIX)) return { held_as: 'compounder_receipt', valued_in: 'portfolio.lp_positions (source asset_compounder)' };
  if (ctx.crediaReceiptDenoms && ctx.crediaReceiptDenoms.has(denom)) return { held_as: 'credia_receipt', valued_in: 'credia.collateral' };
  return null;
}
// 1.1.0 — the feed by denom first (the denom is the identity; the feed's spelling of the symbol is not), catalog symbol second.
function findPrice(denom, symbol, ctx) {
  const byDenom = denom && ctx.priceByDenom && ctx.priceByDenom.get(denom);
  if (byDenom && byDenom.price != null) return { price: byDenom.price, source: byDenom.source, key: byDenom.key, match: 'denom' };
  const e = symbol && ctx.tokenPrices[symbol]; const p = e ? num(e.final_price_usd) : null;
  if (p != null) return { price: p, source: e.final_source || 'network-and-prices', key: symbol, match: 'catalog_symbol' };
  return null;
}
function priceRow(row, ctx) {
  const receipt = receiptKind(row.denom, ctx);
  if (receipt) { Object.assign(row, receipt); row.price_usd = null; row.price_source = null; row.usd_value = null; row.unpriced_reason = 'valued_in_' + row.held_as.replace('_receipt', '') + '_section'; return row; }
  const hit = findPrice(row.denom, row.symbol, ctx);
  row.price_usd = hit ? hit.price : null; row.price_source = hit ? hit.source : null; row.price_key = hit ? hit.key : null; row.price_match = hit ? hit.match : null;
  row.usd_value = hit ? row.amount_human * hit.price : null;
  row.unpriced_reason = hit ? null : (row.symbol ? 'symbol_not_in_price_feed' : (row.symbol_reason || 'symbol_unknown'));
  return row;
}
// 1.1.0 — Credia: collateral from the receipt balances (chain-verified model), debt from the Portfolio contract.
function assetDenom(info) { if (!info) return null; if (typeof info === 'string') return info; if (info.native) return typeof info.native === 'string' ? info.native : (info.native.denom || null); if (info.cw20) return typeof info.cw20 === 'string' ? info.cw20 : (info.cw20.contract_addr || null); if (info.native_token) return info.native_token.denom || null; if (info.token) return info.token.contract_addr || null; if (info.denom) return info.denom; if (info.contract_addr) return info.contract_addr; return null; }
async function readCredia(wallet, ctx) {
  const markets = ctx.crediaMarkets; if (!markets || !markets.length) return { collateral: null, debt: null, collateral_usd: null, debt_usd: null, net_usd: null, error: 'credia markets unavailable (dex-data/credia/snapshots/current.json)' };
  const collateral = [];
  await E.parallelMap(markets, async (m) => {
    if (!m.vproxy) return;
    const bal = await E.queryContract(m.vproxy, { balance: { address: wallet } });
    if (bal === null) { collateral.push({ market: m.denom, symbol: m.symbol, error: 'vproxy balance read failed' }); return; }
    const v = num(bal.balance); if (!v) return;
    const real = v * m.supply_index; const human = real / Math.pow(10, m.decimals);
    const hit = findPrice(m.denom, m.symbol, ctx);
    collateral.push({ market: m.denom, symbol: m.symbol, vproxy: m.vproxy, vamount_raw: bal.balance, supply_index: m.supply_index, amount_human: human, price_usd: hit ? hit.price : null, price_source: hit ? hit.source : null, price_key: hit ? hit.key : null, credia_oracle_price_usd: m.credia_price_usd, usd_value: hit ? human * hit.price : null, unpriced_reason: hit ? null : (m.symbol ? 'symbol_not_in_price_feed' : 'not_in_token_catalog'), basis: 'receipt balance × market supply_index (real = vamount × index), priced by our feed' });
  }, 4);
  // debt — the Portfolio contract's per-user view; shape kept raw, parsed tolerantly (supplies/borrows arrays with a vamount)
  let debt = null, debtError = null, raw = null;
  const pf = await E.queryContract(CREDIA_PORTFOLIO, { portfolio: { address: wallet } });
  if (pf === null) debtError = 'portfolio query failed';
  else {
    raw = pf; const borrows = pf.borrows || pf.borrow || pf.portfolio_borrow || (pf.portfolio && (pf.portfolio.borrows || pf.portfolio.borrow)) || null;
    if (!Array.isArray(borrows)) debtError = 'portfolio response has no borrows array (shape unknown — raw kept)';
    else debt = borrows.map((b) => { const d = assetDenom(b.asset_info || b.info || b.asset || b); const m = markets.find(x => x.denom === d); const vam = num(b.vamount != null ? b.vamount : (b.amount != null ? b.amount : b.virtual_amount)); const real = vam != null && m ? vam * m.borrow_index : null; const human = real != null && m ? real / Math.pow(10, m.decimals) : null; const hit = m ? findPrice(m.denom, m.symbol, ctx) : null; return { market: d, symbol: m ? m.symbol : null, vamount_raw: b.vamount != null ? String(b.vamount) : null, borrow_index: m ? m.borrow_index : null, amount_human: human, price_usd: hit ? hit.price : null, usd_value: hit && human != null ? human * hit.price : null, unpriced_reason: hit ? null : (m ? 'symbol_not_in_price_feed' : 'market_not_in_credia_snapshot') }; }).filter(x => x.amount_human == null || x.amount_human > 0);
  }
  const cUsd = sum(collateral.map(c => c.usd_value)); const cErr = collateral.some(c => c.error);
  const collateral_usd = collateral.length === 0 ? 0 : (cErr && cUsd == null ? null : cUsd);
  const debt_usd = debt === null ? null : (debt.length === 0 ? 0 : sum(debt.map(d => d.usd_value)));
  return { collateral, debt, collateral_usd, debt_usd, net_usd: collateral_usd != null && debt_usd != null ? collateral_usd - debt_usd : null, debt_error: debtError, portfolio_raw: raw, source: `dex-data/credia markets + vproxy balances + ${CREDIA_PORTFOLIO.slice(0, 16)}… portfolio{address}`, note: 'collateral is an asset (counted in known_usd), debt a liability (liabilities_usd); net only when both read' };
}
async function readDelegations(wallet, ctx) {
  const [dl, rw] = await Promise.all([lcd(`/cosmos/staking/v1beta1/delegations/${wallet}?pagination.limit=100`, 'delegations'), lcd(`/cosmos/distribution/v1beta1/delegators/${wallet}/rewards`, 'rewards')]);
  if (!dl) return { rows: null, luna: null, usd_value: null, rewards_luna: null, rewards_usd: null, error: lastLcdError[`/cosmos/staking/v1beta1/delegations/${wallet}?pagination.limit=100`] || 'delegations read failed' };
  const rewardsBy = {}; for (const r of (rw && rw.rewards) || []) rewardsBy[r.validator_address] = sum((r.reward || []).filter(c => c.denom === 'uluna').map(c => num(c.amount) / 1e6));
  const rows = (dl.delegation_responses || []).map(r => { const v = r.delegation.validator_address; const luna = num(r.balance.amount) / 1e6; return { validator: v, own_validator: v === ctx.validator, luna, usd_value: ctx.lunaPriceUsd != null ? luna * ctx.lunaPriceUsd : null, rewards_luna: rewardsBy[v] != null ? rewardsBy[v] : null, rewards_usd: rewardsBy[v] != null && ctx.lunaPriceUsd != null ? rewardsBy[v] * ctx.lunaPriceUsd : null }; });
  const z = (v) => (v == null && rows.length === 0 ? 0 : v);   // a successful read with no delegations is 0; null is reserved for a failed read
  return { rows, luna: z(sum(rows.map(r => r.luna))), usd_value: z(sum(rows.map(r => r.usd_value))), rewards_luna: z(sum(rows.map(r => r.rewards_luna))), rewards_usd: z(sum(rows.map(r => r.rewards_usd))), price_basis: 'LUNA at network-and-prices' };
}
async function readValidatorCommission(ctx) {
  if (!ctx.validator) return null;
  const c = await lcd(`/cosmos/distribution/v1beta1/validators/${ctx.validator}/commission`, 'commission');
  const luna = c && c.commission ? sum((c.commission.commission || []).filter(x => x.denom === 'uluna').map(x => num(x.amount) / 1e6)) : null;
  return { operator: ctx.validator, commission_unclaimed_luna: luna, commission_unclaimed_usd: luna != null && ctx.lunaPriceUsd != null ? luna * ctx.lunaPriceUsd : null };
}
function readVotion(wallet, ctx) {
  const vaults = ctx.votionVaults; if (!vaults) return null;
  const rows = [];
  for (const v of (vaults.vaults || [])) for (const h of (v.holders || [])) if (h.address === wallet || h.wallet === wallet) rows.push({ vault: v.name || v.id || v.address, shares: num(h.shares || h.balance), usd_value: num(h.usd_value || h.value_usd) });
  return { rows, usd_value: sum(rows.map(r => r.usd_value)), source: 'tla-core/votion/snapshots/vaults.json' };
}
function readNfts(wallet, ctx) {
  const out = {}; let any = false;
  for (const [slug, s] of Object.entries(ctx.nftSummaries)) {
    if (!s) continue; any = true;
    const held = num((s.per_real_owner_counts || {})[wallet]) || 0;
    const stakedRow = (s.daodao_stakers || []).find(x => (x.address || x.wallet) === wallet);
    const staked = stakedRow ? num(stakedRow.count || stakedRow.staked || stakedRow.nft_count) || 0 : 0;
    out[slug] = { held_total: held, staked_daodao: staked, floor_usd: null };
  }
  return any ? out : null;
}

// ---------------------------------------------------------------- 1.2.0: the pixeLions rewards distributor (DAODAO dao-rewards-distributor)
//   tenants.json staking.pl_rewards_distributor — found 2026-09-22 by a claim tx. Query shapes per the DAO DAO contract (Distributions,
//   PendingRewards, the distribution's active_epoch.emission_rate); every answer is kept raw beside what this reader parsed, so a
//   schema drift shows as Coming with the raw on the row, never as a wrong number. APR = linear rate per year ÷ staked count, priced.
async function blockSeconds() { const a = await lcd('/cosmos/base/tendermint/v1beta1/blocks/latest'); const h = a && a.block && num(a.block.header.height); if (!h) return null; const b = await lcd(`/cosmos/base/tendermint/v1beta1/blocks/${h - 20000}`); if (!b || !b.block) return null; return (Date.parse(a.block.header.time) - Date.parse(b.block.header.time)) / 1000 / 20000; }
async function readPlRewards(ctx) {
  const st = ctx.tenant.staking || {}; const addr = st.pl_rewards_distributor; if (!addr) return { distributor: null, reason: 'tenants.json staking.pl_rewards_distributor not set' };
  const smartQ = async (q) => { const r = await lcd(`/cosmwasm/wasm/v1/contract/${addr}/smart/${Buffer.from(JSON.stringify(q)).toString('base64')}`); return r && r.data !== undefined ? r.data : null; };
  const symOf = (dn) => { const r = ctx.resolve(dn); if (r && r.symbol) return r; const k = (ctx.cw20s || []).find(c => c.denom === dn); return k && k.symbol ? { symbol: k.symbol, decimals: k.decimals != null ? k.decimals : 6, symbol_source: 'tenants.json known_cw20s' } : r; };   // 1.2.1: a cw20 the catalog lacks but the registry names (DROGO)
  const list = await smartQ({ distributions: { limit: 50 } }); const dists = list && Array.isArray(list.distributions) ? list.distributions : null;
  if (!dists) return { distributor: addr, distributions: null, reason: 'distributions query failed (or not this contract\'s schema)', raw: list };
  const slug = (ctx.tenant.collections || [])[0]; const summ = slug ? ctx.nftSummaries[slug] : null; const staked = summ ? num(summ.daodao_staked_count) : null;
  const bps = await blockSeconds().catch(() => null);
  const YEAR = 31536000;
  const out = { distributor: addr, source: 'DAODAO rewards distributor: distributions + pending_rewards (raw kept)', staked_count: staked, staked_source: slug ? `nft-collections/${slug} summary daodao_staked_count` : null, block_seconds: bps, distributions: [], pending_by_wallet: {} };
  for (const d of dists) {
    const dn = d.denom && (d.denom.native || d.denom.cw20) || null; const r = dn ? symOf(dn) : { symbol: null, decimals: 6 }; const dec = r.decimals != null ? r.decimals : 6;
    const er = d.active_epoch && d.active_epoch.emission_rate || null; const lin = er && er.linear || null;
    let perYear = null, rateNote = null;
    if (lin && lin.amount != null && lin.duration) { const amt = num(lin.amount) / Math.pow(10, dec); if (lin.duration.time != null) { perYear = amt * YEAR / num(lin.duration.time); rateNote = `${amt} per ${lin.duration.time}s`; } else if (lin.duration.height != null) { if (bps) { perYear = amt * (YEAR / bps) / num(lin.duration.height); rateNote = `${amt} per ${lin.duration.height} blocks at ${bps.toFixed(2)}s/block (measured over 20k blocks)`; } else rateNote = 'duration in blocks and the block time could not be measured'; } }
    else if (er && er.paused !== undefined) rateNote = 'paused'; else if (er && er.immediate !== undefined) rateNote = 'immediate (one-off)';
    const pr = dn ? findPrice(dn, r.symbol, ctx) : null; const price = pr ? pr.price : null;
    // 1.2.1: the epoch's dates as ISO — the contract writes {at_time: <ns>} (this version) or {time|height}; a height stays a height
    const when = (x) => { if (!x) return null; const ns = x.at_time != null ? x.at_time : x.time != null ? x.time : null; if (ns != null) { const n = num(ns); return n != null ? new Date(n > 1e14 ? n / 1e6 : n * 1000).toISOString() : null; } return x.at_height != null ? 'height ' + x.at_height : x.height != null ? 'height ' + x.height : null; };
    const row = { id: d.id, denom: dn, symbol: r.symbol, decimals: dec, emission_per_year: perYear, rate_note: rateNote, funded_amount: d.funded_amount != null ? num(d.funded_amount) / Math.pow(10, dec) : null, ends_at: when(d.active_epoch && d.active_epoch.ends_at), started_at: when(d.active_epoch && d.active_epoch.started_at), continuous: lin ? !!lin.continuous : null, price_usd: price, price_source: pr ? `network-and-prices (${pr.source}, matched by ${pr.match})` : null,
      per_token_per_year: perYear != null && staked ? perYear / staked : null, per_token_usd_per_year: null, raw: d };
    row.per_token_usd_per_year = row.per_token_per_year != null && row.price_usd != null ? row.per_token_per_year * row.price_usd : null;
    out.distributions.push(row);
  }
  const usdPerToken = out.distributions.reduce((t, r) => r.per_token_usd_per_year != null ? (t == null ? 0 : t) + r.per_token_usd_per_year : t, null);
  const an = slug ? ctx.nftAnalytics[slug] : null; const floors = an && an.listings_by_marketplace ? Object.values(an.listings_by_marketplace).map(m => num(m.floor_usd)).filter(v => v != null && v > 0) : []; const floor = floors.length ? Math.min(...floors) : null;
  out.apr = { usd_per_token_per_year: usdPerToken, floor_usd: floor, apr_pct_at_floor: usdPerToken != null && floor ? usdPerToken / floor * 100 : null, floor_source: floor != null ? `nft-collections/${slug} nft-analytics listings_by_marketplace (lowest venue floor, USD at today's prices)` : 'no listing floor in nft-analytics', note: 'Σ over distributions of (rate per year ÷ staked count × price) ÷ floor; a distribution whose rate did not parse contributes nothing and says so on its row', unpriced: out.distributions.filter(r => r.per_token_per_year != null && r.price_usd == null).map(r => r.symbol || r.denom) };
  for (const a of Object.keys(ctx.tenant.wallets)) { const p = await smartQ({ pending_rewards: { address: a, limit: 50 } }); if (!p || !Array.isArray(p.pending_rewards)) { out.pending_by_wallet[a] = null; continue; } out.pending_by_wallet[a] = p.pending_rewards.map(x => { const dn = x.denom && (x.denom.native || x.denom.cw20) || null; const r = dn ? symOf(dn) : { symbol: null, decimals: 6 }; const dec = r.decimals != null ? r.decimals : 6; const amt = num(x.pending_rewards) != null ? num(x.pending_rewards) / Math.pow(10, dec) : null; const pr2 = dn ? findPrice(dn, r.symbol, ctx) : null; return { id: x.id, denom: dn, symbol: r.symbol, amount: amt, usd: amt != null && pr2 ? amt * pr2.price : null, raw: x }; }); }
  return out;
}

// ---------------------------------------------------------------- roll-up
function rollup(wallets, extras) {
  const byRole = {}; const parts = [];
  const add = (role, k, v) => { const r = byRole[role] = byRole[role] || {}; if (Number.isFinite(v)) r[k] = (r[k] || 0) + v; else if (r[k] === undefined) r[k] = null; };
  for (const w of Object.values(wallets)) {
    const s = w.portfolio && w.portfolio.summary || {};
    const bal = w.balances ? sum(w.balances.map(b => b.usd_value)) : null;
    const lps = (w.portfolio && w.portfolio.lp_positions) || [];
    const tlaStaked = lps.length ? sum(lps.filter(l => l.source !== 'asset_compounder').map(l => l.estimated_position_usd)) : (w.portfolio && w.portfolio.summary ? 0 : null);
    const compounder = lps.length ? sum(lps.filter(l => l.source === 'asset_compounder').map(l => l.estimated_position_usd)) : (w.portfolio && w.portfolio.summary ? 0 : null);
    const locked = s.total_locked_usd == null ? null : s.total_locked_usd;
    const tla = sum([s.total_lp_position_usd, s.total_locked_usd]);
    const pend = sum([s.total_pending_rewards_usd, s.total_pending_bribes_usd, w.portfolio && w.portfolio.pending_rebase ? w.portfolio.pending_rebase.usd_value : null]);
    const deleg = w.delegations ? w.delegations.usd_value : null; const votion = w.votion ? w.votion.usd_value : null;
    const cr = w.credia || null; const crCol = cr ? cr.collateral_usd : null; const crDebt = cr ? cr.debt_usd : null;
    const receipts = w.balances ? w.balances.filter(b => b.held_as).length : null;
    w.totals = { balances_usd: bal, tla_usd: tla, tla_staked_usd: tlaStaked, tla_compounder_usd: compounder, tla_locked_usd: locked, tla_pending_usd: pend, delegations_usd: deleg, votion_usd: votion,
      credia_collateral_usd: crCol, credia_debt_usd: crDebt, credia_net_usd: cr ? cr.net_usd : null,
      known_usd: sum([bal, tla, deleg, votion, crCol]), liabilities_usd: crDebt,
      unpriced_rows: w.balances ? w.balances.filter(b => b.usd_value == null && !b.held_as).length : null, receipt_rows: receipts };
    for (const [k, v] of Object.entries(w.totals)) if (!['unpriced_rows', 'receipt_rows'].includes(k)) { add(w.role, k, v); add('all', k, v); }
  }
  const vc = extras.validator && extras.validator.commission_unclaimed_usd;
  return { by_role: byRole, dao: Object.assign({}, byRole.all, { validator_commission_unclaimed_usd: vc == null ? null : vc, credia_note: 'collateral counted in known_usd; debt in liabilities_usd; net when both read (1.1.0)' }),
    bases: { tokens: "network-and-prices final_price_usd — by the row's denom first, catalog symbol second (price_key on the row)", tla: 'capture-engine post-take at pool prices (staked non-amp + ampCAPA = tla_staked; compounder receipts = tla_compounder; locks = tla_locked)', luna: 'LUNA at network-and-prices', credia: 'receipt balance × supply_index priced by our feed; debt = borrows × borrow_index', receipts: 'compounder / Credia receipt balances are labeled held_as and valued in their section, never in balances' } };
}
// 1.1.0 — ours vs theirs per SECTION. Their dapp keys map onto our sections; a wallet total can hide two errors cancelling
// (2026-09-21: ours was short $29.7k of balances + $10.2k Credia on Ryan, theirs short $38.6k on five compounder receipts
// it priced at $0 — net −1.0 %). Sections make each side's blind spot its own row.
const SECTION_MAP = { balances: ['balances', 'cw20', 'astroport', 'skeleton-swap'], tla: ['tla'], compounder: ['tla-compounder'], locks: ['tla-locks'], credia: ['creda', 'credia'], votion: ['votion'] };
function reconcile(wallets, fixture, referenceAsOf) {
  if (!fixture) return null;
  // phoenix.money backend shape: { value, portfolios: [{ address, info, value, dappPortfolios: [{ dapp, value, positions: [...] }] }] }
  const theirs = {}; const theirsByDapp = {}; const theirsZeroRows = {}; try {
    for (const x of (fixture.portfolios || [])) { if (!x.address) continue; theirs[x.address] = num(x.value); theirsByDapp[x.address] = Object.fromEntries((x.dappPortfolios || []).map(d => [d.dapp, num(d.value)]));
      theirsZeroRows[x.address] = (x.dappPortfolios || []).flatMap(d => (d.positions || []).filter(p => num(p.amount) > 0 && !(num(p.value) > 0)).map(p => ({ dapp: d.dapp, display: p.display, amount: num(p.amount) }))); }
  } catch (e) {}
  const oursSection = (w) => ({ balances: w.totals.balances_usd, tla: w.totals.tla_staked_usd, compounder: w.totals.tla_compounder_usd, locks: w.totals.tla_locked_usd, credia: w.totals.credia_collateral_usd, votion: w.totals.votion_usd });
  const theirsSection = (a) => { const d = theirsByDapp[a]; if (!d) return null; const o = {}; for (const [sec, keys] of Object.entries(SECTION_MAP)) { const vals = keys.filter(k => k in d).map(k => d[k]); o[sec] = vals.length ? sum(vals) : null; } return o; };
  const rows = Object.entries(wallets).map(([a, w]) => { const o = oursSection(w), t = theirsSection(a); const sections = {}; for (const sec of Object.keys(SECTION_MAP)) { const ov = o[sec], tv = t ? t[sec] : null; sections[sec] = { ours_usd: ov, theirs_usd: tv, delta_usd: ov != null && tv != null ? ov - tv : null }; }
    return { address: a, label: w.label, ours_known_usd: w.totals.known_usd, ours_balances_usd: w.totals.balances_usd, ours_tla_usd: w.totals.tla_usd, theirs_usd: theirs[a] == null ? null : theirs[a], theirs_by_dapp: theirsByDapp[a] || null, delta_usd: theirs[a] != null && w.totals.known_usd != null ? w.totals.known_usd - theirs[a] : null, sections, theirs_amount_but_zero_value: theirsZeroRows[a] && theirsZeroRows[a].length ? theirsZeroRows[a] : [] }; });
  const bySection = {}; for (const sec of Object.keys(SECTION_MAP)) { const ov = sum(rows.map(r => r.sections[sec].ours_usd)), tv = sum(rows.map(r => r.sections[sec].theirs_usd)); bySection[sec] = { ours_usd: ov, theirs_usd: tv, delta_usd: ov != null && tv != null ? ov - tv : null }; }
  return { reference: 'phoenix.money portfolio fixture (docs/fixtures)', reference_as_of: referenceAsOf || null, theirs_total_usd: num(fixture.value), ours_total_known_usd: sum(Object.values(wallets).map(w => w.totals.known_usd)), by_section: bySection, rows,
    note: 'per section: their dapp keys mapped onto ours (balances = balances+cw20+astroport+skeleton-swap; credia = their collateral rows, no debt). theirs_amount_but_zero_value lists their own unpriced rows. The fixture is a dated capture (reference_as_of) — balances move after it; a delta is a question, not an error' };
}

// ---------------------------------------------------------------- github
function gh(method, apiPath, body) { return new Promise((resolve, reject) => { const req = https.request({ hostname: 'api.github.com', path: apiPath, method, headers: { 'Authorization': `Bearer ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github+json', 'User-Agent': 'positions-cron', 'Content-Type': 'application/json' } }, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => { if (res.statusCode >= 200 && res.statusCode < 300) resolve(d ? JSON.parse(d) : {}); else reject(Object.assign(new Error(`GitHub ${method} ${apiPath} → ${res.statusCode}: ${d.slice(0, 200)}`), { status: res.statusCode })); }); }); req.on('error', reject); if (body) req.write(JSON.stringify(body)); req.end(); }); }
async function publish(filePath, content, message) {
  const apiPath = `/repos/${GITHUB_REPO}/contents/${filePath}`;
  for (let attempt = 1; attempt <= 4; attempt++) {
    let sha = null; try { const ex = await gh('GET', apiPath + `?ref=${GITHUB_BRANCH}`); sha = ex.sha; if (Buffer.from(ex.content || '', 'base64').toString() === content) return 'unchanged'; } catch (e) { if (e.status !== 404) throw e; }
    try { await gh('PUT', apiPath, Object.assign({ message, content: Buffer.from(content).toString('base64'), branch: GITHUB_BRANCH }, sha ? { sha } : {})); return sha ? 'updated' : 'created'; }
    catch (e) { if ([409, 422].includes(e.status) || e.status >= 500) { await new Promise(r => setTimeout(r, 400 * attempt + Math.random() * 300)); continue; } throw e; }
  }
  throw new Error('publish gave up: ' + filePath);
}

// ---------------------------------------------------------------- run
async function loadContext() {
  const [tenantsDoc, catalog, votionVaults, crediaSnap] = await Promise.all([
    E.fetchJson(CORE + 'docs/curated/tenants.json', 'tenants'),
    E.fetchJson(CORE + 'token-catalog/snapshots/current.json', 'token-catalog').catch(() => null),
    E.fetchJson(CORE + 'votion/snapshots/vaults.json', 'votion-vaults').catch(() => null),
    E.fetchJson(CORE + 'dex-data/credia/snapshots/current.json', 'credia-markets').catch(() => null),
  ]);
  const t = tenantsDoc.tenants && tenantsDoc.tenants[TENANT]; if (!t) throw new Error(`tenant ${TENANT} not in tenants.json`);
  if (!t.wallets || !Object.keys(t.wallets).length) throw new Error(`tenant ${TENANT} has no wallets in tenants.json`);
  const ctx = await E.loadSharedData();   // tla-snapshot + network-and-prices; throws if either is missing (never a half run)
  const resolve = buildResolver(catalog || []);
  ctx.resolve = (d) => { const r = resolve(d); return r && r.symbol ? { symbol: r.symbol, decimals: r.decimals } : { symbol: null, decimals: 6, reason: (r && r.reason) || 'not_in_token_catalog' }; };
  ctx.cw20s = ((catalog && catalog.tokens) || []).filter(x => x.kind === 'cw20' || /^terra1[0-9a-z]{58}$/.test(String(x.denom).replace('cw20:', ''))).map(x => { const d = String(x.denom).replace('cw20:', ''); const r = ctx.resolve(d); return { denom: d, symbol: r.symbol, decimals: r.decimals, symbol_source: 'token-catalog' }; });
  // 1.1.0 — cw20s the catalog does not carry, from the tenant's registry (pyROAR on the DAO treasury, …): { denom, symbol, decimals }
  for (const k of (t.known_cw20s || [])) { if (!k || !k.denom || ctx.cw20s.some(c => c.denom === k.denom)) continue; ctx.cw20s.push({ denom: k.denom, symbol: k.symbol || null, decimals: k.decimals != null ? k.decimals : 6, symbol_source: 'tenants.json known_cw20s' }); }
  // 1.1.0 — the feed indexed by DENOM (every registry entry with a phoenix-1 market carries its address; CG-only entries carry none)
  ctx.priceByDenom = new Map();
  for (const [key, e] of Object.entries(ctx.tokenPrices || {})) { const p = num(e && e.final_price_usd); if (p == null) continue; const addrs = new Set(); if (e.denom) addrs.add(e.denom); /* 3.1.1 root denom (present on CG-only entries too) */ for (const s of Object.values((e && e.prices) || {})) { if (!s || typeof s !== 'object') continue; if (s.address) addrs.add(s.address); const ac = s.all_chains && s.all_chains['phoenix-1']; if (ac && ac.address) addrs.add(ac.address); } for (const a of addrs) if (!ctx.priceByDenom.has(a)) ctx.priceByDenom.set(a, { price: p, source: e.final_source || 'network-and-prices', key }); }
  // 1.1.0 — Credia markets (denom, indices, receipt token) from the dex-data product; the receipt denoms are what balances must not price
  ctx.crediaMarkets = crediaSnap && Array.isArray(crediaSnap.pools) ? crediaSnap.pools.map(p => { const raw = p.raw || {}, st = raw.state || {}; const denom = (p.assets && p.assets[0] && p.assets[0].denom) || assetDenom(raw.info) || null; const r = denom ? ctx.resolve(denom) : { symbol: null, decimals: 6 }; return { denom, symbol: r.symbol, decimals: r.decimals != null ? r.decimals : 6, vproxy: raw.vproxy_addr || st.vproxy_addr || null, proxy: raw.proxy_addr || st.proxy_addr || null, supply_index: num(raw.supply_index || st.supply_index) || 1, borrow_index: num(raw.borrow_index || st.borrow_index) || 1, credia_price_usd: num(raw.credia_price_usd) }; }).filter(m => m.denom) : null;
  ctx.crediaReceiptDenoms = new Set((ctx.crediaMarkets || []).flatMap(m => [m.vproxy, m.proxy].filter(Boolean)));
  ctx.crediaAsOf = crediaSnap && crediaSnap.meta ? (crediaSnap.meta.captured_at || crediaSnap.meta.generated_at || null) : null;
  ctx.validator = t.validator && t.validator.operator || null;
  ctx.validatorAccount = t.validator && t.validator.account || null;
  ctx.votionVaults = votionVaults;
  ctx.nftSummaries = {};
  ctx.nftAnalytics = {};
  await Promise.all((t.collections || []).map(async (slug) => { ctx.nftSummaries[slug] = await E.fetchJson(NFTC + slug + '/snapshots/summary.json', 'nft-summary ' + slug).catch(() => null); ctx.nftAnalytics[slug] = await E.fetchJson(NFTC + slug + '/snapshots/nft-analytics.json', 'nft-analytics ' + slug).catch(() => null); }));   // 1.2.0: analytics for the listing floor (APR denominator)
  ctx.tenant = t; ctx.tenantSlug = TENANT; ctx.outRoot = OUT_ROOT || ((t.daos || [])[0] || TENANT);
  ctx.gate0 = t.gate0_reference ? await E.fetchJson(CORE + t.gate0_reference, 'gate0-reference').catch(() => null) : null;
  ctx.gate0AsOf = t.gate0_reference_as_of || ((String(t.gate0_reference || '').match(/(\d{4}-\d{2}-\d{2})/) || [])[1]) || null;   // 1.1.0: the fixture is dated by its folder
  return ctx;
}
async function captureWallet(address, w, ctx) {
  const [portfolio, balances, delegations, credia] = await Promise.all([
    w.counts_as === 'validator' ? Promise.resolve({ wallet: address, _errors: [], summary: null, skipped: 'validator account: no TLA capture' }) : E.fetchMemberPortfolio({ address, name: w.label }, ctx).catch(e => ({ _errors: ['engine: ' + e.message], summary: null })),
    readBalances(address, ctx).catch(e => null),
    readDelegations(address, ctx).catch(e => null),
    readCredia(address, ctx).catch(e => ({ collateral: null, debt: null, collateral_usd: null, debt_usd: null, net_usd: null, error: 'credia reader: ' + e.message })),
  ]);
  return { address, label: w.label, role: w.role, counts_as: w.counts_as, portfolio, balances, delegations, votion: readVotion(address, ctx), nfts: readNfts(address, ctx), credia };
}
async function run(opts = {}) {
  const ctx = opts.ctx || await loadContext();
  const t = ctx.tenant; const startedAt = new Date().toISOString();
  console.log(`🦁 positions ${VERSION} — tenant ${TENANT}, ${Object.keys(t.wallets).length} wallets → ${GITHUB_REPO}/${ctx.outRoot}/positions/`);
  const wallets = {};
  await E.parallelMap(Object.entries(t.wallets), async ([a, w]) => { wallets[a] = await captureWallet(a, w, ctx); console.log(`  ✓ ${w.label}`); }, 2);
  if (ctx.validatorAccount && !wallets[ctx.validatorAccount]) wallets[ctx.validatorAccount] = await captureWallet(ctx.validatorAccount, { label: 'validator account', role: 'validator', counts_as: 'validator' }, ctx);
  const validator = await readValidatorCommission(ctx).catch(() => null);
  const pl_rewards = await readPlRewards(ctx).catch(e => ({ distributor: (ctx.tenant.staking || {}).pl_rewards_distributor || null, reason: 'reader threw: ' + e.message }));   // 1.2.0
  const roll = rollup(wallets, { validator });
  const fixture = opts.fixture || ctx.gate0 || null;
  const doc = { schemaVersion: 1, product: `${ctx.outRoot}/positions`, engine: VERSION, tenant: TENANT, capturedAt: new Date().toISOString(), startedAt,
    prices: { luna_usd: ctx.lunaPriceUsd, source: 'network-and-prices', captured_at: ctx.networkPrices && ctx.networkPrices.capturedAt || null },
    validator, pl_rewards, wallets, rollup: roll, reconciliation: reconcile(wallets, fixture, opts.referenceAsOf || ctx.gate0AsOf || null),
    sources: { credia_markets_as_of: ctx.crediaAsOf || null, credia_markets: ctx.crediaMarkets ? ctx.crediaMarkets.length : null, feed_denoms_indexed: ctx.priceByDenom ? ctx.priceByDenom.size : null, known_cw20s: (t.known_cw20s || []).length },
    errors: Object.values(wallets).flatMap(w => (w.portfolio && w.portfolio._errors || []).map(e => ({ wallet: w.label, error: e }))) };
  return doc;
}
// 1.1.1 — one row per day for the charts (never-shrink: an existing day is overwritten by the same day only, never dropped)
function seriesRow(doc) {
  const R = doc.rollup && doc.rollup.dao || {}; const W = doc.wallets || {};
  const vp = sum(Object.keys(W).map(a => { const s = W[a].portfolio && W[a].portfolio.summary; return s ? s.voting_power_human : null; }));
  const roar = Object.keys(W).map(a => (W[a].balances || []).find(b => b.symbol === 'ROAR')).find(Boolean);
  const rc = doc.reconciliation;
  return { capturedAt: doc.capturedAt, engine: doc.engine, known_usd: R.known_usd, liabilities_usd: R.liabilities_usd == null ? null : R.liabilities_usd,
    by_section: { balances_usd: R.balances_usd, tla_staked_usd: R.tla_staked_usd, tla_compounder_usd: R.tla_compounder_usd, tla_locked_usd: R.tla_locked_usd, tla_pending_usd: R.tla_pending_usd, delegations_usd: R.delegations_usd, credia_collateral_usd: R.credia_collateral_usd, credia_debt_usd: R.credia_debt_usd, votion_usd: R.votion_usd },
    by_wallet: Object.fromEntries(Object.keys(W).map(a => [a, W[a].totals ? W[a].totals.known_usd : null])), vp,
    prices: { luna_usd: doc.prices ? doc.prices.luna_usd : null, roar_usd: roar ? roar.price_usd : null },
    validator_commission_luna: doc.validator ? doc.validator.commission_unclaimed_luna : null,
    recon_delta_usd: rc && num(rc.ours_total_known_usd) != null && num(rc.theirs_total_usd) != null ? rc.ours_total_known_usd - rc.theirs_total_usd : null };
}
function mergeSeries(existing, d, row, product) {
  const s = existing && existing.days ? JSON.parse(JSON.stringify(existing)) : { product: product + '/daily', engine: VERSION, note: 'one row per archived day — known value, liabilities, by section, by wallet, VP, prices, validator commission, gate-#0 delta; the pages chart THIS, never the daily files. Never-shrink: a day is overwritten only by that same day.', days: {} };
  s.engine = VERSION; s.days[d] = row; s.updatedAt = row.capturedAt; s.day_count = Object.keys(s.days).length;
  const sorted = {}; Object.keys(s.days).sort().forEach(k => { sorted[k] = s.days[k]; }); s.days = sorted;
  return s;
}
async function readJson(filePath) { try { const ex = await gh('GET', `/repos/${GITHUB_REPO}/contents/${filePath}?ref=${GITHUB_BRANCH}`); return JSON.parse(Buffer.from(ex.content || '', 'base64').toString()); } catch (e) { if (e.status === 404) return null; throw e; } }
// ---------------------------------------------------------------- 1.2.2: the holders duty, folded in (owner: one job per ally)
//   After the hourly positions run, if <dao>/holders-heartbeat.json is missing or its capturedAt is ≥ HOLDERS_EVERY_H (20) hours
//   old, run holders.js in-process (pyROAR ledger walk + ROAR20 owners). A failed holders run never fails the positions run.
//   HOLDERS=off disables it. Heartbeat + products are the same files as before.
async function holdersDue(outRoot) {
  if (process.env.HOLDERS === 'off') return { due: false, why: 'HOLDERS=off' };
  const everyH = Number(process.env.HOLDERS_EVERY_H) || 20;
  const hb = await E.fetchJson(`https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_BRANCH}/${outRoot}/holders-heartbeat.json?t=${Date.now()}`, 'holders-heartbeat').catch(() => null);
  if (!hb || !hb.capturedAt) return { due: true, why: 'no holders heartbeat yet' };
  const ageH = (Date.now() - Date.parse(hb.capturedAt)) / 3600e3; return ageH >= everyH ? { due: true, why: `holders ${ageH.toFixed(1)} h old` } : { due: false, why: `holders ${ageH.toFixed(1)} h old (< ${everyH} h)` };
}
// 1.2.3: the duty as a function main() calls with the positions root ('<dao>/positions') — testable on its own
async function runHoldersIfDue(root) {
  try { const due = await holdersDue(root.replace(/\/positions$/, '')); if (due.due) { console.log(`🦁 holders (${due.why}) — walking the pyROAR ledger + ROAR20 owners…`); const H = require('./holders.js'); const hhb = await H.main(); console.log(`  holders → ${hhb.status}${hhb.errors.length ? ' · ' + hhb.errors.map(e => e.product + ': ' + e.reason).join(' · ') : ''}`); return hhb; } console.log(`  holders: not due (${due.why})`); return null; }
  catch (e) { console.error('  ✗ holders duty threw (positions run unaffected): ' + e.message); return null; }
}
// 1.3.0: ROAR20's market, every run (tenants.json <tenant>.roar20 — a tenant without one skips)
// 1.4.0: the series that power the trends (history-forward.js) — a failure never fails the positions run
async function runHistoryForward(root, roar20Market) {
  if (process.env.HISTORY_FORWARD === 'off') return null;
  try { const tenantsDoc = await E.fetchJson(CORE + 'docs/curated/tenants.json', 'tenants'); const t = tenantsDoc.tenants && tenantsDoc.tenants[TENANT]; if (!t) return null;
    const H = require('./history-forward.js'); return await H.run({ tenant: t, tenantSlug: TENANT, outRoot: root.replace(/\/positions$/, ''), publish, readJson, roar20Market, log: (m) => console.log(m) }); }
  catch (e) { console.error('  ✗ history forward threw (positions run unaffected): ' + e.message); return null; }
}
async function runRoar20Market(root) {
  if (process.env.ROAR20_MARKET === 'off') return null;
  try { const tenantsDoc = await E.fetchJson(CORE + 'docs/curated/tenants.json', 'tenants'); const t = tenantsDoc.tenants && tenantsDoc.tenants[TENANT]; if (!t || !t.roar20) return null;
    const M = require('./roar20-market.js'); return await M.run({ tenant: t, tenantSlug: TENANT, outRoot: root.replace(/\/positions$/, ''), publish, readJson, log: (m) => console.log(m) }); }
  catch (e) { console.error('  ✗ roar20 market threw (positions run unaffected): ' + e.message); return null; }
}
async function main() {
  const doc = await run();
  const content = JSON.stringify(doc, null, 1); const d = day();
  const root = `${doc.product}`;
  const hb = JSON.stringify({ product: root, engine: VERSION, status: doc.errors.length ? 'ok_with_errors' : 'ok', capturedAt: doc.capturedAt, wallets: Object.keys(doc.wallets).length, known_usd: doc.rollup.dao.known_usd, errors: doc.errors.length }, null, 1);
  if (!GITHUB_TOKEN) { fs.mkdirSync('out', { recursive: true }); fs.writeFileSync('out/current.json', content); fs.writeFileSync('out/heartbeat.json', hb); console.log('⚠️  GITHUB_TOKEN not set — wrote out/'); return; }
  console.log(`  current.json → ${await publish(`${root}/current.json`, content, `🦁 ${TENANT} positions ${doc.capturedAt}`)}`);
  console.log(`  daily/${d}.json → ${await publish(`${root}/daily/${d}.json`, content, `📸 ${TENANT} positions daily — ${d}`)}`);
  const series = mergeSeries(await readJson(`${root}/daily/index.json`), d, seriesRow(doc), root);
  console.log(`  daily/index.json (${series.day_count} days) → ${await publish(`${root}/daily/index.json`, JSON.stringify(series, null, 1), `📈 ${TENANT} positions series — ${d}`)}`);
  console.log(`  heartbeat → ${await publish(`${root}/heartbeat.json`, hb, `💓 ${TENANT} positions heartbeat`)}`);
  const r20 = await runRoar20Market(root);   // 1.3.0 — before the holders walk, so a long walk never delays the price
  await runHistoryForward(root, r20);   // 1.4.0 — the daily chain series + today's market row
  await runHoldersIfDue(root);   // 1.2.3

}
module.exports = { VERSION, run, main, runHoldersIfDue, runRoar20Market, runHistoryForward, loadContext, readPlRewards, holdersDue, captureWallet, readBalances, readDelegations, readValidatorCommission, readVotion, readNfts, readCredia, rollup, reconcile, priceRow, findPrice, receiptKind, assetDenom, SECTION_MAP, seriesRow, mergeSeries };
if (require.main === module) main().catch(e => { console.error('✗', e); process.exit(1); });
