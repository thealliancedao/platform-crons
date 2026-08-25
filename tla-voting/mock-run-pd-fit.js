// mock-run-pd-fit.js — gate for lib/pd-bribe-fit.js on COMMITTED products (weekly-avg
// CSVs, pd-bribes, pool-status-history, distributions, tla-snapshot). The numbers below
// were derived independently on 2026-08-25 from the same files.
// Usage: TLA_CORE_DIR=/path/to/tla-core node mock-run-pd-fit.js
'use strict';
const fs = require('fs'), path = require('path');
const CORE = process.env.TLA_CORE_DIR; if (!CORE) { console.error('TLA_CORE_DIR required'); process.exit(1); }
const { buildPdFit, universeFromWeekly, parseCsv } = require('./lib/pd-bribe-fit.js');
const J = (p) => JSON.parse(fs.readFileSync(path.join(CORE, p), 'utf8'));
const pd = J('tla-voting/pd-bribes/current.json'), ps = J('member-data/tla-snapshot/pool-status-history.json'), dist = J('tla-voting/distributions/history.json'), snap = J('member-data/tla-snapshot/current.json');
const nameOf = {}; for (const p of snap.pools) if (p.gauge_pool_id) nameOf[p.gauge_pool_id] = { name: p.name, bucket: p.bucket };
const weeklyByEpoch = {}; for (let e = 184; e <= 200; e++) { const f = path.join(CORE, `dex-data/astroport/weekly-avg/2026-epoch-${e}.csv`); if (fs.existsSync(f)) weeklyByEpoch[e] = universeFromWeekly(parseCsv(fs.readFileSync(f, 'utf8'))); }
let P = 0, F = 0; const check = (n, ok, x) => { if (ok) { P++; console.log('  ✓ ' + n); } else { F++; console.log('  ✗ ' + n + (x != null ? '  ← ' + JSON.stringify(x) : '')); } };
const batches = buildPdFit({ placements: pd.placements, weeklyByEpoch, poolStatus: ps, distributions: dist.entries, nameOf, currentEpoch: Math.max(...ps.epochs) });
const b250 = batches.find(b => b.proposal_id === 250), b253 = batches.find(b => b.proposal_id === 253);
check('batches built for every placement with legs, ascending by proposal', batches.length >= 4 && batches.every((b, i) => i === 0 || b.proposal_id > batches[i - 1].proposal_id), batches.map(b => b.proposal_id));
check('prop 250: window E193–196, reference epoch 192, 11 gauges, stated criterion carries "trading efficiency"', b250 && b250.window.start === 193 && b250.window.end === 196 && b250.window.reference_epoch === 192 && b250.pools_bribed === 11 && /efficiency/i.test(b250.stated_criterion || ''), b250 && [b250.window, b250.pools_bribed, b250.stated_criterion]);
const paxg = b250 && b250.legs.find(l => l.pool === 'PAXG-WBTC'), amp = b250 && b250.legs.find(l => l.pool === 'LUNA-ampLUNA');
check('prop 250: PAXG-WBTC ranked 16 of 19 by efficiency at placement (vol $462 on $163K) and still got 8.9% — 5th of 11 slices', paxg && paxg.at_placement.rank_eff === 16 && paxg.at_placement.of === 19 && Math.abs(paxg.share_pct - 8.9) < 0.2 && b250.legs.indexOf(paxg) === 4, paxg && [paxg.at_placement, paxg.share_pct, b250.legs.indexOf(paxg)]);
check('prop 250: LUNA-ampLUNA 22.2% share, rank 4 at E192', amp && Math.abs(amp.share_pct - 22.2) < 0.2 && amp.at_placement.rank_eff === 4, amp && [amp.share_pct, amp.at_placement.rank_eff]);
check('prop 250: 56% of LUNA to top-half pools; qualified-not-bribed at placement includes LUNA-USDC and LUNA-SOLID', Math.abs(b250.share_to_top_half_by_efficiency_pct - 56) < 1.5 && b250.qualified_not_bribed_at_placement.includes('LUNA-USDC') && b250.qualified_not_bribed_at_placement.includes('LUNA-SOLID'), [b250.share_to_top_half_by_efficiency_pct, b250.qualified_not_bribed_at_placement]);
const wbtc = b250.legs.find(l => l.pool === 'LUNA-WBTC');
check('prop 250 drift: LUNA-WBTC rank 3 at E192 → 9 for E194–196 (per-epoch ranks present)', wbtc && wbtc.by_epoch.eff_rank[192] === 3 && wbtc.by_epoch.eff_rank[194] === 9 && wbtc.by_epoch.eff_rank[196] === 9, wbtc && wbtc.by_epoch.eff_rank);
check('prop 253: 72% to top-half; PAXG-WBTC 16/17 again; wBTC.creda leg present but not in universe (no rank, LUNA shown)', b253 && Math.abs(b253.share_to_top_half_by_efficiency_pct - 72) < 1.5 && b253.legs.find(l => l.pool === 'PAXG-WBTC').at_placement.rank_eff === 16 && b253.legs.some(l => !l.in_universe && l.luna_per_epoch > 900 && l.at_placement === null), b253 && [b253.share_to_top_half_by_efficiency_pct, b253.legs.filter(l => !l.in_universe).map(l => [l.pool, l.luna_per_epoch])]);
check('consequence: bribed gauges carry VP per epoch from pool-status (LUNA-ampLUNA E196 vp > 0) and a payout share when distributions exist', amp && amp.by_epoch.vp_human[196] > 0 && Object.values(amp.by_epoch.payout_share).some(v => v != null && v > 0), amp && [amp.by_epoch.vp_human[196], amp.by_epoch.payout_share]);
check('universe rows are ranked ascending by efficiency and flag which were bribed', b250.universe_at_placement.every((r, i) => r.rank_eff === i + 1) && b250.universe_at_placement.filter(r => r.bribed).length === b250.legs.filter(l => l.in_universe).length);
check('a batch whose window predates the weekly series gets a note and null fit, never a made-up rank', batches.every(b => b.universe_at_placement !== null || (b.share_to_top_half_by_efficiency_pct === null && b.notes.some(n => /predates capture/.test(n)))));
console.log(`\n=== MOCK GATE: ${P} passed, ${F} failed ===`); process.exit(F ? 1 : 0);
