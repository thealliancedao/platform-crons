// gate-contract-watch-tool.mjs — BINDING gate for help-agent lib/contract-watch-tool.js 1.0.0 (v1.24.0) on the REAL record.
// Every expected number is recounted here from the files; no address is typed — the gate takes them from the records it reads.
// Usage: TLA_CORE_DIR=<tla-core checkout> [CW_DIR=<a checkout that holds contract-watch/ and docs/curated/contract-watch.json; default
//        TLA_CORE_DIR>] [SITE_DIR=<aDAO-links-site checkout>] node help-agent/gate-contract-watch-tool.mjs
//   A  overview — counts by route and kind, the latest change, what the record covers
//   B  changes — every filter against a recount; the weekly routine only when asked; "not read" told apart from "nothing changed"
//   C  a change in brief — route, sender and how it signs, proposal number and link, before / now of a state read, assets by catalog name
//   D  contract — code id and admin as the state file has them; what a change requires only for the code the contract runs now
//   E  roles — the address book whole; one role in full, with the change that set it
//   F  address — roles held, contracts it can upgrade, changes it sent; an address the record does not know
//   G  facts only — no verdict words, no mark of its own; every answer under the server's 12,000-character cut
//   H  a file that does not answer — named, never silently empty
//   I  the server wiring (tool listed, dispatched, allowed, chapter in the corpus, rules 20 and 21)
//   J  with SITE_DIR: the tab order in rule 21 is the site's own list; the tool's words for every record are the page's (page in jsdom)
//   K  the server end to end with the model replaced by a script: the corpus it builds, the tools it offers, the tool result it hands over
import fs from 'fs'; import path from 'path'; import { createRequire } from 'module';
const require = createRequire(import.meta.url); const here = path.dirname(new URL(import.meta.url).pathname);
const T = require('./lib/contract-watch-tool.js');
const CORE = process.env.TLA_CORE_DIR, CW = process.env.CW_DIR || CORE, SITE = process.env.SITE_DIR || '';
if (!CORE) { console.error('TLA_CORE_DIR required'); process.exit(1); }
let pass = 0, fail = 0; const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (x !== undefined ? ' → ' + JSON.stringify(x).slice(0, 500) : '')); } };
const find = (rel) => [CW, CORE].map((d) => path.join(d, rel)).find((f) => fs.existsSync(f)) || null;
const J = (rel) => { const f = find(rel); return f ? JSON.parse(fs.readFileSync(f, 'utf8')) : null; };
const mk = (over = {}) => async (url, rel) => (rel in over ? over[rel] : J(rel));
const fetchJson = mk();

