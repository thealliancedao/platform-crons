# tla-flows — changelog

Module changelog for the block-walker (index.js, lib/aux-classifiers.js) and its
gates. Page-facing changelogs live in tla-core/docs/changelogs/ — this file is
for capture-layer changes only.

## 2026-08-23 (later) — Atrium vocabulary fixture-locked; Jun-12→v2-deploy exits resolved

The owner supplied a REAL Atrium sale (tx 995038E5…, 2026-08-21, #6192, 49.99
SOLID, listing 549) — which corrected the record ("no sales since June 12" was a
BBL-only-filter error in the audit) and locked Atrium's shape: `buy_nft` joins
SALE_VERBS with attr normalization (price/listing_id → amount/auction_id). Gate
G6 asserts the fixture end-to-end (buyer/seller/gross/denom/auction, legs
consistent, fee 0 / royalty 0 as the chain says). Zero regression on the
11,582-tx FCD suite. Companion one-off in tla-core
(`nft-resolve-market-exits`) fetches every marketplace-exit tx since the last
enriched sale from the LCD, archives the raw responses, and merges v2 records
into the transfers months — the next warm's market-history pass appends the
sales. Chain fact flagged: the Atrium sale paid ZERO royalty to the DAO (BBL
enforces 5%) — a governance question, recorded in the registry note.

## 2026-08-23 — classifyNftTx v2: marketplace sales ride the walk (gated)

**The Analytics tab's inputs had no maintainer.** `sales-enriched.json` (last sale
2026-06-12) and `listing-history.json` were written by the retired data-repo Action;
the duty was never ported (parallel-run doctrine gap). First repair lands the
capture: **classifyNftTx v2** (`platform-crons/tla-flows/lib/aux-classifiers.js`)
emits `sale` / `list` / `cancel` / `bid` records for watched marketplaces, riding
the existing every-block walk. Sale-vs-cancel decided by money movement (payout
legs from the marketplace + NFT exit); BBL vocabulary (settle/create/cancel)
fixture-locked; batch-settle txs segmented by event order, never pooled;
multi-exit with no vocabulary → `resolution:'ambiguous'`, raw attrs archived
(capture truth, derive later). Registry-first: BBL / Atrium / Boost added to
`tla-voting/capture-registry.json` as `nft_marketplace` stream entries (BBL with
chain-evidenced fee/royalty roles; Atrium/Boost generic until a fixture locks
their shape).

**Gate (permanent: `tla-flows/mock-run-nft-v2.js`, full FCD archive, 11,582 txs):**
1,151 sales · 2,793 lists · 1,602 cancels · 0 ambiguous · 0 leg-inconsistent ·
v1 transfer records byte-identical · 1,087/1,087 enriched overlap on
gross+seller+buyer. v2 also corrects history: the old pipeline dropped **64
sales inside batch-settle txs** and misattributed fee/royalty/net on 13 more
(its legs don't sum to gross; v2's sum exactly). Walker suite parity: all 8
mock scenarios identical pristine-vs-modified (B/C carry a pre-existing
environment failure — logged as an open item).

Next in this arc: flows.js delisting→sale upgrade from the new records, then
sales-enriched/listing-history/luna-usd-daily forward-fill (merge INTO the org
path), then the four field-drift panel fixes on the page.
