'use strict';
// =============================================================================
// member-data / history-tokens.js 1.0.0 (2026-10-13) — every wallet's tokens BY PLACE, one row a day.
// -----------------------------------------------------------------------------
// Why (owner 2026-10-13, Rallies' Home chart): "LUNA — luna held liquid, staked on chain, underlying in locks, in Votion, backing aDAO
// NFTs, staked in LPs … if you select CAPA, ROAR it will track ALL the balances". history-series (one USD row a day) answers "how much";
// this answers "of what, and where". It is the one history both Rallies and the aDAO dashboard read — the live point stays live in each app.
//
// Folded, never captured: every input is an archive another duty already writes.
//   member-data/participants/daily/<d>  locks · TLA LPs (pool share of each token) · pending rewards / rebase / bribes · LUNA-family natives
//                                       in the wallet · receipts a custodian holds (the ampCAPA DAO)                          → cov 'p'
//   member-data/positions/daily/<d>     the same record for registered members the lock census does not carry                → cov 'p'
//   member-data/holdings/daily/<d>      every wallet token, LUNA with validators, CAPA / ROAR governance, aDAO NFT backing     → cov 'h'
//                                       (from 2026-10-13; on an 'h' day the wallet comes from here, not from the TLA capture)
//   votion/snapshots/daily/<d>          LUNA under each Votion vault receipt (underlying LST × the vault's hub rate)          → cov 'v'
//   token-catalog/supply/capa/wallets-daily/<d>  a ≥10K-CAPA wallet's CAPA in every form — on a day WITHOUT holdings, what it shows beyond
//                                       the LP / DAO places is recorded as place 'cs' (CAPA elsewhere: wallet, governance, liquid ampCAPA) → cov 'c'
//   price-history/ratios/<yyyy>/<mm>    that day's LST ratios: ampLUNA / arbLUNA / bLUNA → LUNA, ampCAPA → CAPA, ampROAR → ROAR. A token
//                                       with no ratio stays itself (zLUNA, LunaX …) — never converted at a guessed rate.
//
// Output (tla-core):
//   member-data/history/tokens/<c>.json   { schemaVersion, product, shard, places, wallets: { <addr>: [[d, cov, { <SYM>: { <place>: amount } }], …] } }
//   member-data/history/tokens/index.json { version, places, first_day, last_day, days, wallets, shards, symbols, sources, note }
// Amounts are human units of the BASE token (after the day's ratio). Places:
//   w  wallet (liquid)        ls  wallet, liquid-staked (converted)   st  staked with validators (incl. unbonding)
//   lk TLA locks              lp  TLA LP positions (pool share)        dao held for the wallet by a custodian (the ampCAPA DAO)
//   gov governance stakes     nft aDAO NFT backing                     rw  pending rewards, rebase, bribes
//   vt Votion vaults          cs  CAPA elsewhere per the CAPA census (only on a day without holdings)
// Blank beats phantom: a place the day's inputs did not cover is ABSENT (read cov), never 0. Shards and the 32-character rule match
// history-series, so a reader fetches one ~small file for a wallet's whole history.
// =============================================================================
const VERSION = 'history-tokens-1.0.0';
const OUT_DIR = 'member-data/history/tokens';
const FIRST_ARCHIVE_DAY = '2026-08-11';
const PLACES = ['w', 'ls', 'st', 'lk', 'lp', 'dao', 'gov', 'nft', 'rw', 'vt', 'cs'];
const PLACE_NAMES = { w: 'wallet', ls: 'wallet, liquid-staked', st: 'staked with validators', lk: 'TLA locks', lp: 'TLA LPs', dao: 'held by a custodian (ampCAPA DAO)',
  gov: 'governance stakes', nft: 'aDAO NFT backing', rw: 'pending rewards', vt: 'Votion', cs: 'CAPA elsewhere (CAPA census, before holdings)' };
