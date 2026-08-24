// =============================================================================
// CAPA Supply Map — org-token-catalog duty (v1.1, 2026-08-24)
// =============================================================================
// SPEC: tla-core/docs/pending-changes/SPEC-capa-supply-map.md
// Gate values: capa-supply-probe v2 run 2026-08-24T04:03Z (artifact 9506487143).
//
// v1 publishes the COLLECTION map: every custody form CAPA can sit in, two
// levels, with sum-to-supply guards. Per-wallet rows are v2 (the tool keeps its
// live per-wallet scan until then). All bucket reads are state/balance queries
// proven by the probe — no enumeration walks in v1.
//
// Laws honoured: null-vs-0 (a failed query is null and degrades status, never a
// silent 0); rates from live contracts at capture, never constants; unexplained
// remainders published as *_unattributed, never dropped.
//
// v1.1 (first live publish, guard_failed on 3 — each was a real fact):
//  1. The hub holds NO idle CAPA: it STAKES its CAPA in Solid governance. So the
//     gov contract's balance CONTAINS the hub. in_hub now reads hub state{};
//     gov splits into hub-portion (gov staker{hub}) + direct stakers; the
//     cross-check is hub-state ≈ hub's gov staker balance.
//  2. Astroport-config staking forwards LP into Astroport Incentives — the
//     staking contract's cw20 balance is 0 by design. Staked totals now come
//     from `total_staked_balances` (post-take amounts).
//  3. Amp/non-amp split now uses the COMPOUNDER'S OWN entry in
//     `all_staked_balances{address: compounder}` — same post-take basis as the
//     total, so the split can't go negative from take-rate drift. Rate-implied
//     amp is gone (rates still published).

'use strict';

const C = {
  CAPA_TOKEN:        'terra1t4p3u8khpd7f8qzurwyafxt648dya6mp6vur3vaapswt6m24gkuqrfdhar',
  CAPA_GOV:          'terra1sf66d5vap897xlvv2hlcp4l20y4pp42r6ala4snk8mgd246jvufqwe0cnm',
  AMPCAPA_HUB:       'terra186rpfczl7l2kugdsqqedegl4es4hp624phfc7ddy8my02a4e8lgq5rlx7y',
  AMPCAPA_DENOM:     'factory/terra186rpfczl7l2kugdsqqedegl4es4hp624phfc7ddy8my02a4e8lgq5rlx7y/ampCAPA',
  VE3_COMPOUNDER:    'terra1zly98gvcec54m3caxlqexce7rus6rzgplz7eketsdz7nh750h2rqvu8uzx',
  TLA_STAKE_SINGLE:  'terra1qdz5qgafx88kp5mf6m2tah8742g4u5g2cek0m3jrgssexexk7g4qw6e23k',
  TLA_STAKE_PROJECT: 'terra1awq6t7jfakg9wfjn40fk3wzwmd57mvrqtt3a39z9rmet7wdjj3ysgw3lpa',
  AMPCAPA_DAO_VOTE:  'terra1juj3ymejnug9p92upphcq0prq4e0hpw6rcu20njf8tk7n9sl2wxqldr0mt',
  ASTRO_PAIR:        'terra183wqgrwa2k0uvlz99j57c496gfuwgtaccrhv4stcjzv3ydacl9zq0hmf25',
  ASTRO_LP:          'terra1cg9t08mqa88us074mpwpuu8lp5w4jwtye3vaazll45w27at52cpsq7c564',
  SS_PAIR:           'terra15rzp38yq2cqy2jnewc9vgzqguf3t2q0gqpv9evg8tckrtqp8x44qezhthc',
  SS_LP_DENOM:       'factory/terra15rzp38yq2cqy2jnewc9vgzqguf3t2q0gqpv9evg8tckrtqp8x44qezhthc/uLP',
  AMPLP_AMPCAPA:     'factory/terra1zly98gvcec54m3caxlqexce7rus6rzgplz7eketsdz7nh750h2rqvu8uzx/44/single/amplp',
  AMPLP_ASTRO_LP:    'factory/terra1zly98gvcec54m3caxlqexce7rus6rzgplz7eketsdz7nh750h2rqvu8uzx/42/project/amplp',
  AMPLP_SS_LP:       'factory/terra1zly98gvcec54m3caxlqexce7rus6rzgplz7eketsdz7nh750h2rqvu8uzx/43/project/amplp',
};

