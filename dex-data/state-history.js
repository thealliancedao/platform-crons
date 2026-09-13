'use strict';
// =============================================================================
// dex-data / lib / state-history.js — per-epoch pool state from the ARCHIVE node (dex-data 1.4.0)
// =============================================================================
// MOVED 2026-09-13 from tla-core/.github/scripts/dex-state-history/{lib,sample}.js (verbatim logic, no second
// copy — those files are deleted). The duty was born as a backfill Action (104 epochs, 5-hour budget); forward it
// is one epoch a week, which is org-dex-data's business: a folded module after the core snapshots, like
// epochs-astroport / credia-rates. LAW: Actions = one-time, Render = scheduled.
//
// Product: dex-data/state-history/
//   epochs/<epoch>.json  one file per TLA epoch START boundary (write-once; written only when the sample is
//                        COMPLETE = zero transport failures; absent/depth/query answers are recorded honestly per pool)
//   index.json           epoch coverage + the pair registry · cursor.json resume state · heartbeat.json
//
// Per epoch: every pair with a TLA flow event on or before the boundary → {pool:{}} reserves + LP total_share;
// the compounder's per-asset total_lp / total_amplp; the 4 staking buckets' totals; the 5 LST hub ratios.
//
// ARCHIVE DISCIPLINE (binding — PLAN-genesis-walk): endpoint from env only, every log line masked; SERIAL requests
// with REQ_DELAY_MS spacing; 4 attempts on TRANSIENT failures only (a chain answer is never retried); breaker on
// BREAKER_MAX consecutive transport failures; heights from the committed event corpus, refined by ≤ REFINE_MAX
// block reads; public LCD only for one immutable fact (a cw20 LP token's minter).
//
// Isolation: nothing here calls process.exit — fatals THROW (ArchiveFatal) so a failed duty never touches the
// core dex-data run. Skips fast (no archive traffic) when index.json already covers the latest started boundary.
//
// runStateHistory({ readJson, writeJson, fetchJson, env, now, archiveFactory }) — env: ARCHIVE_LCD | ARCHIVE_RPC ·
//   EPOCH_FROM / EPOCH_TO (backfill: set on the Render service + trigger; default = only what is missing) ·
//   REQ_DELAY_MS (150) · REFINE_MAX (8) · TIME_BUDGET_MIN (20) · FORCE (0) · PUBLIC_LCD · STATE_HISTORY=0 disables.

const https = require('https');
const http = require('http');

