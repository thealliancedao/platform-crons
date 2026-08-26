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
const Y = require('./yields.js');                 // Branch D (1.4.0): live yields from exchange_rates
const C = require('../config/contracts.js');      // LST_HUBS: symbol → hub (single source)

const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
const GITHUB_REPO   = process.env.GITHUB_REPO   || 'thealliancedao/tla-core';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const VERSION       = 'org-votion-1.4.0';   // 1.4.0: Branch D yields — vault/LST/native APR+APY from on-chain exchange_rates (Eris formula + independent measurement); 1.3.0: optimization product carries per-vault YIELD

const VOTION_CODE_ID = 3677;
const ESCROW = 'terra1uqhj8agyeaz8fu6mdggfuwr3lp32jlrx5hqag4jxexde92rzkamq3l62zg';
const GAUGE  = 'terra1hfksrhchkmsj4qdq33wkksrslnfles6y2l77fmmzeep0xmq24l2smsd3lj';
const LCD_ENDPOINTS = ['https://terra-rest.publicnode.com', 'https://phoenix-lcd.terra.dev', 'https://terra-lcd.stakely.io'];   // 1.4.0: Stakely LCD LB as third fallback (owner-found 2026-08-26)
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

// --------------------------------------------------------------------------- LST hub rates (1.2.0)
// AUDIT-eris-apr-pricing fix #1: every LST is priced as LUNA x its OWN hub
// exchange rate — never a catalog LST price, never another LST's rate. The
// arb (slow-burn) hub has compounded since 2022 (rate ~2.9) while amp sits
// ~1.34; catalog pricing was collapsing that difference (the 2.2x arbLUNA
// understatement). Keyed by LST cw20 CONTRACT (chain truth, not labels).
// ampLUNA carries two candidates because the curated registry holds two
// entries labeled "Eris ampLUNA Hub" — first sane responder wins, and which
// one answered is published so the registry label conflict can be curated.
const LST_HUB_CANDIDATES = {
    // ampLUNA
    'terra1ecgazyd0waaj3g7l9cmy5gulhxkps2gmxu9ghducvuypjq68mq2s5lvsct': [
        'terra10788fkzah89xrdm27zkj5yvhj9x3494lxawzm5qq3vvxcqz2yzaqyd3enk',
        'terra1kye343r8hl7wm6f3uzynyyzl2zmcm2sqmvvzwzj7et2j5jj7rjkqa2ue88',
    ],
    // arbLUNA (Eris arbitrage vault)
    'terra1se7rvuerys4kd2snt6vqswh9wugu49vhyzls8ymc02wl37g2p2ms5yz490': [
        'terra1r9gls56glvuc4jedsvc3uwh6vj95mqm9efc7hnweqxa2nlme5cyqxygy5m',
    ],
    // bLUNA — no verified hub entry yet; falls back (labeled) if a vault appears
    'terra17aj4ty4sz4yhgm08na8drc0v03v2jwr3waxcqrwhajj729zhl7zqnpc0ml': [],
};
const HUB_RATE_MIN = 0.5, HUB_RATE_MAX = 50;   // reject only the clearly-broken
function saneHubRate(x) { return typeof x === 'number' && isFinite(x) && x >= HUB_RATE_MIN && x <= HUB_RATE_MAX; }

async function queryHubRate(addr) {
    // dual shape, defensively: {state:{}} -> .exchange_rate, else {exchange_rate:{}}
    const st = await T.queryContract(addr, { state: {} });
    const r1 = st && st.exchange_rate != null ? Number(st.exchange_rate) : null;
    if (saneHubRate(r1)) return { rate: r1, method: 'state.exchange_rate' };
    const ex = await T.queryContract(addr, { exchange_rate: {} });
    const r2 = typeof ex === 'number' ? ex : ex && ex.exchange_rate != null ? Number(ex.exchange_rate) : null;
    if (saneHubRate(r2)) return { rate: r2, method: 'exchange_rate' };
    return null;
}

