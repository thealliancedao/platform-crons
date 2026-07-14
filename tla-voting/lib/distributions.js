// =============================================================================
// tla-voting / lib / distributions.js — gauge distributions capture core
// =============================================================================
// SPEC-distributions-capture (approved 2026-07-13). Shared by BOTH the one-shot
// harvester (harvest-distributions.js) and the forward step in index.js — one
// implementation, zero drift.
//
// WHAT: `distributions{time:{period:P}}` on the asset gauge returns, for all 4
// gauges in one call, the FINALIZED payout split for period P:
//   [{gauge, period, total_gauge_vp, assets:[{asset, distribution, total_vp}]}]
// Probe-confirmed (2026-07-13/14): retained contract state — period 120 (deep
// inside the events dead zone) answers from a normal public LCD. This is the
// payout ledger + de-facto whitelist + canonical per-pool VP/pct history.
//
// EPOCH MECHANICS (chain-confirmed): votes during epoch N tally live in
// gauge_infos(time:"next"); at the flip they freeze into distributions(period
// N); rewards for N pay during N+1. `distributions{time:"current"}` returns
// the latest FINALIZED period. Contract `period` == UI epoch number.
//
// RULES CARRIED (from the register / bug ledger):
//   • hard-deadline transport (flows 1.0.2): overall deadline, NOT idle timeout
//   • state reads via authenticated API with vnd.github.raw (2.1.0 + 2.1.1):
//     never the raw CDN, never Contents-API base64 (>1MB returns empty)
//   • findFloor discovers genesis — never assume it (expected ≈96-97; proven,
//     not presumed). Floor certificate records the evidence.
//   • mid-range failure ≠ floor: network failures after retries → known_gaps
//     entry, walk continues; only contract-level refusal / empty-state runs
//     of FLOOR_CONFIRM consecutive periods end the walk.
//   • invariant: per-gauge distribution fractions sum to 1 ± 1e-9; a violation
//     marks the entry (never silently dropped) and is surfaced in the index.
// =============================================================================
'use strict';

const https = require('https');
const C = require('../../config/contracts.js');

const LCD_PRIMARY  = process.env.LCD_PRIMARY  || 'https://terra-lcd.publicnode.com';
const LCD_FALLBACK = process.env.LCD_FALLBACK || 'https://terra-rest.publicnode.com';
const GITHUB_REPO   = process.env.GITHUB_REPO   || 'thealliancedao/tla-core';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;

const GAUGE_CONTROLLER = C.GAUGE_CONTROLLER.addr;
const DIST_DIR = 'tla-voting/distributions';
const DIST_SCHEMA_VERSION = 1;
// STORAGE LAYOUT — 'single' per SPEC-distributions-capture §3 + the pending
// Deviation Register row (TLA-CORE-STORAGE-DESIGN §7). Flip to 'monthly' only
// with a register update.
const STORAGE_LAYOUT = process.env.DIST_STORAGE_LAYOUT || 'single';
const FLOOR_CONFIRM = 3;      // consecutive floor-shaped responses to certify
const FETCH_RETRIES = 3;      // attempts per period (alternating LCDs inside)
const PACE_MS = 150;          // gentle pacing between period fetches

// <<DISTRIBUTIONS CORE v1>> — byte-identical in tla-core/.github/scripts/tla-voting/harvest-distributions.js. Diff-verify the marked block after ANY change (same rule as <<FLOWS CLASSIFIER v1>>).
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---- transport: HARD deadline (flows 1.0.2 port). r.setTimeout is an IDLE
// timeout (resets on every byte — a tarpit hangs the run); this destroys the
// request when the wall clock says so, regardless of trickling data.
function httpGetHard(url, deadlineMs = 40000) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { headers: { Accept: 'application/json', 'User-Agent': 'org-tla-voting-distributions/1.0' } }, (res) => {
            let b = '';
            res.on('data', c => b += c);
            res.on('end', () => {
                clearTimeout(killer);
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    try { resolve(JSON.parse(b)); } catch { reject(new Error('bad JSON')); }
                } else {
                    const err = new Error(`HTTP ${res.statusCode} ${b.slice(0, 200)}`);
                    err.statusCode = res.statusCode; err.body = b.slice(0, 300);
                    reject(err);
                }
            });
        });
        const killer = setTimeout(() => req.destroy(new Error(`deadline ${deadlineMs}ms`)), deadlineMs);
        req.on('error', (e) => { clearTimeout(killer); reject(e); });
    });
}

