// =============================================================================
// member-data / lib / chain.js
// =============================================================================
// Shared chain + GitHub helpers, vendored from the proven tla-vp-holders /
// capture-engine crons for behavior parity. Dual-LCD retry, CW721 enumeration
// with honest fail-vs-empty distinction, bounded-concurrency parallel map.
// =============================================================================

const https = require('https');

const TERRA_LCD_PRIMARY  = process.env.LCD_PRIMARY  || 'https://terra-rest.publicnode.com';
const TERRA_LCD_FALLBACK = process.env.LCD_FALLBACK || 'https://terra.publicnode.com';

function fetchJson(url, label = '') {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'member-data/1.0' }, timeout: 20000 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} ${label}`)); }
      let d = ''; res.on('data', c => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject).on('timeout', function () { this.destroy(new Error(`timeout ${label}`)); });
  });
}

function encodeQuery(q) { return Buffer.from(JSON.stringify(q)).toString('base64'); }

// Smart query with dual-LCD retry. Returns the `data` field, or null after
// exhausting both endpoints. null = FAILED (caller must distinguish from a
// legitimately-empty result and never silently coerce to []).
async function queryContract(contractAddr, query, attemptFallback = true) {
  const qb = encodeQuery(query);
  const p = `/cosmwasm/wasm/v1/contract/${contractAddr}/smart/${qb}`;
  const label = `query ${JSON.stringify(query).slice(0, 60)}`;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try { const r = await fetchJson(TERRA_LCD_PRIMARY + p, `${label} (try ${attempt})`); return r.data; }
    catch (e) { if (attempt < 2) await new Promise(r => setTimeout(r, 200 + Math.random() * 300)); }
  }
  if (attemptFallback) {
    try { const r = await fetchJson(TERRA_LCD_FALLBACK + p, `${label} (fallback)`); return r.data; }
    catch (e) { return null; }
  }
  return null;
}

async function parallelMap(items, fn, concurrency = 5) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      try { results[i] = await fn(items[i], i); }
      catch (e) { results[i] = { _error: e.message || String(e) }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

// CW721 all_tokens enumeration. Sets enumIncomplete=true if a page returns null
// (query FAILED) rather than a genuine empty page — so a truncated list never
// publishes as a complete census.
async function enumerateAllTokens(contractAddr, pageLimit = 100) {
  const out = [];
  let startAfter = null, page = 0, incomplete = false;
  while (true) {
    page++;
    const q = startAfter
      ? { all_tokens: { limit: pageLimit, start_after: startAfter } }
      : { all_tokens: { limit: pageLimit } };
    const r = await queryContract(contractAddr, q);
    if (r === null) { incomplete = true; break; } // FAILED, not end-of-list
    const tokens = Array.isArray(r?.tokens) ? r.tokens : [];
    if (tokens.length === 0) break;
    out.push(...tokens);
    if (tokens.length < pageLimit) break;
    startAfter = tokens[tokens.length - 1];
  }
  return { tokens: out, incomplete };
}

// ---- GitHub commit (same pattern as other org crons) ----
const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
const GITHUB_REPO   = process.env.GITHUB_REPO || 'thealliancedao/tla-core';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';

function githubApi(method, apiPath, body = null) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.github.com', path: apiPath, method,
      headers: {
        Authorization: `token ${GITHUB_TOKEN}`, 'User-Agent': 'member-data/1.0',
        Accept: 'application/vnd.github+json', 'Content-Type': 'application/json',
      },
    }, (res) => { let d = ''; res.on('data', c => (d += c)); res.on('end', () => { try { resolve({ status: res.statusCode, data: JSON.parse(d || '{}') }); } catch { resolve({ status: res.statusCode, data: {} }); } }); });
    req.on('error', reject); if (body) req.write(JSON.stringify(body)); req.end();
  });
}

// Commit with 409-conflict retry. Multiple crons write to the same tla-core
// repo, so the file's sha can change between our GET and PUT (another cron
// committed first) -> GitHub 409. We re-fetch the fresh sha and retry. Almost
// all collisions resolve on the first retry.
async function pushToGithub(filepath, contentObj, message, maxAttempts = 5) {
  const content = JSON.stringify(contentObj, null, 2);
  if (!GITHUB_TOKEN) {
    const fs = require('fs'), path = require('path');
    const local = path.join(process.env.LOCAL_OUT || './out', filepath);
    fs.mkdirSync(path.dirname(local), { recursive: true });
    fs.writeFileSync(local, content);
    return true;
  }
  const apiPath = `/repos/${GITHUB_REPO}/contents/${filepath}`;
  const b64 = Buffer.from(content).toString('base64');
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // (re)fetch current sha each attempt so a stale sha can't persist
    const existing = await githubApi('GET', `${apiPath}?ref=${GITHUB_BRANCH}`);
    const sha = existing.data?.sha;
    const body = { message, content: b64, branch: GITHUB_BRANCH, ...(sha ? { sha } : {}) };
    const result = await githubApi('PUT', apiPath, body);
    if (result.status === 200 || result.status === 201) return true; // success
    if (result.status === 409 || result.status === 422) {
      // sha conflict (another cron committed between our GET and PUT) — back off
      // and retry with a freshly-fetched sha.
      await new Promise(r => setTimeout(r, 300 * attempt + Math.floor(Math.random() * 400)));
      continue;
    }
    // any other non-success status: don't spin — report failure
    return false;
  }
  return false; // exhausted retries
}

module.exports = {
  queryContract, parallelMap, enumerateAllTokens, fetchJson, pushToGithub,
  TERRA_LCD_PRIMARY, TERRA_LCD_FALLBACK, GITHUB_REPO, GITHUB_BRANCH,
};
