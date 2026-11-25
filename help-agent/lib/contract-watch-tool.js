'use strict';
// help-agent/lib/contract-watch-tool.js 1.0.0 (2026-11-25, v1.24.0) — Contract Watch as a bot tool.
//
// Owner: "get the help bot brought up to speed … so it can answer questions on what we have added in here." One tool reads the SAME
// files contract-watch.html renders (tla-core contract-watch/** and docs/curated/contract-watch.json) and returns FACTS ONLY:
//   overview — the record at a glance: how many changes, by route and kind, the latest ones, what the record covers
//   changes  — the changes that match (contract by name or address, kind, route, dates, a search word), newest first
//   contract — one contract: its group, code id, admin (and how that admin signs), what each kind of change on it requires, its changes
//   roles    — the TLA address book: who holds each role, what the role is required for (the contracts' own answers), how the holder signs
//   address  — one address: the roles it holds, the contracts it can upgrade, how it signs, the changes it sent
// It does NOT decide whether a change "needs a look": that mark is worked out by the page when it loads (its four rules are in the
// knowledge chapter). Every row carries the page link where the mark, the vote and the before / after are shown. No motive, no person:
// an address is named only as the groups file or the DAO list names it.
// Pure over an injected fetchJson (the gate passes local files); cached 10 min per file.

const CORE = 'https://raw.githubusercontent.com/thealliancedao/tla-core/main';
const PAGE = 'https://theadao.com/contract-watch.html';
const TREE = 'https://github.com/thealliancedao/tla-core/blob/main/';
const VERSION = 'contract-watch-tool-1.0.0';
const TTL = 10 * 60 * 1000;

const isAddr = (a) => /^terra1(?:[0-9a-z]{38}|[0-9a-z]{58})$/.test(a || '');
const isContract = (a) => /^terra1[0-9a-z]{58}$/.test(a || '');
const isAccount = (a) => isAddr(a) && !isContract(a);
const lastSeg = (a) => String(a || '').split('/').pop();
const bare = (d) => String(d || '').replace(/^(cw20|native):/, '');
const dayOf = (iso) => (iso ? String(iso).slice(0, 10) : null);
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

const KIND_LABEL = { list: 'Reward list', upgrade: 'Code upgrade', admin: 'Admin (who can upgrade)', role: 'Role', setting: 'Setting', governance: 'DAO structure', delegation: 'Delegation', reserve: 'Reserve', guard: 'Pause & blacklist', code: 'New code uploaded', epoch: 'Weekly distribution' };
const HOW_LABEL = { proposal: 'passed proposal', direct: 'sent directly', authz: 'sent through a grant', observed: 'seen in a state read', routine: 'weekly routine' };
// the page's own rule (contract-watch.html howOf / howGroup)
const howOf = (r) => (r.observed ? 'observed' : r.routine ? 'routine' : r.via && r.via.kind === 'dao_proposal' ? 'proposal' : r.via && r.via.kind === 'authz' ? 'authz' : 'direct');
const howGroup = (h) => (h === 'authz' ? 'direct' : h);

let cache = new Map();
async function get(path, opts) {
  const fj = (opts && opts.fetchJson) || (async (u) => { const r = await fetch(u, { headers: { 'User-Agent': 'tla-help-agent' } }); if (r.status === 404) return null; if (!r.ok) throw new Error(path + ' HTTP ' + r.status); return r.json(); });
  const c = cache.get(path); if (c && Date.now() - c.at < TTL && !(opts && opts.fetchJson)) return c.v;
  let v = null; try { v = await fj(`${CORE}/${path}`, path); } catch (e) { v = null; }
  if (v != null) cache.set(path, { at: Date.now(), v });
  return v;
}

