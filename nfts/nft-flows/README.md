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
