// =============================================================================
// dex-data / index.js  — orchestrator
// =============================================================================
// Runs each ENABLED DEX adapter in isolation and writes a PER-DEX snapshot. The
// per-DEX separation is deliberate (requested): each DEX writes its own files
// under its own path, so one DEX can be shut off (enabled:false) or a new one
// added without touching any other. One DEX failing never affects the others.
//
// This is the FORWARD-CAPTURE cron (Component A of the grading system). It
// captures the right primitives correctly NOW so trustworthy history accrues:
//   - per-snapshot pool stats (TVL, volume_24h, fees, reserves, assets)
//   - the CORRECT aggregation happens over accumulated snapshots in
//     lib/aggregate.js (volume=sum, liquidity=avg+min+cv, gap-honest)
//
// Grading itself is NOT computed here — this cron captures; the grade composes
// later (asset-value rubric + support gap) once history is statistically real
// and un-gameable. See SPEC-grading-and-dex-data.md.
//
// Output layout (tla-core), one product per DEX so they're independent:
//   dex-data/<dex>/snapshots/current.json      latest capture
//   dex-data/<dex>/snapshots/daily/<date>.json forward-only daily archive
//   dex-data/<dex>/snapshots/heartbeat.json    freshness signal
//   dex-data/index.json                        which DEXes are enabled + status
// =============================================================================

const fs = require('fs');
const path = require('path');
const { assertAdapter } = require('./dexes/_contract');

// ---- DEX registry. Add a DEX here; remove/disable to drop it. -------------
const DEXES = [
  require('./dexes/astroport'),
  require('./dexes/skeletonswap'),
  require('./dexes/credia'), // placeholder, enabled:false
].map(assertAdapter);

// ---- GitHub config --------------------------------------------------------
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO || 'thealliancedao/tla-core';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const LOCAL_OUT = process.env.LOCAL_OUT || './out';

const VERSION = 'dex-data-1.2.0';

// TLA epoch math (epochs are weekly; used to tag snapshots).
const TLA_EPOCH_START_MS = Date.parse('2022-10-31T00:00:00Z');
const EPOCH_MS = 7 * 24 * 60 * 60 * 1000;
function currentEpoch() {
  return Math.floor((Date.now() - TLA_EPOCH_START_MS) / EPOCH_MS) + 1;
}

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

// ---- per-DEX run, fully isolated ------------------------------------------
async function runDex(dex) {
  const started = Date.now();
  if (!dex.enabled) {
    return { id: dex.id, label: dex.label, status: 'disabled', skipped: true };
  }
  try {
    const { pools, meta } = await dex.capture();
    const snapshot = {
      meta: {
        version: VERSION,
        dex: dex.id,
        label: dex.label,
        generated_at: new Date().toISOString(),
        epoch: currentEpoch(),
        trust_start: dex.trust_start || null,
        status: 'ok',
        ...meta,
      },
      pools,
    };
    return { id: dex.id, status: 'ok', snapshot, pools_total: pools.length, ms: Date.now() - started };
  } catch (e) {
    // Isolated failure: this DEX fails, others continue.
    return { id: dex.id, label: dex.label, status: 'failed', error: String(e && e.message || e), ms: Date.now() - started };
  }
}

// ---- output (GitHub if token, else local) ---------------------------------
async function writeJson(repoPath, obj) {
  const content = JSON.stringify(obj, null, 2);
  if (!GITHUB_TOKEN) {
    const local = path.join(LOCAL_OUT, repoPath);
    fs.mkdirSync(path.dirname(local), { recursive: true });
    fs.writeFileSync(local, content);
    return { local };
  }
  await commitToGitHub(repoPath, content, `dex-data: update ${repoPath}`);
  return { committed: repoPath };
}

