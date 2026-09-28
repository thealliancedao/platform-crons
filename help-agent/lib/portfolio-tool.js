'use strict';
// help-agent/lib/portfolio-tool.js 1.0.0 (2026-09-28, v1.17.0) — the Member Portfolio as a bot tool.
//
// Owner: "the bot should answer questions about their portfolios or others', who to follow or copy for a strategy, what we show and
// where the data comes from, and errors they get or data that may be wrong — diagnose it, say why it is right or wrong, and if it is
// wrong tell them what to send me to get it fixed." One call reads the SAME products the page renders and returns:
//   record    — who (name from the registries), the hourly summary, custody (receipts staked in a DAO), live LP rows, the P&L ledger's
//               story + positions (open / flagged / top closed), Votion stories, Credia
//   freshness — each product's capturedAt / builtAt and whether it is within its cadence
//   findings  — coded diagnoses {code, kind: known | check | fault, says, evidence} — the rows of the diagnosis table in
//               docs/ecosystem-knowledge/member-portfolio.md, so the bot explains from receipts, never from memory
//   report    — what to send the maintainer when a finding is a fault
// Pure over an injected fetchJson (the gate passes local files); cached 10 min per product.

const CORE = 'https://raw.githubusercontent.com/thealliancedao/tla-core/main';
const PAGE = 'https://thealliancedao.com/member-portfolio.html?wallet=';
const ADDR = /^terra1[a-z0-9]{38,58}$/;
const CADENCE_H = { participants: 3, positions: 30, pnl: 30, votion_holder_pnl: 30, capa_supply: 30 };
const r2 = (x) => x == null || !isFinite(x) ? null : Math.round(x * 100) / 100;
const hoursSince = (t, now) => t ? (now - Date.parse(t)) / 36e5 : null;

let cache = new Map();
async function get(path, opts) {
  const fj = (opts && opts.fetchJson) || (async (u) => { const r = await fetch(u, { headers: { 'User-Agent': 'tla-help-agent' } }); if (r.status === 404) return null; if (!r.ok) throw new Error(u + ' HTTP ' + r.status); return r.json(); });
  const c = cache.get(path); if (c && Date.now() - c.at < 10 * 60 * 1000 && !(opts && opts.fetchJson)) return c.v;
  const v = await fj(`${CORE}/${path}`, path); cache.set(path, { at: Date.now(), v }); return v;
}
const find = (root, w) => ((root && (root.members || root.participants)) || []).find(x => x.wallet === w || x.address === w) || null;

function nameOf(w, part, pos, cat, curated) {
  const m = find(pos, w) || find(part, w); if (m && m.name) return { name: m.name, from: 'DAODAO profile / member registry' };
  const cw = curated && curated.wallets && curated.wallets[w]; if (cw && cw.label) return { name: cw.label, from: 'docs/curated/wallets.json' };
  const e = cat && cat.entities && cat.entities[w]; if (e && e.label) return { name: e.label, from: 'catalog entities' };
  const b = cat && cat.by_address && cat.by_address[w]; if (b && b.handle) return { name: b.handle, from: 'catalog handle' };
  return { name: null, from: null };
}

function pnlBlock(L) {
  if (!L || !L.v3) return null; const v = L.v3, T = v.totals, cols = v.trip_cols || [], iu = cols.indexOf('in_usd');
  const pos = Object.entries(v.positions || {}).map(([k, p]) => {
    const unpriced = (p.trips || []).filter(t => Array.isArray(t) ? t[iu] == null : t.in_usd == null).length;
    return { key: k, name: p.name || k.split('|')[0], mechanism: p.mechanism, open_usd: p.open_value_usd, open_cost_usd: p.open_cost_usd, units_open: p.units_open,
      realized_usd: p.realized ? p.realized.delta_usd : null, trips: p.realized ? p.realized.trips : 0, trips_unpriced: unpriced, claims_usd: p.claims ? p.claims.usd : 0,
      not_held: p.not_held || undefined, held_in: p.held_in || undefined, disputed: p.disputed || undefined, unmatched_units: p.unmatched_units || undefined,
      moves: p.moves ? p.moves.filter(m => m.net_units !== 0).slice(0, 3).map(m => ({ to: m.to, label: m.label, kind: m.kind, net_units: m.net_units, last_day: m.last_day, last_tx: m.last_tx })) : undefined };
  });
  const open = pos.filter(p => p.units_open > 0 && ((p.open_usd || 0) >= 1 || p.not_held || p.held_in));
  const flagged = pos.filter(p => !open.includes(p) && (p.disputed || p.not_held));
  const closed = pos.filter(p => !open.includes(p) && !flagged.includes(p)).sort((a, b) => b.trips - a.trips).slice(0, 8);
  return { built: L.v3.totals.as_of_day || null, net_usd: T.net_usd, net_luna: T.net_luna, realized_usd: T.realized.delta_usd, market_usd: T.realized.market_usd, pool_usd: T.realized.lp_usd,
    rewards_usd: r2((T.rewards.claims_usd || 0) + (T.rewards.bribes_usd || 0)), open_value_usd: T.open.value_usd, open_cost_usd: T.open.cost_usd,
    positions_not_held: T.positions_not_held || 0, positions_disputed: T.positions_disputed || 0, open, flagged, closed_top: closed, positions_total: pos.length };
}

