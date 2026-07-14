// =============================================================================
// tla-voting / index.js — org-tla-voting (Render forward cron)
// TLA VOTING event capture: votes, locks, bribes, rewards — forward maintenance
// Spec: tla-core/docs/pending-changes/SPEC-tla-voting.md
// =============================================================================
//
// The FORWARD half of the tla-voting pipeline. The one-time seed lives in
// tla-core/.github/scripts/tla-voting/ (GitHub Action): it built
// tla-voting/events/ as if this cron had been running all along (incl. the
// legacy Aug-2024→Jun-2026 bootstrap). This cron picks up from there: every
// run sweeps the public nodes' retained tx window (~1 WEEK as of 2026-07-07 —
// they pruned hard; see README), classifies, merges append-only into the
// committed streams, and advances the cursor.
//
// ⚠ RETENTION STAKES: with a ~7-day public-node window, an outage longer than
// a few days loses events PERMANENTLY (recoverable only via archive node).
// The heartbeat monitor watching this cron is not optional. Any gap that does
// occur is recorded honestly in known_gaps — never silently papered over.
//
// One-contract-one-owner (spec §1): gauge + escrow + incentive manager belong
// to THIS cron. No other cron may scan them; this cron scans nothing else.
//
// This cron NEVER seeds: if the committed priors are unreachable it aborts
// with an error heartbeat rather than publishing a shallow "fresh start" over
// history. Recovery path = the seed Action, which owns bootstrap logic.
//
// Reliability: F1 resilient ASC pager (publicnode offset quirk), F2 null≠[],
// F3 never-shrink per stream, F7 heartbeat honesty + cursor advances only on
// complete scans, F8 honest horizons (only ever move down).
//
// The CLASSIFIER block below is BYTE-IDENTICAL to the seed script's
// (<<CLASSIFIER v3>> markers). Never edit one without the other — drift must
// be visible in a plain diff.
//
// Env (Render): GITHUB_TOKEN (scoped to tla-core), GITHUB_REPO
// (default thealliancedao/tla-core), GITHUB_BRANCH (main), LCD_PRIMARY /
// LCD_FALLBACK, MAX_PAGES (60), PAGER_* knobs. Schedule: 0 */6 * * *.
// =============================================================================

'use strict';

const https = require('https');
const C = require('../config/contracts.js');

// ----------------------------------------------------------------------------- constants
const TERRA_LCD_PRIMARY  = process.env.LCD_PRIMARY  || 'https://terra-lcd.publicnode.com';
const TERRA_LCD_FALLBACK = process.env.LCD_FALLBACK || 'https://terra-rest.publicnode.com';

// One-contract-one-owner: single source of truth is the shared config.
// (Constant names must match the seed's so the classifier block stays identical.)
const TLA_GAUGE_CONTROLLER  = C.GAUGE_CONTROLLER.addr;
const TLA_VOTING_ESCROW     = C.VOTING_ESCROW.addr;
const TLA_INCENTIVE_MANAGER = C.BRIBE_MANAGER.addr;

const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
const GITHUB_REPO   = process.env.GITHUB_REPO   || 'thealliancedao/tla-core';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const OUT_DIR       = 'tla-voting/events';

const EPOCH_DATES_URL = `https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_BRANCH}/docs/epoch_1-300_date.json`;

const SEED_MAX_PAGES = Number(process.env.MAX_PAGES || 60); // retained window is ~3 pages/contract; generous cap
const PAGE_LIMIT     = 100;
const SCHEMA_VERSION = 3;
const FORWARD_CADENCE_HOURS = 6;
const VERSION = 'org-tla-voting-1.1.0'; // 1.1.0 (2026-07-14): hard-deadline httpGet port (flows 1.0.2) + distributions forward capture (SPEC-distributions-capture §4)
const { forwardDistributions } = require('./lib/distributions.js');
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
// Counts from the 6/15 unfiltered sweep prove these exist at volume.
const REWARD_GAUGE_KEYS = {           // on the gauge controller
    claim_bribes: 'claim_bribes',                     // voter claims bribes
    claim_rewards: 'claim_rewards',
    distribute_take_rate: 'distribute_take_rate',     // protocol pots (per-epoch)
    distribute_rebase: 'distribute_rebase',
    distribute_bribes: 'distribute_bribes',
};
const REWARD_ESCROW_KEYS = {          // on the voting escrow
    claim_rebase: 'claim_rebase',                     // locker claims rebase
    compound: 'compound',                             // Votion-side compounding
};
const PROTOCOL_REWARD_TYPES = new Set(['distribute_take_rate', 'distribute_rebase', 'distribute_bribes']);

