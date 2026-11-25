'use strict';
/**
 * tla-flows / lib/contract-state.js 1.0.0 (2026-11-25) — CONTRACT STATE, read from the chain and compared with the read before.
 *
 * Why: a transaction's events say THAT something changed and who sent it; they often do not say WHAT it is now. The
 * address book of the TLA (the global config's role → address map) is the clearest case: `set_addresses` emits no
 * attributes, so the walk records "the address book was changed" and nothing else. The state read answers the other
 * half — what each role points at, and who can upgrade each contract — and files every difference from the read before.
 *
 * What is read (LCD, two request shapes, both already used by other crons of this repo)
 *   GET /cosmwasm/wasm/v1/contract/<addr>                      → { contract_info: { code_id, creator, admin, label } }
 *   GET /cosmwasm/wasm/v1/contract/<global config>/smart/<b64 {"all_addresses":{}}>
 *                                                              → { data: [[role, address], …] }
 *       the shape the legacy registry cron stored on 2026-08-11 (tla-core docs/archive/legacy-registry, raw.global_config_all_addresses)
 *       and the site's chain-queries page documents ("Array of [role, address] pairs").
 *
 * What is filed: one record per difference, in the contract-watch stream's own shape, marked `observed: 'state-read'`:
 *   kind 'role'    action 'address_book'  detail { role, before, after, seen_after, seen_by }
 *   kind 'admin'   action 'admin'         detail { before, after, seen_after, seen_by }
 *   kind 'upgrade' action 'code_id'       detail { before, after, seen_after, seen_by }
 * A state record has no transaction and no signer: it says a value was A at one read and B at the next. The transaction
 * that did it is in the same stream when the walk saw it (same contract, between the two reads).
 *
 * Never from a failed read: a contract whose read fails keeps its previous entry (and its previous read time), an address
 * book that does not parse is an error and nothing is compared. A first sighting (no previous entry) files nothing.
 */
const crypto = require('crypto');
const VERSION = 'contract-state-1.0.0';
const ADDR_RE = /^terra1(?:[0-9a-z]{38}|[0-9a-z]{58})$/;
const BOOK_QUERY = { all_addresses: {} };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');

// { all_addresses: {} } → { ok, entries: { ROLE: address }, why }
function parseAddressBook(data) {
  if (!Array.isArray(data) || !data.length) return { ok: false, why: 'not a non-empty array' };
  const entries = {};
  for (const it of data) {
    if (!Array.isArray(it) || it.length !== 2 || typeof it[0] !== 'string' || !it[0] || typeof it[1] !== 'string') return { ok: false, why: 'an entry is not a [role, address] pair' };
    if (!ADDR_RE.test(it[1])) return { ok: false, why: `role ${it[0]} does not hold a terra address` };
    if (it[0] in entries) return { ok: false, why: `role ${it[0]} appears twice` };
    entries[it[0]] = it[1];
  }
  return { ok: true, entries };
}
// the LCD's contract answer → { code_id, admin, creator, label } | null
function parseContractInfo(resp) {
  const ci = resp && resp.contract_info;
  if (!ci || ci.code_id == null || !/^\d+$/.test(String(ci.code_id))) return null;
  const addr = (v) => (typeof v === 'string' && ADDR_RE.test(v) ? v : null);
  return { code_id: String(ci.code_id), admin: addr(ci.admin), creator: addr(ci.creator), label: typeof ci.label === 'string' ? ci.label.slice(0, 200) : null };
}

const keyOf = (parts) => 'state:' + crypto.createHash('sha1').update(parts.map(p => p == null ? '' : String(p)).join('|')).digest('hex').slice(0, 20);
// the same transition seen from the same previous read always has the same key: a retried run files it once
function rec({ kind, contract, action, detail, height, timestamp, keyParts }) {
  return { schemaVersion: 1, k: keyOf(keyParts), txhash: null, height: Number(height) || 0, timestamp, kind, contract, action, detail, signer: null, msg_type: null, via: null, observed: 'state-read' };
}

/**
 * prev / cur: { address_book: { contract, capturedAt, entries }, contracts: { addr: { code_id, admin, creator, label, capturedAt } } }
 * Only what BOTH reads hold is compared; `cur` entries carried over from `prev` (same capturedAt) are not a new read.
 */
