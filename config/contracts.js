/* ============================================================================
 * config/contracts.js — THE single source of truth for structural addresses
 * ============================================================================
 *
 * These are the fixed, structural on-chain contracts the capture engine QUERIES
 * to discover the WHO (members, lock holders) and read TLA state. They change
 * almost never (only on a contract migration).
 *
 * EDIT RULE
 * ---------
 *   • This is the ONLY place a structural address is defined.
 *   • To add / change / remove one: edit it HERE, commit. Next cron run uses it.
 *   • No cron may hardcode an address literal — they all read from here
 *     (directly, or via the constants capture-engine re-exports).
 *
 * NOT here (by design):
 *   • LP / DEX pool pairs — dynamic, created/retired per epoch → dex-data domain.
 *   • Display-only labels for arbitrary addresses → tla-core/docs/curated/
 *     known_contracts.json (labels, not query targets).
 *
 * The address-catalog cron publishes this set (merged with known_contracts.json
 * labels) into tla-core/catalog/ for the site, and DRIFT-CHECKS that the two
 * agree — so a mismatch surfaces immediately instead of silently.
 * ========================================================================== */

'use strict';

// ── Core TLA contracts (DAO-agnostic) ───────────────────────────────────────
const GAUGE_CONTROLLER = {
    addr: 'terra1hfksrhchkmsj4qdq33wkksrslnfles6y2l77fmmzeep0xmq24l2smsd3lj',
    role: 'TLA amp gauges / vote controller (user_info, rebase, first_participation)',
};
const VOTING_ESCROW = {
    addr: 'terra1uqhj8agyeaz8fu6mdggfuwr3lp32jlrx5hqag4jxexde92rzkamq3l62zg',
    role: 'TLA VP lock / vAMP minter (lock NFT enumeration, lock_info, total_vamp)',
};
const BRIBE_MANAGER = {
    addr: 'terra1tuuwm8yrj54qeg0c8xu00aha9ryatyhtczq8qq2q8tntuw0auzas9037wh',
    role: 'TLA incentive / bribe manager (user_claimable)',
};
const COMPOUNDER = {
    addr: 'terra1zly98gvcec54m3caxlqexce7rus6rzgplz7eketsdz7nh750h2rqvu8uzx',
    role: 'Eris LP compounder (asset_configs, user_infos; mints factory amplp)',
};
// Credia Finance (lending, not a dex) — docs/ecosystem-knowledge/credia.facts.json (credia.contracts.portfolio,
// chain-confirmed 2026-07-16). The Portfolio contract answers {metrics:{}} (every market; dex-data/dexes/credia.js)
// and {portfolio:{address}} (one user's supplies/borrows; ally-positions 1.1.0). 2026-09-22.
const CREDIA = {
    portfolio: 'terra1y6hfmr3lxxj6srduhlfz96x7sga2984pr757a0nrfuqxa9rqxapqcjv4zz',
    role: 'Credia Portfolio contract (metrics; portfolio{address}; receipt tokens = each market\'s vproxy_addr)',
};

// ── TLA staking buckets (the 4 pools members stake into) ────────────────────
const STAKING_BUCKETS = {
    stable:   'terra1v399cx9drllm70wxfsgvfe694tdsd9x96p9ha36w7muffe4znlusqswspq',
    project:  'terra1awq6t7jfakg9wfjn40fk3wzwmd57mvrqtt3a39z9rmet7wdjj3ysgw3lpa',
    bluechip: 'terra14mmvqn0kthw6sre75vku263lafn5655mkjdejqjedjga4cw0qx2qlf4arv',
    single:   'terra1qdz5qgafx88kp5mf6m2tah8742g4u5g2cek0m3jrgssexexk7g4qw6e23k',
};
const BUCKETS = ['stable', 'project', 'bluechip', 'single'];

// ── TLA zapper (added 2026-07-08 for org-tla-flows) ─────────────────────────
const ZAPPER = {
    addr: 'terra1qdjsxsv96aagrdxz83gwtjk8qvf2mrg4y8y3dqjxg556lm79pg5qdgmaxl',
    role: 'Eris LP zapper (create_lp / withdraw_lp — zap entry/exit legs for tla-flows)',
};

