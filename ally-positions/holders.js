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
const VERSION = '1.0.1';
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
async function isContract(addr) { try { const r = await E.fetchJson(LCD + `/cosmwasm/wasm/v1/contract/${addr}`, 'contract-info'); return !!(r && r.contract_info); } catch (e) { return /404|not found|no such contract/i.test(String(e.message)) ? false : null; } }   // false = the chain said no; null = the read failed

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
    if (!h.kind) { if (i < TOP_CLASSIFY) { const c = await isContract(h.address); h.kind = c === true ? 'contract' : c === false ? 'wallet' : 'unclassified'; h.kind_source = c == null ? 'contract-info read failed' : 'chain: /cosmwasm/wasm/v1/contract'; } else { h.kind = 'unclassified'; h.kind_source = `only the top ${TOP_CLASSIFY} are asked; a wallet by all odds — unverified`; } } else h.kind_source = 'registry'; }
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
    concentration: { top1_pct: holders[0] ? holders[0].share_pct : null, top10_pct: sum(holders.slice(0, 10).map(h => h.share_pct)), top50_pct: sum(holders.slice(0, 50).map(h => h.share_pct)) },
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
    token: { mint, decimals: dec, supply: total, supply_raw: supply.value.amount, note: t.roar20.supply_fixed_note || null },
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

// ---------------------------------------------------------------- publish
function gh(method, apiPath, body) { return new Promise((resolve, reject) => { const req = https.request({ hostname: 'api.github.com', path: apiPath, method, headers: { 'Authorization': `token ${GITHUB_TOKEN}`, 'User-Agent': 'ally-holders', 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' } }, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => { if (res.statusCode >= 200 && res.statusCode < 300) resolve(d ? JSON.parse(d) : {}); else if (res.statusCode === 404) resolve(null); else reject(new Error(`GitHub ${method} ${apiPath}: ${res.statusCode} ${d.slice(0, 200)}`)); }); }); req.on('error', reject); if (body) req.write(JSON.stringify(body)); req.end(); }); }
async function publish(filePath, content, message, writeOnce) {
  const ex = await gh('GET', `/repos/${GITHUB_REPO}/contents/${filePath}?ref=${GITHUB_BRANCH}`);
  if (ex && writeOnce) return 'kept (write-once)';
  const r = await gh('PUT', `/repos/${GITHUB_REPO}/contents/${filePath}`, Object.assign({ message, content: Buffer.from(content).toString('base64'), branch: GITHUB_BRANCH }, ex && ex.sha ? { sha: ex.sha } : {}));
  return r && r.content ? r.content.sha.slice(0, 7) : 'ok';
}

async function run(which = ['pyroar', 'roar20']) {
  const [tenantsDoc, trusted] = await Promise.all([E.fetchJson(CORE + 'docs/curated/tenants.json', 'tenants'), E.fetchJson(CORE + 'docs/curated/trusted-addresses.json', 'trust-register').catch(() => null)]);
  const t = tenantsDoc.tenants && tenantsDoc.tenants[TENANT]; if (!t) throw new Error(`tenant ${TENANT} not in tenants.json`);
  const outRoot = OUT_ROOT || ((t.daos || [])[0] || TENANT); const nameOf = namer(t, trusted);
  const out = { outRoot, products: {}, errors: [] };
  if (which.includes('pyroar')) { const r = await pyroarHolders(t, nameOf); if (r.product) out.products.pyroar = r.product; else out.errors.push({ product: 'burn/holders', reason: r.reason }); }
  if (which.includes('roar20')) { const r = await roar20Holders(t); if (r.product) out.products.roar20 = r.product; else out.errors.push({ product: 'roar20/holders', reason: r.reason }); }
  return out;
}

async function main(which) {
  which = which || (process.env.DUTIES || 'pyroar,roar20').split(',').map(s => s.trim()).filter(Boolean);
  const res = await run(which); const d = day();
  const targets = { pyroar: 'burn', roar20: 'roar20' };
  const hb = { product: `${res.outRoot}/holders`, engine: VERSION, status: res.errors.length ? (Object.keys(res.products).length ? 'ok_with_errors' : 'failed') : 'ok', capturedAt: new Date().toISOString(), written: Object.keys(res.products).map(k => `${targets[k]}/holders.json`), errors: res.errors };
  for (const e of res.errors) console.error(`✗ ${e.product}: ${e.reason}`);
  if (!GITHUB_TOKEN) { fs.mkdirSync('out', { recursive: true }); for (const [k, p] of Object.entries(res.products)) fs.writeFileSync(`out/${targets[k]}-holders.json`, JSON.stringify(p, null, 1)); fs.writeFileSync('out/holders-heartbeat.json', JSON.stringify(hb, null, 1)); console.log('⚠️  GITHUB_TOKEN not set — wrote out/'); if (hb.status === 'failed') process.exit(1); return; }
  for (const [k, p] of Object.entries(res.products)) { const root = `${res.outRoot}/${targets[k]}`; const content = JSON.stringify(p, null, 1);
    console.log(`  ${root}/holders.json (${p.holder_count} holders, gate Δ ${p.supply_gate.delta}) → ${await publish(`${root}/holders.json`, content, `🦁 ${TENANT} ${p.product} ${p.capturedAt}`)}`);
    console.log(`  ${root}/daily/${d}.json → ${await publish(`${root}/daily/${d}.json`, content, `📸 ${TENANT} ${p.product} daily — ${d}`, true)}`); }
  console.log(`  heartbeat → ${await publish(`${res.outRoot}/holders-heartbeat.json`, JSON.stringify(hb, null, 1), `💓 ${TENANT} holders heartbeat`)}`);
  if (hb.status === 'failed' && require.main === module) process.exit(1);   // a failed product is not written; the previous snapshot stands, and Render shows the failure
  return hb;
}
module.exports = { VERSION, run, main, pyroarHolders, roar20Holders, namer, TOP_CLASSIFY };
if (require.main === module) main().catch(e => { console.error('✗', e); process.exit(1); });
