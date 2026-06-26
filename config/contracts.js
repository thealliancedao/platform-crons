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

// ── TLA staking buckets (the 4 pools members stake into) ────────────────────
const STAKING_BUCKETS = {
    stable:   'terra1v399cx9drllm70wxfsgvfe694tdsd9x96p9ha36w7muffe4znlusqswspq',
    project:  'terra1awq6t7jfakg9wfjn40fk3wzwmd57mvrqtt3a39z9rmet7wdjj3ysgw3lpa',
    bluechip: 'terra14mmvqn0kthw6sre75vku263lafn5655mkjdejqjedjga4cw0qx2qlf4arv',
    single:   'terra1qdz5qgafx88kp5mf6m2tah8742g4u5g2cek0m3jrgssexexk7g4qw6e23k',
};
const BUCKETS = ['stable', 'project', 'bluechip', 'single'];

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
    STAKING_BUCKETS,
    BUCKETS,
    DAO_MAIN_WALLET,
    ARB_LUNA_HUB,
    TLA_TOKENS,
};
