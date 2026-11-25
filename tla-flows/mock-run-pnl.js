'use strict';
// mock-run-pnl.js — BINDING gate for the folded P&L duty (tla-flows 3.4.0, pnl.js).
//   R1 DIFFERENTIAL: buildPnl over a tla-core checkout produces EXACTLY the files the retired build-pnl.js Action wrote
//      (rollup.json, heartbeat.json, ledger/index.json, every ledger/<wallet>.json) — byte-identical after stripping
//      builtAt (+ the builder label, + the wallet docs' dropped builtAt). Requires the old script for the control run.
//   R2 when it builds and which kind of publish: weekly (inside the built epoch · before Mon 03:30 · at 03:31 · PNL=force ·
//      PNL=0), daily, and 'events' (the default: new events with a minimum gap; the day's re-price at 03:30 UTC even when a
//      build was already made after midnight; an older builder's build is redone as a full publish)
//   R3 which wallet files a build writes (pnl 1.8.0): a later hourly read re-prices wallet files without moving any
//      signature → an 'events' build writes none of them (held), one whose signature moved or that is new on main is
//      written, a file identical to main never is; no signatures on main or the day's re-price → all of them. Plus the
//      signature on a real wallet file: prices never move it, events / moves / disputes / bribes do
//      (2026-11-25: R2 and R3 had been red since the cadence left weekly and v3 made a build depend on more inputs — the
//      old cases built at a 2026-09 `now` over a checkout with later prices, so nothing ever matched main)
//   R4 fatal throws (PnlFatal), never exits
// Usage: TLA_CORE_DIR=<checkout> OLD_SCRIPT=<path to build-pnl.js> node --max-old-space-size=400 mock-run-pnl.js
// 3.5.0 (2026-09-27): this gate holds several builds at once, so it runs at 400 MB; the ONE-build Render heap check (200 MB) is
// mock-run-pnl-v3.js V10. The R1 differential vs the retired Action no longer applies (v3 adds fields) — mock-run-pnl-v3.js V1
// is the Phase A/B differential now (BASE_PNL = the pre-v3 pnl.js).
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
  console.log('— R2 when it builds (weekly · daily · events) and which kind of publish —');
  // ONE real build serves every case: the duty stamps three bookkeeping objects (heartbeat, ledger index), so each case gets its own copy of those
  const copyOf = (b) => ({ ...b, files: new Map([...b.files].map(([p, o]) => [p, /ledger\/terra1/.test(p) ? o : JSON.parse(JSON.stringify(o))])) });
  const EV_TOTAL = JSON.parse(fs.readFileSync(path.join(SRC, 'tla-flows/events/index.json'), 'utf8')).total_events;
  const BUILDER = `${P.PNL_VERSION} (org-tla-flows daily duty)`;
  const hbOf = (builtAt, fullAt, total = EV_TOTAL, builder = BUILDER) => ({ builtAt, full_publish_at: fullAt, builder, events_index_total: total });
  const mkDeps = (hb, main, cap, opt = {}) => ({
    fetchJson: async (u) => { const p = u.replace(/^.*?\/main\//, '').split('?')[0];
      if (p === 'tla-flows/pnl/heartbeat.json') { if (!hb) throw new Error('HTTP 404'); return typeof hb === 'string' ? { builtAt: hb } : hb; }
      if (p === 'tla-flows/pnl/ledger/index.json') { if (!opt.ledgerIndex) throw new Error('HTTP 404'); return opt.ledgerIndex; }
      if (p.startsWith('price-history/') && !fs.existsSync(path.join(SRC, p))) throw new Error('HTTP 404 ' + p);
      return JSON.parse(fs.readFileSync(path.join(SRC, p), 'utf8')); },
    listDir: async (dir) => main ? [...main].filter(([p]) => path.dirname(p) === dir).map(([p, sha]) => ({ path: p, sha })) : null,
    publishFile: async (p, content) => { cap.paths.push(p); cap.content.set(p, content); },
    publishBatch: async (files, msg) => { for (const f of files) { cap.paths.push(f.path); cap.content.set(f.path, f.content); } cap.msg = msg; cap.batches++; return { commit: 'abc1234def', chunks: 1, attempts: 1 }; },
    build: async () => copyOf(opt.build || built), rawBase: 'https://raw.githubusercontent.com/x/y/main' });
  const gate = async (nowIso, hb, env = {}, opt = {}, main = null) => { const cap = { paths: [], content: new Map(), msg: null, batches: 0 }; const c = console.log; console.log = () => {}; let r; try { r = await P.runPnlDuty({ ...mkDeps(hb, main, cap, opt), env, now: () => new Date(nowIso) }); } finally { console.log = c; } return { r, cap }; };
  const W = { PNL_CADENCE: 'weekly' };
  { const { r, cap } = await gate('2026-09-10T12:00:00Z', '2026-09-07T03:31:00Z', W); check('weekly: inside the built epoch → skipped, nothing written', r.status === 'skipped' && /already built/.test(r.reason) && cap.paths.length === 0, r); }
  { const { r } = await gate('2026-09-14T01:00:00Z', '2026-09-07T03:31:00Z', W); check('weekly: new epoch but before Mon 03:30 → skipped', r.status === 'skipped' && /builds at Mon 03:30/.test(r.reason), r); }
  { const { r } = await gate('2026-09-14T03:31:00Z', '2026-09-07T03:31:00Z', W); check('weekly: new epoch at 03:31 → runs (epoch 203), a full publish, every file written when main is empty', r.status === 'ok' && r.epoch === 203 && r.mode === 'full' && r.written === r.files && r.unchanged === 0 && r.held === 0, r); }
  { const { r } = await gate('2026-09-10T12:00:00Z', '2026-09-07T03:31:00Z', { ...W, PNL: 'force' }); check('PNL=force runs inside the built epoch, as a full publish', r.status === 'ok' && r.mode === 'full', r); }
  { const { r } = await gate('2026-09-14T03:31:00Z', null, { PNL: '0' }); check('PNL=0 skips', r.status === 'skipped' && r.reason === 'PNL=0', r); }
  { const { r } = await gate('2026-09-14T12:00:00Z', hbOf('2026-09-14T04:00:00Z', '2026-09-14T04:00:00Z'), { PNL_CADENCE: 'daily' }); check('daily: built today → skipped', r.status === 'skipped' && /already built today/.test(r.reason), r); }
  { const { r } = await gate('2026-09-15T03:31:00Z', hbOf('2026-09-14T04:00:00Z', '2026-09-14T04:00:00Z'), { PNL_CADENCE: 'daily' }); check('daily: next day at 03:31 → a full publish', r.status === 'ok' && r.mode === 'full', r && { s: r.status, m: r.mode, why: r.reason }); }
  // 'events' is the default cadence
  { const { r } = await gate('2026-09-14T12:00:00Z', hbOf('2026-09-14T04:00:00Z', '2026-09-14T04:00:00Z')); check('events: re-priced today and no new event → skipped', r.status === 'skipped' && /already built today/.test(r.reason), r); }
  { const { r } = await gate('2026-09-14T12:00:00Z', hbOf('2026-09-14T11:00:00Z', '2026-09-14T04:00:00Z', EV_TOTAL - 3)); check('events: new events, last build 60 min ago → skipped (min 120)', r.status === 'skipped' && /new events, but the last build was 60 min ago/.test(r.reason), r); }
  { const { r } = await gate('2026-09-14T12:00:00Z', hbOf('2026-09-14T09:00:00Z', '2026-09-14T04:00:00Z', EV_TOTAL - 3), {}, { ledgerIndex: { signatures: {} } }); check('events: new events, last build 180 min ago → builds, NOT a full publish', r.status === 'ok' && r.mode === 'events', r && { s: r.status, m: r.mode, why: r.reason }); }
  { const { r } = await gate('2026-09-15T01:00:00Z', hbOf('2026-09-14T23:00:00Z', '2026-09-14T04:00:00Z')); check('events: next day before 03:30, no new event → skipped', r.status === 'skipped' && /builds after 03:30 UTC/.test(r.reason), r); }
  { const { r, cap } = await gate('2026-09-15T03:31:00Z', hbOf('2026-09-14T23:00:00Z', '2026-09-14T04:00:00Z')); const hb = JSON.parse(cap.content.get('tla-flows/pnl/heartbeat.json') || '{}');
    check("events: next day at 03:31 → the day's re-price (a full publish) and the heartbeat says so", r.status === 'ok' && r.mode === 'full' && hb.full_publish_at === hb.builtAt && hb.publish && hb.publish.mode === 'full', { m: r.mode, hb: hb.full_publish_at, built: hb.builtAt }); }
  { const { r } = await gate('2026-09-15T03:31:00Z', hbOf('2026-09-15T00:50:00Z', '2026-09-14T04:00:00Z')); check("events: a build made after midnight for new events is not the day's re-price → 03:31 still does one", r.status === 'ok' && r.mode === 'full', r && { s: r.status, m: r.mode, why: r.reason }); }
  { const { r } = await gate('2026-09-14T12:00:00Z', hbOf('2026-09-14T11:59:00Z', '2026-09-14T04:00:00Z', EV_TOTAL, 'tla-flows-pnl-1.7.2 (org-tla-flows daily duty)')); check('a build by an older builder → rebuilt at once, as a full publish', r.status === 'ok' && r.mode === 'full', r && { s: r.status, m: r.mode }); }
  { const { r } = await gate('2026-09-14T12:00:00Z', { builtAt: '2026-09-14T04:00:00Z', builder: BUILDER, events_index_total: EV_TOTAL }); check('a heartbeat with no full_publish_at reads its builtAt as one → skipped the same day', r.status === 'skipped' && /already built today/.test(r.reason), r); }

  console.log('— R3 which wallet files a build writes (pnl 1.8.0) —');
  { const c = console.log; console.log = () => {};
    // the hourly read two hours on: the same holdings with a later capture time — what moves the end of every rate curve between two real builds
    const laterSrc = { ...localSrc, readJson: async (p) => { const d = await localSrc.readJson(p); if (p === 'member-data/participants/current.json') { const t = new Date(Date.parse(d.capturedAt) + 2 * 3600e3).toISOString(); return { ...d, capturedAt: t, capturedAtUnix: Date.parse(t) }; } return d; } };
    const later = await P.buildPnl(laterSrc, { now: () => new Date('2026-09-14T07:00:00Z') }); console.log = c;
    const isW = (p) => /ledger\/terra1/.test(p), wOf = (p) => /ledger\/(terra1[0-9a-z]+)\.json$/.exec(p)[1];
    const mainOf = (b) => new Map([...b.files].map(([p, o]) => [p, blobSha(P.serialize(o))]));
    const sigsOf = (b) => Object.fromEntries([...b.files].filter(([p]) => isW(p)).map(([p, o]) => [wOf(p), P.activitySignature(o)]));
    const wallets = [...built.files.keys()].filter(isW);
    const moved = wallets.filter(p => P.serialize(built.files.get(p)) !== P.serialize(later.files.get(p)));
    const sigB = sigsOf(built), sigL = sigsOf(later);
    check(`fixture: the later read re-prices ${moved.length} of ${wallets.length} wallet files and moves no signature`, moved.length > 20 && wallets.every(p => sigB[wOf(p)] === sigL[wOf(p)]), { moved: moved.length });
    const hbEv = hbOf('2026-09-14T04:00:00Z', '2026-09-14T04:00:00Z', EV_TOTAL - 2);   // re-priced at 04:00, new events since
    const bookkeeping = (paths) => paths.filter(p => !isW(p)).sort().join(',');
    { const { r, cap } = await gate('2026-09-14T07:00:00Z', hbEv, {}, { build: later, ledgerIndex: { signatures: sigB } }, mainOf(built));
      const hb = JSON.parse(cap.content.get('tla-flows/pnl/heartbeat.json')), ix = JSON.parse(cap.content.get('tla-flows/pnl/ledger/index.json'));
      check(`nothing done by any wallet → 0 wallet files written, ${moved.length} held, ONE commit of the bookkeeping files`, r.mode === 'events' && cap.paths.filter(isW).length === 0 && r.held === moved.length && r.wallet_files_written === 0 && cap.batches === 1 && /heartbeat\.json/.test(bookkeeping(cap.paths)) && /rollup\.json/.test(bookkeeping(cap.paths)) && /ledger\/index\.json/.test(bookkeeping(cap.paths)), { wallets: cap.paths.filter(isW).length, held: r.held, files: bookkeeping(cap.paths) });
      check('held + unchanged + written = every file of the build', r.held + r.unchanged + r.written === r.files, { held: r.held, unchanged: r.unchanged, written: r.written, files: r.files });
      check('the heartbeat reports it and keeps the day of the last full publish', hb.publish.mode === 'events' && hb.publish.wallet_files_written === 0 && hb.publish.wallet_files_held === moved.length && hb.full_publish_at === '2026-09-14T04:00:00Z' && hb.builtAt === '2026-09-14T07:00:00.000Z', hb.publish);
      check(`the index carries a signature for each of the ${wallets.length} wallet files`, ix.signatures && Object.keys(ix.signatures).length === wallets.length && wallets.every(p => ix.signatures[wOf(p)] === sigL[wOf(p)]), Object.keys(ix.signatures || {}).length);
      check('the commit message says how many were held', /0 wallet|held for the day/.test(String(cap.msg)), cap.msg); }
    { const one = moved[0], sigMain = { ...sigB, [wOf(one)]: '0000000000000000' };   // that wallet did something since its file was written
      const { r, cap } = await gate('2026-09-14T07:00:00Z', hbEv, {}, { build: later, ledgerIndex: { signatures: sigMain } }, mainOf(built));
      check('one wallet did something → exactly its file is written, the rest held', cap.paths.filter(isW).length === 1 && cap.paths.includes(one) && r.held === moved.length - 1, cap.paths.filter(isW).length); }
    { const main = mainOf(built); const gone = moved[1]; main.delete(gone);   // a wallet with no file on main yet
      const { r, cap } = await gate('2026-09-14T07:00:00Z', hbEv, {}, { build: later, ledgerIndex: { signatures: sigB } }, main);
      check('a wallet with no file on main → written', cap.paths.filter(isW).length === 1 && cap.paths.includes(gone) && r.held === moved.length - 1, cap.paths.filter(isW)); }
    { const still = wallets.find(p => !moved.includes(p)), sigMain = { ...sigB, [wOf(still)]: '0000000000000000' };
      const { cap } = await gate('2026-09-14T07:00:00Z', hbEv, {}, { build: later, ledgerIndex: { signatures: sigMain } }, mainOf(built));
      check('a file identical to main is never written, whatever its signature says', !cap.paths.includes(still), cap.paths.filter(isW).length); }
    { const { r, cap } = await gate('2026-09-14T07:00:00Z', hbEv, {}, { build: later, ledgerIndex: { builtAt: 'x' } }, mainOf(built));   // an index from before 1.8.0
      const hb = JSON.parse(cap.content.get('tla-flows/pnl/heartbeat.json'));
      check(`no signatures on main → every changed wallet file is written this once (${moved.length}), recorded as a full publish`, r.mode === 'full' && cap.paths.filter(isW).length === moved.length && r.held === 0 && hb.full_publish_at === hb.builtAt, { m: r.mode, n: cap.paths.filter(isW).length }); }
    { const { r, cap } = await gate('2026-09-15T03:31:00Z', hbOf('2026-09-14T23:00:00Z', '2026-09-14T04:00:00Z'), {}, { build: later, ledgerIndex: { signatures: sigB } }, mainOf(built));
      check(`the day's re-price writes all ${moved.length} re-priced files`, r.mode === 'full' && cap.paths.filter(isW).length === moved.length && r.held === 0, { m: r.mode, n: cap.paths.filter(isW).length }); }
    // the signature itself, on a real wallet file
    { const p = moved[0], doc = JSON.parse(P.serialize(later.files.get(p))), sig = P.activitySignature(doc); const mut = (f) => { const d = JSON.parse(JSON.stringify(doc)); f(d); return P.activitySignature(d); };
      const ek = Object.keys(doc.epochs || {})[0], pk = Object.keys((doc.v3 || {}).positions || {})[0];
      check('signature: prices do not move it (value curve, totals, every USD key)', mut(d => { for (const pt of d.v3.value_curve || []) { pt.usd = (pt.usd || 0) + 1; pt.luna = (pt.luna || 0) + 1; } d.v3.totals.net_usd = 1; if (d.v3.totals.open) d.v3.totals.open.value_usd = 1; if (ek && d.epochs[ek]) d.epochs[ek].clm_usd = 123; if (pk) { d.v3.positions[pk].open_value_usd = 5; d.v3.positions[pk].open_value_luna = 5; d.v3.positions[pk].realized = { ...(d.v3.positions[pk].realized || {}), out_usd: 9 }; } }) === sig);
      check('signature: a new event moves it (epoch counts, units)', ek != null && mut(d => { d.epochs[ek].c = { ...(d.epochs[ek].c || {}), dep: ((d.epochs[ek].c || {}).dep || 0) + 1 }; }) !== sig && mut(d => { d.cumulative_units_at_head = { ...(d.cumulative_units_at_head || {}), 'x|lp': '1' }; }) !== sig);
      check('signature: a position that moved, is not held, is disputed, or has new open units moves it', pk != null && mut(d => { d.v3.positions[pk].not_held = 'not_held'; }) !== sig && mut(d => { d.v3.positions[pk].moves = [{}]; }) !== sig && mut(d => { d.v3.positions[pk].disputed = { a: 1 }; }) !== sig && mut(d => { d.v3.positions[pk].units_open = (d.v3.positions[pk].units_open || 0) + 1; }) !== sig);
      check('signature: a bribe claimed moves it; its USD value does not', mut(d => { d.v3.bribes = { ...(d.v3.bribes || {}), ZZZ: { amount: 1, usd: 1, luna: 1, n: 1 } }; }) !== sig && mut(d => { for (const k of Object.keys(d.v3.bribes || {})) d.v3.bribes[k].usd = 777; }) === sig); }
  }
  console.log('— R4 fatal throws —');
  { let err = null; try { await P.buildPnl({ ...localSrc, readJson: async (p) => p === 'tla-flows/events/index.json' ? { months_present: {} } : localSrc.readJson(p) }, { now: () => NOW }); } catch (e) { err = e; } check('empty corpus → PnlFatal thrown', err instanceof P.PnlFatal && /no event month/.test(err.message), err && err.message); }
  console.log(`\n=== MOCK GATE (pnl): ${pass} passed, ${fail} failed ===`); process.exit(fail ? 1 : 0);
})().catch(e => { console.error('GATE CRASH', e); process.exit(1); });
