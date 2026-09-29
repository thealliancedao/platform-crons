'use strict';
// mock-run-solid.js — BINDING gate for lib/solid-reader.js 1.0.0 + tla-participants attachSolid (member-data 1.6.0), SPEC-portfolio-solid.
// Real inputs: the chain's own answers recorded by solid-probe 1.3 (tla-core docs/fixtures/2026-09-28/solid-probe.json — overseer,
// market, 8 custodies, the oracle) and the committed token catalog. When solid-probe 1.4 (mode liquidations) has run, its full census
// (docs/fixtures/<day>/solid-liquidations.json) is used as well (S8). Nothing is fetched.
// Usage: TLA_CORE_DIR=<tla-core checkout> node member-data/mock-run-solid.js
//   S1 the oracle unit: USD per token = price × 10^(decimals − 6) — ampLUNA / bLUNA == the price feed, WBTC.axl ≈ $82.8K, WETH ≈ $2.6K
//   S2 the owner's test position: locked 0.202649 ampLUNA + 0.000092 bLUNA; loan 0.012122 SOLID (= the mint fee left after repaying);
//      borrow limit 0.012243 (the protocol's), health 1.01 → "at risk"; the computed limit agrees within 0.1 %
//   S3 deposited ≠ locked: spendable in a custody is "idle" (in Solid, backing nothing); balance − spendable = locked
//   S4 a real borrower from the census (terra10kwrzdax…: 190,100 ampLUNA locked, 8,040 SOLID owed): health = limit ÷ loan, the
//      liquidation price of its one collateral = price × loan ÷ limit
//   S5 paging stops on an EMPTY page, not a short one (a contract may cap the limit)
//   S6 attachSolid: members in Solid get portfolio.solid + summary fields; members not in Solid get nothing (no "$0");
//      the protocol line (total SOLID owed == market state 46,593.83)
//   S7 a dead chain (every query null) → no member touched, errors recorded, no throw
const fs = require('fs'), path = require('path');
const SRC = process.env.TLA_CORE_DIR; if (!SRC) { console.error('TLA_CORE_DIR required'); process.exit(1); }
const SR = require('../lib/solid-reader.js'); const C = require('../config/contracts.js'); const { attachSolid } = require('./tla-participants.js'); const { buildResolver } = require('../lib/denom-symbol.js');
let pass = 0, fail = 0; const check = (n, ok, x) => { if (ok) { pass++; console.log('  ✅ ' + n); } else { fail++; console.log('  ❌ ' + n + (x != null ? ' — ' + JSON.stringify(x).slice(0, 400) : '')); } };
const J = (p) => JSON.parse(fs.readFileSync(path.join(SRC, p), 'utf8'));
const F = J('docs/fixtures/2026-09-28/solid-probe.json'); const CAT = J('token-catalog/snapshots/current.json'); const RES = buildResolver(CAT);
const decimalsOf = (d) => { const x = RES(d); return x && x.decimals != null ? x.decimals : null; };
const OWNER = 'terra1hr8zsfpch47qygc96c8e6rzkd2t7mafqx77ulw', BORR = 'terra10kwrzdaxhlp0d4ffr36ds4gkcq8w726dpum2t3';
// the recorded answers: exact query → answer; a paged query past the first page → an empty list (the probe recorded one page)
const calls = [];
const query = async (addr, msg) => { calls.push([addr, msg]); const c = F.contracts[addr]; if (!c) return null; const k = Object.keys(msg)[0];
  const exact = c.answers[k + ' ' + JSON.stringify(msg[k])]; const key = exact ? null : Object.keys(c.answers).find(x => x.startsWith(k + ' '));
  let a = exact || (key ? c.answers[key] : null); if (!a) return null; a = JSON.parse(JSON.stringify(a));
  if (msg[k] && msg[k].start_after) { for (const v of Object.values(a)) if (Array.isArray(v)) v.length = 0; return a; }
  // the probe recorded the first page of each census AND the owner's own answers (collaterals / borrower_info / borrower): a real census
  // holds the owner too — his recorded rows join the page they would be in (the same chain answers, merged, nothing invented)
  if (k === 'all_collaterals') { const o = c.answers['collaterals ' + JSON.stringify({ borrower: OWNER })]; if (o) a.all_collaterals.push({ borrower: o.borrower, collaterals: o.collaterals }); }
  if (k === 'borrower_infos') { const o = c.answers['borrower_info ' + JSON.stringify({ borrower: OWNER })]; if (o) a.borrower_infos.push(o); }
  if (k === 'borrowers') { const o = c.answers['borrower ' + JSON.stringify({ address: OWNER })]; if (o) a.borrowers.push(o); }
  return a; };
