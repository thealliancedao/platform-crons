#!/usr/bin/env node
'use strict';
// =============================================================================
// org-votion 1.0.0 — Votion vault + holder capture (SPEC-votion-capture, G2)
//
// ONE self-escalating cron, two branches (Branch C optimizer = v1.1):
//   A (every run, hourly): vault discovery + state + VP + per-pool NOW rollup
//     → snapshots/vaults.json + history/{YYYY}/{MM}.json append
//   B (daily): holder reconstruction (incremental via holders-registry) +
//     valuation → snapshots/current.json + snapshots/daily/{date}.json
//
// Lifted from proven cron-scripts/votion-positions (discovery, {state:{}}
// staked, holder tx_search, valuation) with corrections:
//   - Vault VP = lock_info fixed_amount + voting_power (SPEC-vp-definition-fix;
//     the old cron read voting_power only — the platform-wide undercount bug).
//   - Per-pool Votion NOW from CHAIN (gauge controller user_info per vault),
//     not the Eris API.
//   - Incremental holder discovery via a grow-only registry + tx totals —
//     no daily full re-walk.
//   - USD via token-catalog prices (priority list, per-row source tag — the
//     arbLUNA hub-vs-market transparency lesson preserved).
//   - No names here: identity joins downstream via address-catalog.
// =============================================================================

const https = require('https');

const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
const GITHUB_REPO   = process.env.GITHUB_REPO   || 'thealliancedao/tla-core';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const VERSION       = 'org-votion-1.1.0';

const VOTION_CODE_ID = 3677;
const ESCROW = 'terra1uqhj8agyeaz8fu6mdggfuwr3lp32jlrx5hqag4jxexde92rzkamq3l62zg';
const GAUGE  = 'terra1hfksrhchkmsj4qdq33wkksrslnfles6y2l77fmmzeep0xmq24l2smsd3lj';
const LCD_ENDPOINTS = ['https://terra-rest.publicnode.com', 'https://phoenix-lcd.terra.dev'];
const CONCURRENCY = 5;                       // publicnode saturation rule
const POSITIONS_MAX_AGE_H = 20;              // daily branch trigger
const TXS_PAGE_LIMIT = 100;
const TXS_MAX_PAGES = 50;

// Seed fallback ONLY if the code-id listing fails; real config always from chain.
const SEED_VAULTS = [
    'terra13aae4futz6jk7hmdv0gwm2xs6p4nxv4xwz5tc0c2vt4960u4j6jqpqmye9',
    'terra163jnveun52hxv2kg4ys9a28h20trmccr98tnrvr92snn6yzdeg7qd9zj9l',
    'terra16xzky47caqc3krsxpla58m36ttxcjty3zpp92344m2tere5t26ysuxkjuj',
    'terra1v7aw9eartqrjrhwd6c7hkmlkspcy5q4tvc07gjmvzqezk3fttr4s3mffyz',
    'terra1dr7mv4w6chznedhp7uw6ntz9zjj4hxcdga2lmenlfuj35vmwpf0qhnzm5p',
    'terra1mzelg87h36y6wvtgj6fh9s4crgx9acw63l3zc6f9px6pc5f8h8lqs0sux0',
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// --------------------------------------------------------------------------- raw HTTPS GET
function httpsGetJson(url, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { headers: { 'User-Agent': 'org-votion' }, timeout: timeoutMs }, res => {
            let data = ''; res.on('data', c => data += c);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) { try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('bad json')); } }
                else reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { statusCode: res.statusCode }));
            });
        });
        req.on('timeout', () => { req.destroy(new Error('timeout')); });
        req.on('error', reject);
    });
}

// LCD GET with endpoint fallback + one retry each. null = ALL failed (≠ empty).
async function realLcdGet(path) {
    for (const base of LCD_ENDPOINTS) {
        for (let attempt = 1; attempt <= 2; attempt++) {
            try { return await httpsGetJson(base + path); }
            catch (e) { if (attempt < 2) await sleep(300 * attempt); }
        }
    }
    return null;
}
// Smart query via LCD (base64 msg). null = failed.
async function realQueryContract(addr, msg) {
    const b64 = Buffer.from(JSON.stringify(msg)).toString('base64');
    const r = await T.lcdGet(`/cosmwasm/wasm/v1/contract/${addr}/smart/${b64}`);
    return r && r.data !== undefined ? r.data : null;
}

