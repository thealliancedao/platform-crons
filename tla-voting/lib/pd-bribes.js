'use strict';
// =============================================================================
// pd-bribes — governance-executed bribe attribution (SPEC-pd-directive-watch,
// data product). PD's add_bribe payloads live PERMANENTLY in its dao-proposal
// contract's state, so the per-pool identity the wasm events never carried is
// queryable forever via live LCD — no archive dependency.
//
// Method (measured, never assumed):
//   1. Enumerate ALL proposals on PD's proposal module ({list_proposals} paged).
//   2. Decode every executed proposal's msgs; keep wasm executes on the TLA
//      incentive manager whose payload is add_bribe → per-leg pool + gauge +
//      span + funds (net = funds − the 10-LUNA add_bribe fee when same-denom).
//   3. Cross-verify against the CAPTURED event stream (briber = PD core):
//      executions and proposals are matched by leg MULTISET
//      (denom|net|start|end) — the twin-amount legs prop 250 is famous for
//      match symmetrically (equal keys → totals identical either pairing).
//   4. Spread per leg across its span (events carry start/end natively):
//      per_epoch = net / (end − start + 1). EXACT, not modeled.
//   5. Publish tla-voting/pd-bribes/{current,heartbeat}.json — the single home
//      that replaces the hand-maintained tla_pd_bribes.json (stale past e188
//      while PD funded ~41% of e196) and feeds the epoch-bribes popup, PD's
//      briber-modal By-pool, and the PD Watch page.
//
// Honesty rules: an executed proposal with no captured execution is listed
// under meta.unmatched_proposals (flagged, amounts shown, never merged into
// verified placements). A captured execution with no matching proposal is a
// LOUD flag (should be impossible). cw20-style bribes (send-hook path) are
// not decoded in v1 — flagged raw, never guessed. PD bribes are LUNA to date.
// =============================================================================

const D = require('./distributions.js');   // httpGetHard, sleep — one transport, zero drift (the bribe-state pattern)

const LCD_PRIMARY  = process.env.LCD_PRIMARY  || 'https://terra-lcd.publicnode.com';
const LCD_FALLBACK = process.env.LCD_FALLBACK || 'https://terra-rest.publicnode.com';
const FETCH_RETRIES = 3;

function smartPath(addr, queryObj) {
    const b64 = Buffer.from(JSON.stringify(queryObj)).toString('base64');
    return `/cosmwasm/wasm/v1/contract/${addr}/smart/${encodeURIComponent(b64)}`;
}
async function realQueryContract(addr, queryObj) {
    let lastErr = null;
    for (let attempt = 0; attempt < FETCH_RETRIES; attempt++) {
        const base = attempt % 2 === 0 ? LCD_PRIMARY : LCD_FALLBACK;
        try {
            const res = await D.httpGetHard(base + smartPath(addr, queryObj));
            return res && res.data !== undefined ? res.data : res;
        } catch (e) { lastErr = e; await D.sleep(250 * (attempt + 1)); }
    }
    throw lastErr || new Error('pd-bribes: queryContract exhausted retries');
}

const PD_CORE = 'terra1k8ug6dkzntczfzn76wsh24tdjmx944yj6mk063wum7n20cwd7lxq4lppjg';
const PD_PROP_MODULE = 'terra1660g9mle5kfsq8c0p4k4hgr9ujdyr3m48c22cawy0akr98rmwksqehqnup';
const INCENTIVE_MANAGER = 'terra1tuuwm8yrj54qeg0c8xu00aha9ryatyhtczq8qq2q8tntuw0auzas9037wh';
const FEE_LUNA_RAW = 10000000; // 10 LUNA add_bribe fee, forwarded to PD core (fee income, never a bribe)
const VERSION = 'pd-bribes-1.0.0';

