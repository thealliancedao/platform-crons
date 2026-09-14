'use strict';
// mock-run-state-history.js — BINDING gate for dex-data 1.4.0's folded state-history duty (lib/state-history.js).
// Real committed inputs from a tla-core checkout (epoch table, tla-snapshot, events, the existing state-history
// product); the ARCHIVE is a deterministic fake (smartAt/blockTime answer from the real epoch-202 file); reads and
// writes go to an in-memory store. Usage: TLA_CORE_DIR=<tla-core checkout> node --max-old-space-size=200 mock-run-state-history.js
// 2026-09-14 (1.4.1): RUN WITH THE HEAP CAP — it is the gate. Render's instance has ~256 MB; 1.4.0 held every event month in
// memory and died on the first real boundary (epoch 203, 00:30 UTC) with "heap out of memory", taking eris-apr down with
// it. Under --max-old-space-size=200 the 1.4.0 lib aborts on these same real months; 1.4.1 folds month-by-month and passes.
//   R1 nothing missing  → skipped fast, ZERO archive requests, nothing written
//   R2 no ARCHIVE env   → PUBLIC mode: samples from PUBLIC_LCD, epoch/heartbeat labeled source:public, endpoint not masked
//   R2b public mode + a `depth` answer → epoch kept INCOMPLETE (a pruned answer never freezes blanks)
//   R3 boundary 203 started, missing → ONE epoch sampled from the fake archive, file complete, cursor/index/heartbeat
//      written, index keeps every prior row + the new one, write-once: 97–202 untouched (0 reads of them)
//   R4 transport failure mid-sample → epoch kept INCOMPLETE (visible, in cursor), index lists it, status partial
//   R5 next run after R4 → resampled and completed (cursor cleared)
//   R6 fatal (range outside span) → throws ArchiveFatal, never process.exit
//   R7 FORCE=1 resamples a complete epoch
const fs = require('fs'), path = require('path');
const SRC = process.env.TLA_CORE_DIR; if (!SRC) { console.error('TLA_CORE_DIR required'); process.exit(1); }
const SH = require('./lib/state-history');
let pass = 0, fail = 0; const check = (n, ok, x) => { if (ok) { pass++; console.log('  ✅ ' + n); } else { fail++; console.log('  ❌ ' + n + (x != null ? ' — ' + JSON.stringify(x).slice(0, 300) : '')); } };
const J = (p) => JSON.parse(fs.readFileSync(path.join(SRC, p), 'utf8'));
const real202 = J('dex-data/state-history/epochs/202.json');
function store(seed = {}) { const S = new Map(Object.entries(seed)); const writes = []; const reads = [];
  return { S, writes, reads, readJson: async (p) => { reads.push(p); return S.has(p) ? JSON.parse(JSON.stringify(S.get(p))) : null; }, writeJson: async (p, o) => { writes.push(p); S.set(p, JSON.parse(JSON.stringify(o))); } }; }
