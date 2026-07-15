// =============================================================================
// tla-voting / lib / bribe-state.js — per-period bribe-state harvest (build #3)
// =============================================================================
// SPEC-tla-voting-bribe-state (approved 2026-07-15). The tribute COMPLETENESS
// layer — the capture-fix playbook, third run: state for completeness, events
// for attribution, state wins.
//
// The committed bribe stream holds 173 events; the manager's own books hold
// thousands — the take-rate tribute flow (four bucket contracts calling
// add_bribe internally) is invisible to message-level classification by
// construction, and the 2025-01→2026-06 capture hole swallowed everything
// else. The manager retains its complete per-period, per-pool, per-denom
// ledger (retention PROVEN to period 100 — 12 pools, Sept-2024 era), so
// ~100 queries recover the entire tribute history of TLA, hole included.
//
// D1 — THE STATE SOURCE (CHAIN-PINNED, queries.md Q-IncentiveManager-Bribes):
//   incentive manager `{ bribes: { period: <Time> } }` where `period` is the
//   ve3 Time enum (`current|next|last|{time}|{period:N}`) — NEVER a bare
//   number (serde-json-wasm fallback error; cost four probes). `{bribes:{}}`
//   = current. Returns { buckets: [ { gauge, asset(pool), assets:
//   [{info, amount}…] }… ] }.
// D2 — GENESIS WALK, IN-CRON, BUDGETED: walk DOWN from the current period,
//   BRIBE_WALK_BUDGET (default 30) periods per hourly run, until the floor.
//   Floor semantics mirror the proven distributions sibling: contract-level
//   refusal / empty buckets = floor-shaped; FLOOR_CONFIRM consecutive
//   floor-shaped responses certify (register rule: mid-range failure ≠
//   floor). `index.floor_period` records what the chain says (expect ≈96,
//   the distributions floor — recorded, never presumed). Cursor:
//   `index.walked_down_to` + `index.last_harvested_period`.
// D3 — FORWARD: one harvest per period, same trigger as vote-state — the
//   distributions head advanced past last_harvested_period. Piggybacks the
//   hourly run; lateness is free (retained state), missed flips self-heal.
// D4 — STORAGE: monthly files `bribe-state/{YYYY}/{MM}.json` keyed by the
//   PERIOD'S EPOCH END DATE (docs/epoch_1-300_date.json) — history lands in
//   its historical months (deliberate deviation from vote-state's
//   capturedAt-month, which has no backfill). Dedup key = period;
//   never-shrink; index.json + heartbeat.json.
// D5 — RECORD SHAPE (verbatim insurance): { schemaVersion, period,
//   harvested_at, source:'state-harvest', buckets: <chain VERBATIM> }.
//   NO derived fields — totals/USD live in rollups (Layer 3, recomputable).
// D7 — bribe_capture (heartbeat): on each forward harvest, event-derived
//   per-period bribe sums vs the state buckets → coverage % per denom. A
//   COVERAGE metric, not an alarm — events are structurally partial (that's
//   why this layer exists); the alarm is coverage DROPPING for direct-bribe
//   denominators.
//
// SELF-START: like vote-state, this product MAY start itself — an empty
// product has no history to clobber; dedup + never-shrink apply on every
// write. Cursor fields advance ONLY when every touched month published.
// =============================================================================
'use strict';

const C = require('../../config/contracts.js');
const D = require('./distributions.js');   // httpGetHard, fetchDistributions, sleep — one transport, zero drift

const LCD_PRIMARY  = process.env.LCD_PRIMARY  || 'https://terra-lcd.publicnode.com';
const LCD_FALLBACK = process.env.LCD_FALLBACK || 'https://terra-rest.publicnode.com';

const INCENTIVE_MANAGER = C.BRIBE_MANAGER.addr;

const BS_DIR = 'tla-voting/bribe-state';
const BS_SCHEMA_VERSION = 1;
const FLOOR_CONFIRM = 3;      // register rule (distributions): consecutive floor-shaped responses to certify
const FETCH_RETRIES = 3;
const PACE_MS = Number(process.env.BS_PACE_MS || 150);
const EPOCH_DATES_PATH = 'docs/epoch_1-300_date.json';

const sleep = D.sleep;

