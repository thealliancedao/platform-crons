// =============================================================================
// mock-run-capa-supply.js — BINDING gate for token-catalog/capa-supply.js
// =============================================================================
// Drives the LIVE module (no-third-copy) with a stubbed transport. Fixture
// values are the FIRST LIVE PUBLISH of v1.1 (2026-08-24T16:21Z current.json)
// plus the probe-v2 per-wallet fixture from SPEC-capa-supply-map.md (owner:
// gov balance 1,141,021.59 / share 1,140,715.28, DAO power 3,214,853.997,
// claim 357,205.9996; treasury: liquid 5,387.458905, receipt 198,310.643,
// astroLP receipt 3,821.188, non-amp CAPA-LUNA LP 18,411.23).
//
// The mock world is CONSISTENT BY CONSTRUCTION: every contract total the
// module guards against is the sum of the per-holder entries the mock serves,
// so a green run proves the module's decoders + sums + guards; the failure
// scenarios prove null-vs-0 and the guard trip paths.
//
// Run: node mock-run-capa-supply.js   (exit 1 on any failure)
'use strict';
const path = require('path');
const M = require(path.join(__dirname, 'capa-supply.js'));
const C = M.CAPA_CONTRACTS;

let PASS = 0, FAIL = 0;
const check = (name, ok, extra) => { if (ok) { PASS++; console.log('  ✓ ' + name); } else { FAIL++; console.log('  ✗ ' + name + (extra != null ? '  ← ' + JSON.stringify(extra) : '')); } };
const near = (a, b, tol = 1e-6) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= Math.max(tol, Math.abs(b) * 1e-9);
const u = (x) => String(Math.round(x * 1e6));   // micro-units as the chain serializes them

// ---- bech32 DECODE (test-only helper, to build gov "bank" keys from real addresses) ----
const B32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
function bech32Decode(addr) {
  const pos = addr.lastIndexOf('1'); const data = [...addr.slice(pos + 1)].map(c => B32.indexOf(c)).slice(0, -6);
  let acc = 0, bits = 0; const out = [];
  for (const d of data) { acc = (acc << 5) | d; bits += 5; while (bits >= 8) { bits -= 8; out.push((acc >> bits) & 255); } }
  return Buffer.from(out);
}
const hex = (s) => Buffer.from(s, 'utf8').toString('hex');
const len2 = (s) => Buffer.from(s, 'utf8').length.toString(16).padStart(4, '0');
const b64 = (v) => Buffer.from(JSON.stringify(v)).toString('base64');
const cw20Key = (addr) => '000762616c616e6365' + hex(addr);
const govKey  = (addr) => '000462616e6b' + bech32Decode(addr).toString('hex');
const ve3Key  = (user, kind, id) => '0006736861726573' + len2(user) + hex(user) + len2(kind) + hex(kind) + hex(id);

// ---- fixture world ----
const OWNER = 'terra1hr8zsfpch47qygc96c8e6rzkd2t7mafqx77ulw';
const TREAS = 'terra1sffd4efk2jpdt894r04qwmtjqrrjfc52tmj6vkzjxqhd8qqu2drs3m5vzm';
const INCENTIVES = 'terra1eywh4av8sln6r45pxq45ltj798htfy0cfcf7fy3pxc2gcv6uc07se4ch9x';
const W = (n) => M._decoders.bech32Encode('terra', Buffer.alloc(20, n));   // VALID bech32 20-byte accounts (gov keys round-trip through encode)

const R = { hub: 1.1055377425634347, comp: 2.0469874912831303, astroRcpt: 5.693496323052123, ssRcpt: 2.2172198948598365 };
// v1.1 live publish totals (2026-08-24T16:21Z)
const V1 = {
  capa_supply: 500000000, gov_contract_balance: 175718344.357478, gov_hub_portion: 157305486.561168,
  in_hub: 157166661.603185, astro_capa: 23702033.156161, astro_lp_supply: 3970879.163138, ss_capa: 163226.687157, ss_lp_supply: 27035.837097,
  ampcapa_supply: 142163090.007908, single_total: 120905091.879156, comp_single: 45738934.553329,
  astro_staked: 3647415.352633, astro_amp: 622685.539252, ss_staked: 2396.587344, ss_amp: 2298.005578,
  rcpt_amp_supply: 22345491.46432, dao_power: 15491461.357498,
};
// gov rate: from the SPEC owner fixture balance/share
const GOV_RATE = 1141021.59 / 1140715.28;
const HUB_SHARE = V1.gov_hub_portion / GOV_RATE;
// ve3 pool per-share (post-take amount per share) — pick realistic ratios
const PS = { single: 0.92, astro: 0.87, ss: 0.9 };
const SHARES_TOTAL = { single: V1.single_total / PS.single, astro: V1.astro_staked / PS.astro, ss: V1.ss_staked / PS.ss };
const COMP_SHARES  = { single: V1.comp_single / PS.single, astro: V1.astro_amp / PS.astro, ss: V1.ss_amp / PS.ss };