// everything but the monthly records: small files, read together
async function base(opts) {
  const [idx, groups, state, guards, accounts, rewalk, cat] = await Promise.all(['contract-watch/index.json', 'docs/curated/contract-watch.json', 'contract-watch/state/current.json', 'contract-watch/guards.json', 'contract-watch/accounts.json', 'contract-watch/rewalk.json', 'token-catalog/snapshots/current.json'].map((p) => get(p, opts)));
  const B = { idx, groups, state, guards, accounts, rewalk };
  // names for the assets of a reward list — the page's own rule (contract-watch.html ingestCatalog / assetName): a token by its catalog
  // symbol, a pool only when every side is known, an auto-compounding vault by its number; anything else stays the chain's own id
  B.tokens = new Map(); B.pools = new Map();
  if (cat) {
    for (const t of cat.tokens || []) { const e = t.effective || {}, g = t.discovered || {}; const sym = e.symbol || g.symbol; if (t.denom && sym) B.tokens.set(bare(t.denom), sym); }
    if (!B.tokens.has('uluna')) B.tokens.set('uluna', 'LUNA');
    for (const pl of cat.pools || []) { if (!pl.gauge_pool_id) continue; const syms = (pl.underlyings || []).map((u) => B.tokens.get(bare(u)) || null); if (!syms.length || syms.some((x) => !x)) continue; const dex = pl.architecture && pl.architecture.dex; B.pools.set(pl.gauge_pool_id, (syms.length > 1 ? syms.join('–') + ' LP' : syms[0]) + (dex && syms.length > 1 ? ' · ' + dex : '')); }
  }
  B.byAddr = new Map(((groups && groups.contracts) || []).map((c) => [c.address, c]));
  B.buckets = new Map(((groups && groups.buckets) || []).map((b) => [b.id, b]));
  B.daos = (groups && groups.daos) || [];
  B.book = (state && state.address_book && state.address_book.entries) || {};
  B.chain = (state && state.contracts) || {};
  return B;
}
// the monthly records the index lists, newest first; a month that does not answer is named, never silently empty
async function records(B, opts) {
  const months = Object.keys((B.idx && B.idx.months) || {}).sort();
  const out = [], missing = [];
  for (let i = 0; i < months.length; i += 6) {
    const got = await Promise.all(months.slice(i, i + 6).map((m) => get(`contract-watch/events/${m}.json`, opts)));
    got.forEach((arr, j) => { if (Array.isArray(arr)) out.push(...arr); else missing.push(months[i + j]); });
  }
  out.sort((a, b) => (b.height - a.height) || String(b.k).localeCompare(String(a.k)));
  return { recs: out, months, missing };
}

// ---- names: only what the groups file, the DAO list or the chain's own label say ----
function daoAt(B, a) { return B.daos.find((d) => d.core === a) || null; }
function nameOf(B, a) {
  if (!a) return null;
  const d = daoAt(B, a); const c = B.byAddr.get(a);
  if (c) { const b = B.buckets.get(c.bucket); return { name: c.name, group: b ? b.label : c.bucket, group_id: c.bucket, dao: d ? (d.short || d.name) : undefined }; }
  if (d) return { name: d.name, dao: d.short || d.name };
  const ch = B.chain[a]; if (ch && ch.label) return { name: null, chain_label: ch.label, group: 'not grouped yet' };
  return null;
}
function signsWith(B, a) {
  if (!isAddr(a)) return null;
  if (daoAt(B, a)) return 'a DAO: its members vote';
  if (isContract(a)) return 'a contract';
  const k = B.accounts && B.accounts.accounts && B.accounts.accounts[a];
  if (!k) return 'an account (how many keys it needs has not been read)';
  if (k.keys === 1) return 'an account with one key';
  if (k.keys > 1) return `an account that needs ${k.threshold} of its ${k.keys} keys`;
  return 'an account that has not signed a transaction yet';
}
function party(B, a) {   // an address as the tool hands it out
  if (!a) return null; const n = nameOf(B, a) || {};
  const roles = Object.keys(B.book).filter((r) => B.book[r] === a);
  return Object.assign({ address: a, is: daoAt(B, a) ? 'DAO' : isContract(a) ? 'contract' : 'account', signs_with: signsWith(B, a) }, n.name ? { name: n.name } : {}, n.chain_label ? { chain_label: n.chain_label } : {}, n.group ? { group: n.group } : {}, roles.length ? { roles_held: roles } : {});
}
const partyLite = (B, a) => { const p = party(B, a); if (p) delete p.roles_held; return p; };   // inside a list of roles the holder's other roles would repeat on every row
const contractBrief = (B, a) => { if (!a) return null; const n = nameOf(B, a) || {}; return Object.assign({ address: a }, n.name ? { name: n.name } : {}, n.chain_label ? { chain_label: n.chain_label } : {}, n.group ? { group: n.group } : {}); };

