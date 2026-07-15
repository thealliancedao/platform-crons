// =============================================================================
// tla-voting / mock-run.js — the BINDING mock gate for org-tla-voting 2.0.0
// (SPEC-tla-voting-capture-fix §8: file-based mock runs, stubbed network +
// publish, before any commit/deploy. Main-loop-change law.)
//
// Fixtures are REAL: FCD-archived governance txs (tla-core/archive/fcd/) and
// the committed event streams they produced — classifier parity is asserted
// against production truth, not synthetic expectations.
//
// Run:  TLA_CORE_DIR=<path to tla-core checkout> node mock-run.js
// (needs ../config/contracts.js + ./lib/* beside it, i.e. a platform-crons
// checkout with this 2.0.0 folder in place)
// =============================================================================
'use strict';

process.env.GITHUB_TOKEN = process.env.GITHUB_TOKEN || 'mock-token';
process.env.MAX_BLOCKS_PER_RUN = '4';
process.env.CONFIRM_LAG = '0';
process.env.VS_PACE_MS = '0';
process.env.WALK_CONCURRENCY = '2';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TLA_CORE = process.env.TLA_CORE_DIR || path.join(__dirname, '..', '..', 'tla-core');

// ---- patch the step libs BEFORE index.js destructures them -----------------
const dist = require('./lib/distributions.js');
const realForwardDistributions = dist.forwardDistributions;
dist.forwardDistributions = async () => ({ skipped: true, reason: 'mocked', head: 194 });
const vsLib = require('./lib/vote-state.js');
const realForwardVoteState = vsLib.forwardVoteState;
vsLib.forwardVoteState = async () => ({ skipped: true, reason: 'mocked' });

const M = require('./index.js');

// ---- tiny harness -----------------------------------------------------------
let PASS = 0, FAIL = 0;
function assert(cond, label, extra) {
    if (cond) { PASS++; console.log(`  ✓ ${label}`); }
    else { FAIL++; console.error(`  ✗ FAIL ${label}${extra ? ' — ' + extra : ''}`); }
}
const b64 = (s) => Buffer.from(s).toString('base64');
const sha = (b) => crypto.createHash('sha256').update(Buffer.from(b, 'base64')).digest('hex').toUpperCase();

// ---- in-memory repo (GitHub stub) -------------------------------------------
const REPO = new Map(); // repoPath -> content string
function stubGithubApi(method, apiPath, body, accept) {
    const m = apiPath.match(/\/contents\/(.+?)(\?|$)/);
    const p = m && decodeURIComponent(m[1]);
    if (method === 'GET') {
        if (!REPO.has(p)) { const e = new Error(`404 ${p}`); e.statusCode = 404; throw e; }
        if (accept === 'application/vnd.github.raw') return REPO.get(p);
        return { sha: 'stub-sha' };
    }
    if (method === 'PUT') { REPO.set(p, Buffer.from(body.content, 'base64').toString()); return { content: { path: p } }; }
    throw new Error(`stub: unhandled ${method} ${apiPath}`);
}
const repoJson = (p) => REPO.has(p) ? JSON.parse(REPO.get(p)) : null;

// ---- chain stub (routed by URL) ----------------------------------------------
let HEAD = 0;
let BLOCKS = {};        // N -> { time, txsB64 } | 'PRUNED'
let RESULTS = {};       // N -> txs_results[]
let TXBYHASH = {};      // HASH -> decoded tx_response (or 'FAIL')
const epochDates = JSON.parse(fs.readFileSync(path.join(TLA_CORE, 'docs', 'epoch_1-300_date.json'), 'utf8'));

async function stubHttpGet(url) {
    if (url.includes('/status')) return { result: { sync_info: { latest_block_height: HEAD } } };
    let m = url.match(/\/block\?height=(\d+)/);
    if (m) {
        const N = Number(m[1]);
        const b = BLOCKS[N];
        if (b === 'PRUNED') throw new Error(`height ${N} is not available, lowest height is X`);
        if (!b) throw new Error(`mock: no block ${N}`);
        return { result: { block: { header: { time: b.time }, data: { txs: b.txsB64 } } } };
    }
    m = url.match(/\/block_results\?height=(\d+)/);
    if (m) return { result: { txs_results: RESULTS[Number(m[1])] || [] } };
    m = url.match(/\/cosmos\/tx\/v1beta1\/txs\/([0-9A-F]+)/);
    if (m) {
        const t = TXBYHASH[m[1]];
        if (!t || t === 'FAIL') throw new Error(`mock: tx ${m[1].slice(0, 8)} unavailable`);
        return t;
    }
    if (url.includes('epoch_1-300_date.json')) return epochDates;
    throw new Error(`mock httpGet: unrouted ${url}`);
}
M.T.httpGet = stubHttpGet;
M.T.githubApiRequest = stubGithubApi;
M.T.now = () => new Date('2026-07-15T12:00:00Z');

