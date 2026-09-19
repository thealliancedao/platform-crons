'use strict';
// nfts/nft-flows/lib/oracle-usd.js 1.0.0 (2026-09-19) — THE ONE "USD at the day" rule for every NFT ledger record.
//
// Moved out of nft-flows/index.js 1.3.0, byte-for-byte in behaviour (gate: mock-run.js 55/55 unchanged). It exists as a
// file so the two writers of a ledger share it without a copy: the Render cron (org-nft-flows-<slug>, forward capture and
// the reprice pass) requires it beside itself; the nft-collections derive Action (nft-flows-derive.yml / -forward.yml)
// checks platform-crons out at run time and requires it from there. Same file, same rule, one place to change it.
//
// Doctrine (owner, 2026-09-18): past prices come ONLY from the org price oracle tla-core/price-history/YYYY/MM.json —
// every catalog symbol, daily since 2022-05; a per-collection copy of a series is a copy, and copies disagree. Symbols
// come from the token-catalog `effective` layer through lib/denom-symbol.js, never a hand map. Blank beats phantom: a
// day the oracle has not written yet, or a symbol it never carried, prices to null WITH the reason on the record.
//
//   const O = makeOracle({ fetchMonth: async (mk) => <the month doc or throw>, resolve: () => RESOLVE });
//   await O.loadMonth('2026/09');            // read once, cached until dropMonth (the caller decides the heap footprint)
//   Object.assign(rec, O.usdAt(rec.price, rec.ts));   // month must be loaded — the caller is on that ledger month
//   O.dropMonth('2026/09');                  // read → price → drop (Render ~256 MB heap; the Action runner does not care)
//
//   fetchMonth(mk)  — 'YYYY/MM' → the oracle month document ({ days: { 'YYYY-MM-DD': { SYM: { usd, src } } } }); throw → absent
//   resolve()       — returns the current denom → { symbol, decimals } resolver (DS.buildResolver) or null while unavailable
const DS = require('../../../lib/denom-symbol.js');   // THE denom → symbol resolver (token-catalog effective layer)

const monthOf = (day) => String(day).slice(0, 7).replace('-', '/');

function makeOracle({ fetchMonth, resolve }) {
  const ORACLE = {};          // 'YYYY/MM' → month doc | null (absent)
  let LATEST = null;          // the latest day any loaded month has (a day after it is "not yet written", not "missing")
  const symOf = (denom) => { const R = resolve ? resolve() : null; return R ? R(denom) : { symbol: denom === 'uluna' ? 'LUNA' : null, decimals: 6, reason: 'catalog_unavailable' }; };
  async function loadMonth(mk) {
    if (mk in ORACLE) return ORACLE[mk];
    try { ORACLE[mk] = await fetchMonth(mk); } catch (e) { ORACLE[mk] = null; }
    const days = ORACLE[mk] && ORACLE[mk].days ? Object.keys(ORACLE[mk].days).sort() : []; const last = days[days.length - 1];
    if (last && (!LATEST || last > LATEST)) LATEST = last;
    return ORACLE[mk];
  }
  function dropMonth(mk) { delete ORACLE[mk]; }
  function usdAt(price, ts) {
    if (!price || price.amount == null || !price.denom) return { usd: null, usd_reason: 'no_price' };
    const day = String(ts).slice(0, 10); const s = symOf(price.denom); const dec = s.decimals != null ? s.decimals : 6; const amt = Number(price.amount) / Math.pow(10, dec);
    if (!s.symbol) return { usd: null, usd_reason: 'no_usd_series_for_denom:' + price.denom, denom_symbol: null, denom_symbol_reason: s.reason || 'not_in_token_catalog' };
    const base = { denom_symbol: s.symbol, denom_decimals: dec };
    const mk = monthOf(day); const month = ORACLE[mk];   // preloaded by the caller for the month in hand
    const cell = month && month.days && month.days[day] && month.days[day][s.symbol];
    if (cell && cell.usd != null) { const out = Object.assign(base, { usd: amt * Number(cell.usd), usd_basis: 'price-history:' + day + (cell.src ? ' (' + cell.src + ')' : ''), unit_usd: Number(cell.usd) }); if (s.symbol === 'LUNA') out.luna_usd = Number(cell.usd); return out; }
    if (DS.isStableSymbol(s.symbol)) return Object.assign(base, { usd: amt, usd_basis: 'stable_1_1' });   // the oracle has no row for it that day: a stable is a dollar
    if (!month) return Object.assign(base, { usd: null, usd_reason: (LATEST && day > LATEST) ? 'price_history_not_yet_written:' + day : 'price_history_month_missing:' + mk });
    if (LATEST && day > LATEST) return Object.assign(base, { usd: null, usd_reason: 'price_history_not_yet_written:' + day });   // same-day: waits for the oracle's next append
    return Object.assign(base, { usd: null, usd_reason: 'price_history_missing:' + s.symbol + ':' + day });   // the oracle has the day but not this symbol
  }
  return {
    usdAt, loadMonth, dropMonth, monthOf, symOf,
    latest: () => LATEST,
    loaded: () => Object.keys(ORACLE),                       // every month key seen (present or absent)
    anyLoaded: () => Object.keys(ORACLE).some(k => ORACLE[k]),
    month: (mk) => ORACLE[mk],
  };
}
module.exports = { makeOracle, monthOf, VERSION: '1.0.0' };
