#!/usr/bin/env node
'use strict';
// =============================================================================
// org-system-health 1.0.0 — invariant monitors (SPEC-system-health, defect #10)
//
// Layer 3, chain-free. Reads ONLY committed tla-core files via the
// authenticated Contents API (raw media). REPORTS violations; never repairs
// (D4). Writes system-health/current.json + history/{YYYY}/{MM}.json
// (monthly append, never-shrink) + heartbeat.json.
//
// Invariants (D2 + audit addendum):
//   1 bucket_vp_consistency    member-data vs catalog active-pool VP sums,
//                              like-for-like = same DAY (skip + declare else)
//   2 staked_le_depth          dex-data: staked_liquidity_usd <= tvl_usd
//   3 distribution_fractions   catalog active distribution_pct sums to 1/bucket
//   4 tribute_stream_coverage  surface tla-voting bribe_capture; alarm on DROP
//   5 bucket_label_agreement   dex-data bucket vs catalog bucket per pair
//   6 heartbeat_freshness      product-appropriate signals + one-off exemption
//   7 identity_resolution      unresolved pools/tokens count (informational)
//
// Env (Render): GITHUB_TOKEN (rw tla-core), GITHUB_REPO, GITHUB_BRANCH.
// =============================================================================

const https = require('https');

const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
const GITHUB_REPO   = process.env.GITHUB_REPO   || 'thealliancedao/tla-core';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const VERSION       = 'org-system-health-1.0.1';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// --------------------------------------------------------------------------- GitHub I/O (lifted verbatim from org-tla-voting — the org standard)
function realGithubApiRequest(method, apiPath, body, accept) {
    return new Promise((resolve, reject) => {
        const opts = { hostname: 'api.github.com', path: apiPath, method, headers: { 'User-Agent': 'org-system-health', 'Authorization': `Bearer ${GITHUB_TOKEN}`, 'Accept': accept || 'application/vnd.github+json' } };
        if (body) opts.headers['Content-Type'] = 'application/json';
        const req = https.request(opts, res => { let data = ''; res.on('data', c => data += c); res.on('end', () => { if (res.statusCode >= 200 && res.statusCode < 300) { try { resolve(JSON.parse(data)); } catch { resolve(data); } } else { const err = new Error(`GitHub ${method} ${apiPath}: ${res.statusCode} ${data.slice(0, 200)}`); err.statusCode = res.statusCode; reject(err); } }); });
        req.on('error', reject); if (body) req.write(JSON.stringify(body)); req.end();
    });
}
const T = { githubApiRequest: realGithubApiRequest, now: () => new Date() };

// ALL reads via the authenticated Contents API with the raw media type —
// never the raw CDN (stale/429), never base64 content (>1MB empty).
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

// --------------------------------------------------------------------------- verdict helpers (D3)
function ok(detail, measured, expected)        { return { status: 'ok',        detail, measured: measured ?? null, expected: expected ?? null }; }
function violation(detail, measured, expected) { return { status: 'violation', detail, measured: measured ?? null, expected: expected ?? null }; }
function skipped(detail)                       { return { status: 'skipped',   detail, measured: null, expected: null }; }
const dayOf = (iso) => (iso || '').slice(0, 10);
const num   = (v) => (v === null || v === undefined) ? null : Number(v);

// --------------------------------------------------------------------------- INV 1 — bucket_vp_consistency (same-DAY like-for-like; report, don't repair)
function invBucketVpConsistency(member, catalog) {
    if (!member)  return skipped('member-data current.json absent/unreadable');
    if (!catalog) return skipped('token-catalog current.json absent/unreadable');
    const mDay = dayOf(member.meta && member.meta.generated_at);
    const cDay = dayOf(catalog.meta && catalog.meta.generated_at);
    if (!mDay || !cDay) return skipped('missing generated_at stamp on one side');
    if (mDay !== cDay)  return skipped(`stamps differ (member ${mDay} vs catalog ${cDay}) — like-for-like requires same day`);
    const perBucket = (member.system && member.system.vp_voting_per_bucket) || null;
    if (!perBucket) return skipped('member-data lacks system.vp_voting_per_bucket');
    const sums = {};
    for (const p of (catalog.pools || [])) {
        if (p.gauge_status !== 'active') continue;
        sums[p.bucket] = (sums[p.bucket] || 0) + Number(p.total_vp || 0) / 1e6;   // micro → VP
    }
    const rows = [];
    let worstPct = 0;
    for (const b of Object.keys(perBucket)) {
        const m = Number(perBucket[b] || 0), c = Math.round((sums[b] || 0) * 100) / 100;
        const diffPct = m ? Math.abs(m - c) / m * 100 : 0;
        worstPct = Math.max(worstPct, diffPct);
        rows.push({ bucket: b, member_vp: m, catalog_active_sum_vp: c, diff_pct: Math.round(diffPct * 100) / 100 });
    }
    const TOL_PCT = 0.5;
    if (worstPct > TOL_PCT)
        return violation(`bucket VP drift up to ${worstPct.toFixed(2)}% — known contributors: ghost/stray gauge votes + member/catalog tally scope differences (CHANGES_PENDING #4)`, rows, `<= ${TOL_PCT}% per bucket`);
    return ok(`all buckets within ${TOL_PCT}%`, rows, `<= ${TOL_PCT}% per bucket`);
}

