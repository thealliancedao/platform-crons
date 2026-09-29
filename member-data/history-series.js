'use strict';
// =============================================================================
// member-data / history-series.js 1.0.0 (2026-09-28) — ONE daily series per wallet, for the member portfolio's chart.
// -----------------------------------------------------------------------------
// Why (owner 2026-09-28: "portfolio trackers have a lot of functionality in their charts — time frames, trends for NFTs, TLA,
// Credia, Votion, Solid … a central chart the user can change"): the page's trend read the member daily archive
// (positions/daily, ~390 KB a day, registered members only) and SAMPLED 17 days of it — "all" showed 7 dots. The participants
// archive (participants/daily, every TLA lock holder, ~2.5 MB a day) was never readable from a phone at all.
// Here: every day of those archives folded ONCE into a small per-wallet series, sharded by the wallet's first address character
// (32 files; a page reads one ~100–300 KB file for any wallet's whole history).
//
// Output (tla-core):
//   member-data/history/series/<c>.json  { schemaVersion, product, shard, cols, wallets: { <addr>: [[row], …] } }  rows by day, asc
//   member-data/history/series/index.json  { cols, first_day, last_day, days, wallets, shards, sources, version, generated_at }
// Row (cols): d · p (the day's TLA total: locks + LP + wallet + DAO-staked) · lk (locked USD) · lkL (locked, LUNA at that day's hub
//   rates) · fx (locked, LUNA stamped at lock — VP = 10× at max) · lp · cu (staked in a DAO, USD) · cuS (0 = the day's capture,
//   1 = filled from the CAPA supply history, 2 = carried across a hole in that history — held on both sides) · wb (TLA tokens in the wallet) · vt (Votion, USD) · vtv (Votion implied VP) ·
//   cs / cb (Credia supplied / borrowed USD) · vp · pvp (VP if adjusted) · pr (pending rewards USD) · px (LUNA USD that day) ·
//   nl (lock count) · src (p = participants archive, m = member archive) · ss / sb (1.1.0: Solid collateral incl. idle / SOLID debt, USD;
//   null before Solid was captured, and for a wallet with nothing in Solid)
// Blank beats phantom: a field the day's capture did not carry is null, never 0. A day with no archive file is a gap (no row).
//
// When: the first run with no index SEEDS every archived day (2026-08-11 → today), one day at a time (read → fold → drop:
// Render heap); after that, the 23:xx UTC run refolds today (and fills any missing day since the last); HISTORY=force refolds
// everything; HISTORY=0 disables. Publishes the changed shards as ONE commit (tla-flows lib/git-batch.js).
// The deep backfill (SPEC-deep-history) writes older days into the SAME files with src = 'd' — one canonical file per series.
// =============================================================================
const VERSION = 'history-series-1.2.0';   // 1.2.0 (2026-09-29, the GMC backing wallet): a day whose capture held an LP position it could NOT price (estimated_position_usd null — e.g. wBTC.creda.a before capture-engine priced it on 09-28) records lp and the TLA total as BLANK, not $0 — the chart shows a gap, never a phantom 99 % drop; a series built by an older version rebuilds itself · 1.1.0 (2026-09-28): + ss / sb — Solid collateral (locked + idle) and SOLID debt in USD (member-data 1.6.0 attachSolid); appended, readers decode by name
const OUT_DIR = 'member-data/history/series';
const FIRST_ARCHIVE_DAY = '2026-08-11';   // the org participants / member archives start here (older days live in the legacy repos)
const COLS = ['d', 'p', 'lk', 'lkL', 'fx', 'lp', 'cu', 'cuS', 'wb', 'vt', 'vtv', 'cs', 'cb', 'vp', 'pvp', 'pr', 'px', 'nl', 'src', 'ss', 'sb'];
const SHARD_CHARS = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';   // bech32 — the character after "terra1"
const shardOf = (addr) => { const c = String(addr || '').charAt(6); return SHARD_CHARS.includes(c) ? c : '_'; };
const r2 = (x) => (x == null || !isFinite(x)) ? null : Math.round(x * 100) / 100;
const r6 = (x) => (x == null || !isFinite(x)) ? null : Math.round(x * 1e6) / 1e6;
const num = (x) => (x == null || x === '' || !isFinite(Number(x))) ? null : Number(x);
const dayList = (from, to) => { const out = []; for (let t = Date.parse(from + 'T00:00:00Z'); t <= Date.parse(to + 'T00:00:00Z'); t += 864e5) out.push(new Date(t).toISOString().slice(0, 10)); return out; };

