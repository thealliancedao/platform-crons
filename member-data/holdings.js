'use strict';
// =============================================================================
// member-data / holdings.js 1.0.0 (2026-10-13) — what every participant holds OUTSIDE TLA, once a day.
// -----------------------------------------------------------------------------
// Why (owner 2026-10-13: build out the alliance DAO repo as the data layer and history layer for wallets, so
// the aDAO dashboard and other apps read a single source of truth): the TLA capture (capture-engine) reads locks, LPs, rewards and
// the LUNA-family natives in a wallet — not the wallet's cw20 tokens, LUNA staked with validators, CAPA / ROAR staked for governance, or
// the LUNA backing inside aDAO NFTs. Apps read those live for "now"; this records them per day so the past has them too.
//
// Reads per wallet (bounded concurrency, publicnode): bank balances (all natives, named by the token catalog) · one cw20 `balance` per
// HOLDINGS.cw20 token · delegations + unbonding (staking LCD) · CAPA governance `staker` · ROAR `staked_balance_at_height` + `claims`.
// The aDAO NFT backing is a JOIN on the NFT inventory (no chain reads): unbroken NFTs whose real owner is the wallet, held or staked.
// ~19 reads a wallet → ~4,000 for 210 participants, once a day (the 23:xx run) — never hourly.
//
// Blank beats phantom: a read that FAILED is null with the reason in `errors`, never 0; a read that answered empty is 0 / absent.
//
// Output (tla-core):
//   member-data/holdings/daily/<date>.json   { schemaVersion, product, version, capturedAt, date, sources, stats, wallets: { <addr>: rec } }
//   member-data/holdings/current.json        the same, the latest day
//   member-data/holdings/heartbeat.json
// rec = { tokens: { <symbol>: amount }            liquid in the wallet (natives + tracked cw20), human units, by catalog symbol
//         unknown: { <denom>: raw }               natives the catalog cannot name (kept raw, never guessed)
//         staked: { LUNA: { delegated, unbonding } }   LUNA with validators
//         gov: { <key>: { token, staked, unstaking } }  governance stakes (capa-gov · roar-stake)
//         nft: { held, staked, listed, unbroken, broken, backing: { token: 'ampLUNA', amount } }   aDAO; backing = held+staked unbroken
//         errors: [ '<what>: <why>' ] }
// =============================================================================
const VERSION = 'holdings-1.0.0';
const OUT_DIR = 'member-data/holdings';
const C = require('../config/contracts.js');
const H = C.HOLDINGS;

const num = (x) => (x == null || x === '' || !isFinite(Number(x))) ? null : Number(x);
const human = (raw, dec) => { const n = num(raw); return n == null ? null : n / Math.pow(10, dec); };
const r8 = (x) => (x == null || !isFinite(x)) ? null : Number(x.toPrecision(10));

// ── pure parsers (gated on the chain probe fixtures' shapes) ──────────────────────────────────────────────────────
function parseCw20Balance(d) { const b = d && d.balance; return /^\d+$/.test(String(b)) ? String(b) : null; }
function parseCapaGov(d) { const b = d && d.balance; return /^\d+$/.test(String(b)) ? String(b) : null; }
function parseCw20Stake(staked, claims) {
  const b = staked && staked.balance; const c = claims && claims.claims;
  if (!/^\d+$/.test(String(b)) || !Array.isArray(c)) return null;
  return { staked: String(b), unstaking: String(c.reduce((a, x) => a + (/^\d+$/.test(String(x && x.amount)) ? BigInt(x.amount) : 0n), 0n)) };
}
function parseDelegations(d) {
  const r = d && d.delegation_responses; if (!Array.isArray(r)) return null;
  return r.reduce((a, x) => a + ((x && x.balance && x.balance.denom === 'uluna' && /^\d+$/.test(String(x.balance.amount))) ? BigInt(x.balance.amount) : 0n), 0n);
}
function parseUnbonding(d) {
  const r = d && d.unbonding_responses; if (!Array.isArray(r)) return null;
  let s = 0n; for (const u of r) for (const e of (u && u.entries) || []) if (/^\d+$/.test(String(e && e.balance))) s += BigInt(e.balance);
  return s;
}
// natives → { tokens, unknown } named by the catalog resolver (lib/denom-symbol.js)
function nameNatives(balances, resolve) {
  const tokens = {}, unknown = {};
  for (const b of balances || []) {
    if (!b || !b.denom || !/^\d+$/.test(String(b.amount)) || b.amount === '0') continue;
    const r = resolve ? resolve(b.denom) : (b.denom === 'uluna' ? { symbol: 'LUNA', decimals: 6 } : { symbol: null });
    // the TLA capture's own rule for LUNA-family factory denoms the catalog may not list (zluna …): the last path segment, 6 decimals
    const fam = !(r && r.symbol) && /^factory\/.+\/(z|amp|b|st|arb)?luna$/i.test(b.denom) ? { symbol: b.denom.split('/').pop(), decimals: 6 } : null;
    const t = fam || r;
    if (t && t.symbol && t.decimals != null) tokens[t.symbol] = r8((tokens[t.symbol] || 0) + human(b.amount, t.decimals));
    else unknown[b.denom] = b.amount;
  }
  return { tokens, unknown };
}
// the aDAO NFT inventory → Map<wallet, { held, staked, listed, unbroken, broken }> (pure)
function nftIndex(inventory) {
  const recs = (inventory && (inventory.records || (inventory.data && inventory.data.records))) || [];
  const by = new Map();
  for (const r of recs) {
    if (!r || r.minted === false || r.unminted) continue;
    const who = r.real_owner || r.owner; if (!who || !/^terra1/.test(who)) continue;
    const listed = !!(r.listing || r.bbl_listed || r.atrium_listed || r.boost_listed);
    const staked = !listed && who !== r.owner;
    const x = by.get(who) || { held: 0, staked: 0, listed: 0, unbroken: 0, broken: 0 };
    if (listed) x.listed++; else if (staked) x.staked++; else x.held++;
    if (!listed) { if (r.broken) x.broken++; else x.unbroken++; }
    by.set(who, x);
  }
  return by;
}