// --------------------------------------------------------------------------- GitHub I/O (org standard, lifted verbatim)
function realGithubApiRequest(method, apiPath, body, accept) {
    return new Promise((resolve, reject) => {
        const opts = { hostname: 'api.github.com', path: apiPath, method, headers: { 'User-Agent': 'org-votion', 'Authorization': `Bearer ${GITHUB_TOKEN}`, 'Accept': accept || 'application/vnd.github+json' } };
        if (body) opts.headers['Content-Type'] = 'application/json';
        const req = https.request(opts, res => { let data = ''; res.on('data', c => data += c); res.on('end', () => { if (res.statusCode >= 200 && res.statusCode < 300) { try { resolve(JSON.parse(data)); } catch { resolve(data); } } else { const err = new Error(`GitHub ${method} ${apiPath}: ${res.statusCode} ${data.slice(0, 200)}`); err.statusCode = res.statusCode; reject(err); } }); });
        req.on('error', reject); if (body) req.write(JSON.stringify(body)); req.end();
    });
}
const T = { lcdGet: realLcdGet, queryContract: realQueryContract, githubApiRequest: realGithubApiRequest, now: () => new Date() };

async function apiGetJson(repoPath) {
    try {
        const d = await T.githubApiRequest('GET', `/repos/${GITHUB_REPO}/contents/${repoPath}?ref=${GITHUB_BRANCH}`, null, 'application/vnd.github.raw');
        return { ok: true, data: typeof d === 'string' ? JSON.parse(d) : d };
    } catch (e) {
        if (e.statusCode === 404) return { ok: true, data: null };
        console.warn(`  ⚠ API read failed for ${repoPath}: ${e.message}`);
        return { ok: false, data: null };
    }
}
async function publishFile(filePath, contentObj, message) {
    const content = typeof contentObj === 'string' ? contentObj : JSON.stringify(contentObj, null, 2);
    const apiPath = `/repos/${GITHUB_REPO}/contents/${filePath}`;
    for (let attempt = 1; attempt <= 3; attempt++) {
        let sha = null;
        try { sha = (await T.githubApiRequest('GET', apiPath + `?ref=${GITHUB_BRANCH}`)).sha; } catch { /* new file */ }
        const body = { message, content: Buffer.from(content).toString('base64'), branch: GITHUB_BRANCH };
        if (sha) body.sha = sha;
        try { return await T.githubApiRequest('PUT', apiPath, body); }
        catch (e) { if (e.statusCode === 409 && attempt < 3) { await sleep(400 * attempt); continue; } throw e; }
    }
}

async function mapConcurrent(items, limit, fn) {
    const out = new Array(items.length); let i = 0;
    async function worker() { while (true) { const k = i++; if (k >= items.length) return; try { out[k] = await fn(items[k], k); } catch (e) { out[k] = { _err: e.message }; } } }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return out;
}
const num = (v) => (v === null || v === undefined || v === '') ? null : Number(v);

// =============================================================================
// BRANCH A — vaults
// =============================================================================
async function discoverVaults(errors) {
    const res = await T.lcdGet(`/cosmwasm/wasm/v1/code/${VOTION_CODE_ID}/contracts?pagination.limit=1000`);
    let addresses, discovery_source;
    if (res && Array.isArray(res.contracts) && res.contracts.length) { addresses = res.contracts; discovery_source = 'code_id_listing'; }
    else { addresses = SEED_VAULTS.slice(); discovery_source = 'seed_fallback'; errors.push({ where: 'vault_discovery', error: 'code-id listing unavailable — seed fallback' }); }

    const vaults = (await mapConcurrent(addresses, CONCURRENCY, async (addr) => {
        const cfg = await T.queryContract(addr, { config: {} });
        if (!cfg) { errors.push({ where: `config ${addr.slice(0, 16)}`, error: 'config query failed' }); return null; }
        const vdenom = cfg.vdenom || null;
        return {
            address: addr,
            label: vdenom ? vdenom.split('/').slice(2).join('/') : null,   // e.g. 'max/vampluna' (probe-verified path shape)
            lst_contract: (cfg.lock_info && cfg.lock_info.cw20) || null,
            vdenom,
            lock_id: cfg.lock_id != null ? cfg.lock_id : null,
            protocol_fee: cfg.protocol_fee != null ? Number(cfg.protocol_fee) : null,
        };
    })).filter(v => v && !v._err);
    return { vaults, discovery_source };
}