function diffState(prev, cur, { height } = {}) {
  const out = [];
  const pb = prev && prev.address_book, cb = cur && cur.address_book;
  if (pb && cb && pb.entries && cb.entries && pb.contract === cb.contract && cb.capturedAt && cb.capturedAt !== pb.capturedAt) {
    for (const role of [...new Set([...Object.keys(pb.entries), ...Object.keys(cb.entries)])].sort()) {
      const before = pb.entries[role] || null, after = cb.entries[role] || null;
      if (before === after) continue;
      out.push(rec({ kind: 'role', contract: cb.contract, action: 'address_book', height, timestamp: cb.capturedAt,
        detail: { role, before, after, seen_after: pb.capturedAt || null, seen_by: cb.capturedAt }, keyParts: [cb.contract, 'book', role, before, after, pb.capturedAt] }));
    }
  }
  const pc = (prev && prev.contracts) || {}, cc = (cur && cur.contracts) || {};
  for (const a of Object.keys(cc).sort()) {
    const p = pc[a], c = cc[a];
    if (!p || !c || !c.capturedAt || c.capturedAt === p.capturedAt) continue;                 // first sighting, or carried over from a failed read
    const win = { seen_after: p.capturedAt || null, seen_by: c.capturedAt };
    if (p.code_id != null && c.code_id != null && String(p.code_id) !== String(c.code_id))
      out.push(rec({ kind: 'upgrade', contract: a, action: 'code_id', height, timestamp: c.capturedAt, detail: { before: String(p.code_id), after: String(c.code_id), ...win }, keyParts: [a, 'code_id', p.code_id, c.code_id, p.capturedAt] }));
    if ((p.admin || null) !== (c.admin || null))
      out.push(rec({ kind: 'admin', contract: a, action: 'admin', height, timestamp: c.capturedAt, detail: { before: p.admin || null, after: c.admin || null, ...win }, keyParts: [a, 'admin', p.admin, c.admin, p.capturedAt] }));
  }
  return out;
}

/**
 * One read of the chain. get(path) → parsed JSON or throws (the caller supplies endpoint fallback).
 * → { state, stats: { contracts, read, unread: [addr], book: 'read' | 'kept' | 'none', errors: [] } }
 */
async function readState({ get, watch, bookContract, prev, now, conc = 4, builder }) {
  const at = (now || new Date()).toISOString();
  const stats = { contracts: 0, read: 0, unread: [], book: 'none', errors: [] };
  const state = { schemaVersion: 1, product: 'contract-watch/state', builder: builder || VERSION, capturedAt: at,
    note: 'Each watched contract as the chain reports it (code id, admin, creator, label) and the TLA address book (the global config\'s role → address map). An entry\'s own capturedAt is when THAT value was last read; a read that fails keeps the entry before it.',
    address_book: (prev && prev.address_book) || null, contracts: {} };
  if (bookContract) {
    try {
      const r = await get(`/cosmwasm/wasm/v1/contract/${bookContract}/smart/${b64(BOOK_QUERY)}`);
      const p = parseAddressBook(r && r.data);
      if (!p.ok) throw new Error(`address book: ${p.why}`);
      state.address_book = { contract: bookContract, capturedAt: at, source: 'chain: smart query {"all_addresses":{}}', entries: p.entries }; stats.book = 'read';
    } catch (e) { stats.errors.push(String(e.message || e)); stats.book = state.address_book ? 'kept' : 'none'; }
  }
  const addrs = [...watch].filter(a => /^terra1[0-9a-z]{58}$/.test(a)).sort(); stats.contracts = addrs.length;
  const pc = (prev && prev.contracts) || {}; let i = 0;
  const worker = async () => {
    while (i < addrs.length) {
      const a = addrs[i++]; let info = null;
      try { info = parseContractInfo(await get(`/cosmwasm/wasm/v1/contract/${a}`)); } catch (e) { info = null; }
      if (info) { state.contracts[a] = { ...info, capturedAt: at }; stats.read++; }
      else { stats.unread.push(a); if (pc[a]) state.contracts[a] = pc[a]; }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, conc) }, worker));
  // a contract that left the watch keeps its last entry: the record of what it was is not dropped
  for (const a of Object.keys(pc)) if (!state.contracts[a]) state.contracts[a] = pc[a];
  state.contracts = Object.fromEntries(Object.keys(state.contracts).sort().map(a => [a, state.contracts[a]]));
  state.counts = { contracts: Object.keys(state.contracts).length, read_this_time: stats.read, not_read_this_time: stats.unread.length, address_book: stats.book };
  return { state, stats };
}

module.exports = { VERSION, BOOK_QUERY, parseAddressBook, parseContractInfo, diffState, readState, keyOf };
