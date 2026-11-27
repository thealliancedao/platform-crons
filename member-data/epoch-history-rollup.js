#!/usr/bin/env node
'use strict';
/**
 * epoch-history-rollup.js — v1.0.0 (2026-09-20, TLA Stats step 2: the hero tiles' own history)
 * ---------------------------------------------------------------------------------------------
 * ONE per-epoch series for the six hero tiles of tla-stats.html, folded from the daily archives that already hold the
 * tiles' OWN basis (the page's buildLegacyDataShape reads tla-snapshot for TVL / pools / rewards / VP and eris-apr for APR):
 *   member-data/tla-snapshot/daily/YYYY-MM-DD.json   (archived current.json, 2026-05-13 → today, every epoch since E184)
 *   dex-data/eris-apr/daily/YYYY-MM-DD.json           (2026-08-02 → today, so APR history begins at E196 and says so)
 * Rule: an epoch's reading = the LAST daily of that epoch (what the page showed at the end of the week); the epoch average
 * rides beside it. Bribes (1.1.0): each day's active pots priced at THAT day's oracle price — denom → symbol through THE
 * token-catalog resolver (lib/denom-symbol.js, the effective layer), price from price-history/YYYY/MM.json; a day with any
 * unpriced asset is null, never partial. The live tile prices the same pots at the live LUNA price, so the top row can
 * differ from the last daily by the day's price move — timing, not definition. Facts only.
 * Pattern: apr-history-rollup.js (GitHub read/write on Render, --daily/--out locally). Never shrinks: an epoch already in
 * the file is rewritten only from the same or more days.
 *
 * DEPLOY ON RENDER: GITHUB_TOKEN, GITHUB_REPO (default thealliancedao/tla-core), GITHUB_BRANCH (default main).
 *   node epoch-history-rollup.js
 * LOCAL / TEST: node epoch-history-rollup.js --daily <tla-snapshot/daily> --eris <eris-apr/daily> --core <tla-core checkout> --out ./epoch-history.json
 */
const https = require('https'); const fs = require('fs'); const path = require('path');
const DS = require('../lib/denom-symbol.js');   // THE denom → symbol resolver (token-catalog effective layer); never a hand map
const VERSION = '1.2.0';   // 1.2.0 (2026-11-27, owner on the TVL history: "is this losing this much or are the tokens losing this much, is it outflows of liquidity or just prices … add a column for token prices and a second line in the chart — BTC at 60,000 and ROAR at 0.0000000x don't average nicely"): each epoch's TVL change is SPLIT against the epoch before — tvl_split { prices, flows, newly_valued, lost_value, other } — pool by pool from the staked LP amount and the pool's unit price (value ÷ amount), so prices are never averaged: a pool counts by how much of the TVL it is. price_index chains the price part (first epoch = 100). unvalued_staked names pools that were staked but had no price that week (the TVL leaves them out), with what they would be worth at the unit price they first got — an estimate, labelled, never added to the TVL   // 1.1.0: bribes_usd — the day's pots priced at THAT day's oracle price (token-catalog resolver + price-history months); null when any asset of the day is unpriced (blank beats phantom)
const GITHUB_TOKEN = process.env.GITHUB_TOKEN, GITHUB_REPO = process.env.GITHUB_REPO || 'thealliancedao/tla-core', GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const OUT_PATH = 'member-data/tla-snapshot/epoch-history.json', DAILY_DIR = 'member-data/tla-snapshot/daily', ERIS_DIR = 'dex-data/eris-apr/daily';

