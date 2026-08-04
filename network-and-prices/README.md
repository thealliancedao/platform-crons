# network-and-prices (org home) — 3.0.0

Hourly oracle-reference capture: Terra network state, LUNA market data, LST
hub exchange rates, dual-source token prices (Astroport metrics + CoinGecko)
with match-quality classification, LST hub-vs-market divergence checks, and —
new in 3.0.0 — a **standing price canary** that cross-checks every final price
against xyk-implied prices from tla-core's own dex-data captures.

**This is the canonical home.** Ported 2026-08-04 from
`defipatriot/cron-scripts/network-and-prices` (v2). The legacy repo is
inspiration-only: fixes land HERE.

## Outputs (published to `thealliancedao/tla-core`)

| path | cadence | notes |
|---|---|---|
| `network-and-prices/current.json` | hourly | main product; schemaVersion 2 (deliberately — v3 is field-additive) |
| `network-and-prices/daily/{date}.json` | 23:xx UTC | end-of-day archive |
| `network-and-prices/ratio-history.json` | daily | append-only LST rate series, never-shrink guarded; **first org run auto-seeds from the legacy repo** so the series never restarts |
| `network-and-prices/heartbeat.json` | hourly | uniform freshness contract + `price_canary_flags` |

## Price canary (PHASE 6.5)

Every `final_price_usd` is compared against the price implied by the deepest
**xyk** pool pairing that token with a trusted anchor (USDC/USDT/LUNA at our
own finals) in tla-core's dex-data captures. Depth floor $5,000; drift flag
>10% (matches the Phase-6 review convention). **Concentrated/stable pools are
excluded by doctrine** — their reserve ratio deviates from price by design and
reading them as market prices manufactures phantom divergences (see
`tla-core/docs/pending-changes/AUDIT-eris-apr-pricing.md`, 2026-08-03 audit).
SkeletonSwap references are included but marked `reference_unverified`.
The canary **never changes final prices and never fails the run** — it emits
`price_canary` in the snapshot and `price_canary_flags` in the heartbeat for
human review.

## Deploy (Render)

New cron job, hourly, root directory `network-and-prices/`:
- build: `npm install` (no deps — instant)
- start: `node index.js`
- env: `GITHUB_TOKEN` (org token with tla-core write). `GITHUB_REPO` /
  `GITHUB_BRANCH` default correctly — do not set unless testing.

## Parallel-run → cutover (doctrine)

1. Deploy this job; **leave the legacy Render job running.**
2. After ≥24h, verify legacy fields identical: compare
   `tla-core/network-and-prices/current.json` vs the legacy
   `data/network-and-prices.json` from captures minutes apart — every
   pre-existing field family (network, luna_market, lst_ratios, token_prices)
   should match modulo capture-timing jitter; `price_canary` is org-only.
3. Confirm `ratio-history.json` in tla-core carries the FULL legacy series
   (migration seed) + new day-points.
4. Repoint consumers (grep list, all read the legacy raw URL today):
   - `platform-crons/lib/capture-engine.js` line ~59 (`NETWORK_PRICES_URL`)
   - `platform-crons/nfts/adao/index.js` (price URLs)
   - `platform-crons/lib/portfolio-assembler.js` (priceFlags URL)
   - site: `tla-stats.html` `CONFIG.networkPricesUrl`, nft-inventory sister
     URLs, and any page reading `network-and-prices-data_2026`
5. Retire the legacy Render job. Then remove the `LEGACY_REPO_RAW` migration
   fallbacks here (2 reads) — they are cutover scaffolding.

## Gate

`node mock-run.js` — file-based, no network, no env. Two layers: (1)
provenance — rebuilds index.js from `fixtures/legacy-v2.js` + the two shipped
edit scripts and asserts byte-identity, proving the port is exactly
legacy + declared edits; (2) behavior — the exported live functions on
trimmed-REAL fixtures (live captures 2026-08-03/04), 24 assertions with
pinned values. Re-run after ANY change; keep the edit scripts in sync or
replace Layer 1 with a new baseline when the module diverges from the port.
