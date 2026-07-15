// =============================================================================
// tla-voting / mock-run.js — the BINDING mock gate for org-tla-voting 2.2.0
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
const bsLib = require('./lib/bribe-state.js');
const realForwardBribeState = bsLib.forwardBribeState;
bsLib.forwardBribeState = async () => ({ skipped: true, reason: 'mocked' });

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
// Committed streams are MONTHLY since the 2.0.0 restructure — concatenate
// every {YYYY}/{MM}.json under the stream dir (2.2.0 harness fix; the old
// monolith vote-events.json reader predates the restructure).
function committedEvents(stream) {
    const base = path.join(TLA_CORE, 'tla-voting', 'events', stream);
    const out = [];
    for (const yyyy of fs.readdirSync(base).filter(d => /^\d{4}$/.test(d)).sort()) {
        for (const f of fs.readdirSync(path.join(base, yyyy)).filter(f => /^\d{2}\.json$/.test(f)).sort()) {
            out.push(...JSON.parse(fs.readFileSync(path.join(base, yyyy, f), 'utf8')));
        }
    }
    return out;
}
const msgKeyOf = (tx, key) => (tx.messages || []).some(mm => mm.msg && typeof mm.msg === 'object' && key in mm.msg);

const gaugeTxs = loadFcd('tla-gauge').filter(t => Number(t.code || 0) === 0);
const escrowTxs = loadFcd('tla-escrow').filter(t => Number(t.code || 0) === 0);
const incentiveTxs = loadFcd('tla-incentive').filter(t => Number(t.code || 0) === 0);
const committedVotes = committedEvents('votes');
const committedLocks = committedEvents('locks');
const committedBribes = committedEvents('bribes');

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
    assert(hb.version === 'org-tla-voting-2.3.0' && hb.schemaVersion === 4, 'heartbeat carries 2.2.0 / schema 4');
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
        if (q.lock_info) {
            const owner = { '1': 'walletA', '2': 'walletB', '3': 'walletC', '4': 'walletD' }[q.lock_info.token_id];
            return { owner, asset: { info: { cw20: 'terra1ecgazlst' }, amount: '5000000' }, underlying_amount: '5500000',
                     start: 100, end: q.lock_info.token_id === '1' ? 'permanent' : { period: 250 },
                     coefficient: '1.5', slope: q.lock_info.token_id === '1' ? '0' : '100', voting_power: '900', fixed_amount: '100' };
        }
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
    // lock-state retention rider (2.2.0): the enumeration's lock_info answers retained
    const locksM = repoJson('tla-voting/vote-state/locks/2026/07.json');
    assert(locksM && locksM.length === 1 && locksM[0].period === 194 && locksM[0].lock_count === 4, `rider: one period-194 lock record, 4 locks (${locksM && locksM.length})`);
    const l1 = locksM[0].locks.find(l => l.token_id === '1'), l2 = locksM[0].locks.find(l => l.token_id === '2');
    assert(l1.end === 'permanent' && l1.slope === '0' && l2.end && l2.end.period === 250, 'rider: end kept verbatim (permanent | {period})');
    assert(l1.underlying_amount === '5500000' && l1.asset === 'cw20:terra1ecgazlst' && l1.voting_power === '900' && l1.fixed_amount === '100', 'rider: analytic fields retained');
    assert(res.lock_state && res.lock_state.lock_count === 4, 'rider: lock_state surfaced in the harvest result');
    assert(idx.lock_state && idx.lock_state.last_period === 194, 'rider: index carries lock_state.last_period');
    // idempotence / up-to-date skip
    const res2 = await realForwardVoteState({ publishFile: memPublish, apiGetJson: memRead, readVoteEvents: async () => [], log: console });
    assert(res2.skipped && res2.reason === 'up to date', 'second run skips (up to date)');
    assert(repoJson('tla-voting/vote-state/locks/2026/07.json').length === 1, 'rider: dedup — no duplicate period record');
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
// build #2 additions (SPEC-tla-voting-rollups §4): classifier v5 + rollups 4
// =============================================================================
const { buildRollups4 } = require('./lib/rollups.js');