const SHARD_CHARS = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const shardOf = (addr) => { const c = String(addr || '').charAt(6); return SHARD_CHARS.includes(c) ? c : '_'; };
const num = (x) => (x == null || x === '' || !isFinite(Number(x))) ? null : Number(x);
const sig = (x) => Number(Number(x).toPrecision(8));
const dayList = (from, to) => { const out = []; for (let t = Date.parse(from + 'T00:00:00Z'); t <= Date.parse(to + 'T00:00:00Z'); t += 864e5) out.push(new Date(t).toISOString().slice(0, 10)); return out; };

// ── a day's tokens for one wallet (pure) ────────────────────────────────────────────────────────────────────────────
// ratios: { <LST symbol>: { ratio, base } } for that day · dec(denomOrGaugeId) → { symbol, decimals } | null
function makeBag(ratios, norm = (s) => s) {
  const bag = {};
  const add = (sym0, place, amount) => {
    const a = num(amount); const sym = sym0 && norm(sym0); if (!sym || a == null || !(a > 0)) return;
    const r = ratios[sym]; const base = r && r.ratio > 0 ? r.base : sym; const v = r && r.ratio > 0 ? a * r.ratio : a;
    const pl = (place === 'w' && r && r.ratio > 0) ? 'ls' : place;
    const t = bag[base] || (bag[base] = {}); t[pl] = (t[pl] || 0) + v;
  };
  const done = () => { for (const t of Object.values(bag)) for (const k of Object.keys(t)) t[k] = sig(t[k]); return bag; };
  return { add, done, bag };
}
// the pool snapshot names some pool tokens loosely ('WBTC', 'SOL', 'USDC') — the pool's own name says which (LUNA-WBTC.axl → WBTC.axl).
// A token the catalog knows keeps its name; the pool-name parts left over go, in order, to the ones it does not.
function lpNames(poolName, syms, isSym) {
  const parts = String(poolName || '').split('-').filter(isSym); const used = new Set(syms.filter(isSym));
  const left = parts.filter(x => !used.has(x));
  return syms.map(s => isSym(s) ? s : (left.length ? left.shift() : s));
}
function tlaInto(add, m, dec, withWallet, isSym = () => true) {
  if (withWallet) for (const b of m.wallet_balances || []) add((dec(b.denom) || {}).symbol || b.symbol, 'w', b.amount_human);
  for (const l of m.locks || []) { const ai = l.asset_info || {}; add((dec(ai.cw20 ? 'cw20:' + ai.cw20 : ai.native) || {}).symbol || l.asset_symbol, 'lk', l.amount_human); }
  for (const p of m.lp_positions || []) {
    const u = p.underlying_token_amounts || [];
    if (u.length) { const names = lpNames(p.pool_name, u.map(x => x.symbol), isSym); u.forEach((x, i) => add(names[i], 'lp', x.amount_human)); continue; }
    // a single-asset pool: the position IS the token — its raw amount over the token's decimals (the catalog's, by gauge id)
    const t = dec(p.pool_gauge_id); const sym = (t && t.symbol) || p.pool_name; const d = t && t.decimals != null ? t.decimals : null;
    const raw = p.is_amplified ? num(p.user_lp_raw) : num(p.amplp_balance_raw);
    if (sym && raw != null && d != null) add(sym, 'lp', raw / Math.pow(10, d));
  }
  for (const r of m.pending_rewards || []) add(r.reward_symbol, 'rw', r.amount_human);
  if (m.pending_rebase) add(m.pending_rebase.asset_symbol, 'rw', m.pending_rebase.amount_human);
  for (const b of m.pending_bribes || []) add(b.asset_symbol, 'rw', b.amount_human);
  for (const c of m.custody || []) add(c.unit, 'dao', c.amount);
}
function holdingsInto(add, h) {
  for (const [sym, a] of Object.entries(h.tokens || {})) add(sym, 'w', a);
  if (h.staked && h.staked.LUNA) { add('LUNA', 'st', h.staked.LUNA.delegated); add('LUNA', 'st', h.staked.LUNA.unbonding); }
  for (const g of Object.values(h.gov || {})) if (g) { add(g.token, 'gov', g.staked); add(g.token, 'gov', g.unstaking); }
  if (h.nft && h.nft.backing) add(h.nft.backing.token, 'nft', h.nft.backing.amount);
}

