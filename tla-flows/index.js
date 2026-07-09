// =============================================================================
// org-tla-flows — TLA LP flow event capture (deposits / withdrawals / claims
// + slippage receipts), forward cron. Rev C: BLOCK-WALKER engine.
//
// Render job: org-tla-flows · schedule: */15 * * * * · entry: index.js
// Spec: tla-core/docs/pending-changes/SPEC-tla-flows-walker.md
// Storage per TLA-CORE-STORAGE-DESIGN (corrected 2026-07-08):
//   tla-core/tla-flows/events/{heartbeat,index,cursor}.json + {YYYY}/{MM}.json
//
// FORWARD CAPTURE DONE AS FORWARD CAPTURE (platform doctrine): the walker
// reads each new block since its cursor via RPC — /block (timestamp + raw
// txs) and /block_results (per-tx events) — classifies txs that touch the six
// watched contracts, merges into month files (txhash dedupe, never-shrink),
// and advances cursor = last block processed. Cost scales with elapsed time,
// never with node retention. No index scanning, no pagers, no probing.
// (The Rev B tx_search scanner — a backfill species — lives in git history
// and remains the right tool for one-shot catch-up jobs only.)
//
// PHASE-2 DESTINY (approved direction, 2026-07-08): this walker is the seed
// of the platform-wide capture layer — a registry of watched addresses +
// message patterns routing matched txs into per-domain buckets, with other
// crons as consumers, and the future live activity feed on top. Spec'd
// separately; nothing here changes when that lands except the watch table.
//
// Env (Render): GITHUB_TOKEN (required), GITHUB_REPO/GITHUB_BRANCH,
// RPC_PRIMARY / RPC_FALLBACK, WALK_CONCURRENCY (4), MAX_BLOCKS_PER_RUN
// (4000), TLA_LOOKBACK (1200 blocks, first run only).
// =============================================================================

'use strict';

const https = require('https');
const C = require('../config/contracts.js');

// ----------------------------------------------------------------------------- constants
const RPC_PRIMARY  = process.env.RPC_PRIMARY  || 'https://terra-rpc.publicnode.com';
const RPC_FALLBACK = process.env.RPC_FALLBACK || 'https://terra-rpc.polkachu.com';
const crypto = require('crypto');

const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
const GITHUB_REPO   = process.env.GITHUB_REPO   || 'thealliancedao/tla-core';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const OUT_DIR       = 'tla-flows/events';

const SCHEMA_VERSION   = 2;                       // cursor schema: { last_block }
const CADENCE_MINUTES  = 15;
const VERSION          = 'org-tla-flows-2.1.1';   // Rev C.1.1: raw-media reads (>1MB files)
const DEFAULT_LOOKBACK = Number(process.env.TLA_LOOKBACK || 1200);      // first-run depth, blocks (~2h)

// One-contract-one-owner: the six shared custody contracts cover every pool.
// Addresses come from the shared config — never hardcoded (org rule).
const WATCH = {
  [C.COMPOUNDER.addr]:            'compounder',
  [C.STAKING_BUCKETS.stable]:     'staking-stable',
  [C.STAKING_BUCKETS.project]:    'staking-project',
  [C.STAKING_BUCKETS.bluechip]:   'staking-bluechip',
  [C.STAKING_BUCKETS.single]:     'staking-single',
  [C.ZAPPER.addr]:                'zapper',
};

