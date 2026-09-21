#!/usr/bin/env node
/* ============================================================================
 * ally-positions/index.js 1.0.0 (2026-09-21) — POSITIONS for an ally's wallet roster (crons per ally).
 * ----------------------------------------------------------------------------
 * ONE engine, one Render service per ally: `TENANT=liondao node ally-positions/index.js`. The roster, the validator, the
 * staking contracts and the DAO folder all come from tla-core/docs/curated/tenants.json — this file holds no address.
 *
 * Per wallet (the same engine member-data runs for every TLA participant — lib/capture-engine.js: TLA staked
 * amp / non-amp post-take, locks + VP, pending rewards / bribes / rebase, compounder receipts priced through the
 * compounder's own rates) PLUS what the engine does not read and phoenix.money does not show:
 *   balances     — every bank denom + every catalog cw20, symbol from the token-catalog `effective` layer
 *                  (lib/denom-symbol.js), USD from network-and-prices; unpriced rows KEPT with their reason
 *   delegations  — LUNA delegated per validator + unclaimed rewards; the ally's own validator marked
 *   validator    — the validator's commission accrued (the account is a position too)
 *   votion       — the wallet's rows in tla-core/votion/snapshots/vaults.json
 *   nfts         — held / staked counts per collection of the tenant (nft-collections summary.json)
 *   credia       — NOT READ YET (no reader for the market contract's user positions) → null with the reason
 *
 * Roll-up per role (treasury / ops / msig / validator) and for the DAO; every USD basis labeled; null ≠ 0.
 * Writes dao-originations/<dao>/positions/current.json · daily/<date>.json · heartbeat.json (write-once per day,
 * same-day overwrite). GATE #0: if docs/fixtures/<date>/phoenix-money-liondao-portfolio.json is on tla-core, the run
 * publishes a side-by-side (our USD per wallet vs theirs) in current.json.reconciliation — the venue's UI is not the
 * oracle, it is the check.
 * ========================================================================== */
'use strict';
const https = require('https');
const fs = require('fs');
const path = require('path');
const E = require('../lib/capture-engine.js');
const { buildResolver } = require('../lib/denom-symbol.js');

const VERSION = '1.0.0';
const TENANT = process.env.TENANT || 'liondao';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO || 'thealliancedao/dao-originations';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const OUT_ROOT = process.env.OUT_ROOT || null;   // default: tenants.json daos[0] (the DAO folder in dao-originations)
const CORE = 'https://raw.githubusercontent.com/thealliancedao/tla-core/main/';
const NFTC = 'https://raw.githubusercontent.com/thealliancedao/nft-collections/main/';
const LCD = E.TERRA_LCD_PRIMARY;

// ---------------------------------------------------------------- helpers
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const sum = (arr) => { let t = 0, any = false; for (const v of arr) if (Number.isFinite(v)) { t += v; any = true; } return any ? t : null; };
const day = () => new Date().toISOString().slice(0, 10);
async function lcd(p, label) { try { return await E.fetchJson(LCD + p, label || p.slice(0, 40)); } catch (e) { try { return await E.fetchJson(E.TERRA_LCD_FALLBACK + p, label); } catch (e2) { return null; } } }
async function lcdPaged(p, key, max = 20) { let out = [], next = null, n = 0; do { const r = await lcd(p + (p.includes('?') ? '&' : '?') + 'pagination.limit=500' + (next ? '&pagination.key=' + encodeURIComponent(next) : '')); if (!r) return n ? out : null; out = out.concat(r[key] || []); next = r.pagination && r.pagination.next_key; n++; } while (next && n < max); return out; }

