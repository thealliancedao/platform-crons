// PORTED 2026-08-10 into org dex-data (fold, no new Render jobs — strip #3, SS
// fold): verbatim legacy skeletonswap-lp_data capture logic (pools_list.json +
// network-and-prices + direct LCD {"pool":{}} reserves + fingerprint freshness)
// retargeted to publish daily/rolling/weekly/monthly series into tla-core
// dex-data/skeletonswap trees, CONTINUING dex-slice history. Org snapshots/
// dailies (dexes/skeletonswap.js) untouched. Parallel-run vs legacy
// ss-pool-daily/weekly/monthly Render jobs until parity, then legacy retires.
//
// PARADIGM CONVERSION vs legacy (the only non-verbatim parts):
//   - PUBLISH: legacy cloned defipatriot/ss-pool-data_2026 and used
//     `git add -f … && git push` (Render shell). Org publishes each file via
//     the GitHub contents API (epochs-astroport pushToGithub pattern).
//   - STATE: legacy aggregations read prior day-N.csv files from its local git
//     clone. Org is STATELESS — prior dailies/weeklies are fetched from
//     raw.githubusercontent (tla-core) by DETERMINISTIC filename; missing days
//     are honest gaps (has_gaps), never guessed.
//   - WEEKLY LABELING FIX (org-wins — GATE-PROVEN 2026-08-10): the ENTIRE
//     legacy weekly series is labeled ONE EPOCH AHEAD of the canonical epoch
//     registry (docs/epoch_1-300_date.json). Legacy stamped the run-time epoch
//     on the PRIOR week's data (its weekly job ran after the Monday flip), so
//     e.g. legacy "2026-epoch-197.csv" holds Jul 27–Aug 2 = canonical epoch
//     196. Org aggregates the PREVIOUS COMPLETED epoch's 7 dated dailies
//     (window derived from canonical epoch math) and labels it with THAT
//     epoch — gate-verified byte-identical to legacy numbers under the
//     corrected label. DEPLOY PREREQ: run the one-off relabel of the sliced
//     weekly-avg files (shift every legacy epoch label -1) BEFORE enabling
//     this fold, so the series is internally consistent; see CHANGES_PENDING.
//     Self-healing: re-runs every day, gaps fill as dailies land.
//   - MONTHLY period bounds FIX (org-wins): legacy wrote empty
//     period_start/period_end (it looked for a `date` column that weekly files
//     don't have). Org derives them from the weekly rows' own period bounds.
//   - Yearly mode DROPPED: no page consumes it and no yearly file exists in the
//     sliced tree (pages-define-need).
//
// Output trees (tla-core), continuing the dex-slice:
//   dex-data/skeletonswap/daily-csv/<date>.csv      dated daily (legacy schema)
//   dex-data/skeletonswap/rolling/day-<1..7>.csv    Mon=1..Sun=7 rotating copy
//   dex-data/skeletonswap/rolling/6-day-avg.csv     rolling 6-day aggregate
//   dex-data/skeletonswap/weekly-avg/<yyyy>-epoch-<N>.csv   previous epoch
//   dex-data/skeletonswap/monthly/<yyyy-mm>.csv     previous month (1st only)
//   dex-data/skeletonswap/rolling/heartbeat.json    freshness signal (this fold)
//
// Data-source background (verbatim from legacy, 2026-05-18 architecture): the
// old bulk endpoint at dex.warlock.backbonelabs.io/api/pools/phoenix-1 went
// stale on 2026-04-16 — the API still responds, but every pool's data is frozen
// at the 2026-04-16T17:00:00Z snapshot. Skeleton Swap's own front-end migrated
// to a hybrid architecture that queries the chain directly for reserves and
// ignores warlock for those fields. We mirror that approach here.
//   Fresh fields (computed every run): reserve_0, reserve_1, total_share (LCD
//   smart query {"pool":{}}) and tvl_usd (reserves × network-and-prices).
//   Permanently null fields (no trustworthy source): volume_24h_usd,
//   volume_7d_usd, apr_7d — written empty, never faked.
//
// Runtime: Node 18+. CommonJS, no dependencies.
// =============================================================================

const https = require('https');
const http = require('http');
const crypto = require('crypto');

// -----------------------------------------------------------------------------
// CONFIGURATION
// -----------------------------------------------------------------------------

const POOLS_LIST_URL = 'https://skeletonswap.backbonelabs.io/mainnet/phoenix-1/pools_list.json';
const LCD_URL = process.env.TERRA_LCD || 'https://terra-lcd.publicnode.com';

