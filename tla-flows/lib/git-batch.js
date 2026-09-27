'use strict';
/**
 * tla-flows / lib/git-batch.js 1.0.0 (2026-09-27) — publish MANY files as ONE commit (GitHub git-data API).
 * Why: the weekly P&L duty (pnl.js) rewrites up to ~790 files. One Contents-API PUT per file = one commit per file:
 * the first v3 build (2026-09-27) took ~20 min to publish, and a second run started while the first was still writing —
 * both PUT the same ledger files, 409s on every shared path, and the run's own `pressure` write lost its race.
 * Here: read the branch head → build the new tree on top of it in size-bounded chunks (content inline) → one commit →
 * move the ref fast-forward only. If main moved meanwhile (someone else committed), the ref update is refused (422) and the
 * whole thing is rebuilt on the new head — never a force push, never a lost commit of anyone else's.
 * Also: listTree(dir) — the blob shas of a folder via git trees (the Contents API caps a listing at 1,000 entries; the ledger
 * folder is ~790 today and grows with every new wallet).
 *   api(method, path, body) → parsed JSON; throws { statusCode } on non-2xx (tla-flows' T.githubApiRequest does exactly this)
 */
const VERSION = 'git-batch-1.0.0';
const MAX_CHUNK_BYTES = 4 * 1024 * 1024;   // one tree request stays well under GitHub's request-size limits
const MAX_CHUNK_FILES = 200;

async function headOf(api, repo, branch) {
  const ref = await api('GET', `/repos/${repo}/git/ref/heads/${branch}`);
  const commit = await api('GET', `/repos/${repo}/git/commits/${ref.object.sha}`);
  return { commit: ref.object.sha, tree: commit.tree.sha };
}

// files: [{ path, content: string }] → { commit, files, chunks, attempts }
async function publishBatch({ api, repo, branch = 'main', files, message, retries = 4, sleep = (ms) => new Promise(r => setTimeout(r, ms)) }) {
  if (!files || !files.length) return { commit: null, files: 0, chunks: 0, attempts: 0 };
  const chunks = []; let cur = [], bytes = 0;
  for (const f of files) { const b = Buffer.byteLength(f.content); if (cur.length && (bytes + b > MAX_CHUNK_BYTES || cur.length >= MAX_CHUNK_FILES)) { chunks.push(cur); cur = []; bytes = 0; } cur.push(f); bytes += b; }
  if (cur.length) chunks.push(cur);
  for (let attempt = 1; attempt <= retries; attempt++) {
    const head = await headOf(api, repo, branch);
    let tree = head.tree;
    for (const ch of chunks) {
      const t = await api('POST', `/repos/${repo}/git/trees`, { base_tree: tree, tree: ch.map(f => ({ path: f.path, mode: '100644', type: 'blob', content: f.content })) });
      tree = t.sha;
    }
    if (tree === head.tree) return { commit: null, files: files.length, chunks: chunks.length, attempts: attempt, note: 'no change against the head' };
    const c = await api('POST', `/repos/${repo}/git/commits`, { message, tree, parents: [head.commit] });
    try { await api('PATCH', `/repos/${repo}/git/refs/heads/${branch}`, { sha: c.sha, force: false }); return { commit: c.sha, files: files.length, chunks: chunks.length, attempts: attempt }; }
    catch (e) {
      if ((e.statusCode === 422 || e.statusCode === 409) && attempt < retries) { console.warn(`  ⚠ git-batch: ${branch} moved while building (${e.statusCode}) — rebuilding on the new head (attempt ${attempt})`); await sleep(500 * attempt); continue; }
      throw e;
    }
  }
}

// blob shas of every file directly in `dir` (e.g. 'tla-flows/pnl/ledger') → [{ path, sha }] | null when the folder is absent
async function listTree({ api, repo, branch = 'main', dir }) {
  const head = await headOf(api, repo, branch); let sha = head.tree;
  for (const seg of String(dir).split('/').filter(Boolean)) {
    const t = await api('GET', `/repos/${repo}/git/trees/${sha}`);
    const hit = (t.tree || []).find(x => x.path === seg && x.type === 'tree'); if (!hit) return null; sha = hit.sha;
  }
  const t = await api('GET', `/repos/${repo}/git/trees/${sha}`);
  return (t.tree || []).filter(x => x.type === 'blob').map(x => ({ path: `${dir}/${x.path}`, sha: x.sha }));
}

module.exports = { VERSION, publishBatch, listTree, MAX_CHUNK_BYTES, MAX_CHUNK_FILES };
