'use strict';
/**
 * tla-flows / lib/admin-classifier.js 1.1.0 (2026-11-25) — CONTRACT CHANGES, read from a transaction's events.
 * 1.1.0: each record carries msg_index — which message of the transaction it came from (the event's own msg_index, else the
 * count of message boundaries) — so the message as sent can be put beside it (lib/tx-messages.js).
 *
 * Why: on 2026-11-24 the single gauge's reward list lost two assets and nothing we capture could say who sent it — the walk
 * saw the transaction (it touches a watched staking contract) and dropped it, because it is not a deposit, withdrawal or
 * claim. This classifier keeps what the flow classifier drops: every event that changes what a contract IS or DOES.
 *
 * Input is the walk's own record of a transaction — { txhash, height, timestamp, code, events } — exactly what
 * block_results gives; no tx body and no chain read. Proven on the stored walk of 1,103,059 transactions
 * (tla-core tla-flows/raw, 2025-01 → 2026-06): the vocabulary below is every such action seen there.
 *
 * What is kept
 *   1. wasmd's own lifecycle events, for ANY contract on the chain:
 *        migrate               { code_id }                  → kind 'upgrade'  (+ the contract's own
 *                                                             previous/new name and version when it reports them)
 *        update_contract_admin { new_admin_address }        → kind 'admin'    ('' = the admin was cleared)
 *        store_code            { code_id, code_checksum }   → kind 'code'     (new code uploaded; no contract yet)
 *   2. wasm events of WATCHED contracts whose action changes a list, a setting, a role or the governance of the
 *      contract (CHANGE_RE), plus the weekly distribution set (kind 'epoch', routine: true).
 *   Everything else — every user action, every callback — is not a change and is not kept.
 *
 * Who and how, from the same events
 *   signer : the account that sent the message the event belongs to (the `message` event before it)
 *   via    : { kind: 'dao_proposal', dao, proposal_module, proposal_id } when a DAO DAO proposal module's
 *            `execute` event precedes it in the same message — the change is that proposal being executed;
 *            { kind: 'authz', grantee } when the message is an authz MsgExec; null = sent directly.
 *
 * Not seen here (stated on the product): changes made by chain governance at the end of a block (they are not in a
 * transaction's events), and settings whose contract emits no action attribute. The daily state read catches both as a
 * before → after without a sender.
 */
const VERSION = 'admin-classifier-1.1.0';
const MAX_VALUE = 1500;   // one attribute value as kept in a record (an asset list can run long)

const LIFECYCLE = {
  migrate: { kind: 'upgrade', action: 'migrate' },
  update_contract_admin: { kind: 'admin', action: 'update_admin' },
  store_code: { kind: 'code', action: 'store_code' },
};
// An action name's LAST segment (after / _ or -) decides. Built from the census of the stored walk: 238 distinct wasm
// action names, of which these match 20 (121 events in 17 months) and none of the user actions or callbacks.
const CHANGE_RE = /(^|[/_-])(whitelist\w*|remove_assets?|update_(config|asset_config|params|parameters|owner\w*|admin|members|bridges|fees?|blacklist|proposal_modules|voting_module|sub_daos_list|minter|marketing|allowed\w*|limits?|rates?)|set_(config|address(es)?|admin|owner|fees?|item|take_rate|params|limits?)|(transfer|accept|claim|propose|drop)_(ownership|owner|new_owner)|accept_admin_nomination|nominate_admin|withdraw_admin_nomination|admin_msgs|(add|remove)_hook|remove_item|blacklist\w*|unpause|pause|initialize_asset|alliance_(re|un)?delegate|deregister|upload_logo|withdraw_reserves?)$/;
const EPOCH_RE = /(^|[/_-])(set_distribution|set_asset_reward_distribution)$/;
const KIND_RULES = [
  [/(whitelist\w*|remove_assets?|initialize_asset|deregister)$/, 'list'],
  [/(update_(members|proposal_modules|voting_module|sub_daos_list)|accept_admin_nomination|nominate_admin|withdraw_admin_nomination|admin_msgs|(add|remove)_hook|set_item|remove_item)$/, 'governance'],
  [/(set_address(es)?|set_admin|set_owner|update_owner\w*|update_admin|update_minter|(transfer|accept|claim|propose|drop)_(ownership|owner|new_owner))$/, 'role'],
  [/(blacklist\w*|unpause|pause)$/, 'guard'],
  [/alliance_(re|un)?delegate$/, 'delegation'],
  [/withdraw_reserves?$/, 'reserve'],
];
function kindOfAction(action) {
  if (EPOCH_RE.test(action)) return 'epoch';
  if (!CHANGE_RE.test(action)) return null;
  for (const [re, k] of KIND_RULES) if (re.test(action)) return k;
  return 'setting';
}

const pairsOf = (ev) => (ev && ev.attributes || []).map(a => [a.key, a.value]);
const get = (pairs, k) => { for (const p of pairs) if (p[0] === k) return p[1]; return undefined; };
const clip = (v) => { const s = String(v == null ? '' : v); return s.length > MAX_VALUE ? s.slice(0, MAX_VALUE) + '…' : s; };
// attributes as an object; a key that repeats becomes an array (a gauge's set_distribution repeats gauge / periods)
function detailOf(pairs, drop) {
  const o = {};
  for (const [k, v] of pairs) {
    if (k == null || drop.has(k)) continue;
    const val = clip(v);
    if (!(k in o)) o[k] = val; else if (Array.isArray(o[k])) o[k].push(val); else o[k] = [o[k], val];
  }
  return o;
}
const DROP = new Set(['_contract_address', 'msg_index', 'authz_msg_index']);

