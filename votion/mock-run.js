#!/usr/bin/env node
'use strict';
// =============================================================================
// org-votion mock gate (SPEC-votion-capture D4 — binding before deploy).
// In-memory chain + repo stubs behind the T seam. Fixture shapes mirror the
// proven old cron's documented responses; live probes refine before deploy.
// =============================================================================
const M = require('./index.js');
let PASS = 0, FAIL = 0;
function check(name, cond, extra) { if (cond) { PASS++; console.log(`  ✓ ${name}`); } else { FAIL++; console.log(`  ✗ ${name}${extra ? ' — ' + JSON.stringify(extra).slice(0, 200) : ''}`); } }

// ---------------------------------------------------------------------------- fixtures
const V1 = 'terra1vault_amp_max', V2 = 'terra1vault_arb_max';
const AMPLUNA = 'terra1ecgazyd0waaj3g7l9cmy5gulhxkps2gmxu9ghducvuypjq68mq2s5lvsct';
const ARBLUNA = 'terra1se7rvuerys4kd2snt6vqswh9wugu49vhyzls8ymc02wl37g2p2ms5yz490';
let CHAIN = {};
function healthyChain() {
    return {
        codeList: { contracts: [V1, V2] },
        config: {
            [V1]: { lock_info: { cw20: AMPLUNA }, vdenom: 'factory/' + V1 + '/max/vampluna', lock_id: '101', protocol_fee: '0.1' },
            [V2]: { lock_info: { cw20: ARBLUNA }, vdenom: 'factory/' + V2 + '/max/varbluna', lock_id: '102', protocol_fee: '0.1' },
        },
        state: { [V1]: { staked: '50000000000' }, [V2]: { staked: '200000000000' } },   // 50k / 200k LST
        lock: { '101': { fixed_amount: '10000000000', voting_power: '40000000000' },     // VP = 50k (fixed+boost!)
                '102': { fixed_amount: '30000000000', voting_power: '120000000000' } },  // VP = 150k
        supply: { ['factory/' + V1 + '/max/vampluna']: '40000000000', ['factory/' + V2 + '/max/varbluna']: '160000000000' },   // rates 1.25
        gauge: {   // REAL probe-verified shape (2026-07-16)
            [V1]: { voting_power: '40000000000', fixed_amount: '10000000000', slope: '0',
                    gauge_votes: [ { gauge: 'stable', period: 193, votes: [['cw20:terra1poolA', 6000], ['cw20:terra1poolB', 4000]] } ] },
            [V2]: { voting_power: '120000000000', fixed_amount: '30000000000', slope: '0',
                    gauge_votes: [ { gauge: 'project', period: 193, votes: [['cw20:terra1poolA', 10000]] } ] },
        },
        txPages: {
            [V1]: [{ total: '2', txs: [depTx('terra1alice'), depTx('terra1bob')] }],
            [V2]: [{ total: '1', txs: [depTx('terra1carol')] }],
        },
        balances: {
            ['terra1alice|factory/' + V1 + '/max/vampluna']: '8000000000',   // 8k vtoken
            ['terra1bob|factory/' + V1 + '/max/vampluna']: '0',              // fully exited
            ['terra1carol|factory/' + V2 + '/max/varbluna']: '16000000000',  // 16k vtoken
        },
    };
}
function depTx(recipient) { return { events: [{ type: 'wasm', attributes: [{ key: 'action', value: 'votion-la/deposit' }, { key: 'recipient', value: recipient }] }] }; }