// ── fold one day (pure given its inputs) ────────────────────────────────────────────────────────────────────────────
// inp: { parts, members, holdings, votion, capa: { rows } | null, ratios, dec }
function foldDay(state, day, inp) {
  const recs = new Map();   // addr → { m, src }
  for (const m of (inp.parts && inp.parts.members) || []) if (m && m.wallet && !recs.has(m.wallet)) recs.set(m.wallet, m);
  const M = inp.members || {};
  for (const m of [...(M.members || []), M.treasury, ...(M.treasuries || []), ...(M.council || []), ...(M.council_treasuries || [])]) if (m && m.wallet && !recs.has(m.wallet)) recs.set(m.wallet, m);
  const H = (inp.holdings && inp.holdings.wallets) || {};
  const vot = new Map();
  for (const v of (inp.votion && inp.votion.vaults) || []) { const k = num(v.lst_luna_hub_rate); if (!(k > 0)) continue;
    for (const h of v.holders || []) { const a = num(h.underlying_lst); if (a > 0) vot.set(h.address, (vot.get(h.address) || 0) + a * k); } }
  const addrs = new Set([...recs.keys(), ...Object.keys(H)]);
  let n = 0;
  for (const addr of addrs) {
    const m = recs.get(addr), h = H[addr];
    const { add, done } = makeBag(inp.ratios || {}, inp.norm);
    let cov = '';
    if (m) { tlaInto(add, m, inp.dec || (() => null), !h, inp.isSym); cov += 'p'; }
    if (h) { holdingsInto(add, h); cov += 'h'; }
    if (inp.votion) { const l = vot.get(addr); if (l > 0) add('LUNA', 'vt', l); cov += 'v'; }
    const bag = done();
    if (!h && inp.capa && inp.capa.rows) {
      const r = inp.capa.rows[addr]; const total = r ? num(r[0]) : null;
      if (total != null) { const c = bag.CAPA || {}; const known = (c.lp || 0) + (c.dao || 0); const rest = total - known;
        if (rest > Math.max(1, total * 1e-6)) { (bag.CAPA = c).cs = sig(rest); } cov += 'c'; }
    }
    const w = state.wallets.get(addr) || state.wallets.set(addr, new Map()).get(addr);
    w.set(day, [day, cov, bag]); n++;
  }
  return n;
}

function buildFiles(state, meta) {
  const shards = new Map(); let first = null, last = null; const days = new Set(); const syms = new Set();
  for (const [addr, byDay] of [...state.wallets].sort(([a], [b]) => a.localeCompare(b))) {
    const rows = [...byDay.values()].sort((a, b) => a[0].localeCompare(b[0]));
    for (const r of rows) { days.add(r[0]); if (!first || r[0] < first) first = r[0]; if (!last || r[0] > last) last = r[0]; for (const s of Object.keys(r[2])) syms.add(s); }
    const c = shardOf(addr); const sh = shards.get(c) || shards.set(c, {}).get(c); sh[addr] = rows;
  }
  const files = [];
  for (const [c, wallets] of [...shards].sort(([a], [b]) => a.localeCompare(b))) files.push({ path: `${OUT_DIR}/${c}.json`, obj: { schemaVersion: 1, product: 'member-data/history/tokens', shard: c, places: PLACES, wallets } });
  const symbols = {}; for (const s of [...syms].sort()) symbols[s] = meta.denomOf ? meta.denomOf(s) : null;
  const index = { schemaVersion: 1, product: 'member-data/history/tokens', version: VERSION, generated_at: meta.now, places: PLACES, place_names: PLACE_NAMES,
    cov: { p: 'the TLA capture (participants / member archive): w (LUNA-family natives only when h is absent) · lk · lp · rw · dao', h: 'holdings: w (every token) · st · gov · nft', v: 'Votion: vt', c: 'CAPA census: cs' },
    first_day: first, last_day: last, days: days.size, wallets: state.wallets.size, shards: Object.fromEntries([...shards].map(([c, w]) => [c, Object.keys(w).length])),
    shard_rule: 'the character after "terra1" (bech32); anything else → "_"', symbols,
    sources: { p: 'member-data/participants/daily + member-data/positions/daily', h: 'member-data/holdings/daily (from 2026-10-13)', v: 'votion/snapshots/daily', c: 'token-catalog/supply/capa/wallets-daily', ratios: 'price-history/ratios/<yyyy>/<mm>.json' },
    note: 'Human units of the base token after that day\'s LST ratio. A place the day did not cover is absent — read cov, never assume 0. One row per wallet per archived day; no interpolation.' };
  files.push({ path: `${OUT_DIR}/index.json`, obj: index });
  return { files, index };
}