async function resolveLstHubRates(vaults, errors) {
    const contracts = [...new Set(vaults.map(v => v.lst_contract).filter(Boolean))];
    const out = {};
    for (const lst of contracts) {
        const candidates = LST_HUB_CANDIDATES[lst] || [];
        for (const addr of candidates) {
            const r = await queryHubRate(addr);
            if (r) { out[lst] = { rate: r.rate, hub_addr: addr, method: r.method }; break; }
        }
        if (!out[lst]) errors.push({ where: `lst_hub ${lst.slice(0, 16)}`, error: candidates.length ? 'no hub candidate gave a sane exchange_rate — catalog fallback in use' : 'no hub contract registered — catalog fallback in use' });
    }
    return out;
}

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
const T = { lcdGet: realLcdGet, queryContract: realQueryContract, githubApiRequest: realGithubApiRequest, now: () => new Date(), fetch: (...a) => fetch(...a) };

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
    const hubRates = await resolveLstHubRates(vaults, errors);
    for (const v of vaults) v.hub = (v.lst_contract && hubRates[v.lst_contract]) || null;
    const votion_vp_now_per_pool = buildNowRollup(vaults);
    const total_vp = Math.round(vaults.reduce((s, v) => s + (v.state.lock_vp_human || 0), 0) * 100) / 100;

    const vaultsDoc = {
        meta: { version: VERSION, generated_at: now.toISOString(), discovery_source, vault_count: vaults.length },
        totals: { total_vault_vp: total_vp },
        votion_vp_now_per_pool,
        vaults: vaults.map(v => ({ address: v.address, label: v.label, lst_contract: v.lst_contract, vdenom: v.vdenom, lock_id: v.lock_id, protocol_fee: v.protocol_fee,
            lst_luna_hub_rate: v.hub ? v.hub.rate : null, lst_hub_addr: v.hub ? v.hub.hub_addr : null, ...v.state })),
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
        vaults: vaults.map(v => ({ address: v.address, staked_lst_human: v.state.staked_lst_human, exchange_rate: v.state.exchange_rate, lst_luna_hub_rate: v.hub ? v.hub.rate : null, lock_vp_human: v.state.lock_vp_human })),
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

        // 1.2.0 pricing: LUNA_USD x LST's OWN hub rate (three-link chain) is
        // PRIMARY; the old catalog LST price survives only as a labeled fallback.
        const luna = priceFromCatalog(catalog, 'uluna');
        let lstUsd = null, priceSource = null, rateSource = null;
        if (v.hub && luna.usd != null) {
            lstUsd = v.hub.rate * luna.usd;
            priceSource = 'hub_exchange_rate';
            rateSource = 'hub_exchange_rate';
        } else {
            const fb = priceFromCatalog(catalog, v.lst_contract);
            if (fb.usd != null) { lstUsd = fb.usd; priceSource = `${fb.source} (fallback)`; rateSource = priceSource; }
        }
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
            lst_luna_hub_rate: v.hub ? v.hub.rate : null, lst_hub_addr: v.hub ? v.hub.hub_addr : null, lst_rate_source: rateSource,
            vault_tvl_usd: (v.state.staked_lst_human != null && lstUsd != null) ? Math.round(v.state.staked_lst_human * lstUsd * 100) / 100 : null,
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
            lst_pricing_convention: 'underlying_usd = underlying_lst x LST_own_hub_rate x LUNA_USD (AUDIT-eris-apr-pricing); catalog LST price only as labeled fallback',
            discovery_basis: 'tx_search deposit events (public LCDs prune; pre-retention depositors are NOT discoverable — the vault exposes no holder query and denom_owners is unimplemented on available LCDs, probed 2026-07-16) + curated-holders.json candidates, all verified by live balance. Holder set = retention-window discoveries + registry (grow-only) + curated; it may undercount pre-retention holders.',
        },
        member_sweep: { wallets_swept: memberWallets.length, failures: sweepFailures, complete: sweepComplete },
        totals: { vault_count: vaults.length, unique_holders: uniqueHolders,
            total_tvl_usd: Math.round(vaultBlocks.reduce((s, b) => s + (b.total_underlying_usd || 0), 0) * 100) / 100,   // discovered-holders sum (existing semantic, unchanged)
            total_vault_tvl_usd: Math.round(vaultBlocks.reduce((s, b) => s + (b.vault_tvl_usd || 0), 0) * 100) / 100 },  // REAL vault TVL via hub chain (1.2.0, additive)
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
// ---- Branch C — Votion optimizer capture (DeFi_Patriot 2026-07-31) ---------------
// First-party Votion API: per-vault PLANNED reallocation for the next epoch
// (current% \u2192 optimized% per gauge, isWorthChanging, voteBefore deadline).
// Complements the on-chain vote-shift signal: this is INTENTION (published by
// Votion, not yet cast); the chain shows commitment. Captured verbatim.
// Slugs are explicit config: CONFIRMED are captured; PROBE candidates are
// tried and reported found/absent in the heartbeat \u2014 never guessed into data.
const VOTION_OPT_BASE = 'https://backend.erisprotocol.com/votion/liquidity-alliance';
const VOTION_OPT_SLUGS = (process.env.VOTION_OPT_SLUGS || 'ampluna-max').split(',').map(x => x.trim()).filter(Boolean);
const VOTION_OPT_PROBES = (process.env.VOTION_OPT_PROBES || 'arbluna-max,ampluna,arbluna,moar-max,solid-max,ampcapa-max').split(',').map(x => x.trim()).filter(Boolean);
async function fetchOptimization(slug) {
    const r = await T.fetch(`${VOTION_OPT_BASE}/${slug}/optimization`, { headers: { accept: 'application/json' } });
    if (r.status === 404) return { slug, found: false };
    if (!r.ok) throw new Error(`optimization ${slug}: HTTP ${r.status}`);
    return { slug, found: true, data: await r.json() };
}
// 1.3.0 — per-vault yield from data the cron ALREADY holds: Votion's expected reward for the
// period (Branch C) ÷ the vault's TVL in USD (Branch A state × LUNA × hub rate). Published as
// `yield` on each vault so every consumer shows the same number. Simple annualisation (×365/7),
// votion leg only — Votion's own APY adds the LST asset yield and compounds; that formula is
// unpublished and is not imitated here (it is linked).
function yieldFor(optDoc, vaultRow, lunaUsd) {
    const rew = optDoc && optDoc.summary && optDoc.summary.totalExpectedReward;
    if (typeof rew !== 'number' || !vaultRow) return null;
    const lstUsd = (vaultRow.hub && lunaUsd != null) ? vaultRow.hub.rate * lunaUsd : null;
    const tvl = (vaultRow.state && vaultRow.state.staked_lst_human != null && lstUsd != null) ? vaultRow.state.staked_lst_human * lstUsd : null;
    if (!(tvl > 0)) return { expected_reward_usd: rew, vault_tvl_usd: null, per_period_pct: null, apr_simple_pct: null, basis: 'vault TVL unavailable (no hub rate or LUNA price) — no APR invented' };
    const pp = rew / tvl;
    return { expected_reward_usd: Math.round(rew * 100) / 100, vault_tvl_usd: Math.round(tvl * 100) / 100, per_period_pct: Math.round(pp * 10000) / 100, apr_simple_pct: Math.round(pp * 365 / 7 * 10000) / 100,
        basis: 'expected_reward_usd (Votion API, this period) ÷ vault_tvl_usd (vault staked LST × LUNA USD × LST hub rate) × 365/7. Simple APR, votion leg only; excludes the LST asset yield and compounding that Votion\u2019s displayed APY includes.' };
}
// 1.3.0 — REALIZED yield from our own daily captures: the vault exchange rate (vLST per LST)
// and the LST hub rate, both captured daily in votion/snapshots/daily. Growth over a trailing
// window, compounded to a year. This is what Votion's "Votion APY" / "Asset APY" track
// (checked 2026-08-22: ampLUNA Max 7d vault-rate APY 61.8% vs Votion's 58.96%; hub-rate APY
// 35.0% vs their 35.86%). Ours is measured from chain captures, theirs from their code.
function realizedYield(nowRow, pastRow, days) {
    if (!nowRow || !pastRow || !(days > 0)) return null;
    const out = { window_days: Math.round(days * 10) / 10 };
    const g = (a, b) => (typeof a === 'number' && typeof b === 'number' && b > 0) ? a / b - 1 : null;
    const vg = g(nowRow.exchange_rate, pastRow.exchange_rate), hg = g(nowRow.lst_luna_hub_rate, pastRow.lst_luna_hub_rate);
    const apy = (x) => x == null ? null : Math.round((Math.pow(1 + x, 365 / days) - 1) * 10000) / 100;
    out.vault_rate_growth_pct = vg == null ? null : Math.round(vg * 10000) / 100;
    out.vault_apy_pct = apy(vg);                    // Votion leg, realized
    out.hub_rate_growth_pct = hg == null ? null : Math.round(hg * 10000) / 100;
    out.asset_apy_pct = apy(hg);                    // LST asset leg, realized (hub rate = Eris hub, never market)
    out.combined_apy_pct = (vg == null || hg == null) ? null : Math.round((Math.pow((1 + vg) * (1 + hg), 365 / days) - 1) * 10000) / 100;
    out.basis = 'exchange_rate (vLST/LST) and lst_luna_hub_rate growth between two daily captures, compounded to 365d. Measured, not forecast.';
    return out;
}
async function runBranchC(now, errors, ctx) {
    const vaults = {}; const probes = {};
    for (const slug of VOTION_OPT_SLUGS) {
        try { const r = await fetchOptimization(slug); if (r.found) vaults[slug] = r.data; else { probes[slug] = 'absent'; errors.push({ where: `opt:${slug}`, error: 'configured slug returned 404' }); } }
        catch (e) { errors.push({ where: `opt:${slug}`, error: e.message }); }
    }
    for (const slug of VOTION_OPT_PROBES) {
        try { const r = await fetchOptimization(slug); probes[slug] = r.found ? 'FOUND \u2014 promote to VOTION_OPT_SLUGS' : 'absent'; if (r.found) vaults[slug] = r.data; }
        catch (e) { probes[slug] = `error: ${e.message}`; }
    }
    // ---- cross-vault AGGREGATE (the "one place" view Votion doesn't show) ---
    // Per gauge per pool: sum each vault's current VP and its PLANNED VP,
    // where planned = newVoted only if that vault's gauge isWorthChanging
    // (Votion skips low-gain re-votes \u2014 visible as "skipped" in their UI);
    // otherwise planned = current. Delta = the net Votion move already
    // scheduled before voteBefore. Pool titles from the payload's own meta.
    function buildAggregate(vaultDocs) {
        const gauges = {};
        for (const [slug, doc] of Object.entries(vaultDocs)) {
            for (const opt of doc.optimizations || []) {
                const g = gauges[opt.id] || (gauges[opt.id] = { pools: {}, vaults_moving: [], vaults_keeping: [] });
                const vp = Number(opt.votingPower || 0);
                const moving = !!(opt.diff && opt.diff.isWorthChanging);
                (moving ? g.vaults_moving : g.vaults_keeping).push(slug);
                const titles = {};
                for (const v of (opt.meta && opt.meta.votes) || []) titles[v.id] = v.title || null;
                for (const o of opt.votingOptions || []) if (!(o.id in titles)) titles[o.id] = o.title || null;
                const cur = opt.activeVoted || {};
                const nw = moving ? (opt.newVoted || cur) : cur;
                const ids = new Set([...Object.keys(cur), ...Object.keys(nw)]);
                for (const id of ids) {
                    const p = g.pools[id] || (g.pools[id] = { title: titles[id] || null, current_vp: 0, planned_vp: 0 });
                    if (!p.title && titles[id]) p.title = titles[id];
                    p.current_vp += (Number(cur[id] || 0) / 100) * vp;
                    p.planned_vp += (Number(nw[id] || 0) / 100) * vp;
                }
            }
        }
        for (const g of Object.values(gauges)) {
            for (const p of Object.values(g.pools)) {
                p.current_vp = Math.round(p.current_vp); p.planned_vp = Math.round(p.planned_vp);
                p.delta_vp = p.planned_vp - p.current_vp;
                p.delta_pct = p.current_vp > 0 ? +(100 * p.delta_vp / p.current_vp).toFixed(2) : (p.planned_vp > 0 ? null : 0);
                p.note = p.current_vp === 0 && p.planned_vp > 0 ? 'NEW \u2014 Votion plans to enter this pool' : (p.planned_vp === 0 && p.current_vp > 0 ? 'EXIT \u2014 Votion plans to leave this pool' : undefined);
            }
        }
        return gauges;
    }

    const slugsOk = Object.keys(vaults);
    if (!slugsOk.length) return { status: 'error', slugs: [], probes };
    const anyV = vaults[slugsOk[0]];
    // 1.3.0: attach yield per vault. Slug 'ampluna-max' ↔ vault label 'max/vampluna'.
    const byLabel = {}; for (const v of (ctx && ctx.vaultRows) || []) if (v.label) byLabel[v.label.toLowerCase()] = v;
    const slugToLabel = (slug) => { const m = String(slug).match(/^(amp|arb)luna-(max|\d+)$/i); return m ? `${m[2].toLowerCase()}/v${m[1].toLowerCase()}luna` : null; };
    const yields = {};
    // realized windows from our own daily captures (7d and 30d), by vault address
    const dayFile = async (daysAgo) => { const d = new Date(now.getTime() - daysAgo * 86400e3).toISOString().slice(0, 10); const r = await apiGetJson(`votion/snapshots/daily/${d}.json`); return r.data ? { date: d, doc: r.data } : null; };
    const nearestPast = async (daysAgo) => { for (let i = 0; i < 4; i++) { const f = await dayFile(daysAgo + i); if (f) return f; } return null; };
    const [p7, p30] = ctx && ctx.vaultRows ? await Promise.all([nearestPast(7), nearestPast(30)]) : [null, null];
    const rowIn = (f, addr) => f && f.doc && Array.isArray(f.doc.vaults) ? f.doc.vaults.find(v => v.address === addr) : null;
    const nowRowFor = (v) => v ? { exchange_rate: v.state && v.state.exchange_rate, lst_luna_hub_rate: v.hub ? v.hub.rate : null } : null;
    const daysBetween = (f) => f && f.doc && f.doc.meta && f.doc.meta.generated_at ? (now.getTime() - Date.parse(f.doc.meta.generated_at)) / 86400e3 : null;
    for (const slug of slugsOk) {
        const lab = slugToLabel(slug); const row = lab ? byLabel[lab] : null;
        const y = yieldFor(vaults[slug], row, ctx ? ctx.lunaUsd : null) || {};
        if (row) { y.realized_7d = realizedYield(nowRowFor(row), rowIn(p7, row.address), daysBetween(p7)); y.realized_30d = realizedYield(nowRowFor(row), rowIn(p30, row.address), daysBetween(p30)); y.realized_from = { d7: p7 && p7.date, d30: p30 && p30.date }; }
        vaults[slug].yield = y; yields[slug] = y; if (!row) probes[`yield:${slug}`] = 'no matching vault row for label ' + lab;
    }
    const doc = {
        schemaVersion: 1, product: 'votion/optimization', capturedAt: now.toISOString(),
        source: VOTION_OPT_BASE + '/{slug}/optimization (first-party Votion API \u2014 verbatim capture)',
        semantics: 'PLANNED next-epoch reallocation per vault per gauge \u2014 Votion\u2019s published intention, not yet cast on chain; firms up as voteBefore approaches. The on-chain vote-shift (vote-state vs last payout) is the committed counterpart.',
        period: anyV.period ?? null, voteBefore: anyV.voteBefore ?? null, calculated: anyV.calculated ?? null,
        aggregate: buildAggregate(vaults),
        aggregate_semantics: 'per gauge per pool, summed across captured vaults: current VP vs the VP Votion has ALREADY DECIDED to place (skipped gauges keep current \u2014 matching the \u201cnot worth changing\u201d rows in Votion\u2019s UI). Coverage = the vault slugs captured this run; add slugs to complete it.',
        yields, yield_semantics: 'per slug — FORWARD: expected_reward_usd ÷ vault_tvl_usd (simple APR, votion leg). REALIZED (realized_7d / realized_30d): vault exchange-rate growth (votion leg) and LST hub-rate growth (asset leg) from our daily captures, compounded; combined = both. Votion\u2019s UI shows a realized-style votion APY plus an asset APY — compare with realized_7d.',
        vaults, probe_results: probes,
    };
    await publishFile('votion/optimization/current.json', doc, `votion: optimization p${doc.period} (${slugsOk.length} vault${slugsOk.length === 1 ? '' : 's'})`);
    return { status: 'ok', slugs: slugsOk, probes };
}

