'use strict';
// help-agent/lib/vote-market-tool.js 1.0.0 (2026-09-27, v1.16.0) — the Vote Market simulator as a bot tool.
//
// The owner: "make sure we get this tool and its functionality added to the bot". The bot answers bribe / vote questions with
// the SAME engine the site runs (aDAO-links-site lib/vote-market.js — the TLA Stats tile, /vote-market.html and the app's
// Vote Market tab), fetched from the site repo at runtime and cached, never a copy: one set of numbers everywhere.
// Actions (input.action):
//   overview      — where $X does the most (lens: impact | underdogs | liquidity | volume | pd | leaving | mine), top N
//   simulate      — one pool: add a bribe and/or move a wallet's votes → Votion's reaction per vault, what comes back to the
//                   wallet, the real cost, the APR before/after, where Votion's votes move
//   best_split    — the most bribes for a wallet's VP (or a typed VP) across every bucket, Votion reacting
//   votion_moves  — Votion's own next move if nothing changes (its published plan vs its votes now, in real VP)
//   pool          — one pool's card: pot, votes, Votion now/plan, $ per 1M VP vs Votion's rate, APR, what it takes
// Every answer is an ESTIMATE on the round's pots and today's votes, if everything else stays the same — the result says so.

const SITE_REPO = 'https://raw.githubusercontent.com/thealliancedao/aDAO-links-site/main';
const PLANNER = 'https://thealliancedao.com/vote-market.html';
const ADDR = /^terra1[a-z0-9]{38,58}$/;
const ACTIONS = ['overview', 'simulate', 'best_split', 'votion_moves', 'pool'];
const ESTIMATE = 'Estimate on this round\'s pots and today\'s votes, if every other vote and pot stays the same. Other voters, bribers and Votion\'s own timing can change it before the round closes.';

let engineCache = { at: 0, VM: null }; let modelCache = { at: 0, m: null, live: false, voters: false };
const r2 = (x) => x == null || !isFinite(x) ? null : Math.round(x * 100) / 100;
const r0 = (x) => x == null || !isFinite(x) ? null : Math.round(x);
const r1 = (x) => x == null || !isFinite(x) ? null : Math.round(x * 10) / 10;

// the engine is UMD: under a CommonJS `module` it assigns module.exports
function engineFromSource(src) { const mod = { exports: {} }; new Function('module', 'exports', src)(mod, mod.exports); if (!mod.exports || typeof mod.exports.build !== 'function') throw new Error('vote-market engine did not load'); return mod.exports; }
async function engine(opts) {
  if (opts && opts.engine) return opts.engine;
  if (engineCache.VM && Date.now() - engineCache.at < 60 * 60 * 1000) return engineCache.VM;
  const r = await fetch(`${SITE_REPO}/lib/vote-market.js`, { headers: { 'User-Agent': 'tla-help-agent' } }); if (!r.ok) throw new Error('engine fetch ' + r.status);
  engineCache = { at: Date.now(), VM: engineFromSource(await r.text()) }; return engineCache.VM;
}
async function model(VM, opts) {
  if (opts && opts.model) return { m: opts.model, live: !!opts.live, voters: !!(opts.model.voters) };
  if (modelCache.m && Date.now() - modelCache.at < 10 * 60 * 1000) return modelCache;
  const m = await VM.load({}); let live = false;
  try { const l = await VM.fetchLivePots(m); if (l) { VM.applyLivePots(m, l); live = true; } } catch (e) { /* captured pots stand */ }
  modelCache = { at: Date.now(), m, live, voters: false }; return modelCache;
}
async function voters(VM, M) { if (M.m.voters && Object.keys(M.m.voters).length) { M.voters = true; return; } try { await M.m.loadVoters(); M.voters = true; } catch (e) { M.voters = false; } }

