'use strict';
// nfts/nft-flows/lib/activity.js — 1.0.0 (2026-09-20, owner: "rethink Live Activity")
// THE fold from ledger rows to EPISODES — what a person reads as one thing. The ledger says what it saw, one row per
// contract event; a reader wants one row per act: a same-owner delist+relist inside 24 h is a price change, thirty
// unstakes in an hour are one unstake of thirty, the four verbs a lock restructure fires in one tx are one row.
// Pure: rows in, episodes out. Facts only — every threshold (what is "big", what is "over floor") lives in the site's
// curated config (tla-core/docs/curated/alert-thresholds.json); the page classifies, this file never does.
// Written by org-nft-flows to <slug>/ledger/activity.json; read by the site (index Live Activity, the tenant home, the
// app's Today tab) and the help agent. One rule, no copy.
//
// Inputs (fold(rows, ctx)):
//   rows  — live ledger records (a row with superseded_by is skipped here), any order, within the window
//   ctx   — { now (ms), window_days, kind: 'nft' | 'escrow', venues: { key → {address,label} }, custodians: Map(addr→role),
//            system: Set(addr), tierOf(token_id) → 'base'|'broken'|'phoenix'|'rank1'|null, floorAt(dayISO) → per_tier
//            (floor-history row, or null), backingOf(token_id) → { amount, denom, symbol, usd } | null (escrow only),
//            knownWallets: Set(addr) (escrow: wallets that ever held a lock BEFORE this window) }
// Output: { episodes: [...] (newest first), stats, known_wallets_added: [] }
// Episode: { id, kind, ts, ts_end, txs: [hash…], wallet, counterparty, custodian, venue, count, tokens: [{id, price?,
//            usd?, denom_symbol?, tier?, vs_floor_pct?}], token (when count = 1), amount, usd, denom_symbol, tier,
//            floor_then, vs_floor_pct, flags: [...], detail: {...} }
// Flags are FACTS a page may promote: enterprise · daodao · new_voter · listed_lock · under_floor (only when a floor
// exists — a class with no floor hides nothing) · price_change · bulk (count ≥ 2) · mass (count ≥ 10).
const VERSION = '1.0.0';
const RULES = {
  one_tx_one_row: 'rows that share a tx hash, an actor and a verb fold into one episode (multi-token txs)',
  fold_window_minutes: 60,
  fold_window: 'the same actor doing the same act (same venue / custodian / counterparty) within 60 minutes is one episode; tokens accumulate',
  price_change_hours: 24,
  price_change: 'a delist followed by a list of the same token by the same owner within 24 h is ONE price-change episode (the owner\'s 24 h rule from the journey work); longer is a new listing episode',
  lock_restructure: 'lock_merge · lock_split · lock_migrate · lock_permanent · lock_unpermanent in one tx are one lock_restructure episode (housekeeping); lock_add + lock_extend fold as lock_add',
  new_voter: 'a lock_create for a wallet with no lock in the ledger before this window is flagged new_voter',
  under_floor: 'a listing priced (USD at the time) under its tier\'s listing floor on that day is flagged under_floor; vs_floor_pct = (usd / floor − 1) × 100; a tier with no floor gets no pct and no flag',
  days_on_market: 'a sale carries days_on_market from the seller\'s last list of that token inside the window; null = listed before the window (unknown, never 0)',
  thresholds: 'none here — "big", "over floor" and "mass" percentages are the page\'s curated config; this file carries facts',
};

const KIND_MAP = {   // ledger kind → episode kind (verb family)
  sale: 'sale', list: 'listing', delist: 'delisting', bid: 'bid', mint: 'mint', mint_purchase: null, transfer: 'transfer',
  stake: 'stake', unstake: 'unstake', claim: 'claim', stake_enterprise: 'stake_enterprise', unstake_enterprise: 'unstake_enterprise',
  break: 'break', backing_add: 'backing_add', venue_in: null, venue_out: null, venue_deposit: null, venue_withdraw: null, offer: 'bid',
  lock_create: 'lock_new', lock_add: 'lock_add', lock_extend: 'lock_add', lock_withdraw: 'lock_unlock', lock_transfer: 'lock_transfer',
  lock_merge: 'lock_restructure', lock_split: 'lock_restructure', lock_migrate: 'lock_restructure', lock_permanent: 'lock_restructure', lock_unpermanent: 'lock_restructure',
};
const BULK = new Set(['stake', 'unstake', 'claim', 'stake_enterprise', 'unstake_enterprise', 'transfer', 'listing', 'delisting', 'bid', 'sale', 'mint', 'break', 'backing_add',
  'lock_new', 'lock_add', 'lock_unlock', 'lock_transfer', 'lock_restructure']);   // kinds that accumulate tokens inside the fold window