// ----------------------------------------------------------------------------- transport (injectable: the mock harness monkey-patches T.*)
const KEEPALIVE_AGENT = new https.Agent({ keepAlive: true, maxSockets: 1, keepAliveMsecs: 30000 });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function realHttpGet(url, t = 20000) {
  return new Promise((res, rej) => {
    const r = https.get(url, { agent: KEEPALIVE_AGENT, headers: { Accept: 'application/json', Connection: 'keep-alive', 'User-Agent': 'org-tla-flows/1.0' } }, (x) => {
      let b = ''; x.on('data', c => b += c); x.on('end', () => {
        clearTimeout(deadline);
        if (x.statusCode >= 200 && x.statusCode < 300) { try { res(JSON.parse(b)); } catch { rej(new Error('bad JSON')); } }
        else rej(new Error(`HTTP ${x.statusCode} ${b.slice(0, 120)}`)); });
    });
    r.on('error', (e) => { clearTimeout(deadline); rej(e); });
    // idle timeout (socket goes quiet) …
    r.setTimeout(t, () => r.destroy(new Error('idle-timeout')));
    // … AND a hard total deadline. A tarpitting server that trickles bytes never
    // goes idle, so the idle timer alone can hang a run forever (observed on the
    // first live run, 2026-07-08). destroy() fires the 'error' path → retry.
    const deadline = setTimeout(() => r.destroy(new Error(`deadline-${Math.round(t * 2 / 1000)}s`)), t * 2);
    if (deadline.unref) deadline.unref();
  });
}
function realGithubApiRequest(method, apiPath, body, accept) {
  return new Promise((resolve, reject) => {
    const opts = { hostname: 'api.github.com', path: apiPath, method, headers: { 'User-Agent': 'org-tla-flows', 'Authorization': `Bearer ${GITHUB_TOKEN}`, 'Accept': accept || 'application/vnd.github+json' } };
    if (body) opts.headers['Content-Type'] = 'application/json';
    const req = https.request(opts, res => { let data = ''; res.on('data', c => data += c); res.on('end', () => { if (res.statusCode >= 200 && res.statusCode < 300) { try { resolve(JSON.parse(data)); } catch { resolve(data); } } else { const err = new Error(`GitHub ${method} ${apiPath}: ${res.statusCode} ${data.slice(0, 200)}`); err.statusCode = res.statusCode; reject(err); } }); });
    req.on('error', reject); if (body) req.write(JSON.stringify(body)); req.end();
  });
}
const T = { httpGet: realHttpGet, githubApiRequest: realGithubApiRequest, now: () => new Date() };

async function rpcGet(p, label) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try { return await T.httpGet(RPC_PRIMARY + p); } catch (e) { lastErr = e; }
    try { return await T.httpGet(RPC_FALLBACK + p); } catch (e) { lastErr = e; }
    await sleep(300 * attempt);
  }
  throw new Error(`${label}: RPC failed after retries (${lastErr && lastErr.message})`);
}
async function tryGetJson(url, label) { try { return await T.httpGet(url); } catch (e) { console.warn(`  ⚠ ${label} fetch failed (non-fatal): ${e.message}`); return null; } }

// ----------------------------------------------------------------------------- block walker primitives
const PRUNED = Symbol('pruned');
function isPrunedError(e) { return /not available|is not available|lowest height|pruned/i.test(String(e && e.message || e)); }

async function getHead() {
  const s = await rpcGet('/status', 'head');
  return Number(s.result.sync_info.latest_block_height);
}
async function getBlock(N) {
  let r;
  try { r = await rpcGet(`/block?height=${N}`, `block ${N}`); }
  catch (e) { if (isPrunedError(e)) return PRUNED; throw e; }
  if (r.error) { if (isPrunedError(r.error)) return PRUNED; throw new Error(`block ${N}: ${JSON.stringify(r.error).slice(0, 120)}`); }
  const b = r.result.block;
  return { time: String(b.header.time).slice(0, 19) + 'Z', txsB64: b.data.txs || [] };
}
async function getBlockResults(N) {
  const r = await rpcGet(`/block_results?height=${N}`, `block_results ${N}`);
  if (r.error) throw new Error(`block_results ${N}: ${JSON.stringify(r.error).slice(0, 120)}`);
  return r.result.txs_results || [];
}
const txHashOf = (b64) => crypto.createHash('sha256').update(Buffer.from(b64, 'base64')).digest('hex').toUpperCase();

