'use strict';
/**
 * lib/solid-reader.js 1.0.0 (2026-09-28) — ONE reader for every wallet's Solid (Capapult CDP) position. SPEC-portfolio-solid.
 * Cheap by design: the protocol is read as a CENSUS once per run (paged), then joined to wallets — never one query per wallet —
 * except the protocol's own borrow limit, asked only for the wallets that have a loan.
 *   overseer  all_collaterals {start_after, limit}  → [{ borrower, collaterals: [[cw20, raw]] }]   what is LOCKED (backs the loan)
 *   market    borrower_infos  {start_after, limit}  → [{ borrower, loan_amount }]                  SOLID owed (raw, 6 dec)
 *   custody   borrowers       {start_after, limit}  → [{ borrower, balance, spendable }]            deposited; spendable = NOT locked
 *   oracle    prices {}                              → [{ asset, price }]                            (uusd per raw unit — see below)
 *   overseer  whitelist {}                           → [{ symbol, max_ltv, custody_contract, collateral_token }]
 *   cw20      token_info {}                          → decimals of each collateral and SOLID
 *   overseer  borrow_limit {borrower}                → SOLID raw — the protocol's own limit (wallets with a loan only)
 * THE ORACLE UNIT (proven 2026-09-28 on four assets in docs/fixtures/2026-09-28/solid-probe.json): `price` is uusd per RAW base unit, so
 *   USD per token = price × 10^(decimals − 6): ampLUNA 0.12071 (6 dec) = $0.12071 = the price feed · wBTC 828.44 (8 dec) = $82,844 ·
 *   WETH 2.6449e-9 (18 dec) = $2,644.9 · USDC 1.0001 (6 dec). The owner's test position: locked 0.2026 ampLUNA + 0.000092 bLUNA =
 *   $0.02447 × max LTV 0.5 = 12,235 raw vs the protocol's borrow_limit 12,243 (0.07 % — a price a minute apart).
 * A collateral cw20 the oracle does not list is priced by the ibc token it wraps (config SOLID.custodies[].wraps).
 * Health = borrow_limit ÷ loan — the protocol's own view; under 1.0 the position can be liquidated. Liquidation price (one collateral)
 * = price now × loan ÷ borrow_limit; several collaterals: they would all have to fall by 1 − 1/health.
 * Loans carry a MINT FEE added to the debt when borrowing (borrow_stable → mint_fee; the owner's 2,424,546 borrow owed 12,122 more),
 * no interest has been seen (the market config has only flash_mint_fee) — the P&L history counts fees from the events.
 *   loadCensus(query, cfg, opts) · positionOf(wallet, census) (pure) · attach(portfolios, deps) is in member-data/tla-participants.js
 */
const VERSION = 'solid-reader-1.0.1';   // 1.0.1: wrapper decimals from the wrapped token; a loan with no collateral left is its own band
const PAGE_LIMIT = 30;
const num = (x) => { if (x == null || x === '') return null; const n = Number(x); return Number.isFinite(n) ? n : null; };

// page a list query to the end — stop on an EMPTY page (a contract may cap the limit below what is asked) or a repeated cursor
async function pageAll(query, addr, qName, listKey, cursorOf, maxPages = 400) {
  const rows = []; let start_after = null, pages = 0;
  while (pages < maxPages) {
    const r = await query(addr, { [qName]: Object.assign({ limit: PAGE_LIMIT }, start_after ? { start_after } : {}) }); pages++;
    if (r == null) return { rows, pages, error: `${qName} page ${pages} failed` };
    const list = r[listKey] || []; rows.push(...list); if (!list.length) break;
    const next = cursorOf(list[list.length - 1]); if (next == null || next === start_after) break; start_after = next;
  }
  return { rows, pages, error: pages >= maxPages ? 'page cap reached' : null };
}