function poolIdFrom(ab) {
    // add_bribe payload pool identity — defensive across the shapes the
    // manager accepts. Returns canonical 'cw20:addr' | 'native:denom' | null.
    const cand = ab.lp_token ?? ab.lp ?? ab.pool ?? ab.asset ?? ab.lp_asset ?? null;
    if (cand == null) return null;
    if (typeof cand === 'string') {
        if (cand.startsWith('cw20:') || cand.startsWith('native:')) return cand;
        if (cand.startsWith('terra1')) return 'cw20:' + cand;
        return 'native:' + cand;
    }
    if (typeof cand === 'object') {
        if (cand.token && cand.token.contract_addr) return 'cw20:' + cand.token.contract_addr;
        if (cand.native_token && cand.native_token.denom) return 'native:' + cand.native_token.denom;
        if (cand.cw20) return 'cw20:' + cand.cw20;
        if (cand.native) return 'native:' + cand.native;
    }
    return null;
}

function decodeProposalLegs(prop, flags) {
    const legs = [];
    for (const m of (prop.msgs || [])) {
        const ex = m && m.wasm && m.wasm.execute;
        if (!ex || ex.contract_addr !== INCENTIVE_MANAGER) continue;
        let payload = null;
        try { payload = JSON.parse(Buffer.from(ex.msg, 'base64').toString()); }
        catch (e) { flags.push({ where: 'msg_decode', error: e.message }); continue; }
        const ab = payload && payload.add_bribe;
        if (!ab) continue; // other manager calls in a PD prop are not bribes
        const start = Number(ab.start ?? ab.epoch_start);
        const end = Number(ab.end ?? ab.epoch_end ?? start);
        const pool = poolIdFrom(ab);
        if (pool == null) flags.push({ where: 'pool_identity', error: 'add_bribe payload carried no recognizable pool key', keys: Object.keys(ab) });
        // funds → bribe coin + fee. Fee is 10 LUNA always; same-denom (uluna)
        // bribes arrive as ONE merged uluna coin (gross = net + fee).
        const funds = ex.funds || [];
        let denomKey = null, netRaw = null, feeLuna = 0;
        const uluna = funds.find(c => c.denom === 'uluna');
        const other = funds.find(c => c.denom !== 'uluna');
        if (other) {
            denomKey = 'native:' + other.denom;
            netRaw = Number(other.amount);
            feeLuna = uluna ? Number(uluna.amount) : 0;
        } else if (uluna) {
            denomKey = 'native:uluna';
            netRaw = Number(uluna.amount) - FEE_LUNA_RAW;
            feeLuna = FEE_LUNA_RAW;
        } else {
            flags.push({ where: 'funds', error: 'add_bribe msg with no funds (cw20 send-hook path?) — leg recorded unpriceable', pool });
        }
        legs.push({ pool_gauge_id: pool, gauge: ab.gauge || null, denom: denomKey, net_raw: netRaw, fee_luna_raw: feeLuna, start, end, dist_func: ab.func ?? ab.dist_func ?? null });
    }
    return legs;
}

const legKey = (l) => `${l.denom}|${l.net_raw}|${l.start}|${l.end}`;
const multisetKey = (legs) => legs.map(legKey).sort().join('~');

async function listAllProposals(queryContract, flags) {
    const out = [];
    let startAfter = null;
    for (let page = 0; page < 40; page++) {
        const q = { list_proposals: { limit: 30, ...(startAfter != null ? { start_after: startAfter } : {}) } };
        const r = await queryContract(PD_PROP_MODULE, q);
        const items = (r && (r.proposals || r)) || [];
        if (!Array.isArray(items) || items.length === 0) break;
        out.push(...items);
        startAfter = items[items.length - 1].id;
        if (items.length < 30) break;
    }
    if (out.length === 0) flags.push({ where: 'list_proposals', error: 'proposal module returned zero proposals — refusing to publish an empty product as truth' });
    return out;
}

