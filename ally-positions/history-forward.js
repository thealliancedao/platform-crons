/* =============================================================================
 * ally-positions/history-forward.js 1.0.0 (2026-09-26) — THE DAILY SERIES, KEPT GOING. Runs inside the hourly positions job.
 * -----------------------------------------------------------------------------
 * Why: history/daily.json was a one-off archive backfill (backfill.js, manual Action) — it stopped at 2026-09-18, so every trend
 * on the Lion DAO pages froze there. And the market figures (ROAR / pyROAR / ROAR20 price, holder counts) were read live and
 * never kept, so they had no trend at all (owner 2026-09-26: "do we have things capturing data so we can power trends?").
 *
 * Two duties, both cheap, both never fail the positions run:
 *   1. CHAIN SERIES  → <dao>/history/daily.json (the SAME product and row shape backfill.js writes: pyroar_supply,
 *      roar_supply, roar_staked, pixelions_staked, validator). For every CLOSED UTC day after the file's last_day (at most
 *      MAX_DAYS per run), backfill.js's own readDay / heightAtEndOfDay / merge run against the PUBLIC node — the state at the
 *      last block of that day. A height the public node has pruned is skipped with its reason (the manual archive Action fills
 *      those: FROM=<day> TO=<day>). And if YESTERDAY could not be read at height, the last run of a day (23:xx UTC) writes
 *      today's row from the latest state instead, labeled `method: latest_state_at_capture` — so the series never silently stops.
 *   2. MARKET SERIES → <dao>/history/markets.json (new): one row per UTC day, rewritten by every hourly run (the last run of the
 *      day is what stays): ROAR price + 24h (network-and-prices, the TLA pool), pyROAR price (the registered pyROAR pair, live,
 *      × ROAR), ROAR20 price / volume / market cap (the roar20 market capture this run made), holder counts (the published
 *      roar / pyROAR / ROAR20 holder products), Burning Lions minted + holders (cw721, live). Every field names its source; a
 *      failed read is null with a reason, never a zero. Keeps 3 years.
 * The registry holds the literals (tenants.json); this file names no address.
 * ============================================================================= */
'use strict';
const VERSION = '1.0.1';   // 1.0.1 (owner's first run: the public node had pruned all seven missing days — 7 day-searches every hour for nothing): probe the NEWEST missing day first; if the node cannot serve it, the older ones are not tried (they are older still) — they wait for the archive Action
const E = require('../lib/capture-engine.js');
const MAX_DAYS = Math.max(1, Math.min(14, Number(process.env.HISTORY_MAX_DAYS || 7)));
const KEEP_DAYS = 3 * 366;
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const b64 = (q) => Buffer.from(JSON.stringify(q)).toString('base64');
const day = (ms) => new Date(ms).toISOString().slice(0, 10);
const NFTC = 'https://raw.githubusercontent.com/thealliancedao/nft-collections/main/';
const DAOO = 'https://raw.githubusercontent.com/thealliancedao/dao-originations/main/';
const NAP = 'https://raw.githubusercontent.com/thealliancedao/tla-core/main/network-and-prices/current.json';

async function smart(contract, q) {
  for (const h of [E.TERRA_LCD_PRIMARY, E.TERRA_LCD_FALLBACK]) { try { const r = await E.fetchJson(`${h}/cosmwasm/wasm/v1/contract/${contract}/smart/${b64(q)}`, 'smart'); if (r && r.data !== undefined) return r.data; } catch (e) { /* next host */ } }
  return null;
}
const denomOf = (info) => info && (info.token ? info.token.contract_addr : info.native_token ? info.native_token.denom : info.cw20 || info.native || null);