// ── one wallet (deps: q(contract, msg) → data | null on failure · lcd(path) → json | null on failure) ───────────────
async function readWallet(addr, deps) {
  const { q, lcd, resolve, nfts, perNft } = deps;
  const rec = { tokens: {}, unknown: {}, staked: null, gov: {}, nft: null, errors: [] };
  // bank (paged to the end — a wallet can hold >100 denoms)
  let all = [], key = null, ok = true;
  for (let i = 0; i < 10; i++) {
    const j = await lcd(`/cosmos/bank/v1beta1/balances/${addr}?pagination.limit=500${key ? '&pagination.key=' + encodeURIComponent(key) : ''}`);
    if (!j || !Array.isArray(j.balances)) { ok = false; break; }
    all = all.concat(j.balances); key = j.pagination && j.pagination.next_key; if (!key) break;
  }
  if (ok) { const n = nameNatives(all, resolve); Object.assign(rec.tokens, n.tokens); rec.unknown = n.unknown; } else { rec.tokens = null; rec.errors.push('bank: no answer'); }
  // tracked cw20s
  for (const [sym0, t] of Object.entries(H.cw20)) {
    const named = resolve ? resolve('cw20:' + t.addr) : null; const sym = (named && named.symbol) || sym0;   // the catalog's spelling first
    const d = await q(t.addr, { balance: { address: addr } }); const raw = parseCw20Balance(d);
    if (raw == null) { rec.errors.push(`cw20 ${sym}: no answer`); if (rec.tokens) rec.tokens[sym] = rec.tokens[sym] != null ? rec.tokens[sym] : null; continue; }
    if (raw !== '0' && rec.tokens) rec.tokens[sym] = r8((rec.tokens[sym] || 0) + human(raw, t.decimals));
  }
  // LUNA with validators
  const [del, unb] = await Promise.all([lcd(`/cosmos/staking/v1beta1/delegations/${addr}?pagination.limit=200`), lcd(`/cosmos/staking/v1beta1/delegators/${addr}/unbonding_delegations?pagination.limit=200`)]);
  const dv = parseDelegations(del), uv = parseUnbonding(unb);
  if (dv == null || uv == null) rec.errors.push(`staking: ${dv == null ? 'delegations' : 'unbonding'} no answer`);
  else if (dv > 0n || uv > 0n) rec.staked = { LUNA: { delegated: r8(human(dv.toString(), 6)), unbonding: r8(human(uv.toString(), 6)) } };
  // governance stakes
  for (const g of H.gov) {
    if (g.kind === 'capa_gov') {
      const raw = parseCapaGov(await q(g.contract, { staker: { address: addr } }));
      if (raw == null) { rec.errors.push(`${g.key}: no answer`); rec.gov[g.key] = null; } else if (raw !== '0') rec.gov[g.key] = { token: g.token, staked: r8(human(raw, g.decimals)), unstaking: 0 };
    } else if (g.kind === 'cw20_stake') {
      const [s, c] = await Promise.all([q(g.contract, { staked_balance_at_height: { address: addr } }), q(g.contract, { claims: { address: addr } })]);
      const v = parseCw20Stake(s, c);
      if (v == null) { rec.errors.push(`${g.key}: no answer`); rec.gov[g.key] = null; } else if (v.staked !== '0' || v.unstaking !== '0') rec.gov[g.key] = { token: g.token, staked: r8(human(v.staked, g.decimals)), unstaking: r8(human(v.unstaking, g.decimals)) };
    }
  }
  // aDAO NFTs (a join — no chain reads)
  if (nfts) { const x = nfts.get(addr); if (x) rec.nft = { ...x, backing: perNft != null ? { token: H.nft.backing_token, amount: r8(x.unbroken * perNft) } : null }; }
  else rec.errors.push('nft: inventory unavailable');
  if (!rec.errors.length) delete rec.errors;
  if (rec.unknown && !Object.keys(rec.unknown).length) delete rec.unknown;
  if (rec.gov && !Object.keys(rec.gov).length) delete rec.gov;
  return rec;
}

