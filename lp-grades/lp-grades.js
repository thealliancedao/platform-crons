// =============================================================================
// lp-grades — the unified LP grading cron (SPEC-lp-grading.md)
// =============================================================================
//
// WHY THIS EXISTS
// ---------------
// Two grading systems were built separately and never met: the legacy
// asset-durability score (tla-registry confusion_score) and the interim
// page-side LP grade (tla-stats renderLpGrades). This module unifies them into
// the Layer-3 mission system (MISSION.md): grade every LP in TLA — active AND
// inactive — on real quality so incentives route intelligently. Four consumers,
// one factual core: voters copy it, bribers reference it, aDAO self-bribes
// toward it, depositors read it as a safety signal.
//
// THE CREDIBILITY RULE (binding, SPEC-grading-and-dex-data §2)
// ------------------------------------------------------------
// The auto-grade is 100% facts. Zero opinion in code. Strategic judgment enters
// ONLY through curated override files with stated reasons. The rubric — every
// weight, curve, threshold, boundary, lens — lives in ONE public config file:
//
//     tla-core/docs/curated/grading_config.json
//
// This cron reads that file at run start (Contents API, never CDN), HALTS
// loudly if it is missing/invalid/non-normalized, and echoes config_version +
// config sha into every output so each scored snapshot says which rubric
// produced it. Edit the file → next run reflects it. No code change.
//
// ARCHITECTURE — A COMPOSER, NOT A FETCHER (platform doctrine §9.3)
// -----------------------------------------------------------------
// This cron fetches nothing from chain or DEX APIs. It composes org products
// that other crons own:
//   token-catalog/snapshots/current.json      identities, identity scores, pools
//   member-data/tla-snapshot/current.json     per-pool VP, bucket %, staked USD,
//                                             lp_health reserves, take rate, pots
//   member-data/tla-snapshot/pool-status-history.json  real-unit trend window
//   dex-data/{astroport,skeletonswap}/weekly-avg/      windowed liq+vol with
//                                             snapshots_used/expected/has_gaps
//   tla-voting/pd-bribes/current.json         PD support attribution
//   network-and-prices/current.json           canonical prices (pot valuation)
//   docs/curated/acquisition_guides.json      guide presence for B1
//
// THE MODEL (SPEC §3)
// -------------------
//   QUALITY = A (trading quality) × B (asset & chain value)   ← "how good"
//   C       = support-gap OVERLAY, bucket-aware               ← "needs you"
//   STATES  = new / inactive / provisional / insufficient — never a fake grade
//
// Anti-gaming: A grades on epoch-aligned trailing windows of the dex-data
// averages, gated by snapshots_used/expected. Below the config ratio → the
// grade is PROVISIONAL, visibly. A metric with no trustworthy source is null
// and its weight renormalizes (SkeletonSwap volume; single-asset depth) —
// never fabricated.
//
// OUTPUT — tla-core `lp-grades` module (module/product/files layout):
//   lp-grades/snapshots/current.json    all pools, sub-scores, grades, overlay,
//                                       states, confidence, lenses (from config)
//   lp-grades/snapshots/heartbeat.json  standard heartbeat (system-health reads)
//   lp-grades/epochs/{epoch}.json       write-once per-epoch archive (grade
//                                       history accrues; never overwritten)
//
// GATE MODE (mock gate law): set LOCAL_DATA_DIR=/path/to/tla-core checkout →
// all reads come from disk, all publishes write to ./gate-out/. The gate runs
// the REAL compute end-to-end on REAL production data — no stub math.
//
// Render: service root platform-crons/lp-grades, build `npm i`, start
//   `node lp-grades.js`, env GITHUB_TOKEN (scoped to thealliancedao/tla-core),
//   optional GITHUB_REPO / GITHUB_BRANCH. Daily, suggested 23:15 UTC (after
//   dex-data ~22:01 and tla-snapshot hourly :01 so all inputs are same-day).
// =============================================================================

'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');

const VERSION = 'lp-grades-1.0.0';
const GITHUB_REPO = process.env.GITHUB_REPO || 'thealliancedao/tla-core';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const LOCAL_DATA_DIR = process.env.LOCAL_DATA_DIR || '';   // gate mode when set
const GATE_OUT_DIR = process.env.GATE_OUT_DIR || './gate-out';

const CONFIG_PATH = 'docs/curated/grading_config.json';