// --------------------------------------------------------------------------- INV 2 — staked_le_depth (per pool, both sides present)
function invStakedLeDepth(dexSnapshots) {
    if (!dexSnapshots.length) return skipped('no dex-data snapshots readable');
    const bad = []; let checked = 0;
    for (const { id, snap } of dexSnapshots) {
        for (const p of (snap.pools || [])) {
            const tvl = num(p.tvl_usd), staked = num(p.raw && p.raw.staked_liquidity_usd);
            if (tvl === null || staked === null) continue;
            checked++;
            if (staked > tvl * 1.001)   // 0.1% float slack
                bad.push({ dex: id, pool: p.pool_name || p.pool_address, staked_usd: staked, tvl_usd: tvl });
        }
    }
    if (!checked) return skipped('no pool carried both staked and tvl values');
    if (bad.length) return violation(`${bad.length} pool(s) report staked > depth (impossible state)`, bad, 'staked_liquidity_usd <= tvl_usd');
    return ok(`${checked} pools checked, none impossible`, { pools_checked: checked }, 'staked_liquidity_usd <= tvl_usd');
}

// --------------------------------------------------------------------------- INV 3 — distribution_fractions_sum (active pools, per bucket)
function invDistributionFractions(catalog) {
    if (!catalog) return skipped('token-catalog current.json absent/unreadable');
    const sums = {};
    for (const p of (catalog.pools || [])) {
        if (p.gauge_status !== 'active') continue;
        sums[p.bucket] = (sums[p.bucket] || 0) + Number(p.distribution_pct || 0);
    }
    if (!Object.keys(sums).length) return skipped('no active pools in catalog');
    const bad = {};
    for (const [b, s] of Object.entries(sums)) if (Math.abs(s - 1.0) > 0.001) bad[b] = Math.round(s * 1e6) / 1e6;
    if (Object.keys(bad).length) return violation('active distribution fractions do not sum to 1.0', bad, '1.0 ± 0.001 per bucket');
    return ok('all buckets sum to 1.0', Object.fromEntries(Object.entries(sums).map(([b, s]) => [b, Math.round(s * 1e6) / 1e6])), '1.0 ± 0.001 per bucket');
}

// --------------------------------------------------------------------------- INV 4 — tribute_stream_coverage (consume, don't recompute; alarm on DROP)
function invTributeCoverage(votingHeartbeat, lastHistoryRun) {
    if (!votingHeartbeat) return skipped('tla-voting events heartbeat absent/unreadable');
    const cap = votingHeartbeat.bribe_capture;
    if (!cap) return skipped('bribe_capture not yet published by tla-voting (first epoch flip pending)');
    const prev = lastHistoryRun && lastHistoryRun.tribute_coverage || null;
    const drops = [];
    if (prev && cap.per_denom && prev.per_denom) {
        for (const [denom, v] of Object.entries(cap.per_denom)) {
            const was = prev.per_denom[denom];
            if (typeof was === 'number' && typeof v === 'number' && v < was - 1e-9)
                drops.push({ denom, was, now: v });
        }
    }
    if (drops.length) return violation('direct-bribe coverage DROPPED vs previous run', { drops, current: cap }, 'coverage never decreases per denom');
    return ok('coverage surfaced' + (prev ? ' (no drops vs previous run)' : ' (first observation — no baseline)'), cap, 'coverage never decreases per denom');
}