async function run(input, opts) {
  const w = String((input && (input.wallet || input.address)) || '').trim();
  if (!ADDR.test(w)) return { error: 'give a terra1… address' };
  const now = (opts && opts.now) || Date.now();
  const safe = async (p) => { try { return await get(p, opts); } catch (e) { return { __error: e.message }; } };
  const [part, pos, ledger, hp, cat, curated, partHb, pnlHb, cs] = await Promise.all([
    safe('member-data/participants/current.json'), safe('member-data/positions/current.json'), safe(`tla-flows/pnl/ledger/${w}.json`),
    safe('votion/holder-pnl/current.json'), safe('catalog/snapshots/current.json'), safe('docs/curated/wallets.json'),
    safe('member-data/participants/heartbeat.json'), safe('tla-flows/pnl/heartbeat.json'), safe('token-catalog/supply/capa/wallets.json')]);
  const m = find(pos, w) || find(part, w);
  const who = nameOf(w, part, pos, cat, curated);
  const out = { wallet: w, name: who.name, name_from: who.from, page: PAGE + w, onchain: 'https://chainsco.pe/terra2/address/' + w, tracked: !!m, findings: [] };
  const F = (code, kind, says, evidence) => out.findings.push({ code, kind, says, evidence });

  // freshness
  const partAt = part && part.capturedAt, pnlAt = pnlHb && pnlHb.builtAt, hpAt = hp && hp.meta && hp.meta.generated_at, csAt = cs && cs.capturedAt;
  out.freshness = {
    participants: { at: partAt || null, hours: r2(hoursSince(partAt, now)), ok: partAt ? hoursSince(partAt, now) <= CADENCE_H.participants : false, path: 'member-data/participants/current.json' },
    pnl: { at: pnlAt || null, builder: pnlHb && pnlHb.builder, hours: r2(hoursSince(pnlAt, now)), ok: pnlAt ? hoursSince(pnlAt, now) <= CADENCE_H.pnl : false, path: `tla-flows/pnl/ledger/${w}.json` },
    votion_holder_pnl: { at: hpAt || null, hours: r2(hoursSince(hpAt, now)), ok: hpAt ? hoursSince(hpAt, now) <= CADENCE_H.votion_holder_pnl : null, path: 'votion/holder-pnl/current.json' },
    capa_supply: { at: csAt || null, hours: r2(hoursSince(csAt, now)), path: 'token-catalog/supply/capa/wallets.json' },
  };
  for (const [k, f] of Object.entries(out.freshness)) if (f.ok === false && f.at) F('STALE_PRODUCT', 'fault', `${k} is ${f.hours} h old — past its cadence (${CADENCE_H[k]} h)`, f);

  if (!m) F('NOT_TRACKED', 'known', 'This wallet is not in the hourly read (the tracked electorate = lock holders, aDAO members, ally rosters). Its live wallet balances still read on the page; positions and trends do not.', { path: out.freshness.participants.path });
  if (m) {
    const s = m.summary || {};
    out.summary = { total_usd: r2(s.total_portfolio_value_usd), includes_custody: !!s.total_includes_custody, custody_usd: r2(s.custody_usd), locked_usd: r2(s.total_locked_usd), lp_usd: r2(s.total_lp_position_usd),
      wallet_usd: r2(s.total_wallet_balances_usd), pending_rewards_usd: r2(s.total_pending_rewards_usd), pending_bribes_usd: r2(s.total_pending_bribes_usd), vp: r2(s.voting_power_human), locks: s.lock_count,
      credia_supplied_usd: r2(s.credia_supplied_usd), credia_borrowed_usd: r2(s.credia_borrowed_usd), credia_lt_health: s.credia_lt_health_factor };
    out.custody = (m.custody || []).map(c => ({ where: c.where, pool: c.pool, amount: c.amount, unit: c.unit, usd: r2(c.usd), as_of: c.as_of, source: c.source }));
    out.lp_live = (m.lp_positions || []).map(l => ({ pool: l.pool_name, bucket: l.bucket, amplified: !!l.is_amplified, status: l.status, usd: r2(l.estimated_position_usd), distance_pp: l.distance_from_threshold_pp != null ? r2(l.distance_from_threshold_pp) : null, price_source: l.price_source }));
    for (const c of out.custody) F('CUSTODY_DAO', 'known', `${c.amount != null ? Math.round(c.amount).toLocaleString('en-US') + ' ' + c.unit : 'A receipt'} staked in ${c.where} (≈ $${c.usd}) — still this wallet's position and still earning; shown in its own "STAKED IN A DAO" panel and counted once in the totals.`, c);
    if (!out.custody.length && cs && Array.isArray(cs.rows)) { const r = cs.rows.find(x => x.address === w); if (r && r.capa_equiv && r.capa_equiv.receipt_dao > 0) F('CUSTODY_MISSING', 'fault', `The CAPA supply product shows ${Math.round(r.capa_equiv.receipt_dao).toLocaleString('en-US')} CAPA of this wallet's receipt in the ampCAPA DAO, but the hourly record carries no custody row.`, { capa_supply_at: csAt }); }
    for (const l of out.lp_live) {
      if (!l.pool && l.status === 'unknown') F('UNKNOWN_LP_ROW', partAt && Date.parse(partAt) > Date.parse('2026-09-28T11:00:00Z') ? 'fault' : 'known', 'An amplified position the capture could not match to a pool (single-asset cw20 gauges before capture-engine 1.2.1, 2026-09-28).', l);
      if (l.status === 'inactive') F('INACTIVE_LP', 'check', `${l.pool} is below its bucket's 1% vote threshold — no emissions this epoch while the take rate still applies to non-amplified LP.`, l);
      else if (l.distance_pp != null && l.distance_pp < 0.5 && l.status === 'active') F('AT_RISK_LP', 'check', `${l.pool} is only ${l.distance_pp} pp above the 1% line — close to going inactive.`, l);
    }
    if (s.credia_lt_health_factor != null && s.credia_borrowed_usd > 0 && s.credia_lt_health_factor < 1.2) F('CREDIA_HEALTH_LOW', 'check', `Credia health ${s.credia_lt_health_factor} (below 1.2) on $${r2(s.credia_borrowed_usd)} borrowed.`, { health: s.credia_lt_health_factor });
  }

  // P&L ledger
  if (ledger && !ledger.__error) {
    const P = pnlBlock(ledger); out.pnl = P;
    if (P) {
      for (const p of P.open.concat(P.flagged)) {
        if (p.held_in) F('HELD_IN_CUSTODIAN', 'known', `${p.name} (${p.mechanism}): the receipt sits with ${p.held_in.where} — held, counted as open.`, { held_in: p.held_in });
        else if (p.not_held) { const mv = p.moves && p.moves.find(x => x.net_units > 0); F('MOVED_RECEIPT', 'known', `${p.name} (${p.mechanism}): the chain read finds none in this wallet — the receipt was sent ${mv ? 'to ' + (mv.label || mv.to) + ' on ' + mv.last_day : 'elsewhere'} (a transfer, not a withdrawal). Left out of Open now; its trips and rewards stay.`, { position: p.key, moves: p.moves, ledger_open_usd: p.not_held.ours_usd }); }
        if (p.disputed) F('DISPUTED', 'fault', `${p.name} (${p.mechanism}): our value disagrees with the chain read (ours $${p.disputed.ours_usd} vs ${p.disputed.participants_usd != null ? 'the chain read $' + p.disputed.participants_usd : 'the whole gauge $' + p.disputed.gauge_total_usd}) — left out of every total. Worth a report.`, p.disputed);
      }
      const unp = P.open.concat(P.closed_top).filter(p => p.trips_unpriced > 0);
      if (unp.length) F('APR_BLANK_UNPRICED', 'known', `${unp.length} position(s) have trips with no price that day, so their APR is blank (it would be inflated): ${unp.slice(0, 4).map(p => p.name).join(', ')}.`, unp.slice(0, 4).map(p => ({ name: p.name, trips: p.trips, unpriced: p.trips_unpriced })));
      const um = P.open.concat(P.closed_top).filter(p => p.unmatched_units);
      if (um.length) F('UNITS_BEFORE_CAPTURE', 'known', `${um.length} position(s) withdrew more than our history saw deposited (deposits before capture, or moved in) — the extra has no cost basis and is valued on the way out only.`, um.slice(0, 3).map(p => p.name));
      // ledger says open, chain read has nothing, and the build has not marked it (a build that predates 1.2.3, or a lag)
      if (m && out.lp_live) { const liveKeys = new Set((m.lp_positions || []).map(l => l.pool_gauge_id + '|' + (l.is_amplified ? 'amplified' : 'non_amplified')));
        const stale = P.open.filter(p => !p.not_held && !p.held_in && !p.disputed && (p.open_usd || 0) >= 50 && !liveKeys.has(p.key) && !(out.custody || []).some(c => c.pool + '|amplified' === p.key));
        for (const p of stale) F('LEDGER_OPEN_NOT_ON_CHAIN', 'check', `${p.name} (${p.mechanism}): the P&L history has $${p.open_usd} open but the hourly chain read finds no such position. The page reconciles this live ("not in this wallet"); if it persists after the next P&L build, report it.`, { position: p.key, pnl_built: P.built }); }
    }
  } else if (m) F('NO_PNL_LEDGER', 'known', 'No P&L history for this wallet yet (no TLA deposit / withdraw captured, or the build has not reached it).', { path: out.freshness.pnl.path });

  // Votion
  if (hp && hp.holders) {
    out.votion = Object.values(hp.holders).filter(h => h.wallet === w).map(h => ({ vault: h.vault, lst: h.lst_symbol, vtokens: r2(h.vtokens_now), totals: h.totals ? { in_usd: r2(h.totals.cost_usd), now_usd: r2(h.totals.usd_now), delta_usd: r2(h.totals.delta_usd), luna_price_usd: r2(h.totals.legs.luna_price), lst_staking_usd: r2(h.totals.legs.lst_stake), votion_usd: r2(h.totals.legs.votion), luna_in: r2(h.totals.luna_in), luna_now: r2(h.totals.luna_now), apr_votion: r2(h.totals.apr_votion * 100), advertised_apr: h.advertised && h.advertised.apr != null ? r2(h.advertised.apr * 100) : null, since: h.totals.first_day } : null,
      untracked_vtokens: h.untracked_vtokens || 0, unexplained_outflow_vtokens: h.unexplained_outflow_vtokens || 0 }));
    for (const v of out.votion) { if (v.untracked_vtokens > 0) F('VOTION_UNTRACKED', 'known', `${v.lst} vault: ${v.untracked_vtokens} vTokens have no archived deposit (moved in, or before the archive) — valued now, kept out of the P&L.`, v); if (v.unexplained_outflow_vtokens > 0) F('VOTION_OUTFLOW', 'known', `${v.lst} vault: ${v.unexplained_outflow_vtokens} vTokens left without a withdrawal (sent to another wallet) — taken from the oldest deposits.`, v); }
  } else F('VOTION_STORY_NOT_BUILT', 'known', 'votion/holder-pnl/current.json is not there yet — it is built after the daily Votion positions run.', { path: 'votion/holder-pnl/current.json' });

  const faults = out.findings.filter(f => f.kind === 'fault');
  out.report = faults.length ? { send_to: 'the Help page "Report an issue" form (it files a pre-checked report) — or @DeFi_Patriot', include: ['this wallet address', 'the card and the number seen', 'what you expected and why', 'the finding code(s): ' + faults.map(f => f.code).join(', '), 'the product path + capturedAt checked (see freshness)'] } : null;
  return out;
}

module.exports = { VERSION: 'portfolio-tool-1.0.0', run, _clearCache: () => { cache = new Map(); } };