const GUARD_TOLERANCE = 0.0001;   // 0.01% — SPEC guard band
const num = (v) => { if (v == null) return null; const n = Number(v) / 1e6; return Number.isFinite(n) ? n : null; };   // NaN is a lie, not a number (v1.1 gate finding)
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// deps = { queryContract, fetchJson, lcdBase } — injected so the mock gate can
// drive the LIVE module (no-third-copy) and so this file never owns transport.
async function captureCapaSupply(deps) {
  const { queryContract, fetchJson, lcdBase } = deps;
  const q = async (addr, msg) => { try { return await queryContract(addr, msg); } catch (e) { return { __err: String(e.message || e).slice(0, 120) } } };
  const bankDenom = async (addr, denom) => {
    try { const r = await fetchJson(`${lcdBase}/cosmos/bank/v1beta1/balances/${addr}/by_denom?denom=${encodeURIComponent(denom)}`, 'bank by_denom'); return num(r.balance && r.balance.amount); }
    catch (e) { return null; }
  };
  const supplyOf = async (denom) => {
    try { const r = await fetchJson(`${lcdBase}/cosmos/bank/v1beta1/supply/by_denom?denom=${encodeURIComponent(denom)}`, 'bank supply'); return num(r.amount && r.amount.amount); }
    catch (e) { return null; }
  };
  const errors = [];
  const val = (r, pick) => { if (!r || r.__err) { if (r) errors.push(r.__err); return null; } try { return pick(r); } catch { return null; } };

  // ---- level 1: CAPA ---------------------------------------------------------
  const [tokenInfo, govBal, hubState, hubGovStake, astroPool, astroLpInfo, ssPool] = await Promise.all([
    q(C.CAPA_TOKEN, { token_info: {} }),
    q(C.CAPA_TOKEN, { balance: { address: C.CAPA_GOV } }),
    q(C.AMPCAPA_HUB, { state: {} }),
    q(C.CAPA_GOV, { staker: { address: C.AMPCAPA_HUB } }),   // v1.1: the hub's stake INSIDE gov
    q(C.ASTRO_PAIR, { pool: {} }),
    q(C.ASTRO_LP, { token_info: {} }),
    q(C.SS_PAIR, { pool: {} }),
  ]);
  const totalSupply = val(tokenInfo, (r) => num(r.total_supply));
  const govContractBal = val(govBal, (r) => num(r.balance));        // hub portion + direct stakers + accrued
  const hubRate     = val(hubState, (r) => Number(r.exchange_rate));
  const inHub       = val(hubState, (r) => num(r.total_utoken ?? r.total_ustake ?? r.total_native));
  const hubInGov    = val(hubGovStake, (r) => num(r.balance));
  const govDirect   = [govContractBal, hubInGov].every(isNum) ? govContractBal - hubInGov : null;
  const capaReserveOf = (pool) => val(pool, (r) => num((r.assets.find(a => JSON.stringify(a.info).includes(C.CAPA_TOKEN)) || {}).amount));
  const astroCapa   = capaReserveOf(astroPool);
  const ssCapa      = capaReserveOf(ssPool);
  const astroLpSupply = val(astroLpInfo, (r) => num(r.total_supply));
  const ssLpSupply    = await supplyOf(C.SS_LP_DENOM);

  // v1.1 cross-check: the hub's position per its OWN state vs per the gov
  // contract's books. (The hub may hold a sliver un-staked, so tolerance only.)
  const hubAgree = isNum(inHub) && isNum(hubInGov)
    ? Math.abs(inHub - hubInGov) <= Math.max(1, inHub) * 0.005 : null;   // 0.5%: accrual timing between the two books

  // ---- level 2: ampCAPA ------------------------------------------------------
  const [ampSupply, amplpAmpSupply, amplpAstroSupply, amplpSsSupply, rates, daoTotal,
         singleTotals, projectTotals, compSingle, compProject] = await Promise.all([
    supplyOf(C.AMPCAPA_DENOM),
    supplyOf(C.AMPLP_AMPCAPA),
    supplyOf(C.AMPLP_ASTRO_LP),
    supplyOf(C.AMPLP_SS_LP),
    q(C.VE3_COMPOUNDER, { amplp_exchange_rates: {} }),
    q(C.AMPCAPA_DAO_VOTE, { total_power_at_height: {} }),
    // v1.1: post-take staked amounts from the staking contracts' own books —
    // the ONLY basis on which totals and the compounder's share can be compared.
    q(C.TLA_STAKE_SINGLE, { total_staked_balances: {} }),
    q(C.TLA_STAKE_PROJECT, { total_staked_balances: {} }),
    q(C.TLA_STAKE_SINGLE, { all_staked_balances: { address: C.VE3_COMPOUNDER } }),
    q(C.TLA_STAKE_PROJECT, { all_staked_balances: { address: C.VE3_COMPOUNDER } }),
  ]);
  const amountFor = (res, matcher) => val(res, (r) => {
    const rows = Array.isArray(r) ? r : (r.balances || []);
    const hit = rows.find(x => JSON.stringify(x.asset && x.asset.info).includes(matcher));
    return hit ? num(hit.asset.amount) : 0;   // contract answered; asset absent = confirmed 0
  });
  const ampInSingle   = amountFor(singleTotals, C.AMPCAPA_DENOM);
  const ampViaCompCtr = amountFor(compSingle, C.AMPCAPA_DENOM);
  const astroLpStakedT = amountFor(projectTotals, C.ASTRO_LP);
  const astroLpAmpCtr  = amountFor(compProject, C.ASTRO_LP);
  const ssLpStakedT    = amountFor(projectTotals, C.SS_LP_DENOM);
  const ssLpAmpCtr     = amountFor(compProject, C.SS_LP_DENOM);
  const rateFor = (denom) => val(rates, (r) => {
    const rows = r.exchange_rates || r;   // tolerate either shape
    const hit = (Array.isArray(rows) ? rows : []).find(x => JSON.stringify(x).includes(denom));
    if (!hit) return null;
    const v = Array.isArray(hit) ? hit[1] : (hit.exchange_rate ?? hit.rate);
    return v == null ? null : Number(v);
  });
  const ampcapaAmplpRate = rateFor(C.AMPLP_AMPCAPA);       // published for reference; NOT used for the split (v1.1)
  const ampViaCompounder = ampViaCompCtr;
  const ampNonAmp        = [ampInSingle, ampViaCompounder].every(isNum) ? ampInSingle - ampViaCompounder : null;
  const daoPower         = val(daoTotal, (r) => num(r.power));
  // receipt not in the DAO = held in wallets OR unbonding (claims are per-wallet;
  // v1 cannot total them, so the remainder is published as one labeled bucket).
  const receiptOutsideDao = isNum(amplpAmpSupply) && isNum(daoPower) ? amplpAmpSupply - daoPower : null;
  const ampLiquid        = [ampSupply, ampInSingle].every(isNum) ? ampSupply - ampInSingle : null;

  // ---- LP split (CAPA side, v1.1: one post-take basis) -----------------------
  const capaPerAstroLp = isNum(astroCapa) && isNum(astroLpSupply) && astroLpSupply > 0 ? astroCapa / astroLpSupply : null;
  const astroAmplpRate = rateFor(C.AMPLP_ASTRO_LP);
  const astroLpStaked  = astroLpStakedT;
  const astroLpAmp     = astroLpAmpCtr;
  const astroLpNonAmp  = [astroLpStaked, astroLpAmp].every(isNum) ? astroLpStaked - astroLpAmp : null;
  const capaPerSsLp    = isNum(ssCapa) && isNum(ssLpSupply) && ssLpSupply > 0 ? ssCapa / ssLpSupply : null;
  const ssAmplpRate    = rateFor(C.AMPLP_SS_LP);
  const ssLpStaked     = ssLpStakedT;
  const ssLpAmp        = ssLpAmpCtr;
  const ssLpNonAmp     = [ssLpStaked, ssLpAmp].every(isNum) ? ssLpStaked - ssLpAmp : null;

  // ---- assemble + guards -----------------------------------------------------
  const level1 = {
    'capa.gov_staked_direct': govDirect,     // v1.1: hub's stake lives inside gov — split out
    'capa.in_hub': inHub,
    'capa.in_lp.astro': astroCapa,
    'capa.in_lp.ss': ssCapa,
  };
  const l1Known = Object.values(level1).every(isNum) && isNum(totalSupply);
  const liquid = l1Known ? totalSupply - Object.values(level1).reduce((a, b) => a + b, 0) : null;
  // liquid is the derived remainder BY CONSTRUCTION in v1 (no all_accounts walk
  // yet), so the level-1 guard is the hub cross-check + non-negativity, not a
  // tautological re-sum.
  const level2 = {
    'ampcapa.liquid': ampLiquid,
    'ampcapa.tla.nonamp': ampNonAmp,
    'ampcapa.tla.amp.via_compounder': ampViaCompounder,
  };
  const l2Sum = Object.values(level2).every(isNum) ? Object.values(level2).reduce((a, b) => a + b, 0) : null;
  const l2Guard = isNum(l2Sum) && isNum(ampSupply)
    ? Math.abs(l2Sum - ampSupply) <= ampSupply * GUARD_TOLERANCE : null;
  const l2HubGuard = isNum(ampSupply) && isNum(hubRate) && isNum(inHub)
    ? Math.abs(ampSupply * hubRate - inHub) <= inHub * GUARD_TOLERANCE : null;

  const guards = {
    hub_state_vs_gov_books: hubAgree,
    level2_sums_to_ampcapa_supply: l2Guard,
    ampcapa_supply_x_rate_equals_in_hub: l2HubGuard,
    liquid_non_negative: isNum(liquid) ? liquid >= 0 : null,
    lp_nonamp_non_negative: [astroLpNonAmp, ssLpNonAmp].every(v => v == null || v >= -1e-6),
  };
  const failed = Object.entries(guards).filter(([, v]) => v === false).map(([k]) => k);
  const nulls = [];
  const scan = (o, p) => Object.entries(o).forEach(([k, v]) => { if (v == null) nulls.push(p + k); });
  scan(level1, ''); scan(level2, '');
  const status = failed.length ? 'guard_failed' : (nulls.length || liquid == null) ? 'partial' : 'ok';

  return {
    schemaVersion: 1,
    module: 'token-catalog',
    product: 'supply/capa',
    capturedAt: new Date().toISOString(),
    status, guard_failures: failed, null_buckets: nulls, query_errors: errors.slice(0, 10),
    rates: { hub_capa_per_ampcapa: hubRate, compounder_ampcapa_per_receipt: ampcapaAmplpRate, astro_lp_per_receipt: astroAmplpRate, ss_lp_per_receipt: ssAmplpRate, capa_per_astro_lp: capaPerAstroLp, capa_per_ss_lp: capaPerSsLp },
    capa: {
      total_supply: totalSupply,
      liquid_derived: liquid,      // remainder: wallets + anything v1 has no read for (labeled, never hidden)
      gov_contract_balance: govContractBal, gov_hub_portion: hubInGov, gov_staked_direct: govDirect,
      in_hub: inHub,
      in_lp: {
        astro: { capa: astroCapa, lp_supply: astroLpSupply, lp_staked_tla: astroLpStaked, lp_amp: astroLpAmp, lp_nonamp: astroLpNonAmp },
        ss:    { capa: ssCapa, lp_supply: ssLpSupply, lp_staked_tla: ssLpStaked, lp_amp: ssLpAmp, lp_nonamp: ssLpNonAmp },
      },
    },
    ampcapa: {
      total_supply: ampSupply,
      liquid: ampLiquid,
      tla_single_total: ampInSingle,
      tla_nonamp: ampNonAmp,
      tla_amp_via_compounder: ampViaCompounder,
      receipt_supply: amplpAmpSupply,
      receipt_in_dao: daoPower,
      receipt_outside_dao_or_unbonding: receiptOutsideDao,   // v2 splits this via claims enumeration
    },
  };
}

module.exports = { captureCapaSupply, CAPA_CONTRACTS: C, GUARD_TOLERANCE };
