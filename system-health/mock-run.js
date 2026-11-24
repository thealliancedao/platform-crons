#!/usr/bin/env node
'use strict';
// =============================================================================
// system-health mock gate (SPEC-system-health D6 — BINDING before deploy)
// In-memory REPO stub behind T.githubApiRequest. Covers: all-ok pass, one
// violation per invariant, like-for-like skip, missing-input honesty,
// price-history day-key freshness, one-off exemption, history append
// never-shrink, coverage-drop alarm, fresh-but-failed heartbeat (1.0.7).
// =============================================================================
const M = require('./index.js');

let PASS = 0, FAIL = 0;
function check(name, cond, extra) {
    if (cond) { PASS++; console.log(`  ✓ ${name}`); }
    else      { FAIL++; console.log(`  ✗ ${name}${extra ? ' — ' + JSON.stringify(extra).slice(0, 220) : ''}`); }
}

// ---------------------------------------------------------------------------- repo stub
let REPO = {};
let WRITES = {};
let REPO_HITS = {};   // 1.0.5: path → repo the read was addressed to
M.T.githubApiRequest = async (method, apiPath, body, accept) => {
    const m = apiPath.match(/\/contents\/([^?]+)/);
    const path = m && decodeURIComponent(m[1]);
    const rm = apiPath.match(/^\/repos\/([^/]+\/[^/]+)\//); if (method === 'GET' && rm) REPO_HITS[path] = rm[1];
    if (method === 'GET') {
        if (accept === 'application/vnd.github.raw') {
            if (path in REPO) return JSON.stringify(REPO[path]);
            const err = new Error('404'); err.statusCode = 404; throw err;
        }
        if (path in REPO) return { sha: 'stub-sha' };
        const err = new Error('404'); err.statusCode = 404; throw err;
    }
    if (method === 'PUT') {
        const obj = JSON.parse(Buffer.from(body.content, 'base64').toString());
        REPO[path] = obj; WRITES[path] = (WRITES[path] || 0) + 1;
        return { ok: true };
    }
    throw new Error('unexpected method ' + method);
};
const NOW = new Date('2026-07-16T12:00:00Z');
M.T.now = () => NOW;

// ---------------------------------------------------------------------------- fixture builders
const H = (iso) => ({ capturedAt: iso, status: 'ok' });
function healthyRepo() {
    const gen = '2026-07-16T10:00:00Z';
    const repo = {
        'member-data/snapshots/current.json': { meta: { generated_at: gen }, system: { vp_voting_per_bucket: { stable: 1000, project: 2000 } } },
        'token-catalog/snapshots/current.json': { meta: { generated_at: gen }, pools: [
            { bucket: 'stable',  gauge_status: 'active', total_vp: String(600 * 1e6), distribution_pct: 0.6, architecture: { pair_address: 'pairA' }, gauge_pool_id: 'g1', underlyings: ['x'] },
            { bucket: 'stable',  gauge_status: 'active', total_vp: String(399 * 1e6), distribution_pct: 0.4, architecture: { pair_address: 'pairB' }, gauge_pool_id: 'g2', underlyings: ['x'] },
            { bucket: 'stable',  gauge_status: 'active', total_vp: String(1 * 1e6), distribution_pct: 0, architecture: { pair_address: 'pairF' }, gauge_pool_id: 'g5', underlyings: ['x'] },   // 1.1.1: paid, nothing staked (PAID-EMPTY in the snapshot)
            { bucket: 'project', gauge_status: 'active', total_vp: String(1995 * 1e6), distribution_pct: 1.0, architecture: { pair_address: 'pairC' }, gauge_pool_id: 'g3', underlyings: ['x'] },
            { bucket: 'project', gauge_status: 'dewhitelisted', total_vp: String(5000 * 1e6), distribution_pct: 0.9, gauge_pool_id: 'g4' },  // inactive: excluded everywhere, counts unresolved
        ], tokens: [ { denom: 'tokA', discovered: { symbol: 'A' } }, { denom: 'tokB', discovered: {} } ] },   // real shape: list + discovered
        'dex-data/index.json': { meta: {}, dexes: [{ id: 'astroport', enabled: true }] },
        'dex-data/astroport/snapshots/current.json': { meta: { generated_at: gen }, pools: [
            { pool_name: 'P1', pool_address: 'pairA', bucket: 'stable',  tvl_usd: 100, raw: { staked_liquidity_usd: 60 } },
            { pool_name: 'P2', pool_address: 'pairC', bucket: 'project', tvl_usd: 500, raw: { staked_liquidity_usd: 400 } },
            { pool_name: 'NOT-TLA', pool_address: 'pairZ', bucket: null, tvl_usd: 9, raw: { staked_liquidity_usd: 90 } },  // no bucket → INV5 skip; INV2 STILL checks it? yes both sides exist → would violate! keep <= : fix to 5
        ] },
        'tla-voting/events/heartbeat.json': { capturedAt: '2026-07-16T11:00:00Z', status: 'ok' },  // the hourly heartbeat: no bribe_capture (it is only there on the run that harvests)
        'member-data/snapshots/heartbeat.json': { generated_at: '2026-07-16T02:00:00Z', status: 'ok' },   // real shape: generated_at, no capturedAt
        'token-catalog/snapshots/heartbeat.json': H('2026-07-16T10:00:00Z'),
        'dex-data/astroport/snapshots/heartbeat.json': { generated_at: '2026-07-16T11:00:00Z' },
        'dex-data/skeletonswap/snapshots/heartbeat.json': { generated_at: '2026-07-16T11:00:00Z' },
        // fold-series heartbeats (rows added 2026-08-10, strip step 3) —
        // real shape: capturedAt (fold-authored), no generated_at
        'dex-data/astroport/epochs/heartbeat.json': { capturedAt: '2026-07-16T11:00:00Z', status: 'ok' },
        'dex-data/skeletonswap/rolling/heartbeat.json': { capturedAt: '2026-07-16T11:00:00Z', status: 'ok' },
        'tla-voting/vote-state/heartbeat.json': H('2026-07-13T00:00:00Z'),
        // 1.1.2: written at a harvest only, so it keeps the last bribe_capture — in the shape tla-voting writes (INV4 reads it here)
        'tla-voting/bribe-state/heartbeat.json': Object.assign(H('2026-07-13T00:00:00Z'), { period_head: 49, bribe_capture: { period: 49, denom_count: 3, mean_coverage_pct: 105.61, denoms: {
            'native:uluna': { state: '6942836142', events: '8111781408', coverage_pct: 116.84 }, 'cw20:astro': { state: '100', events: '100', coverage_pct: 100 }, 'native:ibc/EVT': { state: '0', events: '204265', coverage_pct: null, events_only: true } } } }),
        // 1.0.5: the three nft-collections ledger crons (real shape: ran_at, status, cursor)
        'adao/nft-flows/heartbeat.json':        { ran_at: '2026-07-16T11:04:00Z', status: 'ok', cursor: 1 },
        'pixel-lions/nft-flows/heartbeat.json': { ran_at: '2026-07-16T11:24:00Z', status: 'ok', cursor: 1 },
        'tla-locks/nft-flows/heartbeat.json':   { ran_at: '2026-07-16T11:44:00Z', status: 'ok', cursor: 1 },
        'tla-voting/distributions/heartbeat.json': H('2026-07-13T00:00:00Z'),
        'adao/snapshots/heartbeat.json': H('2026-07-16T11:00:00Z'),      // 1.0.6: nft-collections paths
        'pixel-lions/snapshots/heartbeat.json': H('2026-07-16T11:15:00Z'),   // 1.0.9: org-nft-inventory-liondao
        'lion-dao/positions/heartbeat.json':    { product: 'lion-dao/positions', engine: '1.0.2', status: 'ok', capturedAt: '2026-07-16T11:20:00Z', wallets: 5, known_usd: 188105.31, errors: 0 },
        'lion-dao/holders-heartbeat.json':      { product: 'lion-dao/holders', engine: '1.0.0', status: 'ok', capturedAt: '2026-07-16T03:40:00Z', written: ['burn/holders.json', 'roar20/holders.json'], errors: [] },   // 1.0.11 shape   // 1.0.10: org-ally-positions-liondao (real heartbeat shape, 2026-09-21)
        // 1.0.9 INV8 fixture: two collections; a two-month aDAO ledger where #1 was listed then delisted, #2 listed on bbl and
        // still open, #3 listed on atrium and sold; #4 listed then transferred (closed). The inventory agrees: only #2 listed.
        'docs/curated/tenants.json': { tenants: { adao: { collections: ['adao'] }, liondao: { collections: ['pixel-lions'] } } },
        'adao/ledger/index.json': { months: ['2026/06', '2026/07'] },
        'adao/ledger/2026/06.json': [
            { txhash: 'A', height: 10, msg_index: 0, kind: 'list', token_id: '1', venue: 'bbl', ts: '2026-06-01T00:00:00Z' },
            { txhash: 'B', height: 11, msg_index: 0, kind: 'list', token_id: '3', venue: 'atrium', ts: '2026-06-02T00:00:00Z' },
            { txhash: 'C', height: 12, msg_index: 0, kind: 'list', token_id: '4', venue: 'bbl', ts: '2026-06-03T00:00:00Z' },
            { txhash: 'Z', height: 13, msg_index: 0, kind: 'list', token_id: '9', venue: 'bbl', ts: '2026-06-03T00:00:00Z', superseded_by: 'repair-x' },   // never counts
        ],
        'adao/ledger/2026/07.json': [
            { txhash: 'D', height: 20, msg_index: 0, kind: 'delist', token_id: '1', venue: 'bbl', ts: '2026-07-01T00:00:00Z' },
            { txhash: 'E', height: 21, msg_index: 0, kind: 'list', token_id: '2', venue: 'bbl', ts: '2026-07-02T00:00:00Z' },
            { txhash: 'F', height: 22, msg_index: 0, kind: 'sale', token_id: '3', venue: 'atrium', ts: '2026-07-03T00:00:00Z' },
            { txhash: 'G', height: 23, msg_index: 0, kind: 'transfer', token_id: '4', ts: '2026-07-04T00:00:00Z' },
        ],
        'adao/snapshots/nfts.json': { capturedAt: '2026-07-16T11:00:00Z', records: [{ id: '1', listing: null }, { id: '2', listing: { marketplace: 'BBL', source: 'chain' } }, { id: '3', listing: null }, { id: '4', listing: null }] },
        'adao/snapshots/listing-first-seen.json': { entries: { 'BBL:1': { token_id: '2', first_seen_at: '2026-07-02T00:10:00Z' } } },
        'pixel-lions/ledger/index.json': { months: ['2026/07'] },
        'pixel-lions/ledger/2026/07.json': [{ txhash: 'P', height: 30, msg_index: 0, kind: 'list', token_id: '2124', venue: 'bbl', ts: '2026-07-10T00:00:00Z' }],
        'pixel-lions/snapshots/nfts.json': { capturedAt: '2026-07-16T11:15:00Z', records: [{ id: '2124', listing: { marketplace: 'BBL', source: 'chain_only' } }] },
        'adao/flows/heartbeat.json': H('2026-07-16T11:00:00Z'),
        'adao/provenance/heartbeat.json': { ran_at: '2026-07-08T00:00:00Z' },   // ancient — must be EXEMPT
        'price-history/2026/07.json': { meta: {}, days: { '2026-07-14': {}, '2026-07-15': {} } },
        'dex-data/credia/snapshots/heartbeat.json': { generated_at: '2026-07-16T11:00:00Z' },
        'votion/heartbeat.json': { capturedAt: '2026-07-16T11:00:00Z', vaults_at: '2026-07-16T11:00:00Z', positions_at: '2026-07-16T02:00:00Z' },   // latest day 26h < 50h → fresh
        'token-catalog/supply/capa/current.json': { capturedAt: '2026-07-16T10:00:00Z', status: 'ok' },
        'price-history/heartbeat.json': { product: 'price-history', cron: 'token-catalog', capturedAt: '2026-07-16T10:00:00Z', status: 'ok', day: '2026-07-16', tokens_appended: 36 },   // 1.0.8 (B.5): writer heartbeat   // capa-supply v2 row (2026-08-24): the product IS the heartbeat
        'token-catalog/supply/fuel/current.json': { capturedAt: '2026-07-16T10:00:00Z', status: 'ok' },   // fuel-supply v1 row (2026-08-24)
        // 1.1.0: the page-feeding products that got freshness rows (real shapes: capturedAt / generated_at / builtAt)
        'member-data/tla-snapshot/heartbeat.json': { cron: 'tla-snapshot', version: 'tla-snapshot-1.2.0', capturedAt: '2026-07-16T11:45:00Z', status: 'ok' },
        'member-data/participants/heartbeat.json': H('2026-07-16T11:45:00Z'),
        'member-data/positions/heartbeat.json': { cron: 'adao-positions', capturedAt: '2026-07-16T11:47:00Z', status: 'ok' },
        'member-data/holdings/heartbeat.json': { product: 'member-data/holdings', capturedAt: '2026-07-15T23:47:00Z', status: 'ok' },
        'dex-data/eris-apr/heartbeat.json': { generated_at: '2026-07-16T11:02:00Z', status: 'ok' },
        'lp-grades/snapshots/heartbeat.json': { cron: 'lp-grades', capturedAt: '2026-07-15T23:15:00Z', status: 'ok' },
        'network-and-prices/heartbeat.json': { cron: 'network-and-prices', capturedAt: '2026-07-16T11:05:00Z', status: 'ok' },
        'tla-flows/events/heartbeat.json': { cron: 'tla-flows', capturedAt: '2026-07-16T11:17:00Z', status: 'ok' },
        'tla-flows/pnl/heartbeat.json': { product: 'tla-flows/pnl', builtAt: '2026-07-16T03:35:00Z', status: 'ok' },
        // 1.1.0 INV9–11 fixtures: three paid pools (one with nothing staked — that is not "unvalued"), one pool off its gauge's
        // list holding old votes (zero rewards), one listed newcomer with a small next-epoch estimate; the Eris-method feed
        // values the paid pools within 1 %; the P&L build reports no fault.
        'member-data/tla-snapshot/current.json': { version: 'tla-snapshot-1.2.0', totals: { rewards: { annual_emissions_luna: 1000 } }, pools: [
            { name: 'PAID-A', bucket: 'stable', status: 'active', gauge_whitelisted: true, staked_in_tla_usd: 600, amp_lp: { underlying_lp_amount: 10 }, lp_health: { asset_0: { symbol: 'A' }, asset_1: { symbol: 'B' } }, rewards: { source: 'chain_distributions_current', annual_emissions_luna: 600, distribution_share_of_bucket: 0.6 } },
            { name: 'PAID-B', bucket: 'stable', status: 'active', gauge_whitelisted: true, staked_in_tla_usd: 400, amp_lp: { underlying_lp_amount: 10 }, lp_health: { asset_0: { symbol: 'A' }, asset_1: { symbol: 'C' } }, rewards: { source: 'chain_distributions_current', annual_emissions_luna: 395, distribution_share_of_bucket: 0.395 } },
            { name: 'PAID-EMPTY', bucket: 'stable', status: 'active', gauge_whitelisted: true, staked_in_tla_usd: null, amp_lp: null, rewards: { source: 'chain_distributions_current', annual_emissions_luna: 5, distribution_share_of_bucket: 0.005 } },
            { name: 'OFF-LIST', bucket: 'stable', status: 'voted_but_below_threshold', status_reason: 'dewhitelisted', gauge_whitelisted: false, staked_in_tla_usd: 50, rewards: { source: 'dewhitelisted', annual_emissions_luna: 0 } },
            { name: 'NEWCOMER', bucket: 'stable', status: 'voted_but_below_threshold', gauge_whitelisted: true, staked_in_tla_usd: 5, rewards: { source: 'gauge_infos_next_fallback', annual_emissions_luna: 3 } },
        ] },
        'dex-data/eris-apr/current.json': { meta: {}, pools: [{ pool_name: 'PAID-A', tla_staked_usd: 603 }, { pool_name: 'PAID-B', tla_staked_usd: 398 }, { pool_name: 'PAID-EMPTY', tla_staked_usd: 0 }] },
        'tla-flows/pnl/integrity.json': { builder: 'tla-flows-pnl-1.7.2', builtAt: '2026-07-16T03:35:00Z', positions_checked: 100, wallets_checked: 10, checks: {
            foreign_tokens_in_cost: { severity: 'fault', count: 0, status: 'ok' }, units_differ_from_chain: { severity: 'fault', count: 0, status: 'ok' }, cost_not_measured: { severity: 'check', count: 7, status: 'check' } }, per_wallet: { w1: ['cost_not_measured'] } },
    };
    // 1.1.1 INV1 fixtures: the snapshot's votes (boost + fixed) per pool, every vote per gauge, and its epoch. The three paid stable
    // pools are the catalog's g1/g2/g5 (600 + 399 + 1 = 1000 on both sides); OFF-LIST and NEWCOMER hold votes that earn nothing
    // (8 + 2), so the stable gauge holds 1010 votes against the members' 1000. One paid project pool = the catalog's g3.
    const S = repo['member-data/tla-snapshot/current.json'];
    const vp = { 'PAID-A': ['g1', 600], 'PAID-B': ['g2', 399], 'PAID-EMPTY': ['g5', 1], 'OFF-LIST': ['g7', 8], 'NEWCOMER': ['g8', 2] };
    for (const p of S.pools) { p.gauge_pool_id = vp[p.name][0]; p.voting_power = { vp_human: vp[p.name][1] * 0.9, fixed_human: vp[p.name][1] * 0.1, total_human: vp[p.name][1] }; }
    S.pools.push({ name: 'PAID-P', bucket: 'project', status: 'active', gauge_whitelisted: true, gauge_pool_id: 'g3', staked_in_tla_usd: null, amp_lp: null, voting_power: { vp_human: 1795.5, fixed_human: 199.5, total_human: 1995 }, rewards: { source: 'chain_distributions_current', annual_emissions_luna: 0, distribution_share_of_bucket: 1 } });
    S.capturedAt = gen; S.epoch = { currentEpoch: 50, epochStartedAt: '2026-07-13T00:00:00.000Z' };
    S.buckets = { stable: { bucket_vp_total_human: 1010, reward_list_vp_total_human: 1002, off_list_vp_total_human: 8 }, project: { bucket_vp_total_human: 1995, reward_list_vp_total_human: 1995, off_list_vp_total_human: 0 } };
    repo['token-catalog/snapshots/current.json'].meta.epoch = 50;
    return repo;
}
// fix the healthy fixture note above: NOT-TLA pool must satisfy INV2
function fixNotTla(repo) { repo['dex-data/astroport/snapshots/current.json'].pools[2].raw.staked_liquidity_usd = 5; return repo; }

(async () => {
    console.log('— R1: all-ok pass —');
    REPO = fixNotTla(healthyRepo()); WRITES = {};
    let out = await M.run();
    check('R1 overall ok — every check answers (1.1.2: no check is left permanently skipped)', out.meta.status === 'ok', out.meta.status);
    for (const k of ['bucket_vp_consistency', 'staked_le_depth', 'distribution_fractions_sum', 'bucket_label_agreement', 'heartbeat_freshness', 'identity_resolution', 'nft_listings_reconcile', 'reward_list_valued', 'rewards_sum_to_emission', 'pnl_integrity'])
        check(`R1 ${k} ok`, out.invariants[k].status === 'ok', out.invariants[k]);
    { const m = out.invariants.nft_listings_reconcile.measured;
      check('R1 INV8 fold: only #2 open on aDAO (delisted, sold, transferred and superseded rows closed/ignored); by_venue both sides {bbl:1}', m.adao.ledger_open === 1 && m.adao.inventory_listed === 1 && JSON.stringify(m.adao.by_venue) === JSON.stringify({ ledger: { bbl: 1 }, inventory: { bbl: 1 } }), m.adao);
      check('R1 INV8 PL: the chain-only #2124 listing is open in the ledger AND in the inventory (D.2 completion) → ok', m['pixel-lions'].status === 'ok' && m['pixel-lions'].ledger_open === 1, m['pixel-lions']);
      check('R1 INV8 reads the ledger + inventory from nft-collections, tenants from tla-core', REPO_HITS['adao/ledger/2026/07.json'] === 'thealliancedao/nft-collections' && REPO_HITS['pixel-lions/snapshots/nfts.json'] === 'thealliancedao/nft-collections' && REPO_HITS['docs/curated/tenants.json'] === 'thealliancedao/tla-core', [REPO_HITS['adao/ledger/2026/07.json'], REPO_HITS['docs/curated/tenants.json']]); }
    { const t = out.invariants.tribute_stream_coverage;
      check('R1 tribute (1.1.2): read from the bribe-state heartbeat in the product\'s own shape — round 49, 2 tokens with a figure (the events-only one has none), lowest 100 %, first observation', t.status === 'ok' && /round 49: 2 token\(s\), lowest coverage 100%/.test(t.detail) && /first observation/.test(t.detail) && t.measured.per_denom['native:uluna'] === 1.1684 && !('native:ibc/EVT' in t.measured.per_denom), t); }
    check('R1 INV1 measured rows carry both sides', Array.isArray(out.invariants.bucket_vp_consistency.measured) && out.invariants.bucket_vp_consistency.measured[0].catalog_active_sum_vp > 0);
    { const r = out.invariants.bucket_vp_consistency, st = r.measured.find(x => x.bucket === 'stable');
      check('R1 INV1 (1.1.1) like for like: stable members 1000 vs 1010 votes in the gauge (−0.99 %), 8 of them off the list; paid 1000 = 1000; the same 4 paid pools', st.gauge_votes_vp === 1010 && st.off_list_vp === 8 && st.member_vs_gauge_pct === -0.99 && st.snapshot_active_sum_vp === 1000 && st.paid_diff_pct === 0 && /the same 4 paid pools in both/.test(r.detail), r); }
    check('R1 INV7 counts inactive-unresolved pool', out.invariants.identity_resolution.measured.unresolved_pools === 1 && out.invariants.identity_resolution.measured.tokens_without_identity === 1, out.invariants.identity_resolution.measured);
    check('R1 current.json written', WRITES['system-health/current.json'] === 1);
    check('R1 history appended', REPO['system-health/history/2026/07.json'].runs.length === 1);
    check('R1 heartbeat written', REPO['system-health/heartbeat.json'].version.includes('system-health'));
    check('R1 one-off exempt', JSON.stringify(out.invariants.heartbeat_freshness.measured).includes('exempt (one-off)'));
    // 1.0.5: the three nft-collections ledger crons are rows, judged fresh, and READ FROM nft-collections (not tla-core)
    { const rows = out.invariants.heartbeat_freshness.measured; const names = rows.map(r => r.product);
      check('R1.5 nft-ledger rows present ×3', ['nft-ledger-adao', 'nft-ledger-pixel-lions', 'nft-ledger-tla-locks'].every(n => names.includes(n)), names);
      check('R1.5 nft-ledger rows fresh', rows.filter(r => r.product.startsWith('nft-ledger-')).every(r => r.status === 'fresh'), rows.filter(r => r.product.startsWith('nft-ledger-')));
      check('R1.5 nft-ledger read from nft-collections', REPO_HITS['pixel-lions/nft-flows/heartbeat.json'] === 'thealliancedao/nft-collections' && REPO_HITS['adao/nft-flows/heartbeat.json'] === 'thealliancedao/nft-collections', REPO_HITS['pixel-lions/nft-flows/heartbeat.json']);
      check('R1.5 tla-core rows still read from tla-core', REPO_HITS['token-catalog/snapshots/heartbeat.json'] === 'thealliancedao/tla-core', REPO_HITS['token-catalog/snapshots/heartbeat.json']);
      check('R1.6 aDAO product heartbeats read from nft-collections/adao', ['adao/snapshots/heartbeat.json', 'adao/flows/heartbeat.json', 'adao/provenance/heartbeat.json'].every(p => REPO_HITS[p] === 'thealliancedao/nft-collections'), REPO_HITS);
      check('R1.6 no read of tla-core/nfts/adao', !Object.keys(REPO_HITS).some(p => p.startsWith('nfts/adao/')), Object.keys(REPO_HITS).filter(p => p.startsWith('nfts/'))); }

    console.log('— R2: one violation per invariant —');
    // INV1: members' stable votes 1000 vs 1010 in the gauge is ok; bump the members to 1200 (they would claim 18.8 % more votes than the gauge holds)
    REPO['member-data/snapshots/current.json'].system.vp_voting_per_bucket.stable = 1200;
    // INV2: staked > tvl
    REPO['dex-data/astroport/snapshots/current.json'].pools[0].raw.staked_liquidity_usd = 150;
    // INV3: break a fraction
    REPO['token-catalog/snapshots/current.json'].pools[1].distribution_pct = 0.35;
    // INV5: catalog says project for pairA while dex says stable
    REPO['token-catalog/snapshots/current.json'].pools[0].bucket = 'project';
    // INV6: stale product
    REPO['token-catalog/snapshots/heartbeat.json'].capturedAt = '2026-07-15T00:00:00Z';   // 36h > 6h
    // 1.0.5: a collection cron that stops (heartbeat absent — the exact 2026-09-12 failure: services misconfigured to another slug never wrote one) must be listed
    delete REPO['tla-locks/nft-flows/heartbeat.json'];
    out = await M.run();
    check('R2 INV1 violation: members exceed the gauge (stable, 18.81 %)', out.invariants.bucket_vp_consistency.status === 'violation' && /stable: members' votes exceed the votes in the gauge by 18\.81%/.test(out.invariants.bucket_vp_consistency.detail), out.invariants.bucket_vp_consistency);
    check('R2 INV2 violation lists pool', out.invariants.staked_le_depth.status === 'violation' && out.invariants.staked_le_depth.measured[0].pool === 'P1');
    check('R2 INV3 violation names bucket', out.invariants.distribution_fractions_sum.status === 'violation' && 'stable' in out.invariants.distribution_fractions_sum.measured);
    check('R2 INV5 violation carries both stamps', out.invariants.bucket_label_agreement.status === 'violation' && out.invariants.bucket_label_agreement.measured[0].catalog_as_of, out.invariants.bucket_label_agreement.measured);
    check('R2 INV6 violation lists stale product', out.invariants.heartbeat_freshness.status === 'violation' && JSON.stringify(out.invariants.heartbeat_freshness.measured.stale).includes('token-catalog'));
    check('R2.5 INV6 absent collection heartbeat listed', JSON.stringify(out.invariants.heartbeat_freshness.measured.stale).includes('"product":"nft-ledger-tla-locks","reason":"file absent"'), out.invariants.heartbeat_freshness.measured.stale);
    check('R2 overall = violation', out.meta.status === 'violation');
    check('R2 history now 2 runs (never-shrink)', REPO['system-health/history/2026/07.json'].runs.length === 2);

    console.log('— R2.7: FRESH heartbeat with status failed/error is a violation (1.0.7) — the 2026-09-13 tla-locks case —');
    REPO = fixNotTla(healthyRepo());
    REPO['tla-locks/nft-flows/heartbeat.json'] = { ran_at: '2026-07-16T11:44:00Z', status: 'failed', cursor: 1 };   // 16 min old, green by age
    REPO['tla-voting/events/heartbeat.json']   = { capturedAt: '2026-07-16T11:00:00Z', status: 'error' };            // priors refusal shape
    REPO['dex-data/astroport/epochs/heartbeat.json'].status = 'partial';                                              // completed with issues — NOT a violation
    REPO['adao/nft-flows/heartbeat.json'].status = 'degraded';
    REPO['adao/provenance/heartbeat.json'].status = 'failed';                                                         // one-off stays exempt
    out = await M.run();
    { const inv = out.invariants.heartbeat_freshness; const st = JSON.stringify(inv.measured.stale); const rows = inv.measured.all;
      const row = p => rows.find(r => r.product === p);
      check('R2.7 INV6 violation on a fresh heartbeat with status failed', inv.status === 'violation' && st.includes('"product":"nft-ledger-tla-locks","reason":"heartbeat status failed (fresh — job ran and failed)"'), inv.measured.stale);
      check('R2.7 INV6 status error also raised', st.includes('"product":"tla-voting","reason":"heartbeat status error (fresh — job ran and failed)"'), inv.measured.stale);
      check('R2.7 row status FAILED carries hb_status + age', row('nft-ledger-tla-locks').status === 'FAILED' && row('nft-ledger-tla-locks').hb_status === 'failed' && row('nft-ledger-tla-locks').age_h < 1, row('nft-ledger-tla-locks'));
      check('R2.7 exactly two failed products, nothing else raised', inv.measured.stale.length === 2, inv.measured.stale);
      check('R2.7 partial/degraded are surfaced in the row but NOT violations', row('dex-astroport-series').status === 'fresh' && row('dex-astroport-series').hb_status === 'partial' && row('nft-ledger-adao').status === 'fresh' && row('nft-ledger-adao').hb_status === 'degraded', [row('dex-astroport-series'), row('nft-ledger-adao')]);
      check('R2.7 one-off with status failed stays exempt (reported, not raised)', row('nfts-provenance').status === 'exempt (one-off)' && row('nfts-provenance').hb_status === 'failed', row('nfts-provenance'));
      check('R2.7 every non-day-key row carries hb_status', rows.filter(r => r.product !== 'price-history' && r.last).every(r => 'hb_status' in r), rows.filter(r => !('hb_status' in r)).map(r => r.product));
      check('R2.7 overall = violation', out.meta.status === 'violation'); }

    console.log('— R2.9 (1.0.8, B.5): price-history WRITER heartbeat — failed append raised within the hour, day key untouched —');
    REPO = fixNotTla(healthyRepo());
    REPO['price-history/heartbeat.json'] = { product: 'price-history', cron: 'token-catalog', capturedAt: '2026-07-16T11:40:00Z', status: 'failed', reason: 'GitHub PUT price-history/2026/07.json: 500', tokens_appended: 0 };
    out = await M.run();
    { const inv = out.invariants.heartbeat_freshness; const rows = inv.measured.all; const row = p => rows.find(r => r.product === p);
      check('R2.9 writer row raised: status failed, fresh by age', inv.status === 'violation' && row('price-history-writer').status === 'FAILED' && row('price-history-writer').hb_status === 'failed' && row('price-history-writer').age_h < 1, row('price-history-writer'));
      check('R2.9 day-key row still fresh (data is 26h old, band 50h)', row('price-history').status === 'fresh', row('price-history'));
      check('R2.9 only the writer is listed', inv.measured.stale.length === 1 && inv.measured.stale[0].product === 'price-history-writer', inv.measured.stale); }
    REPO = fixNotTla(healthyRepo()); delete REPO['price-history/heartbeat.json'];
    out = await M.run();
    check('R2.9 writer heartbeat absent → listed (the pre-1.0.8 fossil state must not pass silently)', JSON.stringify(out.invariants.heartbeat_freshness.measured.stale).includes('"product":"price-history-writer","reason":"file absent"'));

    console.log('— R2.8: stale AND failed → one entry, reason names the status —');
    REPO = fixNotTla(healthyRepo());
    REPO['tla-locks/nft-flows/heartbeat.json'] = { ran_at: '2026-07-14T11:44:00Z', status: 'failed', cursor: 1 };   // 48h old and failed
    out = await M.run();
    { const st = out.invariants.heartbeat_freshness.measured.stale.filter(s => s.product === 'nft-ledger-tla-locks');
      check('R2.8 single entry, reason = heartbeat status failed (no fresh tag), age carried', st.length === 1 && st[0].reason === 'heartbeat status failed' && st[0].age_h > 6, st); }

    console.log('— R3: like-for-like skip + missing-input honesty —');
    REPO = fixNotTla(healthyRepo());
    REPO['member-data/snapshots/current.json'].meta.generated_at = '2026-07-15T23:00:00Z';   // different DAY
    delete REPO['token-catalog/snapshots/current.json'];                                     // catalog missing entirely
    delete REPO['dex-data/astroport/snapshots/current.json'];
    out = await M.run();
    check('R3 INV1 skipped (catalog absent)', out.invariants.bucket_vp_consistency.status === 'skipped');
    check('R3 INV3 skipped + declared', out.invariants.distribution_fractions_sum.status === 'skipped' && /absent/.test(out.invariants.distribution_fractions_sum.detail));
    check('R3 INV2 skipped (no dex)', out.invariants.staked_le_depth.status === 'skipped');
    check('R3 INV5 skipped', out.invariants.bucket_label_agreement.status === 'skipped');
    check('R3 no crash, overall violation (catalog heartbeat present but current absent → freshness still evaluates)', ['violation', 'skipped'].includes(out.meta.status));

    console.log('— R3b: same-epoch different-day skip (addendum) —');
    REPO = fixNotTla(healthyRepo());
    REPO['member-data/snapshots/current.json'].meta.generated_at = '2026-07-15T23:59:00Z';
    out = await M.run();
    check('R3b INV1 skipped on day mismatch', out.invariants.bucket_vp_consistency.status === 'skipped' && /same day/.test(out.invariants.bucket_vp_consistency.detail));

    console.log('— R4: price-history day-key freshness —');
    REPO = fixNotTla(healthyRepo());
    REPO['price-history/2026/07.json'].days = { '2026-07-10': {} };   // 6 days old > 50h
    out = await M.run();
    check('R4 price-history stale via day key', out.invariants.heartbeat_freshness.status === 'violation' && JSON.stringify(out.invariants.heartbeat_freshness.measured.stale).includes('price-history'));

    console.log('— R4b: capa-supply row (2026-08-24) —');
    REPO = fixNotTla(healthyRepo());
    REPO['token-catalog/supply/capa/current.json'].capturedAt = '2026-07-15T12:00:00Z';   // 24h > 12h
    out = await M.run();
    check('R4b capa-supply stale via its own capturedAt (12h band)', out.invariants.heartbeat_freshness.status === 'violation' && JSON.stringify(out.invariants.heartbeat_freshness.measured.stale).includes('capa-supply'));

    console.log('— R4c: fuel-supply row (2026-08-24) —');
    REPO = fixNotTla(healthyRepo());
    delete REPO['token-catalog/supply/fuel/current.json'];   // absent product must show, not vanish
    out = await M.run();
    check('R4c fuel-supply absent → listed stale', out.invariants.heartbeat_freshness.status === 'violation' && JSON.stringify(out.invariants.heartbeat_freshness.measured.stale).includes('fuel-supply'));

    console.log('— R5: coverage drop alarm (1.1.2: the bribe-state heartbeat, in the shape tla-voting writes) —');
    const BS = 'tla-voting/bribe-state/heartbeat.json'; const capOf = (period, uluna, astro) => ({ period, denom_count: 2, mean_coverage_pct: (uluna + astro) / 2, denoms: { 'native:uluna': { state: '100', events: String(uluna), coverage_pct: uluna }, 'cw20:astro': { state: '100', events: String(astro), coverage_pct: astro } } });
    REPO = fixNotTla(healthyRepo());
    REPO[BS].bribe_capture = capOf(49, 95, 90);
    out = await M.run();   // first observation — baseline
    check('R5a first observation ok (no baseline)', out.invariants.tribute_stream_coverage.status === 'ok' && /first observation/.test(out.invariants.tribute_stream_coverage.detail));
    out = await M.run();   // the same harvest an hour later
    check('R5a2 the same harvest an hour later: ok, and says it is the same harvest', out.invariants.tribute_stream_coverage.status === 'ok' && /same harvest as the previous run/.test(out.invariants.tribute_stream_coverage.detail), out.invariants.tribute_stream_coverage);
    REPO[BS].bribe_capture = capOf(50, 70, 90);   // next round: uluna dropped
    out = await M.run();
    check('R5b drop → violation with denom named', out.invariants.tribute_stream_coverage.status === 'violation' && out.invariants.tribute_stream_coverage.measured.drops[0].denom === 'native:uluna' && /native:uluna 95% → 70%/.test(out.invariants.tribute_stream_coverage.detail), out.invariants.tribute_stream_coverage);
    REPO[BS].bribe_capture = capOf(51, 96, 90);   // recovered/increase
    out = await M.run();
    check('R5c increase → ok, no drops', out.invariants.tribute_stream_coverage.status === 'ok' && /no drops/.test(out.invariants.tribute_stream_coverage.detail));
    REPO[BS].bribe_capture = capOf(52, 100, 90); out = await M.run();
    REPO[BS].bribe_capture = capOf(53, 116.84, 90); out = await M.run();   // events add up to more than the state
    REPO[BS].bribe_capture = capOf(54, 100, 90); out = await M.run();      // back to exactly the state: 117 % → 100 % is not a drop
    check('R5d 117 % → 100 % is not a drop (seen in full both times)', out.invariants.tribute_stream_coverage.status === 'ok' && /no drops/.test(out.invariants.tribute_stream_coverage.detail), out.invariants.tribute_stream_coverage);
    // the block only in the hourly events heartbeat (the run that harvested) is still read
    REPO = fixNotTla(healthyRepo()); delete REPO[BS].bribe_capture; REPO['tla-voting/events/heartbeat.json'].bribe_capture = capOf(49, 100, 100);
    out = await M.run();
    check('R5e capture present only in the events heartbeat is read too', out.invariants.tribute_stream_coverage.status === 'ok' && out.invariants.tribute_stream_coverage.measured.period === 49);
    // neither heartbeat carries it: skipped, and the detail says where it is written
    REPO = fixNotTla(healthyRepo()); delete REPO[BS].bribe_capture;
    out = await M.run();
    check('R5f no capture anywhere → skipped + declared', out.invariants.tribute_stream_coverage.status === 'skipped' && /written at the first harvest after an epoch flip/.test(out.invariants.tribute_stream_coverage.detail) && out.meta.status === 'skipped');
    REPO = fixNotTla(healthyRepo()); REPO[BS].bribe_capture = capOf(49, 96, 90); out = await M.run();   // leave a baseline in place for R6

    console.log('— R6: history never-shrink guard —');
    REPO['system-health/history/2026/07.json'].runs.length ? null : null;
    const runsBefore = REPO['system-health/history/2026/07.json'].runs.length;
    out = await M.run();
    check('R6 append exactly one', REPO['system-health/history/2026/07.json'].runs.length === runsBefore + 1);
    check('R6 run summary carries coverage baseline ({ period, per_denom } as fractions)', REPO['system-health/history/2026/07.json'].runs.at(-1).tribute_coverage.per_denom['native:uluna'] === 0.96 && REPO['system-health/history/2026/07.json'].runs.at(-1).tribute_coverage.period === 49);

    console.log('— R8: INV8 nft_listings_reconcile (1.0.9) —');
    REPO = fixNotTla(healthyRepo());
    REPO['pixel-lions/snapshots/nfts.json'] = { capturedAt: '2026-07-16T11:15:00Z', records: [{ id: '2124', listing: { marketplace_owner_no_listing: true } }] };   // the pre-D.2 state read: blind to the chain-only listing
    out = await M.run();
    check('R8a a listing open in the ledger that the inventory cannot see → violation naming the token, venue and when it was listed', out.invariants.nft_listings_reconcile.status === 'violation' && out.invariants.nft_listings_reconcile.measured['pixel-lions'].ledger_open_not_in_inventory[0].token_id === '2124' && /pixel-lions: 1 open in ledger, not in inventory/.test(out.invariants.nft_listings_reconcile.detail), out.invariants.nft_listings_reconcile.detail);
    check('R8a aDAO still ok inside the same run (per-collection verdicts)', out.invariants.nft_listings_reconcile.measured.adao.status === 'ok');
    REPO = fixNotTla(healthyRepo());
    REPO['adao/snapshots/nfts.json'].records[0].listing = { marketplace: 'Boost', source: 'chain' };   // #1 listed 20 min ago on Boost; the hourly ledger has not seen it
    REPO['adao/snapshots/listing-first-seen.json'].entries['Boost:5'] = { token_id: '1', first_seen_at: '2026-07-16T11:40:00Z' };
    out = await M.run();
    check('R8b a listing the inventory saw inside the lag window (first_seen 20 min ago) → recent_unconfirmed, NOT a violation', out.invariants.nft_listings_reconcile.status === 'ok' && out.invariants.nft_listings_reconcile.measured.adao.recent_unconfirmed.length === 1 && out.invariants.nft_listings_reconcile.measured.adao.recent_unconfirmed[0].token_id === '1', out.invariants.nft_listings_reconcile.measured.adao);
    REPO['adao/snapshots/listing-first-seen.json'].entries['Boost:5'].first_seen_at = '2026-07-15T11:40:00Z';   // a day old: the ledger should have it by now
    out = await M.run();
    check('R8c the same listing a day old → violation (inventory_listed_not_open_in_ledger)', out.invariants.nft_listings_reconcile.status === 'violation' && out.invariants.nft_listings_reconcile.measured.adao.inventory_listed_not_open_in_ledger[0].token_id === '1');
    REPO = fixNotTla(healthyRepo());
    REPO['adao/snapshots/nfts.json'].records[1].listing = { marketplace: 'Atrium', source: 'chain' };   // #2 open on bbl per the ledger, Atrium per the inventory
    out = await M.run();
    check('R8d venue disagreement → violation with both venues named', out.invariants.nft_listings_reconcile.status === 'violation' && out.invariants.nft_listings_reconcile.measured.adao.venue_disagreements[0].ledger_venue === 'bbl' && out.invariants.nft_listings_reconcile.measured.adao.venue_disagreements[0].inventory_venue === 'atrium');
    REPO = fixNotTla(healthyRepo()); delete REPO['docs/curated/tenants.json'];
    out = await M.run();
    check('R8e tenants.json absent → INV8 skipped and says why (never a verdict without the collection list)', out.invariants.nft_listings_reconcile.status === 'skipped' && /tenants\.json/.test(out.invariants.nft_listings_reconcile.detail));
    REPO = fixNotTla(healthyRepo()); delete REPO['pixel-lions/ledger/index.json'];
    out = await M.run();
    check('R8f one collection without a ledger → that collection skipped with a reason, the other still judged', out.invariants.nft_listings_reconcile.measured['pixel-lions'].status === 'skipped' && out.invariants.nft_listings_reconcile.measured.adao.status === 'ok' && out.invariants.nft_listings_reconcile.status === 'ok');
    check('R8 PL inventory heartbeat row present in FRESHNESS_MAP (org-nft-inventory-liondao)', M.FRESHNESS_MAP.some(r => r.product === 'nft-inventory-pixel-lions' && r.repo === 'thealliancedao/nft-collections'));
    // 1.0.10: the tenant-keyed positions cron is a row, read from dao-originations, judged fresh on the real heartbeat shape,
    // and FAILED (not green) when its own status says so — the 1.0.7 rule extends to it unchanged.
    check('R9 ally-positions-liondao row present in FRESHNESS_MAP (dao-originations)', M.FRESHNESS_MAP.some(r => r.product === 'ally-positions-liondao' && r.repo === 'thealliancedao/dao-originations' && r.path === 'lion-dao/positions/heartbeat.json'));
    { REPO = fixNotTla(healthyRepo()); WRITES = {}; REPO_HITS = {};
      const out = await M.run();
      const row = out.invariants.heartbeat_freshness.measured.find(r => r.product === 'ally-positions-liondao');
      check('R9 ally-positions-liondao judged fresh from capturedAt', row && row.status === 'fresh' && row.hb_status === 'ok', row);
      check('R9 ally-positions-liondao read from dao-originations', REPO_HITS['lion-dao/positions/heartbeat.json'] === 'thealliancedao/dao-originations', REPO_HITS['lion-dao/positions/heartbeat.json']);
      REPO['lion-dao/positions/heartbeat.json'] = { product: 'lion-dao/positions', engine: '1.0.2', status: 'failed', capturedAt: '2026-07-16T11:20:00Z', wallets: 5, errors: 3 };
      const out2 = await M.run();
      const inv2 = out2.invariants.heartbeat_freshness; const row2 = inv2.measured.all.find(r => r.product === 'ally-positions-liondao');
      check('R9 ally-positions-liondao fresh-but-failed → FAILED + raised', inv2.status === 'violation' && row2 && row2.status === 'FAILED' && row2.hb_status === 'failed' && inv2.measured.stale.length === 1 && inv2.measured.stale[0].product === 'ally-positions-liondao', row2); }
    // 1.0.11: the daily holders cron is a row of its own (30 h window), judged on its heartbeat; a `failed` status (no product written) is FAILED
    check('R10 ally-holders-liondao row present in FRESHNESS_MAP (daily, dao-originations)', M.FRESHNESS_MAP.some(r => r.product === 'ally-holders-liondao' && r.repo === 'thealliancedao/dao-originations' && r.path === 'lion-dao/holders-heartbeat.json' && r.max_age_h === 30));
    { REPO = fixNotTla(healthyRepo()); WRITES = {}; REPO_HITS = {};
      const out = await M.run(); const row = out.invariants.heartbeat_freshness.measured.find(r => r.product === 'ally-holders-liondao');
      check('R10 ally-holders-liondao judged fresh from capturedAt (26 h old, inside 30)', row && row.status === 'fresh' && row.hb_status === 'ok', row);
      REPO['lion-dao/holders-heartbeat.json'] = { product: 'lion-dao/holders', engine: '1.0.0', status: 'failed', capturedAt: '2026-07-16T03:40:00Z', written: [], errors: [{ product: 'burn/holders', reason: 'all_accounts read failed on page 3' }] };
      const out2 = await M.run(); const inv2 = out2.invariants.heartbeat_freshness; const row2 = inv2.measured.all.find(r => r.product === 'ally-holders-liondao');
      check('R10 ally-holders-liondao fresh-but-failed → FAILED + raised', inv2.status === 'violation' && row2 && row2.status === 'FAILED' && row2.hb_status === 'failed' && inv2.measured.stale.some(r => r.product === 'ally-holders-liondao'), row2); }

    console.log('— R9 (1.1.0): reward_list_valued · rewards_sum_to_emission · pnl_integrity · the dust floor · the new freshness rows —');
    REPO = fixNotTla(healthyRepo()); WRITES = {};
    out = await M.run();
    { const v = out.invariants.reward_list_valued, r = out.invariants.rewards_sum_to_emission, q = out.invariants.pnl_integrity;
      check('R9 healthy: 4 paid pools, the two with nothing staked are not "unvalued"; totals agree within 5 % (1000 vs 1001)', v.status === 'ok' && v.measured.paid_pools === 4 && v.measured.unvalued.length === 0 && v.measured.diff_pct < 1, v);
      check('R9 healthy: per-pool emissions = 100.3 % of the emission (the newcomer\'s estimate is the hair over); the off-list pool carries none', r.status === 'ok' && Math.abs(r.measured.per_pool_sum_over_emission - 1.003) < 1e-9 && r.measured.off_list_but_active_or_paid.length === 0, r);
      check('R9 healthy: P&L — no fault; the 7 positions with no measured cost are carried as a number', q.status === 'ok' && q.measured.counts.cost_not_measured === 7 && /7 with no measured cost/.test(q.detail), q);
      const rows = out.invariants.heartbeat_freshness.measured, names = rows.map(x => x.product);
      check('R9 the nine page-feeding products are watched and fresh', ['tla-snapshot', 'tla-participants', 'adao-positions', 'member-holdings', 'eris-apr', 'lp-grades', 'network-and-prices', 'tla-flows-events', 'tla-flows-pnl'].every(n => names.includes(n) && rows.find(x => x.product === n).status === 'fresh'), rows.filter(x => /tla-|eris|lp-grades|network|holdings|positions/.test(x.product))); }
    // the 2026-11 case, as it stood: one side of the largest paid pool unnamed → no value; nine pools off a list still active with an estimate
    REPO = fixNotTla(healthyRepo());
    { const P = REPO['member-data/tla-snapshot/current.json'].pools;
      P[0].staked_in_tla_usd = null; P[0].lp_health.asset_1.symbol = null;                                   // PAID-A: staked LP, no dollar value
      P[3].status = 'active'; P[3].rewards = { source: 'gauge_infos_next_fallback', annual_emissions_luna: 120 }; delete P[3].status_reason; }   // OFF-LIST: active with an estimate
    REPO['tla-flows/pnl/integrity.json'].checks.foreign_tokens_in_cost = { severity: 'fault', count: 916, status: 'fault' };
    out = await M.run();
    { const v = out.invariants.reward_list_valued, r = out.invariants.rewards_sum_to_emission, q = out.invariants.pnl_integrity;
      check('R9 a paid pool with a stake and no dollar value is a violation that names it and counts its unnamed side', v.status === 'violation' && /PAID-A/.test(v.detail) && v.measured.unvalued[0].unnamed_sides === 1, v);
      check('R9 a pool off its gauge\'s list that is active or carries emissions is a violation that names it', r.status === 'violation' && /OFF-LIST/.test(r.detail) && r.measured.per_pool_sum_over_emission > 1.1, r);
      check('R9 a P&L fault count above zero is a violation ("916 × foreign_tokens_in_cost")', q.status === 'violation' && /916 × foreign_tokens_in_cost/.test(q.detail), q);
      check('R9 overall = violation', out.meta.status === 'violation'); }
    // valued, but the two valuations disagree by more than 5 %
    REPO = fixNotTla(healthyRepo()); REPO['dex-data/eris-apr/current.json'].pools[0].tla_staked_usd = 900;
    out = await M.run();
    check('R9 snapshot vs the Eris-method feed more than 5 % apart is a violation with both totals', out.invariants.reward_list_valued.status === 'violation' && out.invariants.reward_list_valued.measured.tla_staked_usd_snapshot === 1000 && out.invariants.reward_list_valued.measured.tla_staked_usd_eris_method === 1298, out.invariants.reward_list_valued);
    // an earlier build's snapshot (no gauge_whitelisted) whose estimates run over: the sum alone raises it
    REPO = fixNotTla(healthyRepo());
    { const P = REPO['member-data/tla-snapshot/current.json'].pools; for (const x of P) delete x.gauge_whitelisted; P[3].status = 'active'; P[3].rewards = { source: 'gauge_infos_next_fallback', annual_emissions_luna: 120 }; }
    out = await M.run();
    check('R9 an earlier build\'s file: per-pool emissions at 112.3 % of the emission is a violation on the sum alone', out.invariants.rewards_sum_to_emission.status === 'violation' && /112\.3%/.test(out.invariants.rewards_sum_to_emission.detail) && out.invariants.rewards_sum_to_emission.measured.active_pools_with_unread_list === 5, out.invariants.rewards_sum_to_emission);
    console.log('— R11 (1.1.1): bucket_vp_consistency, like for like —');
    // a pool the hourly snapshot still calls active after the catalog says the chain stopped paying it (the 2026-11-24 error, seen from the other side)
    REPO = fixNotTla(healthyRepo()); REPO['token-catalog/snapshots/current.json'].pools[1].gauge_status = 'dewhitelisted';
    out = await M.run();
    { const r = out.invariants.bucket_vp_consistency;
      check('R11 active in the snapshot, not paid per the catalog → violation that names the pool', r.status === 'violation' && /active in the hourly snapshot but not paid per the catalog: PAID-B \(stable\)/.test(r.detail), r); }
    // the same disagreement in the first hours of an epoch is not raised (the distribution changes at the flip; the catalog refreshes 6-hourly)
    REPO = fixNotTla(healthyRepo()); REPO['token-catalog/snapshots/current.json'].pools[2].gauge_status = 'dewhitelisted';   // g5: 1 vote — the paid votes still agree within 5 %
    REPO['member-data/tla-snapshot/current.json'].epoch.epochStartedAt = '2026-07-16T00:00:00.000Z';
    out = await M.run();
    { const r = out.invariants.bucket_vp_consistency;
      check('R11 first 12 h of an epoch: the paid sets are not compared, and the detail says so', r.status === 'ok' && /paid sets not compared in the first 12 h of an epoch/.test(r.detail), r); }
    REPO = fixNotTla(healthyRepo()); REPO['token-catalog/snapshots/current.json'].pools[2].gauge_status = 'dewhitelisted';
    out = await M.run();
    check('R11 …and the same file later in the epoch is raised (PAID-EMPTY)', out.invariants.bucket_vp_consistency.status === 'violation' && /PAID-EMPTY \(stable\)/.test(out.invariants.bucket_vp_consistency.detail), out.invariants.bucket_vp_consistency);
    // the votes behind the paid pools: fixed counted twice in the snapshot (+10 %)
    REPO = fixNotTla(healthyRepo()); for (const x of REPO['member-data/tla-snapshot/current.json'].pools) x.voting_power.total_human = x.voting_power.total_human * 1.1;
    out = await M.run();
    check('R11 paid votes 10 % apart (a boost-or-fixed mix-up) → violation with the figure', out.invariants.bucket_vp_consistency.status === 'violation' && /stable: the votes behind the paid pools differ by 10\.00%/.test(out.invariants.bucket_vp_consistency.detail), out.invariants.bucket_vp_consistency);
    // votes in the gauge that no member accounts for: 1010 → 1200 (members 1000 = −16.67 %)
    REPO = fixNotTla(healthyRepo()); REPO['member-data/tla-snapshot/current.json'].buckets.stable.bucket_vp_total_human = 1200;
    out = await M.run();
    check('R11 16.67 % of a gauge\'s votes unaccounted for → violation', out.invariants.bucket_vp_consistency.status === 'violation' && /stable: 16\.67% of the votes in the gauge are not accounted for by any member wallet/.test(out.invariants.bucket_vp_consistency.detail), out.invariants.bucket_vp_consistency);
    // votes left on pools that earn nothing are NOT a drift any more: 300 old votes off the list, members cast them → ok
    REPO = fixNotTla(healthyRepo()); { const B = REPO['member-data/tla-snapshot/current.json'].buckets.stable; B.bucket_vp_total_human = 1302; B.off_list_vp_total_human = 300; REPO['member-data/snapshots/current.json'].system.vp_voting_per_bucket.stable = 1300; }
    out = await M.run();
    { const r = out.invariants.bucket_vp_consistency, st = r.measured.find(x => x.bucket === 'stable');
      check('R11 300 votes sitting off the reward list (23 % of the gauge) are not a violation — the old check read them as drift', r.status === 'ok' && st.off_list_vp === 300 && st.member_vs_gauge_pct === -0.15, r); }
    // an hourly snapshot from before 1.2.0 has no per-gauge totals: skipped and said so — the unlike comparison is not made
    REPO = fixNotTla(healthyRepo()); delete REPO['member-data/tla-snapshot/current.json'].buckets;
    out = await M.run();
    check('R11 a snapshot without per-gauge vote totals → skipped, never the old comparison', out.invariants.bucket_vp_consistency.status === 'skipped' && /no per-bucket vote totals/.test(out.invariants.bucket_vp_consistency.detail), out.invariants.bucket_vp_consistency);
    // missing inputs are skipped, never guessed
    REPO = fixNotTla(healthyRepo()); delete REPO['member-data/tla-snapshot/current.json']; delete REPO['tla-flows/pnl/integrity.json'];
    out = await M.run();
    check('R9 no snapshot / no integrity file → the three checks are skipped', ['reward_list_valued', 'rewards_sum_to_emission', 'pnl_integrity'].every(k => out.invariants[k].status === 'skipped'), [out.invariants.reward_list_valued.status, out.invariants.pnl_integrity.status]);
    REPO = fixNotTla(healthyRepo()); delete REPO['dex-data/eris-apr/current.json'];
    out = await M.run();
    check('R9 no Eris-method feed → valued pools still ok, and the detail says the total was not cross-checked', out.invariants.reward_list_valued.status === 'ok' && /not cross-checked/.test(out.invariants.reward_list_valued.detail));
    // the dust floor: $1 staked over $0 depth, and a label disagreement on a $0.04 pool, are listed — $80 over $10 is raised
    REPO = fixNotTla(healthyRepo());
    REPO['dex-data/astroport/snapshots/current.json'].pools.push({ pool_name: 'DUST', pool_address: 'pairD', bucket: null, tvl_usd: 0, raw: { staked_liquidity_usd: 1 } });
    REPO['token-catalog/snapshots/current.json'].pools.push({ bucket: 'stable', gauge_status: 'dewhitelisted', total_vp: '0', architecture: { pair_address: 'pairE' }, gauge_pool_id: 'g9', underlyings: ['x'] });
    REPO['dex-data/astroport/snapshots/current.json'].pools.push({ pool_name: 'DUST-LABEL', pool_address: 'pairE', bucket: 'project', tvl_usd: 2, raw: { staked_liquidity_usd: 0.04 } });
    out = await M.run();
    check('R9 dust: staked $1 > depth $0 is listed, not raised', out.invariants.staked_le_depth.status === 'ok' && out.invariants.staked_le_depth.measured.dust_ignored.length === 1 && /1 dust pool/.test(out.invariants.staked_le_depth.detail), out.invariants.staked_le_depth);
    check('R9 dust: a bucket-label disagreement on a $0.04 pool is listed, not raised', out.invariants.bucket_label_agreement.status === 'ok' && out.invariants.bucket_label_agreement.measured.dust_ignored.length === 1, out.invariants.bucket_label_agreement);
    REPO['dex-data/astroport/snapshots/current.json'].pools.push({ pool_name: 'REAL', pool_address: 'pairF', bucket: null, tvl_usd: 10, raw: { staked_liquidity_usd: 80 } });
    out = await M.run();
    check('R9 staked $80 > depth $10 is still a violation; measured stays the list of pools', out.invariants.staked_le_depth.status === 'violation' && Array.isArray(out.invariants.staked_le_depth.measured) && out.invariants.staked_le_depth.measured.length === 1 && out.invariants.staked_le_depth.measured[0].pool === 'REAL' && /1 more under \$50/.test(out.invariants.staked_le_depth.detail), out.invariants.staked_le_depth);

    console.log('— R12 (1.1.2): bucket_label_agreement — every bucket a pair is filed under; the hourly snapshot decides "dust" when the dex has no figure —');
    // a pair the catalog files under two gauges (stable, paid — and project, off the list, the LAST row): the dex label "stable" agrees
    REPO = fixNotTla(healthyRepo());
    REPO['token-catalog/snapshots/current.json'].pools.push({ bucket: 'project', gauge_status: 'dewhitelisted', total_vp: '0', architecture: { pair_address: 'pairA' }, gauge_pool_id: 'g1', underlyings: ['x'] });
    out = await M.run();
    { const v = out.invariants.bucket_label_agreement;
      check('R12 a pair filed under two buckets: the dex label agrees with one of them → ok (the old join compared against the last row only)', v.status === 'ok' && !(v.measured.dust_ignored || []).length, v); }
    // a real disagreement where the dex adapter has no stake figure
    const noFigure = (snapStake) => { REPO = fixNotTla(healthyRepo());
      REPO['token-catalog/snapshots/current.json'].pools.push({ bucket: 'stable', gauge_status: 'dewhitelisted', total_vp: '0', architecture: { pair_address: 'pairE' }, gauge_pool_id: 'g9', underlyings: ['x'] });
      REPO['dex-data/astroport/snapshots/current.json'].pools.push({ pool_name: 'NO-FIGURE', pool_address: 'pairE', bucket: 'project', tvl_usd: 2, raw: { staked_liquidity_usd: null } });
      if (snapStake !== undefined) REPO['member-data/tla-snapshot/current.json'].pools.push({ name: 'NO-FIGURE', bucket: 'project', status: 'voted_but_below_threshold', gauge_whitelisted: true, gauge_pool_id: 'g9', pool_address: 'pairE', staked_in_tla_usd: snapStake, voting_power: { vp_human: 0, fixed_human: 0, total_human: 0 }, rewards: { source: 'gauge_infos_next_fallback', annual_emissions_luna: 0 } }); };
    noFigure(0); out = await M.run();
    { const v = out.invariants.bucket_label_agreement;
      check('R12 no stake figure from the dex, $0 in the hourly snapshot → listed as dust, with where the figure came from', v.status === 'ok' && v.measured.dust_ignored.length === 1 && v.measured.dust_ignored[0].staked_from === 'tla-snapshot' && v.measured.dust_ignored[0].catalog_bucket === 'stable', v); }
    noFigure(500); out = await M.run();
    { const v = out.invariants.bucket_label_agreement;
      check('R12 …$500 in the hourly snapshot → raised', v.status === 'violation' && v.measured[0].pool === 'NO-FIGURE' && v.measured[0].staked_usd === 500, v); }
    noFigure(undefined); out = await M.run();
    { const v = out.invariants.bucket_label_agreement;
      check('R12 …no figure anywhere → raised (unknown is not dust)', v.status === 'violation' && v.measured[0].staked_usd === null && v.measured[0].staked_from === null, v); }

    console.log(`\n=== MOCK GATE: ${PASS} passed, ${FAIL} failed ===`);
    process.exit(FAIL ? 1 : 0);
})().catch(e => { console.error('GATE CRASH:', e); process.exit(1); });
