'use strict';
// mock-run-pnl.js — BINDING gate for the folded P&L duty (tla-flows 3.4.0, pnl.js).
//   R1 DIFFERENTIAL: buildPnl over a tla-core checkout produces EXACTLY the files the retired build-pnl.js Action wrote
//      (rollup.json, heartbeat.json, ledger/index.json, every ledger/<wallet>.json) — byte-identical after stripping
//      builtAt (+ the builder label, + the wallet docs' dropped builtAt). Requires the old script for the control run.
//   R2 weekly gate: skipped inside the built epoch · skipped before Mon 03:30 of a new epoch · runs at/after 03:30 ·
//      PNL=force runs · PNL=0 skips
//   R3 write-only-changed: with main already holding this exact build (blob shas), a run writes only heartbeat +
//      ledger/index.json + rollup.json (the three that carry builtAt) and 0 wallet files; with one wallet drifted
//      on main, exactly that wallet is rewritten too
//   R4 fatal throws (PnlFatal), never exits
// Usage: TLA_CORE_DIR=<checkout> OLD_SCRIPT=<path to build-pnl.js> node --max-old-space-size=200 mock-run-pnl.js
// 1.1.1 (2026-09-15): RUN WITH THE HEAP CAP — Render's instance has ~256 MB. 1.1.0 held every event month (273 MB) and
// died there on every run from Mon 2026-09-14 03:30 (the epoch-203 rollup never built); 1.1.1 folds a month at a time
// (peak ~90 MB on the same months) and its 769 output files are byte-identical to 1.1.0 minus builtAt/builder.
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto'), { spawnSync } = require('child_process');
const SRC = process.env.TLA_CORE_DIR, OLD = process.env.OLD_SCRIPT; if (!SRC) { console.error('TLA_CORE_DIR required'); process.exit(1); }
const P = require('./pnl.js'); let pass = 0, fail = 0; const check = (n, ok, x) => { if (ok) { pass++; console.log('  ✅ ' + n); } else { fail++; console.log('  ❌ ' + n + (x != null ? ' — ' + JSON.stringify(x).slice(0, 300) : '')); } };
const NOW = new Date('2026-09-14T03:31:00Z');
const localSrc = {
  readJson: async (p) => JSON.parse(fs.readFileSync(path.join(SRC, p), 'utf8')),
  priceMonths: async () => { const ms = []; for (const y of fs.readdirSync(path.join(SRC, 'price-history')).filter(d => /^\d{4}$/.test(d)).sort()) for (const f of fs.readdirSync(path.join(SRC, 'price-history', y)).filter(f => /^\d{2}\.json$/.test(f)).sort()) ms.push(`${y}/${f.slice(0, 2)}`); return ms; },
};
const strip = (o) => { if (Array.isArray(o)) return o.map(strip); if (o && typeof o === 'object') { const r = {}; for (const [k, v] of Object.entries(o)) if (k !== 'builtAt' && k !== 'builder') r[k] = strip(v); return r; } return o; };
const blobSha = (s) => crypto.createHash('sha1').update(`blob ${Buffer.byteLength(s)}\0`).update(s).digest('hex');
(async () => {
  console.log('— R1 differential vs the retired Action script —');
  const silence = console.log; console.log = () => {}; const built = await P.buildPnl(localSrc, { now: () => NOW }); console.log = silence;
  check('build returned rollup + heartbeat + ledger index + wallet files', built.files.has('tla-flows/pnl/rollup.json') && built.files.has('tla-flows/pnl/heartbeat.json') && built.files.has('tla-flows/pnl/ledger/index.json') && built.files.size > 100, built.files.size);
  if (OLD && fs.existsSync(OLD)) {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'pnl-old-')); for (const d of ['tla-flows/events', 'price-history', 'token-catalog/snapshots', 'docs/curated']) fs.cpSync(path.join(SRC, d), path.join(ws, d), { recursive: true }); fs.copyFileSync(path.join(SRC, 'docs/epoch_1-300_date.json'), path.join(ws, 'docs/epoch_1-300_date.json'));
    const r = spawnSync('node', [OLD], { cwd: ws, env: { ...process.env, GITHUB_WORKSPACE: ws }, encoding: 'utf8' }); check('old script ran', r.status === 0, r.stderr.slice(-300));
    const oldFiles = []; (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); e.isDirectory() ? walk(p) : oldFiles.push(path.relative(ws, p)); } })(path.join(ws, 'tla-flows/pnl'));
    check(`same file set (${oldFiles.length})`, oldFiles.length === built.files.size && oldFiles.every(f => built.files.has(f)), { old: oldFiles.length, new: built.files.size });
    let same = 0, diff = []; for (const f of oldFiles) { if (!built.files.has(f)) continue; const a = strip(JSON.parse(fs.readFileSync(path.join(ws, f), 'utf8'))), b = strip(built.files.get(f)); if (JSON.stringify(a) === JSON.stringify(b)) same++; else diff.push(f); }
    check(`every file byte-identical minus builtAt/builder (${same}/${oldFiles.length})`, diff.length === 0, diff.slice(0, 3));
    check('wallet docs carry no builtAt; index + rollup do', ![...built.files].some(([p, o]) => /ledger\/terra1/.test(p) && 'builtAt' in o) && built.files.get('tla-flows/pnl/ledger/index.json').builtAt && built.files.get('tla-flows/pnl/rollup.json').builtAt);
    fs.rmSync(ws, { recursive: true, force: true });
  } else console.log('  (OLD_SCRIPT not given — differential control skipped)');
  console.log('— R2 weekly gate —');
  const mkDeps = (hbBuiltAt, main, writes) => ({ fetchJson: async (u) => { const p = u.replace(/^.*?\/main\//, '').split('?')[0]; if (p === 'tla-flows/pnl/heartbeat.json') { if (!hbBuiltAt) throw new Error('HTTP 404'); return { builtAt: hbBuiltAt }; } if (p.startsWith('price-history/') && !fs.existsSync(path.join(SRC, p))) throw new Error('HTTP 404 ' + p); return JSON.parse(fs.readFileSync(path.join(SRC, p), 'utf8')); },
    listDir: async (dir) => main ? [...main].filter(([p]) => path.dirname(p) === dir).map(([p, sha]) => ({ path: p, sha })) : null,
    publishFile: async (p, content) => { writes.push(p); }, rawBase: 'https://raw.githubusercontent.com/x/y/main' });
  const gate = async (nowIso, hb, env = {}) => { const w = []; const c = console.log; console.log = () => {}; const r = await P.runPnlDuty({ ...mkDeps(hb, null, w), env, now: () => new Date(nowIso) }); console.log = c; return { r, w }; };
  { const { r, w } = await gate('2026-09-10T12:00:00Z', '2026-09-07T03:31:00Z'); check('inside built epoch → skipped, nothing written', r.status === 'skipped' && /already built/.test(r.reason) && w.length === 0, r); }
  { const { r } = await gate('2026-09-14T01:00:00Z', '2026-09-07T03:31:00Z'); check('new epoch but before Mon 03:30 → skipped', r.status === 'skipped' && /builds at Mon 03:30/.test(r.reason), r); }
  { const { r, w } = await gate('2026-09-14T03:31:00Z', '2026-09-07T03:31:00Z'); check('new epoch at 03:31 → runs (epoch 203), writes every file when main is empty', r.status === 'ok' && r.epoch === 203 && r.written === r.files && r.unchanged === 0, r); }
  { const { r } = await gate('2026-09-10T12:00:00Z', '2026-09-07T03:31:00Z', { PNL: 'force' }); check('PNL=force runs inside the built epoch', r.status === 'ok', r); }
  { const { r } = await gate('2026-09-14T03:31:00Z', null, { PNL: '0' }); check('PNL=0 skips', r.status === 'skipped' && r.reason === 'PNL=0', r); }
  console.log('— R3 write-only-changed —');
  { const c = console.log; console.log = () => {}; const prior = await P.buildPnl(localSrc, { now: () => new Date('2026-09-07T03:31:00Z') });   // last week's build is what sits on main
    const main = new Map([...prior.files].map(([p, o]) => [p, blobSha(P.serialize(o))])); const w = [];
    const r = await P.runPnlDuty({ ...mkDeps('2026-09-07T03:31:00Z', main, w), env: {}, now: () => NOW }); console.log = c;
    check('main holds this build → only the 3 builtAt-bearing files written, 0 wallets', r.written === 3 && w.every(p => /rollup\.json|heartbeat\.json|ledger\/index\.json$/.test(p)) && r.unchanged === built.files.size - 3, { written: w, unchanged: r.unchanged });
    const anyWallet = [...built.files.keys()].find(p => /ledger\/terra1/.test(p)); main.set(anyWallet, 'deadbeef'); const w2 = []; console.log = () => {};
    const r2 = await P.runPnlDuty({ ...mkDeps('2026-09-07T03:31:00Z', main, w2), env: {}, now: () => NOW }); console.log = c;
    check('one wallet drifted on main → exactly that wallet rewritten too', r2.written === 4 && w2.includes(anyWallet), w2.filter(p => /terra1/.test(p))); }
  console.log('— R4 fatal throws —');
  { let err = null; try { await P.buildPnl({ ...localSrc, readJson: async (p) => p === 'tla-flows/events/index.json' ? { months_present: {} } : localSrc.readJson(p) }, { now: () => NOW }); } catch (e) { err = e; } check('empty corpus → PnlFatal thrown', err instanceof P.PnlFatal && /no event month/.test(err.message), err && err.message); }
  console.log(`\n=== MOCK GATE (pnl): ${pass} passed, ${fail} failed ===`); process.exit(fail ? 1 : 0);
})().catch(e => { console.error('GATE CRASH', e); process.exit(1); });
