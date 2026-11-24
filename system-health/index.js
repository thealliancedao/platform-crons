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
//   1 bucket_vp_consistency    the same paid pools in tla-snapshot and the catalog, the same votes behind them, members' votes vs
//                              every vote in the gauge (1.1.1); like-for-like = same DAY (skip + declare else)
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
const VERSION       = 'org-system-health-1.1.1';   // 1.1.1 (2026-11-24): bucket_vp_consistency asks like for like — the same paid pools in the hourly snapshot and the catalog, the same votes behind them, and members' votes against EVERY vote in the gauge (it compared every member vote with the paid pools only, a 9–12 % red light that could never go out)   // 1.1.0 (2026-11-24, pre-promotion health check): three checks that would have caught what the check found by hand — reward_list_valued (every pool the chain is paying has a dollar value in the TLA snapshot, and its total agrees with the Eris-method feed), rewards_sum_to_emission (per-pool emissions add up to the emission; a pool off its gauge's list is neither active nor paid), pnl_integrity (the P&L build's own fault checks); a $50 floor on the two dust-pool checks so a red status is news again; the page-feeding products that had no freshness row are watched (tla-snapshot, participants, positions, holdings, eris-apr, lp-grades, network-and-prices, tla-flows events + P&L)   // 1.0.11 (2026-09-22): org-ally-holders-liondao registered (daily, heartbeat lion-dao/holders-heartbeat.json) · 1.0.10 (2026-09-21): org-ally-positions-liondao registered (hourly :20, heartbeat in dao-originations/lion-dao/positions/; carries its own status + errors count) · 1.0.9 (2026-09-19, owner): INV 8 nft_listings_reconcile — per collection, listings OPEN per the chain-event ledger == listings the inventory reads from contract state, per venue and per token (the PL #2124 gap: a chain-only BBL listing the state read could not see); + PL inventory freshness row · 1.0.8 (2026-09-14): price-history WRITER heartbeat row (token-catalog now writes price-history/heartbeat.json each run; B.5) · 1.0.7 (2026-09-14): a FRESH heartbeat whose own `status` is failed/error is a violation (tla-locks failed every run for 13 h on 2026-09-13 behind a green freshness row) · 1.0.6 (2026-09-13): the three aDAO product heartbeats read from nft-collections/adao/ (migration) · 1.0.5 (2026-09-12): freshness rows may name their repo — the three nft-collections ledger crons registered

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
const DUST_USD = 50;   // 1.1.0: materiality floor for the two per-pool consistency checks (INV 2, INV 5)
const round2 = (v) => Math.round(v * 100) / 100;