// ── one wallet's row for one day (pure) ─────────────────────────────────────────────────────────────────────────────
// m = a capture-engine portfolio record (participants or member archive); vot = { usd, vp } or null; cuFill = { usd } or null
// (the CAPA supply history, only for a day whose capture did not carry custody); px = LUNA USD that day
function rowOf(day, m, src, vot, cuFill, px) {
  const s = (m && m.summary) || {};
  const inc = !!s.total_includes_custody;
  const cuCap = inc ? num(s.custody_usd) : null;
  const cu = inc ? (cuCap || 0) : (cuFill && cuFill.usd > 0 ? cuFill.usd : null);
  const lpUnpriced = ((m && m.lp_positions) || []).some(x => x && x.estimated_position_usd == null);   // 1.2.0: blank beats phantom
  const base = lpUnpriced ? null : num(s.total_portfolio_value_usd);
  const p = base == null ? null : base + (!inc && cu ? cu : 0);   // the day's TLA total, the DAO stake once
  return [day, r2(p), r2(num(s.total_locked_usd)), r2(num(s.total_locked_luna_equivalent)), r2(num(s.fixed_amount_human)), lpUnpriced ? null : r2(num(s.total_lp_position_usd)),
    r2(cu), cu == null ? null : (inc ? 0 : (cuFill && cuFill.carried ? 2 : 1)), r2(num(s.total_wallet_balances_usd)),
    vot ? r2(vot.usd) : null, vot ? r2(vot.vp) : null,
    s.credia_supplied_usd !== undefined ? r2(num(s.credia_supplied_usd)) : null, s.credia_borrowed_usd !== undefined ? r2(num(s.credia_borrowed_usd)) : null,
    r2(num(s.voting_power_human)), r2(num(s.potential_vp_human)), r2(num(s.total_pending_rewards_usd)), r6(px), num(s.lock_count), src,
    s.solid_collateral_usd !== undefined ? r2((num(s.solid_collateral_usd) || 0) + (num(s.solid_idle_usd) || 0)) : null, s.solid_debt_usd !== undefined ? r2(num(s.solid_debt_usd)) : null];
}

// ── fold one archived day into the state (pure given its inputs) ────────────────────────────────────────────────────
// state: { wallets: Map<addr, Map<day,row>> } · inputs: { parts, members, votion, capaRows, capaPx }
function foldDay(state, day, inp) {
  const seen = new Set(); let n = 0;
  const vot = new Map();
  for (const v of (inp.votion && inp.votion.vaults) || []) for (const h of v.holders || []) {
    const x = vot.get(h.address) || { usd: 0, vp: 0 }; x.usd += num(h.underlying_usd) || 0; x.vp += num(h.implied_vp) || 0; vot.set(h.address, x); }
  const px = num(inp.parts && inp.parts.luna_price_used_usd) ?? num(inp.members && inp.members.luna_price_used_usd);
  const capaFill = (addr) => { if (!inp.capaRows || !inp.capaPx) return null; const r = inp.capaRows[addr]; const capa = r ? num(r[1]) : 0; return capa > 0 ? { usd: capa * inp.capaPx, capa } : null; };
  const put = (m, src) => {
    const addr = m && m.wallet; if (!addr || seen.has(addr) || !m.summary) return; seen.add(addr);
    const inc = !!m.summary.total_includes_custody;
    const fill = inc ? null : capaFill(addr); if (fill && inp.carried) fill.carried = true;
    const row = rowOf(day, m, src, vot.has(addr) ? vot.get(addr) : (inp.votion ? { usd: 0, vp: 0 } : null), fill, px);
    const w = state.wallets.get(addr) || state.wallets.set(addr, new Map()).get(addr); w.set(day, row); n++;
  };
  for (const m of (inp.parts && inp.parts.members) || []) put(m, 'p');        // every TLA lock holder
  const M = inp.members || {};
  for (const m of M.members || []) put(m, 'm');                                // registered members the lock census does not carry
  for (const m of [M.treasury, ...(M.treasuries || []), ...(M.council || []), ...(M.council_treasuries || [])]) if (m && m.wallet) put(m, 'm');
  return n;
}