// Only txs touching a watched contract are classified — block data sees the
// whole chain, unlike tx_search; without this gate the classifier's claim
// fallback would capture other protocols (spec D4). Classifier unchanged.
function touchesWatched(events) {
  for (const e of events || []) {
    if (e.type !== 'wasm') continue;
    for (const a of e.attributes || [])
      if (a.key === '_contract_address' && WATCH[a.value]) return true;
  }
  return false;
}

// Binary-search the lowest available block in (lo..hi] after hitting pruning.
async function firstAvailable(lo, hi) {
  let lb = lo, ub = hi, best = hi;
  while (lb <= ub) {
    const mid = Math.floor((lb + ub) / 2);
    if ((await getBlock(mid)) === PRUNED) lb = mid + 1;
    else { best = mid; ub = mid - 1; }
  }
  return best;
}

// Walk [from..to] with a small ordered prefetch window. Returns
// { records, processedTo, gaps } — safe to commit partial progress.
async function walkBlocks(from, to, budgetNote) {
  const CONC = Number(process.env.WALK_CONCURRENCY || 4);
  const records = [], gaps = [];
  let N = from, inFlight = new Map();
  const launch = (h) => { if (h <= to && !inFlight.has(h)) inFlight.set(h, getBlock(h)); };
  for (let h = N; h < N + CONC && h <= to; h++) launch(h);
  let lastLog = Date.now();
  while (N <= to) {
    let blk;
    try { blk = await inFlight.get(N); } catch (e) { inFlight.delete(N); throw Object.assign(e, { atBlock: N }); }
    inFlight.delete(N);
    if (blk === PRUNED) {
      const avail = await firstAvailable(N, to + 1);
      gaps.push({ from_height: N, to_height: avail - 1, recorded_at: T.now().toISOString(), reason: 'blocks pruned on both RPC endpoints' });
      console.warn(`  ⚠ blocks ${N}–${avail - 1} pruned — gap recorded, jumping`);
      for (const k of [...inFlight.keys()]) if (k < avail) inFlight.delete(k);
      N = avail; if (N > to) break;
      for (let h = N; h < N + CONC && h <= to; h++) launch(h);
      continue;
    }
    if (blk.txsB64.length) {
      const results = await getBlockResults(N);
      for (let i = 0; i < blk.txsB64.length; i++) {
        const res = results[i]; if (!res) continue;
        if (!touchesWatched(res.events)) continue;
        const rec = classifyFlowTx({ txhash: txHashOf(blk.txsB64[i]), height: N, timestamp: blk.time, code: res.code || 0, events: res.events });
        if (rec) records.push(rec);
      }
    }
    if (Date.now() - lastLog > 15000) { console.log(`  walked to ${N} (${to - N} to go, ${records.length} flows)`); lastLog = Date.now(); }
    N++; launch(N + CONC - 1);
  }
  return { records, processedTo: to, gaps, note: budgetNote };
}

// =============================================================================
// SHARED CLASSIFIER — this section must stay BYTE-IDENTICAL with the copy in
// tla-core/.github/scripts/tla-flows/ (the flows-fill derive). Any drift must
// show in a plain diff. Marker: <<FLOWS CLASSIFIER v1>>
// =============================================================================
// Rev A.3 parser, verified 42/42 on a live compounder tx_search dump + 8
// hand-captured chainscope variations. Routes on the FIRST flow action so a
// user-facing flow keeps the real user even when the compounder cascades a
// second action under its own address. code!==0 txs are skipped (failed txs
// appear in FCD-sourced fills and on some SDK indexers).

