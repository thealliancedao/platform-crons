// =============================================================================
// CAPA Supply Map — org-token-catalog duty (v2.1, 2026-08-24)
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
//
// v2.0 — PER-WALLET ROWS + WHALE SCAN v2 (SPEC "Per-wallet rows"):
//  Every holder in every form is ENUMERATED from the contract that owns the
//  form, and every enumeration is SUM-GUARDED against that contract's own total
//  (cw20 Σ == total_supply · Σ gov shares == state.total_share · Σ ve3 shares ==
//  pool shares · Σ denom_owners == supply_by_denom · DAO module holding ==
//  total_power + Σ claims). Rows go to `supply/capa/wallets.json` above a
//  CAPA-equivalent floor; the tail is summed per column so rows + tail +
//  contract rows always reconcile to the bucket. 32-byte addresses are
//  `kind:"contract"` — chain-structural, never identity-guessed (pattern ≠
//  identity: only the structural set carries a label). `role:"bucket"` marks
//  the structural set ONLY: their holdings ARE the other rows (the gov
//  contract's CAPA is the stakers' CAPA), so pages hide them by default to
//  avoid double counting. Every other contract — DAODAO cores (the aDAO
//  treasury is one), multisigs, vesting — is a genuine custody endpoint and is
//  treated as a HOLDER: floor/tail rules, shown by default. The v1.1 collection map
//  is unchanged; v2 ADDS `wallets` (summary) to current.json and the row file.
//  Claims (DAO unbonding) are read for the ampCAPA-orbit wallets only; the guard
//  publishes any uncovered remainder as `receipt_unbonding_unattributed`.
//
// v2.1 — COMPACT PER-WALLET DAILY (`supply/capa/wallets-daily/<date>.json`):
//  the change-period series the ampCAPA tool's members tab needs (24h/7d/30d
//  deltas), replacing the dead defipatriot/ampcapa-data_2026 snapshots. One
//  row per HOLDER that is a DAO staker or ≥ floor: `[total_capa_equiv,
//  receipt_dao_capa]` (~20 bytes/row) — the legacy feed's `members[].capa` IS
//  the second number (receipt × ve3 rate × hub rate), so legacy weeklies fold
//  in as `[null, receipt_dao]` (total unknown then — never invented).
//  `foldIndexRows` adds legacy dates to index.json ONLY where no captured row
//  exists (prior-verbatim: captured rows win; legacy fills the past).

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


// =============================================================================
// v2.0 — per-wallet rows
// =============================================================================
const WALLET_FLOOR_CAPA = 10000;          // rows below this CAPA-equivalent total fold into tail_below_floor
const MAX_STATE_PAGES   = 800;            // 80k models — beyond this the walk is INCOMPLETE (published as such, never trimmed silently)
const MAX_OWNER_PAGES   = 200;            // 100k owners at limit 500
const CLAIMS_CONCURRENCY = 5;             // shared LCD doctrine (BATCH_CONCURRENCY ≤ 5)

// Structural addresses (label = role, from the SPEC/probe). Anything else that
// is 32-byte is `contract` with label null — chain-structural fact, no identity.
const STRUCTURAL = {
  [C.CAPA_TOKEN]:        'CAPA token',
  [C.CAPA_GOV]:          'Solid governance',
  [C.AMPCAPA_HUB]:       'ampCAPA hub',
  [C.VE3_COMPOUNDER]:    've3 compounder',
  [C.TLA_STAKE_SINGLE]:  'TLA single bucket',
  [C.TLA_STAKE_PROJECT]: 'TLA project bucket',
  [C.AMPCAPA_DAO_VOTE]:  'ampCAPA DAO voting module',
  [C.ASTRO_PAIR]:        'Astroport CAPA-LUNA pair',
  [C.ASTRO_LP]:          'Astroport CAPA-LUNA LP',
  [C.SS_PAIR]:           'SkeletonSwap CAPA-LUNA pool',
  'terra1eywh4av8sln6r45pxq45ltj798htfy0cfcf7fy3pxc2gcv6uc07se4ch9x': 'Astroport Incentives',
};
const ASTRO_INCENTIVES = 'terra1eywh4av8sln6r45pxq45ltj798htfy0cfcf7fy3pxc2gcv6uc07se4ch9x';
const isContractAddr = (a) => typeof a === 'string' && a.startsWith('terra1') && a.length === 64;   // 32-byte = contract; 44 chars = 20-byte account
const kindOf = (a) => isContractAddr(a) ? 'contract' : 'wallet';