// ---- chain access (injectable: mock-run.js replaces CH.* — the vote-state pattern)
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
        } catch (e) {
            lastErr = e;
            if (e.statusCode && e.body && /query wasm contract failed|not found|Generic error|ve3_shared/i.test(e.body)) { e.contractError = true; throw e; }
            await sleep(250 * (attempt + 1));
        }
    }
    throw lastErr || new Error('queryContract exhausted retries');
}
const CH = {
    queryContract: realQueryContract,
    fetchDistributions: D.fetchDistributions,
};

// Query one period's bribe ledger. Three outcomes (the distributions pattern):
//   {ok:true, buckets}                — data (buckets may legitimately be small)
//   {ok:false, floor:true, error}     — contract-level refusal OR empty buckets
//   {ok:false, floor:false, error}    — network/transient (after retries)
// D1: the period field is the ve3 Time enum — {period:{period:N}}, NEVER bare.
async function fetchBribes(periodOrCurrent) {
    const q = periodOrCurrent === 'current'
        ? { bribes: {} }
        : { bribes: { period: { period: periodOrCurrent } } };
    try {
        const body = await CH.queryContract(INCENTIVE_MANAGER, q);
        const buckets = body && body.buckets;
        if (!Array.isArray(buckets)) return { ok: false, floor: false, error: 'unexpected shape (buckets not array)' };
        if (buckets.length === 0) return { ok: false, floor: true, error: 'empty buckets (pre-genesis or zero-bribe state)' };
        return { ok: true, buckets };
    } catch (e) {
        if (e.contractError) return { ok: false, floor: true, error: String(e.body || e.message).slice(0, 200) };
        return { ok: false, floor: false, error: String(e.message || e) };
    }
}

// ---- D4: epoch-end-date month routing (period == UI epoch, chain-confirmed) --
// Rows past the table extrapolate weekly from the last end_time — same rule as
// the cron's epoch resolver. Unresolvable → throw (a record must never land in
// a guessed month).
function makePeriodMonth(epochRows) {
    if (!Array.isArray(epochRows) || !epochRows.length) throw new Error('bribe-state: epoch date table unreadable');
    const byEpoch = new Map(epochRows.map(r => [Number(r.epoch), Date.parse(r.end_time)]));
    const last = epochRows[epochRows.length - 1];
    const lastEpoch = Number(last.epoch), lastEnd = Date.parse(last.end_time);
    return (period) => {
        let t = byEpoch.get(Number(period));
        if (t == null && Number(period) > lastEpoch) t = lastEnd + (Number(period) - lastEpoch) * 7 * 864e5;
        if (t == null || !Number.isFinite(t)) throw new Error(`bribe-state: period ${period} has no epoch end date`);
        const iso = new Date(t).toISOString();
        return { yyyy: iso.slice(0, 4), mm: iso.slice(5, 7) };
    };
}

// ---- D5: the record — verbatim, zero derived fields ---------------------------
function buildRecord(period, buckets, harvestedAt) {
    return { schemaVersion: BS_SCHEMA_VERSION, period, harvested_at: harvestedAt, source: 'state-harvest', buckets };
}