// committed inputs straight from the checkout — plus two synthetic anchor events around the 203 boundary
// (the checkout's events end 2026-09-12; in production tla-flows has walked past Monday 00:00 by 03:31)
const fetchJson = async (p) => { const d = J(p); if (p === 'tla-flows/events/2026/09.json') return [...d, { height: 22837990, timestamp: '2026-09-13T23:59:00Z' }, { height: 22838100, timestamp: '2026-09-14T00:11:00Z' }]; return d; };
const publicGet = async () => ({ data: { minter: null } });
// fake archive: answers every pair query with epoch 202's real answer for that pair (or a generic shape), hubs/compounder/staking likewise
function fakeArchive({ failAfter = Infinity, depthFor = 0 } = {}) {
  let n = 0; const stats = { archive_requests: 0, archive_retries: 0, started: Date.now() };
  const byPair = new Map(Object.values(real202.pairs).filter(p => p.ok).map(p => [p.pair, p]));
  return { transport: 'lcd', reqDelayMs: 0, stats,
    async blockTime(h) { stats.archive_requests++; const T = Date.parse('2026-09-14T00:00:00Z'); return new Date(T + (h - 22838000) * 6000).toISOString(); },   // 6 s blocks; height 22838000 = the 203 boundary
    async smartAt(addr, q, h) { stats.archive_requests++; if (++n > failAfter) return { ok: false, class: 'net', msg: 'simulated transport failure' }; if (q.pool && depthFor && n <= depthFor) return { ok: false, class: 'depth', msg: 'simulated: no state at height' };
      if (q.pool) { const p = byPair.get(addr); return p ? { ok: true, data: { assets: p.assets.map(a => ({ info: a.denom.startsWith('cw20:') ? { token: { contract_addr: a.denom.slice(5) } } : { native_token: { denom: a.denom.slice(7) } }, amount: a.amount })), total_share: p.total_share } } : { ok: false, class: 'absent', msg: 'contract not found' }; }
      if (q.asset_configs) return { ok: true, data: real202.compounder.ok ? real202.compounder.rates.map(r => ({ asset: r.asset, gauge: r.gauge })) : [] };
      if (q.user_infos || q.user_info) return { ok: true, data: [] };
      if (q.total_staked_balances) return { ok: true, data: [] };
      if (q.exchange_rates) return { ok: true, data: { exchange_rates: [[0, '2.2868769623084546']] } };
      if (q.state) return { ok: true, data: { exchange_rate: '1.1', total_ustake: '1', total_utoken: '1' } };
      return { ok: true, data: {} }; } };
}
const base = () => ({ 'dex-data/state-history/index.json': J('dex-data/state-history/index.json'), 'dex-data/state-history/cursor.json': J('dex-data/state-history/cursor.json') });
const ENV = { TIME_BUDGET_MIN: '5' };   // no archive env = PUBLIC mode (the forward default)
const ARCH = { ...ENV, ARCHIVE_LCD: 'https://archive.example' };
(async () => {
  console.log('— R1 nothing missing (now = inside epoch 202) —');
  { const st = store(base()); const arch = fakeArchive(); const r = await SH.runStateHistory({ ...st, fetchJson, env: ENV, now: () => new Date('2026-09-10T00:00:00Z'), archiveFactory: () => arch, publicGet });
    check('skipped, reason names epoch 202', r.status === 'skipped' && /202 already complete/.test(r.reason), r); check('zero archive requests', arch.stats.archive_requests === 0); check('nothing written', st.writes.length === 0, st.writes); }
  console.log('— R2 public mode is the default; the factory is handed PUBLIC_LCD, unmasked —');
  { const st = store(base()); let handed = null; const arch = fakeArchive(); const r = await SH.runStateHistory({ ...st, fetchJson, env: { ...ENV, PUBLIC_LCD: 'https://terra-lcd.publicnode.com' }, now: () => new Date('2026-09-15T03:31:00Z'), archiveFactory: (o) => { handed = o; return { ...arch, source: o.secret ? 'archive' : 'public' }; }, publicGet });
    check('factory called with the PUBLIC LCD, secret:false', handed && handed.lcd === 'https://terra-lcd.publicnode.com' && handed.secret === false && !handed.rpc, handed);
    check('sampled 1, source public on epoch file + heartbeat', r.sampled === 1 && r.source === 'public' && st.S.get('dex-data/state-history/epochs/203.json').source === 'public' && st.S.get('dex-data/state-history/heartbeat.json').source === 'public', r);
    check('public host NOT masked in logs', SH.mask('https://terra-lcd.publicnode.com/x') === 'https://terra-lcd.publicnode.com/x');
    { let h = null; await SH.runStateHistory({ ...store(base()), fetchJson, env: { ...ARCH, EPOCH_FROM: '203', EPOCH_TO: '203' }, now: () => new Date('2026-09-15T03:31:00Z'), archiveFactory: (o) => { h = o; return fakeArchive(); }, publicGet }); check('ARCHIVE env → factory gets the archive, secret:true', h && h.lcd === 'https://archive.example' && h.secret === true, h); } }
  console.log('— R2b public mode + depth answer → incomplete, never frozen —');
  { const st = store(base()); const arch = fakeArchive({ depthFor: 3 }); const r = await SH.runStateHistory({ ...st, fetchJson, env: ENV, now: () => new Date('2026-09-15T03:31:00Z'), archiveFactory: () => arch, publicGet });
    const ep = st.S.get('dex-data/state-history/epochs/203.json'); check('depth>0 in public mode → complete:false, in cursor', ep && ep.complete === false && ep.tally.depth === 3 && r.incomplete[0] === 203, ep && ep.tally);
    const st2 = store(base()); const r2 = await SH.runStateHistory({ ...st2, fetchJson, env: ARCH, now: () => new Date('2026-09-15T03:31:00Z'), archiveFactory: () => fakeArchive({ depthFor: 3 }), publicGet });
    check('same answers in ARCHIVE mode → complete (depth is an honest blank there)', r2.sampled === 1 && st2.S.get('dex-data/state-history/epochs/203.json').complete === true, r2); }
  console.log('— R3 epoch 203 started and missing —');
  let st3;
  { st3 = store(base()); const arch = fakeArchive(); const r = await SH.runStateHistory({ ...st3, fetchJson, env: ENV, now: () => new Date('2026-09-15T03:31:00Z'), archiveFactory: () => arch, publicGet });
    check('status ok, 1 sampled, 0 incomplete', r.status === 'ok' && r.sampled === 1 && r.incomplete.length === 0, r);
    const ep = st3.S.get('dex-data/state-history/epochs/203.json'); check('epochs/203.json written, complete, epoch 203', !!ep && ep.complete === true && ep.epoch === 203, ep && ep.tally);
    check('203 has pairs + compounder + staking + lst_hubs + tally', ep && ep.pairs && ep.compounder && ep.staking && ep.lst_hubs && ep.tally && Object.keys(ep.pairs).length >= 60, ep && Object.keys(ep.pairs || {}).length);
    check('write set = 203 + cursor + index + heartbeat only', JSON.stringify([...new Set(st3.writes)].sort()) === JSON.stringify(['dex-data/state-history/cursor.json', 'dex-data/state-history/epochs/203.json', 'dex-data/state-history/heartbeat.json', 'dex-data/state-history/index.json']), st3.writes);
    const idx = st3.S.get('dex-data/state-history/index.json'); const prior = base()['dex-data/state-history/index.json'];
    check('index keeps every prior row byte-equal + adds 203', idx.epochs.length === prior.epochs.length + 1 && JSON.stringify(idx.epochs.slice(0, -1)) === JSON.stringify(prior.epochs) && idx.epochs.at(-1).epoch === 203 && idx.epoch_span[1] === 203, [idx.epochs.length, prior.epochs.length]);
    check('index row shape matches the Action\'s (amp_rates, hubs_ok, shape, skipped)', ['amp_rates', 'hubs_ok', 'shape', 'skipped'].every(k => k in idx.epochs.at(-1)), idx.epochs.at(-1));
    check('write-once: no prior epoch file read or written', !st3.reads.some(p => /epochs\/(9\d|1\d\d|20[0-2])\.json/.test(p)) && !st3.writes.some(p => /epochs\/(9\d|1\d\d|20[0-2])\.json/.test(p)), st3.reads.filter(p => /epochs\//.test(p)));
    const hb = st3.S.get('dex-data/state-history/heartbeat.json'); check('heartbeat ok, runner labeled dex-data', hb.status === 'ok' && /org-dex-data/.test(hb.runner), hb);
    check('cursor: last_attempted 203, incomplete []', st3.S.get('dex-data/state-history/cursor.json').last_attempted === 203 && st3.S.get('dex-data/state-history/cursor.json').incomplete.length === 0); }
  console.log('— R4 transport failure mid-sample → incomplete, kept —');
  let st4;
  { st4 = store(base()); const arch = fakeArchive({ failAfter: 30 }); const r = await SH.runStateHistory({ ...st4, fetchJson, env: ENV, now: () => new Date('2026-09-15T03:31:00Z'), archiveFactory: () => arch, publicGet });
    const ep = st4.S.get('dex-data/state-history/epochs/203.json');
    check('incomplete [203], file kept with complete:false', r.incomplete.length === 1 && r.incomplete[0] === 203 && ep && ep.complete === false && ep.tally.net > 0, r);
    check('cursor lists 203, heartbeat partial, index epochs_incomplete [203]', st4.S.get('dex-data/state-history/cursor.json').incomplete[0] === 203 && st4.S.get('dex-data/state-history/heartbeat.json').status === 'partial' && st4.S.get('dex-data/state-history/index.json').epochs_incomplete[0] === 203); }
  console.log('— R5 next run completes it —');
  { const arch = fakeArchive(); const r = await SH.runStateHistory({ ...st4, fetchJson, env: ENV, now: () => new Date('2026-09-15T04:31:00Z'), archiveFactory: () => arch, publicGet });
    check('resampled → complete, cursor cleared', r.sampled === 1 && r.incomplete.length === 0 && st4.S.get('dex-data/state-history/epochs/203.json').complete === true && st4.S.get('dex-data/state-history/cursor.json').incomplete.length === 0, r); }
  console.log('— R6 fatal throws, never exits —');
  { const st = store(base()); let err = null; try { await SH.runStateHistory({ ...st, fetchJson, env: { ...ENV, EPOCH_FROM: '1', EPOCH_TO: '5' }, now: () => new Date('2026-09-15T03:31:00Z'), archiveFactory: () => fakeArchive(), publicGet }); } catch (e) { err = e; }
    check('ArchiveFatal thrown for a range outside the span', err instanceof SH.ArchiveFatal && /outside the resolvable span/.test(err.message), err && err.message); check('nothing written', st.writes.length === 0); }
  console.log('— R7 FORCE=1 resamples a complete epoch —');
  { const st = store(base()); const arch = fakeArchive(); const r = await SH.runStateHistory({ ...st, fetchJson, env: { ...ENV, FORCE: '1', EPOCH_FROM: '202', EPOCH_TO: '202' }, now: () => new Date('2026-09-10T00:00:00Z'), archiveFactory: () => arch, publicGet });
    check('202 resampled under FORCE', r.sampled === 1 && st.writes.includes('dex-data/state-history/epochs/202.json'), r); }
  console.log(`\n=== MOCK GATE (state-history): ${pass} passed, ${fail} failed ===`); process.exit(fail ? 1 : 0);
})().catch(e => { console.error('GATE CRASH', e); process.exit(1); });
