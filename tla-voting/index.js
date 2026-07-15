// =============================================================================
// tla-voting / index.js — org-tla-voting 2.2.0 (Render forward cron)
// TLA VOTING event capture: votes, locks, bribes, rewards — WALKER TRANSPORT
// Spec: tla-core/docs/pending-changes/SPEC-tla-voting-capture-fix.md
// (module contract: SPEC-tla-voting.md · transport doctrine: SPEC-tla-flows-walker.md §0)
// =============================================================================
//
// 2.0.0 (the capture fix) replaces the tx_search pager with the proven Rev C
// BLOCK-WALKER (lifted from platform-crons/tla-flows): walk every block since
// the cursor via RPC, gate on the three governance contracts, fetch each gated
// tx DECODED by hash from the LCD (we are hours behind head at most — the tx
// provably exists and is well inside the index retention), and feed the same
// tx_response shape the classifiers always consumed. Forward capture done as
// forward capture: completeness comes from block data, which cannot lie the
// way tx_search pagination was proven to (Rev 4, Finding 2).
//
// Also in 2.0.0:
//   • MONTHLY stream writes — events/{votes,locks,bribes,rewards}/{YYYY}/{MM}.json
//     (post-restructure layout; this cron REFUSES to run against the monolith
//     layout: index schemaVersion must be ≥ 4 → the deploy sequencing is
//     self-enforcing).
//   • <<CLASSIFIER v4>> — v3 + the lock token_id promotion (sole live home of
//     the classifier; seed/fcd-fill are layout-guarded off).
//   • vote-state HARVEST (lib/vote-state.js) — the per-period completeness +
//     attribution layer: enumerate lock owners → user_info → period stamps.
//     Catches Votion vaults, DAO DAO executions, Polytone, and silent drops BY
//     CONSTRUCTION. The first harvest IS the heal of the Rev 4 misses.
//   • events-vs-state vote_capture invariant in the heartbeat (the reconcile
//     fold-in, SPEC-tla-voting-reconcile §4 promise).
//   • rollups.json FROZEN — mis-attributed by exactly the actors this fix
//     addresses; build #2 (rollup rebuilds) recomputes it on events + state.
//
// This cron NEVER seeds events (unchanged): unreachable priors → abort with an
// error heartbeat. vote-state MAY self-start (its first harvest has no history
// to clobber — dedup + never-shrink still apply; see lib/vote-state.js).
//
// Reliability: F1 no pagination left to truncate (walker); F2 null ≠ [] on
// every read; F3 never-shrink per touched month; F7 heartbeat honesty + cursor
// advances only when every publish landed; F8 horizons untouched (historical
// floors), pruned-block gaps recorded with EXACT bounds (walker D10).
//
// Env (Render): GITHUB_TOKEN (scoped to tla-core), GITHUB_REPO/GITHUB_BRANCH,
// RPC_PRIMARY / RPC_FALLBACK, LCD_PRIMARY / LCD_FALLBACK, WALK_CONCURRENCY (4),
// MAX_BLOCKS_PER_RUN (2000), CONFIRM_LAG (3), TLA_LOOKBACK (700, cursor-
// migration fallback only). Schedule: 0 * * * * (hourly — D6).
// =============================================================================

'use strict';

const https = require('https');
const crypto = require('crypto');
const C = require('../config/contracts.js');

// ----------------------------------------------------------------------------- constants
const RPC_PRIMARY  = process.env.RPC_PRIMARY  || 'https://terra-rpc.publicnode.com';
const RPC_FALLBACK = process.env.RPC_FALLBACK || 'https://terra-rpc.polkachu.com';
const TERRA_LCD_PRIMARY  = process.env.LCD_PRIMARY  || 'https://terra-lcd.publicnode.com';
const TERRA_LCD_FALLBACK = process.env.LCD_FALLBACK || 'https://terra-rest.publicnode.com';

// One-contract-one-owner: single source of truth is the shared config.
// (Constant names preserved so the classifier block stays v3-verbatim.)
const TLA_GAUGE_CONTROLLER  = C.GAUGE_CONTROLLER.addr;
const TLA_VOTING_ESCROW     = C.VOTING_ESCROW.addr;
const TLA_INCENTIVE_MANAGER = C.BRIBE_MANAGER.addr;
const WATCH_SET = new Set([TLA_GAUGE_CONTROLLER, TLA_VOTING_ESCROW, TLA_INCENTIVE_MANAGER]);

const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
const GITHUB_REPO   = process.env.GITHUB_REPO   || 'thealliancedao/tla-core';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const OUT_DIR       = 'tla-voting/events';

const EPOCH_DATES_URL = `https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_BRANCH}/docs/epoch_1-300_date.json`;

const SCHEMA_VERSION = 4;                      // index/cursor/heartbeat schema (monthly layout)
const FORWARD_CADENCE_HOURS = 1;               // D6: hourly
const VERSION = 'org-tla-voting-2.3.0';        // 2.3.0 (build #3.5): rollups schema 5 — bribe_ledger (state totals vs event attribution, unattributed MEASURED) + bribers via counts, note retired — on 2.2.0 (bribe-state + v6 + lock rider) on 2.1.0 (rollups + v5) on 2.0.0 (walker + monthly + vote-state)
const BUDGET       = Number(process.env.MAX_BLOCKS_PER_RUN || 2000);  // D6 (~3.2 h of chain)
const CONFIRM_LAG  = Number(process.env.CONFIRM_LAG || 3);            // stay behind head so the LCD tx index has the block
const DEFAULT_LOOKBACK = Number(process.env.TLA_LOOKBACK || 700);     // cursor-migration fallback only (~1 h)
const { forwardDistributions } = require('./lib/distributions.js');
const { forwardVoteState } = require('./lib/vote-state.js');
const { buildRollups4 } = require('./lib/rollups.js');
const { forwardBribeState } = require('./lib/bribe-state.js');

// ----------------------------------------------------------------------------- action maps
// CHAIN-CONFIRMED — gauge + escrow (probe 2026-06-15); incentive mgr:
// CHAIN-CONFIRMED (probe + seed 2026-07-07) — incentive manager (add_bribe).
const VOTE_ACTION_KEYS = { vote: 'vote' };

const LOCK_ACTION_KEYS = {
    create_lock: 'lock_create',
    extend_lock_amount: 'lock_extend_amount',
    extend_lock_time: 'lock_extend_time',
    merge_lock: 'merge',
    split_lock: 'split',
    migrate_lock: 'migrate',
    lock_permanent: 'lock_permanent',
    unlock_permanent: 'unlock_permanent',
    withdraw: 'withdraw', unlock: 'withdraw',
    transfer_nft: 'lock_transfer',
    deposit_for: 'lock_deposit_for',
};
const LOCK_HOOK_KEYS = { create_lock: 'lock_create', extend_lock_amount: 'lock_extend_amount', deposit_for: 'lock_deposit_for' };

// Reward-class verbs (spec §3 reward-events). Wallet claims + protocol distributions.
const REWARD_GAUGE_KEYS = {           // on the gauge controller
    claim_bribes: 'claim_bribes',
    claim_rewards: 'claim_rewards',
    distribute_take_rate: 'distribute_take_rate',
    distribute_rebase: 'distribute_rebase',
    distribute_bribes: 'distribute_bribes',
};
const REWARD_ESCROW_KEYS = {          // on the voting escrow
    claim_rebase: 'claim_rebase',
    compound: 'compound',
};
const PROTOCOL_REWARD_TYPES = new Set(['distribute_take_rate', 'distribute_rebase', 'distribute_bribes']);

const BRIBE_ACTION_KEYS = {
    add_bribe: 'bribe_add', bribe: 'bribe_add', deposit_bribe: 'bribe_add', incentivize: 'bribe_add',
    withdraw_bribe: 'bribe_withdraw', remove_bribe: 'bribe_withdraw',
};