// the whole protocol, once. query(addr, msg) → data | null (null = failed; never throws). cfg = config/contracts.js SOLID
async function loadCensus(query, cfg, opts) {
  opts = opts || {}; const errors = [];
  const wl = await query(cfg.overseer, { whitelist: {} }); const elems = (wl && wl.elems) || [];
  if (!elems.length) errors.push('whitelist unreadable — collateral list from config');
  const whitelist = (elems.length ? elems : Object.entries(cfg.custodies || {}).map(([t, c]) => ({ collateral_token: t, symbol: c.symbol, custody_contract: c.custody, max_ltv: c.max_ltv })))
    .map(e => ({ token: e.collateral_token, symbol: e.symbol, custody: e.custody_contract, max_ltv: num(e.max_ltv), wraps: ((cfg.custodies || {})[e.collateral_token] || {}).wraps || null }));
  const decimals = new Map();
  // decimals: the token's own token_info; else the token catalog (opts.decimalsOf) for it or for the ibc token it wraps — labelled, never assumed 6
  const decSrc = new Map();
  for (const t of [...whitelist.map(w => w.token), cfg.stable]) {
    const w = whitelist.find(x => x.token === t);
    // 1.0.1 (the full census, 2026-09-28): Solid's wrappers of bridged tokens REPORT 6 decimals in token_info (wETH, wBTC) while their
    // amounts are in the wrapped token's units (wETH in wei: 22,172,816 raw = 2.2e-11 ETH, not 22 wETH) — so a wrapper takes the decimals of
    // the ibc token it wraps first; USD values never depended on it (raw × price ÷ 1e6), only the token counts shown.
    const wrapDec = w && w.wraps && opts.decimalsOf ? opts.decimalsOf(w.wraps) : null;
    if (wrapDec != null) { decimals.set(t, Number(wrapDec)); decSrc.set(t, 'the wrapped token (' + w.wraps.slice(0, 12) + '…) — token_info of the wrapper is not its unit'); continue; }
    const ti = await query(t, { token_info: {} }); if (ti && ti.decimals != null) { decimals.set(t, Number(ti.decimals)); decSrc.set(t, 'token_info'); continue; } const d = opts.decimalsOf ? ((w && w.wraps ? opts.decimalsOf(w.wraps) : null) ?? opts.decimalsOf(t)) : null;   // a Solid wrapper keeps the decimals of the ibc token it wraps (the catalog may carry the wrapper at a default 6)
    if (d != null) { decimals.set(t, Number(d)); decSrc.set(t, 'token catalog'); } else errors.push('decimals of ' + t.slice(0, 12) + '… unknown (token_info unreadable, not in the catalog) — its value is left blank');
  }
  const pr = await query(cfg.oracle, { prices: {} }); const raw = new Map(((pr && pr.prices) || []).map(p => [p.asset, num(p.price)]));
  if (!raw.size) errors.push('oracle prices unreadable');
  const prices = new Map(); const priceSrc = new Map();
  for (const t of [...whitelist.map(w => w.token), cfg.stable]) {
    const w = whitelist.find(x => x.token === t); const dec = decimals.get(t);
    const p = raw.has(t) ? raw.get(t) : (w && w.wraps && raw.has(w.wraps) ? raw.get(w.wraps) : null);
    if (p != null && dec != null) { prices.set(t, p * Math.pow(10, dec - 6)); priceSrc.set(t, raw.has(t) ? 'oracle' : 'oracle (wrapped ' + w.wraps.slice(0, 12) + '…)'); }
  }
  const ac = await pageAll(query, cfg.overseer, 'all_collaterals', 'all_collaterals', x => x.borrower, opts.maxPages);
  const bi = await pageAll(query, cfg.market, 'borrower_infos', 'borrower_infos', x => x.borrower, opts.maxPages);
  for (const [n, r] of [['all_collaterals', ac], ['borrower_infos', bi]]) if (r.error) errors.push(n + ': ' + r.error);
  const locked = new Map(); for (const x of ac.rows) { const m = {}; for (const [t, a] of (x.collaterals || [])) if (num(a) > 0) m[t] = num(a); if (Object.keys(m).length) locked.set(x.borrower, m); }
  const loans = new Map(); for (const x of bi.rows) if (num(x.loan_amount) > 0) loans.set(x.borrower, num(x.loan_amount));
  const deposits = new Map(); const custodyStats = {};
  for (const w of whitelist) {
    const r = await pageAll(query, w.custody, 'borrowers', 'borrowers', x => x.borrower, opts.maxPages); if (r.error) errors.push('custody ' + w.symbol + ': ' + r.error);
    custodyStats[w.symbol] = { rows: r.rows.length, pages: r.pages, complete: !r.error };
    for (const x of r.rows) { const b = num(x.balance), s = num(x.spendable); if (!(b > 0)) continue; const m = deposits.get(x.borrower) || {}; m[w.token] = { balance: b, spendable: s || 0 }; deposits.set(x.borrower, m); }
  }
  const st = await query(cfg.market, { state: {} });
  return { version: VERSION, cfg, whitelist, decimals, decSrc, prices, priceSrc, locked, loans, deposits, limits: new Map(), total_liabilities_raw: st ? num(st.total_liabilities) : null,
    complete: !errors.length, errors, stats: { collateral_rows: ac.rows.length, collateral_pages: ac.pages, loan_rows: bi.rows.length, borrowers_with_loan: loans.size, custodies: custodyStats } };
}

// the protocol's own limit for the wallets that have a loan (only those — the census has no limit field)
async function loadLimits(query, cfg, census, wallets) {
  let read = 0, failed = 0;
  for (const w of wallets) { if (!census.loans.has(w)) continue; const r = await query(cfg.overseer, { borrow_limit: { borrower: w } }); if (r && r.borrow_limit != null) { census.limits.set(w, num(r.borrow_limit)); read++; } else failed++; }
  return { read, failed };
}