function assetName(B, a) { if (B.tokens.has(bare(a))) return B.tokens.get(bare(a)); if (B.pools.has(a)) return B.pools.get(a); const m = bare(a).match(/\/(\d+)\/(stable|project|bluechip|single)\/amplp$/); return m ? `ampLP vault ${m[1]} (${m[2]})` : null; }
// ---- a record in plain words (the page's own titles: contract-watch.html describe) ----
function assetsOf(r) { const s = r.detail && r.detail.assets; if (!s) return { items: [], cut: false }; const cut = /…$/.test(s); const items = String(s).replace(/…$/, '').split(',').map((x) => x.trim()).filter(Boolean); if (cut) items.pop(); return { items, cut }; }
function bookPairs(r) { const a = r && r.sent && r.sent.msg && r.sent.msg.set_addresses && r.sent.msg.set_addresses.addresses; return Array.isArray(a) && a.every((x) => Array.isArray(x) && x.length === 2 && typeof x[0] === 'string' && typeof x[1] === 'string') ? a : null; }
function titleOf(r) {
  const d = r.detail || {}, act = lastSeg(r.action), n = assetsOf(r).items.length;
  if (r.observed) {
    if (r.action === 'address_book') return `Role ${d.role}: ${d.after ? 'now held by another address' : 'no longer in the address book'}`;
    if (r.action === 'admin') return d.after ? 'The admin — the address that can upgrade this contract — is different' : 'The admin was removed: this contract can no longer be upgraded';
    if (r.action === 'code_id') return 'The contract runs different code';
    return 'Changed: ' + r.action;
  }
  if (act === 'whitelist_assets') return `Added ${plural(n, 'asset')} to the reward list`;
  if (act === 'remove_assets' || act === 'remove_asset') return `Removed ${plural(n, 'asset')} from the reward list`;
  if (act === 'initialize_asset') return 'Set up an auto-compounding vault for an LP asset';
  if (r.kind === 'upgrade') return 'Upgraded the contract’s code';
  if (r.action === 'update_admin') return 'Changed the admin — the address that can upgrade this contract';
  if (r.action === 'clear_admin') return 'Removed the admin: this contract can no longer be upgraded';
  if (r.kind === 'code') return 'New contract code uploaded to the chain';
  if (act === 'set_addresses' || act === 'set_address') { const bp = bookPairs(r); return bp ? `Changed the address book — set ${plural(bp.length, 'role')}` : 'Changed the address book — which address holds each role'; }
  if (act === 'update_asset_config') return 'Changed the settings of one asset on the reward list';
  if (r.kind === 'setting') return 'Changed a setting';
  if (act === 'update_members') return 'Changed the DAO’s member list';
  if (act === 'execute_update_sub_daos_list') return 'Changed the DAO’s list of sub-DAOs';
  if (act === 'execute_set_item' || act === 'set_item') return 'Set an item in the DAO’s storage';
  if (act === 'remove_item') return 'Removed an item from the DAO’s storage';
  if (act === 'add_hook') return 'Added a hook to the DAO’s voting module';
  if (act === 'remove_hook') return 'Removed a hook from the DAO’s voting module';
  if (act === 'execute_accept_admin_nomination') return 'A new admin accepted the DAO';
  if (act === 'execute_admin_msgs') return 'The admin acted on the DAO';
  if (r.kind === 'delegation') return /undelegate/.test(act) ? 'Undelegated Alliance stake from a validator' : /redelegate/.test(act) ? 'Moved Alliance stake to another validator' : 'Delegated Alliance stake to a validator';
  if (r.kind === 'reserve') return 'Withdrew from the reserve';
  if (r.kind === 'guard') return /unpause/.test(act) ? 'Unpaused the contract' : /pause/.test(act) ? 'Paused the contract' : 'Changed the blacklist';
  if (r.kind === 'epoch') return 'Set the weekly distribution';
  if (r.kind === 'role') return 'Changed an owner or a role';
  return 'Changed: ' + r.action;
}
function proposalOf(B, r) {
  if (!(r.via && r.via.kind === 'dao_proposal')) return null;
  const d = daoAt(B, r.via.dao), id = String(r.via.proposal_id);
  return { dao: d ? (d.short || d.name) : null, dao_address: r.via.dao, number: `${(d && d.label_prefix) || '#'}${id}`, url: d ? `https://daodao.zone/dao/${d.core}/proposals/${d.label_prefix || ''}${id}` : null };
}
function brief(B, r, full) {
  const how = howOf(r), d = r.detail || {}, as = assetsOf(r);
  const o = { when: r.timestamp, what: titleOf(r), kind: KIND_LABEL[r.kind] || r.kind, action: r.action, how: HOW_LABEL[how], link: `${PAGE}#k=${encodeURIComponent(r.k)}` };
  if (r.contract) o.contract = contractBrief(B, r.contract);
  if (how === 'proposal') o.proposal = proposalOf(B, r);
  if (r.signer && how !== 'proposal') o.sent_by = party(B, r.signer);   // for a passed proposal the DAO's vote is the sender that matters; who pressed "execute" is on the page
  if (r.txhash) o.txhash = r.txhash;
  if (r.observed) { o.before = d.before == null ? null : (isAddr(d.before) ? party(B, d.before) : d.before); o.now = d.after == null ? null : (isAddr(d.after) ? party(B, d.after) : d.after); if (d.role) o.role = d.role; o.between_reads = [d.seen_after || null, d.seen_by || null]; o.note = 'two reads of the chain differ; this record does not say who sent the change'; }
  if (as.items.length) { const pick = as.items.slice(0, full ? 30 : 8); o.assets = pick.map((x) => { const m = r.kind === 'reserve' ? x.match(/^(.*):(\d+)$/) : null; const id = m ? m[1] : x; return assetName(B, id) || id; });   // a name when the token catalog knows one, else the chain's own id — never a guess
    if (as.items.length > pick.length) o.assets_not_listed_here = as.items.length - pick.length; if (as.cut) o.assets_note = 'the stored list was cut at 1,500 characters; the transaction has all of it'; }
  if (lastSeg(r.action) === 'update_asset_config' && d.asset) o.asset = assetName(B, d.asset) || d.asset;
  if (lastSeg(r.action) === 'initialize_asset') { if (d.amplp) o.vault_token = assetName(B, 'native:' + d.amplp) || d.amplp; if (d.staking) o.staked_in = contractBrief(B, d.staking); }
  if (lastSeg(r.action) === 'execute_set_item' && d.key) o.item_key = d.key;
  if (r.kind === 'upgrade' && !r.observed) { if (d.code_id) o.new_code_id = d.code_id; if (d.new_contract_version || d.previous_contract_version) o.version = `${d.new_contract_name || d.previous_contract_name || 'version'}: ${d.previous_contract_version || '?'} → ${d.new_contract_version || '?'}`; }
  if (r.kind === 'code' && d.code_id) o.code_id = d.code_id;
  if (r.action === 'update_admin' && d.new_admin_address) o.new_admin = party(B, d.new_admin_address);
  const bp = bookPairs(r); if (bp) o.roles_set = bp.slice(0, 30).map(([role, a]) => ({ role, to: partyLite(B, a) }));
  if (lastSeg(r.action) === 'update_members') { o.members_added = d.added || '0'; o.members_removed = d.removed || '0'; }
  if (full && r.sent && r.sent.msg) { const s = JSON.stringify(r.sent.msg); o.message_as_sent = s.length > 1500 ? s.slice(0, 1500) + '…' : s; }
  return o;
}