// -----------------------------------------------------------------------------
// GitHub plumbing — Contents API for reads (repo-state reads must be current;
// never the raw CDN), publishFile with fresh-sha retry treating 409/422/5xx as
// retryable (the platform-standard concurrent-writer pattern; 5xx lesson from
// the 2026-07-20 outage and the 2026-08-17 503).
// -----------------------------------------------------------------------------
function githubApiRequest(method, apiPath, body = null, rawMedia = false) {
  return new Promise((resolve, reject) => {
    const opts = { hostname: 'api.github.com', path: apiPath, method,
      headers: { 'User-Agent': `${VERSION}`, 'Authorization': `Bearer ${GITHUB_TOKEN}`,
        // vnd.github.raw sidesteps the ~1MB base64 Contents limit for big inputs
        'Accept': rawMedia ? 'application/vnd.github.raw' : 'application/vnd.github+json' } };
    if (body) opts.headers['Content-Type'] = 'application/json';
    const req = https.request(opts, res => {
      let data = ''; res.on('data', c => data += c);
      res.on('end', () => {
        let parsed = data;
        if (!rawMedia) { try { parsed = JSON.parse(data); } catch {} }
        resolve({ status: res.statusCode, body: parsed, raw: data, sha: res.headers['etag'] || null });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function publishFile(filePath, content, message, maxAttempts = 5) {
  if (LOCAL_DATA_DIR) {   // gate mode: publish = local file write, real code path otherwise
    const out = path.join(GATE_OUT_DIR, filePath);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, content);
    return { gate: true, path: out };
  }
  const apiPath = `/repos/${GITHUB_REPO}/contents/${filePath}`;
  const b64 = Buffer.from(content).toString('base64');
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // (re)fetch current sha EACH attempt — a stale sha must never persist
    let sha = null;
    const getRes = await githubApiRequest('GET', apiPath + `?ref=${GITHUB_BRANCH}`);
    if (getRes.status >= 200 && getRes.status < 300) sha = getRes.body && getRes.body.sha;
    const body = { message, content: b64, branch: GITHUB_BRANCH };
    if (sha) body.sha = sha;
    const putRes = await githubApiRequest('PUT', apiPath, body);
    if (putRes.status >= 200 && putRes.status < 300) return putRes.body;
    if (putRes.status === 409 || putRes.status === 422 || putRes.status >= 500) {
      lastErr = new Error(`GitHub PUT ${filePath}: ${putRes.status} (attempt ${attempt}/${maxAttempts})`);
      await new Promise(r => setTimeout(r, 300 * attempt + Math.floor(Math.random() * 400)));
      continue;
    }
    throw new Error(`GitHub PUT ${filePath}: ${putRes.status} ${String(putRes.raw).slice(0, 200)}`);
  }
  throw lastErr || new Error(`GitHub PUT ${filePath}: failed after ${maxAttempts} attempts`);
}

// fileExists via Contents API — used for the write-once epoch archive
async function repoFileExists(filePath) {
  if (LOCAL_DATA_DIR) return fs.existsSync(path.join(GATE_OUT_DIR, filePath));
  const res = await githubApiRequest('GET', `/repos/${GITHUB_REPO}/contents/${filePath}?ref=${GITHUB_BRANCH}`);
  return res.status >= 200 && res.status < 300;
}

// -----------------------------------------------------------------------------
// Input readers — local fs in gate mode, Contents API (raw media) in prod.
// A missing REQUIRED input halts the run (grading on partial inputs would
// silently skew every score); optional inputs degrade to null honestly.
// -----------------------------------------------------------------------------
async function readRepoText(relPath, { required = true } = {}) {
  if (LOCAL_DATA_DIR) {
    const p = path.join(LOCAL_DATA_DIR, relPath);
    if (!fs.existsSync(p)) { if (required) throw new Error(`REQUIRED input missing (local): ${relPath}`); return null; }
    return fs.readFileSync(p, 'utf8');
  }
  const res = await githubApiRequest('GET', `/repos/${GITHUB_REPO}/contents/${relPath}?ref=${GITHUB_BRANCH}`, null, true);
  if (res.status === 404) { if (required) throw new Error(`REQUIRED input missing: ${relPath}`); return null; }
  if (res.status < 200 || res.status >= 300) throw new Error(`read ${relPath}: HTTP ${res.status}`);
  return res.raw;
}
async function readRepoJson(relPath, opts) {
  const t = await readRepoText(relPath, opts);
  return t == null ? null : JSON.parse(t);
}

// minimal CSV parser handling quoted fields (dex-data pool names carry quotes)
function parseCsv(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells = []; let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQ) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; } else cur += ch; }
      else if (ch === '"') inQ = true;
      else if (ch === ',') { cells.push(cur); cur = ''; }
      else cur += ch;
    }
    cells.push(cur);
    rows.push(cells);
  }
  const header = rows.shift();
  return rows.map(r => Object.fromEntries(header.map((h, i) => [h, r[i]])));
}

// -----------------------------------------------------------------------------
// Config load + the sum-check law: a typo must never silently rescale the world
// -----------------------------------------------------------------------------
function assertWeightsSumTo1(obj, label) {
  const sum = Object.values(obj).filter(v => typeof v === 'number').reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 1.0) > 1e-9) throw new Error(`CONFIG HALT: ${label} weights sum to ${sum}, not 1.0`);
}
function validateConfig(cfg) {
  if (!cfg || !cfg.config_version) throw new Error('CONFIG HALT: missing config_version');
  assertWeightsSumTo1(cfg.quality_grade.component_weights, 'quality_grade.component_weights');
  assertWeightsSumTo1(cfg.trading_quality_A.metric_weights, 'trading_quality_A.metric_weights');
  assertWeightsSumTo1(cfg.asset_chain_value_B.sub_weights, 'asset_chain_value_B.sub_weights');
  assertWeightsSumTo1(cfg.asset_chain_value_B.durability_B1.metric_weights, 'durability_B1.metric_weights');
  if (!Array.isArray(cfg.lenses) || !cfg.lenses.some(l => l.default)) throw new Error('CONFIG HALT: no default lens');
  return cfg;
}