// ----------------------------------------------------------------------------- transport (injectable: mock-run.js monkey-patches T.*)
const KEEPALIVE_AGENT = new https.Agent({ keepAlive: true, maxSockets: 1, keepAliveMsecs: 30000 });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function realHttpGet(url, t = 40000) {
    // HARD deadline (flows 1.0.2 port): destroys the request when the wall
    // clock says so — an idle timeout alone lets a tarpit hang the run.
    return new Promise((res, rej) => {
        const r = https.get(url, { agent: KEEPALIVE_AGENT, headers: { Accept: 'application/json', Connection: 'keep-alive', 'User-Agent': 'org-tla-voting/2.0' } }, (x) => {
            let b = ''; x.on('data', c => b += c); x.on('end', () => {
                clearTimeout(killer);
                if (x.statusCode >= 200 && x.statusCode < 300) { try { res(JSON.parse(b)); } catch { rej(new Error('bad JSON')); } }
                else { const err = new Error(`HTTP ${x.statusCode} ${b.slice(0, 120)}`); err.statusCode = x.statusCode; rej(err); } });
        });
        const killer = setTimeout(() => r.destroy(new Error(`deadline ${t}ms`)), t);
        r.on('error', (e) => { clearTimeout(killer); rej(e); });
    });
}
function realGithubApiRequest(method, apiPath, body, accept) {
    return new Promise((resolve, reject) => {
        const opts = { hostname: 'api.github.com', path: apiPath, method, headers: { 'User-Agent': 'org-tla-voting', 'Authorization': `Bearer ${GITHUB_TOKEN}`, 'Accept': accept || 'application/vnd.github+json' } };
        if (body) opts.headers['Content-Type'] = 'application/json';
        const req = https.request(opts, res => { let data = ''; res.on('data', c => data += c); res.on('end', () => { if (res.statusCode >= 200 && res.statusCode < 300) { try { resolve(JSON.parse(data)); } catch { resolve(data); } } else { const err = new Error(`GitHub ${method} ${apiPath}: ${res.statusCode} ${data.slice(0, 200)}`); err.statusCode = res.statusCode; reject(err); } }); });
        req.on('error', reject); if (body) req.write(JSON.stringify(body)); req.end();
    });
}
const T = { httpGet: realHttpGet, githubApiRequest: realGithubApiRequest, now: () => new Date() };

async function rpcGet(p, label) {
    let lastErr;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try { return await T.httpGet(RPC_PRIMARY + p); } catch (e) { lastErr = e; }
        try { return await T.httpGet(RPC_FALLBACK + p); } catch (e) { lastErr = e; }
        await sleep(300 * attempt);
    }
    throw new Error(`${label}: RPC failed after retries (${lastErr && lastErr.message})`);
}
async function lcdGet(p, label) {
    let lastErr;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try { return await T.httpGet(TERRA_LCD_PRIMARY + p); } catch (e) { lastErr = e; }
        try { return await T.httpGet(TERRA_LCD_FALLBACK + p); } catch (e) { lastErr = e; }
        await sleep(300 * attempt);
    }
    throw new Error(`${label}: both LCDs failed after retries (${lastErr && lastErr.message})`);
}
async function tryGetJson(url, label) { try { return await T.httpGet(url); } catch (e) { console.warn(`  ⚠ ${label} fetch failed (non-fatal): ${e.message}`); return null; } }

// ----------------------------------------------------------------------------- GitHub publish + state reads (org standard: 409-retry, API raw media)
async function publishFile(filePath, contentObj, message) {
    const content = typeof contentObj === 'string' ? contentObj : JSON.stringify(contentObj, null, 2);
    const apiPath = `/repos/${GITHUB_REPO}/contents/${filePath}`;
    for (let attempt = 1; attempt <= 3; attempt++) {
        let sha = null;
        try { sha = (await T.githubApiRequest('GET', apiPath + `?ref=${GITHUB_BRANCH}`)).sha; } catch { /* new file */ }
        const body = { message, content: Buffer.from(content).toString('base64'), branch: GITHUB_BRANCH };
        if (sha) body.sha = sha;
        try { return await T.githubApiRequest('PUT', apiPath, body); }
        catch (e) {
            if (e.statusCode === 409 && attempt < 3) { console.warn(`  ⚠ 409 on ${filePath} — re-fetching sha (attempt ${attempt})`); await sleep(400 * attempt); continue; }
            throw e;
        }
    }
}
// ALL state reads via the authenticated Contents API with the raw media type —
// never the raw CDN (stale/429 under load), never base64 content (>1MB empty).
// Takes a FULL repo path (events + vote-state share this reader).
async function apiGetJson(repoPath) {
    try {
        const d = await T.githubApiRequest('GET', `/repos/${GITHUB_REPO}/contents/${repoPath}?ref=${GITHUB_BRANCH}`, null, 'application/vnd.github.raw');
        return { ok: true, data: typeof d === 'string' ? JSON.parse(d) : d };
    } catch (e) {
        if (e.statusCode === 404) return { ok: true, data: null };   // genuinely absent
        console.warn(`  ⚠ API read failed for ${repoPath}: ${e.message}`);
        return { ok: false, data: null };                            // UNKNOWN — not absent
    }
}

// ----------------------------------------------------------------------------- block walker (Rev C lift — SPEC-tla-flows-walker D1–D10)
const PRUNED = Symbol('pruned');
function isPrunedError(e) { return /not available|is not available|lowest height|pruned/i.test(String(e && e.message || e)); }

async function getHead() {
    const s = await rpcGet('/status', 'head');
    return Number(s.result.sync_info.latest_block_height);
}
async function getBlock(N) {
    let r;
    try { r = await rpcGet(`/block?height=${N}`, `block ${N}`); }
    catch (e) { if (isPrunedError(e)) return PRUNED; throw e; }
    if (r.error) { if (isPrunedError(r.error)) return PRUNED; throw new Error(`block ${N}: ${JSON.stringify(r.error).slice(0, 120)}`); }
    const b = r.result.block;
    return { time: String(b.header.time).slice(0, 19) + 'Z', txsB64: b.data.txs || [] };
}
async function getBlockResults(N) {
    const r = await rpcGet(`/block_results?height=${N}`, `block_results ${N}`);
    if (r.error) throw new Error(`block_results ${N}: ${JSON.stringify(r.error).slice(0, 120)}`);
    return r.result.txs_results || [];
}
const txHashOf = (b64) => crypto.createHash('sha256').update(Buffer.from(b64, 'base64')).digest('hex').toUpperCase();

// Gate: only txs touching one of the THREE governance contracts proceed to the
// decoded fetch + classification. Block data sees the whole chain — without
// the gate, foreign contracts' 'vote'/'claim' verbs would leak in.
function touchesWatched(events) {
    for (const e of events || []) {
        if (e.type !== 'wasm') continue;
        for (const a of e.attributes || [])
            if (a.key === '_contract_address' && WATCH_SET.has(a.value)) return true;
    }
    return false;
}
// Route decoded txs to per-contract classifier feeds (reproduces the tx_search
// per-contract sweeps EXACTLY — a tx touching several contracts appears in
// each feed; the reward dedup handles the union, as it always did).
function contractsTouched(events) {
    const s = new Set();
    for (const e of events || []) {
        if (e.type !== 'wasm') continue;
        for (const a of e.attributes || [])
            if (a.key === '_contract_address' && WATCH_SET.has(a.value)) s.add(a.value);
    }
    return s;
}

async function firstAvailable(lo, hi) {
    let lb = lo, ub = hi, best = hi;
    while (lb <= ub) {
        const mid = Math.floor((lb + ub) / 2);
        if ((await getBlock(mid)) === PRUNED) lb = mid + 1;
        else { best = mid; ub = mid - 1; }
    }
    return best;
}

// Walk [from..to]; collect GATED tx descriptors (hash/height/code) — decoding
// happens after the walk (targeted LCD by-hash lookups). Partial progress is
// safe to commit (walker D8); returns { watched, processedTo, gaps }.
async function walkBlocks(from, to, budgetNote) {
    const CONC = Number(process.env.WALK_CONCURRENCY || 4);
    const watched = [], gaps = [];
    let N = from, inFlight = new Map();
    const launch = (h) => { if (h <= to && !inFlight.has(h)) inFlight.set(h, getBlock(h)); };
    for (let h = N; h < N + CONC && h <= to; h++) launch(h);
    let lastLog = Date.now();
    while (N <= to) {
        let blk;
        try { blk = await inFlight.get(N); } catch (e) { inFlight.delete(N); throw Object.assign(e, { atBlock: N }); }
        inFlight.delete(N);
        if (blk === PRUNED) {
            const avail = await firstAvailable(N, to + 1);
            gaps.push({ from_height: N, to_height: avail - 1, recorded_at: T.now().toISOString(), reason: 'blocks pruned on both RPC endpoints' });
            console.warn(`  ⚠ blocks ${N}–${avail - 1} pruned — gap recorded, jumping`);
            for (const k of [...inFlight.keys()]) if (k < avail) inFlight.delete(k);
            N = avail; if (N > to) break;
            for (let h = N; h < N + CONC && h <= to; h++) launch(h);
            continue;
        }
        if (blk.txsB64.length) {
            let results;
            try { results = await getBlockResults(N); }
            catch (e) { throw Object.assign(e, { atBlock: N }); }
            for (let i = 0; i < blk.txsB64.length; i++) {
                const res = results[i]; if (!res) continue;
                if (Number(res.code || 0) !== 0) continue;             // failed txs never classified
                if (!touchesWatched(res.events)) continue;             // the gate
                watched.push({ hash: txHashOf(blk.txsB64[i]), height: N, blockTime: blk.time });
            }
        }
        if (Date.now() - lastLog > 15000) { console.log(`  walked to ${N} (${to - N} to go, ${watched.length} watched txs)`); lastLog = Date.now(); }
        N++; launch(N + CONC - 1);
    }
    return { watched, processedTo: to, gaps, note: budgetNote };
}