// ── Contract set (single source: platform-crons config/contracts.js, copied verbatim) ──
const COMPOUNDER = 'terra1zly98gvcec54m3caxlqexce7rus6rzgplz7eketsdz7nh750h2rqvu8uzx';
const DAO_MAIN   = 'terra1sffd4efk2jpdt894r04qwmtjqrrjfc52tmj6vkzjxqhd8qqu2drs3m5vzm'; // any addr works for user_infos totals
const STAKING = {
  stable:   'terra1v399cx9drllm70wxfsgvfe694tdsd9x96p9ha36w7muffe4znlusqswspq',
  project:  'terra1awq6t7jfakg9wfjn40fk3wzwmd57mvrqtt3a39z9rmet7wdjj3ysgw3lpa',
  bluechip: 'terra14mmvqn0kthw6sre75vku263lafn5655mkjdejqjedjga4cw0qx2qlf4arv',
  single:   'terra1qdz5qgafx88kp5mf6m2tah8742g4u5g2cek0m3jrgssexexk7g4qw6e23k',
};
const LST_HUBS = {
  ampLUNA: { hub: 'terra10788fkzah89xrdm27zkj5yvhj9x3494lxawzm5qq3vvxcqz2yzaqyd3enk', query: { exchange_rates: {} }, kind: 'exchange_rates_array' },
  arbLUNA: { hub: 'terra1r9gls56glvuc4jedsvc3uwh6vj95mqm9efc7hnweqxa2nlme5cyqxygy5m', query: { state: {} }, kind: 'state' },
  ampROAR: { hub: 'terra1vklefn7n6cchn0u962w3gaszr4vf52wjvd4y95t2sydwpmpdtszsqvk9wy', query: { state: {} }, kind: 'state' },
  ampCAPA: { hub: 'terra186rpfczl7l2kugdsqqedegl4es4hp624phfc7ddy8my02a4e8lgq5rlx7y', query: { state: {} }, kind: 'state' },
  bLUNA:   { hub: 'terra1l2nd99yze5fszmhl5svyh5fky9wm4nz4etlgnztfu4e8809gd52q04n3ea', query: { state: {} }, kind: 'state' },
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const ms = (iso) => Date.parse(iso);
function num(x) { const n = Number(x); return Number.isFinite(n) ? n : null; }

// ── Masking ────────────────────────────────────────────────────────────────
const SECRETS = [];
function registerSecret(s) { if (!s) return; try { const u = new URL(s); SECRETS.push(s, u.host); } catch { SECRETS.push(s); } }
function mask(s) { s = String(s == null ? '' : s); for (const x of SECRETS) if (x) s = s.split(x).join('[ARCHIVE]'); return s; }
function log(...a) { console.log(...a.map(mask)); }
class ArchiveFatal extends Error {}
function fail(m) { throw new ArchiveFatal(mask(m)); }   // dex-data 1.4.0: throw, never exit — the duty is isolated

// ── HTTP (lifted from tla-flows/archive-walk.js httpGet: redirects, idle + hard deadline) ──
function httpGet(url, headers = {}, t = 25000, hops = 0) {
  return new Promise((res, rej) => {
    const mod = url.startsWith('http:') ? http : https;
    const r = mod.get(url, { headers: { Accept: 'application/json', 'User-Agent': 'tla-dex-state-history/1.0', ...headers } }, (x) => {
      if (x.statusCode >= 301 && x.statusCode <= 308 && x.headers.location && hops < 3) {
        x.resume(); clearTimeout(dl);
        return httpGet(new URL(x.headers.location, url).toString(), headers, t, hops + 1).then(res, rej);
      }
      let b = ''; x.on('data', c => b += c); x.on('end', () => { clearTimeout(dl);
        if (x.statusCode >= 200 && x.statusCode < 300) { try { res(JSON.parse(b)); } catch { rej(Object.assign(new Error('bad JSON'), { statusCode: x.statusCode })); } }
        else rej(Object.assign(new Error(`HTTP ${x.statusCode} ${b.slice(0, 160)}`), { statusCode: x.statusCode, body: b.slice(0, 400) })); });
    });
    r.on('error', (e) => { clearTimeout(dl); rej(e); });
    r.setTimeout(t, () => r.destroy(new Error('idle-timeout')));
    const dl = setTimeout(() => r.destroy(new Error('deadline')), t * 2); if (dl.unref) dl.unref();
  });
}

// ── Protobuf (only what abci_query SmartContractState needs) ──────────────
function varint(n) { const o = []; while (n > 127) { o.push((n & 127) | 128); n >>>= 7; } o.push(n); return Buffer.from(o); }
function pbBytes(field, buf) { return Buffer.concat([Buffer.from([(field << 3) | 2]), varint(buf.length), buf]); }
function encodeSmartReq(addr, queryObj) { return Buffer.concat([pbBytes(1, Buffer.from(addr, 'utf8')), pbBytes(2, Buffer.from(JSON.stringify(queryObj), 'utf8'))]); }
function decodeSmartResp(b64) { // QuerySmartContractStateResponse { bytes data = 1 }
  const b = Buffer.from(b64, 'base64'); if (!b.length) return null;
  let i = 0; if (b[i++] !== 0x0a) throw new Error('unexpected proto tag ' + b[0]);
  let len = 0, shift = 0; for (;;) { const c = b[i++]; len |= (c & 127) << shift; if (!(c & 128)) break; shift += 7; }
  return JSON.parse(b.slice(i, i + len).toString('utf8'));
}

// ── Error classes ───────────────────────────────────────────────────────────
//   'absent' — contract did not exist at that height (expected for pools born later)
//   'depth'  — node has no state for that height
//   'query'  — contract rejected the message (wrong shape for that code version)
//   'net'    — transport failure after retries (the ONLY class that is retried / resampled)
const CHAIN_ANSWER_RE = /codespace|no such contract|not found|failed to load state|version does not exist|Error parsing|unknown variant|invalid height|lowest height/i;
function classify(text) {
  const t = String(text);
  if (/failed to load state|height .*not available|pruned|no version|version does not exist|invalid height|cannot query with height|lowest height|is not available/i.test(t)) return { class: 'depth', msg: t.slice(0, 160) };
  if (/no such contract|contract: not found|not found: contract|unknown contract|contract not found|address .* not found/i.test(t)) return { class: 'absent', msg: t.slice(0, 160) };
  return { class: 'query', msg: t.slice(0, 160) };
}

// ── The archive client ─────────────────────────────────────────────────────
function makeArchive({ lcd, rpc, reqDelayMs = 150, breakerMax = 5 }) {
  lcd = String(lcd || '').replace(/\/+$/, ''); rpc = String(rpc || '').replace(/\/+$/, '');
  registerSecret(lcd); registerSecret(rpc);
  if (!lcd && !rpc) fail('set repo secret ARCHIVE_LCD (cosmos REST, preferred) or ARCHIVE_RPC (Tendermint 26657)');
  const transport = lcd ? 'lcd' : 'rpc';
  const stats = { archive_requests: 0, archive_retries: 0, started: Date.now() };
  let streak = 0;
  function breaker(ok) { if (ok) { streak = 0; return; } if (++streak >= breakerMax) fail(`${breakerMax} consecutive transport failures — stopping rather than hammering a node that is not answering`); }
  async function get(url, headers) {
    let last;
    for (let a = 1; a <= 4; a++) {
      stats.archive_requests++;
      try { const r = await httpGet(url, headers); await sleep(reqDelayMs); return r; }
      catch (e) {
        last = e; const sc = e.statusCode;
        const chainAnswer = CHAIN_ANSWER_RE.test(e.body || e.message || '');
        if (sc && sc !== 429 && !(sc === 403 && /rate/i.test(e.message)) && (sc < 500 || chainAnswer)) { e.chainAnswer = true; throw e; }
        stats.archive_retries++; await sleep(400 * a * a);
      }
    }
    throw last;
  }
  async function smartAt(addr, queryObj, height) {
    try {
      if (transport === 'lcd') {
        const q = encodeURIComponent(Buffer.from(JSON.stringify(queryObj)).toString('base64'));
        const r = await get(`${lcd}/cosmwasm/wasm/v1/contract/${addr}/smart/${q}`, { 'x-cosmos-block-height': String(height) });
        breaker(true); return { ok: true, data: r.data };
      }
      const data = '0x' + encodeSmartReq(addr, queryObj).toString('hex');
      const r = await get(`${rpc}/abci_query?path=${encodeURIComponent('"/cosmwasm.wasm.v1.Query/SmartContractState"')}&data=${data}&height=${height}&prove=false`);
      const resp = r && r.result && r.result.response;
      if (!resp) { breaker(false); return { ok: false, class: 'net', msg: 'no response object' }; }
      breaker(true);
      if (Number(resp.code) !== 0) return { ok: false, ...classify(resp.log || resp.info || `code ${resp.code}`) };
      return { ok: true, data: decodeSmartResp(resp.value) };
    } catch (e) {
      if (e.chainAnswer) { breaker(true); return { ok: false, ...classify(e.body || e.message || '') }; }
      breaker(false); return { ok: false, class: 'net', msg: mask(e.message).slice(0, 160) };
    }
  }
  async function blockTime(height) {
    if (transport === 'lcd') { const r = await get(`${lcd}/cosmos/base/tendermint/v1beta1/blocks/${height}`); return r.block.header.time; }
    const r = await get(`${rpc}/block?height=${height}`); return r.result.block.header.time;
  }
  return { transport, stats, smartAt, blockTime, reqDelayMs };
}

// ── Committed inputs: epoch table, snapshot, event corpus (anchors + pool set) ──
function buildCorpus({ epochTable, snapshot, eventMonths }) {   // 1.4.0: inputs fetched by the caller (was loadCorpus(ROOT) on a checkout)
  const anchors = []; const poolSeen = new Map();
  for (const events of eventMonths) for (const e of events) {
    if (e.height && e.timestamp) anchors.push([ms(e.timestamp), Number(e.height)]);
    if (e.pool) { const s = poolSeen.get(e.pool) || { n: 0, first: e.timestamp, last: e.timestamp }; s.n++; if (e.timestamp < s.first) s.first = e.timestamp; if (e.timestamp > s.last) s.last = e.timestamp; poolSeen.set(e.pool, s); }
  }
  anchors.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return { epochTable, snapshot, anchors, poolSeen };
}

// ── Target set: every pool that ever appears in events → what to query ─────
async function buildTargets(corpus, { publicLcd, reqDelayMs = 150, stats = {}, getJson = httpGet }) {
  const lpToPair = new Map(), pairMeta = new Map();
  for (const p of corpus.snapshot.pools || []) {
    if (p.lp_address && p.pool_address) lpToPair.set(p.lp_address, { pair: p.pool_address, name: p.name, dex: p.dex, bucket: p.bucket });
    if (p.pool_address) pairMeta.set(p.pool_address, { name: p.name, dex: p.dex, bucket: p.bucket });
  }
  async function minterOf(lp) { // immutable fact; public LCD; not the archive
    stats.public_requests = (stats.public_requests || 0) + 1;
    const q = encodeURIComponent(Buffer.from(JSON.stringify({ minter: {} })).toString('base64'));
    try { const r = await getJson(`${publicLcd}/cosmwasm/wasm/v1/contract/${lp}/smart/${q}`); await sleep(reqDelayMs); return r.data && r.data.minter || null; }
    catch { return null; }
  }
  const targets = [];
  for (const [key, seen] of corpus.poolSeen) {
    const base = { key, events: seen.n, first: seen.first, last: seen.last };
    if (key.startsWith('cw20:')) {
      const lp = key.slice(5); const m = lpToPair.get(lp);
      if (m) targets.push({ ...base, kind: 'pair', lp, pair: m.pair, name: m.name, dex: m.dex, bucket: m.bucket, pair_via: 'snapshot' });
      else { const pair = await minterOf(lp); const pm = pair && pairMeta.get(pair);
        targets.push(pair ? { ...base, kind: 'pair', lp, pair, name: pm ? pm.name : null, dex: pm ? pm.dex : null, bucket: pm ? pm.bucket : null, pair_via: 'lcd_minter' }
                          : { ...base, kind: 'unresolved', lp, pair: null, name: null, dex: null, bucket: null, pair_via: null }); }
    } else if (/^native:factory\/(terra1[0-9a-z]+)\/uLP$/.test(key)) {
      const pair = key.match(/^native:factory\/(terra1[0-9a-z]+)\/uLP$/)[1]; const pm = pairMeta.get(pair);
      targets.push({ ...base, kind: 'pair', lp: key.slice(7), pair, name: pm ? pm.name : null, dex: pm ? pm.dex : 'Skeleton Swap', bucket: pm ? pm.bucket : null, pair_via: 'factory_denom' });
    } else {
      targets.push({ ...base, kind: 'single', lp: key.slice(7), pair: null, name: (corpus.snapshot.pools || []).find(p => p.gauge_pool_id === key)?.name || null, dex: null, bucket: null, pair_via: null });
    }
  }
  targets.sort((a, b) => b.events - a.events);
  return targets;
}

// ── Epoch boundary → height (anchor bracket + ≤ refineMax block reads) ─────
function bracket(anchors, tMs) {
  let lo = 0, hi = anchors.length - 1, i = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (anchors[m][0] <= tMs) { i = m; lo = m + 1; } else hi = m - 1; }
  return { before: i >= 0 ? anchors[i] : null, after: i + 1 < anchors.length ? anchors[i + 1] : null };
}
async function resolveHeight(corpus, archive, epoch, refineMax = 8) {
  const row = corpus.epochTable.find(r => r.epoch === epoch); if (!row) return { epoch, error: 'epoch not in docs/epoch_1-300_date.json' };
  const T = ms(row.start_time); const { before, after } = bracket(corpus.anchors, T);
  if (!before || !after) return { epoch, start_time: row.start_time, error: 'outside anchor corpus' };
  let lo = [before[1], before[0]], hi = [after[1], after[0]]; let reads = 0; // [height, timeMs]
  while (hi[0] - lo[0] > 1 && reads < refineMax) {
    const frac = (T - lo[1]) / Math.max(1, hi[1] - lo[1]);
    let guess = Math.round(lo[0] + (hi[0] - lo[0]) * Math.min(0.95, Math.max(0.05, frac)));
    if (guess <= lo[0]) guess = lo[0] + 1; if (guess >= hi[0]) guess = hi[0] - 1;
    let t; try { t = ms(await archive.blockTime(guess)); reads++; }
    catch (e) { return { epoch, start_time: row.start_time, height: lo[0], height_time: new Date(lo[1]).toISOString(), delta_sec: Math.round((T - lo[1]) / 1000), block_reads: reads, bracket_blocks: hi[0] - lo[0], note: 'refine aborted: ' + mask(e.message).slice(0, 80) }; }
    if (t <= T) lo = [guess, t]; else hi = [guess, t];
  }
  return { epoch, start_time: row.start_time, height: lo[0], height_time: new Date(lo[1]).toISOString(), delta_sec: Math.round((T - lo[1]) / 1000), block_reads: reads, bracket_blocks: hi[0] - lo[0] };
}