// ── DAO wallets ─────────────────────────────────────────────────────────────
const DAO_MAIN_WALLET = {
    addr: 'terra1sffd4efk2jpdt894r04qwmtjqrrjfc52tmj6vkzjxqhd8qqu2drs3m5vzm',
    role: 'AllianceDAO treasury wallet (holds unminted NFTs + treasury assets)',
};

// ── Pricing hubs the engine references directly ─────────────────────────────
const ARB_LUNA_HUB = {
    addr: 'terra1u72y7gppxrsncctvgfyqduv3md6pgq77pqhz9rxgwl3dqgye00cq7vmf8u',
    role: 'Eris arbLUNA hub (zLUNA/arbLUNA ratio for valuation)',
};

// ── LST exchange-rate hubs (token-catalog Stage 3 redemption pricing) ────────
// Each LST has an on-chain hub whose exchange rate gives redemption value:
//   redemption_price = base_token_price_usd × ratio
// Proven query shapes (lifted from network-and-prices, verified on phoenix-1):
//   kind 'exchange_rates_array' → data.exchange_rates[0][1]   (ampLUNA)
//   kind 'state'                → data.exchange_rate          (all others)
// All five live on phoenix-1, queryable via the standard LCD smart endpoint.
// NOTE: xASTRO is intentionally NOT here — its real hub is on Neutron (cross-chain)
//   and the reward isn't worth the squeeze for one bridged single-asset stake.
//   xASTRO stays price-only (TLA + CoinGecko) with no redemption cross-check.
const LST_HUBS = {
    ampLUNA: { hub: 'terra10788fkzah89xrdm27zkj5yvhj9x3494lxawzm5qq3vvxcqz2yzaqyd3enk',
        lstDenom: 'terra1ecgazyd0waaj3g7l9cmy5gulhxkps2gmxu9ghducvuypjq68mq2s5lvsct',
        base: 'LUNA', baseDenom: 'uluna',
        query: { exchange_rates: {} }, kind: 'exchange_rates_array' },
    arbLUNA: { hub: 'terra1r9gls56glvuc4jedsvc3uwh6vj95mqm9efc7hnweqxa2nlme5cyqxygy5m',
        lstDenom: 'terra1se7rvuerys4kd2snt6vqswh9wugu49vhyzls8ymc02wl37g2p2ms5yz490',
        base: 'LUNA', baseDenom: 'uluna',
        query: { state: {} }, kind: 'state' },
    ampROAR: { hub: 'terra1vklefn7n6cchn0u962w3gaszr4vf52wjvd4y95t2sydwpmpdtszsqvk9wy',
        lstDenom: 'factory/terra1vklefn7n6cchn0u962w3gaszr4vf52wjvd4y95t2sydwpmpdtszsqvk9wy/ampROAR',
        base: 'ROAR', baseDenom: 'terra1lxx40s29qvkrcj8fsa3yzyehy7w50umdvvnls2r830rys6lu2zns63eelv',
        query: { state: {} }, kind: 'state' },
    ampCAPA: { hub: 'terra186rpfczl7l2kugdsqqedegl4es4hp624phfc7ddy8my02a4e8lgq5rlx7y',
        lstDenom: 'factory/terra186rpfczl7l2kugdsqqedegl4es4hp624phfc7ddy8my02a4e8lgq5rlx7y/ampCAPA',
        base: 'CAPA', baseDenom: 'terra1t4p3u8khpd7f8qzurwyafxt648dya6mp6vur3vaapswt6m24gkuqrfdhar',
        query: { state: {} }, kind: 'state' },
    bLUNA: { hub: 'terra1l2nd99yze5fszmhl5svyh5fky9wm4nz4etlgnztfu4e8809gd52q04n3ea',
        lstDenom: 'terra17aj4ty4sz4yhgm08na8drc0v03v2jwr3waxcqrwhajj729zhl7zqnpc0ml',
        base: 'LUNA', baseDenom: 'uluna',
        query: { state: {} }, kind: 'state' },
};
// Within this % gap between market price and redemption price, the two agree
// (clean staking derivative). Beyond it, market sits off redemption — surfaced
// neutrally. Only a LARGE gap (review threshold) is flagged for human review, per
// the proven doctrine: hub-ratio redemption is robust; a thin/stale pool price
// must not auto-alarm. (arbLUNA discovered 2026-06-14 running ~14% off via a thin pool.)
const LST_DIVERGENCE_FLAG_PCT = 2;
const LST_REVIEW_FLAG_PCT = 10;

