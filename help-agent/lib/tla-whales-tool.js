'use strict';
// help-agent/lib/tla-whales-tool.js 1.0.0 (2026-11-27, v1.25.0) — TLA Whales as a bot tool.
//
// Owner: a community member asked the bot for a pool's top depositors and whether the liquidity is the team's or the community's;
// it could not answer. This tool reads the SAME file tla-whales.html renders (tla-core tla-whales/current.json — every account
// holding a pool's staked liquidity, read from the chain) and returns FACTS ONLY:
//   pool     — one pool: its largest accounts (share, value, how held, since when, what they did lately), how concentrated it is,
//              and how much of the pool the list explains
//   overview — all pools together: how many accounts, the share of the largest 1 / 5 / 10 / 25, the split by what the chain says
//              (verified label · registered name · no name · not attributed), and the rewards the listed accounts have claimed
//   account  — one address: every pool it holds, its share and value in each, and what the public record holds for it
// It names an account only as the file does (a name the account registered, or a label the address catalog verified). It never says
// who owns an unlabelled account and never sorts accounts into "team" or "community". Pure over an injected fetchJson; cached 10 min.

const CORE = 'https://raw.githubusercontent.com/thealliancedao/tla-core/main';
const PAGE = 'https://theadao.com/tla-whales.html';
const VERSION = 'tla-whales-tool-1.0.0';
const TTL = 10 * 60 * 1000;
const NOTE = 'A name is one the account registered itself; a label is one the address catalog verified. Every other account is an address only: "no name" is neither "community" nor "team", one person or organisation may hold several, and a contract holds for others.';
let cache = { at: 0, doc: null };
const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100), r0 = (x) => (x == null ? null : Math.round(x));
const short = (a) => (a && a.length > 16 ? a.slice(0, 9) + '…' + a.slice(-5) : a || '');
const isAddr = (a) => /^terra1(?:[0-9a-z]{38}|[0-9a-z]{58})$/.test(a || '');
const epochDay = (n) => new Date(Date.UTC(2022, 9, 31) + n * 7 * 864e5).toISOString().slice(0, 10);   // a round starts on a Monday 00:00 UTC
const TREND = { adding: 'adding (deposits, no withdrawals, in the last 8 rounds)', reducing: 'taking out (withdrawals, no deposits, in the last 8 rounds)', both: 'in and out (deposits and withdrawals in the last 8 rounds)', holding: 'holding (no deposit or withdrawal in the last 8 rounds)' };

async function load(opts) {
  if (opts && opts.doc) return opts.doc;
  if (cache.doc && Date.now() - cache.at < TTL && !(opts && opts.fetchJson)) return cache.doc;
  const fj = (opts && opts.fetchJson) || (async (u) => { const r = await fetch(u, { headers: { 'User-Agent': 'tla-help-agent' } }); if (!r.ok) return null; return r.json(); });
  let d = null; try { d = await fj(`${CORE}/tla-whales/current.json`); } catch (e) { d = null; }
  if (d && Array.isArray(d.pools)) cache = { at: Date.now(), doc: d };
  return d && Array.isArray(d.pools) ? d : null;
}
const livePools = (d) => d.pools.filter((p) => p.holders && p.holders.length);
const valueOf = (h, P) => (P.staked_usd == null ? null : h.pct / 100 * P.staked_usd);
const who = (h) => ({ shown_as: h.label || h.name || short(h.a), address: h.a, name_kind: h.label ? 'verified label' : h.name ? 'registered name' : 'no name', organisation: h.label ? h.protocol || undefined : undefined, is_contract: h.kind === 'contract' || undefined });
const base = (d) => ({ source: 'tla-whales/current.json — read from the chain', read_at: d.capturedAt, round: d.epoch, tool: VERSION, note: NOTE });
function findPools(d, q) { const s = String(q || '').trim().toLowerCase(); if (!s) return []; const L = livePools(d);
  const exact = L.filter((p) => p.key.toLowerCase() === s || p.key.toLowerCase().endsWith(':' + s)); if (exact.length) return exact;   // by the pool's own key; a NAME is matched by its parts, so "Capa-Luna" finds LUNA-CAPA as well as CAPA-LUNA, the larger first
  const norm = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9.]+/g, ' ').trim().split(' ').sort().join(' ');   // "luna astro", "ASTRO/LUNA", "Astro-Luna" are one pool
  const byParts = L.filter((p) => norm(p.name) === norm(s)); if (byParts.length) return byParts;
  return L.filter((p) => String(p.name || '').toLowerCase().includes(s)); }