// ── Asset-info normalisation: chain shapes → the event corpus's pool key form ──
function assetKey(info) {
  if (!info || typeof info !== 'object') return null;
  if (info.token && info.token.contract_addr) return 'cw20:' + info.token.contract_addr;
  if (info.native_token && info.native_token.denom) return 'native:' + info.native_token.denom;
  if (typeof info.native === 'string') return 'native:' + info.native;
  if (typeof info.cw20 === 'string') return 'cw20:' + info.cw20;
  return null;
}

// ── Sample one height ─────────────────────────────────────────────────────
// opts.skipBornLater: pairs whose FIRST event is after `boundaryIso` are not queried
// (their state before any TLA deposit values nothing) — recorded under not_sampled.
async function sampleHeight(archive, targets, h, opts = {}) {
  const pairs = targets.filter(t => t.kind === 'pair');
  const out = { height: h, pairs: {}, not_sampled: {}, compounder: null, staking: {}, lst_hubs: {}, tally: { pair_ok: 0, absent: 0, depth: 0, query: 0, net: 0, shape: 0, skipped: 0 } };
  for (const t of pairs) {
    if (opts.skipBornLater && opts.boundaryIso && t.first > opts.boundaryIso) { out.not_sampled[t.key] = 'born_later_per_events'; out.tally.skipped++; continue; }
    const r = await archive.smartAt(t.pair, { pool: {} }, h);
    if (r.ok) {
      const d = r.data || {};
      const assets = Array.isArray(d.assets) ? d.assets.map(a => ({ denom: assetKey(a.info), amount: a.amount == null ? null : String(a.amount) })) : null;
      const total_share = d.total_share == null ? null : String(d.total_share);
      if (!assets || assets.length < 2 || total_share == null || assets.some(a => !a.denom || a.amount == null)) {
        out.pairs[t.key] = { pair: t.pair, ok: false, class: 'shape', msg: 'pool query answered without assets[2]+total_share: keys=' + Object.keys(d).join(',') }; out.tally.shape++;
      } else { out.pairs[t.key] = { pair: t.pair, ok: true, assets, total_share }; out.tally.pair_ok++; }
    } else { out.pairs[t.key] = { pair: t.pair, ok: false, class: r.class, msg: r.msg }; out.tally[r.class] = (out.tally[r.class] || 0) + 1; }
  }
  // asset-compounder: asset_configs (which assets exist at h) → user_infos totals per gauge = the amplified rate
  const cfg = await archive.smartAt(COMPOUNDER, { asset_configs: {} }, h);
  if (cfg.ok && Array.isArray(cfg.data)) {
    const byGauge = {}; for (const c of cfg.data) (byGauge[c.gauge] = byGauge[c.gauge] || []).push(c.asset_info);
    const rates = []; const errors = [];
    for (const [g, infos] of Object.entries(byGauge)) {
      const r = await archive.smartAt(COMPOUNDER, { user_infos: { addr: DAO_MAIN, assets: infos.map(i => [g, i]) } }, h);
      if (!r.ok) { errors.push({ gauge: g, class: r.class, msg: r.msg }); if (r.class === 'net') out.tally.net++; continue; }
      for (const e of (r.data || [])) {
        const tl = num(e.total_lp), ta = num(e.total_amplp);
        rates.push({ gauge: g, asset: assetKey(e.asset), total_lp: e.total_lp == null ? null : String(e.total_lp), total_amplp: e.total_amplp == null ? null : String(e.total_amplp), lp_per_amplp: (tl != null && ta) ? tl / ta : null });
      }
    }
    out.compounder = { ok: true, configs: cfg.data.length, rates, errors };
  } else { out.compounder = { ok: false, class: cfg.class, msg: cfg.msg }; if (cfg.class === 'net') out.tally.net++; }
  for (const [b, addr] of Object.entries(STAKING)) {
    const r = await archive.smartAt(addr, { total_staked_balances: {} }, h);
    if (r.ok) out.staking[b] = { ok: true, balances: (Array.isArray(r.data) ? r.data : []).map(x => ({ asset: assetKey(x.asset) || (typeof x.asset === 'string' ? x.asset : null), balance: x.balance == null ? null : String(x.balance) })) };
    else { out.staking[b] = { ok: false, class: r.class, msg: r.msg }; if (r.class === 'net') out.tally.net++; }
  }
  for (const [sym, hub] of Object.entries(LST_HUBS)) {
    const r = await archive.smartAt(hub.hub, hub.query, h);
    if (!r.ok) { out.lst_hubs[sym] = { ok: false, class: r.class, msg: r.msg }; if (r.class === 'net') out.tally.net++; continue; }
    let ratio = null;
    if (hub.kind === 'exchange_rates_array') ratio = num(r.data?.exchange_rates?.[0]?.[1]);
    else if (sym === 'arbLUNA') { const a = num(r.data?.last_exchange_rate), b = num(r.data?.share_exchange_rate); ratio = (a != null && b != null) ? a * b : num(r.data?.exchange_rate); }
    else ratio = num(r.data?.exchange_rate);
    out.lst_hubs[sym] = { ok: true, ratio };
  }
  return out;
}



