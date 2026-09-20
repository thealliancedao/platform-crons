> **1.5.3 (2026-09-20)** — index.js never handed the registry's custodian ROLES to the projector (only the system set): on
> Render a holder's transfer into a custodian was a release, so the live PL shards carried 2,721 positions with acquired:null
> and #6 with no holder while the lib gate (which passed custodians itself) was green. Fixed at the one call; the by-wallet
> index carries `engine` and a new engine rebuilds its projection once (`mode: all (engine changed)`); the mock stakes into a
> registry custodian and asserts the holder keeps the token as `staked:<role>`. Mock 81/81.
>
> **1.5.2 (2026-09-20)** — the by-wallet index carries `system_key` (hash of the registry system-address set): a registry change
> (a custodian added) rebuilds every shard on the next run, no env toggle (`mode: all (registry changed)`). Mock 78/78.
>
> **1.5.1 (2026-09-20, D.1)** — by-wallet shards: `<slug>/ledger/by-wallet/<shard>.json` + index.json — the ledger replayed
> per address (lib/by-wallet.js 1.0.0, THE rule): every live row naming the address (+ `role`), `holdings_now` per token with
> its state, `held_past` (closed positions, P&L two ways), counts. 32 shards keyed by the address's last bech32 char (`_` for
> non-terra ids); system addresses get no block; registry custodians are custody moves, custodian→custodian migrations
> re-label the holder, a stale position closes as a labeled `gap`. Rebuilt for the shards a run's wallets touch;
> `BY_WALLET_ALL=1` or a missing index rebuilds all in groups of `BY_WALLET_GROUP` (8). Gates: mock 76/76;
> `gate-by-wallet.mjs` on the REAL ledgers vs the REAL inventory (aDAO 3982/3983 tokens agree, PL 4798/4819; no token
> held by two wallets; heap < 100 MB). Readers: help-agent v1.14 `nft_wallet`, the journey sheet's buyer holdings (next).
>
> **1.4.0 (2026-09-18)** — by-token shards: `<slug>/ledger/by-token/<shard>.json` + index.json (100 tokens per shard, live
> rows only, rebuilt for the shards a run touches; `BY_TOKEN_ALL=1` or a missing index rebuilds all, one month in memory at a
> time). 1.3.1: `launchpad.addresses` watched. classify.js **1.1.5**: several launchpad holders per collection; launchpad →
> distribution wallet = stock returned, never a $0 mint_purchase (REPAIR mint-phase-1.1.5 on adao/ledger).

# org-nft-flows-<slug> — NFT + lock forward capture, ONE Render service per collection (hourly)

Picks up where a collection's backfill left off (nft-collections/<slug>/) and keeps that one collection's ledger
current. Env `COLLECTION=<slug>` selects the folder; the service reads and writes nothing outside it.

- Config: `nft-collections/<slug>/collection.json` (`capture` block) + `nft-collections/venues.json`.
- Cursor: `<slug>/ledger/cursor.json` (bootstrapped from the ledger's coverage edge, else `capture.genesis_height`).
- Raw before ledger: `<slug>/raw/forward/YYYY-MM-DD.json.gz` (same {h,x,t,c,e} shape as backfill parts) then
  `<slug>/ledger/YYYY/MM.json` (merge by recordKey, never-shrink) + `index.json` (coverage `forward:org-nft-flows`).
- `lib/classify.js` is BYTE-IDENTICAL to `nft-collections/.github/scripts/nft-flows/classify.js`. Diff-gate on change.
- Env: COLLECTION (slug, required), GITHUB_TOKEN (nft-collections write), GITHUB_REPO (thealliancedao/nft-collections), GITHUB_BRANCH, RPC_PRIMARY, RPC_FALLBACK, WALK_CONCURRENCY (4),
  MAX_BLOCKS_PER_RUN (4000 ≈ 6.5 h of chain — an outage catches up over runs), HEAD_LAG (10), PACE_MS (60), DRY_RUN.
- Heartbeat: `<slug>/nft-flows/heartbeat.json` (status ok · degraded · failed, cursor, matched).
- Render: one cron per collection — `org-nft-flows-adao` (`4 * * * *`), `org-nft-flows-pixel-lions` (`24 * * * *`),
  `org-nft-flows-tla-locks` (`44 * * * *`) (as registered in CRON-FLEET.md 2026-09-13); root dir `nfts/nft-flows`, start
  `node index.js`, env COLLECTION set per service. Reads luna-usd-daily from nft-collections/adao/snapshots/ (env NFTC_RAW).
- Mock: `node mock-run.js` — fake RPC + fake GitHub; asserts raw file, ledger merge, index coverage, cursor last.

## Changelog
### 1.5.1 — 2026-09-20 (D.1)
- `lib/by-wallet.js` 1.0.0 + the by-wallet duty in index.js (see the top note). Replay order inside a block: acquisition →
  return-from-custody → transfer → custody-entry → destruction, then msg_index (the ledger carries no tx index; a wallet
  cannot move what it has not received). Self-transfers move nothing (`role:self`).
- `mock-run.js`: failing assertions print what they saw; by-wallet cases (system addresses excluded, pre-ledger holding labeled,
  P&L two ways incl. a LUNA→bLUNA trip with no LUNA-terms number, superseded twin never enters, dirty vs full rebuild).
- `gate-by-wallet.mjs` (new): real ledgers + real `snapshots/nfts.json` (needs the nft-collections checkout beside
  platform-crons or `NC=…`). It surfaced pixeLions staking v1 (`terra1exj6fxvr…sqnp0stl`, registered as custodian
  `legacy_staking` in pixel-lions/collection.json the same day) and shows the ledger names a holder for every
  Enterprise/DAODAO custody-unattributed token (B.3's input).
- First run per service: `by-wallet/index.json` missing → full rebuild (4 passes over the months, ~2 min); after that dirty only.
### 1.5.0 — 2026-09-19 (B.1)
- Message bodies decoded at walk time (`lib/tx-body.js`) and archived as `m` on the raw record; classify 1.1.6 e.
### 1.4.1 — 2026-09-19
- `lib/oracle-usd.js` = the pricing rule (makeOracle({ fetchMonth, resolve }) → usdAt / loadMonth / dropMonth); index.js delegates to it, derive.js (nft-collections) requires it from `_crons` at run time — one rule, no copy.
- by-token: `by-token: N/M shards (k written so far)` every 20 shards and at the end.
### 1.1.3 — 2026-09-14
Re-price pass at the start of every run over the current + previous month files: a record left `usd:null /
usd_reason:luna_usd_daily_missing:<day>` (the series lags the chain 1–2 days, so same-day LUNA sales were never priced)
gets its USD filled once the day arrives, labeled `usd_repriced_at`; event fields verbatim; month file written only on
change; heartbeat carries `repriced`. Mock 26/26.
### 1.1.2 — 2026-09-14
luna-usd-daily read repointed to nft-collections/adao/snapshots/ (tla-core/nfts/adao deleted 2026-09-13 → every run
`degraded · luna-usd-daily: HTTP 404`). Mock pins the exact path requested.
### 1.1.1 — 2026-09-13
GitHub bodies collected as bytes — a same-day second match re-read the existing raw/forward part as utf8-mangled gzip
(`incorrect header check`); org-nft-flows-tla-locks failed every run for 13 h behind a fresh heartbeat.
### 1.1.0 — 2026-09-12
One service per collection (env COLLECTION), config + data in nft-collections/<slug>/, nothing cross-collection. Mock 10/10.
### 1.0.0 — 2026-09-12
Initial (global cursor, tla-core paths) — superseded the same day; never deployed.