let REPO = {}, WRITES = {};
M.T.githubApiRequest = async (method, apiPath, body, accept) => {
    const m = apiPath.match(/\/contents\/([^?]+)/); const path = m && decodeURIComponent(m[1]);
    if (method === 'GET') {
        if (accept === 'application/vnd.github.raw') { if (path in REPO) return JSON.stringify(REPO[path]); const e = new Error('404'); e.statusCode = 404; throw e; }
        if (path in REPO) return { sha: 'x' }; const e = new Error('404'); e.statusCode = 404; throw e;
    }
    if (method === 'PUT') { REPO[path] = JSON.parse(Buffer.from(body.content, 'base64').toString()); WRITES[path] = (WRITES[path] || 0) + 1; return { ok: true }; }
};
M.T.lcdGet = async (path) => {
    if (path.includes(`/code/3677/contracts`)) return CHAIN.codeList;
    if (path.includes('/supply/by_denom')) { const d = decodeURIComponent(path.split('denom=')[1]); const a = CHAIN.supply[d]; return a != null ? { amount: { denom: d, amount: a } } : null; }
    if (path.includes('/cosmos/tx/v1beta1/txs')) {
        const q = decodeURIComponent(path.match(/query=([^&]+)/)[1]); const vault = q.match(/_contract_address='([^']+)'/)[1];
        const page = Number(path.match(/page=(\d+)/)[1]);
        const pages = CHAIN.txPages[vault];
        if (pages === null) return null;                        // total failure
        const p = pages[page - 1];
        if (p === undefined) return { total: pages[0] ? pages[0].total : '0', tx_responses: [] };
        if (p === null) return null;                            // this page fails
        return { total: p.total, tx_responses: p.txs };
    }
    if (path.includes('/balances/')) { const mm = path.match(/balances\/([^/]+)\/by_denom\?denom=(.+)$/); const key = mm[1] + '|' + decodeURIComponent(mm[2]); const a = CHAIN.balances[key]; if (a === null) return null; return { balance: { amount: a != null ? a : '0' } }; }
    if (path.includes('/smart/')) {
        const mm = path.match(/contract\/([^/]+)\/smart\/(.+)$/); const addr = mm[1];
        const msg = JSON.parse(Buffer.from(decodeURIComponent(mm[2]), 'base64').toString());
        if (msg.config) return CHAIN.config[addr] ? { data: CHAIN.config[addr] } : null;
        if (msg.state) return CHAIN.state[addr] ? { data: CHAIN.state[addr] } : null;
        if (msg.lock_info) { const l = CHAIN.lock[String(msg.lock_info.token_id)]; return l ? { data: l } : null; }
        if (msg.user_info) return CHAIN.gauge[msg.user_info.user] ? { data: CHAIN.gauge[msg.user_info.user] } : { data: null };
        return null;
    }
    return null;
};
let NOW = new Date('2026-07-17T02:10:00Z');
M.T.now = () => NOW;
const CATALOG = { tokens: [
    { denom: AMPLUNA, prices: { tla: { usd: 0.105, status: 'ok' } } },
    { denom: ARBLUNA, prices: { tla: { usd: null, status: 'fail' }, coingecko: { usd: 0.133, status: 'ok' } } },
] };

