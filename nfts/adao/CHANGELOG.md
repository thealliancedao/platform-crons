# nfts/adao — changelog

## market-history 1.1.0 — 2026-08-23 — unresolved-exit sentinel (the "never again" invariant)

- Every marketplace exit is a sale or a delist — no third thing. The sentinel
  (warm/full, trailing 60d, `SENTINEL_WINDOW_DAYS` overridable) flags every v1
  exit record with no v2 sale/cancel record for the same tx: loud log lines +
  `stats.unresolved_exits` and the tx list in market-history-heartbeat.json.
  Motivated by the missed 2026-08-21 Atrium sale of #6192 (owner-caught).
- Registry-driven marketplace set (nft_marketplace stream entries) — a new
  venue is guarded the moment it's registered, no code change.
- Gate G6 on the REAL committed 2026/08 month: the missed sale tx flags
  pre-resolution, clears on resolution, window respected. Shape-aware: passes
  both before and after the resolve-market-exits Action runs.
- Companion: coverage & gap register appended to tla-core/docs/DATA-MAP.md
  (FCD→walker seam Jan 7–9 2025, OTC invisibility, vocabulary lock status,
  frozen-spot semantics).


## market-history 1.0.0 — 2026-08-23 — the ported duty (Analytics tab un-frozen)

- **NEW module market-history.js** — forward maintenance of sales-enriched.json,
  listing-history.json, luna-usd-daily.json, bluna-usd-daily.json (frozen since
  June when the data-repo Action retired without the duty being ported). Inputs:
  classifyNftTx v2 records (nfts/adao/transfers) + org price-history. Merges INTO
  the same org paths — deeper history, never a side file. Laws enforced in code:
  entry-keyed prior rows byte-verbatim, never-shrink (throws, refuses publish),
  ambiguous v2 sales NEVER enriched (warned for a human), missing price days left
  blank (no carry-forward fabrication), repairs labeled (repair field).
- **Wired into the warm/full pass** after analytics, isolated like analytics
  (a failure never taints inventory). Analytics re-derives from committed inputs
  next pass — never from in-flight state.
- **flows.js: delisting→sale upgrade at rollup** — the "future sales feed" the
  diff comment promised. A delisting whose token has a same-day non-ambiguous v2
  sale record retypes to sale (upgraded_from:'delisting', chain price carried).
- **Gate (permanent): mock-run-market-history.js** — real committed products +
  the 64 REAL batch-settle sales (self-derived from the FCD archive via the
  same-repo live classifier). G1/G2 daily fills (prior-verbatim, no fabricated
  days, idempotent), G3 the 64 (labeled, priced day-of, legs sum to gross, prior
  1,259 byte-verbatim, re-feed adds 0, ambiguous refused), G4 listing lifecycle
  (open/close/unmatched, all-ever-seen dedupe — a closed listing can never be
  phantom-reopened by scan-window overlap), G5 flows upgrade.
- One-off recovery of the 64 lives in tla-core (.github/scripts/nft-market-history)
  per repo-placement law — runs the LIVE classifier + enricher, idempotent.


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