console.log('\nR5 — classifier v5: rebase-income promotion on the REAL probe tx');
{
    const probe = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'compound_probe.json'), 'utf8'));
    const tr = probe.tx_response;
    const e = M.classifyEscrowTxs([tr], {});
    const comp = e.rewardEvents.find(ev => ev.type === 'compound');
    assert(comp && Array.isArray(comp.coins) && comp.coins[0].amount === '13966383' &&
           comp.coins[0].denom === 'cw20:terra1ecgazyd0waaj3g7l9cmy5gulhxkps2gmxu9ghducvuypjq68mq2s5lvsct' &&
           comp.coins_source === 'gauge_event',
        `compound income filled from gauge event: ${comp && JSON.stringify(comp.coins)} (${comp && comp.coins_source})`);
    assert(M.extractLockTokenId(tr, null) === '748', 'v4 regression: token_id 748 still extracted from the same real tx');
    // true zero-claim stays null: same tx WITHOUT the gauge/claim_rebase event
    const noGauge = JSON.parse(JSON.stringify(tr));
    noGauge.events = noGauge.events.filter(ev => !(ev.attributes || []).some(a => a.value === 'gauge/claim_rebase'));
    const e2 = M.classifyEscrowTxs([noGauge], {});
    const comp2 = e2.rewardEvents.find(ev => ev.type === 'compound');
    assert(comp2 && comp2.coins === null && comp2.coins_source === undefined, 'zero-claim (no gauge declaration) stays coins:null');
}

