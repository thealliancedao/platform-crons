#!/usr/bin/env node
// gate-vote-market-tool.mjs — help-agent v1.16.0: the bot's vote_market tool (lib/vote-market-tool.js) answers with the SAME
// numbers the site's engine computes. Offline: the engine from a local aDAO-links-site checkout, the model built from a local
// tla-core checkout (the products the site reads). Relations, never literals.
// Usage: TLA_CORE_DIR=/path/tla-core SITE_DIR=/path/aDAO-links-site node gate-vote-market-tool.mjs
import fs from 'fs'; import path from 'path'; import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const CORE = process.env.TLA_CORE_DIR, SITE = process.env.SITE_DIR; if (!CORE || !SITE) { console.error('TLA_CORE_DIR and SITE_DIR required'); process.exit(1); }
const here = path.dirname(new URL(import.meta.url).pathname);
const T = require(path.join(here, 'lib/vote-market-tool.js'));
let PASS = 0, FAIL = 0; const check = (n, ok, x) => { if (ok) { PASS++; console.log('  ✓ ' + n); } else { FAIL++; console.log('  ✗ ' + n + (x != null ? '  ← ' + JSON.stringify(x).slice(0, 400) : '')); } };
const J = (rel) => JSON.parse(fs.readFileSync(path.join(CORE, rel), 'utf8'));
const VM = T.engineFromSource(fs.readFileSync(path.join(SITE, 'lib/vote-market.js'), 'utf8'));   // the same loader the service uses on the fetched file
const MRp = path.join(CORE, 'votion/backtest/move-rule.json');
const m = VM.build({ moveRule: fs.existsSync(MRp) ? J('votion/backtest/move-rule.json') : null, snapshot: J('member-data/tla-snapshot/current.json'), votion: J('votion/optimization/current.json'), grades: J('lp-grades/snapshots/current.json'), pd: J('tla-voting/pd-bribes/current.json'), prices: J('network-and-prices/current.json'), catalog: J('token-catalog/snapshots/current.json'), participants: J('member-data/participants/current.json') });
const opts = { engine: VM, model: m };
const cam = 'terra1hr8zsfpch47qygc96c8e6rzkd2t7mafqx77ulw';
console.log(`vote_market tool ${T.VERSION} · engine ${VM.VERSION} · round ${m.period}`);

check('X0 the engine loads from its source text (UMD → module.exports), as the service loads the fetched file', typeof VM.scenario === 'function' && typeof VM.build === 'function');
const ov = await T.run({ action: 'overview', usd: 50 }, opts); const top = VM.lens(m, { lens: 'impact', bucket: 'all', usd: 50, limit: 8 });
check('X1 overview $50 = the engine\'s top 8, in order, with its emissions and APRs', ov.pools.length === top.length && ov.pools.every((p, i) => p.key === top[i].pool.pk && Math.abs(p.emissions_bought_usd_per_week - top[i].im.emissionsBought) < 0.01), ov.pools.slice(0, 2));
const funded = Object.values(m.pools).reduce((s, p) => s + (p.potUsd || 0), 0);
check(`X2 the round header: $${funded.toFixed(2)} in ${Object.values(m.pools).filter(p => p.potUsd > 0.5).length} pots (the planner's number), Votion's rate, its move rule`, Math.abs(ov.round.bribes_total_usd - funded) < 0.01 && ov.round.votion_rate_usd_per_1m_vp === Math.round(VM.votionRate(m) * 100) / 100 && /gain > \$0\.05 AND/.test(ov.round.votion_move_rule || ''), ov.round);
check('X3 every answer is marked an estimate and links the simulator with the $ in', /if every other vote and pot stays the same/.test(ov.estimate) && ov.pools.every(p => p.simulate === 'https://thealliancedao.com/vote-market.html?pool=' + encodeURIComponent(p.key) + '&bribe=50'));
check('X4 no winding-down pool is recommended', ov.pools.every(p => !p.winding_down));
const ud = await T.run({ action: 'overview', lens: 'underdogs', bucket: 'project', usd: 250 }, opts); const udE = VM.lens(m, { lens: 'underdogs', bucket: 'project', usd: 250, limit: 8 });
check('X5 lens + bucket + amount follow the engine (underdogs · project · $250)', ud.pools.map(p => p.key).join() === udE.map(r => r.pool.pk).join());
check('X6 bad inputs are refused with the choices', /lens must be one of/.test((await T.run({ action: 'overview', lens: 'nope' }, opts)).error) && /action must be one of/.test((await T.run({ action: 'fly' }, opts)).error));