function smartPath(addr, queryObj) {
    const b64 = Buffer.from(JSON.stringify(queryObj)).toString('base64');
    return `/cosmwasm/wasm/v1/contract/${addr}/smart/${encodeURIComponent(b64)}`;
}

// Query one period ('current' or a number). Distinguishes three outcomes:
//   {ok:true, period, gauges}           — data
//   {ok:false, floor:true, error}       — contract-level refusal or empty state
//   {ok:false, floor:false, error}      — network/transient (after retries)
async function fetchDistributions(periodOrCurrent) {
    const q = { distributions: { time: periodOrCurrent === 'current' ? 'current' : { period: periodOrCurrent } } };
    let lastErr = null;
    for (let attempt = 0; attempt < FETCH_RETRIES; attempt++) {
        const base = attempt % 2 === 0 ? LCD_PRIMARY : LCD_FALLBACK;
        try {
            const res = await httpGetHard(base + smartPath(GAUGE_CONTROLLER, q));
            const gauges = res?.data;
            if (!Array.isArray(gauges)) return { ok: false, floor: false, error: 'unexpected shape (data not array)' };
            const allEmpty = gauges.length === 0 || gauges.every(g => !Array.isArray(g.assets) || g.assets.length === 0);
            if (allEmpty) return { ok: false, floor: true, error: 'empty distributions (pre-genesis state)' };
            const period = Math.max(...gauges.map(g => Number(g.period) || 0));
            return { ok: true, period, gauges };
        } catch (e) {
            lastErr = e;
            // Contract-level refusal (query parse / state errors) arrives as HTTP
            // 4xx/5xx WITH a cosmwasm error body — that's floor-shaped, not transient.
            if (e.statusCode && e.body && /ve3_shared|query wasm contract failed|not found|Generic error/i.test(e.body)) {
                return { ok: false, floor: true, error: e.body };
            }
            await sleep(250 * (attempt + 1)); // transient — back off and alternate LCD
        }
    }
    return { ok: false, floor: false, error: String(lastErr && lastErr.message || lastErr) };
}