async function loadVaultState(v, errors) {
    const state = {};
    const s = await T.queryContract(v.address, { state: {} });
    if (s && s.staked != null) { state.staked_lst_raw = String(s.staked); state.staked_lst_human = Number(s.staked) / 1e6; }
    else { state.staked_lst_raw = null; state.staked_lst_human = null; errors.push({ where: `state ${v.address.slice(0, 16)}`, error: 'state query failed or no staked' }); }

    // Vault VP = fixed + voting_power (TOTAL — SPEC-vp-definition-fix).
    state.lock_vp_human = null; state.lock_vp_components = null;
    const hasLock = v.lock_id != null && String(v.lock_id).trim() !== '';
    if (!hasLock) {
        // Vault has never minted its lock (no deposits yet) — VP 0 is the
        // CORRECT state, not an error. user_info fallback below confirms.
        state.lock_vp_human = 0;
        state.lock_vp_components = { fixed_human: 0, voting_power_human: 0, source: 'no_lock_yet' };
    }
    if (hasLock) {
        const li = await T.queryContract(ESCROW, { lock_info: { token_id: String(v.lock_id), time: 'next' } });
        if (li && (li.voting_power != null || li.fixed_amount != null)) {
            const fixed = Number(li.fixed_amount || 0), boost = Number(li.voting_power || 0);
            state.lock_vp_human = (fixed + boost) / 1e6;
            state.lock_vp_components = { fixed_human: fixed / 1e6, voting_power_human: boost / 1e6 };
        } else errors.push({ where: `lock_info lock_id=${v.lock_id} (${v.address.slice(0, 16)})`, error: 'lock_info failed' });
    }

    state.vdenom_supply_raw = null; state.vdenom_supply_human = null;
    if (v.vdenom) {
        const sup = await T.lcdGet(`/cosmos/bank/v1beta1/supply/by_denom?denom=${encodeURIComponent(v.vdenom)}`);
        if (sup && sup.amount && sup.amount.amount != null) { state.vdenom_supply_raw = String(sup.amount.amount); state.vdenom_supply_human = Number(sup.amount.amount) / 1e6; }
        else errors.push({ where: `supply ${v.vdenom.slice(-20)}`, error: 'supply query failed' });
    }

    // exchange rate = staked LST / vdenom supply (LST per v-token — the vault's
    // bond ratio; DISTINCT from the LST->LUNA hub ratio).
    state.exchange_rate = (state.staked_lst_human != null && state.vdenom_supply_human > 0)
        ? state.staked_lst_human / state.vdenom_supply_human : null;

    // Per-vault gauge votes NOW (chain — the vault's own vote allocations).
    state.gauge_votes = null;
    const ui = await T.queryContract(GAUGE, { user_info: { user: v.address } });
    if (ui) {
        state.gauge_votes = ui;   // preserved verbatim under state; rollup below parses it
        // Probe-verified: user_info also carries fixed_amount + voting_power —
        // free VP fallback if the escrow lock_info read failed.
        if (state.lock_vp_human == null && (ui.voting_power != null || ui.fixed_amount != null)) {
            const fixed = Number(ui.fixed_amount || 0), boost = Number(ui.voting_power || 0);
            state.lock_vp_human = (fixed + boost) / 1e6;
            state.lock_vp_components = { fixed_human: fixed / 1e6, voting_power_human: boost / 1e6, source: 'gauge_user_info_fallback' };
        }
    }
    return state;
}

