#!/usr/bin/env node
/**
 * ally-positions/backfill.js — THE PAST, FROM AN ARCHIVE NODE, AS A DAILY SERIES. One-off (or re-runnable) job.
 *   Everything here is a STATE-AT-HEIGHT read (`x-cosmos-block-height` header), which an archive LCD serves for any height
 *   it keeps — no tx index needed, no event log to walk. For each UTC day in [FROM, TO] the job finds the last block of the
 *   day (binary search over block timestamps), then reads at that height:
 *     · pyROAR total_supply      → the burn festival, day by day (Δ per day = ROAR burned that day; the ledger is frozen after)
 *     · ROAR total_supply        → supply over time (the 1T-minus-burns story, measured)
 *     · ROAR staked (Lion DAO)   → cw20-stake total_staked_at_height at that height
 *     · the validator            → bonded validator set at that height: rank, tokens, delegator_shares, commission rate, jailed
 *     · pixeLions staked in the DAO → the voting module's total_power_at_height (DAODAO cw721-stake)
 *   Output: dao-originations/<dao>/history/daily.json — one row per day, never-shrink merge (a re-run adds days, never
 *   rewrites a measured one; a day with a failed read is written with the failed field null + reason, and re-read next run).
 *   Every row names its height and the block time it was read at. Nothing is interpolated: a height the node no longer
 *   serves is a row that says so.
 *
 *   Usage (one-off): ARCHIVE_LCD=https://<archive-lcd> TENANT=liondao FROM=2023-09-01 TO=2026-09-21 GITHUB_TOKEN=… node backfill.js
 *   No GITHUB_TOKEN → writes out/history-daily.json. STEP_DAYS=7 samples weekly (first pass on a slow node), then re-run daily.
 *   Laws: a successful empty read is 0; null is a failed read; reported figures never enter; a series never rebuilds from a
 *   failed read; the registry holds the literals (contracts from tenants.json), the engine none.
 *
 *   1.1.0 — THE ARCHIVE IS A COURTESY (owner, 2026-09-22). Every guard below exists so this job can never look like a spam or an
 *   attack to the operator, and can never run away:
 *     · SEQUENTIAL, THROTTLED: one request in flight, at most RPS per second (default 2, hard ceiling 4 whatever the env says).
 *     · BACK OFF when it pushes back: 429 / 503 / 502 / 504 or a timeout → wait 5 s, 20 s, 60 s and retry at most 3 times.
 *     · STOP when it keeps refusing: MAX_CONSECUTIVE_FAILURES (5) → the run ends and publishes what it measured — we do not lean on it.
 *     · HARD CAPS: MAX_REQUESTS per run (default 5,000, ceiling 20,000) and MAX_MINUTES wall-clock (default 60, ceiling 240);
 *       hitting either ends the run cleanly (partial results merged never-shrink, `stopped` says why). No loop is unbounded:
 *       the height search is capped in iterations, the day walk in days.
 *     · CHEAP HEIGHTS: after the first day, the next day's height is estimated from the measured block rate and refined in a
 *       narrow bracket (~6 block reads a day instead of ~25).
 *     · IDENTIFIED: User-Agent names the site so the operator knows who is asking.
 *     · MANUAL ONLY: the workflow has no schedule; the script refuses to start unless RUN_MODE=manual (the Action sets it);
 *       ARCHIVE_LCD lives only in the Actions secret, never on a Render service.
 */
'use strict';
const VERSION = '1.1.0';
const https = require('https');
const fs = require('fs');
const E = require('../lib/capture-engine.js');