// --------------------------------------------------------------------------- INV 5 — bucket_label_agreement (dex-data vs catalog, joined on pair)
function invBucketLabelAgreement(dexSnapshots, catalog) {
    if (!catalog) return skipped('token-catalog current.json absent/unreadable');
    if (!dexSnapshots.length) return skipped('no dex-data snapshots readable');
    const catByPair = {};
    for (const p of (catalog.pools || [])) {
        const pair = p.architecture && p.architecture.pair_address;
        if (pair) catByPair[pair] = p;
    }
    const mismatches = []; let joined = 0;
    for (const { id, snap } of dexSnapshots) {
        for (const p of (snap.pools || [])) {
            if (!p.bucket) continue;                          // non-TLA pool
            const cat = catByPair[p.pool_address];
            if (!cat) continue;                               // catalog has no pair entry — INV7 territory
            joined++;
            if (cat.bucket !== p.bucket)
                mismatches.push({ dex: id, pool: p.pool_name || p.pool_address, dex_bucket: p.bucket, catalog_bucket: cat.bucket, dex_as_of: snap.meta && snap.meta.generated_at, catalog_as_of: catalog.meta && catalog.meta.generated_at });
        }
    }
    if (!joined) return skipped('no dex pool joined to a catalog pair');
    if (mismatches.length) return violation(`${mismatches.length} bucket label disagreement(s) — dex-data 1.1.0 resolves from chain; catalog entry likely stale (finding A)`, mismatches, 'dex bucket == catalog bucket per pair');
    return ok(`${joined} joined pairs agree`, { pairs_joined: joined }, 'dex bucket == catalog bucket per pair');
}

// --------------------------------------------------------------------------- INV 6 — heartbeat_freshness (product-appropriate signals; addendum)
// kind: 'cron' (heartbeat ts vs max_age_h) | 'day-key' (latest day in current
// month file) | 'one-off' (exempt, reported informationally).
const FRESHNESS_MAP = [
    { product: 'member-data',        kind: 'cron',    path: 'member-data/snapshots/heartbeat.json',        ts: ['generated_at', 'capturedAt'], max_age_h: 30 },
    { product: 'token-catalog',      kind: 'cron',    path: 'token-catalog/snapshots/heartbeat.json',      ts: ['capturedAt', 'generated_at'], max_age_h: 6 },
    { product: 'dex-astroport',      kind: 'cron',    path: 'dex-data/astroport/snapshots/heartbeat.json', ts: ['generated_at', 'capturedAt'], max_age_h: 6 },
    { product: 'dex-skeletonswap',   kind: 'cron',    path: 'dex-data/skeletonswap/snapshots/heartbeat.json', ts: ['generated_at', 'capturedAt'], max_age_h: 6 },
    { product: 'tla-voting',         kind: 'cron',    path: 'tla-voting/events/heartbeat.json',            ts: ['capturedAt'],                max_age_h: 6 },
    { product: 'tla-voting-votestate', kind: 'cron',  path: 'tla-voting/vote-state/heartbeat.json',        ts: ['capturedAt'],                max_age_h: 216 },
    { product: 'tla-voting-bribestate', kind: 'cron', path: 'tla-voting/bribe-state/heartbeat.json',       ts: ['capturedAt'],                max_age_h: 216 },
    { product: 'tla-distributions',  kind: 'cron',    path: 'tla-voting/distributions/heartbeat.json',     ts: ['capturedAt'],                max_age_h: 216 },
    { product: 'nfts-snapshots',     kind: 'cron',    path: 'nfts/adao/snapshots/heartbeat.json',          ts: ['capturedAt'],                max_age_h: 6 },
    { product: 'nfts-flows',         kind: 'cron',    path: 'nfts/adao/flows/heartbeat.json',              ts: ['capturedAt'],                max_age_h: 6 },
    { product: 'nfts-provenance',    kind: 'one-off', path: 'nfts/adao/provenance/heartbeat.json',         ts: ['ran_at'] },
    { product: 'dex-credia',         kind: 'cron',    path: 'dex-data/credia/snapshots/heartbeat.json',   ts: ['generated_at', 'capturedAt'], max_age_h: 6 },
    { product: 'votion-vaults',      kind: 'cron',    path: 'votion/heartbeat.json',                       ts: ['vaults_at', 'capturedAt'],   max_age_h: 6 },
    { product: 'votion-positions',   kind: 'cron',    path: 'votion/heartbeat.json',                       ts: ['positions_at'],              max_age_h: 30 },
    { product: 'price-history',      kind: 'day-key', pathFn: (now) => `price-history/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}.json`, max_age_h: 50 },
];
function firstTs(obj, fields) { for (const f of fields || []) if (obj && obj[f]) return obj[f]; return null; }
async function invHeartbeatFreshness(reader, now) {
    const rows = []; const stale = [];
    for (const spec of FRESHNESS_MAP) {
        const path = spec.pathFn ? spec.pathFn(now) : spec.path;
        const r = await reader(path);
        if (!r.ok)        { rows.push({ product: spec.product, status: 'unreadable' }); stale.push({ product: spec.product, reason: 'read failed (not 404)' }); continue; }
        if (!r.data)      { rows.push({ product: spec.product, status: 'absent' });     stale.push({ product: spec.product, reason: 'file absent' }); continue; }
        let ts = null;
        if (spec.kind === 'day-key') {
            const days = r.data.days ? Object.keys(r.data.days).sort() : [];
            ts = days.length ? days[days.length - 1] + 'T00:00:00Z' : null;
        } else {
            ts = firstTs(r.data, spec.ts);
        }
        if (!ts) { rows.push({ product: spec.product, status: 'no timestamp' }); stale.push({ product: spec.product, reason: 'no usable timestamp field' }); continue; }
        const ageH = Math.round((now.getTime() - new Date(ts).getTime()) / 36e5 * 10) / 10;
        if (spec.kind === 'one-off') { rows.push({ product: spec.product, status: 'exempt (one-off)', last: ts, age_h: ageH }); continue; }
        const fresh = ageH <= spec.max_age_h;
        rows.push({ product: spec.product, status: fresh ? 'fresh' : 'STALE', last: ts, age_h: ageH, max_age_h: spec.max_age_h });
        if (!fresh) stale.push({ product: spec.product, age_h: ageH, max_age_h: spec.max_age_h });
    }
    if (stale.length) return violation(`${stale.length} product(s) stale/absent`, { stale, all: rows }, 'age <= per-product max_age_h');
    return ok('all products fresh (one-offs exempt)', rows, 'age <= per-product max_age_h');
}

