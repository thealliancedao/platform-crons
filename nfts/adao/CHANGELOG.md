# nfts/adao — changelog

## C.6 — 2026-08-23 — raw-custody count + daodao_custody_unattributed bucket (the 9981 fix)

- **Root cause of classification sum 9981**: `daodaoCustodyCount` filtered on the
  `daodao_staked` FLAG, which prior resolution had already flipped to false for
  the 19 stranded tokens — so custody read 1631, chain count = 1631−1631 = 0,
  the tracker looked reconciled, and the C.5 sweep never re-fired. Custody now
  counts RAW chain ownership (`owner == staking contract`): 1650 in every mode.
- **New bucket `daodao_custody_unattributed`**: the third custody state the old
  "custody = active + pending; no third state" model denied — unstaked long ago,
  claim window expired, never claimed (includes legacy 1319/3605/6847/7123).
  Resolution strands land here; the chain claims tracker promotes attributable
  ones to `daodao_pending_claim` (with real unstaker as real_owner); tokens that
  leave custody clear entirely. A held token is never no-bucket.
- Summary/heartbeat/console carry the new count; classification-sum guard
  includes it (expects 10,000 again).
- **Gate (permanent): `mock-run-custody.js`** — real committed nfts.json (the
  poisoned 19-token base), four scenarios: warm-fresh, hot-carry, tracker-sweep,
  tracker-empty. All must sum to 10,000 with the 19 bucketed and never phantom.


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