(async () => {
    console.log('— R1: first full run (A + B) —');
    CHAIN = healthyChain(); REPO = { 'token-catalog/snapshots/current.json': CATALOG,
             'votion/curated-holders.json': { addresses: ['terra1multisig'] } }; WRITES = {};
    CHAIN.balances['terra1multisig|factory/' + V2 + '/max/varbluna'] = '80000000000';   // 80k vtoken — the pre-retention whale
    let r = await M.run();
    check('R1 status ok', r.status === 'ok', r.errors);
    const vd = REPO['votion/snapshots/vaults.json'];
    check('R1 vaults.json: 2 vaults, chain discovery', vd.vaults.length === 2 && vd.meta.discovery_source === 'code_id_listing');
    check('R1 VP = fixed + voting_power (regression vs old bug)', vd.vaults[0].lock_vp_human === 50000 && vd.vaults[0].lock_vp_components.fixed_human === 10000);
    check('R1 exchange rate 1.25', vd.vaults[0].exchange_rate === 1.25);
    check('R1 label from vdenom path', vd.vaults[0].label === 'max/vampluna', vd.vaults[0].label);
    const roll = vd.votion_vp_now_per_pool;
    check('R1 NOW rollup: poolA = 50k*0.6 + 150k*1.0 = 180k; poolB = 20k', roll['cw20:terra1poolA'] === 180000 && roll['cw20:terra1poolB'] === 20000, roll);
    const cur = REPO['votion/snapshots/current.json'];
    check('R1 positions ok, 3 unique holders (bob exited; curated multisig found)', cur.meta.status === 'ok' && cur.totals.unique_holders === 3, cur.totals);
    check('R1 curated candidate valued in V2 (80k vtoken × 1.25 = 100k arbLUNA)', cur.vaults[1].holders.some(h => h.address === 'terra1multisig' && h.underlying_lst === 100000));
    check('R1 discovery_basis declared', /pre-retention/.test(cur.meta.discovery_basis));
    check('R1 curated zero-balance in V1 dropped silently', !cur.vaults[0].holders.some(h => h.address === 'terra1multisig'));
    const alice = cur.vaults[0].holders.find(h => h.address === 'terra1alice');
    check('R1 alice: 8k vtoken × 1.25 = 10k ampLUNA, $1050, tagged tla', alice.underlying_lst === 10000 && alice.underlying_usd === 1050 && alice.underlying_usd_price_source === 'token-catalog/tla');
    check('R1 alice implied VP = 20% share × 50k = 10k', alice.implied_vp === 10000, alice);
    const carol = cur.vaults[1].holders.find(h => h.address === 'terra1carol');
    check('R1 arbLUNA priced via coingecko fallback + tagged', carol.underlying_usd_price_source === 'token-catalog/coingecko' && carol.underlying_usd === Math.round(20000 * 0.133 * 100) / 100);
    check('R1 daily archive written', 'votion/snapshots/daily/2026-07-17.json' in REPO);
    const reg = REPO['votion/holders-registry.json'];
    check('R1 registry: bob retained though exited, totals stored', reg.vaults[V1].holders.includes('terra1bob') && reg.vaults[V1].tx_total === 2 && reg.vaults[V1].discovery_complete === true);
    check('R1 history point appended', REPO['votion/history/2026/07.json'].points.length === 1);
    check('R1 heartbeat carries branch stamps', REPO['votion/heartbeat.json'].positions_status === 'ok' && REPO['votion/heartbeat.json'].vaults_at);

    console.log('— R1b: escrow lock_info fails → VP falls back to gauge user_info —');
    CHAIN.lock['101'] = undefined; WRITES = {};
    NOW = new Date('2026-07-17T02:40:00Z');
    r = await M.run();
    const vf = REPO['votion/snapshots/vaults.json'].vaults[0];
    check('R1b VP from user_info fallback = 50k, source tagged', vf.lock_vp_human === 50000 && vf.lock_vp_components.source === 'gauge_user_info_fallback');
    CHAIN.lock['101'] = { fixed_amount: '10000000000', voting_power: '40000000000' };

    console.log('— R1c: vault with empty lock_id (never deposited) → VP 0, NO error —');
    CHAIN.config[V2].lock_id = '';
    NOW = new Date('2026-07-17T02:50:00Z');
    r = await M.run();
    const ve = REPO['votion/snapshots/vaults.json'].vaults[1];
    check('R1c empty-lock vault: VP 0, no_lock_yet, run not partial for it', ve.lock_vp_human === 0 && ve.lock_vp_components.source === 'no_lock_yet' && !r.errors.some(e => /lock_info/.test(e.where)), r.errors);
    CHAIN.config[V2].lock_id = '102';

    console.log('— R2: hourly run — B skipped as fresh, A appends —');
    NOW = new Date('2026-07-17T03:10:00Z'); WRITES = {};
    r = await M.run();
    check('R2 positions skipped', REPO['votion/heartbeat.json'].positions_status === 'skipped' && REPO['votion/heartbeat.json'].positions_at === '2026-07-17T02:10:00.000Z');
    check('R2 no current.json rewrite', !WRITES['votion/snapshots/current.json']);
    check('R2 history now 4 points (never-shrink; R1b+R1c added)', REPO['votion/history/2026/07.json'].points.length === 4);

    console.log('— R3: incremental discovery — new depositor, only delta fetched —');
    NOW = new Date('2026-07-18T02:10:00Z');
    let pagesRequested = 0;
    CHAIN.txPages[V1] = [{ total: '3', txs: [depTx('terra1dave'), depTx('terra1alice'), depTx('terra1bob')] }];
    const origLcd = M.T.lcdGet; M.T.lcdGet = async (p) => { if (p.includes('/cosmos/tx/')) pagesRequested++; return origLcd(p); };
    CHAIN.balances['terra1dave|factory/' + V1 + '/max/vampluna'] = '4000000000';
    r = await M.run();
    M.T.lcdGet = origLcd;
    check('R3 dave discovered + valued', REPO['votion/snapshots/current.json'].vaults[0].holders.some(h => h.address === 'terra1dave'));
    check('R3 registry grew to 3, total advanced', REPO['votion/holders-registry.json'].vaults[V1].holders.length === 3 && REPO['votion/holders-registry.json'].vaults[V1].tx_total === 3);
    check('R3 delta walk: 1 tx page per vault (2 total)', pagesRequested === 2, pagesRequested);

    console.log('— R4: one vault paging fails → partial, cursor NOT advanced, other vault intact —');
    NOW = new Date('2026-07-19T02:10:00Z');
    CHAIN.txPages[V1] = null;   // total failure for V1 discovery
    r = await M.run();
    const hb4 = REPO['votion/heartbeat.json'];
    check('R4 partial + error recorded', hb4.positions_status === 'partial' && hb4._errors.some(e => /tx page/.test(e.error)));
    check('R4 V1 cursor unchanged (3), holders retained', REPO['votion/holders-registry.json'].vaults[V1].tx_total === 3 && REPO['votion/holders-registry.json'].vaults[V1].holders.length === 3);
    check('R4 V1 still valued from known holders', REPO['votion/snapshots/current.json'].vaults[0].holder_count >= 2);
    check('R4 V2 intact + complete', REPO['votion/snapshots/current.json'].vaults[1].holder_discovery_complete === true);
    CHAIN.txPages[V1] = [{ total: '3', txs: [depTx('terra1dave'), depTx('terra1alice'), depTx('terra1bob')] }];

    console.log('— R5: vault-listing failure → seed fallback declared —');
    NOW = new Date('2026-07-19T03:10:00Z');
    CHAIN.codeList = null;
    CHAIN.config = Object.fromEntries(M.SEED_VAULTS.map(a => [a, null]));   // seed configs unreachable too → zero vaults
    r = await M.run().catch(e => ({ status: 'threw', msg: e.message }));
    check('R5 zero vaults → error status, never fake', r.status === 'error' || REPO['votion/heartbeat.json'].status === 'error');
    check('R5 discovery_source seed declared in vaults.json', REPO['votion/snapshots/vaults.json'].meta.discovery_source === 'seed_fallback' || REPO['votion/snapshots/vaults.json'].vaults.length === 0);

    console.log('— R6: missing price → USD null + source null, amounts intact —');
    CHAIN = healthyChain(); NOW = new Date('2026-07-20T02:10:00Z');
    REPO['token-catalog/snapshots/current.json'] = { tokens: [] };
    r = await M.run();
    const a6 = REPO['votion/snapshots/current.json'].vaults[0].holders[0];
    check('R6 amounts real, USD honestly null', a6.underlying_lst === 10000 && a6.underlying_usd === null && a6.underlying_usd_price_source === null);

    console.log('— R7: balance query failure ≠ zero balance —');
    NOW = new Date('2026-07-21T02:10:00Z');
    REPO['token-catalog/snapshots/current.json'] = CATALOG;
    CHAIN.balances[['terra1alice|factory/' + V1 + '/max/vampluna']] = null;   // read FAILS (≠ '0')
    r = await M.run();
    const v7 = REPO['votion/snapshots/current.json'].vaults[0];
    check('R7 partial + failure counted, alice NOT dropped as exited', REPO['votion/heartbeat.json'].positions_status === 'partial' && v7.balance_failures === 1 && !v7.holders.some(h => h.address === 'terra1alice'));
    check('R7 registry still holds alice', REPO['votion/holders-registry.json'].vaults[V1].holders.includes('terra1alice'));

    console.log(`\n=== MOCK GATE: ${PASS} passed, ${FAIL} failed ===`);
    process.exit(FAIL ? 1 : 0);
})().catch(e => { console.error('GATE CRASH:', e); process.exit(1); });