function flowsAttrs(ev) { const o = {}; for (const a of (ev.attributes || [])) if (!(a.key in o)) o[a.key] = a.value; return o; }
function flowsEventsOf(txr) {
  if (Array.isArray(txr.events) && txr.events.length) return txr.events;
  const out = []; for (const log of (txr.logs || [])) for (const e of (log.events || [])) out.push(e); return out;
}
function classifyFlowTx(txr) {
  if (Number(txr.code || 0) !== 0) return null;
  const wasm = flowsEventsOf(txr).filter(e => e.type === 'wasm').map(flowsAttrs);
  let flow = null;
  for (const w of wasm) {
    const act = w.action;
    if (act === 'asset-compounding/stake')        flow = { type: 'deposit',  mechanism: 'amplified',     user: w.user, amount: w.bond_share_adjusted || w.bond_share, unit: 'amplp' };
    else if (act === 'asset-compounding/unstake') flow = { type: 'withdraw', mechanism: 'amplified',     user: w.user, amount: (w.returned || '').split(':').pop(), unit: 'lp' };
    else if (act === 'asset/stake')               flow = { type: 'deposit',  mechanism: 'non_amplified', user: w.user, amount: w.share, unit: 'shares' };
    else if (act === 'asset/unstake')             flow = { type: 'withdraw', mechanism: 'non_amplified', user: w.user, amount: w.share, unit: 'shares' };
    if (flow) break;
  }
  if (!flow) {
    const c = wasm.find(w => /claim/i.test(w.action || ''));
    if (c) flow = { type: 'claim', mechanism: null, user: c.user || c.sender, amount: null, unit: 'rewards' };
  }
  if (!flow) return null;
  const viaZap = wasm.some(w => w.action === 'zapper/create_lp' || w.action === 'zapper/withdraw_lp');
  const cost = flowsExtractCost(wasm);
  return { schemaVersion: 1, txhash: txr.txhash, height: Number(txr.height), timestamp: txr.timestamp,
           type: flow.type, mechanism: flow.mechanism, via_zap: viaZap, user: flow.user || null,
           amount: flow.amount || null, amount_unit: flow.unit, cost,
           raw_actions: [...new Set(wasm.map(w => w.action).filter(Boolean))] };
}
// Entry/exit cost: collect EVERY swap leg (a non-LUNA exit is multi-hop) plus
// any provide_liquidity slippage (imbalanced "Tokens" deposits). Cross-denom
// legs kept raw — the cron records receipt truth; analysis prices the rollup.
function flowsExtractCost(wasm) {
  const swaps = wasm
    .filter(w => w.action === 'swap' && w.offer_amount !== undefined && w.return_amount !== undefined)
    .map(w => {
      const ret = Number(w.return_amount || 0), spr = Number(w.spread_amount || 0), com = Number(w.commission_amount || 0), d = ret + spr + com;
      return { offer_asset: w.offer_asset, offer_amount: w.offer_amount, ask_asset: w.ask_asset,
               return_amount: w.return_amount, spread_amount: w.spread_amount, commission_amount: w.commission_amount,
               maker_fee_amount: w.maker_fee_amount, leg_cost_pct: d > 0 ? +(100 * (spr + com) / d).toFixed(4) : null };
    });
  const prov = wasm.find(w => w.action === 'provide_liquidity' && w.slippage !== undefined);
  const provide_slippage_pct = prov ? +(100 * Number(prov.slippage)).toFixed(4) : null;
  if (!swaps.length && provide_slippage_pct == null) return null;
  return { swaps, provide_slippage_pct };
}
// ============================================================== <<FLOWS CLASSIFIER v1>> END

