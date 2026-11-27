'use strict';
// help-agent/lib/tla-whales-tool.js 1.1.0 (2026-11-27, v1.26.0) — TLA Whales as a bot tool.
// 1.1.0: what the page gained in 1.1.0 — how each account holds a pool (staked directly: rewards paid out as LUNA to claim; amplified:
//   rewards compounded back), a pool list cut to one kind (held = direct | amplified), each account's voting power, the votes it gives
//   the pool and the bribes it placed on it, a pool's votes and bribes with the part that comes from its own holders, and a new action
//   voters (who holds the voting power, where each points it, and whether it holds liquidity in those pools).
//
// Owner: a community member asked the bot for a pool's top depositors and whether the liquidity is the team's or the community's;
// it could not answer. This tool reads the SAME file tla-whales.html renders (tla-core tla-whales/current.json — every account
// holding a pool's staked liquidity, read from the chain) and returns FACTS ONLY:
//   pool     — one pool: its largest accounts (share, value, how held, since when, what they did lately), how concentrated it is,
//              and how much of the pool the list explains
//   overview — all pools together: how many accounts, the share of the largest 1 / 5 / 10 / 25, the split by what the chain says
//              (verified label · registered name · no name · not attributed), and the rewards the listed accounts have claimed
//   account  — one address: every pool it holds, its share and value in each, and what the public record holds for it
//   voters   — every voter by voting power: where it points its votes, the liquidity it holds, the share of its votes on pools it holds
// It names an account only as the file does (a name the account registered, or a label the address catalog verified). It never says
// who owns an unlabelled account and never sorts accounts into "team" or "community". Pure over an injected fetchJson; cached 10 min.