// Decoded tx by hash (LCD GetTx). We only ask for txs PROVEN to exist by block
// data, at most hours old — well inside index retention. Persistent failure is
// a run-abort (cursor holds; the window re-walks) — a known-watched tx is
// never skipped.
async function fetchDecodedTx(hash, height, blockTime) {
    const r = await lcdGet(`/cosmos/tx/v1beta1/txs/${hash}`, `tx ${hash.slice(0, 12)}`);
    const tr = r && r.tx_response;
    if (!tr) throw new Error(`tx ${hash.slice(0, 12)}: no tx_response in LCD reply`);
    if (!tr.tx && r.tx) tr.tx = r.tx;
    if (!tr.timestamp) tr.timestamp = blockTime;
    if (String(tr.txhash).toUpperCase() !== hash) throw new Error(`tx ${hash.slice(0, 12)}: LCD hash mismatch (${tr.txhash})`);
    if (Number(tr.height) !== height) throw new Error(`tx ${hash.slice(0, 12)}: LCD height ${tr.height} ≠ block ${height}`);
    return tr;
}

// SHARED CLASSIFIER — <<CLASSIFIER v6>> (2.2.0, SPEC-tla-voting-bribe-state D6).
// v6 = v5 + the contract-initiated bribe promotion (extractContractBribes +
// extractTrackBribeCallbacks + one hook in classifyIncentiveTxs) — nothing
// else. v5 = v4 + the rebase-income promotion. v4 = v3 + the lock token_id
// promotion. Since 2.0.0 this cron is the classifier's SOLE live home: the seed
// and fcd-fill are layout-guarded off and keep v3 for git-history reference.
// Any future monthly-aware fill must lift the CURRENT block FROM HERE and
// diff-verify it (the standing rule).
// =============================================================================

// ----------------------------------------------------------------------------- msg decoding
function decodeMaybeB64(v) {
    if (v == null) return null;
    if (typeof v === 'object') return v;
    if (typeof v === 'string') { try { return JSON.parse(Buffer.from(v, 'base64').toString('utf8')); } catch { return null; } }
    return null;
}
function wasmActions(tr) {
    const acts = new Set();
    for (const ev of tr?.events || []) {
        if (ev.type !== 'wasm') continue;
        for (const kv of ev.attributes || []) if (kv.key === 'action' && kv.value) acts.add(kv.value);
    }
    return acts;
}
function normalizeAssetId(asset) {
    if (asset == null) return null;
    if (typeof asset === 'string') return asset;
    if (asset.cw20) return `cw20:${asset.cw20}`;
    if (asset.native) return `native:${asset.native}`;
    if (asset.token?.contract_addr) return `cw20:${asset.token.contract_addr}`;
    if (asset.native_token?.denom) return `native:${asset.native_token.denom}`;
    return JSON.stringify(asset);
}
function extractVotes(voteArgs) {
    const arr = voteArgs?.votes || voteArgs?.weights || voteArgs?.allocations || voteArgs?.gauge_votes;
    if (!Array.isArray(arr)) return null;
    const out = [];
    for (const v of arr) {
        if (Array.isArray(v) && v.length >= 2) out.push([normalizeAssetId(v[0]), Number(v[1])]);
        else if (v && typeof v === 'object') {
            const asset = v.asset ?? v.pool ?? v.gauge ?? v.id;
            const bps = v.bps ?? v.weight ?? v.amount ?? v.power;
            if (asset != null && bps != null) out.push([normalizeAssetId(asset), Number(bps)]);
        }
    }
    return out.length ? out : null;
}

// ----------------------------------------------------------------------------- amount extraction (spec §3 hard rule: amounts + denoms on everything)
// Coins as raw strings — pricing is downstream (price-history join). Two sources:
//   1. cosmos coin_received events filtered to a receiver (wallet claims)
//   2. cw20 wasm `transfer/mint` events filtered to a recipient
// Returns [{amount, denom}] (denom canonical native:/ibc-as-native:/cw20:), or
// null when nothing extractable — callers keep raw attrs so nothing is lost.
function parseCoinString(s) {
    // "12345uluna" | "67ibc/ABCD..." | comma-joined multi-coin
    const out = [];
    for (const part of String(s).split(',')) {
        const m = part.trim().match(/^(\d+)([a-zA-Z/][a-zA-Z0-9/._-]*)$/);
        if (m) out.push({ amount: m[1], denom: `native:${m[2]}` });
    }
    return out;
}
function coinsReceivedBy(tr, addr) {
    if (!addr) return null;
    const coins = [];
    for (const ev of tr?.events || []) {
        if (ev.type === 'coin_received') {
            let recv = null, amt = null;
            for (const kv of ev.attributes || []) {
                if (kv.key === 'receiver') recv = kv.value;
                if (kv.key === 'amount') amt = kv.value;
            }
            if (recv === addr && amt) coins.push(...parseCoinString(amt));
        } else if (ev.type === 'wasm') {
            // cw20 transfer/mint to the wallet: attributes action/to|recipient/amount + _contract_address
            let action = null, to = null, amt = null, contract = null;
            for (const kv of ev.attributes || []) {
                if (kv.key === 'action') action = kv.value;
                if (kv.key === 'to' || kv.key === 'recipient') to = kv.value;
                if (kv.key === 'amount') amt = kv.value;
                if (kv.key === '_contract_address') contract = kv.value;
            }
            if ((action === 'transfer' || action === 'mint') && to === addr && amt && /^\d+$/.test(amt) && contract) {
                coins.push({ amount: amt, denom: `cw20:${contract}` });
            }
        }
    }
    if (!coins.length) return null;
    // merge same-denom legs
    const byDenom = new Map();
    for (const c of coins) byDenom.set(c.denom, (BigInt(byDenom.get(c.denom) || 0) + BigInt(c.amount)).toString());
    return [...byDenom.entries()].map(([denom, amount]) => ({ amount, denom }));
}
// All coins moved in a tx (for protocol distributions, where there's no single
// wallet recipient): sum coin_received across the tx by denom.
function coinsMovedInTx(tr) {
    const byDenom = new Map();
    for (const ev of tr?.events || []) {
        if (ev.type !== 'coin_received') continue;
        let amt = null;
        for (const kv of ev.attributes || []) if (kv.key === 'amount') amt = kv.value;
        if (amt) for (const c of parseCoinString(amt)) byDenom.set(c.denom, (BigInt(byDenom.get(c.denom) || 0) + BigInt(c.amount)).toString());
    }
    if (!byDenom.size) return null;
    return [...byDenom.entries()].map(([denom, amount]) => ({ amount, denom }));
}

// ----------------------------------------------------------------------------- classify: votes + rewards (one unfiltered gauge pass)
// Reward events are built by ONE helper used by BOTH the gauge and incentive
// sweeps: distribute-txs touch multiple contracts, so each sweep may see the
// same tx. Identical objects from either sweep dedup to one (union coverage,
// zero double-count) — the helper must stay deterministic on the tx alone.
function rewardEventFromMsg(key, m, mi, tr, meta) {
    const rtype = REWARD_GAUGE_KEYS[key];
    if (!rtype) return null;
    const a = m.msg[key] || {};
    if (PROTOCOL_REWARD_TYPES.has(rtype)) {
        // gross coin movement across the tx — an upper-bound view of the pot
        // (multi-hop transfers count each hop); honest basis flagged on-event.
        return { type: rtype, kind: 'protocol_distribution', wallet: null, executor: m.sender || null, msg_index: mi, ...meta, gauge: a.gauge ?? null, coins: coinsMovedInTx(tr), coins_basis: 'gross_coin_received', args: a };
    }
    return { type: rtype, kind: 'wallet_claim', wallet: m.sender, msg_index: mi, ...meta, gauge: a.gauge ?? null, coins: coinsReceivedBy(tr, m.sender), args: a };
}
function classifyGaugeTxs(txResponses, discovered) {
    const voteEvents = [], rewardEvents = [];
    for (const tr of txResponses) {
        const meta = { height: Number(tr.height), timestamp: tr.timestamp, tx_hash: tr.txhash };
        (tr?.tx?.body?.messages || []).forEach((m, mi) => {
            const msg = m?.msg; if (!msg || typeof msg !== 'object') return;
            const key = Object.keys(msg)[0]; if (!key) return;
            discovered[`gauge:${key}`] = (discovered[`gauge:${key}`] || 0) + 1;
            const a = msg[key] || {};
            if (VOTE_ACTION_KEYS[key] === 'vote') {
                voteEvents.push({ type: 'vote', wallet: m.sender, msg_index: mi, ...meta, gauge: a.gauge ?? null, votes: extractVotes(a), raw_msg: extractVotes(a) ? undefined : a });
                return;
            }
            const re = rewardEventFromMsg(key, m, mi, tr, meta);
            if (re) rewardEvents.push(re);
        });
    }
    return { voteEvents, rewardEvents };
}