// ---- bech32 (encode only; needed for the gov "bank" keys, which store the 20-byte canonical address) ----
const B32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
function bech32Polymod(v) { const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]; let c = 1; for (const d of v) { const b = c >>> 25; c = ((c & 0x1ffffff) << 5) ^ d; for (let i = 0; i < 5; i++) if ((b >> i) & 1) c ^= G[i]; } return c >>> 0; }
function bech32Encode(hrp, bytes) {
  let acc = 0, bits = 0; const d5 = [];
  for (const b of bytes) { acc = ((acc << 8) | b) >>> 0; bits += 8; while (bits >= 5) { bits -= 5; d5.push((acc >>> bits) & 31); } }
  if (bits) d5.push((acc << (5 - bits)) & 31);
  const hrpExp = [...hrp].map(c => c.charCodeAt(0) >> 5).concat(0, ...[...hrp].map(c => c.charCodeAt(0) & 31));
  const pm = bech32Polymod([...hrpExp, ...d5, 0, 0, 0, 0, 0, 0]) ^ 1;
  const cs = Array.from({ length: 6 }, (_, i) => (pm >> (5 * (5 - i))) & 31);
  return hrp + '1' + [...d5, ...cs].map(d => B32[d]).join('');
}
const hexBytes = (hex) => Buffer.from(hex, 'hex');

// ---- state-key decoders (formats proven live by the ampCAPA tool's scans) ----
// cw20-base `balance` map: key = 0007 "balance" + Addr string bytes; value = JSON Uint128.
const CW20_BAL_PREFIX = '000762616c616e6365';
function decodeCw20BalanceKey(hexKey) {
  const lk = String(hexKey).toLowerCase();
  if (!lk.startsWith(CW20_BAL_PREFIX)) return null;
  const rest = hexBytes(lk.slice(CW20_BAL_PREFIX.length));
  const s = rest.toString('utf8');
  if (s.startsWith('terra1') && (s.length === 44 || s.length === 64)) return s;
  if (rest.length === 20) return bech32Encode('terra', rest);
  return null;
}
// Anchor-fork governance `bank` map: key = [2-byte len=4]"bank" + canonical addr (20-byte account | 32-byte contract); value = {share, balance?, locked_balance}.
function decodeGovBankKey(hexKey) {
  const raw = hexBytes(String(hexKey).toLowerCase());
  if (raw.length < 3) return null;
  const nsLen = (raw[0] << 8) | raw[1];
  if (raw.slice(2, 2 + nsLen).toString('utf8') !== 'bank') return null;
  const addr = raw.slice(2 + nsLen);
  return (addr.length === 20 || addr.length === 32) ? bech32Encode('terra', addr) : null;   // 20 = account, 32 = contract (the hub stakes here)
}
// ve3 asset-staking `shares` map: key = 0006 "shares" + [len]user + [len]("cw20:"|"native:") + asset id (last segment, unprefixed); value = JSON Uint128.
const VE3_SHARES_PREFIX = '0006736861726573';
function decodeVe3SharesKey(hexKey) {
  const lk = String(hexKey).toLowerCase();
  if (!lk.startsWith(VE3_SHARES_PREFIX)) return null;
  const raw = hexBytes(lk.slice(VE3_SHARES_PREFIX.length));
  let o = 0;
  const seg = () => { if (o + 2 > raw.length) return null; const n = (raw[o] << 8) | raw[o + 1]; o += 2; if (o + n > raw.length) return null; const s = raw.slice(o, o + n).toString('utf8'); o += n; return s; };
  const user = seg(); if (!user || !user.startsWith('terra1')) return null;
  const kind = seg(); if (!kind) return null;
  const id = raw.slice(o).toString('utf8');
  return { user, asset: kind + id };                // "cw20:terra1…" | "native:factory/…"
}
const jsonU128 = (b64) => { try { const v = JSON.parse(Buffer.from(b64, 'base64').toString('utf8')); return typeof v === 'string' || typeof v === 'number' ? Number(v) : null; } catch { return null; } };
const jsonObj  = (b64) => { try { return JSON.parse(Buffer.from(b64, 'base64').toString('utf8')); } catch { return null; } };

