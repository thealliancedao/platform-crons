'use strict';
// lib/by-wallet.js 1.0.0 (2026-09-20, D.1) — THE per-wallet projection of a collection's ledger.
//
// The ledger is event-ordered (one row per tx/msg/kind/token). Every reader that asks "what did THIS address do, what
// does it hold now, what did it hold before" has to replay the whole ledger for that address. This lib is that replay,
// once, so a wallet's answer is one small file: <slug>/ledger/by-wallet/<shard>.json (org-nft-flows rebuilds the shards
// a run touches; index.json beside them). Readers: the explorer's journey sheet ("buyer's holdings at the time"), the app,
// member portfolios (cost basis), and the help agent ("what does terra1… hold / what did it hold in 2024").
//
// LAWS: records verbatim (+ `role` = which side of the record the wallet is on); superseded rows never enter; the ledger
// says what it saw — a position that opens without an acquisition record (pre-ledger history, a gap) is LABELED
// `acquired: null` with `opened_by`, never invented; a release with no open position is counted, not guessed; P&L two
// ways (USD at each end, and in the token's own units when both ends are the same symbol — else null, never converted).
// System addresses (the collection contract, custodians, venues, launchpads, distributors, DAO cores — every address the
// registry names as machinery) are not wallets: they get no block, so a shard never carries 5,000 mint rows twice.
//
// Shard rule: the LAST character of the bech32 address (its checksum's 6th char — uniform over the 32-char bech32
// alphabet) → 32 shards named by that char; anything that is not a terra1… address → "_". A reader computes the shard
// from the address alone: terra1hr8…x77ulw → w.json.

const VERSION = '1.0.0';
const BECH32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const SHARDS = [...BECH32].sort();   // 32 shard names, stable order
function shardOf(addr) { const a = String(addr || ''); if (!/^terra1[0-9a-z]+$/.test(a)) return '_'; const c = a[a.length - 1]; return BECH32.includes(c) ? c : '_'; }   // any terra1… id shards by its last char (real addresses are 44/64 chars; fixtures may be short)

// Every terra1… string the registry names as machinery for this collection + every venue address.
function systemAddresses(collectionJson, venues) {
  const out = new Set(); const walk = (v) => { if (!v) return; if (typeof v === 'string') { if (/^terra1[0-9a-z]{38,58}$/.test(v)) out.add(v); return; } if (Array.isArray(v)) return v.forEach(walk); if (typeof v === 'object') { Object.keys(v).forEach(walk); Object.values(v).forEach(walk); } };   // keys too: capture.custodians is keyed BY address
  const c = collectionJson || {}; walk(c.nft_contract); walk(c.capture); walk(c.governance); walk(c.backing);
  for (const v of Object.values(venues || {})) if (v && v.address) out.add(v.address);
  return out;
}

// ---- position rules: which records open, move, or close a wallet's position on a token ------------------------------
// role 'to' = the record's `to` is this wallet; role 'from' = the record's `from` is. A kind not listed changes nothing
// (bid / offer / lock_add / lock_extend … are events on the wallet, not custody changes).
const ACQUIRE = { to: new Set(['mint', 'mint_purchase', 'transfer', 'sale', 'lock_create', 'lock_split', 'lock_transfer']) };
const RELEASE = { from: new Set(['transfer', 'sale', 'burn', 'lock_withdraw', 'lock_transfer']) };
// state moves — the wallet still holds the token, its custody changed. `to`-side moves also OPEN a position when none is
// open (a delist / claim / unstake_enterprise on a token the ledger never saw the wallet acquire = pre-ledger holding).
const STATE = {
  from: { list: (r) => 'listed:' + (r.venue || '?'), stake: () => 'staked', stake_enterprise: () => 'staked_enterprise', venue_in: (r) => 'escrow:' + (r.venue || '?'), break: null /* flag only */ },
  to:   { delist: () => 'liquid', claim: () => 'liquid', unstake: () => 'unstaking', unstake_enterprise: () => 'liquid', venue_out: () => 'liquid' },
};
const OPEN_STATE = { mint: 'liquid', mint_purchase: 'liquid', transfer: 'liquid', sale: 'liquid', lock_create: 'locked', lock_split: 'locked', lock_transfer: 'locked' };
// Replay order inside one block: the ledger carries no tx index, so two txs at one height (a buy-now settle and the
// buyer's immediate transfer on) can land in either order. A wallet cannot move what it has not received: acquisitions
// replay first, then returns from custody, then transfers, then custody entries, then destructions.
const KIND_RANK = { mint: 0, mint_purchase: 1, sale: 2, lock_create: 2, lock_split: 2, lock_migrate: 2, claim: 3, unstake_enterprise: 3, venue_out: 3, delist: 3, unstake: 3, transfer: 4, lock_transfer: 4, list: 5, stake: 5, stake_enterprise: 5, venue_in: 5, break: 6, lock_merge: 6, burn: 7, lock_withdraw: 7 };
const rank = (k) => KIND_RANK[k] == null ? 8 : KIND_RANK[k];
function orderRows(rows) { return rows.slice().sort((a, b) => a.height - b.height || rank(a.kind) - rank(b.kind) || (a.msg_index || 0) - (b.msg_index || 0)); }