// "LUNA-EURe", "luna eure", "stable|terra1…" → one pool key; ambiguity is returned, never guessed
const norm = (s) => String(s || '').toLowerCase().replace(/[\s_\-./]+/g, '');
function resolvePool(m, ask, bucket) {
  const a = String(ask || '').trim(); if (!a) return { error: 'pool required (a pool name like LUNA-EURe, or its bucket|gauge key)' };
  if (m.pools[a]) return { pk: a };
  const b = bucket && bucket !== 'all' ? String(bucket).toLowerCase() : null;
  let hits = Object.keys(m.pools).filter(pk => norm(m.pools[pk].name) === norm(a) && (!b || m.pools[pk].bucket === b));
  if (!hits.length) hits = Object.keys(m.pools).filter(pk => norm(m.pools[pk].name).includes(norm(a)) && (!b || m.pools[pk].bucket === b));
  if (hits.length > 1) { const live = hits.filter(pk => m.pools[pk].vp > 1e5 || m.pools[pk].potUsd > 0 || m.pools[pk].stakedUsd >= 1000); if (live.length === 1) hits = live; }
  if (hits.length === 1) return { pk: hits[0] };
  if (!hits.length) return { error: `no TLA pool matches "${a}"${b ? ' in ' + b : ''}` };
  return { error: `"${a}" matches ${hits.length} pools — say which bucket`, candidates: hits.slice(0, 8).map(pk => ({ key: pk, name: m.pools[pk].name, bucket: m.pools[pk].bucket, dex: m.pools[pk].dex || null, votes: r0(m.pools[pk].vp) })) };
}
const winding = (p) => p.winding ? { asset: p.winding.symbol || null, headline: p.winding.headline || null, action: p.winding.action || null, deadline: p.winding.deadline || null, replacement: p.winding.replacement && p.winding.replacement.symbol || null, source_url: p.winding.source_url || null } : undefined;
const plannerUrl = (pk, bribe, view) => { const q = []; if (pk) q.push('pool=' + encodeURIComponent(pk)); if (bribe) q.push('bribe=' + Math.round(bribe)); if (view) q.push('view=' + view); return PLANNER + (q.length ? '?' + q.join('&') : ''); };
function roundInfo(VM, M) {
  const m = M.m; const casts = (m.moveRuleDoc && m.moveRuleDoc.timing && m.moveRuleDoc.timing.casts) || [];
  const hs = casts.filter(c => c.hours_before_deadline > 0 && c.hours_before_deadline < 6).map(c => c.hours_before_deadline).sort((a, b) => a - b); const hb = hs.length ? hs[Math.floor(hs.length / 2)] : null;
  let funded = 0, n = 0; for (const p of Object.values(m.pools)) { funded += p.potUsd || 0; if (p.potUsd > 0.5) n++; }
  return { round: Number(m.period), vote_before: m.voteBefore || null, votion_usually_casts_hours_before: hb, votion_cast_eta: m.voteBefore && hb != null ? new Date(Date.parse(m.voteBefore) - hb * 36e5).toISOString() : null,
    bribes_total_usd: r2(funded), funded_pots: n, pots: M.live ? 'live (incentive manager)' : 'captured (Votion\'s period list)', votion_rate_usd_per_1m_vp: r2(VM.votionRate(m)),
    votion_move_rule: m.moveRule ? `a vault re-votes a bucket only when its gain > $${m.moveRule.gain_usd_gt} AND its votes shift > ${m.moveRule.deviation_pct_gt}%` : null };
}
function walletFor(M, input) {
  const a = String(input.wallet || '').trim();
  if (a && ADDR.test(a)) { const rec = M.m.voters && M.m.voters[a]; if (rec) return { w: rec, who: rec.name || a, hypothetical: false };
    return { w: { vp: Number(input.vp) > 0 ? Number(input.vp) : 1e6, votes: {}, lp: [], hypothetical: true }, who: a, hypothetical: true, note: 'this address has no TLA votes on record — the numbers use a typed VP (' + (Number(input.vp) > 0 ? input.vp : '1,000,000 default') + ')' }; }
  const vp = Number(input.vp) > 0 ? Number(input.vp) : 1e6; return { w: { vp, votes: {}, lp: [], hypothetical: true }, who: null, hypothetical: true, note: input.vp ? undefined : 'no wallet given — 1,000,000 VP assumed, not voted yet' };
}
const tag = (VM, p) => ({ name: p.name, key: p.pk, bucket: VM.BUCKET_LABEL[p.bucket] || p.bucket, dex: p.dex || null, grade: p.grade || null, winding_down: winding(p), votion: p.votionExcluded ? 'excluded this round' : p.votionUntested ? 'not offered this pool yet (untested)' : undefined });

