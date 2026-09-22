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
//   8 nft_listings_reconcile   per collection (tenants.json): listings open per the event ledger == inventory listings
//                              from contract state, per venue and per token; a difference younger than the two products'
//                              lag is 'recent_unconfirmed', never a violation (1.0.9)
//
// Env (Render): GITHUB_TOKEN (rw tla-core), GITHUB_REPO, GITHUB_BRANCH.
// =============================================================================

const https = require('https');

const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
const GITHUB_REPO   = process.env.GITHUB_REPO   || 'thealliancedao/tla-core';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const VERSION       = 'org-system-health-1.0.11';   // 1.0.11 (2026-09-22): org-ally-holders-liondao registered (daily, heartbeat lion-dao/holders-heartbeat.json) · 1.0.10 (2026-09-21): org-ally-positions-liondao registered (hourly :20, heartbeat in dao-originations/lion-dao/positions/; carries its own status + errors count) · 1.0.9 (2026-09-19, owner): INV 8 nft_listings_reconcile — per collection, listings OPEN per the chain-event ledger == listings the inventory reads from contract state, per venue and per token (the PL #2124 gap: a chain-only BBL listing the state read could not see); + PL inventory freshness row · 1.0.8 (2026-09-14): price-history WRITER heartbeat row (token-catalog now writes price-history/heartbeat.json each run; B.5) · 1.0.7 (2026-09-14): a FRESH heartbeat whose own `status` is failed/error is a violation (tla-locks failed every run for 13 h on 2026-09-13 behind a green freshness row) · 1.0.6 (2026-09-13): the three aDAO product heartbeats read from nft-collections/adao/ (migration) · 1.0.5 (2026-09-12): freshness rows may name their repo — the three nft-collections ledger crons registered

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
async function apiGetJson(repoPath, repo = GITHUB_REPO) {   // 1.0.5: `repo` — a product that lives outside tla-core (nft-collections) names its repo
    try {
        const d = await T.githubApiRequest('GET', `/repos/${repo}/contents/${repoPath}?ref=${GITHUB_BRANCH}`, null, 'application/vnd.github.raw');
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
// 1.0.7: age is not health. A cron that crashes still writes its heartbeat
// (nft-flows FATAL → status 'failed'; tla-flows/tla-voting priors refusal →
// 'error'), so a fresh timestamp can sit on a dead job. Every row now carries
// the heartbeat's own `status` (hb_status), and failed/error is stale-
// equivalent. 'partial'/'degraded' (run completed with issues) are surfaced in
// the row, not raised — the fleet uses those for recoverable, retried work.
const FAILED_STATUSES = new Set(['failed', 'error']);
const FRESHNESS_MAP = [
    { product: 'member-data',        kind: 'cron',    path: 'member-data/snapshots/heartbeat.json',        ts: ['generated_at', 'capturedAt'], max_age_h: 30 },
    { product: 'token-catalog',      kind: 'cron',    path: 'token-catalog/snapshots/heartbeat.json',      ts: ['capturedAt', 'generated_at'], max_age_h: 6 },
    { product: 'dex-astroport',      kind: 'cron',    path: 'dex-data/astroport/snapshots/heartbeat.json', ts: ['generated_at', 'capturedAt'], max_age_h: 6 },
    { product: 'dex-skeletonswap',   kind: 'cron',    path: 'dex-data/skeletonswap/snapshots/heartbeat.json', ts: ['generated_at', 'capturedAt'], max_age_h: 6 },
    // 2026-08-10 (strip step 3, same paste as the legacy dex kills): the two
    // FOLD series heartbeats — these products are what the site now READS
    // (tla-stats/index repoint Rev 3.1/3.71), so they get their own rows.
    { product: 'dex-astroport-series',    kind: 'cron', path: 'dex-data/astroport/epochs/heartbeat.json',    ts: ['capturedAt'],                max_age_h: 6 },
    { product: 'dex-skeletonswap-series', kind: 'cron', path: 'dex-data/skeletonswap/rolling/heartbeat.json', ts: ['capturedAt'],               max_age_h: 6 },
    { product: 'tla-voting',         kind: 'cron',    path: 'tla-voting/events/heartbeat.json',            ts: ['capturedAt'],                max_age_h: 6 },
    { product: 'tla-voting-votestate', kind: 'cron',  path: 'tla-voting/vote-state/heartbeat.json',        ts: ['capturedAt'],                max_age_h: 216 },
    { product: 'tla-voting-bribestate', kind: 'cron', path: 'tla-voting/bribe-state/heartbeat.json',       ts: ['capturedAt'],                max_age_h: 216 },
    { product: 'tla-distributions',  kind: 'cron',    path: 'tla-voting/distributions/heartbeat.json',     ts: ['capturedAt'],                max_age_h: 216 },
    // 2026-09-13 aDAO migration: these three products moved to nft-collections/adao/ (tla-core/nfts/adao is gone)
    { product: 'nfts-snapshots',     kind: 'cron',    repo: 'thealliancedao/nft-collections', path: 'adao/snapshots/heartbeat.json',  ts: ['capturedAt'], max_age_h: 6 },
    { product: 'nfts-flows',         kind: 'cron',    repo: 'thealliancedao/nft-collections', path: 'adao/flows/heartbeat.json',      ts: ['capturedAt'], max_age_h: 6 },
    { product: 'nfts-provenance',    kind: 'one-off', repo: 'thealliancedao/nft-collections', path: 'adao/provenance/heartbeat.json', ts: ['ran_at'] },
    { product: 'dex-credia',         kind: 'cron',    path: 'dex-data/credia/snapshots/heartbeat.json',   ts: ['generated_at', 'capturedAt'], max_age_h: 6 },
    { product: 'votion-vaults',      kind: 'cron',    path: 'votion/heartbeat.json',                       ts: ['vaults_at', 'capturedAt'],   max_age_h: 6 },
    { product: 'votion-positions',   kind: 'cron',    path: 'votion/heartbeat.json',                       ts: ['positions_at'],              max_age_h: 30 },
    { product: 'price-history',      kind: 'day-key', pathFn: (now) => `price-history/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}.json`, max_age_h: 50 },
    // 1.0.8 (B.5): the WRITER's heartbeat — org-token-catalog appends the daily row every run (~6 h) and now writes this
    // file with its own status; a swallowed append failure lands here as status 'failed' within the hour instead of
    // surfacing as a stale day key 50 h later. The day-key row above stays: it is the data's own freshness truth.
    { product: 'price-history-writer', kind: 'cron', path: 'price-history/heartbeat.json',                ts: ['capturedAt'],                max_age_h: 12 },
    // 2026-08-24 (capa-supply v2): the CAPA custody map rides org-token-catalog
    // (~5h observed cadence) but is its own product — its own row, read from
    // the product itself (it carries capturedAt; no separate heartbeat).
    { product: 'capa-supply',        kind: 'cron',    path: 'token-catalog/supply/capa/current.json',     ts: ['capturedAt'],                max_age_h: 12 },
    { product: 'fuel-supply',        kind: 'cron',    path: 'token-catalog/supply/fuel/current.json',     ts: ['capturedAt'],                max_age_h: 12 },   // 2026-08-24: Boost DAO (Neutron) + Terra IBC map
    // 2026-09-12 (NFT ledger milestone): one Render service per collection (org-nft-flows-<slug>, hourly, platform-crons/
    // nfts/nft-flows) publishing into thealliancedao/nft-collections/<slug>/ — `repo` names where the heartbeat lives.
    { product: 'nft-inventory-pixel-lions', kind: 'cron', repo: 'thealliancedao/nft-collections', path: 'pixel-lions/snapshots/heartbeat.json', ts: ['capturedAt'], max_age_h: 6 },   // 1.0.9: org-nft-inventory-liondao (run-ally, 15-min)
    { product: 'nft-ledger-adao',        kind: 'cron', repo: 'thealliancedao/nft-collections', path: 'adao/nft-flows/heartbeat.json',        ts: ['ran_at'], max_age_h: 6 },
    { product: 'nft-ledger-pixel-lions', kind: 'cron', repo: 'thealliancedao/nft-collections', path: 'pixel-lions/nft-flows/heartbeat.json', ts: ['ran_at'], max_age_h: 6 },
    { product: 'nft-ledger-tla-locks',   kind: 'cron', repo: 'thealliancedao/nft-collections', path: 'tla-locks/nft-flows/heartbeat.json',   ts: ['ran_at'], max_age_h: 6 },
    // 2026-09-21 (Lion DAO positions): the tenant-keyed positions engine (platform-crons/ally-positions, one Render
    // service per ally, TENANT=<ally>) publishes into thealliancedao/dao-originations/<ally>/positions/. Its heartbeat
    // carries status ok|failed + errors — the 1.0.7 fresh-but-failed rule applies unchanged.
    { product: 'ally-positions-liondao', kind: 'cron', repo: 'thealliancedao/dao-originations', path: 'lion-dao/positions/heartbeat.json', ts: ['capturedAt'], max_age_h: 6 },
    // 1.0.11 (2026-09-22): the holder products (ally-positions/holders.js — a duty of org-ally-positions-liondao since index.js 1.2.2,
    // run when ≥20 h old): pyROAR ledger walked whole + ROAR20 owners via Helius; heartbeat carries status ok|ok_with_errors|failed.
    { product: 'ally-holders-liondao', kind: 'cron', repo: 'thealliancedao/dao-originations', path: 'lion-dao/holders-heartbeat.json', ts: ['capturedAt'], max_age_h: 30 },
];
function firstTs(obj, fields) { for (const f of fields || []) if (obj && obj[f]) return obj[f]; return null; }
async function invHeartbeatFreshness(reader, now) {
    const rows = []; const stale = [];
    for (const spec of FRESHNESS_MAP) {
        const path = spec.pathFn ? spec.pathFn(now) : spec.path;
        const r = spec.repo ? await reader(path, spec.repo) : await reader(path);
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
        const hbStatus = spec.kind === 'day-key' ? null : (typeof r.data.status === 'string' ? r.data.status.toLowerCase() : null);
        if (spec.kind === 'one-off') { rows.push({ product: spec.product, status: 'exempt (one-off)', hb_status: hbStatus, last: ts, age_h: ageH }); continue; }
        const fresh  = ageH <= spec.max_age_h;
        const failed = hbStatus !== null && FAILED_STATUSES.has(hbStatus);
        rows.push({ product: spec.product, status: failed ? 'FAILED' : fresh ? 'fresh' : 'STALE', hb_status: hbStatus, last: ts, age_h: ageH, max_age_h: spec.max_age_h });
        if (failed)      stale.push({ product: spec.product, reason: `heartbeat status ${hbStatus}${fresh ? ' (fresh — job ran and failed)' : ''}`, hb_status: hbStatus, age_h: ageH, max_age_h: spec.max_age_h });
        else if (!fresh) stale.push({ product: spec.product, age_h: ageH, max_age_h: spec.max_age_h });
    }
    if (stale.length) return violation(`${stale.length} product(s) stale/absent/failed`, { stale, all: rows }, 'age <= per-product max_age_h and heartbeat status not failed/error');
    return ok('all products fresh and not failed (one-offs exempt)', rows, 'age <= per-product max_age_h and heartbeat status not failed/error');
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


// --------------------------------------------------------------------------- INV 8 — nft_listings_reconcile (1.0.9, owner 2026-09-19)
// Two products answer "what is listed": the event LEDGER (org-nft-flows, every list/delist/sale/transfer on chain, hourly)
// and the INVENTORY (org-nft-inventory, contract state every 15 min: cw721 owner + the venues' auction/listing queries).
// They must agree per venue and per token. When they do not, one of them is blind — the September case: BBL's
// auction_by_contract shows 30 rows and its cursor never advances, so a chain-only auction the ledger had seen listed (PL
// #2124) was invisible to the state read until D.2 completed it from ownership. This invariant keeps that class of gap loud.
// Fold rule (the ledger side): `list` opens a token's listing on its venue; `delist`, `sale`, `venue_out`, `transfer` close
// it (the token leaves the venue). Superseded rows never count. One month in memory at a time (read → fold → drop).
// Lag rule: the ledger runs hourly, the inventory every 15 min, and a listing placed or closed inside that window is on
// one side only — those are reported as recent_unconfirmed (with the timestamp that proves it), never as a violation.
const LISTING_OPEN = new Set(['list']), LISTING_CLOSE = new Set(['delist', 'sale', 'venue_out', 'transfer']);
const NFTC_REPO = 'thealliancedao/nft-collections';
async function invNftListingsReconcile(reader, now, opts = {}) {
    const tenants = (await reader('docs/curated/tenants.json')).data;
    if (!tenants || !tenants.tenants) return skipped('docs/curated/tenants.json absent/unreadable — no collection list');
    const slugs = [...new Set(Object.values(tenants.tenants).flatMap(t => t.collections || []))];
    if (!slugs.length) return skipped('tenants.json names no collections');
    const per = {}; const problems = []; let compared = 0;
    for (const slug of slugs) {
        const ix = (await reader(`${slug}/ledger/index.json`, NFTC_REPO)).data;
        const hb = (await reader(`${slug}/nft-flows/heartbeat.json`, NFTC_REPO)).data;
        const nfts = (await reader(`${slug}/snapshots/nfts.json`, NFTC_REPO)).data;
        const first = (await reader(`${slug}/snapshots/listing-first-seen.json`, NFTC_REPO)).data;
        if (!ix || !Array.isArray(ix.months) || !nfts || !Array.isArray(nfts.records)) { per[slug] = { status: 'skipped', reason: !ix ? 'no ledger index' : 'no inventory nfts.json' }; continue; }
        // ledger side: fold open listings month by month
        const open = {};   // token → { venue, ts }
        for (const mk of ix.months) {
            const m = (await reader(`${slug}/ledger/${mk}.json`, NFTC_REPO)).data; if (!Array.isArray(m)) continue;
            m.sort((a, b) => (a.height - b.height) || (a.msg_index - b.msg_index));
            for (const r of m) {
                if (r.superseded_by || r.token_id == null) continue;
                const t = String(r.token_id);
                if (LISTING_OPEN.has(r.kind)) open[t] = { venue: String(r.venue || '').toLowerCase(), ts: r.ts };
                else if (LISTING_CLOSE.has(r.kind) && open[t]) { open[t] = null; delete open[t]; }
            }
        }
        // inventory side
        const inv = {};
        for (const r of nfts.records) if (r.listing && r.listing.marketplace) inv[String(r.id)] = { venue: String(r.listing.marketplace).toLowerCase(), source: r.listing.source || null };
        const firstSeen = {}; for (const e of Object.values((first && first.entries) || {})) if (e && e.token_id) firstSeen[String(e.token_id)] = e.first_seen_at;
        const ledgerAt = (hb && hb.ran_at) || null, invAt = nfts.capturedAt || null;
        const lagMs = ledgerAt && invAt ? Math.abs(new Date(invAt) - new Date(ledgerAt)) : 0;
        const window = Math.max(lagMs, (opts.min_lag_h || 2) * 36e5);   // at least 2 h: hourly cron + settle time
        const countBy = (o) => { const c = {}; for (const v of Object.values(o)) c[v.venue] = (c[v.venue] || 0) + 1; return c; };
        const ledgerOnly = [], invOnly = [], venueDiff = [], recent = [];
        for (const t of Object.keys(open)) {
            if (!inv[t]) { const age = now - new Date(open[t].ts); (age < window ? recent : ledgerOnly).push({ token_id: t, venue: open[t].venue, listed_at: open[t].ts, side: 'ledger' }); }
            else if (inv[t].venue !== open[t].venue) venueDiff.push({ token_id: t, ledger_venue: open[t].venue, inventory_venue: inv[t].venue });
        }
        for (const t of Object.keys(inv)) {
            if (open[t]) continue;
            const fs = firstSeen[t]; const age = fs ? now - new Date(fs) : Infinity;
            (age < window ? recent : invOnly).push({ token_id: t, venue: inv[t].venue, source: inv[t].source, first_seen_at: fs || null, side: 'inventory' });
        }
        compared++;
        const bad = ledgerOnly.length + invOnly.length + venueDiff.length;
        per[slug] = { status: bad ? 'violation' : 'ok', ledger_open: Object.keys(open).length, inventory_listed: Object.keys(inv).length, by_venue: { ledger: countBy(open), inventory: countBy(inv) },
            ledger_open_not_in_inventory: ledgerOnly.slice(0, 25), inventory_listed_not_open_in_ledger: invOnly.slice(0, 25), venue_disagreements: venueDiff.slice(0, 25), recent_unconfirmed: recent.slice(0, 25),
            ledger_as_of: ledgerAt, inventory_as_of: invAt, lag_window_h: Math.round(window / 36e5 * 10) / 10 };
        if (bad) problems.push(`${slug}: ${ledgerOnly.length} open in ledger, not in inventory · ${invOnly.length} listed in inventory, not open in ledger · ${venueDiff.length} venue disagreement(s)`);
    }
    if (!compared) return skipped('no collection had both a ledger index and an inventory nfts.json');
    if (problems.length) return violation(problems.join(' | '), per, 'per collection: listings open per the event ledger == inventory listings from contract state, per venue and per token (differences inside the products\' lag window are recent_unconfirmed)');
    return ok(`${compared} collection(s) reconcile to the token`, per, 'per collection: listings open per the event ledger == inventory listings from contract state, per venue and per token');
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

    // ---- run the eight
    const invariants = {
        bucket_vp_consistency:      invBucketVpConsistency(member, catalog),
        staked_le_depth:            invStakedLeDepth(dexSnapshots),
        distribution_fractions_sum: invDistributionFractions(catalog),
        tribute_stream_coverage:    invTributeCoverage(votingHb, lastRun),
        bucket_label_agreement:     invBucketLabelAgreement(dexSnapshots, catalog),
        heartbeat_freshness:        await invHeartbeatFreshness(apiGetJson, now),
        identity_resolution:        invIdentityResolution(catalog),
        nft_listings_reconcile:     await invNftListingsReconcile(apiGetJson, now),   // 1.0.9
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

module.exports = { run, T, apiGetJson, publishFile, invBucketVpConsistency, invStakedLeDepth, invDistributionFractions, invTributeCoverage, invBucketLabelAgreement, invHeartbeatFreshness, invIdentityResolution, invNftListingsReconcile, FRESHNESS_MAP };
if (require.main === module) run().then(() => process.exit(0)).catch(e => { console.error('FATAL:', e.message); process.exit(1); });