console.log('\nR1–R4, R6, R7, R13a — rollups schema 5 on real vote-state + crafted claim + bribe_ledger');
{
    REPO.clear();
    const TC = fs.readFileSync(path.join(TLA_CORE, 'token-catalog', 'snapshots', 'current.json'), 'utf8');
    const realVS = JSON.parse(fs.readFileSync(path.join(TLA_CORE, 'tla-voting', 'vote-state', '2026', '07.json'), 'utf8'));
    const wDirect = 'terra1mockdirectvoter', wX = 'terra1mockclaimer';
    const vsMonth = [...realVS,
        { schemaVersion: 1, period: 193, wallet: wDirect, vp: { fixed: '1', boost: '9', total: '10' }, gauge_votes: [], voted_this_period: false, raw_gauge_votes: [], capturedAt: '2026-07-15T00:00:00Z', source: 'state-harvest' }];
    REPO.set('tla-voting/events/index.json', JSON.stringify({ schemaVersion: 4, streams: {
        votes:   { count: 2, months_present: { '2026': ['07'] } },
        locks:   { count: 4, months_present: { '2026': ['07'] } },
        bribes:  { count: 1, months_present: { '2026': ['07'] } },
        rewards: { count: 4, months_present: { '2026': ['07'] } } }, files: { 'rollups.json': {} } }));
    REPO.set('tla-voting/vote-state/index.json', JSON.stringify({ schemaVersion: 1, last_harvested_period: 193, months_present: { '2026': ['07'] } }));
    REPO.set('tla-voting/vote-state/2026/07.json', JSON.stringify(vsMonth));
    REPO.set('token-catalog/snapshots/current.json', TC);
    REPO.set('tla-voting/events/votes/2026/07.json', JSON.stringify([
        { type: 'vote', wallet: wDirect, gauge: 'project', votes: [['cw20:poolA', 10000]], height: 1, timestamp: '2026-07-02T00:00:00Z', tx_hash: 'V1' },
        { type: 'vote', wallet: wDirect, gauge: 'stable', votes: [['cw20:poolB', 10000]], height: 2, timestamp: '2026-07-03T00:00:00Z', tx_hash: 'V2' }]));
    REPO.set('tla-voting/events/locks/2026/07.json', JSON.stringify([
        { type: 'lock_create', canonical: true, wallet: wX, amount: 5000000, asset: 'cw20:terra1ecgazyd0waaj3g7l9cmy5gulhxkps2gmxu9ghducvuypjq68mq2s5lvsct', timestamp: '2026-07-01T00:00:00Z', height: 1, tx_hash: 'L1' },
        { type: 'lock_create', canonical: false, wallet: wX, amount: 7777777, asset: 'cw20:terra1ecgazyd0waaj3g7l9cmy5gulhxkps2gmxu9ghducvuypjq68mq2s5lvsct', timestamp: '2026-07-01T01:00:00Z', height: 2, tx_hash: 'L2' },
        { type: 'withdraw', canonical: true, wallet: wX, amount: 1000000, timestamp: '2026-07-02T00:00:00Z', height: 3, tx_hash: 'L3' },
        { type: 'lock_extend_time', canonical: true, wallet: wX, timestamp: '2026-07-03T00:00:00Z', height: 4, tx_hash: 'L4' }]));
    REPO.set('tla-voting/events/bribes/2026/07.json', JSON.stringify([
        { type: 'bribe_add', briber: 'terra1mockbriber', pool: 'cw20:poolA', gauge: 'project', epoch_start: 194, coins: [{ amount: '180000000', denom: 'native:uluna' }], timestamp: '2026-07-02T00:00:00Z', height: 5, tx_hash: 'B1' },
        { type: 'bribe_add', via: 'wasm_event', briber: 'terra1tributecontract', briber_source: 'msg_target', pool: null, epoch_start: 195, epoch_end: 195, coins: [{ amount: '15000000', denom: 'native:uluna' }], timestamp: '2026-07-03T00:00:00Z', height: 6, tx_hash: 'B2' },
        { type: 'bribe_add', via: 'wasm_event', briber: 'terra1tributecontract', briber_source: 'msg_target', pool: null, epoch_start: 190, epoch_end: 194, coins: [{ amount: '5000000', denom: 'native:uluna' }], timestamp: '2026-07-03T01:00:00Z', height: 7, tx_hash: 'B3' }]));
    // #3.5: the bribe-state ledger joins the build — period 194 state totals
    REPO.set('tla-voting/bribe-state/index.json', JSON.stringify({ schemaVersion: 1, last_harvested_period: 194, walked_down_to: 96, floor_period: 96, months_present: { '2026': ['07'] } }));
    REPO.set('tla-voting/bribe-state/2026/07.json', JSON.stringify([
        { schemaVersion: 1, period: 194, harvested_at: '2026-07-15T00:00:00Z', source: 'state-harvest', buckets: [
            { gauge: 'project', asset: { cw20: 'terra1poolA' }, assets: [
                { info: { native_token: { denom: 'uluna' } }, amount: '200000000' },
                { info: { token: { contract_addr: 'terra1astro' } }, amount: '9000000' }] }] }]));
    REPO.set('tla-voting/events/rewards/2026/07.json', JSON.stringify([
        { type: 'claim_bribes', kind: 'wallet_claim', wallet: wX, coins: [{ amount: '1000000', denom: 'native:uluna' }], timestamp: '2026-07-02T10:00:00Z', height: 6, tx_hash: 'C1' },
        { type: 'claim_bribes', kind: 'wallet_claim', wallet: wX, coins: [{ amount: '2000000', denom: 'native:uluna' }], timestamp: '2026-07-05T10:00:00Z', height: 7, tx_hash: 'C2' },
        { type: 'claim_rebase', kind: 'wallet_claim', wallet: wX, coins: null, timestamp: '2026-07-06T10:00:00Z', height: 8, tx_hash: 'C3' },
        { type: 'claim_bribes', kind: 'wallet_claim', wallet: wX, coins: [{ amount: '500', denom: 'native:ibc/UNKNOWNDENOM' }], timestamp: '2026-07-06T11:00:00Z', height: 9, tx_hash: 'C4' }]));
    REPO.set('price-history/2026/07.json', JSON.stringify({ meta: {}, days: {
        '2026-07-02': { LUNA: { usd: 0.30 } },
        '2026-07-04': { LUNA: { usd: 0.40 } } } }));   // 07-05 claim → walks back to 07-04

    const ru = await buildRollups4({ publishFile: memPublish, apiGetJson: memRead, epochOf: () => 193, log: console });
    const roll = repoJson('tla-voting/events/rollups.json');
    const vBy = Object.fromEntries(roll.voters.map(v => [v.wallet, v]));

    // R1 — the honest merge
    const maxVP = vsMonth.filter(r => r.vp).sort((a, b) => (BigInt(b.vp.total) > BigInt(a.vp.total) ? 1 : -1))[0];
    assert(roll.voters[0].wallet === maxVP.wallet && roll.voters[0].events_visibility === 'none',
        `top voter by VP is the real contract-path #1 (${roll.voters[0].wallet.slice(0, 14)}…), visibility none`);
    const adao = roll.voters.find(v => v.wallet.startsWith('terra1sffd4'));
    assert(adao && adao.state && adao.state.gauges.length === 4, 'aDAO in the rollup with its 4-gauge state');
    assert(vBy[wDirect].events_visibility === 'full' && vBy[wDirect].votes.event_count === 2 &&
           vBy[wDirect].votes.pools_voted.length === 2, 'direct voter: visibility full + event detail');
    assert(vBy[wX].state === null, 'events-only wallet keeps state:null (history is history)');
    assert(roll.voter_count === roll.voters.length && roll.voter_count > realVS.length, `union grew past state-only (${roll.voter_count} > ${realVS.length})`);

    // R2 — three-number claims math (exact)
    const luna = vBy[wX].claims.by_token.LUNA;
    assert(luna.amount === '3000000' && luna.amount_display === 3 && luna.claim_count === 2, `LUNA amounts (${luna.amount}, ×${luna.claim_count})`);
    assert(luna.usd_at_claim === 1.10, `usd_at_claim 0.3×1 + 0.4×2 = 1.10 (${luna.usd_at_claim})`);
    assert(luna.usd_at_build === 1.20, `usd_at_build latest 0.40 × 3.0 = 1.20 (${luna.usd_at_build})`);
    assert(vBy[wX].claims.totals.usd_at_claim === 1.10 && vBy[wX].claims.totals.usd_at_build === 1.20, 'wallet totals match');

    // R3 — price edges + coverage honesty
    assert(vBy[wX].claims.unpriced.some(u => u.denom === 'native:ibc/UNKNOWNDENOM' && /token-catalog/.test(u.reason)), 'unjoinable denom lands in unpriced, never dropped');
    assert(roll.claim_coverage.some(c => /HOLE/.test(c.source)), 'the 2025→2026 capture hole is DECLARED in the file');

    // R4 — canonical-only lock sums
    const net = vBy[wX].locks.net_by_denom['cw20:terra1ecgazyd0waaj3g7l9cmy5gulhxkps2gmxu9ghducvuypjq68mq2s5lvsct'];
    assert(net.in === '5000000' && net.out === '1000000', `canonical net in/out 5M/1M (${net.in}/${net.out}) — non-canonical 7.78M excluded`);
    assert(vBy[wX].locks.first_lock_ts === '2026-07-01T00:00:00Z', 'first_lock_ts from the canonical create');

    // R6 — zero-claims honest split
    assert(vBy[wX].claims.claim_tx_count === 4 && vBy[wX].claims.paid_claim_count === 3, `claim_tx 4 vs paid 3 (${vBy[wX].claims.claim_tx_count}/${vBy[wX].claims.paid_claim_count})`);

    // R7 — pots retired + bribers (schema 5: measured ledger, note RETIRED)
    assert(roll.pots && /distributions\/history/.test(roll.pots.moved_to) && !roll.protocol_pots_by_epoch, 'pots retired to distributions pointer');
    assert(roll.schemaVersion === 5 && roll.bribers_coverage_note === undefined, 'schema 5: bribers_coverage_note RETIRED');
    const mockBriber = roll.bribers.find(b => b.briber === 'terra1mockbriber');
    const tribBriber = roll.bribers.find(b => b.briber === 'terra1tributecontract');
    assert(mockBriber.by_epoch['194'].coins['native:uluna'] === '180000000' && mockBriber.via.msg === 1 && mockBriber.via.wasm_event === 0,
        'direct briber aggregated + via counts (msg)');
    assert(tribBriber.event_count === 2 && tribBriber.via.wasm_event === 2, 'v6-promoted briber carries via.wasm_event counts');

    // R13a — bribe_ledger math inside the full build
    const bl = roll.bribe_ledger;
    assert(bl.floor_period === 96 && bl.state_through_period === 194 && roll.sources.bribe_state_through_period === 194 && roll.sources.bribe_state_floor === 96,
        'ledger + sources carry the bribe-state cursor and floor');
    const p194 = bl.periods['194'].by_denom;
    assert(p194['native:uluna'].state === '200000000' && p194['native:uluna'].attributed === '180000000' && p194['native:uluna'].unattributed === '20000000',
        `period 194 uluna: state 200M, attributed 180M (single-period event), unattributed 20M MEASURED`);
    assert(p194['cw20:terra1astro'].state === '9000000' && p194['cw20:terra1astro'].attributed === '0' && p194['cw20:terra1astro'].unattributed === '9000000',
        'state-only denom: fully unattributed, never dropped (canonicalOfInfo token branch)');
    const lt = bl.lifetime['native:uluna'];
    assert(lt.state === '200000000' && lt.attributed_exact === '180000000' && lt.attributed_spanning === '5000000' && lt.unattributed === '15000000',
        `lifetime uluna: spanning event counts in FULL (5M, never divided) → unattributed 15M`);
    assert(bl.events_outside_state.by_denom['native:uluna'] === '15000000' && bl.events_outside_state.event_coin_count === 1,
        'single-period event ahead of the harvested head → events_outside_state, not a skewed remainder');
    assert(bl.spanning_event_coin_count === 1 && bl.periods['190'] === undefined,
        'spanning event NEVER lands in per-period rows (no-division law)');
}