const TENANT = process.env.TENANT || 'liondao';
const clampNum = (v, dflt, lo, hi) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.min(hi, Math.max(lo, n)) : dflt; };
const RPS = clampNum(process.env.RPS, 2, 0.2, 4);                       // requests per second, ceiling 4 — the env cannot raise it past that
const MAX_REQUESTS = clampNum(process.env.MAX_REQUESTS, 5000, 50, 20000);
const MAX_MINUTES = clampNum(process.env.MAX_MINUTES, 60, 1, 240);
const MAX_CONSECUTIVE_FAILURES = clampNum(process.env.MAX_CONSECUTIVE_FAILURES, 5, 1, 10);
const MAX_RETRIES = 3, BACKOFF_MS = [5000, 20000, 60000];
const RUN_MODE = process.env.RUN_MODE || '';
const UA = 'thealliancedao.com ally-backfill/1.1 (one-off, throttled ' + RPS + ' rps; contact via the site)';
const budget = { started: Date.now(), requests: 0, retries: 0, backoffs: 0, consecutiveFailures: 0, stopped: null, lastAt: 0 };
function budgetLeft() { if (budget.stopped) return false; if (budget.requests >= MAX_REQUESTS) { budget.stopped = `MAX_REQUESTS ${MAX_REQUESTS} reached`; return false; } if (Date.now() - budget.started > MAX_MINUTES * 60000) { budget.stopped = `MAX_MINUTES ${MAX_MINUTES} reached`; return false; } if (budget.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) { budget.stopped = `${MAX_CONSECUTIVE_FAILURES} consecutive failures — the node is refusing or down; not pushing further`; return false; } return true; }
async function throttle() { const gap = 1000 / RPS; const wait = budget.lastAt + gap - Date.now(); if (wait > 0) await sleep(wait); budget.lastAt = Date.now(); }
const ARCHIVE = (process.env.ARCHIVE_LCD || '').replace(/\/$/, '');
const FROM = process.env.FROM || '2023-09-01', TO = process.env.TO || new Date(Date.now() - 864e5).toISOString().slice(0, 10);
const STEP_DAYS = Math.max(1, Number(process.env.STEP_DAYS || 1));
const GITHUB_TOKEN = process.env.GITHUB_TOKEN; const GITHUB_REPO = process.env.GITHUB_REPO || 'thealliancedao/dao-originations'; const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const CORE = 'https://raw.githubusercontent.com/thealliancedao/tla-core/main/';
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const b64 = (q) => Buffer.from(JSON.stringify(q)).toString('base64');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------- archive reads (height-pinned)
async function getAt(path, height, label) {
  for (let attempt = 0; ; attempt++) {
    if (!budgetLeft()) return { error: 'stopped: ' + budget.stopped };
    await throttle(); budget.requests++;
    const url = ARCHIVE + path; const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 30000); let res, body = '';
    try { res = await fetch(url, { signal: ctrl.signal, headers: Object.assign({ Accept: 'application/json', 'User-Agent': UA }, height ? { 'x-cosmos-block-height': String(height) } : {}) }); }
    catch (e) { clearTimeout(t); const msg = e.name === 'AbortError' ? 'timeout' : e.message; if (attempt < MAX_RETRIES) { budget.retries++; budget.backoffs++; budget.consecutiveFailures++; if (!budgetLeft()) return { error: 'stopped: ' + budget.stopped }; await sleep(BACKOFF_MS[attempt]); continue; } budget.consecutiveFailures++; return { error: msg }; }
    clearTimeout(t);
    if (res.ok) { budget.consecutiveFailures = 0; try { return { data: await res.json() }; } catch (e) { return { error: 'bad JSON' }; } }
    body = await res.text().catch(() => '');
    if ([429, 502, 503, 504].includes(res.status) && attempt < MAX_RETRIES) { budget.retries++; budget.backoffs++; budget.consecutiveFailures++; if (!budgetLeft()) return { error: 'stopped: ' + budget.stopped }; const ra = Number(res.headers && res.headers.get && res.headers.get('retry-after')); await sleep(ra > 0 ? Math.min(ra * 1000, 120000) : BACKOFF_MS[attempt]); continue; }
    if ([429, 502, 503, 504].includes(res.status)) budget.consecutiveFailures++;   // a pruned height or a 404 is an answer, not a failure — it does not count against the node
    return { error: `HTTP ${res.status} ${body.slice(0, 120)}` };
  }
}
async function smartAt(contract, q, height) { const r = await getAt(`/cosmwasm/wasm/v1/contract/${contract}/smart/${b64(q)}`, height); return r.data && r.data.data !== undefined ? { data: r.data.data } : { error: r.error || 'no data' }; }
async function block(h) { const r = await getAt(h ? `/cosmos/base/tendermint/v1beta1/blocks/${h}` : '/cosmos/base/tendermint/v1beta1/blocks/latest', null, 'block'); const b = r.data && r.data.block; return b ? { height: num(b.header.height), time: b.header.time } : { error: r.error || 'no block' }; }

