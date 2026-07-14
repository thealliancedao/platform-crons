// =============================================================================
// tla-voting / harvest-distributions.js — ONE-SHOT payout-history harvest
// =============================================================================
// SPEC-distributions-capture §2. Walks `distributions{time:{period:P}}` DOWN
// from the current finalized period until the contract floor (findFloor — the
// script PROVES genesis, never assumes it; expected ≈96-97 for the Aug-2024
// launch, but the certificate is the authority). Retained contract state, so:
// no block scanning, ~1 query/period, re-runnable, idempotent (existing
// periods are never re-fetched; a re-run over complete history is a no-op).
//
// Run:  GITHUB_TOKEN=... node harvest-distributions.js
// Env:  DIST_STORAGE_LAYOUT=single (default; 'monthly' pending register call)
//       DRY_RUN=1  → walk + report, publish nothing
// =============================================================================
'use strict';

const D = require('./lib/distributions.js');
const https = require('https');

const GITHUB_REPO   = process.env.GITHUB_REPO   || 'thealliancedao/tla-core';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
const DRY_RUN = process.env.DRY_RUN === '1';

// publish helper (same shape as org-tla-voting's; kept local so the one-shot
// has zero coupling to the forward cron's internals)
function githubApiRequest(method, apiPath, body) {
    return new Promise((resolve, reject) => {
        const opts = { hostname: 'api.github.com', path: apiPath, method, headers: { 'User-Agent': 'harvest-distributions', 'Authorization': `Bearer ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github+json' } };
        if (body) opts.headers['Content-Type'] = 'application/json';
        const req = https.request(opts, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { if (res.statusCode >= 200 && res.statusCode < 300) { try { resolve(JSON.parse(d)); } catch { resolve(d); } } else reject(new Error(`GitHub ${method}: ${res.statusCode} ${d.slice(0, 200)}`)); }); });
        req.on('error', reject); if (body) req.write(JSON.stringify(body)); req.end();
    });
}
async function publishFile(filePath, contentObj, message) {
    const content = JSON.stringify(contentObj, null, 2);
    const apiPath = `/repos/${GITHUB_REPO}/contents/${filePath}`;
    let sha = null;
    try { sha = (await githubApiRequest('GET', apiPath + `?ref=${GITHUB_BRANCH}`)).sha; } catch { /* new file */ }
    const body = { message, content: Buffer.from(content).toString('base64'), branch: GITHUB_BRANCH };
    if (sha) body.sha = sha;
    return githubApiRequest('PUT', apiPath, body);
}

async function main() {
    const startedAt = new Date();
    console.log(`\n📜 harvest-distributions — ${startedAt.toISOString()} (layout: ${D.STORAGE_LAYOUT}${DRY_RUN ? ', DRY RUN' : ''})\n`);
    if (!GITHUB_TOKEN && !DRY_RUN) throw new Error('GITHUB_TOKEN missing (set DRY_RUN=1 to walk without publishing)');

    // Current finalized period = the walk's starting head.
    const cur = await D.fetchDistributions('current');
    if (!cur.ok) throw new Error(`current-period query failed: ${cur.error}`);
    const head = cur.period;
    console.log(`  current finalized period: ${head}`);

    // Idempotency: never re-fetch committed periods.
    const prior = DRY_RUN ? null : await D.readHistory();
    const entries = (prior && Array.isArray(prior.entries)) ? prior.entries.slice() : [];
    const have = new Set(entries.map(e => e.period));
    console.log(`  committed periods already present: ${have.size}`);

    const capturedAt = startedAt.toISOString();
    const knownGaps = [];
    let floorRun = 0;                 // consecutive floor-shaped responses
    let floorCertificate = null;
    let fetched = 0;

    for (let p = head; p >= 1; p--) {
        if (have.has(p)) { floorRun = 0; continue; }
        const r = (p === head) ? cur : await D.fetchDistributions(p);
        if (r.ok) {
            entries.push(D.makeEntry(p, r.gauges, capturedAt));
            fetched++; floorRun = 0;
            if (fetched % 10 === 0) console.log(`    …period ${p} (${fetched} fetched)`);
        } else if (r.floor) {
            floorRun++;
            if (!floorCertificate) floorCertificate = { first_floor_period: p, evidence: String(r.error).slice(0, 300), probedAt: capturedAt };
            if (floorRun >= D.FLOOR_CONFIRM) {
                console.log(`  🧱 floor certified at period ${floorCertificate.first_floor_period} (${floorRun} consecutive floor responses)`);
                console.log(`     deepest valid period: ${floorCertificate.first_floor_period + 1}`);
                break;
            }
        } else {
            // transient after retries — a GAP, not the floor. Record and continue.
            knownGaps.push({ period: p, error: r.error, at: capturedAt });
            console.warn(`  ⚠ period ${p}: transient failure recorded as gap (${r.error})`);
            floorRun = 0;
        }
        await D.sleep(D.PACE_MS);
    }

    entries.sort((a, b) => a.period - b.period);
    const history = { schemaVersion: D.DIST_SCHEMA_VERSION, module: 'tla-voting', product: 'distributions', entries };
    const index = D.buildIndex(entries, { floorCertificate, knownGaps, runNote: `harvest ${capturedAt}` });

    console.log(`\n📋 harvest summary:`);
    console.log(`  periods: ${index.period_floor} → ${index.period_head}  (${index.count} entries, ${fetched} newly fetched)`);
    console.log(`  known_gaps: ${knownGaps.length}  invariant violations: ${index.invariant_violations.length}`);
    if (floorCertificate) console.log(`  floor certificate: first floor period ${floorCertificate.first_floor_period} — "${floorCertificate.evidence.slice(0, 80)}…"`);

    if (DRY_RUN) { console.log('\nDRY RUN — nothing published.'); return; }
    if (fetched === 0 && knownGaps.length === 0) { console.log('\nAlready complete — no-op (idempotent).'); return; }
    await publishFile(`${D.DIST_DIR}/history.json`, history, `distributions: harvest ${index.period_floor}→${index.period_head}`);
    await publishFile(`${D.DIST_DIR}/index.json`, index, `distributions: index (harvest)`);
    await publishFile(`${D.DIST_DIR}/heartbeat.json`, {
        schemaVersion: D.DIST_SCHEMA_VERSION, cron: 'harvest-distributions', product: 'distributions',
        capturedAt, status: knownGaps.length ? 'partial' : 'ok', period_floor: index.period_floor, period_head: index.period_head, count: index.count,
    }, 'distributions heartbeat (harvest)');
    console.log('\n✅ published: history.json, index.json, heartbeat.json');
}

main().catch(e => { console.error('fatal:', e); process.exit(1); });