console.log('\nR13 — bribe_ledger edges: grace, surplus clamp, dedup');
{
    const { buildBribeLedger } = require('./lib/rollups.js');
    // absent index (pre-deploy) → declared grace, never a throw
    const grace = buildBribeLedger(null, [], []);
    assert(/awaiting bribe-state/.test(grace.status), 'absent bribe-state index → declared awaiting status');
    // event surplus over state → unattributed clamped 0, surplus DECLARED
    const idx = { last_harvested_period: 194, floor_period: 96 };
    const recs = [{ period: 194, buckets: [{ gauge: 'g', assets: [{ info: { native: 'uluna' }, amount: '100' }] }] },
                  { period: 194, buckets: [{ gauge: 'g', assets: [{ info: { native: 'uluna' }, amount: '999999' }] }] }];  // dup period — must be ignored
    const evs = [{ type: 'bribe_add', epoch_start: 194, epoch_end: 194, coins: [{ denom: 'native:uluna', amount: '150' }] }];
    const led = buildBribeLedger(idx, recs, evs);
    const d = led.periods['194'].by_denom['native:uluna'];
    assert(d.state === '100', 'duplicate period record ignored (dedup safety — state stays 100)');
    assert(d.unattributed === '0' && d.event_surplus === '50', `surplus clamped: unattributed 0, event_surplus 50 declared (${JSON.stringify(d)})`);
    assert(led.lifetime['native:uluna'].unattributed === '0' && led.lifetime['native:uluna'].event_surplus === '50', 'lifetime surplus mirrors');
}