const CORE = 'https://raw.githubusercontent.com/thealliancedao/tla-core/main';
const PAGE = 'https://theadao.com/tla-whales.html';
const VERSION = 'tla-whales-tool-1.1.0';
const VB_NOTE = 'Voting power comes from locked LUNA, not from liquidity. Voting for a pool one holds, or bribing it, is what the system is built for: give the figures and no judgement. Bribe dollars are the value on the day placed; a bribe in a token with no price on the record is counted as a bribe but is not in any dollar figure (see unpriced).';
const HELD_NOTE = 'staked directly = the rewards are paid out as LUNA, which the account claims; amplified (through the pool\'s amp token) = the rewards are compounded back into the pool, nothing is claimed';
const npTxt = (np) => (np && np.length ? np.map((t) => (typeof t === 'string' ? t : t.amount > 0 ? `${t.amount >= 1 ? Math.round(t.amount * 100) / 100 : Number(t.amount.toPrecision(3))} ${t.sym}` : t.sym)).join(', ') : undefined);
const whoV = (x) => ({ shown_as: x.label || x.name || x.briber_label || short(x.a), address: x.a, name_kind: x.label ? 'verified label' : x.name ? 'registered name' : x.briber_label ? 'name on the public bribe record' : 'no name', is_contract: x.kind === 'contract' || undefined });
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
function poolBrief(P, d, n, held) { const AC = d.accounts || {}; const f = held === 'direct' ? 'direct_pct' : held === 'amplified' ? 'amp_pct' : 'pct'; const rows = f === 'pct' ? P.holders : P.holders.filter((h) => h[f] > 0).sort((x, y) => y[f] - x[f] || (x.a < y.a ? -1 : 1));
  const dS = P.holders.reduce((t, h) => t + (h.direct_pct || 0), 0), aS = P.holders.reduce((t, h) => t + (h.amp_pct || 0), 0); const V = P.votes, B = P.bribes;
  const top = (k) => r2(P.holders.slice(0, k).reduce((t, h) => t + h.pct, 0)); const na = (P.not_attributed.direct_pct || 0) + (P.not_attributed.amp_pct || 0);
  const notes = []; if (!P.complete) notes.push('this pool was NOT read to the end (' + (P.why_incomplete || []).join('; ') + ') — an account missing from the list may still hold a stake');
  if (na > 0.5) notes.push(`${r2(na)}% of the pool is NOT ATTRIBUTED${P.amp_token_missing ? ' — the compounder holds that part and lists no amp token for it, so the chain gives no list of whose it is' : ' — staked by accounts the read did not find'}; it is not spread over the accounts listed`);
  if (P.amp_check && P.amp_check.stated_over_staked != null && Math.abs(P.amp_check.stated_over_staked - 1) > 0.005) notes.push(`the amp tokens outstanding × the compounder's stated rate come to ${r2(P.amp_check.stated_over_staked * 100)}% of what it has staked here; shares are of the staked amount; the data does not say why they differ`);
  return { pool: P.name, bucket: P.bucket, dex: P.dex, status: P.status || undefined, staked_usd: r0(P.staked_usd), accounts_holding: P.holders_n, largest_pct: r2(P.holders[0].pct), top5_pct: top(5), top10_pct: top(10), auto_compounding_pct: r2(P.amplified_pct), list_explains_pct: r2(P.attributed_pct), notes: notes.length ? notes : undefined,
    how_it_is_held: { staked_directly_pct: r2(dS), accounts_staking_directly: P.holders.filter((h) => h.direct_pct).length, amplified_pct: r2(aS), accounts_holding_amplified: P.holders.filter((h) => h.amp_pct).length, meaning: HELD_NOTE },
    votes_on_this_pool: V ? { votes: V.vp, voters: V.voters, pct_from_accounts_that_hold_it: V.from_holders_pct, largest_voters: (V.top || []).slice(0, n > 15 ? 3 : 5).map((x) => Object.assign(whoV(x), { votes: x.vp, pct_of_the_pools_votes: x.pct, holds_this_pool: !!x.holds })) } : undefined,
    bribes_on_this_pool: B ? { usd_when_placed: B.usd, bribes: B.n, bribers: B.bribers, pct_of_priced_dollars_from_accounts_that_hold_it: B.usd ? B.from_holders_pct : undefined, unpriced: npTxt(B.unpriced), largest_bribers: (B.top || []).slice(0, n > 15 ? 3 : 5).map((x) => Object.assign(whoV(x), { usd_when_placed: x.usd || (x.np ? 'no price on the record' : 0), bribes: x.n, unpriced: npTxt(x.np), holds_this_pool: !!x.holds })) } : undefined,
    votes_and_bribes_note: V || B ? VB_NOTE : undefined, list_is: f === 'pct' ? 'every account, by its whole share' : held === 'direct' ? 'only accounts staking directly, ranked by that part' : 'only accounts holding the amp token, ranked by that part',
    top_accounts: rows.slice(0, n).map((h, i) => Object.assign({ rank: i + 1 }, who(h), { share_of_pool_pct: r2(h[f]), value_usd: r0(P.staked_usd == null ? null : h[f] / 100 * P.staked_usd), held: h.direct_pct && h.amp_pct ? `${r2(h.direct_pct)}% staked directly + ${r2(h.amp_pct)}% through the amp token` : h.amp_pct ? 'through the amp token (auto-compounding)' : 'staked directly',
      first_deposit_here: h.since != null ? epochDay(h.since) : i < 10 ? 'none on the public record (holds the amp token, which can be bought or received)' : 'none on the public record', weeks_in: h.since != null && d.epoch ? d.epoch - h.since : undefined, deposits_here: h.dep, withdrawals_here: h.wdr, last_8_rounds: h.trend ? (i < 10 ? TREND[h.trend] : TREND[h.trend].split(' (')[0]) : undefined, voting_power: AC[h.a] && AC[h.a].vp ? AC[h.a].vp : undefined, votes_it_gives_this_pool: h.vote_vp || undefined, bribed_this_pool: h.brb_n ? { usd_when_placed: h.brb_usd || (h.brb_np ? 'no price on the record' : 0), bribes: h.brb_n, unpriced: npTxt(h.brb_np) } : undefined })),
    more: rows.length > n ? `${rows.length - n} more account(s) — on the page` : undefined, link: `${PAGE}?pool=${encodeURIComponent(P.name || '')}` }; }