// ── The duty (was sample.js) ────────────────────────────────────────────────
const VERSION = 'dex-state-history-1.1.0';   // 1.1.0: folded into dex-data (API reads/writes, no git); 1.0.0 was the Action
const OUT = 'dex-data/state-history';
async function runStateHistory({ readJson, writeJson, fetchJson, env = process.env, now = () => new Date(), archiveFactory = makeArchive, publicGet = httpGet }) {
  const t0 = Date.now(); const out = { status: 'skipped', sampled: 0, skipped: 0, incomplete: [], reason: null };
  if (env.STATE_HISTORY === '0') { out.reason = 'STATE_HISTORY=0'; return out; }
  if (!env.ARCHIVE_LCD && !env.ARCHIVE_RPC) { out.reason = 'ARCHIVE_LCD / ARCHIVE_RPC not set on this service'; return out; }
  const FORCE = env.FORCE === '1', REFINE_MAX = Number(env.REFINE_MAX || 8), BUDGET_MS = Number(env.TIME_BUDGET_MIN || 20) * 60000;
  const PUBLIC_LCD = String(env.PUBLIC_LCD || 'https://terra-lcd.publicnode.com').replace(/\/+$/, '');
  // 1. committed inputs (raw reads — public data)
  const epochTable = await fetchJson('docs/epoch_1-300_date.json', 'epoch table');
  const nowIso = now().toISOString();
  const started = epochTable.filter(r => r.start_time <= nowIso); const latestStarted = started[started.length - 1].epoch;
  // 2. fast exit: nothing to do unless a started boundary is missing / incomplete, or a backfill range is set
  const index = await readJson(`${OUT}/index.json`); const cursor = (await readJson(`${OUT}/cursor.json`)) || { schemaVersion: 1, incomplete: [] };
  const have = new Set((index && index.epochs || []).filter(e => e.complete).map(e => e.epoch));
  if (!env.EPOCH_FROM && !env.EPOCH_TO && !FORCE && have.has(latestStarted) && !(cursor.incomplete || []).length) { out.reason = `epoch ${latestStarted} already complete — nothing missing`; return out; }
  // 3. corpus (event months from tla-flows/events, anchors + pool set)
  const snapshot = await fetchJson('member-data/tla-snapshot/current.json', 'tla-snapshot');
  const evIndex = await fetchJson('tla-flows/events/index.json', 'events index');
  const months = []; for (const [y, ms_] of Object.entries(evIndex.months_present || {})) for (const m of ms_) months.push(`${y}/${m}`);
  const eventMonths = []; for (const mo of months.sort()) eventMonths.push(await fetchJson(`tla-flows/events/${mo}.json`, `events ${mo}`));
  const corpus = buildCorpus({ epochTable, snapshot, eventMonths });
  const archive = archiveFactory({ lcd: env.ARCHIVE_LCD, rpc: env.ARCHIVE_RPC, reqDelayMs: Number(env.REQ_DELAY_MS || 150) });
  log(`  ${VERSION} · transport=${archive.transport} · spacing=${archive.reqDelayMs}ms · serial${FORCE ? ' · FORCE' : ''}`);
  const targets = await buildTargets(corpus, { publicLcd: PUBLIC_LCD, reqDelayMs: archive.reqDelayMs, stats: archive.stats, getJson: publicGet });
  const pairs = targets.filter(t => t.kind === 'pair'), unresolved = targets.filter(t => t.kind === 'unresolved');
  log(`  ${corpus.anchors.length} anchors · ${targets.length} pools in events · ${pairs.length} pairs · ${unresolved.length} unresolved`);
  const inSpan = corpus.epochTable.filter(r => ms(r.start_time) > corpus.anchors[0][0] && r.start_time <= nowIso);
  const spanFrom = inSpan[0].epoch, spanTo = inSpan[inSpan.length - 1].epoch;
  const FROM = Number(env.EPOCH_FROM || spanFrom), TO = Number(env.EPOCH_TO || spanTo);
  if (!(FROM >= spanFrom && TO <= spanTo && FROM <= TO)) fail(`epoch range ${FROM}→${TO} outside the resolvable span ${spanFrom}→${spanTo}`);
  const incomplete = new Set(cursor.incomplete || []); let stoppedForBudget = false; out.status = 'ok';
  const readEpoch = async (ep) => readJson(`${OUT}/epochs/${ep}.json`);
  for (let ep = FROM; ep <= TO; ep++) {
    if (Date.now() - t0 > BUDGET_MS) { stoppedForBudget = true; log(`  time budget reached before epoch ${ep} — clean stop (next run resumes)`); break; }
    if (!FORCE && have.has(ep)) { out.skipped++; continue; }                                   // write-once (index says complete)
    const existing = await readEpoch(ep);
    if (existing && existing.complete && !FORCE) { out.skipped++; have.add(ep); continue; }
    const hr = await resolveHeight(corpus, archive, ep, REFINE_MAX);
    if (hr.error) { log(`  epoch ${ep}: ${hr.error}`); continue; }
    const s = await sampleHeight(archive, targets, hr.height, { skipBornLater: true, boundaryIso: hr.start_time });
    const complete = s.tally.net === 0;
    const rec = { schemaVersion: 1, product: OUT, version: VERSION, epoch: ep, start_time: hr.start_time, height: hr.height, height_time: hr.height_time, delta_sec: hr.delta_sec, block_reads: hr.block_reads, resolve_note: hr.note || null,
      sampled_at: now().toISOString(), transport: archive.transport, complete,
      method: { height: 'last block at or before the epoch start_time; bracketed by tla-flows/events anchors, refined by block reads', pairs: '{pool:{}} on the pair contract at height — assets (denom, amount) + total_share; only pairs with a TLA flow event on or before the boundary are queried', compounder: 'asset_configs at height → user_infos totals per gauge; lp_per_amplp = total_lp / total_amplp (the amplified exchange rate)', classes: 'absent = contract not instantiated at height · depth = node has no state at height · query = message rejected · shape = answered without assets+total_share · net = transport (blocks completion)' },
      pairs: s.pairs, not_sampled: s.not_sampled, compounder: s.compounder, staking: s.staking, lst_hubs: s.lst_hubs, tally: s.tally };
    log(`  epoch ${ep} ${hr.start_time.slice(0, 10)} h=${hr.height} (${hr.delta_sec}s, ${hr.block_reads} reads) · pairs ok ${s.tally.pair_ok} · absent ${s.tally.absent} · depth ${s.tally.depth} · query ${s.tally.query} · net ${s.tally.net} → ${complete ? 'COMPLETE' : 'INCOMPLETE (kept, resampled next run)'}`);
    if (complete) { await writeJson(`${OUT}/epochs/${ep}.json`, rec); incomplete.delete(ep); have.add(ep); out.sampled++; }
    else { incomplete.add(ep); if (!existing) await writeJson(`${OUT}/epochs/${ep}.json`, rec); }
    cursor.last_attempted = ep; cursor.incomplete = [...incomplete].sort((a, b) => a - b); cursor.updatedAt = now().toISOString();
    await writeJson(`${OUT}/cursor.json`, cursor);
  }
  // index: coverage from the epoch files we know (existing index rows + what this run wrote/confirmed)
  const rows = new Map((index && index.epochs || []).map(e => [e.epoch, e]));
  for (const ep of [...have, ...incomplete]) { if (rows.has(ep) && rows.get(ep).complete === have.has(ep)) continue; const r = await readEpoch(ep); if (!r) continue;
    rows.set(ep, { epoch: r.epoch, start_time: r.start_time, height: r.height, delta_sec: r.delta_sec, complete: r.complete, pairs_ok: r.tally.pair_ok, absent: r.tally.absent, depth: r.tally.depth, query: r.tally.query, shape: r.tally.shape, net: r.tally.net, skipped: r.tally.skipped, amp_rates: r.compounder && r.compounder.ok ? r.compounder.rates.length : 0, hubs_ok: Object.values(r.lst_hubs || {}).filter(x => x.ok).length }); }
  const epochs = [...rows.values()].sort((a, b) => a.epoch - b.epoch);
  const idx = { schemaVersion: 1, product: OUT, version: VERSION, updatedAt: now().toISOString(), epoch_span: epochs.length ? [epochs[0].epoch, epochs[epochs.length - 1].epoch] : null,
    epochs_complete: epochs.filter(e => e.complete).length, epochs_incomplete: epochs.filter(e => !e.complete).map(e => e.epoch),
    pairs: targets.filter(t => t.kind !== 'single').map(t => ({ key: t.key, kind: t.kind, pair: t.pair, lp: t.lp, name: t.name, dex: t.dex, bucket: t.bucket, pair_via: t.pair_via, events: t.events, first_event: t.first, last_event: t.last })),
    singles: targets.filter(t => t.kind === 'single').map(t => ({ key: t.key, name: t.name, events: t.events, first_event: t.first, last_event: t.last })), epochs };
  await writeJson(`${OUT}/index.json`, idx);
  await writeJson(`${OUT}/heartbeat.json`, { schemaVersion: 1, product: OUT, version: VERSION, capturedAt: now().toISOString(), status: incomplete.size ? 'partial' : 'ok', sampled: out.sampled, skipped: out.skipped, incomplete: [...incomplete], budget_stop: stoppedForBudget, archive_requests: archive.stats.archive_requests, archive_retries: archive.stats.archive_retries, runner: 'org-dex-data (folded, 1.4.0)' });
  out.incomplete = [...incomplete]; out.budget_stop = stoppedForBudget; out.archive_requests = archive.stats.archive_requests;
  return out;
}

module.exports = { VERSION, OUT, ArchiveFatal, COMPOUNDER, DAO_MAIN, STAKING, LST_HUBS, sleep, ms, num, mask, log, fail, httpGet, classify, makeArchive, buildCorpus, buildTargets, resolveHeight, sampleHeight, assetKey, runStateHistory };