// =============================================================================
// build #3 additions (SPEC-tla-voting-bribe-state D9): R8–R12
// =============================================================================
const BS = bsLib;
const refusal = () => { const e = new Error('contract refusal'); e.statusCode = 400; e.body = 'Generic error: ve3_shared pre-genesis'; e.contractError = true; throw e; };
const mkBuckets = (p) => [{ gauge: 'stable', asset: { cw20: `terra1pool${p}` }, assets: [{ info: { native: 'uluna' }, amount: String(p * 1000) }, { info: { cw20: 'terra1astro' }, amount: String(p * 7) }] }];

console.log('\nR8 — bribe-state walk-down: budget, floor confirm, cursor across runs');
{
    REPO.clear();
    process.env.BRIBE_WALK_BUDGET = '2';
    REPO.set('docs/epoch_1-300_date.json', JSON.stringify(epochDates));
    BS.CH.fetchDistributions = async () => ({ ok: true, period: 194 });
    BS.CH.queryContract = async (addr, q) => {
        const t = q.bribes && q.bribes.period;
        const p = t == null ? 194 : t.period;
        if (t != null && typeof t.period !== 'number') throw new Error('mock: Time enum violated (bare/malformed period)');
        if (p >= 190) return { buckets: mkBuckets(p) };
        refusal();   // ≤189 = pre-genesis
    };
    const bsArgs = { publishFile: memPublish, apiGetJson: memRead, readBribeEvents: async () => [], log: console };
    const r1 = await realForwardBribeState(bsArgs);
    let idx = repoJson('tla-voting/bribe-state/index.json');
    assert(r1.forward_appended === 1 && r1.walk_appended === 2 && idx.last_harvested_period === 194 && idx.walked_down_to === 192,
        `run1: forward 194 + walk 193,192 under budget 2 (fwd ${r1.forward_appended}/walk ${r1.walk_appended}, down_to ${idx.walked_down_to})`);
    assert(idx.floor_period == null && /walk-down in progress/.test(idx.note || ''), 'run1: floor not yet certified, progress note present');
    const r2 = await realForwardBribeState(bsArgs);
    idx = repoJson('tla-voting/bribe-state/index.json');
    assert(r2.walk_appended === 2 && idx.walked_down_to === 190, `run2: walked to 190 (${idx.walked_down_to})`);
    const r3 = await realForwardBribeState(bsArgs);
    idx = repoJson('tla-voting/bribe-state/index.json');
    assert(idx.floor_period === 190 && idx.floor_certificate && idx.floor_certificate.probes.length === 3,
        `run3: FLOOR CERTIFIED at 190 with 3 consecutive probes (${idx.floor_period}, ${idx.floor_certificate && idx.floor_certificate.probes.length})`);
    const r4 = await realForwardBribeState(bsArgs);
    assert(r4.skipped && /up to date/.test(r4.reason), 'run4: skipped — up to date, floor certified');
    const hb = repoJson('tla-voting/bribe-state/heartbeat.json');
    assert(hb.floor_period === 190 && hb.status === 'ok', 'heartbeat carries floor + ok');
}

