#!/usr/bin/env node
'use strict';
// mock-run-contract-watch.js — BINDING gate for the contract-changes stream (tla-flows 3.6.0):
// lib/admin-classifier.js, its wiring into the walk (index.js) and the history derive (backfill-contract-watch.js).
// Every transaction used is a REAL one, read from the walks stored in a tla-core checkout and found by height + hash.
//   A  the classifier on real transactions: a list change executed by a DAO proposal · an upgrade with the contract's own
//      version report · an admin change inside a sub-DAO adoption (four records, one transaction) · a member-group change
//      on a contract nobody lists, kept because a watched DAO's proposal made it · the weekly distribution (routine) ·
//      a settings change sent directly · a redelegation · and what must NOT be kept (a claim through authz, a zap
//      deposit, a failed transaction, an unwatched contract)
//   F  the FCD-era adapter: message boundaries and lifecycle events rebuilt from a transaction's messages
//   W  the real run() over a small chain built from those transactions: the month file, keyed and sorted; flows still
//      captured; a second run adds nothing; a failed publish of the stream holds the cursor; the heartbeat counts
//   R  the catch-up walk (rewalk.json): a bounded stretch per run, progress and the times of the span walked, pruned blocks
//   S  3.7.0 the state read (lib/contract-state.js): the address book as the chain answered it on 2026-08-11 and the
//      contract inventory of 2026-09-29 (both stored in the checkout) through the real run() against a stand-in LCD —
//      first read files nothing; not due inside a day; a role that moved, an admin and a code id that changed are filed
//      once (also when the state write fails in between); a change the walk files triggers a read in the same run;
//      a node that answers nothing changes nothing; contract-watch/index.json lists the months
//   D  (FULL=1, ~3 min) the whole stored corpus: every reward-list change is a DAO proposal being executed
// Usage: TLA_CORE_DIR=<tla-core checkout> [FULL=1] node mock-run-contract-watch.js
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const SRC = process.env.TLA_CORE_DIR; if (!SRC) { console.error('TLA_CORE_DIR required'); process.exit(1); }
process.env.GITHUB_TOKEN = process.env.GITHUB_TOKEN || 'mock-token'; process.env.PNL = '0'; process.env.ADMIN_STATE = '0';   // the state read is switched on in section S
const AD = require('./lib/admin-classifier.js'), BF = require('./backfill-contract-watch.js'), C = require('../config/contracts.js'), CS = require('./lib/contract-state.js');
let pass = 0, fail = 0; const check = (n, ok, x) => { if (ok) { pass++; console.log('  ✅ ' + n); } else { fail++; console.log('  ❌ ' + n + (x !== undefined ? ' — ' + JSON.stringify(x).slice(0, 420) : '')); } };
const readGz = (p) => JSON.parse(zlib.gunzipSync(fs.readFileSync(p)).toString('utf8'));
const cache = new Map(); const part = (rel) => cache.get(rel) || cache.set(rel, readGz(path.join(SRC, rel))).get(rel);
const raw = (rel, h, x) => { const r = part('tla-flows/raw/' + rel).find(t => t.h === h && t.x === x); if (!r) throw new Error(`fixture not in the checkout: ${rel} ${h} ${x.slice(0, 12)}`); return r; };
const fcd = (rel, h, x) => { const t = part('archive/fcd/' + rel).txs.find(t => Number(t.height) === h && t.txhash === x); if (!t) throw new Error(`FCD fixture not in the checkout: ${rel} ${h}`); return t; };
const PD = 'terra1k8ug6dkzntczfzn76wsh24tdjmx944yj6mk063wum7n20cwd7lxq4lppjg', PD_MODULE = 'terra1660g9mle5kfsq8c0p4k4hgr9ujdyr3m48c22cawy0akr98rmwksqehqnup';
const isWallet = (a) => /^terra1[0-9a-z]{38}$/.test(a || '');

const R = {   // real transactions of the archive walk (tla-flows/raw): [part, height, hash]
  remove:   ['14098866-14548865/part-00027.json.gz', 14305281, '9AFC59E4A0A89F616CA1933DD8BD668124A53CF9B7287DB98D80CA01C4A07158'],   // PD A117: two assets off the single list
  whitelist:['14456121-14906120/part-00020.json.gz', 14672765, 'E1C05B1CB58187067161FD3D731E1062B0D90F963EFB2DD68F59CB14EF366E86'],   // PD A123
  migrate:  ['13737811-14187810/part-00028.json.gz', 14033189, '2F974A5FA9F0FB82C5E736FC73C016FC4B26A8143C2C28463B1C19FA2BF2A067'],   // bribe manager 1.1.1 → 1.8.1
  adopt:    ['17005824-17455823/part-00011.json.gz', 17170542, '8F96B825E9D92D0B06710B3B7BE464F3666F57127B6798E59156EA73C86E37A0'],   // PD A182: a sub-DAO's admin becomes PD
  members:  ['14715493-15165492/part-00012.json.gz', 14905231, '413DD948C1C36AAB870FC22BEBF44C2CAE18E17AAFC2A64E58A2431C0A6DE7F2'],   // PD A125: one member wallet replaced
  epoch:    ['13737811-14187810/part-00007.json.gz', 13822277, 'B252680766A222422D5AD41E83B1528118EE477E61669336820A9433AF155402'],   // the weekly distribution
  config:   ['16735277-17185276/part-00012.json.gz', 16919637, '587970D0C96229230ECC85C5BDF5E1A33D19C2CBE10F9AA61A1C6C9339B52544'],   // zapper/update_config, sent directly
  redeleg:  ['14098866-14548865/part-00021.json.gz', 14247309, 'D430FB83A52E19A65C9D443C31F7376CAD9E171F491CC1DA13811256E2ADF8B8'],   // PD A114: a connector redelegates
  authz:    ['13737811-14187810/part-00005.json.gz', 13787160, '5FB731F9995E641280CD28D01D5AEF9F7283CBC7340AF54B47CA60636C4E9831'],   // a claim through authz — not a change
  deposit:  ['14098866-14548865/part-00027.json.gz', 14297424, '2BE7EEE87F90D0CF05AADBFB8A07E2165FE96A65911014724BAA9D8279912684'],   // a zap deposit — a flow, not a change
};
const F = {   // real transactions of the FCD archive
  whitelist: ['lp-stable/part-00002.json.gz', 13648986, '886152557921DE6F80F17BE742E31BBE0102095921FE1DCC852AB5CCA81A8485'],
  migrate:   ['lp-stable/part-00010.json.gz', 12997418, 'E2C405314C46A27548EEBD8F5E60D7B1F5895BE914AC3672365A813435D10A4B'],
  admin:     ['lp-stable/part-00020.json.gz', 11910063, '3C7D83963F5B19592A4A4A8461C4170DF91B66E3CCCB65C87388B0209C5F873D'],
};
const watch = AD.adminWatchFrom({ config: C, known: JSON.parse(fs.readFileSync(path.join(SRC, 'docs/curated/known_contracts.json'), 'utf8')), registry: JSON.parse(fs.readFileSync(path.join(SRC, 'tla-voting/capture-registry.json'), 'utf8')) });
const cls = (k) => AD.classifyAdminTx(BF.rawToTxr(raw(...R[k])), watch);

