'use strict';
// mock-run-snapshot.js — BINDING gate for tla-snapshot 1.3.0 on REAL committed data (a tla-core checkout). Nothing fetched; the
// live functions of tla-snapshot.js are exercised, never a copy.
// Usage: TLA_CORE_DIR=<tla-core checkout> node member-data/mock-run-snapshot.js
//   N  an IBC token the hand registry does not know is named from the price feed's denom + the token-catalog (USDC.inj); registry
//      entries are untouched; a denom nobody knows stays null (never guessed)
//   V  each USDC.inj pool, rebuilt from the reserves the snapshot already records: both sides priced, pool value = the DEX depth,
//      staked value = the Eris-method feed's figure (dex-data/eris-apr)
//   W  the gauges' own asset lists: parsed, checked against what the chain is paying, the token-catalog standing in when unread
//   R  rewards: an asset off its gauge's list earns nothing; the per-pool emissions add up to the emission (they ran ~12 % over)
//   T  totals: TLA staked in the pools the chain is paying = the Eris-method feed's total
//   E  (1.3.0) the year's emission from the chain's own figures, the calibrated constant as the labelled fallback
//   S  (1.3.0) total voting power from the lock contract's total_vamp
const fs = require('fs'), path = require('path');
const SRC = process.env.TLA_CORE_DIR; if (!SRC) { console.error('TLA_CORE_DIR required'); process.exit(1); }
const S = require('./tla-snapshot.js')._internals;
let pass = 0, fail = 0;
const check = (n, ok, x) => { if (ok) { pass++; console.log('  ✅ ' + n); } else { fail++; console.log('  ❌ ' + n + (x != null ? ' — ' + JSON.stringify(x).slice(0, 500) : '')); } };
const J = (p) => JSON.parse(fs.readFileSync(path.join(SRC, p), 'utf8'));
const snap = J('member-data/tla-snapshot/current.json'), np = J('network-and-prices/current.json'), cat = J('token-catalog/snapshots/current.json'),
  eris = J('dex-data/eris-apr/current.json'), distH = J('tla-voting/distributions/history.json');
const dist = distH.entries[distH.entries.length - 1].gauges;
const usd = (v) => '$' + Math.round(v).toLocaleString('en-US');