console.log('\nR9 — forward harvest: self-heal, dedup, epoch-month routing, corrupt-month refusal');
{
    // continue from R8 state; move the head to 197 (epoch ends: 195→2026-07, 196/197→2026-08)
    BS.CH.fetchDistributions = async () => ({ ok: true, period: 197 });
    BS.CH.queryContract = async (addr, q) => {
        const t = q.bribes && q.bribes.period;
        const p = t == null ? 197 : t.period;
        if (p >= 190) return { buckets: mkBuckets(p) };
        refusal();
    };
    const bsArgs = { publishFile: memPublish, apiGetJson: memRead, readBribeEvents: async () => [], log: console };
    const r = await realForwardBribeState(bsArgs);
    const idx = repoJson('tla-voting/bribe-state/index.json');
    const jul = repoJson('tla-voting/bribe-state/2026/07.json');
    const aug = repoJson('tla-voting/bribe-state/2026/08.json');
    assert(r.forward_appended === 3 && idx.last_harvested_period === 197, `self-heal: 195,196,197 appended (${r.forward_appended})`);
    assert(jul.some(x => x.period === 195) && aug && aug.map(x => x.period).join(',') === '196,197',
        `epoch-END-date month routing: 195→2026/07, 196+197→2026/08 (aug: ${aug && aug.map(x => x.period)})`);
    // period == epoch, month = the epoch's END month — spot-check deep history against the real table
    const m100 = BS.makePeriodMonth(epochDates)(100);
    const row100 = epochDates.find(e => e.epoch === 100);
    assert(`${m100.yyyy}-${m100.mm}` === row100.end_time.slice(0, 7), `period-100 routing matches the real table's end month (${m100.yyyy}/${m100.mm})`);
    // dedup: same head again → nothing new
    const r2 = await realForwardBribeState(bsArgs);
    assert(r2.skipped && r2.reason === 'nothing new' || r2.skipped, `re-run skips (${r2.reason})`);
    // never-shrink / corrupt refusal: cursor fields must HOLD
    BS.CH.fetchDistributions = async () => ({ ok: true, period: 198 });
    const monthOf198 = BS.makePeriodMonth(epochDates)(198);
    REPO.set(`tla-voting/bribe-state/${monthOf198.yyyy}/${monthOf198.mm}.json`, JSON.stringify({ corrupt: true }));
    const r3 = await realForwardBribeState(bsArgs);
    const idx3 = repoJson('tla-voting/bribe-state/index.json');
    assert(r3.status === 'partial' && idx3.last_harvested_period === 197, `corrupt month refused: status partial, cursor HELD at 197 (${idx3.last_harvested_period})`);
    assert(JSON.parse(REPO.get(`tla-voting/bribe-state/${monthOf198.yyyy}/${monthOf198.mm}.json`)).corrupt === true, 'corrupt file NOT overwritten');
}