// per-holder raw entries (units: CAPA / shares / receipts / LP, not micro)
const H = {};
const at = (a) => (H[a] || (H[a] = {}));
// owner (SPEC fixture): gov + DAO + claim only
at(OWNER).gov_share = 1140715.28; at(OWNER).dao_power = 3214853.997; at(OWNER).claims = [357205.9996];
// treasury (SPEC fixture)
at(TREAS).capa = 5387.458905; at(TREAS).rcpt_amp = 198310.643; at(TREAS).rcpt_astro = 3821.188; at(TREAS).astro_shares = 18411.23 / PS.astro;
// whales, one per form
at(W(1)).capa = 0;                       // set below as the cw20 remainder
at(W(2)).gov_share = (V1.gov_contract_balance - V1.gov_hub_portion - 1141021.59) / GOV_RATE; at(W(2)).claims = [];   // closes gov Σ(shares×rate) == contract balance
at(W(3)).ampcapa = 15000000; at(W(3)).claims = [];
at(W(4)).rcpt_amp = 6000000; at(W(4)).claims = [100000];
at(W(5)).single_shares = 30000000 / PS.single; at(W(5)).claims = [];
at(W(6)).astro_lp = 10000;
at(W(7)).ss_shares = 50; at(W(7)).ss_lp = 20;
at(W(8)).rcpt_ss = 30; at(W(8)).rcpt_astro = 1000;
at(W(9)).dao_power = 2000000; at(W(9)).claims = [];
// filler below the floor
for (let i = 10; i < 15; i++) { at(W(i)).capa = 500; at(W(i)).ampcapa = 100; at(W(i)).claims = []; }
// contracts
at(C.CAPA_GOV).capa = V1.gov_contract_balance; at(C.ASTRO_PAIR).capa = V1.astro_capa; at(C.SS_PAIR).capa = V1.ss_capa;
at(C.AMPCAPA_HUB).gov_share = HUB_SHARE;
at(C.VE3_COMPOUNDER).single_shares = COMP_SHARES.single; at(C.VE3_COMPOUNDER).astro_shares = COMP_SHARES.astro; at(C.VE3_COMPOUNDER).ss_shares = COMP_SHARES.ss;
at(INCENTIVES).astro_lp = V1.astro_staked + 5000;    // TLA-staked LP forwarded here + 5,000 LP of direct Astroport stakers (unattributable by construction)
// derived remainders so the world reconciles exactly
const sum = (k) => Object.values(H).reduce((s, h) => s + (h[k] || 0), 0);
at(W(1)).capa = V1.capa_supply - sum('capa');                                              // cw20 Σ == supply
const GOV_TOTAL_SHARE = sum('gov_share');
at(W(5)).single_shares += SHARES_TOTAL.single - sum('single_shares');                       // Σ single shares == pool shares
at(W(6)).astro_shares = SHARES_TOTAL.astro - sum('astro_shares');                           // Σ astro shares == pool shares
at(W(7)).ss_shares += SHARES_TOTAL.ss - sum('ss_shares');
at(W(6)).astro_lp += V1.astro_lp_supply - sum('astro_lp');                                  // Σ LP cw20 == LP supply
// ampCAPA owners: supply = liquid holders + TLA single bucket contract holding
at(C.TLA_STAKE_SINGLE).ampcapa = V1.single_total; at(W(3)).ampcapa += V1.ampcapa_supply - sum('ampcapa');
// receipt owners: DAO module holds power + Σ claims; supply closes on W4
const CLAIMS_SUM = Object.values(H).reduce((s, h) => s + (h.claims || []).reduce((a, b) => a + b, 0), 0);
at(C.AMPCAPA_DAO_VOTE).rcpt_amp = V1.dao_power + CLAIMS_SUM; at(W(4)).rcpt_amp += V1.rcpt_amp_supply - sum('rcpt_amp');
const RCPT_ASTRO_SUPPLY = sum('rcpt_astro'), RCPT_SS_SUPPLY = sum('rcpt_ss');
at(C.TLA_STAKE_PROJECT).ss_lp = V1.ss_staked; at(W(7)).ss_lp += V1.ss_lp_supply - sum('ss_lp');
at(W(9)).dao_power += V1.dao_power - sum('dao_power');