// last block at or before `dayEndIso` (UTC 23:59:59.999), by binary search over block times; lo/hi seeded from a rate estimate
async function heightAtEndOfDay(day, cache) {
  const target = Date.parse(day + 'T23:59:59.999Z');
  const latest = cache.latest || (cache.latest = await block(null)); if (latest.error) return { error: 'latest block: ' + latest.error };
  if (target >= Date.parse(latest.time)) return { height: latest.height, time: latest.time, note: 'day not closed yet — latest block' };
  const isPruned = (e) => /not available|pruned|lowest height/i.test(String(e));
  let lo, hi;
  if (cache.prev && cache.bpd) { lo = Math.max(1, Math.floor(cache.prev.height + cache.bpd * ((target - Date.parse(cache.prev.time)) / 864e5) * 0.985)); hi = Math.min(latest.height, Math.ceil(cache.prev.height + cache.bpd * ((target - Date.parse(cache.prev.time)) / 864e5) * 1.015)); }   // next day: a narrow bracket from the measured block rate
  else { const est = Math.max(1, Math.floor(latest.height - (Date.parse(latest.time) - target) / 6000)); lo = Math.max(1, est - 30000); hi = Math.min(latest.height, est + 30000); }
  // widen until the bracket holds (bounded), then bisect (bounded)
  for (let k = 0; k < 8; k++) { const ba = await block(lo), bb = await block(hi); if (ba.error) return { error: isPruned(ba.error) ? 'the archive does not serve height ' + lo + ' (' + ba.error + ')' : 'block ' + lo + ': ' + ba.error }; if (bb.error) return { error: 'block ' + hi + ': ' + bb.error };
    if (Date.parse(ba.time) <= target && Date.parse(bb.time) > target) break; const span = hi - lo; if (Date.parse(ba.time) > target) { hi = lo; lo = Math.max(1, lo - span * 2); } else { lo = hi; hi = Math.min(latest.height, hi + span * 2); } if (k === 7) return { error: 'could not bracket ' + day + ' in 8 widenings' }; }
  let loB = await block(lo); if (loB.error) return { error: 'block ' + lo + ': ' + loB.error };
  for (let it = 0; hi - lo > 1 && it < 40; it++) { const mid = Math.floor((lo + hi) / 2); const bm = await block(mid); if (bm.error) return { error: 'block ' + mid + ': ' + bm.error }; if (Date.parse(bm.time) <= target) { lo = mid; loB = bm; } else hi = mid; }
  if (cache.prev) { const days = (Date.parse(loB.time) - Date.parse(cache.prev.time)) / 864e5; if (days > 0) cache.bpd = (lo - cache.prev.height) / days; }
  cache.prev = { height: lo, time: loB.time }; return { height: lo, time: loB.time };
}

// ---------------------------------------------------------------- one day's readings
async function readDay(day, h, t) {
  const st = t.staking || {}, val = t.validator || {}, burn = t.burn || {};
  const row = { day, height: h.height, block_time: h.time, reads: {} };
  const put = (k, r, pick) => { if (r.data !== undefined) { row[k] = pick(r.data); row.reads[k] = 'ok'; } else { row[k] = null; row.reads[k] = r.error || 'failed'; } };
  if (burn.pyroar_cw20) put('pyroar_supply', await smartAt(burn.pyroar_cw20, { token_info: {} }, h.height), (d) => num(d.total_supply) != null ? num(d.total_supply) / Math.pow(10, num(d.decimals) != null ? num(d.decimals) : 6) : null);
  if (st.roar_cw20) put('roar_supply', await smartAt(st.roar_cw20, { token_info: {} }, h.height), (d) => num(d.total_supply) != null ? num(d.total_supply) / Math.pow(10, num(d.decimals) != null ? num(d.decimals) : 6) : null);
  if (st.roar_staking) put('roar_staked', await smartAt(st.roar_staking, { total_staked_at_height: {} }, h.height), (d) => num(d.total) != null ? num(d.total) / 1e6 : (num(d.power) != null ? num(d.power) / 1e6 : null));
  if (st.pl_voting_module) put('pixelions_staked', await smartAt(st.pl_voting_module, { total_power_at_height: {} }, h.height), (d) => num(d.power));
  if (val.operator) { const r = await getAt('/cosmos/staking/v1beta1/validators?status=BOND_STATUS_BONDED&pagination.limit=300', h.height);
    if (r.data && Array.isArray(r.data.validators)) { const vs = r.data.validators.slice().sort((a, b) => num(b.tokens) - num(a.tokens)); const i = vs.findIndex(v => v.operator_address === val.operator); const v = i >= 0 ? vs[i] : null;
      row.validator = v ? { rank: i + 1, of: vs.length, tokens_luna: num(v.tokens) / 1e6, delegator_shares: num(v.delegator_shares) / 1e6, commission_rate: num(v.commission && v.commission.commission_rates && v.commission.commission_rates.rate), jailed: !!v.jailed, status: v.status } : { rank: null, of: vs.length, note: 'not in the bonded set at this height' }; row.reads.validator = 'ok'; }
    else { row.validator = null; row.reads.validator = r.error || 'failed'; } }
  return row;
}