// ---- what a kind of change requires: the contracts' own answers (guards.json), only for the code the contract runs now ----
function guardsFor(B, a) {
  const now = B.chain[a] && B.chain[a].code_id;
  return ((B.guards && B.guards.guards) || []).filter((g) => g.contract === a && (!now || String(g.code_id) === String(now))).map((g) => ({ action: g.action,
    requires: g.guard.kind === 'role' ? `the role ${g.guard.role}` : g.guard.kind === 'address' ? 'one contract it names' : g.guard.kind === 'account' ? 'one account it names' : g.guard.kind === 'open' ? 'nothing: the message went through from an address with no role' : g.guard.kind === 'unnamed' ? 'a sender it does not name' : g.guard.kind === 'shape' ? 'not answered: the contract no longer accepts a message of that form' : 'not answered',
    contract_said: g.guard.kind === 'failed' ? undefined : g.guard.text, read_at: g.read_at }));
}
function roleUses(B, role) {   // "required to <action> on <contract>" for one role
  const out = [];
  for (const g of (B.guards && B.guards.guards) || []) {
    if (g.guard.kind !== 'role' || g.guard.role !== role) continue;
    const now = B.chain[g.contract] && B.chain[g.contract].code_id; if (now && String(g.code_id) !== String(now)) continue;
    const n = nameOf(B, g.contract) || {}; out.push({ action: g.action, on: n.name || n.chain_label || g.contract });
  }
  return out;
}