// ---- real FCD fixtures --------------------------------------------------------
function loadFcd(label) {
    const dir = path.join(TLA_CORE, 'archive', 'fcd', label);
    const out = [];
    for (const f of fs.readdirSync(dir).filter(f => f.startsWith('part-')).sort()) {
        const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        out.push(...(Array.isArray(d) ? d : d.txs || []));
    }
    return out;
}
// FCD trimmed tx -> the classifier's tx_response shape (the fcd-fill adapter)
const adapt = (tx) => ({ txhash: tx.txhash, height: tx.height, timestamp: tx.timestamp, events: tx.events, tx: { body: { messages: tx.messages } } });
function committedEvents(file) {
    return JSON.parse(fs.readFileSync(path.join(TLA_CORE, 'tla-voting', 'events', file), 'utf8')).events;
}
const msgKeyOf = (tx, key) => (tx.messages || []).some(mm => mm.msg && typeof mm.msg === 'object' && key in mm.msg);

const gaugeTxs = loadFcd('tla-gauge').filter(t => Number(t.code || 0) === 0);
const escrowTxs = loadFcd('tla-escrow').filter(t => Number(t.code || 0) === 0);
const incentiveTxs = loadFcd('tla-incentive').filter(t => Number(t.code || 0) === 0);
const committedVotes = committedEvents('vote-events.json');
const committedLocks = committedEvents('lock-events.json');
const committedBribes = committedEvents('bribe-events.json');