// Concurrency cap when querying pools in parallel. Public LCD endpoints tolerate
// ~10-15 in-flight requests comfortably; 34 pools at 8 concurrent ≈ 5 batches.
const POOL_QUERY_CONCURRENCY = 8;

// Sandbox / local-testing escape hatches (production on Render leaves unset).
const POOLS_LIST_FIXTURE_URL = process.env.SS_POOLS_LIST_FIXTURE_URL || '';
const PRICES_FIXTURE_URL = process.env.SS_PRICES_FIXTURE_URL || '';
const FORCE_MONTHLY = process.env.SS_FORCE_MONTHLY === '1';

// GitHub config from environment (same convention as epochs-astroport).
const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
const GITHUB_REPO   = process.env.GITHUB_REPO   || 'thealliancedao/tla-core';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';

// Prices come from the org canonical pricing feed (same repo we publish to).
const PRICES_PATH = 'network-and-prices/current.json';

// Output tree roots.
const OUT = 'dex-data/skeletonswap';

// TLA epoch math (verbatim): epochs started 2022-10-31 00:00:00 UTC, 7 days each.
const EPOCH_START = Date.parse('2022-10-31T00:00:00Z');
const EPOCH_DURATION = 7 * 24 * 60 * 60 * 1000;

// CSV Headers (verbatim legacy — the sliced trees carry exactly these).
const DAILY_HEADERS = 'date,time,dex,pool_name,pool_address,tvl_usd,volume_24h_usd,volume_7d_usd,apr_7d,reserve_0,reserve_1,total_share';
const AGG_HEADERS = 'period,period_start,period_end,snapshots_used,snapshots_expected,has_gaps,dex,pool_name,pool_address,avg_tvl_usd,total_volume_usd,avg_apr_7d,avg_reserve_0,avg_reserve_1,avg_total_share,snapshot_count';

// Freshness threshold (verbatim): 2 identical runs → suspicious, 3+ → stuck.
const STUCK_THRESHOLD = 3;

// -----------------------------------------------------------------------------
// HTTP HELPERS (legacy httpRequest, extended with http:// support for the
// local-LCD test harness; behavior identical for https URLs)
// -----------------------------------------------------------------------------

function httpRequest(url, { method = 'GET', headers = {}, body = null, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const isHttp = u.protocol === 'http:';
    const mod = isHttp ? http : https;
    const reqOpts = {
      method,
      hostname: u.hostname,
      port: u.port || (isHttp ? 80 : 443),
      path: u.pathname + (u.search || ''),
      headers: {
        'User-Agent': 'org-dex-data/epochs-skeletonswap',
        ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}),
        ...headers
      },
      timeout: timeoutMs
    };
    const req = mod.request(reqOpts, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return resolve(httpRequest(next, { method, headers, body, timeoutMs }));
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          return reject(new Error(`HTTP ${res.statusCode} from ${url}: ${data.slice(0, 200)}`));
        }
        resolve({ status: res.statusCode, body: data });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error(`Timeout after ${timeoutMs}ms: ${url}`)); });
    if (body) req.write(body);
    req.end();
  });
}

async function fetchJson(url, opts = {}) {
  const { retries = 2 } = opts;
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const { body } = await httpRequest(url, opts);
      return JSON.parse(body);
    } catch (e) {
      lastErr = e;
      if (i < retries) await new Promise(r => setTimeout(r, 500 * (i + 1)));
    }
  }
  throw new Error(`fetchJson failed after ${retries + 1} attempts: ${lastErr.message}`);
}

// Fetch a file from the data repo via raw.githubusercontent. null on 404/error.
// Cache-buster required: GitHub's raw CDN caches aggressively and the weekly
// aggregation re-reads dailies this same job pushed earlier today.
function fetchRawFromRepo(repoPath) {
  const url = `https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_BRANCH}/${repoPath}?cb=${Date.now()}`;
  return httpRequest(url).then(r => r.body).catch(() => null);
}

// -----------------------------------------------------------------------------
// CSV HELPERS (verbatim legacy parser + always-quoted pool names)
// -----------------------------------------------------------------------------

function parseCSV(content) {
  const lines = content.trim().split('\n');
  if (lines.length < 2) return [];
  const headers = lines[0].split(',');
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(',');
    const row = {};
    headers.forEach((h, idx) => {
      let val = values[idx] || '';
      val = val.replace(/^"|"$/g, '');
      row[h.trim()] = val;
    });
    rows.push(row);
  }
  return rows;
}

// Legacy read helper — legacy daily files have `pool_id`; new files `pool_name`.
function rowPoolName(row) { return row.pool_name || row.pool_id || ''; }

// -----------------------------------------------------------------------------
// EPOCH / DATE MATH (verbatim, UTC-explicit)
// -----------------------------------------------------------------------------

