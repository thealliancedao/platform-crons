// =============================================================================
// dex-data mock gate — 1.1.0 (bucket truth). File-based, stubbed network.
// Run: node mock-run.js — no env needed. Re-run after ANY main-loop change.
//
// Fixtures mirror the REAL defects found 2026-07-15 by cross-checking committed
// dex-data snapshots against token-catalog's gauge truth (join on pair):
//   LUNA-SOLID  (Astroport)  labeled stable,   gauge says project
//   USDC-USDT   (Astroport)  labeled bluechip, gauge says single (stray appearance)
//   LUNA-WHALE  (Astroport)  labeled null,     gauge says project
//   SkeletonSwap: ALL 27 gauge pools shipped bucket:null
// =============================================================================
'use strict';

let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log(`  ✓ ${msg}`); }
    else { failed++; console.log(`  ✗ FAIL ${msg}`); }
}

// ---- patch lib/fetch BEFORE any adapter require (they destructure at require)
const fetchLib = require('./lib/fetch');
const NET = { pools_getAll: null, pools_list: null, contract: null };
fetchLib.fetchJsonWithRetry = async (url) => {
    if (/pools\.getAll/.test(url)) return NET.pools_getAll();
    if (/pools_list\.json/.test(url)) return NET.pools_list();
    throw new Error(`mock: unexpected fetch ${url}`);
};
fetchLib.queryContract = async (addr, q) => NET.contract(addr, q);

const BT = require('./lib/bucket-truth');
BT.CH.queryContract = (addr, q) => NET.contract(addr, q);
const astroport = require('./dexes/astroport');
const skeletonswap = require('./dexes/skeletonswap');

const { STAKING_BUCKETS } = require('../config/contracts.js');
const A = { stable: STAKING_BUCKETS.stable, project: STAKING_BUCKETS.project, bluechip: STAKING_BUCKETS.bluechip, single: STAKING_BUCKETS.single };

// ---- the crafted chain: LP cw20s, their minter pairs, gauge classifications
const LP = {
    lunaSolidAstro: 'terra1lp_lunasolid_astro', usdcUsdtAstro: 'terra1lp_usdcusdt_astro',
    lunaWhale: 'terra1lp_lunawhale', wstethGhost: 'terra1lp_wsteth_ghost',
    lunaSolidSS: 'terra1lp_lunasolid_ss', atomLunaSS: 'terra1lp_atomluna_ss',
};
const PAIR = {
    lunaSolidAstro: 'terra1pair_lunasolid_astro', usdcUsdtAstro: 'terra1pair_usdcusdt_astro',
    lunaWhale: 'terra1pair_lunawhale', wstethGhost: 'terra1pair_wsteth_ghost',
    lunaSolidSS: 'terra1swap_lunasolid_ss', atomLunaSS: 'terra1swap_atomluna_ss',
    factoryPool: 'terra1pair_factory_native',
};
const MINTER = {
    [LP.lunaSolidAstro]: PAIR.lunaSolidAstro, [LP.usdcUsdtAstro]: PAIR.usdcUsdtAstro,
    [LP.lunaWhale]: PAIR.lunaWhale, [LP.wstethGhost]: PAIR.wstethGhost,
    [LP.lunaSolidSS]: PAIR.lunaSolidSS, [LP.atomLunaSS]: PAIR.atomLunaSS,
};
const wl = (cw20, whitelisted, config = {}) => ({ info: { cw20 }, whitelisted, config });

// details per bucket contract — the REAL shape token-catalog's stage 1b parses
const DETAILS = {
    [A.stable]:   [wl(LP.lunaSolidSS, true)],
    [A.project]:  [wl(LP.lunaSolidAstro, true), wl(LP.lunaWhale, true), { info: { native: 'factory/terra1hub/32/project/amplp' }, whitelisted: true }],
    [A.bluechip]: [wl(LP.usdcUsdtAstro, false), wl(LP.wstethGhost, false),
                   { info: { native: `factory/${PAIR.factoryPool}/astroport/share/uLP` }, whitelisted: true }],
    [A.single]:   [wl(LP.usdcUsdtAstro, true), wl(LP.atomLunaSS, true), wl('terra1lp_minterfails', true), wl('terra1vca_wbtc_receipt', true)],
};