// ---------------------------------------------------------------- 1. chain series (backfill.js's reads, against the public node)
async function chainSeries(o) {
  const path = `${o.outRoot}/history/daily.json`; const log = o.log;
  const existing = await o.readJson(path).catch(() => null);
  const last = existing && existing.last_day; const yesterday = day(Date.now() - 864e5);
  const want = []; if (last) { for (let d = new Date(last + 'T00:00:00Z'); ; ) { d.setUTCDate(d.getUTCDate() + 1); const s = d.toISOString().slice(0, 10); if (s > yesterday) break; want.push(s); } } else want.push(yesterday);
  const todo = want.slice(-MAX_DAYS); const hourUtc = new Date().getUTCHours();
  if (!todo.length && !(hourUtc === 23 && last !== day(Date.now()))) { log(`  history daily: up to date (last day ${last})`); return null; }
  // backfill.js reads ARCHIVE_LCD at require time — point it at the public node for this in-process use (never an archive on Render)
  if (!process.env.ARCHIVE_LCD) process.env.ARCHIVE_LCD = E.TERRA_LCD_PRIMARY;
  const B = require('./backfill.js');
  let rows = [], skipped = [];
  const okRows = (res) => res.rows.filter(r => Object.values(r.reads || {}).some(v => v === 'ok'));
  if (todo.length) { const probe = await B.run({ allowNonManual: true, days: [todo[todo.length - 1]] }); rows = okRows(probe);
    if (!rows.length) skipped = [{ day: todo.length > 1 ? todo[0] + ' … ' + todo[todo.length - 1] : todo[0], reason: 'the public node does not serve state at those heights (pruned) — the archive backfill Action fills them: FROM=' + todo[0] + ' TO=' + todo[todo.length - 1] }];
    else if (todo.length > 1) { const res = await B.run({ allowNonManual: true, days: todo.slice(0, -1) }); const more = okRows(res); rows = more.concat(rows); skipped = res.skipped.concat(res.rows.filter(r => !more.includes(r)).map(r => ({ day: r.day, reason: 'every read failed at height ' + r.height }))); } }
  const gotYesterday = rows.some(r => r.day === yesterday) || last === yesterday;
  // the fallback: the day's LAST hourly run writes today's row from the latest state when the public node cannot serve heights
  if (!gotYesterday && hourUtc === 23) {
    const t = o.tenant; const latest = await E.fetchJson(`${E.TERRA_LCD_PRIMARY}/cosmos/base/tendermint/v1beta1/blocks/latest`, 'latest block').catch(() => null);
    const h = latest && latest.block ? { height: num(latest.block.header.height), time: latest.block.header.time } : { height: null, time: new Date().toISOString() };
    try { const row = await B.readDay(day(Date.now()), h, t); row.method = 'latest_state_at_capture'; row.method_note = 'the public node did not serve the previous days at height; this is the state at the 23:xx UTC run — the archive Action can replace it with the end-of-day read'; rows.push(row); }
    catch (e) { skipped.push({ day: day(Date.now()), reason: 'latest-state fallback failed: ' + e.message }); }
  }
  for (const s of skipped) log(`  history daily: skipped ${s.day} — ${s.reason}`);
  if (!rows.length) { log('  history daily: nothing measured this run' + (skipped.length ? ' (the public node likely pruned those heights — run the archive backfill Action for them)' : '')); return null; }
  const meta = { product: `${o.outRoot}/history/daily`, sources: { forward: { engine: 'history-forward ' + VERSION, node: E.TERRA_LCD_PRIMARY, method: 'state at the last block of each closed UTC day, read hourly by the positions job; latest-state fallback at 23:xx UTC when heights are pruned' } } };
  const doc = B.merge(existing, rows, meta);
  log(`  history daily: +${rows.map(r => r.day + (r.method ? ' (latest state)' : '')).join(', ')} → ${doc.day_count} days, last ${doc.last_day} → ${await o.publish(path, JSON.stringify(doc, null, 1), `📜 ${o.tenantSlug} history ${doc.last_day}`)}`);
  return doc;
}

