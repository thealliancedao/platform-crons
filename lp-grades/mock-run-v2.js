// mock-run-v2.js — gate for lp-grades/v2.js computeV2 on the COMMITTED v1 product + products it reads.
// Usage: TLA_CORE_DIR=/path/to/tla-core node mock-run-v2.js
'use strict';
const fs = require('fs'), path = require('path');
const CORE = process.env.TLA_CORE_DIR; if (!CORE) { console.error('TLA_CORE_DIR required'); process.exit(1); }
const { computeV2, pairClass, percentile, CONFIG_V2 } = require('./v2.js');
const J = (p) => JSON.parse(fs.readFileSync(path.join(CORE, p), 'utf8'));
const v1 = J('lp-grades/snapshots/current.json'), snap = J('member-data/tla-snapshot/current.json'), ps = J('member-data/tla-snapshot/pool-status-history.json'), vot = J('votion/optimization/current.json');
const votionByGauge = {}; for (const [g, gd] of Object.entries(vot.aggregate)) for (const [pid, pp] of Object.entries(gd.pools || {})) votionByGauge[g + '|' + pid] = pp.current_vp || 0;
let P = 0, F = 0; const check = (n, ok, x) => { if (ok) { P++; console.log('  ✓ ' + n); } else { F++; console.log('  ✗ ' + n + (x != null ? '  ← ' + JSON.stringify(x) : '')); } };
check('pair classes: LUNA-USDC native_stable · LUNA-ampLUNA lst_correlated · USDC-EURe stable_stable · LUNA-WBTC bluechip_bridge · LUNA-CAPA project · ampCAPA single', pairClass('LUNA-USDC') === 'native_stable' && pairClass('LUNA-ampLUNA') === 'lst_correlated' && pairClass('USDC-EURe') === 'stable_stable' && pairClass('LUNA-WBTC') === 'bluechip_bridge' && pairClass('LUNA-CAPA') === 'project' && pairClass('ampCAPA', true) === 'single_asset');
check('percentile: highest of [1,2,3,4,5] = 100, lowest = 0, ties share, lower-is-better flips', percentile([1, 2, 3, 4, 5], 5) === 100 && percentile([1, 2, 3, 4, 5], 1) === 0 && percentile([1, 2, 3, 4, 5], 1, false) === 100 && percentile([2, 2, 2], 2) === 50);
const r = computeV2(v1.pools, { snapshotPools: snap.pools, psHistory: ps, votionByGauge, votionRate: 20, runwayPots: {}, votedPeriod: 200, pdShareByGauge: {}, lunaUsd: 0.049, archive: [{ epoch: 199, byGauge: Object.fromEntries(v1.pools.map(p => [p.gauge_pool_id, { letter: p.grade, basis: 'v1' }])) }] });
const g = Object.values(r.byGauge);
check(`every active pool gets a v2 letter; the distribution spreads (A and F both present) — ${JSON.stringify(r.meta.distribution)}`, g.length > 25 && g.every(x => x.letter) && r.meta.distribution.A > 0 && r.meta.distribution.F > 0, r.meta.distribution);
const lu = r.byGauge['cw20:terra1s275y73lfupag0g03nglxaedfnsw5z4m5zc9wk66guy503zuw5ss889tlx'];
check('LUNA-USDC: purpose 100 (native-stable), work lens present with three parts, retention measured, composite = weighted mean of present lenses', lu && lu.lenses.purpose.score === 100 && lu.lenses.work.score != null && Object.keys(lu.lenses.work.parts).length === 3 && lu.raw.retention_4ep != null && Math.abs(lu.composite - Math.round((0.2 * lu.lenses.purpose.score + 0.25 * lu.lenses.work.score + 0.15 * lu.lenses.efficiency.score + 0.25 * lu.lenses.durability.score + 0.15 * lu.lenses.governance.score))) <= 1, lu && [lu.letter, lu.composite, lu.lenses.work, lu.raw.retention_4ep]);
check('governance: LUNA-CAPA mercenary share ≈ 1.66M/5.53M = 0.30 (Votion is in the pool), cushion pct present', (() => { const c = Object.values(r.byGauge).find(x => x.pair_class === 'project' && x.raw.mercenary_share != null && Math.abs(x.raw.mercenary_share - 0.30) < 0.03); return !!c && c.raw.cushion_pct != null; })());
check('null-vs-0: every pool with no utilization source has a NULL utilization part (never 0); confidence tiers vary', g.filter(x => x.raw.util == null).every(x => x.lenses.work.parts.utilization === null) && g.some(x => x.raw.util == null) && new Set(g.map(x => x.confidence)).size >= 2, [g.filter(x => x.raw.util == null).length, [...new Set(g.map(x => x.confidence))]]);
check('streak: a pool at ≥C now with a v1 C last epoch reads streak 2 (basis v1-backfilled); a pool at D/F reads 0', g.some(x => x.streak === 2 && x.streak_basis === 'v1-backfilled') && g.filter(x => x.letter === 'F' || x.letter === 'D').every(x => x.streak === 0));
check('why line names the strongest and weakest lens', g.every(x => /strongest: \w+ \d+ · weakest: \w+ \d+/.test(x.why)));
console.log(`\n=== MOCK GATE: ${P} passed, ${F} failed ===`); process.exit(F ? 1 : 0);