// ---------------------------------------------------------------- readers the engine lacks
async function readBalances(wallet, ctx) {
  const bank = await E.fetchBankBalances(wallet);
  const rows = [];
  for (const b of bank) {
    const amt = num(b.amount); if (!amt) continue;
    const r = ctx.resolve(b.denom); const dec = r.decimals != null ? r.decimals : 6; const human = amt / Math.pow(10, dec);
    rows.push(priceRow({ kind: 'native', denom: b.denom, symbol: r.symbol, symbol_reason: r.symbol ? null : r.reason, amount_raw: b.amount, amount_human: human }, ctx));
  }
  await E.parallelMap(ctx.cw20s, async (t) => {
    const bal = await E.queryContract(t.denom, { balance: { address: wallet } });
    const amt = bal ? num(bal.balance) : null; if (!amt) return;
    const human = amt / Math.pow(10, t.decimals);
    rows.push(priceRow({ kind: 'cw20', denom: t.denom, symbol: t.symbol, symbol_reason: null, amount_raw: bal.balance, amount_human: human }, ctx));
  }, 5);
  rows.sort((a, b) => (b.usd_value || 0) - (a.usd_value || 0));
  return rows;
}
function priceRow(row, ctx) {
  const p = row.symbol && ctx.tokenPrices[row.symbol] ? num(ctx.tokenPrices[row.symbol].final_price_usd) : null;
  row.price_usd = p; row.price_source = p != null ? (ctx.tokenPrices[row.symbol].final_source || 'network-and-prices') : null;
  row.usd_value = p != null ? row.amount_human * p : null;
  row.unpriced_reason = p != null ? null : (row.symbol ? 'symbol_not_in_price_feed' : (row.symbol_reason || 'symbol_unknown'));
  return row;
}
async function readDelegations(wallet, ctx) {
  const [dl, rw] = await Promise.all([lcd(`/cosmos/staking/v1beta1/delegations/${wallet}?pagination.limit=100`, 'delegations'), lcd(`/cosmos/distribution/v1beta1/delegators/${wallet}/rewards`, 'rewards')]);
  if (!dl) return null;
  const rewardsBy = {}; for (const r of (rw && rw.rewards) || []) rewardsBy[r.validator_address] = sum((r.reward || []).filter(c => c.denom === 'uluna').map(c => num(c.amount) / 1e6));
  const rows = (dl.delegation_responses || []).map(r => { const v = r.delegation.validator_address; const luna = num(r.balance.amount) / 1e6; return { validator: v, own_validator: v === ctx.validator, luna, usd_value: ctx.lunaPriceUsd != null ? luna * ctx.lunaPriceUsd : null, rewards_luna: rewardsBy[v] != null ? rewardsBy[v] : null, rewards_usd: rewardsBy[v] != null && ctx.lunaPriceUsd != null ? rewardsBy[v] * ctx.lunaPriceUsd : null }; });
  return { rows, luna: sum(rows.map(r => r.luna)), usd_value: sum(rows.map(r => r.usd_value)), rewards_luna: sum(rows.map(r => r.rewards_luna)), rewards_usd: sum(rows.map(r => r.rewards_usd)), price_basis: 'LUNA at network-and-prices' };
}
async function readValidatorCommission(ctx) {
  if (!ctx.validator) return null;
  const c = await lcd(`/cosmos/distribution/v1beta1/validators/${ctx.validator}/commission`, 'commission');
  const luna = c && c.commission ? sum((c.commission.commission || []).filter(x => x.denom === 'uluna').map(x => num(x.amount) / 1e6)) : null;
  return { operator: ctx.validator, commission_unclaimed_luna: luna, commission_unclaimed_usd: luna != null && ctx.lunaPriceUsd != null ? luna * ctx.lunaPriceUsd : null };
}
function readVotion(wallet, ctx) {
  const vaults = ctx.votionVaults; if (!vaults) return null;
  const rows = [];
  for (const v of (vaults.vaults || [])) for (const h of (v.holders || [])) if (h.address === wallet || h.wallet === wallet) rows.push({ vault: v.name || v.id || v.address, shares: num(h.shares || h.balance), usd_value: num(h.usd_value || h.value_usd) });
  return { rows, usd_value: sum(rows.map(r => r.usd_value)), source: 'tla-core/votion/snapshots/vaults.json' };
}
function readNfts(wallet, ctx) {
  const out = {}; let any = false;
  for (const [slug, s] of Object.entries(ctx.nftSummaries)) {
    if (!s) continue; any = true;
    const held = num((s.per_real_owner_counts || {})[wallet]) || 0;
    const stakedRow = (s.daodao_stakers || []).find(x => (x.address || x.wallet) === wallet);
    const staked = stakedRow ? num(stakedRow.count || stakedRow.staked || stakedRow.nft_count) || 0 : 0;
    out[slug] = { held_total: held, staked_daodao: staked, floor_usd: null };
  }
  return any ? out : null;
}

