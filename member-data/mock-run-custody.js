'use strict';
// mock-run-custody.js — BINDING gate for capture-engine 1.2 custody (config CUSTODIANS: the ampCAPA DAO) on REAL committed data from a
// tla-core checkout: the CAPA supply product (token-catalog/supply/capa/wallets.json), network-and-prices, the participants product
// (every member's real portfolio fields). Nothing is fetched. Usage: TLA_CORE_DIR=<tla-core checkout> node member-data/mock-run-custody.js
//   K1 the owner: the DAO stake = the product's receipt_dao (CAPA-equivalent) × this run's CAPA price; where / custodian / pool named
//   K2 summary: custody_usd, total_includes_custody, and total_portfolio_value_usd = the old total + custody (nothing else moves)
//   K3 every wallet the product shows in the DAO gets exactly one custody row; the rows sum to the product's own DAO total
//   K4 no CAPA price → amounts kept, USD blank (null), the total unchanged — never a guessed dollar
//   K5 the product unreadable → custody empty with a recorded error; the capture itself never throws
//   K6 a portfolio captured before 1.2 (no custody field) summarises exactly as before (+0)
const fs = require('fs'), path = require('path');
const SRC = process.env.TLA_CORE_DIR; if (!SRC) { console.error('TLA_CORE_DIR required'); process.exit(1); }
const E = require('../lib/capture-engine.js'); const C = require('../config/contracts.js');
let pass = 0, fail = 0; const check = (n, ok, x) => { if (ok) { pass++; console.log('  ✅ ' + n); } else { fail++; console.log('  ❌ ' + n + (x != null ? ' — ' + JSON.stringify(x).slice(0, 400) : '')); } };
const J = (p) => JSON.parse(fs.readFileSync(path.join(SRC, p), 'utf8'));
const PROD = J('token-catalog/supply/capa/wallets.json'), NP = J('network-and-prices/current.json'), PART = J('member-data/participants/current.json');
const fjLocal = async (url) => { const rel = url.replace('https://raw.githubusercontent.com/thealliancedao/tla-core/main/', ''); return J(rel); };
const OWNER = 'terra1hr8zsfpch47qygc96c8e6rzkd2t7mafqx77ulw';
const clone = (o) => JSON.parse(JSON.stringify(o));
(async () => {
  const cu = await E.loadCustody(NP.token_prices, fjLocal); const px = NP.token_prices.CAPA.final_price_usd;
  const row = PROD.rows.find(r => r.address === OWNER); const mine = cu.byWallet.get(OWNER) || [];
  check(`K1 owner: ${row.capa_equiv.receipt_dao.toLocaleString('en-US')} CAPA in ${C.CUSTODIANS[0].label} × $${px} = $${(row.capa_equiv.receipt_dao * px).toFixed(2)} (the DAO page: 3,357,642,280,765 amplp)`,
    mine.length === 1 && Math.abs(mine[0].usd - row.capa_equiv.receipt_dao * px) < 1e-9 && mine[0].where === 'the ampCAPA DAO' && mine[0].custodian === C.CUSTODIANS[0].address && mine[0].pool === C.CUSTODIANS[0].pool && mine[0].as_of === PROD.capturedAt, mine);
  const CTX = { tokenPrices: NP.token_prices, lstRatios: NP.lst_ratios || {}, lunaPriceUsd: NP.token_prices.LUNA.final_price_usd };   /* this run's prices, as loadSharedData gives them */
  const m = clone(PART.members.find(x => x.wallet === OWNER)); delete m.custody; const before = E.computeMemberSummary(clone(m), CTX);
  m.custody = mine; const after = E.computeMemberSummary(m, CTX);
  check(`K2 summary: custody_usd $${after.custody_usd.toFixed(2)}, flagged, total $${before.total_portfolio_value_usd.toFixed(2)} → $${after.total_portfolio_value_usd.toFixed(2)} (+ custody only)`,
    after.total_includes_custody === true && Math.abs(after.custody_usd - mine[0].usd) < 1e-9 && Math.abs(after.total_portfolio_value_usd - before.total_portfolio_value_usd - mine[0].usd) < 1e-6 && after.total_lp_position_usd === before.total_lp_position_usd);
  const inDao = PROD.rows.filter(r => r.capa_equiv && r.capa_equiv.receipt_dao > 0); const sumP = inDao.reduce((a, r) => a + r.capa_equiv.receipt_dao, 0);
  const sumC = [...cu.byWallet.values()].flat().reduce((a, c) => a + c.amount, 0);
  check(`K3 ${inDao.length} wallets in the DAO per the product → ${cu.byWallet.size} custody rows; ${sumC.toFixed(0)} CAPA = the product's ${sumP.toFixed(0)}`, cu.byWallet.size === inDao.length && [...cu.byWallet.values()].every(l => l.length === 1) && Math.abs(sumC - sumP) < 1e-6);
  const np2 = clone(NP.token_prices); delete np2.CAPA; const cu2 = await E.loadCustody(np2, fjLocal); const m2 = cu2.byWallet.get(OWNER)[0];
  const t2 = E.computeMemberSummary(Object.assign(clone(PART.members.find(x => x.wallet === OWNER)), { custody: [m2] }), CTX);
  check('K4 no CAPA price: amount kept, usd null, total unchanged', m2.amount === row.capa_equiv.receipt_dao && m2.usd === null && t2.custody_usd === 0 && Math.abs(t2.total_portfolio_value_usd - before.total_portfolio_value_usd) < 1e-9 && cu2.sources[0].priced === false);
  let threw = null, cu3 = null; try { cu3 = await E.loadCustody(NP.token_prices, async () => { throw new Error('raw 503'); }); } catch (e) { threw = e.message; }
  check('K5 product unreadable → no custody, error recorded, no throw', !threw && cu3.byWallet.size === 0 && cu3.errors.length === 1 && /503/.test(cu3.errors[0].error), threw || cu3);
  { const m0 = clone(PART.members.find(x => x.wallet === OWNER)); delete m0.custody; const s0 = E.computeMemberSummary(m0, CTX); const s1 = E.computeMemberSummary(Object.assign(clone(m0), { custody: [] }), CTX);
    check(`K6 a pre-1.2 portfolio (no custody field) sums exactly as one with none: $${s0.total_portfolio_value_usd.toFixed(2)}, custody 0`, s0.custody_usd === 0 && s0.total_portfolio_value_usd === s1.total_portfolio_value_usd && Math.abs(s0.total_locked_usd - PART.members.find(x => x.wallet === OWNER).summary.total_locked_usd) / PART.members.find(x => x.wallet === OWNER).summary.total_locked_usd < 0.05); }
  console.log(`\n${pass}/${pass + fail} passed`); process.exit(fail ? 1 : 0);
})().catch(e => { console.error('GATE CRASH', e); process.exit(1); });