// ── shard files from the state (pure) ───────────────────────────────────────────────────────────────────────────────
function buildFiles(state, meta) {
  const shards = new Map(); let first = null, last = null; const days = new Set();
  for (const [addr, byDay] of [...state.wallets].sort(([a], [b]) => a.localeCompare(b))) {
    const rows = [...byDay.values()].sort((a, b) => a[0].localeCompare(b[0]));
    for (const r of rows) { days.add(r[0]); if (!first || r[0] < first) first = r[0]; if (!last || r[0] > last) last = r[0]; }
    const c = shardOf(addr); const sh = shards.get(c) || shards.set(c, {}).get(c); sh[addr] = rows;
  }
  const files = [];
  for (const [c, wallets] of [...shards].sort(([a], [b]) => a.localeCompare(b))) files.push({ path: `${OUT_DIR}/${c}.json`, obj: { schemaVersion: 1, product: 'member-data/history/series', shard: c, cols: COLS, wallets } });
  const index = { schemaVersion: 1, product: 'member-data/history/series', version: VERSION, generated_at: meta.now, cols: COLS, first_day: first, last_day: last, days: days.size,
    wallets: state.wallets.size, shards: Object.fromEntries([...shards].map(([c, w]) => [c, Object.keys(w).length])), shard_rule: 'the character after "terra1" (bech32); anything else → "_"',
    sources: { p: 'member-data/participants/daily (every TLA lock holder)', m: 'member-data/positions/daily (registered members, treasury, council)', vt: 'votion/snapshots/daily', cu_fill: 'token-catalog/supply/capa/wallets-daily × price-history/series/CAPA.json (days captured before capture-engine 1.2 carried custody; cuS 1 = the nearest capture ≤ 7 days back, 2 = carried across the 2026-08-10 → 08-23 hole where the stake is held on both sides)', d: 'deep backfill (SPEC-deep-history) — not yet' },
    note: 'One row per wallet per archived day; a day with no archive is a gap, never interpolated. Blank beats phantom: null = the capture did not carry the field.' };
  files.push({ path: `${OUT_DIR}/index.json`, obj: index });
  return { files, index };
}
const serialize = (obj) => JSON.stringify(obj) + '\n';

// ── read the committed series back into a state ─────────────────────────────────────────────────────────────────────
async function loadState(fetchJson, rawBase, index) {
  const state = { wallets: new Map() };
  for (const c of Object.keys(index.shards || {})) {
    const f = await fetchJson(`${rawBase}/${OUT_DIR}/${c}.json?t=${Date.now()}`).catch(() => null); if (!f) continue;
    for (const [addr, rows] of Object.entries(f.wallets || {})) state.wallets.set(addr, new Map(rows.map(r => [r[0], r])));
  }
  return state;
}

