'use strict';
// org-nft-flows 1.5.0 — FORWARD CAPTURE for ONE collection
// 1.5.0 (2026-09-19, B.1): MESSAGE BODIES at walk time — every matched tx's MsgExecuteContract bodies are decoded from the
//   block's tx bytes (lib/tx-body.js, no protobuf library) and archived as `m` on the raw record, the FCD `messages` shape,
//   so Boost list prices, Atrium list denoms and DAODAO unstake token ids classify from the body forward (classify 1.1.6 e).
//   The same decoder serves nft-collections' walk / resolve-msg-bodies from a run-time checkout of this repo (one home).
// 1.4.1 (2026-09-19, D.2): the "USD at the day" rule lives in lib/oracle-usd.js (moved, not copied — the nft-collections
//   derive Action requires the same file from a run-time checkout of this repo; behaviour byte-identical, mock 55/55);
//   by-token rebuild prints a progress line every 20 shards (a full aDAO rebuild is 101 shards of silence otherwise).
// 1.4.0 (2026-09-18): BY-TOKEN SHARDS — <slug>/ledger/by-token/<shard>.json (index.json beside them): every LIVE ledger
//   record of a token (superseded rows excluded), 100 tokens per shard, records verbatim and sorted. The read shape for
//   "open an NFT → its whole on-chain journey" (explorer sheet, app NFT sheet, portfolio cost basis) — one small file per
//   click instead of 20 MB of month files. Rebuilt for the shards touched this run (new records, re-priced records); the
//   first run (no by-token/index.json) or BY_TOKEN_ALL=1 rebuilds every shard, one month in memory at a time; a shard is
//   written only when its content changed. Same folder, same job: adding or removing a collection touches nothing else.
// 1.3.1 (2026-09-18): classify.js 1.1.5 — `launchpad.addresses` (several primary-sale holders; aDAO's three candy machines)
//   and launchpad → distribution wallet = stock returned, not a $0 mint_purchase; every launchpad holder joins the watch set.
//   REPAIR mint-phase-1.1.5 on adao/ledger (1,954 paid mints priced from the oracle, 3,653 stock moves relabeled).
// 1.3.0 (2026-09-18, owner): USD from THE org price oracle (tla-core/price-history/YYYY/MM.json — every catalog symbol,
//   daily since 2022-05, bLUNA carried as LUNA×hub-ratio through CoinGecko's 2024-04 → 2025-09 hole) — the per-collection
//   luna/bluna-usd-daily files and the nearest-day rule are gone; one oracle month in memory per ledger month; basis
//   `price-history:<day> (<src>)`. The 128 bLUNA sales the CoinGecko chart could not price are priced by the oracle.
// 1.2.2 (2026-09-18): sparse USD series (bluna-usd-daily is weekly-ish before mid-2025) price from the NEAREST day within
//   USD_NEAREST_MAX_DAYS (7), labeled on usd_basis "(nearest, Δ3d)"; a row that still cannot be priced gets its usd_reason
//   refreshed (day + gap) instead of the stale no_usd_series text. First adao sweep: 5,751 symbols stamped, 214 priced,
//   the 2023-12 → 2025-08 bLUNA rows waited on this.
// 1.2.1 (2026-09-18): the reprice pass walks EVERY month the ledger index lists (REPRICE_ALL=0 → current + previous only),
//   one month in memory at a time; heartbeat reports months_walked / months_touched. The 2023–2025 bLUNA buy-now repairs
//   (1.1.4) get their USD from bluna-usd-daily on the first run.
// 1.2.0 (2026-09-17): every priced record carries denom_symbol / denom_decimals from THE shared resolver (lib/denom-symbol.js:
//   token-catalog effective layer — no hand map, collection- and venue-agnostic). USD is per SYMBOL: a daily series per priced
//   symbol (LUNA, bLUNA today; any <symbol>-usd-daily.json is picked up), stables 1:1 by catalog symbol, `usd_basis` labels the
//   rule. The reprice pass now also stamps symbols on records that predate the field and fills USD on records written when their
//   denom had no series (the 290 bLUNA buy-now sales of 1.1.4) — labeled usd_repriced_at, never a second formula.
// 1.1.4 (2026-09-14): lib/classify.js reads EVERY venue event in a msg — BBL buy-now (place_bid + settle in one tx) is
//   now a SALE; the first-event-only read had filed every buy-now since 2023 as a verb-less venue release (317 sales).
// 1.1.3 (2026-09-14): same-day sales were never USD-priced — luna-usd-daily runs 1–2 days behind the chain and a record
//   was priced ONCE at write, so a LUNA sale on the current UTC day landed usd:null/usd_reason:luna_usd_daily_missing
//   forever. A re-price pass now runs at the start of every run over the current + previous month files: a record whose
//   only defect is a missing day that the series now has gets its usd filled in and is LABELED (usd_repriced_at). The
//   event itself is never touched; a month file is written only if something changed.
// 1.1.2 (2026-09-14): luna-usd-daily read repointed to nft-collections/adao/snapshots/ (tla-core/nfts/adao was deleted
//   2026-09-13; every run since answered `degraded · luna-usd-daily: HTTP 404` and any LUNA-priced sale would have landed
//   usd:null). New NFTC_RAW base (env NFTC_RAW). Surfaced by system-health 1.0.7's hb_status column.
// 1.1.1 (2026-09-13): GitHub response bodies collected as BYTES — reading an existing raw/forward/<day>.json.gz part was
//   utf8-mangling the gzip → 'incorrect header check' on every run after a collection's 2nd match of a UTC day
//   (tla-locks stuck from 08:45 with a fresh 'failed' heartbeat; mock-run R3 regression added).: Render cron `org-nft-flows-<slug>` (hourly), env COLLECTION=<slug>.
// One service per collection: stop, delete or add a collection without touching the others. Reads the collection's own
// config (nft-collections/<slug>/collection.json capture block + venues.json), walks new blocks from its own cursor,
// and writes only inside its own folder (<slug>/raw/forward, <slug>/ledger, <slug>/nft-flows/heartbeat.json).
// Picks up where the backfill left off; the archive node is never needed again.
//
//   reads  : nft-collections/<slug>/collection.json capture block + venues.json (the registry — the ONLY per-collection input)
//            tla-core/nfts/ledger-cursor.json (global block cursor; first run derives it from each ledger's coverage)
//            nft-collections/adao/snapshots/luna-usd-daily.json (USD at the day — 1.1.2; was tla-core/nfts/adao)
//   walks  : cursor+1 → head-LAG on RPC_PRIMARY (fallback RPC_FALLBACK), /block + /block_results, concurrency 4,
//            MAX_BLOCKS_PER_RUN cap (a long outage catches up over several runs, never one giant run)
//   writes : tla-core/nfts/raw/<collection>/forward/YYYY-MM-DD.json.gz  — every matched tx's events, same {h,x,t,c,e}
//            shape as the backfill parts (write-once per day file: read-merge-write within the day, keyed by txhash)
//            tla-core/nfts/<collection>/ledger/YYYY/MM.json  — classified records merged by recordKey (never-shrink)
//            tla-core/nfts/<collection>/ledger/index.json    — totals, by_kind, months, coverage += forward range
//            tla-core/nfts/ledger-cursor.json, tla-core/nfts/nft-flows/heartbeat.json
//   LAWS   : one classifier (lib/classify.js is BYTE-IDENTICAL to tla-core/.github/scripts/nft-flows/classify.js —
//            diff-gate on every change); raw before ledger (a tx is archived before it is interpreted); write-once /
//            never-shrink; a failed read never advances the cursor; USD null + reason when no series covers the denom.
const https = require('https'), zlib = require('zlib'), crypto = require('crypto');
const { classifyNftTx, buildIndex, recordKey } = require('./lib/classify.js');
const { decodeTxMessages } = require('./lib/tx-body.js');   // 1.5.0
const bodiesOf = (b64) => { try { const m = decodeTxMessages(b64); return m.length ? m : undefined; } catch (e) { return undefined; } };   // a body that will not decode is left out, never guessed (events still classify)
const DS = require('../../lib/denom-symbol.js');   // 1.2.0: THE denom → symbol resolver (token-catalog effective layer), shared by every cron

