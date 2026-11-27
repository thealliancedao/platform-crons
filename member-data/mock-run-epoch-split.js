#!/usr/bin/env node
'use strict';
// mock-run-epoch-split.js — epoch-history-rollup 1.2.0: why the TVL moved (prices · flows · newly valued · lost value · other),
// the chained price index, and the pools staked with no price. A made-up world where every part is known; then, with
// DAILY=<tla-core member-data/tla-snapshot/daily>, the REAL dailies: the parts must add up to the change in every epoch.
const R = require('./epoch-history-rollup.js'); const fs = require('fs'); const path = require('path');
let pass = 0, fail = 0; const T = (n, c, d) => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + (d !== undefined ? ' ← ' + JSON.stringify(d).slice(0, 400) : ''))); };
const pool = (name, V, Q, dex = 'Astroport') => ({ name, dex, gauge_pool_id: 'cw20:' + name, status: 'active', staked_in_tla_usd: V, amp_lp: { underlying_lp_amount: Q } });
const snap = (epoch, day, pools) => ({ capturedAt: day + 'T23:40:00Z', epoch: { currentEpoch: epoch }, totals: { tla_tvl_usd: pools.reduce((t, p) => t + (p.staked_in_tla_usd || 0), 0), active_pools_count: pools.length, rewards: { luna_price_used: 0.05 } }, buckets: {}, pools });
// epoch 1 → 2:  A price +10% (no flow) · B half withdrawn at the same price · C staked, no price → priced · D priced → no price
//               E a new stake · F withdrawn in full · G unit price ×10 (an LP token change) · H unchanged
const E1 = [pool('A', 1000, 100), pool('B', 2000, 200), pool('C', 0, 300), pool('D', 400, 40), pool('F', 600, 60), pool('G', 500, 5000), pool('H', 800, 80)];
const E2 = [pool('A', 1100, 100), pool('B', 1000, 100), pool('C', 900, 300), pool('D', 0, 40), pool('E', 250, 25), pool('F', 0, 0), pool('G', 500, 500), pool('H', 800, 80)];
// epoch 2 → 3:  A price −50% and a deposit doubling the amount; everything else as it was
const E3 = [pool('A', 1100, 200), pool('B', 1000, 100), pool('C', 900, 300), pool('D', 0, 40), pool('E', 250, 25), pool('F', 0, 0), pool('G', 500, 500), pool('H', 800, 80)];
const days = [{ snap: snap(1, '2026-01-04', E1) }, { snap: snap(2, '2026-01-08', [pool('A', 5, 1)]) }, { snap: snap(2, '2026-01-11', E2) }, { snap: snap(3, '2026-01-18', E3) }];
const ep = R.fold(days, null); const [e1, e2, e3] = ep;
console.log('— the split —');
T('three epochs; the first has an index of 100 and nothing to be split against', ep.length === 3 && e1.price_index === 100 && e1.tvl_split === null);
T('an epoch is read at its LAST daily (the mid-week reading of epoch 2 is not used)', e2.tla_tvl_usd === 4550 && e2.tvl_split.vs_epoch === 1);
const s = e2.tvl_split;
T('prices: A +$100 (the same 100 units, each worth 10% more); H nothing', s.prices_usd === 100, s);
T('flows: B −$1,000 (half withdrawn) + E +$250 (a new stake) + F −$600 (all withdrawn) = −$1,350', s.flows_usd === -1350, s);
T('a pool that was staked with no price and now has one is "newly valued" (+$900), not a deposit — and is named', s.newly_valued_usd === 900 && s.newly_valued.join() === 'C');
T('a pool still staked whose price is gone is "lost value" (−$400), not a withdrawal — and is named', s.lost_value_usd === -400 && s.lost_value.join() === 'D');
T('a unit price that moved ten-fold in a week is not forced into prices or flows: "other" ($0 here), named', s.other_usd === 0 && s.other.join() === 'G' && s.pools_split === 3);
T('the five parts add up to the change of the TVL (5,300 → 4,550 = −750)', s.change_usd === -750 && Math.abs(s.prices_usd + s.flows_usd + s.newly_valued_usd + s.lost_value_usd + s.other_usd - s.change_usd) < 1e-9);
T('as shares of the TVL before: prices +1.89%, flows −25.47%', s.prices_pct === 1.89 && s.flows_pct === -25.47, [s.prices_pct, s.flows_pct]);
T('the largest movers are listed with both parts', s.movers[0].name === 'B' && s.movers[0].flows_usd === -1000 && s.movers.some(m => m.name === 'A' && m.prices_usd === 100 && m.flows_usd === 0));
T('a price fall and a deposit in the same pool are told apart: A −$550 from price (100 units × −5.5), +$550 from the 100 units added', e3.tvl_split.prices_usd === -550 && e3.tvl_split.flows_usd === 550 && e3.tvl_split.change_usd === 0);
T('the price index is chained: 100 → 101.8868 (+100 on 5,300) → 89.5708 (−550 on 4,550) — a pool weighs by its share of the TVL, prices are never averaged', e2.price_index === 101.8868 && e3.price_index === +(101.8867924528 * (1 - 550 / 4550)).toFixed(4), [e2.price_index, e3.price_index]);
T('pools staked with no price are named each epoch (C in epoch 1; D in 2 and 3)', e1.unvalued_staked.names.join() === 'C' && e2.unvalued_staked.names.join() === 'D' && e3.unvalued_staked.n === 1);
T('a pool that got its price later: what its stake would be worth at the unit price it FIRST got (C: 300 units × $3 = $900) — beside the TVL, marked an estimate', e1.unvalued_staked.later_valued && e1.unvalued_staked.later_valued.est_usd_at_first_price === 900 && /estimate/.test(e1.unvalued_staked.later_valued.note) && e1.tla_tvl_usd === 5300 && e2.unvalued_staked.later_valued === undefined);
T('two pools sharing a gauge id on different DEXes are kept apart; the same pool listed twice is added up', (() => { const m = R.poolMap({ pools: [pool('X', 10, 1, 'Astroport'), pool('X', 20, 2, 'Skeleton Swap'), pool('X', 5, 1, 'Astroport')] }); return m.size === 2 && [...m.values()].find(v => v.dex === 'Astroport').V === 15; })());
if (process.env.DAILY) { console.log('— the real dailies —'); const files = fs.readdirSync(process.env.DAILY).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort(); const real = R.fold(files.map(f => ({ snap: JSON.parse(fs.readFileSync(path.join(process.env.DAILY, f), 'utf8')), eris: null })), null);
  const bad = real.filter(e => e.tvl_split && Math.abs(e.tvl_split.prices_usd + e.tvl_split.flows_usd + e.tvl_split.newly_valued_usd + e.tvl_split.lost_value_usd + e.tvl_split.other_usd - e.tvl_split.change_usd) > 0.1);
  T(`${real.length} epochs from ${files.length} dailies: in every one the parts add up to the change of the TVL`, real.length > 20 && bad.length === 0, bad.map(e => e.epoch));
  T('and the change is the change of the published TVL figure (the pools add up to the total)', real.every((e, i) => !i || !e.tvl_split || Math.abs((e.tla_tvl_usd - real[i - 1].tla_tvl_usd) - e.tvl_split.change_usd) < 1), real.filter((e, i) => i && e.tvl_split && Math.abs((e.tla_tvl_usd - real[i - 1].tla_tvl_usd) - e.tvl_split.change_usd) >= 1).map(e => e.epoch));
  const last = real[real.length - 1]; T(`the index runs from 100 (E${real[0].epoch}) to ${last.price_index} (E${last.epoch}) and never leaves a sane range`, real[0].price_index === 100 && real.every(e => e.price_index > 5 && e.price_index < 500));
  const nv = real.filter(e => e.tvl_split && e.tvl_split.newly_valued_usd > 1000); console.log('    newly valued: ' + nv.map(e => `E${e.epoch} +$${Math.round(e.tvl_split.newly_valued_usd).toLocaleString('en-US')} (${e.tvl_split.newly_valued.join(', ')})`).join(' · '));
  const un = real.filter(e => e.unvalued_staked.later_valued); console.log('    understated epochs: ' + un.map(e => `E${e.epoch} ~$${e.unvalued_staked.later_valued.est_usd_at_first_price.toLocaleString('en-US')}`).join(' · ')); }
else console.log('(set DAILY=<tla-snapshot/daily> to check the real dailies)');
console.log(`\n===== EPOCH SPLIT GATE: ${pass}/${pass + fail} =====`); process.exit(fail ? 1 : 0);
