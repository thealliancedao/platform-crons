// =============================================================================
// history.js — FORWARD EMITTERS (2026-08-10, strip step 4a) — PERMANENT module
// =============================================================================
// Lean forward-capture of TLA gauge state — NOT a port of the legacy 1,744-line
// tla-snapshot cron. Per CHANGES_PENDING step 4: only the pool-status RULE is
// ported from tla-snapshot.js; everything else here is org-native.
//
// LEG 1 (live): POOL-STATUS — for each bucket gauge, gauge_infos(time='next')
//   per-pool VP → pct-of-bucket → status by the 1% rule:
//     pct >= 1.0%  → 'active'             (earning rewards)
//     vp > 0       → 'voted_but_inactive' (below threshold)
//     else         → 'zero_vp'            (deprecated)
//   plus `deprecated` cross-reference from the org astroport snapshot
//   (dex-data/astroport/snapshots/current.json — org product, never legacy).
//   Products (tla-core):
//     dex-data/pool-status/current.json        latest full state
//     dex-data/pool-status/daily/<date>.json   immutable dated series (forward)
//     dex-data/pool-status/heartbeat.json      freshness signal
//   Old legacy series DISCARDED by doctrine (method drift; queue step 4).
//
// LEG 2 (DELIBERATELY NOT BUILT — decision pending, CHANGES_PENDING 4b):
//   APR-HISTORY via the correct Eris formula
//     displayed = aprToApy(incentiveApr × 0.92) + tradingApr − yearly_take_rate
//     (incentive leg compounded, trading/take linear — replicate exactly)
//   BLOCKED ON TWO SOURCING DECISIONS (do not implement before they're made):
//   (a) alliance reward_weights — legacy HARDCODED them, hand-calibrated from
//       a block explorer (its comment: LCD alliance queries firewalled at its
//       provider). Options: hand-calibrated registry w/ drift canary; live
//       /terra/alliances probe on both public LCDs; archive-endpoint capture.
//   (b) the denominator (per-bucket TLA-STAKED TVL) — most of the legacy
//       cron's size exists to compute this. Options: total_staked_balances
//       gauge queries + org pricing (lean) vs porting the staked machinery.
//
// Fold discipline: runs as an isolated tail of org-dex-data (index.js hook),
// kill-switch HISTORY=0, failure never fails core snapshots.
// Consistency laws honored: publishes via contents API with sha-conflict retry
// and server blob-sha verification; no raw-CDN reads of anything this run
// writes (this module only reads org products written by EARLIER runs/jobs).
// =============================================================================

const https = require('https');
const crypto = require('crypto');

// -----------------------------------------------------------------------------
// CONFIG
// -----------------------------------------------------------------------------
const TLA_GAUGE_CONTROLLER = 'terra1hfksrhchkmsj4qdq33wkksrslnfles6y2l77fmmzeep0xmq24l2smsd3lj';
const BUCKETS = ['stable', 'project', 'bluechip', 'single'];
const ACTIVE_THRESHOLD_PCT = 1.0;   // the ported rule: >=1% of bucket VP = active

const LCD_URL = process.env.TERRA_LCD || 'https://terra-lcd.publicnode.com';
const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
const GITHUB_REPO   = process.env.GITHUB_REPO   || 'thealliancedao/tla-core';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const OUT = 'dex-data/pool-status';
const ASTRO_SNAPSHOT_PATH = 'dex-data/astroport/snapshots/current.json';