function poolBrief(P, d, n) { const top = (k) => r2(P.holders.slice(0, k).reduce((t, h) => t + h.pct, 0)); const na = (P.not_attributed.direct_pct || 0) + (P.not_attributed.amp_pct || 0);
  const notes = []; if (!P.complete) notes.push('this pool was NOT read to the end (' + (P.why_incomplete || []).join('; ') + ') — an account missing from the list may still hold a stake');
  if (na > 0.5) notes.push(`${r2(na)}% of the pool is NOT ATTRIBUTED${P.amp_token_missing ? ' — the compounder holds that part and lists no amp token for it, so the chain gives no list of whose it is' : ' — staked by accounts the read did not find'}; it is not spread over the accounts listed`);
  if (P.amp_check && P.amp_check.stated_over_staked != null && Math.abs(P.amp_check.stated_over_staked - 1) > 0.005) notes.push(`the amp tokens outstanding × the compounder's stated rate come to ${r2(P.amp_check.stated_over_staked * 100)}% of what it has staked here; shares are of the staked amount; the data does not say why they differ`);
  return { pool: P.name, bucket: P.bucket, dex: P.dex, status: P.status || undefined, staked_usd: r0(P.staked_usd), accounts_holding: P.holders_n, largest_pct: r2(P.holders[0].pct), top5_pct: top(5), top10_pct: top(10), auto_compounding_pct: r2(P.amplified_pct), list_explains_pct: r2(P.attributed_pct), notes: notes.length ? notes : undefined,
    top_accounts: P.holders.slice(0, n).map((h, i) => Object.assign({ rank: i + 1 }, who(h), { share_of_pool_pct: r2(h.pct), value_usd: r0(valueOf(h, P)), held: h.direct_pct && h.amp_pct ? `${r2(h.direct_pct)}% staked directly + ${r2(h.amp_pct)}% through the amp token` : h.amp_pct ? 'through the amp token (auto-compounding)' : 'staked directly',
      first_deposit_here: h.since != null ? epochDay(h.since) : 'none on the public record (holds the amp token, which can be bought or received)', weeks_in: h.since != null && d.epoch ? d.epoch - h.since : undefined, deposits_here: h.dep, withdrawals_here: h.wdr, last_8_rounds: h.trend ? TREND[h.trend] : undefined })),
    more: P.holders_n > n ? `${P.holders_n - n} more account(s) hold the rest — on the page` : undefined, link: `${PAGE}?pool=${encodeURIComponent(P.name || '')}` }; }