// --------------------------------------------------------------------------- INV 7 — identity_resolution (informational, tracked)
function invIdentityResolution(catalog) {
    if (!catalog) return skipped('token-catalog current.json absent/unreadable');
    const unresolvedPools = (catalog.pools || []).filter(p => !p.architecture && !(p.underlyings && p.underlyings.length))
        .map(p => p.gauge_pool_id || p.lp_address);
    const tokens = catalog.tokens || [];
    const tokenList = Array.isArray(tokens) ? tokens : Object.entries(tokens).map(([k, v]) => ({ denom: k, ...v }));
    const idOf = (t) => (t.discovered && (t.discovered.symbol || t.discovered.display_name)) || t.symbol || t.name || null;
    const unnamedTokens = tokenList.filter(t => !idOf(t)).map(t => t.denom || t.address || t.id).slice(0, 25);
    const stats = catalog.identity_stats || null;   // catalog's own accounting — cross-check
    return ok('identity resolution tracked (a shrinking number)', {
        unresolved_pools: unresolvedPools.length, unresolved_pool_ids: unresolvedPools,
        tokens_without_identity: unnamedTokens.length, sample: unnamedTokens.slice(0, 8),
        catalog_identity_stats: stats ? { symbols_resolved: stats.symbols_resolved, total_tokens: stats.total_tokens } : null,
    }, 'informational — trend toward zero');
}

// --------------------------------------------------------------------------- history append (monthly, never-shrink)
async function appendHistory(now, runSummary) {
    const path = `system-health/history/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}.json`;
    const r = await apiGetJson(path);
    if (!r.ok) throw new Error(`history read failed for ${path} — refusing to write blind`);
    const doc = r.data || { meta: { module: 'system-health', format_version: 1 }, runs: [] };
    const before = doc.runs.length;
    doc.runs.push(runSummary);
    if (doc.runs.length !== before + 1) throw new Error('never-shrink violated — aborting');
    doc.meta.updated_at = now.toISOString();
    await publishFile(path, doc, `system-health: run ${now.toISOString()} (${runSummary.status})`);
    return { path, runs: doc.runs.length };
}