// ---- the record, read here independently of the tool ----
const idx = J('contract-watch/index.json'), groups = J('docs/curated/contract-watch.json'), state = J('contract-watch/state/current.json'), guards = J('contract-watch/guards.json'), accounts = J('contract-watch/accounts.json'), cat = J('token-catalog/snapshots/current.json');
if (!idx || !groups || !state) { console.error('the checkout holds no contract-watch record (contract-watch/index.json, docs/curated/contract-watch.json, contract-watch/state/current.json)'); process.exit(1); }
const all = []; for (const m of Object.keys(idx.months)) all.push(...J(`contract-watch/events/${m}.json`));
all.sort((a, b) => (b.height - a.height) || String(b.k).localeCompare(String(a.k)));
const how = (r) => (r.observed ? 'observed' : r.routine ? 'routine' : r.via && r.via.kind === 'dao_proposal' ? 'proposal' : 'direct');   // authz counts as direct
const changes = all.filter((r) => how(r) !== 'routine');
const HOW = { proposal: 'passed proposal', direct: 'sent directly', observed: 'seen in a state read' };
const count = (list, f) => { const o = {}; for (const r of list) { const k = f(r); o[k] = (o[k] || 0) + 1; } return o; };
const same = (a, b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
const isC = (a) => /^terra1[0-9a-z]{58}$/.test(a || ''), isA = (a) => /^terra1[0-9a-z]{38}$/.test(a || '');
const book = state.address_book.entries, nameOf = new Map(groups.contracts.map((c) => [c.address, c.name]));
const now = Date.parse(idx.updated_at) + 60e3;
const run = (input, fj) => T.run(input, { fetchJson: fj || fetchJson, now });
const day = (r) => r.timestamp.slice(0, 10);
const sizes = [];
const R = async (input, fj) => { const o = await run(input, fj); sizes.push([JSON.stringify(input), JSON.stringify(o).length]); return o; };
console.log(`record: ${all.length} records in ${Object.keys(idx.months).length} months · ${changes.length} changes · ${groups.contracts.length} contracts in ${groups.buckets.length} groups · ${T.VERSION}`);

// ---------------------------------------------------------------- A
console.log('— A overview —');
{ const o = await R({ action: 'overview' });
  ok(`changes on record ${o.record.changes_on_record} = the files' ${changes.length}; the weekly routine counted apart (${o.record.weekly_routine_records} = ${all.length - changes.length})`, o.record.changes_on_record === changes.length && o.record.weekly_routine_records === all.length - changes.length, o.record);
  ok('by route = the recount (' + JSON.stringify(o.record.by_route) + ')', same(o.record.by_route, count(changes, (r) => HOW[how(r)])), count(changes, (r) => HOW[how(r)]));
  const since = new Date(now - 30 * 864e5).toISOString(), win = changes.filter((r) => r.timestamp >= since);
  ok(`the last 30 days: ${o.last_30_days.changes} changes, by route and by kind = the recount`, o.last_30_days.changes === win.length && same(o.last_30_days.by_route, count(win, (r) => HOW[how(r)])) && Object.values(o.last_30_days.by_kind).reduce((s, n) => s + n, 0) === win.length, o.last_30_days);
  ok('the latest change listed is the newest record of the files, with its page link', o.latest[0].link === 'https://theadao.com/contract-watch.html#k=' + encodeURIComponent(changes[0].k) && o.latest[0].when === changes[0].timestamp && o.record.first === day(changes[changes.length - 1]), o.latest[0].link);
  ok(`watched: ${o.watched.contracts} contracts in ${o.watched.groups} groups = the groups file`, o.watched.contracts === groups.contracts.length && o.watched.groups === groups.buckets.length);
  const c = o.coverage, ar = idx.archive;
  ok(`coverage: live since ${c.live_since}, the stored walks end ${c.stored_walks_end}, the archive read "${c.archive_read}" — as the index says`, c.live_since === idx.forward_since.day && c.stored_walks_end === idx.history.walks_end && c.archive_read === (ar ? (ar.complete ? 'complete' : 'in progress') : 'not run yet') && c.state_read_at === state.capturedAt);
  if (!(ar && ar.complete)) ok('coverage says in words which months are NOT on record, and that the one-time archive read is started by a person', c.lines.some((l) => /NOT on record/.test(l) && l.startsWith(idx.history.walks_end)) && (ar ? true : c.lines.some((l) => /has not run yet\. It is started by a person, never on a timer\./.test(l))), c.lines);
  ok('the answer says the mark is the page\'s, with the link to what is marked now', /worked out by the page/.test(o.marks) && /#att=look/.test(o.marks));
}

// ---------------------------------------------------------------- B
console.log('— B changes —');
{ const kinds = [...new Set(changes.map((r) => r.kind))];
  let good = true; const seen = {};
  for (const k of kinds) { const o = await R({ action: 'changes', kind: k, limit: 3 }); const n = changes.filter((r) => r.kind === k).length; seen[k] = o.matched; if (o.matched !== n || !o.changes.every((c) => c.kind === T._internals.KIND_LABEL[k])) good = false; }
  ok(`each kind of change, counted: ${JSON.stringify(seen)}`, good && kinds.length >= 5, count(changes, (r) => r.kind));
  for (const h of ['proposal', 'direct', 'observed']) { const o = await R({ action: 'changes', how: h, limit: 2 }); const n = changes.filter((r) => how(r) === h).length; ok(`route "${h}": ${o.matched} = the recount, every row says "${HOW[h]}"`, o.matched === n && o.changes.every((c) => c.how === HOW[h] || (h === 'direct' && c.how === 'sent through a grant')), n); }
  const o0 = await R({ action: 'changes', limit: 25 });
  ok('the weekly distribution is left out unless it is asked for', o0.matched === changes.length && !o0.changes.some((c) => c.kind === 'Weekly distribution'));
  const ow = await R({ action: 'changes', kind: 'weekly', limit: 3 }); const nw = all.filter((r) => r.kind === 'epoch').length;
  ok(`asked for, it is all there (${ow.matched} = ${nw})`, ow.matched === nw && ow.changes.every((c) => c.kind === 'Weekly distribution' && c.how === 'weekly routine'));
  // a contract by its name, then by its address
  const busy = Object.entries(count(changes.filter((r) => r.contract && nameOf.has(r.contract)), (r) => r.contract)).sort((a, b) => b[1] - a[1])[0];
  const byName = await R({ action: 'changes', contract: nameOf.get(busy[0]), limit: 5 }), byAddr = await R({ action: 'changes', contract: busy[0], limit: 5 });
  ok(`a contract by the name the page shows ("${nameOf.get(busy[0])}") and by its address give the same ${busy[1]} changes`, byName.matched === busy[1] && byAddr.matched === busy[1] && byName.filter.contract.address === busy[0] && byName.changes.every((c) => c.contract.address === busy[0]), { name: byName.matched, addr: byAddr.matched });
  const amb = await R({ action: 'changes', contract: 'staking contract' }); const nAmb = groups.contracts.filter((c) => c.name.toLowerCase().includes('staking contract')).length;
  ok(`a name that fits ${nAmb} contracts asks which one (no guess)`, nAmb > 1 && Array.isArray(amb.candidates) && amb.candidates.length === Math.min(15, nAmb) && !amb.changes, amb);
  const none = await R({ action: 'changes', contract: 'no such contract here' });
  ok('a name nothing fits says so and lists the groups', /no watched contract is named like/.test(none.error || '') && none.groups.length === groups.buckets.length);
  // dates
  const mid = day(changes[Math.floor(changes.length / 2)]), a = mid.slice(0, 7);
  const od = await R({ action: 'changes', since: a, until: a, limit: 3 }); const nd = changes.filter((r) => day(r).slice(0, 7) === a).length;
  ok(`one month (${a}): ${od.matched} = the recount`, od.matched === nd && od.changes.every((c) => c.when.slice(0, 7) === a), nd);
  // a proposal number and a transaction hash
  const pr = changes.find((r) => how(r) === 'proposal'), dao = groups.daos.find((d) => d.core === pr.via.dao), num = (dao.label_prefix || '#') + pr.via.proposal_id;
  const oq = await R({ action: 'changes', q: num, limit: 25 }); const nq = changes.filter((r) => how(r) === 'proposal' && ((groups.daos.find((d) => d.core === r.via.dao) || {}).label_prefix || '#') + r.via.proposal_id === num).length;
  ok(`a proposal number (${num}) finds its ${nq} change(s), each naming the DAO and linking the vote`, oq.matched >= nq && oq.changes.filter((c) => c.proposal && c.proposal.number === num).length === Math.min(nq, oq.changes.length) && oq.changes.every((c) => !c.proposal || /^https:\/\/daodao\.zone\/dao\/terra1[0-9a-z]{58}\/proposals\//.test(c.proposal.url)), { matched: oq.matched, nq });
  const tx = changes.find((r) => r.txhash); const ot = await R({ action: 'changes', q: tx.txhash }); const nt = changes.filter((r) => r.txhash === tx.txhash).length;
  ok(`a transaction hash finds its ${nt} change(s)`, ot.matched === nt && ot.changes.every((c) => c.txhash === tx.txhash));
  // "not read" is not "nothing changed"
  const ar = idx.archive && idx.archive.complete; const end = idx.history.walks_end, live = idx.forward_since.day;
  const inHole = await R({ action: 'changes', since: end.slice(0, 8) + '28', until: live.slice(0, 8) + '01' }), before = await R({ action: 'changes', until: end, limit: 1 }), after = await R({ action: 'changes', since: live, limit: 1 });
  if (!ar) ok(`a span between ${end} and ${live} carries the note that it is not fully on record; a span wholly before or wholly after does not`, /not fully on record/.test(inHole.coverage_note || '') && /"not read", not "nothing changed"/.test(inHole.coverage_note) && !before.coverage_note && !after.coverage_note, { hole: inHole.coverage_note, before: before.coverage_note, after: after.coverage_note });
  else ok('the archive read is complete: no span carries a not-on-record note', !inHole.coverage_note && !before.coverage_note);
  ok('a wrong kind, route or date is refused with what is allowed (no guess)', (await run({ action: 'changes', kind: 'bananas' })).kinds && (await run({ action: 'changes', how: 'sideways' })).routes && /YYYY-MM/.test((await run({ action: 'changes', since: 'last tuesday' })).error));
  ok(`a long list says how many it did not list (${o0.changes.length} listed of ${o0.matched})`, o0.changes.length < o0.matched && new RegExp('^' + (o0.matched - o0.changes.length) + ' older').test(o0.more));
}

// ---------------------------------------------------------------- C
console.log('— C a change in brief —');
{ const B = await T._internals.base({ fetchJson });
  const pr = changes.find((r) => how(r) === 'proposal'), bp = T._internals.brief(B, pr), dao = groups.daos.find((d) => d.core === pr.via.dao);
  ok(`a passed proposal: "${bp.what}" — ${bp.proposal.dao} ${bp.proposal.number}, the vote linked; no sender (the vote is the sender that matters)`, bp.how === 'passed proposal' && bp.proposal.number === (dao.label_prefix || '#') + pr.via.proposal_id && bp.proposal.dao === (dao.short || dao.name) && bp.proposal.url.includes(dao.core) && !bp.sent_by && !bp.executed_by, bp);
  const dr = changes.find((r) => how(r) === 'direct' && isA(r.signer) && accounts && accounts.accounts[r.signer]); const bd = dr && T._internals.brief(B, dr); const k = dr && accounts.accounts[dr.signer];
  if (dr) ok(`sent directly: the sender is the record's signer, and how it signs is the chain's own account record ("${bd.sent_by.signs_with}")`, bd.how === 'sent directly' && bd.sent_by.address === dr.signer && bd.sent_by.is === 'account' && bd.sent_by.signs_with === (k.keys === 1 ? 'an account with one key' : k.keys > 1 ? `an account that needs ${k.threshold} of its ${k.keys} keys` : 'an account that has not signed a transaction yet') && bd.txhash === dr.txhash && !bd.proposal, bd.sent_by);
  const unread = changes.find((r) => how(r) === 'direct' && isA(r.signer) && !(accounts && accounts.accounts[r.signer]));
  if (unread) ok('a sender whose key count was not read is "an account" and says it was not read — never a guess', /has not been read/.test(T._internals.brief(B, unread).sent_by.signs_with));
  const ob = changes.find((r) => r.observed && r.action === 'address_book'), bo = ob && T._internals.brief(B, ob);
  if (ob) ok(`seen in a state read: "${bo.what}" — before, now, the two read times, and the sentence that it does not say who sent it`, bo.how === 'seen in a state read' && bo.role === ob.detail.role && (bo.before ? bo.before.address === ob.detail.before : ob.detail.before == null) && bo.now.address === ob.detail.after && bo.between_reads[0] === ob.detail.seen_after && bo.between_reads[1] === ob.detail.seen_by && /does not say who sent/.test(bo.note) && !bo.sent_by && !bo.txhash, bo);
  // assets: a name only when the token catalog has one (the page's rule), else the chain's own id
  if (cat) {
    const bare = (d) => String(d || '').replace(/^(cw20|native):/, ''); const tok = new Map(); for (const t of cat.tokens || []) { const s = (t.effective || {}).symbol || (t.discovered || {}).symbol; if (t.denom && s) tok.set(bare(t.denom), s); } if (!tok.has('uluna')) tok.set('uluna', 'LUNA');
    const pools = new Map(); for (const p of cat.pools || []) { if (!p.gauge_pool_id) continue; const sy = (p.underlyings || []).map((u) => tok.get(bare(u)) || null); if (!sy.length || sy.some((x) => !x)) continue; const dex = p.architecture && p.architecture.dex; pools.set(p.gauge_pool_id, (sy.length > 1 ? sy.join('–') + ' LP' : sy[0]) + (dex && sy.length > 1 ? ' · ' + dex : '')); }
    const expect = (x) => tok.get(bare(x)) || pools.get(x) || ((bare(x).match(/\/(\d+)\/(stable|project|bluechip|single)\/amplp$/) || []).length ? `ampLP vault ${bare(x).match(/\/(\d+)\//)[1]} (${bare(x).match(/\/(stable|project|bluechip|single)\/amplp$/)[1]})` : null) || x;
    let n = 0, named = 0, bad = null;
    for (const r of changes.filter((x) => x.kind === 'list' && x.detail && x.detail.assets)) { const b = T._internals.brief(B, r, true); const items = String(r.detail.assets).replace(/…$/, '').split(',').map((s) => s.trim()).filter(Boolean); if (/…$/.test(r.detail.assets)) items.pop();
      items.slice(0, 30).forEach((x, i) => { n++; if (b.assets[i] !== expect(x)) bad = bad || [x, b.assets[i], expect(x)]; if (expect(x) !== x) named++; }); }
    ok(`every asset of every reward-list change (${n}) is the token catalog's name for it (${named}) or the chain's own id (${n - named}) — never a guess`, n > 0 && !bad, bad);
  }
  const up = changes.find((r) => r.kind === 'upgrade' && !r.observed && r.detail && r.detail.code_id);
  if (up) { const b = T._internals.brief(B, up); ok(`an upgrade carries the new code id (${b.new_code_id})${b.version ? ' and the version before → after' : ''}`, b.new_code_id === up.detail.code_id && b.what === 'Upgraded the contract’s code'); }
}

// ---------------------------------------------------------------- D
console.log('— D contract —');
{ const withGuards = [...new Set((guards ? guards.guards : []).map((g) => g.contract))].find((a) => state.contracts[a] && nameOf.has(a) && guards.guards.some((g) => g.contract === a && String(g.code_id) === String(state.contracts[a].code_id)));
  const a = withGuards || changes.find((r) => r.contract && state.contracts[r.contract] && nameOf.has(r.contract)).contract; const ch = state.contracts[a];
  const o = await R({ action: 'contract', contract: a }); const mine = changes.filter((r) => r.contract === a);
  ok(`"${o.contract.name}" (${o.contract.group}): code id ${o.now.code_id} and its admin as the state file has them, read ${o.now.read_at}`, o.contract.name === nameOf.get(a) && o.now.code_id === ch.code_id && (ch.admin ? o.now.admin.address === ch.admin : o.now.admin === null) && o.now.read_at === ch.capturedAt, o.now);
  ok(`its admin is said as what it is (${o.now.admin ? o.now.admin.is + ' — ' + o.now.admin.signs_with : 'none'}), with what an admin can do`, ch.admin ? (o.now.admin.is === (groups.daos.some((d) => d.core === ch.admin) ? 'DAO' : isC(ch.admin) ? 'contract' : 'account') && /can upgrade \(replace\)/.test(o.now.admin_note)) : /cannot be replaced/.test(o.now.admin_note));
  ok(`its changes: ${o.changes_on_record} = the recount, by route and by kind`, o.changes_on_record === mine.length && same(o.by_route, count(mine, (r) => HOW[how(r)])) && o.latest.every((c) => c.contract.address === a) && o.page.endsWith('#contract=' + a));
  if (withGuards) {
    const want = guards.guards.filter((g) => g.contract === a && String(g.code_id) === String(ch.code_id));
    ok(`what a change on it requires: ${o.what_a_change_requires.map((g) => g.action + ' → ' + g.requires).join(' · ')} — the contract's own words kept`, o.what_a_change_requires.length === want.length && o.what_a_change_requires.every((g) => { const w = want.find((x) => x.action === g.action); return w && g.contract_said === w.guard.text && (w.guard.kind !== 'role' || g.requires === 'the role ' + w.guard.role); }), o.what_a_change_requires);
    const old = JSON.parse(JSON.stringify(guards)); old.guards.push({ contract: a, action: 'planted_old_answer', code_id: String(Number(ch.code_id) - 1), guard: { kind: 'open', text: '' }, sample: { from: 'record', ref: 'x' }, read_at: '2026-01-01T00:00:00Z' });
    const o2 = await run({ action: 'contract', contract: a }, mk({ 'contract-watch/guards.json': old }));
    ok('an answer the contract gave under OTHER code is not handed out (planted: an "open" answer for the code id before)', !o2.what_a_change_requires.some((g) => g.action === 'planted_old_answer') && o2.what_a_change_requires.length === want.length);
  }
  const inBook = Object.entries(book).find(([, v]) => isC(v) && nameOf.has(v));
  if (inBook) { const ob = await R({ action: 'contract', contract: inBook[1] }); ok(`a contract that is itself in the address book says so (${ob.is_in_the_address_book_as.join(', ')})`, same(Object.fromEntries(ob.is_in_the_address_book_as.map((r) => [r, 1])), Object.fromEntries(Object.keys(book).filter((r) => book[r] === inBook[1]).map((r) => [r, 1])))); }
}

// ---------------------------------------------------------------- E
console.log('— E roles —');
{ const o = await R({ action: 'roles' }); const roles = Object.keys(book);
  const listed = [...o.held_by_accounts, ...o.held_by_daos, ...o.held_by_contracts].map((r) => r.role).sort();
  ok(`the address book whole: ${o.roles_total} roles, each listed once — ${o.held_by_accounts.length} held by accounts, ${o.held_by_daos.length} by DAOs, ${o.held_by_contracts.length} by contracts`, o.roles_total === roles.length && JSON.stringify(listed) === JSON.stringify(roles.slice().sort()) && o.read_at === state.address_book.capturedAt);
  ok('held by an account = the holder is an account address; by a DAO = the holder is a DAO core of the groups file', o.held_by_accounts.every((r) => isA(book[r.role]) && r.account === book[r.role]) && o.held_by_daos.every((r) => groups.daos.some((d) => d.core === book[r.role])) && o.held_by_contracts.every((r) => isC(book[r.role]) && !groups.daos.some((d) => d.core === book[r.role])));
  const withUse = guards && roles.find((r) => guards.guards.some((g) => g.guard.kind === 'role' && g.guard.role === r));
  if (withUse) {
    const one = (await R({ action: 'roles', role: withUse })).role; const want = guards.guards.filter((g) => g.guard.kind === 'role' && g.guard.role === withUse && String(g.code_id) === String((state.contracts[g.contract] || {}).code_id || g.code_id));
    ok(`${withUse}: held by ${one.holder.is === 'account' ? one.holder.signs_with : one.holder.name}; required for ${[...new Set(one.required_for.map((u) => u.action))].join(' / ')} on ${[...new Set(one.required_for.map((u) => u.on))].length} contract(s) — the contracts' own answers`, one.holder.address === book[withUse] && one.required_for.length === want.length && one.required_for.every((u) => want.some((w) => w.action === u.action && (nameOf.get(w.contract) || w.contract) === u.on)), one.required_for);
    const pairs = (r) => { const p = r && r.sent && r.sent.msg && r.sent.msg.set_addresses && r.sent.msg.set_addresses.addresses; return Array.isArray(p) ? p : []; };
    const setBy = all.find((r) => !r.observed && pairs(r).some((p) => p[0] === withUse && p[1] === book[withUse]));
    ok(setBy ? `the change that set it is the newest record whose own message names that role and that holder (${day(setBy)})` : 'no record names that role and holder → it says so, no guess', setBy ? one.set_by && one.set_by.link.endsWith(encodeURIComponent(setBy.k)) : !one.set_by && /no change on record names/.test(one.set_by_note), one.set_by || one.set_by_note);
    const lower = await run({ action: 'roles', role: withUse.toLowerCase().slice(0, -3) }); ok('a role asked for in lower case, or in part, is found', lower.role && lower.role.role === withUse);
  }
  ok('a role that is not in the address book says so and lists the roles', (await run({ action: 'roles', role: 'NOT_A_ROLE' })).roles.length === roles.length);
}

// ---------------------------------------------------------------- F
console.log('— F address —');
{ const holders = count(Object.entries(book).filter(([, v]) => isA(v)), ([, v]) => v); const top = Object.entries(holders).sort((a, b) => b[1] - a[1])[0];
  if (top) { const a = top[0]; const o = await R({ action: 'address', address: a });
    const adminOf = Object.keys(state.contracts).filter((k) => state.contracts[k].admin === a), sent = changes.filter((r) => r.signer === a && how(r) === 'direct');
    ok(`the account that holds the most roles: ${o.address.roles_held.length} roles, admin of ${o.admin_of.count} watched contract(s), ${o.changes_sent_directly.count} changes sent directly — all = the recount`, o.address.roles_held.length === top[1] && o.admin_of.count === adminOf.length && o.changes_sent_directly.count === sent.length && same(o.changes_sent_directly.by_kind, count(sent, (r) => T._internals.KIND_LABEL[r.kind])) && o.address.is === 'account', { roles: o.address.roles_held.length, admin: o.admin_of.count, sent: o.changes_sent_directly.count });
    ok('it is given as an address and how it signs — no name, because no file names it', !o.address.name && /^an account/.test(o.address.signs_with) && o.page.endsWith('#address=' + a)); }
  const dao = groups.daos.find((d) => changes.some((r) => r.via && r.via.dao === d.core)); const od = await R({ action: 'address', address: dao.core }); const via = changes.filter((r) => r.via && r.via.dao === dao.core);
  ok(`a DAO (${dao.short || dao.name}): "${od.address.signs_with}", ${od.passed_proposals_executed.count} changes through its passed proposals = the recount`, od.address.is === 'DAO' && od.address.signs_with === 'a DAO: its members vote' && od.passed_proposals_executed.count === via.length);
  const stranger = 'terra1' + 'q'.repeat(38); const os = await R({ action: 'address', address: stranger });
  ok('an address the record does not know: said plainly, nothing made up', os.on_record === false && /holds no role, is the admin of no watched contract and sent no change on record/.test(os.note) && !os.changes_sent_directly);
  ok('something that is not an address is refused', /terra1/.test((await run({ action: 'address', address: 'bob' })).error));
}

// ---------------------------------------------------------------- G
console.log('— G facts only, and short enough —');
{ const sample = [];
  for (const input of [{ action: 'overview' }, { action: 'roles' }, { action: 'changes', limit: 25 }, { action: 'changes', how: 'direct', limit: 25 }, { action: 'changes', how: 'observed', limit: 25 }, { action: 'changes', kind: 'admin', limit: 25 }, { action: 'changes', kind: 'role', limit: 25 }]) sample.push(JSON.stringify(await R(input)));
  for (const c of groups.contracts.filter((c) => changes.some((r) => r.contract === c.address)).slice(0, 40)) sample.push(JSON.stringify(await R({ action: 'contract', contract: c.address, limit: 25 })));
  for (const role of Object.keys(book)) sample.push(JSON.stringify(await R({ action: 'roles', role })));
  for (const a of [...new Set(changes.map((r) => r.signer).filter(isA))].slice(0, 25)) sample.push(JSON.stringify(await R({ action: 'address', address: a, limit: 25 })));
  const text = sample.join('\n').replace(/"(contract_said|message_as_sent|chain_label|action)":"(?:[^"\\]|\\.)*"/g, '""');   // the chain's own words are the chain's
  const verdict = text.match(/\b(safe|unsafe|risk\w*|attack\w*|rug\w*|malicious|suspicious|illegal|fraud\w*|backdoor|takeover|compromised|scam\w*|stole\w*|theft|unauthori[sz]ed|shady|hostile)\b/i);
  ok(`no verdict word in ${sample.length} answers (the chain's own refusal texts and labels set aside)`, !verdict, verdict && verdict[0]);
  ok('no answer carries a mark of its own (no needs_look / attention / severity field)', !/"(needs_look|needs_a_look|attention|severity|risk|flag|flags|verdict)":/.test(text));
  const big = sizes.slice().sort((a, b) => b[1] - a[1])[0];
  ok(`every answer fits under the server's 12,000-character cut — the longest of ${sizes.length} is ${big[1]} (${big[0]})`, big[1] < 12000, sizes.filter((s) => s[1] >= 12000));
}

// ---------------------------------------------------------------- H
console.log('— H a file that does not answer —');
{ const o = await run({ action: 'overview' }, mk({ 'contract-watch/index.json': null }));
  ok('no index → it says the record could not be read just now (no empty answer that reads as "no changes")', /could not be read just now/.test(o.error || '') && !o.record);
  const m = Object.keys(idx.months).sort().pop(); const o2 = await run({ action: 'changes', limit: 3 }, mk({ [`contract-watch/events/${m}.json`]: null }));
  ok(`a month file that does not answer (${m}) is named in the answer`, Array.isArray(o2.months_not_read_just_now) && o2.months_not_read_just_now.join() === m && o2.matched === changes.filter((r) => !r.timestamp.startsWith(m.replace('/', '-'))).length, o2.months_not_read_just_now);
  const o3 = await run({ action: 'roles' }, mk({ 'contract-watch/guards.json': null, 'contract-watch/accounts.json': null, 'contract-watch/rewalk.json': null, 'token-catalog/snapshots/current.json': null }));
  ok('without the role answers and the key counts it still gives the address book, and says an account\'s key count has not been read', o3.roles_total === Object.keys(book).length && o3.held_by_accounts.every((r) => /has not been read/.test(r.signs_with) && !r.required_for));
  ok('no address book → it says so', /address book has not been read/.test((await run({ action: 'roles' }, mk({ 'contract-watch/state/current.json': null }))).error || ''));
}

// ---------------------------------------------------------------- I
console.log('— I the server wiring —');
{ const srv = fs.readFileSync(path.join(here, 'server.js'), 'utf8'); const rules = srv.match(/const SYSTEM_RULES = `([\s\S]*?)`;\n/)[1];
  ok('server.js requires the tool, lists it for the model, and dispatches it', /require\('\.\/lib\/contract-watch-tool\.js'\)/.test(srv) && /\{ name: 'contract_watch'/.test(srv) && /if \(name === 'contract_watch'\) return CWT\.run\(input\)/.test(srv));
  const def = srv.match(/\{ name: 'contract_watch'[\s\S]*?required: \['action'\] \} \},/)[0];
  ok('the tool\'s actions offered to the model are the tool\'s own', ['overview', 'changes', 'contract', 'roles', 'address'].every((a) => def.includes(`'${a}'`)) && /does not carry the page\\'s "needs a look" mark/.test(def));
  ok('read_product may read contract-watch/**; the chapter and the head of its changelog are in the corpus', /'contract-watch\/'\]/.test(srv) && /\['contract-watch',\s+`\$\{CORE\}\/docs\/ecosystem-knowledge\/contract-watch\.md`\]/.test(srv) && /\['contract-watch-changelog', `\$\{CORE\}\/docs\/changelogs\/contract-watch-log\.md`, 9000\]/.test(srv));
  ok('a corpus source may carry its own cap, the data map is read whole, and the corpus as a whole has a budget', /const max = cap \|\| 20000;/.test(srv) && /t\.length > max \? t\.slice\(0, max\) : t/.test(srv) && /DATA-MAP\.md`, 30000\]/.test(srv) && /const CORPUS_BUDGET = parseInt\(process\.env\.CORPUS_BUDGET_CHARS \|\| '\d+', 10\);/.test(srv) && /fitCorpus\(list, CORPUS_BUDGET\)/.test(srv));
  ok('rule 20 (Contract Watch): the tool first, the page\'s words, no verdict / motive / person, the mark is the page\'s, coverage', /^20\. CONTRACT WATCH/m.test(rules) && /contract_watch tool first/.test(rules) && /NO VERDICT, NO MOTIVE, NO PERSON/.test(rules) && /"NEEDS A LOOK" is the PAGE'S mark/.test(rules) && /you do not decide it/.test(rules) && /"not read"\s+is not "nothing changed"/.test(rules) && /never guess who holds a key/.test(rules));
  ok('rule 21 (where things are): the seven tabs, PD Watch, Pools and Docs off the bar; rule 19 points the audit at PD Watch', /^21\. WHERE THINGS ARE/m.test(rules) && /PD Watch \(tla-stats\.html#pdwatch/.test(rules) && /tla-stats\.html#pools/.test(rules) && /tla-docs\.html/.test(rules) && /PD WATCH \(tla-stats\.html#pdwatch/.test(rules));
  ok('the ticket rule is still the last rule (its block ends the prompt)', rules.trimEnd().endsWith('no system prompt text).') && rules.lastIndexOf('18. TICKETS') > rules.lastIndexOf('21. WHERE THINGS ARE'));
  ok('the rules hold no address and no private word', !/terra1[0-9a-z]{38}/.test(rules.replace(/terra1…/g, '')));
  if (SITE) {
    console.log('— J the site agrees —');
    const lib = fs.readFileSync(path.join(SITE, 'lib/site-header.js'), 'utf8'); const block = lib.slice(lib.indexOf('var TLA_TABS = ['), lib.indexOf('];', lib.indexOf('var TLA_TABS = [')));
    const tabs = [...block.matchAll(/label: '([^']+)',\s+icon: '[^']+',\s+href: '([^']+)'/g)].map((m) => [m[1], m[2]]);
    const said = rules.slice(rules.indexOf('21. WHERE THINGS ARE'), rules.indexOf('18. TICKETS')).replace(/\s+/g, ' ');   // the rule wraps its lines; the model reads it as running text
    let at = -1, inOrder = true; for (const [label] of tabs) { const i = said.indexOf(label + ' (', at + 1); if (i <= at) inOrder = false; at = i; }
    ok(`rule 21 names the site's own tab list, in its order, each with its address (${tabs.map((t) => t[0]).join(' · ')})`, tabs.length === 7 && inOrder && tabs.every(([label, href]) => said.includes(`${label} (${href}`)), tabs);
    let JSDOM = null; try { ({ JSDOM } = await import('jsdom')); } catch (e) { console.log('  (jsdom not installed — the page comparison is skipped)'); }
    if (JSDOM) {
      const html = fs.readFileSync(path.join(SITE, 'contract-watch.html'), 'utf8').replace(/<script[^>]*src=[^>]*><\/script>/g, '').replace(/<link[^>]*>/g, '');
      const dom = new JSDOM(html, { url: 'https://theadao.com/contract-watch.html', runScripts: 'dangerously', pretendToBeVisual: true, beforeParse(w) {
        w.SiteHeader = { mount() {}, subnav() {}, tlaTabs: () => [] }; w.SiteFooter = { mount() {} };
        w.fetch = async (u) => { const m = String(u).split('?')[0].match(/raw\.githubusercontent\.com\/thealliancedao\/tla-core\/main\/(.+)$/); const f = m && find(m[1]); if (!f) return { ok: false, status: 404, json: async () => null }; const t = fs.readFileSync(f, 'utf8'); return { ok: true, status: 200, json: async () => JSON.parse(t) }; };
        w.Element.prototype.scrollIntoView = function () {}; } });
      const w = dom.window; for (let i = 0; i < 200 && !(w.__cw && w.__cw.S.ready); i++) await new Promise((r) => setTimeout(r, 50));
      if (!(w.__cw && w.__cw.S.ready)) ok('the page read the record in jsdom', false);
      else { const byK = new Map(w.__cw.S.recs.map((r) => [r.k, r])); let n = 0, bad = null;
        for (const r of all) { const pr = byK.get(r.k); if (!pr) continue; n++; const t = T._internals.titleOf(r), pt = w.__cw.describe(pr).title, h = T._internals.howOf(r), ph = w.__cw.howOf(pr); if (t !== pt || h !== ph) bad = bad || { k: r.k, tool: [t, h], page: [pt, ph] }; }
        ok(`for every record the page holds (${n} of ${all.length}) the tool's words and route are the page's own — what changed, and how it arrived`, n === all.length && !bad, bad || { n, all: all.length }); }
      w.close();
    }
  }
}

// ---------------------------------------------------------------- K
// The server end to end, with the model replaced by a script: the real server.js is started with its outbound fetch pointed at the
// checkouts (tla-core files) and at a stand-in for the model that asks for the contract_watch tool once and then answers. What the
// server SENT the model is then read back: the corpus it built, the tools it offered, and the tool result it handed over.
console.log('— K the server end to end (the model replaced by a script) —');
{ const { spawn } = await import('child_process'); const os = await import('os');
  const outFile = path.join(os.tmpdir(), `cw-gate-${process.pid}.json`); const port = 18000 + (process.pid % 1500);
  const mock = `
    const fs = require('fs'), path = require('path'); const DIRS = process.env.MOCK_DIRS.split(':'); const calls = [];
    global.fetch = async (url, opts) => { url = String(url);
      if (url.startsWith('https://api.anthropic.com/')) { calls.push(JSON.parse(opts.body)); fs.writeFileSync(process.env.MOCK_OUT, JSON.stringify(calls));
        const reply = calls.length === 1 ? { content: [{ type: 'tool_use', id: 'tu_1', name: 'contract_watch', input: { action: 'overview' } }], stop_reason: 'tool_use', usage: { input_tokens: 1, output_tokens: 1 } } : { content: [{ type: 'text', text: 'SCRIPTED ANSWER' }], stop_reason: 'end_turn', usage: {} };
        return { ok: true, status: 200, json: async () => reply }; }
      const m = url.match(/raw\\.githubusercontent\\.com\\/thealliancedao\\/tla-core\\/main\\/([^?]+)/);
      if (m) for (const d of DIRS) { const f = path.join(d, m[1]); if (fs.existsSync(f)) { const t = fs.readFileSync(f, 'utf8'); return { ok: true, status: 200, text: async () => t, json: async () => JSON.parse(t) }; } }
      return { ok: false, status: 404, text: async () => '', json: async () => null }; };
    require(${JSON.stringify(path.join(here, 'server.js'))});`;
  const child = spawn(process.execPath, ['-e', mock], { env: Object.assign({}, process.env, { PORT: String(port), ANTHROPIC_API_KEY: 'gate-not-a-key', MOCK_DIRS: [CW, CORE].join(':'), MOCK_OUT: outFile, QUESTION_LOG: '0' }), stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
  try {
    let up = false; for (let i = 0; i < 60 && !up; i++) { await new Promise((r) => setTimeout(r, 150)); try { const h = await fetch(`http://127.0.0.1:${port}/health`); up = h.ok; } catch (e) { } }
    ok('the server starts with the new tool and rules (GET /health)', up, log.slice(0, 300));
    if (up) {
      const r = await fetch(`http://127.0.0.1:${port}/ask`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: 'What changed on the alliance contracts lately?', accepted_disclaimer: true, page: 'contract-watch' }) });
      const d = await r.json(); const calls = JSON.parse(fs.readFileSync(outFile, 'utf8'));
      ok('a question goes through: the tool was called once and the answer came back', r.ok && d.answer === 'SCRIPTED ANSWER' && d.chain_queries === 1 && calls.length === 2, { status: r.status, d, calls: calls.length });
      const corpus = calls[0].system[1].text, block = (n) => { const m = corpus.match(new RegExp('<' + n + '>\\n([\\s\\S]*?)\\n</' + n + '>')); return m ? m[1] : null; };
      const chapter = find('docs/ecosystem-knowledge/contract-watch.md') && fs.readFileSync(find('docs/ecosystem-knowledge/contract-watch.md'), 'utf8');
      if (chapter) ok(`the corpus the model received holds the Contract Watch chapter whole (${chapter.length} characters)`, block('contract-watch') === chapter && chapter.length < 20000, (block('contract-watch') || '').length);
      else ok('the corpus names the chapter as unavailable when the checkout has none (it is fetched from tla-core at run time)', /<contract-watch>UNAVAILABLE \(404\)<\/contract-watch>/.test(corpus));
      const dm = find('docs/agent/DATA-MAP.md') && fs.readFileSync(find('docs/agent/DATA-MAP.md'), 'utf8');
      if (dm) ok(`the data map is in the corpus whole (${dm.length} characters; it used to be cut at 20,000)`, block('data-map') === dm, (block('data-map') || '').length);
      const cl = find('docs/changelogs/contract-watch-log.md') && fs.readFileSync(find('docs/changelogs/contract-watch-log.md'), 'utf8');
      if (cl) ok('the head of the Contract Watch changelog is in the corpus, newest entries first, within its own cap (9,000)', (block('contract-watch-changelog') || '').startsWith(cl.slice(0, 2000)) && (cl.length <= 9000 || /…\[truncated\]$/.test(block('contract-watch-changelog'))) && block('contract-watch-changelog').length <= 9020);
      // the budget: the whole corpus stays under it; what is shortened is a changelog / spec / queue (never below the floor), never a chapter
      const budget = Number((fs.readFileSync(path.join(here, 'server.js'), 'utf8').match(/CORPUS_BUDGET_CHARS \|\| '(\d+)'/) || [])[1]);
      const blocks = [...corpus.matchAll(/<([a-z0-9-]+)>\n([\s\S]*?)\n<\/\1>/g)].map((m) => ({ name: m[1], text: m[2] })); const bodies = blocks.reduce((n, b) => n + b.text.replace(/\n…\[truncated\]$/, '').length, 0);
      const h = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
      ok(`the corpus the model received keeps to its budget: ${bodies} characters of sources ≤ ${budget} (the whole block ${corpus.length}); /health reports it, with the version (${h.version})`, bodies <= budget && bodies > budget * 0.8 && h.corpus && h.corpus.chars === corpus.length - 'CORPUS:\n'.length && h.corpus.budget === budget && h.version === '1.24.0', { bodies, budget, health: h.corpus });
      const soft = /-changelog$|^spec-|^build-queue$|^cron-fleet$/; const whole = (n) => { const f = { 'member-portfolio': 'docs/ecosystem-knowledge/member-portfolio.md', 'lp-grades-and-voting': 'docs/ecosystem-knowledge/lp-grades-and-voting.md', 'phoenix-directive': 'docs/ecosystem-knowledge/phoenix-directive.md', 'votion': 'docs/ecosystem-knowledge/votion.md' }[n]; const t = f && find(f) && fs.readFileSync(find(f), 'utf8'); return !t || block(n) === (t.length > 20000 ? t.slice(0, 20000) + '\n…[truncated]' : t); };
      ok(`making room took ${h.corpus.shortened_to_fit} characters off the changelogs, specs, build queue and cron table only — each still at least 6,000; the knowledge chapters are whole`, h.corpus.shortened_to_fit > 0 && blocks.filter((b) => soft.test(b.name)).every((b) => b.text.length >= 5990 || !/…\[truncated\]$/.test(b.text)) && ['member-portfolio', 'lp-grades-and-voting', 'phoenix-directive', 'votion'].every(whole) && h.corpus.not_read.length === 0, { not_read: h.corpus.not_read, soft: blocks.filter((b) => soft.test(b.name)).map((b) => [b.name, b.text.length]) });
      ok('the rules it received hold rules 20 and 21, and the tools it was offered include contract_watch', /20\. CONTRACT WATCH/.test(calls[0].system[0].text) && /21\. WHERE THINGS ARE/.test(calls[0].system[0].text) && calls[0].tools.some((t) => t.name === 'contract_watch' && t.input_schema.properties.action.enum.join() === 'overview,changes,contract,roles,address'));
      const tr = calls[1].messages[calls[1].messages.length - 1].content[0]; let parsed = null; try { parsed = JSON.parse(tr.content); } catch (e) { }
      ok(`the tool result the model was handed is whole JSON (${tr.content.length} characters, not cut) and says ${parsed && parsed.record.changes_on_record} changes on record = the files' ${changes.length}`, tr.type === 'tool_result' && tr.tool_use_id === 'tu_1' && parsed && parsed.record.changes_on_record === changes.length && tr.content.length < 12000, tr.content.slice(0, 200));
    }
  } finally { child.kill(); try { fs.unlinkSync(outFile); } catch (e) { } }
}
console.log(`\n=== GATE contract-watch-tool: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