// ── Solid (Capapult CDP) — found by the solid-probe 1.3 run (tla-core docs/fixtures/2026-09-28/solid-probe.json) from the owner's
// test txs; every custody's config names the same overseer / market / liquidation / collector. Query targets for the Solid reader
// (queued). Labels + query shapes: docs/curated/known_contracts.json and docs/queries.md §19. OPEN: the oracle's price unit.
const SOLID = {
    overseer:    'terra10qnsw3wn4uaxs7en2kynhet2dsyy76lmprh2ptcz85d8hu59gkuqcpndnv',   // whitelist, collaterals{borrower}, all_collaterals, borrow_limit{borrower}
    market:      'terra1h4cknjl5k0aysdhv0h4eqcaka620g8h69k8h0pjjccxvf9esfhws3cyqnc',   // state, borrower_info{borrower} (loan_amount), borrower_infos
    liquidation: 'terra188d4q69nen6vmwt7vcvz8lf54mc80cfvqtrznpmsrawftm86jkmsh4grzp',
    collector:   'terra1uz33y5dfazxspyfdvw30dwmpa5hhm4908tetpq5t0sm0z0c63rlspfkaau',
    oracle:      'terra199pgv9dymcg9q8xtwsxk7yakazmvlf5ptkqh4zadcv7k0yqsal2q6tq7mv',   // v2 — the overseer's; prices{} (unit unconfirmed)
    stable:      'terra10aa3zdkrc7jwuf8ekl3zq7e7m42vmzqehcmu74e4egc7xkm5kr2s0muyst',   // SOLID cw20
    // collateral token → custody (the overseer's whitelist, 2026-09-28)
    custodies: {
        'terra1ecgazyd0waaj3g7l9cmy5gulhxkps2gmxu9ghducvuypjq68mq2s5lvsct': { symbol: 'ampLUNA', custody: 'terra18uxq2k6wpsqythpakz5n6ljnuzyehrt775zkdclrtdtv6da63gmskqn7dq', max_ltv: 0.5 },
        'terra17aj4ty4sz4yhgm08na8drc0v03v2jwr3waxcqrwhajj729zhl7zqnpc0ml': { symbol: 'bLUNA',   custody: 'terra1fyfrqdf58nf4fev2amrdrytq5d63njulfa7sm75c0zu4pnr693dsqlr7p9', max_ltv: 0.5 },
        'terra14xsm2wzvu7xaf567r693vgfkhmvfs08l68h4tjj5wjgyn5ky8e2qvzyanh': { symbol: 'LunaX',   custody: 'terra18l7vt34kfy2ycv3aej4fgq286s060n55f7uz0qyw9jpzn5gszkxsy3r7nw', max_ltv: 0.5 },
        'terra164ye3v3pksjzl8nan9z3jd8xyhwpee7ws82l5y2gfcwqnekz9ujqts7v58': { symbol: 'wETH',    custody: 'terra1xyxxg9z8eep6xkfts4sp7gper677glz0md4wd9krj4d8dllmut8q8tjjrl', max_ltv: 0.75, wraps: 'ibc/BC8A77AFBD872FDC32A348D3FB10CC09277C266CFE52081DE341C7EC6752E674' },
        'terra1r6ju9f643v353n88dxaqdvkthdnclycgds2qc6kyddqpmcr9dj5sdkvu37': { symbol: 'wBTC',    custody: 'terra1jksfmpavp09wwla8xffera3q7z49ef6r2jx9lu29mwvl64g34ljs7u2hln', max_ltv: 0.75, wraps: 'ibc/05D299885B07905B6886F554B39346EA6761246076A1120B1950049B92B922DD' },
        'terra1qv3gtys4u8hacv9mdzk3gmc88z6gv5w2c9ksmcf868pl8q3er42snwgdn2': { symbol: 'USDC',    custody: 'terra1shc5n0sqg30fzvg0e2j826j0g73ypmjw9vkf592ghdph5dhau25qha2rks', max_ltv: 0.95, wraps: 'ibc/2C962DAB9F57FE0921435426AE75196009FAA1981BF86991203C8411F8980FDB' },
        'terra1ctelwayk6t2zu30a8v9kdg3u2gr0slpjdfny5pjp7m3tuquk32ysugyjdg': { symbol: 'wSOL',    custody: 'terra1e32q545j90agakl32mtkacq05990cnr54czj8wp0wv3nttkrhwlqr9spf5', max_ltv: 0.65 },
        'terra1xc7ynquupyfcn43sye5pfmnlzjcw2ck9keh0l2w2a4rhjnkp64uq4pr388': { symbol: 'wBNB',    custody: 'terra1fluajm00hwu9wyy8yuyf4zag7x5pw95vdlgkhh8w03pfzqj6hapsx4673t', max_ltv: 0.65 },
    },
};