// ---- D7: bribe_capture — event-derived per-period sums vs state buckets -------
function normalizeAssetId(asset) {
    if (asset == null) return null;
    if (typeof asset === 'string') return asset;
    if (asset.cw20) return `cw20:${asset.cw20}`;
    if (asset.native) return `native:${asset.native}`;
    if (asset.token?.contract_addr) return `cw20:${asset.token.contract_addr}`;
    if (asset.native_token?.denom) return `native:${asset.native_token.denom}`;
    return JSON.stringify(asset);
}
function computeBribeCapture(bribeEvents, record, epochOfTs) {
    const period = record.period;
    // state side: per-denom totals across every bucket/pool entry
    const state = new Map();
    for (const b of record.buckets || []) {
        for (const a of b.assets || []) {
            const denom = normalizeAssetId(a.info);
            if (!denom || a.amount == null) continue;
            state.set(denom, (state.get(denom) || 0) + Number(a.amount));
        }
    }
    // event side: bribe_add coins apportioned across the event's native epoch
    // range (linear — the contract's own distribution model); events without a
    // range fall back to the timestamp's epoch. This division exists ONLY for
    // the coverage metric — the streams and rollups never divide raw amounts.
    const events = new Map();
    for (const ev of bribeEvents || []) {
        if (ev.type !== 'bribe_add' || !Array.isArray(ev.coins)) continue;
        let s = ev.epoch_start != null ? Number(ev.epoch_start) : null;
        let e = ev.epoch_end != null ? Number(ev.epoch_end) : s;
        if (s == null) { const ep = epochOfTs ? epochOfTs(ev.timestamp) : null; if (ep == null) continue; s = e = ep; }
        if (e == null) e = s;
        if (period < s || period > e) continue;
        const span = Math.max(1, e - s + 1);
        for (const c of ev.coins) {
            if (!c || !c.denom || c.amount == null) continue;
            events.set(c.denom, (events.get(c.denom) || 0) + Number(c.amount) / span);
        }
    }
    const denoms = {};
    const pcts = [];
    for (const [denom, st] of [...state.entries()].sort()) {
        const evAmt = events.get(denom) || 0;
        const pct = st > 0 ? +(100 * evAmt / st).toFixed(2) : null;
        denoms[denom] = { state: String(Math.round(st)), events: String(Math.round(evAmt)), coverage_pct: pct };
        if (pct != null) pcts.push(pct);
    }
    for (const [denom, evAmt] of events.entries()) {
        if (!state.has(denom)) denoms[denom] = { state: '0', events: String(Math.round(evAmt)), coverage_pct: null, events_only: true };
    }
    const mean = pcts.length ? +(pcts.reduce((a, b) => a + b, 0) / pcts.length).toFixed(2) : null;
    return { period, denom_count: Object.keys(denoms).length, mean_coverage_pct: mean, denoms };
}