const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
const GITHUB_REPO   = process.env.GITHUB_REPO   || 'thealliancedao/nft-collections';
const SLUG          = String(process.env.COLLECTION || '').trim();
const TLA_CORE_RAW  = process.env.TLA_CORE_RAW || 'https://raw.githubusercontent.com/thealliancedao/tla-core/main/';
const NFTC_RAW      = process.env.NFTC_RAW     || 'https://raw.githubusercontent.com/thealliancedao/nft-collections/main/';   // 1.1.2: aDAO products live here now
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const RPC_PRIMARY   = process.env.RPC_PRIMARY   || 'https://terra-rpc.publicnode.com';
const RPC_FALLBACK  = process.env.RPC_FALLBACK  || 'https://terra-rpc.polkachu.com';
const CONC          = Number(process.env.WALK_CONCURRENCY || 4);
const MAX_BLOCKS    = Number(process.env.MAX_BLOCKS_PER_RUN || 4000);
const LAG           = Number(process.env.HEAD_LAG || 10);
const PACE_MS       = Number(process.env.PACE_MS || 60);
const DRY           = /^1|true$/i.test(String(process.env.DRY_RUN || ''));
const CURSOR_PATH   = `${SLUG}/ledger/cursor.json`, HB_PATH = `${SLUG}/nft-flows/heartbeat.json`, LEDGER = `${SLUG}/ledger`, RAWF = `${SLUG}/raw/forward`;
const AGENT = new https.Agent({ keepAlive: true, maxSockets: 8 });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const t0 = Date.now(); const errors = [];