// ---------------------------------------------------------------- 2. market series (today's row, rewritten each run)
async function marketSeries(o) {
  const t = o.tenant; const st = t.staking || {}, burn = t.burn || {}, bl = t.burning_lions || {}; const log = o.log;
  const row = { day: day(Date.now()), capturedAt: new Date().toISOString(), sources: {}, reasons: {} };
  const set = (k, v, src, why) => { row[k] = v == null ? null : v; if (v == null) row.reasons[k] = why || 'not read'; else if (src) row.sources[k] = src; };
  // ROAR — the price feed the whole platform uses (network-and-prices: the TLA pool on Astroport)
  const nap = await E.fetchJson(NAP, 'network-and-prices').catch(() => null); const R = nap && nap.token_prices && nap.token_prices.ROAR;
  const ap = R && R.prices && R.prices.astroport; const roarUsd = R ? num(R.final_price_usd) != null ? num(R.final_price_usd) : num(ap && ap.price_usd) : null;
  set('roar_usd', roarUsd, 'network-and-prices ROAR', 'ROAR not in network-and-prices'); set('roar_chg_24h_pct', ap ? num(ap.price_change_24h_pct) : null, 'network-and-prices (astroport)', 'no 24h figure in the feed');
  set('luna_usd', nap && nap.token_prices && nap.token_prices.LUNA ? num(nap.token_prices.LUNA.final_price_usd) : null, 'network-and-prices LUNA');
  // pyROAR — the registered pair, live: ROAR per pyROAR × ROAR's USD
  if (burn.pyroar_pair && burn.pyroar_cw20) { const pool = await smart(burn.pyroar_pair, { pool: {} }); const as = pool && Array.isArray(pool.assets) ? pool.assets : [];
    const py = as.find(a => denomOf(a.info) === burn.pyroar_cw20), other = as.find(a => denomOf(a.info) !== burn.pyroar_cw20);
    const inRoar = py && other && denomOf(other.info) === st.roar_cw20 && num(py.amount) > 0 ? num(other.amount) / num(py.amount) : null;   // both 6 decimals
    set('pyroar_in_roar', inRoar, 'pyROAR pair pool (live)', pool ? 'the pair is not pyROAR/ROAR' : 'the pair did not answer');
    set('pyroar_usd', inRoar != null && roarUsd != null ? inRoar * roarUsd : null, 'pyROAR pair × ROAR', 'pyROAR or ROAR price missing');
    set('pyroar_pair_depth_usd', py && roarUsd != null && inRoar != null ? 2 * num(py.amount) / 1e6 * inRoar * roarUsd : null, 'pyROAR pair reserves'); }
  else set('pyroar_usd', null, null, 'no pyROAR pair registered (tenants.json burn.pyroar_pair)');
  // ROAR20 — the market capture this same run made (roar20-market.js); null when every source failed
  const m = o.roar20Market; set('roar20_usd', m ? m.price_usd : null, m ? 'roar20/market (' + m.source + ')' : null, 'the ROAR20 market capture had no answer this run');
  set('roar20_volume_24h_usd', m ? m.volume_24h_usd : null, m ? 'roar20/market (' + m.source + ')' : null, 'no volume figure'); set('roar20_market_cap_usd', m ? m.market_cap_usd : null, m ? 'roar20/market (' + m.source + ')' : null, 'no market cap figure');
  // holder counts — the published holder products (daily duty); the day they were captured is kept beside the count
  for (const [k, rel] of [['roar_holders', 'roar/holders.json'], ['pyroar_holders', 'burn/holders.json'], ['roar20_holders', 'roar20/holders.json']]) {
    const h = await E.fetchJson(DAOO + o.outRoot + '/' + rel + '?t=' + Date.now(), rel).catch(() => null);
    set(k, h ? num(h.holder_count) : null, h ? rel + ' @ ' + String(h.capturedAt || '').slice(0, 10) : null, rel + ' not readable'); }
  // Burning Lions — minted and holders, live (a handful of reads)
  if (bl.contract) { const nt = await smart(bl.contract, { num_tokens: {} }); set('bl_minted', nt ? num(nt.count) : null, 'cw721 num_tokens', 'the cw721 did not answer');
    const at = await smart(bl.contract, { all_tokens: { limit: 30 } }); const ids = at && Array.isArray(at.tokens) ? at.tokens : [];
    const owners = []; for (const id of ids) { const ow = await smart(bl.contract, { owner_of: { token_id: id } }); owners.push(ow ? ow.owner : null); }
    set('bl_holders', ids.length && owners.every(Boolean) ? new Set(owners).size : null, 'cw721 owner_of per token', ids.length ? 'owner_of did not answer for every lion' : 'all_tokens did not answer'); }
  // pixeLions floor lives in its own daily product (nft-collections/pixel-lions/snapshots/floor-history.json) — referenced, not copied
  const path = `${o.outRoot}/history/markets.json`; const ex = await o.readJson(path).catch(() => null);
  const days = Object.assign({}, ex && ex.days ? ex.days : {}); days[row.day] = row;
  const cut = day(Date.now() - KEEP_DAYS * 864e5); for (const d of Object.keys(days)) if (d < cut) delete days[d];
  const keys = Object.keys(days).sort();
  const doc = { product: `${o.outRoot}/history/markets`, engine: 'history-forward ' + VERSION, updatedAt: row.capturedAt, day_count: keys.length, first_day: keys[0], last_day: keys[keys.length - 1],
    note: 'one row per UTC day, rewritten by each hourly positions run — the last run of the day is the row that stays. Every figure names its source (row.sources) or why it is missing (row.reasons). pixeLions and Burning Lions floors: nft-collections/<slug>/snapshots/floor-history.json. Chain supplies and stakes: history/daily.json.',
    days: keys.reduce((a, k) => { a[k] = days[k]; return a; }, {}) };
  log(`  history markets ${row.day}: ROAR ${row.roar_usd == null ? '—' : '$' + row.roar_usd.toExponential(3)} · pyROAR ${row.pyroar_usd == null ? '—' : '$' + row.pyroar_usd.toExponential(3)} · ROAR20 ${row.roar20_usd == null ? '—' : '$' + row.roar20_usd.toExponential(3)} · holders ROAR ${row.roar_holders ?? '—'} / pyROAR ${row.pyroar_holders ?? '—'} / ROAR20 ${row.roar20_holders ?? '—'} · BL ${row.bl_minted ?? '—'} minted, ${row.bl_holders ?? '—'} holders → ${await o.publish(path, JSON.stringify(doc, null, 1), `📈 ${o.tenantSlug} markets ${row.day}`)}`);
  return doc;
}

// run({ tenant, tenantSlug, outRoot, publish, readJson, log, roar20Market })
async function run(o) {
  o.log = o.log || console.log; const out = {};
  try { out.markets = await marketSeries(o); } catch (e) { o.log('  ✗ history markets threw (positions run unaffected): ' + e.message); }
  try { out.daily = await chainSeries(o); } catch (e) { o.log('  ✗ history daily threw (positions run unaffected): ' + e.message); }
  return out;
}
module.exports = { VERSION, run, marketSeries, chainSeries };
