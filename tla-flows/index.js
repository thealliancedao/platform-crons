#!/usr/bin/env node
// =============================================================================
// org-tla-flows — TLA LP flow event capture (deposits / withdrawals / claims
// + entry/exit slippage), forward cron.
//
// Render job: org-tla-flows · schedule: */15 * * * * · entry: index.js
// Spec context: PROJECT_KNOWLEDGE "TLA LP-flow event capture" + review of
// 2026-07-08. Storage per TLA-CORE-STORAGE-DESIGN (corrected 2026-07-08):
//   tla-core/tla-flows/events/
//     heartbeat.json  index.json  cursor.json
//     {YYYY}/{MM}.json          ← monthly JSON arrays, chain-ordered
//
// Write pattern (EVENT product law): scan [cursor+1, head] → classify →
// read touched month files → merge DEDUPED BY TXHASH → never-shrink guard →
// publish months → index → CURSOR LAST (only if every contract scan was
// complete) → heartbeat. A crash re-reads the unmoved window; merge-dedupe
// absorbs the overlap. Page-capped / stuck scans report status "partial" and
// DO NOT advance the cursor (F7).
//
// Retention honesty: public nodes retain ~1 week of tx index. If the cursor
// has fallen further behind than RETENTION_BLOCKS, the unrecoverable span is
// recorded in known_gaps (with precise heights) and the cursor moves on —
// never papered over, never stuck.
//
// The CLASSIFIER block below carries <<FLOWS CLASSIFIER v1>> markers and must
// stay BYTE-IDENTICAL with the flows-fill derive's copy
// (tla-core/.github/scripts/tla-flows/) once that ships. Verify with a plain
// diff after any change. Classification logic is the Rev A.3 parser, verified
// 42/42 on live compounder data + 8 hand-captured variations; the shell adds
// only a code!==0 skip (FCD-sourced fills include failed txs).
//
// Env (Render): GITHUB_TOKEN (scoped to tla-core), GITHUB_REPO
// (default thealliancedao/tla-core), GITHUB_BRANCH (main), LCD_PRIMARY /
// LCD_FALLBACK, MAX_PAGES (60), PAGER_* knobs, TLA_START_HEIGHT (first-run
// override), TLA_LOOKBACK (first-run window, blocks), RETENTION_BLOCKS.
// =============================================================================

'use strict';

const https = require('https');
const C = require('../config/contracts.js');

// ----------------------------------------------------------------------------- constants
const TERRA_LCD_PRIMARY  = process.env.LCD_PRIMARY  || 'https://terra-lcd.publicnode.com';
const TERRA_LCD_FALLBACK = process.env.LCD_FALLBACK || 'https://terra-rest.publicnode.com';

const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
const GITHUB_REPO   = process.env.GITHUB_REPO   || 'thealliancedao/tla-core';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const OUT_DIR       = 'tla-flows/events';