// ----------------------------------------------------------------------------- GitHub publish (org standard + 409-retry from the proven harvester)
async function publishFile(filePath, contentObj, message) {
  const content = typeof contentObj === 'string' ? contentObj : JSON.stringify(contentObj, null, 2);
  const apiPath = `/repos/${GITHUB_REPO}/contents/${filePath}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    let sha = null;
    try { sha = (await T.githubApiRequest('GET', apiPath + `?ref=${GITHUB_BRANCH}`)).sha; } catch { /* new file */ }
    const body = { message, content: Buffer.from(content).toString('base64'), branch: GITHUB_BRANCH };
    if (sha) body.sha = sha;
    try { return await T.githubApiRequest('PUT', apiPath, body); }
    catch (e) {
      if (e.statusCode === 409 && attempt < 3) { console.warn(`  ⚠ 409 on ${filePath} — re-fetching sha (attempt ${attempt})`); await sleep(400 * attempt); continue; }
      throw e;
    }
  }
}
// Rev C.1: ALL state reads go through the authenticated Contents API — never
// the raw CDN. The CDN serves stale/429 responses under load; on 2026-07-09 a
// 429 on index.json made this cron rebuild the index from empty (month data
// unaffected; metadata clobbered). API reads are authoritative + higher-limit.
async function apiGetJson(file) {
  try {
    // raw media type: Contents API returns EMPTY content for files >1MB
    const d = await T.githubApiRequest('GET', `/repos/${GITHUB_REPO}/contents/${OUT_DIR}/${file}?ref=${GITHUB_BRANCH}`, null, 'application/vnd.github.raw');
    return { ok: true, data: typeof d === 'string' ? JSON.parse(d) : d };
  } catch (e) {
    if (e.statusCode === 404) return { ok: true, data: null };   // genuinely absent
    console.warn(`  ⚠ API read failed for ${file}: ${e.message}`);
    return { ok: false, data: null };                            // UNKNOWN — not absent
  }
}

// ----------------------------------------------------------------------------- heartbeat (tla-core standard)
async function publishHeartbeat(h) {
  const hb = {
    schemaVersion: SCHEMA_VERSION, cron: 'tla-flows', product: 'events', version: VERSION,
    capturedAt: h.startedAt.toISOString(), runId: `tla-flows-${h.startedAt.getTime().toString(36)}`,
    runMode: h.runMode || 'forward', status: h.status, note: h.note || undefined,
    counts: h.counts || {}, last_heights: h.lastHeights || {},
    known_gaps: h.gaps && h.gaps.length ? h.gaps : undefined,
    next_expected_run_at: new Date(h.startedAt.getTime() + CADENCE_MINUTES * 60000).toISOString(),
    error_count: h.errors.length, recent_errors: h.errors.slice(-5),
  };
  try { await publishFile(`${OUT_DIR}/heartbeat.json`, hb, `tla-flows heartbeat ${h.status}`); }
  catch (e) { console.warn(`  ⚠ heartbeat publish failed: ${e.message}`); }
}

// ----------------------------------------------------------------------------- helpers
const monthKey = (ts) => { const [Y, M] = String(ts || '').slice(0, 7).split('-'); return `${Y}/${M}`; };
function mergeMonth(existing, incoming) {
  // dedupe by txhash, chain order, NEVER-SHRINK is checked by the caller
  const byHash = new Map();
  for (const r of existing) byHash.set(r.txhash, r);
  let added = 0;
  for (const r of incoming) if (!byHash.has(r.txhash)) { byHash.set(r.txhash, r); added++; }
  const merged = [...byHash.values()].sort((a, b) => a.height - b.height || (a.txhash < b.txhash ? -1 : 1));
  return { merged, added };
}

// ----------------------------------------------------------------------------- main
async function run() {
  const startedAt = T.now();
  const errors = [];
  const addErr = (step, e) => { errors.push({ step, message: String(e && e.message || e) }); console.error(`  ✗ ${step}: ${e.message || e}`); };
  console.log(`\n🌊 org-tla-flows forward — ${startedAt.toISOString()} (${VERSION})\n`);

  if (!GITHUB_TOKEN) throw new Error('GITHUB_TOKEN missing — refusing to run (no publish target).');

  // 1. committed priors (API reads; fetch-failure ≠ absence — abort, never rebuild)
  const cr = await apiGetJson('cursor.json');
  const ir = await apiGetJson('index.json');
  if (!cr.ok || !ir.ok) {
    await publishHeartbeat({ startedAt, status: 'error', errors: [{ step: 'priors', message: 'state read failed (API) — refusing to run on unknown priors' }] });
    throw new Error('state read failed — aborting rather than risk rebuilding over history');
  }
  const cursor = cr.data;
  const index = ir.data ||
    { schemaVersion: SCHEMA_VERSION, product: 'tla-flows/events', total_events: 0, by_type: {}, months_present: {}, known_gaps: [], first_date: null, latest_date: null, latest_height: null };
  if (!cursor && index.total_events > 0) {
    // Never-seed rule: priors exist but the cursor is unreachable — abort loudly
    // rather than bootstrapping a shallow window over a real history.
    await publishHeartbeat({ startedAt, status: 'error', errors: [{ step: 'priors', message: 'index has events but cursor.json unreachable' }], note: 'refusing to bootstrap over existing history' });
    throw new Error('cursor unreachable while index shows history — aborting');
  }

  // 2. window (cursor = last block processed; schema-2, with schema-1 migration)
  let head;
  try { head = await getHead(); }
  catch (e) { addErr('head', e); await publishHeartbeat({ startedAt, status: 'error', errors }); throw e; }

  let lastBlock = null;
  if (cursor) lastBlock = cursor.last_block != null ? Number(cursor.last_block)
                        : (cursor.head_height_at_last_run != null ? Number(cursor.head_height_at_last_run) : null); // v1 migration
  let fromB, runMode = 'forward';
  if (lastBlock != null) fromB = lastBlock + 1;
  else if (process.env.TLA_START_HEIGHT) { fromB = Number(process.env.TLA_START_HEIGHT); runMode = 'bootstrap'; }
  else { fromB = head - DEFAULT_LOOKBACK; runMode = 'bootstrap'; console.log(`  first run: head ${head}, walking from ${fromB} (${DEFAULT_LOOKBACK} blocks back)`); }
  if (fromB > head) {
    console.log(`  no new blocks (cursor ${fromB - 1} >= head ${head})`);
    await publishHeartbeat({ startedAt, status: 'ok', errors, runMode, counts: { new_events: 0 }, lastHeights: { cursor: fromB - 1, head }, gaps: index.known_gaps });
    return;
  }

  // 3. budget (catch-up is safe partial progress in walker-world)
  const BUDGET = Number(process.env.MAX_BLOCKS_PER_RUN || 4000);
  let toB = head, note;
  if (toB - fromB + 1 > BUDGET) { toB = fromB + BUDGET - 1; note = `catching-up (${head - toB} blocks remain)`; runMode = 'catch-up'; console.log(`  budget: walking ${fromB}–${toB}, ${head - toB} deferred to next run`); }

  // 4. walk
  const gaps = Array.isArray(index.known_gaps) ? [...index.known_gaps] : [];
  let walk;
  let cursorTarget;
  try {
    walk = await walkBlocks(fromB, toB, note);
    cursorTarget = walk.processedTo;
  } catch (e) {
    // mid-walk failure: commit nothing from this run, cursor holds; next run re-walks
    addErr(`walk@${e.atBlock || '?'}`, e);
    await publishHeartbeat({ startedAt, status: 'partial', errors, runMode, counts: { new_events: 0 }, lastHeights: { cursor: fromB - 1, head, failed_at: e.atBlock || null }, gaps });
    console.warn('  ⚠ walk failed — cursor NOT advanced (window will be re-walked)');
    return;
  }
  for (const g of walk.gaps) gaps.push(g);
  const records = walk.records;
  records.sort((a, b) => a.height - b.height || (a.txhash < b.txhash ? -1 : 1));
  const byType = {};
  for (const r of records) byType[r.type] = (byType[r.type] || 0) + 1;
  console.log(`  walked ${fromB}–${cursorTarget}: ${records.length} flow events ${JSON.stringify(byType)}`);
  let allComplete = true;

  // 5. merge + publish touched months (read → dedupe → never-shrink → publish)
  const byMonth = {};
  for (const r of records) (byMonth[monthKey(r.timestamp)] ||= []).push(r);
  let totalAdded = 0;
  for (const mk of Object.keys(byMonth).sort()) {
    const file = `${mk}.json`;
    const mr = await apiGetJson(file);
    if (!mr.ok) { addErr(`month:${mk}`, new Error('month read failed — skipping publish this run')); allComplete = false; continue; }
    const existing = mr.data || [];
    if (!Array.isArray(existing)) { addErr(`month:${mk}`, new Error('existing month file is not an array — refusing to overwrite')); allComplete = false; continue; }
    const { merged, added } = mergeMonth(existing, byMonth[mk]);
    if (merged.length < existing.length) { addErr(`month:${mk}`, new Error(`never-shrink violation: merged ${merged.length} < committed ${existing.length}`)); allComplete = false; continue; }
    if (added === 0) { console.log(`  ${mk}: no new events (all ${byMonth[mk].length} already committed)`); continue; }
    try {
      await publishFile(`${OUT_DIR}/${file}`, JSON.stringify(merged), `tla-flows ${mk}: +${added} (${merged.length} total)`);
      totalAdded += added;
      const [Y, M] = mk.split('/');
      (index.months_present[Y] ||= []).includes(M) || index.months_present[Y].push(M);
      index.months_present[Y].sort();
    } catch (e) { addErr(`publish:${mk}`, e); allComplete = false; }
  }

  // 6. index (never-shrink totals)
  if (totalAdded > 0 || walk.gaps.length) {
    index.schemaVersion = SCHEMA_VERSION;
    index.total_events = (index.total_events || 0) + totalAdded;
    for (const t in byType) index.by_type[t] = (index.by_type[t] || 0) + byType[t];
    if (records.length) {
      const lastTs = records[records.length - 1].timestamp.slice(0, 10);
      const firstTs = records[0].timestamp.slice(0, 10);
      if (!index.first_date || firstTs < index.first_date) index.first_date = firstTs;
      if (!index.latest_date || lastTs > index.latest_date) index.latest_date = lastTs;
      index.latest_height = Math.max(index.latest_height || 0, records[records.length - 1].height);
    }
    index.known_gaps = gaps;
    index.updatedAt = startedAt.toISOString();
    try { await publishFile(`${OUT_DIR}/index.json`, index, `tla-flows index: ${index.total_events} events`); }
    catch (e) { addErr('publish:index', e); allComplete = false; }
  }

  // 7. cursor LAST — walker semantics: advance to the last block actually
  // processed (partial progress is safe; unpublished months block advancement)
  if (allComplete) {
    try {
      await publishFile(`${OUT_DIR}/cursor.json`, {
        schemaVersion: SCHEMA_VERSION,
        last_block: cursorTarget,
        window_walked: { from: fromB, to: cursorTarget },
        updatedAt: startedAt.toISOString(),
      }, `tla-flows cursor @ ${cursorTarget}`);
    } catch (e) { addErr('publish:cursor', e); allComplete = false; }
  } else {
    console.warn('  ⚠ publish failure — cursor NOT advanced (window will be re-walked)');
  }

  // 8. heartbeat
  await publishHeartbeat({
    startedAt, status: allComplete ? 'ok' : 'partial', errors, runMode, note,
    counts: { new_events: totalAdded, classified: records.length, by_type: byType, blocks_walked: cursorTarget - fromB + 1 },
    lastHeights: { cursor: allComplete ? cursorTarget : (lastBlock != null ? lastBlock : null), head, window_from: fromB },
    gaps,
  });
  console.log(`\n✅ done — +${totalAdded} events, cursor ${allComplete ? `advanced to ${cursorTarget}` : 'HELD'}${note ? ' · ' + note : ''}\n`);
}

// ----------------------------------------------------------------------------- entry
if (require.main === module) {
  run().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
}
module.exports = { run, classifyFlowTx, flowsExtractCost, flowsAttrs, flowsEventsOf, mergeMonth, monthKey, publishFile, T, WATCH, txHashOf, touchesWatched };