// ----------------------------------------------------------------------------- classify: locks + escrow rewards (one escrow pass)
function isCanonicalLock(type) {
    if (!type.startsWith('event:')) return true;
    return type.startsWith('event:ve/');
}
// v4 token_id promotion (SPEC-tla-voting-capture-fix D9). Chain-truth sources,
// both on the ESCROW contract's own events:
//   • create_lock → CW721 wasm {action:'mint', token_id, owner} (proven on the
//     real FCD tx 09A186D9…: token_id 542) — owner must match the event wallet
//     when both are present (multi-actor txs).
//   • deposit_for / extends → metadata-update events carrying token_id
//     (the ve/deposit_for ↔ wasm-metadata_changed pairing, Rev 4).
// Ambiguity (0 or 2+ distinct candidates) stays null — honest, never guessed.
function extractLockTokenId(tr, wallet) {
    const cands = new Set();
    for (const ev of tr?.events || []) {
        const t = ev.type || '';
        if (t !== 'wasm' && !/metadata_changed/i.test(t)) continue;
        let contract = null, action = null, tokenId = null, owner = null;
        for (const kv of ev.attributes || []) {
            if (kv.key === '_contract_address') contract = kv.value;
            else if (kv.key === 'action') action = kv.value;
            else if (kv.key === 'token_id') tokenId = kv.value;
            else if (kv.key === 'owner') owner = kv.value;
        }
        if (contract !== TLA_VOTING_ESCROW || tokenId == null) continue;
        if (t === 'wasm' && action !== 'mint' && !/metadata_changed/i.test(action || '')) continue;
        if (owner && wallet && owner !== wallet) continue;
        cands.add(String(tokenId));
    }
    return cands.size === 1 ? [...cands][0] : null;
}
// v5 rebase-income promotion (SPEC-tla-voting-rollups D6). The GAUGE's own
// wasm event `{action:'gauge/claim_rebase', rebase_amount, user}` declares the
// claimed amount even when the recipient is a wrapper (chain-proven on the
// live probe tx 9B2DD008… — Votion vault compound, rebase_amount 13966383;
// trimmed fixture: fixtures/compound_probe.json). Used to fill coins on
// compound events (income measured at the gauge boundary — pre-swap,
// pre-wrapper-fee) and as a backstop for claim_rebase when the coin parse
// found nothing. The denom is taken from the same-tx cw20 transfer OUT OF the
// gauge with the exact amount (chain-derived); ampLUNA constant is the last
// resort. Ambiguity (0 or 2+ candidate events for the claimer) stays null.
const AMPLUNA_CW20 = 'terra1ecgazyd0waaj3g7l9cmy5gulhxkps2gmxu9ghducvuypjq68mq2s5lvsct';
function extractRebaseIncome(tr, claimers) {
    const cands = [];
    for (const ev of tr?.events || []) {
        if (ev.type !== 'wasm') continue;
        let contract = null, action = null, amt = null, user = null;
        for (const kv of ev.attributes || []) {
            if (kv.key === '_contract_address') contract = kv.value;
            else if (kv.key === 'action') action = kv.value;
            else if (kv.key === 'rebase_amount') amt = kv.value;
            else if (kv.key === 'user') user = kv.value;
        }
        if (contract !== TLA_GAUGE_CONTROLLER || action !== 'gauge/claim_rebase') continue;
        if (!amt || !/^\d+$/.test(amt) || amt === '0') continue;
        if (user && claimers.length && !claimers.includes(user)) continue;
        cands.push(amt);
    }
    if (cands.length !== 1) return null;
    const amount = cands[0];
    let denom = null;
    for (const ev of tr?.events || []) {
        if (ev.type !== 'wasm') continue;
        let contract = null, action = null, amt = null, from = null;
        for (const kv of ev.attributes || []) {
            if (kv.key === '_contract_address') contract = kv.value;
            else if (kv.key === 'action') action = kv.value;
            else if (kv.key === 'amount') amt = kv.value;
            else if (kv.key === 'from') from = kv.value;
        }
        if (action === 'transfer' && from === TLA_GAUGE_CONTROLLER && amt === amount && contract) { denom = `cw20:${contract}`; break; }
    }
    return [{ amount, denom: denom || `cw20:${AMPLUNA_CW20}` }];
}
function classifyEscrowTxs(txResponses, discovered) {
    const lockEvents = [], rewardEvents = [];
    for (const tr of txResponses) {
        const meta = { height: Number(tr.height), timestamp: tr.timestamp, tx_hash: tr.txhash };
        const acts = wasmActions(tr);
        let matchedThisTx = false;
        const lockStart = lockEvents.length; // v4: token_id promotion bracket
        (tr?.tx?.body?.messages || []).forEach((m, mi) => {
            const msg = m?.msg; if (!msg || typeof msg !== 'object') return;
            const key = Object.keys(msg)[0]; if (!key) return;

            if (key === 'send' && msg.send?.contract === TLA_VOTING_ESCROW) {
                const inner = decodeMaybeB64(msg.send.msg);
                const innerKey = inner ? Object.keys(inner)[0] : null;
                discovered[`escrow_hook:${innerKey || 'undecodable'}`] = (discovered[`escrow_hook:${innerKey || 'undecodable'}`] || 0) + 1;
                const type = innerKey && LOCK_HOOK_KEYS[innerKey];
                if (type) { const ia = inner[innerKey] || {}; lockEvents.push({ type, canonical: isCanonicalLock(type), wallet: m.sender, msg_index: mi, ...meta,
                    token_id: ia.token_id != null ? String(ia.token_id) : null,
                    asset: m.contract ? `cw20:${m.contract}` : null,
                    amount: msg.send.amount != null ? String(msg.send.amount) : null,
                    lock_seconds: ia.time != null ? Number(ia.time) : null,
                    funded_by_cw20: true, args: ia }); matchedThisTx = true; }
                return;
            }
            discovered[`escrow:${key}`] = (discovered[`escrow:${key}`] || 0) + 1;
            const a = msg[key] || {};
            const rtype = REWARD_ESCROW_KEYS[key];
            if (rtype) {
                const ev = { type: rtype, kind: 'wallet_claim', wallet: m.sender, msg_index: mi, ...meta, token_id: a.token_id != null ? String(a.token_id) : null, coins: coinsReceivedBy(tr, m.sender), args: a };
                // v5: rebase-income promotion — when the coin parse found nothing
                // (compound restakes; wrapped claims pay the wrapper), the gauge's
                // own gauge/claim_rebase event declares the claimed amount. The
                // claimer is the msg sender (direct) or the msg target contract
                // (wrapped — e.g. a Votion vault). True zero-claims stay null.
                if (!ev.coins) {
                    const inc = extractRebaseIncome(tr, [m.sender, m.contract].filter(Boolean));
                    if (inc) { ev.coins = inc; ev.coins_source = 'gauge_event'; }
                }
                rewardEvents.push(ev);
                matchedThisTx = true;
                return;
            }
            const type = LOCK_ACTION_KEYS[key];
            if (!type) return;
            lockEvents.push({ type, canonical: isCanonicalLock(type), wallet: m.sender, msg_index: mi, ...meta,
                token_id: a.token_id != null ? String(a.token_id) : (a.lock_id != null ? String(a.lock_id) : null),
                token_id_add: a.token_id_add != null ? String(a.token_id_add) : null,
                asset: a.asset ? normalizeAssetId(a.asset) : null,
                into_asset: a.into ? normalizeAssetId(a.into) : null,
                amount: a.amount != null ? String(a.amount) : null,
                lock_seconds: a.time != null ? Number(a.time) : null,
                recipient: a.recipient || null,
                args: a });
            matchedThisTx = true;
        });
        if (!matchedThisTx) {
            for (const act of acts) {
                if (/lock|deposit|withdraw|relock|merge|extend/i.test(act)) {
                    discovered[`escrow_event:${act}`] = (discovered[`escrow_event:${act}`] || 0) + 1;
                    lockEvents.push({ type: `event:${act}`, canonical: isCanonicalLock(`event:${act}`), wallet: tr?.tx?.body?.messages?.[0]?.sender || null, msg_index: 0, ...meta, via: 'wasm_event', args_unknown: true });
                }
            }
        }
        // v4: fill null token_ids for this tx's lock events from the tx's own
        // wasm events (mint / metadata_changed). Fixes the 1,306-null-create
        // defect forward from 2.0.0; source flagged for provenance.
        for (let li = lockStart; li < lockEvents.length; li++) {
            const le = lockEvents[li];
            if (le.token_id == null) {
                const tid = extractLockTokenId(tr, le.wallet);
                if (tid != null) { le.token_id = tid; le.token_id_source = 'wasm_event'; }
            }
        }
    }
    return { lockEvents, rewardEvents };
}

