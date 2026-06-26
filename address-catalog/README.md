# Address-Catalog Cron

The platform's **single "who do we track" registry** — and the structural-contract
reference. Member/holder discovery used to happen in five crons (`adao-positions`,
`adao-allies`, `tla-locks`, `tla-participants`, `tla-chain-registry`), each
re-deriving who exists. This cron does it **once** and publishes one catalog every
other cron reads — so discovery is no longer duplicated, and onboarding a new ally
is a single config row.

**Foundation role:** downstream crons read this catalog's address list instead of
re-walking the chain, and read its `contracts` block instead of hardcoding
addresses. Edit once here (or in `config/contracts.js`), everything downstream
follows on the next run.

## Output

Writes into the unified **`tla-core`** repo as the `catalog` module, following the
`module / product / files` layout (snapshots product). Forward-only: it starts
capturing the day it goes live — no backfill.

```
catalog/snapshots/
├── current.json             full registry (latest)
├── daily/{YYYY-MM-DD}.json  forward-only daily snapshot (history accrues)
├── index.json               manifest: latest pointers + counts
└── heartbeat.json           standard heartbeat (read by system-health)
```

`current.json` shape:

```
meta             { version, schemaVersion, generated_at, epoch, status, source }
retention_policy { adao:'all', tla_locks:'all', pixellions:'registered_only', liondao:'registered_only' }
slugs[]          per-entity block { slug, name, type, stake_type, retention, status,
                   voting_module, total_count, registered_count, kept_count, [lock_tokens] }
counts           { total_address_rows, unique_addresses, by_slug{} }
contracts        { gauge_controller, voting_escrow, bribe_manager, compounder,
                   dao_main_wallet, arb_luna_hub, staking_buckets }  <- from config/contracts.js
addresses[]      one row per (address, slug): { address, slug, type, handle, retention,
                   stake_raw, vp_pct_of_dao, source }
by_address{}     index: address -> { handle, memberships:[{slug,type,stake_raw,vp_pct_of_dao}] }
```

Downstream crons read `addresses` (filter by `slug`/`retention`), `by_address`, or
the `contracts` block. The `contracts` block is a **generated copy** of
`config/contracts.js` — never hand-edit it; edit the config.

## Adding an ally (the give-back model)

Append **one row** to `TRACKED` at the top of `address-catalog.js`. Nothing else in
the platform changes — the catalog discovers them and every downstream cron starts
tracking them on the next run. Example (future Solid alliance):

```js
{ slug:'solid', name:'Solid', stakeType:'cw20', retention:'registered_only',
  type:'ally_member', coreAddress:'terra1...' }
```

## Discovery methods (`stakeType`)

| type   | how                                                | used by           |
|--------|----------------------------------------------------|-------------------|
| `nft`  | `daoVotingCw721Staked` -> `topStakers`             | aDAO, Pixel Lions |
| `cw20` | `daoVotingCw20Staked` -> `topStakers`              | Lion DAO (ROAR)   |
| `token`| `daoVotingTokenStaked` -> `topStakers`             | (future)          |
| `lock` | veLUNA CW721 `all_tokens` enumeration + `owner_of` | TLA Lock Holders  |

`votingModule` is resolved from the DAO `coreAddress` unless an override is given
(aDAO uses the proven override). `lock` needs no core.

## Retention

- `all` — keep every address (named + anonymous); anonymous kept for the record with
  `handle:null`. Our own entities (aDAO, TLA locks).
- `registered_only` — keep only PFPK-named addresses; anonymous are **counted**
  (`total_count`/`registered_count`) but **not stored**. Allies — a give-back to
  identifiable community members.

## Addresses & single source

- **Structural contracts** (gauge, escrow, compounder, DAO wallet, staking buckets)
  come from `config/contracts.js` — the one place they're defined. aDAO's
  `coreAddress` reads from there too.
- **Ally cores** (Pixel Lions, Lion DAO) live in the `TRACKED` row for that ally —
  that's the per-tenant config you edit to onboard a collection.

## Render setup

- Repo: `thealliancedao/platform-crons` · Root dir: `address-catalog`
- Build: `npm i` (uses shared `../lib` + `../config`)
- Start: `node address-catalog.js`
- Schedule: daily is plenty (membership moves slowly); `RUN_EVERY_HOURS` env tunes
  the heartbeat's expected cadence.
- Env: `GITHUB_TOKEN` (fine-grained, scoped to `thealliancedao/tla-core`, Contents
  read+write), `GITHUB_REPO` (optional, defaults to `thealliancedao/tla-core`).

Without `GITHUB_TOKEN` it writes `catalog.json` + `heartbeat.json` locally only —
handy for a first dry run.

## Recent changes

- **1.1.0** — org migration + foundation hardening. Output moved to the
  `catalog/snapshots/` product shape (`current` + `daily/` + `index` + `heartbeat`),
  full heartbeat schema, forward-only daily history. aDAO `coreAddress` now reads
  `config/contracts.js` (single source); added a generated `contracts` block to the
  output. Default repo -> `thealliancedao/tla-core`.
- **1.0.0** — initial. Config-driven discovery (nft/cw20/token/lock), PFPK handle
  resolution for all methods, per-entity retention, one catalog + heartbeat. Reuses
  `lib/capture-engine.js` + `lib/ally-capture.js`. null != [] guards on lock
  enumeration (matches `tla-participants`).
