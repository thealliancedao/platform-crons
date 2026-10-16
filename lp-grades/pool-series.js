'use strict';
// =============================================================================
// lp-grades/pool-series.js — the raw facts the LP Scorecard grades from (2026-10-15)
// =============================================================================
//
// WHY: the weekly dex-data series is keyed by pool NAME and only carries pools
// that existed when a window opened. Renames (LUNA-USDC → LUNA-USDC.n →
// LUNA-USDC.nbl) split one pool's history into three, and new pools (the
// USDC.inj family, 2026-09-27) were invisible to anything ranking at the time.
// This product keys every pool by its POOL ADDRESS (gauge id for single-asset
// gauges), merges every name it has carried, and lays out daily facts from the
// first day the pool was captured — so any window (24h, 7d, 30d, 90d, an epoch)
// can be computed at any past date, under whatever rubric the config says.
//
// FACTS ONLY. No scores, no weights here — the grading happens in
// lp-scorecard.js (identical copy on the site, /lib/lp-scorecard.js) from these
// facts + docs/curated/grading_config.json `scorecard`. Change the config →
// every past and future view re-grades from the same facts.
//
// Inputs (all org products, nothing fetched from chain):
//   dex-data/astroport/daily-csv/*.csv     tvl, 24h volume, 24h fees (from 2026-05-12)
//   dex-data/skeletonswap/daily-csv/*.csv  tvl (+ volume where the API gave one)
//   member-data/tla-snapshot/pool-status-history.json  per-epoch votes, bucket %, amounts, prices (E184+)
//   tla-voting/bribe-state/YYYY/MM.json    per-period bribe pots, every briber (chain state)
//   tla-voting/pd-bribes/current.json      PD placements (proposal-decoded, event-verified)
//   member-data/tla-snapshot/epoch-history.json  LUNA price + annual LUNA emissions per epoch
//   token-catalog/snapshots/current.json   today's prices for non-LUNA bribe tokens (labeled)
//   docs/epoch_1-300_date.json             epoch calendar
//
// Output: lp-grades/series/pools.json
// =============================================================================

const SERIES_VERSION = 'pool-series-1.5.1';   // 1.5.1 (2026-10-16): non-LUNA bribe tokens at the epoch's oracle price (else today's) · 1.5.0 (2026-10-16): who funded each pot — e[E].funders by organisation from the bribe events (individuals only as 'Other bribers') · 1.4.0 (2026-10-16): votes per pool + Votion's share before the vote harvest (distributions ledger + archive read of Votion's vaults), LUNA price from the oracle before epoch-history · 1.3.0 (2026-10-16): weekly history before the daily capture (dex-data/history) as w[E] · 1.2.0 (2026-10-16): votes per pool per period from vote-state, Votion's share (votes_cast, votion_vp, votes_by_epoch) · 1.1.1 (2026-10-16): bribe-token decimals from the catalog's `effective` layer first (curated, verified) — wBTC / ATOM / FUEL / xASTRO bribes were counted $0 because they have no discovered decimals · 1.1.0 (2026-10-16): pots for periods not yet harvested come from the runway product (bribe_src 'runway')

function num(v) { if (v === '' || v == null) return null; const n = Number(v); return isFinite(n) ? n : null; }
const r2 = (v) => v == null ? null : Math.round(v * 100) / 100;
const r6 = (v) => v == null ? null : Math.round(v * 1e6) / 1e6;
const bare = (d) => String(d || '').replace(/^(cw20|native):/, '');

/**
 * build — pure composer.
 * @param io { listDir(rel) → [names], readText(rel) → string|null, readJson(rel) → obj|null }
 * @param parseCsv (text) → [{col: value}]
 */