// ---------------------------------------------------------------------------- Branch D (1.4.0): yields
const LUNA_LST_SYMBOLS = ['ampLUNA', 'arbLUNA', 'bLUNA'];   // the three "New Here? → TLA" bonding routes
function lstSymbolOfContract(addr) { for (const [sym, h] of Object.entries(C.LST_HUBS)) if (h.lstDenom === addr) return sym; return null; }
async function runBranchD(now, vaults) {
    const hubs = {}; for (const sym of LUNA_LST_SYMBOLS) if (C.LST_HUBS[sym]) hubs[sym] = C.LST_HUBS[sym].hub;
    const readRatioMonth = (y, m) => apiGetJson(`price-history/ratios/${y}/${m}.json`).then(r => r.data);
    const r = await Y.buildYields({ T, vaults: vaults.map(v => ({ address: v.address, label: v.label, lst_contract: v.lst_contract })), hubs, lstSymbolOf: lstSymbolOfContract, readRatioMonth, now, version: VERSION });
    await publishFile('votion/yields/current.json', r.doc, `votion: yields ${r.status} @ ${now.toISOString()}`);
    await publishFile(`votion/yields/daily/${now.toISOString().slice(0, 10)}.json`, r.doc, `votion: yields daily ${now.toISOString().slice(0, 10)}`);
    return r;
}

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

    // Branch C — optimizer capture (every run: it changes intra-epoch)
    let optC = { status: 'skipped', slugs: [], probes: {} };
    try {
        const catalogForC = await apiGetJson('token-catalog/snapshots/current.json').then(r => r.data).catch(() => null);
        const lunaC = priceFromCatalog(catalogForC, 'uluna');
        optC = await runBranchC(now, errors, { vaultRows: vaults, lunaUsd: lunaC.usd });
        console.log(`  C: optimization ${optC.status} — vaults [${optC.slugs.join(', ')}]`);
    }
    catch (e) { errors.push({ where: 'optimization', error: e.message }); console.warn(`  C: optimization failed: ${e.message}`); }

    // Branch D — yields (every run; cheap: 3 windows × (vaults + hubs) reads). Product the "New Here? → TLA" page reads live.
    let yieldsStatus = 'skipped';
    try {
        const d = await runBranchD(now, vaults);
        yieldsStatus = d.status;
        if (d.errors.length) errors.push(...d.errors);
        console.log(`  D: yields ${d.status} — ${d.doc.vaults.filter(v => v.headline[30] && v.headline[30].total_apy != null).length}/${d.doc.vaults.length} vaults with a 30d headline; native est ${d.doc.native_staking.apy_est == null ? 'n/a' : (d.doc.native_staking.apy_est * 100).toFixed(2) + '%'}`);
    }
    catch (e) { errors.push({ where: 'yields', error: e.message }); console.warn(`  D: yields failed: ${e.message}`); yieldsStatus = 'error'; }

    const status = vaults.length === 0 ? 'error' : (errors.length ? 'partial' : 'ok');
    await publishFile('votion/heartbeat.json', {
        version: VERSION, capturedAt: now.toISOString(), status,
        vaults_at: now.toISOString(), positions_at: positionsAt, positions_status: positionsStatus,
        lst_rate_fallback_in_use: errors.some(e => /lst_hub/.test(e.where)),
        vault_count: vaults.length, optimization_status: optC.status, optimization_vaults: optC.slugs, optimization_probes: optC.probes, yields_status: yieldsStatus, _errors: errors.length ? errors : null,
    }, `votion heartbeat ${status}`);
    console.log(`  done: ${status}${errors.length ? ` (${errors.length} recorded errors)` : ''}`);
    return { status, vaults, errors };
}

module.exports = { run, T, apiGetJson, publishFile, discoverVaults, loadVaultState, parseGaugeVotes, buildNowRollup, discoverHoldersIncremental, priceFromCatalog, resolveLstHubRates, queryHubRate, LST_HUB_CANDIDATES, runBranchA, runBranchB, SEED_VAULTS, runBranchC, runBranchD, lstSymbolOfContract };
if (require.main === module) run().then(r => process.exit(r.status === 'error' ? 1 : 0)).catch(e => { console.error('FATAL:', e.message); process.exit(1); });