// ---- transport stub ----
function makeWorld(opts = {}) {
  const calls = { state: {}, owners: {}, claims: 0 };
  const paginate = (items, keyParam, limit, url) => {
    const m = /pagination\.key=([^&]+)/.exec(url); const start = m ? Number(decodeURIComponent(m[1])) : 0;
    const page = items.slice(start, start + limit); const next = start + limit < items.length ? String(start + limit) : null;
    return { page, next };
  };
  const stateModels = (addr) => {
    const out = [];
    for (const [a, h] of Object.entries(H)) {
      if (addr === C.CAPA_TOKEN && h.capa != null) out.push({ key: cw20Key(a), value: b64(u(h.capa)) });
      if (addr === C.CAPA_GOV && h.gov_share != null) out.push({ key: govKey(a).toUpperCase(), value: b64({ share: u(h.gov_share), locked_balance: [] }) });   // mixed-case hex as the API serves it
      if (addr === C.TLA_STAKE_SINGLE && h.single_shares != null) out.push({ key: ve3Key(a, 'native:', C.AMPCAPA_DENOM), value: b64(u(h.single_shares)) });
      if (addr === C.TLA_STAKE_PROJECT && h.astro_shares != null) out.push({ key: ve3Key(a, 'cw20:', C.ASTRO_LP), value: b64(u(h.astro_shares)) });
      if (addr === C.TLA_STAKE_PROJECT && h.ss_shares != null) out.push({ key: ve3Key(a, 'native:', C.SS_LP_DENOM), value: b64(u(h.ss_shares)) });
      if (addr === C.ASTRO_LP && h.astro_lp != null) out.push({ key: cw20Key(a), value: b64(u(h.astro_lp)) });
    }
    // noise: other namespaces / other assets in the same contracts
    out.push({ key: hex('token_info'), value: b64({ total_supply: '1' }) });
    out.push({ key: ve3Key(W(1), 'cw20:', 'terra1otherlp'), value: b64('123') });
    out.push({ key: '0004706f6c6c' + '00000001', value: b64({ id: 1 }) });
    return out;
  };
  const ownersOf = (denom) => {
    const f = { [C.AMPCAPA_DENOM]: 'ampcapa', [C.AMPLP_AMPCAPA]: 'rcpt_amp', [C.AMPLP_ASTRO_LP]: 'rcpt_astro', [C.AMPLP_SS_LP]: 'rcpt_ss', [C.SS_LP_DENOM]: 'ss_lp' }[denom];
    return Object.entries(H).filter(([, h]) => h[f] != null).map(([a, h]) => ({ address: a, balance: { denom, amount: u(h[f]) } }));
  };
  const supplyOf = (denom) => ({ [C.AMPCAPA_DENOM]: V1.ampcapa_supply, [C.AMPLP_AMPCAPA]: V1.rcpt_amp_supply, [C.AMPLP_ASTRO_LP]: RCPT_ASTRO_SUPPLY, [C.AMPLP_SS_LP]: RCPT_SS_SUPPLY, [C.SS_LP_DENOM]: V1.ss_lp_supply }[denom]);
  const asset = (info, amount, shares) => ({ asset: { info, amount: u(amount) }, shares: u(shares) });
  const ampInfo = { native: C.AMPCAPA_DENOM }, astroInfo = { cw20: C.ASTRO_LP }, ssInfo = { native: C.SS_LP_DENOM };

  async function queryContract(addr, msg) {
    const k = Object.keys(msg)[0];
    if (addr === C.CAPA_TOKEN && k === 'token_info') return { total_supply: u(V1.capa_supply) };
    if (addr === C.CAPA_TOKEN && k === 'balance') return { balance: u(H[msg.balance.address] && H[msg.balance.address].capa || 0) };
    if (addr === C.AMPCAPA_HUB && k === 'state') return { exchange_rate: String(R.hub), total_utoken: u(V1.in_hub), total_ustake: u(V1.ampcapa_supply) };
    if (addr === C.CAPA_GOV && k === 'staker') { const h = H[msg.staker.address] || {}; const sh = h.gov_share || 0; return { balance: u(sh * GOV_RATE), share: u(sh), locked_balance: [] }; }
    if (addr === C.CAPA_GOV && k === 'state') return { poll_count: 1, total_share: u(GOV_TOTAL_SHARE), total_deposit: '0' };
    if (addr === C.ASTRO_PAIR && k === 'pool') return { assets: [{ info: { token: { contract_addr: C.CAPA_TOKEN } }, amount: u(V1.astro_capa) }, { info: { native_token: { denom: 'uluna' } }, amount: u(1000) }], total_share: u(V1.astro_lp_supply) };
    if (addr === C.ASTRO_LP && k === 'token_info') return { total_supply: u(V1.astro_lp_supply) };
    if (addr === C.SS_PAIR && k === 'pool') return { assets: [{ info: { token: { contract_addr: C.CAPA_TOKEN } }, amount: u(V1.ss_capa) }, { info: { native_token: { denom: 'uluna' } }, amount: u(7) }], total_share: u(V1.ss_lp_supply) };
    if (addr === C.VE3_COMPOUNDER && k === 'amplp_exchange_rates') return { exchange_rates: [[C.AMPLP_AMPCAPA, String(R.comp)], [C.AMPLP_ASTRO_LP, String(R.astroRcpt)], [C.AMPLP_SS_LP, String(R.ssRcpt)]] };
    if (addr === C.AMPCAPA_DAO_VOTE && k === 'total_power_at_height') return { power: u(V1.dao_power), height: 1 };
    if (addr === C.TLA_STAKE_SINGLE && k === 'total_staked_balances') return [asset(ampInfo, V1.single_total, SHARES_TOTAL.single), asset({ cw20: 'terra1xastro' }, 5, 5)];
    if (addr === C.TLA_STAKE_PROJECT && k === 'total_staked_balances') return [asset(astroInfo, V1.astro_staked, SHARES_TOTAL.astro), asset(ssInfo, V1.ss_staked, SHARES_TOTAL.ss)];
    if (addr === C.TLA_STAKE_SINGLE && k === 'all_staked_balances') return [asset(ampInfo, V1.comp_single, COMP_SHARES.single)];
    if (addr === C.TLA_STAKE_PROJECT && k === 'all_staked_balances') return [asset(astroInfo, V1.astro_amp, COMP_SHARES.astro), asset(ssInfo, V1.ss_amp, COMP_SHARES.ss)];
    if (addr === C.AMPCAPA_DAO_VOTE && k === 'list_stakers') {
      const all = Object.entries(H).filter(([, h]) => h.dao_power != null).map(([a, h]) => ({ address: a, balance: u(h.dao_power) })).sort((x, y) => x.address < y.address ? -1 : 1);
      const { limit, start_after } = msg.list_stakers; const i = start_after ? all.findIndex(s => s.address === start_after) + 1 : 0;
      return { stakers: all.slice(i, i + limit) };
    }
    if (addr === C.AMPCAPA_DAO_VOTE && k === 'claims') {
      calls.claims++;
      if (opts.claimsFailFor === msg.claims.address) return null;
      const h = H[msg.claims.address] || {};
      return { claims: (h.claims || []).map(a => ({ amount: u(a), release_at: { at_time: '1756123200000000000' } })) };
    }
    throw new Error('mock: unhandled query ' + addr.slice(0, 14) + ' ' + k);
  }
  async function fetchJson(url) {
    if (url.includes('/contract/') && url.includes('/state?')) {
      const addr = /contract\/([^/]+)\/state/.exec(url)[1];
      calls.state[addr] = (calls.state[addr] || 0) + 1;
      if (opts.stateFailAt && opts.stateFailAt.addr === addr && calls.state[addr] === opts.stateFailAt.page) throw new Error('HTTP 503 mock');
      const { page, next } = paginate(stateModels(addr), 'pagination.key', 100, url);
      return { models: page, pagination: { next_key: next } };
    }
    if (url.includes('denom_owners_by_query')) {
      const denom = decodeURIComponent(/denom=([^&]+)/.exec(url)[1]);
      calls.owners[denom] = (calls.owners[denom] || 0) + 1;
      const { page, next } = paginate(ownersOf(denom), 'pagination.key', 500, url);
      return { denom_owners: page, pagination: { next_key: next } };
    }
    if (url.includes('/supply/by_denom')) { const denom = decodeURIComponent(/denom=([^&]+)/.exec(url)[1]); return { amount: { denom, amount: u(supplyOf(denom)) } }; }
    if (url.includes('/balances/') && url.includes('by_denom')) return { balance: { amount: '0' } };
    throw new Error('mock: unhandled url ' + url);
  }
  return { queryContract, fetchJson, lcdBase: 'https://mock.lcd', calls };
}

