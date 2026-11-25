'use strict';
/**
 * tla-flows / backfill-contract-watch.js 1.1.0 (2026-11-25) — the contract-watch HISTORY, derived from the walks already
 * stored in a tla-core checkout. No chain access: it re-reads transactions the capture kept and applies
 * lib/admin-classifier.js (the same classifier the forward walk uses) to them.
 *
 * Sources
 *   archive/fcd/<label>/part-*.json.gz          { txs: [{ txhash, height, timestamp, code, messages, events }] }
 *        TLA's first months (contract genesis 2024-08 → 2025-01-07). FCD kept only wasm events, so the message
 *        boundaries and the lifecycle events (migrate, admin change) are rebuilt from each tx's `messages`.
 *   tla-flows/raw/<from>-<to>/part-*.json.gz    [{ h, x, t, c, e }]  — block_results events as the archive walk saw them
 *        (2025-01-07 → 2026-06-16, the public nodes' retention floor when forward capture began).
 * Both hold only transactions that touched a contract of the capture registry, so this history is complete for THOSE
 * contracts and says nothing about others. The forward walk records upgrades and admin changes for every contract.
 *
 * Output: <outDir>/contract-watch/events/<YYYY>/<MM>.json (arrays, sorted by height then key; the forward stream's
 * shape), <outDir>/contract-watch/index.json (the months and what each holds) and <outDir>/contract-watch/backfill-report.json. Merges into month files already in the checkout — a record
 * the forward walk already filed is kept, never duplicated (k = txhash:n).
 *
 * Usage: TLA_CORE_DIR=<tla-core checkout> node backfill-contract-watch.js <outDir>
 */
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const AD = require('./lib/admin-classifier.js'), AX = require('./lib/aux-classifiers.js');
const VERSION = 'backfill-contract-watch-1.1.0';   // 1.1.0: writes contract-watch/index.json (the months of the stream) with the months
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const readGz = (p) => JSON.parse(zlib.gunzipSync(fs.readFileSync(p)).toString('utf8'));
const listParts = (dir) => fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /\.json\.gz$/.test(f)).sort().map(f => path.join(dir, f)) : [];

// FCD → the walk's shape. FCD's events are the wasm events only, each tagged with the index of its message.
function fcdToTxr(tx) {
  const ev = [];
  const msgs = Array.isArray(tx.messages) ? tx.messages : [];
  const byMsg = new Map(); for (const e of tx.events || []) { const i = Number(e.msg_index || 0); (byMsg.get(i) || byMsg.set(i, []).get(i)).push(e); }
  const n = Math.max(msgs.length, byMsg.size ? Math.max(...byMsg.keys()) + 1 : 0);
  for (let i = 0; i < n; i++) {
    const m = msgs[i] || {}; const type = m['@type'] || null, sender = m.sender || m.grantee || null;
    if (type) ev.push({ type: 'message', attributes: [{ key: 'action', value: type }, { key: 'sender', value: sender }] });
    if (/MsgMigrateContract$/.test(type || '') && m.contract) ev.push({ type: 'migrate', attributes: [...(m.code_id != null ? [{ key: 'code_id', value: String(m.code_id) }] : []), { key: '_contract_address', value: m.contract }] });   // the compacted archive kept no code id: the versions come from the contract's own report, the code id from the chain's contract history
    if (/MsgUpdateAdmin$/.test(type || '') && m.contract) ev.push({ type: 'update_contract_admin', attributes: [{ key: '_contract_address', value: m.contract }, { key: 'new_admin_address', value: m.new_admin || '' }] });
    if (/MsgClearAdmin$/.test(type || '') && m.contract) ev.push({ type: 'update_contract_admin', attributes: [{ key: '_contract_address', value: m.contract }, { key: 'new_admin_address', value: '' }] });
    for (const e of byMsg.get(i) || []) ev.push(e);
  }
  return { txhash: tx.txhash, height: Number(tx.height), timestamp: String(tx.timestamp).slice(0, 19) + 'Z', code: tx.code || 0, events: ev };
}
const rawToTxr = (r) => ({ txhash: r.x, height: Number(r.h), timestamp: String(r.t).slice(0, 19) + 'Z', code: r.c || 0, events: r.e || [] });
const monthKey = (ts) => `${ts.slice(0, 4)}/${ts.slice(5, 7)}`;

