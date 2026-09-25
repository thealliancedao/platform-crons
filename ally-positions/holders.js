#!/usr/bin/env node
/**
 * ally-positions/holders.js — WHO HOLDS THE ALLY'S TOKENS, from the chains, one snapshot a day.
 *   Same folder as the positions engine (crons per ally, one engine); its own entry point so the hourly job stays lean.
 *   1.0.1 (owner): runs INSIDE the hourly positions job (index.js) once the holder products are ≥ 20 h old or missing — no service
 *   of its own; env HELIUS_API_KEY on org-ally-positions-<tenant>. Still runnable alone: `TENANT=<slug> node holders.js`.
 *   Two products, each with its supply gate published:
 *
 *   1. pyROAR — the frozen burn ledger (tenants.json <tenant>.burn.pyroar_cw20): cw20 `all_accounts` (paged, the contract's
 *      own 30-per-page cap) + `balance` per account = the COMPLETE holder list = the burn-festival leaderboard (one pyROAR was
 *      minted per ROAR burned; the festival is over, so the list does not move — but the run re-reads it whole every day).
 *      Names from the tenant roster, the festival receiver, the trust register; a holder that is a contract is marked by the
 *      chain (/cosmwasm/wasm/v1/contract/{addr}), not by pattern. Gate: token_info.total_supply − Σ balances, published.
 *      → <dao>/burn/holders.json (+ daily/<date>.json write-once)
 *
 *   2. ROAR20 — the Solana token (tenants.json <tenant>.roar20.mint): Helius DAS `getTokenAccounts` by mint (paged) folded to
 *      OWNERS; `getTokenSupply` for the total; owners of the top accounts classified by the chain via getMultipleAccounts —
 *      a System-Program-owned (or absent) account is a wallet, anything else is program-owned (a pool vault, a contract) with
 *      the owning program id recorded (pattern ≠ identity: the program id is the fact, "Raydium" would be a name we did not
 *      read). Gate: supply − Σ amounts, published.
 *      → <dao>/roar20/holders.json (+ daily/<date>.json write-once)
 *
 *   Laws: a successful empty read is 0, null is a failed read; a reported figure never enters a product; every number names
 *   its source; a series never rebuilds from a failed read (a failed product is not written — the previous snapshot stands).
 */
'use strict';
const VERSION = '1.1.1';   // 1.1.1 (2026-09-25): fix — the publish log read p.supply_gate.delta, which roar/holders does not have (it is gated per column, not by one supply sum): the throw came AFTER burn + roar20 were written and BEFORE roar/holders.json and the heartbeat, so the heartbeat never moved and every hourly run walked again; the log line reads the gate only when a product has one, and one product's publish failing no longer stops the rest or the heartbeat
//   // 1.1.0 (2026-09-23, owner): duty `roar` — the whale tracker (staked · liquid · ampROAR · TLA-amp LP ≈ · plain LP · total per wallet)   // 1.0.2: contract labels from the chain on pyROAR contract holders; top10_wallets (burners) beside top10
const https = require('https');
const fs = require('fs');
const E = require('../lib/capture-engine.js');