// -----------------------------------------------------------------------------
// HTTP (fold-standard: http/https, redirects, timeout; LCD json w/ retry)
// -----------------------------------------------------------------------------
function httpRequest(url, { method = 'GET', headers = {}, body = null, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const isHttp = u.protocol === 'http:';
    const mod = isHttp ? require('http') : https;
    const req = mod.request({
      method, hostname: u.hostname, port: u.port || (isHttp ? 80 : 443),
      path: u.pathname + (u.search || ''),
      headers: {
        'User-Agent': 'org-dex-data/history',
        ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}),
        ...headers,
      },
      timeout: timeoutMs,
    }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        return resolve(httpRequest(new URL(res.headers.location, url).toString(), { method, headers, body, timeoutMs }));
      }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode} from ${url}: ${data.slice(0, 160)}`));
        resolve({ status: res.statusCode, body: data });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error(`timeout ${url}`)));
    if (body) req.write(body);
    req.end();
  });
}

async function fetchJson(url, { retries = 2, timeoutMs = 12000 } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const { body } = await httpRequest(url, { timeoutMs });
      return JSON.parse(body);
    } catch (e) {
      lastErr = e;
      if (i < retries) await new Promise(r => setTimeout(r, 500 * (i + 1)));
    }
  }
  throw new Error(`fetchJson failed: ${lastErr.message}`);
}

async function queryContract(addr, queryObj) {
  const q = Buffer.from(JSON.stringify(queryObj)).toString('base64');
  const resp = await fetchJson(`${LCD_URL}/cosmwasm/wasm/v1/contract/${addr}/smart/${q}`);
  return resp?.data;
}

function fetchOrgRaw(repoPath) {
  return httpRequest(`https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_BRANCH}/${repoPath}?cb=${Date.now()}`)
    .then(r => r.body).catch(() => null);
}

// -----------------------------------------------------------------------------
// POOL-ID RESOLUTION (ported verbatim in behavior from tla-snapshot.js)
// -----------------------------------------------------------------------------
async function resolvePoolId(poolId) {
  try {
    if (poolId.startsWith('cw20:')) {
      const lpAddr = poolId.slice(5);
      const minterInfo = await queryContract(lpAddr, { minter: {} });
      return { lpAddr, poolAddr: minterInfo?.minter || null, isLpPair: true, isSingle: false, sourceType: 'cw20' };
    }
    if (poolId.startsWith('native:')) {
      const denom = poolId.slice('native:'.length);
      const parts = denom.split('/');
      if (denom.startsWith('factory/') && parts.length >= 3 && parts[parts.length - 1] === 'uLP') {
        return { lpAddr: null, poolAddr: parts[1], isLpPair: true, isSingle: false, sourceType: 'native-lp', lpDenom: denom };
      }
      if (denom.startsWith('factory/')) {
        return { lpAddr: null, poolAddr: null, isLpPair: false, isSingle: true, sourceType: 'native-single', lpDenom: denom, symbolFromDenom: parts.slice(2).join('/') };
      }
      if (denom.startsWith('ibc/')) {
        return { lpAddr: null, poolAddr: null, isLpPair: false, isSingle: true, sourceType: 'native-ibc', lpDenom: denom };
      }
      return { lpAddr: null, poolAddr: null, isLpPair: false, isSingle: true, sourceType: 'native-bare', lpDenom: denom };
    }
    return null;
  } catch (e) {
    console.log(`  ⚠ resolve(${poolId.slice(0, 50)}): ${(e.message || '').slice(0, 60)}`);
    return null;
  }
}

// -----------------------------------------------------------------------------
// STATUS CLASSIFICATION (the ported 1% rule — verbatim semantics)
// -----------------------------------------------------------------------------
function classifyStatus(vp, pctOfBucket) {
  if (pctOfBucket >= ACTIVE_THRESHOLD_PCT) return 'active';
  // NB: the legacy SOURCE COMMENT says 'voted_but_inactive' but the legacy
  // PRODUCT emits 'voted_but_below_threshold' — readers match on the product
  // string, so that is the ported truth.
  if (vp > 0) return 'voted_but_below_threshold';
  return 'zero_vp';
}

// -----------------------------------------------------------------------------
// BUILD
// -----------------------------------------------------------------------------
async function buildPoolStatus(now) {
  console.log('⛓  gauge_infos(next) × 4 ...');
  const gauges = {};
  for (const bucket of BUCKETS) {
    const res = await queryContract(TLA_GAUGE_CONTROLLER, { gauge_infos: { gauge: bucket, time: 'next' } });
    if (!Array.isArray(res)) throw new Error(`gauge_infos(${bucket}) returned non-array`);
    gauges[bucket] = res;   // entries: [pool_id, { voting_power }]
    console.log(`  ✓ ${bucket}: ${res.length} pools`);
  }

  // org astroport snapshot for deprecated cross-ref + names (org product only)
  let astroByPool = new Map();
  try {
    const raw = await fetchOrgRaw(ASTRO_SNAPSHOT_PATH);
    if (raw) {
      const snap = JSON.parse(raw);
      for (const p of snap.pools || []) if (p.poolContract) astroByPool.set(p.poolContract, p);
      console.log(`  ✓ astroport cross-ref: ${astroByPool.size} pools`);
    } else {
      console.log('  ⚠ astroport snapshot unreachable — deprecated flags omitted this run (honest null)');
    }
  } catch (e) {
    console.log(`  ⚠ astroport cross-ref failed: ${e.message.slice(0, 60)} — deprecated flags omitted`);
    astroByPool = new Map();
  }

  const buckets = {};
  const pools = [];
  for (const bucket of BUCKETS) {
    const entries = gauges[bucket];
    const bucketVp = entries.reduce((s, [, v]) => s + (parseFloat(v?.voting_power) || 0), 0);
    let active = 0;
    for (const [poolId, v] of entries) {
      const vp = parseFloat(v?.voting_power) || 0;
      const pct = bucketVp > 0 ? (vp / bucketVp) * 100 : 0;
      const status = classifyStatus(vp, pct);
      if (status === 'active') active++;
      const resolved = await resolvePoolId(poolId);
      const astro = resolved?.poolAddr ? astroByPool.get(resolved.poolAddr) : null;
      pools.push({
        pool_id: poolId,
        bucket,
        pool_address: resolved?.poolAddr || null,
        lp_address: resolved?.lpAddr || null,
        is_lp_pair: !!resolved?.isLpPair,
        is_single: !!resolved?.isSingle,
        source_type: resolved?.sourceType || null,
        name: astro?.name || resolved?.symbolFromDenom || poolId,
        vp,
        vp_human: vp / 1e6,
        pct_of_bucket: pct,
        status,
        deprecated: astro ? !!astro.deprecated : null,   // null = cross-ref unavailable, never guessed
      });
    }
    buckets[bucket] = {
      bucket_vp: bucketVp,
      bucket_vp_human: bucketVp / 1e6,
      pool_count: entries.length,
      active_count: active,
    };
  }

  return {
    schemaVersion: 1,
    cron: 'dex-history-pool-status',
    capturedAt: now.toISOString(),
    epoch: Math.floor((now.getTime() - Date.parse('2022-10-31T00:00:00Z')) / (7 * 24 * 60 * 60 * 1000)) + 1,
    gauge_time: 'next',
    rule: { active_threshold_pct: ACTIVE_THRESHOLD_PCT },
    buckets,
    pools,
  };
}

// -----------------------------------------------------------------------------
// PUBLISH (fold-standard: contents API, sha retry, server blob-sha verification)
// -----------------------------------------------------------------------------
function gitBlobSha1(content) {
  const buf = Buffer.from(content);
  return crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
}

async function pushToGithub(filepath, content, message) {
  const apiPath = `/repos/${GITHUB_REPO}/contents/${encodeURI(filepath)}`;
  const headers = { Authorization: `token ${GITHUB_TOKEN}`, Accept: 'application/vnd.github.v3+json' };
  for (let attempt = 1; attempt <= 4; attempt++) {
    const existing = await httpRequest(`https://api.github.com${apiPath}?ref=${GITHUB_BRANCH}`, { headers }).then(r => JSON.parse(r.body)).catch(() => ({}));
    const r = await httpRequest(`https://api.github.com${apiPath}`, {
      method: 'PUT', headers,
      body: JSON.stringify({ message, content: Buffer.from(content).toString('base64'), branch: GITHUB_BRANCH, ...(existing.sha ? { sha: existing.sha } : {}) }),
    }).catch(e => ({ status: 0, body: e.message }));
    if (r.status === 200 || r.status === 201) {
      const storedSha = (() => { try { return JSON.parse(r.body).content.sha; } catch { return null; } })();
      if (storedSha !== gitBlobSha1(content)) throw new Error(`push ${filepath}: blob sha mismatch — storage verification failed`);
      console.log(`  ✅ pushed ${filepath} (blob sha server-verified)`);
      return true;
    }
    if (r.status === 409 || r.status === 422 || r.status >= 500 || r.status === 0) {
      console.log(`  ↻ push retry ${attempt} (HTTP ${r.status}) ${filepath}`);
      await new Promise(res => setTimeout(res, 400 * attempt + Math.floor(Math.random() * 300)));
      continue;
    }
    console.error(`  ❌ push failed (HTTP ${r.status}): ${String(r.body).slice(0, 120)}`);
    return false;
  }
  return false;
}