// one wallet's position (pure). null = nothing in Solid (no card — never "$0").
function positionOf(wallet, C) {
  const L = C.locked.get(wallet) || {}, D = C.deposits.get(wallet) || {}, loanRaw = C.loans.get(wallet) || 0;
  const tokens = [...new Set([...Object.keys(L), ...Object.keys(D)])]; if (!tokens.length && !loanRaw) return null;
  const sDec = C.decimals.get(C.cfg.stable); const sPx = C.prices.get(C.cfg.stable);
  const collateral = tokens.map(t => {
    const w = C.whitelist.find(x => x.token === t) || { symbol: null, max_ltv: null }; const dec = C.decimals.get(t); const px = C.prices.get(t);
    const lockedRaw = L[t] || 0, dep = D[t] || null; const idleRaw = dep ? dep.spendable : 0;   // deposited but not locked = spendable in the custody
    const h = (r) => dec != null ? r / Math.pow(10, dec) : null;
    const lk = h(lockedRaw), idle = h(idleRaw);
    return { token: t, symbol: w.symbol, max_ltv: w.max_ltv, decimals: dec, price_usd: px != null ? px : null, price_src: C.priceSrc.get(t) || null,
      locked: lk, locked_usd: lk != null && px != null ? lk * px : null, idle: idle, idle_usd: idle != null && px != null ? idle * px : null, deposited: dep ? h(dep.balance) : lk };
  }).sort((a, b) => (b.locked_usd || 0) - (a.locked_usd || 0));
  const debt = sDec != null ? loanRaw / Math.pow(10, sDec) : null;
  const lockedUsd = collateral.reduce((x, c) => x + (c.locked_usd || 0), 0), idleUsd = collateral.reduce((x, c) => x + (c.idle_usd || 0), 0);
  const computed = collateral.reduce((x, c) => x + (c.locked_usd || 0) * (c.max_ltv || 0), 0);   // USD ≈ SOLID for the limit (the protocol compares in uusd)
  const protoRaw = C.limits.get(wallet); const limit = protoRaw != null && sDec != null ? protoRaw / Math.pow(10, sDec) : computed;
  const hasCollateral = collateral.some(c => (c.locked || 0) > 0);
  // 1.0.1: a loan with NO collateral left (59 wallets in the full census) = SOLID still owed after a liquidation took everything — its own
  // state, not "health 0 / liquidatable" (there is nothing left to liquidate)
  const health = debt > 0 && limit != null && hasCollateral ? limit / debt : null;
  const priced = collateral.filter(c => (c.locked || 0) > 0);
  let liquidation = null;
  if (health != null) {
    if (priced.length === 1 && priced[0].price_usd != null) liquidation = { kind: 'single', symbol: priced[0].symbol, price_now: priced[0].price_usd, price_at: priced[0].price_usd / health, drop_pct: 1 - 1 / health };
    else liquidation = { kind: 'basket', drop_pct: 1 - 1 / health };
  }
  const unpriced = collateral.filter(c => c.price_usd == null).map(c => c.symbol || c.token);
  return { collateral, debt_solid: debt, debt_usd: debt != null && sPx != null ? debt * sPx : debt, solid_price_usd: sPx != null ? sPx : null,
    borrow_limit_solid: limit, borrow_limit_src: protoRaw != null ? 'protocol' : 'computed (locked × max LTV at the oracle)', health,
    band: debt > 0 && !hasCollateral ? 'debt_no_collateral' : health == null ? null : health < 1 ? 'liquidatable' : health < 1.2 ? 'at_risk' : health < 1.5 ? 'watch' : 'safe',
    liquidation, collateral_usd: lockedUsd, idle_usd: idleUsd, net_usd: lockedUsd + idleUsd - (debt != null ? debt * (sPx != null ? sPx : 1) : 0),
    unpriced: unpriced.length ? unpriced : undefined, source: 'solid census (' + VERSION + ') — Solid’s own oracle' };
}

// the protocol in one line per collateral (for the page's context and the history)
function protocolSummary(C) {
  const by = {}; for (const [, m] of C.locked) for (const [t, a] of Object.entries(m)) by[t] = (by[t] || 0) + a;
  return { total_liabilities_solid: C.total_liabilities_raw != null && C.decimals.get(C.cfg.stable) != null ? C.total_liabilities_raw / Math.pow(10, C.decimals.get(C.cfg.stable)) : null,
    borrowers_with_loan: C.loans.size, wallets_with_collateral: C.locked.size,
    collateral: C.whitelist.map(w => { const d = C.decimals.get(w.token); const amt = by[w.token] != null && d != null ? by[w.token] / Math.pow(10, d) : 0; const px = C.prices.get(w.token);
      return { symbol: w.symbol, token: w.token, max_ltv: w.max_ltv, locked: amt, price_usd: px != null ? px : null, locked_usd: px != null ? amt * px : null }; }),
    solid_price_usd: C.prices.get(C.cfg.stable) != null ? C.prices.get(C.cfg.stable) : null, complete: C.complete, errors: C.errors.length ? C.errors : undefined };
}

module.exports = { VERSION, PAGE_LIMIT, pageAll, loadCensus, loadLimits, positionOf, protocolSummary };