const money = (r) => (r && r.price && r.price.amount != null) ? { amount: r.price.amount, denom: r.price.denom || null, symbol: r.denom_symbol || null, decimals: r.denom_decimals == null ? null : r.denom_decimals, usd: r.usd == null ? null : r.usd, usd_basis: r.usd_basis || null } : null;
const units = (m) => (m && m.amount != null && m.decimals != null) ? Number(m.amount) / Math.pow(10, m.decimals) : null;
const stamp = (r) => ({ kind: r.kind, ts: r.ts, height: r.height, txhash: r.txhash, venue: r.venue || undefined, price: money(r) || undefined });
const days = (a, b) => (a && b) ? Math.round((Date.parse(b) - Date.parse(a)) / 864e5 * 10) / 10 : null;

// P&L two ways: USD at each end; token units only when both ends are priced in the SAME symbol (a LUNA buy sold for
// bLUNA is not a LUNA-terms number — null, and the reader says so).
function pnl(acq, rel) {
  const a = acq && acq.price, b = rel && rel.price; if (!a || !b) return { usd: null, token: null, note: 'one end unpriced' };
  const usd = (a.usd != null && b.usd != null) ? Math.round((b.usd - a.usd) * 100) / 100 : null;
  const ua = units(a), ub = units(b);
  const token = (a.symbol && a.symbol === b.symbol && ua != null && ub != null) ? { symbol: a.symbol, delta: Math.round((ub - ua) * 1e6) / 1e6, paid: ua, received: ub } : null;
  return { usd, token, note: token ? undefined : (a.symbol && b.symbol ? `bought in ${a.symbol}, sold in ${b.symbol} — no single-token basis` : 'symbol unknown on one end') };
}