// -----------------------------------------------------------------------------
// Scoring primitives — every curve parameterized from config, nothing hardcoded
// -----------------------------------------------------------------------------
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
function logCurve(v, lo, hi) {
  if (!(v > 0)) return 0;
  if (v <= lo) return 0;
  if (v >= hi) return 100;
  return (Math.log10(v / lo) / Math.log10(hi / lo)) * 100;
}
// weighted mean over [name, score, weight] parts, RENORMALIZING around nulls —
// the honesty rule: a metric with no trustworthy source never counts as zero.
function composeParts(parts) {
  const present = parts.filter(([, v]) => v !== null && v !== undefined && !Number.isNaN(v));
  const wSum = present.reduce((s, [, , w]) => s + w, 0);
  if (!wSum) return { score: null, parts };
  const score = present.reduce((s, [, v, w]) => s + v * (w / wSum), 0);
  return { score, parts };
}
function letterFor(score, bounds) {
  if (score >= bounds.A_plus) return 'A+';
  if (score >= bounds.A) return 'A';
  if (score >= bounds.B) return 'B';
  if (score >= bounds.C) return 'C';
  if (score >= bounds.D) return 'D';
  return 'F';
}

// -----------------------------------------------------------------------------
// B1 helpers — acquisition class derivation (recorded, honest about provenance)
// -----------------------------------------------------------------------------
// The legacy four-class model, derived v1 from token-catalog kind + curated
// guides/overrides. `wrapped` detection: a curated override/warning marking the
// token as bridged, or a symbol carrying a bridge suffix (.axl/.atom/.osmo/
// .inj/.eureka) or a w-prefix over a known major. Derivation is RECORDED per
// token so a wrong class is arguable and overridable, never hidden.
const BRIDGE_SUFFIX_RE = /\.(axl|atom|osmo|inj|eureka|creda(\.[a-z])?|wh)$/i;
function deriveAcquisitionClass(token, overrides, guides) {
  const denom = token.denom;
  const sym = (token.discovered && token.discovered.symbol) || '';
  const ov = overrides && overrides[denom];
  const hasGuide = !!(guides && guides[denom]);
  const looksWrapped = BRIDGE_SUFFIX_RE.test(sym) || /^w(BTC|ETH|BNB|stETH|KWEEN)/i.test(sym)
    || !!(ov && (ov.warning || /bridged|wrapped/i.test(ov.notes || '')));
  let cls;
  if (token.kind === 'cw20' || token.kind === 'native' || token.kind === 'factory') {
    cls = looksWrapped ? 'wrapped_disclosed' : 'native_terra';
  } else if (token.kind === 'ibc') {
    // one-hop cosmos native unless it's a bridged asset riding IBC
    cls = looksWrapped ? (ov && ov.warning ? 'wrapped_looks_native' : 'wrapped_disclosed') : 'ibc_cosmos_native';
  } else cls = 'wrapped_disclosed';
  return { cls, hasGuide, derivation: { kind: token.kind, symbol: sym, looksWrapped, curated_override: !!ov, guide: hasGuide } };
}