// ---- the harvest step (called from index.js run(); reads/writes injected) ----
async function forwardBribeState({ publishFile, apiGetJson, readBribeEvents, log = console }) {
    const harvestedAt = new Date().toISOString();
    const WALK_BUDGET = Number(process.env.BRIBE_WALK_BUDGET || 30);   // D2 (read per-run: mock-tunable)

    // current FINALIZED period = distributions head (one authoritative source — D3)
    const cur = await CH.fetchDistributions('current');
    if (!cur.ok) throw new Error(`period discovery failed: ${cur.error}`);
    const head = cur.period;

    const ir = await apiGetJson(`${BS_DIR}/index.json`);
    if (!ir.ok) throw new Error('bribe-state index read failed — refusing to run on unknown state');
    const idx = ir.data || {
        schemaVersion: BS_SCHEMA_VERSION, module: 'tla-voting', product: 'bribe-state',
        last_harvested_period: null, walked_down_to: null, floor_period: null, floor_certificate: null,
        months_present: {}, counts: { records: 0 }, empty_or_refused: [], known_gaps: [],
    };

    const upToDate = idx.last_harvested_period != null && idx.last_harvested_period >= head;
    const walkDone = idx.floor_period != null;
    if (upToDate && walkDone) return { skipped: true, reason: 'up to date (floor certified)', head };

    // ---- epoch-end month routing table (D4) — REQUIRED; authenticated read
    const er = await apiGetJson(EPOCH_DATES_PATH);
    if (!er.ok || !er.data) throw new Error('bribe-state: epoch date table read failed — month routing impossible');
    const periodMonth = makePeriodMonth(er.data);
    const epochOfTs = (() => {   // ts→epoch fallback for bribe_capture (D7)
        const rows = er.data.map(r => ({ epoch: Number(r.epoch), start: Date.parse(r.start_time), end: Date.parse(r.end_time) }));
        const last = rows[rows.length - 1];
        return (iso) => {
            const t = Date.parse(iso); if (!Number.isFinite(t)) return null;
            for (const r of rows) if (t >= r.start && t < r.end) return r.epoch;
            return t >= last.end ? last.epoch + Math.floor((t - last.end) / (7 * 864e5)) + 1 : null;
        };
    })();

    const records = [];                       // fresh records this run (forward + walk)
    const emptyOrRefused = Array.isArray(idx.empty_or_refused) ? [...idx.empty_or_refused] : [];
    const errors = [];

    // ---- FORWARD (D3): self-heal every period from last_harvested+1 to head.
    // A transient failure stops the forward advance AT that period (retried next
    // hour); a floor-shaped mid-history response is recorded honestly and skipped.
    let newLastHarvested = idx.last_harvested_period;
    let forwardAppended = 0;
    if (!upToDate) {
        const from = idx.last_harvested_period != null ? idx.last_harvested_period + 1 : head;  // first run: head only — the walk owns history
        for (let p = from; p <= head; p++) {
            const r = await fetchBribes(p === head ? head : p);
            if (r.ok) { records.push(buildRecord(p, r.buckets, harvestedAt)); newLastHarvested = p; forwardAppended++; }
            else if (r.floor) { emptyOrRefused.push({ period: p, error: r.error, at: harvestedAt }); newLastHarvested = p; log.warn(`  ⚠ bribe-state period ${p} floor-shaped mid-forward: ${r.error}`); }
            else { errors.push({ step: `forward:${p}`, message: r.error }); log.warn(`  ⚠ bribe-state forward stopped at period ${p} (transient): ${r.error}`); break; }
            await sleep(PACE_MS);
        }
    }

    // ---- WALK-DOWN (D2): budgeted genesis capture until the floor certifies.
    let newWalkedDownTo = idx.walked_down_to != null ? idx.walked_down_to
        : (newLastHarvested != null ? newLastHarvested : null);
    let floorPeriod = idx.floor_period ?? null;
    let floorCertificate = idx.floor_certificate ?? null;
    let walkAppended = 0;
    if (floorPeriod == null && newWalkedDownTo != null) {
        let budget = WALK_BUDGET;
        let p = newWalkedDownTo - 1;
        while (budget-- > 0 && p >= 1) {
            const r = await fetchBribes(p);
            await sleep(PACE_MS);
            if (r.ok) { records.push(buildRecord(p, r.buckets, harvestedAt)); newWalkedDownTo = p; walkAppended++; p--; continue; }
            if (!r.floor) { errors.push({ step: `walk:${p}`, message: r.error }); log.warn(`  ⚠ bribe-state walk stopped at period ${p} (transient — resumes next run): ${r.error}`); break; }
            // floor-shaped: confirm with the next FLOOR_CONFIRM-1 lower periods
            // in the SAME run (bounded extra probes — no cross-run counter state)
            const probes = [{ period: p, error: r.error }];
            let revivedAt = null, revived = null;
            for (let k = 1; k < FLOOR_CONFIRM && p - k >= 1; k++) {
                const rc = await fetchBribes(p - k);
                await sleep(PACE_MS);
                if (rc.ok) { revivedAt = p - k; revived = rc; break; }
                if (!rc.floor) { errors.push({ step: `walk-confirm:${p - k}`, message: rc.error }); break; }
                probes.push({ period: p - k, error: rc.error });
            }
            if (revivedAt != null) {
                // not the floor — record the revived period, note the gap honestly
                for (const pr of probes) emptyOrRefused.push({ ...pr, at: harvestedAt });
                records.push(buildRecord(revivedAt, revived.buckets, harvestedAt));
                newWalkedDownTo = revivedAt; walkAppended++; p = revivedAt - 1;
                continue;
            }
            if (probes.length >= Math.min(FLOOR_CONFIRM, p)) {
                floorPeriod = newWalkedDownTo;
                floorCertificate = { certifiedAt: harvestedAt, lowest_recorded_period: newWalkedDownTo, probes };
                log.log(`  bribe-state: FLOOR CERTIFIED — floor_period ${floorPeriod} (${probes.length} consecutive floor-shaped below)`);
            }
            break;   // transient inside confirm, or floor certified — either way stop
        }
    }

    if (!records.length && !floorPeriod && errors.length) {
        // nothing landed and something transient broke — surface, retry next run
        throw new Error(`bribe-state: no progress (${errors[0].step}: ${errors[0].message})`);
    }
    if (!records.length && floorPeriod === idx.floor_period && newLastHarvested === idx.last_harvested_period) {
        return { skipped: true, reason: 'nothing new', head };
    }

    // ---- publish: month files (D4) — dedup on period, never-shrink -----------
    const byMonth = {};
    for (const rec of records) {
        const { yyyy, mm } = periodMonth(rec.period);
        ((byMonth[yyyy] ||= {})[mm] ||= []).push(rec);
    }
    let allPublished = true;
    let added = 0;
    const monthsPresent = { ...(idx.months_present || {}) };
    for (const yyyy of Object.keys(byMonth).sort()) {
        for (const mm of Object.keys(byMonth[yyyy]).sort()) {
            const monthPath = `${BS_DIR}/${yyyy}/${mm}.json`;
            try {
                const mr = await apiGetJson(monthPath);
                if (!mr.ok) throw new Error('month read failed');
                const existing = mr.data || [];
                if (!Array.isArray(existing)) throw new Error('existing month file is not an array — refusing to overwrite');
                const byKey = new Map(existing.map(r => [r.period, r]));
                let monthAdded = 0;
                for (const r of byMonth[yyyy][mm]) if (!byKey.has(r.period)) { byKey.set(r.period, r); monthAdded++; }
                const merged = [...byKey.values()].sort((a, b) => a.period - b.period);
                if (merged.length < existing.length) throw new Error(`never-shrink violation: ${merged.length} < ${existing.length}`);
                if (monthAdded > 0) {
                    await publishFile(monthPath, JSON.stringify(merged), `bribe-state ${yyyy}/${mm}: +${monthAdded} (${merged.length} total)`);
                    added += monthAdded;
                    ((monthsPresent[yyyy] ||= []).includes(mm)) || monthsPresent[yyyy].push(mm);
                    monthsPresent[yyyy].sort();
                }
            } catch (e) {
                allPublished = false;
                errors.push({ step: `month:${yyyy}/${mm}`, message: String(e.message || e) });
                log.warn(`  ⚠ bribe-state month ${yyyy}/${mm} publish failed: ${e.message}`);
            }
        }
    }

    // ---- bribe_capture (D7): on forward-harvested periods only ---------------
    let bribe_capture = null;
    if (forwardAppended > 0 && readBribeEvents) {
        try {
            const evs = await readBribeEvents();
            const fwd = records.filter(r => idx.last_harvested_period == null || r.period > idx.last_harvested_period);
            const per = fwd.map(r => computeBribeCapture(evs, r, epochOfTs));
            bribe_capture = per.length === 1 ? per[0] : { periods: per };
        } catch (e) {
            bribe_capture = { unavailable: String(e.message || e) };
            log.warn(`  ⚠ bribe_capture unavailable this run: ${e.message}`);
        }
    }

    // ---- index + heartbeat: cursors advance ONLY when every publish landed ---
    const newIdx = {
        schemaVersion: BS_SCHEMA_VERSION, module: 'tla-voting', product: 'bribe-state',
        spec: 'docs/pending-changes/SPEC-tla-voting-bribe-state.md',
        updatedAt: harvestedAt,
        last_harvested_period: allPublished ? newLastHarvested : (idx.last_harvested_period ?? null),
        walked_down_to: allPublished ? newWalkedDownTo : (idx.walked_down_to ?? null),
        floor_period: allPublished ? floorPeriod : (idx.floor_period ?? null),
        floor_certificate: allPublished ? floorCertificate : (idx.floor_certificate ?? null),
        months_present: allPublished ? monthsPresent : (idx.months_present || {}),
        counts: { records: (idx.counts?.records || 0) + (allPublished ? added : 0) },
        empty_or_refused: allPublished ? emptyOrRefused : (idx.empty_or_refused || []),
        note: floorPeriod == null ? `walk-down in progress (budget ${WALK_BUDGET}/run)` : undefined,
    };
    await publishFile(`${BS_DIR}/index.json`, newIdx, `bribe-state index: head ${newIdx.last_harvested_period ?? '—'}, walked to ${newIdx.walked_down_to ?? '—'}${newIdx.floor_period != null ? `, floor ${newIdx.floor_period}` : ''}`);
    const status = allPublished && !errors.length ? 'ok' : 'partial';
    await publishFile(`${BS_DIR}/heartbeat.json`, {
        schemaVersion: BS_SCHEMA_VERSION, cron: 'tla-voting', product: 'bribe-state',
        capturedAt: harvestedAt, status,
        period_head: newIdx.last_harvested_period, walked_down_to: newIdx.walked_down_to,
        floor_period: newIdx.floor_period,
        added, forward_appended: forwardAppended, walk_appended: walkAppended,
        bribe_capture: bribe_capture || undefined,
        error_count: errors.length, recent_errors: errors.slice(-5),
    }, `bribe-state heartbeat ${status}`);

    return {
        head, added, forward_appended: forwardAppended, walk_appended: walkAppended,
        walked_down_to: newIdx.walked_down_to, floor_period: newIdx.floor_period,
        status, bribe_capture,
    };
}

module.exports = { forwardBribeState, CH, BS_DIR, BS_SCHEMA_VERSION, fetchBribes, buildRecord, makePeriodMonth, computeBribeCapture, FLOOR_CONFIRM };