console.log('\nR10 — classifier v6: contract-bribe promotion on REAL FCD tx 69D072693314');
{
    const takeTx = incentiveTxs.find(t => t.txhash.startsWith('69D072693314'));
    assert(!!takeTx, 'real take-rate tx present in the FCD archive');
    const i = M.classifyIncentiveTxs([adapt(takeTx)], {});
    const promoted = i.bribeEvents.filter(e => e.via === 'wasm_event');
    assert(i.bribeEvents.length === 2 && promoted.length === 2, `two add_bribe events → two promoted bribe events (${i.bribeEvents.length})`);
    const amts = promoted.map(e => e.coins[0].amount).sort();
    assert(amts.join(',') === '226225967,447102559', `ASTRO amounts 226225967 + 447102559 (${amts})`);
    assert(promoted.every(e => e.type === 'bribe_add' && e.briber_source === 'msg_target' &&
           e.coins[0].denom === 'native:ibc/8D8A7F7253615E5F76CB6252A1E1BD921D5EDB7BBAAF8913FB1C77FF125D9995' &&
           e.epoch_start === 115 && e.epoch_end === 115), 'denom + epoch range 115 carried from the event');
    const bribers = promoted.map(e => e.briber);
    assert(bribers[0] === 'terra1v399cx9drllm70wxfsgvfe694tdsd9x96p9ha36w7muffe4znlusqswspq' &&
           bribers[1] === 'terra1awq6t7jfakg9wfjn40fk3wzwmd57mvrqtt3a39z9rmet7wdjj3ysgw3lpa',
        `briber = each event's OWN initiating tribute contract via msg_index (${bribers.map(b => b.slice(0, 12))})`);
    assert(promoted.every(e => e.pool === null), 'aggregated add — no single callback matches → pool stays null (honest)');
    // pairing positive + ambiguity cases (crafted around the real event anatomy)
    const mgrEv = (added) => ({ type: 'wasm', attributes: [
        { key: '_contract_address', value: 'terra1tuuwm8yrj54qeg0c8xu00aha9ryatyhtczq8qq2q8tntuw0auzas9037wh' },
        { key: 'action', value: 'bribe/add_bribe' }, { key: 'added', value: added },
        { key: 'start', value: '200' }, { key: 'end', value: '200' }, { key: 'msg_index', value: '0' }] });
    const cbEv = (asset, bribe) => ({ type: 'wasm', attributes: [
        { key: '_contract_address', value: 'terra1bucket' }, { key: 'action', value: 'asset/track_bribes_callback' },
        { key: 'asset', value: asset }, { key: 'bribe', value: bribe }, { key: 'msg_index', value: '0' }] });
    const mkTx = (events) => ({ txhash: 'CRAFTED1', height: 1, timestamp: '2026-07-15T00:00:00Z',
        events, tx: { body: { messages: [{ sender: 'terra1bot', contract: 'terra1bucket', msg: { distribute_take_rate: {} } }] } } });
    const paired = M.classifyIncentiveTxs([mkTx([mgrEv('native:uluna:5000'), cbEv('cw20:terra1poolq', 'native:uluna:5000')])], {}).bribeEvents;
    assert(paired.length === 1 && paired[0].pool === 'cw20:terra1poolq' && paired[0].briber === 'terra1bucket',
        `single unambiguous callback match → pool paired (${paired[0] && paired[0].pool})`);
    const ambig = M.classifyIncentiveTxs([mkTx([mgrEv('native:uluna:5000'), cbEv('cw20:terra1poolq', 'native:uluna:5000'), cbEv('cw20:terra1poolr', 'native:uluna:5000')])], {}).bribeEvents;
    assert(ambig.length === 1 && ambig[0].pool === null, 'two same denom+amount candidates → ambiguity stays null');
    // regression: direct bribes untouched — the hook never fires when a msg classified
    const directSample = incentiveTxs.filter(t => msgKeyOf(t, 'add_bribe')).slice(0, 10);
    const d = M.classifyIncentiveTxs(directSample.map(adapt), {});
    assert(d.bribeEvents.length > 0 && d.bribeEvents.every(e => e.via === undefined),
        `direct-bribe regression: ${d.bribeEvents.length} events, zero promoted (T1 parity already asserted field-level)`);
}