// ---------------------------------------------------------------- http / rpc
function httpGet(url, t = 25000) {
  return new Promise((res, rej) => {
    const r = (url.startsWith('http:') ? require('http') : https).get(url, { agent: url.startsWith('http:') ? undefined : AGENT, headers: { Accept: 'application/json', 'User-Agent': 'org-nft-flows/1.0' } }, (x) => {
      let b = ''; x.on('data', c => b += c); x.on('end', () => { if (x.statusCode >= 200 && x.statusCode < 300) { try { res(JSON.parse(b)); } catch { rej(new Error('bad JSON')); } } else rej(new Error(`HTTP ${x.statusCode} ${b.slice(0, 80)}`)); });
    });
    r.on('error', rej); r.setTimeout(t, () => r.destroy(new Error('timeout')));
  });
}
async function rpc(p, label) {
  let last;
  for (let a = 1; a <= 3; a++) {
    for (const base of [RPC_PRIMARY, RPC_FALLBACK]) { try { const r = await httpGet(base + p); await sleep(PACE_MS); return r; } catch (e) { last = e; } }
    await sleep(500 * a);
  }
  throw new Error(`${label}: ${last && last.message}`);
}
const txHashOf = (b64) => crypto.createHash('sha256').update(Buffer.from(b64, 'base64')).digest('hex').toUpperCase();
async function getBlock(N) { const b = await rpc(`/block?height=${N}`, `block ${N}`); return { time: b.result.block.header.time, txsB64: b.result.block.data.txs || [] }; }
async function getBlockResults(N) { const r = await rpc(`/block_results?height=${N}`, `results ${N}`); return (r.result.txs_results || []).map(t => ({ code: t.code || 0, events: t.events || [] })); }
async function getHead() { const s = await rpc('/status', 'status'); return Number(s.result.sync_info.latest_block_height); }

// ---------------------------------------------------------------- github (Contents API; transient retry; 409 merge-retry by re-read)
function ghReqOnce(method, apiPath, body, accept) {
  return new Promise((resolve, reject) => {
    const GA = new URL(process.env.GITHUB_API || 'https://api.github.com');
    const opts = { hostname: GA.hostname, port: GA.port || undefined, path: apiPath, method, headers: { 'User-Agent': 'org-nft-flows', 'Authorization': `Bearer ${GITHUB_TOKEN}`, 'Accept': accept || 'application/vnd.github+json' } };
    if (body) opts.headers['Content-Type'] = 'application/json';
    const req = (GA.protocol === 'http:' ? require('http') : https).request(opts, res => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => { const buf = Buffer.concat(chunks); const d = buf.toString('utf8');   // 1.1.1: bodies collected as BYTES — a raw-media read of a .json.gz part must not be utf8-mangled
      if (res.statusCode >= 200 && res.statusCode < 300) { if (accept) return resolve(buf); try { resolve(JSON.parse(d || '{}')); } catch { resolve(d); } } else { const e = new Error(`GitHub ${res.statusCode} ${apiPath} ${d.slice(0, 120)}`); e.statusCode = res.statusCode; reject(e); } }); });
    req.on('error', reject); if (body) req.write(JSON.stringify(body)); req.end();
  });
}
async function ghReq(method, apiPath, body, accept) {
  let last;
  for (let a = 1; a <= 5; a++) { try { return await ghReqOnce(method, apiPath, body, accept); } catch (e) { last = e; const sc = e.statusCode; const transient = !sc || sc >= 500 || sc === 429 || (sc === 403 && /rate limit/i.test(e.message)); if (!transient) throw e; await sleep(Math.min(20000, 700 * Math.pow(2, a))); } }
  throw last;
}
async function readFile(p) {   // → { data (parsed, gz-aware), sha } | null
  try {
    const meta = await ghReq('GET', `/repos/${GITHUB_REPO}/contents/${p}?ref=${GITHUB_BRANCH}`);
    const raw = await ghReq('GET', `/repos/${GITHUB_REPO}/contents/${p}?ref=${GITHUB_BRANCH}`, null, 'application/vnd.github.raw');   // raw media type: the JSON form blanks content >1MB
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'utf8');   // 1.1.1: raw reads arrive as a Buffer (was Buffer.from(utf8-string,'binary') → gunzip 'incorrect header check' on any existing part)
    const data = p.endsWith('.gz') ? JSON.parse(zlib.gunzipSync(buf)) : JSON.parse(buf.toString('utf8'));
    return { data, sha: meta.sha };
  } catch (e) { if (e.statusCode === 404) return null; throw e; }
}
async function writeFile(p, buf, msg, sha) {
  if (DRY) { console.log(`  [dry] would write ${p} (${buf.length} B)`); return; }
  for (let a = 1; a <= 4; a++) {
    try { await ghReq('PUT', `/repos/${GITHUB_REPO}/contents/${p}`, Object.assign({ message: msg, content: Buffer.from(buf).toString('base64'), branch: GITHUB_BRANCH }, sha ? { sha } : {})); return; }
    catch (e) { if ((e.statusCode === 409 || e.statusCode === 422) && a < 4) { const cur = await readFile(p); sha = cur ? cur.sha : undefined; await sleep(400 * a); continue; } throw e; }
  }
}
const writeJson = (p, obj, msg, sha) => writeFile(p, JSON.stringify(obj, null, 1) + '\n', msg, sha);
const writeGz   = (p, obj, msg, sha) => writeFile(p, zlib.gzipSync(Buffer.from(JSON.stringify(obj)), { level: 9 }), msg, sha);