// PROVISIONAL bribe verbs (incentive manager) — sample run confirms/extends.
// Anything not listed still lands losslessly as `event:incentive/<key>`.
const BRIBE_ACTION_KEYS = {
    add_bribe: 'bribe_add', bribe: 'bribe_add', deposit_bribe: 'bribe_add', incentivize: 'bribe_add',
    withdraw_bribe: 'bribe_withdraw', remove_bribe: 'bribe_withdraw',
};

// ----------------------------------------------------------------------------- http (proven transport)
const KEEPALIVE_AGENT = new https.Agent({ keepAlive: true, maxSockets: 1, keepAliveMsecs: 30000 });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function httpGet(url, t = 40000) {
    // HARD deadline (flows 1.0.2 port, landed with SPEC-distributions-capture):
    // the previous r.setTimeout was an IDLE timeout — it resets on every byte,
    // so a tarpit trickling data hangs the run forever. This destroys the
    // request when the wall clock says so, regardless of activity.
    return new Promise((res, rej) => {
        const r = https.get(url, { agent: KEEPALIVE_AGENT, headers: { Accept: 'application/json', Connection: 'keep-alive', 'User-Agent': 'org-tla-voting/1.1' } }, (x) => {
            let b = ''; x.on('data', c => b += c); x.on('end', () => {
                clearTimeout(killer);
                if (x.statusCode >= 200 && x.statusCode < 300) { try { res(JSON.parse(b)); } catch { rej(new Error('bad JSON')); } }
                else rej(new Error(`HTTP ${x.statusCode} ${b.slice(0, 120)}`)); });
        });
        const killer = setTimeout(() => r.destroy(new Error(`deadline ${t}ms`)), t);
        r.on('error', (e) => { clearTimeout(killer); rej(e); });
    });
}
async function lcdGet(p, label) { try { return await httpGet(TERRA_LCD_PRIMARY + p); } catch (e) { try { return await httpGet(TERRA_LCD_FALLBACK + p); } catch (e2) { throw new Error(`${label}: both LCDs failed (${e2.message})`); } } }
async function tryGetJson(url, label) { try { return await httpGet(url); } catch (e) { console.warn(`  ⚠ ${label} fetch failed (non-fatal): ${e.message}`); return null; } }