function getEpochNumber(date = new Date()) {
  return Math.floor((date.getTime() - EPOCH_START) / EPOCH_DURATION) + 1;
}

function epochStartMs(epoch) { return EPOCH_START + (epoch - 1) * EPOCH_DURATION; }

// Mon=1 .. Sun=7 (UTC).
function getDayOfWeekUTC(date) {
  return ((date.getUTCDay() + 6) % 7) + 1;
}

function isoDate(ms) { return new Date(ms).toISOString().slice(0, 10); }

// -----------------------------------------------------------------------------
// PRICE LOOKUP (verbatim legacy — SS symbol idiosyncrasies + ampROAR derivation)
// -----------------------------------------------------------------------------

//    SS pool_assets[].symbol → canonical symbol used in network-and-prices.json:
//      - USDt        → USDT          (case)
//      - wstETH      → WSTETH        (case)
//      - EURe        → EURE          (case)
//      - wBTC.osmo   → WBTC          (different bridge, same underlying)
//      - wBTC.axl    → WBTC          (different bridge, same underlying)
//      - ampROAR     → derived: ROAR_usd × lst_ratios.ampROAR.ratio
//      - dATOM       → null (no price source — pool TVL will be null)
function buildPriceLookup(napData) {
  const tokenPrices = napData.token_prices || {};
  const lstRatios = napData.lst_ratios || {};

  const lookup = {};
  for (const [name, entry] of Object.entries(tokenPrices)) {
    const price = entry?.prices?.astroport?.final_price_usd
      ?? entry?.final_price_usd
      ?? null;
    if (price != null) {
      lookup[name.toLowerCase()] = price;
    }
  }

  const alias = (from, to) => {
    if (lookup[to.toLowerCase()] != null) lookup[from.toLowerCase()] = lookup[to.toLowerCase()];
  };
  alias('usdt',         'USDT');
  alias('wsteth',       'WSTETH');
  alias('eure',         'EURE');
  alias('wbtc.osmo',    'WBTC');
  alias('wbtc.axl',     'WBTC');
  alias('axlusdc',      'USDC');     // Axelar-bridged USDC, par with native USDC
  alias('astro.cw20',   'ASTRO');    // legacy CW20 ASTRO, same underlying token

  const roarPrice = lookup['roar'];
  const ampRoarRatio = lstRatios['ampROAR']?.ratio;
  if (roarPrice != null && ampRoarRatio != null) {
    lookup['amproar'] = roarPrice * ampRoarRatio;
  }

  return lookup;
}

function priceForSymbol(symbol, lookup) {
  if (!symbol) return null;
  const v = lookup[symbol.toLowerCase()];
  return (typeof v === 'number' && isFinite(v)) ? v : null;
}

// -----------------------------------------------------------------------------
// CHAIN + TVL (verbatim legacy)
// -----------------------------------------------------------------------------

async function queryPoolChain(swapAddress) {
  const queryB64 = Buffer.from('{"pool":{}}').toString('base64');
  const url = `${LCD_URL}/cosmwasm/wasm/v1/contract/${swapAddress}/smart/${queryB64}`;
  const resp = await fetchJson(url, { retries: 2, timeoutMs: 12000 });
  const d = resp?.data;
  if (!d || !Array.isArray(d.assets) || d.assets.length < 2) {
    throw new Error(`Unexpected pool response shape for ${swapAddress}`);
  }
  return {
    reserve_0: d.assets[0].amount,
    reserve_1: d.assets[1].amount,
    total_share: d.total_share
  };
}