// ---------------------------------------------------------------- roll-up
function rollup(wallets, extras) {
  const byRole = {}; const parts = [];
  const add = (role, k, v) => { const r = byRole[role] = byRole[role] || {}; if (Number.isFinite(v)) r[k] = (r[k] || 0) + v; else if (r[k] === undefined) r[k] = null; };
  for (const w of Object.values(wallets)) {
    const s = w.portfolio && w.portfolio.summary || {};
    const bal = w.balances ? sum(w.balances.map(b => b.usd_value)) : null;
    const tla = sum([s.total_lp_position_usd, s.total_locked_usd]);
    const pend = sum([s.total_pending_rewards_usd, s.total_pending_bribes_usd, w.portfolio && w.portfolio.pending_rebase ? w.portfolio.pending_rebase.usd_value : null]);
    const deleg = w.delegations ? w.delegations.usd_value : null; const votion = w.votion ? w.votion.usd_value : null;
    w.totals = { balances_usd: bal, tla_usd: tla, tla_pending_usd: pend, delegations_usd: deleg, votion_usd: votion, credia_usd: null, known_usd: sum([bal, tla, deleg, votion]), unpriced_rows: w.balances ? w.balances.filter(b => b.usd_value == null).length : null };
    for (const [k, v] of Object.entries(w.totals)) if (k !== 'unpriced_rows') add(w.role, k, v);
    add('all', 'balances_usd', bal); add('all', 'tla_usd', tla); add('all', 'tla_pending_usd', pend); add('all', 'delegations_usd', deleg); add('all', 'votion_usd', votion); add('all', 'known_usd', w.totals.known_usd);
  }
  const vc = extras.validator && extras.validator.commission_unclaimed_usd;
  return { by_role: byRole, dao: Object.assign({}, byRole.all, { validator_commission_unclaimed_usd: vc == null ? null : vc, credia_usd: null, credia_note: 'reader not built — Credia collateral and debt land when the market contract reader exists' }),
    bases: { tokens: 'network-and-prices final_price_usd by catalog symbol', tla: 'capture-engine post-take at pool prices', luna: 'LUNA at network-and-prices' } };
}
function reconcile(wallets, fixture) {
  if (!fixture) return null;
  // phoenix.money backend shape: { value, portfolios: [{ address, info, value, dappPortfolios: [{ dapp, value, positions: [...] }] }] }
  const theirs = {}; const theirsByDapp = {}; try {
    for (const x of (fixture.portfolios || [])) { if (!x.address) continue; theirs[x.address] = num(x.value); theirsByDapp[x.address] = Object.fromEntries((x.dappPortfolios || []).map(d => [d.dapp, num(d.value)])); }
  } catch (e) {}
  const rows = Object.entries(wallets).map(([a, w]) => ({ address: a, label: w.label, ours_known_usd: w.totals.known_usd, ours_balances_usd: w.totals.balances_usd, ours_tla_usd: w.totals.tla_usd, theirs_usd: theirs[a] == null ? null : theirs[a], theirs_by_dapp: theirsByDapp[a] || null, delta_usd: theirs[a] != null && w.totals.known_usd != null ? w.totals.known_usd - theirs[a] : null }));
  return { reference: 'phoenix.money portfolio fixture (docs/fixtures)', theirs_total_usd: num(fixture.value), ours_total_known_usd: sum(Object.values(wallets).map(w => w.totals.known_usd)), rows, note: 'theirs excludes delegations, Credia debt, Votion and unpriced receipts; ours labels each — a delta is a question, not an error' };
}