// custodians: address → role (the registry's capture.custodians). A wallet's transfer INTO a custodian is a custody
// change (the token is still theirs), a custodian's transfer back is the return; a custodian→custodian move (the 2023
// pixeLions staking v1 → Enterprise migration: 4,199 tokens moved by the contracts, never by the holders) re-labels the
// holder's state without touching the position. Both read from the registry — the engine holds no address.
const stateOfRole = (role) => role === 'daodao_voting' ? 'staked' : role === 'enterprise_staking' ? 'staked_enterprise' : 'staked:' + role;
function makeProjector({ system = new Set(), custodians = new Map(), wanted = null /* Set of shard names | null = all */ } = {}) {
  const W = new Map();   // address → wallet state
  const HOLDER = new Map();   // token_id → address (among the wallets being built) — for custodian→custodian moves
  const isWallet = (a) => typeof a === 'string' && a && !system.has(a) && (!wanted || wanted.has(shardOf(a)));
  const roleOf = (a) => custodians.get(a) || null;
  // The ledger next saw the token with someone else and the leg out of the previous holder is not in it (a 2023 FCD-era
  // gap, a contract the walk did not watch): close the stale position and SAY so — a wallet is never shown holding a
  // token the chain has since given to another address.
  function closeGap(prevAddr, id, r, newAddr) {
    const pw = W.get(prevAddr); const pos = pw && pw.open.get(id); if (!pos) return;
    pw.open.delete(id); pw.past.push({ token_id: id, acquired: pos.acquired, opened_by: pos.opened_by, released: { kind: 'gap', ts: r.ts, height: r.height, txhash: r.txhash, note: `next seen with ${newAddr} (${r.kind} from ${r.from || '?'}); the leg out of this wallet is not in the ledger` }, held_days: days(pos.acquired ? pos.acquired.ts : pos.since, r.ts), broken: pos.broken || undefined });
    pw.counts.gap_closed = (pw.counts.gap_closed || 0) + 1;
  }
  const takeOver = (id, w, r) => { const prev = HOLDER.get(id); if (prev && prev !== w.address) closeGap(prev, id, r, w.address); HOLDER.set(id, w.address); };
  const wallet = (a) => { let w = W.get(a); if (!w) { w = { address: a, first_seen: null, last_seen: null, counts: {}, open: new Map(), past: [], events: [] }; W.set(a, w); } return w; };
  function touch(w, r, role) {
    const ev = Object.assign({}, r, { role }); w.events.push(ev);
    if (!w.first_seen || r.ts < w.first_seen) w.first_seen = r.ts; if (!w.last_seen || r.ts > w.last_seen) w.last_seen = r.ts;
    const ck = role === 'to' ? ({ sale: 'bought', mint_purchase: 'minted', transfer: 'transfers_in', claim: 'claims', unstake: 'unstakes', unstake_enterprise: 'unstakes_enterprise', delist: 'delists', lock_create: 'locks_created', lock_transfer: 'locks_received' })[r.kind]
                              : ({ sale: 'sold', transfer: 'transfers_out', list: 'listings', stake: 'stakes', stake_enterprise: 'stakes_enterprise', bid: 'bids', offer: 'offers', break: 'breaks', burn: 'burns', lock_withdraw: 'locks_withdrawn', lock_transfer: 'locks_sent', lock_add: 'lock_adds', lock_merge: 'lock_merges' })[r.kind];
    if (ck) w.counts[ck] = (w.counts[ck] || 0) + 1;
    if (r.token_id == null) return;
    const id = String(r.token_id); const pos = w.open.get(id);
    // custody moves by address (registry custodians): a transfer into one keeps the position, into a new state
    if (role === 'from' && roleOf(r.to) && (r.kind === 'transfer' || r.kind === 'stake' || r.kind === 'stake_enterprise')) {
      const st = stateOfRole(roleOf(r.to));
      if (pos) { pos.state = st; pos.since = r.ts; pos.since_height = r.height; } else w.open.set(id, { token_id: id, state: st, since: r.ts, since_height: r.height, acquired: null, opened_by: stamp(r), broken: false });
      HOLDER.set(id, w.address); return;
    }
    if (role === 'to' && roleOf(r.from) && (r.kind === 'transfer' || r.kind === 'claim' || r.kind === 'unstake_enterprise' || r.kind === 'unstake')) {
      const st = r.kind === 'unstake' ? 'unstaking' : 'liquid';
      if (pos) { pos.state = st; pos.since = r.ts; pos.since_height = r.height; if (r.kind === 'unstake' && r.claim_duration) pos.claim_duration = r.claim_duration; }
      else w.open.set(id, { token_id: id, state: st, since: r.ts, since_height: r.height, acquired: null, opened_by: stamp(r), broken: false });   // came back from a custodian the ledger never saw it enter (pre-ledger)
      takeOver(id, w, r); return;
    }
    if (role === 'to' && ACQUIRE.to.has(r.kind)) {
      if (pos) { pos.state = OPEN_STATE[r.kind] || pos.state; pos.since = r.ts; takeOver(id, w, r); return; }   // already open (e.g. a transfer back after a claim the ledger missed): a state refresh, not a second position
      w.open.set(id, { token_id: id, state: OPEN_STATE[r.kind] || 'liquid', since: r.ts, since_height: r.height, acquired: stamp(r), broken: false }); takeOver(id, w, r); return;
    }
    if (role === 'from' && RELEASE.from.has(r.kind)) {
      if (!pos) { w.past.push({ token_id: id, acquired: null, opened_by: null, released: stamp(r), held_days: null, note: 'no acquisition record in the ledger (pre-ledger holding or a gap) — the release proves it was held, nothing more' }); w.counts.released_without_acquisition = (w.counts.released_without_acquisition || 0) + 1; if (HOLDER.get(id) === w.address) HOLDER.delete(id); return; }
      w.open.delete(id); if (HOLDER.get(id) === w.address) HOLDER.delete(id); const rel = stamp(r);
      w.past.push({ token_id: id, acquired: pos.acquired, opened_by: pos.opened_by, released: rel, held_days: days(pos.acquired ? pos.acquired.ts : pos.since, r.ts), broken: pos.broken || undefined, pnl: (pos.acquired && r.kind === 'sale' && pos.acquired.price) ? pnl(pos.acquired, rel) : undefined });
      return;
    }
    if (role === 'from' && r.kind === 'lock_merge' && r.lineage && Array.isArray(r.lineage.burned)) { for (const b of r.lineage.burned) { const p = w.open.get(String(b)); if (p) { w.open.delete(String(b)); w.past.push({ token_id: String(b), acquired: p.acquired, opened_by: p.opened_by, released: Object.assign(stamp(r), { note: 'merged into ' + id }), held_days: days(p.acquired ? p.acquired.ts : p.since, r.ts) }); } } if (!w.open.get(id)) w.open.set(id, { token_id: id, state: 'locked', since: r.ts, since_height: r.height, acquired: null, opened_by: stamp(r), broken: false }); return; }
    if (role === 'from' && r.kind === 'lock_migrate' && r.lineage && r.lineage.from_ids) { for (const o of r.lineage.from_ids) { const p = w.open.get(String(o)); if (p && String(o) !== id) { w.open.delete(String(o)); w.past.push({ token_id: String(o), acquired: p.acquired, opened_by: p.opened_by, released: Object.assign(stamp(r), { note: 'migrated to ' + id }), held_days: days(p.acquired ? p.acquired.ts : p.since, r.ts) }); } } if (!w.open.get(id)) w.open.set(id, { token_id: id, state: 'locked', since: r.ts, since_height: r.height, acquired: null, opened_by: stamp(r), broken: false }); return; }
    const mv = STATE[role] && STATE[role][r.kind];
    if (role === 'from' && r.kind === 'break') { if (pos) pos.broken = true; return; }
    if (mv) {
      if (pos) { pos.state = mv(r); pos.since = r.ts; pos.since_height = r.height; if (r.kind === 'unstake' && r.claim_duration) pos.claim_duration = r.claim_duration; }
      else w.open.set(id, { token_id: id, state: mv(r), since: r.ts, since_height: r.height, acquired: null, opened_by: stamp(r), broken: false });   // pre-ledger holding: the ledger saw the wallet get it BACK (to) or list/stake it (from), never get it
      takeOver(id, w, r);   // the token is with this wallet now — a stale position elsewhere closes as a labeled gap
    }
  }
  return {
    add(r) {
      if (!r || r.superseded_by) return;
      if (r.from && r.from === r.to) { if (isWallet(r.from)) { const w = wallet(r.from); w.events.push(Object.assign({}, r, { role: 'self' })); if (!w.last_seen || r.ts > w.last_seen) w.last_seen = r.ts; if (!w.first_seen || r.ts < w.first_seen) w.first_seen = r.ts; } return; }   // a self-transfer moves nothing
      if (isWallet(r.from)) touch(wallet(r.from), r, 'from'); if (isWallet(r.to)) touch(wallet(r.to), r, 'to');
      // custodian → custodian (a migration the contracts did): the holder's state follows the token, the position stays
      if (r.token_id != null && roleOf(r.from) && roleOf(r.to)) { const h = HOLDER.get(String(r.token_id)); const w = h && W.get(h); const pos = w && w.open.get(String(r.token_id)); if (pos) { pos.state = stateOfRole(roleOf(r.to)); pos.since = r.ts; pos.since_height = r.height; w.events.push(Object.assign({}, r, { role: 'holder' })); if (!w.last_seen || r.ts > w.last_seen) w.last_seen = r.ts; } }
    },
    finish() {
      const out = {};
      for (const [a, w] of W) {
        const holdings = [...w.open.values()].sort((x, y) => Number(x.token_id) - Number(y.token_id) || String(x.token_id).localeCompare(String(y.token_id)));
        const byState = {}; for (const h of holdings) byState[h.state] = (byState[h.state] || 0) + 1;
        const trips = w.past.filter(p => p.pnl); const usd = trips.filter(p => p.pnl.usd != null), tok = trips.filter(p => p.pnl.token && p.pnl.token.symbol === 'LUNA');
        w.events.sort((x, y) => x.height - y.height || x.msg_index - y.msg_index || String(x.kind).localeCompare(String(y.kind)));
        out[a] = {
          address: a, first_seen: w.first_seen, last_seen: w.last_seen, events_count: w.events.length, counts: w.counts,
          holdings_now: { total: holdings.length, by_state: byState, tokens: holdings },
          held_past: { total: w.past.length, distinct_tokens: new Set(w.past.map(p => p.token_id)).size, tokens: w.past.sort((x, y) => x.released.height - y.released.height) }, held_past_note: 'closed positions; acquired:null = the ledger never saw the wallet get the token (it saw it leave, list, stake or come back), never a guess',
          held_ever_distinct: new Set([...w.past.map(p => p.token_id), ...holdings.map(h => h.token_id)]).size,
          realized: { round_trips: trips.length, usd: { priced: usd.length, total: usd.length ? Math.round(usd.reduce((s, p) => s + p.pnl.usd, 0) * 100) / 100 : null }, luna: { priced: tok.length, total: tok.length ? Math.round(tok.reduce((s, p) => s + p.pnl.token.delta, 0) * 1e6) / 1e6 : null }, note: 'P&L two ways: USD at each end (oracle day), and LUNA-terms only when both ends were LUNA — a buy in LUNA sold for bLUNA/USDC has no LUNA number (null)' },
          events: w.events,
        };
      }
      return out;
    },
    size() { return W.size; },
  };
}