console.log('\nR11 — bribe_capture coverage math on a crafted period');
{
    const record = { period: 200, buckets: [
        { gauge: 'stable', asset: { cw20: 'terra1poolA' }, assets: [{ info: { native: 'uluna' }, amount: '600' }] },
        { gauge: 'project', asset: { cw20: 'terra1poolB' }, assets: [{ info: { native: 'uluna' }, amount: '400' }, { info: { cw20: 'terra1solid' }, amount: '100' }] },
    ] };
    const events = [
        { type: 'bribe_add', coins: [{ amount: '600', denom: 'native:uluna' }], epoch_start: 200, epoch_end: 200, timestamp: '2026-08-01T00:00:00Z' },
        { type: 'bribe_add', coins: [{ amount: '800', denom: 'native:uluna' }], epoch_start: 199, epoch_end: 202, timestamp: '2026-08-01T00:00:00Z' },  // 4-way linear → 200/period
        { type: 'bribe_add', coins: [{ amount: '50', denom: 'cw20:terra1ghost' }], epoch_start: 200, epoch_end: 200, timestamp: '2026-08-01T00:00:00Z' },
        { type: 'bribe_add', coins: [{ amount: '999', denom: 'native:uluna' }], epoch_start: 150, epoch_end: 150, timestamp: '2024-01-01T00:00:00Z' },   // out of period
    ];
    const bc = BS.computeBribeCapture(events, record, () => null);
    assert(bc.denoms['native:uluna'].state === '1000' && bc.denoms['native:uluna'].events === '800' && bc.denoms['native:uluna'].coverage_pct === 80,
        `uluna: state 1000, events 600+200(linear share) = 800 → 80% (${JSON.stringify(bc.denoms['native:uluna'])})`);
    assert(bc.denoms['cw20:terra1solid'].coverage_pct === 0, 'state-only denom: 0% coverage (the structural blind spot, measured)');
    assert(bc.denoms['cw20:terra1ghost'] && bc.denoms['cw20:terra1ghost'].events_only === true, 'events-only denom listed, never dropped');
    assert(bc.mean_coverage_pct === 40, `mean over state denoms = (80+0)/2 = 40 (${bc.mean_coverage_pct})`);
}

console.log('\nR12 — verbatim retention: record.buckets deep-equals the chain response');
{
    const chainBuckets = mkBuckets(191);
    // pull the committed record for period 191 from whichever month it landed in
    const m191 = BS.makePeriodMonth(epochDates)(191);
    const month = repoJson(`tla-voting/bribe-state/${m191.yyyy}/${m191.mm}.json`);
    const r191 = month && month.find(x => x.period === 191);
    assert(r191 && JSON.stringify(r191.buckets) === JSON.stringify(chainBuckets), 'committed period-191 buckets byte-equal the stubbed chain response');
    assert(Object.keys(r191).sort().join(',') === 'buckets,harvested_at,period,schemaVersion,source',
        `record carries EXACTLY the D5 fields — zero derived (${Object.keys(r191).sort()})`);
}

// =============================================================================
console.log(`\n${'='.repeat(60)}\n${FAIL === 0 ? '✅' : '❌'} mock gate: ${PASS} passed, ${FAIL} failed\n`);
process.exit(FAIL === 0 ? 0 : 1);
}

main().catch(e => { console.error('MOCK HARNESS FATAL:', e); process.exit(1); });