// ---------------------------------------------------------------- USD at the day (same rule as derive.js)
// 1.3.0 — USD comes from THE org price oracle: tla-core/price-history/YYYY/MM.json (daily USD for every catalog symbol
// since 2022-05, paid CoinGecko backfill once, token-catalog appends daily; bLUNA/ampLUNA carried as LUNA×hub-ratio where
// CoinGecko had no chart). One month file in memory at a time — the same month the ledger sweep is on. No per-collection
// price series, no CoinGecko calls, no second formula: nft-flows prices exactly what the rest of the platform prices.
let RESOLVE = null;                 // denom → { symbol, decimals } from the token-catalog (null until loaded)
let STAMPED = 0;                    // records that received denom_symbol in the reprice pass (heartbeat)
let MONTHS_WALKED = 0, MONTHS_TOUCHED = [];   // 1.2.1: the sweep's footprint, reported on the heartbeat
const TOKENS_DIRTY = new Set();                 // 1.4.0: token ids whose by-token shard must be rebuilt this run
const SHARD_SIZE = 100;                         // tokens per by-token shard (aDAO 10,000 → 100 files; PL 5,000 → 50; TLA locks by lock id)
const shardOf = (id) => { const n = Number(id); return Number.isInteger(n) && n >= 0 ? String(Math.floor(n / SHARD_SIZE)).padStart(3, '0') : 'x'; };   // non-numeric ids share one shard
// 1.4.0 — by-token shards: the ledger re-projected per token. Reads every month once (read → pick the wanted tokens → drop),
// so the heap holds one month plus the shards being rebuilt. Superseded rows never enter a shard (every reader skips them).
async function byTokenDuty() {
  try { const ixf = await readFile(`${LEDGER}/index.json`); if (!ixf || !ixf.data) return { skipped: 'no ledger index' }; const r = await rebuildByToken(ixf.data); console.log(`  by-token: ${r.mode} · ${r.shards_rebuilt} shard(s) rebuilt · ${r.shards_written} written`); return r; }
  catch (e) { errors.push('by-token: ' + e.message); console.warn('  ⚠ by-token: ' + e.message); return { error: e.message }; }
}
async function rebuildByToken(ix) {
  const BYT = `${LEDGER}/by-token`; const ixb = await readFile(`${BYT}/index.json`);
  const all = process.env.BY_TOKEN_ALL === '1' || !ixb || !ixb.data || ixb.data.shard_size !== SHARD_SIZE;
  const wanted = all ? null : new Set([...TOKENS_DIRTY].map(shardOf));
  if (!all && !wanted.size) return { shards_rebuilt: 0, shards_written: 0, records: 0, mode: 'nothing dirty' };
  const buckets = {}; let records = 0;
  for (const mk of (ix.months || [])) {
    const m = await readFile(`${LEDGER}/${mk}.json`); if (!m || !Array.isArray(m.data)) continue;
    for (const r of m.data) { if (r.superseded_by || r.token_id == null) continue; const sh = shardOf(r.token_id); if (wanted && !wanted.has(sh)) continue; ((buckets[sh] ||= {})[String(r.token_id)] ||= []).push(r); records++; }
  }
  const shards = wanted ? [...wanted] : Object.keys(buckets); shards.sort();
  const before = JSON.stringify((ixb && ixb.data && ixb.data.shards) || {}); const meta = JSON.parse(before); let written = 0; const stamp = new Date().toISOString();   // a copy: the write test below compares against what was on main
  let done = 0;
  for (const sh of shards) {
    if (++done % 20 === 0 || done === shards.length) console.log(`  by-token: ${done}/${shards.length} shards${written ? ` (${written} written so far)` : ''}`);   // 1.4.1: a progress line every 20 shards
    const tokens = buckets[sh] || {}; for (const id of Object.keys(tokens)) tokens[id].sort((a, b) => a.height - b.height || a.msg_index - b.msg_index || String(a.kind).localeCompare(String(b.kind)));
    const lo = sh === 'x' ? null : Number(sh) * SHARD_SIZE; const n = Object.values(tokens).reduce((s, l) => s + l.length, 0);
    const body = { product: `${SLUG}/ledger/by-token`, collection: SLUG, shard: sh, shard_size: SHARD_SIZE, range: lo == null ? null : [lo, lo + SHARD_SIZE - 1], tokens_with_records: Object.keys(tokens).length, records: n, note: 'every live ledger record of these tokens (superseded rows excluded), sorted; rebuilt by org-nft-flows when a token in this shard gains or re-prices a record', tokens };
    const p = `${BYT}/${sh}.json`; const ex = await readFile(p);
    const same = ex && ex.data && JSON.stringify(ex.data.tokens) === JSON.stringify(body.tokens);
    meta[sh] = { tokens_with_records: body.tokens_with_records, records: n, updatedAt: same ? (meta[sh] && meta[sh].updatedAt) || stamp : stamp };
    if (same) continue;   // changed-files-only
    await writeJson(p, body, `nft-flows by-token ${SLUG} shard ${sh} (${n} records)`, ex && ex.sha); written++;
  }
  const index = { product: `${SLUG}/ledger/by-token`, collection: SLUG, shard_size: SHARD_SIZE, shard_of: 'floor(token_id / shard_size) zero-padded to 3 · non-numeric ids → "x"', shards: meta, updatedAt: stamp, note: 'read <shard>.json for a token\'s whole on-chain history; written by org-nft-flows (1.4.0), superseded ledger rows never included' };
  if (!ixb || before !== JSON.stringify(meta) || all) await writeJson(`${BYT}/index.json`, index, `nft-flows by-token ${SLUG} index`, ixb && ixb.sha);
  return { shards_rebuilt: shards.length, shards_written: written, records, mode: all ? 'all' : 'dirty' };
}
// 1.4.1 — THE ONE rule, from lib/oracle-usd.js: months fetched from the org oracle, symbols from the catalog resolver.
const OU = require('./lib/oracle-usd.js');
const ORACLE = OU.makeOracle({ fetchMonth: (mk) => httpGet(TLA_CORE_RAW + 'price-history/' + mk + '.json'), resolve: () => RESOLVE });
const monthOf = OU.monthOf;
const loadOracleMonth = (mk) => ORACLE.loadMonth(mk);
const dropOracleMonth = (mk) => ORACLE.dropMonth(mk);   // read → price → drop (Render heap)
const symOf = (denom) => ORACLE.symOf(denom);
// 1.1.3 — re-price pass. Scope: the current and previous UTC month files (a missing day is always recent: the series
// lags the chain by 1–2 days). A record qualifies only when usd is null AND usd_reason is luna_usd_daily_missing:<day>
// AND the series now has <day>. Nothing else on the record changes; the fill is labeled with usd_repriced_at. Returns
// the number of records re-priced (0 when the series is unavailable — a missing series is never a reason to write).
async function repriceMissingDays() {
  if (!ORACLE.anyLoaded() && !RESOLVE) return 0;
  const now = new Date(); const months = [];
  for (const back of [0, 1]) { const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1)); months.push(`${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}`); }
  // 1.2.1: the FULL sweep — every month the ledger index lists, once per run (read → stamp/price → write → drop; the heap
  // never holds two months). Needed once for the 2023–2025 bLUNA buy-now repairs; after that it is a no-op read per month
  // (nothing to stamp, nothing to price), which is the honest way to prove the ledger is fully labeled.
  const REPRICE_ALL = process.env.REPRICE_ALL !== '0';
  if (REPRICE_ALL) { const ixf = await readFile(`${LEDGER}/index.json`); for (const mk of ((ixf && ixf.data && ixf.data.months) || [])) if (!months.includes(mk)) months.push(mk); }
  months.sort();
  let total = 0; MONTHS_WALKED = 0; MONTHS_TOUCHED = [];
  for (const mk of months) {
    const p = `${LEDGER}/${mk}.json`; const ex = await readFile(p); if (!ex || !Array.isArray(ex.data)) continue;
    MONTHS_WALKED++; await loadOracleMonth(mk);
    let changed = 0, stamped = 0; const stamp = new Date().toISOString();
    for (const r of ex.data) {
      if (!r.price) continue;
      // 1.2.0: stamp the symbol on records that predate it (the catalog rule, never a guess) — a label, not a repair
      if (r.denom_symbol === undefined && RESOLVE && DS.stampRecord(r, r.price.denom, symOf)) stamped++;
      // 1.3.0: rows priced by 1.2.x from the per-collection CoinGecko copies (basis luna-/bluna-usd-daily:*) are re-priced
      // from the oracle — the one price everyone else uses; when the number moves the old one is kept beside it.
      if (r.usd != null && typeof r.usd_basis === 'string' && /^(luna|bluna)-usd-daily:/.test(r.usd_basis)) {
        const again = usdAt(r.price, r.ts); if (again.usd == null) continue;
        const moved = Math.abs(again.usd - r.usd) > Math.abs(r.usd) * 5e-3;
        if (moved) { r.usd_prev = r.usd; r.usd_prev_basis = r.usd_basis; }
        Object.assign(r, again); r.usd_repriced_at = stamp; if (moved) changed++; else stamped++; if (r.token_id != null) TOKENS_DIRTY.add(String(r.token_id));   // a relabel is not a repair; 1.4.0: the shard follows either way
        continue;
      }
      if (r.usd != null || typeof r.usd_reason !== 'string') continue;
      // qualifies: a day the series now has (any symbol), or a denom that had no series when written and now has one
      if (!/^(luna_usd_daily_missing|usd_daily_missing|no_usd_series_for_denom|price_history_(missing|not_yet_written|month_missing)):/.test(r.usd_reason)) continue;   // every earlier spelling qualifies
      const again = usdAt(r.price, r.ts);
      if (again.usd == null) { if (again.usd_reason && again.usd_reason !== r.usd_reason) { r.usd_reason = again.usd_reason; stamped++; } continue; }   // 1.2.2: the reason is kept current (day missing + gap), never left stale
      delete r.usd_reason; Object.assign(r, again); r.usd_repriced_at = stamp; changed++; if (r.token_id != null) TOKENS_DIRTY.add(String(r.token_id));   // 1.4.0: its shard is rebuilt
    }
    if (!changed && !stamped) { dropOracleMonth(mk); continue; }
    await writeJson(p, ex.data, `nft-flows reprice ${SLUG} ${mk} (${changed} repriced, ${stamped} symbol-stamped)`, ex.sha);
    console.log(`  repriced ${changed} record(s) in ${p}${stamped ? ` · symbol stamped on ${stamped}` : ''}`); total += changed; STAMPED += stamped; MONTHS_TOUCHED.push(mk);
  }
  for (const mk of ORACLE.loaded()) if (!months.slice(-2).includes(mk)) dropOracleMonth(mk);
  return total;
}
const usdAt = (price, ts) => ORACLE.usdAt(price, ts);   // 1.4.1: lib/oracle-usd.js (the month must be loaded — the caller is on it)