(async () => {
  console.log(`${S.SNAPSHOT_VERSION} gate — snapshot of ${snap.capturedAt} (${snap.version || 'written by an earlier build'}), distribution period ${distH.entries[distH.entries.length - 1].period}`);
  const tokenPrices = np.token_prices || {};
  const feedByDenom = new Map(); for (const [sym, e] of Object.entries(tokenPrices)) if (e && typeof e.denom === 'string' && e.denom) feedByDenom.set(e.denom, sym);
  // cw20 token_info answers come from the price feed's own denom → key (no chain here): symbol = the feed key, 6 decimals is
  // what every cw20 in these four pools has on chain (SOLID) — the gate only needs the USDC.inj side, which is native
  const tokenInfo = async (addr, q) => (q && q.token_info && feedByDenom.has(addr)) ? { symbol: feedByDenom.get(addr), decimals: 6 } : null;
  const R = new S.TokenResolver(tokenInfo, { feedByDenom, catalog: cat });
  const P = new S.PriceResolver(tokenPrices, np.lst_ratios || {}, new Map());

  // ── N: names ──
  const reg = Object.entries(S.IBC_REGISTRY); let regSame = 0;
  for (const [denom, want] of reg) { const got = await R.resolve({ native_token: { denom } }); if (got.symbol === want.symbol && got.decimals === want.decimals) regSame++; }
  check(`N1 all ${reg.length} hand-registry IBC denoms resolve exactly as before`, regSame === reg.length && reg.length > 20);
  const inj = tokenPrices['USDC.inj'] && tokenPrices['USDC.inj'].denom;
  const gInj = inj ? await R.resolve({ native_token: { denom: inj } }) : null;
  check(`N2 USDC.inj (${String(inj).slice(0, 12)}…, not in the registry) → ${gInj && gInj.symbol}, ${gInj && gInj.decimals} decimals, via ${gInj && gInj._source}`,
    !!inj && !S.IBC_REGISTRY[inj] && gInj.symbol === 'USDC.inj' && gInj.decimals === 6, gInj);
  const ghost = 'ibc/' + 'F'.repeat(64); const gGhost = await R.resolve({ native_token: { denom: ghost } });
  check('N3 an IBC denom neither the feed nor the catalog knows stays null (never guessed)', gGhost.symbol === null && gGhost._unknown_ibc === ghost, gGhost);
  const bare = new S.TokenResolver(tokenInfo); const gBare = inj ? await bare.resolve({ native_token: { denom: inj } }) : null;
  check('N4 with neither input loaded the resolver behaves as before (USDC.inj null) — a missing feed never invents a name', !!gBare && gBare.symbol === null);
  const pInj = P.resolvePrice('USDC.inj');
  check(`N5 the price lookup then hits: USDC.inj = $${pInj.price} (${pInj.source})`, pInj.price > 0.97 && pInj.price < 1.03 && pInj.source === 'direct', pInj);

  // ── V: the four pools, from the reserves already in the snapshot ──
  const denomOf = (sym) => sym === 'LUNA' ? 'uluna' : (tokenPrices[sym] && tokenPrices[sym].denom) || null;
  const erisBy = new Map(eris.pools.map(p => [p.gauge_pool_id, p]));
  const injPools = snap.pools.filter(p => /USDC\.inj/.test(p.name) && p.is_lp_pair && p.lp_health && p.amp_lp);
  const fixedStake = new Map(); let vOk = 0; const vRows = [];
  for (const p of injPools) {
    const sides = [p.lp_health.asset_0, p.lp_health.asset_1];
    // the side the old build left unnamed is the USDC.inj side (the pool is named for it); the other keeps its symbol
    const infos = sides.map(a => { const d = a.symbol ? denomOf(a.symbol) : inj; return !d ? null : (/^terra1/.test(d) ? { token: { contract_addr: d } } : { native_token: { denom: d } }); });
    if (infos.some(x => !x)) { vRows.push([p.name, 'side without a denom in the feed']); continue; }
    const poolData = { assets: sides.map((a, i) => ({ info: infos[i], amount: String(a.amount_raw) })), total_share: p.lp_health.total_share };
    const H = await S.buildLpHealth(poolData, P, R);
    const staked = H.total_pool_usd ? Number(p.amp_lp.underlying_lp_amount) * H.total_pool_usd / Number(H.total_share) : null;
    const e = erisBy.get(p.gauge_pool_id);
    const depthOk = H.total_pool_usd && p.depth_usd ? Math.abs(H.total_pool_usd / p.depth_usd - 1) < 0.05 : false;
    const erisOk = staked && e && e.tla_staked_usd ? Math.abs(staked / e.tla_staked_usd - 1) < 0.03 : false;
    if (depthOk && erisOk && H.asset_0.symbol && H.asset_1.symbol) vOk++;
    vRows.push([p.name, 'pool ' + (H.total_pool_usd ? usd(H.total_pool_usd) : 'null') + ' vs depth ' + usd(p.depth_usd || 0), 'staked ' + (staked ? usd(staked) : 'null') + ' vs Eris-method ' + (e ? usd(e.tla_staked_usd) : '—'), 'published: ' + (p.staked_in_tla_usd == null ? 'null' : usd(p.staked_in_tla_usd))]);
    if (staked) fixedStake.set(p.gauge_pool_id, staked);
  }
  for (const r of vRows) console.log('     · ' + r.join(' · '));
  check(`V1 ${injPools.length} USDC.inj pools: both sides named and priced, pool value within 5 % of the DEX depth, staked value within 3 % of the Eris-method feed`, injPools.length >= 3 && vOk === injPools.length);

  // ── W: the gauges' own lists ──
  const rowsByBucket = {}; for (const b of S.BUCKETS) rowsByBucket[b] = [];
  for (const p of cat.pools) if (rowsByBucket[p.bucket] && p.asset_raw) rowsByBucket[p.bucket].push({ info: p.asset_raw, config: {}, whitelisted: p.gauge_status !== 'dewhitelisted' });
  const truth = S.buildWhitelistTruth(rowsByBucket, dist);
  const paid = dist.flatMap(d => (d.assets || []).map(a => [d.gauge, a.asset.cw20 ? 'cw20:' + a.asset.cw20 : 'native:' + a.asset.native]));
  check(`W1 chain-shaped rows parse for all four gauges; every asset the chain is paying (${paid.length}) reads whitelisted`, S.BUCKETS.every(b => truth[b] instanceof Map) && paid.every(([b, k]) => truth[b].get(k) === true));
  const mangled = {}; for (const b of S.BUCKETS) mangled[b] = rowsByBucket[b].map(r => ({ ...r, info: r.info.cw20 ? { cw20: 'x' + r.info.cw20 } : { native: 'x' + r.info.native } }));
  const bad = S.buildWhitelistTruth(mangled, dist);
  check('W2 a list that does not name what the chain is paying is dropped (null), not allowed to switch pools off', S.BUCKETS.every(b => bad[b] === null));
  check('W3 a failed read (not a list) is null', S.whitelistOf(null) === null && S.whitelistOf({ error: 'x' }) === null && S.buildWhitelistTruth({}, dist).stable === null);
  const catStatus = new Map(cat.pools.map(p => [`${p.bucket}|${p.gauge_pool_id}`, p.gauge_status]));
  const some = snap.pools.find(p => catStatus.get(`${p.bucket}|${p.gauge_pool_id}`) === 'dewhitelisted');
  const viaChain = S.whitelistFor(some.bucket, some.gauge_pool_id, truth, catStatus), viaCat = S.whitelistFor(some.bucket, some.gauge_pool_id, { [some.bucket]: null }, catStatus), viaNone = S.whitelistFor(some.bucket, some.gauge_pool_id, {}, new Map());
  check(`W4 ${some.name}: chain list → off (${viaChain.source}); chain unread → the token-catalog stands in (${viaCat.source}); neither → null`,
    viaChain.whitelisted === false && /^chain:/.test(viaChain.source) && viaCat.whitelisted === false && /^token-catalog:/.test(viaCat.source) && viaNone.whitelisted === null);

  // ── R / T: status, rewards and totals on the real pools ──
  const bucketVps = {}; for (const b of S.BUCKETS) bucketVps[b] = snap.buckets[b].bucket_vp;
  const pools = snap.pools.map(p => {
    const q = JSON.parse(JSON.stringify(p));
    const wl = S.whitelistFor(q.bucket, q.gauge_pool_id, truth, catStatus);
    const st = S.poolStatus({ isDeprecated: p.status === 'deprecated', whitelisted: wl.whitelisted, pctOfBucket: q.voting_power.pct_of_bucket, vp: q.voting_power.vp });
    q.gauge_whitelisted = wl.whitelisted; q.status = st.status; q.status_reason = st.reason;
    if (q.staked_in_tla_usd == null && fixedStake.has(q.gauge_pool_id)) q.staked_in_tla_usd = fixedStake.get(q.gauge_pool_id);   // what V1 just measured
    if (q.voting_power.total_human == null) q.voting_power.total_human = q.voting_power.vp_human;                                 // an earlier build's file has no fixed part
    delete q.rewards; return q;
  });
  const offBig = pools.filter(q => q.gauge_whitelisted === false && q.voting_power.pct_of_bucket >= 1);
  check(`R1 ${offBig.length} pools hold ≥ 1 % of their gauge's votes but are off its list → "voted_but_below_threshold", reason "dewhitelisted" (${offBig.map(q => q.name).slice(0, 9).join(', ')})`,
    offBig.every(q => q.status === 'voted_but_below_threshold' && q.status_reason === 'dewhitelisted'));
  const paidSet = new Set(paid.map(([, k]) => k));
  const paidPools = pools.filter(q => paidSet.has(q.gauge_pool_id));
  check(`R2 the ${paidPools.length} pools the chain is paying keep their status (${paidPools.filter(q => q.status === 'active').length} active) and none is flagged`, paidPools.length === paid.length && paidPools.every(q => q.gauge_whitelisted === true && q.status_reason === null && q.status === snap.pools.find(p => p.gauge_pool_id === q.gauge_pool_id).status));
  const { totals, byBucket } = S.computeRollups(pools, bucketVps);
  const luna = tokenPrices.LUNA.final_price_usd;
  const rw = S.computeRewards(pools, byBucket, totals, luna, dist);
  const sumLuna = pools.reduce((s, q) => s + ((q.rewards && q.rewards.annual_emissions_luna) || 0), 0);
  const before = snap.pools.reduce((s, q) => s + ((q.rewards && q.rewards.annual_emissions_luna) || 0), 0);
  check(`R3 per-pool emissions add up to the emission: ${(sumLuna / rw.annual_emissions_luna * 100).toFixed(2)} % of ${Math.round(rw.annual_emissions_luna).toLocaleString('en-US')} LUNA a year (the published file: ${(before / rw.annual_emissions_luna * 100).toFixed(2)} %)`,
    sumLuna / rw.annual_emissions_luna > 0.999 && sumLuna / rw.annual_emissions_luna < 1.01, { sumLuna, total: rw.annual_emissions_luna });
  const off = pools.filter(q => q.gauge_whitelisted === false);
  check(`R4 all ${off.length} pools off a list: zero emissions, no APR, source "dewhitelisted"; none of them is in the chain's distribution`,
    off.length > 0 && off.every(q => q.rewards && q.rewards.source === 'dewhitelisted' && q.rewards.annual_emissions_usd === 0 && q.rewards.approx_apr_pct === null) && rw.pools_dewhitelisted === off.length);
  const est = pools.filter(q => q.rewards && q.rewards.source === 'gauge_infos_next_fallback');
  check(`R5 the next-epoch estimate is left only for listed pools not in this epoch's distribution (${est.length}), ${(est.reduce((s, q) => s + q.rewards.annual_emissions_luna, 0) / rw.annual_emissions_luna * 100).toFixed(2)} % of the emission`, est.every(q => q.gauge_whitelisted !== false));
  check(`T1 counts: ${totals.active_pools_count} active (= the pools with ≥ 1 % that are on a list), ${totals.dewhitelisted_pools_count} off a list, ${totals.voted_pools_count} with votes that earn nothing`,
    totals.active_pools_count === pools.filter(q => q.status === 'active').length && totals.dewhitelisted_pools_count === off.length && pools.filter(q => q.status === 'active').every(q => q.gauge_whitelisted !== false));
  const erisTotal = eris.pools.reduce((s, p) => s + (p.tla_staked_usd || 0), 0);
  check(`T2 TLA staked in the pools the chain is paying: ${usd(rw.tla_tvl_in_distribution_usd)} vs the Eris-method feed ${usd(erisTotal)} (the published file's total, every pool: ${usd(snap.totals.tla_tvl_usd)})`,
    Math.abs(rw.tla_tvl_in_distribution_usd / erisTotal - 1) < 0.03, { ours: rw.tla_tvl_in_distribution_usd, erisTotal });
  const bOk = S.BUCKETS.every(b => Math.abs(byBucket[b].reward_list_vp_total_human + byBucket[b].off_list_vp_total_human - byBucket[b].bucket_vp_total_human) < 1e-3);
  check(`T3 per gauge, votes on listed assets + votes left on assets off the list = every vote (stable: ${(byBucket.stable.off_list_vp_total_human / 1e6).toFixed(2)}M of ${(byBucket.stable.bucket_vp_total_human / 1e6).toFixed(2)}M sit off the list)`, bOk);
  const aprInj = pools.find(q => q.name === 'LUNA-USDC.inj'); const eInj = aprInj && erisBy.get(aprInj.gauge_pool_id);
  if (aprInj && eInj) check(`T4 LUNA-USDC.inj reward APR ${aprInj.rewards.approx_apr_pct == null ? 'null' : aprInj.rewards.approx_apr_pct.toFixed(1) + ' %'} vs the Eris-method feed ${eInj.incentive_apr_pct.toFixed(1)} % (within 2 points)`,
    aprInj.rewards.approx_apr_pct != null && Math.abs(aprInj.rewards.approx_apr_pct - eInj.incentive_apr_pct) < 2);
  // ── E (1.3.0): the year's emission from the chain's own figures (the Eris-method feed's hourly read), the constant as fallback ──
  { const feedAt = Date.parse(eris.meta.generated_at); const em = S.liveEmissionFrom(eris, feedAt + 36e5);
    const want = eris.meta.annual_provisions_luna * ['stable', 'project', 'bluechip', 'single'].reduce((t, b) => t + eris.alliance.per_gauge[b].reward_weight, 0) / eris.meta.total_reward_weight;
    check(`E1 live emission ${em.ok ? Math.round(em.annual_luna).toLocaleString('en-US') : '—'} LUNA a year = annual provisions × Σ gauge weights ÷ total weight (${(eris.meta.annual_provisions_luna / 1e6).toFixed(2)}M × ${em.ok ? em.weight_sum : '?'} ÷ ${eris.meta.total_reward_weight}); the May constant is ${em.ok ? ((S.TLA_LUNA_EMISSIONS_PER_YEAR / em.annual_luna - 1) * 100).toFixed(2) : '?'} % above it`,
      em.ok && Math.abs(em.annual_luna - want) < 1e-6 && em.age_h === 1 && Math.abs(S.TLA_LUNA_EMISSIONS_PER_YEAR / em.annual_luna - 1) < 0.1, em);
    const p2 = JSON.parse(JSON.stringify(pools)); const r2 = S.computeRollups(p2, bucketVps); const rw2 = S.computeRewards(p2, r2.byBucket, r2.totals, luna, dist, em);
    const sum2 = p2.reduce((t, q) => t + ((q.rewards && q.rewards.annual_emissions_luna) || 0), 0);
    check(`E2 with it the model pays out the chain's figure: totals ${Math.round(rw2.annual_emissions_luna).toLocaleString('en-US')} LUNA, per-pool sum ${(sum2 / rw2.annual_emissions_luna * 100).toFixed(2)} %, source "${rw2.emission_source.kind}", every pool scaled by the same ${(rw2.annual_emissions_luna / rw.annual_emissions_luna).toFixed(4)}`,
      Math.abs(rw2.annual_emissions_luna - em.annual_luna) < 1e-6 && rw2.emission_source.kind === 'chain' && sum2 / rw2.annual_emissions_luna > 0.999 && sum2 / rw2.annual_emissions_luna < 1.01 &&
      p2.every((q, i) => { const a = q.rewards && q.rewards.annual_emissions_luna, b = pools[i].rewards && pools[i].rewards.annual_emissions_luna; return (!a && !b) || Math.abs(a / b - em.annual_luna / S.TLA_LUNA_EMISSIONS_PER_YEAR) < 1e-9; }));
    // with one emission on both sides, what is left between a pool's reward APR here and the feed's incentive APR is exactly the two
    // inputs each captures for itself: the LUNA price and the staked value. (With the constant there was ~1 % more on top.)
    const a2 = p2.find(q => q.name === 'LUNA-USDC.inj');
    if (a2 && eInj) { const expect = (luna / eris.meta.luna_price_used_usd) * (eInj.tla_staked_usd / a2.staked_in_tla_usd); const got = a2.rewards.approx_apr_pct / eInj.incentive_apr_pct; const was = aprInj.rewards.approx_apr_pct / eInj.incentive_apr_pct;
      check(`E3 LUNA-USDC.inj reward APR ${a2.rewards.approx_apr_pct.toFixed(2)} % vs the feed's ${eInj.incentive_apr_pct.toFixed(2)} %: the whole gap (${((got - 1) * 100).toFixed(2)} %) is LUNA price × staked value as each file captured them (${((expect - 1) * 100).toFixed(2)} %); with the constant ${((was / expect - 1) * 100).toFixed(2)} % was left unexplained`,
        Math.abs(got / expect - 1) < 0.003 && Math.abs(was / expect - 1) > Math.abs(got / expect - 1), { got, expect, was }); }
    const stale = S.liveEmissionFrom(eris, feedAt + 7 * 36e5); const noG = JSON.parse(JSON.stringify(eris)); delete noG.alliance.per_gauge.single; const wild = JSON.parse(JSON.stringify(eris)); wild.meta.annual_provisions_luna *= 3;
    const off = JSON.parse(JSON.stringify(eris)); off.alliance.per_gauge.project.active = false;
    const fb = [stale, S.liveEmissionFrom(noG, feedAt), S.liveEmissionFrom(wild, feedAt), S.liveEmissionFrom(off, feedAt), S.liveEmissionFrom(null, feedAt), S.liveEmissionFrom({ meta: {} }, feedAt)];
    const p3 = JSON.parse(JSON.stringify(pools)); const r3 = S.computeRollups(p3, bucketVps); const rw3 = S.computeRewards(p3, r3.byBucket, r3.totals, luna, dist, stale);
    check(`E4 a feed that is 7 h old, lacks a gauge, has a gauge switched off, reads 3× the calibration, or is missing is not believed (${fb.map(x => x.why).join(' · ')}) — the constant stands in, labelled`,
      fb.every(x => x.ok === false && x.why) && rw3.annual_emissions_luna === S.TLA_LUNA_EMISSIONS_PER_YEAR && rw3.emission_source.kind === 'calibrated_constant' && /7\.0 h old/.test(rw3.emission_source.why), fb);
    check('E5 called the old way (no sixth argument) nothing changes', rw.annual_emissions_luna === S.TLA_LUNA_EMISSIONS_PER_YEAR && rw.emission_source.kind === 'calibrated_constant'); }
  // ── S (1.3.0): all the voting power that exists — the lock contract's total_vamp, in the shape the chain returned on 2026-11-24 ──
  { const tv = S.parseTotalVamp({ fixed: '3936602484268', voting_power: '32748520740303', vp: '36685123224571' });
    check(`S1 total_vamp → ${tv && tv.vp_human.toLocaleString('en-US')} VP = fixed ${tv && tv.fixed_human.toLocaleString('en-US')} + boost ${tv && tv.boost_human.toLocaleString('en-US')} (Eris printed 36.68M that minute)`,
      !!tv && Math.abs(tv.vp_human - 36685123.224571) < 1e-6 && Math.abs(tv.fixed_human + tv.boost_human - tv.vp_human) < 1e-6);
    const noVp = S.parseTotalVamp({ fixed: '10', voting_power: '90' });
    check('S2 a failed or unrecognised read is null (the page keeps its older estimate); a reply without "vp" adds the two parts', S.parseTotalVamp(null) === null && S.parseTotalVamp({ error: 'x' }) === null && S.parseTotalVamp({ vp: '0' }) === null && !!noVp && Math.abs(noVp.vp_human - 0.0001) < 1e-12); }
  console.log(`\n${pass}/${pass + fail} passed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('gate crashed:', e.stack || e.message); process.exit(1); });