// ---- what the record covers, in the page's words ----
function coverage(B) {
  const idx = B.idx || {}, lines = [], ar = idx.archive, h = idx.history || {};
  const jobs = ((B.rewalk && B.rewalk.jobs) || []).filter((j) => j && isFinite(Number(j.from)) && isFinite(Number(j.to)));
  const stretches = jobs.filter((x) => !jobs.some((y) => y !== x && Number(y.from) <= Number(x.from) && Number(y.to) >= Number(x.to) && (y.to - y.from) > (x.to - x.from))).sort((a, b) => a.from - b.from);
  if (ar && ar.complete) lines.push(`The whole history was read once from an archive node${ar.to_time ? ' (to ' + dayOf(ar.to_time) + ')' : ''}: every watched contract since the chain began.`);
  else {
    if (h.first_record && h.walks_end) lines.push(`${h.first_record} → ${h.walks_end}: taken from the chain walks already stored. Complete for the contracts the capture followed in those months.`);
    if (ar) lines.push(`The whole history is being read once from an archive node: ${(ar.searches || 0) - (ar.searches_left || 0)} of ${ar.searches || 0} searches read so far. It is started by hand and reads slowly on purpose.`);
    else lines.push('The one-time read of the whole history from an archive node has not run yet. It is started by a person, never on a timer.');
    const big = jobs.filter((j) => j.pruned_to != null && j.first_walked).sort((a, b) => b.to - a.to)[0];
    if (h.walks_end) lines.push(`${h.walks_end} → ${big ? dayOf(big.first_walked.time) : 'the first block public nodes still hold'}: NOT on record — public nodes no longer hold those blocks.`);
    for (const j of stretches) {
      const start = j.pruned_to != null ? Number(j.pruned_to) + 1 : Number(j.from), span = Number(j.to) - start + 1;
      const words = j.label || `blocks ${start}–${j.to}`;
      if (j.done) lines.push(`${words}: read again for contract changes — done, ${plural(Number(j.found) || 0, 'change')} found.`);
      else if (j.next != null) lines.push(`${words}: being read again now — ${span > 0 ? Math.min(100, Math.round((Math.max(0, Number(j.next) - start) / span) * 100)) : 0}% of the stretch read${j.last_walked ? ' (up to ' + dayOf(j.last_walked.time) + ')' : ''}, ${plural(Number(j.found) || 0, 'change')} found so far. It reads a little every 15 minutes.`);
      else lines.push(`${words}: queued to be read again.`);
    }
  }
  if (idx.forward_since) lines.push(`${idx.forward_since.day} → now: live, read every 15 minutes. Upgrades and admin changes are kept for every contract on the chain, the other changes for the watched contracts.`);
  if (B.state && B.state.capturedAt) lines.push(`State read (each watched contract's admin and code id, and the address book): once a day and whenever a change is recorded. Last read ${B.state.capturedAt}.`);
  lines.push('Not seen by a walk: a change made by chain governance at the end of a block, and a setting whose contract reports no action.');
  return { lines, live_since: idx.forward_since ? idx.forward_since.day : null, stored_walks_end: h.walks_end || null, first_record: h.first_record || null, archive_read: ar ? (ar.complete ? 'complete' : 'in progress') : 'not run yet',
    catch_up_open: stretches.some((j) => !j.done), record_updated_at: idx.updated_at || null, state_read_at: (B.state && B.state.capturedAt) || null, role_answers_read_at: (B.guards && B.guards.read_at) || null, key_counts_read_at: (B.accounts && B.accounts.read_at) || null };
}
// is a span of days fully on record? (so "nothing found" can be told from "not read")
function gapNote(B, fromDay, toDay) {
  const idx = B.idx || {}, ar = idx.archive, h = idx.history || {};
  if (ar && ar.complete && (!ar.to_time || !toDay || toDay <= dayOf(ar.to_time))) return null;
  const live = idx.forward_since && idx.forward_since.day, end = h.walks_end;
  if (!end || !live) return null;
  const a = fromDay || '0000', b = toDay || '9999';
  if (b <= end || a >= live) return null;   // wholly inside the stored walks, or wholly inside the live stream
  return `Part of this span (${end} → ${live}) is not fully on record: public nodes no longer hold the first months of it and the rest is still being read again. No change listed for those months means "not read", not "nothing changed". See coverage.`;
}