// ----------------------------------------------------------------------------- classify: bribes (incentive manager)
// add_bribe shape CHAIN-CONFIRMED (probe 2026-07-07):
//   { bribe: { amount, info:{cw20|native} },          ← the actual bribe coins
//     for_info: {cw20|native},                        ← the TARGET pool asset
//     distribution: { func: { start, end, func_type } } ← native EPOCH RANGE }
//   + msg funds = [10000000 uluna]                    ← anti-spam FEE, not the bribe
// Rules learned from the probe:
//   • tx_search returns any tx TOUCHING the contract — only messages ADDRESSED
//     to the incentive manager (m.contract, or send-hook targeting it) are
//     classified here; other messages in the tx are counted-only (no thin junk
//     from cw20 increase_allowance approvals, compounder legs, etc.).
//   • Reward verbs (distribute_*, claim_bribes) also execute against this
//     contract — classified via the SAME rewardEventFromMsg helper as the
//     gauge sweep, so overlapping txs dedup to one reward event (union
//     coverage across sweeps).
function bribeEventFrom(type, sender, args, mi, meta, sendHook) {
    // Coin precedence: the msg's own bribe field (authoritative) > cw20 hook
    // amount > native funds. Funds are demoted to fee_funds whenever the bribe
    // field was parsed (probe proved funds = 10-LUNA anti-spam fee there).
    const bribeCoins = args?.bribe?.amount != null && args?.bribe?.info
        ? [{ amount: String(args.bribe.amount), denom: normalizeAssetId(args.bribe.info) }]
        : null;
    const hookCoins = sendHook?.contract && sendHook.amount != null
        ? [{ amount: String(sendHook.amount), denom: `cw20:${sendHook.contract}` }]
        : null;
    const fundCoins = Array.isArray(args?._funds) && args._funds.length
        ? args._funds.map(f => ({ amount: String(f.amount), denom: `native:${f.denom}` }))
        : null;
    const dist = args?.distribution?.func || null;
    return { type, briber: sender, msg_index: mi, ...meta,
        pool: args?.for_info ? normalizeAssetId(args.for_info)
            : (args?.asset ? normalizeAssetId(args.asset) : (args?.pool ? normalizeAssetId(args.pool) : (args?.lp ? normalizeAssetId(args.lp) : null))),
        gauge: args?.gauge ?? null,
        coins: bribeCoins || hookCoins || fundCoins || null,
        fee_funds: (bribeCoins || hookCoins) && fundCoins ? fundCoins : undefined,
        epoch_start: dist?.start ?? null, epoch_end: dist?.end ?? null, dist_func: dist?.func_type ?? null,
        args: (({ _funds, ...rest }) => rest)(args || {}) };
}
// v6 contract-bribe promotion (SPEC-tla-voting-bribe-state D6). The take-rate
// tribute flow — four bucket contracts calling add_bribe internally — carries
// NO top-level message addressed to the manager, so message-level
// classification is blind to it BY CONSTRUCTION (FCD census: 2,793 add_bribe
// events vs 173 captured; 751 FCD-era txs contract-initiated). The manager's
// own wasm event declares the deposit:
//   {action:'bribe/add_bribe', added:'<canonical-denom>:<amount>', start, end}
// (chain-proven on FCD tx 69D072693314…: two events, ASTRO 226225967 +
// 447102559, start=end=115). It carries NO pool and NO briber:
//   • briber = the initiating contract, resolved via the event's own
//     msg_index → that message's target (msg_index is a property on FCD-
//     trimmed events, an attribute on live LCD events); first-msg-target
//     fallback when absent. briber_source:'msg_target' either way.
//   • pool pairing from same-tx `asset/track_bribes_callback {asset, bribe}`
//     ONLY when a single unambiguous candidate matches denom+amount — the
//     add_bribe is bucket-AGGREGATED, so ambiguity (0 or 2+) stays null
//     (honest; state has the per-pool truth).
function parseDenomAmount(s) {
    // '<denom>:<amount>' where the denom itself contains colons — amount is
    // everything after the LAST colon ('native:ibc/8D8A…:226225967').
    const m = String(s || '').match(/^(.*):(\d+)$/);
    return m ? { denom: m[1], amount: m[2] } : null;
}
function eventMsgIndex(ev) {
    if (ev.msg_index != null && Number.isFinite(Number(ev.msg_index))) return Number(ev.msg_index);
    for (const kv of ev.attributes || []) if (kv.key === 'msg_index' && Number.isFinite(Number(kv.value))) return Number(kv.value);
    return null;
}
function extractContractBribes(tr) {
    const out = [];
    for (const ev of tr?.events || []) {
        if (ev.type !== 'wasm') continue;
        let contract = null, action = null, added = null, start = null, end = null;
        for (const kv of ev.attributes || []) {
            if (kv.key === '_contract_address') contract = kv.value;
            else if (kv.key === 'action') action = kv.value;
            else if (kv.key === 'added') added = kv.value;
            else if (kv.key === 'start') start = kv.value;
            else if (kv.key === 'end') end = kv.value;
        }
        if (contract !== TLA_INCENTIVE_MANAGER || action !== 'bribe/add_bribe') continue;
        out.push({
            coin: parseDenomAmount(added), added_raw: added ?? null,
            start: start != null && Number.isFinite(Number(start)) ? Number(start) : null,
            end: end != null && Number.isFinite(Number(end)) ? Number(end) : null,
            msg_index: eventMsgIndex(ev),
        });
    }
    return out;
}
function extractTrackBribeCallbacks(tr) {
    const out = [];
    for (const ev of tr?.events || []) {
        if (ev.type !== 'wasm') continue;
        let action = null, asset = null, bribe = null;
        for (const kv of ev.attributes || []) {
            if (kv.key === 'action') action = kv.value;
            else if (kv.key === 'asset') asset = kv.value;
            else if (kv.key === 'bribe') bribe = kv.value;
        }
        if (action !== 'asset/track_bribes_callback' || !asset || !bribe) continue;
        const coin = parseDenomAmount(bribe);
        if (coin) out.push({ asset, denom: coin.denom, amount: coin.amount });
    }
    return out;
}
function classifyIncentiveTxs(txResponses, discovered) {
    const bribeEvents = [], rewardEvents = [];
    for (const tr of txResponses) {
        const meta = { height: Number(tr.height), timestamp: tr.timestamp, tx_hash: tr.txhash };
        const bribeStart = bribeEvents.length;   // v6: contract-bribe promotion bracket
        (tr?.tx?.body?.messages || []).forEach((m, mi) => {
            const msg = m?.msg; if (!msg || typeof msg !== 'object') return;
            const key = Object.keys(msg)[0]; if (!key) return;

            // cw20 send-hook bribe funding (bribe paid via cw20 `send` to the mgr)
            if (key === 'send' && msg.send?.contract === TLA_INCENTIVE_MANAGER) {
                const inner = decodeMaybeB64(msg.send.msg);
                const innerKey = inner ? Object.keys(inner)[0] : null;
                discovered[`incentive_hook:${innerKey || 'undecodable'}`] = (discovered[`incentive_hook:${innerKey || 'undecodable'}`] || 0) + 1;
                const ia = { ...(inner?.[innerKey] || {}) };
                const type = (innerKey && BRIBE_ACTION_KEYS[innerKey]) || `event:incentive_hook/${innerKey || 'undecodable'}`;
                bribeEvents.push(bribeEventFrom(type, m.sender, ia, mi, meta, { contract: m.contract, amount: msg.send.amount }));
                return;
            }

            // messages NOT addressed to the incentive manager: counted-only context
            if (m.contract !== TLA_INCENTIVE_MANAGER) {
                discovered[`incentive_ctx:${key}`] = (discovered[`incentive_ctx:${key}`] || 0) + 1;
                return;
            }
            discovered[`incentive:${key}`] = (discovered[`incentive:${key}`] || 0) + 1;

            // reward verbs on this contract → shared helper (dedups with gauge sweep)
            const re = rewardEventFromMsg(key, m, mi, tr, meta);
            if (re) { rewardEvents.push(re); return; }

            const a = { ...(msg[key] || {}) };
            if (Array.isArray(m.funds) && m.funds.length) a._funds = m.funds; // fee or native bribe funding
            const type = BRIBE_ACTION_KEYS[key] || `event:incentive/${key}`;
            bribeEvents.push(bribeEventFrom(type, m.sender, a, mi, meta, null));
        });
        // v6 hook: a manager-touching tx that produced NO bribe event from
        // top-level msgs — promote the manager's own bribe/add_bribe events
        // (the take-rate tribute flow). Direct bribes never reach here (their
        // msg already classified above), so v3–v5 behavior is unchanged.
        if (bribeEvents.length === bribeStart) {
            const promoted = extractContractBribes(tr);
            if (promoted.length) {
                const msgs = tr?.tx?.body?.messages || [];
                const callbacks = extractTrackBribeCallbacks(tr);
                promoted.forEach((pb, pi) => {
                    discovered['incentive_event:bribe/add_bribe'] = (discovered['incentive_event:bribe/add_bribe'] || 0) + 1;
                    const initMsg = (pb.msg_index != null && msgs[pb.msg_index]) ? msgs[pb.msg_index] : msgs[0];
                    const matches = pb.coin ? callbacks.filter(c => c.denom === pb.coin.denom && c.amount === pb.coin.amount) : [];
                    bribeEvents.push({
                        type: 'bribe_add', via: 'wasm_event',
                        briber: initMsg?.contract || null, briber_source: 'msg_target',
                        msg_index: pb.msg_index != null ? pb.msg_index : 1000 + pi,   // dedup-key uniqueness when the attr is absent
                        ...meta,
                        pool: matches.length === 1 ? matches[0].asset : null,        // aggregated add — ambiguity stays null
                        gauge: null,
                        coins: pb.coin ? [{ amount: pb.coin.amount, denom: pb.coin.denom }] : null,
                        epoch_start: pb.start, epoch_end: pb.end, dist_func: null,
                        args: { added: pb.added_raw, start: pb.start, end: pb.end },
                    });
                });
            }
        }
    }
    return { bribeEvents, rewardEvents };
}