// Parse a gauge user_info payload into [{pool_gauge_id, bps}] — tolerant of the
// two shapes seen on-chain (votes: [[id,bps],...] or gauge_votes/buckets maps).
// REAL chain shape (probe-verified 2026-07-16):
//   { voting_power, fixed_amount, slope,
//     gauge_votes: [ { gauge: 'stable'|..., period, votes: [[pool_id, bps], ...] } ] }
// bps are per-BUCKET (each bucket allocates the user's FULL VP up to 10000).
function parseGaugeVotes(ui) {
    const out = [];
    const push = (id, bps, bucket) => { if (id != null && bps != null) out.push({ pool_gauge_id: String(id), bps: Number(bps), bucket: bucket || null }); };
    if (!ui || typeof ui !== 'object') return out;
    if (Array.isArray(ui.gauge_votes)) for (const g of ui.gauge_votes) {
        if (Array.isArray(g.votes)) for (const v of g.votes) Array.isArray(v) ? push(v[0], v[1], g.gauge) : push(v.lp_token || v.pool, v.vote_percent ?? v.bps ?? v.weight, g.gauge);
        else push(g.lp_token || g.pool, g.vote_percent ?? g.bps ?? g.weight, g.gauge);   // tolerant of flat variants
    }
    if (Array.isArray(ui.votes)) for (const v of ui.votes) Array.isArray(v) ? push(v[0], v[1]) : push(v.lp_token || v.pool, v.vote_percent ?? v.bps ?? v.weight);
    return out;
}

function buildNowRollup(vaults) {
    const perPool = {};
    for (const v of vaults) {
        const vp = v.state && v.state.lock_vp_human;
        const votes = parseGaugeVotes(v.state && v.state.gauge_votes);
        if (!vp || !votes.length) continue;
        for (const { pool_gauge_id, bps } of votes) {
            perPool[pool_gauge_id] = (perPool[pool_gauge_id] || 0) + vp * (bps / 10000);
        }
    }
    for (const k of Object.keys(perPool)) perPool[k] = Math.round(perPool[k] * 100) / 100;
    return perPool;
}

async function runBranchA(now, errors) {
    const { vaults, discovery_source } = await discoverVaults(errors);
    for (const v of vaults) v.state = await loadVaultState(v, errors);
    const votion_vp_now_per_pool = buildNowRollup(vaults);
    const total_vp = Math.round(vaults.reduce((s, v) => s + (v.state.lock_vp_human || 0), 0) * 100) / 100;

    const vaultsDoc = {
        meta: { version: VERSION, generated_at: now.toISOString(), discovery_source, vault_count: vaults.length },
        totals: { total_vault_vp: total_vp },
        votion_vp_now_per_pool,
        vaults: vaults.map(v => ({ address: v.address, label: v.label, lst_contract: v.lst_contract, vdenom: v.vdenom, lock_id: v.lock_id, protocol_fee: v.protocol_fee, ...v.state })),
    };
    await publishFile('votion/snapshots/vaults.json', vaultsDoc, `votion: vaults @ ${now.toISOString()}`);

    // history append (monthly array, never-shrink)
    const hPath = `votion/history/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}.json`;
    const hr = await apiGetJson(hPath);
    if (!hr.ok) throw new Error(`history read failed for ${hPath} — refusing to write blind`);
    const hDoc = hr.data || { meta: { module: 'votion', format_version: 1 }, points: [] };
    const before = hDoc.points.length;
    hDoc.points.push({
        at: now.toISOString(),
        vaults: vaults.map(v => ({ address: v.address, staked_lst_human: v.state.staked_lst_human, exchange_rate: v.state.exchange_rate, lock_vp_human: v.state.lock_vp_human })),
        total_vault_vp: total_vp,
    });
    if (hDoc.points.length !== before + 1) throw new Error('never-shrink violated — aborting');
    hDoc.meta.updated_at = now.toISOString();
    await publishFile(hPath, hDoc, `votion: history point ${now.toISOString()}`);
    return { vaults, vaultsDoc };
}