// Commit with 409-conflict retry. Multiple crons write to the same tla-core
// repo, so the file's sha can change between our GET and PUT (another cron
// committed first) -> GitHub 409. We re-fetch the fresh sha and retry. (httpRequest
// throws on non-2xx, so a 409 surfaces as a thrown error containing "409"; we
// detect that, back off, and retry with a freshly-read sha.)
async function commitToGitHub(filepath, content, message, maxAttempts = 5) {
  const { httpRequest } = require('./lib/fetch');
  const apiBase = 'https://api.github.com';
  const b64 = Buffer.from(content).toString('base64');
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // (re)fetch current sha each attempt so a stale sha can't persist
    let sha = null;
    try {
      const res = await httpRequest(`${apiBase}/repos/${GITHUB_REPO}/contents/${filepath}?ref=${GITHUB_BRANCH}`, {
        headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' },
      });
      sha = JSON.parse(res.body).sha;
    } catch (_) { /* file doesn't exist yet — sha stays null */ }
    const body = JSON.stringify({
      message, content: b64, branch: GITHUB_BRANCH, ...(sha ? { sha } : {}),
    });
    try {
      await httpRequest(`${apiBase}/repos/${GITHUB_REPO}/contents/${filepath}`, {
        method: 'PUT',
        headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' },
        body,
      });
      return; // success
    } catch (e) {
      const msg = String(e && e.message || e);
      if (msg.includes('409') || msg.includes('422')) {
        // sha conflict — another cron committed between our GET and PUT. Back
        // off and retry with a fresh sha.
        lastErr = e;
        await new Promise(r => setTimeout(r, 300 * attempt + Math.floor(Math.random() * 400)));
        continue;
      }
      throw e; // any other error is real
    }
  }
  throw lastErr || new Error(`commit ${filepath} failed after ${maxAttempts} attempts`);
}

// ---- main -----------------------------------------------------------------
async function main() {
  console.log(`${VERSION} — capturing ${DEXES.filter(d => d.enabled).length} enabled DEX(es)`);
  const date = todayUtc();
  const epoch = currentEpoch();
  const results = [];

  // Run DEXes independently (isolated failures).
  for (const dex of DEXES) {
    const r = await runDex(dex);
    results.push(r);
    if (r.status === 'ok') {
      console.log(`  ✓ ${r.id}: ${r.pools_total} pools (${r.ms}ms)`);
      // per-DEX outputs (independent paths)
      await writeJson(`dex-data/${r.id}/snapshots/current.json`, r.snapshot);
      await writeJson(`dex-data/${r.id}/snapshots/daily/${date}.json`, r.snapshot);
      await writeJson(`dex-data/${r.id}/snapshots/heartbeat.json`, {
        dex: r.id, generated_at: r.snapshot.meta.generated_at, epoch, status: 'ok', pools_total: r.pools_total,
      });
    } else if (r.status === 'disabled') {
      console.log(`  – ${r.id}: disabled (skipped)`);
    } else {
      console.log(`  ✗ ${r.id}: FAILED — ${r.error}`);
    }
  }

  // top-level index: which DEXes exist, enabled, last status
  const index = {
    meta: { version: VERSION, generated_at: new Date().toISOString(), epoch },
    dexes: DEXES.map((d) => {
      const r = results.find((x) => x.id === d.id);
      return {
        id: d.id, label: d.label, enabled: d.enabled, trust_start: d.trust_start || null,
        last_status: r ? r.status : 'unknown',
        pools_total: r && r.pools_total != null ? r.pools_total : null,
      };
    }),
  };
  await writeJson('dex-data/index.json', index);

  const ok = results.filter((r) => r.status === 'ok').length;
  const failed = results.filter((r) => r.status === 'failed');
  console.log(`done: ${ok} ok, ${failed.length} failed${failed.length ? ' (' + failed.map(f => f.id).join(',') + ')' : ''}`);
  // Non-zero exit only if EVERY enabled DEX failed (partial success is still success).
  const enabledCount = DEXES.filter((d) => d.enabled).length;
  if (enabledCount > 0 && ok === 0) process.exit(1);
}

main().catch((e) => { console.error('fatal:', e); process.exit(1); });