const TENANT = process.env.TENANT || 'liondao';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO || 'thealliancedao/dao-originations';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const OUT_ROOT = process.env.OUT_ROOT || null;
const HELIUS_API_KEY = process.env.HELIUS_API_KEY || null;
const HELIUS_RPC = process.env.HELIUS_RPC || (HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}` : null);
const CORE = 'https://raw.githubusercontent.com/thealliancedao/tla-core/main/';
const LCD = E.TERRA_LCD_PRIMARY;
const TOP_CLASSIFY = 60;   // holders whose kind (wallet / contract) the chain is asked about; the rest are 'unclassified' with a reason

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const sum = (arr) => { let t = 0, any = false; for (const v of arr) if (Number.isFinite(v)) { t += v; any = true; } return any ? t : null; };
const day = () => new Date().toISOString().slice(0, 10);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const b64 = (q) => Buffer.from(JSON.stringify(q)).toString('base64');

async function lcd(p, label) { try { return await E.fetchJson(LCD + p, label || p.slice(0, 40)); } catch (e) { try { return await E.fetchJson(E.TERRA_LCD_FALLBACK + p, label); } catch (e2) { return null; } } }
async function smart(contract, q) { const r = await lcd(`/cosmwasm/wasm/v1/contract/${contract}/smart/${b64(q)}`); return r && r.data !== undefined ? r.data : null; }
async function isContract(addr) { try { const r = await E.fetchJson(LCD + `/cosmwasm/wasm/v1/contract/${addr}`, 'contract-info'); return r && r.contract_info ? { yes: true, label: r.contract_info.label || null, code_id: r.contract_info.code_id || null } : { yes: false }; } catch (e) { return /404|not found|no such contract/i.test(String(e.message)) ? { yes: false } : null; } }   // {yes:false} = the chain said no; null = the read failed

// JSON-RPC over POST (Helius / Solana)
function rpc(url, method, params) {
  return new Promise((resolve, reject) => {
    const u = new URL(url); const body = JSON.stringify({ jsonrpc: '2.0', id: 'holders', method, params });
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 30000 }, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { const j = JSON.parse(d); if (j.error) reject(new Error(`${method}: ${j.error.message || JSON.stringify(j.error)}`)); else resolve(j.result); } catch (e) { reject(new Error(`${method}: bad JSON (${res.statusCode})`)); } }); });
    req.on('timeout', () => { req.destroy(new Error(`${method}: timeout`)); }); req.on('error', reject); req.write(body); req.end();
  });
}

// ---------------------------------------------------------------- naming (roster · receiver · trust register)
function namer(t, trusted) {
  const roster = t.wallets || {}; const reg = (trusted && trusted.addresses) || {};
  return (addr) => {
    if (roster[addr]) return { label: roster[addr].label, kind: 'roster', role: roster[addr].counts_as || roster[addr].role || null };
    if (t.burn && addr === t.burn.festival_receiver) return { label: 'Festival receiver (Enterprise core)', kind: 'receiver', role: null };
    if (t.staking) for (const [k, v] of Object.entries(t.staking)) if (v === addr) return { label: k.replace(/_/g, ' '), kind: 'contract', role: 'registry:staking.' + k };
    if (reg[addr]) return { label: reg[addr].label, kind: reg[addr].type === 'contract' ? 'contract' : 'trust', role: reg[addr].protocol || null };
    return null;
  };
}

// ---------------------------------------------------------------- 1. pyROAR (cw20, complete walk)
async function pyroarHolders(t, nameOf) {
  const cw20 = t.burn && t.burn.pyroar_cw20; if (!cw20) return { product: null, reason: 'tenants.json burn.pyroar_cw20 not set' };
  const info = await smart(cw20, { token_info: {} }); if (!info) return { product: null, reason: 'token_info read failed' };
  const dec = num(info.decimals) != null ? num(info.decimals) : 6; const human = (raw) => { const n = num(raw); return n == null ? null : n / Math.pow(10, dec); };
  // all_accounts: the contract caps a page at 30; walk until a short page
  const accounts = []; let start = null, pages = 0;
  for (;;) { const r = await smart(cw20, { all_accounts: Object.assign({ limit: 30 }, start ? { start_after: start } : {}) }); if (!r || !Array.isArray(r.accounts)) { if (!pages) return { product: null, reason: 'all_accounts read failed on page 1' }; return { product: null, reason: `all_accounts read failed on page ${pages + 1} — a partial list is not a leaderboard` }; }
    pages++; for (const a of r.accounts) accounts.push(a); if (r.accounts.length < 30) break; start = r.accounts[r.accounts.length - 1]; if (pages > 400) return { product: null, reason: 'all_accounts exceeded 400 pages (12,000 accounts) — cap raised on purpose or something is wrong' }; }
  const holders = []; let failed = 0;
  for (let i = 0; i < accounts.length; i++) { const a = accounts[i]; const r = await smart(cw20, { balance: { address: a } }); if (!r || r.balance === undefined) { failed++; continue; } const amt = human(r.balance); holders.push({ address: a, amount: amt, raw: r.balance }); if (i % 20 === 19) await sleep(150); }
  if (failed) return { product: null, reason: `${failed} of ${accounts.length} balance reads failed — a partial sum is not a gate` };
  holders.sort((a, b) => b.amount - a.amount);
  const total = human(info.total_supply); const sigma = sum(holders.map(h => h.amount));
  let sigmaRaw = 0n; for (const h of holders) { try { sigmaRaw += BigInt(String(h.raw)); } catch (e) { /* a non-integer balance would be the contract's own bug; the float sum still stands */ } }
  const gateDeltaRaw = (() => { try { return (BigInt(String(info.total_supply)) - sigmaRaw).toString(); } catch (e) { return null; } })();
  // kind by the chain for the top N; names from the registry for everyone
  for (let i = 0; i < holders.length; i++) { const h = holders[i]; const nm = nameOf(h.address); h.label = nm ? nm.label : null; h.kind = nm ? nm.kind : null; h.role = nm ? nm.role : null; h.share_pct = total > 0 ? h.amount / total * 100 : null; h.rank = i + 1;
    if (!h.kind) { if (i < TOP_CLASSIFY) { const c = await isContract(h.address); h.kind = c && c.yes ? 'contract' : c ? 'wallet' : 'unclassified'; h.kind_source = c == null ? 'contract-info read failed' : 'chain: /cosmwasm/wasm/v1/contract'; if (c && c.yes) { h.contract_label = c.label; h.code_id = c.code_id; if (!h.label && c.label) h.label = c.label; h.label_source = 'chain: contract_info.label'; } } else { h.kind = 'unclassified'; h.kind_source = `only the top ${TOP_CLASSIFY} are asked; a wallet by all odds — unverified`; } } else h.kind_source = 'registry'; }
  const by = (k) => holders.filter(h => h.kind === k);
  const kinds = {}; for (const k of ['roster', 'receiver', 'contract', 'trust', 'wallet', 'unclassified']) kinds[k] = { holders: by(k).length, amount: sum(by(k).map(h => h.amount)) || 0 };
  const nonZero = holders.filter(h => h.amount > 0);
  return { product: {
    product: 'burn/holders', engine: VERSION, tenant: TENANT, capturedAt: new Date().toISOString(), chain: 'phoenix-1',
    token: { cw20, name: info.name || null, symbol: info.symbol || null, decimals: dec, total_supply: total, total_supply_raw: info.total_supply, note: 'one pyROAR per ROAR burned in the festival; minting is closed — this list is the burn leaderboard' },
    source: { accounts: 'cw20 all_accounts (30 per page, walked whole)', balances: 'cw20 balance per account', kinds: `roster / receiver / registry names; wallet-vs-contract from the chain for the top ${TOP_CLASSIFY}` },
    holder_count: nonZero.length, account_count: holders.length, zero_balance_accounts: holders.length - nonZero.length,
    holders: holders, kinds,
    top10: holders.slice(0, 10).map(h => ({ rank: h.rank, address: h.address, label: h.label, kind: h.kind, amount: h.amount, share_pct: h.share_pct })),
    // 1.0.2: the BURNERS are wallets — a contract holding pyROAR (a pool, a treasury) did not burn; the leaderboard's headline is the top wallet
    top10_wallets: holders.filter(h => h.kind !== 'contract' && h.kind !== 'receiver').slice(0, 10).map(h => ({ rank: h.rank, address: h.address, label: h.label, kind: h.kind, amount: h.amount, share_pct: h.share_pct })),
    concentration: { top1_pct: holders[0] ? holders[0].share_pct : null, top10_pct: sum(holders.slice(0, 10).map(h => h.share_pct)), top50_pct: sum(holders.slice(0, 50).map(h => h.share_pct)), top1_wallet_pct: (holders.find(h => h.kind !== 'contract' && h.kind !== 'receiver') || {}).share_pct || null, contracts_pct: total > 0 ? sum(by('contract').map(h => h.amount)) / total * 100 : null },
    supply_gate: { total_supply: total, sum_of_balances: sigma, delta: gateDeltaRaw != null ? Number(gateDeltaRaw) / Math.pow(10, dec) : (total != null && sigma != null ? total - sigma : null), delta_raw: gateDeltaRaw, exact: gateDeltaRaw != null, note: 'the contract\'s total_supply against the sum of every balance read; a non-zero Δ means an account the walk missed or a read that lied' },
  } };
}

// ---------------------------------------------------------------- 2. ROAR20 (Solana, Helius DAS)
async function roar20Holders(t) {
  const mint = t.roar20 && t.roar20.mint; if (!mint) return { product: null, reason: 'tenants.json roar20.mint not set' };
  if (!HELIUS_RPC) return { product: null, reason: 'HELIUS_API_KEY not set — the DAS getTokenAccounts read needs it' };
  let supply; try { supply = await rpc(HELIUS_RPC, 'getTokenSupply', [mint]); } catch (e) { return { product: null, reason: 'getTokenSupply: ' + e.message }; }
  const dec = supply && supply.value ? num(supply.value.decimals) : null; const total = supply && supply.value ? num(supply.value.uiAmount) : null; if (total == null) return { product: null, reason: 'getTokenSupply returned no uiAmount' };
  // every token account for the mint, paged (DAS: limit 1000, cursor)
  const accounts = []; let cursor = null, pages = 0;
  for (;;) { let r; try { r = await rpc(HELIUS_RPC, 'getTokenAccounts', Object.assign({ mint, limit: 1000, displayOptions: { showZeroBalance: false } }, cursor ? { cursor } : {})); } catch (e) { return { product: null, reason: `getTokenAccounts page ${pages + 1}: ${e.message}` }; }
    pages++; const list = (r && r.token_accounts) || []; for (const a of list) accounts.push({ address: a.address, owner: a.owner, raw: a.amount, amount: num(a.amount) != null ? num(a.amount) / Math.pow(10, dec || 0) : null, frozen: !!a.frozen });
    if (!r || !r.cursor || list.length < 1000) break; cursor = r.cursor; if (pages > 200) return { product: null, reason: 'getTokenAccounts exceeded 200 pages' }; await sleep(120); }
  // fold to owners
  const byOwner = new Map(); for (const a of accounts) { const o = byOwner.get(a.owner) || { owner: a.owner, amount: 0, accounts: 0, frozen_accounts: 0 }; o.amount += a.amount || 0; o.accounts++; if (a.frozen) o.frozen_accounts++; byOwner.set(a.owner, o); }
  const holders = [...byOwner.values()].filter(h => h.amount > 0).sort((a, b) => b.amount - a.amount);
  holders.forEach((h, i) => { h.rank = i + 1; h.share_pct = total > 0 ? h.amount / total * 100 : null; h.kind = 'unclassified'; h.kind_source = `only the top ${TOP_CLASSIFY} owners are asked`; });
  // classify the top owners by the chain: System-Program-owned or absent = a wallet; anything else = program-owned (its program id is the fact)
  const SYSTEM = '11111111111111111111111111111111'; const top = holders.slice(0, TOP_CLASSIFY);
  for (let i = 0; i < top.length; i += 100) { const chunk = top.slice(i, i + 100); let r; try { r = await rpc(HELIUS_RPC, 'getMultipleAccounts', [chunk.map(h => h.owner), { encoding: 'base64' }]); } catch (e) { chunk.forEach(h => { h.kind = 'unclassified'; h.kind_source = 'getMultipleAccounts: ' + e.message; }); continue; }
    const vals = (r && r.value) || []; chunk.forEach((h, k) => { const acc = vals[k]; if (!acc || acc.owner === SYSTEM) { h.kind = 'wallet'; h.kind_source = acc ? 'chain: System Program owns the account' : 'chain: no account record (a wallet that never held SOL)'; } else { h.kind = 'program'; h.owner_program = acc.owner; h.executable = !!acc.executable; h.kind_source = 'chain: owned by program ' + acc.owner; } }); }
  const roster = t.roar20 && t.roar20.known_owners || {};   // optional registry labels ({ owner: label }) — none today
  holders.forEach(h => { h.label = roster[h.owner] || null; });
  const by = (k) => holders.filter(h => h.kind === k);
  const kinds = { program: { holders: by('program').length, amount: sum(by('program').map(h => h.amount)) || 0, programs: [...new Set(by('program').map(h => h.owner_program))] }, wallet: { holders: by('wallet').length, amount: sum(by('wallet').map(h => h.amount)) || 0 }, unclassified: { holders: by('unclassified').length, amount: sum(by('unclassified').map(h => h.amount)) || 0 } };
  const sigma = sum(holders.map(h => h.amount));
  let sigmaRaw = 0n; for (const a of accounts) { try { sigmaRaw += BigInt(String(a.raw)); } catch (e) { } }
  const gateDeltaRaw = (() => { try { return (BigInt(String(supply.value.amount)) - sigmaRaw).toString(); } catch (e) { return null; } })();
  return { product: {
    product: 'roar20/holders', engine: VERSION, tenant: TENANT, capturedAt: new Date().toISOString(), chain: 'solana',
    token: { mint, decimals: dec, supply: total, supply_raw: supply.value.amount, minted: t.roar20.supply_minted || t.roar20.supply_fixed || null, note: 'mint authority revoked at create (no new tokens) — supply can still fall by burns; getTokenSupply is the live figure' },
    source: { accounts: 'Helius DAS getTokenAccounts by mint (1000 per page, zero balances skipped), folded to owners', supply: 'getTokenSupply', kinds: `owner account read (getMultipleAccounts) for the top ${TOP_CLASSIFY}: System-Program-owned or absent = wallet; else program-owned with the program id` },
    holder_count: holders.length, token_account_count: accounts.length,
    holders: holders.map(h => ({ rank: h.rank, owner: h.owner, label: h.label, amount: h.amount, share_pct: h.share_pct, accounts: h.accounts, frozen_accounts: h.frozen_accounts, kind: h.kind, owner_program: h.owner_program || null, kind_source: h.kind_source })),
    kinds,
    top10: holders.slice(0, 10).map(h => ({ rank: h.rank, owner: h.owner, label: h.label, kind: h.kind, owner_program: h.owner_program || null, amount: h.amount, share_pct: h.share_pct })),
    top10_wallets: by('wallet').slice(0, 10).map(h => ({ rank: h.rank, owner: h.owner, amount: h.amount, share_pct: h.share_pct })),
    concentration: { top1_pct: holders[0] ? holders[0].share_pct : null, top10_pct: sum(holders.slice(0, 10).map(h => h.share_pct)), top10_wallets_pct: sum(by('wallet').slice(0, 10).map(h => h.share_pct)), program_owned_pct: total > 0 ? kinds.program.amount / total * 100 : null },
    supply_gate: { supply: total, sum_of_balances: sigma, delta: gateDeltaRaw != null ? Number(gateDeltaRaw) / Math.pow(10, dec || 0) : (sigma != null ? total - sigma : null), delta_raw: gateDeltaRaw, exact: gateDeltaRaw != null, note: 'getTokenSupply against the sum of every non-zero token account; a Δ is an account the DAS page walk missed, or supply held in a form the mint\'s token program did not enumerate' },
  } };
}

// ---------------------------------------------------------------- 3. ROAR whales — where every wallet's ROAR is (owner, 2026-09-23)
//   Per wallet, six columns, six sources: staked (staking module `list_stakers`, walked whole) · liquid ROAR (cw20 `all_accounts`
//   walked whole + `balance`) · liquid ampROAR (bank `denom_owners` of the hub's factory denom, walked whole, converted to ROAR at
//   the hub's `state.exchange_rate`) · ROAR in TLA-amplified LP (member-data/participants: each member's ROAR-pool positions,
//   ≈ ROAR = position USD × the pool's ROAR share ÷ ROAR price — a derivation, labeled) · ROAR in plain LP (each registered pair's
//   `pool` + `pair` → LP token; LP token holders walked; ROAR = share × the pool's ROAR) · total. A source that fails leaves its
//   column null for EVERY wallet with the reason on the product — never a zero. Gate: Σ staked vs the module's total, Σ liquid vs
//   the cw20's total_supply less the contracts' own balances is NOT a gate (contracts hold ROAR too) — instead Σ(liquid) is published
//   beside total_supply and the difference named.
async function roarWhales(t, nameOf) {
  const st = t.staking || {}; const cw20 = st.roar_cw20; if (!cw20) return { product: null, reason: 'staking.roar_cw20 not set' };
  const smartOn = (c) => async (q) => { const r = await lcd(`/cosmwasm/wasm/v1/contract/${c}/smart/${b64(q)}`); return r && r.data !== undefined ? r.data : null; };
  const info = await smartOn(cw20)({ token_info: {} }); if (!info) return { product: null, reason: 'ROAR token_info read failed' };
  const dec = num(info.decimals) != null ? num(info.decimals) : 6; const H = (raw) => { const n = num(raw); return n == null ? null : n / Math.pow(10, dec); };
  const W = new Map(); const at = (a) => { let w = W.get(a); if (!w) { w = { address: a, staked: null, liquid: null, amp: null, amp_units: null, lp_amp: null, lp_plain: null }; W.set(a, w); } return w; };
  const cols = {};   // column → { ok, source, reason, sum }
  // --- staked: list_stakers walked whole
  if (st.roar_staking) { const q = smartOn(st.roar_staking); const stakers = []; let start = null, pages = 0, fail = null;
    for (;;) { const r = await q({ list_stakers: Object.assign({ limit: 30 }, start ? { start_after: start } : {}) }); if (!r || !Array.isArray(r.stakers)) { fail = `list_stakers page ${pages + 1} failed`; break; } pages++; r.stakers.forEach(x => stakers.push(x)); if (r.stakers.length < 30) break; start = r.stakers[r.stakers.length - 1].address; if (pages > 2000) { fail = 'list_stakers exceeded 2000 pages'; break; } }
    if (fail) cols.staked = { ok: false, reason: fail, source: 'staking module list_stakers' }; else { stakers.forEach(x => { at(x.address).staked = H(x.balance); }); const tot = await q({ total_staked_at_height: {} }); let sr = 0n; stakers.forEach(x => { try { sr += BigInt(String(x.balance)); } catch (e) { } }); const dr = tot && tot.total != null ? (() => { try { return (BigInt(String(tot.total)) - sr).toString(); } catch (e) { return null; } })() : null; cols.staked = { ok: true, source: 'staking module list_stakers (walked whole)', sum: stakers.reduce((a, x) => a + (H(x.balance) || 0), 0), module_total: tot && tot.total != null ? H(tot.total) : null, gate_delta_raw: dr, gate_delta: dr != null ? Number(dr) / Math.pow(10, dec) : null, exact: dr != null }; } }
  else cols.staked = { ok: false, reason: 'staking.roar_staking not set' };
  // --- liquid ROAR: the cw20 walked whole
  { const q = smartOn(cw20); const accts = []; let start = null, pages = 0, fail = null;
    for (;;) { const r = await q({ all_accounts: Object.assign({ limit: 30 }, start ? { start_after: start } : {}) }); if (!r || !Array.isArray(r.accounts)) { fail = `all_accounts page ${pages + 1} failed`; break; } pages++; r.accounts.forEach(a => accts.push(a)); if (r.accounts.length < 30) break; start = r.accounts[r.accounts.length - 1]; if (pages > 4000) { fail = 'all_accounts exceeded 4000 pages'; break; } }
    if (fail) cols.liquid = { ok: false, reason: fail, source: 'cw20 all_accounts + balance' }; else { let failed = 0, sum = 0; for (let i = 0; i < accts.length; i++) { const r = await q({ balance: { address: accts[i] } }); if (!r || r.balance === undefined) { failed++; continue; } const v = H(r.balance); if (v > 0) { at(accts[i]).liquid = v; sum += v; } if (i % 25 === 24) await sleep(120); } cols.liquid = failed ? { ok: false, reason: `${failed} of ${accts.length} balance reads failed — a partial column is not a column` } : { ok: true, source: 'cw20 all_accounts (walked whole) + balance', accounts: accts.length, sum, total_supply: H(info.total_supply) }; if (cols.liquid.ok) { for (const w of W.values()) if (w.liquid == null) w.liquid = 0; } } }
  // --- liquid ampROAR: bank denom_owners, converted at the hub's exchange rate
  if (st.amproar_denom && st.amproar_hub) { const hs = await smartOn(st.amproar_hub)({ state: {} }); const xr = hs && hs.exchange_rate != null ? Number(hs.exchange_rate) : null; const owners = []; let key = null, pages = 0, fail = null;
    for (;;) { const r = await lcd(`/cosmos/bank/v1beta1/denom_owners/${encodeURIComponent(st.amproar_denom)}?pagination.limit=1000` + (key ? `&pagination.key=${encodeURIComponent(key)}` : '')); if (!r || !Array.isArray(r.denom_owners)) { fail = `denom_owners page ${pages + 1} failed`; break; } pages++; r.denom_owners.forEach(o => owners.push(o)); key = r.pagination && r.pagination.next_key; if (!key) break; if (pages > 200) { fail = 'denom_owners exceeded 200 pages'; break; } }
    if (fail) cols.amp = { ok: false, reason: fail, source: 'bank denom_owners' }; else if (xr == null) cols.amp = { ok: false, reason: 'hub state.exchange_rate not read — ampROAR cannot be expressed in ROAR', source: 'bank denom_owners + hub state' }; else { let sum = 0; owners.forEach(o => { const u = H(o.balance && o.balance.amount); if (u > 0) { const w = at(o.address); w.amp_units = u; w.amp = u * xr; sum += w.amp; } }); for (const w of W.values()) if (w.amp == null) { w.amp = 0; w.amp_units = 0; } cols.amp = { ok: true, source: `bank denom_owners of ${st.amproar_denom.split('/').pop()} (walked whole) × hub exchange_rate ${xr}`, owners: owners.length, exchange_rate: xr, sum }; } }
  else cols.amp = { ok: false, reason: 'staking.amproar_denom / amproar_hub not set' };
  // --- ROAR in TLA-amplified LP: participants product (≈, labeled)
  { const parts = await E.fetchJson(CORE + 'member-data/participants/current.json', 'participants').catch(() => null); const nap = await E.fetchJson(CORE + 'network-and-prices/current.json', 'nap').catch(() => null); const px = nap && nap.token_prices && nap.token_prices.ROAR ? num(nap.token_prices.ROAR.final_price_usd) : null;
    if (!parts || !Array.isArray(parts.members)) cols.lp_amp = { ok: false, reason: 'member-data/participants not read', source: 'participants' }; else if (px == null) cols.lp_amp = { ok: false, reason: 'ROAR price not in network-and-prices', source: 'participants ÷ price' }; else { let sum = 0, n = 0; parts.members.forEach(m => { const rows = (m.lp_positions || []).filter(l => /ROAR/.test(String(l.pool_name || ''))); if (!rows.length) return; const usd = rows.reduce((a, l) => a + (num(l.estimated_position_usd) || 0), 0); const roar = usd * 0.5 / px; const w = at(m.wallet); w.lp_amp = roar; sum += roar; n++; }); for (const w of W.values()) if (w.lp_amp == null) w.lp_amp = 0; cols.lp_amp = { ok: true, source: `member-data/participants: ROAR-pool positions, ≈ ROAR = USD × ½ ÷ ROAR ${px} (a derivation: half of each two-sided pool is ROAR by value)`, members: n, sum, derived: true }; } }
  // --- ROAR in plain LP: each registered pair's LP token holders × the pool's ROAR
  { const pairs = Array.isArray(t.roar_pools) ? t.roar_pools : []; let any = false, fails = []; let sum = 0; const detail = [];
    for (const p of pairs) { const q = smartOn(p.address); const pool = await q({ pool: {} }); const pair = await q({ pair: {} }); const lpTok = pair && (pair.liquidity_token || (pair.liquidity_token_addr)); if (!pool || !Array.isArray(pool.assets) || !lpTok) { fails.push(`${p.label}: pool/pair read failed`); continue; }
      const roarAsset = pool.assets.find(a => a.info && a.info.token && a.info.token.contract_addr === cw20); const poolRoar = roarAsset ? H(roarAsset.amount) : null; const total = num(pool.total_share); if (poolRoar == null || !total) { fails.push(`${p.label}: no ROAR asset or total_share`); continue; }
      const lq = smartOn(lpTok); const accts = []; let start = null, pages = 0, fail = null; for (;;) { const r = await lq({ all_accounts: Object.assign({ limit: 30 }, start ? { start_after: start } : {}) }); if (!r || !Array.isArray(r.accounts)) { fail = 'LP all_accounts failed'; break; } pages++; r.accounts.forEach(a => accts.push(a)); if (r.accounts.length < 30) break; start = r.accounts[r.accounts.length - 1]; if (pages > 500) { fail = 'LP walk exceeded 500 pages'; break; } }
      if (fail) { fails.push(`${p.label}: ${fail}`); continue; } let failed = 0, psum = 0; for (const a of accts) { const r = await lq({ balance: { address: a } }); if (!r || r.balance === undefined) { failed++; continue; } const sh = num(r.balance); if (sh > 0) { const roar = poolRoar * sh / total; const w = at(a); w.lp_plain = (w.lp_plain || 0) + roar; psum += roar; } } if (failed) { fails.push(`${p.label}: ${failed} LP balance reads failed`); continue; } any = true; sum += psum; detail.push({ pair: p.label, address: p.address, lp_token: lpTok, pool_roar: poolRoar, holders: accts.length, roar_attributed: psum }); }
    if (!pairs.length) cols.lp_plain = { ok: false, reason: 'no roar_pools registered' }; else if (!any) cols.lp_plain = { ok: false, reason: fails.join(' · '), source: 'pair LP tokens' }; else { for (const w of W.values()) if (w.lp_plain == null) w.lp_plain = 0; cols.lp_plain = { ok: true, source: 'each pair: pool + pair (LP token), LP holders walked whole × the pool\'s ROAR', pairs: detail, sum, partial: fails.length ? fails : null }; } }
  // --- fold, name, rank
  const rows = [...W.values()].map(w => { const parts = ['staked', 'liquid', 'amp', 'lp_amp', 'lp_plain'].map(k => w[k]); const known = parts.filter(v => v != null); w.total = known.length ? known.reduce((a, b) => a + b, 0) : null; const nm = nameOf(w.address); w.label = nm ? nm.label : null; w.kind = nm ? nm.kind : null; return w; }).filter(w => w.total != null && w.total >= (t.whales && t.whales.min_total_roar || 0)).sort((a, b) => b.total - a.total);
  rows.forEach((w, i) => { w.rank = i + 1; });
  const TOPC = 40; for (let i = 0; i < rows.length; i++) { const w = rows[i]; if (w.kind) { w.kind_source = 'registry'; continue; } if (i < TOPC) { const c = await isContract(w.address); w.kind = c && c.yes ? 'contract' : c ? 'wallet' : 'unclassified'; w.kind_source = c == null ? 'contract-info read failed' : 'chain: /cosmwasm/wasm/v1/contract'; if (c && c.yes && c.label) { w.label = w.label || c.label; w.contract_label = c.label; } } else { w.kind = 'unclassified'; w.kind_source = `only the top ${TOPC} are asked; a wallet by all odds — unverified`; } }
  const totalSupply = H(info.total_supply); const all = [...W.values()]; const sumCol = (k) => all.reduce((a, w) => a + (w[k] || 0), 0);
  return { product: {
    product: 'roar/holders', engine: VERSION, tenant: TENANT, capturedAt: new Date().toISOString(), chain: 'phoenix-1',
    token: { cw20, symbol: info.symbol || 'ROAR', decimals: dec, total_supply: totalSupply },
    columns: cols, min_total_roar: t.whales && t.whales.min_total_roar || 0,
    holder_count: rows.length, wallets_seen: all.length, holders: rows,
    top25: rows.slice(0, 25).map(w => ({ rank: w.rank, address: w.address, label: w.label, kind: w.kind, staked: w.staked, liquid: w.liquid, amp: w.amp, lp_amp: w.lp_amp, lp_plain: w.lp_plain, total: w.total })),
    sums: { staked: sumCol('staked'), liquid: sumCol('liquid'), amp: sumCol('amp'), lp_amp: sumCol('lp_amp'), lp_plain: sumCol('lp_plain'), total: all.reduce((a, w) => a + (w.total || 0), 0), note: 'over every wallet seen, before the min_total_roar floor that trims the table' },
    concentration: { top1_pct: rows[0] && totalSupply ? rows[0].total / totalSupply * 100 : null, top10_pct: totalSupply ? rows.slice(0, 10).reduce((a, w) => a + w.total, 0) / totalSupply * 100 : null, top25_pct: totalSupply ? rows.slice(0, 25).reduce((a, w) => a + w.total, 0) / totalSupply * 100 : null, of: 'total_supply' },
    notes: ['a wallet\'s ampROAR is shown in ROAR at the hub\'s exchange rate; its units are kept (amp_units)', 'ROAR in TLA-amplified LP is a derivation (½ of position USD ÷ price) — labeled ≈ on the page', 'contracts (pools, the hub, DAO cores) hold ROAR too and rank here by what they hold; the kind column says which is which'],
  } };
}

// ---------------------------------------------------------------- publish
function gh(method, apiPath, body) { return new Promise((resolve, reject) => { const req = https.request({ hostname: 'api.github.com', path: apiPath, method, headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'ally-holders', 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' } }, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => { if (res.statusCode >= 200 && res.statusCode < 300) resolve(d ? JSON.parse(d) : {}); else if (res.statusCode === 404) resolve(null); else reject(new Error(`GitHub ${method} ${apiPath}: ${res.statusCode} ${d.slice(0, 200)}`)); }); }); req.on('error', reject); if (body) req.write(JSON.stringify(body)); req.end(); }); }
async function publish(filePath, content, message, writeOnce) {
  const ex = await gh('GET', `/repos/${GITHUB_REPO}/contents/${filePath}?ref=${GITHUB_BRANCH}`);
  if (ex && writeOnce) return 'kept (write-once)';
  const r = await gh('PUT', `/repos/${GITHUB_REPO}/contents/${filePath}`, Object.assign({ message, content: Buffer.from(content).toString('base64'), branch: GITHUB_BRANCH }, ex && ex.sha ? { sha: ex.sha } : {}));
  return r && r.content ? r.content.sha.slice(0, 7) : 'ok';
}

async function run(which = ['pyroar', 'roar20', 'roar']) {
  const [tenantsDoc, trusted] = await Promise.all([E.fetchJson(CORE + 'docs/curated/tenants.json', 'tenants'), E.fetchJson(CORE + 'docs/curated/trusted-addresses.json', 'trust-register').catch(() => null)]);
  const t = tenantsDoc.tenants && tenantsDoc.tenants[TENANT]; if (!t) throw new Error(`tenant ${TENANT} not in tenants.json`);
  const outRoot = OUT_ROOT || ((t.daos || [])[0] || TENANT); const nameOf = namer(t, trusted);
  const out = { outRoot, products: {}, errors: [] };
  if (which.includes('pyroar')) { const r = await pyroarHolders(t, nameOf); if (r.product) out.products.pyroar = r.product; else out.errors.push({ product: 'burn/holders', reason: r.reason }); }
  if (which.includes('roar20')) { const r = await roar20Holders(t); if (r.product) out.products.roar20 = r.product; else out.errors.push({ product: 'roar20/holders', reason: r.reason }); }
  if (which.includes('roar')) { const r = await roarWhales(t, nameOf); if (r.product) out.products.roar = r.product; else out.errors.push({ product: 'roar/holders', reason: r.reason }); }
  return out;
}

async function main(which) {
  which = which || (process.env.DUTIES || 'pyroar,roar20,roar').split(',').map(s => s.trim()).filter(Boolean);
  const res = await run(which); const d = day();
  const targets = { pyroar: 'burn', roar20: 'roar20', roar: 'roar' };
  const hb = { product: `${res.outRoot}/holders`, engine: VERSION, status: res.errors.length ? (Object.keys(res.products).length ? 'ok_with_errors' : 'failed') : 'ok', capturedAt: new Date().toISOString(), written: Object.keys(res.products).map(k => `${targets[k]}/holders.json`), errors: res.errors };
  for (const e of res.errors) console.error(`✗ ${e.product}: ${e.reason}`);
  if (!GITHUB_TOKEN) { fs.mkdirSync('out', { recursive: true }); for (const [k, p] of Object.entries(res.products)) fs.writeFileSync(`out/${targets[k]}-holders.json`, JSON.stringify(p, null, 1)); fs.writeFileSync('out/holders-heartbeat.json', JSON.stringify(hb, null, 1)); console.log('⚠️  GITHUB_TOKEN not set — wrote out/'); if (hb.status === 'failed' && require.main === module) process.exit(1); return hb; }
  for (const [k, p] of Object.entries(res.products)) { const root = `${res.outRoot}/${targets[k]}`; const content = JSON.stringify(p, null, 1);
    const gate = p.supply_gate ? `gate Δ ${p.supply_gate.delta}` : `${Object.values(p.columns || {}).filter(c => c && c.ok).length}/${Object.keys(p.columns || {}).length} columns read`;   // 1.1.1
    try {
      console.log(`  ${root}/holders.json (${p.holder_count} holders, ${gate}) → ${await publish(`${root}/holders.json`, content, `🦁 ${TENANT} ${p.product} ${p.capturedAt}`)}`);
      console.log(`  ${root}/daily/${d}.json → ${await publish(`${root}/daily/${d}.json`, content, `📸 ${TENANT} ${p.product} daily — ${d}`, true)}`);
    } catch (e) { console.error(`✗ publish ${root}/holders.json: ${e.message}`); hb.errors.push({ product: `${targets[k]}/holders`, reason: 'publish failed: ' + e.message }); hb.written = hb.written.filter(w => w !== `${targets[k]}/holders.json`); hb.status = 'ok_with_errors'; } }
  console.log(`  heartbeat → ${await publish(`${res.outRoot}/holders-heartbeat.json`, JSON.stringify(hb, null, 1), `💓 ${TENANT} holders heartbeat`)}`);
  if (hb.status === 'failed' && require.main === module) process.exit(1);   // a failed product is not written; the previous snapshot stands, and Render shows the failure
  return hb;
}
module.exports = { VERSION, run, main, pyroarHolders, roar20Holders, roarWhales, namer, TOP_CLASSIFY };
if (require.main === module) main().catch(e => { console.error('✗', e); process.exit(1); });