function computePoolTvl(poolMeta, chainData, priceLookup) {
  const assets = poolMeta.pool_assets;
  const missing = [];
  let tvl = 0;
  for (let i = 0; i < 2; i++) {
    const a = assets[i];
    const price = priceForSymbol(a.symbol, priceLookup);
    const rawAmount = i === 0 ? chainData.reserve_0 : chainData.reserve_1;
    if (price == null) {
      missing.push(a.symbol);
      continue;
    }
    const amount = Number(rawAmount) / Math.pow(10, a.decimals);
    tvl += amount * price;
  }
  if (missing.length > 0) {
    return { tvl_usd: null, missing };
  }
  return { tvl_usd: Math.round(tvl * 100) / 100, missing: [] };
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      try {
        results[i] = { ok: true, value: await fn(items[i], i) };
      } catch (e) {
        results[i] = { ok: false, error: e };
      }
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// -----------------------------------------------------------------------------
// DATA SOURCES
// -----------------------------------------------------------------------------

async function loadPoolsList() {
  const url = POOLS_LIST_FIXTURE_URL || POOLS_LIST_URL;
  console.log(`  [pools_list] fetching: ${url}`);
  return await fetchJson(url, { retries: 2, timeoutMs: 15000 });
}

async function loadPrices() {
  if (PRICES_FIXTURE_URL) {
    console.log(`  [prices] fetching fixture: ${PRICES_FIXTURE_URL}`);
    return await fetchJson(PRICES_FIXTURE_URL, { retries: 2, timeoutMs: 15000 });
  }
  console.log(`  [prices] fetching repo feed: ${PRICES_PATH}`);
  const raw = await fetchRawFromRepo(PRICES_PATH);
  if (!raw) throw new Error(`prices feed unreachable: ${PRICES_PATH}`);
  return JSON.parse(raw);
}

// -----------------------------------------------------------------------------
// FRESHNESS (verbatim legacy fingerprint; previous heartbeat via raw fetch)
// -----------------------------------------------------------------------------

function computeDataFingerprint(poolsMetadata, chainResults) {
  const items = [];
  for (let i = 0; i < poolsMetadata.length; i++) {
    const meta = poolsMetadata[i];
    const res = chainResults[i];
    if (res && res.ok) {
      items.push([meta.pool_id, res.value.reserve_0, res.value.reserve_1, res.value.total_share]);
    } else {
      items.push([meta.pool_id, 'FAIL']);
    }
  }
  items.sort((a, b) => a[0].localeCompare(b[0]));
  const input = JSON.stringify(items);
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 12);
}

async function fetchPreviousHeartbeat() {
  try {
    const raw = await fetchRawFromRepo(`${OUT}/rolling/heartbeat.json`);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) {
    console.log(`  [freshness] no previous heartbeat available (${(e.message || '').slice(0, 60)})`);
    return null;
  }
}

function classifyFreshness(currentFp, prev) {
  if (!prev || !prev.dataFingerprint) {
    return { dataFreshness: 'fresh', consecutiveStuckRuns: 0, previousFingerprint: null };
  }
  const previousFingerprint = prev.dataFingerprint;
  if (currentFp !== previousFingerprint) {
    return { dataFreshness: 'fresh', consecutiveStuckRuns: 0, previousFingerprint };
  }
  const priorCount = Number(prev.consecutiveStuckRuns) || 1;
  const consecutive = priorCount + 1;
  const dataFreshness = consecutive >= STUCK_THRESHOLD ? 'stuck' : 'suspicious';
  return { dataFreshness, consecutiveStuckRuns: consecutive, previousFingerprint };
}

// -----------------------------------------------------------------------------
// DAILY SNAPSHOT (verbatim capture; publish list assembled by caller)
// -----------------------------------------------------------------------------

async function buildDaily(now) {
  const dateStr = now.toISOString().split('T')[0];
  const timeStr = now.toISOString().split('T')[1].split('.')[0];

  console.log('Loading pool metadata...');
  const poolsList = await loadPoolsList();
  const pools = poolsList.pools || [];
  if (pools.length === 0) throw new Error('pools_list.json returned zero pools');
  console.log(`  ✓ ${pools.length} active pools`);

  console.log('Loading token prices (network-and-prices feed)...');
  const napData = await loadPrices();
  const priceLookup = buildPriceLookup(napData);
  console.log(`  ✓ ${Object.keys(priceLookup).length} symbols priced (captured ${napData.capturedAt})`);

  console.log(`Querying chain for ${pools.length} pools (concurrency=${POOL_QUERY_CONCURRENCY})...`);
  const t0 = Date.now();
  const chainResults = await mapWithConcurrency(pools, POOL_QUERY_CONCURRENCY, (p) => queryPoolChain(p.swap_address));
  const okCount = chainResults.filter(r => r.ok).length;
  const failCount = chainResults.length - okCount;
  console.log(`  ✓ ${okCount}/${pools.length} pools queried in ${((Date.now() - t0) / 1000).toFixed(1)}s${failCount ? ` (${failCount} failed)` : ''}`);

  let csv = DAILY_HEADERS + '\n';
  const unpriced = [];
  const chainFailed = [];
  let tvlSum = 0;

  for (let i = 0; i < pools.length; i++) {
    const meta = pools[i];
    const res = chainResults[i];
    let tvlUsd = '';
    let r0 = '', r1 = '', ts = '';
    if (res.ok) {
      r0 = res.value.reserve_0;
      r1 = res.value.reserve_1;
      ts = res.value.total_share;
      const { tvl_usd, missing } = computePoolTvl(meta, res.value, priceLookup);
      if (tvl_usd != null) {
        tvlUsd = tvl_usd;
        tvlSum += tvl_usd;
      } else {
        unpriced.push({ pool: meta.pool_id, missing });
      }
    } else {
      chainFailed.push({ pool: meta.pool_id, error: res.error.message });
    }

    const row = [
      dateStr,
      timeStr,
      'skeletonswap',
      `"${meta.pool_id}"`,
      meta.swap_address,
      tvlUsd,
      '', // volume_24h_usd — no trustworthy source
      '', // volume_7d_usd  — no trustworthy source
      '', // apr_7d         — no trustworthy source
      r0,
      r1,
      ts
    ].join(',');
    csv += row + '\n';
  }

  console.log(`  Total TVL (priced pools): $${tvlSum.toLocaleString()}`);
  if (unpriced.length) {
    console.log(`  Pools without full pricing (${unpriced.length}):`);
    for (const u of unpriced) console.log(`    - ${u.pool} missing: ${u.missing.join(', ')}`);
  }
  if (chainFailed.length) {
    console.log(`  Chain query failures (${chainFailed.length}):`);
    for (const f of chainFailed) console.log(`    - ${f.pool}: ${f.error}`);
  }

  const dataFingerprint = computeDataFingerprint(pools, chainResults);

  return {
    csv, dateStr, timeStr,
    pools: pools.length,
    priced: pools.length - unpriced.length - chainFailed.length,
    unpriced: unpriced.length,
    chainFailed: chainFailed.length,
    tvlSum: Math.round(tvlSum * 100) / 100,
    dataFingerprint,
  };
}

