// =============================================================================
// FUEL Supply Map — org-token-catalog duty (v1.0, 2026-08-24)
// =============================================================================
// Fixture: fuel-boost-dao-probe run 2026-08-24T19:27Z (artifact 9535225981):
//   Boost DAO core neutron1ej43fv…vvzm43 ("Boost DAO"), voting module
//   neutron19740eh…sdpy2 (dao-voting-token-staked 2.5.0), FUEL native denom
//   factory/neutron1zl2htq…uruxm/fuel; 46 stakers Σ 16,055,799.122882 ==
//   total_power == module bank; treasury 42,438,782 FUEL; native supply
//   99,859,353.300701.
//
// FUEL is a Neutron token; the Terra side (what fuel-tool's whales showed) is
// the IBC voucher ibc/4B44…3961. Two levels, both sum-guarded:
//   NEUTRON  native_supply = boost_staked + boost_treasury + bridged (escrow of
//            the transfer channel to Terra) + neutron_liquid (derived remainder,
//            cross-checked by a denom_owners walk: Σ owners == native supply)
//   TERRA    ibc_supply = Σ denom_owners (pool pair, bribe manager, wallets)
//   cross    terra ibc_supply ≈ neutron escrow balance (bridged)
// Per-wallet rows on BOTH chains: {chain, address, kind, role, label,
// fuel:{liquid, boost_staked, boost_unbonding}, total}. Laws as capa-supply:
// null-vs-0 per column, sum guards vs the owning contract's OWN totals, floor
// + per-column tail, kind chain-structural (32-byte = contract), role:"bucket"
// ONLY for the structural set (the two Boost contracts, the transfer escrow,
// catalog-known pair contracts, the TLA incentive manager); everything else is
// a holder. Rates: FUEL has none (1 FUEL = 1 FUEL on both chains).
'use strict';

const F = {
  NEUTRON_LCD:      'https://neutron-rest.publicnode.com',
  BOOST_CORE:       'neutron1ej43fvrmw40dg6xj40mmh822a8xz98rt5ad2p9tj2tgtgxw0zalsvvzm43',
  BOOST_VOTING:     'neutron19740eh6mqdmgudy0y9at3a3sr54juu0p4lurt7asd5yx74wslycqrsdpy2',
  FUEL_NEUTRON:     'factory/neutron1zl2htquajn50vxu5ltz0y5hf2qzvkgnjaaza2rssef268xplq6vsjuruxm/fuel',
  FUEL_TERRA_IBC:   'ibc/4B44179AC2F0BEE50C16A673B3B886398988692885B2848A1C8AEF27148B3961',
  TLA_INCENTIVE_MANAGER: 'terra1tuuwm8yrj54qeg0c8xu00aha9ryatyhtczq8qq2q8tntuw0auzas9037wh',
};
const GUARD_TOLERANCE = 0.0001;
const WALLET_FLOOR_FUEL = 10000;
const MAX_OWNER_PAGES = 200;
const num = (v) => { if (v == null) return null; const n = Number(v) / 1e6; return Number.isFinite(n) ? n : null; };
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
// chain-structural: bech32 data length. 20-byte account = prefix+1+38 chars; 32-byte contract = prefix+1+58.
const kindOf = (addr) => { const p = addr.indexOf('1'); return (addr.length - p - 1) === 58 ? 'contract' : 'wallet'; };
const chainOf = (addr) => addr.startsWith('neutron1') ? 'neutron' : addr.startsWith('terra1') ? 'terra' : 'other';

// deps = { fetchJson, terraLcdBase, neutronLcdBase?, catalogPools? } — no queryContract: it is Terra-bound in the engine; smart queries here go through fetchJson so both chains use one path and the gate can stub both.
async function captureFuelSupply(deps) {
  const { fetchJson, terraLcdBase } = deps;
  const NL = deps.neutronLcdBase || F.NEUTRON_LCD;
  const errors = [];
  const get = async (base, path, label) => { try { return await fetchJson(`${base}${path}`, label); } catch (e) { errors.push(`${label}: ${String(e.message || e).slice(0, 100)}`); return null; } };
  const smart = async (base, addr, msg) => { const r = await get(base, `/cosmwasm/wasm/v1/contract/${addr}/smart/${b64(msg)}`, `smart ${addr.slice(0, 14)} ${Object.keys(msg)[0]}`); return r ? r.data : null; };
  const supplyOf = async (base, denom) => { const r = await get(base, `/cosmos/bank/v1beta1/supply/by_denom?denom=${encodeURIComponent(denom)}`, `supply ${denom.slice(-10)}`); return r ? num(r.amount && r.amount.amount) : null; };
  const balanceOf = async (base, addr, denom) => { const r = await get(base, `/cosmos/bank/v1beta1/balances/${addr}/by_denom?denom=${encodeURIComponent(denom)}`, `balance ${addr.slice(0, 14)}`); return r ? num(r.balance && r.balance.amount) : null; };
  async function walkOwners(base, denom) {
    const owners = []; let key = null, pages = 0;
    while (pages < MAX_OWNER_PAGES) {
      pages++;
      const r = await get(base, `/cosmos/bank/v1beta1/denom_owners_by_query?denom=${encodeURIComponent(denom)}&pagination.limit=500${key ? '&pagination.key=' + encodeURIComponent(key) : ''}`, `owners ${denom.slice(-10)} p${pages}`);
      if (!r) return { owners, complete: false, pages, error: 'walk failed' };
      for (const o of (r.denom_owners || [])) owners.push({ address: o.address, amount: num(o.balance && o.balance.amount) });
      key = r.pagination && r.pagination.next_key;
      if (!key) return { owners, complete: true, pages, error: null };
    }
    return { owners, complete: false, pages, error: 'page cap' };
  }
  async function walkStakers() {
    const stakers = []; let start = null, pages = 0;
    while (pages < 500) {
      pages++;
      const r = await smart(NL, F.BOOST_VOTING, start ? { list_stakers: { limit: 30, start_after: start } } : { list_stakers: { limit: 30 } });
      if (!r) return { stakers, complete: false, error: 'list_stakers failed' };
      const rows = r.stakers || [];
      for (const s of rows) stakers.push({ address: s.address, amount: num(s.balance) });
      if (rows.length < 30) return { stakers, complete: true, error: null };
      start = rows[rows.length - 1].address;
    }
    return { stakers, complete: false, error: 'page cap' };
  }

  // ---- Neutron level ---------------------------------------------------------
  const [nativeSupply, treasuryFuel, moduleBank, totalPower, stakersWalk, neutronOwners, coreState] = await Promise.all([
    supplyOf(NL, F.FUEL_NEUTRON),
    balanceOf(NL, F.BOOST_CORE, F.FUEL_NEUTRON),
    balanceOf(NL, F.BOOST_VOTING, F.FUEL_NEUTRON),
    smart(NL, F.BOOST_VOTING, { total_power_at_height: {} }).then(r => r ? num(r.power) : null),
    walkStakers(),
    walkOwners(NL, F.FUEL_NEUTRON),
    smart(NL, F.BOOST_CORE, { config: {} }),
  ]);
  const boostName = coreState && coreState.name ? String(coreState.name) : null;
  // claims (unbonding) per staker — the module's bank must equal power + Σ claims
  let claimsSum = 0, claimsFailed = 0; const claimsBy = {};
  if (stakersWalk.complete) {
    for (const s of stakersWalk.stakers) {
      const r = await smart(NL, F.BOOST_VOTING, { claims: { address: s.address } });
      if (!r) { claimsFailed++; claimsBy[s.address] = null; continue; }
      let sum = 0; for (const c of (r.claims || [])) { const a = num(c.amount); if (a == null) { sum = null; break; } sum += a; }
      claimsBy[s.address] = sum; if (sum != null) claimsSum += sum; else claimsFailed++;
    }
  }
  // bridged: the ICS-20 escrow on Neutron for the channel that mints Terra's ibc/4B44…
  let escrow = { address: null, balance: null, channel: null, error: null };
  try {
    const tr = await get(terraLcdBase, `/ibc/apps/transfer/v1/denom_traces/${F.FUEL_TERRA_IBC.slice(4)}`, 'terra denom trace');
    const path = tr && tr.denom_trace && tr.denom_trace.path;   // "transfer/channel-N" (Terra's channel)
    const terraChannel = path && path.split('/')[1];
    const ch = terraChannel ? await get(terraLcdBase, `/ibc/core/channel/v1/channels/${terraChannel}/ports/transfer`, 'terra channel') : null;
    const neutronChannel = ch && ch.channel && ch.channel.counterparty && ch.channel.counterparty.channel_id;
    if (neutronChannel) {
      const es = await get(NL, `/ibc/apps/transfer/v1/channels/${neutronChannel}/ports/transfer/escrow_address`, 'neutron escrow');
      const esAddr = es && es.escrow_address;
      escrow = { address: esAddr || null, channel: neutronChannel, balance: esAddr ? await balanceOf(NL, esAddr, F.FUEL_NEUTRON) : null, error: esAddr ? null : 'escrow address not returned' };
    } else escrow.error = 'counterparty channel not resolved';
  } catch (e) { escrow.error = String(e.message || e).slice(0, 100); }

  // ---- Terra level -----------------------------------------------------------
  const [terraSupply, terraOwners] = await Promise.all([supplyOf(terraLcdBase, F.FUEL_TERRA_IBC), walkOwners(terraLcdBase, F.FUEL_TERRA_IBC)]);

  // ---- rows ------------------------------------------------------------------
  const STRUCTURAL = {
    [F.BOOST_CORE]: boostName ? `${boostName} treasury (DAODAO core)` : 'Boost DAO treasury (DAODAO core)',
    [F.BOOST_VOTING]: 'Boost DAO voting module (staked + unbonding FUEL)',
    [F.TLA_INCENTIVE_MANAGER]: 'TLA incentive manager (FUEL bribe pots)',
  };
  if (escrow.address) STRUCTURAL[escrow.address] = `IBC transfer escrow → Terra (${escrow.channel})`;
  for (const p of (deps.catalogPools || [])) {
    const pair = p.architecture && p.architecture.pair_address;
    if (pair && JSON.stringify(p.underlyings || p).includes(F.FUEL_TERRA_IBC)) STRUCTURAL[pair] = `${p.dex || 'DEX'} pair ${p.name || ''}`.trim();
  }
  const raw = {}; const at = (a) => (raw[a] || (raw[a] = {}));
  const walkSums = {};
  if (neutronOwners.complete) { let s = 0; for (const o of neutronOwners.owners) { if (o.amount == null) continue; at(o.address).liquid = (at(o.address).liquid || 0) + o.amount; s += o.amount; } walkSums.neutron = s; }
  if (terraOwners.complete) { let s = 0; for (const o of terraOwners.owners) { if (o.amount == null) continue; at(o.address).liquid = (at(o.address).liquid || 0) + o.amount; s += o.amount; } walkSums.terra = s; }
  if (stakersWalk.complete) { let s = 0; for (const st of stakersWalk.stakers) { if (st.amount == null) continue; at(st.address).boost_staked = st.amount; at(st.address).boost_unbonding = claimsBy[st.address] === undefined ? null : claimsBy[st.address]; s += st.amount; } walkSums.staked = s; }

  const g = (sum, expected, complete = true) => {
    const ok = complete && isNum(sum) && isNum(expected) ? Math.abs(sum - expected) <= Math.max(1e-6, Math.abs(expected) * GUARD_TOLERANCE) : null;
    return { sum: isNum(sum) ? sum : null, expected: isNum(expected) ? expected : null, ok, ...(complete ? {} : { enumeration: 'incomplete' }) };
  };
  const guards = {
    neutron_owners_sum_to_native_supply: g(walkSums.neutron, nativeSupply, neutronOwners.complete),
    boost_stakers_sum_to_total_power:    g(walkSums.staked, totalPower, stakersWalk.complete),
    boost_module_bank_eq_power_plus_claims: g(isNum(totalPower) && !claimsFailed && stakersWalk.complete ? totalPower + claimsSum : null, moduleBank, stakersWalk.complete && !claimsFailed),
    terra_owners_sum_to_ibc_supply:      g(walkSums.terra, terraSupply, terraOwners.complete),
    terra_ibc_supply_eq_neutron_escrow:  g(terraSupply, escrow.balance, escrow.balance != null),
  };
  const colOk = { liquid: neutronOwners.complete && terraOwners.complete, boost_staked: stakersWalk.complete, boost_unbonding: stakersWalk.complete };
  const conv = (r, chain) => ({
    liquid: (chain === 'neutron' ? neutronOwners.complete : terraOwners.complete) ? (r.liquid || 0) : null,
    boost_staked: colOk.boost_staked ? (r.boost_staked || 0) : null,
    boost_unbonding: colOk.boost_unbonding ? (r.boost_unbonding === null ? null : (r.boost_unbonding || 0)) : null,
  });
  const COLS = ['liquid', 'boost_staked', 'boost_unbonding'];
  const rows = []; const tail = { count: 0, total: 0, fuel: { liquid: 0, boost_staked: 0, boost_unbonding: 0 } }; let holders = 0;
  for (const [addr, r] of Object.entries(raw)) {
    const chain = chainOf(addr), kind = kindOf(addr), role = STRUCTURAL[addr] ? 'bucket' : null;
    const fuel = conv(r, chain); const total = COLS.reduce((s, k) => s + (fuel[k] || 0), 0);
    const row = { chain, address: addr, kind, role, label: STRUCTURAL[addr] || null, total_fuel: total, fuel };
    if (role === 'bucket') { rows.push(row); continue; }
    holders++;
    if (total >= WALLET_FLOOR_FUEL) rows.push(row); else { tail.count++; tail.total += total; for (const k of COLS) tail.fuel[k] += fuel[k] || 0; }
  }
  rows.sort((a, b) => b.total_fuel - a.total_fuel);

  const failed = Object.entries(guards).filter(([, v]) => v.ok === false).map(([k]) => k);
  const incomplete = Object.entries(guards).filter(([, v]) => v.enumeration === 'incomplete').map(([k]) => k);
  const bridged = escrow.balance;
  const neutronLiquid = [nativeSupply, walkSums.staked, treasuryFuel, bridged].every(isNum) ? nativeSupply - walkSums.staked - claimsSum - treasuryFuel - bridged : null;
  const status = failed.length ? 'guard_failed' : (incomplete.length || claimsFailed || bridged == null) ? 'partial' : 'ok';
  const capturedAt = new Date().toISOString();
  const doc = {
    schemaVersion: 1, module: 'token-catalog', product: 'supply/fuel', capturedAt, status,
    guard_failures: failed, incomplete_enumerations: incomplete, query_errors: errors.slice(0, 10),
    sources: { neutron_lcd: NL, boost_core: F.BOOST_CORE, boost_voting: F.BOOST_VOTING, boost_name: boostName, fuel_neutron_denom: F.FUEL_NEUTRON, fuel_terra_ibc: F.FUEL_TERRA_IBC, escrow },
    neutron: {
      native_supply: nativeSupply,
      boost_staked: stakersWalk.complete ? walkSums.staked : null, boost_unbonding: claimsFailed ? null : claimsSum, boost_stakers: stakersWalk.complete ? stakersWalk.stakers.length : null,
      boost_treasury: treasuryFuel, bridged_to_terra: bridged,
      liquid_derived: neutronLiquid,   // remainder: every Neutron holder that is not the DAO, the module, or the escrow (labeled, cross-checked by the owners guard)
      holders_enumerated: neutronOwners.complete ? neutronOwners.owners.length : null,
    },
    terra: { ibc_supply: terraSupply, holders_enumerated: terraOwners.complete ? terraOwners.owners.length : null },
    sum_guards: guards,
    wallets: { file: 'wallets.json', floor_fuel: WALLET_FLOOR_FUEL, holders_enumerated: holders, rows_published: rows.filter(r => r.role !== 'bucket').length, tail_below_floor: tail.count },
  };
  const wallets = {
    schemaVersion: 1, module: 'token-catalog', product: 'supply/fuel/wallets', capturedAt, status, guard_failures: failed, incomplete_enumerations: incomplete,
    floor_fuel: WALLET_FLOOR_FUEL, columns: COLS, columns_unknown: COLS.filter(k => !colOk[k]),
    counts: { holders_enumerated: holders, rows_published: doc.wallets.rows_published, buckets_published: rows.filter(r => r.role === 'bucket').length, tail_below_floor: tail.count, claims_queried: stakersWalk.complete ? stakersWalk.stakers.length : 0, claims_failed: claimsFailed },
    sum_guards: guards, rows, tail_below_floor: { count: tail.count, total_fuel: tail.total, fuel: tail.fuel },
  };
  return { doc, wallets };
}

function indexRowOf(doc) {
  return { date: doc.capturedAt.slice(0, 10), capturedAt: doc.capturedAt, status: doc.status,
    native_supply: doc.neutron.native_supply, boost_staked: doc.neutron.boost_staked, boost_unbonding: doc.neutron.boost_unbonding, boost_stakers: doc.neutron.boost_stakers,
    boost_treasury: doc.neutron.boost_treasury, bridged_to_terra: doc.neutron.bridged_to_terra, neutron_liquid: doc.neutron.liquid_derived, terra_ibc_supply: doc.terra.ibc_supply };
}
function upsertIndex(existing, doc) {
  if (existing === undefined) throw new Error('never-shrink: existing index read failed — refusing');
  if (existing !== null && (typeof existing !== 'object' || !Array.isArray(existing.rows))) throw new Error('never-shrink: existing index is corrupt');
  const rows = existing ? existing.rows.slice() : []; const row = indexRowOf(doc);
  const i = rows.findIndex(r => r.date === row.date); if (i >= 0) rows[i] = row; else rows.push(row);
  rows.sort((a, b) => a.date < b.date ? -1 : 1);
  return { schemaVersion: 1, module: 'token-catalog', product: 'supply/fuel/index', updatedAt: doc.capturedAt, row_count: rows.length, date_range: { from: rows[0].date, to: rows[rows.length - 1].date }, rows };
}

module.exports = { captureFuelSupply, indexRowOf, upsertIndex, FUEL_CONTRACTS: F, GUARD_TOLERANCE, WALLET_FLOOR_FUEL, _kindOf: kindOf };
