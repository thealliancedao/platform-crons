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
const CONTRACTS = new Set([RECEIVER, STAKING, 'terra1mockcontract' + 'c'.repeat(23)]);
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
global.fetch = async (url) => { url = String(url); calls.push(url);
  if (url.startsWith(CORE_U)) { const f = path.join(CORE, url.slice(CORE_U.length).split('?')[0]); return fs.existsSync(f) ? ok(J(f)) : nf; }
  const m = url.match(/\/cosmwasm\/wasm\/v1\/contract\/([a-z0-9]+)(\/smart\/)?/);
  if (m && !m[2]) return CONTRACTS.has(m[1]) ? ok({ address: m[1], contract_info: { code_id: '1', creator: 'terra1x', label: 'mock' } }) : nf;
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
  ok2('an unnamed contract in the top 60 is marked contract BY THE CHAIN (contract-info 200), a wallet by the chain\'s 404', mc.kind === 'contract' && /chain/.test(mc.kind_source) && P.holders[0].kind === 'wallet' && /chain/.test(P.holders[0].kind_source), [mc.kind, mc.kind_source, P.holders[0].kind_source]);
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
  console.log('— failure modes');
  const save = global.fetch; global.fetch = async (u) => { const q = b64q(String(u)); if (q && q.balance && q.balance.address === pad(5)) return nf; return save(u); };
  const r2 = await H.run(['pyroar']); ok2('one failed balance read → NO product (a partial sum is not a gate), the error names it', !r2.products.pyroar && /balance reads failed/.test(r2.errors[0].reason), r2.errors);
  global.fetch = save; delete process.env.HELIUS_API_KEY;
  const r3 = await (async () => { const H2 = { run: null }; delete require.cache[require.resolve('./holders.js')]; process.env.HELIUS_API_KEY = ''; return require('./holders.js').run(['roar20']); })();
  ok2('no HELIUS_API_KEY → no ROAR20 product, reason says so', !r3.products.roar20 && /HELIUS_API_KEY/.test(r3.errors[0].reason), r3.errors);
  fs.mkdirSync('out', { recursive: true }); fs.writeFileSync('out/holders-mock-burn.json', JSON.stringify(P, null, 1)); fs.writeFileSync('out/holders-mock-roar20.json', JSON.stringify(R, null, 1));
  console.log(`${pass} passed, ${fail} failed · out/holders-mock-*.json`); process.exit(fail ? 1 : 0);
})().catch(e => { console.error('✗', e); process.exit(1); });