// -----------------------------------------------------------------------------
// AGGREGATION CORE (verbatim legacy math over parsed daily rows)
// -----------------------------------------------------------------------------

function aggregateDailyRows(rowsByFile) {
  const poolData = {};
  for (const rows of rowsByFile) {
    for (const row of rows) {
      const poolId = rowPoolName(row);
      if (!poolData[poolId]) {
        poolData[poolId] = {
          pool_address: row.pool_address,
          tvl: [], volume: [], apr: [],
          reserve_0: [], reserve_1: [], total_share: []
        };
      }
      if (row.tvl_usd) poolData[poolId].tvl.push(parseFloat(row.tvl_usd));
      if (row.volume_24h_usd) poolData[poolId].volume.push(parseFloat(row.volume_24h_usd));
      if (row.apr_7d) poolData[poolId].apr.push(parseFloat(row.apr_7d));
      if (row.reserve_0) poolData[poolId].reserve_0.push(parseFloat(row.reserve_0));
      if (row.reserve_1) poolData[poolId].reserve_1.push(parseFloat(row.reserve_1));
      if (row.total_share) poolData[poolId].total_share.push(parseFloat(row.total_share));
    }
  }
  return poolData;
}

const avg = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
const sum = arr => arr.reduce((a, b) => a + b, 0);

function buildAggCsvFromDailies(periodLabel, poolData, meta) {
  let csv = AGG_HEADERS + '\n';
  for (const [poolId, data] of Object.entries(poolData)) {
    const row = [
      periodLabel,
      meta.period_start,
      meta.period_end,
      meta.snapshots_used,
      meta.snapshots_expected,
      meta.has_gaps,
      'skeletonswap',
      `"${poolId}"`,
      data.pool_address,
      avg(data.tvl).toFixed(2),
      sum(data.volume).toFixed(2),
      avg(data.apr).toFixed(4),
      avg(data.reserve_0).toFixed(0),
      avg(data.reserve_1).toFixed(0),
      avg(data.total_share).toFixed(0),
      data.tvl.length
    ].join(',');
    csv += row + '\n';
  }
  return csv;
}

// Fetch a set of dated daily CSVs by deterministic name; return parsed rows +
// the dates that actually existed (gap-honest).
async function fetchDailies(dates) {
  const rowsByFile = [];
  const datesUsed = [];
  for (const date of dates) {
    const content = await fetchRawFromRepo(`${OUT}/daily-csv/${date}.csv`);
    if (!content) continue;
    const rows = parseCSV(content);
    if (rows.length === 0) continue;
    rowsByFile.push(rows);
    datesUsed.push(date);
  }
  return { rowsByFile, datesUsed };
}

// -----------------------------------------------------------------------------
// 6-DAY ROLLING AVERAGE — past 6 calendar days (exclusive of today), fetched
// from the dated daily tree. Runs every invocation (astroport-fold pattern).
// -----------------------------------------------------------------------------

