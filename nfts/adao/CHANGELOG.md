# nfts/adao — changelog

## 1.0.0 — 2026-06-29 — org migration + analytics + blueprint

- **Inventory cron**: migrated proven Rev C.4 into the org. Plumbing only
  (GITHUB_REPO → thealliancedao/tla-core; OUTPUT_PATH → nfts/adao/snapshots;
  409-retry on commit; startup tag). 2,200+ lines of NFT logic byte-for-byte
  identical to the proven version — verified by diff.
- **analytics.js** (new): floor by grade(1-40) + object, backing-to-floor ratio,
  all-time sales analytics from existing sales-history.json (no backfill — history
  was already captured to 2023-12). Validated on real data (1,043 LUNA sales /
  177,643 LUNA all-time). Separate module; reads cron outputs, logic untouched.
- **BLUEPRINT.md** (new): how to add a collection without touching aDAO. Collections
  are isolated sibling folders (nfts/<collection>/ in both repos).
- **History seeded**: sales-history, sales-enriched, floor-history,
  listing-first-seen, pending-claims copied from old data repo into
  tla-core/nfts/adao/snapshots/ so accumulated history carries forward.

Deferred: floor by planet/inhabitant (rarity data is grade+object, no separate
category); price source → token-catalog (verified follow-up).