// =============================================================================
// BRANCH B — positions (daily)
// =============================================================================
// Incremental holder discovery. Registry per vault: { holders:[], tx_total,
// discovery_complete }. Fetch DESC pages until enough new txs are covered;
// advance tx_total ONLY on a complete walk of the delta.
async function discoverHoldersIncremental(vault, reg, errors) {
    const prev = reg[vault.address] || { holders: [], tx_total: null, discovery_complete: false };
    const known = new Set(prev.holders);
    const query = encodeURIComponent(`wasm._contract_address='${vault.address}' AND wasm.action='votion-la/deposit'`);
    let page = 1, fetched = 0, newTotal = null, complete = true;
    // If we have a prior complete walk, only the delta needs covering.
    const needFull = prev.tx_total == null || !prev.discovery_complete;
    while (true) {
        const res = await T.lcdGet(`/cosmos/tx/v1beta1/txs?query=${query}&order_by=ORDER_BY_DESC&page=${page}&limit=${TXS_PAGE_LIMIT}`);
        if (res === null) { complete = false; errors.push({ where: `holders ${vault.address.slice(0, 16)}`, error: `tx page ${page} failed` }); break; }   // null ≠ empty
        const txs = Array.isArray(res.tx_responses) ? res.tx_responses : [];
        if (newTotal == null && res.total != null) newTotal = Number(res.total);
        for (const tr of txs) {
            for (const ev of (tr.events || (tr.logs || []).flatMap(l => l.events || []))) {
                if (ev.type !== 'wasm') continue;
                const attrs = Object.fromEntries((ev.attributes || []).map(a => [a.key, a.value]));
                if (attrs.action === 'votion-la/deposit' && attrs.recipient) known.add(attrs.recipient);
            }
        }
        fetched += txs.length;
        if (txs.length < TXS_PAGE_LIMIT) break;                                        // last page
        if (!needFull && newTotal != null && fetched >= (newTotal - prev.tx_total)) break;  // delta covered
        page++;
        if (page > TXS_MAX_PAGES) { complete = false; errors.push({ where: `holders ${vault.address.slice(0, 16)}`, error: `>${TXS_MAX_PAGES} pages — capped` }); break; }
    }
    const next = {
        holders: [...known].sort(),
        tx_total: complete ? (newTotal != null ? newTotal : prev.tx_total) : prev.tx_total,   // advance ONLY on complete
        discovery_complete: complete ? true : prev.discovery_complete && !needFull,
    };
    return { holders: [...known], complete, next };
}

// token-catalog price for an LST contract: priority tla > coingecko > astroport
// > skeletonswap (first ok). Returns { usd, source } or nulls — never guessed.
function priceFromCatalog(catalog, lstContract) {
    if (!catalog || !Array.isArray(catalog.tokens)) return { usd: null, source: null };
    const t = catalog.tokens.find(x => x.denom === lstContract);
    const prices = t && t.prices;
    if (!prices) return { usd: null, source: null };
    for (const src of ['tla', 'coingecko', 'astroport', 'skeletonswap']) {
        const p = prices[src];
        if (p && p.status === 'ok' && p.usd != null) return { usd: Number(p.usd), source: `token-catalog/${src}` };
    }
    return { usd: null, source: null };
}