// --------------------------------------------------------------------------- main
async function run() {
    const now = T.now();
    console.log(`${VERSION} @ ${now.toISOString()} → ${GITHUB_REPO}#${GITHUB_BRANCH}`);
    if (!GITHUB_TOKEN && T.githubApiRequest === realGithubApiRequest) throw new Error('GITHUB_TOKEN missing — refusing to run.');

    // ---- D1 inputs (each read wrapped; absence/failure → per-invariant skip)
    const member  = (await apiGetJson('member-data/snapshots/current.json')).data;
    const catalog = (await apiGetJson('token-catalog/snapshots/current.json')).data;
    const dexIdx  = (await apiGetJson('dex-data/index.json')).data;
    const dexIds  = ((dexIdx && dexIdx.dexes) || [{ id: 'astroport' }, { id: 'skeletonswap' }]).filter(d => d.enabled !== false).map(d => d.id);
    const dexSnapshots = [];
    for (const id of dexIds) {
        const s = (await apiGetJson(`dex-data/${id}/snapshots/current.json`)).data;
        if (s) dexSnapshots.push({ id, snap: s });
    }
    const votingHb = (await apiGetJson('tla-voting/events/heartbeat.json')).data;

    // previous run (for the INV4 drop alarm): last entry of current month, else previous month
    let lastRun = null;
    {
        const cur = await apiGetJson(`system-health/history/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}.json`);
        if (cur.data && cur.data.runs && cur.data.runs.length) lastRun = cur.data.runs[cur.data.runs.length - 1];
        else {
            const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
            const p = await apiGetJson(`system-health/history/${prev.getUTCFullYear()}/${String(prev.getUTCMonth() + 1).padStart(2, '0')}.json`);
            if (p.data && p.data.runs && p.data.runs.length) lastRun = p.data.runs[p.data.runs.length - 1];
        }
    }

    // ---- run the seven
    const invariants = {
        bucket_vp_consistency:      invBucketVpConsistency(member, catalog),
        staked_le_depth:            invStakedLeDepth(dexSnapshots),
        distribution_fractions_sum: invDistributionFractions(catalog),
        tribute_stream_coverage:    invTributeCoverage(votingHb, lastRun),
        bucket_label_agreement:     invBucketLabelAgreement(dexSnapshots, catalog),
        heartbeat_freshness:        await invHeartbeatFreshness(apiGetJson, now),
        identity_resolution:        invIdentityResolution(catalog),
    };
    for (const inv of Object.values(invariants)) inv.as_of = now.toISOString();

    const rank = { violation: 2, skipped: 1, ok: 0 };
    const worst = Object.values(invariants).reduce((w, v) => rank[v.status] > rank[w] ? v.status : w, 'ok');
    const current = { meta: { version: VERSION, generated_at: now.toISOString(), status: worst }, invariants };

    for (const [k, v] of Object.entries(invariants)) console.log(`  ${v.status === 'ok' ? '✓' : v.status === 'skipped' ? '~' : '✗'} ${k}: ${v.status} — ${v.detail}`);
    console.log(`  overall: ${worst}`);

    // ---- publish
    await publishFile('system-health/current.json', current, `system-health: ${worst} @ ${now.toISOString()}`);
    const runSummary = {
        as_of: now.toISOString(), status: worst,
        by_invariant: Object.fromEntries(Object.entries(invariants).map(([k, v]) => [k, v.status])),
        tribute_coverage: (votingHb && votingHb.bribe_capture) || null,   // baseline for the next drop check
    };
    const h = await appendHistory(now, runSummary);
    await publishFile('system-health/heartbeat.json', { version: VERSION, capturedAt: now.toISOString(), status: worst, history_runs: h.runs }, `system-health heartbeat`);
    console.log(`  committed current.json + ${h.path} (${h.runs} runs) + heartbeat`);
    return current;
}

module.exports = { run, T, apiGetJson, publishFile, invBucketVpConsistency, invStakedLeDepth, invDistributionFractions, invTributeCoverage, invBucketLabelAgreement, invHeartbeatFreshness, invIdentityResolution, FRESHNESS_MAP };
if (require.main === module) run().then(() => process.exit(0)).catch(e => { console.error('FATAL:', e.message); process.exit(1); });