async function buildSixDayAvg(todayStr) {
  const today = new Date(todayStr + 'T00:00:00Z');
  const dates = [];
  for (let i = 6; i >= 1; i--) {
    dates.push(isoDate(today.getTime() - i * 24 * 60 * 60 * 1000));
  }
  const { rowsByFile, datesUsed } = await fetchDailies(dates);
  const poolData = aggregateDailyRows(rowsByFile);
  const meta = {
    period_start: datesUsed[0] || '',
    period_end: datesUsed[datesUsed.length - 1] || '',
    snapshots_used: datesUsed.length,
    snapshots_expected: 6,
    has_gaps: datesUsed.length < 6,
  };
  return { csv: buildAggCsvFromDailies('6-day-avg', poolData, meta), meta, pools: Object.keys(poolData).length };
}

// -----------------------------------------------------------------------------
// WEEKLY (EPOCH) AGGREGATION — previous COMPLETED epoch, deterministic window.
// Runs every invocation, so gaps self-heal as dailies accrue.
// -----------------------------------------------------------------------------

async function buildWeekly(now) {
  const currentEpoch = getEpochNumber(now);
  const epoch = currentEpoch - 1;                    // previous, completed
  const startMs = epochStartMs(epoch);
  const dates = [];
  for (let d = 0; d < 7; d++) dates.push(isoDate(startMs + d * 24 * 60 * 60 * 1000));
  const year = new Date(startMs).getUTCFullYear();   // year of the epoch's start
  const periodStr = `${year}-epoch-${epoch}`;

  const { rowsByFile, datesUsed } = await fetchDailies(dates);
  const poolData = aggregateDailyRows(rowsByFile);
  const meta = {
    period_start: datesUsed[0] || '',
    period_end: datesUsed[datesUsed.length - 1] || '',
    snapshots_used: datesUsed.length,
    snapshots_expected: 7,
    has_gaps: datesUsed.length < 7,
  };
  return {
    filename: `${OUT}/weekly-avg/${periodStr}.csv`,
    csv: buildAggCsvFromDailies(periodStr, poolData, meta),
    periodStr, epoch, meta, pools: Object.keys(poolData).length,
  };
}

// -----------------------------------------------------------------------------
// MONTHLY AGGREGATION — previous month from weekly epoch files, fetched by
// deterministic epoch range (verbatim math; period bounds fixed org-side).
// -----------------------------------------------------------------------------

async function buildMonthly(now) {
  const prevMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const year = prevMonth.getUTCFullYear();
  const month = String(prevMonth.getUTCMonth() + 1).padStart(2, '0');
  const periodStr = `${year}-${month}`;

  const monthStart = new Date(Date.UTC(year, prevMonth.getUTCMonth(), 1));
  const monthEnd = new Date(Date.UTC(year, prevMonth.getUTCMonth() + 1, 0));
  const epochStart = getEpochNumber(monthStart);
  const epochEnd = getEpochNumber(monthEnd);
  console.log(`  Month ${periodStr} spans epochs ${epochStart} to ${epochEnd}`);

  const poolData = {};
  let filesUsed = 0;
  const bounds = [];
  for (let ep = epochStart; ep <= epochEnd; ep++) {
    const epYear = new Date(epochStartMs(ep)).getUTCFullYear();
    const content = await fetchRawFromRepo(`${OUT}/weekly-avg/${epYear}-epoch-${ep}.csv`);
    if (!content) continue;
    const rows = parseCSV(content);
    if (rows.length === 0) continue;
    filesUsed++;
    for (const row of rows) {
      const poolId = rowPoolName(row);
      if (!poolData[poolId]) {
        poolData[poolId] = {
          pool_address: row.pool_address,
          tvl: [], volume: [], apr: [],
          reserve_0: [], reserve_1: [], total_share: [],
          snapshots: 0
        };
      }
      if (row.avg_tvl_usd) poolData[poolId].tvl.push(parseFloat(row.avg_tvl_usd));
      if (row.total_volume_usd) poolData[poolId].volume.push(parseFloat(row.total_volume_usd));
      if (row.avg_apr_7d) poolData[poolId].apr.push(parseFloat(row.avg_apr_7d));
      if (row.avg_reserve_0) poolData[poolId].reserve_0.push(parseFloat(row.avg_reserve_0));
      if (row.avg_reserve_1) poolData[poolId].reserve_1.push(parseFloat(row.avg_reserve_1));
      if (row.avg_total_share) poolData[poolId].total_share.push(parseFloat(row.avg_total_share));
      if (row.snapshot_count) poolData[poolId].snapshots += parseInt(row.snapshot_count);
      // org-wins fix: derive real period bounds from the weekly rows themselves
      if (row.period_start) bounds.push(row.period_start);
      if (row.period_end) bounds.push(row.period_end);
    }
  }

  bounds.sort();
  const expected = epochEnd - epochStart + 1;
  const meta = {
    period_start: bounds[0] || '',
    period_end: bounds[bounds.length - 1] || '',
    snapshots_used: filesUsed,
    snapshots_expected: expected,
    has_gaps: filesUsed < expected,
  };

  let csv = AGG_HEADERS + '\n';
  for (const [poolId, data] of Object.entries(poolData)) {
    const row = [
      periodStr,
      meta.period_start,
      meta.period_end,
      meta.snapshots_used,
      meta.snapshots_expected,
      meta.has_gaps,
      'skeletonswap',
      `"${poolId}"`,
      data.pool_address,
      avg(data.tvl).toFixed(2),
      sum(data.volume).toFixed(2),
      avg(data.apr).toFixed(4),
      avg(data.reserve_0).toFixed(0),
      avg(data.reserve_1).toFixed(0),
      avg(data.total_share).toFixed(0),
      data.snapshots
    ].join(',');
    csv += row + '\n';
  }

  return {
    filename: `${OUT}/monthly/${periodStr}.csv`,
    csv, periodStr, meta, pools: Object.keys(poolData).length,
  };
}