const num = (v) => (v == null || v === '' ? null : Number(v));
const amtOf = (r) => (r && r.price && r.price.amount != null ? Number(r.price.amount) / Math.pow(10, r.denom_decimals == null ? 6 : r.denom_decimals) : null);
const dayOf = (ts) => String(ts).slice(0, 10);

// the actor of a row: who a reader would say "did" it
function actorOf(r, ctx) {
  const sys = ctx.system || new Set();
  switch (r.kind) {
    case 'sale': return r.from;                                   // the seller acts; the buyer is the counterparty
    case 'list': case 'bid': case 'offer': case 'stake': case 'stake_enterprise': case 'transfer': case 'lock_transfer': case 'lock_add': case 'lock_extend': case 'lock_withdraw': case 'lock_merge': case 'lock_split': case 'lock_migrate': case 'lock_permanent': case 'lock_unpermanent': case 'break': case 'backing_add':
      return r.from || r.to || null;
    case 'delist': case 'unstake': case 'unstake_enterprise': case 'claim': case 'mint': case 'lock_create':
      return r.to || r.from || null;                              // the human end (the custodian / venue / contract is `from`)
    default: return (r.from && !sys.has(r.from)) ? r.from : (r.to || r.from || null);
  }
}
function counterpartyOf(r, ep) {
  if (r.kind === 'sale') return r.to;
  if (r.kind === 'transfer' || r.kind === 'lock_transfer') return r.to;
  return null;
}