// ---------------------------------------------------------------- publish (never-shrink)
function gh(method, apiPath, body) { return new Promise((resolve, reject) => { const req = https.request({ hostname: 'api.github.com', path: apiPath, method, headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'ally-backfill', 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' } }, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => { if (res.statusCode >= 200 && res.statusCode < 300) resolve(d ? JSON.parse(d) : {}); else if (res.statusCode === 404) resolve(null); else reject(new Error(`GitHub ${method} ${apiPath}: ${res.statusCode} ${d.slice(0, 200)}`)); }); }); req.on('error', reject); if (body) req.write(JSON.stringify(body)); req.end(); }); }
function merge(existing, rows, meta) {
  const doc = existing && Array.isArray(existing.days) ? existing : { product: meta.product, engine: VERSION, tenant: TENANT, days: [], sources: {} };
  const byDay = new Map(doc.days.map(r => [r.day, r]));
  for (const r of rows) { const old = byDay.get(r.day); if (!old) { byDay.set(r.day, r); continue; }
    // never-shrink: a measured field is kept; a null field is filled when the new row measured it; a differing measured value is kept as the older one with the new one labeled (heights differ only if the day boundary moved)
    for (const k of Object.keys(r)) { if (k === 'reads' || k === 'day') continue; if (old[k] == null && r[k] != null) { old[k] = r[k]; old.reads[k] = r.reads[k]; } else if (old[k] != null && r[k] != null && JSON.stringify(old[k]) !== JSON.stringify(r[k]) && k !== 'height' && k !== 'block_time') { old.superseded = old.superseded || {}; old.superseded[k] = { previous: old[k], read_at_height: old.height }; old[k] = r[k]; old.reads[k] = r.reads[k] + ' (re-read; previous kept under superseded)'; } } }
  doc.days = [...byDay.values()].sort((a, b) => a.day < b.day ? -1 : 1); doc.day_count = doc.days.length; doc.first_day = doc.days[0] && doc.days[0].day; doc.last_day = doc.days[doc.days.length - 1] && doc.days[doc.days.length - 1].day;
  doc.engine = VERSION; doc.updated_at = new Date().toISOString(); doc.sources = Object.assign(doc.sources || {}, meta.sources); return doc;
}

async function run(opts = {}) {
  if (!ARCHIVE) throw new Error('ARCHIVE_LCD is required (an archive LCD that serves state at historical heights)');
  if (RUN_MODE !== 'manual' && !opts.allowNonManual) throw new Error('RUN_MODE must be "manual" — this job runs only when a person starts it (the Action sets it); it is never scheduled');
  console.log(`  budget: ≤ ${RPS} req/s sequential · ≤ ${MAX_REQUESTS} requests · ≤ ${MAX_MINUTES} min · stop after ${MAX_CONSECUTIVE_FAILURES} consecutive refusals · UA "${UA}"`);
  const tenantsDoc = await E.fetchJson(CORE + 'docs/curated/tenants.json', 'tenants'); const t = tenantsDoc.tenants && tenantsDoc.tenants[TENANT]; if (!t) throw new Error(`tenant ${TENANT} not in tenants.json`);
  const outRoot = process.env.OUT_ROOT || ((t.daos || [])[0] || TENANT); const cache = {}; const rows = []; const skipped = [];
  const days = []; for (let d = new Date(FROM + 'T00:00:00Z'); d.toISOString().slice(0, 10) <= TO; d.setUTCDate(d.getUTCDate() + STEP_DAYS)) days.push(d.toISOString().slice(0, 10));
  const want = opts.days || days;
  for (const day of want) { if (!budgetLeft()) { skipped.push({ day, reason: 'not attempted — ' + budget.stopped }); continue; } const h = await heightAtEndOfDay(day, cache); if (h.error) { skipped.push({ day, reason: h.error }); if (/^stopped:/.test(h.error)) continue; if (/does not serve height/.test(h.error)) console.error('  · ' + day + ': ' + h.error + ' (skipped; no value is invented for it)'); continue; }
    const row = await readDay(day, h, t); rows.push(row); if (opts.onRow) opts.onRow(row); if (budget.requests % 200 < 6) console.log(`  · ${budget.requests} requests so far, ${((Date.now() - budget.started) / 60000).toFixed(1)} min`); }
  const meta = { product: `${outRoot}/history/daily`, sources: { archive: ARCHIVE.replace(/\/\/.*@/, '//'), method: 'state at the last block of each UTC day (x-cosmos-block-height); heights by binary search over block times', fields: { pyroar_supply: 'cw20 token_info.total_supply — Δ per day = ROAR burned that day', roar_supply: 'cw20 token_info.total_supply', roar_staked: 'cw20-stake total_staked_at_height', pixelions_staked: 'DAODAO voting module total_power_at_height', validator: 'bonded set at height: rank, tokens, shares, commission, jailed' } } };
  const summary = { requests: budget.requests, retries: budget.retries, backoffs: budget.backoffs, minutes: +((Date.now() - budget.started) / 60000).toFixed(2), avg_rps: +(budget.requests / Math.max(1, (Date.now() - budget.started) / 1000)).toFixed(2), stopped: budget.stopped, days_read: rows.length, days_skipped: skipped.length };
  meta.sources.last_run = summary;
  return { outRoot, rows, skipped, meta, summary };
}

async function main() {
  const res = await run({ onRow: (r) => console.log(`  ${r.day} @${r.height} pyROAR ${r.pyroar_supply == null ? '—' : Math.round(r.pyroar_supply).toLocaleString()} · ROAR ${r.roar_supply == null ? '—' : Math.round(r.roar_supply).toLocaleString()} · staked ${r.roar_staked == null ? '—' : Math.round(r.roar_staked).toLocaleString()} · val ${r.validator && r.validator.rank != null ? '#' + r.validator.rank : '—'}`) });
  for (const s of res.skipped) console.error(`  skipped ${s.day}: ${s.reason}`);
  console.log(`  run: ${res.summary.requests} requests in ${res.summary.minutes} min (${res.summary.avg_rps} rps, ${res.summary.retries} retries)` + (res.summary.stopped ? ` — STOPPED EARLY: ${res.summary.stopped}; what was measured is merged, re-run later for the rest` : ''));
  const filePath = `${res.outRoot}/history/daily.json`;
  if (!GITHUB_TOKEN) { const doc = merge(fs.existsSync('out/history-daily.json') ? JSON.parse(fs.readFileSync('out/history-daily.json', 'utf8')) : null, res.rows, res.meta); fs.mkdirSync('out', { recursive: true }); fs.writeFileSync('out/history-daily.json', JSON.stringify(doc, null, 1)); console.log(`⚠️  GITHUB_TOKEN not set — wrote out/history-daily.json (${doc.day_count} days)`); return; }
  const ex = await gh('GET', `/repos/${GITHUB_REPO}/contents/${filePath}?ref=${GITHUB_BRANCH}`); const existing = ex ? JSON.parse(Buffer.from(ex.content, 'base64').toString()) : null;
  const doc = merge(existing, res.rows, res.meta);
  const r = await gh('PUT', `/repos/${GITHUB_REPO}/contents/${filePath}`, Object.assign({ message: `📜 ${TENANT} history backfill ${FROM}→${TO} (${res.rows.length} days read, ${res.skipped.length} skipped)`, content: Buffer.from(JSON.stringify(doc, null, 1)).toString('base64'), branch: GITHUB_BRANCH }, ex && ex.sha ? { sha: ex.sha } : {}));
  console.log(`  ${filePath} (${doc.day_count} days) → ${r && r.content ? r.content.sha.slice(0, 7) : 'ok'}`);
}
module.exports = { VERSION, run, merge, readDay, heightAtEndOfDay, _budget: budget, _limits: { RPS, MAX_REQUESTS, MAX_MINUTES, MAX_CONSECUTIVE_FAILURES } };
if (require.main === module) main().catch(e => { console.error('✗', e); process.exit(1); });