// Group the finished wallet map into shard bodies.
function shardBodies(slug, wallets, { system, wanted } = {}) {
  const groups = {}; for (const [a, w] of Object.entries(wallets)) { const sh = shardOf(a); if (wanted && !wanted.has(sh)) continue; (groups[sh] ||= {})[a] = w; }
  const bodies = {};
  for (const sh of (wanted ? [...wanted] : Object.keys(groups))) {
    const ws = groups[sh] || {}; const addrs = Object.keys(ws).sort(); const ordered = {}; addrs.forEach(a => ordered[a] = ws[a]);
    bodies[sh] = { product: `${slug}/ledger/by-wallet`, collection: slug, shard: sh, shard_of: 'last character of the bech32 address (terra1…x77ulw → w); non-terra → x', wallets_in_shard: addrs.length, records: addrs.reduce((s, a) => s + ws[a].events_count, 0), system_addresses_excluded: system ? system.size : undefined, rules: RULES, note: 'every live ledger record naming this address as from or to (superseded rows excluded), + its positions replayed: holdings_now (state per token), held_past (closed positions with P&L two ways), counts. A position with acquired:null was opened by a custody move the ledger saw without the acquisition (pre-ledger) — labeled, never invented.', wallets: ordered };
  }
  return bodies;
}
const RULES = { replay_order: 'by height, then acquisition → return-from-custody → transfer → custody-entry → destruction (a wallet cannot move what it has not received), then msg_index', custodian_moves: 'a wallet\'s transfer/stake into a registry custodian = state change (staked / staked_enterprise / staked:<role>), the custodian\'s transfer back = liquid, a custodian→custodian move re-labels the holder\'s state (role: holder)', acquire_when_to: [...ACQUIRE.to].sort(), release_when_from: [...RELEASE.from].sort(), state_when_from: Object.keys(STATE.from), state_when_to: Object.keys(STATE.to), states: ['liquid', 'listed:<venue>', 'staked', 'staked_enterprise', 'unstaking', 'escrow:<venue>', 'locked'] };

module.exports = { VERSION, SHARDS, shardOf, systemAddresses, makeProjector, shardBodies, orderRows, RULES, pnl };