// ── the duty ────────────────────────────────────────────────────────────────────────────────────────────────────────
// deps: { fetchJson(url) → obj (throws on 404), publishBatch(files[{path, content}], message), rawBase, env, now() → Date }
async function run(deps) {
  const { fetchJson, publishBatch, rawBase, env = {}, now = () => new Date() } = deps; const log = deps.log || console.log;
  if (env.HISTORY === '0') { log('  history-series: disabled (HISTORY=0)'); return { status: 'skipped', reason: 'HISTORY=0' }; }
  const t = now(); const today = t.toISOString().slice(0, 10); const hour = t.getUTCHours();
  let index = env.HISTORY === 'force' ? null : await fetchJson(`${rawBase}/${OUT_DIR}/index.json?t=${Date.now()}`).catch(() => null);
  if (index && index.version && index.version !== VERSION) { log(`  history-series: built by ${index.version} — rebuilding every day with ${VERSION}`); index = null; }   // 1.2.0: no HISTORY=force after a deploy
  let from;
  if (!index) from = FIRST_ARCHIVE_DAY;                                        // seed
  else if (index.last_day < today) from = new Date(Date.parse(index.last_day + 'T00:00:00Z') + 864e5).toISOString().slice(0, 10);
  else if (hour === 23 || env.HISTORY === '1') from = today;                   // refold today from its (near-final) archive
  else { log(`  history-series: up to date (${index.last_day}); today refolds at 23:xx UTC`); return { status: 'skipped', reason: 'up to date' }; }
  const state = index ? await loadState(fetchJson, rawBase, index) : { wallets: new Map() };
  // the CAPA custody fill (days before capture-engine 1.2): the supply history's nearest day ≤ 7 days back × CAPA that day
  const capaIdx = await fetchJson(`${rawBase}/token-catalog/supply/capa/wallets-daily/index.json?t=${Date.now()}`).catch(() => null);
  const capaPx = await fetchJson(`${rawBase}/price-history/series/CAPA.json?t=${Date.now()}`).catch(() => null);
  const capaDays = ((capaIdx && capaIdx.days) || []).map(d => d.date).sort();
  let folded = 0, gaps = [];
  for (const day of dayList(from, today)) {
    const g = (p) => fetchJson(`${rawBase}/${p}?t=${Date.now()}`).catch(() => null);
    const parts = await g(`member-data/participants/daily/${day}.json`);
    const members = await g(`member-data/positions/daily/${day}.json`);
    if (!parts && !members) { gaps.push(day); continue; }
    const votion = await g(`votion/snapshots/daily/${day}.json`);
    let capaRows = null, cpx = null, carried = false;
    const needFill = [...((parts && parts.members) || []), ...((members && members.members) || [])].some(m => m && m.summary && !m.summary.total_includes_custody);
    if (needFill && capaDays.length) {
      const t0 = Date.parse(day + 'T00:00:00Z'); const dt = (d) => Date.parse(d + 'T00:00:00Z');
      const prev = capaDays.filter(d => d <= day).pop(), next = capaDays.find(d => d > day);
      if (prev && dt(prev) >= t0 - 7 * 864e5) { const f = await g(`token-catalog/supply/capa/wallets-daily/${prev}.json`); capaRows = f && f.rows || null; }
      else if (prev && next && dt(next) - dt(prev) <= 21 * 864e5) {
        // the supply history has a hole around this day (2026-08-10 → 08-23): a stake present on BOTH sides of the hole is carried
        // at the earlier capture's CAPA (a lower bound — the receipt only compounds up), priced at this day's CAPA; flagged cuS=2.
        // A stake on one side only is not carried (it may have moved in the hole) — never guessed.
        const [a, b] = [await g(`token-catalog/supply/capa/wallets-daily/${prev}.json`), await g(`token-catalog/supply/capa/wallets-daily/${next}.json`)];
        if (a && a.rows && b && b.rows) { capaRows = {}; for (const [w, r] of Object.entries(a.rows)) if (num(r[1]) > 0 && b.rows[w] && num(b.rows[w][1]) > 0) capaRows[w] = r; carried = true; }
      }
      for (let i = 0; i <= 3 && cpx == null; i++) cpx = num(capaPx && capaPx.daily && capaPx.daily[new Date(t0 - i * 864e5).toISOString().slice(0, 10)]);
    }
    const n = foldDay(state, day, { parts, members, votion, capaRows, capaPx: cpx, carried });
    folded++; log(`  history-series: ${day} — ${n} wallets${votion ? '' : ' (no Votion archive that day)'}${needFill ? (capaRows && cpx ? (carried ? ' · DAO stake carried across the CAPA supply-history hole' : ' · DAO stake filled from the CAPA supply history') : ' · no CAPA fill available') : ''}`);
  }
  if (!folded) { log(`  history-series: nothing to fold (${gaps.length} day(s) without an archive: ${gaps.join(', ')})`); return { status: 'skipped', reason: 'no archive', gaps }; }
  const { files, index: ix } = buildFiles(state, { now: t.toISOString() });
  const out = files.map(f => ({ path: f.path, content: serialize(f.obj) }));
  const r = await publishBatch(out, `member-data: history series ${from === today ? today : from + ' → ' + today} (${ix.wallets} wallets, ${ix.days} days)`);
  log(`  history-series: ${ix.wallets} wallets × ${ix.days} days (${ix.first_day} → ${ix.last_day}) in ${files.length - 1} shards · commit ${r && r.commit ? String(r.commit).slice(0, 7) : '—'}`);
  return { status: 'ok', folded, gaps, index: ix, files: out.length };
}

module.exports = { VERSION, COLS, OUT_DIR, FIRST_ARCHIVE_DAY, shardOf, rowOf, foldDay, buildFiles, loadState, run };