// simulate: the planner's own scenario for the wallet, $100 on the top pool
const tgt = top[0].pool; const sim = await T.run({ action: 'simulate', pool: tgt.name, bucket: tgt.bucket, bribe_usd: 100, wallet: cam }, opts);
const scE = VM.scenario(m, { bucket: tgt.bucket, target: tgt.pk, bribeUsd: 100, wallet: m.voters[cam], from: 'all', pct: 0 });
check(`X7 simulate by NAME (${tgt.name}) resolves the pool and equals the engine's scenario: Votion ${Math.round(scE.votionIn)} VP in, back $${scE.bribeBack.toFixed(2)}, real cost $${scE.netCost.toFixed(2)}`, !sim.error && sim.pool.key === tgt.pk && sim.votion.votes_in_vp === Math.round(scE.votionIn) && sim.bribe_breakdown.comes_back_to_your_votes_usd === Math.round(scE.bribeBack * 100) / 100 && sim.bribe_breakdown.real_cost_this_round_usd === Math.round(scE.netCost * 100) / 100 && sim.apr_next_epoch.after_pct === Math.round(scE.plan.rows[tgt.pk].apr * 10) / 10, sim.error || sim.bribe_breakdown);
check('X8 simulate names each Votion vault\'s decision (re-votes / holds) with its track record', Array.isArray(sim.votion.vaults) && sim.votion.vaults.length === (scE.decisions || []).length && sim.votion.vaults.every((v, i) => v.re_votes === !!scE.decisions[i].moves));
const rec = m.voters[cam]; const bk = Object.keys(rec.votes).map(k => k.split('|')[0])[0]; const other = bk && Object.keys(m.pools).filter(pk => m.pools[pk].bucket === bk && m.pools[pk].potUsd > 1 && !rec.votes[pk])[0];
if (other) { const mv = await T.run({ action: 'simulate', pool: other, wallet: cam, pct: 50 }, opts); const scM = VM.scenario(m, { bucket: bk, target: other, bribeUsd: 0, wallet: rec, from: 'all', pct: 0.5 });
  check(`X9 moving 50% of the wallet's ${bk} votes to ${m.pools[other].name}: moved VP and the wallet's bribes = the engine's`, mv.moved_vp === Math.round(scM.moved) && mv.your_bribes_this_round.after_usd === Math.round(scM.myPlan * 100) / 100 && !!mv.what_it_takes, mv.error || [mv.moved_vp, mv.your_bribes_this_round]); }
const dup = Object.values(m.pools).map(p => p.name).find((n, i, a) => a.indexOf(n) !== i && Object.values(m.pools).filter(p => p.name === n && (p.vp > 1e5 || p.potUsd > 0 || p.stakedUsd >= 1000)).length > 1);
if (dup) { const amb = await T.run({ action: 'pool', pool: dup }, opts); check(`X10 an ambiguous name (${dup}) returns the candidates, never a guess`, /say which bucket/.test(amb.error || '') && amb.candidates.length > 1, amb); }
const unknown = await T.run({ action: 'simulate', pool: 'NOT-A-POOL', bribe_usd: 10 }, opts); check('X11 an unknown pool is an error, not a made-up answer', /no TLA pool matches/.test(unknown.error || ''));
const hyp = await T.run({ action: 'simulate', pool: tgt.pk, bribe_usd: 100 }, opts); check('X12 no wallet → 1M VP not voted: nothing comes back, and it says why', hyp.hypothetical && hyp.bribe_breakdown.comes_back_to_your_votes_usd === 0 && /not on this pool/.test(hyp.bribe_breakdown.comes_back_note || ''));

const bs = await T.run({ action: 'best_split', wallet: cam }, opts); const bsE = VM.bestSplitAll(m, rec);
check(`X13 best_split for the wallet = the engine's ($${bsE.nowUsd.toFixed(2)} → $${bsE.usd.toFixed(2)}), linked to ?view=best`, bs.now_usd === Math.round(bsE.nowUsd * 100) / 100 && bs.best_usd === Math.round(bsE.usd * 100) / 100 && /view=best$/.test(bs.planner) && bs.buckets.length === VM.BUCKETS.length, [bs.now_usd, bs.best_usd]);
const bs2 = await T.run({ action: 'best_split', vp: 2e6 }, opts); check('X14 best_split with a typed VP (2M) runs hypothetically', bs2.hypothetical && bs2.vp === 2e6 && bs2.best_usd === Math.round(VM.bestSplitAll(m, { vp: 2e6, votes: {}, lp: [] }).usd * 100) / 100);
const vm = await T.run({ action: 'votion_moves' }, opts); const mvE = VM.votionMoves(m, 'all');
check(`X15 votion_moves = its published plan in real VP (row 1 ${mvE[0] && mvE[0].name} ${mvE[0] && Math.round(mvE[0].d)})`, vm.moves.length > 0 && vm.moves[0].key === mvE[0].pk && vm.moves[0].change_vp === Math.round(mvE[0].d));
const pc = await T.run({ action: 'pool', pool: tgt.pk }, opts); const wt = VM.whatItTakes(m, tgt.pk);
check('X16 pool card: pot, votes, Votion now/plan and what it takes = the engine', pc.pool.pot_usd === Math.round(tgt.potUsd * 100) / 100 && pc.pool.votes_vp === Math.round(tgt.vp) && pc.pool.votion_plan_vp === Math.round(tgt.votionPlan) && pc.what_it_takes.cross_1pct_line_usd === (wt.overLine == null ? null : Math.round(wt.overLine)));
const wind = Object.values(m.pools).find(p => p.winding && (p.vp > 1e5 || p.potUsd > 0));
if (wind) { const ws = await T.run({ action: 'simulate', pool: wind.pk, bribe_usd: 25 }, opts); check(`X17 a winding-down pool (${wind.name}) carries the warning and the migration`, /being wound down/.test(ws.warning || '') && !!ws.pool.winding_down); }

console.log(`\n${PASS} passed · ${FAIL} failed`); process.exit(FAIL ? 1 : 0);
