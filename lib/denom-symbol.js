// lib/denom-symbol.js — 1.0.0 (2026-09-17) — THE ONE denom → symbol resolver for every cron that writes a priced record.
//
// Doctrine: a token's identity is read from the token-catalog's `effective` layer (its stated downstream contract),
// never from a hand map. Hand maps rot per page and per cron (seven of them on the site alone, each wrong in its own
// way: a Boost listing in native:uluna rendered with no token; an ampLUNA listing showed as LUNA). This module is
// collection-agnostic and venue-agnostic: a denom is a denom whoever emitted it.
//
// Spellings normalised: "uluna" · "native:uluna" · "cw20:terra1…" · bare "terra1…" (58 chars) · "ibc/…" · "factory/…".
// Unknown → null (never guessed) with the reason on the result, so a record says `denom_symbol: null,
// denom_symbol_reason: 'not_in_token_catalog'` and the gate can count them.
'use strict';
const CW20 = /^terra1[0-9a-z]{58}$/;
function bare(d) { let s = String(d || '').trim(); if (s.startsWith('cw20:')) s = s.slice(5); if (s.startsWith('native:')) s = s.slice(7); return s; }
// tokens: the token-catalog `tokens` array (or a whole catalog doc). Returns a resolver.
function buildResolver(catalog) {
  const tokens = Array.isArray(catalog) ? catalog : (catalog && Array.isArray(catalog.tokens)) ? catalog.tokens : [];
  const by = new Map();
  for (const t of tokens) {
    if (!t || !t.denom) continue;
    const e = t.effective || {}, g = t.discovered || {};
    const symbol = e.symbol || g.symbol || null; if (!symbol) continue;
    const decimals = e.decimals != null ? e.decimals : (g.decimals != null ? g.decimals : 6);
    by.set(bare(t.denom), { symbol, decimals, source: e.symbol ? 'token-catalog:effective' : 'token-catalog:discovered' });
  }
  const resolve = (denom) => {
    if (!denom) return { symbol: null, decimals: null, reason: 'no_denom' };
    const b = bare(denom); const hit = by.get(b);
    if (hit) return { symbol: hit.symbol, decimals: hit.decimals, source: hit.source };
    if (b === 'uluna') return { symbol: 'LUNA', decimals: 6, source: 'native' };   // the chain's own coin is not a catalog opinion
    return { symbol: null, decimals: CW20.test(b) ? 6 : null, reason: 'not_in_token_catalog' };
  };
  resolve.size = by.size;
  return resolve;
}
// Stamp a record in place: denom_symbol / denom_decimals (+ reason when unknown). Never overwrites a symbol already set
// by the same catalog rule; never invents one. Returns true when it changed the record.
function stampRecord(rec, denom, resolve) {
  if (!rec || !denom) return false;
  const r = resolve(denom);
  const before = rec.denom_symbol;
  if (r.symbol) { rec.denom_symbol = r.symbol; rec.denom_decimals = r.decimals; delete rec.denom_symbol_reason; }
  else { if (rec.denom_symbol == null) { rec.denom_symbol = null; rec.denom_symbol_reason = r.reason; } }
  return rec.denom_symbol !== before;
}
// Stable-coin rule for USD (1:1) — by SYMBOL from the catalog, never by denom string, so a new USDC (USDC.inj) is
// covered the day the catalog names it a stable.
const STABLE_SYMBOLS = new Set(['USDC', 'USDC.n', 'USDC.inj', 'axlUSDC', 'USDT', 'USDt', 'SOLID', 'EURe']);
const isStableSymbol = (s) => !!s && STABLE_SYMBOLS.has(String(s));
module.exports = { buildResolver, stampRecord, bare, isStableSymbol, STABLE_SYMBOLS, VERSION: '1.0.0' };