function parseArgs() { const a = process.argv.slice(2), o = { daily: null, eris: null, core: null, out: null }; for (let i = 0; i < a.length; i++) { if (a[i] === '--daily') o.daily = a[++i]; else if (a[i] === '--eris') o.eris = a[++i]; else if (a[i] === '--core') o.core = a[++i]; else if (a[i] === '--out') o.out = a[++i]; } return o; }
const CATALOG_PATH = 'token-catalog/snapshots/current.json', ORACLE_DIR = 'price-history';
// pots on a day at that day's oracle price: { usd, unpriced: [symbols or denoms] }
function priceBribes(snap, day, ctx) {
  if (!ctx || !ctx.resolve || !ctx.oracleDays) return { usd: null, unpriced: ['no oracle'] };
  let tot = 0; const miss = new Set(); const cell = ctx.oracleDays[day] || null; let any = false;
  for (const p of (snap.pools || [])) for (const b of ((p.bribes && p.bribes.active_now) || [])) for (const a of (b.assets || [])) {
    any = true; const d = a.info && (a.info.native || (a.info.cw20 ? 'cw20:' + a.info.cw20 : null)); const r = ctx.resolve(d);
    const px = r.symbol && cell && cell[r.symbol] && cell[r.symbol].usd != null ? Number(cell[r.symbol].usd) : null;
    if (px == null) { miss.add(r.symbol || d || '?'); continue; }
    tot += Number(a.amount) / Math.pow(10, r.decimals == null ? 6 : r.decimals) * px;
  }
  if (!any) return { usd: 0, unpriced: [] };
  return miss.size ? { usd: null, unpriced: [...miss] } : { usd: +tot.toFixed(2), unpriced: [] };
}
function gh(pathname, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: 'api.github.com', path: pathname, method, headers: { 'User-Agent': 'epoch-history-rollup', 'Authorization': `token ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github+json', ...(body ? { 'Content-Type': 'application/json' } : {}) } }, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, json: d ? JSON.parse(d) : null })); });
    req.on('error', reject); if (body) req.write(JSON.stringify(body)); req.end();
  });
}
async function ghList(dir) { const r = await gh(`/repos/${GITHUB_REPO}/contents/${dir}?ref=${GITHUB_BRANCH}`); if (r.status !== 200 || !Array.isArray(r.json)) return []; return r.json.filter(x => /^\d{4}-\d{2}-\d{2}\.json$/.test(x.name)).map(x => x.name).sort(); }
async function ghRead(p) { const r = await gh(`/repos/${GITHUB_REPO}/contents/${p}?ref=${GITHUB_BRANCH}`); if (r.status !== 200 || !r.json || !r.json.content) return { data: null, sha: null }; return { data: JSON.parse(Buffer.from(r.json.content, 'base64').toString('utf8')), sha: r.json.sha }; }
async function ghWrite(p, obj, sha, message) { const body = { message, content: Buffer.from(JSON.stringify(obj, null, 1) + '\n').toString('base64'), branch: GITHUB_BRANCH }; if (sha) body.sha = sha; const r = await gh(`/repos/${GITHUB_REPO}/contents/${p}`, 'PUT', body); if (r.status !== 200 && r.status !== 201) throw new Error(`write ${p}: HTTP ${r.status}`); }

// ---- 1.2.0 THE SPLIT (pure): why the TVL moved between two epoch-end readings ---------------------------------------------
// Per pool: V = staked_in_tla_usd, Q = the staked amount (amp_lp.underlying_lp_amount), unit price p = V / Q.
//   valued at both ends     → prices = Q_before × (p_now − p_before)   ·   flows = (Q_now − Q_before) × p_now      (the two add up to ΔV)
//   staked before with NO value, valued now  → newly_valued (the stake was there; only its price is new — not a deposit)
//   valued before, staked now with NO value  → lost_value   (the stake is there; its price is gone — not a withdrawal)
//   not staked before / not staked now       → flows (a new stake, or all of it withdrawn)
//   unit price moved more than 5× in the week, or a value with no amount → other (never forced into prices or flows)
// The five parts add up to the TVL change exactly (checked by the gate). Nothing is averaged across tokens.
const UNIT_JUMP = 5;
function poolMap(snap) { const m = new Map(); for (const p of (snap && Array.isArray(snap.pools) ? snap.pools : [])) { const k = `${p.gauge_pool_id || ''}|${p.dex || ''}|${p.name || ''}`; const V = Number(p.staked_in_tla_usd) || 0, Q = Number(p.amp_lp && p.amp_lp.underlying_lp_amount) || 0; const e = m.get(k); if (e) { e.V += V; e.Q += Q; } else m.set(k, { name: p.name || null, dex: p.dex || null, V, Q }); } return m; }
function splitChange(before, now) {
  const o = { prices: 0, flows: 0, newly_valued: 0, lost_value: 0, other: 0 }; const names = { newly_valued: [], lost_value: [], other: [] }; const movers = []; let split = 0, tb = 0, tn = 0;
  for (const k of new Set([...before.keys(), ...now.keys()])) { const a = before.get(k) || { V: 0, Q: 0 }, b = now.get(k) || { V: 0, Q: 0 }; tb += a.V; tn += b.V; if (!(a.V > 0) && !(b.V > 0)) continue; const nm = (now.get(k) || before.get(k)).name, dex = (now.get(k) || before.get(k)).dex;
    if (a.V > 0 && b.V > 0) { if (a.Q > 0 && b.Q > 0 && (b.V / b.Q) / (a.V / a.Q) <= UNIT_JUMP && (b.V / b.Q) / (a.V / a.Q) >= 1 / UNIT_JUMP) { const pa = a.V / a.Q, pb = b.V / b.Q, pe = a.Q * (pb - pa), fe = (b.Q - a.Q) * pb; o.prices += pe; o.flows += fe; split++; movers.push({ name: nm, dex, prices_usd: pe, flows_usd: fe }); } else { o.other += b.V - a.V; names.other.push(nm); } }
    else if (b.V > 0) { if (a.Q > 0) { o.newly_valued += b.V; names.newly_valued.push(nm); } else { o.flows += b.V; movers.push({ name: nm, dex, prices_usd: 0, flows_usd: b.V }); } }
    else { if (b.Q > 0) { o.lost_value -= a.V; names.lost_value.push(nm); } else { o.flows -= a.V; movers.push({ name: nm, dex, prices_usd: 0, flows_usd: -a.V }); } } }
  movers.sort((x, y) => (Math.abs(y.prices_usd) + Math.abs(y.flows_usd)) - (Math.abs(x.prices_usd) + Math.abs(x.flows_usd)));
  return { before_usd: tb, now_usd: tn, parts: o, names, pools_split: split, movers: movers.slice(0, 5).map(x => ({ name: x.name, dex: x.dex, prices_usd: Math.round(x.prices_usd), flows_usd: Math.round(x.flows_usd) })) };
}
// the split and the chained price index, onto epoch rows (epochs ascending; snaps = Map epoch → that epoch's last daily)
function addSplits(epochs, snaps) {
  const r2 = (x) => Math.round(x * 100) / 100; let prev = null, index = null; const maps = new Map(epochs.map(e => [e.epoch, poolMap(snaps.get(e.epoch))]));
  for (const e of epochs) { const m = maps.get(e.epoch);
    const unv = [...m.values()].filter(x => x.Q > 0 && !(x.V > 0)); e.unvalued_staked = { n: unv.length, names: unv.map(x => x.name).filter(Boolean).slice(0, 12) };
    if (!prev) { index = 100; e.price_index = 100; e.tvl_split = null; prev = e; continue; }
    const s = splitChange(maps.get(prev.epoch), m), base = s.before_usd;
    e.tvl_split = { vs_epoch: prev.epoch, change_usd: r2(s.now_usd - s.before_usd), prices_usd: r2(s.parts.prices), flows_usd: r2(s.parts.flows), newly_valued_usd: r2(s.parts.newly_valued), lost_value_usd: r2(s.parts.lost_value), other_usd: r2(s.parts.other),
      prices_pct: base > 0 ? +(s.parts.prices / base * 100).toFixed(2) : null, flows_pct: base > 0 ? +(s.parts.flows / base * 100).toFixed(2) : null, pools_split: s.pools_split,
      newly_valued: s.names.newly_valued.slice(0, 12), lost_value: s.names.lost_value.slice(0, 12), other: s.names.other.slice(0, 12), movers: s.movers };
    if (base > 0) index *= 1 + s.parts.prices / base; e.price_index = +index.toFixed(4); prev = e; }
  // a pool that was staked with no value, and later got one: what its stake would have been worth at the unit price it FIRST got — an
  // estimate (the unit price moves week to week), kept beside the TVL and never added to it
  const firstPrice = new Map(); for (const e of epochs) for (const [k, x] of maps.get(e.epoch)) if (x.V > 0 && x.Q > 0 && !firstPrice.has(k)) firstPrice.set(k, { p: x.V / x.Q, epoch: e.epoch });
  for (const e of epochs) { let est = 0; const who = []; for (const [k, x] of maps.get(e.epoch)) { const f = firstPrice.get(k); if (x.Q > 0 && !(x.V > 0) && f && f.epoch > e.epoch) { est += x.Q * f.p; who.push(x.name); } }
    if (who.length) e.unvalued_staked.later_valued = { names: who.slice(0, 12), est_usd_at_first_price: Math.round(est), note: 'staked that week with no price; valued here at the unit price each first got in a later epoch — an estimate, not in tla_tvl_usd' }; }
  return epochs;
}

// ---- THE FOLD (pure): dailies in, epochs out ------------------------------------------------------------------------
const isAstro = (dex) => /astro/i.test(dex || ''), isSS = (dex) => /skeleton/i.test(dex || '');
function dayRow(snap, eris, ctx) {
  const t = snap.totals || {}; const pools = Array.isArray(snap.pools) ? snap.pools : []; const active = pools.filter(p => p.status === 'active');
  const buckets = snap.buckets || {}; const vps = Object.values(buckets).map(b => Number(b.bucket_vp_human || 0)).filter(Number.isFinite);
  const row = {
    date: String(snap.capturedAt || '').slice(0, 10), epoch: snap.epoch && snap.epoch.currentEpoch != null ? Number(snap.epoch.currentEpoch) : null,
    tla_tvl_usd: num(t.tla_tvl_usd), active_pools: num(t.active_pools_count), active_pools_astro: active.filter(p => isAstro(p.dex)).length, active_pools_ss: active.filter(p => isSS(p.dex)).length,
    rewards_annual_usd: num(t.rewards && t.rewards.annual_emissions_usd), rewards_weekly_usd: num(t.rewards && t.rewards.weekly_emissions_usd), rewards_annual_luna: num(t.rewards && t.rewards.annual_emissions_luna),
    luna_price_usd: num(t.rewards && t.rewards.luna_price_used) ?? num(t.luna_price_usd), voting_vp: vps.length ? Math.max(...vps) : null,   // Eris convention: the max bucket (unique voters), never the pool sum
    apr_non_amp_pct: null, apr_amp_pct: null, apr_pools: 0, apr_tvl_usd: null, bribes_usd: null, bribes_unpriced: [],
  };
  { const b = priceBribes(snap, row.date, ctx); row.bribes_usd = b.usd; row.bribes_unpriced = b.unpriced; }
  if (eris && Array.isArray(eris.pools)) {   // TVL-weighted, the page's own rule (Batch A): Eris's numbers by gauge, null rows never a multiplier
    let wN = 0, wA = 0, tvN = 0, tvA = 0, n = 0;
    for (const p of eris.pools) { const tvl = Number(p.tla_staked_usd); if (!(tvl > 0)) continue; if (typeof p.eris_apr_pct === 'number') { wN += p.eris_apr_pct * tvl; tvN += tvl; n++; } if (typeof p.eris_apy_pct === 'number') { wA += p.eris_apy_pct * tvl; tvA += tvl; } }
    row.apr_non_amp_pct = tvN > 0 ? +(wN / tvN).toFixed(4) : null; row.apr_amp_pct = tvA > 0 ? +(wA / tvA).toFixed(4) : null; row.apr_pools = n; row.apr_tvl_usd = tvN > 0 ? +tvN.toFixed(2) : null;
  }
  return row;
}
const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v))) ? null : Number(v);
const FIELDS = ['tla_tvl_usd', 'active_pools', 'active_pools_astro', 'active_pools_ss', 'rewards_annual_usd', 'rewards_weekly_usd', 'rewards_annual_luna', 'luna_price_usd', 'voting_vp', 'apr_non_amp_pct', 'apr_amp_pct', 'bribes_usd'];
function fold(days, ctx) {   // days: [{ snap, eris }] any order; ctx: { resolve, oracleDays }
  const rows = days.map(d => dayRow(d.snap, d.eris, ctx)).filter(r => r.date && r.epoch != null).sort((a, b) => a.date.localeCompare(b.date));
  const lastSnap = new Map(); for (const d of days.slice().sort((a, b) => String(a.snap.capturedAt || '').localeCompare(String(b.snap.capturedAt || '')))) { const ep = d.snap.epoch && d.snap.epoch.currentEpoch != null ? Number(d.snap.epoch.currentEpoch) : null; if (ep != null && String(d.snap.capturedAt || '').slice(0, 10)) lastSnap.set(ep, d.snap); }   // 1.2.0: the same reading the row is made of
  const byEpoch = new Map(); for (const r of rows) { if (!byEpoch.has(r.epoch)) byEpoch.set(r.epoch, []); byEpoch.get(r.epoch).push(r); }
  const epochs = [];
  for (const [epoch, rs] of [...byEpoch.entries()].sort((a, b) => a[0] - b[0])) {
    const last = rs[rs.length - 1]; const avg = {}; for (const f of FIELDS) { const v = rs.map(r => r[f]).filter(x => x != null); avg[f] = v.length ? +(v.reduce((s, x) => s + x, 0) / v.length).toFixed(4) : null; }
    epochs.push({ epoch, date: last.date, days: rs.length, first_date: rs[0].date, ...Object.fromEntries(FIELDS.map(f => [f, last[f]])), apr_pools: last.apr_pools, apr_tvl_usd: last.apr_tvl_usd, bribes_unpriced: last.bribes_unpriced, avg, source: 'tla-snapshot daily (last reading of the epoch)' + (last.apr_non_amp_pct != null ? ' + eris-apr daily' : '') });
  }
  return addSplits(epochs, lastSnap);
}
function envelope(epochs, meta) {
  return { schemaVersion: 1, product: 'member-data/tla-snapshot/epoch-history', version: VERSION, generatedAt: new Date().toISOString(), rule: 'one row per epoch = the LAST daily reading of that epoch (what the page showed at the end of the week); `avg` = mean of the epoch\'s dailies; voting_vp = max bucket VP (Eris convention); APR = TVL-weighted eris-apr per gauge (null before 2026-08-02, the first eris-apr daily); bribes_usd = that day\'s active pots at that day\'s oracle price (token-catalog resolver + price-history); null when any asset of the day is unpriced; tvl_split (1.2.0) = the TVL change against the epoch before, split pool by pool from the staked amount and the unit price (value ÷ amount): prices + flows + newly_valued + lost_value + other = change, nothing averaged across tokens; price_index = the price part chained from 100 at the first epoch; unvalued_staked = pools staked that week with no price (left out of the TVL)', basis: { tla_tvl_usd: 'tla-snapshot totals.tla_tvl_usd (TLA-staked gauges, that day\'s LUNA price)', active_pools: 'tla-snapshot totals.active_pools_count; astro/ss from pools[].dex where status=active', rewards: 'tla-snapshot totals.rewards (annual/weekly emissions USD at that day\'s price)', voting_vp: 'max(buckets[].bucket_vp_human)', apr: 'eris-apr daily eris_apr_pct / eris_apy_pct weighted by tla_staked_usd', bribes: 'tla-snapshot pools[].bribes.active_now assets × price-history/<day>[symbol].usd (symbol via lib/denom-symbol.js, token-catalog effective layer)' }, epochs, ...meta };
}
function oracleFromMonths(months) { const days = {}; for (const m of months) if (m && m.days) Object.assign(days, m.days); return days; }
module.exports = { VERSION, fold, dayRow, envelope, FIELDS, main, priceBribes, oracleFromMonths, poolMap, splitChange, addSplits };

async function main() {
  const args = parseArgs();
  if (args.daily) {
    const files = fs.readdirSync(args.daily).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort(); const eris = args.eris && fs.existsSync(args.eris) ? new Set(fs.readdirSync(args.eris)) : new Set();
    const days = files.map(f => ({ snap: JSON.parse(fs.readFileSync(path.join(args.daily, f), 'utf8')), eris: eris.has(f) ? JSON.parse(fs.readFileSync(path.join(args.eris, f), 'utf8')) : null }));
    let ctx = null; if (args.core) { const cat = JSON.parse(fs.readFileSync(path.join(args.core, CATALOG_PATH), 'utf8')); const months = []; for (const y of fs.readdirSync(path.join(args.core, ORACLE_DIR)).filter(x => /^\d{4}$/.test(x))) for (const f of fs.readdirSync(path.join(args.core, ORACLE_DIR, y)).filter(x => /^\d{2}\.json$/.test(x))) months.push(JSON.parse(fs.readFileSync(path.join(args.core, ORACLE_DIR, y, f), 'utf8'))); ctx = { resolve: DS.buildResolver(cat), oracleDays: oracleFromMonths(months) }; }
    const out = envelope(fold(days, ctx), { days_read: files.length, eris_days_read: days.filter(d => d.eris).length, bribes_priced: !!ctx });
    if (args.out) fs.writeFileSync(args.out, JSON.stringify(out, null, 1) + '\n'); else console.log(JSON.stringify(out).slice(0, 2000));
    console.log(`epoch-history: ${out.epochs.length} epochs from ${files.length} dailies (${out.eris_days_read} with eris-apr)`); return;
  }
  if (!GITHUB_TOKEN) { console.error('GITHUB_TOKEN required (or run with --daily <dir> --out <file>)'); process.exit(1); }
  const dailyNames = await ghList(DAILY_DIR), erisNames = new Set(await ghList(ERIS_DIR));
  const existing = await ghRead(OUT_PATH); const have = new Map(((existing.data && existing.data.epochs) || []).map(e => [e.epoch, e]));
  const days = []; for (const f of dailyNames) { const s = await ghRead(`${DAILY_DIR}/${f}`); if (!s.data) continue; const e = erisNames.has(f) ? await ghRead(`${ERIS_DIR}/${f}`) : { data: null }; days.push({ snap: s.data, eris: e.data }); }
  // oracle + catalog for the bribe join: the months the dailies span
  const cat = (await ghRead(CATALOG_PATH)).data; const monthKeys = [...new Set(days.map(d => String(d.snap.capturedAt || '').slice(0, 7)).filter(Boolean))].sort();
  const months = []; for (const mk of monthKeys) { const [y, m] = mk.split('-'); const r = await ghRead(`${ORACLE_DIR}/${y}/${m}.json`); if (r.data) months.push(r.data); }
  const ctx = cat ? { resolve: DS.buildResolver(cat), oracleDays: oracleFromMonths(months) } : null;
  const epochs = fold(days, ctx);
  for (const e of epochs) { const h = have.get(e.epoch); if (h && h.days > e.days) { console.warn(`epoch ${e.epoch}: file has ${h.days} days, fold has ${e.days} — keeping the file's row (never shrink)`); Object.assign(e, h); } }
  const out = envelope(epochs, { days_read: days.length, eris_days_read: days.filter(d => d.eris).length, bribes_priced: !!ctx });
  await ghWrite(OUT_PATH, out, existing.sha, `epoch-history ${VERSION}: ${epochs.length} epochs (${days.length} dailies)`);
  console.log(`epoch-history: wrote ${epochs.length} epochs`);
}
if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });

