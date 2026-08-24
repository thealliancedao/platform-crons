// =============================================================================
// mock-run-fuel-supply.js — BINDING gate for token-catalog/fuel-supply.js
// =============================================================================
// Fixture = fuel-boost-dao-probe run 2026-08-24T19:27Z (artifact 9535225981):
// 46 stakers Σ 16,055,799.122882 == total_power == module bank; treasury
// 42,438,782 FUEL; native supply 99,859,353.300701; sample stakers
// neutron10aen… 9,418 · neutron10rdut… 53,447 · neutron136wra… 0 power.
// The world is consistent by construction; scenarios prove null-vs-0, the
// escrow cross-guard, and a loud guard trip. Drives the LIVE module.
'use strict';
const path = require('path');
const M = require(path.join(__dirname, 'fuel-supply.js'));
const F = M.FUEL_CONTRACTS;
let PASS = 0, FAIL = 0;
const check = (n, ok, x) => { if (ok) { PASS++; console.log('  ✓ ' + n); } else { FAIL++; console.log('  ✗ ' + n + (x != null ? '  ← ' + JSON.stringify(x) : '')); } };
const near = (a, b, tol = 1e-6) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= Math.max(tol, Math.abs(b) * 1e-9);
const u = (x) => String(Math.round(x * 1e6));

const NATIVE = 99859353.300701, TREAS = 42438782, POWER = 16055799.122882;
const STK = ['neutron10aen3uas4xl3jw93u4r3ay33kyq2pkkd0crm2m', 'neutron10rdut36lnhsrudd3t4zqqgpvrmxam4led82zwa', 'neutron136wrasqzaplzsakzf62g0czq3jeh6wxn9crmtj'];
const W = (n, pfx = 'neutron') => pfx + '1' + 'q'.repeat(38 - String(n).length) + String(n).replace(/[^a-z0-9]/g, 'z');   // 20-byte-shaped
const TERRA_PAIR = 'terra1' + 'p'.repeat(58); const ESCROW = 'neutron1' + 'e'.repeat(38);
// stakers: 3 fixture + 43 filler summing to POWER
const stakers = {}; stakers[STK[0]] = 9418; stakers[STK[1]] = 53447; stakers[STK[2]] = 0;
for (let i = 0; i < 43; i++) stakers[W(100 + i)] = 100000; const rem = POWER - Object.values(stakers).reduce((a, b) => a + b, 0); stakers[W(200)] = (stakers[W(200)] || 0) + rem;   // 47 addresses, one absorbed the remainder
const claims = { [STK[1]]: 1000 };   // one unbonding claim → module bank = power + 1000
const MODULE_BANK = POWER + 1000;
const TERRA_SUPPLY = 21000000;      // bridged; escrow holds exactly this
const neutronLiquid = { [W(300)]: 12000000, [W(301)]: 3000, [W(302)]: 500 };
neutronLiquid[W(303)] = NATIVE - POWER - 1000 - TREAS - TERRA_SUPPLY - 12003500;   // closes native supply
const terraLiquid = { [TERRA_PAIR]: 8301522, [F.TLA_INCENTIVE_MANAGER]: 126625, ['terra1' + 'w'.repeat(38)]: 6479053 };
terraLiquid['terra1' + 'x'.repeat(38)] = TERRA_SUPPLY - Object.values(terraLiquid).reduce((a, b) => a + b, 0);

