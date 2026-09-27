'use strict';
// mock-run-credia.js — BINDING gate for tla-participants attachCredia (member-data 1.3.0) on lib/credia-reader.js 1.0.0.
// Real inputs from a tla-core checkout: the captured Credia Portfolio answer (docs/fixtures/2026-09-27/credia-portfolio-ryan.json)
// and the committed token catalog. Nothing is fetched. Usage: TLA_CORE_DIR=<tla-core checkout> node member-data/mock-run-credia.js
//   C1 the real answer: supplied_usd = the contract's total (10,097.51 incl. the ampLP row), debt 0, health factor kept
//   C2 names from the catalog: wBTC.atom / arbLUNA / ampLUNA with decimals; the amplp receipt labelled, never guessed
//   C3 an empty answer is a read with 0 (never null); a failed query is recorded as credia.error and never throws
//   C4 a borrower: debt rows parsed, net = supplied − debt, counted as a borrower
//   C5 summary fields set on read wallets only; stats = { read, failed, with_position, borrowers }
//   C6 one query per wallet, to the registry's Portfolio contract, with {portfolio:{address}}
//   C7 no catalog (fetch fails) → still reads, rows carry USD with symbol null (blank beats phantom)
const fs = require('fs'), path = require('path');
const SRC = process.env.TLA_CORE_DIR; if (!SRC) { console.error('TLA_CORE_DIR required'); process.exit(1); }
const { attachCredia } = require('./tla-participants.js');
const C = require('../config/contracts.js');
let pass = 0, fail = 0; const check = (n, ok, x) => { if (ok) { pass++; console.log('  ✅ ' + n); } else { fail++; console.log('  ❌ ' + n + (x != null ? ' — ' + JSON.stringify(x).slice(0, 400) : '')); } };
const J = (p) => JSON.parse(fs.readFileSync(path.join(SRC, p), 'utf8'));
const REAL = J('docs/fixtures/2026-09-27/credia-portfolio-ryan.json').response;
const CAT = J('token-catalog/snapshots/current.json');
const clone = (o) => JSON.parse(JSON.stringify(o));
const EMPTY = { supplied: [], borrowed: [], total_supplied_value: '0', total_collateral_value: '0', total_lt_value: '0', total_ltv_value: '0', total_borrowed_value: '0', lt_health_factor: null, ltv_health_factor: null, unhealthy_prices: [], max_liquidation_usd: null, emode: null };
// a borrower built from the real rows: the wBTC row supplied, the arbLUNA row borrowed (same field shape as the contract's)
const BORROW = (() => { const s = REAL.supplied; return Object.assign(clone(EMPTY), { supplied: [clone(s[0])], borrowed: [Object.assign(clone(s[1]), { collateral: undefined })], total_supplied_value: s[0].value, total_borrowed_value: s[1].value, lt_health_factor: '2.5', ltv_health_factor: '1.8' }); })();
const W = { ryan: REAL.address, empty: 'terra1emptyemptyemptyemptyemptyemptyempty0', borrower: 'terra1borrowerborrowerborrowerborrowerbo0', broken: 'terra1brokenbrokenbrokenbrokenbrokenbroke' };
const serial = async (xs, fn) => { for (const x of xs) await fn(x); };
(async () => {
  const calls = [];
  const queryContract = async (addr, msg) => { calls.push([addr, msg]); const a = msg.portfolio.address; if (a === W.ryan) return clone(REAL); if (a === W.empty) return clone(EMPTY); if (a === W.borrower) return clone(BORROW); throw new Error('lcd 502'); };
  const fetchJson = async (url) => { if (/token-catalog\/snapshots\/current\.json$/.test(url)) return clone(CAT); throw new Error('unexpected ' + url); };
  const P = [{ wallet: W.ryan, summary: { total_usd: 1 } }, { address: W.empty }, { wallet: W.borrower }, { wallet: W.broken, summary: {} }];
  let threw = null, stats = null; try { stats = await attachCredia(P, { queryContract, fetchJson, parallel: serial }); } catch (e) { threw = e.message; }
  const [r, e, b, x] = P;
  check(`C1 real answer: supplied_usd ${r.credia && r.credia.supplied_usd && r.credia.supplied_usd.toFixed(2)} = contract total 10097.51 (${r.credia && r.credia.supplied.length} rows incl. ampLP), debt 0, lt health ${r.credia && r.credia.health.lt_health_factor}`,
    !threw && r.credia && Math.abs(r.credia.supplied_usd - 10097.511312416578) < 1e-6 && r.credia.supplied.length === 4 && r.credia.debt_usd === 0 && r.credia.debt.length === 0 && r.credia.health.lt_health_factor === 100 && Math.abs(r.credia.supplied.reduce((s, y) => s + y.usd_value, 0) - r.credia.supplied_usd) < 1e-6, threw || r.credia);
  const syms = r.credia ? r.credia.supplied.map(y => y.symbol) : [];
  check('C2 names from the catalog: ' + syms.join(' · '), syms[0] === 'wBTC.atom' && syms[1] === 'arbLUNA' && syms[2] === 'ampLUNA' && /ampLP/.test(syms[3] || '') && r.credia.supplied[0].amount_human === Number(REAL.supplied[0].amount) / 1e8 && r.credia.supplied[3].amount_human === null, r.credia && r.credia.supplied.map(y => [y.symbol, y.amount_human]));
  check('C3 empty answer → read with 0 (not null); failed query → credia.error, no throw', e.credia && e.credia.supplied_usd === 0 && e.credia.debt_usd === 0 && !e.credia.error && x.credia && typeof x.credia.error === 'string' && x.credia.supplied_usd === undefined && !threw, { e: e.credia, x: x.credia });
  check(`C4 borrower: debt ${b.credia && b.credia.debt_usd && b.credia.debt_usd.toFixed(2)} (${b.credia && b.credia.debt[0] && b.credia.debt[0].symbol}), net = supplied − debt`, b.credia && b.credia.debt.length === 1 && b.credia.debt[0].symbol === 'arbLUNA' && Math.abs(b.credia.net_usd - (b.credia.supplied_usd - b.credia.debt_usd)) < 1e-9 && b.credia.debt[0].collateral === undefined && b.credia.health.ltv_health_factor === 1.8, b.credia);
  check('C5 summary on read wallets only; stats ' + JSON.stringify(stats), r.summary.total_usd === 1 && r.summary.credia_supplied_usd === r.credia.supplied_usd && r.summary.credia_borrowed_usd === 0 && r.summary.credia_lt_health_factor === 100 && e.summary.credia_supplied_usd === 0 && b.summary.credia_borrowed_usd > 0 && x.summary.credia_supplied_usd === undefined
    && stats && stats.read === 3 && stats.failed === 1 && stats.with_position === 2 && stats.borrowers === 1, { stats, x: x.summary });
  check(`C6 ${calls.length} queries, one per wallet, to ${C.CREDIA.portfolio.slice(0, 12)}… with {portfolio:{address}}`, calls.length === 4 && calls.every(([a, m]) => a === C.CREDIA.portfolio && Object.keys(m).join() === 'portfolio' && Object.keys(m.portfolio).join() === 'address') && new Set(calls.map(c => c[1].portfolio.address)).size === 4, calls);
  const P2 = [{ wallet: W.ryan }];
  const s2 = await attachCredia(P2, { queryContract, fetchJson: async () => { throw new Error('raw 503'); }, parallel: serial });
  check('C7 no catalog: still read (USD from the contract), symbols blank not guessed, amplp still labelled', s2.read === 1 && Math.abs(P2[0].credia.supplied_usd - 10097.511312416578) < 1e-6 && P2[0].credia.supplied.slice(0, 3).every(y => y.symbol === null && y.amount_human === null) && /ampLP/.test(P2[0].credia.supplied[3].symbol), P2[0].credia.supplied.map(y => y.symbol));
  console.log(`\n${pass}/${pass + fail} passed`); process.exit(fail ? 1 : 0);
})().catch(e => { console.error('GATE CRASH', e); process.exit(1); });