async function loadState(fetchJson, rawBase, index) {
  const state = { wallets: new Map() };
  for (const c of Object.keys(index.shards || {})) {
    const f = await fetchJson(`${rawBase}/${OUT_DIR}/${c}.json?t=${Date.now()}`).catch(() => null); if (!f) continue;
    for (const [addr, rows] of Object.entries(f.wallets || {})) state.wallets.set(addr, new Map(rows.map(r => [r[0], r])));
  }
  return state;
}

// symbols as the catalog spells them: exact, else a unique case-insensitive match (the TLA capture writes 'zluna' for the catalog's 'zLUNA')
function symbolNormalizer(cat, resolve) {
  const exact = new Set(), lower = new Map();
  for (const x of (cat && (cat.tokens || cat)) || []) { const e = (x && x.effective) || {}; const s = e.symbol || ((x && x.discovered) || {}).symbol; if (!s) continue; exact.add(s); const k = s.toLowerCase(); lower.set(k, lower.has(k) && lower.get(k) !== s ? null : s); }
  const norm = (s) => { if (exact.has(s)) return s;
    if (/^[0-9A-F]{64}$/.test(String(s)) && resolve) { const r = resolve('ibc/' + s); if (r && r.symbol) return r.symbol; }   // a bribe named by its ibc hash
    return lower.get(String(s).toLowerCase()) || s; };
  norm.isSym = (s) => exact.has(s);
  return norm;
}
// that day's ratios from the month file(s): the day itself, else the nearest earlier day within 7 days
function ratiosFor(day, months) {
  const out = {};
  for (let i = 0; i <= 7; i++) {
    const d = new Date(Date.parse(day + 'T00:00:00Z') - i * 864e5).toISOString().slice(0, 10);
    const mf = months.get(d.slice(0, 7)); const row = mf && mf.days && mf.days[d]; if (!row) continue;
    for (const [sym, x] of Object.entries(row)) if (!out[sym] && num(x && x.ratio) > 0 && x.base) out[sym] = { ratio: num(x.ratio), base: x.base };
  }
  return out;
}