function makeWorld(opts = {}) {
  const owners = (denom) => {
    if (denom === F.FUEL_NEUTRON) return [[F.BOOST_CORE, TREAS], [F.BOOST_VOTING, MODULE_BANK], [ESCROW, TERRA_SUPPLY], ...Object.entries(neutronLiquid)].map(([a, v]) => ({ address: a, balance: { denom, amount: u(v) } }));
    return Object.entries(terraLiquid).map(([a, v]) => ({ address: a, balance: { denom, amount: u(v) } }));
  };
  const calls = { owners: {} };
  async function fetchJson(url) {
    const neutron = url.startsWith('https://neutron');
    if (url.includes('/smart/')) {
      const addr = /contract\/([^/]+)\/smart\/(.+)$/.exec(url); const q = JSON.parse(Buffer.from(decodeURIComponent(addr[2]), 'base64').toString()); const k = Object.keys(q)[0];
      if (addr[1] === F.BOOST_CORE && k === 'config') return { data: { name: 'Boost DAO' } };
      if (addr[1] === F.BOOST_VOTING && k === 'total_power_at_height') return { data: { power: u(POWER), height: 1 } };
      if (addr[1] === F.BOOST_VOTING && k === 'list_stakers') { const all = Object.entries(stakers).map(([a, v]) => ({ address: a, balance: u(v) })).sort((x, y) => x.address < y.address ? -1 : 1); const s = q.list_stakers.start_after; const i = s ? all.findIndex(x => x.address === s) + 1 : 0; return { data: { stakers: all.slice(i, i + q.list_stakers.limit) } }; }
      if (addr[1] === F.BOOST_VOTING && k === 'claims') { if (opts.claimsFailFor === q.claims.address) throw new Error('HTTP 503'); return { data: { claims: claims[q.claims.address] ? [{ amount: u(claims[q.claims.address]), release_at: { at_time: '1' } }] : [] } }; }
      throw new Error('mock unhandled smart ' + k);
    }
    if (url.includes('denom_owners_by_query')) {
      const denom = decodeURIComponent(/denom=([^&]+)/.exec(url)[1]); calls.owners[denom] = (calls.owners[denom] || 0) + 1;
      if (opts.ownersFail === denom) throw new Error('HTTP 503');
      let list = owners(denom); if (opts.dropOwner) list = list.filter(o => o.address !== opts.dropOwner);
      return { denom_owners: list, pagination: { next_key: null } };
    }
    if (url.includes('/supply/by_denom')) { const d = decodeURIComponent(/denom=([^&]+)/.exec(url)[1]); return { amount: { denom: d, amount: u(d === F.FUEL_NEUTRON ? NATIVE : TERRA_SUPPLY) } }; }
    if (url.includes('/balances/') && url.includes('by_denom')) { const a = /balances\/([^/]+)\//.exec(url)[1]; const v = a === F.BOOST_CORE ? TREAS : a === F.BOOST_VOTING ? MODULE_BANK : a === ESCROW ? TERRA_SUPPLY : 0; return { balance: { amount: u(v) } }; }
    if (url.includes('/denom_traces/')) return { denom_trace: { path: 'transfer/channel-229', base_denom: F.FUEL_NEUTRON } };
    if (url.includes('/channels/channel-229/ports/transfer')) return { channel: { counterparty: { channel_id: 'channel-25' } } };
    if (url.includes('/channels/channel-25/ports/transfer/escrow_address')) { if (opts.noEscrow) throw new Error('HTTP 501'); return { escrow_address: ESCROW }; }
    throw new Error('mock unhandled ' + url);
  }
  return { fetchJson, terraLcdBase: 'https://terra.mock', neutronLcdBase: 'https://neutron.mock', catalogPools: [{ name: 'LUNA-FUEL', dex: 'Astroport', architecture: { pair_address: TERRA_PAIR }, underlyings: [F.FUEL_TERRA_IBC, 'uluna'] }], calls };
}
module.exports = { makeWorld, STK, W, TERRA_PAIR, ESCROW, NATIVE, TREAS, POWER, TERRA_SUPPLY, neutronLiquid, terraLiquid };
if (require.main !== module) return;

(async () => {
  console.log('=== fuel-supply gate — scenario A (probe fixture, everything answers) ===');
  const world = makeWorld();
  const { doc, wallets: Wf } = await M.captureFuelSupply(world);
  check('A1 status ok, 5/5 guards', doc.status === 'ok' && Object.values(doc.sum_guards).every(g => g.ok === true), { s: doc.status, g: doc.sum_guards, e: doc.query_errors });
  check('A2 neutron level: native 99,859,353.300701 · staked 16,055,799.122882 · 46 non-zero stakers counted as 47 rows incl. the 0-power one · treasury 42,438,782 · bridged 21M', near(doc.neutron.native_supply, NATIVE) && near(doc.neutron.boost_staked, POWER) && doc.neutron.boost_stakers === 47 && near(doc.neutron.boost_treasury, TREAS) && near(doc.neutron.bridged_to_terra, TERRA_SUPPLY), doc.neutron);
  check('A3 liquid_derived closes the native supply exactly', near(doc.neutron.liquid_derived, NATIVE - POWER - 1000 - TREAS - TERRA_SUPPLY, 1e-3), doc.neutron.liquid_derived);
  check('A4 unbonding = Σ claims (1,000) and module bank guard closes', near(doc.neutron.boost_unbonding, 1000) && doc.sum_guards.boost_module_bank_eq_power_plus_claims.ok === true);
  check('A5 terra level: ibc supply == Σ owners == neutron escrow (cross-chain guard)', near(doc.terra.ibc_supply, TERRA_SUPPLY) && doc.sum_guards.terra_ibc_supply_eq_neutron_escrow.ok === true);
  const row = (a) => Wf.rows.find(r => r.address === a);
  const s1 = row(STK[1]);
  check('A6 staker row: neutron chain, wallet, boost_staked 53,447 + unbonding 1,000, no liquid', s1 && s1.chain === 'neutron' && s1.kind === 'wallet' && near(s1.fuel.boost_staked, 53447) && near(s1.fuel.boost_unbonding, 1000) && s1.fuel.liquid === 0, s1);
  check('A7 0-power staker with nothing else folds into the tail, not a row', !row(STK[2]) && Wf.tail_below_floor.count >= 1);
  const core = row(F.BOOST_CORE), vm = row(F.BOOST_VOTING), es = row(ESCROW), pair = row(TERRA_PAIR), mgr = row(F.TLA_INCENTIVE_MANAGER);
  check('A8 buckets labeled: treasury (DAO name from chain), voting module, escrow (channel), catalog pair, TLA incentive manager', core && core.role === 'bucket' && /Boost DAO treasury/.test(core.label) && vm && vm.role === 'bucket' && es && /channel-25/.test(es.label) && pair && /Astroport pair LUNA-FUEL/.test(pair.label) && mgr && mgr.role === 'bucket', [core && core.label, es && es.label, pair && pair.label]);
  check('A9 terra holder rows carry chain terra; the 6.48M bribes wallet published, the 500-FUEL neutron wallet in tail', row('terra1' + 'w'.repeat(38)).chain === 'terra' && !row(W(302)) && row(W(300)).total_fuel === 12000000);
  const colSum = (k) => Wf.rows.filter(r => r.chain === 'neutron' && r.role !== 'bucket').reduce((s, r) => s + (r.fuel[k] || 0), 0) + Wf.tail_below_floor.fuel[k] * 0;
  check('A10 counts reconcile: holders = rows + tail', Wf.counts.holders_enumerated === Wf.counts.rows_published + Wf.counts.tail_below_floor, Wf.counts);
  check('A11 kindOf: 20-byte account vs 32-byte contract on both prefixes', M._kindOf(F.BOOST_CORE) === 'contract' && M._kindOf(STK[0]) === 'wallet' && M._kindOf(TERRA_PAIR) === 'contract' && M._kindOf(F.TLA_INCENTIVE_MANAGER) === 'contract' && M._kindOf('terra1hr8zsfpch47qygc96c8e6rzkd2t7mafqx77ulw') === 'wallet');

  console.log('\n=== scenario B (Neutron owners walk fails → liquid unknown, status partial, other guards intact) ===');
  const { doc: dB, wallets: WB } = await M.captureFuelSupply(makeWorld({ ownersFail: F.FUEL_NEUTRON }));
  check('B1 partial; neutron owners guard incomplete; stakers guard still ok', dB.status === 'partial' && dB.sum_guards.neutron_owners_sum_to_native_supply.enumeration === 'incomplete' && dB.sum_guards.boost_stakers_sum_to_total_power.ok === true, dB.sum_guards);
  check('B2 neutron rows liquid null, terra rows liquid known; columns_unknown lists liquid', WB.rows.find(r => r.address === STK[1]).fuel.liquid === null && WB.rows.find(r => r.address === TERRA_PAIR).fuel.liquid === 8301522 && WB.columns_unknown.includes('liquid'));
  check('B3 liquid_derived still computed from the bucket reads (no owners needed) — owners guard is the cross-check', typeof dB.neutron.liquid_derived === 'number');

  console.log('\n=== scenario C (escrow lookup unavailable → bridged null, cross guard suspended, status partial) ===');
  const { doc: dC } = await M.captureFuelSupply(makeWorld({ noEscrow: true }));
  check('C1 bridged null, liquid_derived null (cannot derive without it), cross guard ok=null, status partial', dC.neutron.bridged_to_terra === null && dC.neutron.liquid_derived === null && dC.sum_guards.terra_ibc_supply_eq_neutron_escrow.ok === null && dC.status === 'partial' && /501/.test(JSON.stringify(dC.query_errors)) && dC.sources.escrow.channel === 'channel-25');

  console.log('\n=== scenario D (a Neutron holder missing from the walk → guard FAILS loud) ===');
  const { doc: dD } = await M.captureFuelSupply(makeWorld({ dropOwner: W(300) }));   // 12M holder (a 3K holder sits inside the 0.01% band by design — mid-walk transfers are that size)
  check('D1 guard_failed naming neutron_owners_sum_to_native_supply', dD.status === 'guard_failed' && dD.guard_failures[0] === 'neutron_owners_sum_to_native_supply');

  console.log('\n=== index ===');
  const i1 = M.upsertIndex(null, doc); const i2 = M.upsertIndex(i1, { ...doc, capturedAt: '2026-08-25T01:00:00.000Z' });
  check('E1 index rows append per date, refuse failed read', i2.row_count === 2 && near(i2.rows[0].boost_staked, POWER) && (() => { try { M.upsertIndex(undefined, doc); return false; } catch (e) { return /never-shrink/.test(e.message); } })());

  console.log(`\n=== MOCK GATE: ${PASS} passed, ${FAIL} failed ===`);
  process.exit(FAIL ? 1 : 0);
})().catch(e => { console.error('GATE CRASH:', e); process.exit(1); });