async function readPdEvents(apiGetJson) {
    const ir = await apiGetJson('tla-voting/events/index.json');
    if (!ir.ok || !ir.data) throw new Error('events index unavailable');
    const months = ir.data.streams?.bribes?.months_present || {};
    const evs = [];
    for (const yyyy of Object.keys(months).sort()) for (const mm of months[yyyy]) {
        const r = await apiGetJson(`tla-voting/events/bribes/${yyyy}/${mm}.json`);
        if (!r.ok) throw new Error(`month read failed ${yyyy}/${mm}`);
        const arr = Array.isArray(r.data) ? r.data : (r.data.events || []);
        for (const e of arr) if (e && e.briber === PD_CORE) evs.push(e);
    }
    return evs;
}

function buildProduct(proposals, pdEvents, now, flags) {
    // executions from events, grouped by tx
    const byTx = new Map();
    for (const ev of pdEvents) {
        const t = byTx.get(ev.tx_hash) || { tx_hash: ev.tx_hash, height: ev.height, timestamp: ev.timestamp, legs: [] };
        const c = (ev.coins || [])[0] || {};
        t.legs.push({ denom: c.denom || null, net_raw: Number(c.amount || 0), start: ev.epoch_start, end: ev.epoch_end ?? ev.epoch_start });
        byTx.set(ev.tx_hash, t);
    }
    const execByMs = new Map();
    for (const t of byTx.values()) {
        const k = multisetKey(t.legs);
        (execByMs.get(k) || execByMs.set(k, []).get(k)).push(t);
    }
    for (const arr of execByMs.values()) arr.sort((a, b) => a.height - b.height);

    const placements = [], unmatchedProps = [];
    const decoded = proposals
        .map(item => ({ id: item.id, prop: item.proposal || item }))
        .filter(x => String(x.prop.status || '').toLowerCase().includes('execut'))
        .map(x => ({ ...x, legs: decodeProposalLegs(x.prop, flags) }))
        .filter(x => x.legs.length > 0)
        .sort((a, b) => Number(a.id) - Number(b.id));

    for (const p of decoded) {
        const k = multisetKey(p.legs);
        const pool = execByMs.get(k);
        const exec = pool && pool.length ? pool.shift() : null;
        const legs = p.legs.map(l => {
            const epochs = (l.end - l.start + 1) || 1;
            return { ...l, net_display: l.net_raw != null ? l.net_raw / 1e6 : null, epochs, per_epoch_display: l.net_raw != null ? Math.round(l.net_raw / epochs) / 1e6 : null };
        });
        const rec = {
            proposal_id: p.id, title: p.prop.title || null,
            tx_hash: exec ? exec.tx_hash : null, height: exec ? exec.height : null, executed_at: exec ? exec.timestamp : null,
            verified_against_events: !!exec,
            legs,
            total_net_display: Math.round(legs.reduce((s, l) => s + (l.net_raw || 0), 0)) / 1e6,
        };
        if (exec) placements.push(rec);
        else { unmatchedProps.push(rec); flags.push({ where: `proposal ${p.id}`, error: 'executed with add_bribe msgs but no captured execution matched (multiset) — shown flagged, never merged as verified' }); }
    }
    const unmatchedExecs = [...execByMs.values()].flat().map(t => t.tx_hash);
    for (const h of unmatchedExecs) flags.push({ where: `execution ${h.slice(0, 12)}`, error: 'captured PD execution with NO matching proposal — investigate (should be impossible)' });

    // rollups: by_epoch spread + by_pool lifetime (verified placements only)
    const by_epoch = {}, by_pool = {};
    for (const pl of placements) for (const l of pl.legs) {
        if (l.pool_gauge_id == null || l.net_raw == null) continue;
        for (let e = l.start; e <= l.end; e++) {
            const slot = (by_epoch[e] ||= { pools: {}, total_display_by_denom: {} });
            const ps = (slot.pools[l.pool_gauge_id] ||= { gauge: l.gauge, by_denom: {} });
            ps.by_denom[l.denom] = Math.round(((ps.by_denom[l.denom] || 0) + l.net_raw / l.epochs / 1e6) * 1e6) / 1e6;
            slot.total_display_by_denom[l.denom] = Math.round(((slot.total_display_by_denom[l.denom] || 0) + l.net_raw / l.epochs / 1e6) * 1e6) / 1e6;
        }
        const bp = (by_pool[l.pool_gauge_id] ||= { gauge: l.gauge, by_denom: {}, leg_count: 0 });
        bp.by_denom[l.denom] = Math.round(((bp.by_denom[l.denom] || 0) + l.net_raw / 1e6) * 1e6) / 1e6;
        bp.leg_count++;
    }

    return {
        meta: {
            version: VERSION, generated_at: now.toISOString(),
            dao_core: PD_CORE, prop_module: PD_PROP_MODULE, incentive_manager: INCENTIVE_MANAGER,
            method: 'proposal-module state (permanent) decoded per executed proposal; legs cross-verified against captured events by (denom|net|start|end) multiset; per-epoch spread is exact from each leg\u2019s start/end. Fee legs (10 LUNA, forwarded to PD core) excluded from all amounts. Replaces the hand-maintained tla_pd_bribes.json.',
            proposals_scanned: proposals.length, executed_with_bribes: decoded.length,
            verified_placements: placements.length, unmatched_proposals: unmatchedProps.length, unmatched_executions: unmatchedExecs.length,
        },
        placements, unmatched_proposals: unmatchedProps,
        by_epoch, by_pool,
        totals: {
            // denom-honest: the LUNA headline counts ONLY uluna legs; other
            // denoms roll up separately (mixed-denom sums are meaningless).
            net_luna_display: Math.round(placements.flatMap(p => p.legs).filter(l => l.denom === 'native:uluna').reduce((s, l) => s + (l.net_raw || 0), 0) / 1e6 * 1e6) / 1e6,
            net_by_denom: placements.flatMap(p => p.legs).reduce((acc, l) => { if (l.denom && l.net_raw != null) acc[l.denom] = Math.round(((acc[l.denom] || 0) + l.net_raw / 1e6) * 1e6) / 1e6; return acc; }, {}),
            placements: placements.length,
            first_executed: placements.map(p => p.executed_at).filter(Boolean).sort()[0] || null,
            last_executed: placements.map(p => p.executed_at).filter(Boolean).sort().slice(-1)[0] || null,
        },
    };
}

