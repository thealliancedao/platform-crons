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
- Render: one cron per collection — `org-nft-flows-adao` (`17 * * * *`), `org-nft-flows-pixel-lions` (`22 * * * *`),
  `org-nft-flows-tla-locks` (`27 * * * *`); root dir `nfts/nft-flows`, start `node index.js`, env COLLECTION set per service.
- Mock: `node mock-run.js` — fake RPC + fake GitHub; asserts raw file, ledger merge, index coverage, cursor last.

## Changelog
### 1.1.0 — 2026-09-12
One service per collection (env COLLECTION), config + data in nft-collections/<slug>/, nothing cross-collection. Mock 10/10.
### 1.0.0 — 2026-09-12
Initial (global cursor, tla-core paths) — superseded the same day; never deployed.