// every change the stored walks of a checkout hold → { recs (sorted), stats, watch }
function derive(SRC, { only } = {}) {   // only: optional (relativePath) => boolean, to read a part of the corpus (the gate)
  const watch = AD.adminWatchFrom({
    config: require('../config/contracts.js'),
    known: fs.existsSync(path.join(SRC, 'docs/curated/known_contracts.json')) ? readJson(path.join(SRC, 'docs/curated/known_contracts.json')) : null,
    registry: fs.existsSync(path.join(SRC, 'tla-voting/capture-registry.json')) ? readJson(path.join(SRC, 'tla-voting/capture-registry.json')) : null,
    extra: fs.existsSync(path.join(SRC, 'docs/curated/contract-watch.json')) ? readJson(path.join(SRC, 'docs/curated/contract-watch.json')) : null,
  });
  const byKey = new Map(); const seenTx = new Set(); const stats = { watch: watch.size, fcd_parts: 0, fcd_txs: 0, raw_parts: 0, raw_txs: 0, unreadable: [] };
  const take = (txr) => { if (seenTx.has(txr.txhash)) return; seenTx.add(txr.txhash); for (const rec of AD.classifyAdminTx(txr, watch)) byKey.set(rec.k, rec); };
  const fcdRoot = path.join(SRC, 'archive/fcd');
  for (const label of fs.existsSync(fcdRoot) ? fs.readdirSync(fcdRoot).filter(d => fs.statSync(path.join(fcdRoot, d)).isDirectory()).sort() : []) {
    for (const f of listParts(path.join(fcdRoot, label))) {
      if (only && !only(path.relative(SRC, f))) continue;
      let d; try { d = readGz(f); } catch (e) { stats.unreadable.push(path.relative(SRC, f)); continue; }
      stats.fcd_parts++; for (const tx of d.txs || []) { stats.fcd_txs++; take(fcdToTxr(tx)); }
    }
  }
  const rawRoot = path.join(SRC, 'tla-flows/raw');
  for (const dir of fs.existsSync(rawRoot) ? fs.readdirSync(rawRoot).filter(d => /^\d+-\d+$/.test(d)).sort((a, b) => Number(a.split('-')[0]) - Number(b.split('-')[0])) : []) {
    for (const f of listParts(path.join(rawRoot, dir))) {
      if (only && !only(path.relative(SRC, f))) continue;
      let d; try { d = readGz(f); } catch (e) { stats.unreadable.push(path.relative(SRC, f)); continue; }
      stats.raw_parts++; for (const r of d) { stats.raw_txs++; take(rawToTxr(r)); }
    }
  }
  const recs = [...byKey.values()].sort((a, b) => a.height - b.height || (a.k < b.k ? -1 : 1));
  return { recs, stats, watch, transactions: seenTx.size };
}

function main(SRC, OUT) {
  const { recs, stats, transactions } = derive(SRC);
  const byM = {}; for (const r of recs) (byM[monthKey(r.timestamp)] ||= []).push(r);
  let written = 0, kept = 0;
  const idxOnDisk = path.join(SRC, 'contract-watch/index.json');
  const idx = fs.existsSync(idxOnDisk) ? readJson(idxOnDisk) : { schemaVersion: 1, product: 'contract-watch/index', note: 'The months of contract-watch/events and what each holds (n = records, changes = records that are not the weekly routine). Written by org-tla-flows whenever a month changes.' };
  idx.months = idx.months || {};
  for (const mk of Object.keys(byM).sort()) {
    const rel = `contract-watch/events/${mk}.json`, onDisk = path.join(SRC, rel);
    const existing = fs.existsSync(onDisk) ? readJson(onDisk) : [];
    const m = AX.mergeKeyed(existing, byM[mk]); kept += existing.length;
    const out = path.join(OUT, rel); fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(m.merged)); written++;
    idx.months[mk] = AD.monthSummary(m.merged);
  }
  idx.months = Object.fromEntries(Object.keys(idx.months).sort().map(k => [k, idx.months[k]])); idx.updated_at = new Date().toISOString(); idx.builder = VERSION;
  fs.mkdirSync(path.join(OUT, 'contract-watch'), { recursive: true }); fs.writeFileSync(path.join(OUT, 'contract-watch/index.json'), JSON.stringify(idx, null, 2));
  const count = (f) => recs.reduce((o, r) => { const k = f(r); o[k] = (o[k] || 0) + 1; return o; }, {});
  const report = { schemaVersion: 1, product: 'contract-watch/backfill-report', builder: VERSION, classifier: AD.VERSION, builtAt: new Date().toISOString(),
    sources: { fcd_archive: { parts: stats.fcd_parts, txs: stats.fcd_txs, covers: 'contract genesis (2024-08) → 2025-01-07' }, archive_walk: { parts: stats.raw_parts, txs: stats.raw_txs, covers: '2025-01-07 → 2026-06-16' }, unreadable_parts: stats.unreadable },
    transactions_read: transactions, watched_contracts: stats.watch, records: recs.length, months_written: written, records_already_on_file: kept,
    first: recs[0] ? { height: recs[0].height, day: recs[0].timestamp.slice(0, 10) } : null, last: recs.length ? { height: recs[recs.length - 1].height, day: recs[recs.length - 1].timestamp.slice(0, 10) } : null,
    by_kind: count(r => r.kind), by_action: count(r => r.action), by_how: count(r => r.via ? r.via.kind : 'sent directly'),
    scope: 'Complete for the contracts of the capture registry over the two spans; nothing about other contracts. FCD kept no chain events, so its upgrades and admin changes are rebuilt from the transaction messages.' };
  fs.mkdirSync(path.join(OUT, 'contract-watch'), { recursive: true }); fs.writeFileSync(path.join(OUT, 'contract-watch/backfill-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ transactions_read: report.transactions_read, records: report.records, months: written, by_kind: report.by_kind, by_how: report.by_how, unreadable: stats.unreadable.length }, null, 1));
}

if (require.main === module) {
  const SRC = process.env.TLA_CORE_DIR, OUT = process.argv[2];
  if (!SRC || !OUT) { console.error('usage: TLA_CORE_DIR=<checkout> node backfill-contract-watch.js <outDir>'); process.exit(1); }
  main(SRC, OUT);
}
module.exports = { VERSION, derive, fcdToTxr, rawToTxr, monthKey };