/**
 * txr: { txhash, height, timestamp, code, events }   watch: Set (or anything with .has) of watched contract addresses
 * → [ { schemaVersion, k (= txhash:n — the key of the shared mergeKeyed law), txhash, height, timestamp, kind, contract, action, detail, signer, msg_type, msg_index, via, routine? } ]
 */
function classifyAdminTx(txr, watch) {
  if (!txr || Number(txr.code || 0) !== 0) return [];
  const out = []; let msg = null, firstSender = null, feePayer = null, via = null, lastUpgrade = null, msgCount = -1, evIndex = null;
  const idxOf = (pairs) => { const v = get(pairs, 'msg_index'); return v != null && /^\d+$/.test(String(v)) ? Number(v) : null; };
  const push = (kind, contract, action, detail, extra) => {
    const rec = { schemaVersion: 1, k: `${txr.txhash}:${out.length}`, txhash: txr.txhash, height: Number(txr.height), timestamp: txr.timestamp,
      kind, contract: contract || null, action, detail, signer: (msg && msg.sender) || firstSender || feePayer || null, msg_type: msg ? msg.type : null, msg_index: msg ? (evIndex != null ? evIndex : msg.index) : null,
      via: via || (msg && /\.MsgExec$/.test(msg.type || '') ? { kind: 'authz', grantee: msg.sender || null } : null) };
    if (extra) Object.assign(rec, extra);
    out.push(rec); return rec;
  };
  for (const ev of txr.events || []) {
    const t = ev.type, pairs = pairsOf(ev);
    if (t === 'tx') { const fp = get(pairs, 'fee_payer'); if (fp && !feePayer) feePayer = fp; continue; }
    if (t === 'message') {
      const a = get(pairs, 'action'), s = get(pairs, 'sender'); if (s && !firstSender) firstSender = s;
      if (a) { msgCount++; const mi = idxOf(pairs); msg = { type: a, sender: s || null, index: mi != null ? mi : msgCount }; via = null; lastUpgrade = null; }   // a new message: what came before does not explain it
      continue;
    }
    const contract = get(pairs, '_contract_address'); evIndex = idxOf(pairs);
    if (LIFECYCLE[t]) {
      const L = LIFECYCLE[t], d = detailOf(pairs, DROP);
      const action = t === 'update_contract_admin' && !d.new_admin_address ? 'clear_admin' : L.action;
      const rec = push(L.kind, contract, action, d);
      lastUpgrade = t === 'migrate' ? rec : null;
      continue;
    }
    if (t !== 'wasm') continue;
    // the contract's own report after its migrate: previous / new name and version
    if (lastUpgrade && contract === lastUpgrade.contract && (get(pairs, 'new_contract_version') != null || get(pairs, 'previous_contract_version') != null)) {
      for (const k of ['previous_contract_name', 'previous_contract_version', 'new_contract_name', 'new_contract_version']) { const v = get(pairs, k); if (v != null) lastUpgrade.detail[k] = clip(v); }
      lastUpgrade = null; continue;
    }
    const actions = pairs.filter(p => p[0] === 'action' || p[0] === 'method').map(p => String(p[1]));
    // a DAO DAO proposal module executing a passed proposal: everything after it in this message is that proposal
    if (actions.includes('execute') && get(pairs, 'proposal_id') != null && get(pairs, 'dao')) {
      via = { kind: 'dao_proposal', dao: get(pairs, 'dao'), proposal_module: contract, proposal_id: String(get(pairs, 'proposal_id')) }; continue;
    }
    // kept: a watched contract, or ANY contract a watched DAO's proposal is changing (its member group, a sub-DAO, a treasury tool)
    if (!contract || !watch || !(watch.has(contract) || (via && via.kind === 'dao_proposal' && watch.has(via.dao)))) continue;
    const hit = actions.find(a => CHANGE_RE.test(a)) || actions.find(a => EPOCH_RE.test(a));
    if (!hit) continue;
    const kind = kindOfAction(hit);
    push(kind, contract, hit, detailOf(pairs.filter(p => !(p[0] === 'action' && p[1] === hit)), DROP), kind === 'epoch' ? { routine: true } : null);
  }
  return out;
}

// The watched set: every structural contract the crons name, every named contract of the curated registry, every contract
// of the capture registry, and a curated extra list. Addresses only (contracts are 64 characters; a wallet is never watched).
function adminWatchFrom({ config, known, registry, extra } = {}) {
  const set = new Set(); const add = (a) => { if (typeof a === 'string' && /^terra1[0-9a-z]{58}$/.test(a)) set.add(a); };
  (function walk(o, depth) { if (depth > 4 || o == null) return; if (typeof o === 'string') return add(o); if (typeof o === 'object') for (const v of Object.values(o)) walk(v, depth + 1); })(config, 0);
  const k = known && (known.contracts || known); if (k && typeof k === 'object') for (const a of Object.keys(k)) add(a);
  for (const c of (registry && registry.contracts) || []) add(c && c.address);
  for (const c of (extra && (extra.contracts || extra.watch)) || []) add(typeof c === 'string' ? c : c && c.address);
  return set;
}

// One month of the stream, as contract-watch/index.json lists it (records sorted by height, as filed).
function monthSummary(arr) {
  const ch = arr.filter(r => !r.routine);
  return { n: arr.length, changes: ch.length, first: arr.length ? arr[0].timestamp : null, last: arr.length ? arr[arr.length - 1].timestamp : null, last_change: ch.length ? ch[ch.length - 1].timestamp : null };
}

module.exports = { VERSION, classifyAdminTx, adminWatchFrom, kindOfAction, monthSummary, CHANGE_RE, EPOCH_RE, LIFECYCLE };