// ---------------------------------------------------------------- github
function gh(method, apiPath, body) { return new Promise((resolve, reject) => { const req = https.request({ hostname: 'api.github.com', path: apiPath, method, headers: { 'Authorization': `Bearer ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github+json', 'User-Agent': 'positions-cron', 'Content-Type': 'application/json' } }, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => { if (res.statusCode >= 200 && res.statusCode < 300) resolve(d ? JSON.parse(d) : {}); else reject(Object.assign(new Error(`GitHub ${method} ${apiPath} → ${res.statusCode}: ${d.slice(0, 200)}`), { status: res.statusCode })); }); }); req.on('error', reject); if (body) req.write(JSON.stringify(body)); req.end(); }); }
async function publish(filePath, content, message) {
  const apiPath = `/repos/${GITHUB_REPO}/contents/${filePath}`;
  for (let attempt = 1; attempt <= 4; attempt++) {
    let sha = null; try { const ex = await gh('GET', apiPath + `?ref=${GITHUB_BRANCH}`); sha = ex.sha; if (Buffer.from(ex.content || '', 'base64').toString() === content) return 'unchanged'; } catch (e) { if (e.status !== 404) throw e; }
    try { await gh('PUT', apiPath, Object.assign({ message, content: Buffer.from(content).toString('base64'), branch: GITHUB_BRANCH }, sha ? { sha } : {})); return sha ? 'updated' : 'created'; }
    catch (e) { if ([409, 422].includes(e.status) || e.status >= 500) { await new Promise(r => setTimeout(r, 400 * attempt + Math.random() * 300)); continue; } throw e; }
  }
  throw new Error('publish gave up: ' + filePath);
}

// ---------------------------------------------------------------- run
async function loadContext() {
  const [tenantsDoc, catalog, votionVaults] = await Promise.all([
    E.fetchJson(CORE + 'docs/curated/tenants.json', 'tenants'),
    E.fetchJson(CORE + 'token-catalog/snapshots/current.json', 'token-catalog').catch(() => null),
    E.fetchJson(CORE + 'votion/snapshots/vaults.json', 'votion-vaults').catch(() => null),
  ]);
  const t = tenantsDoc.tenants && tenantsDoc.tenants[TENANT]; if (!t) throw new Error(`tenant ${TENANT} not in tenants.json`);
  if (!t.wallets || !Object.keys(t.wallets).length) throw new Error(`tenant ${TENANT} has no wallets in tenants.json`);
  const ctx = await E.loadSharedData();   // tla-snapshot + network-and-prices; throws if either is missing (never a half run)
  const resolve = buildResolver(catalog || []);
  ctx.resolve = (d) => { const r = resolve(d); return r && r.symbol ? { symbol: r.symbol, decimals: r.decimals } : { symbol: null, decimals: 6, reason: (r && r.reason) || 'not_in_token_catalog' }; };
  ctx.cw20s = ((catalog && catalog.tokens) || []).filter(x => x.kind === 'cw20' || /^terra1[0-9a-z]{58}$/.test(String(x.denom).replace('cw20:', ''))).map(x => { const d = String(x.denom).replace('cw20:', ''); const r = ctx.resolve(d); return { denom: d, symbol: r.symbol, decimals: r.decimals }; });
  ctx.validator = t.validator && t.validator.operator || null;
  ctx.validatorAccount = t.validator && t.validator.account || null;
  ctx.votionVaults = votionVaults;
  ctx.nftSummaries = {};
  await Promise.all((t.collections || []).map(async (slug) => { ctx.nftSummaries[slug] = await E.fetchJson(NFTC + slug + '/snapshots/summary.json', 'nft-summary ' + slug).catch(() => null); }));
  ctx.tenant = t; ctx.tenantSlug = TENANT; ctx.outRoot = OUT_ROOT || ((t.daos || [])[0] || TENANT);
  return ctx;
}
async function captureWallet(address, w, ctx) {
  const [portfolio, balances, delegations] = await Promise.all([
    E.fetchMemberPortfolio({ address, name: w.label }, ctx).catch(e => ({ _errors: ['engine: ' + e.message], summary: null })),
    readBalances(address, ctx).catch(e => null),
    readDelegations(address, ctx).catch(e => null),
  ]);
  return { address, label: w.label, role: w.role, counts_as: w.counts_as, portfolio, balances, delegations, votion: readVotion(address, ctx), nfts: readNfts(address, ctx), credia: null, credia_note: 'reader not built' };
}
async function run(opts = {}) {
  const ctx = opts.ctx || await loadContext();
  const t = ctx.tenant; const startedAt = new Date().toISOString();
  console.log(`🦁 positions ${VERSION} — tenant ${TENANT}, ${Object.keys(t.wallets).length} wallets → ${GITHUB_REPO}/${ctx.outRoot}/positions/`);
  const wallets = {};
  await E.parallelMap(Object.entries(t.wallets), async ([a, w]) => { wallets[a] = await captureWallet(a, w, ctx); console.log(`  ✓ ${w.label}`); }, 2);
  if (ctx.validatorAccount && !wallets[ctx.validatorAccount]) wallets[ctx.validatorAccount] = await captureWallet(ctx.validatorAccount, { label: 'validator account', role: 'validator', counts_as: 'validator' }, ctx);
  const validator = await readValidatorCommission(ctx).catch(() => null);
  const roll = rollup(wallets, { validator });
  const fixture = opts.fixture || null;
  const doc = { schemaVersion: 1, product: `${ctx.outRoot}/positions`, engine: VERSION, tenant: TENANT, capturedAt: new Date().toISOString(), startedAt,
    prices: { luna_usd: ctx.lunaPriceUsd, source: 'network-and-prices', captured_at: ctx.networkPrices && ctx.networkPrices.capturedAt || null },
    validator, wallets, rollup: roll, reconciliation: reconcile(wallets, fixture),
    errors: Object.values(wallets).flatMap(w => (w.portfolio && w.portfolio._errors || []).map(e => ({ wallet: w.label, error: e }))) };
  return doc;
}
async function main() {
  const doc = await run();
  const content = JSON.stringify(doc, null, 1); const d = day();
  const root = `${doc.product}`;
  const hb = JSON.stringify({ product: root, engine: VERSION, status: doc.errors.length ? 'ok_with_errors' : 'ok', capturedAt: doc.capturedAt, wallets: Object.keys(doc.wallets).length, known_usd: doc.rollup.dao.known_usd, errors: doc.errors.length }, null, 1);
  if (!GITHUB_TOKEN) { fs.mkdirSync('out', { recursive: true }); fs.writeFileSync('out/current.json', content); fs.writeFileSync('out/heartbeat.json', hb); console.log('⚠️  GITHUB_TOKEN not set — wrote out/'); return; }
  console.log(`  current.json → ${await publish(`${root}/current.json`, content, `🦁 ${TENANT} positions ${doc.capturedAt}`)}`);
  console.log(`  daily/${d}.json → ${await publish(`${root}/daily/${d}.json`, content, `📸 ${TENANT} positions daily — ${d}`)}`);
  console.log(`  heartbeat → ${await publish(`${root}/heartbeat.json`, hb, `💓 ${TENANT} positions heartbeat`)}`);
}
module.exports = { VERSION, run, loadContext, captureWallet, readBalances, readDelegations, readValidatorCommission, readVotion, readNfts, rollup, reconcile, priceRow };
if (require.main === module) main().catch(e => { console.error('✗', e); process.exit(1); });