(async () => {
  console.log(`— A the classifier on real transactions (${AD.VERSION}; ${watch.size} contracts watched) —`);
  { const r = cls('remove');
    check('a list change executed by a proposal: ONE record — the single staking contract, asset/remove_assets, both assets, PD proposal 117', r.length === 1 && r[0].kind === 'list' && r[0].contract === C.STAKING_BUCKETS.single && r[0].action === 'asset/remove_assets' && /^cw20:terra1.+,native:factory\/terra1.+\/uLP$/.test(r[0].detail.assets) && r[0].via && r[0].via.kind === 'dao_proposal' && r[0].via.dao === PD && r[0].via.proposal_module === PD_MODULE && r[0].via.proposal_id === '117', r);
    check('…the signer is the wallet that sent the execute, the key is txhash:0, height and time are the transaction\'s', isWallet(r[0].signer) && r[0].k === R.remove[2] + ':0' && r[0].height === 14305281 && r[0].timestamp === '2025-02-14T22:06:09Z' && r[0].msg_type === '/cosmwasm.wasm.v1.MsgExecuteContract', { signer_is_wallet: isWallet(r[0].signer), k: r[0].k, t: r[0].timestamp }); }
  { const r = cls('whitelist'); check('a whitelist through proposal 123', r.length === 1 && r[0].kind === 'list' && r[0].action === 'asset/whitelist_assets' && r[0].via.proposal_id === '123' && /^cw20:terra1/.test(r[0].detail.assets), r); }
  { const r = cls('migrate');
    check('an upgrade: kind upgrade, the new code id, the contract\'s own report (ve3-bribe-manager 1.1.1 → 1.8.1), sent directly by a wallet', r.length === 1 && r[0].kind === 'upgrade' && r[0].action === 'migrate' && r[0].contract === C.BRIBE_MANAGER.addr && r[0].detail.code_id === '3494' && r[0].detail.previous_contract_version === '1.1.1' && r[0].detail.new_contract_version === '1.8.1' && r[0].detail.new_contract_name === 've3-bribe-manager' && r[0].via === null && isWallet(r[0].signer) && r[0].msg_type === '/cosmwasm.wasm.v1.MsgMigrateContract', r); }
  { const r = cls('adopt'); const kinds = r.map(x => x.kind + ':' + x.action).join(' | ');
    check('a sub-DAO adopted by proposal 182 → four records in one transaction, keyed :0…:3, each carrying the proposal', r.length === 4 && r.every((x, i) => x.k.endsWith(':' + i) && x.via && x.via.proposal_id === '182' && x.via.dao === PD) && /governance:execute_accept_admin_nomination \| governance:execute_admin_msgs \| admin:update_admin \| governance:execute_update_sub_daos_list/.test(kinds), kinds);
    const adm = r.find(x => x.kind === 'admin'); check('…the admin change names the new admin (the DAO) and is kept though the sub-DAO is on no list (a lifecycle event is kept for every contract)', adm && adm.detail.new_admin_address === PD && !watch.has(adm.contract), adm); }
  { const r = cls('members'); check('a member group nobody lists, changed by a watched DAO\'s proposal → kept (governance, update_members, added 1 / removed 1, proposal 125)', r.length === 1 && r[0].kind === 'governance' && r[0].action === 'update_members' && !watch.has(r[0].contract) && r[0].detail.added === '1' && r[0].detail.removed === '1' && r[0].via.proposal_id === '125', r);
    const stranger = new Set([...watch].filter(a => a !== PD)); check('…and NOT kept when that DAO is not watched', AD.classifyAdminTx(BF.rawToTxr(raw(...R.members)), stranger).length === 0); }
  { const r = cls('epoch'); check('the weekly distribution: five records (the gauge + four staking contracts), kind epoch, routine: true, repeated attributes kept as lists', r.length === 5 && r.every(x => x.kind === 'epoch' && x.routine === true) && r[0].action === 'gauge/set_distribution' && Array.isArray(r[0].detail.gauge) && r[0].detail.gauge.join() === 'stable,project,bluechip,single' && r.slice(1).every(x => x.action === 'asset/set_asset_reward_distribution'), r.map(x => x.action)); }
  { const r = cls('config'); check('a settings change sent directly: zapper/update_config, kind setting, via null, signer a wallet', r.length === 1 && r[0].kind === 'setting' && r[0].action === 'zapper/update_config' && r[0].contract === C.ZAPPER.addr && r[0].via === null && isWallet(r[0].signer), r); }
  { const r = cls('redeleg'); check(`a redelegation by proposal 114: ${r.length} records, kind delegation — the four connectors and the PD treasury tool`, r.length === 5 && r.every(x => x.kind === 'delegation' && /^(ca|pdt)\/alliance_redelegate$/.test(x.action) && x.via.proposal_id === '114') && r.filter(x => x.action === 'ca/alliance_redelegate').length === 4, r.map(x => [x.kind, x.action])); }
  check('NOT kept: a reward claim made through authz', cls('authz').length === 0, cls('authz'));
  check('NOT kept: a zap deposit (a flow)', cls('deposit').length === 0, cls('deposit'));
  { const t = BF.rawToTxr(raw(...R.remove)); check('NOT kept: the same list change in a failed transaction', AD.classifyAdminTx({ ...t, code: 5 }, watch).length === 0); }
  { const t = BF.rawToTxr(raw(...R.config)); check('NOT kept: a settings change on a contract nobody watches', AD.classifyAdminTx(t, new Set()).length === 0);
    const t2 = BF.rawToTxr(raw(...R.migrate)); check('…but an upgrade is kept with an EMPTY watch list (every contract)', AD.classifyAdminTx(t2, new Set()).length === 1 && AD.classifyAdminTx(t2, null).length === 1); }
  { const t = BF.rawToTxr(raw(...R.remove)); const two = { ...t, events: [...t.events, { type: 'message', attributes: [{ key: 'action', value: '/cosmwasm.wasm.v1.MsgExecuteContract' }, { key: 'sender', value: 'terra1' + 'q'.repeat(38) }] }, { type: 'wasm', attributes: [{ key: '_contract_address', value: C.STAKING_BUCKETS.stable }, { key: 'action', value: 'asset/whitelist_assets' }, { key: 'assets', value: 'native:uluna' }] }] };
    const r = AD.classifyAdminTx(two, watch); check('a second message in the same transaction does not inherit the first one\'s proposal or signer', r.length === 2 && r[0].via.proposal_id === '117' && r[1].via === null && r[1].signer === 'terra1' + 'q'.repeat(38) && r[1].k.endsWith(':1'), r.map(x => [x.via, x.signer && x.signer.slice(0, 9)])); }
  check('vocabulary: user actions and callbacks are not changes; the change actions are', ['asset/stake', 'asset/unstake', 'asset/claim_rewards', 'gauge/vote', 've/create_lock', 'bribe/add_bribe', 'zapper/create_lp', 'swap', 'transfer', 'pdt/setup', 'launch-nft/setup', 'create_pair', 'register'].every(a => AD.kindOfAction(a) === null) &&
    AD.kindOfAction('asset/remove_assets') === 'list' && AD.kindOfAction('asset/whitelist_assets') === 'list' && AD.kindOfAction('set_addresses') === 'role' && AD.kindOfAction('zapper/update_config') === 'setting' && AD.kindOfAction('update_members') === 'governance' && AD.kindOfAction('ve/update_blacklist') === 'guard' && AD.kindOfAction('gauge/set_distribution') === 'epoch' && AD.kindOfAction('creda-portfolio/withdraw_reserve') === 'reserve', [AD.kindOfAction('ve/update_blacklist'), AD.kindOfAction('set_addresses')]);

  console.log('— F the FCD-era adapter (messages → message boundaries and lifecycle events) —');
  { const r = AD.classifyAdminTx(BF.fcdToTxr(fcd(...F.whitelist)), watch); check('a 2024 whitelist: list change on the stable staking contract through a PD proposal, signer from the message', r.length >= 1 && r[0].kind === 'list' && r[0].action === 'asset/whitelist_assets' && r[0].contract === C.STAKING_BUCKETS.stable && r[0].via && r[0].via.dao === PD && isWallet(r[0].signer), r); }
  { const t = fcd(...F.migrate), r = AD.classifyAdminTx(BF.fcdToTxr(t), watch); const n = (t.messages || []).filter(m => /MsgMigrateContract$/.test(m['@type'])).length;
    check(`a 2024 upgrade transaction: one upgrade record per migrate message (${n}), each with the contract's own version report and the sender as signer; no code id invented where the archive kept none`, n > 0 && r.filter(x => x.kind === 'upgrade').length === n && r.every(x => x.kind !== 'upgrade' || (!('code_id' in x.detail) && x.detail.previous_contract_version === '1.4.0' && x.detail.new_contract_version === '1.6.0' && isWallet(x.signer))) && r.some(x => x.contract === C.STAKING_BUCKETS.stable), r.map(x => [x.kind, x.detail])); }
  { const t = fcd(...F.admin), r = AD.classifyAdminTx(BF.fcdToTxr(t), watch); const n = (t.messages || []).filter(m => /MsgUpdateAdmin$/.test(m['@type'])).length;
    check(`a 2024 admin hand-over: one admin record per message (${n}), each naming the new admin`, n > 0 && r.filter(x => x.kind === 'admin').length === n && r.every(x => x.kind !== 'admin' || (x.action === 'update_admin' && isWallet(x.detail.new_admin_address))), r.map(x => [x.kind, x.action])); }

  console.log('— W the real run() over a chain built from those transactions —');
  const cron = require('./index.js');
  const order = ['deposit', 'authz', 'remove', 'migrate', 'adopt', 'members', 'epoch', 'config'];
  const BASE = 5000000; const CHAIN = new Map();   // one transaction per block, 3 blocks apart, plus a block holding an unrelated transaction
  order.forEach((k, i) => { const r = raw(...R[k]); CHAIN.set(BASE + 3 * i, [{ b64: Buffer.from(r.x).toString('base64'), code: r.c || 0, events: r.e, ts: String(r.t).slice(0, 19) + 'Z' }]); });
  CHAIN.set(BASE + 1, [{ b64: Buffer.from('noise').toString('base64'), code: 0, ts: '2025-01-01T00:00:00Z', events: [{ type: 'wasm', attributes: [{ key: '_contract_address', value: 'terra1' + 'z'.repeat(58) }, { key: 'action', value: 'update_config' }] }] }]);
  const HEAD = BASE + 3 * order.length; const M = { store: {}, failAdminPut: 0, failStatePut: 0, puts: [], head: BASE - 1, prunedBelow: 0, nullBelow: 0, nullAt: null, nullOn: null, noResultsBelow: 0, shortResults: null, lcd: { book: [], info: {}, down: false, calls: 0 } };
  const OLD = BASE - 2000;   // an older stretch of the same chain, for the catch-up walk: the same transactions, 4 blocks apart
  order.forEach((k, i) => { const r = raw(...R[k]); CHAIN.set(OLD + 4 * i, [{ b64: Buffer.from('old' + r.x).toString('base64'), code: r.c || 0, events: r.e, ts: String(r.t).slice(0, 19) + 'Z' }]); });
  const OLD_END = OLD + 4 * order.length;
  const rawFile = (p) => { if (M.store[p] !== undefined) return JSON.parse(M.store[p]); const f = path.join(SRC, p); if (/^(docs\/curated\/known_contracts\.json|tla-voting\/capture-registry\.json|token-catalog\/snapshots\/current\.json)$/.test(p) && fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8')); throw new Error('HTTP 404 (mock raw)'); };
  cron.T.httpGet = async (url) => {
    if (url.includes('/status')) return { result: { sync_info: { latest_block_height: String(M.head) } } };
    if (url.includes('/block_results?height=')) { const N = Number(url.split('height=')[1]); if (N < M.noResultsBelow) throw new Error(`HTTP 500 could not find results for height #${N}`); if (N === M.shortResults) return { result: { txs_results: [] } }; return { result: { txs_results: (CHAIN.get(N) || []).map(t => ({ code: t.code, events: t.events })) } }; }
    if (url.includes('/block?height=')) { const N = Number(url.split('height=')[1]); if (N < M.prunedBelow) throw new Error(`height ${N} is not available, lowest height is ${M.prunedBelow}`); if (N < M.nullBelow || (M.nullAt === N && url.startsWith(M.nullOn || 'https://terra-rpc.publicnode.com'))) return { result: { block_id: { hash: '' }, block: null } }; const txs = CHAIN.get(N) || []; return { result: { block: { header: { time: (txs.length ? txs[0].ts : '2025-01-01T00:00:00Z').replace('Z', '.000000000Z') }, data: { txs: txs.map(t => t.b64) } } } }; }
    if (url.includes('raw.githubusercontent.com')) return rawFile((url.match(/main\/(.+?)(\?|$)/) || [])[1]);
    if (url.includes('/cosmwasm/wasm/v1/contract/')) {   // the stand-in LCD of section S
      M.lcd.calls++; if (M.lcd.down) throw new Error('mock LCD 503');
      const m = url.match(/contract\/(terra1[0-9a-z]+)(?:\/smart\/([A-Za-z0-9+/=]+))?$/); if (!m) throw new Error('mock LCD: bad path ' + url);
      if (m[2]) { const q = JSON.parse(Buffer.from(m[2], 'base64').toString('utf8')); if (m[1] === C.GLOBAL_CONFIG.addr && q.all_addresses && !Object.keys(q.all_addresses).length) return { data: M.lcd.book }; throw new Error('mock LCD: unknown smart query'); }
      const i = M.lcd.info[m[1]]; if (!i) throw new Error('mock LCD 404: not a contract');
      return { address: m[1], contract_info: { code_id: i.code_id, creator: i.creator, admin: i.admin || '', label: i.label, created: null, ibc_port_id: '', extension: null } };
    }
    throw new Error('mock httpGet: unhandled ' + url);
  };
  cron.T.githubApiRequest = async (method, apiPath, body, accept) => {
    const p = decodeURIComponent((apiPath.match(/contents\/(.+?)(\?|$)/) || [])[1] || '');
    if (method === 'GET') { if (M.store[p] === undefined) { const e = new Error('404'); e.statusCode = 404; throw e; } if (/raw/.test(accept || '')) return JSON.parse(M.store[p]); return { sha: 's' + M.store[p].length, content: Buffer.from(M.store[p]).toString('base64') }; }
    if (method === 'PUT') { if (p === 'contract-watch/state/current.json' && M.failStatePut > 0) { M.failStatePut--; const e = new Error('mock 500 (state)'); e.statusCode = 500; throw e; }
      if (/^contract-watch\//.test(p) && M.failAdminPut > 0) { M.failAdminPut--; const e = new Error('mock 500'); e.statusCode = 500; throw e; } M.store[p] = Buffer.from(body.content, 'base64').toString('utf8'); M.puts.push(p); return { ok: 1 }; }
    throw new Error('mock gh: ' + method);
  };
  global.fetch = async () => { throw new Error('mock: no network in the gate'); };   // the pressure duty reads through fetch; P&L is off (PNL=0)
  const quiet = async (fn) => { const l = console.log, w = console.warn, e = console.error; console.log = () => {}; console.warn = () => {}; console.error = () => {}; try { return await fn(); } finally { console.log = l; console.warn = w; console.error = e; } };
  const months = () => Object.keys(M.store).filter(k => /^contract-watch\/events\/\d{4}\/\d{2}\.json$/.test(k)).sort();
  const changes = () => months().flatMap(k => JSON.parse(M.store[k]));
  const flows = () => Object.keys(M.store).filter(k => /^tla-flows\/events\/\d{4}\/\d{2}\.json$/.test(k)).flatMap(k => JSON.parse(M.store[k]));
  const cursor = () => M.store['tla-flows/events/cursor.json'] ? JSON.parse(M.store['tla-flows/events/cursor.json']).last_block : null;
  const hb = () => JSON.parse(M.store['tla-flows/events/heartbeat.json']);
  process.env.TLA_START_HEIGHT = String(BASE - 5); process.env.MAX_BLOCKS_PER_RUN = '4000';
  await quiet(() => cron.run());   // a first run over five empty blocks: the cursor exists from here on
  check('bootstrap over empty blocks: cursor set, no change filed', cursor() === BASE - 1 && months().length === 0, { cursor: cursor() });
  // then the chain grows; the stream's publish fails → nothing of it lands and the cursor is held
  M.head = HEAD; M.failAdminPut = 99; await quiet(() => cron.run());
  check('a failed publish of the stream holds the cursor (the window is walked again) and leaves no partial month', cursor() === BASE - 1 && months().length === 0 && hb().status !== 'ok', { cursor: cursor(), months: months(), status: hb().status });
  M.failAdminPut = 0; await quiet(() => cron.run());
  const all = changes(); const want = order.reduce((n, k) => n + cls(k).length, 0);
  check(`the walk kept exactly the classifier's records (${want}) across ${months().length} month files, and nothing for the unwatched noise`, all.length === want && want === 13 && !all.some(r => /zzzz/.test(r.contract || '')), { got: all.length, want });
  check('each month file is an array sorted by height then key, keys unique, every record schemaVersion 1 with txhash / height / timestamp / kind / action / signer', months().every(k => { const a = JSON.parse(M.store[k]); return Array.isArray(a) && a.every((r, i) => r.schemaVersion === 1 && r.k && r.txhash && r.height && r.timestamp && r.kind && r.action && 'signer' in r && (i === 0 || a[i - 1].height < r.height || (a[i - 1].height === r.height && a[i - 1].k < r.k))); }) && new Set(all.map(r => r.k)).size === all.length);
  check('kinds on the chain: list 1 · upgrade 1 · admin 1 · governance 4 · epoch 5 · setting 1', (() => { const k = all.reduce((o, r) => { o[r.kind] = (o[r.kind] || 0) + 1; return o; }, {}); return Object.keys(k).length === 6 && k.list === 1 && k.upgrade === 1 && k.admin === 1 && k.governance === 4 && k.epoch === 5 && k.setting === 1; })(), all.reduce((o, r) => { o[r.kind] = (o[r.kind] || 0) + 1; return o; }, {}));
  { const rm = all.find(r => r.action === 'asset/remove_assets'); check('the list change as the walk filed it: proposal 117 of the PD DAO, the two assets, a wallet as signer', rm && rm.via && rm.via.proposal_id === '117' && rm.via.dao === PD && /uLP$/.test(rm.detail.assets) && isWallet(rm.signer), rm); }
  { const idx = JSON.parse(M.store['contract-watch/index.json'] || 'null'); const ok = idx && months().every(k => { const mk = k.slice('contract-watch/events/'.length, -5), a = JSON.parse(M.store[k]), e = idx.months[mk]; return e && e.n === a.length && e.changes === a.filter(r => !r.routine).length && e.first === a[0].timestamp && e.last === a[a.length - 1].timestamp; });
    check(`contract-watch/index.json lists every month of the stream with its record and change counts (${idx ? Object.keys(idx.months).length : 0} months)`, !!ok && Object.keys(idx.months).length === months().length && Object.keys(idx.months).join() === Object.keys(idx.months).sort().join(), idx); }
  check('flows are captured as before (the zap deposit is in tla-flows/events, the claim too) and are not in the changes stream', flows().length === 2 && flows().some(f => f.type === 'deposit') && flows().some(f => f.type === 'claim'), flows().map(f => f.type));
  check('the cursor advanced to the head and the heartbeat counts the changes and the watched set', cursor() === HEAD && hb().counts.contract_changes === want && hb().counts.contracts_watched === watch.size && /^org-tla-flows-3\.7\./.test(hb().version), { cursor: cursor(), counts: hb().counts, v: hb().version });
  { const before = JSON.stringify(months().map(k => M.store[k])); const cur = JSON.parse(M.store['tla-flows/events/cursor.json']); cur.last_block = BASE - 1; M.store['tla-flows/events/cursor.json'] = JSON.stringify(cur); M.puts = []; await quiet(() => cron.run());   // walk the same window again
    check('walking the same window again adds nothing and rewrites no month of the stream', JSON.stringify(months().map(k => M.store[k])) === before && !M.puts.some(p => /^contract-watch\//.test(p)) && hb().counts.contract_changes === 0, M.puts.filter(p => /^contract-watch\//.test(p))); }

  console.log('— R the catch-up walk (contract-watch/rewalk.json) —');
  { const RW = 'contract-watch/rewalk.json'; const job = () => JSON.parse(M.store[RW]).jobs[0]; const step = async () => { M.head++; await quiet(() => cron.run()); };
    const flowsBefore = JSON.stringify(flows()); const base = changes().length;
    await step(); check('no rewalk.json → nothing walked again, the heartbeat says so (contract_catch_up null)', hb().counts.contract_catch_up === null && changes().length === base, hb().counts.contract_catch_up);
    M.store[RW] = JSON.stringify({ schemaVersion: 1, jobs: [{ id: 'gate', from: OLD, to: OLD_END }] }); process.env.ADMIN_REWALK_BLOCKS = '20';
    await step(); const j1 = job(), n1 = changes().length - base;
    check('a job of 33 blocks at 20 a run: the first run walks 20, files what those blocks hold and writes its progress', j1.next === OLD + 20 && j1.walked === 20 && !j1.done && n1 > 0 && n1 < 13 && j1.found === n1 && hb().counts.contract_catch_up.walked === 20 && hb().counts.contract_catch_up.done === false, { job: j1, n1 });
    await step(); const j2 = job(), n2 = changes().length - base;
    check('the second run finishes the span: done, all 13 changes of that stretch filed under their own keys', j2.done === true && j2.next === OLD_END + 1 && j2.walked === OLD_END - OLD + 1 && n2 === 13 && j2.found === 13 && !!j2.finished_at, { job: j2, n2 });
    check('the job records the first and the last block it walked, each with its time (a page shows dates, not block numbers)', j1.first_walked && j1.first_walked.height === OLD && /^\d{4}-\d\d-\d\dT/.test(j1.first_walked.time) && j1.last_walked.height === OLD + 19 && j2.first_walked.height === OLD && j2.last_walked.height === OLD_END && /^\d{4}-\d\d-\d\dT/.test(j2.last_walked.time), { j1: [j1.first_walked, j1.last_walked], j2: [j2.first_walked, j2.last_walked] });
    check('the catch-up walk files contract changes only — the flows of those blocks are not filed again', JSON.stringify(flows()) === flowsBefore);
    await step(); check('every job done → idle; nothing is written', hb().counts.contract_catch_up && hb().counts.contract_catch_up.idle === true && changes().length === base + 13, hb().counts.contract_catch_up);
    const all2 = changes().length; M.store[RW] = JSON.stringify({ schemaVersion: 1, jobs: [{ id: 'again', from: OLD, to: OLD_END }] }); process.env.ADMIN_REWALK_BLOCKS = '4000';
    await step(); check('walking a span that is already filed adds nothing (keyed merge) and still completes', changes().length === all2 && job().done === true && job().found === 0, job());
    M.store[RW] = JSON.stringify({ schemaVersion: 1, jobs: [{ id: 'fail', from: OLD, to: OLD_END }] }); for (const k of months()) delete M.store[k]; M.failAdminPut = 99;
    await step(); check('a failed publish: progress is NOT advanced and the run reports the error', job().next === undefined && !job().done && hb().counts.contract_catch_up.error === 'publish failed' && hb().counts.contract_catch_up.walked === 0, { job: job(), hb: hb().counts.contract_catch_up });
    M.failAdminPut = 0; await step(); check('…and the next run files the stretch and finishes it', job().done === true && changes().filter(r => r.height < BASE - 5).length === 13, { job: job(), n: changes().filter(r => r.height < BASE - 5).length });
    M.store[RW] = JSON.stringify({ schemaVersion: 1, jobs: [{ id: 'pruned', from: OLD - 500, to: OLD_END }] }); M.prunedBelow = OLD - 100;
    await step(); check('a span that starts below what the nodes still hold: the pruned stretch is jumped and recorded, the rest walked — the first block walked is the first one the nodes hold', job().done === true && job().pruned_to === OLD - 101 && job().first_walked.height === OLD - 100, job()); M.prunedBelow = 0;
    // 3.7.1 — what a node does with a block it no longer holds
    M.store[RW] = JSON.stringify({ schemaVersion: 1, jobs: [{ id: 'empty', from: OLD - 500, to: OLD_END }] }); M.nullBelow = OLD - 60;
    await step(); check('a node that answers a block it no longer holds with an EMPTY result (no error): the stretch is jumped and recorded like a pruned one, the rest walked', job().done === true && job().pruned_to === OLD - 61 && job().first_walked.height === OLD - 60 && hb().counts.contract_catch_up.error === null, { job: job(), hb: hb().counts.contract_catch_up }); M.nullBelow = 0;
    M.store[RW] = JSON.stringify({ schemaVersion: 1, jobs: [{ id: 'one-node', from: OLD, to: OLD_END }] }); M.nullAt = OLD + 4;   // the first endpoint has no such block, the other does
    for (const k of months()) delete M.store[k]; await step(); check('an empty answer from one endpoint is asked again at the other: the block is walked, nothing is jumped', job().done === true && job().pruned_to === undefined && changes().filter(r => r.height < BASE - 5).length === 13, { job: job(), n: changes().filter(r => r.height < BASE - 5).length }); M.nullAt = null;
    M.store[RW] = JSON.stringify({ schemaVersion: 1, jobs: [{ id: 'no-results', from: OLD, to: OLD_END }] }); M.noResultsBelow = OLD + 5; for (const k of months()) delete M.store[k];
    await step(); check('old blocks whose RESULTS the nodes no longer hold are not held: jumped and recorded, the blocks after them walked', job().done === true && job().pruned_to === OLD + 4 && changes().filter(r => r.height < BASE - 5).length > 0 && changes().filter(r => r.height < BASE - 5).every(r => r.height >= OLD + 5), { job: job(), heights: changes().filter(r => r.height < BASE - 5).map(r => r.height).slice(0, 4) }); M.noResultsBelow = 0;
    M.store[RW] = JSON.stringify({ schemaVersion: 1, jobs: [{ id: 'short', from: OLD, to: OLD_END }] }); M.shortResults = OLD + 8;
    await step(); check('results that do not match a block\'s transactions stop the walk with the block named — nothing is skipped silently, progress is not advanced', !job().done && job().next === undefined && /block_results \d+: 0 result\(s\) for 1 transaction/.test(hb().counts.contract_catch_up.error), { job: job(), hb: hb().counts.contract_catch_up }); M.shortResults = null;
    { const cur = JSON.parse(M.store['tla-flows/events/cursor.json']); const c0 = cur.last_block; M.nullAt = M.head + 1; M.nullOn = 'https://'; process.env.ADMIN_REWALK = '0'; await step();   // every endpoint answers the head block with an empty result
      check('the forward walk never calls a block at the head pruned on an empty answer: the run stops with the block named, records no gap, and walks the window again', cursor() === c0 && !(hb().known_gaps || []).some(g => g.from_height >= c0) && hb().status !== 'ok' && /returned no block/.test(JSON.stringify(hb().recent_errors)), { cursor: cursor(), c0, hb: hb().recent_errors }); M.nullAt = null; M.nullOn = null; await step(); delete process.env.ADMIN_REWALK; }
    process.env.ADMIN_REWALK = '0'; M.store[RW] = JSON.stringify({ schemaVersion: 1, jobs: [{ id: 'off', from: OLD, to: OLD_END }] }); await step(); check('ADMIN_REWALK=0 switches it off', hb().counts.contract_catch_up === null && job().next === undefined); delete process.env.ADMIN_REWALK; }

  console.log(`— S the state read (${CS.VERSION}) —`);
  { const legacy = JSON.parse(fs.readFileSync(path.join(SRC, 'docs/archive/legacy-registry/tla-chain-registry-2026-08-11.json'), 'utf8'));
    const BOOK = legacy.raw.global_config_all_addresses, seen = JSON.parse(fs.readFileSync(path.join(SRC, 'docs/deep-history/contracts-seen.json'), 'utf8')).contracts;
    const pb = CS.parseAddressBook(BOOK);
    check(`the address book as the chain answered it on 2026-08-11 parses: ${pb.ok ? Object.keys(pb.entries).length : 0} roles, the four staking contracts are the config's, six controller roles point at the PD DAO`, pb.ok && Object.keys(pb.entries).length === 20 && ['stable', 'project', 'bluechip', 'single'].every(b => pb.entries['ASSET_STAKING__' + b] === C.STAKING_BUCKETS[b]) && pb.entries.ASSET_GAUGE === C.GAUGE_CONTROLLER.addr && Object.values(pb.entries).filter(a => a === PD).length === 6 && pb.entries.ASSET_WHITELIST_CONTROLLER === PD && legacy.contracts.global_config === C.GLOBAL_CONFIG.addr, pb.ok ? Object.keys(pb.entries) : pb);
    check('an answer of another shape is refused, never compared: an object, an empty list, a triple, a role twice, a value that is no address', [{ a: 1 }, [], [['A', PD, 'x']], [['A', PD], ['A', PD]], [['A', 'not-an-address']], null].every(x => CS.parseAddressBook(x).ok === false));
    check('contract info: code id as text, an empty admin is no admin, an answer without contract_info is nothing', JSON.stringify(CS.parseContractInfo({ contract_info: { code_id: '3494', creator: PD, admin: '', label: 'x' } })) === JSON.stringify({ code_id: '3494', admin: null, creator: PD, label: 'x' }) && CS.parseContractInfo({}) === null && CS.parseContractInfo({ contract_info: { code_id: 'abc' } }) === null);
    // the stand-in LCD answers from the stored inventory (2026-09-29) and the stored address book
    const inSeen = [...watch].filter(a => seen[a] && seen[a].code_id); const missing = [...watch].filter(a => !(seen[a] && seen[a].code_id));
    for (const a of inSeen) M.lcd.info[a] = { code_id: String(seen[a].code_id), admin: seen[a].admin || null, creator: seen[a].creator || null, label: seen[a].label || null };
    M.lcd.book = BOOK.map(p => p.slice());
    const ST = 'contract-watch/state/current.json'; const state = () => JSON.parse(M.store[ST]); const obs = () => changes().filter(r => r.observed === 'state-read');
    let clock = Date.parse('2026-11-25T05:00:00Z'); cron.T.now = () => new Date(clock); const tick = async (hours) => { clock += hours * 3.6e6; M.head++; M.puts = []; await quiet(() => cron.run()); };
    delete process.env.ADMIN_STATE; const monthsBefore = JSON.stringify(months().map(k => M.store[k]));
    await tick(0); const s1 = state();
    check(`first read: every watched contract the inventory knows is read (${inSeen.length} of ${watch.size}; ${missing.length} the stand-in node does not have are listed as not read), the address book too, and NOTHING is filed — a first sighting is not a change`, Object.keys(s1.contracts).length === inSeen.length && s1.counts.read_this_time === inSeen.length && s1.counts.not_read_this_time === missing.length && Object.keys(s1.address_book.entries).length === 20 && s1.address_book.contract === C.GLOBAL_CONFIG.addr && obs().length === 0 && JSON.stringify(months().map(k => M.store[k])) === monthsBefore && hb().counts.contract_state.read === true && hb().counts.contract_state.differences === 0, { n: Object.keys(s1.contracts).length, counts: s1.counts, hb: hb().counts.contract_state });
    check('…each entry is the chain\'s own report and carries the time of its read', (() => { const a = C.STAKING_BUCKETS.single, e = s1.contracts[a]; return e && e.code_id === String(seen[a].code_id) && e.admin === (seen[a].admin || null) && e.creator === seen[a].creator && e.capturedAt === s1.capturedAt && s1.height === M.head; })(), s1.contracts[C.STAKING_BUCKETS.single]);
    const calls = M.lcd.calls; await tick(3);
    check('three hours later: not due — the chain is not read, nothing is written', M.lcd.calls === calls && hb().counts.contract_state.skipped === 'not due' && !M.puts.some(p => /^contract-watch\//.test(p)) && state().capturedAt === s1.capturedAt, hb().counts.contract_state);
    // the chain changes: a controller role moves from the DAO to a wallet, one contract gets a new admin, another new code
    const WALLET = pb.entries.PDT_CONFIG_OWNER, A1 = C.STAKING_BUCKETS.stable, A2 = C.ZAPPER.addr, oldAdmin = M.lcd.info[A1].admin, oldCode = M.lcd.info[A2].code_id;
    M.lcd.book.find(p => p[0] === 'ASSET_WHITELIST_CONTROLLER')[1] = WALLET; M.lcd.info[A1].admin = WALLET; M.lcd.info[A2].code_id = String(Number(oldCode) + 7);
    M.failStatePut = 1; await tick(22);   // the differences are filed, then the state write fails
    const o1 = obs();
    check('a day later the read finds three differences and files them — the role with before (the PD DAO) and after (a wallet), the admin, the code id — each marked observed, with no transaction and no signer, and the window between the two reads', o1.length === 3 && o1.every(r => r.observed === 'state-read' && r.txhash === null && r.signer === null && r.via === null && r.detail.seen_after === s1.capturedAt && r.detail.seen_by === r.timestamp && /^state:[0-9a-f]{20}$/.test(r.k)) &&
      (() => { const role = o1.find(r => r.kind === 'role'), adm = o1.find(r => r.kind === 'admin'), up = o1.find(r => r.kind === 'upgrade'); return role && role.contract === C.GLOBAL_CONFIG.addr && role.action === 'address_book' && role.detail.role === 'ASSET_WHITELIST_CONTROLLER' && role.detail.before === PD && role.detail.after === WALLET && adm && adm.contract === A1 && adm.detail.before === oldAdmin && adm.detail.after === WALLET && up && up.contract === A2 && up.detail.before === oldCode && up.detail.after === String(Number(oldCode) + 7); })(), o1.map(r => [r.kind, r.action, r.detail]));
    check('…the state write failed, so the state on file is still the first read and the run says so', state().capturedAt === s1.capturedAt && hb().counts.contract_state.state_written === false && hb().error_count > 0, hb().counts.contract_state);
    await tick(0.25); const o2 = obs();
    check('the next run reads again, files nothing twice (the keys do not depend on the time of the read) and writes the state', o2.length === 3 && JSON.stringify(o2.map(r => r.k).sort()) === JSON.stringify(o1.map(r => r.k).sort()) && state().capturedAt !== s1.capturedAt && state().address_book.entries.ASSET_WHITELIST_CONTROLLER === WALLET && state().contracts[A1].admin === WALLET && hb().counts.contract_state.differences === 3, { n: o2.length, hb: hb().counts.contract_state });
    { const idx = JSON.parse(M.store['contract-watch/index.json']); check('the differences are in the month of their read and the index counts them', idx.months['2026/11'] && idx.months['2026/11'].n === o2.length && idx.months['2026/11'].changes === 3, idx.months['2026/11']); }
    // a node that answers nothing
    const sBefore = M.store[ST]; M.lcd.down = true; await tick(30);
    check('a node that answers nothing: nothing is filed, the state on file is untouched, the heartbeat reports it', obs().length === 3 && M.store[ST] === sBefore && hb().counts.contract_state.read === false && hb().error_count > 0, hb().counts.contract_state);
    // one contract unreadable: its entry (and its read time) is kept, no difference invented
    M.lcd.down = false; const gone = M.lcd.info[A2]; delete M.lcd.info[A2]; const a2Before = state().contracts[A2]; await tick(0.25);
    check('one contract the node cannot answer for: its entry is kept with its own earlier read time, and nothing is filed about it', obs().length === 3 && JSON.stringify(state().contracts[A2]) === JSON.stringify(a2Before) && state().contracts[A2].capturedAt !== state().capturedAt && state().counts.not_read_this_time === missing.length + 1, state().counts);
    M.lcd.info[A2] = gone;
    // a change filed by the walk triggers a read in the same run
    const cfg = raw(...R.config); const H2 = M.head + 1; CHAIN.set(H2, [{ b64: Buffer.from('again' + cfg.x).toString('base64'), code: 0, events: cfg.e, ts: '2026-11-26T12:00:00Z' }]);
    M.lcd.info[A2].code_id = String(Number(M.lcd.info[A2].code_id) + 1); const c3 = M.lcd.calls; await tick(1);
    check('a change the walk files (a settings change on a watched contract) makes the same run read the chain, though a day has not passed — and the read finds the new code id', M.lcd.calls > c3 && hb().counts.contract_changes === 1 && hb().counts.contract_state.by === 'change' && obs().length === 4 && obs().some(r => r.kind === 'upgrade' && r.contract === A2 && r.detail.after === M.lcd.info[A2].code_id), hb().counts.contract_state);
    // the pure compare: carried-over entries and first sightings file nothing; a later repeat of the same transition has its own key
    const prev = { address_book: { contract: 'c', capturedAt: 't1', entries: { R: PD } }, contracts: { x: { code_id: '1', admin: null, capturedAt: 't1' }, y: { code_id: '5', admin: PD, capturedAt: 't1' } } };
    const cur = { address_book: { contract: 'c', capturedAt: 't2', entries: { R: WALLET, NEW: PD } }, contracts: { x: { code_id: '1', admin: null, capturedAt: 't1' }, y: { code_id: '6', admin: null, capturedAt: 't2' }, z: { code_id: '9', admin: null, capturedAt: 't2' } } };
    const d = CS.diffState(prev, cur, { height: 7 });
    check('the compare alone: a role that moved and a role that is new, a code id, an admin that was cleared — four records; the entry carried over from a failed read and the contract seen for the first time file nothing', d.length === 4 && d.filter(r => r.kind === 'role').length === 2 && d.some(r => r.detail.role === 'NEW' && r.detail.before === null && r.detail.after === PD) && d.some(r => r.kind === 'upgrade' && r.contract === 'y') && d.some(r => r.kind === 'admin' && r.contract === 'y' && r.detail.after === null) && !d.some(r => r.contract === 'x' || r.contract === 'z') && d.every(r => r.height === 7), d.map(r => [r.kind, r.contract, r.detail]));
    const again = CS.diffState({ ...prev, address_book: { ...prev.address_book, capturedAt: 't9' } }, { ...cur, address_book: { ...cur.address_book, capturedAt: 't10' } }, {});
    check('the same transition seen from a later read has another key (it is another event); seen again from the same read it has the same key', again.find(r => r.detail.role === 'R').k !== d.find(r => r.detail.role === 'R').k && CS.diffState(prev, { ...cur, address_book: { ...cur.address_book, capturedAt: 't3' } }, {}).find(r => r.detail.role === 'R').k === d.find(r => r.detail.role === 'R').k);
    process.env.ADMIN_STATE = '0'; const c4 = M.lcd.calls; await tick(48); check('ADMIN_STATE=0 switches it off', M.lcd.calls === c4 && hb().counts.contract_state === null); }

  if (process.env.FULL === '1') {
    console.log('— D the whole stored corpus (FCD archive + archive walk) —');
    const { recs, transactions } = BF.derive(SRC);
    const list = recs.filter(r => r.action === 'asset/whitelist_assets' || r.action === 'asset/remove_assets');
    const ids = [...new Set(list.filter(r => r.via).map(r => Number(r.via.proposal_id)))].sort((a, b) => a - b);
    check(`${transactions.toLocaleString('en-US')} transactions → ${recs.length} records; ${list.length} reward-list changes, EVERY one a PD proposal being executed (${ids.length} proposals), none sent directly`, list.length >= 47 && list.every(r => r.via && r.via.kind === 'dao_proposal' && r.via.dao === PD) && ids.length >= 27 && [2, 3, 7, 10, 22, 23, 25, 55, 117, 236].every(i => ids.includes(i)), { list: list.length, ids });
    check('every upgrade and admin change in it was sent directly by a wallet, except the sub-DAO adoption', recs.filter(r => r.kind === 'upgrade').every(r => r.via === null && isWallet(r.signer)) && recs.filter(r => r.kind === 'admin' && r.via).length === 1, recs.filter(r => r.kind === 'admin' && r.via).length);
    check('keys are unique across the corpus (the two sources overlap; a transaction is taken once)', new Set(recs.map(r => r.k)).size === recs.length);
  } else console.log('  (FULL=1 not set — the whole-corpus check D skipped)');
  console.log(`\n=== MOCK GATE (contract-watch): ${pass} passed, ${fail} failed ===`); process.exit(fail ? 1 : 0);
})().catch(e => { console.error('GATE CRASH', e); process.exit(1); });