// --------------------------------------------------------------------------- INV 1 — bucket_vp_consistency (same-DAY like-for-like; report, don't repair)
// 1.1.1: like with like. Through 1.1.0 this set every vote the members cast in a bucket against the votes behind the catalog's PAID
// pools only, so the votes sitting on pools that earn nothing (off the gauge's reward list, or under 1 %) read as a 9–12 % "drift" on
// every run — a red light that could not go out, on a monitor people then stop reading. tla-snapshot 1.2.0 carries every vote in each
// gauge (boost + fixed) and which pools the chain is paying, so three like-for-like questions are asked instead:
//   a) the paid set   — are the pools the hourly snapshot calls active exactly the pools the catalog says the chain is paying?
//   b) the paid votes — do the two agree on the votes behind them? (the catalog holds the distribution's figure, the snapshot the
//                       live one — they part by timing only; a boost-or-fixed mix-up shows as ~10 %)
//   c) every vote     — do the members' votes account for the votes in the gauge?
// (a) is not asked in the first hours of an epoch: the distribution changes at the flip and the two sources refresh at different rates.
const PAID_VP_TOL_PCT = 5;              // (b) snapshot vs catalog, votes behind the paid pools
const MEMBER_OVER_TOL_PCT = 5;          // (c) members may not claim more votes than the gauge holds (beyond a day's timing)
const MEMBER_UNDER_TOL_PCT = 10;        // (c) votes in the gauge that no member wallet accounts for (timing + votes left by locks that moved)
const PAID_SET_GRACE_H = 12;            // (a) hours after the epoch starts before the paid sets are compared
function invBucketVpConsistency(member, catalog, tlaSnap) {
    if (!member)  return skipped('member-data current.json absent/unreadable');
    if (!catalog) return skipped('token-catalog current.json absent/unreadable');
    const mDay = dayOf(member.meta && member.meta.generated_at);
    const cDay = dayOf(catalog.meta && catalog.meta.generated_at);
    if (!mDay || !cDay) return skipped('missing generated_at stamp on one side');
    if (mDay !== cDay)  return skipped(`stamps differ (member ${mDay} vs catalog ${cDay}) — like-for-like requires same day`);
    const perBucket = (member.system && member.system.vp_voting_per_bucket) || null;
    if (!perBucket) return skipped('member-data lacks system.vp_voting_per_bucket');
    const sB = (tlaSnap && tlaSnap.buckets) || null;
    if (!sB || !Object.values(sB).some(b => b && typeof b.bucket_vp_total_human === 'number'))
        return skipped('tla-snapshot has no per-bucket vote totals (bucket_vp_total_human, tla-snapshot 1.2.0) — members\' votes against the paid pools only is not like for like and is no longer compared');
    const sDay = dayOf(tlaSnap.capturedAt);
    if (sDay && sDay !== mDay) return skipped(`stamps differ (member ${mDay} vs tla-snapshot ${sDay}) — like-for-like requires same day`);

    const catPaid = {}, catSet = new Map();
    for (const p of (catalog.pools || [])) {
        if (p.gauge_status !== 'active') continue;
        catPaid[p.bucket] = (catPaid[p.bucket] || 0) + Number(p.total_vp || 0) / 1e6;   // micro → VP
        catSet.set(`${p.bucket}|${p.gauge_pool_id}`, p.gauge_pool_id);
    }
    const snapPaid = {}, snapSet = new Map();
    for (const p of (tlaSnap.pools || [])) {
        if (p.status !== 'active') continue;
        const vp = p.voting_power || {};
        snapPaid[p.bucket] = (snapPaid[p.bucket] || 0) + (Number(vp.total_human != null ? vp.total_human : vp.vp_human) || 0);
        snapSet.set(`${p.bucket}|${p.gauge_pool_id}`, p.name || p.gauge_pool_id);
    }
    const r2 = (x) => Math.round(x * 100) / 100;
    const rows = [], problems = [];
    let worstPaid = 0, worstOver = 0, worstUnder = 0;
    for (const b of Object.keys(perBucket)) {
        const m = Number(perBucket[b] || 0), sb = sB[b] || {};
        const all = Number(sb.bucket_vp_total_human || 0), cp = catPaid[b] || 0, sp = snapPaid[b] || 0;
        const paidDiff = cp ? (sp - cp) / cp * 100 : (sp ? 100 : 0);
        const memberDiff = all ? (m - all) / all * 100 : (m ? 100 : 0);
        worstPaid = Math.max(worstPaid, Math.abs(paidDiff));
        if (memberDiff > 0) worstOver = Math.max(worstOver, memberDiff); else worstUnder = Math.max(worstUnder, -memberDiff);
        rows.push({ bucket: b, member_vp: m, gauge_votes_vp: r2(all), on_listed_pools_vp: r2(Number(sb.reward_list_vp_total_human || 0)), off_list_vp: r2(Number(sb.off_list_vp_total_human || 0)),
            member_vs_gauge_pct: r2(memberDiff), catalog_active_sum_vp: r2(cp), snapshot_active_sum_vp: r2(sp), paid_diff_pct: r2(paidDiff) });
        if (Math.abs(paidDiff) > PAID_VP_TOL_PCT) problems.push(`${b}: the votes behind the paid pools differ by ${paidDiff.toFixed(2)}% between the hourly snapshot and the catalog`);
        if (memberDiff > MEMBER_OVER_TOL_PCT) problems.push(`${b}: members' votes exceed the votes in the gauge by ${memberDiff.toFixed(2)}%`);
        if (-memberDiff > MEMBER_UNDER_TOL_PCT) problems.push(`${b}: ${(-memberDiff).toFixed(2)}% of the votes in the gauge are not accounted for by any member wallet`);
    }
    // (a) the paid set — same epoch on both sides, and past the hours in which the new distribution is still settling
    const sEpoch = tlaSnap.epoch && tlaSnap.epoch.currentEpoch, cEpoch = catalog.meta && catalog.meta.epoch;
    const startedAt = tlaSnap.epoch && Date.parse(tlaSnap.epoch.epochStartedAt), catAt = Date.parse(catalog.meta && catalog.meta.generated_at);
    const settled = !isFinite(startedAt) || !isFinite(catAt) || (catAt - startedAt) >= PAID_SET_GRACE_H * 3600e3;
    let setNote;
    if (sEpoch != null && cEpoch != null && sEpoch !== cEpoch) setNote = `paid sets not compared (snapshot epoch ${sEpoch}, catalog epoch ${cEpoch})`;
    else if (!settled) setNote = `paid sets not compared in the first ${PAID_SET_GRACE_H} h of an epoch`;
    else {
        const onlySnap = [...snapSet.keys()].filter(k => !catSet.has(k)), onlyCat = [...catSet.keys()].filter(k => !snapSet.has(k));
        if (onlySnap.length) problems.push(`active in the hourly snapshot but not paid per the catalog: ${onlySnap.slice(0, 5).map(k => `${snapSet.get(k)} (${k.split('|')[0]})`).join(', ')}${onlySnap.length > 5 ? ` +${onlySnap.length - 5} more` : ''}`);
        if (onlyCat.length) problems.push(`paid per the catalog but not active in the hourly snapshot: ${onlyCat.slice(0, 5).map(k => `${String(catSet.get(k)).slice(0, 24)} (${k.split('|')[0]})`).join(', ')}${onlyCat.length > 5 ? ` +${onlyCat.length - 5} more` : ''}`);
        setNote = `the same ${snapSet.size} paid pools in both`;
    }
    const expected = `the same paid pools in both; paid votes within ${PAID_VP_TOL_PCT}%; members' votes within +${MEMBER_OVER_TOL_PCT}% / −${MEMBER_UNDER_TOL_PCT}% of the votes in the gauge`;
    if (problems.length) return violation(problems.slice(0, 4).join(' · ') + (problems.length > 4 ? ` · +${problems.length - 4} more` : ''), rows, expected);
    return ok(`${setNote}; paid votes agree within ${worstPaid.toFixed(2)}%; members account for all but ${worstUnder.toFixed(2)}% of the votes in a gauge at most`, rows, expected);
}