async function run(input, opts) {
  input = input || {}; const action = String(input.action || 'overview').toLowerCase(); if (!ACTIONS.includes(action)) return { error: 'action must be one of ' + ACTIONS.join(', ') };
  const VM = await engine(opts); const M = await model(VM, opts); const m = M.m;
  const base = { engine: VM.VERSION, round: roundInfo(VM, M), estimate: ESTIMATE };

  if (action === 'overview') {
    const lens = String(input.lens || 'impact'); const L = VM.LENSES.find(x => x.key === lens); if (!L) return { error: 'lens must be one of ' + VM.LENSES.map(x => x.key).join(', ') };
    const usd = Number(input.usd) > 0 ? Number(input.usd) : 50; const bucket = String(input.bucket || 'all').toLowerCase(); if (bucket !== 'all' && !VM.BUCKETS.includes(bucket)) return { error: 'bucket must be all or one of ' + VM.BUCKETS.join(', ') };
    let rec = null; if (lens === 'mine') { await voters(VM, M); const W = walletFor(M, input); if (W.hypothetical) return { error: 'lens "mine" needs a wallet with TLA votes / LP positions' }; rec = W.w; }
    const rows = VM.lens(m, { lens, bucket, usd, wallet: rec, limit: Math.min(15, Number(input.limit) || 8), untested: !!input.untested });
    return Object.assign(base, { lens: L.label, lens_means: L.hint, usd, bucket, planner: plannerUrl(null, 0),
      pools: rows.map((r, i) => Object.assign({ rank: i + 1 }, tag(VM, r.pool), { emissions_bought_usd_per_week: r2(r.im.emissionsBought), apr_next_epoch_now_pct: r1(r.im.apr0), apr_next_epoch_with_usd_pct: r1(r.im.apr1),
        crosses_1pct_line: !r.im.active0 && r.im.active1 ? true : undefined, under_1pct_line: !r.im.active1 ? true : undefined, votion_votes_in: r0(r.im.votionIn), pot_usd: r2(r.pool.potUsd), depth_usd: lens === 'liquidity' ? r0(r.pool.depthUsd) : undefined, volume_7d_usd: lens === 'volume' ? r0(r.pool.vol7dUsd) : undefined,
        votion_leaving_vp: lens === 'leaving' ? r0(r.pool.votionPlan - r.pool.votionNow) : undefined, simulate: plannerUrl(r.pool.pk, ['impact', 'underdogs', 'pd'].includes(lens) ? usd : 0) })),
      left_out: lens !== 'liquidity' && lens !== 'volume' ? Object.values(m.pools).filter(p => p.winding).length + ' winding-down pools are never recommended' : undefined });
  }
  if (action === 'votion_moves') {
    const bucket = String(input.bucket || 'all').toLowerCase(); const mv = VM.votionMoves(m, bucket);
    return Object.assign(base, { meaning: 'Votion\'s published plan minus its votes now, per pool, in real VP (its own units ÷ k per bucket). This is what its two vaults cast if nothing changes.',
      moves: mv.slice(0, Math.min(20, Number(input.limit) || 12)).map(x => { const p = m.pools[x.pk]; const epv = p.vp > 0 && p.weeklyUsdNow > 0 ? p.weeklyUsdNow / p.vp : null;
        return Object.assign(tag(VM, p), { votion_now_vp: r0(x.now), votion_plan_vp: r0(x.plan), change_vp: r0(x.d), lp_emissions_change_usd_per_week: epv != null ? r0(x.d * epv) : null, pot_usd: r2(p.potUsd), simulate: plannerUrl(x.pk, 0) }); }) });
  }
  if (action === 'best_split') {
    await voters(VM, M); const W = walletFor(M, input); const r = VM.bestSplitAll(m, W.w);
    return Object.assign(base, { wallet: W.who, vp: r0(W.w.vp), hypothetical: W.hypothetical, note: W.note, now_usd: r2(r.nowUsd), best_usd: r2(r.usd), gain_usd: r2(r.gain), planner: plannerUrl(null, 0, 'best'),
      buckets: VM.BUCKETS.map(b => { const x = r.buckets[b]; return { bucket: VM.BUCKET_LABEL[b], now_usd: r2(x.nowUsd), best_usd: r2(x.usd), split: x.split.filter(s => s.pct >= 0.005).map(s => ({ pool: s.name, key: s.pk, pct: r1(s.pct * 100), vp: r0(s.vp), usd: r2(s.usd), votion_excluded: m.pools[s.pk].votionExcluded || undefined })), skipped_winding_down: x.skipped && x.skipped.length ? x.skipped : undefined, note: x.split.length ? undefined : 'no funded pool pays here' }; }),
      caution: 'Weights are a starting point: a pool whose pot is small moves a lot when anyone else votes it. Re-check close to the deadline.' });
  }
  const R = resolvePool(m, input.pool, input.bucket); if (R.error) return Object.assign(base, R); const pk = R.pk; const p = m.pools[pk]; const b = p.bucket;
  if (action === 'pool') {
    const wt = VM.whatItTakes(m, pk); const rate = VM.votionRate(m); const per = p.potUsd > 0 && p.vp > 50000 ? p.potUsd / (p.vp / 1e6) : null;
    return Object.assign(base, { pool: Object.assign(tag(VM, p), { pot_usd: r2(p.potUsd), pot_tokens: (p.pot && p.pot.tokens || []).map(t => ({ symbol: t.sym, amount: r2(t.amount), usd: r2(t.usd) })), pot_unpriced: p.pot && p.pot.unpriced && p.pot.unpriced.length ? p.pot.unpriced : undefined, pot_priced_by: p.potPricedBy || undefined,
      votes_vp: r0(p.vp), votion_now_vp: r0(p.votionNow), votion_plan_vp: r0(p.votionPlan), usd_per_1m_vp: r2(per), vs_votion_rate_pct: per != null && rate ? r0((per / rate - 1) * 100) : null, apr_now_pct: r1(p.aprNow), staked_usd: r0(p.stakedUsd), depth_usd: r0(p.depthUsd), pd_bribe_usd: r2(p.pdUsd) || undefined,
      not_funded_warning: !(p.potUsd > 0.5) && p.votionNow > 50000 ? `Votion's ${r0(p.votionNow)} VP here leaves unless the pool is funded for round ${m.period} before it casts` : undefined }),
      what_it_takes: { bring_votion_in_usd: wt.votionExcluded ? null : wt.votionAlready ? 0 : r0(wt.votionIn), votion_already_in: !!wt.votionAlready, votion_excluded: !!wt.votionExcluded, cross_1pct_line_usd: r0(wt.overLine) }, simulate: plannerUrl(pk, 0) });
  }
  // simulate
  await voters(VM, M); const W = walletFor(M, input); const bribe = Math.max(0, Number(input.bribe_usd) || 0); const pct = Math.max(0, Math.min(100, Number(input.pct) || 0));
  let from = String(input.from || 'all'); if (from !== 'all') { const F = resolvePool(m, from, b); if (F.error) return Object.assign(base, { error: 'from: ' + F.error, candidates: F.candidates }); from = F.pk; }
  const sc = VM.scenario(m, { bucket: b, target: pk, bribeUsd: bribe, wallet: W.w, from, pct: pct / 100 }); const t0 = sc.base.rows[pk], t1 = sc.plan.rows[pk];
  const TR = (m.moveRuleDoc && m.moveRuleDoc.track_record && m.moveRuleDoc.track_record.by_vault) || {};
  const out = Object.assign(base, { pool: tag(VM, p), wallet: W.who, vp: r0(W.w.vp), hypothetical: W.hypothetical, note: W.note, bribe_usd: bribe, moved_vp: r0(sc.moved), moved_from: pct > 0 ? (from === 'all' ? 'all of the wallet\'s votes in this bucket' : m.pools[from].name) : undefined,
    votion: p.votionExcluded ? { stays_out: 'this pool is outside Votion\'s list this round' } : { votes_in_vp: r0(sc.votionIn), votes_now_vp: r0(t0.votion), votes_after_vp: r0(t1.votion),
      vaults: (sc.decisions || []).map(d => ({ vault: d.vault, vp: r0(d.vp), re_votes: !!d.moves, because_of_your_change: d.flippedByChange || undefined, your_change_adds_usd: d.gainFromChange != null ? r2(d.gainFromChange) : undefined, track_record: TR[d.vault] && TR[d.vault].flagged ? `re-voted ${TR[d.vault].moved} of ${TR[d.vault].flagged} times the rule said it would` : undefined })) },
    your_bribes_this_round: { now_usd: r2(sc.myNow), after_usd: r2(sc.myPlan), change_usd: r2(sc.myPlan - sc.myNow) },
    apr_next_epoch: { now_pct: r1(t0.apr), after_pct: r1(t1.apr), share_now_pct: r1(t0.share * 100), share_after_pct: r1(t1.share * 100), crosses_1pct_line: !t0.active && t1.active ? true : undefined, under_1pct_line: !t1.active ? true : undefined },
    flows: sc.flows.slice(0, 6).map(x => ({ pool: x.name, votion_change_vp: r0(x.d) })), simulate: plannerUrl(pk, bribe) });
  if (bribe > 0) out.bribe_breakdown = { you_pay_usd: r2(bribe), comes_back_to_your_votes_usd: r2(sc.bribeBack), elsewhere_usd: r2(sc.incomeChange - sc.bribeBack), elsewhere_means: (sc.incomeChange - sc.bribeBack) > 0.005 ? 'GAINED on the wallet\'s other pools: Votion\'s votes leave pools it votes, so it is diluted less' : (sc.incomeChange - sc.bribeBack) < -0.005 ? 'GIVEN UP on the wallet\'s other pools: Votion\'s new votes dilute it' + (sc.moved > 0 ? ', plus the pool it moved votes off' : '') : undefined, real_cost_this_round_usd: r2(sc.netCost), lp_emissions_bought_usd_per_week: r2(sc.emissionsBought),
    comes_back_note: sc.bribeBack > 0.005 ? undefined : (W.w.vp > 0 ? 'nothing comes back: the wallet\'s votes are not on this pool — move some here to collect part of its own bribe' : 'no votes to collect with') };
  else { const wt = VM.whatItTakes(m, pk); out.what_it_takes = { bring_votion_in_usd: wt.votionExcluded ? null : wt.votionAlready ? 0 : r0(wt.votionIn), votion_already_in: !!wt.votionAlready, cross_1pct_line_usd: r0(wt.overLine) }; }
  if (p.winding) out.warning = `${p.name} holds ${p.winding.symbol || 'an asset'} that is being wound down — ${p.winding.action || p.winding.headline || ''}`.trim();
  return out;
}

module.exports = { VERSION: '1.0.0', ACTIONS, run, resolvePool, engineFromSource, plannerUrl, ESTIMATE };