(async () => {
  const cen = await SR.loadCensus(query, C.SOLID, { decimalsOf });
  const px = (sym) => { const w = cen.whitelist.find(x => x.symbol === sym); return w ? cen.prices.get(w.token) : null; };
  const snap = J('member-data/tla-snapshot/current.json'); const feed = new Map(); for (const p of snap.pools) for (const a of [p.lp_health && p.lp_health.asset_0, p.lp_health && p.lp_health.asset_1]) if (a && a.symbol && a.price_usd > 0 && !feed.has(a.symbol)) feed.set(a.symbol, a.price_usd);
  const wbtcRaw = Number(F.contracts[C.SOLID.oracle].answers['prices {}'].prices.find(p => p.asset.startsWith('ibc/05D2')).price);
  check(`S1 oracle unit: ampLUNA $${px('ampLUNA').toFixed(5)} / bLUNA $${px('bLUNA').toFixed(5)} (the price feed now — the oracle was recorded hours earlier, so within 3 %: $${feed.get('ampLUNA').toFixed(5)} / $${feed.get('bLUNA').toFixed(5)}) · wBTC ${wbtcRaw.toFixed(2)} × 10² = $${px('wBTC').toFixed(0)} · wETH $${px('wETH').toFixed(0)}`,
    Math.abs(px('ampLUNA') / feed.get('ampLUNA') - 1) < 0.03 && Math.abs(px('bLUNA') / feed.get('bLUNA') - 1) < 0.03 && px('wBTC') > 50000 && px('wBTC') < 200000 && px('wETH') > 1000 && px('wETH') < 10000 && Math.abs(px('wBTC') - wbtcRaw * 100) < 1e-6,
    { amp: px('ampLUNA'), b: px('bLUNA'), wbtc: px('wBTC'), weth: px('wETH'), dec: [...cen.decimals] });
  // S2 the owner (his limit from the protocol, as the reader asks it for wallets with a loan)
  await SR.loadLimits(query, C.SOLID, cen, [OWNER]);
  const o = SR.positionOf(OWNER, cen); const amp = o && o.collateral.find(c => c.symbol === 'ampLUNA'), bl = o && o.collateral.find(c => c.symbol === 'bLUNA');
  const comp = o ? o.collateral.reduce((x, c) => x + (c.locked_usd || 0) * c.max_ltv, 0) : null;
  check(`S2 owner: locked ${amp && amp.locked} ampLUNA + ${bl && bl.locked} bLUNA · loan ${o && o.debt_solid} SOLID · limit ${o && o.borrow_limit_solid} (protocol) vs ${comp && comp.toFixed(6)} computed · health ${o && o.health && o.health.toFixed(3)} → ${o && o.band}`,
    o && amp.locked === 0.202649 && bl.locked === 0.000092 && o.debt_solid === 0.012122 && o.borrow_limit_solid === 0.012243 && o.borrow_limit_src === 'protocol' && Math.abs(comp / 0.012243 - 1) < 0.002 && Math.abs(o.health - 12243 / 12122) < 1e-9 && o.band === 'at_risk', o);
  check(`S2b a two-collateral loan: the liquidation reads as a basket fall of ${o && (o.liquidation.drop_pct * 100).toFixed(2)}% (1 − 1/health), no single price`, o && o.liquidation.kind === 'basket' && Math.abs(o.liquidation.drop_pct - (1 - 12122 / 12243)) < 1e-9);
  // S3 deposited vs locked, from the custody census rows themselves
  const custRows = []; for (const w of cen.whitelist) { const a = F.contracts[w.custody] && F.contracts[w.custody].answers['borrowers {}']; for (const r of ((a && a.borrowers) || [])) custRows.push([w, r]); }
  const lockedOf = (w, t) => { const m = cen.locked.get(w); return m && m[t] ? m[t] : 0; };
  let agree = 0, both = 0; for (const [w, r] of custRows) { const lk = lockedOf(r.borrower, w.token); if (!(Number(r.balance) > 0) || !cen.locked.has(r.borrower)) continue; both++;   /* rows whose wallet is in the recorded all_collaterals page too */ if (Number(r.balance) - Number(r.spendable) === lk) agree++; }
  const idleRow = custRows.find(([, r]) => Number(r.spendable) > 0);
  check(`S3 deposited = locked + spendable on every recorded custody row (${agree}/${both}): the overseer's lock and the custody agree, so "spendable" is exactly what sits in Solid backing nothing`, both >= 3 && agree === both, { agree, both });
  if (idleRow) { const [w, r] = idleRow; const p = SR.positionOf(r.borrower, cen); const c = p && p.collateral.find(x => x.token === w.token);
    check(`S3b ${r.borrower.slice(-6)}: ${w.symbol} spendable ${Number(r.spendable) / 10 ** cen.decimals.get(w.token)} → idle $${c && c.idle_usd != null ? c.idle_usd.toFixed(2) : '—'}`, c && Math.abs(c.idle - Number(r.spendable) / 10 ** cen.decimals.get(w.token)) < 1e-12, p); }
  else console.log('  (no idle collateral in the recorded rows — S3b runs on the full census)');
  // S4 a real borrower
  const b = SR.positionOf(BORR, cen); const bAmp = b && b.collateral.find(c => c.symbol === 'ampLUNA');
  const lim = 190100.01813 * px('ampLUNA') * 0.5;
  check(`S4 ${BORR.slice(0, 12)}…: ${bAmp && bAmp.locked.toLocaleString()} ampLUNA ($${b && b.collateral_usd.toFixed(0)}) against ${b && b.debt_solid.toLocaleString()} SOLID → limit ${b && b.borrow_limit_solid.toFixed(0)} (computed — no protocol read in the fixture), health ${b && b.health.toFixed(3)} (${b && b.band}); liquidates if ampLUNA falls ${b && (b.liquidation.drop_pct * 100).toFixed(1)}% to $${b && b.liquidation.price_at.toFixed(4)}`,
    b && Math.abs(b.borrow_limit_solid - lim) < 0.01 && Math.abs(b.health - lim / 8040) < 1e-9 && b.liquidation.kind === 'single' && Math.abs(b.liquidation.price_at - px('ampLUNA') * 8040 / lim) < 1e-12 && b.borrow_limit_src.startsWith('computed'), b);
  // S5 paging
  const seq = []; const pq = async (a, m) => { const sa = m.x.start_after || null; seq.push(sa); const pages = { null: ['a', 'b'], b: ['c'], c: [] }; return { list: (pages[sa] || []).map(k => ({ id: k })) }; };
  const pr = await SR.pageAll(pq, 'addr', 'x', 'list', (r) => r.id);
  check(`S5 paging: a short page is not the end (pages ${pr.pages}, rows ${pr.rows.map(r => r.id).join('')}), an empty one is`, pr.rows.length === 3 && pr.pages === 3 && !pr.error, pr);
  // S6 attachSolid on members
  const P = [{ wallet: OWNER, summary: {} }, { wallet: BORR, summary: {} }, { wallet: 'terra1nobodynobodynobodynobodynobodynobody0', summary: { total_portfolio_value_usd: 5 } }];
  const res = await attachSolid(P, { queryContract: query, fetchJson: async (u) => { if (/token-catalog/.test(u)) return JSON.parse(JSON.stringify(CAT)); throw new Error('unexpected ' + u); } });
  const liab = Number(F.contracts[C.SOLID.market].answers['state {}'].total_liabilities) / 1e6;
  check(`S6 attachSolid: ${res.stats.with_position} members in Solid (${res.stats.borrowers} borrowing) get portfolio.solid + summary; the outsider gets nothing; protocol owes ${res.protocol && res.protocol.total_liabilities_solid} SOLID (market state ${liab})`,
    P[0].solid && P[1].solid && !P[2].solid && P[2].summary.solid_collateral_usd === undefined && P[0].summary.solid_health === P[0].solid.health && P[1].summary.solid_debt_usd === P[1].solid.debt_usd && Math.abs(res.protocol.total_liabilities_solid - liab) < 1e-9 && res.stats.limits_read >= 1, res.stats);
  const nQ = calls.filter(([a, m]) => m.borrow_limit).length;
  check(`S6b the protocol's limit is asked only for wallets with a loan (${nQ} borrow_limit queries in all)`, nQ <= 3);
  // S7 dead chain
  const P2 = [{ wallet: OWNER, summary: {} }]; let threw = null, r2 = null; try { r2 = await attachSolid(P2, { queryContract: async () => null, fetchJson: async () => { throw new Error('down'); } }); } catch (e) { threw = e.message; }
  check('S7 a dead chain: no throw, errors recorded, no member touched (unknown, not zero)', !threw && r2 && r2.stats.errors && r2.stats.errors.length > 0 && !P2[0].solid && P2[0].summary.solid_debt_usd === undefined, { threw, r2: r2 && r2.stats });
  // S8 the full census (solid-probe 1.4), when committed
  const fx = fs.existsSync(path.join(SRC, 'docs/fixtures')) ? fs.readdirSync(path.join(SRC, 'docs/fixtures')).sort().reverse().map(d => path.join('docs/fixtures', d, 'solid-liquidations.json')).find(p => fs.existsSync(path.join(SRC, p))) : null;
  if (!fx) console.log('  (no solid-liquidations.json yet — run the Solid Probe Action in mode "liquidations"; S8 checks the full census then)');
  else { const L = J(fx); const ans = { census: L.census };
    const q2 = async (addr, msg) => { const k = Object.keys(msg)[0]; if (k === 'token_info') return L.token_info[addr] && !L.token_info[addr].error ? L.token_info[addr] : null; if (k === 'prices') return L.answers['oracle.prices'].data; if (k === 'whitelist') return L.answers['overseer.whitelist'].data; if (k === 'state') return L.answers['market.state'].data;
      if (k === 'borrow_limit') { const x = (L.census['overseer.borrow_limit'].data || []).find(y => y.borrower === msg.borrow_limit.borrower); return x && !x.error ? x : null; }
      const key = k === 'all_collaterals' ? 'overseer.all_collaterals' : k === 'borrower_infos' ? 'market.borrower_infos' : Object.keys(L.census).find(c => L.census[c].contract === addr && c.endsWith('.borrowers'));
      if (!key) return null; if (msg[k].start_after) return { [k]: [] }; return { [k]: L.census[key].data }; };
    const c2 = await SR.loadCensus(q2, C.SOLID, { decimalsOf }); await SR.loadLimits(q2, C.SOLID, c2, [...c2.loans.keys()]);
    let ok = 0, n = 0, worst = 0; let noColl = 0; for (const w of c2.loans.keys()) { const p = SR.positionOf(w, c2); if (!p || p.borrow_limit_src !== 'protocol') continue; if (p.band === 'debt_no_collateral') { noColl++; continue; } if (p.borrow_limit_solid < 0.01) continue;   /* dust: the protocol floors a sub-cent limit to 0 */ n++; const comp = p.collateral.reduce((x, c) => x + (c.locked_usd || 0) * (c.max_ltv || 0), 0); const d = Math.abs(comp / p.borrow_limit_solid - 1); worst = Math.max(worst, d); if (d < 0.01) ok++; }
    check(`S8 the full census (${fx}): ${c2.locked.size} wallets with collateral, ${c2.loans.size} with a loan; the computed limit matches the protocol's within 1 % on ${ok}/${n} (worst ${(worst * 100).toFixed(2)} %)`, n > 0 && ok === n, { n, ok, worst });
    const wb = c2.whitelist.find(x => x.symbol === 'wBTC'), we = c2.whitelist.find(x => x.symbol === 'wETH');
    const pxT = (w) => { const c = [...c2.loans.keys()].map(a => SR.positionOf(a, c2)).flatMap(p => (p && p.collateral) || []).find(x => x.token === w.token && x.price_usd); return c ? c.price_usd : null; };
    check(`S8b wrappers count in the wrapped token's units (their token_info says 6): wBTC ${c2.decimals.get(wb.token)} dec → $${(pxT(wb) || 0).toFixed(0)} per wBTC · wETH ${c2.decimals.get(we.token)} dec → $${(pxT(we) || 0).toFixed(0)} per wETH`, c2.decimals.get(wb.token) === 8 && c2.decimals.get(we.token) === 18 && pxT(wb) > 20000 && pxT(we) > 500, { wb: pxT(wb), we: pxT(we) });
    check(`S8c ${noColl} wallets owe SOLID with NO collateral left (liquidated to zero) → band "debt_no_collateral", no health, no liquidation line — never "health 0"`, noColl > 0 && [...c2.loans.keys()].map(a => SR.positionOf(a, c2)).filter(p => p && p.band === 'debt_no_collateral').every(p => p.health == null && p.liquidation == null && p.debt_solid > 0));
    // S9 the liquidation vocabulary (the history needs it): custody liquidate_collateral {borrower, amount} = execute_bid {collateral_amount, repay_amount} = market repay_stable {borrower}
    const attrs = (e) => Object.fromEntries(e.attributes.map(a => [a.key, a.value]));
    let good = 0, tried = 0; for (const smp of L.liquidations.samples) { const ev = smp.events.map(attrs); const lc = ev.filter(a => a.action === 'liquidate_collateral' && a.borrower && a.amount); const eb = ev.filter(a => a.action === 'execute_bid'); const rp = ev.filter(a => a.action === 'repay_stable' && a.borrower);
      if (!lc.length || !eb.length || !rp.length) continue; tried++; if (lc.every(x => eb.some(b => b.collateral_amount === x.amount)) && lc.every(x => rp.some(r => r.borrower === x.borrower))) good++; }
    check(`S9 liquidation events carry everything the Solid history needs: ${good}/${tried} sampled liquidations tie borrower + collateral taken (custody) = collateral sold (queue) and SOLID repaid (market) · ${Object.entries(L.liquidations.direct || {}).filter(([k]) => /custody.*liquidate_collateral/.test(k)).reduce((x, [, v]) => x + v.total, 0)} liquidations on chain in all`, tried >= 20 && good === tried, { good, tried }); }
  console.log(`\n${pass}/${pass + fail} passed`); process.exit(fail ? 1 : 0);
})().catch(e => { console.error('GATE CRASH', e); process.exit(1); });