async function buildPdBribes({ queryContract = realQueryContract, apiGetJson, publishFile, now = new Date(), log = console }) {
    const flags = [];
    const proposals = await listAllProposals(queryContract, flags);
    if (proposals.length === 0) throw new Error('pd-bribes: zero proposals from module — aborting (never publish empty as truth)');
    const pdEvents = await readPdEvents(apiGetJson);
    const doc = buildProduct(proposals, pdEvents, now, flags);
    if (flags.length) doc.meta.flags = flags;
    await publishFile('tla-voting/pd-bribes/current.json', JSON.stringify(doc, null, 1), `pd-bribes: ${doc.meta.verified_placements} verified placements @ ${now.toISOString()}`);
    await publishFile('tla-voting/pd-bribes/heartbeat.json', JSON.stringify({
        version: VERSION, generated_at: now.toISOString(),
        status: doc.meta.unmatched_executions > 0 ? 'error' : (flags.length ? 'partial' : 'ok'),
        verified_placements: doc.meta.verified_placements, unmatched_proposals: doc.meta.unmatched_proposals,
        unmatched_executions: doc.meta.unmatched_executions, total_net_luna: doc.totals.net_luna_display,
        _flags: flags.length ? flags : null,
    }, null, 1), 'pd-bribes heartbeat');
    return doc;
}

module.exports = { buildPdBribes, buildProduct, decodeProposalLegs, poolIdFrom, listAllProposals, PD_CORE, PD_PROP_MODULE, INCENTIVE_MANAGER, VERSION };