// ----------------------------------------------------------------------------- merge / dedup (F3 support)
// v3 dedup key includes msg_index (multi-message txs: distributions, multicalls).
function eventKey(e) { return `${e.tx_hash}|${e.type}|${e.wallet ?? e.briber ?? ''}|${e.msg_index ?? ''}`; }
function mergeEvents(prior, fresh) {
    const byKey = new Map();
    for (const e of prior) byKey.set(eventKey(e), e);
    let added = 0;
    for (const e of fresh) { const k = eventKey(e); if (!byKey.has(k)) { byKey.set(k, e); added++; } }
    const merged = [...byKey.values()].sort((a, b) => (a.height - b.height) || String(a.tx_hash).localeCompare(String(b.tx_hash)) || ((a.msg_index ?? 0) - (b.msg_index ?? 0)));
    return { merged, added };
}

// ----------------------------------------------------------------------------- epoch mapping (1-indexed canonical)
function makeEpochResolver(epochDates) {
    if (!Array.isArray(epochDates) || !epochDates.length) return () => null;
    const rows = epochDates.map(r => ({ epoch: r.epoch, start: Date.parse(r.start_time), end: Date.parse(r.end_time) })).filter(r => Number.isFinite(r.start));
    return (iso) => { const t = Date.parse(iso); if (!Number.isFinite(t)) return null; for (const r of rows) if (t >= r.start && t < r.end) return r.epoch; const last = rows[rows.length - 1]; return (t >= last.end) ? last.epoch + Math.floor((t - last.end) / (7 * 864e5)) + 1 : null; };
}

// ----------------------------------------------------------------------------- rollups (layer 3 — recomputable; spec §3)
function buildRollups(voteEvents, lockEvents, bribeEvents, rewardEvents, epochOf) {
    const wallets = {};
    const w = (addr) => (wallets[addr] ||= { wallet: addr, vote_count: 0, first_vote_epoch: null, last_vote_epoch: null, pools_voted: {}, vote_changes: 0, locks: [], first_lock_ts: null, claimed: {} });
    let prevByWalletGauge = {};
    for (const e of voteEvents) {
        if (!e.wallet) continue;
        const r = w(e.wallet); r.vote_count++;
        const ep = epochOf(e.timestamp);
        if (ep != null) { if (r.first_vote_epoch == null || ep < r.first_vote_epoch) r.first_vote_epoch = ep; if (r.last_vote_epoch == null || ep > r.last_vote_epoch) r.last_vote_epoch = ep; }
        const gkey = `${e.wallet}|${e.gauge ?? ''}`;
        const sig = JSON.stringify((e.votes || []).slice().sort());
        if (prevByWalletGauge[gkey] != null && prevByWalletGauge[gkey] !== sig) r.vote_changes++;
        prevByWalletGauge[gkey] = sig;
        for (const [asset] of (e.votes || [])) if (asset) r.pools_voted[asset] = (r.pools_voted[asset] || 0) + 1;
    }
    for (const e of lockEvents) {
        if (!e.wallet) continue;
        const r = w(e.wallet);
        r.locks.push({ type: e.type, canonical: e.canonical !== false, token_id: e.token_id ?? null, asset: e.asset ?? null, amount: e.amount ?? null, timestamp: e.timestamp, epoch: epochOf(e.timestamp), tx_hash: e.tx_hash });
        if (r.first_lock_ts == null || Date.parse(e.timestamp) < Date.parse(r.first_lock_ts)) r.first_lock_ts = e.timestamp;
    }
    // claimed totals per wallet per denom (income line of P&L; raw integer strings)
    for (const e of rewardEvents) {
        if (e.kind !== 'wallet_claim' || !e.wallet || !Array.isArray(e.coins)) continue;
        const r = w(e.wallet);
        for (const c of e.coins) r.claimed[c.denom] = (BigInt(r.claimed[c.denom] || 0) + BigInt(c.amount)).toString();
    }
    for (const r of Object.values(wallets)) {
        r.vote_churn_rate = r.vote_count > 1 ? +(r.vote_changes / (r.vote_count - 1)).toFixed(4) : 0;
        r.pools_voted = Object.entries(r.pools_voted).sort((a, b) => b[1] - a[1]).map(([asset, n]) => ({ asset, times: n }));
        r.locks.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    }
    // per-briber per-epoch totals (raw denoms; attribution joins address-catalog downstream)
    const bribers = {};
    for (const e of bribeEvents) {
        if (!e.briber || e.type.startsWith('event:')) { /* thin events still counted below */ }
        const b = (bribers[e.briber || 'unknown'] ||= { briber: e.briber || null, event_count: 0, by_epoch: {} });
        b.event_count++;
        // add_bribe carries its NATIVE epoch range (distribution.func start/end)
        // — attribute to the range key ("193-200") when present, else to the
        // timestamp's epoch. Lossless: no fake per-epoch division of raw amounts.
        const ep = (e.epoch_start != null)
            ? (e.epoch_end != null && e.epoch_end !== e.epoch_start ? `${e.epoch_start}-${e.epoch_end}` : String(e.epoch_start))
            : (epochOf(e.timestamp) ?? 'unknown');
        const slot = (b.by_epoch[ep] ||= { pools: {}, coins: {} });
        if (e.pool) slot.pools[e.pool] = (slot.pools[e.pool] || 0) + 1;
        for (const c of e.coins || []) slot.coins[c.denom] = (BigInt(slot.coins[c.denom] || 0) + BigInt(c.amount)).toString();
    }
    // per-epoch protocol pots (earned-vs-claimed foundation)
    const pots = {};
    for (const e of rewardEvents) {
        if (e.kind !== 'protocol_distribution') continue;
        const ep = epochOf(e.timestamp) ?? 'unknown';
        const slot = (pots[ep] ||= {});
        const t = (slot[e.type] ||= {});
        for (const c of e.coins || []) t[c.denom] = (BigInt(t[c.denom] || 0) + BigInt(c.amount)).toString();
    }
    return {
        schemaVersion: SCHEMA_VERSION, builtAt: new Date().toISOString(),
        wallet_count: Object.keys(wallets).length,
        wallets: Object.values(wallets).sort((a, b) => b.vote_count - a.vote_count),
        bribers: Object.values(bribers).sort((a, b) => b.event_count - a.event_count),
        protocol_pots_by_epoch: pots,
    };
}
// <<CLASSIFIER v5 END>>

// ----------------------------------------------------------------------------- heartbeat (tla-core standard, schema 4)
async function publishHeartbeat(h) {
    const hb = {
        schemaVersion: SCHEMA_VERSION, cron: 'tla-voting', product: 'events', version: VERSION,
        capturedAt: h.startedAt.toISOString(), runId: `tla-voting-${h.startedAt.getTime().toString(36)}`,
        runMode: h.runMode || 'forward', status: h.status, note: h.note || undefined,
        counts: h.counts || {}, last_block: h.lastBlock ?? undefined, head: h.head ?? undefined,
        horizons: h.horizons || undefined,
        known_gaps_walker: h.walkerGaps && h.walkerGaps.length ? h.walkerGaps : undefined,
        vote_state: h.voteState || undefined,
        vote_capture: h.voteCapture || undefined,
        rollups: h.rollups || undefined,
        bribe_state: h.bribeState || undefined,
        bribe_capture: h.bribeCapture || undefined,
        next_expected_run_at: new Date(h.startedAt.getTime() + FORWARD_CADENCE_HOURS * 3600000).toISOString(),
        error_count: h.errors.length, recent_errors: h.errors.slice(-5),
    };
    try { await publishFile(`${OUT_DIR}/heartbeat.json`, hb, `tla-voting heartbeat ${h.status}`); }
    catch (e) { console.warn(`  ⚠ heartbeat publish failed: ${e.message}`); }
}

