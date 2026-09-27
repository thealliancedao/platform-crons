'use strict';
// mock-run-git-batch.js — BINDING gate for lib/git-batch.js 1.0.0 + pnl.js 1.2.1's one-commit publish.
// A fake GitHub git-data API (refs, commits, trees with nested paths, blob shas computed like git) — no network.
//   B1 790 files of ~40 KB (the ledger's size) → ONE commit, split into size-bounded tree chunks, every file on the branch
//   B2 main moves while the batch is building (someone else commits) → the ref update is refused, the batch rebuilds on the new
//      head: ONE new commit, the other person's file is still there, nothing force-pushed
//   B3 identical content → no commit at all
//   B4 listTree lists 1,500 files in one folder (the Contents API stops at 1,000) with git's blob shas
//   B5 runPnlDuty on a real build with main already holding it → ONE batch of just the 3 builtAt files; with main empty → ONE
//      batch of every file (vs ~790 commits before)
// Usage: TLA_CORE_DIR=<tla-core checkout> node --max-old-space-size=400 mock-run-git-batch.js
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const GB = require('./lib/git-batch.js'), P = require('./pnl.js');
let pass = 0, fail = 0; const check = (n, ok, x) => { if (ok) { pass++; console.log('  ✅ ' + n); } else { fail++; console.log('  ❌ ' + n + (x != null ? ' — ' + JSON.stringify(x).slice(0, 300) : '')); } };
const blobSha = (s) => crypto.createHash('sha1').update(`blob ${Buffer.byteLength(s)}\0`).update(s).digest('hex');
const h = (s) => crypto.createHash('sha1').update(s).digest('hex');