// ---------------------------------------------------------------- main
(async () => {
  if (!GITHUB_TOKEN && !DRY) throw new Error('GITHUB_TOKEN missing — refusing to run (no publish target).');
  if (!SLUG) throw new Error('COLLECTION missing — one service per collection (env COLLECTION=<slug>)');
  const cj = await readFile(`${SLUG}/collection.json`); if (!cj || !cj.data.capture) throw new Error(`${SLUG}/collection.json missing or has no capture block`);
  const vj = await readFile('venues.json'); if (!vj) throw new Error('venues.json missing');
  const R = { venues: vj.data.venues, collections: { [SLUG]: Object.assign({ label: cj.data.name, collection: cj.data.nft_contract, supply: cj.data.supply, kind: cj.data.kind }, cj.data.capture) } };
  const idx = buildIndex(R); const cols = [SLUG];
  // watch set = every collection contract + custodians + launchpads + distributors + every venue (offers/deposits are venue-only records)
  const watchOf = {}; const WATCH = new Set();
  for (const [k, c] of Object.entries(R.collections)) { const s = new Set([c.collection, ...Object.keys(c.custodians || {}), c.distributor, c.launchpad && c.launchpad.address, ...((c.launchpad && c.launchpad.addresses) || []), ...(c.distribution_wallets || [])].filter(Boolean)); watchOf[k] = s; s.forEach(a => WATCH.add(a)); }   // 1.3.1: every launchpad holder is watched
  for (const vk of (R.collections[SLUG].venues || [])) { const v = R.venues[vk]; if (v && v.address) WATCH.add(v.address); }   // only the venues THIS collection lists on
  try { RESOLVE = DS.buildResolver(await httpGet(TLA_CORE_RAW + 'token-catalog/snapshots/current.json')); console.log(`  token-catalog: ${RESOLVE.size} denoms resolvable`); } catch (e) { errors.push('token-catalog: ' + e.message); }   // 1.2.0: symbols from the catalog, never a map
  { const now = new Date(); for (const back of [1, 0]) { const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1)); const mk = `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}`; if (!(await loadOracleMonth(mk))) errors.push('price-history/' + mk + ': unavailable'); } }   // 1.3.0: the oracle months forward capture prices from
  const repriced = await repriceMissingDays();   // 1.1.3: fill USD on records whose day has since arrived in the series

  // cursor: stored, else derived from each ledger's full coverage (min across collections so none is skipped)
  let cur = await readFile(CURSOR_PATH); let cursor = cur && Number(cur.data.height);
  if (!cursor) {
    const ends = [];
    const ix = await readFile(`${LEDGER}/index.json`); const full = ix ? (ix.data.coverage || []).filter(c => !c.partial) : []; if (full.length) ends.push(Math.max(...full.map(c => c.to)));
    if (!ends.length) { const g = Number(R.collections[SLUG].genesis_height); if (g) ends.push(g - 1); }
    if (!ends.length) throw new Error(`no ledger coverage and no genesis_height for ${SLUG} — run the backfill (or set capture.genesis_height) first`);
    cursor = Math.min(...ends); console.log(`cursor bootstrapped from ${SLUG} ledger coverage: ${cursor}`);
  }
  const head = await getHead() - LAG; const from = cursor + 1; const to = Math.min(head, cursor + MAX_BLOCKS);
  console.log(`org-nft-flows-${SLUG} · cursor ${cursor} · head ${head} · walking ${from} → ${to} (${Math.max(0, to - from + 1)} blocks) · watch ${WATCH.size}`);
  if (to < from) {
    const byt = await byTokenDuty();   // 1.4.0: a re-priced record (or the first run) still rebuilds its shards on a nothing-new run
    await heartbeat('ok', { cursor, head, walked: 0, matched: 0, repriced, symbol_stamped: STAMPED, months_walked: MONTHS_WALKED, months_touched: MONTHS_TOUCHED, by_token: byt, note: 'nothing new' }); console.log('done: nothing new'); process.exit(0);
  }

  // ---- walk (tla-flows pattern: concurrency, any failed read stops the run BEFORE the cursor moves)
  const matched = []; let processedTo = cursor;
  const inFlight = new Map(); const launch = (h) => { if (h <= to && !inFlight.has(h)) inFlight.set(h, getBlock(h)); };
  for (let h = from; h < from + CONC && h <= to; h++) launch(h);
  try {
    for (let N = from; N <= to; N++) {
      const blk = await inFlight.get(N); inFlight.delete(N); launch(N + CONC);
      if (blk.txsB64.length) {
        const results = await getBlockResults(N);
        for (let i = 0; i < blk.txsB64.length; i++) {
          const res = results[i]; if (!res) continue;
          let hit = false; for (const e of res.events || []) { if (e.type !== 'wasm') continue; for (const a of e.attributes || []) if (a.key === '_contract_address' && WATCH.has(a.value)) { hit = true; break; } if (hit) break; }
          if (hit) matched.push({ h: N, x: txHashOf(blk.txsB64[i]), t: blk.time, c: res.code, e: res.events, m: bodiesOf(blk.txsB64[i]) });   // 1.5.0: bodies archived beside the events
        }
      }
      processedTo = N;
    }
  } catch (e) { errors.push(`walk stopped at ${processedTo + 1}: ${e.message}`); console.warn('  ⚠ ' + errors[errors.length - 1]); }
  console.log(`  walked to ${processedTo} · ${matched.length} matched`);

  // ---- raw before ledger: per collection, per day file
  const touchesCol = (tx, k) => (tx.e || []).some(e => e.type === 'wasm' && (e.attributes || []).some(a => a.key === '_contract_address' && watchOf[k].has(a.value)));
  const rawPer = {}; for (const tx of matched) for (const k of cols) if (touchesCol(tx, k)) (rawPer[k] ||= []).push(tx);
  // venue-only txs (deposit/withdraw/offer) touch no collection contract: archive them under every collection listing on that venue
  const venueAddr = new Set(Object.values(R.venues || {}).map(v => v.address)); const venueKeyOf = {}; for (const [vk, v] of Object.entries(R.venues || {})) venueKeyOf[v.address] = vk;
  for (const tx of matched) { if (cols.some(k => touchesCol(tx, k))) continue; const vks = new Set(); for (const e of tx.e || []) if (e.type === 'wasm') for (const a of e.attributes || []) if (a.key === '_contract_address' && venueAddr.has(a.value)) vks.add(venueKeyOf[a.value]); for (const k of cols) if ((R.collections[k].venues || []).some(v => vks.has(v))) (rawPer[k] ||= []).push(tx); }
  let rawFiles = 0;
  for (const [k, txs] of Object.entries(rawPer)) {
    const byDay = {}; txs.forEach(tx => (byDay[String(tx.t).slice(0, 10)] ||= []).push(tx));
    for (const [day, list] of Object.entries(byDay)) {
      const p = `${RAWF}/${day}.json.gz`; const ex = await readFile(p); const seen = new Set(((ex && ex.data) || []).map(t => t.x));
      const merged = [...((ex && ex.data) || []), ...list.filter(t => !seen.has(t.x))].sort((a, b) => a.h - b.h);
      if (merged.length === ((ex && ex.data) || []).length) continue;
      await writeGz(p, merged, `nft-flows forward raw ${k} ${day} (+${merged.length - ((ex && ex.data) || []).length})`, ex && ex.sha); rawFiles++;
    }
  }

  // ---- ledger: classify, USD, merge by key into month files, refresh index
  const recs = matched.flatMap(tx => classifyNftTx({ txhash: tx.x, height: tx.h, timestamp: tx.t, code: tx.c, events: tx.e, messages: tx.m }, R, idx));
  const perCol = {}; for (const r of recs) { if (r.collection) (perCol[r.collection] ||= []).push(r); else if (r.venue) for (const k of cols) if ((R.collections[k].venues || []).includes(r.venue)) (perCol[k] ||= []).push(Object.assign({}, r, { collection: k })); }
  let added = 0; const perColAdded = {};
  for (const [k, list] of Object.entries(perCol)) {
    const byMonth = {}; list.forEach(r => { r.source = 'forward:org-nft-flows'; if (r.price) Object.assign(r, usdAt(r.price, r.ts)); (byMonth[String(r.ts).slice(0, 7).replace('-', '/')] ||= []).push(r); });
    const monthsTouched = {};
    for (const [mk, rs] of Object.entries(byMonth)) {
      const p = `${LEDGER}/${mk}.json`; const ex = await readFile(p); const existing = (ex && Array.isArray(ex.data)) ? ex.data : []; const seen = new Set(existing.map(recordKey));
      const fresh = rs.filter(r => !seen.has(recordKey(r))); if (!fresh.length) continue;
      const merged = [...existing, ...fresh].sort((a, b) => a.height - b.height || a.msg_index - b.msg_index);
      fresh.forEach(r => { if (r.token_id != null) TOKENS_DIRTY.add(String(r.token_id)); });   // 1.4.0
      await writeJson(p, merged, `nft-flows forward ${k} ${mk} (+${fresh.length})`, ex && ex.sha); added += fresh.length; perColAdded[k] = (perColAdded[k] || 0) + fresh.length; monthsTouched[mk] = merged;
    }
    if (Object.keys(monthsTouched).length) {
      const ixf = await readFile(`${LEDGER}/index.json`); const ix = (ixf && ixf.data) || { product: `${k}/ledger`, schema: 'nft-flows-1.0', collection: k, total: 0, by_kind: {}, months: [], coverage: [], known_gaps: [] };
      for (const [mk, merged] of Object.entries(monthsTouched)) { if (!ix.months.includes(mk)) ix.months.push(mk); ix.months.sort(); }
      const bk = {}; let total = 0; for (const mk of ix.months) { const m = monthsTouched[mk] || ((await readFile(`${LEDGER}/${mk}.json`)) || { data: [] }).data; total += m.length; m.forEach(r => { bk[r.kind] = (bk[r.kind] || 0) + 1; }); }
      ix.total = total; ix.by_kind = bk;
      const fw = ix.coverage.find(c => c.source === 'forward:org-nft-flows'); if (fw) fw.to = Math.max(fw.to, processedTo); else ix.coverage.push({ source: 'forward:org-nft-flows', from: from, to: processedTo, parts: 0 });
      ix.forward_stream = `org-nft-flows-${k} (Render, hourly) → ${k}/raw/forward + this ledger`; ix.updatedAt = new Date().toISOString();
      await writeJson(`${LEDGER}/index.json`, ix, `nft-flows forward ${k} index`, ixf && ixf.sha);
    }
  }
  // collections with nothing new still get their coverage edge moved (the walk covered them)
  for (const k of cols) { if (perColAdded[k]) continue; const ixf = await readFile(`${LEDGER}/index.json`); if (!ixf) continue; const ix = ixf.data; const fw = ix.coverage.find(c => c.source === 'forward:org-nft-flows'); if (fw) { if (processedTo > fw.to) { fw.to = processedTo; ix.updatedAt = new Date().toISOString(); await writeJson(`${LEDGER}/index.json`, ix, `nft-flows forward ${k} coverage → ${processedTo}`, ixf.sha); } } else { ix.coverage.push({ source: 'forward:org-nft-flows', from, to: processedTo, parts: 0 }); ix.updatedAt = new Date().toISOString(); await writeJson(`${LEDGER}/index.json`, ix, `nft-flows forward ${k} coverage start`, ixf.sha); } }

  const byt = await byTokenDuty();   // 1.4.0: shards for every token that gained or re-priced a record this run
  // ---- cursor LAST (raw + ledger are on main before we say so), then heartbeat
  if (processedTo > cursor) await writeJson(CURSOR_PATH, { height: processedTo, updatedAt: new Date().toISOString(), note: `block cursor for org-nft-flows-${SLUG}; this service walks only this collection` }, `nft-flows cursor → ${processedTo}`, cur && cur.sha);
  await heartbeat(errors.length ? 'degraded' : 'ok', { cursor: processedTo, head, walked: processedTo - cursor, matched: matched.length, raw_files: rawFiles, records_added: added, repriced, symbol_stamped: STAMPED, months_walked: MONTHS_WALKED, months_touched: MONTHS_TOUCHED, by_token: byt, per_collection: perColAdded });
  console.log(`done: +${added} ledger records, ${rawFiles} raw files, cursor ${processedTo}, ${Date.now() - t0} ms`);
  process.exit(0);   // keep-alive sockets would otherwise hold the process open on Render
})().catch(async (e) => { console.error('FATAL', e); errors.push(e.message); try { await heartbeat('failed', {}); } catch { } process.exit(1); });

async function heartbeat(status, extra) {
  const hb = Object.assign({ module: 'nft-collections', product: `${SLUG}/nft-flows`, cron: `org-nft-flows-${SLUG}`, version: '1.5.0', status, ran_at: new Date().toISOString(), duration_ms: Date.now() - t0, errors }, extra);
  const ex = await readFile(HB_PATH).catch(() => null);
  await writeJson(HB_PATH, hb, `nft-flows heartbeat ${status}`, ex && ex.sha);
}
