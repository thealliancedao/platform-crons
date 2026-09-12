# org-nft-flows — NFT + lock forward capture (Render, hourly)

Picks up where the nft-flows backfill left off (SPEC-nft-flows.md in tla-core) and keeps every registered
collection's ledger current. Writes to the SAME paths the backfill wrote; the archive node is never needed again.

- Registry: `tla-core/docs/curated/nft-collections.json` — the only per-collection input. Add a collection there
  (RUNBOOK-add-a-collection.md) and this cron starts archiving it on its next run; nothing else changes.
- Cursor: `tla-core/nfts/ledger-cursor.json` (global; bootstrapped from each ledger's coverage on first run).
- Raw before ledger: `nfts/raw/<collection>/forward/YYYY-MM-DD.json.gz` (same {h,x,t,c,e} shape as backfill parts)
  then `nfts/<collection>/ledger/YYYY/MM.json` (merge by recordKey, never-shrink) + `index.json` (forward coverage).
- `lib/classify.js` is BYTE-IDENTICAL to `tla-core/.github/scripts/nft-flows/classify.js`. Diff-gate on change:
  `cmp lib/classify.js ../../../tla-core/.github/scripts/nft-flows/classify.js` (empty = correct).
- Env: GITHUB_TOKEN (tla-core write), GITHUB_REPO, GITHUB_BRANCH, RPC_PRIMARY, RPC_FALLBACK, WALK_CONCURRENCY (4),
  MAX_BLOCKS_PER_RUN (4000 ≈ 6.5 h of chain — an outage catches up over runs), HEAD_LAG (10), PACE_MS (60), DRY_RUN.
- Heartbeat: `tla-core/nfts/nft-flows/heartbeat.json` (status ok · degraded · failed, cursor, matched, per_collection).
- Render: cron `org-nft-flows`, schedule `17 * * * *` (hourly, off the :00/:31/:45 pile), start `node index.js`.
- Mock: `node mock-run.js` — fake RPC + fake GitHub; asserts raw file, ledger merge, index coverage, cursor last.

## Changelog
### 1.0.0 — 2026-09-12
Initial. Replaces the (never-scheduled) Actions forward idea: scheduled capture is a Render job by doctrine.