// fake repo: a tree = Map(fullPath → blobSha); content kept by blob sha
function fakeRepo() {
  const blobs = new Map(), trees = new Map(), commits = new Map(); let ref = null; const calls = { trees: 0, commits: 0, patch: 0, patchRefusals: 0 }; let beforePatch = null;
  const putTree = (m) => { const sha = h('tree' + [...m].sort().map(x => x.join(':')).join('|')); trees.set(sha, m); return sha; };
  const commitTree = (m, parent, msg) => { const t = putTree(m); const c = h('commit' + t + parent + msg + Math.random()); commits.set(c, { tree: t, parents: parent ? [parent] : [], message: msg }); return c; };
  ref = commitTree(new Map(), null, 'root');
  const api = async (method, p, body) => {
    const err = (code) => { const e = new Error('HTTP ' + code); e.statusCode = code; return e; };
    if (method === 'GET' && /\/git\/ref\/heads\//.test(p)) return { object: { sha: ref } };
    if (method === 'GET' && /\/git\/commits\//.test(p)) { const c = commits.get(p.split('/').pop()); return { sha: p.split('/').pop(), tree: { sha: c.tree } }; }
    if (method === 'GET' && /\/git\/trees\//.test(p)) { const [sha, prefix = ''] = decodeURIComponent(p.split('/git/trees/')[1]).split('::'); const m = trees.get(sha); if (!m) throw err(404);
      const kids = new Map(); for (const [fp, b] of m) { if (!fp.startsWith(prefix)) continue; const rest = fp.slice(prefix.length); const seg = rest.split('/')[0]; if (rest.includes('/')) kids.set(seg, { path: seg, type: 'tree', sha: encodeURIComponent(sha + '::' + prefix + seg + '/') }); else kids.set(seg, { path: seg, type: 'blob', sha: b }); }
      return { sha, tree: [...kids.values()] }; }
    if (method === 'POST' && /\/git\/trees$/.test(p)) { calls.trees++; const base = trees.get(body.base_tree); const m = new Map(base); for (const e of body.tree) { const b = blobSha(e.content); blobs.set(b, e.content); m.set(e.path, b); } return { sha: putTree(m) }; }
    if (method === 'POST' && /\/git\/commits$/.test(p)) { calls.commits++; const c = h('commit' + body.tree + body.parents[0] + body.message); commits.set(c, { tree: body.tree, parents: body.parents, message: body.message }); return { sha: c }; }
    if (method === 'PATCH' && /\/git\/refs\/heads\//.test(p)) { calls.patch++; if (beforePatch) { const f = beforePatch; beforePatch = null; f(); } const c = commits.get(body.sha); if (!c || c.parents[0] !== ref) { calls.patchRefusals++; throw err(422); } ref = body.sha; return { object: { sha: ref } }; }
    throw err(400);
  };
  return { api, calls, blobs, get head() { return ref; }, fileAt: (fp) => { const m = trees.get(commits.get(ref).tree); const b = m.get(fp); return b ? blobs.get(b) : undefined; }, files: () => trees.get(commits.get(ref).tree),
    foreignCommit: (fp, content) => { const m = new Map(trees.get(commits.get(ref).tree)); const b = blobSha(content); blobs.set(b, content); m.set(fp, b); ref = commitTree(m, ref, 'someone else'); }, onNextPatch: (f) => { beforePatch = f; } };
}
const quiet = async (fn) => { const l = console.log, w = console.warn; console.log = () => {}; console.warn = () => {}; try { return await fn(); } finally { console.log = l; console.warn = w; } };

(async () => {
  console.log('— lib/git-batch.js ' + GB.VERSION + ' —');
  { const R = fakeRepo(); const pad = 'x'.repeat(40000); const files = Array.from({ length: 790 }, (_, i) => ({ path: `tla-flows/pnl/ledger/terra1w${String(i).padStart(4, '0')}.json`, content: `{"i":${i},"pad":"${pad}"}\n` }));
    const r = await GB.publishBatch({ api: R.api, repo: 'o/r', branch: 'main', files, message: 'weekly' });
    check(`B1 790 files × 40 KB → one commit (${r.chunks} size-bounded tree chunks), every file on the branch with its content`, R.calls.commits === 1 && R.calls.patch === 1 && r.chunks >= 8 && files.every(f => R.fileAt(f.path) === f.content), { chunks: r.chunks, commits: R.calls.commits });
    // B2 — someone else commits between our tree build and our ref update
    const before = R.calls.commits; R.onNextPatch(() => R.foreignCommit('docs/someone.md', 'hello'));
    const files2 = files.slice(0, 5).map(f => ({ path: f.path, content: f.content.replace('"i"', '"j"') }));
    const r2 = await quiet(() => GB.publishBatch({ api: R.api, repo: 'o/r', branch: 'main', files: files2, message: 'weekly 2', sleep: async () => {} }));
    check('B2 main moved mid-build → refused (422), rebuilt on the new head: one more commit of ours, their file kept, our 5 files updated, no force', r2.attempts === 2 && R.calls.patchRefusals === 1 && R.calls.commits === before + 2 && R.fileAt('docs/someone.md') === 'hello' && files2.every(f => R.fileAt(f.path) === f.content), { attempts: r2.attempts, refusals: R.calls.patchRefusals });
    const c0 = R.calls.commits; const r3 = await GB.publishBatch({ api: R.api, repo: 'o/r', branch: 'main', files: files2, message: 'same again' });
    check('B3 identical content → no commit', r3.commit === null && R.calls.commits === c0);
    const R4 = fakeRepo(); await GB.publishBatch({ api: R4.api, repo: 'o/r', branch: 'main', files: Array.from({ length: 1500 }, (_, i) => ({ path: `a/b/f${i}.json`, content: `{"n":${i}}\n` })), message: 'big' });
    const lt = await GB.listTree({ api: R4.api, repo: 'o/r', branch: 'main', dir: 'a/b' });
    check('B4 listTree: 1,500 files in one folder (past the Contents API\'s 1,000), shas == git blob shas', lt.length === 1500 && lt.every(x => x.sha === blobSha(`{"n":${x.path.match(/f(\d+)/)[1]}}\n`)), lt && lt.length);
    check('listTree of an absent folder → null', (await GB.listTree({ api: R4.api, repo: 'o/r', branch: 'main', dir: 'nope/x' })) === null); }

  console.log('— pnl.js runPnlDuty with publishBatch (real build) —');
  const SRC = process.env.TLA_CORE_DIR;
  if (SRC) {
    const R = fakeRepo(); const rawBase = 'https://raw.test'; const J = (p) => JSON.parse(fs.readFileSync(path.join(SRC, p), 'utf8'));
    const fetchJson = async (u) => { const rel = String(u).replace(rawBase + '/', '').split('?')[0]; if (rel === 'tla-flows/pnl/heartbeat.json') { const c = R.fileAt(rel); if (!c) { const e = new Error('HTTP 404'); throw e; } return JSON.parse(c); } const f = path.join(SRC, rel); if (!fs.existsSync(f)) throw new Error('HTTP 404 ' + rel); return J(rel); };
    const listDir = (dir) => GB.listTree({ api: R.api, repo: 'o/r', branch: 'main', dir });
    const batches = []; const publishBatch = async (files, message) => { batches.push(files.length); return GB.publishBatch({ api: R.api, repo: 'o/r', branch: 'main', files, message }); };
    const perFile = []; const publishFile = async (p) => { perFile.push(p); };
    const env = { PNL: 'force' }; const now = () => new Date('2026-09-28T03:31:00Z');
    const r1 = await quiet(() => P.runPnlDuty({ fetchJson, listDir, publishFile, publishBatch, rawBase, env, now }));
    check(`B5a main empty → ONE batch of all ${r1.files} files, one commit, 0 per-file PUTs`, batches.length === 1 && batches[0] === r1.files && r1.written === r1.files && perFile.length === 0 && !!r1.commit && R.calls.commits === 1, { batches, written: r1.written });
    const r2 = await quiet(() => P.runPnlDuty({ fetchJson, listDir, publishFile, publishBatch, rawBase, env, now: () => new Date('2026-09-28T04:31:00Z') }));
    check(`B5b main already holds the build → ONE batch of just the 3 builtAt files (${r2.unchanged} unchanged)`, batches.length === 2 && batches[1] === 3 && r2.written === 3 && r2.unchanged === r2.files - 3 && perFile.length === 0, { batches, written: r2.written });
  } else console.log('  (TLA_CORE_DIR not given — B5 skipped)');
  console.log(`\n=== MOCK GATE (git-batch): ${pass} passed, ${fail} failed ===`); process.exit(fail ? 1 : 0);
})().catch(e => { console.error('GATE CRASH', e); process.exit(1); });