async function run(input, opts) {
  input = input || {}; const action = String(input.action || 'overview'); const d = await load(opts);
  if (!d) return { error: 'the whale list could not be read just now (tla-whales/current.json) — try again shortly', page: PAGE };
  const L = livePools(d); const lim = Math.min(25, Math.max(1, parseInt(input.limit || 10, 10) || 10));
  if (action === 'pool') { const hits = findPools(d, input.pool); if (!hits.length) return Object.assign(base(d), { error: `no pool named "${String(input.pool || '').slice(0, 40)}" holds staked liquidity`, pools: L.slice(0, 40).map((p) => p.name), page: PAGE });
    const out = Object.assign(base(d), { matched: hits.length, pools: hits.slice(0, 3).map((P) => poolBrief(P, d, hits.length > 1 ? Math.min(lim, 5) : lim)) }); if (hits.length > 1) out.same_name = 'more than one pool carries this name (different DEX or bucket) — say which one each figure is for'; if (hits.length > 3) out.more_pools = hits.slice(3).map((p) => `${p.name} (${p.dex})`); return out; }
  // accounts across pools
  const by = new Map(); for (const P of L) for (const h of P.holders) { const e = by.get(h.a) || by.set(h.a, { h, usd: 0, rows: [] }).get(h.a); const v = valueOf(h, P) || 0; e.usd += v; e.rows.push({ P, h, v }); }
  const AC = d.accounts || {}; const total = L.reduce((t, p) => t + (p.staked_usd || 0), 0); const list = [...by.values()].sort((x, y) => y.usd - x.usd); const share = (v) => (total ? r2(v / total * 100) : null);
  if (action === 'account') { const a = String(input.address || '').trim(); if (!isAddr(a)) return Object.assign(base(d), { error: 'give a full terra1… address' }); const e = by.get(a);
    if (!e) return Object.assign(base(d), { address: a, holds: 'no staked liquidity in any pool on this read', record: AC[a] || undefined, page: PAGE });
    const x = AC[a]; return Object.assign(base(d), { account: who(e.h), rank_by_staked_value: list.indexOf(e) + 1, staked_value_usd: r0(e.usd), share_of_all_staked_pct: share(e.usd),
      pools: e.rows.sort((p, q) => q.v - p.v).slice(0, 20).map((r) => ({ pool: r.P.name, dex: r.P.dex, share_of_pool_pct: r2(r.h.pct), value_usd: r0(r.v), first_deposit_here: r.h.since != null ? epochDay(r.h.since) : undefined, last_8_rounds: r.h.trend ? TREND[r.h.trend] : undefined })),
      across_the_alliance: x ? { deposits: x.dep, withdrawals: x.wdr, claims: x.clm, claims_worth_usd_on_the_day: x.clm_usd, first_event: x.first, last_event: x.last } : 'nothing on the public flow record (amp tokens compound by themselves — holding them involves no claim)', link: PAGE + '?view=all' }); }
  const cut = (f) => list.filter(f).reduce((t, e) => t + e.usd, 0); const ver = cut((e) => e.h.label), nam = cut((e) => !e.h.label && e.h.name), pl = cut((e) => !e.h.label && !e.h.name), nA = Math.max(0, total - list.reduce((t, e) => t + e.usd, 0));
  const prot = new Map(); for (const e of list) if (e.h.label) prot.set(e.h.protocol || e.h.label, (prot.get(e.h.protocol || e.h.label) || 0) + e.usd);
  const clm = (e) => (AC[e.h.a] && AC[e.h.a].clm_usd) || 0; const claimed = list.reduce((t, e) => t + clm(e), 0), CA = d.claims_all || {}; const topN = (n) => share(list.slice(0, n).reduce((t, e) => t + e.usd, 0));
  return Object.assign(base(d), { pools: L.length, staked_usd: r0(total), accounts_holding: list.length, largest_account_pct: topN(1), top5_pct: topN(5), top10_pct: topN(10), top25_pct: topN(25),
    who_by_what_the_chain_says: { verified_label_pct: share(ver), registered_name_pct: share(nam), no_name_pct: share(pl), not_attributed_pct: share(nA), verified_by_organisation: [...prot.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => ({ organisation: k, pct: share(v) })) },
    rewards_claimed: { by_listed_accounts_usd: r0(claimed), all_time_on_record_usd: CA.usd == null ? null : CA.usd, listed_share_pct: CA.usd ? r2(claimed / CA.usd * 100) : null, how: 'claims across the whole Alliance, each valued on the day it was made; a claim is not tied to one pool' },
    largest_accounts: list.slice(0, lim).map((e, i) => Object.assign({ rank: i + 1 }, who(e.h), { share_of_all_staked_pct: share(e.usd), value_usd: r0(e.usd), pools: e.rows.length, largest_positions: e.rows.slice().sort((p, q) => q.v - p.v).slice(0, 3).map((r) => `${r.P.name} ${r2(r.h.pct)}%`), rewards_claimed_usd: AC[e.h.a] ? r0(AC[e.h.a].clm_usd) : 'none on record' })),
    largest_pools: L.slice(0, 12).map((p) => ({ pool: p.name, dex: p.dex, staked_usd: r0(p.staked_usd), accounts: p.holders_n, largest_pct: r2(p.holders[0].pct) })), link: PAGE + '?view=all' });
}
module.exports = { VERSION, run, _clearCache: () => { cache = { at: 0, doc: null }; }, _internals: { findPools, epochDay, valueOf, PAGE, NOTE } };