const PAGE_LIMIT       = 100;
const MAX_PAGES        = Number(process.env.MAX_PAGES || 60);
const SCHEMA_VERSION   = 1;
const CADENCE_MINUTES  = 15;
const VERSION          = 'org-tla-flows-1.0.0';
const DEFAULT_LOOKBACK = Number(process.env.TLA_LOOKBACK || 1200);      // first-run window (~2h)
const RETENTION_BLOCKS = Number(process.env.RETENTION_BLOCKS || 86400); // ~6 days @ ~14.4k blocks/day

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
        if (x.statusCode >= 200 && x.statusCode < 300) { try { res(JSON.parse(b)); } catch { rej(new Error('bad JSON')); } }
        else rej(new Error(`HTTP ${x.statusCode} ${b.slice(0, 120)}`)); });
    });
    r.on('error', rej); r.setTimeout(t, () => r.destroy(new Error('timeout')));
  });
}
function realGithubApiRequest(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const opts = { hostname: 'api.github.com', path: apiPath, method, headers: { 'User-Agent': 'org-tla-flows', 'Authorization': `Bearer ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github+json' } };
    if (body) opts.headers['Content-Type'] = 'application/json';
    const req = https.request(opts, res => { let data = ''; res.on('data', c => data += c); res.on('end', () => { if (res.statusCode >= 200 && res.statusCode < 300) { try { resolve(JSON.parse(data)); } catch { resolve(data); } } else { const err = new Error(`GitHub ${method} ${apiPath}: ${res.statusCode} ${data.slice(0, 200)}`); err.statusCode = res.statusCode; reject(err); } }); });
    req.on('error', reject); if (body) req.write(JSON.stringify(body)); req.end();
  });
}
const T = { httpGet: realHttpGet, githubApiRequest: realGithubApiRequest, now: () => new Date() };

async function lcdGet(p, label) { try { return await T.httpGet(TERRA_LCD_PRIMARY + p); } catch (e) { try { return await T.httpGet(TERRA_LCD_FALLBACK + p); } catch (e2) { throw new Error(`${label}: both LCDs failed (${e2.message})`); } } }
async function tryGetJson(url, label) { try { return await T.httpGet(url); } catch (e) { console.warn(`  ⚠ ${label} fetch failed (non-fatal): ${e.message}`); return null; } }

// ----------------------------------------------------------------------------- tx_search (resilient ASC pager — verbatim from the proven org engine; F1)
async function fetchAllTxs(conds, label) {
  const RETRIES = +(process.env.PAGER_RETRIES || 40), ROUNDS = +(process.env.PAGER_ROUNDS || 2);
  const ERR_BACKOFF = +(process.env.PAGER_ERR_BACKOFF || 250), PROBE_DELAY = +(process.env.PAGER_PROBE_DELAY || 40);
  const CONTIG_DELTA = 250000, P1_STABLE = 12;
  const txPath = (page) => `/cosmos/tx/v1beta1/txs?query=${encodeURIComponent(conds.join(' AND '))}&order_by=ORDER_BY_ASC&page=${page}&limit=${PAGE_LIMIT}`;
  const out = [], seen = new Set();
  const stats = { calls: 0, pages: 0, regress: 0, far: 0, dup: 0, empty: 0, error: 0, reprobe: 0 };
  let frontier = 0, globalMax = 0, stop = 'complete';
  const scan = (batch) => { let freshMin = Infinity, fresh = 0; for (const tx of batch) { const h = Number(tx.height); if (h > globalMax) globalMax = h; if (!seen.has(tx.txhash)) { fresh++; if (h < freshMin) freshMin = h; } } return { fresh, freshMin }; };
  const commit = (batch) => { let added = 0; for (const tx of batch) { const h = Number(tx.height); if (h > frontier) frontier = h; if (!seen.has(tx.txhash)) { seen.add(tx.txhash); out.push(tx); added++; } } stats.pages++; return added; };

  let best1 = null, noImprove = 0, nonEmpty = 0;
  for (let a = 0; a < RETRIES; a++) {
    stats.calls++;
    let resp; try { resp = await lcdGet(txPath(1), `${label} p1.${a}`); } catch { stats.error++; await sleep(ERR_BACKOFF); continue; }
    const batch = resp?.tx_responses || [];
    if (!batch.length) { stats.empty++; await sleep(ERR_BACKOFF); continue; }
    scan(batch); nonEmpty++;
    const minH = Math.min(...batch.map(t => Number(t.height)));
    if (!best1 || minH < best1.minH) { best1 = { batch, minH }; noImprove = 0; } else { noImprove++; }
    if (nonEmpty >= 3 && noImprove >= P1_STABLE) break;
    await sleep(PROBE_DELAY);
  }
  if (!best1) {
    // Watched-contract windows can legitimately be empty at 15-min cadence —
    // but "empty" and "unreachable" must stay distinct. If every probe ERRORED,
    // that's unreachable → incomplete. If probes succeeded with zero rows,
    // that's a genuinely empty result → complete.
    const unreachable = stats.error > 0 && stats.empty === 0;
    return { txs: [], stop: unreachable ? 'p1-unreachable' : 'clean-end', globalMax: 0 };
  }
  commit(best1.batch);

  for (let page = 2; page < MAX_PAGES; page++) {
    const avg = out.length > 1 ? Math.max(1, (frontier - Number(out[0].height)) / (out.length - 1)) : 1;
    const TIGHT = Math.max(2000, 3 * avg), LOOSE = Math.max(50000, 10 * avg);
    let bestCand = null, rounds = 0;
    do {
      if (rounds > 0) stats.reprobe++;
      for (let a = 0; a < RETRIES; a++) {
        stats.calls++;
        let resp; try { resp = await lcdGet(txPath(page), `${label} p${page}.${a}`); } catch { stats.error++; await sleep(ERR_BACKOFF); continue; }
        const batch = resp?.tx_responses || [];
        if (!batch.length) { stats.empty++; await sleep(ERR_BACKOFF); continue; }
        const { fresh, freshMin } = scan(batch);
        if (fresh === 0) { stats.dup++; await sleep(PROBE_DELAY); continue; }
        if (freshMin < frontier) { stats.regress++; await sleep(PROBE_DELAY); continue; }
        if (freshMin - frontier > CONTIG_DELTA) { stats.far++; await sleep(PROBE_DELAY); continue; }
        if (!bestCand || freshMin < bestCand.freshMin) bestCand = { batch, freshMin };
        if (bestCand.freshMin - frontier <= TIGHT) break;
        await sleep(PROBE_DELAY);
      }
      rounds++;
    } while (frontier < globalMax && rounds < ROUNDS && (!bestCand || bestCand.freshMin - frontier > LOOSE));

    if (bestCand) {
      commit(bestCand.batch);
      if (page === MAX_PAGES - 1) { stop = 'page-cap'; console.warn(`  ⚠ ${label} hit page cap (${MAX_PAGES})`); }
      continue;
    }
    if (frontier >= globalMax) { stop = 'clean-end'; break; }
    stop = `stuck@page${page}`;
    console.warn(`  ⚠ ${label}: STUCK at page ${page} — frontier ${frontier} < globalMax ${globalMax}`);
    break;
  }
  out.sort((a, b) => Number(a.height) - Number(b.height) || (a.txhash < b.txhash ? -1 : 1));
  console.log(`  ${label}: ${out.length} txs | stop=${stop} | pages=${stats.pages} calls=${stats.calls} err=${stats.error}`);
  return { txs: out, stop, globalMax };
}
const SCAN_COMPLETE = (stop) => stop === 'complete' || stop === 'clean-end';

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
const RAW = (file) => `https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_BRANCH}/${OUT_DIR}/${file}?t=${Date.now()}`;

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

  // 1. committed priors
  const cursor = await tryGetJson(RAW('cursor.json'), 'cursor');
  const index  = await tryGetJson(RAW('index.json'),  'index') ||
    { schemaVersion: SCHEMA_VERSION, product: 'tla-flows/events', total_events: 0, by_type: {}, months_present: {}, known_gaps: [], first_date: null, latest_date: null, latest_height: null };
  if (!cursor && index.total_events > 0) {
    // Never-seed rule: priors exist but the cursor is unreachable — abort loudly
    // rather than bootstrapping a shallow window over a real history.
    await publishHeartbeat({ startedAt, status: 'error', errors: [{ step: 'priors', message: 'index has events but cursor.json unreachable' }], note: 'refusing to bootstrap over existing history' });
    throw new Error('cursor unreachable while index shows history — aborting');
  }

  // 2. window
  let head;
  try { head = Number((await lcdGet('/cosmos/base/tendermint/v1beta1/blocks/latest', 'head')).block.header.height); }
  catch (e) { addErr('head', e); await publishHeartbeat({ startedAt, status: 'error', errors }); throw e; }

  let fromH;
  let runMode = 'forward';
  if (cursor && cursor.head_height_at_last_run) fromH = Number(cursor.head_height_at_last_run) + 1;
  else if (process.env.TLA_START_HEIGHT) { fromH = Number(process.env.TLA_START_HEIGHT); runMode = 'backfill'; }
  else { fromH = head - DEFAULT_LOOKBACK; runMode = 'bootstrap'; console.log(`  first run: head ${head}, starting ${DEFAULT_LOOKBACK} blocks back at ${fromH}`); }
  if (fromH > head) {
    console.log(`  no new blocks (cursor ${fromH - 1} >= head ${head})`);
    await publishHeartbeat({ startedAt, status: 'ok', errors, counts: { new_events: 0 }, lastHeights: { cursor: fromH - 1, head }, gaps: index.known_gaps });
    return;
  }

  // 3. retention honesty — record the unrecoverable span, then move on
  const gaps = Array.isArray(index.known_gaps) ? [...index.known_gaps] : [];
  let gapRecorded = null;
  if (runMode === 'forward' && head - fromH > RETENTION_BLOCKS) {
    gapRecorded = {
      from_height: fromH,
      to_height_approx: head - RETENTION_BLOCKS,
      recorded_at: startedAt.toISOString(),
      reason: `cursor fell behind public-node retention (~${RETENTION_BLOCKS} blocks); span likely pruned — archive-node target`,
    };
    gaps.push(gapRecorded);
    console.warn(`  ⚠ retention gap recorded: ${gapRecorded.from_height} → ~${gapRecorded.to_height_approx}`);
  }

  // 4. scan the six contracts
  const seen = new Set(); const records = [];
  let allComplete = true;
  const perContract = {};
  for (const [addr, name] of Object.entries(WATCH)) {
    let res;
    try { res = await fetchAllTxs([`wasm._contract_address='${addr}'`], name); }
    catch (e) { addErr(`scan:${name}`, e); allComplete = false; continue; }
    if (!SCAN_COMPLETE(res.stop)) allComplete = false;
    perContract[name] = { stop: res.stop, txs_seen: res.txs.length };
    let kept = 0;
    for (const txr of res.txs) {
      const h = Number(txr.height);
      if (h < fromH || h > head) continue;                 // client-side window
      if (seen.has(txr.txhash)) continue; seen.add(txr.txhash);
      const rec = classifyFlowTx(txr); if (rec) { records.push(rec); kept++; }
    }
    perContract[name].classified = kept;
  }
  records.sort((a, b) => a.height - b.height || (a.txhash < b.txhash ? -1 : 1));
  const byType = {};
  for (const r of records) byType[r.type] = (byType[r.type] || 0) + 1;
  console.log(`  classified ${records.length} flow events ${JSON.stringify(byType)} | window [${fromH}, ${head}] | complete=${allComplete}`);

  // 5. merge + publish touched months (read → dedupe → never-shrink → publish)
  const byMonth = {};
  for (const r of records) (byMonth[monthKey(r.timestamp)] ||= []).push(r);
  let totalAdded = 0;
  for (const mk of Object.keys(byMonth).sort()) {
    const file = `${mk}.json`;
    const existing = (await tryGetJson(RAW(file), `month ${mk}`)) || [];
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
  if (totalAdded > 0 || gapRecorded) {
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

  // 7. cursor LAST — only on fully complete scans (F7)
  if (allComplete) {
    try {
      await publishFile(`${OUT_DIR}/cursor.json`, {
        schemaVersion: SCHEMA_VERSION,
        head_height_at_last_run: head,
        window_scanned: { from: fromH, to: head },
        updatedAt: startedAt.toISOString(),
      }, `tla-flows cursor @ ${head}`);
    } catch (e) { addErr('publish:cursor', e); allComplete = false; }
  } else {
    console.warn('  ⚠ incomplete scan — cursor NOT advanced (window will be re-read)');
  }

  // 8. heartbeat
  const status = errors.length ? (allComplete ? 'ok' : 'partial') : (allComplete ? 'ok' : 'partial');
  await publishHeartbeat({
    startedAt, status: errors.length && !totalAdded && !allComplete ? 'error' : status, errors, runMode,
    counts: { new_events: totalAdded, classified: records.length, by_type: byType, per_contract: perContract },
    lastHeights: { cursor: allComplete ? head : (cursor ? cursor.head_height_at_last_run : null), head, window_from: fromH },
    gaps,
  });
  console.log(`\n✅ done — +${totalAdded} events, cursor ${allComplete ? `advanced to ${head}` : 'HELD'}\n`);
}

// ----------------------------------------------------------------------------- entry
if (require.main === module) {
  run().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
}
module.exports = { run, classifyFlowTx, flowsExtractCost, flowsAttrs, flowsEventsOf, mergeMonth, monthKey, publishFile, T, WATCH };
