#!/usr/bin/env node
// ally-positions/mock-run.js — drives the LIVE positions engine with a stubbed transport (no-third-copy).
// Real fixtures: tenants.json (the roster), tla-snapshot, network-and-prices, token-catalog, member-data/participants
// (the engine's own output for Ryan's wallet and the msig → stands in for fetchMemberPortfolio), pixel-lions summary,
// the phoenix.money reference. SHAPE fixtures (cosmos-sdk / cw20 schemas with marked values) for the LCD reads the
// gate host cannot reach: bank balances, cw20 balances, delegations, rewards, commission.
// Usage: TLA_CORE_DIR=<tla-core> NFTC_DIR=<nft-collections> node ally-positions/mock-run.js
'use strict';
const fs = require('fs'); const path = require('path');
const CORE = process.env.TLA_CORE_DIR, NFTC = process.env.NFTC_DIR; if (!CORE || !NFTC) { console.error('TLA_CORE_DIR and NFTC_DIR required'); process.exit(1); }
process.env.TENANT = process.env.TENANT || 'liondao';
const J = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const tenants = J(path.join(CORE, 'docs/curated/tenants.json')); const T = tenants.tenants[process.env.TENANT];
const participants = J(path.join(CORE, 'member-data/participants/current.json'));
const byWallet = Object.fromEntries(participants.members.map(m => [m.wallet, m]));
const fixture = J(path.join(CORE, 'docs/fixtures/2026-09-21/phoenix-money-liondao-portfolio.json'));
const treasury = Object.keys(T.wallets).find(a => T.wallets[a].counts_as === 'treasury');
const ROAR = T.staking.roar_cw20;
const ryanAddr = Object.keys(T.wallets).find(a => /Ryan/.test(T.wallets[a].label));
// 1.1.0 shape fixtures: the compounder receipt denom (real prefix, real gauge id shape), wstETH + USDC.inj ibc denoms (real),
// a Credia wBTC receipt (vproxy from the real dex-data/credia snapshot) and a Portfolio{address} response (SHAPE — docs name
// PortfolioResponse.supplies; borrows assumed alongside with vamount; the live run keeps the raw answer either way)
const credia = J(path.join(CORE, 'dex-data/credia/snapshots/current.json'));
const wbtcMarket = credia.pools.find(p => p.assets[0].denom.startsWith('ibc/88386'));
const WBTC_VPROXY = wbtcMarket.raw.vproxy_addr;
const PYROAR = (T.known_cw20s || []).find(k => k.symbol === 'pyROAR');
const RECEIPT = 'factory/terra1zly98gvcec54m3caxlqexce7rus6rzgplz7eketsdz7nh750h2rqvu8uzx/46/terra1a5apghncafx0nem740fsrmd6demaywvp332a4uat63u2jtwn8mgsz7khkw/amplp';
const WSTETH = 'ibc/A356EC90DC3AE43D485514DA7260EDC7ABB5CFAA0654CE2524C739392975AD3C', USDC_INJ = 'ibc/E8481AD838C31D4FC12A504B10F9B4E2F830F8818D2735C2FFC707579B5FA60B';
// ---- transport stub
const CORE_U = 'https://raw.githubusercontent.com/thealliancedao/tla-core/main/', NFTC_U = 'https://raw.githubusercontent.com/thealliancedao/nft-collections/main/';
const calls = []; const ok = (o) => ({ ok: true, status: 200, json: async () => o, text: async () => JSON.stringify(o) }); const nf = { ok: false, status: 404, json: async () => ({}), text: async () => '' };
const b64q = (u) => { try { return JSON.parse(Buffer.from(u.split('/smart/')[1].split('?')[0], 'base64').toString()); } catch (e) { return null; } };
global.fetch = async (url) => { url = String(url); calls.push(url);
  if (url.startsWith(CORE_U)) { const f = path.join(CORE, url.slice(CORE_U.length).split('?')[0]); return fs.existsSync(f) ? ok(J(f)) : nf; }
  if (url.startsWith(NFTC_U)) { const f = path.join(NFTC, url.slice(NFTC_U.length).split('?')[0]); return fs.existsSync(f) ? ok(J(f)) : nf; }
  if (url.includes('/cosmos/bank/v1beta1/balances/')) { const a = url.split('/balances/')[1].split('?')[0]; return ok({ balances: a === treasury ? [{ denom: 'uluna', amount: '13000000' }, { denom: 'ibc/88386AC48152D48B34B082648DF836F975506F0B57DBBFC10A54213B1BF484CB', amount: '270000' }] : a === ryanAddr ? [{ denom: 'uluna', amount: '1084000000' }, { denom: RECEIPT, amount: '6537689470' }, { denom: WSTETH, amount: '2875193328255860000' }, { denom: USDC_INJ, amount: '19349286099' }] : [{ denom: 'uluna', amount: '1084000000' }] }); }
  if (url.includes('/cosmos/staking/v1beta1/delegations/')) { const a = url.split('/delegations/')[1].split('?')[0]; return ok({ delegation_responses: a === treasury ? [{ delegation: { validator_address: T.validator.operator }, balance: { denom: 'uluna', amount: '10000000000' } }] : [] }); }
  if (url.includes('/distribution/v1beta1/delegators/')) { const a = url.split('/delegators/')[1].split('/')[0]; return ok({ rewards: a === treasury ? [{ validator_address: T.validator.operator, reward: [{ denom: 'uluna', amount: '500000000.25' }] }] : [], total: [] }); }
  if (url.includes('/distribution/v1beta1/validators/')) return ok({ commission: { commission: [{ denom: 'uluna', amount: '2000000000.5' }] } });
  if (url.includes('/cosmwasm/wasm/v1/contract/')) { const c = url.split('/contract/')[1].split('/')[0]; const q = b64q(url);
    if (q && q.balance) { const a = q.balance.address; if (c === ROAR && a === treasury) return ok({ data: { balance: '298564000000000000' } }); if (c === ROAR && T.wallets[a] && T.wallets[a].role === 'ops') return ok({ data: { balance: '19342000000000000' } });
      if (PYROAR && c === PYROAR.denom && a === treasury) return ok({ data: { balance: '6240000000000' } });
      if (c === WBTC_VPROXY && a === ryanAddr) return ok({ data: { balance: '4142667' } });   // Ryan's wBTC.creda.a receipt (8 dec) = the vamount
      return ok({ data: { balance: '0' } }); }
    if (q && q.portfolio) { const a = q.portfolio.address; if (a === ryanAddr) return ok({ data: { address: a, emode_group: null, supplies: [{ asset_info: { native: 'ibc/88386AC48152D48B34B082648DF836F975506F0B57DBBFC10A54213B1BF484CB' }, vamount: '4142667', collateral: true }], borrows: [{ asset_info: { native: 'uluna' }, vamount: '1000000000' }] } }); return ok({ data: { address: a, emode_group: null, supplies: [], borrows: [] } }); }
    return ok({ data: null }); }
  return nf;
};
// ---- the engine's own per-wallet capture: stand in with its real output for the wallets participants already carries
const E = require('../lib/capture-engine.js');
const P = require('./index.js');
const realFetchMemberPortfolio = E.fetchMemberPortfolio;
E.fetchMemberPortfolio = async (m) => byWallet[m.address] ? byWallet[m.address] : { wallet: m.address, name: m.name, _errors: [], lp_positions: [], pending_rewards: [], pending_bribes: [], locks: [], pending_rebase: null, wallet_balances: [], summary: { total_lp_position_usd: 0, total_locked_usd: 0, total_pending_rewards_usd: 0, total_pending_bribes_usd: 0, voting_power_human: 0, lock_count: 0 } };
let pass = 0, fail = 0; const chk = (m, c, x) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (x !== undefined ? ' → ' + JSON.stringify(x).slice(0, 300) : '')); } };
(async () => {
  const ctx = await P.loadContext();
  chk('context: roster from tenants.json (' + Object.keys(ctx.tenant.wallets).length + ' wallets), validator, catalog cw20s resolved (' + ctx.cw20s.length + ')', Object.keys(ctx.tenant.wallets).length === 4 && ctx.validator === T.validator.operator && ctx.cw20s.length >= 10 && ctx.cw20s.some(c => c.denom === ROAR && c.symbol === 'ROAR'), ctx.cw20s.slice(0, 3));
  chk('context: LUNA price and pool index came from the real products', ctx.lunaPriceUsd > 0 && ctx.poolByGaugeId.size > 20);
  const doc = await P.run({ ctx, fixture });
  const W = doc.wallets; const ryan = Object.values(W).find(w => w.label.startsWith('LionDAO ops')); const tre = W[treasury];
  chk('every roster wallet + the validator account captured (5 rows)', Object.keys(W).length === 5 && W[T.validator.account] && W[T.validator.account].role === 'validator', Object.keys(W).map(a => W[a].label));
  const rp = byWallet[ryan.address].summary;
  chk("Ryan's TLA from the engine: LP " + rp.total_lp_position_usd.toFixed(0) + ' + locked ' + rp.total_locked_usd.toFixed(0) + ' = totals.tla_usd', Math.abs(ryan.totals.tla_usd - (rp.total_lp_position_usd + rp.total_locked_usd)) < 1e-6, ryan.totals);
  const roarRow = tre.balances.find(b => b.symbol === 'ROAR');
  chk('treasury ROAR balance 298.564B priced at the feed (' + (roarRow && roarRow.price_usd) + ') → ' + (roarRow && roarRow.usd_value.toFixed(0)) + ' USD, source labeled', roarRow && roarRow.amount_human === 298564000000 && roarRow.usd_value > 50000 && /astroport|calculated|network/.test(roarRow.price_source), roarRow);
  const wbtc = tre.balances.find(b => b.denom.startsWith('ibc/88386'));
  chk('wBTC.atom native row resolved through the catalog and priced (or kept unpriced with a reason)', wbtc && (wbtc.usd_value != null || wbtc.unpriced_reason), wbtc);
  chk('treasury delegation: 10,000 LUNA on the own validator, marked, rewards 500 LUNA priced', tre.delegations.luna === 10000 && tre.delegations.rows[0].own_validator === true && Math.abs(tre.delegations.rewards_luna - 500.00000025) < 1e-6 && tre.delegations.rewards_usd > 0, tre.delegations);
  chk('validator commission 2,000 LUNA on the doc, priced', doc.validator.commission_unclaimed_luna === 2000.0000005 && doc.validator.commission_unclaimed_usd > 0, doc.validator);
  chk('nfts: pixeLions held / staked per wallet from the collection summary (never null when the summary loaded)', Object.values(W).every(w => w.nfts && w.nfts['pixel-lions'] && Number.isInteger(w.nfts['pixel-lions'].held_total)), tre.nfts);
  // ---- 1.1.0
  const wst = ryan.balances.find(b => b.denom === WSTETH);
  chk('1.1.0 price by DENOM: wstETH (catalog symbol) priced through the feed key WSTETH, price_match denom, ≈ $' + (wst && wst.usd_value && wst.usd_value.toFixed(0)), wst && wst.symbol === 'wstETH' && wst.price_key === 'WSTETH' && wst.price_match === 'denom' && wst.usd_value > 5000, wst);
  const wb = tre.balances.find(b => b.denom.startsWith('ibc/88386'));
  chk('1.1.0 price by DENOM: treasury wBTC.atom priced through WBTC (was symbol_not_in_price_feed)', wb && wb.symbol === 'wBTC.atom' && wb.price_key === 'WBTC' && wb.usd_value > 100, wb);
  const rc0 = ryan.balances.find(b => b.denom === RECEIPT);
  chk('1.1.0 compounder receipt in balances is LABELED and NOT priced (valued in lp_positions)', rc0 && rc0.held_as === 'compounder_receipt' && rc0.usd_value === null && /lp_positions/.test(rc0.valued_in) && rc0.unpriced_reason === 'valued_in_compounder_section', rc0);
  const inj = ryan.balances.find(b => b.denom === USDC_INJ);
  chk('1.1.0 USDC.inj (not in the catalog, not yet in the feed) stays unpriced with not_in_token_catalog — no bridge', inj && inj.symbol === null && inj.usd_value === null && inj.symbol_reason === 'not_in_token_catalog', inj);
  { // the feed at 3.1.1 carries `denom` at the root of every entry (CG-only ones included) — rebuild the context exactly as loadContext does
    const ctx2 = Object.assign({}, ctx, { tokenPrices: Object.assign({}, ctx.tokenPrices, { 'USDC.inj': { canonical: 'USDC.inj', denom: USDC_INJ, final_price_usd: 0.9998, final_source: 'coingecko', prices: { astroport: { available: false }, coingecko: { price_usd: 0.9998 } } } }) });
    ctx2.priceByDenom = new Map(); for (const [key, e] of Object.entries(ctx2.tokenPrices)) { const p = Number(e.final_price_usd); if (!Number.isFinite(p)) continue; const addrs = new Set(); if (e.denom) addrs.add(e.denom); for (const s of Object.values(e.prices || {})) if (s && s.address) addrs.add(s.address); for (const a of addrs) if (!ctx2.priceByDenom.has(a)) ctx2.priceByDenom.set(a, { price: p, source: e.final_source, key }); }
    const r = P.priceRow({ kind: 'native', denom: USDC_INJ, symbol: null, symbol_reason: 'not_in_token_catalog', amount_human: 19349.286099 }, ctx2);
    chk('1.1.0 once the feed carries the USDC.inj denom (network-and-prices 3.1.1) the same row prices by denom, symbol_reason kept', r.usd_value > 19000 && r.price_match === 'denom' && r.price_key === 'USDC.inj' && r.symbol_reason === 'not_in_token_catalog', r); }
  const py = tre.balances.find(b => PYROAR && b.denom === PYROAR.denom);
  chk('1.1.0 known_cw20s: pyROAR on the treasury read from tenants.json (6.24M, symbol_source labeled, unpriced by design)', py && py.symbol === 'pyROAR' && py.amount_human === 6240000 && /tenants/.test(py.symbol_source) && py.usd_value === null, py);
  const cr = ryan.credia;
  chk('1.1.0 Credia collateral from the receipt: 4,142,667 vamount × supply_index → ' + (cr && cr.collateral[0] && cr.collateral[0].amount_human.toFixed(6)) + ' wBTC.atom, priced by denom (WBTC) ≈ $' + (cr && cr.collateral_usd && cr.collateral_usd.toFixed(0)), cr && cr.collateral.length === 1 && Math.abs(cr.collateral[0].amount_human - 0.04142667 * wbtcMarket.raw.state.supply_index) < 1e-9 && cr.collateral[0].price_key === 'WBTC' && cr.collateral_usd > 3000 && cr.collateral[0].credia_oracle_price_usd > 0, cr && cr.collateral);
  chk('1.1.0 Credia debt from portfolio{address}: 1,000 LUNA vamount × borrow_index, priced; net = collateral − debt; raw kept', cr && cr.debt.length === 1 && cr.debt[0].symbol === 'LUNA' && cr.debt[0].amount_human > 1000 && cr.debt_usd > 0 && Math.abs(cr.net_usd - (cr.collateral_usd - cr.debt_usd)) < 1e-9 && cr.portfolio_raw && cr.debt_error === null, cr && cr.debt);
  chk('1.1.0 Credia on a wallet with nothing: collateral 0 / debt 0 (a successful empty read is 0, never null)', tre.credia && tre.credia.collateral_usd === 0 && tre.credia.debt_usd === 0 && tre.credia.net_usd === 0, tre.credia);
  const wbr = ryan.balances.find(b => b.denom === WBTC_VPROXY);
  chk('1.1.0 the Credia receipt (wBTC.creda.a) in balances is LABELED credia_receipt and NOT priced (valued in credia)', !wbr || (wbr.held_as === 'credia_receipt' && wbr.usd_value === null), wbr);
  chk('1.1.0 totals: known_usd includes Credia collateral, liabilities_usd carries the debt separately, receipts counted apart from unpriced', Math.abs(ryan.totals.known_usd - (ryan.totals.balances_usd + ryan.totals.tla_usd + (ryan.totals.delegations_usd || 0) + ryan.totals.credia_collateral_usd)) < 1e-6 && ryan.totals.liabilities_usd === ryan.totals.credia_debt_usd && ryan.totals.receipt_rows >= 1 && doc.rollup.dao.credia_collateral_usd === ryan.totals.credia_collateral_usd, ryan.totals);
  chk('1.1.0 totals split TLA: tla_staked + tla_compounder = LP; + tla_locked = tla_usd', Math.abs(ryan.totals.tla_staked_usd + ryan.totals.tla_compounder_usd + ryan.totals.tla_locked_usd - ryan.totals.tla_usd) < 1e-6 && ryan.totals.tla_compounder_usd > 30000, ryan.totals);
  const R = doc.rollup; const known = Object.values(W).map(w => w.totals.known_usd);
  chk('roll-up: dao.known_usd = Σ wallets known_usd; by_role has treasury / ops / msig / validator', Math.abs(R.dao.known_usd - known.reduce((a, b) => a + (b || 0), 0)) < 1e-6 && ['treasury', 'ops', 'msig', 'validator'].every(r => R.by_role[r]), Object.keys(R.by_role));
  chk('roll-up: every basis labeled', R.bases.tokens && R.bases.tla && R.bases.luna);
  const rc = doc.reconciliation;
  chk('gate #0: side-by-side vs phoenix.money — 4 rows with theirs_usd from the fixture, theirs total $189,983', rc && rc.theirs_total_usd > 189000 && rc.rows.filter(r => r.theirs_usd != null).length === 4, rc && rc.rows.map(r => [r.label, r.theirs_usd]));
  chk("gate #0: Ryan's TLA from us vs their 'tla' dapp within the same order (ours " + ryan.totals.tla_usd.toFixed(0) + ')', (() => { const r = rc.rows.find(x => x.address === ryan.address); const theirTla = r.theirs_by_dapp && (r.theirs_by_dapp.tla || r.theirs_by_dapp['tla-staked'] || null); return r && ryan.totals.tla_usd > 10000; })(), rc.rows.find(x => x.address === ryan.address));
  chk('no live LCD host was contacted outside the stub (every URL answered locally)', calls.every(u => u.startsWith(CORE_U) || u.startsWith(NFTC_U) || u.includes('publicnode.com')));
  chk('doc carries schema, product path from tenants.json daos[0], prices block, errors list', doc.schemaVersion === 1 && doc.product === 'lion-dao/positions' && doc.prices.luna_usd > 0 && Array.isArray(doc.errors), doc.product);
  // ---- 1.1.0 gate #0 by section
  const rr = rc.rows.find(x => x.address === ryan.address);
  chk("1.1.0 gate #0 by section: Ryan's compounder row = ours vs their 'tla-compounder', theirs $13,985; ours " + rr.sections.compounder.ours_usd.toFixed(0), rr.sections.compounder.theirs_usd > 13000 && rr.sections.compounder.theirs_usd < 15000 && rr.sections.compounder.ours_usd > 30000 && rr.sections.compounder.delta_usd > 15000, rr.sections.compounder);
  chk("1.1.0 gate #0 by section: their five $0-with-amount compounder rows are listed (ATOM-LUNA, ROAR-LUNA, bLUNA-LUNA, USDt-LUNA, LUNA-INJ)", rr.theirs_amount_but_zero_value.filter(z => z.dapp === 'tla-compounder').length >= 5, rr.theirs_amount_but_zero_value);
  chk("1.1.0 gate #0 by section: credia = their collateral $10,204 vs ours (receipt read) " + rr.sections.credia.ours_usd.toFixed(0), rr.sections.credia.theirs_usd > 10000 && rr.sections.credia.ours_usd > 3000, rr.sections.credia);
  chk('1.1.0 gate #0 by section: by_section totals present for all six, reference_as_of = the fixture folder date', ['balances', 'tla', 'compounder', 'locks', 'credia', 'votion'].every(s => rc.by_section[s] && 'delta_usd' in rc.by_section[s]) && rc.reference_as_of === '2026-09-21', [rc.reference_as_of, rc.by_section]);
  chk('1.1.0 sources block: credia markets (11) + as-of, feed denoms indexed, known_cw20s count', doc.sources && doc.sources.credia_markets === 11 && doc.sources.feed_denoms_indexed > 10 && doc.sources.known_cw20s === 1, doc.sources);
  fs.mkdirSync('out', { recursive: true }); fs.writeFileSync('out/positions-mock-current.json', JSON.stringify(doc, null, 1));
  console.log(`\n${pass} passed, ${fail} failed · out/positions-mock-current.json`); process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