// ----------------------------------------------------------------------------- tx_search (resilient ASC pager — verbatim from proven engine; F1)
async function fetchAllTxs(conds, label) {
    const RETRIES = +(process.env.PAGER_RETRIES || 40), ROUNDS = +(process.env.PAGER_ROUNDS || 2);
    const ERR_BACKOFF = +(process.env.PAGER_ERR_BACKOFF || 250), PROBE_DELAY = +(process.env.PAGER_PROBE_DELAY || 40);
    const CONTIG_DELTA = 250000, P1_STABLE = 12;
    const txPath = (page) => `/cosmos/tx/v1beta1/txs?query=${encodeURIComponent(conds.join(' AND '))}&order_by=ORDER_BY_ASC&page=${page}&limit=${PAGE_LIMIT}`;
    const out = [], seen = new Set();
    const stats = { calls: 0, pages: 0, regress: 0, far: 0, dup: 0, empty: 0, error: 0, reprobe: 0 };
    let frontier = 0, globalMax = 0, stop = 'complete';
    const scan = (batch) => { let freshMin = Infinity, fresh = 0; for (const tx of batch) { const h = Number(tx.height); if (h > globalMax) globalMax = h; if (!seen.has(tx.txhash)) { fresh++; if (h < freshMin) freshMin = h; } } return { fresh, freshMin }; };
    const commit = (batch) => { let added = 0; for (const tx of batch) { const h = Number(tx.height); if (h > frontier) frontier = h; if (!seen.has(tx.txhash)) { seen.add(tx.txhash); out.push(tx); added++; } } stats.pages++; return added; };

    let best1 = null, noImprove = 0, nonEmpty = 0;
    for (let a = 0; a < RETRIES; a++) {
        stats.calls++;
        let resp; try { resp = await lcdGet(txPath(1), `${label} p1.${a}`); } catch { stats.error++; await sleep(ERR_BACKOFF); continue; }
        const batch = resp?.tx_responses || [];
        if (!batch.length) { stats.empty++; await sleep(ERR_BACKOFF); continue; }
        scan(batch); nonEmpty++;
        const minH = Math.min(...batch.map(t => Number(t.height)));
        if (!best1 || minH < best1.minH) { best1 = { batch, minH }; noImprove = 0; } else { noImprove++; }
        if (a % 8 === 7) console.log(`  ${label}: probing page 1… best start-height=${best1 ? best1.minH : 'n/a'} (${a + 1} probes)`);
        if (nonEmpty >= 3 && noImprove >= P1_STABLE) break;
        await sleep(PROBE_DELAY);
    }
    if (!best1) { console.warn(`  ⚠ ${label}: page 1 unreachable after ${RETRIES} tries (treating as empty)`); return { txs: [], stop: 'p1-unreachable', globalMax: 0 }; }
    commit(best1.batch);
    console.log(`  ${label}: page1 start-height=${best1.minH} (${out.length} txs, frontier=${frontier})`);

    for (let page = 2; page < SEED_MAX_PAGES; page++) {
        const avg = out.length > 1 ? Math.max(1, (frontier - Number(out[0].height)) / (out.length - 1)) : 1;
        const TIGHT = Math.max(2000, 3 * avg), LOOSE = Math.max(50000, 10 * avg);
        let bestCand = null, rounds = 0;
        do {
            if (rounds > 0) stats.reprobe++;
            for (let a = 0; a < RETRIES; a++) {
                stats.calls++;
                let resp; try { resp = await lcdGet(txPath(page), `${label} p${page}.${a}`); } catch { stats.error++; await sleep(ERR_BACKOFF); continue; }
                const batch = resp?.tx_responses || [];
                if (!batch.length) { stats.empty++; await sleep(ERR_BACKOFF); continue; }
                const { fresh, freshMin } = scan(batch);
                if (fresh === 0) { stats.dup++; await sleep(PROBE_DELAY); continue; }
                if (freshMin < frontier) { stats.regress++; await sleep(PROBE_DELAY); continue; }
                if (freshMin - frontier > CONTIG_DELTA) { stats.far++; await sleep(PROBE_DELAY); continue; }
                if (!bestCand || freshMin < bestCand.freshMin) bestCand = { batch, freshMin };
                if (bestCand.freshMin - frontier <= TIGHT) break;
                await sleep(PROBE_DELAY);
            }
            rounds++;
        } while (frontier < globalMax && rounds < ROUNDS && (!bestCand || bestCand.freshMin - frontier > LOOSE));

        if (bestCand) {
            const added = commit(bestCand.batch);
            if (page % 10 === 0 || added === 0) console.log(`  ${label}: ${out.length} txs (page ${page}, frontier=${frontier}, +${added})`);
            if (page === SEED_MAX_PAGES - 1) { stop = 'page-cap'; console.warn(`  ⚠ ${label} hit page cap (${SEED_MAX_PAGES})`); }
            continue;
        }
        if (frontier >= globalMax) { stop = 'clean-end'; break; }
        stop = `stuck@page${page}`;
        console.warn(`  ⚠ ${label}: STUCK at page ${page} — frontier ${frontier} < globalMax ${globalMax}`);
        break;
    }
    out.sort((a, b) => Number(a.height) - Number(b.height) || (a.txhash < b.txhash ? -1 : 1));
    console.log(`  ${label}: DONE — ${out.length} txs | stop=${stop} | pages=${stats.pages} calls=${stats.calls} reprobe=${stats.reprobe} regress=${stats.regress} far=${stats.far} dup=${stats.dup} empty=${stats.empty} error=${stats.error}`);
    return { txs: out, stop, globalMax };
}