// =============================================================================
// MAIN
// =============================================================================
async function main() {
  const startedAt = new Date();
  console.log(`${VERSION} starting ${startedAt.toISOString()} ${LOCAL_DATA_DIR ? '[GATE MODE: ' + LOCAL_DATA_DIR + ']' : ''}`);

  // ---- 1. CONFIG (halt-on-fail; sha echoed into output) ---------------------
  const configText = await readRepoText(CONFIG_PATH);
  const config = validateConfig(JSON.parse(configText));
  const crypto = require('crypto');
  const configSha = crypto.createHash('sha256').update(configText).digest('hex').slice(0, 12);
  console.log(`config ${config.config_version} sha ${configSha} — weights validated`);

  // ---- 2. INPUTS -------------------------------------------------------------
  const tokenCatalog = await readRepoJson('token-catalog/snapshots/current.json');
  const snapshot     = await readRepoJson('member-data/tla-snapshot/current.json');
  const psHistory    = await readRepoJson('member-data/tla-snapshot/pool-status-history.json');
  const pdBribes     = await readRepoJson('tla-voting/pd-bribes/current.json', { required: false });
  const netPrices    = await readRepoJson('network-and-prices/current.json', { required: false });
  const guides       = ((await readRepoJson('docs/curated/acquisition_guides.json', { required: false })) || {}).tokens || {};
  const overridesRaw = (await readRepoJson('docs/curated/token_overrides.json', { required: false })) || {};
  const overrides    = overridesRaw.tokens || overridesRaw;

  const currentEpoch = (snapshot.epoch && snapshot.epoch.currentEpoch) || null;
  if (!currentEpoch) throw new Error('HALT: snapshot carries no currentEpoch');
  const windowEpochs = config.confidence.firm_min_window_epochs;
  // grade on COMPLETED epochs only — the in-progress epoch is exactly the
  // small-snippet gaming surface the spec forbids
  const windowList = [];
  for (let e = currentEpoch - windowEpochs; e <= currentEpoch - 1; e++) windowList.push(e);
  console.log(`epoch ${currentEpoch}; grading window = epochs [${windowList.join(', ')}] (completed only)`);

  // weekly-avg per dex per epoch → per-pool windowed rows
  const weekly = {};   // pool_address -> [{epoch, liq, vol, used, expected, gaps, dex}]
  for (const dex of ['astroport', 'skeletonswap']) {
    for (const ep of windowList) {
      const rel = `dex-data/${dex}/weekly-avg/2026-epoch-${ep}.csv`;
      const text = await readRepoText(rel, { required: false });
      if (!text) { console.log(`  (no ${rel})`); continue; }
      for (const r of parseCsv(text)) {
        const key = r.pool_address;
        (weekly[key] = weekly[key] || []).push({
          epoch: ep, dex,
          liq: parseFloat(r.avg_liquidity_usd || r.avg_tvl_usd || '0') || 0,
          vol: r.total_volume_usd === '' || r.total_volume_usd == null ? null : (parseFloat(r.total_volume_usd) || 0),
          used: parseInt(r.snapshots_used || '0', 10), expected: parseInt(r.snapshots_expected || '0', 10),
          gaps: String(r.has_gaps) === 'true',
        });
      }
    }
  }

  // canonical symbol→usd map for pot valuation (address AND symbol keyed)
  const priceByAddr = {}, priceBySym = {};
  if (netPrices && netPrices.token_prices) {
    for (const [sym, entry] of Object.entries(netPrices.token_prices)) {
      const p = entry && entry.prices;
      const best = p && (p.final || p.astroport || p.tla || p.coingecko);
      const usd = best && (best.price_usd ?? best.usd);
      if (usd == null) continue;
      priceBySym[sym.toUpperCase()] = usd;
      for (const src of Object.values(p)) if (src && src.address) priceByAddr[src.address] = usd;
    }
  }

  // token lookups
  const tokensByDenom = {};
  for (const t of (tokenCatalog.tokens || [])) tokensByDenom[t.denom] = t;
  const tcPoolsByGauge = {};
  for (const p of (tokenCatalog.pools || [])) tcPoolsByGauge[p.gauge_pool_id] = p;
  const snapByGauge = {};
  for (const p of (snapshot.pools || [])) snapByGauge[p.gauge_pool_id] = p;
  const psByGauge = {};
  for (const p of ((psHistory && psHistory.pools) || [])) psByGauge[p.gauge_pool_id] = p;

  // real-unit trend price map from the LATEST window epoch (page-proven rule:
  // deflate both ends with one price set so USD noise can't fake a trend)
  const trendFirstEp = String(windowList[0]), trendLastEp = String(windowList[windowList.length - 1]);
  const px = {};
  for (const p of Object.values(psByGauge)) {
    const ed = p.epochs && p.epochs[trendLastEp];
    if (!ed) continue;
    if (ed.a0_sym && ed.a0_px) px[ed.a0_sym] = ed.a0_px;
    if (ed.a1_sym && ed.a1_px) px[ed.a1_sym] = ed.a1_px;
  }
  const realOf = (ed) => !ed ? 0 : ['a0', 'a1'].reduce((s, k) => s + ((ed[k + '_amt'] || 0) * (px[ed[k + '_sym']] || 0)), 0);

  // pool first-seen epoch (for state:new) from pool-status-history
  const firstSeenByGauge = {};
  for (const [g, p] of Object.entries(psByGauge)) {
    const eps = Object.keys(p.epochs || {}).map(Number).filter(Number.isFinite);
    if (eps.length) firstSeenByGauge[g] = Math.min(...eps);
  }

  // ---- 3. UNIVERSE = token-catalog pools (active AND inactive — the mission) -
  const universe = (tokenCatalog.pools || []).map(tc => ({
    gauge_pool_id: tc.gauge_pool_id, tc,
    snap: snapByGauge[tc.gauge_pool_id] || null,
    ps: psByGauge[tc.gauge_pool_id] || null,
  }));
  console.log(`universe: ${universe.length} pools (token-catalog), ${Object.keys(snapByGauge).length} live in snapshot`);

  // ---- 4. PER-POOL COMPUTE ----------------------------------------------------
  const A = config.trading_quality_A, B = config.asset_chain_value_B, C = config.support_gap_C;
  const rows = [];
  for (const u of universe) {
    const tc = u.tc, snap = u.snap;
    const name = (snap && snap.name) || (u.ps && u.ps.name) || tc.gauge_pool_id;
    const bucket = (snap && snap.bucket) || tc.bucket || null;
    const dex = (snap && snap.dex) || null;
    const dexSub = (snap && snap.dex_subtype) || null;
    const isSingle = (snap && snap.is_single) || tc.pool_kind === 'single_asset';
    const isSS = (dex || '').toLowerCase().includes('skeleton');
    const gaugeActive = tc.gauge_status === 'active' || (snap && snap.status === 'active');

    // ---------- window sample (confidence) ----------
    const wk = (weekly[(snap && snap.pool_address) || ''] || []).filter(r => windowList.includes(r.epoch));
    const usedSum = wk.reduce((s, r) => s + r.used, 0);
    const expSum = wk.reduce((s, r) => s + r.expected, 0);
    const epochsCovered = new Set(wk.map(r => r.epoch)).size;
    const sampleRatio = expSum ? usedSum / expSum : 0;
    const hasGaps = wk.some(r => r.gaps) || epochsCovered < windowList.length;

    // ---------- A: trading quality ----------
    // depth: windowed average liquidity; snapshot depth as fallback marks provisional
    let depthUsd = wk.length ? wk.reduce((s, r) => s + r.liq, 0) / wk.length : null;
    let depthFallback = false;
    if (depthUsd == null && snap && snap.depth_usd > 0) { depthUsd = snap.depth_usd; depthFallback = true; }
    const depthScore = isSingle ? null : (depthUsd == null ? null : logCurve(depthUsd, A.depth.usd_floor, A.depth.usd_full_marks));

    // utilization: Σvol / avg liq per week, averaged across window. Null where
    // volume has no trustworthy source (SS — honest null, renormalizes) or single.
    let utilScore = null, utilRatio = null;
    if (!isSingle && !isSS) {
      const utilPts = wk.filter(r => r.vol != null && r.liq > 0).map(r => r.vol / r.liq);
      if (utilPts.length) {
        utilRatio = utilPts.reduce((a, b) => a + b, 0) / utilPts.length;
        utilScore = clamp((utilRatio / A.utilization.full_marks_weekly_turnover) * 100, 0, 100);
      }
    }

    // trend: real units across the window from pool-status-history
    let trendPct = null, trendScore = null;
    if (u.ps) {
      const f = realOf(u.ps.epochs && u.ps.epochs[trendFirstEp]);
      const l = realOf(u.ps.epochs && u.ps.epochs[trendLastEp]);
      if (f > 1000) {
        trendPct = (l - f) / f * 100;
        trendScore = clamp(A.trend.flat_score + trendPct * A.trend.points_per_pct, 0, 100);
      }
    }

    // exit slippage: worst-direction xyk impact at config sizes from per-side USD.
    // Concentrated/stable真 impact is LOWER by design → score on the bound, flagged.
    let slipScore = null, slipBound = false, slipWorstPct = null;
    const lh = snap && snap.lp_health;
    if (!isSingle && lh && lh.asset_0 && lh.asset_1 && lh.asset_0.usd_value > 0 && lh.asset_1.usd_value > 0) {
      slipBound = dexSub === 'concentrated' || dexSub === 'stable';
      const sizes = A.exit_slippage.trade_sizes_usd;
      const sideMin = Math.min(lh.asset_0.usd_value, lh.asset_1.usd_value);
      const perSize = sizes.map(sz => sz / (sideMin + sz) * 100);   // worst direction
      // score each size on the config impact curve, average
      const b = A.exit_slippage.impact_grade_bounds_pct;
      const sScores = perSize.map(pct => pct <= b.full_marks_under ? 100
        : pct >= b.zero_at ? 0
        : (1 - (Math.log10(pct / b.full_marks_under) / Math.log10(b.zero_at / b.full_marks_under))) * 100);
      slipScore = sScores.reduce((a, x) => a + x, 0) / sScores.length;
      slipWorstPct = perSize[perSize.length - 1];
    }

    // pool balance
    let balScore = null, sidePcts = null;
    if (!isSingle && lh && Array.isArray(lh.balance_ratio_pct)) {
      sidePcts = lh.balance_ratio_pct;
      const minSide = Math.min(...sidePcts);
      const [lo, hi] = A.pool_balance.full_marks_side_pct_range;
      balScore = minSide >= lo && Math.max(...sidePcts) <= hi ? 100
        : minSide <= A.pool_balance.zero_below_side_pct ? 0
        : clamp((minSide - A.pool_balance.zero_below_side_pct) / (lo - A.pool_balance.zero_below_side_pct) * 100, 0, 100);
    }

    const aComposed = composeParts([
      ['depth', depthScore, A.metric_weights.depth],
      ['utilization', utilScore, A.metric_weights.utilization],
      ['trend', trendScore, A.metric_weights.trend],
      ['exit_slippage', slipScore, A.metric_weights.exit_slippage],
      ['pool_balance', balScore, A.metric_weights.pool_balance],
    ]);

    // ---------- B: asset & chain value ----------
    const underlyings = (tc.underlyings || []).map(d => tokensByDenom[d]).filter(Boolean);
    // B1 durability = mean over underlyings of {price_oracle, acquisition, identity}
    let b1Score = null; const b1Tokens = [];
    if (underlyings.length) {
      const per = underlyings.map(t => {
        const match = (t.scoring && t.scoring.identity && t.scoring.identity.match) || 'unknown_state';
        const oracleScore = B.durability_B1.price_oracle_scores[match] ?? B.durability_B1.price_oracle_scores.unknown_state;
        const acq = deriveAcquisitionClass(t, overrides, guides);
        const acqKey = acq.cls === 'native_terra' || acq.cls === 'ibc_cosmos_native' ? acq.cls
          : `${acq.cls}_${acq.hasGuide ? 'with_guide' : 'no_guide'}`;
        const acqScore = B.durability_B1.acquisition_class_scores[acqKey];
        const idScore = (t.scoring && t.scoring.identity && t.scoring.identity.score) ?? null;
        const c = composeParts([
          ['price_oracle', oracleScore, B.durability_B1.metric_weights.price_oracle],
          ['acquisition', acqScore, B.durability_B1.metric_weights.acquisition],
          ['identity_safety', idScore, B.durability_B1.metric_weights.identity_safety],
        ]);
        b1Tokens.push({ denom: t.denom, symbol: (t.discovered || {}).symbol || null, match, acquisition_class: acq.cls, guide: acq.hasGuide, score: c.score == null ? null : Math.round(c.score * 10) / 10 });
        return c.score;
      }).filter(v => v != null);
      if (per.length) b1Score = per.reduce((a, b2) => a + b2, 0) / per.length;
    }

    // B2 asset class — v1 fact bases computable today; bridged-major market cap
    // has NO in-platform source yet → null + flag (renormalizes; upgrade lands
    // with the CG index extension or Stage 3). Honest over fabricated.
    let b2Score = null; const b2Flags = [];
    if (underlyings.length) {
      const per = underlyings.map(t => {
        const acq = deriveAcquisitionClass(t, overrides, guides);
        if (acq.cls === 'native_terra') {
          let s = B.asset_class_B2.native_terra.base_score;
          const sym = ((t.discovered || {}).symbol || '').toUpperCase();
          if (sym === 'SOLID') s += B.asset_class_B2.native_terra.is_native_stablecoin_points;
          if (sym === 'CAPA' || sym === 'ROAR') s += B.asset_class_B2.native_terra.is_governance_token_points;
          return clamp(s, 0, 100);
        }
        if (acq.cls === 'ibc_cosmos_native') return B.asset_class_B2.ibc_infrastructure.fact_base_score;
        b2Flags.push('mcap_source_pending:' + ((t.discovered || {}).symbol || t.denom.slice(0, 12)));
        return null;   // bridged major: mcap not yet sourced — renormalize
      }).filter(v => v != null);
      if (per.length) b2Score = per.reduce((a, b2) => a + b2, 0) / per.length;
    }

    // B3 chain alignment: generated take flow = yearly take rate × staked TVL,
    // per-epoch-ized. Purely factual, from the pool's own on-chain terms.
    let b3Score = null, takeFlowEpochUsd = null;
    const takeRate = (snap && snap.amp_lp && snap.amp_lp.yearly_take_rate) ?? tc.take_rate ?? null;
    const stakedUsd = (snap && snap.staked_in_tla_usd) || 0;
    if (takeRate != null && stakedUsd > 0) {
      takeFlowEpochUsd = takeRate * stakedUsd / 52;
      b3Score = logCurve(takeFlowEpochUsd, B.chain_alignment_B3.flow_floor_usd_per_epoch, B.chain_alignment_B3.flow_full_marks_usd_per_epoch);
    }

    const bComposed = composeParts([
      ['durability_B1', b1Score, B.sub_weights.durability_B1],
      ['asset_class_B2', b2Score, B.sub_weights.asset_class_B2],
      ['chain_alignment_B3', b3Score, B.sub_weights.chain_alignment_B3],
    ]);

    // ---------- quality = A × B ----------
    // Null-by-DESIGN vs null-by-MISSING-DATA (the rule this gate run taught us):
    // singles have no A by nature → their quality is B-only, capped, provisional.
    // A pair pool with NO trading data (typically inactive) must NOT be handed a
    // B-only "quality" grade that outranks measured pools — quality stays null;
    // its B sub-scores still publish as safety/context info.
    const qw = config.quality_grade.component_weights;
    let quality = null;
    if (isSingle) {
      quality = bComposed.score == null ? null : Math.min(bComposed.score, config.caps.single_asset_max_score);
    } else if (aComposed.score != null) {
      quality = composeParts([
        ['trading_quality_A', aComposed.score, qw.trading_quality_A],
        ['asset_chain_value_B', bComposed.score, qw.asset_chain_value_B],
      ]).score;
    }

    rows.push({
      gauge_pool_id: tc.gauge_pool_id, name, bucket, dex, dex_subtype: dexSub,
      lp_address: tc.lp_address || null, pool_address: (snap && snap.pool_address) || null,
      is_single: !!isSingle, is_ss: !!isSS, gauge_status: tc.gauge_status || null, gaugeActive,
      vp: snap ? snap.voting_power.vp_human : (u.ps && u.ps.epochs && u.ps.epochs[String(currentEpoch)] ? u.ps.epochs[String(currentEpoch)].vp_human : 0),
      pct_of_bucket: snap ? snap.voting_power.pct_of_bucket : null,
      staked_usd: stakedUsd, depth_usd: depthUsd, take_rate: takeRate, take_flow_epoch_usd: takeFlowEpochUsd,
      first_seen_epoch: firstSeenByGauge[tc.gauge_pool_id] ?? null,
      sample: { snapshots_used: usedSum, snapshots_expected: expSum, ratio: Math.round(sampleRatio * 1000) / 1000, epochs_covered: epochsCovered, has_gaps: hasGaps, depth_fallback: depthFallback },
      scores: {
        A: { score: aComposed.score, parts: Object.fromEntries(aComposed.parts.map(([n, v]) => [n, v == null ? null : Math.round(v * 10) / 10])), util_weekly_ratio: utilRatio, trend_pct: trendPct == null ? null : Math.round(trendPct * 10) / 10, slip_bound: slipBound, slip_worst_pct: slipWorstPct == null ? null : Math.round(slipWorstPct * 100) / 100 },
        B: { score: bComposed.score, parts: Object.fromEntries(bComposed.parts.map(([n, v]) => [n, v == null ? null : Math.round(v * 10) / 10])), tokens: b1Tokens, flags: b2Flags },
        quality: quality == null ? null : Math.round(quality * 10) / 10,
      },
      snapBribes: (snap && snap.bribes) || null,
    });
  }

  // ---- 5. C OVERLAY — bucket-aware support gap --------------------------------
  const activeRows = rows.filter(r => r.gaugeActive && r.vp > 0);
  const medianRatioByBucket = {};
  for (const b of [...new Set(activeRows.map(r => r.bucket).filter(Boolean))]) {
    const ratios = activeRows.filter(r => r.bucket === b && r.vp > 1 && r.staked_usd > 0)
      .map(r => r.staked_usd / (r.vp / 1e6)).sort((x, y) => x - y);
    medianRatioByBucket[b] = ratios.length ? ratios[Math.floor(ratios.length / 2)] : 0;
  }
  const medVpByBucket = {};
  for (const b of Object.keys(medianRatioByBucket)) {
    const v = activeRows.filter(r => r.bucket === b).map(r => r.vp).sort((x, y) => x - y);
    medVpByBucket[b] = v.length ? v[Math.floor(v.length / 2)] : 0;
  }
  const pdByPool = (pdBribes && pdBribes.by_pool) || {};

  for (const r of rows) {
    const med = medianRatioByBucket[r.bucket] || 0;
    let ratioX = null;
    if (r.vp > 1 && med > 0 && r.staked_usd > 0) ratioX = (r.staked_usd / (r.vp / 1e6)) / med;
    // live pot USD from snapshot active bribes priced via network-and-prices
    let potUsd = 0;
    const act = r.snapBribes && r.snapBribes.active_now;
    if (Array.isArray(act)) {
      for (const b of act) for (const a of (b.assets || [])) {
        const addr = (a.info && (a.info.native || (a.info.cw20))) || null;
        const amt = (parseFloat(a.amount) || 0) / 1e6;
        const usd = addr && priceByAddr[addr] != null ? priceByAddr[addr] : (addr === 'uluna' ? priceBySym['LUNA'] : null);
        if (usd != null) potUsd += amt * usd;
      }
    }
    const pdEntry = pdByPool[r.gauge_pool_id];
    const q = r.scores.quality;
    const needScore = (q != null && ratioX != null && ratioX > 1) ? q * Math.min(ratioX, C.need_score.ratio_cap) : 0;
    const utilPart = r.scores.A.parts.utilization;
    const underdog = r.gaugeActive
      && ((utilPart != null && utilPart >= C.underdog.min_utilization_score) || (r.scores.A.trend_pct != null && r.scores.A.trend_pct > C.underdog.or_min_trend_pct))
      && (medVpByBucket[r.bucket] ? r.vp < medVpByBucket[r.bucket] * C.underdog.max_vp_vs_bucket_median : false)
      && r.staked_usd >= C.underdog.min_staked_usd;
    const bribeTarget = r.gaugeActive && potUsd < C.bribe_target.max_existing_pot_usd && q != null
      && (r.staked_usd >= C.bribe_target.min_staked_usd || (ratioX != null && ratioX >= C.bribe_target.or_min_ratio_vs_median));
    const thresholdRisk = r.gaugeActive && r.pct_of_bucket != null
      && r.pct_of_bucket >= C.threshold_risk.cliff_vote_pct && r.pct_of_bucket < C.threshold_risk.at_risk_below_vote_pct;
    let balanceTag = 'balanced';
    if (ratioX != null && ratioX > C.underpaid_ratio_cutoff) balanceTag = 'underpaid';
    else if (ratioX != null && ratioX < C.overweighted_ratio_cutoff) balanceTag = 'overweighted';
    else if (r.gaugeActive && r.vp <= 1) balanceTag = 'no_support';

    r.overlay = {
      ratio_vs_bucket_median: ratioX == null ? null : Math.round(ratioX * 100) / 100,
      balance: balanceTag,
      need_score: Math.round(needScore * 10) / 10,
      underdog, bribe_target: bribeTarget, threshold_risk: thresholdRisk,
      support: {
        active_pot_usd: Math.round(potUsd * 100) / 100,
        pd_lifetime: pdEntry ? pdEntry.by_denom : null,
        pd_leg_count: pdEntry ? pdEntry.leg_count : 0,
      },
    };
    delete r.snapBribes;
  }

  // ---- 6. STATES + confidence + letters ---------------------------------------
  const cc = config.confidence, st = config.states, gb = config.grade_boundaries;
  for (const r of rows) {
    const age = r.first_seen_epoch != null ? currentEpoch - r.first_seen_epoch : null;
    if (!r.gaugeActive) r.state = 'inactive';           // grade only if its own window data exists
    else if (age != null && age < st.new_pool_below_epochs) r.state = 'new';
    else if (r.scores.quality == null) r.state = 'ungradeable';   // active but no measurable A (and not single)
    else r.state = 'graded';
    let tier;
    if (r.sample.ratio >= cc.firm_min_snapshot_ratio && !r.sample.has_gaps && !r.sample.depth_fallback) tier = 'firm';
    else if (r.sample.ratio >= cc.insufficient_below_ratio) tier = 'provisional';
    else tier = r.is_single ? 'provisional' : 'insufficient';   // singles have no dex sample by design
    r.confidence = { tier, ...r.sample };
    r.grade = (r.state === 'graded' || r.state === 'inactive') && r.scores.quality != null ? letterFor(r.scores.quality, gb) : null;
  }
  rows.sort((a, b) => (b.scores.quality || 0) - (a.scores.quality || 0));

  // ---- 7. OUTPUT ---------------------------------------------------------------
  const out = {
    schemaVersion: 1,
    cron: 'lp-grades',
    version: VERSION,
    capturedAt: startedAt.toISOString(),
    capturedAtUnix: startedAt.getTime(),
    epoch: currentEpoch,
    window_epochs: windowList,
    rubric: { config_version: config.config_version, config_sha: configSha,
      quality_weights: config.quality_grade.component_weights,
      A_weights: config.trading_quality_A.metric_weights,
      B_weights: config.asset_chain_value_B.sub_weights,
      grade_boundaries: gb },
    sources: {
      token_catalog_at: tokenCatalog.meta && tokenCatalog.meta.generated_at || null,
      snapshot_at: snapshot.capturedAt,
      ps_history_at: psHistory && psHistory.generatedAt || null,
      pd_bribes: !!pdBribes, net_prices_at: netPrices && netPrices.capturedAt || null,
    },
    medians: { liquidity_per_1m_vp_by_bucket: medianRatioByBucket, vp_by_bucket: medVpByBucket },
    counts: {
      pools: rows.length,
      graded: rows.filter(r => r.state === 'graded').length,
      new: rows.filter(r => r.state === 'new').length,
      inactive: rows.filter(r => r.state === 'inactive').length,
      ungradeable: rows.filter(r => r.state === 'ungradeable').length,
      firm: rows.filter(r => r.confidence.tier === 'firm').length,
      provisional: rows.filter(r => r.confidence.tier === 'provisional').length,
    },
    lenses: config.lenses,
    pools: rows,
  };

  const heartbeat = {
    schemaVersion: 1, cron: 'lp-grades', capturedAt: out.capturedAt, capturedAtUnix: out.capturedAtUnix,
    runId: `lpg-${out.capturedAtUnix}`, runMode: 'daily', currentEpoch, status: 'ok',
    stats: out.counts, rubric: { config_version: config.config_version, config_sha: configSha },
    next_expected_run_at: new Date(out.capturedAtUnix + 24 * 3600 * 1000).toISOString(),
  };

  console.log('\n=== RESULT SUMMARY ===');
  console.log(JSON.stringify(out.counts));
  for (const r of rows.slice(0, 12)) {
    console.log(`  ${String(r.grade || '—').padEnd(2)} q=${String(r.scores.quality ?? '—').padStart(5)} [${r.confidence.tier[0]}] ${r.state.padEnd(10)} ${r.bucket || '?'} ${r.name} (A=${r.scores.A.score == null ? '—' : Math.round(r.scores.A.score)}, B=${r.scores.B.score == null ? '—' : Math.round(r.scores.B.score)}, need=${r.overlay.need_score})`);
  }

  await publishFile('lp-grades/snapshots/current.json', JSON.stringify(out, null, 1), `lp-grades ${VERSION} epoch ${currentEpoch} (rubric ${config.config_version}/${configSha})`);
  await publishFile('lp-grades/snapshots/heartbeat.json', JSON.stringify(heartbeat, null, 2), `lp-grades heartbeat`);
  // write-once epoch archive — grade history accrues, never overwritten
  const epRel = `lp-grades/epochs/${currentEpoch}.json`;
  if (!(await repoFileExists(epRel))) {
    await publishFile(epRel, JSON.stringify(out, null, 1), `lp-grades epoch ${currentEpoch} archive (write-once)`);
    console.log(`epoch archive written: ${epRel}`);
  } else console.log(`epoch archive exists, untouched (write-once): ${epRel}`);

  console.log(`${VERSION} done in ${((Date.now() - out.capturedAtUnix) / 1000).toFixed(1)}s`);
}

main().catch(e => { console.error(`${VERSION} FATAL:`, e.message); process.exit(1); });
