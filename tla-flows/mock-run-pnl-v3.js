'use strict';
// mock-run-pnl-v3.js — BINDING gate for build-pnl v3 (tla-flows 3.5.0: pnl.js 1.2.0 + lib/pnl-positions.js 1.0.0).
// Real committed inputs from a tla-core checkout (every event month, state-history, price-history, participants, tla-voting
// rewards). Expected values come from the RAW products (participants chain reads, raw event legs), never from the code under test.
//   V1 Phase A/B unchanged: event counts, claim counts, claimed yield (LUNA + USD) identical to the pre-v3 build on the same
//      inputs; zap/fee USD may only GROW (the catalog now reads `effective` first → legs that were unknown get priced)
//   V2 FIFO + proportional partial lots, on a synthetic book (hand-computed): 100 u @ $100, 100 u @ $300, out 150 u for $330 →
//      in = $250, out = $330, Δ = +$80, market + lp = Δ exactly
//   V3 migration: a non-amp withdraw + amp deposit in one tx → NO trip, the new lot carries the old cost and open date
//   V4 attribution identity on EVERY valued trip in the real build: out − in = market + lp (± $0.02 rounding)
//   V5 units vs the chain: open non-amp units from events == participants' on-chain shares (< 0.1 %) on ≥ 95 % of positions
//   V6 value vs the chain: median |ours − participants| < 5 % (non-amp and amp); every disputed position is OUT of the totals
//   V11 (1.1.0) LP now == the chain's staked balance; LP in ≥ LP now (the take rate only removes); drag valued; capital × days present
//   V7 totals add up: wallet open.value_usd == Σ its non-disputed positions; DAO totals == Σ wallets
//   V8 value curve: the last point equals the open value on a wallet with no disputes and no missing pools (the owner's)
//   V9 determinism: two builds byte-identical minus builtAt
//   V10 heap: one build + serialize under --max-old-space-size=200 (Render ~256 MB), in a child process
// Usage: TLA_CORE_DIR=<checkout> [BASE_PNL=<pre-v3 pnl.js>] node --max-old-space-size=400 mock-run-pnl-v3.js
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');
const SRC = process.env.TLA_CORE_DIR; if (!SRC) { console.error('TLA_CORE_DIR required'); process.exit(1); }
const P = require('./pnl.js'), PP = require('./lib/pnl-positions');
let pass = 0, fail = 0; const check = (n, ok, x) => { if (ok) { pass++; console.log('  ✅ ' + n); } else { fail++; console.log('  ❌ ' + n + (x != null ? ' — ' + JSON.stringify(x).slice(0, 400) : '')); } };
const J = (p) => JSON.parse(fs.readFileSync(path.join(SRC, p), 'utf8'));
const localSrc = { readJson: async (p) => J(p), priceMonths: async () => { const ms = []; for (const y of fs.readdirSync(path.join(SRC, 'price-history')).filter(d => /^\d{4}$/.test(d)).sort()) for (const f of fs.readdirSync(path.join(SRC, 'price-history', y)).filter(f => /^\d\d\.json$/.test(f)).sort()) ms.push(`${y}/${f.slice(0, 2)}`); return ms; } };
const NOW = new Date('2026-09-28T03:31:00Z'); const OWNER = 'terra1hr8zsfpch47qygc96c8e6rzkd2t7mafqx77ulw';
const quiet = async (fn) => { const l = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = l; } };
const strip = (o) => { if (Array.isArray(o)) return o.map(strip); if (o && typeof o === 'object') { const r = {}; for (const [k, v] of Object.entries(o)) if (k !== 'builtAt' && k !== 'builder') r[k] = strip(v); return r; } return o; };
(async () => {
  const built = await quiet(() => P.buildPnl(localSrc, { now: () => NOW }));
  const R = built.files.get('tla-flows/pnl/rollup.json'); const W = new Map(R.wallets.map(w => [w.address, w]));
  const ledger = (a) => built.files.get(`tla-flows/pnl/ledger/${a}.json`);
  if (process.env.OUT_DIR) { const path = require('path'); for (const [p, doc] of built.files) { const f = path.join(process.env.OUT_DIR, p); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(doc)); } console.log(`  wrote ${built.files.size} files → ${process.env.OUT_DIR} (the page gate reads them as PNL_OUT)`); }

  console.log('— V1 Phase A/B unchanged —');
  if (process.env.BASE_PNL && fs.existsSync(process.env.BASE_PNL)) {
    const B = require(path.resolve(process.env.BASE_PNL)); const b = await quiet(() => B.buildPnl(localSrc, { now: () => NOW })); const RB = b.files.get('tla-flows/pnl/rollup.json');
    check('same wallets, same event counts per type', RB.wallets.length === R.wallets.length && JSON.stringify(RB.sources.events_by_type) === JSON.stringify(R.sources.events_by_type));
    let same = 0, grew = 0, bad = []; for (const wb of RB.wallets) { const w = W.get(wb.address); if (!w) { bad.push(wb.address); continue; }
      if (JSON.stringify(wb.counts) !== JSON.stringify(w.counts) || JSON.stringify(wb.claims) !== JSON.stringify(w.claims) || JSON.stringify(wb.claimed_yield) !== JSON.stringify(w.claimed_yield)) { bad.push(wb.address); continue; }
      if (w.zap_input_usd_at_event + 1e-6 < wb.zap_input_usd_at_event || w.fees_usd_at_event + 1e-6 < wb.fees_usd_at_event) { bad.push('shrank ' + wb.address); continue; }
      if (w.zap_input_usd_at_event > wb.zap_input_usd_at_event + 1e-6 || w.fees_usd_at_event > wb.fees_usd_at_event + 1e-6) grew++; else same++; }
    check(`counts, claims, claimed yield identical on every wallet; zap/fee USD never shrank (${same} same, ${grew} grew from newly priced legs)`, bad.length === 0, bad.slice(0, 5));
    check(`unpriced fee legs fell ${RB.pricing_meta.unpriced_fee_legs} → ${R.pricing_meta.unpriced_fee_legs} (catalog effective layer)`, R.pricing_meta.unpriced_fee_legs <= RB.pricing_meta.unpriced_fee_legs);
  } else console.log('  (BASE_PNL not given — Phase A/B differential skipped)');

  console.log('— V2/V3 synthetic book (hand-computed) —');
  { const rates = PP.finishRates(PP.newRates()); const pools = PP.finishPools(PP.newPools(), []);
    const ctx = { rates, pools, symbolOf: () => 'USDC', amountDisplay: (d, raw) => raw / 1e6, priceUsd: () => 1, lunaUsd: () => 0.05 };
    const book = PP.newBook(); const pool = 'cw20:terra1pool', dep = (tx, day, units, usd) => ({ txhash: tx, type: 'deposit', mechanism: 'non_amplified', user: 'w', pool, amount: String(units), amount_unit: 'shares', timestamp: day + 'T00:00:00Z', provides: [{ assets: [{ denom: 'uusd', amount: String(usd * 1e6) }], share: String(units) }] });
    PP.applyEvent(book, ctx, dep('A', '2025-01-01', 100, 100)); PP.applyEvent(book, ctx, dep('B', '2025-02-01', 100, 300));
    PP.applyEvent(book, ctx, { txhash: 'C', type: 'withdraw', mechanism: 'non_amplified', user: 'w', pool, amount: '150', amount_unit: 'shares', timestamp: '2025-03-01T00:00:00Z', withdraw_liqs: [{ refund_assets: [{ denom: 'uusd', amount: String(330e6) }], share: '150' }] });
    const p = book.positions.get(pool + '|non_amplified'); const t = p.trips[0];
    check('FIFO: first lot whole + half of the second → in $250, out $330, Δ +$80, market + lp = Δ', t && t.in_usd === 250 && t.out_usd === 330 && t.delta_usd === 80 && Math.abs(t.market_usd + t.lp_usd - t.delta_usd) < 0.011, t);
    check('the partial lot stays open: 50 units at $150 cost, opened 2025-02-01', p.lots.length === 1 && p.lots[0].units === 50 && Math.abs(p.lots[0].in_usd - 150) < 1e-9 && p.lots[0].day === '2025-02-01', p.lots);
    check('LUNA terms ride along: in 5,000 LUNA (at $0.05), out 6,600', t.in_luna === 5000 && t.out_luna === 6600, [t.in_luna, t.out_luna]);
    // migration
    const book2 = PP.newBook(); PP.applyEvent(book2, ctx, dep('D', '2025-01-01', 100, 100));
    const mig = new Set(['M|' + pool]);
    PP.applyEvent(book2, ctx, { txhash: 'M', type: 'withdraw', mechanism: 'non_amplified', user: 'w', pool, amount: '100', timestamp: '2025-05-01T00:00:00Z' }, mig);
    PP.applyEvent(book2, ctx, { txhash: 'M', type: 'deposit', mechanism: 'amplified', user: 'w', pool, amount: '80', amount_unit: 'amplp', timestamp: '2025-05-01T00:00:00Z', flows: [{ user: 'w', mechanism: 'amplified', type: 'deposit', bond_amount: '100', bond_share: '80' }] }, mig);
    const a = book2.positions.get(pool + '|amplified'), n = book2.positions.get(pool + '|non_amplified');
    check('migration non-amp → amp: no realized trip; the amp lot carries $100 cost and the 2025-01-01 open date', n.trips.length === 0 && a.lots.length === 1 && a.lots[0].in_usd === 100 && a.lots[0].day === '2025-01-01' && a.lots[0].carried && book2.segments === 1, { trips: n.trips, lot: a.lots[0] }); }

  console.log('— V4 attribution identity on every valued trip —');
  { let n = 0, bad = []; for (const [p, doc] of built.files) { if (!/ledger\/terra1/.test(p) || !doc.v3) continue; const C = doc.v3.trip_cols; const I = (k) => C.indexOf(k);
      for (const pos of Object.values(doc.v3.positions)) for (const r of pos.trips) { const inU = r[I('in_usd')], outU = r[I('out_usd')], m = r[I('market_usd')], l = r[I('lp_usd')]; if (inU == null || outU == null || m == null || l == null) continue; n++; if (Math.abs((outU - inU) - (m + l)) > 0.021) bad.push([doc.address.slice(-6), r[0], inU, outU, m, l]); } }
    check(`out − in = market + lp on all ${n} valued trips`, bad.length === 0 && n > 10000, bad.slice(0, 5)); }

  console.log('— V5/V6 against the chain (participants, hourly) —');
  const part = J('member-data/participants/current.json');
  { let exact = 0, tot = 0; const off = [];
    for (const m of part.members) { const d = ledger(m.wallet); const P5 = (d && d.v3 && d.v3.positions) || {};
      for (const l of m.lp_positions) { if (l.is_amplified || !l.pool_gauge_id) continue; const chain = Number(l.amplp_shares_raw || 0); if (chain < 1e6) continue; tot++;
        const ours = (P5[l.pool_gauge_id + '|non_amplified'] || {}).units_open || 0; if (Math.abs(ours - chain) / chain < 0.001) exact++; else off.push([m.wallet.slice(-6), l.pool_name, chain, ours]); } }
    check(`open non-amp units == on-chain shares (< 0.1 %) on ${exact}/${tot} positions (≥ 95 %)`, tot > 100 && exact / tot >= 0.95, off.slice(0, 6)); }
  { const rel = { amp: [], non: [] }; let disputedInTotals = 0;
    for (const m of part.members) { const d = ledger(m.wallet); const P6 = (d && d.v3 && d.v3.positions) || {};
      for (const l of m.lp_positions) { if (!l.pool_gauge_id) continue; const t = Number(l.estimated_position_usd || 0); if (t < 20) continue; const p = P6[l.pool_gauge_id + (l.is_amplified ? '|amplified' : '|non_amplified')]; if (!p || p.disputed || !p.open_value_usd) continue; (l.is_amplified ? rel.amp : rel.non).push(Math.abs(p.open_value_usd - t) / t); } }
    const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
    check(`value vs participants: median |Δ| non-amp ${(med(rel.non) * 100).toFixed(2)} % (${rel.non.length}), amp ${(med(rel.amp) * 100).toFixed(2)} % (${rel.amp.length}) — both < 5 %`, med(rel.non) < 0.05 && med(rel.amp) < 0.05 && rel.non.length > 50 && rel.amp.length > 40);
    for (const [p, doc] of built.files) { if (!/ledger\/terra1/.test(p) || !doc.v3) continue; const dis = Object.values(doc.v3.positions).filter(x => x.disputed); if (dis.length && (doc.v3.totals.positions_disputed || 0) !== dis.length) disputedInTotals++; }
    check(`every disputed position is counted as disputed in its wallet's totals (${R.totals.v3.positions_disputed} disputed DAO-wide)`, disputedInTotals === 0); }

  console.log('— V11 LP in vs now (pnl-positions 1.1.0): the take-rate drag and the top-up, against the chain —');
  { let tot = 0, near = 0, drag = 0, neg = 0, withUsd = 0; const off = [], negs = [];
    for (const m of part.members) { const d = ledger(m.wallet); const P = (d && d.v3 && d.v3.positions) || {};
      for (const l of m.lp_positions) { if (l.is_amplified || !l.pool_gauge_id) continue; const bal = Number(l.amplp_balance_raw || 0); if (bal < 1e6) continue; const p = P[l.pool_gauge_id + '|non_amplified']; if (!p || !p.open_lp || p.open_lp.lp_now_raw == null) continue; tot++;
        if (Math.abs(p.open_lp.lp_now_raw - bal) / bal < 0.005) near++; else off.push([m.wallet.slice(-6), l.pool_name, bal, p.open_lp.lp_now_raw]);
        if (p.open_lp.lp_in_raw != null) { if (p.open_lp.lp_in_raw >= p.open_lp.lp_now_raw * (1 - 1e-4)) drag++; /* 0.01 %: rate interpolation (a lot deposited just before the latest sample) */ else { neg++; negs.push([m.wallet.slice(-6), l.pool_name, p.open_lp.lp_in_raw, p.open_lp.lp_now_raw]); } }
        if (p.open_lp.take_rate && p.open_lp.take_rate.usd != null && p.open_value_usd) { withUsd++; } } }
    check(`LP now (units × today's rate) == the chain's staked balance (< 0.5 %) on ${near}/${tot} open non-amp positions (≥ 95 %)`, tot > 100 && near / tot >= 0.95, off.slice(0, 5));
    check(`the take rate only removes: LP in ≥ LP now on ${drag}/${drag + neg} (≥ 99 %); ${withUsd} drags valued in USD`, drag + neg > 100 && drag / (drag + neg) >= 0.99 && withUsd > 50, negs.slice(0, 5));
    let cap = 0, capBad = 0; for (const [p, doc] of built.files) { if (!/ledger\/terra1/.test(p) || !doc.v3) continue; for (const x of Object.values(doc.v3.positions)) { if (!x.open_lp) continue; cap++; if (x.open_cost_usd && !(x.open_lp.capital_days_usd >= 0)) capBad++; } }
    check(`every open position carries capital × days for its APR (${cap}, ${capBad} bad)`, cap > 100 && capBad === 0); }
  console.log('— V7 totals add up —');
  { let bad = []; let sumOpen = 0, sumNet = 0;
    for (const [p, doc] of built.files) { if (!/ledger\/terra1/.test(p) || !doc.v3) continue; const v = doc.v3; let s = 0; for (const x of Object.values(v.positions)) if (!x.disputed && typeof x.open_value_usd === 'number') s += x.open_value_usd;
      if (Math.abs(s - v.totals.open.value_usd) > 0.05 + 0.0001 * s) bad.push([doc.address.slice(-6), s, v.totals.open.value_usd]); sumOpen += v.totals.open.value_usd; sumNet += v.totals.net_usd; }
    check('each wallet: open.value_usd == Σ non-disputed position values', bad.length === 0, bad.slice(0, 4));
    check(`DAO: open value ${R.totals.v3.open_value_usd} == Σ wallets, net ${R.totals.v3.net_usd} == Σ wallets`, Math.abs(sumOpen - R.totals.v3.open_value_usd) < 1 && Math.abs(sumNet - R.totals.v3.net_usd) < 1, [sumOpen, sumNet]); }

  console.log('— V8 value curve (owner) —');
  { const d = ledger(OWNER); const v = d && d.v3; const last = v && v.value_curve[v.value_curve.length - 1];
    const prev = v.value_curve[v.value_curve.length - 2]; check(`owner: the curve spans E${v.value_curve[0].e}→E${prev.e} + a "now" point; now ${last.usd} == open value ${v.totals.open.value_usd}`, last && last.e === 'now' && !last.m && Math.abs(last.usd - v.totals.open.value_usd) < 0.05 && prev.e === v.totals.as_of_epoch, last);
    { let bad = 0, n = 0; for (const [p, doc] of built.files) { if (!/ledger\/terra1/.test(p) || !doc.v3 || !doc.v3.value_curve.length) continue; const z = doc.v3.value_curve[doc.v3.value_curve.length - 1]; if (z.e !== 'now' || z.m) continue; n++; if (Math.abs(z.usd - doc.v3.totals.open.value_usd) > 0.05 + 1e-4 * z.usd) bad++; } check(`every wallet with nothing missing: curve "now" == open value (${n} wallets)`, bad === 0 && n > 300, bad); }
    const t = v.totals; console.log(`     owner: realized ${t.realized.delta_usd} USD / ${t.realized.delta_luna.toFixed(0)} LUNA over ${t.realized.trips_valued} trips (market ${t.realized.market_usd}, lp ${t.realized.lp_usd}) · open ${t.open.value_usd} vs cost ${t.open.cost_usd} · claims ${t.rewards.claims_usd} · bribes ${t.rewards.bribes_usd} · net ${t.net_usd} USD / ${t.net_luna.toFixed(0)} LUNA`); }

  console.log('— V9 determinism —');
  { const b2 = await quiet(() => P.buildPnl(localSrc, { now: () => NOW })); let diff = 0; for (const [p, o] of built.files) if (JSON.stringify(strip(o)) !== JSON.stringify(strip(b2.files.get(p)))) diff++;
    check(`two builds identical minus builtAt (${built.files.size} files)`, diff === 0 && b2.files.size === built.files.size, diff); }

  console.log('— V10 heap (child process, --max-old-space-size=200) —');
  { const child = `const fs=require('fs'),path=require('path');const P=require(${JSON.stringify(path.resolve(__dirname, 'pnl.js'))});const S=${JSON.stringify(SRC)};const src={readJson:async p=>JSON.parse(fs.readFileSync(path.join(S,p),'utf8')),priceMonths:async()=>{const ms=[];for(const y of fs.readdirSync(path.join(S,'price-history')).filter(d=>/^\\d{4}$/.test(d)).sort())for(const f of fs.readdirSync(path.join(S,'price-history',y)).filter(f=>/^\\d\\d\\.json$/.test(f)).sort())ms.push(y+'/'+f.slice(0,2));return ms;}};(async()=>{console.log=()=>{};const b=await P.buildPnl(src,{now:()=>new Date('2026-09-28T03:31:00Z')});let n=0;for(const [,o] of b.files)n+=P.serialize(o).length;process.stdout.write('OK '+n);})().catch(e=>{process.stdout.write('ERR '+e.message);process.exit(1)});`;
    const r = spawnSync(process.execPath, ['--max-old-space-size=200', '-e', child], { encoding: 'utf8' });
    check(`one build + serialize of every file under a 200 MB heap (${(r.stdout || '').trim()})`, r.status === 0 && /^OK/.test(r.stdout || ''), (r.stderr || '').slice(-300)); }

  console.log(`\n=== MOCK GATE (pnl v3): ${pass} passed, ${fail} failed ===`); process.exit(fail ? 1 : 0);
})().catch(e => { console.error('GATE CRASH', e); process.exit(1); });