// SHARED CLASSIFIER — this section must stay BYTE-IDENTICAL with the copy in
// platform-crons/history/ (the Render forward cron). Any drift must show in a
// plain diff. Marker: <<CLASSIFIER v3>>
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
function classifyEscrowTxs(txResponses, discovered) {
    const lockEvents = [], rewardEvents = [];
    for (const tr of txResponses) {
        const meta = { height: Number(tr.height), timestamp: tr.timestamp, tx_hash: tr.txhash };
        const acts = wasmActions(tr);
        let matchedThisTx = false;
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
                rewardEvents.push({ type: rtype, kind: 'wallet_claim', wallet: m.sender, msg_index: mi, ...meta, token_id: a.token_id != null ? String(a.token_id) : null, coins: coinsReceivedBy(tr, m.sender), args: a });
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
function classifyIncentiveTxs(txResponses, discovered) {
    const bribeEvents = [], rewardEvents = [];
    for (const tr of txResponses) {
        const meta = { height: Number(tr.height), timestamp: tr.timestamp, tx_hash: tr.txhash };
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
// <<CLASSIFIER v3 END>>

// ----------------------------------------------------------------------------- github publish
function githubApiRequest(method, apiPath, body) {
    return new Promise((resolve, reject) => {
        const opts = { hostname: 'api.github.com', path: apiPath, method, headers: { 'User-Agent': 'org-tla-voting', 'Authorization': `Bearer ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github+json' } };
        if (body) opts.headers['Content-Type'] = 'application/json';
        const req = https.request(opts, res => { let data = ''; res.on('data', c => data += c); res.on('end', () => { if (res.statusCode >= 200 && res.statusCode < 300) { try { resolve(JSON.parse(data)); } catch { resolve(data); } } else reject(new Error(`GitHub ${method} ${apiPath}: ${res.statusCode} ${data.slice(0, 200)}`)); }); });
        req.on('error', reject); if (body) req.write(JSON.stringify(body)); req.end();
    });
}
async function publishFile(filePath, contentObj, message) {
    const content = typeof contentObj === 'string' ? contentObj : JSON.stringify(contentObj, null, 2);
    const apiPath = `/repos/${GITHUB_REPO}/contents/${filePath}`;
    let sha = null;
    try { sha = (await githubApiRequest('GET', apiPath + `?ref=${GITHUB_BRANCH}`)).sha; } catch { /* new file */ }
    const body = { message, content: Buffer.from(content).toString('base64'), branch: GITHUB_BRANCH };
    if (sha) body.sha = sha;
    return githubApiRequest('PUT', apiPath, body);
}
const RAW = (file) => `https://raw.githubusercontent.com/${GITHUB_REPO}/${GITHUB_BRANCH}/${OUT_DIR}/${file}?t=${Date.now()}`;

// ----------------------------------------------------------------------------- heartbeat (tla-core standard)
async function publishHeartbeat(h) {
    const hb = {
        schemaVersion: SCHEMA_VERSION, cron: 'tla-voting', product: 'events', version: VERSION,
        capturedAt: h.startedAt.toISOString(), runId: `tla-voting-${h.startedAt.getTime().toString(36)}`,
        runMode: 'forward', status: h.status, note: h.note || undefined,
        counts: h.counts || {}, last_heights: h.lastHeights || {}, horizons: h.horizons || {},
        known_gaps: h.gaps && Object.keys(h.gaps).length ? h.gaps : undefined,
        discovered_actions: h.discovered,
        next_expected_run_at: new Date(h.startedAt.getTime() + FORWARD_CADENCE_HOURS * 3600 * 1000).toISOString(),
        error_count: h.errors.length, recent_errors: h.errors,
    };
    try { await publishFile(`${OUT_DIR}/heartbeat.json`, hb, `tla-voting heartbeat ${h.status}`); }
    catch (e) { console.warn(`  ⚠ heartbeat publish failed: ${e.message}`); }
}
async function tryGetJson(url, label) { try { return await httpGet(url); } catch (e) { console.warn(`  ⚠ ${label} fetch failed: ${e.message}`); return null; } }

// ----------------------------------------------------------------------------- main (forward run)
async function run() {
    const startedAt = new Date();
    const errors = [];
    const addErr = (step, e) => errors.push({ step, message: String(e && e.message || e) });
    const discovered = {};
    console.log(`\n📜 org-tla-voting forward — ${startedAt.toISOString()} (${VERSION})\n`);
    if (!GITHUB_TOKEN) throw new Error('GITHUB_TOKEN missing — refusing to run (no publish target).');

    // committed priors + epoch dates. This cron NEVER seeds: all-priors-missing
    // means either a transient raw-CDN failure or a wiped module — both are
    // "abort and let the next run / the seed Action handle it".
    const [priorVotes, priorLocks, priorBribes, priorRewards, epochDates] = await Promise.all([
        tryGetJson(RAW('vote-events.json'), 'prior vote-events'),
        tryGetJson(RAW('lock-events.json'), 'prior lock-events'),
        tryGetJson(RAW('bribe-events.json'), 'prior bribe-events'),
        tryGetJson(RAW('reward-events.json'), 'prior reward-events'),
        tryGetJson(EPOCH_DATES_URL, 'epoch dates'),
    ]);
    if (!priorVotes && !priorLocks && !priorBribes && !priorRewards) {
        addErr('priors', new Error('all committed streams unreachable'));
        await publishHeartbeat({ startedAt, status: 'error', errors, discovered, note: 'priors unreachable — forward cron never seeds; recover via the tla-core seed Action if the module is actually empty' });
        throw new Error('All priors unreachable — refusing to run in seed mode.');
    }
    const epochOf = makeEpochResolver(epochDates);
    const prior = {
        votes:   priorVotes?.events   || [],
        locks:   priorLocks?.events   || [],
        bribes:  priorBribes?.events  || [],
        rewards: priorRewards?.events || [],
    };
    const priorHorizons = {
        votes:  priorVotes?.horizonHeight  ?? null,
        locks:  priorLocks?.horizonHeight  ?? null,
        bribes: priorBribes?.horizonHeight ?? null,
        rewards: priorRewards?.horizonHeight ?? null,
    };
    const priorLast = {
        votes:  priorVotes?.lastScannedHeight  ?? null,
        locks:  priorLocks?.lastScannedHeight  ?? null,
        bribes: priorBribes?.lastScannedHeight ?? null,
        rewards: priorRewards?.lastScannedHeight ?? null,
    };
    const priorGaps = {
        votes:  priorVotes?.known_gaps  || [],
        locks:  priorLocks?.known_gaps  || [],
        bribes: priorBribes?.known_gaps || [],
        rewards: priorRewards?.known_gaps || [],
    };
    console.log(`   prior: votes=${prior.votes.length} locks=${prior.locks.length} bribes=${prior.bribes.length} rewards=${prior.rewards.length}\n`);

    // sweep the retained window (~1 week ≈ 2-3 pages/contract at current volumes)
    console.log('🗳  scanning gauge (unfiltered: votes + rewards)…');
    const gauge = await fetchAllTxs([`wasm._contract_address='${TLA_GAUGE_CONTROLLER}'`], 'gauge-all');
    console.log('\n🔒 scanning escrow (locks + claim_rebase/compound)…');
    const escrow = await fetchAllTxs([`wasm._contract_address='${TLA_VOTING_ESCROW}'`], 'escrow-all');
    console.log('\n💰 scanning incentive manager (bribes)…');
    const incentive = await fetchAllTxs([`wasm._contract_address='${TLA_INCENTIVE_MANAGER}'`], 'incentive-all');

    const done = (r) => r.stop === 'complete' || r.stop === 'clean-end';
    console.log(`\n   gauge: ${gauge.txs.length} (${gauge.stop}) | escrow: ${escrow.txs.length} (${escrow.stop}) | incentive: ${incentive.txs.length} (${incentive.stop})`);

    // classify (shared block — byte-identical with the seed)
    const g = classifyGaugeTxs(gauge.txs, discovered);
    const e = classifyEscrowTxs(escrow.txs, discovered);
    const i = classifyIncentiveTxs(incentive.txs, discovered);
    const freshRewards = [...g.rewardEvents, ...e.rewardEvents, ...i.rewardEvents];

    // merge + dedup per stream
    const vm = mergeEvents(prior.votes, g.voteEvents);
    const lm = mergeEvents(prior.locks, e.lockEvents);
    const bm = mergeEvents(prior.bribes, i.bribeEvents);
    const rm = mergeEvents(prior.rewards, freshRewards);
    console.log(`   votes ${prior.votes.length}→${vm.merged.length} (+${vm.added}) | locks ${prior.locks.length}→${lm.merged.length} (+${lm.added}) | bribes ${prior.bribes.length}→${bm.merged.length} (+${bm.added}) | rewards ${prior.rewards.length}→${rm.merged.length} (+${rm.added})`);

    // F3 never-shrink per stream
    const shrunk = vm.merged.length < prior.votes.length || lm.merged.length < prior.locks.length || bm.merged.length < prior.bribes.length || rm.merged.length < prior.rewards.length;
    if (shrunk) {
        addErr('shrink-guard', new Error('merged event count < committed — aborting publish'));
        await publishHeartbeat({ startedAt, status: 'error', errors, discovered, counts: { votes: prior.votes.length, locks: prior.locks.length, bribes: prior.bribes.length, rewards: prior.rewards.length }, note: 'F3 shrink guard tripped; nothing published' });
        throw new Error('F3 shrink guard: refusing to overwrite history with fewer events.');
    }

    // horizons only ever move DOWN (F8)
    const earliest = (txs) => txs.length ? Number(txs[0].height) : null;
    const horizon = (p, txs) => { const eh = earliest(txs); if (eh == null) return p; if (p == null) return eh; return Math.min(p, eh); };
    const horizons = {
        votes: horizon(priorHorizons.votes, gauge.txs),
        locks: horizon(priorHorizons.locks, escrow.txs),
        bribes: horizon(priorHorizons.bribes, incentive.txs),
        rewards: horizon(priorHorizons.rewards, gauge.txs.length || escrow.txs.length ? [ ...(gauge.txs.length ? [gauge.txs[0]] : []), ...(escrow.txs.length ? [escrow.txs[0]] : []) ].sort((a, b) => Number(a.height) - Number(b.height)) : []),
    };

    // GAP HONESTY: outage longer than the node's retention window = a real,
    // permanent hole. Record it (end = where coverage actually resumes).
    const detectGap = (last, mergedEvts, txs) => {
        if (last == null) return null;
        let resume = null;
        for (const ev of mergedEvts) { const h = Number(ev.height); if (h > last && (resume == null || h < resume)) resume = h; }
        const floor = earliest(txs);
        if (resume == null) resume = floor;
        if (resume == null || resume <= last + 1) return null;
        return { from_height: last + 1, to_height: resume - 1, detected_at: startedAt.toISOString(), reason: 'public-node tx-index prune: coverage resumes above prior frontier; events in this window unknowable without an archive node' };
    };
    const mergeGaps = (priorList, g2) => {
        const all = [...priorList]; if (g2 && !all.find(x => x.from_height === g2.from_height && x.to_height === g2.to_height)) all.push(g2);
        return all.sort((a, b) => a.from_height - b.from_height);
    };
    const knownGaps = {
        votes:  mergeGaps(priorGaps.votes,  detectGap(priorLast.votes,  vm.merged, gauge.txs)),
        locks:  mergeGaps(priorGaps.locks,  detectGap(priorLast.locks,  lm.merged, escrow.txs)),
        bribes: mergeGaps(priorGaps.bribes, detectGap(priorLast.bribes, bm.merged, incentive.txs)),
        rewards: mergeGaps(priorGaps.rewards, null),
    };
    for (const [k, gs] of Object.entries(knownGaps)) if (gs.length) console.warn(`   ⚠ ${k}: ${gs.length} known gap(s) — ${gs.map(x => `${x.from_height}→${x.to_height}`).join(', ')}`);

    const streamFile = (contract, txsRes, complete, hz, merged, gaps) => ({
        schemaVersion: SCHEMA_VERSION, builtAt: startedAt.toISOString(), contract,
        lastScannedHeight: complete ? (txsRes.globalMax || 0) : undefined, horizonHeight: hz,
        scan_complete: complete, scan_stop: txsRes.stop, count: merged.length,
        known_gaps: gaps && gaps.length ? gaps : undefined, events: merged,
    });
    const gComplete = done(gauge), eComplete = done(escrow), iComplete = done(incentive);
    // frontier honesty: on an INCOMPLETE scan, keep the prior frontier so the
    // next run re-detects any hole instead of skipping past it
    const frontier = (complete, txsRes, last) => complete ? (txsRes.globalMax || 0) : (last ?? 0);
    const voteFile   = { ...streamFile(TLA_GAUGE_CONTROLLER,  gauge,     gComplete, horizons.votes,  vm.merged, knownGaps.votes),  lastScannedHeight: frontier(gComplete, gauge, priorLast.votes) };
    const lockFile   = { ...streamFile(TLA_VOTING_ESCROW,     escrow,    eComplete, horizons.locks,  lm.merged, knownGaps.locks),  lastScannedHeight: frontier(eComplete, escrow, priorLast.locks) };
    const bribeFile  = { ...streamFile(TLA_INCENTIVE_MANAGER, incentive, iComplete, horizons.bribes, bm.merged, knownGaps.bribes), lastScannedHeight: frontier(iComplete, incentive, priorLast.bribes) };
    const rewardFile = { schemaVersion: SCHEMA_VERSION, builtAt: startedAt.toISOString(),
        contracts: { gauge: TLA_GAUGE_CONTROLLER, escrow: TLA_VOTING_ESCROW, incentive: TLA_INCENTIVE_MANAGER },
        lastScannedHeight: (gComplete && eComplete && iComplete) ? Math.max(gauge.globalMax || 0, escrow.globalMax || 0, incentive.globalMax || 0) : (priorLast.rewards ?? 0),
        horizonHeight: horizons.rewards, scan_complete: gComplete && eComplete && iComplete,
        scan_stop: `gauge:${gauge.stop};escrow:${escrow.stop};incentive:${incentive.stop}`,
        known_gaps: knownGaps.rewards.length ? knownGaps.rewards : undefined,
        count: rm.merged.length, events: rm.merged };

    const rollups = buildRollups(vm.merged, lm.merged, bm.merged, rm.merged, epochOf);

    // cursor — advances ONLY on complete scans (F7)
    const cursor = {
        schemaVersion: SCHEMA_VERSION, updatedAt: startedAt.toISOString(),
        contracts: {
            [TLA_GAUGE_CONTROLLER]:  { lastScannedHeight: frontier(gComplete, gauge, priorLast.votes),      complete: gComplete },
            [TLA_VOTING_ESCROW]:     { lastScannedHeight: frontier(eComplete, escrow, priorLast.locks),     complete: eComplete },
            [TLA_INCENTIVE_MANAGER]: { lastScannedHeight: frontier(iComplete, incentive, priorLast.bribes), complete: iComplete },
        },
    };

    const index = {
        module: 'tla-voting', product: 'events', schemaVersion: SCHEMA_VERSION, updatedAt: startedAt.toISOString(),
        spec: 'docs/pending-changes/SPEC-tla-voting.md',
        files: {
            'vote-events.json':   { contract: TLA_GAUGE_CONTROLLER,  count: vm.merged.length, horizonHeight: horizons.votes },
            'lock-events.json':   { contract: TLA_VOTING_ESCROW,     count: lm.merged.length, horizonHeight: horizons.locks, note: 'sum canonical===true for VP/lock-delta math' },
            'bribe-events.json':  { contract: TLA_INCENTIVE_MANAGER, count: bm.merged.length, horizonHeight: horizons.bribes },
            'reward-events.json': { count: rm.merged.length, horizonHeight: horizons.rewards, note: 'wallet_claim + protocol_distribution; coins are raw {amount,denom}; distribution pots are tx-gross (coins_basis) — never sum across distribution types' },
            'rollups.json':       { wallets: rollups.wallet_count },
            'cursor.json':        { note: 'org-tla-voting (Render) forward-maintains from here' },
            'heartbeat.json':     {},
        },
        known_gap_count: Object.values(knownGaps).reduce((n, x) => n + x.length, 0) || undefined,
        note_gaps: Object.values(knownGaps).some(x => x.length) ? 'public-node prune gaps recorded in each stream file (known_gaps) — archive-node targets' : undefined,
    };

    // publish only streams whose count changed (or whose gaps changed) to keep
    // commit noise down; cursor + heartbeat publish every run.
    const changed = (added, gapsNow, gapsPrior) => added > 0 || gapsNow.length !== gapsPrior.length;
    if (changed(vm.added, knownGaps.votes, priorGaps.votes))   await publishFile(`${OUT_DIR}/vote-events.json`,   voteFile,   `tla-voting forward: votes ${vm.merged.length} (+${vm.added})`);
    if (changed(lm.added, knownGaps.locks, priorGaps.locks))   await publishFile(`${OUT_DIR}/lock-events.json`,   lockFile,   `tla-voting forward: locks ${lm.merged.length} (+${lm.added})`);
    if (changed(bm.added, knownGaps.bribes, priorGaps.bribes)) await publishFile(`${OUT_DIR}/bribe-events.json`,  bribeFile,  `tla-voting forward: bribes ${bm.merged.length} (+${bm.added})`);
    if (changed(rm.added, knownGaps.rewards, priorGaps.rewards)) await publishFile(`${OUT_DIR}/reward-events.json`, rewardFile, `tla-voting forward: rewards ${rm.merged.length} (+${rm.added})`);
    if (vm.added + lm.added + bm.added + rm.added > 0) await publishFile(`${OUT_DIR}/rollups.json`, rollups, `tla-voting rollups: ${rollups.wallet_count} wallets`);
    await publishFile(`${OUT_DIR}/cursor.json`, cursor, `tla-voting cursor`);
    await publishFile(`${OUT_DIR}/index.json`,  index,  `tla-voting index`);

    // ---- distributions forward capture (SPEC-distributions-capture §4) ----
    // Self-healing: reads the committed distributions index, backfills every
    // finalized period newer than it (retained contract state — lateness is
    // free). Never seeds (2.1.0 doctrine): an empty module means the one-shot
    // harvest hasn't run. Failures here NEVER block the event streams above.
    let dist = null;
    try {
        dist = await forwardDistributions({ publishFile, log: console });
        console.log(`  distributions: ${dist.skipped ? `skipped (${dist.reason})` : `+${dist.appended} → period ${dist.head}`}`);
    } catch (e) {
        addErr('distributions', e);
        console.warn(`  ⚠ distributions forward step failed (event streams unaffected): ${e.message}`);
    }

    const allComplete = gComplete && eComplete && iComplete;
    await publishHeartbeat({ startedAt, status: allComplete ? 'ok' : 'partial', errors, discovered,
        counts: { votes: vm.merged.length, locks: lm.merged.length, bribes: bm.merged.length, rewards: rm.merged.length, wallets: rollups.wallet_count, added: vm.added + lm.added + bm.added + rm.added,
                  distributions_head: dist && dist.head || undefined, distributions_appended: dist && dist.appended || undefined },
        lastHeights: { gauge: gauge.globalMax || 0, escrow: escrow.globalMax || 0, incentive: incentive.globalMax || 0 },
        horizons, gaps: Object.fromEntries(Object.entries(knownGaps).filter(([, v]) => v.length)) });

    console.log(`\n✅ done — votes ${vm.merged.length} (+${vm.added}), locks ${lm.merged.length} (+${lm.added}), bribes ${bm.merged.length} (+${bm.added}), rewards ${rm.merged.length} (+${rm.added}), status ${allComplete ? 'ok' : 'PARTIAL'}`);
}

if (require.main === module) {
    run().catch(err => { console.error('FATAL:', err.message); process.exit(1); });
}

module.exports = { classifyGaugeTxs, classifyEscrowTxs, classifyIncentiveTxs, rewardEventFromMsg, bribeEventFrom, mergeEvents, buildRollups, extractVotes, normalizeAssetId, makeEpochResolver, isCanonicalLock, parseCoinString, coinsReceivedBy, coinsMovedInTx, eventKey };