// ── the duty ────────────────────────────────────────────────────────────────────────────────────────────────────────
// deps: { wallets: [addr], q, lcd, fetchJson(url), parallel(items, fn, n), concurrency, publish(path, content, message) | null, now() }
async function run(deps) {
  const { wallets, q, lcd, fetchJson, parallel, concurrency = 5, publish, now = () => new Date() } = deps; const log = deps.log || console.log;
  const t = now(); const date = t.toISOString().slice(0, 10);
  let resolve = null, catalogOk = false;
  try { const cat = await fetchJson('https://raw.githubusercontent.com/thealliancedao/tla-core/main/token-catalog/snapshots/current.json'); resolve = require('../lib/denom-symbol.js').buildResolver(cat || []); catalogOk = resolve.size > 0; } catch (e) { log('  ⚠ holdings: token catalog unavailable — natives other than LUNA kept raw'); }
  let nfts = null, perNft = null, nftAt = null;
  try {
    const raw = `https://raw.githubusercontent.com/${H.nft.repo}/main/`;
    const [inv, sum] = await Promise.all([fetchJson(raw + H.nft.inventory), fetchJson(raw + H.nft.summary)]);
    nfts = nftIndex(inv); perNft = num(sum && sum.backing && sum.backing.per_nft_ampluna); nftAt = (inv && inv.capturedAt) || null;
  } catch (e) { log('  ⚠ holdings: aDAO NFT inventory unavailable — nft left blank (' + e.message + ')'); }
  const uniq = [...new Set((wallets || []).filter(w => /^terra1[0-9a-z]{38}([0-9a-z]{20})?$/.test(w)))];
  const out = {}; let failed = 0;
  await parallel(uniq, async (w) => { const r = await readWallet(w, { q, lcd, resolve, nfts, perNft }); if (r.errors) failed++; out[w] = r; }, concurrency);
  const wallets_sorted = Object.fromEntries(Object.keys(out).sort().map(k => [k, out[k]]));
  const stats = { wallets: uniq.length, with_errors: failed, with_staked_luna: Object.values(out).filter(r => r.staked).length, with_gov: Object.values(out).filter(r => r.gov).length,
    with_nft_backing: Object.values(out).filter(r => r.nft && r.nft.unbroken > 0).length };
  const doc = { schemaVersion: 1, product: 'member-data/holdings', version: VERSION, capturedAt: t.toISOString(), date,
    sources: { wallets: 'member-data/participants (this run)', natives: catalogOk ? 'bank, named by token-catalog/snapshots/current.json' : 'bank (catalog unavailable: LUNA named, the rest raw)',
      cw20: Object.keys(H.cw20), gov: H.gov.map(g => g.key), nft: nfts ? { inventory: `${H.nft.repo}/${H.nft.inventory}`, as_of: nftAt, per_nft_backing: perNft, token: H.nft.backing_token } : null },
    stats, wallets: wallets_sorted };
  const status = !uniq.length ? 'error' : (failed > uniq.length * 0.2 || !nfts ? 'partial' : 'ok');
  const hb = { schemaVersion: 1, product: 'member-data/holdings', version: VERSION, capturedAt: t.toISOString(), status, stats, next_expected_run_at: new Date(t.getTime() + 25 * 3600e3).toISOString() };
  const body = JSON.stringify(doc) + '\n';
  if (publish) {
    await publish(`${OUT_DIR}/daily/${date}.json`, body, `member-data: holdings ${date} (${uniq.length} wallets)`);
    await publish(`${OUT_DIR}/current.json`, body, `member-data: holdings current ${date}`);
    await publish(`${OUT_DIR}/heartbeat.json`, JSON.stringify(hb, null, 2) + '\n', `member-data: holdings heartbeat ${status}`);
  }
  log(`  holdings: ${uniq.length} wallets · ${stats.with_staked_luna} staking LUNA · ${stats.with_gov} with gov stakes · ${stats.with_nft_backing} with aDAO backing · ${failed} with a failed read · ${status}`);
  return { status, doc, hb };
}
// when: the 23:xx run (the last write of the day), HOLDINGS=1 forces, HOLDINGS=0 disables
function due(env, hour) { if (env.HOLDINGS === '0') return false; if (env.HOLDINGS === '1') return true; return hour === parseInt(env.HOLDINGS_HOUR || '23', 10); }

module.exports = { VERSION, OUT_DIR, parseCw20Balance, parseCapaGov, parseCw20Stake, parseDelegations, parseUnbonding, nameNatives, nftIndex, readWallet, run, due };