// Exported so the SITE gate (aDAO-links-site/gate-ampcapa-whales.mjs) can derive
// its wallets.json fixture from the LIVE module on this same world — one truth.
module.exports = { makeWorld, OWNER, TREAS, W, V1, R, GOV_RATE };
if (require.main !== module) return;

(async () => {
  console.log('=== capa-supply gate — decoders ===');
  const D = M._decoders;
  check('bech32 round-trip (owner address)', D.bech32Encode('terra', bech32Decode(OWNER)) === OWNER);
  check('cw20 balance key decodes (utf8 addr)', D.decodeCw20BalanceKey(cw20Key(TREAS)) === TREAS);
  check('cw20 balance key rejects other namespace', D.decodeCw20BalanceKey(hex('token_info')) === null);
  check('gov bank key decodes (mixed-case hex, 20-byte)', D.decodeGovBankKey(govKey(OWNER).toUpperCase()) === OWNER);
  check('gov key rejects non-bank namespace', D.decodeGovBankKey('0004706f6c6c00000001') === null);
  const k = D.decodeVe3SharesKey(ve3Key(TREAS, 'cw20:', C.ASTRO_LP));
  check('ve3 shares key decodes user + asset (cw20)', k && k.user === TREAS && k.asset === 'cw20:' + C.ASTRO_LP);
  const k2 = D.decodeVe3SharesKey(ve3Key(W(5), 'native:', C.AMPCAPA_DENOM));
  check('ve3 shares key decodes native factory asset', k2 && k2.user === W(5) && k2.asset === 'native:' + C.AMPCAPA_DENOM);

  console.log('\n=== v1.1 collection map on the fixture world ===');
  const world = makeWorld();
  const doc = await M.captureCapaSupply(world);
  check('v1.1 status ok, no guard failures', doc.status === 'ok' && doc.guard_failures.length === 0, { status: doc.status, g: doc.guard_failures, n: doc.null_buckets, e: doc.query_errors });
  check('v1.1 liquid_derived = supply − gov_direct − hub − astro − ss', near(doc.capa.liquid_derived, V1.capa_supply - (V1.gov_contract_balance - V1.gov_hub_portion) - V1.in_hub - V1.astro_capa - V1.ss_capa, 1e-3), doc.capa.liquid_derived);
  check('v1.1 gov_staked_direct 18,412,857.796', near(doc.capa.gov_staked_direct, 18412857.79631, 1e-3), doc.capa.gov_staked_direct);
  check('v1.1 lp_nonamp astro = staked − comp entry', near(doc.capa.in_lp.astro.lp_nonamp, V1.astro_staked - V1.astro_amp, 1e-6));
  check('v1.1 ampcapa liquid = supply − single total', near(doc.ampcapa.liquid, V1.ampcapa_supply - V1.single_total, 1e-6));

  console.log('\n=== v2.0 per-wallet rows — scenario A (everything answers) ===');
  const { doc: doc2, wallets: Wf } = await M.captureCapaWallets(world, doc);
  check('A1 status ok', Wf.status === 'ok', { status: Wf.status, g: Wf.guard_failures, inc: Wf.incomplete_enumerations, e: Wf.query_errors });
  const failedGuards = Object.entries(Wf.sum_guards).filter(([, v]) => v.ok !== true);
  check('A2 all 13 sum guards ok', Object.keys(Wf.sum_guards).length === 13 && failedGuards.length === 0, failedGuards.map(([k, v]) => [k, v.sum, v.expected, v.ok]));
  check('A3 current.json → schemaVersion 2 with wallets summary, sum_guards_ok', doc2.schemaVersion === 2 && doc2.wallets && doc2.wallets.sum_guards_ok === true && doc2.wallets.file === 'wallets.json');
  const row = (a) => Wf.rows.find(r => r.address === a);
  const o = row(OWNER);
  check('A4 owner row: gov_direct 1,141,021.59 (share × hub-derived rate)', o && near(o.capa_equiv.gov_direct, 1141021.59, 1e-2), o && o.capa_equiv.gov_direct);
  check('A5 owner row: receipt_dao = 3,214,853.997 × comp × hub', o && near(o.capa_equiv.receipt_dao, 3214853.997 * R.comp * R.hub, 1e-3), o && o.capa_equiv.receipt_dao);
  check('A6 owner row: receipt_unbonding = 357,205.9996 × comp × hub (claims read, not remainder)', o && near(o.capa_equiv.receipt_unbonding, 357205.9996 * R.comp * R.hub, 1e-3), o && o.capa_equiv.receipt_unbonding);
  check('A7 owner row: every other form is exactly 0, kind wallet, label null', o && o.kind === 'wallet' && o.label === null && ['capa_liquid', 'ampcapa_liquid', 'ampcapa_tla_nonamp', 'receipt_held', 'astro_lp_liquid', 'astro_lp_tla_nonamp', 'astro_lp_amp', 'ss_lp_liquid', 'ss_lp_tla_nonamp', 'ss_lp_amp'].every(c => o.capa_equiv[c] === 0));
  const t = row(TREAS);
  check('A8 treasury row: liquid 5,387.458905', t && near(t.capa_equiv.capa_liquid, 5387.458905, 1e-6));
  check('A9 treasury row: receipt_held = 198,310.643 × comp × hub', t && near(t.capa_equiv.receipt_held, 198310.643 * R.comp * R.hub, 1e-3));
  check('A10 treasury row: astro_lp_tla_nonamp = 18,411.23 LP × CAPA/LP (shares × pool per-share)', t && near(t.capa_equiv.astro_lp_tla_nonamp, 18411.23 * doc.rates.capa_per_astro_lp, 1e-3), t && t.capa_equiv.astro_lp_tla_nonamp);
  check('A11 treasury row: astro_lp_amp = 3,821.188 rcpt × LP/rcpt × CAPA/LP', t && near(t.capa_equiv.astro_lp_amp, 3821.188 * R.astroRcpt * doc.rates.capa_per_astro_lp, 1e-3));
  check('A12 treasury raw shares kept (audit trail)', t && near(t.raw.astro_shares, 18411.23 / PS.astro, 1e-6) && near(t.raw.rcpt_amp, 198310.643, 1e-6));
  const hub = row(C.AMPCAPA_HUB), comp = row(C.VE3_COMPOUNDER), daoM = row(C.AMPCAPA_DAO_VOTE), inc = row(INCENTIVES), pair = row(C.ASTRO_PAIR);
  check('A13 hub is a contract row, role bucket, labeled; gov_direct = hub portion', hub && hub.kind === 'contract' && hub.role === 'bucket' && hub.label === 'ampCAPA hub' && near(hub.capa_equiv.gov_direct, V1.gov_hub_portion, 1e-2));
  check('A13b aDAO treasury (a DAODAO core, 32-byte) is kind contract but role null — a HOLDER, counted toward enumerated/floor, label null', t && t.kind === 'contract' && t.role === null && t.label === null && Wf.counts.contracts_published === 1);
  check('A14 compounder contract row carries the amp shares (single/astro/ss)', comp && comp.kind === 'contract' && near(comp.capa_equiv.ampcapa_tla_nonamp, V1.comp_single * R.hub, 1e-3) && near(comp.raw.ss_shares, COMP_SHARES.ss, 1e-6));
  check('A15 DAO module contract row holds power + Σ claims in receipts', daoM && near(daoM.raw.rcpt_amp, V1.dao_power + CLAIMS_SUM, 1e-6));
  check('A16 Astroport pair + Incentives are labeled contract rows', pair && pair.label === 'Astroport CAPA-LUNA pair' && inc && inc.label === 'Astroport Incentives');
  check('A17 unattributed: LP in Incentives beyond TLA = 5,000 LP (direct Astroport stakers, labeled not invented)', near(Wf.unattributed.astro_lp_in_incentives_not_tla, 5000, 1e-6), Wf.unattributed);
  check('A18 unattributed: receipt_unbonding_unattributed = 0 (claims sweep closed the module holding)', near(Wf.unattributed.receipt_unbonding_unattributed, 0, 1e-6), Wf.unattributed);
  // floor + tail
  const walletRows = Wf.rows.filter(r => r.role !== 'bucket');
  check('A19 five filler wallets fold into tail_below_floor (count 5), none published', Wf.tail_below_floor.count === 5 && !walletRows.some(r => r.address === W(10)), Wf.tail_below_floor.count);
  check('A20 tail sums per column (5 × 500 CAPA liquid, 5 × 100 ampCAPA × hub)', near(Wf.tail_below_floor.capa_equiv.capa_liquid, 2500, 1e-6) && near(Wf.tail_below_floor.capa_equiv.ampcapa_liquid, 500 * R.hub, 1e-6));
  check('A21 every published wallet row ≥ floor and rows sorted desc', walletRows.every(r => r.total_capa_equiv >= M.WALLET_FLOOR_CAPA) && Wf.rows.every((r, i) => i === 0 || Wf.rows[i - 1].total_capa_equiv >= r.total_capa_equiv));
  check('A22 counts reconcile: enumerated = published + tail', Wf.counts.wallets_enumerated === Wf.counts.rows_published + Wf.counts.tail_below_floor, Wf.counts);
  // per-column reconciliation: rows + tail + contracts == bucket totals
  const colSum = (c) => Wf.rows.reduce((s, r) => s + (r.capa_equiv[c] || 0), 0) + Wf.tail_below_floor.capa_equiv[c];
  check('A23 Σ capa_liquid over rows+tail+contracts == 500M supply', near(colSum('capa_liquid'), V1.capa_supply, 1e-3), colSum('capa_liquid'));
  check('A24 Σ gov_direct (incl. hub contract row) == gov contract balance; gov_balance_beyond_shares ≈ 0', near(colSum('gov_direct'), V1.gov_contract_balance, 1e-1) && Math.abs(Wf.unattributed.gov_balance_beyond_shares) < 0.1, [colSum('gov_direct'), Wf.unattributed]);
  check('A25 Σ ampcapa_tla_nonamp (incl. compounder) == single total × hub', near(colSum('ampcapa_tla_nonamp'), V1.single_total * R.hub, 1e-2));
  check('A26 Σ receipt_held (incl. DAO module) + nothing else == receipt supply × comp × hub', near(colSum('receipt_held'), V1.rcpt_amp_supply * R.comp * R.hub, 1e-2));
  check('A27 claims queried only for the ampCAPA orbit (not pure-CAPA holders): W1/W6/W7 not queried', Wf.counts.claims_queried === world.calls.claims && !Wf.rows.some(r => [W(1), W(6), W(7)].includes(r.address) && r.raw.claims !== undefined), Wf.counts);
  check('A28 columns list is the 13-form contract, columns_unknown empty', Wf.columns.length === 13 && Wf.columns_unknown.length === 0);
  check('A29 gov rate published from the hub\'s own books', near(Wf.rates.gov_capa_per_share, GOV_RATE, 1e-9));
  check('A30 state walks paginate (CAPA cw20 needed 1 page; project bucket walked)', world.calls.state[C.CAPA_TOKEN] >= 1 && world.calls.state[C.TLA_STAKE_PROJECT] >= 1);

  console.log('\n=== scenario B (CAPA cw20 state walk dies on page 1 → column unknown, never 0) ===');
  const worldB = makeWorld({ stateFailAt: { addr: C.CAPA_TOKEN, page: 1 } });
  const docB = await M.captureCapaSupply(worldB);
  const { doc: doc2B, wallets: WB } = await M.captureCapaWallets(worldB, docB);
  check('B1 status partial (not ok, not guard_failed)', WB.status === 'partial', WB.status);
  check('B2 capa guard reports enumeration incomplete with the error, ok=null', WB.sum_guards.capa_cw20_sums_to_supply.enumeration === 'incomplete' && WB.sum_guards.capa_cw20_sums_to_supply.ok === null && /503/.test(WB.sum_guards.capa_cw20_sums_to_supply.error));
  check('B3 capa_liquid is NULL on every row (unknown), other columns intact', WB.rows.every(r => r.capa_equiv.capa_liquid === null) && WB.rows.find(r => r.address === OWNER).capa_equiv.receipt_dao > 0);
  check('B4 columns_unknown lists capa_liquid', WB.columns_unknown.length === 1 && WB.columns_unknown[0] === 'capa_liquid');
  check('B5 current.json summary reflects sum_guards_ok false + incomplete list', doc2B.wallets.sum_guards_ok === false && doc2B.wallets.incomplete_enumerations[0] === 'capa_cw20_sums_to_supply');
  check('B6 other 12 guards still ok', Object.entries(WB.sum_guards).filter(([k]) => k !== 'capa_cw20_sums_to_supply').every(([, v]) => v.ok === true));

  console.log('\n=== scenario C (one claims query fails → that cell null, module guard suspended, status partial) ===');
  const worldC = makeWorld({ claimsFailFor: W(4) });
  const docC = await M.captureCapaSupply(worldC);
  const { wallets: WC } = await M.captureCapaWallets(worldC, docC);
  check('C1 status partial, claims_failed 1', WC.status === 'partial' && WC.counts.claims_failed === 1, WC.counts);
  check('C2 W4 receipt_unbonding null (not 0); owner still 357,206 × rates', WC.rows.find(r => r.address === W(4)).capa_equiv.receipt_unbonding === null && near(WC.rows.find(r => r.address === OWNER).capa_equiv.receipt_unbonding, 357205.9996 * R.comp * R.hub, 1e-3));
  check('C3 module-holding guard ok=null (cannot assert with a failed claim)', WC.sum_guards.dao_module_holding_eq_power_plus_claims.ok === null);

  console.log('\n=== scenario D (a real drift: a receipt owner missing → guard FAILS loud) ===');
  const worldD = makeWorld();
  const origFetch = worldD.fetchJson;
  worldD.fetchJson = async (url) => { const r = await origFetch(url); if (url.includes('denom_owners_by_query') && url.includes(encodeURIComponent(C.AMPLP_AMPCAPA))) r.denom_owners = r.denom_owners.filter(o => o.address !== W(4)); return r; };
  const docD = await M.captureCapaSupply(worldD);
  const { wallets: WD } = await M.captureCapaWallets(worldD, docD);
  check('D1 status guard_failed naming the receipt guard', WD.status === 'guard_failed' && WD.guard_failures.includes('receipt_ampcapa_owners_sum_to_supply'), WD.guard_failures);
  check('D2 guard carries sum vs expected for the decode', WD.sum_guards.receipt_ampcapa_owners_sum_to_supply.sum < WD.sum_guards.receipt_ampcapa_owners_sum_to_supply.expected);

  console.log('\n=== index.json row series (pure) ===');
  const idx1 = M.upsertIndex(null, doc2);
  check('E1 first row from empty', idx1.row_count === 1 && idx1.rows[0].date === doc2.capturedAt.slice(0, 10) && near(idx1.rows[0].capa_in_hub, V1.in_hub, 1e-6) && idx1.rows[0].wallets_published === Wf.counts.rows_published);
  const idx2 = M.upsertIndex(idx1, { ...doc2, capturedAt: doc2.capturedAt.slice(0, 10) + 'T23:00:00.000Z' });
  check('E2 same-date upsert replaces, row_count stays 1', idx2.row_count === 1 && idx2.rows[0].capturedAt.endsWith('T23:00:00.000Z'));
  const idx3 = M.upsertIndex(idx2, { ...doc2, capturedAt: '2026-08-25T00:30:00.000Z' });
  check('E3 next day appends, sorted, date_range', idx3.row_count === 2 && idx3.date_range.to === '2026-08-25' && idx3.rows[1].date === '2026-08-25');
  let threw = 0; try { M.upsertIndex(undefined, doc2); } catch (e) { if (/never-shrink/.test(e.message)) threw++; }
  try { M.upsertIndex({ garbage: true }, doc2); } catch (e) { if (/corrupt/.test(e.message)) threw++; }
  check('E4 never-shrink: a failed or corrupt read of the committed index REFUSES (absent=null starts fresh, undefined/corrupt throw)', threw === 2);

  console.log('\n=== v2.1 compact per-wallet daily + fold helpers ===');
  const { walletsDaily: DY } = await M.captureCapaWallets(world, doc);
  check('F1 daily row for the owner = [total, receipt_dao] matching wallets.json', Array.isArray(DY.rows[OWNER]) && near(DY.rows[OWNER][0], o.total_capa_equiv, 1e-6) && near(DY.rows[OWNER][1], o.capa_equiv.receipt_dao, 1e-6), DY.rows[OWNER]);
  check('F2 buckets absent from the daily; DAO staker below floor is PRESENT (W9-style) and filler is absent', !DY.rows[C.AMPCAPA_HUB] && !DY.rows[C.VE3_COMPOUNDER] && !!DY.rows[W(9)] && !DY.rows[W(10)]);
  check('F3 daily carries date/src/rates/columns/row_count', DY.date === doc.capturedAt.slice(0, 10) && DY.src === 'capture' && near(DY.rates.hub_capa_per_ampcapa, R.hub) && DY.columns[1] === 'receipt_dao_capa' && DY.row_count === Object.keys(DY.rows).length);
  const worldB2 = makeWorld({ stateFailAt: { addr: C.CAPA_TOKEN, page: 1 } });   // fresh world: the fail trigger is call-counted, worldB already consumed it
  const { walletsDaily: WDB } = await M.captureCapaWallets(worldB2, await M.captureCapaSupply(worldB2));
  check('F4 incomplete enumeration → daily total is null (unknown), receipt_dao still known (6-dp rounded)', WDB.rows[OWNER][0] === null && near(WDB.rows[OWNER][1], o.capa_equiv.receipt_dao, 1e-5));
  const leg = M.legacyIndexRow({ date: '2026-08-09', capturedAt: '2026-08-09T23:50:33.283Z', hub_rate: 1.1055, receipt_in_dao: 15828086.3, src: 'legacy_fold ampcapa-data_2026 epoch-197' });
  check('F5 legacy index row has the SAME keys as a captured row, other fields null, status legacy_fold', JSON.stringify(Object.keys(leg).filter(k => k !== 'src').sort()) === JSON.stringify(Object.keys(M.indexRowOf(doc2)).sort()) && leg.capa_liquid === null && leg.status === 'legacy_fold');
  const f1 = M.foldIndexRows(idx3, [leg, M.legacyIndexRow({ date: idx3.rows[0].date, capturedAt: 'x', hub_rate: 9, receipt_in_dao: 9, src: 'legacy' })]);
  check('F6 fold adds only missing dates (1 added, 1 skipped); the captured row is byte-untouched', f1.added === 1 && f1.skipped === 1 && f1.doc.row_count === 3 && JSON.stringify(f1.doc.rows.find(r => r.date === idx3.rows[0].date)) === JSON.stringify(idx3.rows[0]) && f1.doc.rows[0].date === '2026-08-09');
  let thr = 0; try { M.foldIndexRows(undefined, [leg]); } catch (e) { thr++; } try { M.foldIndexRows({ nope: 1 }, [leg]); } catch (e) { thr++; }
  check('F7 fold refuses failed/corrupt reads (never-shrink)', thr === 2);
  const d1 = M.upsertDailyIndex(null, '2026-08-24', 'capture');
  const d2 = M.upsertDailyIndex(d1.doc, '2026-08-09', 'legacy_fold');
  const d3 = M.upsertDailyIndex(d2.doc, '2026-08-24', 'legacy_fold');
  const d4 = M.upsertDailyIndex(d3.doc, '2026-08-09', 'capture');
  check('F8 daily index: sorted, legacy never demotes a captured day, capture upgrades a legacy day', d2.doc.days[0].date === '2026-08-09' && d3.changed === false && d4.doc.days[0].src === 'capture' && d4.doc.day_count === 2);

  console.log(`\n=== MOCK GATE: ${PASS} passed, ${FAIL} failed ===`);
  process.exit(FAIL ? 1 : 0);
})().catch(e => { console.error('GATE CRASH:', e); process.exit(1); });