// deps: { fetchJson(url) → obj (throws on 404), publishBatch(files, message), rawBase, env, now() }
async function run(deps) {
  const { fetchJson, publishBatch, rawBase, env = {}, now = () => new Date() } = deps; const log = deps.log || console.log;
  if (env.HISTORY_TOKENS === '0' || env.HISTORY === '0') { log('  history-tokens: disabled'); return { status: 'skipped', reason: 'disabled' }; }
  const t = now(); const today = t.toISOString().slice(0, 10);
  let index = env.HISTORY_TOKENS === 'force' ? null : await fetchJson(`${rawBase}/${OUT_DIR}/index.json?t=${Date.now()}`).catch(() => null);
  if (index && index.version !== VERSION) { log(`  history-tokens: built by ${index.version} — rebuilding with ${VERSION}`); index = null; }
  // seed every archived day; after that refold the last recorded day (its archive may have been rewritten since) through today
  const from = index ? index.last_day : FIRST_ARCHIVE_DAY;
  if (index && index.last_day === today && !(t.getUTCHours() === 23 || env.HISTORY_TOKENS === '1')) { log(`  history-tokens: up to date (${today}); today refolds at 23:xx UTC`); return { status: 'skipped', reason: 'up to date' }; }
  const state = index ? await loadState(fetchJson, rawBase, index) : { wallets: new Map() };
  const g = (p) => fetchJson(`${rawBase}/${p}?t=${Date.now()}`).catch(() => null);
  let resolve = null; { const cat = await g('token-catalog/snapshots/current.json'); if (cat) resolve = require('../lib/denom-symbol.js').buildResolver(cat); }
  const dec = (id) => { if (!resolve || !id) return null; const r = resolve(String(id)); return r && r.symbol ? r : null; };
  const norm = symbolNormalizer(await g('token-catalog/snapshots/current.json'), resolve);
  const bySym = new Map(); if (resolve) { const cat = await g('token-catalog/snapshots/current.json'); for (const x of (cat && (cat.tokens || cat)) || []) { const e = (x && x.effective) || {}; const s = e.symbol || (x.discovered || {}).symbol; if (s && x.denom && !bySym.has(s)) bySym.set(s, x.denom); } }
  if (!bySym.has('LUNA')) bySym.set('LUNA', 'uluna');
  const months = new Map(); const capaIdx = await g('token-catalog/supply/capa/wallets-daily/index.json');
  const capaDays = ((capaIdx && capaIdx.days) || []).map(d => d.date).sort();
  let folded = 0; const gaps = [];
  for (const day of dayList(from, today)) {
    for (let i = 0; i <= 7; i++) { const ym = new Date(Date.parse(day + 'T00:00:00Z') - i * 864e5).toISOString().slice(0, 7); if (!months.has(ym)) months.set(ym, await g(`price-history/ratios/${ym.slice(0, 4)}/${ym.slice(5, 7)}.json`)); }
    const parts = await g(`member-data/participants/daily/${day}.json`);
    const members = await g(`member-data/positions/daily/${day}.json`);
    const holdings = day >= '2026-10-13' ? await g(`member-data/holdings/daily/${day}.json`) : null;
    if (!parts && !members && !holdings) { gaps.push(day); continue; }
    const votion = await g(`votion/snapshots/daily/${day}.json`);
    let capa = null; { const prev = capaDays.filter(d => d <= day).pop(); if (prev && Date.parse(day) - Date.parse(prev) <= 3 * 864e5) capa = await g(`token-catalog/supply/capa/wallets-daily/${prev}.json`); }
    const n = foldDay(state, day, { parts, members, holdings, votion, capa, ratios: ratiosFor(day, months), dec, norm, isSym: norm.isSym });
    folded++; log(`  history-tokens: ${day} — ${n} wallets${holdings ? ' · holdings' : ''}${votion ? '' : ' · no Votion'}${capa ? '' : ' · no CAPA census'}`);
  }
  if (!folded) return { status: 'skipped', reason: 'no archive', gaps };
  const { files, index: ix } = buildFiles(state, { now: t.toISOString(), denomOf: (s) => bySym.get(s) || null });
  const out = files.map(f => ({ path: f.path, content: JSON.stringify(f.obj) + '\n' }));
  const r = publishBatch ? await publishBatch(out, `member-data: history tokens ${from === today ? today : from + ' → ' + today} (${ix.wallets} wallets, ${ix.days} days)`) : null;
  log(`  history-tokens: ${ix.wallets} wallets × ${ix.days} days (${ix.first_day} → ${ix.last_day}) in ${files.length - 1} shards${r && r.commit ? ' · commit ' + String(r.commit).slice(0, 7) : ''}`);
  return { status: 'ok', folded, gaps, index: ix, files: out };
}

module.exports = { VERSION, PLACES, PLACE_NAMES, OUT_DIR, FIRST_ARCHIVE_DAY, shardOf, symbolNormalizer, lpNames, makeBag, tlaInto, holdingsInto, foldDay, buildFiles, ratiosFor, run };