async function buildSeries(io, parseCsv, log = console.log) {
  const t0 = Date.now();
  const psh = await io.readJson('member-data/tla-snapshot/pool-status-history.json');
  const pd = await io.readJson('tla-voting/pd-bribes/current.json');
  const eh = await io.readJson('member-data/tla-snapshot/epoch-history.json');
  const tc = await io.readJson('token-catalog/snapshots/current.json');
  const cal = await io.readJson('docs/epoch_1-300_date.json');
  if (!psh || !Array.isArray(psh.pools)) throw new Error('pool-series: pool-status-history missing');

  // ---- pools from the gauge side (votes, bucket, gauge ids) ----
  const pools = new Map();               // id → pool
  const byGauge = new Map();             // gauge_pool_id (full and bare) → id
  const ensure = (id, seed) => { if (!pools.has(id)) pools.set(id, Object.assign({ id, names: [], dex: null, bucket: null, gauge_pool_ids: [], days: {}, epochs: {} }, seed || {})); return pools.get(id); };
  for (const g of psh.pools) {
    const id = (g.pool_address || g.gauge_pool_id || '').toLowerCase(); if (!id) continue;
    const p = ensure(id);
    if (g.name && !p.names.includes(g.name)) p.names.push(g.name);
    p.dex = p.dex || (g.dex ? String(g.dex).replace(/^Skeleton ?Swap$/i, 'SkeletonSwap') : null); p.bucket = g.bucket || p.bucket; p.is_single = !g.pool_address;
    if (g.gauge_pool_id && !p.gauge_pool_ids.includes(g.gauge_pool_id)) p.gauge_pool_ids.push(g.gauge_pool_id);
    byGauge.set(g.gauge_pool_id, id); byGauge.set(bare(g.gauge_pool_id), id);
    for (const [e, x] of Object.entries(g.epochs || {})) {
      const prev = p.epochs[e] || {};
      // a pool can sit on one gauge per bucket; the ids are the same pool, votes add
      p.epochs[e] = {
        vp: r2((prev.vp || 0) + (x.vp_human || 0)),
        bucket_pct: r6((prev.bucket_pct || 0) + (x.bucket_pct || 0)),
        active: !!(prev.active || x.active),
        status: x.status || prev.status || null,
        staked_usd: r2((prev.staked_usd || 0) + (x.staked_usd || 0)),
        amt: (x.a0_amt || x.a1_amt) ? [x.a0_amt || 0, x.a1_amt || 0] : (prev.amt || null),
        px: (x.a0_px || x.a1_px) ? [x.a0_px || 0, x.a1_px || 0] : (prev.px || null),
        syms: (x.a0_sym || x.a1_sym) ? [x.a0_sym || null, x.a1_sym || null] : (prev.syms || null),
      };
    }
  }

  // ---- daily dex facts, keyed by address ----
  const dexDirs = [['astroport', 'dex-data/astroport/daily-csv'], ['skeletonswap', 'dex-data/skeletonswap/daily-csv']];
  const allDays = new Set(); let rowsRead = 0, files = 0;
  for (const [dex, dir] of dexDirs) {
    const names = (await io.listDir(dir)).filter(n => /^\d{4}-\d{2}-\d{2}\.csv$/.test(n)).sort();
    for (const n of names) {
      const day = n.slice(0, 10); const text = await io.readText(`${dir}/${n}`); if (!text) continue; files++;
      for (const r of parseCsv(text)) {
        const addr = String(r.pool_address || '').toLowerCase(); if (!addr) continue;
        if (r.fetch_ok === 'false') continue;
        const name = r.pool_name || r.pool || r.pool_id || null;
        const tvl = num(r.tvl_usd ?? r.astroport_tvl_usd), vol = num(r.volume_24h_usd ?? r.astroport_day_volume_usd), fees = num(r.fees_24h_usd);
        if (tvl == null) continue;
        const p = ensure(addr, { dex: dex === 'astroport' ? 'Astroport' : 'SkeletonSwap', bucket: r.bucket || null });
        if (name && !p.names.includes(name)) p.names.push(name);
        if (name && (!p.name_day || day >= p.name_day)) { p.display = name; p.name_day = day; }
        if (!p.bucket && r.bucket) p.bucket = r.bucket;
        if (!p.dex) p.dex = dex === 'astroport' ? 'Astroport' : 'SkeletonSwap';
        p.days[day] = [r2(tvl), vol == null ? null : r2(vol), fees == null ? null : r2(fees), r.is_deregistered === 'true' ? 1 : 0];
        allDays.add(day); rowsRead++;
      }
    }
  }

  // ---- prices (today) for non-LUNA bribe tokens ----
  const pxNow = {}; for (const t of (tc && tc.tokens) || []) { const u = t.prices && t.prices.tla && t.prices.tla.usd; if (u != null) pxNow[t.denom] = u; }
  const decBy = {}; for (const t of (tc && tc.tokens) || []) { const d = (t.effective && t.effective.decimals) ?? (t.discovered && t.discovered.decimals) ?? t.decimals; if (d != null) decBy[t.denom] = d; }   // effective = curated override (verified), else chain-discovered
  const decimalsOf = (denom) => decBy[denom];   // unknown decimals → unpriced (never guessed: a wrong guess is a 100x error)
  const ehBy = {}; for (const e of (eh && eh.epochs) || []) ehBy[e.epoch] = e;
  // 1.4.0: epochs before the epoch-history capture take LUNA's price from the price oracle (price-history/series/LUNA.json), the
  // epoch week's average — so older bribe pots get a USD value and the steered-vote arithmetic can run there too.
  const lunaSeries = await io.readJson('price-history/series/LUNA.json'); const lunaWeek = {};
  if (lunaSeries && lunaSeries.daily) for (const c of cal || []) { if (!c.start_time) continue; const d0 = new Date(c.start_time.slice(0, 10) + 'T00:00:00Z'); const v = [];
    for (let i = 0; i < 7; i++) { const k = new Date(d0.getTime() + i * 864e5).toISOString().slice(0, 10); if (lunaSeries.daily[k] != null) v.push(Number(lunaSeries.daily[k])); }
    if (v.length) lunaWeek[c.epoch] = v.reduce((a, b) => a + b, 0) / v.length; }
  const lunaPx = (E) => (ehBy[E] && ehBy[E].luna_price_usd) || lunaWeek[E] || null;
  // 1.5.1: non-LUNA bribe tokens at the EPOCH's price (price-history oracle, week average) where the oracle has the token, else today's
  // catalog price — a ROAR or SOLID bribe from 2025 is worth what it was worth then, not what the token is worth now.
  const symBy = {}; for (const t of (tc && tc.tokens) || []) { const sy = (t.effective && t.effective.symbol) || (t.discovered && t.discovered.symbol) || t.symbol; if (sy) symBy[t.denom] = sy; }
  const haveSeries = new Set(((await io.listDir('price-history/series')) || []).filter(n => /\.json$/.test(n)).map(n => n.replace(/\.json$/, '')));
  const serCache = {}; const calStart = {}; for (const c of cal || []) if (c.start_time) calStart[c.epoch] = c.start_time.slice(0, 10);
  const pxAt = async (denom, E) => { const sy = symBy[denom]; if (sy && haveSeries.has(sy) && calStart[E]) { if (!(sy in serCache)) { const j = await io.readJson(`price-history/series/${sy}.json`); serCache[sy] = j && j.daily ? j.daily : null; }
      const dly = serCache[sy]; if (dly) { const d0 = new Date(calStart[E] + 'T00:00:00Z'); const v = []; for (let i = 0; i < 7; i++) { const k = new Date(d0.getTime() + i * 864e5).toISOString().slice(0, 10); if (dly[k] != null) v.push(Number(dly[k])); } if (v.length) return v.reduce((a, b) => a + b, 0) / v.length; } }
    return pxNow[denom] ?? null; };

  // ---- bribes, every briber, per pool per period (chain state) ----
  const bsMonths = [];
  for (const y of (await io.listDir('tla-voting/bribe-state')).filter(n => /^\d{4}$/.test(n)).sort()) {
    for (const m of (await io.listDir(`tla-voting/bribe-state/${y}`)).filter(n => /^\d{2}\.json$/.test(n)).sort()) bsMonths.push(`tla-voting/bribe-state/${y}/${m}`);
  }
  let bribeRows = 0; const unmappedBribePools = new Set();
  for (const rel of bsMonths) {
    const rows = await io.readJson(rel); if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      const E = String(row.period);
      for (const b of row.buckets || []) {
        const a = b.asset || {}; const gid = a.cw20 ? 'cw20:' + a.cw20 : a.native ? 'native:' + a.native : null;
        const id = byGauge.get(gid) || byGauge.get(bare(gid)); if (!id) { unmappedBribePools.add(gid); continue; }
        const p = pools.get(id); const ep = p.epochs[E] = p.epochs[E] || {};
        let luna = 0, usd = 0, unpriced = 0;
        for (const x of b.assets || []) {
          const d = x.info && (x.info.native || x.info.cw20); const amt = Number(x.amount || 0);
          if (d === 'uluna') { luna += amt / 1e6; continue; }
          const px = await pxAt(d, Number(row.period)); if (px == null || decimalsOf(d) == null) { unpriced++; continue; }
          usd += (amt / Math.pow(10, decimalsOf(d))) * px;
        }
        const lp = lunaPx(Number(row.period));
        ep.bribe_luna = r2((ep.bribe_luna || 0) + luna);
        ep.bribe_other_usd = r2((ep.bribe_other_usd || 0) + usd);
        ep.bribe_usd = lp ? r2((ep.bribe_usd || 0) + luna * lp + usd) : (ep.bribe_usd ?? null);
        if (unpriced) ep.bribe_unpriced = (ep.bribe_unpriced || 0) + unpriced;
        bribeRows++;
      }
    }
  }

  // ---- pots already funded for periods not harvested yet (runway: chain state probed forward) ----
  // The harvest records a period once it has been paid; the epoch running now — and any funded ahead — live only in the
  // runway product. Filled only where the harvest has nothing, and marked bribe_src: 'runway'.
  const runway = await io.readJson('tla-voting/bribe-state/runway.json');
  let runwayRows = 0;
  for (const rp of (runway && runway.pools) || []) {
    const id = byGauge.get(rp.pool) || byGauge.get(bare(rp.pool)); if (!id) continue;
    const per = {};   // period → [{denom, amount}]
    for (const [den, v] of Object.entries(rp.by_denom || {})) for (const [P, amt] of Object.entries(v.per_period || {})) (per[P] = per[P] || []).push({ d: den.replace(/^(native|cw20):/, ''), amt: Number(amt || 0) });
    for (const [P, list] of Object.entries(per)) {
      const p = pools.get(id); const ep = p.epochs[P] = p.epochs[P] || {};
      if (ep.bribe_luna != null || ep.bribe_usd != null) continue;   // harvested — the harvest wins
      let luna = 0, usd = 0, unpriced = 0;
      for (const x of list) { if (x.d === 'uluna') { luna += x.amt / 1e6; continue; } const px = await pxAt(x.d, Number(P)); if (px == null || decimalsOf(x.d) == null) { unpriced++; continue; } usd += (x.amt / Math.pow(10, decimalsOf(x.d))) * px; }
      const lp = lunaPx(Number(P)) || (pxNow.uluna || null);
      ep.bribe_luna = r2(luna); ep.bribe_other_usd = r2(usd); ep.bribe_usd = lp ? r2(luna * lp + usd) : null; ep.bribe_src = 'runway';
      if (unpriced) ep.bribe_unpriced = unpriced;
      runwayRows++;
    }
  }

  // ---- PD's share, per pool per period (proposal-decoded legs) ----
  const placements = [];
  for (const pl of (pd && pd.placements) || []) {
    const legs = [];
    for (const l of pl.legs || []) {
      const id = byGauge.get(l.pool_gauge_id) || byGauge.get(bare(l.pool_gauge_id)) || null;
      const lunaLeg = l.denom === 'native:uluna';
      legs.push({ pool: id, gauge_pool_id: l.pool_gauge_id, gauge: l.gauge, start: l.start, end: l.end, luna_per_epoch: lunaLeg ? r6(l.per_epoch_display) : null, denom: l.denom });
      if (id && lunaLeg) for (let e = l.start; e <= l.end; e++) { const ep = pools.get(id).epochs[String(e)] = pools.get(id).epochs[String(e)] || {}; ep.pd_luna = r2((ep.pd_luna || 0) + l.per_epoch_display); }
    }
    placements.push({ proposal_id: pl.proposal_id, title: pl.title, executed_at: pl.executed_at, tx_hash: pl.tx_hash, description: pl.description || null, weights_parsed: pl.weights_parsed || null, legs });
  }

  // ---- 1.5.0: who funded each pot — every bribe event (tla-voting/events/bribes, briber + pool + epoch range + coins), grouped by the
  // address catalog's organisation (Phoenix Directive, Solid Protocol, Lion DAO, Fuel …); TLA's own tribute contracts as 'TLA tribute';
  // everyone else as 'Other bribers' (individuals are never written). A multi-epoch event is split evenly over its epochs. Valued like
  // the pots: LUNA at the epoch's price, other tokens at today's catalog price. e[E].funders = { group: usd }.
  const catDoc = await io.readJson('catalog/snapshots/current.json');
  const orgOf = {}; if (catDoc) { for (const x of catDoc.addresses || []) if (x && x.address && x.protocol) orgOf[x.address] = x.protocol; for (const [a, x] of Object.entries(catDoc.entities || {})) if (x && x.protocol) orgOf[a] = x.protocol; }
  const groupOf = (a) => { const o = orgOf[a]; return !o ? 'Other bribers' : o === 'TLA' ? 'TLA tribute' : o; };
  const funderTotals = {}; let fundRows = 0;
  for (const y of (await io.listDir('tla-voting/events/bribes')).filter(n => /^\d{4}$/.test(n)).sort()) {
    for (const m of (await io.listDir(`tla-voting/events/bribes/${y}`)).filter(n => /^\d{2}\.json$/.test(n)).sort()) {
      const evs = await io.readJson(`tla-voting/events/bribes/${y}/${m}`); if (!Array.isArray(evs)) continue;
      for (const ev of evs) {
        if (ev.type !== 'bribe_add' || ev.epoch_start == null || ev.epoch_end == null) continue;
        const id = byGauge.get(ev.pool) || byGauge.get(bare(ev.pool)); if (!id) continue;
        const nE = ev.epoch_end - ev.epoch_start + 1; if (!(nE > 0) || nE > 60) continue; const g = groupOf(ev.briber);
        for (let E = ev.epoch_start; E <= ev.epoch_end; E++) {
          let usd = 0; for (const c of ev.coins || []) { const d = bare(c.denom); const amt = Number(c.amount || 0) / nE;
            if (d === 'uluna') { const lp = lunaPx(E); if (lp) usd += amt / 1e6 * lp; continue; }
            const px = await pxAt(d, E); if (px == null || decimalsOf(d) == null) continue; usd += amt / Math.pow(10, decimalsOf(d)) * px; }
          if (!(usd > 0)) continue;
          const ep = pools.get(id).epochs[String(E)] = pools.get(id).epochs[String(E)] || {}; ep.funders = ep.funders || {}; ep.funders[g] = r2((ep.funders[g] || 0) + usd);
          funderTotals[g] = (funderTotals[g] || 0) + usd;
        }
        fundRows++;
      }
    }
  }

  // ---- votes per pool per period, every voter (tla-voting/vote-state), and how many of them are Votion's (1.2.0) ----
  // vote-state is a per-period, per-wallet harvest of the gauge controller: the wallet's VP and its split per gauge in bps.
  // A pool's votes = Σ wallet VP × bps / 10000; Votion's = the same over the Votion vault wallets (votion/snapshots/vaults.json).
  // This is what lets the page MEASURE how many votes each funder's pots steer (Votion follows pots) instead of estimating it.
  const vaultsDoc = await io.readJson('votion/snapshots/vaults.json');
  const votionVaults = new Set(((vaultsDoc && vaultsDoc.vaults) || []).map(v => v && (v.address || v.vault)).filter(Boolean));
  const voteTotals = {}; let voteRows = 0;
  for (const y of (await io.listDir('tla-voting/vote-state')).filter(n => /^\d{4}$/.test(n)).sort()) {
    for (const m of (await io.listDir(`tla-voting/vote-state/${y}`)).filter(n => /^\d{2}\.json$/.test(n)).sort()) {
      const rows = await io.readJson(`tla-voting/vote-state/${y}/${m}`); if (!Array.isArray(rows)) continue;
      for (const r of rows) {
        const E = String(r.period); const vp = Number((r.vp && r.vp.total) || 0) / 1e6; if (!(vp > 0)) continue; const isV = votionVaults.has(r.wallet);
        for (const g of r.gauge_votes || []) for (const [gid, bps] of g.votes || []) {
          const x = vp * Number(bps || 0) / 10000; if (!(x > 0)) continue;
          const vt = voteTotals[E] = voteTotals[E] || { votes: 0, votion: 0, wallets: 0 }; vt.votes += x; if (isV) vt.votion += x;
          const id = byGauge.get(gid) || byGauge.get(bare(gid)); if (!id) continue;
          const ep = pools.get(id).epochs[E] = pools.get(id).epochs[E] || {};
          ep.votes_cast = r2((ep.votes_cast || 0) + x); if (isV) ep.votion_vp = r2((ep.votion_vp || 0) + x);
        }
        if (voteTotals[E]) voteTotals[E].wallets++;
        voteRows++;
      }
    }
  }
  for (const E of Object.keys(voteTotals)) { voteTotals[E].votes = r2(voteTotals[E].votes); voteTotals[E].votion = r2(voteTotals[E].votion); }
  // ---- 1.4.0: periods before the vote harvest — totals per pool from the finalized distributions ledger (tla-voting/distributions,
  // every period since E96), Votion's share from the archive-node read of its vaults (tla-voting/vote-history/votion.json).
  // Same arithmetic as above: a pool's votes = VP on it; the period's total = Σ over the four gauges. Marked votes_src 'ledger'.
  const dist = await io.readJson('tla-voting/distributions/history.json'); const vh = await io.readJson('tla-voting/vote-history/votion.json');
  let ledgerPeriods = 0;
  for (const ent of (dist && dist.entries) || []) {
    const E = String(ent.period); if (voteTotals[E]) continue;
    const VP = vh && vh.periods && vh.periods[E]; if (!VP || !VP.complete) continue;   // without Votion's side the steered share cannot be measured — leave the period out
    let tot = 0;
    for (const g of ent.gauges || []) { tot += Number(g.total_gauge_vp || 0) / 1e6;
      for (const a of g.assets || []) { const gid = a.asset && (a.asset.cw20 ? 'cw20:' + a.asset.cw20 : a.asset.native ? 'native:' + a.asset.native : null); const id = gid && (byGauge.get(gid) || byGauge.get(bare(gid))); if (!id) continue;
        const ep = pools.get(id).epochs[E] = pools.get(id).epochs[E] || {}; ep.votes_cast = r2((ep.votes_cast || 0) + Number(a.total_vp || 0) / 1e6); } }
    let vt = 0; for (const [gid, x] of Object.entries(VP.pools || {})) { vt += x; const id = byGauge.get(gid) || byGauge.get(bare(gid)); if (!id) continue; const ep = pools.get(id).epochs[E] = pools.get(id).epochs[E] || {}; ep.votion_vp = r2((ep.votion_vp || 0) + x); }
    voteTotals[E] = { votes: r2(tot), votion: r2(vt), wallets: null, src: 'ledger' }; ledgerPeriods++;
  }

  // ---- lay out ----
  const days = [...allDays].sort();
  const dayIx = Object.fromEntries(days.map((d, i) => [d, i]));
  const epochNums = new Set(); for (const p of pools.values()) for (const e of Object.keys(p.epochs)) epochNums.add(Number(e));
  const eps = [...epochNums].sort((a, b) => a - b);
  const calBy = {}; for (const c of cal || []) calBy[c.epoch] = c;
  const out = [];
  for (const p of pools.values()) {
    const tvl = new Array(days.length).fill(null), vol = tvl.slice(), fees = tvl.slice(); let first = null, last = null, dereg = null;
    for (const [d, v] of Object.entries(p.days)) { const i = dayIx[d]; tvl[i] = v[0]; vol[i] = v[1]; fees[i] = v[2]; if (v[3]) dereg = dereg || d; if (!first || d < first) first = d; if (!last || d > last) last = d; }
    const hasDaily = first != null, hasEpochs = Object.keys(p.epochs).length > 0;
    if (!hasDaily && !hasEpochs) continue;
    out.push({
      id: p.id, name: p.display || p.names[0] || p.id.slice(0, 14), names: p.names, dex: p.dex, bucket: p.bucket, is_single: !!p.is_single,
      gauge_pool_ids: p.gauge_pool_ids, first_day: first, last_day: last, deregistered_from: dereg,
      d: hasDaily ? { tvl, vol, fees } : null,
      e: p.epochs,
    });
  }
  // ---- weekly history before the daily capture (dex-data/history/weekly.json, archive-node swaps + state-history reserves) — 1.3.0 ----
  // Attached per pool as w[E] = [tvl_usd, vol_usd_week, swaps, complete, unpriced, reserve_implied]; pairs the daily record never saw
  // (retired before 2026-05-12) join as their own pools so a past placement's whole field is there.
  const hist = await io.readJson('dex-data/history/weekly.json'); let histPools = 0;
  if (hist && hist.pairs) {
    const byId = new Map(out.map(p => [p.id, p]));
    for (const [pair, H] of Object.entries(hist.pairs)) {
      const id = pair.toLowerCase(); const weeks = H.weeks || {}; if (!Object.keys(weeks).length) continue;
      let p = byId.get(id);
      if (!p) { p = { id, name: H.name || id.slice(0, 14), names: H.name ? [H.name] : [], dex: H.dex || null, bucket: H.bucket || null, is_single: false, gauge_pool_ids: H.key ? [H.key] : [], first_day: null, last_day: null, deregistered_from: null, d: null, e: {} }; out.push(p); byId.set(id, p); }
      if (H.key && !(p.gauge_pool_ids || []).includes(H.key)) p.gauge_pool_ids = (p.gauge_pool_ids || []).concat([H.key]);
      p.w = weeks; histPools++;
    }
  }
  out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const epochs = {}; for (const e of eps) { const c = calBy[e]; const h = ehBy[e]; epochs[e] = { start: c ? c.start_time.slice(0, 10) : null, end: c ? c.end_time.slice(0, 10) : null, luna_usd: lunaPx(e), annual_luna: h ? h.rewards_annual_luna : null }; }
  const doc = {
    schemaVersion: 1, product: 'lp-grades/series', version: SERIES_VERSION, generatedAt: new Date().toISOString(),
    method: 'Facts only, keyed by pool address (gauge id for single-asset gauges); every name a pool has carried is merged. d.* are daily arrays aligned to `days` (null = not captured that day): tvl USD, 24h volume USD, 24h fees USD. e[epoch] = votes (vp, bucket_pct, active), staked USD, pool amounts + prices at the epoch’s last reading (price-neutral retention), bribe pots for that period from chain state (every briber: bribe_luna, bribe_other_usd at the epoch’s oracle price (today’s catalog price where the oracle lacks the token), bribe_usd = LUNA at the epoch’s price + other), and pd_luna from PD’s decoded proposals. Grades are NOT here — lp-scorecard.js computes them from these facts + grading_config.json `scorecard`.',
    coverage: { days_first: days[0] || null, days_last: days[days.length - 1] || null, dex_files: files, dex_rows: rowsRead, epochs_first: eps[0] || null, epochs_last: eps[eps.length - 1] || null, bribe_rows: bribeRows, bribe_months: bsMonths.length, runway_rows: runwayRows, vote_rows: voteRows, history_pools: histPools, history_epochs: hist && hist.coverage ? hist.coverage.epochs : null, vote_periods: Object.keys(voteTotals).length, vote_ledger_periods: ledgerPeriods, funder_events: fundRows, unmapped_bribe_pools: [...unmappedBribePools].slice(0, 20), pd_placements: placements.length, notes: ['SkeletonSwap volume is mostly not provided by its API — those cells are null, never zero.', 'Votes, amounts and bribes per epoch begin at E184 (pool-status-history); daily dex facts begin 2026-05-12 (Astroport) and 2026-01-12 (SkeletonSwap).'] },
    days, epochs, weekly_epochs: hist && hist.epochs ? hist.epochs : {}, placements, funders: Object.entries(funderTotals).sort((a, b) => b[1] - a[1]).map(([g, u]) => ({ group: g, usd: r2(u) })), votes_by_epoch: voteTotals, votion_vaults: [...votionVaults], pools: out,
  };
  log(`${SERIES_VERSION}: ${out.length} pools · ${days.length} days (${doc.coverage.days_first}→${doc.coverage.days_last}) · epochs ${doc.coverage.epochs_first}–${doc.coverage.epochs_last} · ${bribeRows} bribe rows · ${placements.length} PD placements · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return doc;
}

module.exports = { buildSeries, SERIES_VERSION };