function stubChain({ failAllDetails = false } = {}) {
    NET.contract = async (addr, q) => {
        if (q.whitelisted_asset_details) {
            if (failAllDetails) { const e = new Error('LCD 503'); throw e; }
            return DETAILS[addr] || [];
        }
        if (q.minter) {
            if (addr === 'terra1lp_minterfails') throw new Error('minter query timeout');
            const m = MINTER[addr];
            if (!m) throw new Error(`no minter for ${addr}`);
            return { minter: m };
        }
        if (q.pool) return { assets: [{ amount: '1000' }, { amount: '2000' }], total_share: '1500' };
        if (q.metrics) return CREDIA_METRICS();
        throw new Error(`mock: unexpected query ${JSON.stringify(q)}`);
    };
}

NET.pools_getAll = () => ({ result: { data: { json: [
    { poolAddress: PAIR.lunaSolidAstro, lpAddress: LP.lunaSolidAstro, name: 'SOLID - LUNA', poolType: 'xyk', poolLiquidityUsd: 10000, dayVolumeUsd: 100 },
    { poolAddress: PAIR.usdcUsdtAstro, lpAddress: LP.usdcUsdtAstro, name: 'USDC - USDT', poolType: 'stable', poolLiquidityUsd: 50000 },
    { poolAddress: PAIR.lunaWhale, lpAddress: LP.lunaWhale, name: 'WHALE - LUNA', poolType: 'xyk' },
    { poolAddress: PAIR.wstethGhost, lpAddress: LP.wstethGhost, name: 'wstETH - LUNA', poolType: 'pcl' },
    { poolAddress: PAIR.factoryPool, lpAddress: null, name: 'FACT - LUNA', poolType: 'pcl' },
    { poolAddress: 'terra1pair_not_tla', lpAddress: 'terra1lp_not_tla', name: 'MEME - LUNA', poolType: 'xyk' },
] } } });
const CREDIA_METRICS = () => ({
    total_supplied_usd: '650926.35', total_borrowed_usd: '178551.28', total_collateral_usd: '523350.05', total_reserves_usd: '149.51',
    assets: [
        { info: { native: 'ibc/8838wbtc' }, price: '64624.7', total_supplied: '288150930', total_supplied_usd: '186216.69',
          total_borrowed_usd: '10243.97', total_collateral_usd: '186216.69', utilization: '0.055', supply_apy: '0.0007', borrow_apy: '0.0138',
          proxy_addr: 'terra1proxy_wbtc', vproxy_addr: 'terra1vca_wbtc_receipt', user_wallet_balance: '123',
          state: { ltv: '0.7', liquidation_threshold: '0.72', liquidation_penalty: '0.1', take_rate: null, isolation: null } },
        { info: { native: 'factory/terra1hub/32/project/amplp' }, price: '0.287', total_supplied: '194000000', total_supplied_usd: '55820.25',
          total_borrowed_usd: '0', total_collateral_usd: '55820.25', utilization: '0', supply_apy: '0', borrow_apy: '0',
          proxy_addr: 'terra1proxy_amplp', vproxy_addr: 'terra1vca_amplp_receipt',
          state: { ltv: '0.45', take_rate: { fixed: '0.02' }, isolation: null } },
        { info: { cw20: 'terra1arbluna' }, price: '0.1395', total_supplied: '147000000', total_supplied_usd: '20535.40',
          total_borrowed_usd: '737.96', total_collateral_usd: '20535.40', utilization: '0.036', supply_apy: '0.0001', borrow_apy: '0.0045',
          proxy_addr: 'terra1proxy_other', vproxy_addr: 'terra1vca_other_receipt',
          state: { ltv: '0.7', take_rate: null, isolation: null } },
    ],
});
NET.pools_list = () => ([
    { pool_id: 'LUNA-SOLID', swap_address: PAIR.lunaSolidSS, pool_assets: [{ symbol: 'LUNA', denom: 'uluna', decimals: 6 }, { symbol: 'SOLID', denom: 'terra1solid', decimals: 6 }] },
    { pool_id: 'ATOM-LUNA', swap_address: PAIR.atomLunaSS, pool_assets: [{ symbol: 'ATOM', denom: 'ibc/atom', decimals: 6 }, { symbol: 'LUNA', denom: 'uluna', decimals: 6 }] },
    { pool_id: 'MEME-LUNA', swap_address: 'terra1swap_not_tla', pool_assets: [{ symbol: 'MEME', denom: 'terra1meme', decimals: 6 }, { symbol: 'LUNA', denom: 'uluna', decimals: 6 }] },
]);

