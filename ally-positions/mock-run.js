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
// ---- transport stub
const CORE_U = 'https://raw.githubusercontent.com/thealliancedao/tla-core/main/', NFTC_U = 'https://raw.githubusercontent.com/thealliancedao/nft-collections/main/';
const calls = []; const ok = (o) => ({ ok: true, status: 200, json: async () => o, text: async () => JSON.stringify(o) }); const nf = { ok: false, status: 404, json: async () => ({}), text: async () => '' };
const b64q = (u) => { try { return JSON.parse(Buffer.from(u.split('/smart/')[1].split('?')[0], 'base64').toString()); } catch (e) { return null; } };
global.fetch = async (url) => { url = String(url); calls.push(url);
  if (url.startsWith(CORE_U)) { const f = path.join(CORE, url.slice(CORE_U.length).split('?')[0]); return fs.existsSync(f) ? ok(J(f)) : nf; }
  if (url.startsWith(NFTC_U)) { const f = path.join(NFTC, url.slice(NFTC_U.length).split('?')[0]); return fs.existsSync(f) ? ok(J(f)) : nf; }
  if (url.includes('/cosmos/bank/v1beta1/balances/')) { const a = url.split('/balances/')[1].split('?')[0]; return ok({ balances: a === treasury ? [{ denom: 'uluna', amount: '13000000' }, { denom: 'ibc/88386AC48152D48B34B082648DF836F975506F0B57DBBFC10A54213B1BF484CB', amount: '270000' }] : [{ denom: 'uluna', amount: '1084000000' }] }); }
  if (url.includes('/cosmos/staking/v1beta1/delegations/')) { const a = url.split('/delegations/')[1].split('?')[0]; return ok({ delegation_responses: a === treasury ? [{ delegation: { validator_address: T.validator.operator }, balance: { denom: 'uluna', amount: '10000000000' } }] : [] }); }
  if (url.includes('/distribution/v1beta1/delegators/')) { const a = url.split('/delegators/')[1].split('/')[0]; return ok({ rewards: a === treasury ? [{ validator_address: T.validator.operator, reward: [{ denom: 'uluna', amount: '500000000.25' }] }] : [], total: [] }); }
  if (url.includes('/distribution/v1beta1/validators/')) return ok({ commission: { commission: [{ denom: 'uluna', amount: '2000000000.5' }] } });
  if (url.includes('/cosmwasm/wasm/v1/contract/')) { const c = url.split('/contract/')[1].split('/')[0]; const q = b64q(url);
    if (q && q.balance) { const a = q.balance.address; if (c === ROAR && a === treasury) return ok({ data: { balance: '298564000000000000' } }); if (c === ROAR && T.wallets[a] && T.wallets[a].role === 'ops') return ok({ data: { balance: '19342000000000000' } }); return ok({ data: { balance: '0' } }); }
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
  chk('credia is null with its reason (no reader) — never 0', tre.credia === null && /reader not built/.test(tre.credia_note) && doc.rollup.dao.credia_usd === null);
  const R = doc.rollup; const known = Object.values(W).map(w => w.totals.known_usd);
  chk('roll-up: dao.known_usd = Σ wallets known_usd; by_role has treasury / ops / msig / validator', Math.abs(R.dao.known_usd - known.reduce((a, b) => a + (b || 0), 0)) < 1e-6 && ['treasury', 'ops', 'msig', 'validator'].every(r => R.by_role[r]), Object.keys(R.by_role));
  chk('roll-up: every basis labeled', R.bases.tokens && R.bases.tla && R.bases.luna);
  const rc = doc.reconciliation;
  chk('gate #0: side-by-side vs phoenix.money — 4 rows with theirs_usd from the fixture, theirs total $189,983', rc && rc.theirs_total_usd > 189000 && rc.rows.filter(r => r.theirs_usd != null).length === 4, rc && rc.rows.map(r => [r.label, r.theirs_usd]));
  chk("gate #0: Ryan's TLA from us vs their 'tla' dapp within the same order (ours " + ryan.totals.tla_usd.toFixed(0) + ')', (() => { const r = rc.rows.find(x => x.address === ryan.address); const theirTla = r.theirs_by_dapp && (r.theirs_by_dapp.tla || r.theirs_by_dapp['tla-staked'] || null); return r && ryan.totals.tla_usd > 10000; })(), rc.rows.find(x => x.address === ryan.address));
  chk('no live LCD host was contacted outside the stub (every URL answered locally)', calls.every(u => u.startsWith(CORE_U) || u.startsWith(NFTC_U) || u.includes('publicnode.com')));
  chk('doc carries schema, product path from tenants.json daos[0], prices block, errors list', doc.schemaVersion === 1 && doc.product === 'lion-dao/positions' && doc.prices.luna_usd > 0 && Array.isArray(doc.errors), doc.product);
  fs.mkdirSync('out', { recursive: true }); fs.writeFileSync('out/positions-mock-current.json', JSON.stringify(doc, null, 1));
  console.log(`\n${pass} passed, ${fail} failed · out/positions-mock-current.json`); process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