function fold(rows, ctx) {
  const now = ctx.now || Date.now(); const FOLD = RULES.fold_window_minutes * 60e3; const PC = RULES.price_change_hours * 3600e3;
  const live = rows.filter(r => r && !r.superseded_by && KIND_MAP[r.kind] !== undefined && KIND_MAP[r.kind] !== null && r.ts);
  live.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts) || Number(a.height) - Number(b.height) || Number(a.msg_index) - Number(b.msg_index));
  // a row with no address (lock_permanent / lock_unpermanent / lock_extend name only the lock) adopts the actor of its tx-mates
  const txActor = new Map(); for (const r of live) { const a = actorOf(r, ctx); if (a && !txActor.has(r.txhash)) txActor.set(r.txhash, a); }
  const stats = { rows_in: rows.length, rows_live: live.length, price_changes: 0, by_kind: {} };

  // ---- price changes: pair a delist with the same owner's relist of the token inside 24 h (both rows leave the stream)
  const consumed = new Set();
  const byTok = {}; live.forEach((r, i) => { if (r.token_id != null && (r.kind === 'delist' || r.kind === 'list')) (byTok[r.token_id] ||= []).push(i); });
  const priceChanges = [];
  for (const idxs of Object.values(byTok)) {
    for (let a = 0; a < idxs.length; a++) {
      const d = live[idxs[a]]; if (d.kind !== 'delist' || consumed.has(idxs[a])) continue;
      const owner = d.to; if (!owner) continue;
      for (let b = a + 1; b < idxs.length; b++) {
        const l = live[idxs[b]]; if (consumed.has(idxs[b])) continue;
        const dt = Date.parse(l.ts) - Date.parse(d.ts); if (dt > PC) break;
        if (l.kind === 'list' && l.from === owner && dt >= 0) {
          // the price before: the most recent list of this token by this owner before the delist (inside the window)
          let prev = null; for (let c = a - 1; c >= 0; c--) { const p = live[idxs[c]]; if (p.kind === 'list' && p.from === owner) { prev = p; break; } }
          consumed.add(idxs[a]); consumed.add(idxs[b]);
          priceChanges.push({ delist: d, list: l, prev });
          break;
        }
        if (l.kind === 'list') break;   // someone else listed it (a sale happened in between) — no pair
      }
    }
  }

  // ---- one tx, one act: group by (tx, episode kind, actor)
  const eps = []; const key2ep = new Map();
  const push = (r, ekind, actor, extra) => {
    const venue = r.venue || null, cust = r.custodian || (ctx.custodians && (ctx.custodians.get(r.to) || ctx.custodians.get(r.from))) || null;
    const cp = counterpartyOf(r);
    const k = `${r.txhash}|${ekind}|${actor}|${venue || ''}|${cust || ''}|${cp || ''}`;
    let ep = key2ep.get(k);
    if (!ep) { ep = { kind: ekind, ts: r.ts, ts_end: r.ts, txs: [r.txhash], wallet: actor, counterparty: cp, custodian: cust, venue, count: 0, tokens: [], flags: new Set(), detail: {} }; key2ep.set(k, ep); eps.push(ep); }
    const tok = { id: r.token_id == null ? null : String(r.token_id) };
    if (r.price) { tok.amount = amtOf(r); tok.denom_symbol = r.denom_symbol || null; tok.usd = r.usd == null ? null : r.usd; }   // amount + symbol + USD; the denom string stays in the ledger
    if (extra) Object.assign(tok, extra);
    if (ctx.kind === 'nft' && tok.id != null && ctx.tierOf) tok.tier = ctx.tierOf(tok.id);
    if (ekind === 'lock_restructure') { delete tok.usd; delete tok.denom_symbol; delete tok.amount; }   // housekeeping rows: the id is the fact
    ep.tokens.push(tok); ep.count++;
    if (r.lock) { ep.detail.lock = r.lock; if (r.lock.voting_power != null) tok.vp = Number(r.lock.voting_power) / 1e6; }   // the lock's power at the last row of the group; per-token VP for bulk sums
    if (r.lineage) { const L = ep.detail.lineage ||= { ids: [], burned: [] }; for (const id of [...(r.lineage.from_ids || []), ...(r.lineage.to_ids || [])]) if (!L.ids.includes(String(id))) L.ids.push(String(id)); for (const id of (r.lineage.burned || [])) if (!L.burned.includes(String(id))) L.burned.push(String(id)); }
    if (r.migrate) ep.detail.migrate = r.migrate;
    if (r.note && /resolve at claim|not archived/.test(r.note)) ep.detail.ids_pending = true;   // 4.22 lesson: say "ids resolve at claim", never #?
    return ep;
  };
  live.forEach((r, i) => {
    if (consumed.has(i)) return;
    const ek = KIND_MAP[r.kind]; const actor = actorOf(r, ctx) || txActor.get(r.txhash) || null;
    if (ek === 'lock_restructure') { const ep = push(r, ek, actor); (ep.detail.verbs ||= []).push(r.kind); return; }
    const ep = push(r, ek, actor);
    if (r.kind === 'lock_create' || r.kind === 'lock_add' || r.kind === 'lock_extend' || r.kind === 'lock_withdraw') ep.detail.verbs = Array.from(new Set([...(ep.detail.verbs || []), r.kind]));
  });
  for (const pc of priceChanges) {
    const l = pc.list, d = pc.delist; const from = pc.prev ? amtOf(pc.prev) : null, to = amtOf(l);
    const ep = { kind: 'price_change', ts: l.ts, ts_end: l.ts, txs: [d.txhash, l.txhash], wallet: l.from, counterparty: null, custodian: null, venue: l.venue || d.venue || null, count: 1, flags: new Set(['price_change']),
      tokens: [{ id: String(l.token_id), usd: l.usd == null ? null : l.usd, denom_symbol: l.denom_symbol || null, amount: to, tier: ctx.kind === 'nft' && ctx.tierOf ? ctx.tierOf(String(l.token_id)) : null }],
      detail: { from_amount: from, to_amount: to, from_usd: pc.prev ? (pc.prev.usd == null ? null : pc.prev.usd) : null, to_usd: l.usd == null ? null : l.usd, pct: from && to ? +(((to / from) - 1) * 100).toFixed(1) : null,
        prev_known: !!pc.prev, hours_between: +(((Date.parse(l.ts) - Date.parse(d.ts)) / 3600e3).toFixed(2)), venue_before: d.venue || null, venue_after: l.venue || null } };
    eps.push(ep); stats.price_changes++;
  }

  // ---- fold across txs: same actor + kind + venue/custodian/counterparty within 60 minutes (chronological)
  eps.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const out = []; const open = new Map();
  for (const ep of eps) {
    const k = `${ep.kind}|${ep.wallet}|${ep.venue || ''}|${ep.custodian || ''}|${ep.counterparty || ''}`;
    const o = open.get(k);
    if (o && BULK.has(ep.kind) && Date.parse(ep.ts) - Date.parse(o.ts_end) <= FOLD) {
      o.ts_end = ep.ts_end; for (const t of ep.txs) if (!o.txs.includes(t)) o.txs.push(t); o.tokens.push(...ep.tokens); o.count += ep.count;
      for (const f of ep.flags) o.flags.add(f);
      if (ep.detail.lock) o.detail.lock = ep.detail.lock;
      if (ep.detail.verbs) o.detail.verbs = Array.from(new Set([...(o.detail.verbs || []), ...ep.detail.verbs]));
      if (ep.detail.lineage) { const L = o.detail.lineage ||= { ids: [], burned: [] }; for (const id of ep.detail.lineage.ids) if (!L.ids.includes(id)) L.ids.push(id); for (const id of ep.detail.lineage.burned) if (!L.burned.includes(id)) L.burned.push(id); }
      if (ep.detail.ids_pending) o.detail.ids_pending = true;
      continue;
    }
    open.set(k, ep); out.push(ep);
  }

  // ---- facts per episode: floors, backing, flags, sale context
  const listByTok = {}; for (const r of live) if (r.kind === 'list' && r.token_id != null) (listByTok[r.token_id] ||= []).push(r);
  const known = ctx.knownWallets || new Set(); const knownAdded = new Set();
  for (const ep of out) {
    ep.flags = Array.from(ep.flags);
    if (ep.custodian === 'enterprise_staking' || ep.kind === 'stake_enterprise' || ep.kind === 'unstake_enterprise') ep.flags.push('enterprise');
    if (ep.custodian === 'daodao_voting') ep.flags.push('daodao');
    if (ep.count >= 2) ep.flags.push('bulk'); if (ep.count >= 10) ep.flags.push('mass');
    // priced tokens: USD sum, tier floors on the day, vs-floor
    let usd = 0, priced = 0; const syms = new Set();
    for (const t of ep.tokens) {
      if (t.usd != null) { usd += t.usd; priced++; } if (t.denom_symbol) syms.add(t.denom_symbol);
      if (ctx.kind === 'nft' && (ep.kind === 'listing' || ep.kind === 'price_change') && t.tier && ctx.floorAt) {
        const fl = ctx.floorAt(dayOf(ep.ts)); const tf = fl && fl[t.tier]; const f = tf && tf.listing_floor_usd;
        t.floor_then = f == null ? null : f;
        t.vs_floor_pct = (f && t.usd != null) ? +(((t.usd / f) - 1) * 100).toFixed(1) : null;
        if (t.vs_floor_pct != null && t.vs_floor_pct < 0) ep.flags.push('under_floor');
      }
    }
    if (priced) { ep.usd = +usd.toFixed(4); ep.usd_priced = priced; }
    ep.denom_symbol = syms.size === 1 ? [...syms][0] : (syms.size ? 'mixed' : null);
    if (ep.count === 1) { const t = ep.tokens[0]; ep.token = t.id; if (t.amount != null) ep.amount = t.amount; if (t.tier) ep.tier = t.tier; if (t.floor_then !== undefined) ep.floor_then = t.floor_then; if (t.vs_floor_pct !== undefined) ep.vs_floor_pct = t.vs_floor_pct; }
    else { const v = ep.tokens.map(t => t.vs_floor_pct).filter(x => x != null); if (v.length) ep.vs_floor_pct = Math.min(...v); const tiers = new Set(ep.tokens.map(t => t.tier).filter(Boolean)); if (tiers.size === 1) ep.tier = [...tiers][0]; }
    if (ep.kind === 'sale') {
      // days on market: the seller's last list of the token before the sale, inside the window
      for (const t of ep.tokens) { const ls = (listByTok[t.id] || []).filter(l => l.from === ep.wallet && Date.parse(l.ts) <= Date.parse(ep.ts)); const last = ls[ls.length - 1]; t.days_on_market = last ? +(((Date.parse(ep.ts) - Date.parse(last.ts)) / 86400e3).toFixed(1)) : null; t.list_usd = last ? (last.usd == null ? null : last.usd) : null; }
      if (ep.count === 1) { ep.days_on_market = ep.tokens[0].days_on_market; ep.list_usd = ep.tokens[0].list_usd; }
    }
    if (ctx.kind === 'escrow') {
      if (ep.detail.lock) { const L = ep.detail.lock; const vps = ep.tokens.map(t => t.vp).filter(v => v != null); ep.vp = ep.count > 1 && vps.length ? +vps.reduce((a, b) => a + b, 0).toFixed(6) : (L.voting_power == null ? null : Number(L.voting_power) / 1e6); /* one lock: its VP; a bulk act: the sum over its locks */ ep.fixed_vp = L.fixed_power == null ? null : Number(L.fixed_power) / 1e6; ep.lock_end = L.lock_end == null ? null : L.lock_end; }
      if (ep.kind === 'lock_new') { if (!known.has(ep.wallet)) { ep.flags.push('new_voter'); knownAdded.add(ep.wallet); } }
      if (ep.kind === 'lock_new' || ep.kind === 'lock_transfer') knownAdded.add(ep.counterparty || ep.wallet);
      if ((ep.kind === 'listing' || ep.kind === 'price_change' || ep.kind === 'sale') && ctx.backingOf) {
        ep.flags.push(ep.kind === 'sale' ? 'lock_sold' : 'listed_lock');
        for (const t of ep.tokens) { const b = ctx.backingOf(t.id); if (b) { t.backing = b; if (t.usd != null && b.usd) t.price_vs_backing = +((t.usd / b.usd).toFixed(3)); } }
        if (ep.count === 1) { ep.backing = ep.tokens[0].backing || null; ep.price_vs_backing = ep.tokens[0].price_vs_backing == null ? null : ep.tokens[0].price_vs_backing; }
      }
    }
    ep.tx_count = ep.txs.length; const MAXTX = ctx.max_txs == null ? 12 : ctx.max_txs; if (ep.txs.length > MAXTX) ep.txs = ep.txs.slice(0, MAXTX);   // the first dozen hashes; tx_count says how many there were (52-tx restructures happen)
    stats.by_kind[ep.kind] = (stats.by_kind[ep.kind] || 0) + 1;
    ep.id = `${ep.kind}:${ep.txs[0]}:${ep.wallet || ''}:${ep.venue || ep.custodian || ''}`;
    if (ep.count > 1) ep.token_ids = ep.tokens.map(t => t.id);
  }
  out.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
  return { episodes: out, stats, known_wallets_added: [...knownAdded].filter(Boolean) };
}

// tierOf for an NFT collection: registry tiers (token-id sets, e.g. aDAO phoenix) · inventory broken flag · rank 1 set (PL)
function makeTierOf({ registryTiers, brokenIds, rank1Ids }) {
  const sets = Object.entries(registryTiers || {}).map(([name, t]) => [name, new Set((t.token_ids || []).map(String))]);
  const broken = brokenIds || new Set(), r1 = rank1Ids || new Set();
  return (id) => { id = String(id); if (broken.has(id)) return 'broken'; for (const [n, s] of sets) if (s.has(id)) return n; if (r1.has(id)) return 'rank1'; return 'base'; };
}
// floorAt from a floor-history product: the row of that day, else the last row before it (floors are daily; a missing day
// inherits the previous reading — labeled by the page as "floor as of <day>")
function makeFloorAt(floorHistory) {
  const rows = ((floorHistory && floorHistory.rows) || []).slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return (day) => { let best = null; for (const r of rows) { if (r.date <= day) best = r; else break; } return best ? best.per_tier : null; };
}

module.exports = { VERSION, RULES, KIND_MAP, fold, makeTierOf, makeFloorAt, actorOf, amtOf };