// ----------------------------------------------------------------------------- monthly stream files
const STREAM_OF = { vote: 'votes', lock: 'locks', bribe: 'bribes', reward: 'rewards' };
const monthKeyOf = (ts) => { const s = String(ts || ''); return { yyyy: s.slice(0, 4), mm: s.slice(5, 7) }; };

// ----------------------------------------------------------------------------- main (forward run)
async function run() {
    const startedAt = T.now();
    const errors = [];
    const addErr = (step, e) => { errors.push({ step, message: String(e && e.message || e) }); console.error(`  ✗ ${step}: ${e && e.message || e}`); };
    const discovered = {};
    console.log(`\n📜 org-tla-voting forward — ${startedAt.toISOString()} (${VERSION})\n`);
    if (!GITHUB_TOKEN) throw new Error('GITHUB_TOKEN missing — refusing to run (no publish target).');

    // 1. committed priors (authenticated API; fetch-failure ≠ absence)
    const ir = await apiGetJson(`${OUT_DIR}/index.json`);
    const cr = await apiGetJson(`${OUT_DIR}/cursor.json`);
    if (!ir.ok || !cr.ok) {
        await publishHeartbeat({ startedAt, status: 'error', errors: [{ step: 'priors', message: 'state read failed (API) — refusing to run on unknown priors' }] });
        throw new Error('state read failed — aborting rather than risk publishing over unknown state');
    }
    const index = ir.data;
    if (!index) {
        await publishHeartbeat({ startedAt, status: 'error', errors: [{ step: 'priors', message: 'events index absent — this cron never seeds' }], note: 'recover via the tla-core seed/restructure history, not a fresh start' });
        throw new Error('events index absent — forward cron never seeds.');
    }
    if (Number(index.schemaVersion) < 4 || !index.streams) {
        await publishHeartbeat({ startedAt, status: 'error', errors: [{ step: 'layout', message: `index schemaVersion ${index.schemaVersion} — monolith layout` }], note: 'run the tla-voting-restructure Action before deploying 2.0.0 (SPEC-tla-voting-capture-fix §6)' });
        throw new Error('events product is on the MONOLITH layout — dispatch tla-voting-restructure first.');
    }
    const epochDates = await tryGetJson(EPOCH_DATES_URL, 'epoch dates');
    const epochOf = makeEpochResolver(epochDates);

    // 2. cursor (schema 4: { last_block }; migrates the 1.x per-contract shape)
    let lastBlock = null, runMode = 'forward';
    const cursor = cr.data;
    if (cursor && cursor.last_block != null) lastBlock = Number(cursor.last_block);
    else if (cursor && cursor.contracts) {
        const hs = Object.values(cursor.contracts).map(c => Number(c.lastScannedHeight)).filter(Number.isFinite);
        if (hs.length) { lastBlock = Math.min(...hs); runMode = 'migrate-cursor'; console.log(`  cursor migrated from 1.x per-contract shape: last_block ${lastBlock} (min of frontiers)`); }
    }

    let head;
    try { head = await getHead(); }
    catch (e) { addErr('head', e); await publishHeartbeat({ startedAt, status: 'error', errors }); throw e; }
    const walkHead = head - CONFIRM_LAG;          // stay behind head so the LCD tx index has the block

    let fromB;
    if (lastBlock != null) fromB = lastBlock + 1;
    else { fromB = walkHead - DEFAULT_LOOKBACK; runMode = 'bootstrap'; console.log(`  no cursor: walking from ${fromB} (${DEFAULT_LOOKBACK} back) — events priors exist, so this is a cursor bootstrap, not a seed`); }
    if (fromB > walkHead) {
        console.log(`  no new blocks (cursor ${fromB - 1} >= walkable head ${walkHead})`);
        await publishHeartbeat({ startedAt, status: 'ok', errors, runMode, counts: { added: 0 }, lastBlock: fromB - 1, head });
        return;
    }

    // 3. budget (catch-up is safe partial progress in walker-world)
    let toB = walkHead, note;
    if (toB - fromB + 1 > BUDGET) { toB = fromB + BUDGET - 1; note = `catching-up (${walkHead - toB} blocks remain)`; runMode = 'catch-up'; console.log(`  budget: walking ${fromB}–${toB}, ${walkHead - toB} deferred to next run`); }

    // 4. walk → gated tx descriptors
    const priorWalkerGaps = Array.isArray(index.known_gaps_walker) ? [...index.known_gaps_walker] : [];
    let walk;
    try { walk = await walkBlocks(fromB, toB, note); }
    catch (e) {
        addErr(`walk@${e.atBlock || '?'}`, e);
        await publishHeartbeat({ startedAt, status: 'partial', errors, runMode, counts: { added: 0 }, lastBlock: lastBlock, head, walkerGaps: priorWalkerGaps });
        console.warn('  ⚠ walk failed — cursor NOT advanced (window will be re-walked)');
        return;
    }
    const walkerGaps = [...priorWalkerGaps, ...walk.gaps];
    const cursorTarget = walk.processedTo;
    console.log(`  walked ${fromB}–${cursorTarget}: ${walk.watched.length} gated tx(s)`);

    // 5. decode gated txs (targeted by-hash; failure aborts — never skip a known tx)
    const decoded = [];
    for (const w of walk.watched) {
        try { decoded.push(await fetchDecodedTx(w.hash, w.height, w.blockTime)); }
        catch (e) {
            addErr(`decode@${w.height}`, e);
            await publishHeartbeat({ startedAt, status: 'partial', errors, runMode, counts: { added: 0 }, lastBlock: lastBlock, head, walkerGaps: priorWalkerGaps, note: 'decoded-tx fetch failed — cursor held, window re-walks' });
            console.warn('  ⚠ decode failed — cursor NOT advanced (window will be re-walked)');
            return;
        }
    }
    decoded.sort((a, b) => Number(a.height) - Number(b.height) || (a.txhash < b.txhash ? -1 : 1));

    // 6. classify — per-contract feeds, exactly as the tx_search sweeps fed them
    const feeds = { gauge: [], escrow: [], incentive: [] };
    for (const tr of decoded) {
        const touched = contractsTouched(tr.events);
        if (touched.has(TLA_GAUGE_CONTROLLER))  feeds.gauge.push(tr);
        if (touched.has(TLA_VOTING_ESCROW))     feeds.escrow.push(tr);
        if (touched.has(TLA_INCENTIVE_MANAGER)) feeds.incentive.push(tr);
    }
    const g = classifyGaugeTxs(feeds.gauge, discovered);
    const e = classifyEscrowTxs(feeds.escrow, discovered);
    const i = classifyIncentiveTxs(feeds.incentive, discovered);
    const fresh = {
        votes:   g.voteEvents,
        locks:   e.lockEvents,
        bribes:  i.bribeEvents,
        rewards: [...g.rewardEvents, ...e.rewardEvents, ...i.rewardEvents],
    };
    console.log(`  classified: votes +${fresh.votes.length} locks +${fresh.locks.length} bribes +${fresh.bribes.length} rewards +${fresh.rewards.length}`);

    // 7. merge into touched month files (read → dedupe → never-shrink → publish)
    let allComplete = true;
    const addedByStream = { votes: 0, locks: 0, bribes: 0, rewards: 0 };
    for (const stream of ['votes', 'locks', 'bribes', 'rewards']) {
        const byMonth = {};
        for (const ev of fresh[stream]) {
            const { yyyy, mm } = monthKeyOf(ev.timestamp);
            if (!yyyy || !mm) { addErr(`month-key:${stream}`, new Error(`event without timestamp (tx ${ev.tx_hash})`)); allComplete = false; continue; }
            ((byMonth[yyyy] ||= {})[mm] ||= []).push(ev);
        }
        for (const yyyy of Object.keys(byMonth).sort()) {
            for (const mm of Object.keys(byMonth[yyyy]).sort()) {
                const repoPath = `${OUT_DIR}/${stream}/${yyyy}/${mm}.json`;
                const mr = await apiGetJson(repoPath);
                if (!mr.ok) { addErr(`month:${stream}/${yyyy}/${mm}`, new Error('month read failed — skipping publish this run')); allComplete = false; continue; }
                const existing = mr.data || [];
                if (!Array.isArray(existing)) { addErr(`month:${stream}/${yyyy}/${mm}`, new Error('existing month file is not an array — refusing to overwrite')); allComplete = false; continue; }
                const m = mergeEvents(existing, byMonth[yyyy][mm]);
                if (m.merged.length < existing.length) { addErr(`month:${stream}/${yyyy}/${mm}`, new Error(`never-shrink violation: merged ${m.merged.length} < committed ${existing.length}`)); allComplete = false; continue; }
                if (m.added === 0) { console.log(`  ${stream}/${yyyy}/${mm}: no new events`); continue; }
                try {
                    await publishFile(repoPath, JSON.stringify(m.merged), `tla-voting ${stream} ${yyyy}/${mm}: +${m.added} (${m.merged.length} total)`);
                    addedByStream[stream] += m.added;
                    const s = index.streams[stream];
                    if (s) {
                        s.count = (s.count || 0) + m.added;
                        ((s.months_present ||= {})[yyyy] ||= []).includes(mm) || s.months_present[yyyy].push(mm);
                        s.months_present[yyyy].sort();
                    }
                } catch (pe) { addErr(`publish:${stream}/${yyyy}/${mm}`, pe); allComplete = false; }
            }
        }
    }
    const totalAdded = Object.values(addedByStream).reduce((a, b) => a + b, 0);

    // 8. index (rollups.json stays FROZEN pending build #2 — noted, not touched)
    if (totalAdded > 0 || walk.gaps.length) {
        index.schemaVersion = SCHEMA_VERSION;
        index.updatedAt = startedAt.toISOString();
        index.known_gaps_walker = walkerGaps.length ? walkerGaps : undefined;
        if (index.files && index.files['rollups.json']) index.files['rollups.json'].note = 'schema 4 (SPEC-tla-voting-rollups) — rebuilt on harvest runs from vote-state ∪ events; pots live in distributions/history.json';
        try { await publishFile(`${OUT_DIR}/index.json`, index, `tla-voting index: +${totalAdded}`); }
        catch (pe) { addErr('publish:index', pe); allComplete = false; }
    }

    // 9. cursor LAST — advances only when every publish landed
    if (allComplete) {
        try {
            await publishFile(`${OUT_DIR}/cursor.json`, {
                schemaVersion: SCHEMA_VERSION, last_block: cursorTarget,
                window_walked: { from: fromB, to: cursorTarget }, updatedAt: startedAt.toISOString(),
            }, `tla-voting cursor @ ${cursorTarget}`);
        } catch (pe) { addErr('publish:cursor', pe); allComplete = false; }
    } else {
        console.warn('  ⚠ publish failure — cursor NOT advanced (window will be re-walked)');
    }

    // 10. distributions forward capture (unchanged — SPEC-distributions-capture §4)
    let dist = null;
    try {
        dist = await forwardDistributions({ publishFile, log: console });
        console.log(`  distributions: ${dist.skipped ? `skipped (${dist.reason})` : `+${dist.appended} → period ${dist.head}`}`);
    } catch (de) { addErr('distributions', de); console.warn(`  ⚠ distributions step failed (event streams unaffected): ${de.message}`); }

    // 11. vote-state harvest (SPEC-tla-voting-capture-fix §3) — the completeness
    // + attribution layer. Non-fatal to the event streams; failures surface in
    // its own product heartbeat AND here.
    let vs = null;
    try {
        const readVoteEvents = async () => {
            const months = [];
            const mp = index.streams?.votes?.months_present || {};
            for (const yyyy of Object.keys(mp).sort()) for (const mm of mp[yyyy]) months.push(`${OUT_DIR}/votes/${yyyy}/${mm}.json`);
            const all = [];
            for (const p of months) {
                const r = await apiGetJson(p);
                if (!r.ok) throw new Error(`vote month read failed: ${p}`);
                if (Array.isArray(r.data)) all.push(...r.data);
            }
            all.sort((a, b) => a.height - b.height || (a.tx_hash < b.tx_hash ? -1 : 1));
            return all;
        };
        vs = await forwardVoteState({ publishFile, apiGetJson, readVoteEvents, log: console });
        console.log(`  vote-state: ${vs.skipped ? `skipped (${vs.reason})` : `period ${vs.period} — ${vs.wallets} wallets, ${vs.voted} voted, ${vs.pending} pending`}`);
    } catch (ve) { addErr('vote-state', ve); console.warn(`  ⚠ vote-state step failed (event streams unaffected): ${ve.message}`); }

    // 11b. rollups schema 4 (SPEC-tla-voting-rollups D2) — rebuilt after a
    // clean full harvest (the run that already paid for reading vote months),
    // or on demand via FORCE_ROLLUPS=1. Pure derived; failures abort this
    // step only.
    let ru = null;
    const harvestLanded = vs && !vs.skipped && vs.pending === 0;
    if (harvestLanded || process.env.FORCE_ROLLUPS === '1') {
        try {
            ru = await buildRollups4({ apiGetJson, publishFile, epochOf, log: console });
            console.log(`  rollups: schema 5 rebuilt — ${ru.voters} voters, ${ru.bribers} bribers, period ${ru.built_on_period}`);
        } catch (re) { addErr('rollups', re); console.warn(`  ⚠ rollups step failed (streams/state unaffected): ${re.message}`); }
    }

    // 11c. bribe-state harvest (SPEC-tla-voting-bribe-state §2 — build #3): the
    // tribute completeness layer. Budgeted walk-down genesis capture + per-period
    // forward harvest + bribe_capture coverage. Failures abort this step only.
    let bs = null;
    try {
        const readBribeEvents = async () => {
            const all = [];
            const mp = index.streams?.bribes?.months_present || {};
            for (const yyyy of Object.keys(mp).sort()) for (const mm of mp[yyyy]) {
                const r = await apiGetJson(`${OUT_DIR}/bribes/${yyyy}/${mm}.json`);
                if (!r.ok) throw new Error(`bribe month read failed: ${yyyy}/${mm}`);
                if (Array.isArray(r.data)) all.push(...r.data);
            }
            return all;
        };
        bs = await forwardBribeState({ publishFile, apiGetJson, readBribeEvents, log: console });
        console.log(`  bribe-state: ${bs.skipped ? `skipped (${bs.reason})` : `+${bs.added} (fwd ${bs.forward_appended} / walk ${bs.walk_appended}) — walked to ${bs.walked_down_to ?? '—'}${bs.floor_period != null ? `, FLOOR ${bs.floor_period}` : ''}`}`);
    } catch (be) { addErr('bribe-state', be); console.warn(`  ⚠ bribe-state step failed (event streams unaffected): ${be.message}`); }

    // 12. heartbeat
    const status = (allComplete && !errors.length) ? 'ok' : (allComplete ? 'partial' : 'partial');
    const horizons = {};
    for (const s of Object.keys(index.streams || {})) if (index.streams[s].horizonHeight != null) horizons[s] = index.streams[s].horizonHeight;
    await publishHeartbeat({
        startedAt, status, errors, runMode, note,
        counts: { added: totalAdded, ...addedByStream, blocks_walked: cursorTarget - fromB + 1, gated_txs: walk.watched.length,
                  distributions_head: dist && dist.head || undefined },
        lastBlock: allComplete ? cursorTarget : lastBlock, head, horizons,
        walkerGaps,
        voteState: vs && !vs.skipped ? { period: vs.period, wallets: vs.wallets, voted: vs.voted, pending: vs.pending, lock_state: vs.lock_state } : (vs && vs.reason ? { skipped: vs.reason } : undefined),
        voteCapture: vs && vs.vote_capture || undefined,
        rollups: ru || undefined,
        bribeState: bs && !bs.skipped ? { added: bs.added, forward_appended: bs.forward_appended, walk_appended: bs.walk_appended, walked_down_to: bs.walked_down_to, floor_period: bs.floor_period, status: bs.status } : (bs && bs.reason ? { skipped: bs.reason } : undefined),
        bribeCapture: bs && bs.bribe_capture || undefined,
    });
    console.log(`\n✅ done — +${totalAdded} events (${JSON.stringify(addedByStream)}), cursor ${allComplete ? `advanced to ${cursorTarget}` : 'HELD'}, status ${status}${note ? ' · ' + note : ''}\n`);
}

// ----------------------------------------------------------------------------- entry
if (require.main === module) {
    run().catch(err => { console.error('FATAL:', err.message); process.exit(1); });
}

module.exports = { run, T, WATCH_SET, classifyGaugeTxs, classifyEscrowTxs, classifyIncentiveTxs, extractLockTokenId, extractContractBribes, extractTrackBribeCallbacks, parseDenomAmount, rewardEventFromMsg, bribeEventFrom, mergeEvents, buildRollups, extractVotes, normalizeAssetId, makeEpochResolver, isCanonicalLock, parseCoinString, coinsReceivedBy, coinsMovedInTx, eventKey, txHashOf, touchesWatched, contractsTouched, walkBlocks, fetchDecodedTx, publishFile, apiGetJson };