// ---- committed-state reads: authenticated API + raw media type (2.1.0/2.1.1)
function ghRaw(path) {
    return new Promise((resolve, reject) => {
        const opts = {
            hostname: 'api.github.com',
            path: `/repos/${GITHUB_REPO}/contents/${path}?ref=${GITHUB_BRANCH}`,
            method: 'GET',
            headers: { 'User-Agent': 'org-tla-voting-distributions', 'Authorization': `Bearer ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github.raw' },
        };
        const req = https.request(opts, res => {
            let d = ''; res.on('data', c => d += c);
            res.on('end', () => {
                if (res.statusCode === 404) return resolve(null);
                if (res.statusCode >= 200 && res.statusCode < 300) { try { resolve(JSON.parse(d)); } catch { reject(new Error('bad JSON from API raw read')); } }
                else reject(new Error(`GitHub raw read ${path}: ${res.statusCode} ${d.slice(0, 150)}`));
            });
        });
        req.on('error', reject); req.end();
    });
}
const readHistory = () => ghRaw(`${DIST_DIR}/history.json`);
const readIndex   = () => ghRaw(`${DIST_DIR}/index.json`);

// ---- invariant: fractions per gauge sum to 1 ± 1e-9
function checkInvariant(entry) {
    const violations = [];
    for (const g of entry.gauges) {
        if (!Array.isArray(g.assets) || g.assets.length === 0) continue;
        const sum = g.assets.reduce((s, a) => s + parseFloat(a.distribution || 0), 0);
        if (Math.abs(sum - 1) > 1e-9) violations.push({ gauge: g.gauge, sum });
    }
    return violations;
}

function makeEntry(period, gauges, capturedAt) {
    const entry = { period, capturedAt, gauges };
    const violations = checkInvariant(entry);
    if (violations.length) entry._invariant_violations = violations; // marked, never dropped
    return entry;
}

function buildIndex(entries, { floorCertificate, knownGaps, runNote }) {
    const periods = entries.map(e => e.period);
    const withViolations = entries.filter(e => e._invariant_violations).map(e => e.period);
    return {
        schemaVersion: DIST_SCHEMA_VERSION,
        module: 'tla-voting', product: 'distributions',
        storage_layout: STORAGE_LAYOUT,
        generatedAt: new Date().toISOString(),
        count: entries.length,
        period_floor: periods.length ? Math.min(...periods) : null,
        period_head: periods.length ? Math.max(...periods) : null,
        known_gaps: knownGaps.length ? knownGaps : [],
        invariant_violations: withViolations.length ? withViolations : [],
        floor_certificate: floorCertificate || null,
        note: runNote || undefined,
    };
}

// <<DISTRIBUTIONS CORE v1 END>>

// ---- forward capture (index.js §4): self-healing — verify committed head ==
// current finalized period; backfill anything missing in between. Lateness is
// free (retained state), so a missed boundary heals on the next run.
async function forwardDistributions({ publishFile, log = console }) {
    const idx = await readIndex();
    const cur = await fetchDistributions('current');
    if (!cur.ok) throw new Error(`distributions current query failed: ${cur.error}`);
    const head = cur.period;
    const committedHead = idx?.period_head ?? null;
    if (committedHead === null) {
        // Forward NEVER seeds (2.1.0 doctrine) — an empty module means the
        // harvest hasn't run (or state read failed). Report, don't invent.
        return { skipped: true, reason: 'no committed index — run harvest-distributions first (forward never seeds)', head };
    }
    if (committedHead >= head) return { skipped: true, reason: 'up to date', head, appended: 0 };

    const history = await readHistory();
    if (!history || !Array.isArray(history.entries)) throw new Error('index present but history.json unreadable — refusing to publish over unknown state');
    const have = new Set(history.entries.map(e => e.period));
    const capturedAt = new Date().toISOString();
    const knownGaps = (idx.known_gaps || []).slice();
    let appended = 0;
    for (let p = committedHead + 1; p <= head; p++) {
        if (have.has(p)) continue;
        const r = (p === head) ? cur : await fetchDistributions(p);
        if (r.ok) { history.entries.push(makeEntry(p, r.gauges, capturedAt)); appended++; }
        else { knownGaps.push({ period: p, error: r.error, at: capturedAt }); log.warn(`  ⚠ distributions period ${p} failed: ${r.error}`); }
        await sleep(PACE_MS);
    }
    if (!appended && knownGaps.length === (idx.known_gaps || []).length) return { skipped: true, reason: 'nothing new', head, appended: 0 };
    history.entries.sort((a, b) => a.period - b.period);
    const newIndex = buildIndex(history.entries, { floorCertificate: idx.floor_certificate, knownGaps, runNote: `forward append to ${head}` });
    await publishFile(`${DIST_DIR}/history.json`, history, `distributions: forward append → period ${head}`);
    await publishFile(`${DIST_DIR}/index.json`, newIndex, `distributions: index → period ${head}`);
    await publishFile(`${DIST_DIR}/heartbeat.json`, {
        schemaVersion: DIST_SCHEMA_VERSION, cron: 'tla-voting', product: 'distributions',
        capturedAt, status: knownGaps.length > (idx.known_gaps || []).length ? 'partial' : 'ok',
        period_head: head, appended,
    }, `distributions heartbeat`);
    return { appended, head };
}

module.exports = {
    DIST_DIR, DIST_SCHEMA_VERSION, STORAGE_LAYOUT, FLOOR_CONFIRM, PACE_MS,
    httpGetHard, fetchDistributions, readHistory, readIndex,
    checkInvariant, makeEntry, buildIndex, forwardDistributions, sleep,
};