async function runBranchB(now, vaults, errors) {
    const regR = await apiGetJson('votion/holders-registry.json');
    if (!regR.ok) throw new Error('holders-registry read failed — refusing to run blind');
    const registry = regR.data || { meta: { module: 'votion' }, vaults: {} };
    // Curated candidates: addresses to ALWAYS balance-check (chain history is
    // pruned, so pre-retention depositors are undiscoverable by tx_search —
    // known candidates like the aDAO multisig are added here by hand and
    // verified by live balance, never assumed). File is human-maintained.
    const curated = (await apiGetJson('votion/curated-holders.json')).data || { addresses: [] };
    const curatedAddrs = Array.isArray(curated.addresses) ? curated.addresses : [];

    // MEMBER SWEEP (dynamic candidates — nothing hardcoded): every wallet
    // member-data currently tracks gets ONE full-balances query; any votion
    // vdenom found makes that wallet a holder of that vault. The candidate
    // list self-updates as member-data does; values are live-verified here.
    // This is what makes every TLA participant's Votion position appear in
    // the portfolio layer automatically.
    const memberDoc = (await apiGetJson('member-data/snapshots/current.json')).data;
    const memberWallets = memberDoc && Array.isArray(memberDoc.wallets)
        ? memberDoc.wallets.map(w => w.address || w.wallet).filter(Boolean) : [];
    if (!memberWallets.length) errors.push({ where: 'member_sweep', error: 'member-data unreadable/empty — sweep skipped this run' });
    const vdenomToVault = Object.fromEntries(vaults.filter(v => v.vdenom).map(v => [v.vdenom, v.address]));
    const sweepHits = {};   // vaultAddr → Map<wallet, raw>
    const sweepResults = await mapConcurrent(memberWallets, CONCURRENCY, async (addr) => {
        const r = await T.lcdGet(`/cosmos/bank/v1beta1/balances/${addr}?pagination.limit=200`);
        if (r === null) return { _err: `sweep balance failed ${addr.slice(0, 16)}` };   // failed ≠ zero
        for (const b of (r.balances || [])) {
            const vault = vdenomToVault[b.denom];
            if (vault && Number(b.amount) > 0) (sweepHits[vault] = sweepHits[vault] || {})[addr] = b.amount;
        }
        return null;
    });
    let sweepFailures = 0;
    for (const r of sweepResults) if (r && r._err) { sweepFailures++; errors.push({ where: 'member_sweep', error: r._err }); }
    const sweepComplete = memberWallets.length > 0 && sweepFailures === 0;
    const catalog = (await apiGetJson('token-catalog/snapshots/current.json')).data;
    if (!catalog) errors.push({ where: 'pricing', error: 'token-catalog unreadable — USD will be null' });

    const vaultBlocks = [];
    let anyIncomplete = false;
    for (const v of vaults) {
        if (!v.vdenom) { errors.push({ where: `vault ${v.address.slice(0, 16)}`, error: 'no vdenom — cannot enumerate holders' }); anyIncomplete = true; vaultBlocks.push({ address: v.address, holders: null, holder_discovery_complete: false }); continue; }
        const { holders: discovered, complete, next } = await discoverHoldersIncremental(v, registry.vaults, errors);
        for (const a of Object.keys(sweepHits[v.address] || {})) if (!next.holders.includes(a)) next.holders.push(a);   // sweep finds persist
        next.holders.sort();
        registry.vaults[v.address] = next;
        const sweep = sweepHits[v.address] || {};
        const holders = [...new Set([...discovered, ...curatedAddrs, ...Object.keys(sweep)])];
        if (!complete) anyIncomplete = true;

        const { usd: lstUsd, source: priceSource } = priceFromCatalog(catalog, v.lst_contract);
        const rows = (await mapConcurrent(holders, CONCURRENCY, async (addr) => {
            let raw;
            if (sweep[addr] != null) raw = Number(sweep[addr]);   // already live-read in the sweep
            else {
                const bal = await T.lcdGet(`/cosmos/bank/v1beta1/balances/${addr}/by_denom?denom=${encodeURIComponent(v.vdenom)}`);
                if (bal === null) return { _err: `balance failed ${addr.slice(0, 16)}` };   // failed ≠ zero
                raw = bal.balance && bal.balance.amount != null ? Number(bal.balance.amount) : 0;
            }
            if (raw <= 0) return null;                                                  // fully exited — drops from current, stays in registry
            const vtoken = raw / 1e6;
            const underlyingLst = v.state.exchange_rate != null ? vtoken * v.state.exchange_rate : null;
            const shareOfVault = v.state.vdenom_supply_human ? vtoken / v.state.vdenom_supply_human : null;
            return {
                address: addr,
                found_via: sweep[addr] != null ? 'member_sweep' : (curatedAddrs.includes(addr) && !discovered.includes(addr) ? 'curated' : 'tx_discovery'),
                vtoken_balance: vtoken,
                underlying_lst: underlyingLst != null ? Math.round(underlyingLst * 1e6) / 1e6 : null,
                underlying_usd: (underlyingLst != null && lstUsd != null) ? Math.round(underlyingLst * lstUsd * 100) / 100 : null,
                underlying_usd_price_source: (underlyingLst != null && lstUsd != null) ? priceSource : null,
                share_of_vault_pct: shareOfVault != null ? Math.round(shareOfVault * 1e6) / 1e4 : null,
                implied_vp: (shareOfVault != null && v.state.lock_vp_human != null) ? Math.round(shareOfVault * v.state.lock_vp_human * 100) / 100 : null,
            };
        }));
        const failed = rows.filter(r => r && r._err);
        if (failed.length) { anyIncomplete = true; for (const f of failed) errors.push({ where: `balances ${v.address.slice(0, 16)}`, error: f._err }); }
        const valid = rows.filter(r => r && !r._err).sort((a, b) => (b.implied_vp || 0) - (a.implied_vp || 0));
        vaultBlocks.push({
            address: v.address, lst_contract: v.lst_contract, vdenom: v.vdenom,
            exchange_rate: v.state.exchange_rate, lock_vp_human: v.state.lock_vp_human,
            holder_count: valid.length, candidates_checked: holders.length,
            holder_discovery_complete: complete,   // paging completed — NOT full-history coverage (see meta.discovery_basis)
            balance_failures: failed.length,
            total_underlying_usd: Math.round(valid.reduce((s, h) => s + (h.underlying_usd || 0), 0) * 100) / 100,
            holders: valid,
        });
    }

    if (!sweepComplete) anyIncomplete = true;
    const status = vaults.length === 0 ? 'error' : (anyIncomplete ? 'partial' : 'ok');
    const uniqueHolders = new Set(vaultBlocks.flatMap(b => (b.holders || []).map(h => h.address))).size;
    const doc = {
        meta: {
            version: VERSION, generated_at: now.toISOString(), status,
            discovery_basis: 'tx_search deposit events (public LCDs prune; pre-retention depositors are NOT discoverable — the vault exposes no holder query and denom_owners is unimplemented on available LCDs, probed 2026-07-16) + curated-holders.json candidates, all verified by live balance. Holder set = retention-window discoveries + registry (grow-only) + curated; it may undercount pre-retention holders.',
        },
        member_sweep: { wallets_swept: memberWallets.length, failures: sweepFailures, complete: sweepComplete },
        totals: { vault_count: vaults.length, unique_holders: uniqueHolders, total_tvl_usd: Math.round(vaultBlocks.reduce((s, b) => s + (b.total_underlying_usd || 0), 0) * 100) / 100 },
        vaults: vaultBlocks,
    };
    await publishFile('votion/snapshots/current.json', doc, `votion: positions ${status} @ ${now.toISOString()}`);
    await publishFile(`votion/snapshots/daily/${now.toISOString().slice(0, 10)}.json`, doc, `votion: daily archive ${now.toISOString().slice(0, 10)}`);
    registry.meta = { ...(registry.meta || {}), updated_at: now.toISOString() };
    await publishFile('votion/holders-registry.json', registry, `votion: registry @ ${now.toISOString()}`);
    return { status, doc };
}