function resolveContract(B, q) {
  const s = String(q || '').trim(); if (!s) return { error: 'name a contract (its name on the page, or its terra1… address)' };
  if (isContract(s)) return { address: s };
  const kl = s.toLowerCase(); const all = [...B.byAddr.values()];
  const exact = all.filter((c) => c.name.toLowerCase() === kl); if (exact.length === 1) return { address: exact[0].address };
  const hits = all.filter((c) => c.name.toLowerCase().includes(kl) || String(c.role || '').toLowerCase() === kl);
  if (hits.length === 1) return { address: hits[0].address };
  if (!hits.length) { const words = kl.split(/[^a-z0-9.]+/).filter((w) => w.length > 1); const loose = all.filter((c) => words.every((w) => c.name.toLowerCase().includes(w))); if (loose.length === 1) return { address: loose[0].address }; if (loose.length) return { candidates: loose.slice(0, 15).map((c) => ({ name: c.name, group: (B.buckets.get(c.bucket) || {}).label || c.bucket, address: c.address })) }; return { error: `no watched contract is named like "${s}" — the groups and names are in docs/curated/contract-watch.json`, groups: [...B.buckets.values()].map((b) => b.label) }; }
  return { candidates: hits.slice(0, 15).map((c) => ({ name: c.name, group: (B.buckets.get(c.bucket) || {}).label || c.bucket, address: c.address })) };
}
const normKind = (k) => { const s = String(k || '').toLowerCase().trim(); if (!s || s === 'all') return null; const m = { 'reward list': 'list', 'reward lists': 'list', lists: 'list', upgrades: 'upgrade', 'code upgrade': 'upgrade', 'code upgrades': 'upgrade', migrate: 'upgrade', roles: 'role', settings: 'setting', 'dao structure': 'governance', dao: 'governance', reserves: 'reserve', pause: 'guard', blacklist: 'guard', 'new code': 'code', store_code: 'code', weekly: 'epoch', routine: 'epoch' }; return m[s] || (KIND_LABEL[s] ? s : null); };
const normHow = (h) => { const s = String(h || '').toLowerCase().trim(); if (!s || s === 'all') return null; return /propos/.test(s) ? 'proposal' : /direct|account|key/.test(s) ? 'direct' : /state|observ|read/.test(s) ? 'observed' : /routine|weekly/.test(s) ? 'routine' : null; };
const normDay = (d, end) => { const s = String(d || '').trim(); if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s; if (/^\d{4}-\d{2}$/.test(s)) return end ? s + '-31' : s + '-01'; if (/^\d{4}$/.test(s)) return end ? s + '-12-31' : s + '-01-01'; return null; };
const tally = (list, f) => { const o = {}; for (const r of list) { const k = f(r); o[k] = (o[k] || 0) + 1; } return o; };