const localOut = [];
async function publish(filepath, content, message) {
  if (GITHUB_TOKEN) return pushToGithub(filepath, content, message);
  const fs = require('fs'); const path = require('path');
  const p = path.join(process.env.LOCAL_OUT || './out', filepath);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  localOut.push(filepath);
  console.log(`  💾 saved locally: ${p}`);
  return true;
}

// -----------------------------------------------------------------------------
// MAIN
// -----------------------------------------------------------------------------
async function captureHistory() {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  console.log(`\n📜 history (pool-status) — ${now.toISOString()}`);

  const snap = await buildPoolStatus(now);
  const body = JSON.stringify(snap, null, 2);

  const heartbeat = {
    schemaVersion: 1,
    cron: 'dex-history-pool-status',
    capturedAt: now.toISOString(),
    status: 'ok',
    stats: {
      pools: snap.pools.length,
      active: snap.pools.filter(p => p.status === 'active').length,
      voted_but_below_threshold: snap.pools.filter(p => p.status === 'voted_but_below_threshold').length,
      zero_vp: snap.pools.filter(p => p.status === 'zero_vp').length,
      crossref_available: snap.pools.some(p => p.deprecated !== null),
    },
  };

  console.log(`  buckets: ${BUCKETS.map(b => `${b}=${snap.buckets[b].active_count}/${snap.buckets[b].pool_count}`).join(' ')}`);
  console.log('\n📤 publishing...');
  await publish(`${OUT}/current.json`, body, `📜 pool-status current — ${dateStr}`);
  await publish(`${OUT}/daily/${dateStr}.json`, body, `📜 pool-status daily — ${dateStr}`);
  await publish(`${OUT}/heartbeat.json`, JSON.stringify(heartbeat, null, 2), `📍 pool-status heartbeat — ${dateStr}`);
  console.log('\n✅ history (pool-status) complete\n');
  return { snap, heartbeat };
}

module.exports = {
  main: captureHistory,
  // Gate-only surface (real-fixture parity vs the legacy rule). Not a public API.
  _test: { classifyStatus, resolvePoolId, buildPoolStatus, gitBlobSha1, ACTIVE_THRESHOLD_PCT, BUCKETS },
};
if (require.main === module) captureHistory()
  .then(() => process.exit(0))
  .catch(err => { console.error('\n❌ history failed:', err.message); console.error(err.stack); process.exit(1); });