// =============================================================================
// MAIN
// =============================================================================
async function run() {
    const now = T.now();
    const errors = [];
    console.log(`${VERSION} @ ${now.toISOString()} → ${GITHUB_REPO}#${GITHUB_BRANCH}`);
    if (!GITHUB_TOKEN && T.githubApiRequest === realGithubApiRequest) throw new Error('GITHUB_TOKEN missing — refusing to run.');

    const prevHb = (await apiGetJson('votion/heartbeat.json')).data;

    // Branch A — always
    const { vaults } = await runBranchA(now, errors);
    console.log(`  A: ${vaults.length} vaults, total VP ${Math.round(vaults.reduce((s, v) => s + (v.state.lock_vp_human || 0), 0)).toLocaleString()}`);

    // Branch B — daily (positions stale or never run)
    let positionsStatus = 'skipped';
    let positionsAt = prevHb && prevHb.positions_at || null;
    const ageH = positionsAt ? (now.getTime() - new Date(positionsAt).getTime()) / 36e5 : Infinity;
    if (ageH >= POSITIONS_MAX_AGE_H) {
        const b = await runBranchB(now, vaults, errors);
        positionsStatus = b.status; positionsAt = now.toISOString();
        console.log(`  B: positions ${b.status} — ${b.doc.totals.unique_holders} holders, TVL $${b.doc.totals.total_tvl_usd.toLocaleString()}`);
    } else {
        console.log(`  B: skipped (positions ${ageH.toFixed(1)}h old < ${POSITIONS_MAX_AGE_H}h)`);
    }

    const status = vaults.length === 0 ? 'error' : (errors.length ? 'partial' : 'ok');
    await publishFile('votion/heartbeat.json', {
        version: VERSION, capturedAt: now.toISOString(), status,
        vaults_at: now.toISOString(), positions_at: positionsAt, positions_status: positionsStatus,
        vault_count: vaults.length, _errors: errors.length ? errors : null,
    }, `votion heartbeat ${status}`);
    console.log(`  done: ${status}${errors.length ? ` (${errors.length} recorded errors)` : ''}`);
    return { status, vaults, errors };
}

module.exports = { run, T, apiGetJson, publishFile, discoverVaults, loadVaultState, parseGaugeVotes, buildNowRollup, discoverHoldersIncremental, priceFromCatalog, runBranchA, runBranchB, SEED_VAULTS };
if (require.main === module) run().then(r => process.exit(r.status === 'error' ? 1 : 0)).catch(e => { console.error('FATAL:', e.message); process.exit(1); });