// The server cuts a tool result at 12,000 characters. A list cut in the middle of a row reads as broken data, so a long answer drops
// its oldest rows instead (a list of changes then says how many it did not list).
const MAX_CHARS = 10500;
function fit(out, listOf) {
  for (let guard = 0; guard < 80 && JSON.stringify(out).length > MAX_CHARS; guard++) { const lists = listOf(out).filter((l) => Array.isArray(l) && l.length > 1).sort((a, b) => b.length - a.length); if (!lists.length) break; lists[0].pop(); }
  return out;
}
async function run(input, opts) { const out = await run_(input, opts); if (out && !out.error) { fit_(out); if (Array.isArray(out.changes) && out.matched > out.changes.length) out.more = `${out.matched - out.changes.length} older change(s) not listed — narrow with a contract, a kind, a route or dates`; } return out; }
const fit_ = (out) => fit(out, (o) => [o.changes, o.latest, o.changes_sent_directly && o.changes_sent_directly.latest, o.passed_proposals_executed && o.passed_proposals_executed.latest, o.role && o.role.differences_seen, o.held_by_contracts]);
async function run_(input, opts) {
  input = input || {}; const action = String(input.action || 'overview');
  const B = await base(opts);
  if (!B.idx) return { error: 'the contract-watch record could not be read just now (contract-watch/index.json) — try again shortly', page: PAGE };
  const now = (opts && opts.now) || Date.now();
  const src = (p) => TREE + p;
  const lim = Math.min(25, Math.max(1, parseInt(input.limit || 10, 10) || 10));
  const marks = `Which changes are marked "needs a look" is worked out by the page when it loads — open ${PAGE}#att=look. This tool gives the facts of a change, not the mark.`;

  if (action === 'roles') {
    const want = String(input.role || '').trim().toUpperCase();
    const roles = Object.keys(B.book).sort();
    if (!roles.length) return { error: 'the address book has not been read (contract-watch/state/current.json)', page: PAGE };
    let recs = null;
    const one = async (role) => { const holder = B.book[role]; const o = { role, holder: party(B, holder), required_for: roleUses(B, role) };
      if (!o.required_for.length) o.required_for_note = 'no contract named this role when it was asked (the answers on file cover the kinds of change the record holds)';
      if (!recs) recs = (await records(B, opts)).recs;
      const setBy = recs.find((r) => !r.observed && (bookPairs(r) || []).some((p) => p[0] === role && p[1] === holder));
      if (setBy) o.set_by = brief(B, setBy); else o.set_by_note = 'no change on record names this role and this holder (the record does not hold the message of every earlier change)';
      const seen = recs.filter((r) => r.observed && r.action === 'address_book' && r.detail && r.detail.role === role).slice(0, 3).map((r) => brief(B, r)); if (seen.length) o.differences_seen = seen;
      return o; };
    if (want) { const hit = roles.find((r) => r === want) || roles.find((r) => r.includes(want)); if (!hit) return { error: `no role named ${want} in the address book`, roles }; return { role: await one(hit), read_at: B.state.address_book.capturedAt, address_book: contractBrief(B, B.state.address_book.contract), page: `${PAGE}#view=roles`, source: src('contract-watch/state/current.json'), marks }; }
    const rows = roles.map((role) => { const p = party(B, B.book[role]); const uses = [...new Set(roleUses(B, role).map((u) => u.action))]; return { is: p.is, row: Object.assign({ role }, p.is === 'account' ? { account: p.address, signs_with: p.signs_with } : p.is === 'DAO' ? { dao: p.name || p.address, signs_with: p.signs_with } : { holder: p.name || p.chain_label || p.address }, uses.length ? { required_for: uses } : {}) }; });
    const of = (k) => rows.filter((r) => r.is === k).map((r) => r.row);
    return { read_at: B.state.address_book.capturedAt, address_book: contractBrief(B, B.state.address_book.contract), roles_total: rows.length,
      held_by_accounts: of('account'), held_by_daos: of('DAO'), held_by_contracts: of('contract'),
      hint: 'pass role=<NAME> for one role in full: what it is required for, which change set it, differences seen', page: `${PAGE}#view=roles`, source: src('contract-watch/state/current.json'), role_answers_source: src('contract-watch/guards.json'), marks };
  }

  const { recs, missing } = await records(B, opts);
  const changes = recs.filter((r) => howOf(r) !== 'routine');
  const warn = missing.length ? { months_not_read_just_now: missing } : {};

  if (action === 'overview') {
    const days = Math.min(3650, Math.max(1, parseInt(input.days || 30, 10) || 30)); const since = new Date(now - days * 864e5).toISOString();
    const win = changes.filter((r) => r.timestamp >= since);
    return Object.assign({ record: { changes_on_record: changes.length, first: changes.length ? dayOf(changes[changes.length - 1].timestamp) : null, by_route: tally(changes, (r) => HOW_LABEL[howGroup(howOf(r))]), weekly_routine_records: recs.length - changes.length },
      [`last_${days}_days`]: { changes: win.length, by_route: tally(win, (r) => HOW_LABEL[howGroup(howOf(r))]), by_kind: tally(win, (r) => KIND_LABEL[r.kind] || r.kind) },
      latest: changes.slice(0, Math.min(lim, 6)).map((r) => brief(B, r)),
      watched: { contracts: B.byAddr.size, groups: B.buckets.size, groups_file: src('docs/curated/contract-watch.json') },
      coverage: coverage(B), marks, page: PAGE, source: src('contract-watch/index.json') }, warn);
  }

  if (action === 'changes') {
    const kind = normKind(input.kind); if (input.kind && !kind) return { error: `unknown kind "${input.kind}"`, kinds: Object.keys(KIND_LABEL) };
    const how = normHow(input.how); if (input.how && !how) return { error: `unknown route "${input.how}"`, routes: ['proposal', 'direct', 'observed'] };
    let list = (input.include_routine || kind === 'epoch' || how === 'routine') ? recs : changes; const filter = {};   // the weekly distribution only when it is asked for
    if (input.contract) { const c = resolveContract(B, input.contract); if (c.error || c.candidates) return Object.assign({ which_contract: c.error || 'more than one contract matches — pick one', page: PAGE }, c); list = list.filter((r) => r.contract === c.address); filter.contract = contractBrief(B, c.address); }
    if (kind) { list = list.filter((r) => r.kind === kind); filter.kind = KIND_LABEL[kind]; }
    if (how) { list = list.filter((r) => howGroup(howOf(r)) === how); filter.how = HOW_LABEL[how]; }
    const a = normDay(input.since, false), b = normDay(input.until, true);
    if (input.since && !a) return { error: 'since: use YYYY-MM-DD or YYYY-MM' }; if (input.until && !b) return { error: 'until: use YYYY-MM-DD or YYYY-MM' };
    if (a) { list = list.filter((r) => dayOf(r.timestamp) >= a); filter.since = a; } if (b) { list = list.filter((r) => dayOf(r.timestamp) <= b); filter.until = b; }
    if (input.sender) { const s = String(input.sender).trim(); if (!isAddr(s)) return { error: 'sender: a terra1… address' }; list = list.filter((r) => r.signer === s || (r.via && r.via.dao === s)); filter.sender = s; }
    if (input.q) { const q = String(input.q).toLowerCase().trim(); list = list.filter((r) => JSON.stringify([r.action, r.detail, r.txhash, r.contract, (nameOf(B, r.contract) || {}).name, (proposalOf(B, r) || {}).number]).toLowerCase().includes(q)); filter.q = q; }
    const gap = gapNote(B, a, b);
    return Object.assign({ filter, matched: list.length, by_route: tally(list, (r) => HOW_LABEL[howGroup(howOf(r))]), changes: list.slice(0, lim).map((r) => brief(B, r, list.length <= 3)) },
      gap ? { coverage_note: gap } : {}, !list.length ? { note: 'no change on record matches' + (gap ? ' — see coverage_note' : '') } : {}, { marks, page: PAGE }, warn);
  }

  if (action === 'contract') {
    const c = resolveContract(B, input.contract); if (c.error || c.candidates) return Object.assign({ which_contract: c.error || 'more than one contract matches — pick one', page: PAGE }, c);
    const a = c.address, ch = B.chain[a] || null, mine = recs.filter((r) => r.contract === a), ch2 = mine.filter((r) => howOf(r) !== 'routine');
    const role = Object.keys(B.book).filter((r) => B.book[r] === a);
    const o = Object.assign({ contract: contractBrief(B, a), watched: B.byAddr.has(a) || !!ch }, role.length ? { is_in_the_address_book_as: role } : {},
      ch ? { now: { code_id: ch.code_id, admin: ch.admin ? party(B, ch.admin) : null, admin_note: ch.admin ? 'the admin is the address that can upgrade (replace) this contract\'s code' : 'no admin: this contract\'s code cannot be replaced', chain_label: ch.label, read_at: ch.capturedAt } } : { now: null, now_note: 'this contract is not in the last state read' },
      { what_a_change_requires: guardsFor(B, a), changes_on_record: ch2.length, by_route: tally(ch2, (r) => HOW_LABEL[howGroup(howOf(r))]), by_kind: tally(ch2, (r) => KIND_LABEL[r.kind] || r.kind), weekly_routine_records: mine.length - ch2.length,
        latest: ch2.slice(0, lim).map((r) => brief(B, r)), coverage_note: gapNote(B, null, null) || undefined, marks, page: `${PAGE}#contract=${a}`, source: src('contract-watch/state/current.json') }, warn);
    if (!o.what_a_change_requires.length) { delete o.what_a_change_requires; o.what_a_change_requires_note = 'no answer on file for this contract (answers exist for the kinds of change the record holds, on the code the contract runs now)'; }
    return o;
  }

  if (action === 'address') {
    const a = String(input.address || '').trim(); if (!isAddr(a)) return { error: 'address: a terra1… address' };
    const p = party(B, a); const adminOf = Object.keys(B.chain).filter((k) => B.chain[k].admin === a);
    const sent = changes.filter((r) => r.signer === a && howGroup(howOf(r)) === 'direct'), viaDao = changes.filter((r) => r.via && r.via.dao === a);
    const known = p.name || p.chain_label || (p.roles_held && p.roles_held.length) || adminOf.length || sent.length || viaDao.length;
    if (!known) return { address: a, is: p.is, on_record: false, note: 'This address holds no role, is the admin of no watched contract and sent no change on record. Contract Watch only knows an address by what it changed or can change.', coverage_note: gapNote(B, null, null) || undefined, page: `${PAGE}#address=${a}` };
    return Object.assign({ address: p, admin_of: { count: adminOf.length, meaning: 'it can upgrade (replace the code of) these contracts', contracts: adminOf.slice(0, 30).map((k) => (nameOf(B, k) || {}).name || (nameOf(B, k) || {}).chain_label || k) },
      changes_sent_directly: { count: sent.length, by_kind: tally(sent, (r) => KIND_LABEL[r.kind] || r.kind), latest: sent.slice(0, lim).map((r) => brief(B, r)) } },
      viaDao.length ? { passed_proposals_executed: { count: viaDao.length, by_kind: tally(viaDao, (r) => KIND_LABEL[r.kind] || r.kind), latest: viaDao.slice(0, Math.min(lim, 5)).map((r) => brief(B, r)) } } : {},
      { coverage_note: gapNote(B, null, null) || undefined, marks, page: `${PAGE}#address=${a}`, key_counts_source: src('contract-watch/accounts.json') }, warn);
  }
  return { error: 'unknown action', actions: ['overview', 'changes', 'contract', 'roles', 'address'] };
}

module.exports = { VERSION, run, _clearCache: () => { cache = new Map(); }, _internals: { howOf, howGroup, titleOf, signsWith, coverage, gapNote, resolveContract, brief, base, records, KIND_LABEL, HOW_LABEL } };