// --------------------------------------------------------------------------- INV 2 — staked_le_depth (per pool, both sides present)
function invStakedLeDepth(dexSnapshots) {
    if (!dexSnapshots.length) return skipped('no dex-data snapshots readable');
    const bad = [], dust = []; let checked = 0;
    for (const { id, snap } of dexSnapshots) {
        for (const p of (snap.pools || [])) {
            const tvl = num(p.tvl_usd), staked = num(p.raw && p.raw.staked_liquidity_usd);
            if (tvl === null || staked === null) continue;
            checked++;
            if (staked > tvl * 1.001) {   // 0.1% float slack
                const row = { dex: id, pool: p.pool_name || p.pool_address, staked_usd: staked, tvl_usd: tvl };
                // 1.1.0: a pool with under $50 staked is rounding in an empty pool, not a state anyone can be misled by — listed, not raised
                (staked < DUST_USD ? dust : bad).push(row);
            }
        }
    }
    if (!checked) return skipped('no pool carried both staked and tvl values');
    if (bad.length) return violation(`${bad.length} pool(s) report staked > depth (impossible state)` + (dust.length ? ` — ${dust.length} more under $${DUST_USD} staked not raised` : ''), bad, 'staked_liquidity_usd <= tvl_usd');   // measured stays the list of pools (readers expect an array)
    return ok(`${checked} pools checked, none impossible` + (dust.length ? ` (${dust.length} dust pool(s) under $${DUST_USD} staked listed, not raised)` : ''), { pools_checked: checked, dust_ignored: dust }, 'staked_liquidity_usd <= tvl_usd');
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
    const mismatches = [], dust = []; let joined = 0;
    for (const { id, snap } of dexSnapshots) {
        for (const p of (snap.pools || [])) {
            if (!p.bucket) continue;                          // non-TLA pool
            const cat = catByPair[p.pool_address];
            if (!cat) continue;                               // catalog has no pair entry — INV7 territory
            joined++;
            if (cat.bucket !== p.bucket) {
                const staked = num(p.raw && p.raw.staked_liquidity_usd);
                const row = { dex: id, pool: p.pool_name || p.pool_address, dex_bucket: p.bucket, catalog_bucket: cat.bucket, staked_usd: staked, dex_as_of: snap.meta && snap.meta.generated_at, catalog_as_of: catalog.meta && catalog.meta.generated_at };
                // 1.1.0: a disagreement on a pool with under $50 staked is listed, not raised (SkeletonSwap LUNA-SOLID: $0.04)
                (staked !== null && staked < DUST_USD ? dust : mismatches).push(row);
            }
        }
    }
    if (!joined) return skipped('no dex pool joined to a catalog pair');
    if (mismatches.length) return violation(`${mismatches.length} bucket label disagreement(s) — dex-data 1.1.0 resolves from chain; catalog entry likely stale (finding A)` + (dust.length ? ` — ${dust.length} more on dust pools not raised` : ''), mismatches, 'dex bucket == catalog bucket per pair');   // measured stays the list
    return ok(`${joined} joined pairs agree` + (dust.length ? ` (${dust.length} disagreement(s) on dust pools under $${DUST_USD} staked listed, not raised)` : ''), { pairs_joined: joined, dust_ignored: dust }, 'dex bucket == catalog bucket per pair');
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
    // 1.1.0 (2026-11-24): the products TLA Stats and Member Portfolio read that had no row here (the 2026-10-14 go-live audit
    // checked them by hand). Hourly ones get 4 h, daily ones 30 h — a missed run or two, not a blip.
    { product: 'tla-snapshot',       kind: 'cron', path: 'member-data/tla-snapshot/heartbeat.json',  ts: ['capturedAt'],                 max_age_h: 4 },
    { product: 'tla-participants',   kind: 'cron', path: 'member-data/participants/heartbeat.json',  ts: ['capturedAt'],                 max_age_h: 4 },
    { product: 'adao-positions',     kind: 'cron', path: 'member-data/positions/heartbeat.json',     ts: ['capturedAt'],                 max_age_h: 4 },
    { product: 'member-holdings',    kind: 'cron', path: 'member-data/holdings/heartbeat.json',      ts: ['capturedAt'],                 max_age_h: 30 },
    { product: 'eris-apr',           kind: 'cron', path: 'dex-data/eris-apr/heartbeat.json',         ts: ['generated_at', 'capturedAt'], max_age_h: 4 },
    { product: 'lp-grades',          kind: 'cron', path: 'lp-grades/snapshots/heartbeat.json',       ts: ['capturedAt'],                 max_age_h: 30 },
    { product: 'network-and-prices', kind: 'cron', path: 'network-and-prices/heartbeat.json',        ts: ['capturedAt'],                 max_age_h: 4 },
    { product: 'tla-flows-events',   kind: 'cron', path: 'tla-flows/events/heartbeat.json',          ts: ['capturedAt'],                 max_age_h: 4 },
    { product: 'tla-flows-pnl',      kind: 'cron', path: 'tla-flows/pnl/heartbeat.json',             ts: ['builtAt'],                    max_age_h: 30 },
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


// --------------------------------------------------------------------------- INV 9 — reward_list_valued (1.1.0)
// Every pool the chain is paying must have a dollar value in the TLA snapshot, and the snapshot's total for those pools must
// agree with the Eris-method feed (dex-data/eris-apr), which values the same pools from the DEX adapters. The 2026-11 case:
// the snapshot could not name USDC.inj for eight weeks — four paid pools read no value (the largest TLA pool among them), the
// page's TLA TVL read a third low — and every check here was green or "known".
function invRewardListValued(tlaSnap, erisApr) {
    if (!tlaSnap || !Array.isArray(tlaSnap.pools)) return skipped('tla-snapshot current.json absent/unreadable');
    const paid = tlaSnap.pools.filter(p => p.rewards && p.rewards.source === 'chain_distributions_current');
    if (!paid.length) return skipped('no pool in the TLA snapshot carries the chain distribution');
    // "has a stake but no value": something is staked (the staking contract holds LP) and the snapshot could not price it
    const unvalued = paid.filter(p => !(Number(p.staked_in_tla_usd) > 0) && p.amp_lp && Number(p.amp_lp.underlying_lp_amount) > 0)
        .map(p => ({ pool: p.name, bucket: p.bucket, share_of_bucket: p.rewards.distribution_share_of_bucket, unnamed_sides: [p.lp_health && p.lp_health.asset_0, p.lp_health && p.lp_health.asset_1].filter(a => a && !a.symbol).length }));
    const ours = paid.reduce((s, p) => s + (Number(p.staked_in_tla_usd) || 0), 0);
    const theirs = erisApr && Array.isArray(erisApr.pools) ? erisApr.pools.reduce((s, p) => s + (Number(p.tla_staked_usd) || 0), 0) : null;
    const diffPct = theirs ? Math.abs(ours - theirs) / theirs * 100 : null;
    const TOL_PCT = 5;
    const measured = { paid_pools: paid.length, unvalued, tla_staked_usd_snapshot: round2(ours), tla_staked_usd_eris_method: theirs == null ? null : round2(theirs), diff_pct: diffPct == null ? null : round2(diffPct), snapshot_version: tlaSnap.version || null };
    const expected = `every paid pool valued; totals within ${TOL_PCT}%`;
    if (unvalued.length) return violation(`${unvalued.length} pool(s) the chain is paying have no dollar value in the TLA snapshot: ${unvalued.map(u => u.pool).join(', ')}`, measured, expected);
    if (diffPct != null && diffPct > TOL_PCT) return violation(`TLA staked in the paid pools: the snapshot and the Eris-method feed differ by ${diffPct.toFixed(1)}%`, measured, expected);
    return ok(`${paid.length} paid pools valued` + (diffPct != null ? `; the snapshot and the Eris-method feed agree within ${diffPct.toFixed(1)}%` : ' (Eris-method feed unreadable — total not cross-checked)'), measured, expected);
}

// --------------------------------------------------------------------------- INV 10 — rewards_sum_to_emission (1.1.0)
// The chain's distribution sums to 100 % of each bucket, so the per-pool emissions in the snapshot must add up to the emission
// (a hair over is allowed: a listed pool not in this epoch's distribution carries a next-epoch estimate). A pool that is off its
// gauge's list must carry none and must not be `active`. The 2026-11 case: nine such pools were active with an estimate each —
// the sum ran 12 % over and the page's "Epoch rewards" tile with it.
function invRewardsSumToEmission(tlaSnap) {
    if (!tlaSnap || !Array.isArray(tlaSnap.pools) || !tlaSnap.totals || !tlaSnap.totals.rewards) return skipped('tla-snapshot rewards absent/unreadable');
    const total = Number(tlaSnap.totals.rewards.annual_emissions_luna) || 0;
    if (!(total > 0)) return skipped('no annual emission in the TLA snapshot');
    const sum = tlaSnap.pools.reduce((s, p) => s + (Number(p.rewards && p.rewards.annual_emissions_luna) || 0), 0);
    const ratio = sum / total;
    const offPaid = tlaSnap.pools.filter(p => p.gauge_whitelisted === false && (p.status === 'active' || (Number(p.rewards && p.rewards.annual_emissions_luna) || 0) > 0)).map(p => p.name);
    const unread = tlaSnap.pools.filter(p => p.status === 'active' && p.gauge_whitelisted == null).length;   // an earlier build, or the gauge's list could not be read
    const measured = { per_pool_sum_over_emission: Math.round(ratio * 10000) / 10000, off_list_but_active_or_paid: offPaid, active_pools_with_unread_list: unread, snapshot_version: tlaSnap.version || null };
    const expected = '98–102% of the emission; no pool off its gauge\'s list active or paid';
    if (offPaid.length) return violation(`${offPaid.length} pool(s) off their gauge's list are active or carry emissions: ${offPaid.slice(0, 6).join(', ')}`, measured, expected);
    if (ratio > 1.02 || ratio < 0.98) return violation(`per-pool emissions add up to ${(ratio * 100).toFixed(1)}% of the emission`, measured, expected);
    return ok(`per-pool emissions add up to ${(ratio * 100).toFixed(1)}% of the emission` + (unread ? ` (${unread} active pool(s) with the gauge's list unread)` : ''), measured, expected);
}

// --------------------------------------------------------------------------- INV 11 — pnl_integrity (1.1.0)
// tla-flows/pnl/integrity.json is the P&L build's own list of invariants; `fault` = a figure is wrong. Nothing watched it: it
// reported 878–916 faults for five weeks (a stale check, fixed in pnl 1.7.2) and nobody was told. A fault count above zero is
// now raised here; the `check` counts (cost not measured) are carried as numbers.
function invPnlIntegrity(integ) {
    if (!integ || !integ.checks) return skipped('tla-flows/pnl/integrity.json absent/unreadable');
    const faults = Object.entries(integ.checks).filter(([, c]) => c && c.severity === 'fault' && Number(c.count) > 0).map(([k, c]) => ({ check: k, count: c.count }));
    const measured = { builder: integ.builder || null, built_at: integ.builtAt || null, positions_checked: integ.positions_checked, wallets_checked: integ.wallets_checked,
        counts: Object.fromEntries(Object.entries(integ.checks).map(([k, c]) => [k, c && c.count])), wallets_flagged: integ.per_wallet ? Object.keys(integ.per_wallet).length : null };
    if (faults.length) return violation(`the P&L build reports ${faults.map(f => f.count + ' × ' + f.check).join(', ')}`, measured, 'no fault-severity check above zero');
    return ok(`no fault in the P&L build (${integ.positions_checked} positions; ${measured.counts.cost_not_measured != null ? measured.counts.cost_not_measured + ' with no measured cost' : 'cost coverage not reported'})`, measured, 'no fault-severity check above zero');
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
    // 1.1.0: the TLA snapshot (the file behind the TLA Stats tiles), the Eris-method feed and the P&L build's integrity report
    const tlaSnap  = (await apiGetJson('member-data/tla-snapshot/current.json')).data;
    const erisApr  = (await apiGetJson('dex-data/eris-apr/current.json')).data;
    const pnlInteg = (await apiGetJson('tla-flows/pnl/integrity.json')).data;

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

    // ---- run them
    const invariants = {
        bucket_vp_consistency:      invBucketVpConsistency(member, catalog, tlaSnap),
        staked_le_depth:            invStakedLeDepth(dexSnapshots),
        distribution_fractions_sum: invDistributionFractions(catalog),
        tribute_stream_coverage:    invTributeCoverage(votingHb, lastRun),
        bucket_label_agreement:     invBucketLabelAgreement(dexSnapshots, catalog),
        heartbeat_freshness:        await invHeartbeatFreshness(apiGetJson, now),
        identity_resolution:        invIdentityResolution(catalog),
        nft_listings_reconcile:     await invNftListingsReconcile(apiGetJson, now),   // 1.0.9
        reward_list_valued:         invRewardListValued(tlaSnap, erisApr),            // 1.1.0
        rewards_sum_to_emission:    invRewardsSumToEmission(tlaSnap),                 // 1.1.0
        pnl_integrity:              invPnlIntegrity(pnlInteg),                        // 1.1.0
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

module.exports = { run, T, apiGetJson, publishFile, invBucketVpConsistency, invStakedLeDepth, invDistributionFractions, invTributeCoverage, invBucketLabelAgreement, invHeartbeatFreshness, invIdentityResolution, invNftListingsReconcile, invRewardListValued, invRewardsSumToEmission, invPnlIntegrity, FRESHNESS_MAP };
if (require.main === module) run().then(() => process.exit(0)).catch(e => { console.error('FATAL:', e.message); process.exit(1); });