(async () => {
    console.log('M1 — resolveBucket: the honesty rules, pure');
    {
        const r1 = BT.resolveBucket([{ bucket: 'project', whitelisted: true }]);
        assert(r1.bucket === 'project' && r1.whitelisted === true && !r1.ambiguous_buckets, 'single whitelisted appearance → that bucket, clean');
        const r2 = BT.resolveBucket([{ bucket: 'bluechip', whitelisted: false }, { bucket: 'single', whitelisted: true }]);
        assert(r2.bucket === 'single' && r2.whitelisted === true && JSON.stringify(r2.ambiguous_buckets) === '["bluechip"]',
            'whitelisted wins over dewhitelisted stray — stray DECLARED (the USDC-USDT case)');
        const r3 = BT.resolveBucket([{ bucket: 'bluechip', whitelisted: false }]);
        assert(r3.bucket === 'bluechip' && r3.whitelisted === false, 'dewhitelisted-only keeps its bucket, whitelisted:false (the ghost case)');
        const r4 = BT.resolveBucket([{ bucket: 'project', whitelisted: true }, { bucket: 'stable', whitelisted: true }]);
        assert(r4.bucket === 'stable' && JSON.stringify(r4.ambiguous_buckets) === '["project"]',
            'double-whitelisted: canonical order picks, ambiguity FLAGGED never silent');
        assert(BT.parseFactoryPair('factory/terra1pairx/astroport/share/uLP') === 'terra1pairx' && BT.parseFactoryPair('uluna') === null,
            'factory LP denom parses to pair; plain denoms do not');
    }

    console.log('\nM2 — fetchBucketTruth on the crafted chain (real defect shapes)');
    {
        stubChain();
        BT._resetForTests();
        const t = await BT.fetchBucketTruth();
        assert(t.ok && t.stats.buckets_ok === 4, 'all four bucket contracts answered');
        assert(t.byPair[PAIR.lunaSolidAstro].bucket === 'project', 'LUNA-SOLID (Astroport) → project (was mislabeled stable)');
        assert(t.byPair[PAIR.usdcUsdtAstro].bucket === 'single' && JSON.stringify(t.byPair[PAIR.usdcUsdtAstro].ambiguous_buckets) === '["bluechip"]',
            'USDC-USDT → single, bluechip stray declared (was mislabeled bluechip)');
        assert(t.byPair[PAIR.lunaWhale].bucket === 'project', 'LUNA-WHALE → project (was null)');
        assert(t.byPair[PAIR.wstethGhost].bucket === 'bluechip' && t.byPair[PAIR.wstethGhost].whitelisted === false,
            'ghost pool: gauge-registered, whitelisted:false — honest, not hidden');
        assert(t.byPair[PAIR.factoryPool].bucket === 'bluechip' && t.byPair[PAIR.factoryPool].gauge_pool_id.startsWith('native:factory/'),
            'native factory LP resolved by denom parse');
        assert(t.byPair[PAIR.lunaSolidSS].bucket === 'stable', 'SS LUNA-SOLID → stable (its own gauge asset, distinct from Astro pool)');
        assert(t.minter_errors && /minter query timeout/.test(t.minter_errors['cw20:terra1lp_minterfails']),
            'minter failure recorded per-asset, never fatal');
        assert(t.byAsset['cw20:terra1lp_minterfails'].bucket === 'single', 'unmappable asset still in byAsset — nothing dropped');
    }

    console.log('\nM3 — Astroport capture end-to-end (stubbed net): the 3 mislabels corrected');
    {
        const cap = await astroport.capture();
        const by = Object.fromEntries(cap.pools.map(p => [p.pool_address, p]));
        assert(by[PAIR.lunaSolidAstro].bucket === 'project' && by[PAIR.lunaSolidAstro].tla_relevant === true, 'LUNA-SOLID ships project');
        assert(by[PAIR.usdcUsdtAstro].bucket === 'single' && JSON.stringify(by[PAIR.usdcUsdtAstro].raw.gauge.ambiguous_buckets) === '["bluechip"]',
            'USDC-USDT ships single with the stray in raw.gauge');
        assert(by[PAIR.lunaWhale].bucket === 'project', 'LUNA-WHALE ships project');
        assert(by[PAIR.wstethGhost].bucket === 'bluechip' && by[PAIR.wstethGhost].raw.gauge.whitelisted === false, 'ghost ships bucket + whitelisted:false');
        assert(by[PAIR.factoryPool].bucket === 'bluechip', 'factory-native pool labeled via denom parse');
        assert(by['terra1pair_not_tla'].bucket === null && by['terra1pair_not_tla'].tla_relevant === false, 'non-TLA pool stays unlabeled');
        assert(cap.meta.pools_tla_relevant === 5 && /gauge truth/.test(cap.meta.bucket_source), 'meta: tla count + bucket_source declared');
        assert(cap.meta.bucket_errors === null && cap.meta.minter_errors && cap.meta.minter_errors['cw20:terra1lp_minterfails'],
            'meta: clean buckets, minter failure surfaced');
        assert(by[PAIR.lunaSolidAstro].pool_name === 'LUNA-SOLID', 'LUNA-first canonical naming intact (regression)');
    }

    console.log('\nM4 — SkeletonSwap capture: 27×null gap closed');
    {
        const cap = await skeletonswap.capture();
        const by = Object.fromEntries(cap.pools.map(p => [p.pool_address, p]));
        assert(by[PAIR.lunaSolidSS].bucket === 'stable' && by[PAIR.lunaSolidSS].tla_relevant === true, 'SS LUNA-SOLID ships stable');
        assert(by[PAIR.atomLunaSS].bucket === 'single' && by[PAIR.atomLunaSS].raw.gauge.gauge_pool_id === `cw20:${LP.atomLunaSS}`, 'SS ATOM-LUNA labeled + gauge id in raw');
        assert(by['terra1swap_not_tla'].bucket === null && by['terra1swap_not_tla'].tla_relevant === false, 'non-TLA SS pool stays unlabeled');
        assert(by[PAIR.lunaSolidSS].raw.reserve_0 === '1000' && by[PAIR.lunaSolidSS].tvl_usd === null, 'reserves + honest-null TVL untouched (regression)');
        assert(/gauge truth/.test(cap.meta.bucket_source) && cap.meta.bucket_errors === null, 'SS meta declares bucket_source');
    }

    console.log('\nM5 — total truth failure: null buckets + errors, NEVER a staked-membership guess');
    {
        stubChain({ failAllDetails: true });
        BT._resetForTests();
        const cap = await astroport.capture();
        assert(cap.pools.every(p => p.bucket === null && p.tla_relevant === false), 'all buckets null on truth failure — honest > guessed');
        assert(cap.meta.bucket_errors && Object.keys(cap.meta.bucket_errors).length === 4, 'all four bucket-contract failures recorded');
        const capSS = await skeletonswap.capture();
        assert(capSS.pools.every(p => p.bucket === null) && capSS.meta.bucket_errors, 'SS inherits the same honest failure (memoized truth)');
    }

    console.log('\nM6 — Credia lending-market adapter (1.2.0): metrics mapping + receipt-token gauge join');
    {
        stubChain();
        BT._resetForTests();
        const credia = require('./dexes/credia');
        assert(credia.enabled === true && credia.trust_start === '2026-07-16', 'credia enabled with trust_start');
        const cap = await credia.capture();
        assert(cap.pools.length === 3 && cap.meta.pools_total === 3, 'all markets captured');
        const by = Object.fromEntries(cap.pools.map(p => [p.pool_address, p]));
        const w = by['terra1vca_wbtc_receipt'];
        assert(w && w.pool_type === 'lending_market' && w.bucket === 'single' && w.tla_relevant === true
            && w.raw.bucket_joined_on === 'cw20:terra1vca_wbtc_receipt', 'wBTC market joins gauge via RECEIPT token byAsset (vcawbtc pattern)');
        assert(w.tvl_usd === 186216.69 && w.volume_24h_usd === null && w.assets[0].price_usd === null
            && w.raw.credia_price_usd === 64624.7, 'tvl=supplied USD; volume + asset price honest-null; oracle price labeled in raw');
        assert(!('user_wallet_balance' in w.raw) && !('price' in w.raw), 'session artifacts stripped from raw');
        const lp = by['terra1vca_amplp_receipt'];
        assert(lp.raw.state.take_rate && lp.raw.state.take_rate.fixed === '0.02' && lp.bucket === 'project',
            'ampLP market keeps take_rate in raw + joins its gauge bucket');
        const x = by['terra1vca_other_receipt'];
        assert(x.bucket === null && x.tla_relevant === false, 'non-gauge market stays honestly unlabeled');
        assert(cap.meta.platform.total_supplied_usd === 650926.35 && /lending markets/.test(cap.meta.source), 'platform totals + honest source label');
    }


    console.log('\nM7 — eris-apr rider (1.3.0): AUDIT §Gauge-LP-APR verbatim pipeline');
    {
        const E = require('./lib/eris-apr');
        // aprToApy unit truth: 100% nominal, daily 365.25 compounding
        assert(Math.abs(E.aprToApy(100) - 171.4570017990229) < 1e-9, 'aprToApy(100) = 171.4570018 (their compound conversion)');

        const CONTROLLER = 'terra1hfksrhchkmsj4qdq33wkksrslnfles6y2l77fmmzeep0xmq24l2smsd3lj';
        const CONN = { project: 'terra1connproject' + 'x'.repeat(24), stable: 'terra1connstable' + 'x'.repeat(25), single: 'terra1connsingle' + 'x'.repeat(25) };
        const FOREIGN = 'terra1foreignproj' + 'x'.repeat(24);
        const K = { lunaSolid: 'cw20:terra1lp_lunasolid_astro', lunaWhale: 'cw20:terra1lp_lunawhale',
                    xastro: 'cw20:terra1xastro', notake: 'cw20:terra1notake',
                    zero: 'cw20:terra1zerozero', inf: 'cw20:terra1infcase', ssPool: 'cw20:terra1lp_lunasolid_ss' };

        E.CH.lcdJson = async (path) => {
            if (path.includes('/terra/alliances')) return { alliances: [
                { denom: `factory/${CONN.project}/vt`, reward_weight: '0.025', reward_start_time: '2024-08-27T00:00:00Z', last_reward_change_time: '2024-09-01T00:00:00Z', reward_change_interval: '604800s' },
                { denom: `factory/${CONN.stable}/vt`,  reward_weight: '0.015', reward_start_time: '2024-08-27T00:00:00Z', last_reward_change_time: '2024-09-01T00:00:00Z', reward_change_interval: '604800s' },
                { denom: `factory/${CONN.single}/vt`,  reward_weight: '0.010', reward_start_time: '2024-08-27T00:00:00Z', last_reward_change_time: '2024-09-01T00:00:00Z', reward_change_interval: '604800s' },
                { denom: `factory/${FOREIGN}/vt`,      reward_weight: '0.5',   reward_start_time: '2024-01-01T00:00:00Z', last_reward_change_time: '2024-01-01T00:00:00Z', reward_change_interval: '600s' },
                { denom: 'factory/terra1notyetactive' + 'y'.repeat(20) + '/vt', reward_weight: '9', reward_start_time: '2030-01-01T00:00:00Z', last_reward_change_time: '2030-01-01T00:00:00Z', reward_change_interval: '600s' },
            ] };
            if (path.includes('/cosmos/mint/v1beta1/annual_provisions')) return { annual_provisions: '150000000000000.000000000000000000' };
            throw new Error('mock lcd: ' + path);
        };
        E.CH.queryContract = async (addr, q) => {
            if (q.config) {
                if (addr === CONN.project) return { gauge: 'project', reward_denom: 'uluna' };
                if (addr === CONN.stable)  return { gauge: 'stable',  reward_denom: 'uluna' };
                if (addr === CONN.single)  return { gauge: 'single',  reward_denom: 'uluna' };
                throw new Error('not a connector');
            }
            if (q.distributions && addr === CONTROLLER) return { distributions: [
                { gauge: 'project', assets: [
                    { asset: { cw20: 'terra1lp_lunasolid_astro' }, distribution: '0.6' },
                    { asset: { cw20: 'terra1lp_lunawhale' },      distribution: '0.4' } ] },
                { gauge: 'stable', assets: [
                    { asset: { cw20: 'terra1zerozero' },          distribution: '0' },
                    { asset: { cw20: 'terra1infcase' },           distribution: '0.1' },
                    { asset: { cw20: 'terra1lp_lunasolid_ss' },   distribution: '0.9' } ] },
                { gauge: 'single', assets: [
                    { asset: { cw20: 'terra1xastro' },            distribution: '1.0' },
                    { asset: { cw20: 'terra1notake' },            distribution: '0.2' } ] },
            ] };
            if (q.total_staked_balances) {
                if (addr === A.project) return [
                    { asset: { cw20: 'terra1lp_lunasolid_astro' }, balance: '400000000000' },
                    { asset: { cw20: 'terra1lp_lunawhale' },       balance: '100000000000' } ];
                if (addr === A.stable) return [
                    { asset: { cw20: 'terra1zerozero' }, balance: '0' },
                    { asset: { cw20: 'terra1infcase' },  balance: '0' } ];
                if (addr === A.single) return [
                    { asset: { cw20: 'terra1xastro' }, balance: '250000000000' },
                    { asset: { cw20: 'terra1notake' }, balance: '1000000000' } ];
                return [];
            }
            if (q.whitelisted_asset_details) {
                if (addr === A.project) return [
                    { info: { cw20: 'terra1lp_lunasolid_astro' }, whitelisted: true, config: { yearly_take_rate: '0.10' } },
                    { info: { cw20: 'terra1lp_lunawhale' },       whitelisted: true, config: { yearly_take_rate: '0.10' } } ];
                if (addr === A.stable) return [
                    { info: { cw20: 'terra1zerozero' }, whitelisted: true, config: { yearly_take_rate: '0.10' } },
                    { info: { cw20: 'terra1infcase' },  whitelisted: true, config: { yearly_take_rate: '0.10' } },
                    { info: { cw20: 'terra1lp_lunasolid_ss' }, whitelisted: true, config: { yearly_take_rate: '0.10' } } ];
                if (addr === A.single) return [
                    { info: { cw20: 'terra1xastro' }, whitelisted: true, config: { yearly_take_rate: '0.10' } } ];
                return [];
            }
            throw new Error('mock qc: ' + addr + ' ' + JSON.stringify(q).slice(0, 60));
        };

        const dexPools = [
            { dex: 'astroport', pool_address: 'terra1pair_lunasolid_astro', pool_name: 'LUNA-SOLID',
              tvl_usd: 1000000, lp_total_supply: '1000000000000', fee_apr: 0.85,
              assets: [ { denom: 'uluna', price_usd: 0.10, decimals: 6 }, { denom: 'terra1solid', price_usd: 0.01, decimals: 6 } ],
              raw: { gauge: { gauge_pool_id: K.lunaSolid } } },
            { dex: 'astroport', pool_address: 'terra1pair_lunawhale', pool_name: 'LUNA-WHALE',
              tvl_usd: 200000, lp_total_supply: '500000000000', fee_apr: null,
              assets: [ { denom: 'uluna', price_usd: 0.10, decimals: 6 } ],
              raw: { gauge: { gauge_pool_id: K.lunaWhale } } },
            { dex: 'skeletonswap', pool_address: 'terra1swap_lunasolid_ss', pool_name: 'LUNA-SOLID',
              tvl_usd: null, lp_total_supply: null, fee_apr: null,
              assets: [],
              raw: { gauge: { gauge_pool_id: K.ssPool } } },
        ];
        const assetPrices = { terra1xastro: { price_usd: 0.02, decimals: 6 }, terra1notake: { price_usd: 1.0, decimals: 6 } };

        const doc = await E.runErisApr(dexPools, assetPrices);
        const by = Object.fromEntries(doc.pools.map(p => [p.gauge_pool_id, p]));

        // Stage 1+2: discovery + weights
        assert(Math.abs(doc.meta.total_reward_weight - 1.55) < 1e-12, 'totalReward = Σ ACTIVE weights + 1 = 1.55 (future-start alliance excluded)');
        assert(doc.alliance.per_gauge.project && doc.alliance.per_gauge.project.connector === CONN.project
            && doc.alliance.per_gauge.single && !doc.alliance.per_gauge.foreign, 'connectors self-discovered from alliance denoms; foreign alliance rejected by config probe');
        assert(Math.abs(doc.alliance.per_gauge.project.rewards_per_year_luna - 2419354.8387096776) < 1e-4, 'project rewardsPerYear = provisions × 0.025/1.55');
        assert(doc.alliance.per_gauge.project.rewards_update === new Date(Date.parse('2024-09-01T00:00:00Z') + 604800000).toISOString(), 'rewardsUpdate = last_change + interval');

        // Stage 3+4: the full acceptance pool, every leg exact
        const ls = by[K.lunaSolid];
        assert(Math.abs(ls.incentive_apr_pct - 36.29032258064517) < 1e-9, `LUNA-SOLID incentive APR 36.2903% (got ${ls.incentive_apr_pct.toFixed(6)})`);
        assert(Math.abs(ls.tla_staked_usd - 400000) < 1e-9 && ls.tla_staked_usd_basis === 'staked_supply_ratio_x_pool_tvl', 'TLA-staked USD = supply-ratio × pool TVL (unit-free)');
        assert(Math.abs(ls.eris_apr_pct - 27.14032258064517) < 1e-9, 'linear total = incentive − take + trading (source-verbatim, NO 0.92)');
        assert(Math.abs(ls.eris_apy_pct - 30.465002564975258) < 1e-9, `displayed APY = aprToApy(incentive×0.92) + trading − take (got ${ls.eris_apy_pct.toFixed(6)})`);
        assert(ls.eris_cut_pct === 8 && ls.yearly_take_rate_pct === 10 && ls.trading_apr_pct === 0.85, 'components block published (cut 8, take 10, trading 0.85)');

        // trading ?? 0 verbatim, flagged
        const lw = by[K.lunaWhale];
        assert(Math.abs(lw.eris_apr_pct - 231.93548387096774) < 1e-9 && lw.trading_apr_pct === null
            && lw.flags && lw.flags.includes('trading_apr_assumed_zero'), 'unknown trading APR → 0 in formula (verbatim), null + flagged in components');

        // edge cases verbatim
        assert(by[K.zero].incentive_apr_pct === 0, '0 incentives / 0 staked → 0 (verbatim)');
        assert(by[K.inf].incentive_apr_pct === null && by[K.inf].flags.includes('infinite_apr_zero_tvl'), 'tvl==0 with incentives → Infinity, JSON-published null + flag');

        // honest nulls: SS pool has no TVL basis
        const ss = by[K.ssPool];
        assert(ss.tla_staked_usd === null && ss.eris_apy_pct === null && ss.flags.includes('staked_balance_unavailable') || ss.flags.includes('staked_usd_unavailable'), 'SS pool without TVL → figures null with reason, never a guess');

        // single-asset pricing path
        const xa = by[K.xastro];
        assert(Math.abs(xa.tla_staked_usd - 5000) < 1e-9 && xa.tla_staked_usd_basis === 'staked_units_x_asset_price', 'single-asset gauge entry priced via adapter asset prices');
        assert(Math.abs(xa.incentive_apr_pct - 1935.483870967742) < 1e-6, 'single-asset incentive APR exact');

        // take missing → figures null, components live
        const nt = by[K.notake];
        assert(nt.eris_apr_pct === null && nt.eris_apy_pct === null && nt.flags.includes('take_rate_unavailable')
            && Math.abs(nt.incentive_apr_pct - 1935.483870967742) < 1e-6, 'missing take rate nulls the figure WITH reason; incentive component still published');

        // dist-sum deviation reported, never normalized
        assert(doc.meta.dist_sum_deviations && Math.abs(doc.meta.dist_sum_deviations.single - 1.2) < 1e-12, 'distribution sum ≠ 1 reported (single = 1.2), raw values used verbatim');

        // idempotence of the pure compose
        const doc2 = E.composeErisApr(await E.captureInputs(E.CH), dexPools, assetPrices);
        const strip = (d) => JSON.stringify({ ...d, meta: { ...d.meta, generated_at: null } });
        assert(strip(doc) === strip(doc2), 'compose is deterministic (byte-identical sans generated_at)');

        assert(doc.meta.luna_price_used_usd === 0.10 && doc.meta.pools_fully_priced === 4, 'LUNA price from adapter assets; 4/7 pools fully priced (honest count)');
    }

    console.log('\n' + '='.repeat(60));
    console.log(failed ? `❌ mock gate: ${passed} passed, ${failed} failed` : `✅ mock gate: ${passed} passed, 0 failed`);
    process.exit(failed ? 1 : 0);
})().catch(e => { console.error('mock gate crashed:', e); process.exit(1); });
