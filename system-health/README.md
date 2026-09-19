# org-system-health — invariant monitors (defect register #10)

The platform's immune system. Every defect in the July-14 register was found
by manual cross-checking; this cron makes those cross-checks permanent.
**Layer 3, chain-free:** reads ONLY committed tla-core files via the
authenticated Contents API. **Reports, never repairs (D4)** — no other
product is ever written to.

## Invariants (SPEC-system-health D2 + audit addendum)
1. `bucket_vp_consistency` — member-data `vp_voting_per_bucket` vs
   token-catalog active-pool `total_vp` sums per bucket. Like-for-like =
   **same DAY** (skip + declare otherwise). Currently violates by design:
   ghost/stray votes + tally scope differences (CHANGES_PENDING #4).
2. `staked_le_depth` — per dex pool with both sides: `raw.staked_liquidity_usd
   <= tvl_usd` (the impossible-LUNA-SOLID class of error).
3. `distribution_fractions_sum` — catalog active `distribution_pct` sums to
   1.0 ± 0.001 per bucket.
4. `tribute_stream_coverage` — consumes tla-voting's `bribe_capture`
   heartbeat block (never recomputes); violation ONLY on a per-denom DROP vs
   the baseline stored in the previous history run. Skipped + declared until
   the first epoch-flip capture publishes it.
5. `bucket_label_agreement` — dex-data bucket vs catalog bucket joined on
   `architecture.pair_address`; mismatches carry both generated_at stamps.
   Proven live: caught the SS LUNA-SOLID stale entry on its first dry run.
6. `heartbeat_freshness` — per-product FRESHNESS_MAP with product-appropriate
   signals: cron heartbeats vs cadence-aware max ages; price-history = latest
   day key of the current month file (data truth) PLUS, since 1.0.8, the
   writer's own heartbeat (`price-history/heartbeat.json`, written by
   org-token-catalog each run — a swallowed append failure is raised within
   the hour instead of as a stale day key 50 h later);
   one-offs (nfts provenance) exempt.
7. `identity_resolution` — informational: unresolved pools + tokens without
   `discovered.symbol` (cross-checked against the catalog's own
   identity_stats). A shrinking number, tracked.
8. `nft_listings_reconcile` (1.0.9, owner 2026-09-19) — per collection in
   `tla-core/docs/curated/tenants.json`: the listings OPEN per the chain-event
   ledger (`<slug>/ledger/`, `list` opens; `delist` / `sale` / `venue_out` /
   `transfer` close; superseded rows never count) must equal the listings the
   inventory reads from contract state (`<slug>/snapshots/nfts.json`), per
   venue and per token. Ledger months are folded one at a time (heap). A
   difference younger than the two products' lag (≥ 2 h; ledger `ran_at` vs
   inventory `capturedAt`) is `recent_unconfirmed`, never a violation. Proven
   live on its first run: Pixel Lions #2124, listed on BBL 2025-12-13 and
   invisible to the state read until nft-inventory D.2 completed it from
   cw721 ownership.

## Verdicts (D3)
Per invariant `{status: ok|violation|skipped, detail, measured, expected,
as_of}`. Top-level status = worst member (violation > skipped > ok).
Violations carry enough detail to file straight into CHANGES_PENDING.

## Writes (tla-core)
- `system-health/current.json` — the alert surface (Trust & Data tab renders it)
- `system-health/history/{YYYY}/{MM}.json` — monthly run appends, never-shrink
  guarded; each run stores the tribute-coverage baseline for the next drop check
- `system-health/heartbeat.json`

## Run
- Render job `org-system-health`, hourly. Cheap: ~18 Contents-API raw reads,
  zero chain queries.
- Env: `GITHUB_TOKEN` (rw tla-core) required; `GITHUB_REPO` (default
  thealliancedao/tla-core), `GITHUB_BRANCH` (default main).

## Mock gate (D6 — binding before any deploy)
`node mock-run.js` — in-memory repo stub behind the `T` seam. 33 checks:
all-ok pass, one crafted violation per invariant, same-day like-for-like
skip, missing-input honesty (absent product = skipped, never a crash),
price-history day-key staleness, one-off exemption, coverage-drop alarm
(baseline → drop → recovery), history never-shrink. Also dry-run against a
real checkout: `TLA_CORE_DIR=<path> node dryrun-local.js` (writes captured,
GitHub untouched).
