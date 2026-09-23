#!/usr/bin/env node
// ally-positions/mock-holders.js — drives holders.js with a stubbed transport. Real fixtures: tenants.json (roster, receiver,
// pyROAR cw20, ROAR20 mint), trusted-addresses.json. SHAPE fixtures (cw20 / cosmos-sdk / Helius DAS schemas, marked values):
// a 235-account pyROAR ledger (8 pages of 30 + a short page; treasury, receiver, one contract, wallets), a 1,500-owner ROAR20
// set over 2 DAS pages (two program-owned vaults, the rest wallets). Every gate is arithmetic on the fixture, never a literal.
// Usage: TLA_CORE_DIR=<tla-core> node ally-positions/mock-holders.js
'use strict';
const fs = require('fs'); const path = require('path'); const https = require('https');
const CORE = process.env.TLA_CORE_DIR; if (!CORE) { console.error('TLA_CORE_DIR required'); process.exit(1); }
process.env.TENANT = process.env.TENANT || 'liondao'; process.env.HELIUS_API_KEY = 'mock';
const J = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const T = J(path.join(CORE, 'docs/curated/tenants.json')).tenants[process.env.TENANT];
const PY = T.burn.pyroar_cw20, RECEIVER = T.burn.festival_receiver, TREASURY = Object.keys(T.wallets).find(a => T.wallets[a].counts_as === 'treasury'), STAKING = T.staking.roar_staking;
const CORE_U = 'https://raw.githubusercontent.com/thealliancedao/tla-core/main/';
// ---- pyROAR fixture: 235 accounts; amounts in raw (6 dp). Total supply = Σ (the gate must read 0).
const pad = (i) => 'terra1mock' + String(i).padStart(4, '0') + 'x'.repeat(28);
const PYACC = {}; PYACC[TREASURY] = 6240000000000; PYACC[RECEIVER] = 100000000000000; PYACC[STAKING] = 1000000000; PYACC['terra1mockcontract' + 'c'.repeat(23)] = 250000000000000;
for (let i = 0; i < 231; i++) PYACC[pad(i)] = i === 0 ? 1400000000000000 : Math.round(500000000000 * Math.pow(0.97, i)) + (i % 7 === 0 ? 0 : 1);
PYACC[pad(230)] = 0;   // one zero-balance account (a wallet that sent everything on)
const PY_ACCOUNTS = Object.keys(PYACC).sort(); const PY_TOTAL = Object.values(PYACC).reduce((t, v) => t + v, 0);
const CONTRACTS = new Set([RECEIVER, STAKING, 'terra1mockcontract' + 'c'.repeat(23)].concat(T.roar_pools.map(p => p.address)));
// ---- ROAR20 fixture: 1,500 owners; two vaults program-owned
const SOL = []; const owner = (i) => 'SoLmock' + String(i).padStart(5, '0') + 'a'.repeat(30);
const VAULT_A = 'VauLtA' + 'p'.repeat(38), VAULT_B = 'VauLtB' + 'q'.repeat(38), PROG_A = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', PROG_B = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
SOL.push({ address: 'acctA', owner: VAULT_A, amount: 400000000000000 }); SOL.push({ address: 'acctB', owner: VAULT_B, amount: 100000000000000 });
for (let i = 0; i < 1498; i++) SOL.push({ address: 'acct' + i, owner: owner(i), amount: Math.round(5000000000000 * Math.pow(0.99, i)) + 1 });
SOL.push({ address: 'acctDup', owner: owner(3), amount: 1000000 });   // a second account for one owner (folds)
{ const w = SOL.filter(a => a.owner !== VAULT_A && a.owner !== VAULT_B).reduce((t, a) => t + a.amount, 0); SOL[0].amount = Math.round(w * 0.8); SOL[1].amount = w - SOL[0].amount; }   // vaults = exactly half the supply
const SOL_TOTAL = SOL.reduce((t, a) => t + a.amount, 0);
// ---- transport stubs
const calls = []; const ok = (o) => ({ ok: true, status: 200, json: async () => o, text: async () => JSON.stringify(o) }); const nf = { ok: false, status: 404, json: async () => ({}), text: async () => 'not found' };
const b64q = (u) => { try { return JSON.parse(Buffer.from(u.split('/smart/')[1].split('?')[0], 'base64').toString()); } catch (e) { return null; } };
// ---- ROAR whales fixtures (1.1.0): stakers, the cw20's holders, ampROAR owners, the hub state, three pairs with LP tokens, participants + a price
const ROAR = T.staking.roar_cw20, STK = T.staking.roar_staking, HUB = T.staking.amproar_hub, AMPD = T.staking.amproar_denom; const PAIRS = T.roar_pools.map(p => p.address); const LPTOK = Object.fromEntries(PAIRS.map((a, i) => [a, 'terra1' + ('lptok' + i).repeat(12).slice(0, 58)]));
const wl = (i) => 'terra1' + ('whale' + i).repeat(8).slice(0, 38);
const STAKERS = {}; for (let i = 0; i < 70; i++) STAKERS[wl(i)] = Math.round(4e15 * Math.pow(0.9, i));
const ROARBAL = {}; for (let i = 0; i < 95; i++) ROARBAL[wl(i + 20)] = Math.round(2e15 * Math.pow(0.93, i)); ROARBAL[PAIRS[0]] = 75e15; ROARBAL[TREASURY] = 298e15;
const AMPOWN = {}; for (let i = 0; i < 40; i++) AMPOWN[wl(i * 2)] = Math.round(1e15 * Math.pow(0.9, i));
const XR = '1.190476';
const LPHOLD = {}; PAIRS.forEach((a, k) => { LPHOLD[a] = {}; for (let i = 0; i < 12; i++) LPHOLD[a][wl(i + 5 + k)] = Math.round(1e12 * Math.pow(0.8, i)); });
const LPTOTAL = Object.fromEntries(PAIRS.map(a => [a, Object.values(LPHOLD[a]).reduce((x, y) => x + y, 0)]));
const POOLROAR = { [PAIRS[0]]: 75e15, [PAIRS[1]]: 6.5e15, [PAIRS[2]]: 3.2e15 };
let LP_FAIL_PAIR = null;
const whaleStub = (url) => {
  if (url.startsWith(CORE_U + 'member-data/participants/')) return ok({ members: [{ wallet: wl(3), lp_positions: [{ pool_name: 'LUNA-ROAR', estimated_position_usd: 2000 }, { pool_name: 'ampROAR-ROAR', estimated_position_usd: 1000 }] }, { wallet: wl(7), lp_positions: [{ pool_name: 'LUNA-USDC', estimated_position_usd: 500 }] }] });
  if (url.startsWith(CORE_U + 'network-and-prices/')) return ok({ token_prices: { ROAR: { final_price_usd: 0.00000035 } } });
  if (url.includes('/cosmos/bank/v1beta1/denom_owners/')) { const owners = Object.entries(AMPOWN); const off = url.includes('pagination.key=') ? Number(decodeURIComponent(url.split('pagination.key=')[1])) : 0; const page = owners.slice(off, off + 1000); return ok({ denom_owners: page.map(([a, u]) => ({ address: a, balance: { denom: AMPD, amount: String(u) } })), pagination: { next_key: off + 1000 < owners.length ? String(off + 1000) : null } }); }
  const m = url.match(/\/cosmwasm\/wasm\/v1\/contract\/([a-z0-9]+)\/smart\//); if (!m) return null; const c = m[1]; const q = b64q(url); if (!q) return null;
  if (c === ROAR) { if (q.token_info) return ok({ data: { name: 'Lion DAO', symbol: 'ROAR', decimals: 6, total_supply: '893210193782000000' } }); if (q.all_accounts) { const keys = Object.keys(ROARBAL).sort(); const from = q.all_accounts.start_after ? keys.indexOf(q.all_accounts.start_after) + 1 : 0; return ok({ data: { accounts: keys.slice(from, from + 30) } }); } if (q.balance) return ok({ data: { balance: String(ROARBAL[q.balance.address] || 0) } }); }
  if (c === STK) { if (q.list_stakers) { const keys = Object.keys(STAKERS).sort(); const from = q.list_stakers.start_after ? keys.indexOf(q.list_stakers.start_after) + 1 : 0; return ok({ data: { stakers: keys.slice(from, from + 30).map(a => ({ address: a, balance: String(STAKERS[a]) })) } }); } if (q.total_staked_at_height) return ok({ data: { total: Object.values(STAKERS).reduce((x, y) => x + BigInt(y), 0n).toString(), height: '1' } }); }
  if (c === HUB && q.state) return ok({ data: { total_ustake: '84000000000000000', total_utoken: '100000000000000000', exchange_rate: XR } });
  if (PAIRS.includes(c)) { if (q.pool) return ok({ data: { assets: [{ info: { token: { contract_addr: ROAR } }, amount: String(POOLROAR[c]) }, { info: { native_token: { denom: 'uluna' } }, amount: '1000000000' }], total_share: String(LPTOTAL[c]) } }); if (q.pair) return ok({ data: { asset_infos: [], contract_addr: c, liquidity_token: LPTOK[c] } }); }
  const lpPair = Object.keys(LPTOK).find(a => LPTOK[a] === c); if (lpPair) { if (LP_FAIL_PAIR === lpPair) return nf; if (q.all_accounts) { const keys = Object.keys(LPHOLD[lpPair]).sort(); const from = q.all_accounts.start_after ? keys.indexOf(q.all_accounts.start_after) + 1 : 0; return ok({ data: { accounts: keys.slice(from, from + 30) } }); } if (q.balance) return ok({ data: { balance: String(LPHOLD[lpPair][q.balance.address] || 0) } }); }
  return null; };
global.fetch = async (url) => { url = String(url); calls.push(url); { const ws = whaleStub(url); if (ws) return ws; }
  if (url.startsWith(CORE_U)) { const f = path.join(CORE, url.slice(CORE_U.length).split('?')[0]); return fs.existsSync(f) ? ok(J(f)) : nf; }
  const m = url.match(/\/cosmwasm\/wasm\/v1\/contract\/([a-z0-9]+)(\/smart\/)?/);
  if (m && !m[2]) return CONTRACTS.has(m[1]) ? ok({ address: m[1], contract_info: { code_id: '1', creator: 'terra1x', label: m[1].startsWith('terra1mockcontract') ? 'astroport-pair pyROAR-ROAR' : 'mock' } }) : nf;
  if (m && m[1] === PY) { const q = b64q(url);
    if (q.token_info) return ok({ data: { name: 'Burnt ROAR', symbol: 'pyROAR', decimals: 6, total_supply: String(PY_TOTAL) } });
    if (q.all_accounts) { const lim = q.all_accounts.limit; const from = q.all_accounts.start_after ? PY_ACCOUNTS.indexOf(q.all_accounts.start_after) + 1 : 0; return ok({ data: { accounts: PY_ACCOUNTS.slice(from, from + lim) } }); }
    if (q.balance) return ok({ data: { balance: String(PYACC[q.balance.address] != null ? PYACC[q.balance.address] : 0) } }); }
  return nf; };
const rpcCalls = [];
https.request = (opts, cb) => { const chunks = []; return { on() { return this; }, write(b) { chunks.push(b); }, end() { const body = JSON.parse(chunks.join('')); rpcCalls.push(body.method); let result;
  if (opts.hostname === 'mainnet.helius-rpc.com') {
    if (body.method === 'getTokenSupply') result = { context: { slot: 1 }, value: { amount: String(SOL_TOTAL), decimals: 6, uiAmount: SOL_TOTAL / 1e6, uiAmountString: String(SOL_TOTAL / 1e6) } };
    if (body.method === 'getTokenAccounts') { const p = body.params; const from = p.cursor ? Number(p.cursor) : 0; const page = SOL.slice(from, from + p.limit); result = { total: SOL.length, limit: p.limit, cursor: from + p.limit < SOL.length ? String(from + p.limit) : undefined, token_accounts: page.map(a => ({ address: a.address, mint: T.roar20.mint, owner: a.owner, amount: a.amount, delegated_amount: 0, frozen: false })) }; }
    if (body.method === 'getMultipleAccounts') result = { context: { slot: 1 }, value: body.params[0].map(o => o === VAULT_A ? { owner: PROG_A, executable: false, lamports: 1, data: ['', 'base64'] } : o === VAULT_B ? { owner: PROG_B, executable: false, lamports: 1, data: ['', 'base64'] } : (o.endsWith('a'.repeat(30)) && Number(o.slice(7, 12)) % 5 === 0 ? null : { owner: '11111111111111111111111111111111', executable: false, lamports: 1, data: ['', 'base64'] })) };
  }
  const res = { statusCode: 200, on(ev, f) { if (ev === 'data') f(JSON.stringify({ jsonrpc: '2.0', id: 'holders', result })); if (ev === 'end') f(); } }; cb(res); } }; };
const H = require('./holders.js');
let pass = 0, fail = 0; const ok2 = (m, c, x) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (x !== undefined ? ' → ' + JSON.stringify(x).slice(0, 300) : '')); } };
(async () => {
  const res = await H.run(['pyroar', 'roar20']);
  console.log('— pyROAR (burn/holders)');
  const P = res.products.pyroar; ok2('product written, no errors', P && res.errors.length === 0, res.errors);
  ok2(`all_accounts walked whole: ${PY_ACCOUNTS.length} accounts over ${Math.ceil(PY_ACCOUNTS.length / 30)} pages (30 per page, start_after)`, P.account_count === PY_ACCOUNTS.length && calls.filter(u => u.includes('/smart/') && (b64q(u) || {}).all_accounts).length === Math.ceil(PY_ACCOUNTS.length / 30), [P.account_count, calls.filter(u => (b64q(u) || {}).all_accounts).length]);
  ok2(`holder_count = non-zero accounts (${PY_ACCOUNTS.length - 1}); one zero-balance account counted apart`, P.holder_count === PY_ACCOUNTS.length - 1 && P.zero_balance_accounts === 1, [P.holder_count, P.zero_balance_accounts]);
  ok2('supply gate Δ = 0 EXACT (raw integers, not floats): token_info.total_supply − Σ balances', P.supply_gate.delta === 0 && P.supply_gate.delta_raw === '0' && P.supply_gate.exact && Math.abs(P.token.total_supply - PY_TOTAL / 1e6) < 1e-6, P.supply_gate);
  ok2('ranked by amount; #1 is the 1.4B wallet with its share', P.holders[0].amount === 1400000000 && P.holders[0].rank === 1 && Math.abs(P.holders[0].share_pct - 1400000000 / (PY_TOTAL / 1e6) * 100) < 1e-9, P.top10[0]);
  const tr = P.holders.find(h => h.address === TREASURY), rc = P.holders.find(h => h.address === RECEIVER), st = P.holders.find(h => h.address === STAKING);
  ok2('names from the registry: treasury = roster (label from tenants.json), receiver = "Festival receiver (Enterprise core)", staking module = contract named by staking.<key>', tr.kind === 'roster' && tr.label === T.wallets[TREASURY].label && rc.kind === 'receiver' && st.kind === 'contract' && /roar staking/.test(st.label) && tr.kind_source === 'registry', [tr, rc, st].map(h => h.label + '/' + h.kind));
  const mc = P.holders.find(h => h.address.startsWith('terra1mockcontract'));
  ok2('an unnamed contract in the top 60 is marked contract BY THE CHAIN (contract-info 200) and takes the chain\'s label; a wallet by the chain\'s 404', mc.kind === 'contract' && /chain/.test(mc.kind_source) && mc.label === 'astroport-pair pyROAR-ROAR' && mc.label_source === 'chain: contract_info.label' && P.holders[0].kind === 'wallet' && /chain/.test(P.holders[0].kind_source), [mc.kind, mc.label, P.holders[0].kind_source]);
  ok2('1.0.2 top10_wallets excludes contracts and the receiver (burners are wallets); concentration carries top1_wallet_pct + contracts_pct', P.top10_wallets.every(h => h.kind !== 'contract' && h.kind !== 'receiver') && P.top10_wallets[0].address === P.holders[0].address && Math.abs(P.concentration.contracts_pct - P.kinds.contract.amount / P.token.total_supply * 100) < 1e-9 && P.concentration.top1_wallet_pct === P.holders[0].share_pct, [P.top10_wallets.slice(0, 2), P.concentration]);
  ok2(`only the top ${H.TOP_CLASSIFY} are asked: rank ${H.TOP_CLASSIFY + 5} is 'unclassified' with the reason; contract-info calls ≤ ${H.TOP_CLASSIFY}`, P.holders[H.TOP_CLASSIFY + 4].kind === 'unclassified' && /unverified/.test(P.holders[H.TOP_CLASSIFY + 4].kind_source) && calls.filter(u => /\/cosmwasm\/wasm\/v1\/contract\/[a-z0-9]+$/.test(u)).length <= H.TOP_CLASSIFY, calls.filter(u => /\/cosmwasm\/wasm\/v1\/contract\/[a-z0-9]+$/.test(u)).length);
  ok2('kinds sum to the total (roster + receiver + contract + wallet + unclassified = Σ)', Math.abs(Object.values(P.kinds).reduce((t, k) => t + k.amount, 0) - P.supply_gate.sum_of_balances) < 1e-6, P.kinds);
  ok2('concentration: top1 / top10 / top50 pct as arithmetic on the ranked list', Math.abs(P.concentration.top10_pct - P.holders.slice(0, 10).reduce((t, h) => t + h.share_pct, 0)) < 1e-9 && P.concentration.top50_pct > P.concentration.top10_pct, P.concentration);
  ok2('no reported figure anywhere in the product (chain facts only)', !/reported|tweet|x\.com/i.test(JSON.stringify(P)));
  console.log('— ROAR20 (roar20/holders)');
  const R = res.products.roar20; ok2('product written', !!R);
  ok2('DAS walk: 2 pages of 1,000, cursor carried; token accounts folded to owners (one owner with 2 accounts)', rpcCalls.filter(m => m === 'getTokenAccounts').length === 2 && R.token_account_count === SOL.length && R.holder_count === SOL.length - 1 && R.holders.find(h => h.owner === owner(3)).accounts === 2, [rpcCalls, R.token_account_count, R.holder_count]);
  ok2('supply gate Δ = 0 EXACT (raw integers): getTokenSupply − Σ token accounts', R.supply_gate.delta === 0 && R.supply_gate.delta_raw === '0' && Math.abs(R.token.supply - SOL_TOTAL / 1e6) < 1e-6, R.supply_gate);
  ok2('the two vaults are program-owned BY THE CHAIN with their program ids recorded (no name invented)', R.holders[0].kind === 'program' && R.holders[0].owner_program === PROG_A && R.holders[1].kind === 'program' && R.holders[1].owner_program === PROG_B && !/raydium|pump/i.test(JSON.stringify(R.holders.slice(0, 2))), R.holders.slice(0, 2));
  ok2('a System-Program-owned owner is a wallet; an owner with no account record is a wallet too, with that reason', R.holders[2].kind === 'wallet' && R.holders.slice(2, H.TOP_CLASSIFY).some(h => /no account record/.test(h.kind_source)) && R.holders.slice(2, H.TOP_CLASSIFY).every(h => h.kind === 'wallet'), R.holders.slice(2, 6).map(h => h.kind_source));
  ok2(`beyond the top ${H.TOP_CLASSIFY}: unclassified with the reason`, R.holders[H.TOP_CLASSIFY + 1].kind === 'unclassified');
  ok2('breakdown: program-owned 50 % of supply · wallets + unclassified the rest; top10_wallets excludes the vaults', Math.abs(R.concentration.program_owned_pct - 50) < 1e-6 && R.top10_wallets.every(w => w.owner !== VAULT_A && w.owner !== VAULT_B) && Math.abs(R.kinds.program.amount + R.kinds.wallet.amount + R.kinds.unclassified.amount - R.supply_gate.sum_of_balances) < 1e-6, [R.concentration, R.kinds.program]);
  ok2('getMultipleAccounts asked once for the top 60 (one chunk)', rpcCalls.filter(m => m === 'getMultipleAccounts').length === 1, rpcCalls);
  console.log('— ROAR whales (roar/holders)');
  const res3 = await H.run(['roar']); const R3 = res3.products.roar; ok2('product written', !!R3 && res3.errors.length === 0, res3.errors);
  const C3 = R3.columns; ok2('every column read: staked (list_stakers walked, 3 pages) · liquid (cw20 walked whole) · ampROAR (denom_owners × exchange rate) · TLA-amp LP (participants ≈) · plain LP (3 pairs)', C3.staked.ok && C3.liquid.ok && C3.amp.ok && C3.lp_amp.ok && C3.lp_plain.ok && calls.filter(u => (b64q(u) || {}).list_stakers).length === 3, Object.fromEntries(Object.entries(C3).map(([k, v]) => [k, v.ok || v.reason])));
  ok2('staked gate: Σ list_stakers = the module total (Δ 0, EXACT on raw integers)', C3.staked.gate_delta === 0 && C3.staked.gate_delta_raw === '0' && C3.staked.exact && C3.staked.module_total > 0, C3.staked);
  const w0 = R3.holders.find(h => h.address === wl(0)); const w20 = R3.holders.find(h => h.address === wl(20)); const w3 = R3.holders.find(h => h.address === wl(3));
  ok2('one wallet, six columns: whale0 staked 4B · liquid 0 · ampROAR 1B units → 1.19B ROAR · no LP → total = the sum', Math.abs(w0.staked - 4e9) < 1 && w0.liquid === 0 && Math.abs(w0.amp_units - 1e9) < 1 && Math.abs(w0.amp - 1e9 * Number(XR)) < 1 && w0.lp_amp === 0 && w0.lp_plain === 0 && Math.abs(w0.total - (4e9 + 1e9 * Number(XR))) < 1, w0);
  ok2('whale20: liquid 2B (cw20) + staked (rank 20) + ampROAR (even index) — and the TLA-amp column is 0 for a non-participant', Math.abs(w20.liquid - 2e9) < 1 && w20.staked > 0 && w20.amp > 0 && w20.lp_amp === 0, w20);
  ok2('whale3: ROAR in TLA-amplified LP ≈ (2000 + 1000) × ½ ÷ 0.00000035 = ' + Math.round(3000 * 0.5 / 0.00000035).toLocaleString() + ' ROAR (a derivation, the column says so)', Math.abs(w3.lp_amp - 3000 * 0.5 / 0.00000035) < 1 && C3.lp_amp.derived === true && /derivation/.test(C3.lp_amp.source), [w3.lp_amp, C3.lp_amp.source]);
  const w5 = R3.holders.find(h => h.address === wl(5)); const share0 = LPHOLD[PAIRS[0]][wl(5)] / LPTOTAL[PAIRS[0]] * POOLROAR[PAIRS[0]] / 1e6 + (LPHOLD[PAIRS[1]][wl(5)] || 0) / LPTOTAL[PAIRS[1]] * POOLROAR[PAIRS[1]] / 1e6 + (LPHOLD[PAIRS[2]][wl(5)] || 0) / LPTOTAL[PAIRS[2]] * POOLROAR[PAIRS[2]] / 1e6;
  ok2('whale5: ROAR in plain LP = Σ over pairs of (LP share × the pool\'s ROAR) = ' + Math.round(share0).toLocaleString(), Math.abs(w5.lp_plain - share0) < 1e-3 && C3.lp_plain.pairs.length === 3 && C3.lp_plain.pairs.every(p => p.lp_token.startsWith('terra1lptok')), [w5.lp_plain, share0]);
  ok2('the pair contract and the treasury rank as holders too, marked by kind (contract / roster) — never hidden', R3.holders.some(h => h.address === PAIRS[0] && h.liquid === 75e9 && h.kind === 'contract') && R3.holders.some(h => h.address === TREASURY && h.kind === 'roster'), R3.holders.filter(h => h.kind !== 'wallet' && h.kind !== 'unclassified').map(h => [h.address.slice(0, 12), h.kind]));
  ok2('ranked by total; sums per column over EVERY wallet seen (before the 1M floor); concentration of total_supply; beyond the top 40 the kind is unclassified with the reason', R3.holders.every((h, i) => i === 0 || h.total <= R3.holders[i - 1].total) && R3.sums.total > 0 && Math.abs(R3.sums.staked - C3.staked.sum) < 1e-6 && R3.wallets_seen >= R3.holder_count && R3.concentration.of === 'total_supply' && R3.holders.slice(40).every(h => h.kind === 'unclassified' || h.kind === 'roster'), [R3.sums, R3.wallets_seen, R3.holder_count]);
  { LP_FAIL_PAIR = PAIRS[1]; const r = await H.run(['roar']); LP_FAIL_PAIR = null; const c = r.products.roar.columns.lp_plain;
    ok2('one pair\'s LP walk fails → the plain-LP column keeps the other pairs and NAMES the missing one as partial (never a silent zero for it)', c.ok && c.partial && c.partial.length === 1 && /ROAR-ampROAR/.test(c.partial[0]) && c.pairs.length === 2, c.partial); }
  console.log('— failure modes');
  const save = global.fetch; global.fetch = async (u) => { const q = b64q(String(u)); if (q && q.balance && q.balance.address === pad(5)) return nf; return save(u); };
  const r2 = await H.run(['pyroar']); ok2('one failed balance read → NO product (a partial sum is not a gate), the error names it', !r2.products.pyroar && /balance reads failed/.test(r2.errors[0].reason), r2.errors);
  global.fetch = save; delete process.env.HELIUS_API_KEY;
  const r3 = await (async () => { const H2 = { run: null }; delete require.cache[require.resolve('./holders.js')]; process.env.HELIUS_API_KEY = ''; return require('./holders.js').run(['roar20']); })();
  ok2('no HELIUS_API_KEY → no ROAR20 product, reason says so', !r3.products.roar20 && /HELIUS_API_KEY/.test(r3.errors[0].reason), r3.errors);
  fs.mkdirSync('out', { recursive: true }); fs.writeFileSync('out/holders-mock-burn.json', JSON.stringify(P, null, 1)); fs.writeFileSync('out/holders-mock-roar20.json', JSON.stringify(R, null, 1)); fs.writeFileSync('out/holders-mock-roar.json', JSON.stringify(R3, null, 1));
  console.log(`${pass} passed, ${fail} failed · out/holders-mock-*.json`); process.exit(fail ? 1 : 0);
})().catch(e => { console.error('✗', e); process.exit(1); });