// ── Custodians: contracts that HOLD a member's TLA receipt while it stays the member's (2026-09-28) ─────────────────
// Owner: "I deposit, amplify, and stake the ampLP receipt in DAODAO for gov VP — still my position, still earning."
// A receipt sent to one of these is NOT a withdrawal and NOT gone: the capture engine counts it in the member's totals
// (measured by `measured_by`), the P&L build keeps its lots open ("held in"), the portfolio shows it apart from wallet LPs.
// Add a custodian here (with how its per-wallet stake is measured) and every consumer picks it up.
const CUSTODIANS = [
    { key: 'ampcapa-dao', label: 'the ampCAPA DAO', kind: 'daodao_voting_module',
      address: 'terra1juj3ymejnug9p92upphcq0prq4e0hpw6rcu20njf8tk7n9sl2wxqldr0mt',
      holds_denom: 'factory/terra1zly98gvcec54m3caxlqexce7rus6rzgplz7eketsdz7nh750h2rqvu8uzx/44/single/amplp',
      pool: 'native:factory/terra186rpfczl7l2kugdsqqedegl4es4hp624phfc7ddy8my02a4e8lgq5rlx7y/ampCAPA', mechanism: 'amplified',
      measured_by: { product: 'token-catalog/supply/capa/wallets.json', field: 'capa_equiv.receipt_dao', unit: 'CAPA', price_symbol: 'CAPA' } },
];

// ── TLA-relevant token CW20s (INTERIM) ──────────────────────────────────────
// NOTE: token identity belongs to the token-catalog domain (the WORTH layer).
// These live here only so no address is hardcoded today. When token-catalog is
// built, MOVE this block there and delete it here. (Tracked: foundation cleanup.)
const TLA_TOKENS = {
    ampLUNA: 'terra1ecgazyd0waaj3g7l9cmy5gulhxkps2gmxu9ghducvuypjq68mq2s5lvsct',
    bLUNA:   'terra17aj4ty4sz4yhgm08na8drc0v03v2jwr3waxcqrwhajj729zhl7zqnpc0ml',
};

module.exports = {
    GAUGE_CONTROLLER,
    VOTING_ESCROW,
    BRIBE_MANAGER,
    COMPOUNDER,
    CREDIA,
    ZAPPER,
    STAKING_BUCKETS,
    BUCKETS,
    DAO_MAIN_WALLET,
    ARB_LUNA_HUB,
    LST_HUBS,
    LST_DIVERGENCE_FLAG_PCT,
    LST_REVIEW_FLAG_PCT,
    TLA_TOKENS,
    CUSTODIANS,
    SOLID,
};