// ---- enumerators (all via injected fetchJson so the gate can drive the live module) ----
function makeEnumerators({ fetchJson, queryContract, lcdBase }) {
  const get = async (path, label) => { try { return await fetchJson(`${lcdBase}${path}`, label); } catch (e) { return { __err: String(e.message || e).slice(0, 120) }; } };
  async function walkState(addr) {
    const models = []; let key = null, pages = 0, err = null;
    while (pages < MAX_STATE_PAGES) {
      pages++;
      const r = await get(`/cosmwasm/wasm/v1/contract/${addr}/state?pagination.limit=100${key ? '&pagination.key=' + encodeURIComponent(key) : ''}`, `state ${addr.slice(0, 12)} p${pages}`);
      if (!r || r.__err) { err = r ? r.__err : 'no response'; break; }
      for (const m of (r.models || [])) models.push(m);
      key = r.pagination && r.pagination.next_key;
      if (!key || !(r.models || []).length) return { models, complete: true, pages, error: null };
    }
    return { models, complete: false, pages, error: err || `page cap ${MAX_STATE_PAGES}` };
  }
  async function walkDenomOwners(denom) {
    const owners = []; let key = null, pages = 0, err = null;
    while (pages < MAX_OWNER_PAGES) {
      pages++;
      const pag = `&pagination.limit=500${key ? '&pagination.key=' + encodeURIComponent(key) : ''}`;
      const r = await get(`/cosmos/bank/v1beta1/denom_owners_by_query?denom=${encodeURIComponent(denom)}${pag}`, `owners ${denom.slice(-14)} p${pages}`);
      if (!r || r.__err) { err = r ? r.__err : 'no response'; break; }
      for (const o of (r.denom_owners || [])) owners.push({ address: o.address, amount: num(o.balance && o.balance.amount) });
      key = r.pagination && r.pagination.next_key;
      if (!key) return { owners, complete: true, pages, error: null };
    }
    return { owners, complete: false, pages, error: err || `page cap ${MAX_OWNER_PAGES}` };
  }
  async function walkListStakers(addr) {
    const stakers = []; let start = null, pages = 0; const LIMIT = 30;
    while (pages < 500) {
      pages++;
      let r; try { r = await queryContract(addr, start ? { list_stakers: { limit: LIMIT, start_after: start } } : { list_stakers: { limit: LIMIT } }); } catch (e) { r = null; }
      if (!r) return { stakers, complete: false, pages, error: 'list_stakers query failed' };
      const rows = r.stakers || [];
      for (const s of rows) stakers.push({ address: s.address, amount: num(s.balance) });
      if (rows.length < LIMIT) return { stakers, complete: true, pages, error: null };
      start = rows[rows.length - 1].address;
    }
    return { stakers, complete: false, pages, error: 'page cap' };
  }
  async function claimsOf(addr) {
    let r; try { r = await queryContract(C.AMPCAPA_DAO_VOTE, { claims: { address: addr } }); } catch (e) { r = null; }
    if (!r) return null;                                            // failed ≠ 0
    const rows = Array.isArray(r.claims) ? r.claims : [];
    let sum = 0; for (const c of rows) { const a = num(c.amount); if (a == null) return null; sum += a; }
    return { amount: sum, count: rows.length, release_at: rows.map(c => c.release_at) };
  }
  async function pmap(items, fn, n = CLAIMS_CONCURRENCY) {
    const out = new Array(items.length); let i = 0;
    await Promise.all(Array(Math.min(n, items.length || 1)).fill(0).map(async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
    return out;
  }
  return { walkState, walkDenomOwners, walkListStakers, claimsOf, pmap };
}

// ---- the per-wallet capture ----
// doc = the v1.1 collection map (already captured); returns { doc (v2, with `wallets` summary), wallets (row file) }.
async function captureCapaWallets(deps, doc) {
  const E = makeEnumerators(deps);
  const R = doc.rates || {};
  const hubRate = R.hub_capa_per_ampcapa, compRate = R.compounder_ampcapa_per_receipt,
        astroLpPerRcpt = R.astro_lp_per_receipt, ssLpPerRcpt = R.ss_lp_per_receipt,
        capaPerAstroLp = R.capa_per_astro_lp, capaPerSsLp = R.capa_per_ss_lp;
  const errors = [];
  const q = async (addr, msg) => { try { return await deps.queryContract(addr, msg); } catch (e) { errors.push(String(e.message || e).slice(0, 120)); return null; } };

  // Extra totals v2 needs (v1.1 didn't): gov state (total_share) + hub staker share (rate) + pool shares.
  const [govState, hubStaker, singleTotals, projectTotals] = await Promise.all([
    q(C.CAPA_GOV, { state: {} }),
    q(C.CAPA_GOV, { staker: { address: C.AMPCAPA_HUB } }),
    q(C.TLA_STAKE_SINGLE, { total_staked_balances: {} }),
    q(C.TLA_STAKE_PROJECT, { total_staked_balances: {} }),
  ]);
  const govTotalShare = govState ? num(govState.total_share) : null;
  const govRate = hubStaker && isNum(num(hubStaker.balance)) && isNum(num(hubStaker.share)) && num(hubStaker.share) > 0 ? num(hubStaker.balance) / num(hubStaker.share) : null;   // CAPA per gov share, from the hub's own books
  const poolOf = (res, matcher) => { const rows = res ? (Array.isArray(res) ? res : (res.balances || [])) : null; if (!rows) return null; const hit = rows.find(x => JSON.stringify(x.asset && x.asset.info).includes(matcher)); return hit ? { amount: num(hit.asset.amount), shares: num(hit.shares) } : { amount: 0, shares: 0 }; };
  const poolAmp    = poolOf(singleTotals, C.AMPCAPA_DENOM);
  const poolAstro  = poolOf(projectTotals, C.ASTRO_LP);
  const poolSs     = poolOf(projectTotals, C.SS_LP_DENOM);
  const perShare = (p) => p && isNum(p.amount) && isNum(p.shares) && p.shares > 0 ? p.amount / p.shares : null;

  // ---- enumerate all forms in parallel (each walk is sequential on its own next_key) ----
  const [capaState, govStateWalk, singleState, projectState, astroLpState,
         ampOwners, rcptAmpOwners, rcptAstroOwners, rcptSsOwners, ssLpOwners, daoStakers] = await Promise.all([
    E.walkState(C.CAPA_TOKEN), E.walkState(C.CAPA_GOV), E.walkState(C.TLA_STAKE_SINGLE), E.walkState(C.TLA_STAKE_PROJECT), E.walkState(C.ASTRO_LP),
    E.walkDenomOwners(C.AMPCAPA_DENOM), E.walkDenomOwners(C.AMPLP_AMPCAPA), E.walkDenomOwners(C.AMPLP_ASTRO_LP), E.walkDenomOwners(C.AMPLP_SS_LP), E.walkDenomOwners(C.SS_LP_DENOM),
    E.walkListStakers(C.AMPCAPA_DAO_VOTE),
  ]);

  // ---- decode into per-address raw holdings ----
  const raw = {};   // addr -> { capa_liquid, gov_share, ampcapa_liquid, single_shares, astro_shares, ss_shares, rcpt_amp, rcpt_astro, rcpt_ss, astro_lp_liquid, ss_lp_liquid, dao_power, claims }
  const at = (a) => (raw[a] || (raw[a] = {}));
  const add = (a, k, v) => { if (v == null) return; at(a)[k] = (at(a)[k] || 0) + v; };
  const walkSums = {};
  if (capaState.complete) { let s = 0; for (const m of capaState.models) { const a = decodeCw20BalanceKey(m.key); if (!a) continue; const v = jsonU128(m.value); if (v == null) continue; add(a, 'capa_liquid', v / 1e6); s += v / 1e6; } walkSums.capa = s; }
  if (govStateWalk.complete) { let s = 0; for (const m of govStateWalk.models) { const a = decodeGovBankKey(m.key); if (!a) continue; const o = jsonObj(m.value); if (!o) continue; const sh = num(o.share ?? o.staked_balance ?? o.balance ?? o.amount); if (sh == null) continue; add(a, 'gov_share', sh); s += sh; } walkSums.gov_shares = s; }
  const ve3Walk = (walk, want, field, sums) => { if (!walk.complete) return; let s = 0; for (const m of walk.models) { const k = decodeVe3SharesKey(m.key); if (!k || k.asset !== want) continue; const v = jsonU128(m.value); if (v == null) continue; add(k.user, field, v / 1e6); s += v / 1e6; } walkSums[sums] = s; };
  ve3Walk(singleState, 'native:' + C.AMPCAPA_DENOM, 'single_shares', 'single_shares');
  ve3Walk(projectState, 'cw20:' + C.ASTRO_LP, 'astro_shares', 'astro_shares');
  ve3Walk(projectState, 'native:' + C.SS_LP_DENOM, 'ss_shares', 'ss_shares');
  if (astroLpState.complete) { let s = 0; for (const m of astroLpState.models) { const a = decodeCw20BalanceKey(m.key); if (!a) continue; const v = jsonU128(m.value); if (v == null) continue; add(a, 'astro_lp_liquid', v / 1e6); s += v / 1e6; } walkSums.astro_lp = s; }
  const ownersInto = (walk, field, sums) => { if (!walk.complete) return; let s = 0; for (const o of walk.owners) { if (o.amount == null) continue; add(o.address, field, o.amount); s += o.amount; } walkSums[sums] = s; };
  ownersInto(ampOwners, 'ampcapa_liquid', 'ampcapa');
  ownersInto(rcptAmpOwners, 'rcpt_amp', 'rcpt_amp');
  ownersInto(rcptAstroOwners, 'rcpt_astro', 'rcpt_astro');
  ownersInto(rcptSsOwners, 'rcpt_ss', 'rcpt_ss');
  ownersInto(ssLpOwners, 'ss_lp_liquid', 'ss_lp');
  if (daoStakers.complete) { let s = 0; for (const st of daoStakers.stakers) { if (st.amount == null) continue; add(st.address, 'dao_power', st.amount); s += st.amount; } walkSums.dao_power = s; }

  // ---- claims (DAO unbonding) for the ampCAPA-orbit wallets ----
  const orbit = Object.entries(raw).filter(([a, r]) => !isContractAddr(a) && (r.dao_power || r.rcpt_amp || r.ampcapa_liquid || r.single_shares || r.gov_share)).map(([a]) => a);
  const claimsRes = daoStakers.complete ? await E.pmap(orbit, E.claimsOf) : [];
  let claimsFailed = 0, claimsSum = 0;
  claimsRes.forEach((c, i) => { if (c == null) { claimsFailed++; at(orbit[i]).claims = null; return; } at(orbit[i]).claims = c.amount; claimsSum += c.amount; if (c.count) at(orbit[i]).claims_release_at = c.release_at; });

  // ---- supply-side totals to guard against ----
  const T = {
    capa_supply: doc.capa.total_supply,
    gov_total_share: govTotalShare,
    single_shares: poolAmp && poolAmp.shares, astro_shares: poolAstro && poolAstro.shares, ss_shares: poolSs && poolSs.shares,
    astro_lp_supply: doc.capa.in_lp.astro.lp_supply,
    ampcapa_supply: doc.ampcapa.total_supply, rcpt_amp_supply: doc.ampcapa.receipt_supply,
    rcpt_astro_supply: null, rcpt_ss_supply: null, ss_lp_supply: doc.capa.in_lp.ss.lp_supply,
    dao_power: doc.ampcapa.receipt_in_dao,
  };
  // receipt supplies for the two LP receipts aren't in the v1 doc — read them here.
  const supplyOf = async (denom) => { const r = await (async () => { try { return await deps.fetchJson(`${deps.lcdBase}/cosmos/bank/v1beta1/supply/by_denom?denom=${encodeURIComponent(denom)}`, 'supply'); } catch { return null; } })(); return r ? num(r.amount && r.amount.amount) : null; };
  [T.rcpt_astro_supply, T.rcpt_ss_supply] = await Promise.all([supplyOf(C.AMPLP_ASTRO_LP), supplyOf(C.AMPLP_SS_LP)]);
  const daoModuleHolding = (raw[C.AMPCAPA_DAO_VOTE] || {}).rcpt_amp;   // the module holds staked + unbonding receipts

  const g = (name, sum, expected, walk) => {
    const complete = walk ? walk.complete : true;
    const ok = complete && isNum(sum) && isNum(expected) ? Math.abs(sum - expected) <= Math.max(1e-6, Math.abs(expected) * GUARD_TOLERANCE) : (complete && isNum(sum) && isNum(expected) ? false : null);
    return { sum: isNum(sum) ? sum : null, expected: isNum(expected) ? expected : null, ok, ...(walk && !walk.complete ? { enumeration: 'incomplete', error: walk.error } : {}) };
  };
  const guards = {
    capa_cw20_sums_to_supply:           g('capa', walkSums.capa, T.capa_supply, capaState),
    gov_shares_sum_to_total_share:      g('gov', walkSums.gov_shares, T.gov_total_share, govStateWalk),
    single_ampcapa_shares_sum_to_pool:  g('single', walkSums.single_shares, T.single_shares, singleState),
    project_astro_shares_sum_to_pool:   g('astro', walkSums.astro_shares, T.astro_shares, projectState),
    project_ss_shares_sum_to_pool:      g('ss', walkSums.ss_shares, T.ss_shares, projectState),
    astro_lp_cw20_sums_to_supply:       g('astrolp', walkSums.astro_lp, T.astro_lp_supply, astroLpState),
    ampcapa_owners_sum_to_supply:       g('amp', walkSums.ampcapa, T.ampcapa_supply, ampOwners),
    receipt_ampcapa_owners_sum_to_supply: g('rcpt', walkSums.rcpt_amp, T.rcpt_amp_supply, rcptAmpOwners),
    receipt_astro_owners_sum_to_supply: g('rcpta', walkSums.rcpt_astro, T.rcpt_astro_supply, rcptAstroOwners),
    receipt_ss_owners_sum_to_supply:    g('rcpts', walkSums.rcpt_ss, T.rcpt_ss_supply, rcptSsOwners),
    ss_lp_owners_sum_to_supply:         g('sslp', walkSums.ss_lp, T.ss_lp_supply, ssLpOwners),
    dao_stakers_sum_to_total_power:     g('dao', walkSums.dao_power, T.dao_power, daoStakers),
    // the module's receipt balance = staked power + everything in its unbonding queue; claims are per-wallet so this is the completeness check for the claims sweep
    dao_module_holding_eq_power_plus_claims: g('claims', isNum(T.dao_power) && !claimsFailed ? T.dao_power + claimsSum : null, daoModuleHolding, daoStakers),
  };

  // ---- rows (CAPA-equivalent per form, live rates) ----
  const singlePS = perShare(poolAmp), astroPS = perShare(poolAstro), ssPS = perShare(poolSs);
  const mul = (a, b) => (isNum(a) && isNum(b)) ? a * b : (a == null ? null : (b == null ? null : 0));
  // null-vs-0 per column: a form whose enumeration did not complete is NULL on
  // every row (unknown), never 0 (confirmed empty).
  const colOk = {
    capa_liquid: capaState.complete, gov_direct: govStateWalk.complete, ampcapa_liquid: ampOwners.complete,
    ampcapa_tla_nonamp: singleState.complete, receipt_held: rcptAmpOwners.complete, receipt_dao: daoStakers.complete,
    receipt_unbonding: daoStakers.complete, astro_lp_liquid: astroLpState.complete, astro_lp_tla_nonamp: projectState.complete,
    astro_lp_amp: rcptAstroOwners.complete, ss_lp_liquid: ssLpOwners.complete, ss_lp_tla_nonamp: projectState.complete, ss_lp_amp: rcptSsOwners.complete,
  };
  const conv = (r) => Object.fromEntries(Object.entries(convRaw(r)).map(([k, v]) => [k, colOk[k] ? v : null]));
  const convRaw = (r) => ({
    capa_liquid:        r.capa_liquid ?? 0,
    gov_direct:         mul(r.gov_share ?? 0, govRate),
    ampcapa_liquid:     mul(r.ampcapa_liquid ?? 0, hubRate),
    ampcapa_tla_nonamp: mul(mul(r.single_shares ?? 0, singlePS), hubRate),
    receipt_held:       mul(mul(r.rcpt_amp ?? 0, compRate), hubRate),
    receipt_dao:        mul(mul(r.dao_power ?? 0, compRate), hubRate),
    receipt_unbonding:  r.claims === null ? null : mul(mul(r.claims ?? 0, compRate), hubRate),
    astro_lp_liquid:    mul(r.astro_lp_liquid ?? 0, capaPerAstroLp),
    astro_lp_tla_nonamp: mul(mul(r.astro_shares ?? 0, astroPS), capaPerAstroLp),
    astro_lp_amp:       mul(mul(r.rcpt_astro ?? 0, astroLpPerRcpt), capaPerAstroLp),
    ss_lp_liquid:       mul(r.ss_lp_liquid ?? 0, capaPerSsLp),
    ss_lp_tla_nonamp:   mul(mul(r.ss_shares ?? 0, ssPS), capaPerSsLp),
    ss_lp_amp:          mul(mul(r.rcpt_ss ?? 0, ssLpPerRcpt), capaPerSsLp),
  });
  const COLS = ['capa_liquid', 'gov_direct', 'ampcapa_liquid', 'ampcapa_tla_nonamp', 'receipt_held', 'receipt_dao', 'receipt_unbonding', 'astro_lp_liquid', 'astro_lp_tla_nonamp', 'astro_lp_amp', 'ss_lp_liquid', 'ss_lp_tla_nonamp', 'ss_lp_amp'];
  const total = (c) => COLS.reduce((s, k) => s + (c[k] || 0), 0);
  const rows = [], tailCols = Object.fromEntries(COLS.map(k => [k, 0])); let tailCount = 0, tailTotal = 0, walletsEnumerated = 0;
  for (const [addr, r] of Object.entries(raw)) {
    const kind = kindOf(addr);
    const role = STRUCTURAL[addr] ? 'bucket' : null;
    const c = conv(r); const t = total(c);
    const row = { address: addr, kind, role, label: STRUCTURAL[addr] || null, total_capa_equiv: t, capa_equiv: c, raw: r };
    if (role === 'bucket') { rows.push(row); continue; }         // structural buckets always published (few; they ARE the buckets)
    walletsEnumerated++;                                         // holders = wallets + non-bucket contracts (DAOs, multisigs, vesting)
    if (t >= WALLET_FLOOR_CAPA) rows.push(row);
    else { tailCount++; tailTotal += t; for (const k of COLS) tailCols[k] += (c[k] || 0); }
  }
  rows.sort((a, b) => b.total_capa_equiv - a.total_capa_equiv);

  // ---- compact per-wallet daily (v2.1): holders that are DAO stakers OR ≥ floor ----
  const dailyRows = {};
  for (const [addr, r] of Object.entries(raw)) {
    if (STRUCTURAL[addr]) continue;
    const c = conv(r); const t = total(c);
    if (!(r.dao_power > 0) && t < WALLET_FLOOR_CAPA) continue;
    const rd = c.receipt_dao;
    dailyRows[addr] = [Object.values(c).some(v => v === null) ? null : round6(t), rd === null ? null : round6(rd)];
  }

  // ---- unattributed remainders (labeled, never dropped) ----
  const incentivesLp = (raw[ASTRO_INCENTIVES] || {}).astro_lp_liquid;
  const unattributed = {
    // LP sitting in Astroport Incentives beyond what TLA staked there = users staked DIRECTLY on Astroport (no enumeration exists) — labeled, not invented
    astro_lp_in_incentives_not_tla: isNum(incentivesLp) && isNum(doc.capa.in_lp.astro.lp_staked_tla) ? Math.max(0, incentivesLp - doc.capa.in_lp.astro.lp_staked_tla) : null,
    // gov cw20 balance beyond Σ(shares × rate): poll deposits / rewards not yet folded into the rate — real, labeled, not a staker
    gov_balance_beyond_shares: isNum(doc.capa.gov_contract_balance) && isNum(walkSums.gov_shares) && isNum(govRate) ? doc.capa.gov_contract_balance - walkSums.gov_shares * govRate : null,
    // claims not covered by the orbit sweep (module holding − power − Σ claims found)
    receipt_unbonding_unattributed: isNum(daoModuleHolding) && isNum(T.dao_power) ? Math.max(0, daoModuleHolding - T.dao_power - claimsSum) : null,
  };

  const failed = Object.entries(guards).filter(([, v]) => v.ok === false).map(([k]) => k);
  const incomplete = Object.entries(guards).filter(([, v]) => v.enumeration === 'incomplete').map(([k]) => k);
  const status = failed.length ? 'guard_failed' : (incomplete.length || claimsFailed || !isNum(govRate)) ? 'partial' : 'ok';

  const walletsDaily = {
    schemaVersion: 2, module: 'token-catalog', product: 'supply/capa/wallets-daily',
    date: doc.capturedAt.slice(0, 10), capturedAt: doc.capturedAt, src: 'capture', status,
    rates: { hub_capa_per_ampcapa: hubRate, compounder_ampcapa_per_receipt: compRate },
    columns: ['total_capa_equiv', 'receipt_dao_capa'],   // null = unknown this run, never 0
    row_count: Object.keys(dailyRows).length,
    rows: dailyRows,
  };
  const wallets = {
    schemaVersion: 2, module: 'token-catalog', product: 'supply/capa/wallets',
    capturedAt: doc.capturedAt, status, guard_failures: failed, incomplete_enumerations: incomplete,
    query_errors: errors.slice(0, 10),
    floor_capa_equiv: WALLET_FLOOR_CAPA,
    rates: { ...R, gov_capa_per_share: govRate, single_ampcapa_per_share: singlePS, astro_lp_per_share: astroPS, ss_lp_per_share: ssPS },
    columns: COLS,
    columns_unknown: COLS.filter(k => !colOk[k]),   // enumeration incomplete → column is null on every row
    counts: { wallets_enumerated: walletsEnumerated, rows_published: rows.filter(r => r.role !== 'bucket').length, contracts_published: rows.filter(r => r.kind === 'contract' && r.role !== 'bucket').length, buckets_published: rows.filter(r => r.role === 'bucket').length, tail_below_floor: tailCount, claims_queried: orbit.length, claims_failed: claimsFailed },
    sum_guards: guards,
    unattributed,
    rows,
    tail_below_floor: { count: tailCount, total_capa_equiv: tailTotal, capa_equiv: tailCols },
  };
  const doc2 = { ...doc, schemaVersion: 2, wallets: { file: 'wallets.json', status, rows_published: wallets.counts.rows_published, wallets_enumerated: walletsEnumerated, floor_capa_equiv: WALLET_FLOOR_CAPA, sum_guards_ok: failed.length === 0 && incomplete.length === 0, guard_failures: failed, incomplete_enumerations: incomplete } };
  return { doc: doc2, wallets, walletsDaily };
}
const round6 = (v) => Math.round(v * 1e6) / 1e6;

// ---- row-series (daily/<date>.json + index.json) — pure, testable ----
// index.json rows: one per UTC date, same-date upsert, never-shrink (a row can
// never disappear; asserted by the caller before publish).
function indexRowOf(doc) {
  const c = doc.capa, m = doc.ampcapa;
  return {
    date: doc.capturedAt.slice(0, 10), capturedAt: doc.capturedAt, status: doc.status,
    hub_rate: doc.rates && doc.rates.hub_capa_per_ampcapa,
    capa_liquid: c.liquid_derived, capa_gov_direct: c.gov_staked_direct, capa_in_hub: c.in_hub,
    capa_astro_lp: c.in_lp.astro.capa, capa_ss_lp: c.in_lp.ss.capa,
    ampcapa_liquid: m.liquid, ampcapa_tla_nonamp: m.tla_nonamp, ampcapa_tla_amp: m.tla_amp_via_compounder,
    receipt_in_dao: m.receipt_in_dao, receipt_outside_dao: m.receipt_outside_dao_or_unbonding,
    wallets_published: doc.wallets ? doc.wallets.rows_published : null,
  };
}
// `existing`: the committed index.json (object) · null = 404/absent (start fresh) ·
// undefined = the READ FAILED (corrupt or transport) → refuse; publishing from a
// failed read is how a series silently shrinks (F4 corrupt-vs-absent).
function upsertIndex(existing, doc) {
  if (existing === undefined) throw new Error('never-shrink: existing index read failed — refusing to rebuild from nothing');
  if (existing !== null && (typeof existing !== 'object' || !Array.isArray(existing.rows))) throw new Error('never-shrink: existing index is corrupt (no rows array)');
  const rows = existing ? existing.rows.slice() : [];
  const row = indexRowOf(doc);
  const i = rows.findIndex(r => r.date === row.date);
  if (i >= 0) rows[i] = row; else rows.push(row);
  rows.sort((a, b) => a.date < b.date ? -1 : 1);
  if (existing && Array.isArray(existing.rows) && rows.length < existing.rows.length) throw new Error('never-shrink: index rows would drop');
  return { schemaVersion: 2, module: 'token-catalog', product: 'supply/capa/index', updatedAt: doc.capturedAt, row_count: rows.length, date_range: rows.length ? { from: rows[0].date, to: rows[rows.length - 1].date } : null, rows };
}

// A legacy (ampcapa-data_2026) weekly/monthly snapshot → the SAME index row
// shape, every field it cannot supply left null, `src` labeling the repair.
function legacyIndexRow({ date, capturedAt, hub_rate, receipt_in_dao, src }) {
  const row = Object.fromEntries(Object.keys(indexRowOf({ capturedAt: '2000-01-01T00:00:00.000Z', status: 'ok', rates: {}, capa: { in_lp: { astro: {}, ss: {} } }, ampcapa: {} })).map(k => [k, null]));
  return { ...row, date, capturedAt, status: 'legacy_fold', hub_rate, receipt_in_dao, src };
}
// Prior-verbatim fold: legacy rows are added ONLY for dates with no committed
// row; committed rows (captured or previously folded) are never touched.
// Never-shrink: refuses a failed/corrupt read like upsertIndex.
function foldIndexRows(existing, legacyRows) {
  if (existing === undefined) throw new Error('never-shrink: existing index read failed');
  if (existing !== null && (typeof existing !== 'object' || !Array.isArray(existing.rows))) throw new Error('never-shrink: existing index is corrupt');
  const rows = existing ? existing.rows.slice() : []; const have = new Set(rows.map(r => r.date)); let added = 0, skipped = 0;
  for (const lr of legacyRows) { if (have.has(lr.date)) { skipped++; continue; } rows.push(lr); have.add(lr.date); added++; }
  rows.sort((a, b) => a.date < b.date ? -1 : 1);
  const meta = existing || {};
  return { doc: { schemaVersion: 2, module: 'token-catalog', product: 'supply/capa/index', updatedAt: meta.updatedAt || null, row_count: rows.length, date_range: rows.length ? { from: rows[0].date, to: rows[rows.length - 1].date } : null, rows }, added, skipped };
}
// wallets-daily/index.json: the date list (+ src) the page picks comparison days from. Never-shrink.
function upsertDailyIndex(existing, date, src) {
  if (existing === undefined) throw new Error('never-shrink: existing wallets-daily index read failed');
  if (existing !== null && (typeof existing !== 'object' || !Array.isArray(existing.days))) throw new Error('never-shrink: existing wallets-daily index is corrupt');
  const days = existing ? existing.days.slice() : [];
  const i = days.findIndex(d => d.date === date);
  if (i >= 0) { if (days[i].src === 'capture' && src !== 'capture') return { doc: existing, changed: false }; days[i] = { date, src }; }   // a captured day is never demoted to legacy
  else days.push({ date, src });
  days.sort((a, b) => a.date < b.date ? -1 : 1);
  return { doc: { schemaVersion: 2, module: 'token-catalog', product: 'supply/capa/wallets-daily/index', updatedAt: new Date().toISOString(), day_count: days.length, date_range: { from: days[0].date, to: days[days.length - 1].date }, days }, changed: true };
}

module.exports = { captureCapaSupply, captureCapaWallets, indexRowOf, upsertIndex, legacyIndexRow, foldIndexRows, upsertDailyIndex, CAPA_CONTRACTS: C, GUARD_TOLERANCE, WALLET_FLOOR_CAPA,
  _decoders: { decodeCw20BalanceKey, decodeGovBankKey, decodeVe3SharesKey, bech32Encode } };