async function run(input, opts) {
  input = input || {}; const action = String(input.action || 'overview'); const d = await load(opts);
  if (!d) return { error: 'the whale list could not be read just now (tla-whales/current.json) — try again shortly', page: PAGE };
  const L = livePools(d); const lim = Math.min(25, Math.max(1, parseInt(input.limit || 10, 10) || 10)); const hq = String(input.held || '').toLowerCase(); const held = /^direct/.test(hq) ? 'direct' : /^amp/.test(hq) ? 'amplified' : null; const VT = d.voting && Array.isArray(d.voting.list) ? d.voting : null;
  if (action === 'pool') { const hits = findPools(d, input.pool); if (!hits.length) return Object.assign(base(d), { error: `no pool named "${String(input.pool || '').slice(0, 40)}" holds staked liquidity`, pools: L.slice(0, 40).map((p) => p.name), page: PAGE });
    const out = Object.assign(base(d), { matched: hits.length, pools: hits.slice(0, 3).map((P) => poolBrief(P, d, hits.length > 1 ? Math.min(lim, 5) : Math.min(lim, 20), held)) }); /* a pool row now carries votes and bribes too: 20 rows keep the answer under the server's cut */ if (hits.length > 1) out.same_name = 'more than one pool carries this name (different DEX or bucket) — say which one each figure is for'; if (hits.length > 3) out.more_pools = hits.slice(3).map((p) => `${p.name} (${p.dex})`); return out; }
  // accounts across pools
  const by = new Map(); for (const P of L) for (const h of P.holders) { const e = by.get(h.a) || by.set(h.a, { h, usd: 0, dusd: 0, ausd: 0, rows: [] }).get(h.a); const v = valueOf(h, P) || 0; e.usd += v; e.dusd += (h.direct_pct || 0) / 100 * (P.staked_usd || 0); e.ausd += (h.amp_pct || 0) / 100 * (P.staked_usd || 0); e.rows.push({ P, h, v }); }
  const AC = d.accounts || {}; const total = L.reduce((t, p) => t + (p.staked_usd || 0), 0); const list = [...by.values()].sort((x, y) => y.usd - x.usd); const share = (v) => (total ? r2(v / total * 100) : null);
  const ownShare = (v) => { const e = by.get(v.a); const to = v.to || [], sum = to.reduce((t, x) => t + x.bps, 0); if (!e || !sum) return null; const keys = new Set(e.rows.map((r) => r.P.key)); return r2(to.filter((x) => keys.has(x.key)).reduce((t, x) => t + x.bps, 0) / sum * 100); };
  const voterRow = (v, i, nTo) => { const e = by.get(v.a), keys = e ? new Set(e.rows.map((r) => r.P.key)) : new Set(); return Object.assign({ rank: i + 1 }, whoV(v), { voting_power: v.vp, pct_of_all_voting_power: v.pct, points_its_votes_at: (v.to || []).slice(0, nTo).map((x) => `${x.name || short(x.key)} ${r2(x.bps / 100)}%${x.bucket ? ' of its ' + x.bucket + ' votes' : ''}${keys.has(x.key) ? ' (holds it)' : ''}`), liquidity_it_holds_usd: e ? r0(e.usd) : 'none', pct_of_its_votes_on_pools_it_holds: ownShare(v) == null ? undefined : ownShare(v), bribes_placed: v.brb_n ? { usd_when_placed: v.brb_usd || (v.brb_np ? 'no price on the record' : 0), bribes: v.brb_n, unpriced: npTxt(v.brb_np) } : undefined }); };
  if (action === 'voters') { if (!VT) return Object.assign(base(d), { error: 'this read carries no voting data', page: PAGE }); const VL = VT.list; const hv = VL.filter((v) => by.has(v.a)); const topV = (n) => r2(VL.slice(0, n).reduce((t, v) => t + v.pct, 0));
    return Object.assign(base(d), { total_voting_power: VT.total_vp, voters: VL.length, largest_voter_pct: topV(1), top5_pct: topV(5), top10_pct: topV(10), votes_as_of: VT.votes_as_of || undefined, voters_that_also_hold_liquidity: { accounts: hv.length, pct_of_all_voting_power: r2(hv.reduce((t, v) => t + v.vp, 0) / (VT.total_vp || 1) * 100) }, votes_and_bribes_note: VB_NOTE,
      largest_voters: VL.slice(0, lim).map((v, i) => voterRow(v, i, lim > 12 ? 3 : 6)), more: VL.length > lim ? `${VL.length - lim} more voter(s) — on the page` : undefined, link: PAGE + '?view=vote' }); }
  if (action === 'account') { const a = String(input.address || '').trim(); if (!isAddr(a)) return Object.assign(base(d), { error: 'give a full terra1… address' }); const e = by.get(a);
    const vv = VT ? VT.list.findIndex((v) => v.a === a) : -1; const voting = vv >= 0 ? voterRow(VT.list[vv], vv, 16) : 'no voting power (no TLA lock) on this read';
    if (!e) return Object.assign(base(d), { address: a, holds: 'no staked liquidity in any pool on this read', voting, record: AC[a] || undefined, page: PAGE });
    const x = AC[a]; return Object.assign(base(d), { account: who(e.h), rank_by_staked_value: list.indexOf(e) + 1, staked_value_usd: r0(e.usd), share_of_all_staked_pct: share(e.usd), staked_directly_usd: r0(e.dusd), amplified_usd: r0(e.ausd), held_meaning: HELD_NOTE,
      pools: e.rows.sort((p, q) => q.v - p.v).slice(0, 20).map((r) => ({ pool: r.P.name, dex: r.P.dex, share_of_pool_pct: r2(r.h.pct), value_usd: r0(r.v), held: r.h.direct_pct && r.h.amp_pct ? 'both' : r.h.amp_pct ? 'amplified' : 'staked directly', votes_it_gives_this_pool: r.h.vote_vp || undefined, bribed_this_pool_usd: r.h.brb_n ? (r.h.brb_usd || (r.h.brb_np ? 'no price on the record' : 0)) : undefined, first_deposit_here: r.h.since != null ? epochDay(r.h.since) : undefined, last_8_rounds: r.h.trend ? TREND[r.h.trend] : undefined })),
      across_the_alliance: x ? { deposits: x.dep, withdrawals: x.wdr, claims: x.clm, claims_worth_usd_on_the_day: x.clm_usd, first_event: x.first, last_event: x.last } : 'nothing on the public flow record (amp tokens compound by themselves — holding them involves no claim)',
      voting, bribes_placed: x && x.brb_n ? { usd_when_placed: x.brb_usd || (x.brb_np ? 'no price on the record' : 0), bribes: x.brb_n, pools: x.brb_pools, first: x.brb_first, last: x.brb_last, unpriced_tokens: npTxt(x.brb_np) } : 'none on the record', votes_and_bribes_note: VB_NOTE, link: PAGE + '?view=all' }); }
  const cut = (f) => list.filter(f).reduce((t, e) => t + e.usd, 0); const ver = cut((e) => e.h.label), nam = cut((e) => !e.h.label && e.h.name), pl = cut((e) => !e.h.label && !e.h.name), nA = Math.max(0, total - list.reduce((t, e) => t + e.usd, 0));
  const prot = new Map(); for (const e of list) if (e.h.label) prot.set(e.h.protocol || e.h.label, (prot.get(e.h.protocol || e.h.label) || 0) + e.usd);
  const clm = (e) => (AC[e.h.a] && AC[e.h.a].clm_usd) || 0; const claimed = list.reduce((t, e) => t + clm(e), 0), CA = d.claims_all || {}; const topN = (n) => share(list.slice(0, n).reduce((t, e) => t + e.usd, 0));
  return Object.assign(base(d), { pools: L.length, staked_usd: r0(total), accounts_holding: list.length, largest_account_pct: topN(1), top5_pct: topN(5), top10_pct: topN(10), top25_pct: topN(25),
    who_by_what_the_chain_says: { verified_label_pct: share(ver), registered_name_pct: share(nam), no_name_pct: share(pl), not_attributed_pct: share(nA), verified_by_organisation: [...prot.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => ({ organisation: k, pct: share(v) })) },
    rewards_claimed: { by_listed_accounts_usd: r0(claimed), all_time_on_record_usd: CA.usd == null ? null : CA.usd, listed_share_pct: CA.usd ? r2(claimed / CA.usd * 100) : null, how: 'claims across the whole Alliance, each valued on the day it was made; a claim is not tied to one pool' },
    how_it_is_held: { staked_directly_pct: share(list.reduce((t, e) => t + e.dusd, 0)), accounts_staking_directly: list.filter((e) => e.dusd > 0.005).length, amplified_pct: share(list.reduce((t, e) => t + e.ausd, 0)), accounts_holding_amplified: list.filter((e) => e.ausd > 0.005).length, meaning: HELD_NOTE },
    holders_that_vote: VT ? (() => { const w = list.filter((e) => AC[e.h.a] && AC[e.h.a].vp > 0); return { accounts: w.length, pct_of_staked_value_they_hold: share(w.reduce((t, e) => t + e.usd, 0)), pct_of_all_voting_power_they_hold: r2(w.reduce((t, e) => t + AC[e.h.a].vp, 0) / (VT.total_vp || 1) * 100) }; })() : undefined,
    holders_that_bribe: (() => { const w = list.filter((e) => AC[e.h.a] && AC[e.h.a].brb_n > 0); return { accounts: w.length, pct_of_staked_value_they_hold: share(w.reduce((t, e) => t + e.usd, 0)) }; })(), votes_and_bribes_note: VB_NOTE,
    largest_accounts: (held ? list.filter((e) => (held === 'direct' ? e.dusd : e.ausd) > 0).sort((x, y) => (held === 'direct' ? y.dusd - x.dusd : y.ausd - x.ausd)) : list).slice(0, lim).map((e, i) => Object.assign({ rank: i + 1 }, who(e.h), { share_of_all_staked_pct: share(held === 'direct' ? e.dusd : held === 'amplified' ? e.ausd : e.usd), value_usd: r0(held === 'direct' ? e.dusd : held === 'amplified' ? e.ausd : e.usd), staked_directly_usd: held || e.dusd < 0.5 ? undefined : r0(e.dusd), amplified_usd: held || e.ausd < 0.5 ? undefined : r0(e.ausd), voting_power: AC[e.h.a] && AC[e.h.a].vp ? AC[e.h.a].vp : undefined, bribes_placed_usd: AC[e.h.a] && AC[e.h.a].brb_n ? (AC[e.h.a].brb_usd || 'no price on the record') : undefined, pools: e.rows.length, largest_positions: e.rows.slice().sort((p, q) => q.v - p.v).slice(0, lim > 15 ? 2 : 3).map((r) => `${r.P.name} ${r2(r.h.pct)}%`), rewards_claimed_usd: AC[e.h.a] ? r0(AC[e.h.a].clm_usd) : 'none on record' })),
    largest_pools: L.slice(0, lim > 15 ? 6 : 12).map((p) => ({ pool: p.name, dex: p.dex, staked_usd: r0(p.staked_usd), accounts: p.holders_n, largest_pct: r2(p.holders[0].pct) })), link: PAGE + '?view=all' });
}
module.exports = { VERSION, run, _clearCache: () => { cache = { at: 0, doc: null }; }, _internals: { findPools, epochDay, valueOf, PAGE, NOTE, VB_NOTE, HELD_NOTE } };