// =============================================================================
async function main() {

// ---- T1: classifier parity on REAL txs vs COMMITTED events -------------------
console.log('\nT1 — classifier v4 parity on real FCD txs vs committed events');
{
    const voteSample = gaugeTxs.filter(t => msgKeyOf(t, 'vote')).slice(0, 25);
    const g = M.classifyGaugeTxs(voteSample.map(adapt), {});
    const byKey = new Map(committedVotes.map(e => [`${e.tx_hash}|${e.wallet}|${e.msg_index ?? ''}`, e]));
    let matched = 0, compared = 0;
    for (const ev of g.voteEvents) {
        const c = byKey.get(`${ev.tx_hash}|${ev.wallet}|${ev.msg_index ?? ''}`) ||
                  committedVotes.find(e => e.tx_hash === ev.tx_hash && e.wallet === ev.wallet);
        if (!c) continue;
        compared++;
        const same = c.type === ev.type && c.gauge === ev.gauge && c.height === ev.height &&
                     JSON.stringify(c.votes) === JSON.stringify(ev.votes);
        if (same) matched++;
        else console.error(`    diff on ${ev.tx_hash.slice(0, 12)}: committed ${JSON.stringify(c).slice(0, 120)} vs fresh ${JSON.stringify(ev).slice(0, 120)}`);
    }
    assert(compared >= 20 && matched === compared, `vote parity ${matched}/${compared} on real txs`);

    const bribeSample = incentiveTxs.filter(t => msgKeyOf(t, 'add_bribe')).slice(0, 10);
    const i = M.classifyIncentiveTxs(bribeSample.map(adapt), {});
    const bByHash = new Map(committedBribes.map(e => [`${e.tx_hash}|${e.msg_index ?? ''}`, e]));
    let bMatched = 0, bCompared = 0;
    for (const ev of i.bribeEvents) {
        const c = bByHash.get(`${ev.tx_hash}|${ev.msg_index ?? ''}`);
        if (!c) continue;
        bCompared++;
        if (c.type === ev.type && c.briber === ev.briber && c.pool === ev.pool &&
            JSON.stringify(c.coins) === JSON.stringify(ev.coins) && c.epoch_start === ev.epoch_start) bMatched++;
    }
    assert(bCompared >= 5 && bMatched === bCompared, `bribe parity ${bMatched}/${bCompared} on real txs`);
}

// ---- T2: token_id promotion on REAL create_lock txs ---------------------------
console.log('\nT2 — v4 token_id promotion (real escrow txs; committed creates are null)');
{
    const creates = escrowTxs.filter(t => msgKeyOf(t, 'create_lock'));
    const e = M.classifyEscrowTxs(creates.map(adapt), {});
    const freshCreates = e.lockEvents.filter(ev => ev.type === 'lock_create');
    const withId = freshCreates.filter(ev => ev.token_id != null);
    const target = freshCreates.find(ev => ev.tx_hash.startsWith('09A186D9'));
    assert(target && target.token_id === '542' && target.token_id_source === 'wasm_event',
        `real tx 09A186D9… carries token_id 542 via wasm mint event (got ${target && target.token_id})`);
    const commByHash = new Map(committedLocks.filter(x => x.type === 'lock_create').map(x => [x.tx_hash, x]));
    let nullBefore = 0, filledNow = 0, fieldParity = 0, comparedL = 0;
    for (const ev of freshCreates) {
        const c = commByHash.get(ev.tx_hash);
        if (!c) continue;
        comparedL++;
        if (c.token_id == null) nullBefore++;
        if (c.token_id == null && ev.token_id != null) filledNow++;
        const { token_id: _a, token_id_source: _b, ...evRest } = ev;
        const { token_id: _c2, ...cRest } = c;
        if (JSON.stringify(evRest) === JSON.stringify(cRest)) fieldParity++;
    }
    assert(comparedL >= 20 && fieldParity === comparedL, `create parity minus token_id: ${fieldParity}/${comparedL}`);
    assert(nullBefore > 0 && filledNow === nullBefore, `all ${nullBefore} committed-null creates now filled (${filledNow}) — the defect closes`);
    console.log(`    (v4 fills ${withId.length}/${freshCreates.length} creates overall)`);
}

// ---- walker world: shared repo seed -------------------------------------------
const IDX_SEED = () => ({
    module: 'tla-voting', product: 'events', schemaVersion: 4, updatedAt: 'seed',
    streams: {
        votes: { dir: 'events/votes/', count: 0, months_present: {}, horizonHeight: 11558887 },
        locks: { dir: 'events/locks/', count: 0, months_present: {}, horizonHeight: 11558979 },
        bribes: { dir: 'events/bribes/', count: 0, months_present: {}, horizonHeight: 11559045 },
        rewards: { dir: 'events/rewards/', count: 0, months_present: {}, horizonHeight: 11558887 },
    },
    files: { 'rollups.json': {}, 'cursor.json': {}, 'heartbeat.json': {} },
});
function seedRepo(cursor) {
    REPO.clear();
    REPO.set('tla-voting/events/index.json', JSON.stringify(IDX_SEED()));
    if (cursor) REPO.set('tla-voting/events/cursor.json', JSON.stringify(cursor));
}
// synthetic block carrying a REAL tx: block data is fake bytes; the by-hash stub
// serves the real decoded tx re-stamped to the block's height/time + computed hash
function stageBlock(N, time, realTxs, opts = {}) {
    const txsB64 = [], results = [];
    for (const [i, tx] of realTxs.entries()) {
        const bytes = b64(`blk${N}-tx${i}-${tx.txhash}`);
        txsB64.push(bytes);
        const h = sha(bytes);
        results.push({ code: opts.failCode ? 1 : 0, events: opts.foreign ? [{ type: 'wasm', attributes: [{ key: '_contract_address', value: 'terra1foreigncontract' }, { key: 'action', value: 'claim' }] }] : tx.events });
        if (!opts.foreign && !opts.failCode) {
            TXBYHASH[h] = opts.decodeFail ? 'FAIL'
                : { tx_response: { ...adapt(tx), txhash: h, height: N, timestamp: time } };
        }
    }
    BLOCKS[N] = { time, txsB64 };
    RESULTS[N] = results;
    return txsB64.map(sha);
}
const realVoteTx = gaugeTxs.find(t => msgKeyOf(t, 'vote'));
const realCreateTx = escrowTxs.find(t => t.txhash.startsWith('09A186D9'));

// ---- T3: walker end-to-end ------------------------------------------------------
console.log('\nT3 — walker end-to-end: gate, decode, classify, monthly merge, index, cursor');
{
    BLOCKS = {}; RESULTS = {}; TXBYHASH = {}; HEAD = 104;
    seedRepo({ schemaVersion: 4, last_block: 100 });
    BLOCKS[101] = { time: '2026-07-15T10:00:00Z', txsB64: [] };
    stageBlock(102, '2026-07-15T10:01:00Z', [realVoteTx]);
    stageBlock(103, '2026-07-15T10:02:00Z', [realCreateTx], {});
    stageBlock(104, '2026-07-15T10:03:00Z', [realVoteTx], { foreign: true });
    await M.run();
    const votesM = repoJson('tla-voting/events/votes/2026/07.json');
    const locksM = repoJson('tla-voting/events/locks/2026/07.json');
    const idx = repoJson('tla-voting/events/index.json');
    const cur = repoJson('tla-voting/events/cursor.json');
    const hb = repoJson('tla-voting/events/heartbeat.json');
    assert(votesM && votesM.length === 1 && votesM[0].type === 'vote', `vote landed in votes/2026/07.json (${votesM && votesM.length})`);
    assert(locksM && locksM.length === 1 && locksM[0].token_id === '542' && locksM[0].token_id_source === 'wasm_event', 'create landed with promoted token_id');
    assert(idx.streams.votes.count === 1 && idx.streams.votes.months_present['2026'].includes('07'), 'index counts + months updated');
    assert(cur.last_block === 104, `cursor advanced to 104 (${cur.last_block})`);
    assert(hb.status === 'ok' && hb.counts.gated_txs === 2, `heartbeat ok, gated_txs 2 (foreign gated out) — got ${hb.status}/${hb.counts.gated_txs}`);
    assert(hb.version === 'org-tla-voting-2.0.0' && hb.schemaVersion === 4, 'heartbeat carries 2.0.0 / schema 4');
    // idempotence: re-walk the same window (cursor rolled back) → dedup absorbs
    REPO.set('tla-voting/events/cursor.json', JSON.stringify({ schemaVersion: 4, last_block: 100 }));
    await M.run();
    assert(repoJson('tla-voting/events/votes/2026/07.json').length === 1 &&
           repoJson('tla-voting/events/locks/2026/07.json').length === 1 &&
           repoJson('tla-voting/events/index.json').streams.votes.count === 1, 'crash-rewind idempotent: dedup absorbed, counts unchanged');
}

// ---- T4: budget split ------------------------------------------------------------
console.log('\nT4 — budget: 10-block backlog across 3 budget-capped runs, nothing lost');
{
    BLOCKS = {}; RESULTS = {}; TXBYHASH = {}; HEAD = 110;
    seedRepo({ schemaVersion: 4, last_block: 100 });
    for (let N = 101; N <= 110; N++) BLOCKS[N] = { time: '2026-07-15T11:00:00Z', txsB64: [] };
    stageBlock(105, '2026-07-15T11:00:05Z', [realVoteTx]);
    stageBlock(109, '2026-07-15T11:00:09Z', [realCreateTx]);
    await M.run();
    let cur = repoJson('tla-voting/events/cursor.json');
    let hb = repoJson('tla-voting/events/heartbeat.json');
    assert(cur.last_block === 104 && /catching-up/.test(hb.note || ''), `run1 cursor at budget edge 104 + catching-up note (${cur.last_block})`);
    await M.run();
    cur = repoJson('tla-voting/events/cursor.json');
    assert(cur.last_block === 108, `run2 cursor 108 (${cur.last_block})`);
    await M.run();
    cur = repoJson('tla-voting/events/cursor.json');
    assert(cur.last_block === 110, `run3 cursor 110 (${cur.last_block})`);
    assert(repoJson('tla-voting/events/votes/2026/07.json').length === 1 &&
           repoJson('tla-voting/events/locks/2026/07.json').length === 1, 'both events captured across the split — nothing lost');
}

// ---- T5: decode failure holds the cursor -------------------------------------------
console.log('\nT5 — by-hash decode failure: cursor HELD, window re-walks, then heals');
{
    BLOCKS = {}; RESULTS = {}; TXBYHASH = {}; HEAD = 103;
    seedRepo({ schemaVersion: 4, last_block: 100 });
    BLOCKS[101] = { time: '2026-07-15T12:00:00Z', txsB64: [] };
    const hashes = stageBlock(102, '2026-07-15T12:00:02Z', [realVoteTx], { decodeFail: true });
    BLOCKS[103] = { time: '2026-07-15T12:00:03Z', txsB64: [] };
    await M.run();
    let cur = repoJson('tla-voting/events/cursor.json');
    let hb = repoJson('tla-voting/events/heartbeat.json');
    assert(cur.last_block === 100 && hb.status === 'partial', `cursor held at 100, status partial (${cur.last_block}/${hb.status})`);
    assert(!REPO.has('tla-voting/events/votes/2026/07.json'), 'nothing published on the failed run');
    // heal: the tx becomes fetchable → re-walk captures it
    TXBYHASH[hashes[0]] = { tx_response: { ...adapt(realVoteTx), txhash: hashes[0], height: 102, timestamp: '2026-07-15T12:00:02Z' } };
    await M.run();
    cur = repoJson('tla-voting/events/cursor.json');
    assert(cur.last_block === 103 && repoJson('tla-voting/events/votes/2026/07.json').length === 1, 'window re-walked, event captured, cursor advanced');
}

// ---- T6: pruned blocks → exact gap, cursor jumps -------------------------------------
console.log('\nT6 — pruned range: exact-bounds gap recorded, cursor jumps');
{
    BLOCKS = {}; RESULTS = {}; TXBYHASH = {}; HEAD = 104;
    seedRepo({ schemaVersion: 4, last_block: 100 });
    BLOCKS[101] = 'PRUNED'; BLOCKS[102] = 'PRUNED';
    BLOCKS[103] = { time: '2026-07-15T13:00:00Z', txsB64: [] };
    stageBlock(104, '2026-07-15T13:00:01Z', [realVoteTx]);
    BLOCKS[105] = { time: '2026-07-15T13:00:02Z', txsB64: [] }; // firstAvailable probe bound (to+1)
    await M.run();
    const idx = repoJson('tla-voting/events/index.json');
    const g = (idx.known_gaps_walker || [])[0];
    assert(g && g.from_height === 101 && g.to_height === 102, `walker gap 101–102 recorded (${g && g.from_height}–${g && g.to_height})`);
    assert(repoJson('tla-voting/events/cursor.json').last_block === 104 &&
           repoJson('tla-voting/events/votes/2026/07.json').length === 1, 'cursor jumped the gap; post-gap event captured');
}

// ---- T7: corrupt month file → publish refused, cursor held ----------------------------
console.log('\nT7 — corrupt existing month (not an array): refused, cursor HELD');
{
    BLOCKS = {}; RESULTS = {}; TXBYHASH = {}; HEAD = 102;
    seedRepo({ schemaVersion: 4, last_block: 100 });
    BLOCKS[101] = { time: '2026-07-15T14:00:00Z', txsB64: [] };
    stageBlock(102, '2026-07-15T14:00:01Z', [realVoteTx]);
    REPO.set('tla-voting/events/votes/2026/07.json', JSON.stringify({ corrupt: true }));
    await M.run();
    const hb = repoJson('tla-voting/events/heartbeat.json');
    assert(repoJson('tla-voting/events/cursor.json').last_block === 100 && hb.status === 'partial',
        'cursor held + partial on corrupt month');
    assert(JSON.parse(REPO.get('tla-voting/events/votes/2026/07.json')).corrupt === true, 'corrupt file NOT overwritten');
}

// ---- T8: 1.x cursor migration -----------------------------------------------------------
console.log('\nT8 — 1.x per-contract cursor migrates to min(frontier)');
{
    BLOCKS = {}; RESULTS = {}; TXBYHASH = {}; HEAD = 95;
    seedRepo({ schemaVersion: 3, contracts: { a: { lastScannedHeight: 92 }, b: { lastScannedHeight: 90 }, c: { lastScannedHeight: 94 } } });
    for (let N = 91; N <= 95; N++) BLOCKS[N] = { time: '2026-07-15T15:00:00Z', txsB64: [] };
    await M.run();
    let cur = repoJson('tla-voting/events/cursor.json');
    assert(cur.window_walked.from === 91 && cur.last_block === 94, `migrated from min frontier 90 → walked 91–94 under budget (${cur.window_walked.from}–${cur.last_block})`);
    await M.run();
    cur = repoJson('tla-voting/events/cursor.json');
    assert(cur.last_block === 95, `second run completes to 95 (${cur.last_block})`);
}

// ---- T9: monolith-layout guard -----------------------------------------------------------
console.log('\nT9 — monolith layout (index v3): cron refuses to run');
{
    REPO.clear();
    REPO.set('tla-voting/events/index.json', JSON.stringify({ schemaVersion: 3, files: {} }));
    let threw = null;
    try { await M.run(); } catch (e) { threw = e; }
    assert(threw && /MONOLITH/i.test(threw.message), `aborted with restructure-first message (${threw && threw.message.slice(0, 60)})`);
    const hb = repoJson('tla-voting/events/heartbeat.json');
    assert(hb && hb.status === 'error', 'error heartbeat published');
}

// =============================================================================
// vote-state harvest tests (forwardVoteState called directly, CH stubbed)
// =============================================================================
const VS = vsLib;
const memPublish = async (p, obj) => { REPO.set(p, typeof obj === 'string' ? obj : JSON.stringify(obj)); };
const memRead = async (p) => ({ ok: true, data: repoJson(p) });
const K = (a) => ({ cw20: a });   // pool key shorthand
const UI = (fixed, boost, gv) => ({ fixed_amount: String(fixed), voting_power: String(boost), gauge_votes: gv });

console.log('\nT10 — vote-state full harvest: records, stamps, flags, index');
{
    REPO.clear();
    VS.CH.fetchDistributions = async () => ({ ok: true, period: 194 });
    VS.CH.queryContract = async (addr, q) => {
        if (q.num_tokens) return { count: 4 };
        if (q.all_tokens) return q.all_tokens.start_after ? { tokens: [] } : { tokens: ['1', '2', '3', '4'] };
        if (q.lock_info) return { owner: { '1': 'walletA', '2': 'walletB', '3': 'walletC', '4': 'walletD' }[q.lock_info.token_id] };
        if (q.user_info) {
            const w = q.user_info.user;
            if (w === 'walletA') return UI(100, 900, [{ gauge: 'project', period: 194, votes: [[K('poolX'), 7000], [K('poolY'), 3000]] }]);
            if (w === 'walletB') return UI(50, 450, [{ gauge: 'stable', period: 190, votes: [[K('poolZ'), 10000]] }]);
            if (w === 'walletC') return UI(10, 90, [{ gauge: 'single', period: 195, votes: [[K('poolW'), 10000]] }]);
            if (w === 'walletD') return UI(0, 0, []);
        }
        throw new Error('unrouted CH query ' + JSON.stringify(q));
    };
    const res = await realForwardVoteState({ publishFile: memPublish, apiGetJson: memRead, readVoteEvents: async () => [], log: console });
    const month = repoJson('tla-voting/vote-state/2026/07.json');
    const idx = repoJson('tla-voting/vote-state/index.json');
    const rec = Object.fromEntries(month.map(r => [r.wallet, r]));
    assert(res.wallets === 4 && res.pending === 0 && month.length === 4, `4 records, 0 pending (${res.wallets}/${res.pending})`);
    assert(rec.walletA.voted_this_period === true && rec.walletB.voted_this_period === false, 'voted_this_period from stamp === period');
    assert(rec.walletC.gauge_votes[0].post_flip_change === true, 'stamp 195 > 194 flagged post_flip_change');
    assert(rec.walletA.vp.total === '1000' && rec.walletB.vp.total === '500', 'vp.total = fixed + boost (VP law)');
    assert(rec.walletA.raw_gauge_votes.length === 1 && rec.walletD.gauge_votes.length === 0, 'raw retained verbatim; zero-alloc wallet recorded honestly');
    assert(idx.last_harvested_period === 194 && idx.wallets_seen.length === 4, 'index advanced to 194, wallets_seen cumulative');
    // idempotence / up-to-date skip
    const res2 = await realForwardVoteState({ publishFile: memPublish, apiGetJson: memRead, readVoteEvents: async () => [], log: console });
    assert(res2.skipped && res2.reason === 'up to date', 'second run skips (up to date)');
}

console.log('\nT11 — vote-state pending completion across two runs');
{
    REPO.clear();
    let bFails = true;
    VS.CH.fetchDistributions = async () => ({ ok: true, period: 194 });
    VS.CH.queryContract = async (addr, q) => {
        if (q.num_tokens) return { count: 2 };
        if (q.all_tokens) return q.all_tokens.start_after ? { tokens: [] } : { tokens: ['1', '2'] };
        if (q.lock_info) return { owner: q.lock_info.token_id === '1' ? 'walletA' : 'walletB' };
        if (q.user_info) {
            if (q.user_info.user === 'walletB' && bFails) throw new Error('mock: simulated LCD failure');
            return UI(1, 9, [{ gauge: 'project', period: 194, votes: [[K('poolX'), 10000]] }]);
        }
        throw new Error('unrouted');
    };
    const r1 = await realForwardVoteState({ publishFile: memPublish, apiGetJson: memRead, readVoteEvents: async () => [], log: console });
    let idx = repoJson('tla-voting/vote-state/index.json');
    assert(r1.pending === 1 && idx.pending_wallets[0] === 'walletB' && idx.pending_period === 194 && idx.last_harvested_period === null,
        'run1: walletB pending, period NOT advanced');
    assert(repoJson('tla-voting/vote-state/2026/07.json').length === 1, 'run1: walletA record published anyway');
    assert(r1.vote_capture !== undefined, 'run1 is a full harvest — vote_capture computed');
    bFails = false;
    const r2 = await realForwardVoteState({ publishFile: memPublish, apiGetJson: memRead, readVoteEvents: async () => { throw new Error('must not be called in completion mode'); }, log: console });
    idx = repoJson('tla-voting/vote-state/index.json');
    const month = repoJson('tla-voting/vote-state/2026/07.json');
    assert(r2.pending === 0 && idx.last_harvested_period === 194 && idx.pending_wallets.length === 0,
        'run2 (completion): walletB harvested, period advanced');
    assert(month.length === 2 && month.filter(r => r.wallet === 'walletA').length === 1, 'dedup: walletA not duplicated');
    assert(r2.vote_capture === undefined, 'completion mode skips vote_capture (partial universe)');
}

console.log('\nT12 — vote_capture: all four classes + match rate');
{
    const events = [
        { type: 'vote', wallet: 'walletA', gauge: 'stable', height: 10, tx_hash: 'H1', votes: [['cw20:poolX', 10000]] },
        { type: 'vote', wallet: 'walletA', gauge: 'project', height: 11, tx_hash: 'H2', votes: [['cw20:poolY', 10000]] },
        { type: 'vote', wallet: 'walletC', gauge: 'project', height: 12, tx_hash: 'H3', votes: [['cw20:poolZ', 10000]] },
    ];
    const uiByWallet = new Map([
        ['walletA', { gauge_votes: [
            { gauge: 'stable', votes: [[K('poolX'), 10000]] },              // MATCH
            { gauge: 'project', votes: [[K('poolY'), 9000], [K('poolQ'), 1000]] }, // MISMATCH
        ] }],
        ['walletB', { gauge_votes: [{ gauge: 'single', votes: [[K('poolW'), 10000]] }] }], // CHAIN_ONLY
        ['walletC', { gauge_votes: [] }],                                    // EVENTS_ONLY
    ]);
    const vc = VS.computeVoteCapture(events, uiByWallet, new Set());
    assert(vc.counts.MATCH === 1 && vc.counts.MISMATCH === 1 && vc.counts.CHAIN_ONLY === 1 && vc.counts.EVENTS_ONLY === 1,
        `all four classes exactly once (${JSON.stringify(vc.counts)})`);
    assert(vc.match_rate_pct === 25, `match_rate 25% (${vc.match_rate_pct})`);
}

console.log('\nT13 — vote-state enumeration failure aborts the whole harvest');
{
    REPO.clear();
    VS.CH.fetchDistributions = async () => ({ ok: true, period: 194 });
    VS.CH.queryContract = async (addr, q) => {
        if (q.num_tokens) return { count: 2 };
        if (q.all_tokens) return q.all_tokens.start_after ? { tokens: [] } : { tokens: ['1', '2'] };
        if (q.lock_info && q.lock_info.token_id === '2') throw new Error('mock: lock_info down');
        if (q.lock_info) return { owner: 'walletA' };
        throw new Error('unrouted');
    };
    let threw = null;
    try { await realForwardVoteState({ publishFile: memPublish, apiGetJson: memRead, readVoteEvents: async () => [], log: console }); }
    catch (e) { threw = e; }
    assert(threw && /universe incomplete/i.test(threw.message), 'harvest aborted on incomplete universe');
    assert(REPO.size === 0, 'nothing published on the aborted harvest');
}

// =============================================================================
console.log(`\n${'='.repeat(60)}\n${FAIL === 0 ? '✅' : '❌'} mock gate: ${PASS} passed, ${FAIL} failed\n`);
process.exit(FAIL === 0 ? 0 : 1);
}

main().catch(e => { console.error('MOCK HARNESS FATAL:', e); process.exit(1); });