// -----------------------------------------------------------------------------
// GITHUB PUBLISH (epochs-astroport pattern; local fallback when no token)
// -----------------------------------------------------------------------------

function githubApiRequest(method, apiPath, body = null) {
  return httpRequest(`https://api.github.com${apiPath}`, {
    method,
    headers: {
      'Authorization': `token ${GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github.v3+json',
    },
    body: body ? JSON.stringify(body) : null,
    timeoutMs: 20000,
  }).then(r => ({ status: r.status, data: JSON.parse(r.body || '{}') }))
    .catch(e => ({ status: 0, data: { message: e.message } }));
}

async function pushToGithub(filepath, content, message) {
  const apiPath = `/repos/${GITHUB_REPO}/contents/${encodeURI(filepath)}`;
  // 409/422 sha-conflict retry — multiple crons write to tla-core concurrently.
  for (let attempt = 1; attempt <= 4; attempt++) {
    const existing = await githubApiRequest('GET', `${apiPath}?ref=${GITHUB_BRANCH}`);
    const sha = existing.data?.sha;
    const body = {
      message,
      content: Buffer.from(content).toString('base64'),
      branch: GITHUB_BRANCH,
      ...(sha ? { sha } : {}),
    };
    const result = await githubApiRequest('PUT', apiPath, body);
    if (result.status === 200 || result.status === 201) {
      console.log(`  ✅ Pushed: ${filepath}`);
      return true;
    }
    if (result.status === 409 || result.status === 422 || result.status >= 500 || result.status === 0) {
      console.log(`  ↻ push retry ${attempt} (HTTP ${result.status}) ${filepath}`);
      await new Promise(r => setTimeout(r, 400 * attempt + Math.floor(Math.random() * 300)));
      continue;
    }
    console.error(`  ❌ Push failed (HTTP ${result.status}): ${result.data?.message || '<no message>'}`);
    return false;
  }
  console.error(`  ❌ Push failed after retries: ${filepath}`);
  return false;
}

const publishedLocal = [];
async function publish(filepath, content, message) {
  if (GITHUB_TOKEN) {
    return pushToGithub(filepath, content, message);
  }
  // Local mode (mock gate / no token): write under ./out preserving tree.
  const fs = require('fs');
  const path = require('path');
  const local = path.join(process.env.LOCAL_OUT || './out', filepath);
  fs.mkdirSync(path.dirname(local), { recursive: true });
  fs.writeFileSync(local, content);
  publishedLocal.push(filepath);
  console.log(`  💾 Saved locally: ${local}`);
  return true;
}

// -----------------------------------------------------------------------------
// MAIN
// -----------------------------------------------------------------------------

async function captureSkeletonswapSeries() {
  const now = new Date();
  const dayNum = getDayOfWeekUTC(now);
  const currentEpoch = getEpochNumber(now);

  console.log(`\n💀 SkeletonSwap series (fold) — ${now.toISOString()}`);
  console.log(`   Epoch: ${currentEpoch}  Day: ${dayNum} (Mon=1..Sun=7)\n`);

  // ---- Daily capture (chain truth) ----------------------------------------
  const daily = await buildDaily(now);

  // ---- Rolling 6-day average ----------------------------------------------
  console.log('\nBuilding 6-day rolling average (fetching past dailies)...');
  const sixDay = await buildSixDayAvg(daily.dateStr);
  console.log(`  Used ${sixDay.meta.snapshots_used}/${sixDay.meta.snapshots_expected} dailies (${sixDay.meta.period_start} → ${sixDay.meta.period_end})`);

  // ---- Weekly (previous completed epoch) ----------------------------------
  console.log('\nBuilding weekly epoch aggregate (previous epoch, fetching dailies)...');
  const weekly = await buildWeekly(now);
  console.log(`  ${weekly.periodStr}: ${weekly.meta.snapshots_used}/${weekly.meta.snapshots_expected} dailies, ${weekly.pools} pools`);

  // ---- Monthly (1st of month UTC only, or forced) -------------------------
  let monthly = null;
  if (now.getUTCDate() === 1 || FORCE_MONTHLY) {
    console.log('\nBuilding monthly aggregate (previous month, fetching weeklies)...');
    monthly = await buildMonthly(now);
    console.log(`  ${monthly.periodStr}: ${monthly.meta.snapshots_used}/${monthly.meta.snapshots_expected} weeklies, ${monthly.pools} pools`);
  }

  // ---- Freshness ----------------------------------------------------------
  console.log('\nComputing data freshness...');
  const prevHeartbeat = await fetchPreviousHeartbeat();
  const freshness = classifyFreshness(daily.dataFingerprint, prevHeartbeat);
  const icon = { fresh: '✓', suspicious: '⚠', stuck: '🔴' }[freshness.dataFreshness];
  console.log(`  fingerprint: ${daily.dataFingerprint}  previous: ${freshness.previousFingerprint || '(none)'}`);
  console.log(`  ${icon} dataFreshness: ${freshness.dataFreshness}` +
    (freshness.consecutiveStuckRuns > 1 ? `  (${freshness.consecutiveStuckRuns} consecutive identical runs)` : ''));

  let status;
  if (freshness.dataFreshness === 'stuck') status = 'stuck';
  else if (daily.chainFailed > 0)          status = 'partial';
  else                                     status = 'ok';

  const heartbeat = {
    schemaVersion: 1,
    cron: 'dex-epochs-skeletonswap',
    capturedAt: now.toISOString(),
    capturedAtUnix: now.getTime(),
    runId: `ss-${now.toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)}`,
    runMode: 'daily',
    currentEpoch,
    status,
    stats: {
      poolsProcessed: daily.pools,
      poolsPriced: daily.priced,
      poolsUnpriced: daily.unpriced,
      poolsChainFailed: daily.chainFailed,
      tvlSumUsd: daily.tvlSum,
      fileWritten: `daily-csv/${daily.dateStr}.csv`,
    },
    dataFingerprint: daily.dataFingerprint,
    previousFingerprint: freshness.previousFingerprint,
    dataFreshness: freshness.dataFreshness,
    consecutiveStuckRuns: freshness.consecutiveStuckRuns,
    next_expected_run_at: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
  };

  // ---- Publish (heartbeat last) -------------------------------------------
  console.log('\n📤 Publishing...');
  await publish(`${OUT}/daily-csv/${daily.dateStr}.csv`, daily.csv, `💀 SkeletonSwap daily — ${daily.dateStr}`);
  await publish(`${OUT}/rolling/day-${dayNum}.csv`, daily.csv, `💀 SkeletonSwap day-${dayNum} (${daily.dateStr})`);
  await publish(`${OUT}/rolling/6-day-avg.csv`, sixDay.csv, `💀 SkeletonSwap 6-day rolling avg`);
  await publish(weekly.filename, weekly.csv, `💀 SkeletonSwap weekly accumulating — epoch ${weekly.epoch}`);
  if (monthly) {
    await publish(monthly.filename, monthly.csv, `💀 SkeletonSwap monthly — ${monthly.periodStr}`);
  }
  await publish(`${OUT}/rolling/heartbeat.json`, JSON.stringify(heartbeat, null, 2), `📍 SkeletonSwap series heartbeat — ${daily.dateStr}`);

  console.log(`\n✅ SkeletonSwap series complete (status=${status})\n`);
  return { daily, sixDay, weekly, monthly, heartbeat };
}

// Require-safe entry: standalone run keeps legacy behavior (exit codes);
// folded invocation from dex-data/index.js awaits main() without exiting.
module.exports = {
  main: captureSkeletonswapSeries,
  // Exposed for the mock gate ONLY (real-fixture parity tests). Not a public API.
  _test: { buildWeekly, buildMonthly, buildSixDayAvg, buildDaily, parseCSV,
           buildPriceLookup, computePoolTvl, getEpochNumber, classifyFreshness },
};
if (require.main === module) captureSkeletonswapSeries()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('\n❌ SkeletonSwap series failed:', err.message);
    console.error(err.stack);
    process.exit(1);
  });
