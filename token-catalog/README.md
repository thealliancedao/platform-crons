# Token-Catalog Cron

The platform's **WORTH layer** — what tokens exist in TLA and what they're worth.
The companion to address-catalog (the WHO layer). Built in **stages**, each verified
on a parallel run before the next was layered on. **All stages are now complete.**

| Stage | Adds | Status |
|-------|------|--------|
| **1 — discovery** | pools (active + inactive) + underlying tokens | ✅ done |
| **2 — identity** | discovered symbol / decimals / logo / coingecko_id, variations, override layer | ✅ done |
| **2.1 — verification** | coingecko-id verification (vs CG terra-2 index) + identity sub-score | ✅ done |
| **3.0 — pricing** | TLA + CoinGecko prices, snapshot-coherent, + LST hub-ratio redemption | ✅ done |
| **3.1 — DEX pricing** | Astroport + SkeletonSwap (pair-implied) → four-source agreement + composite grade | ✅ done |

Reserves & slippage **grading** remain out of scope — that's the `dex-data` domain.
Token-catalog stops at "what exists, what it's worth, and how trustworthy the price is."

> **The "why" behind the pricing rules below is sourced in
> `tla-core/docs/ecosystem-knowledge/`** — see `eris-protocol.md` (ampLUNA/arbLUNA/ampLP
> mechanics), `astroport.md` (XYK/PCL/stableswap), and `tla-stats-system.md` (our
> pricing doctrine as citable facts). This README says *what the cron does*; those say
> *why it's correct*.

## Why discovery first

You can't price what you don't know exists. Stage 1 enumerates the **complete** TLA
pool set and resolves every LP to its underlying tokens. That token set *is* the price
list — Stage 3 prices exactly what discovery finds, nothing more (only what's in TLA,
not all of Astroport/SkeletonSwap).

## Discovery chain (Stage 1)

1. **Active pools** — gauge `distributions` (active set + vote %).
2. **Inactive pools** — `whitelisted_asset_details` on each of the 4 staking buckets.
   Returns the COMPLETE set incl. below-threshold and dewhitelisted, each flagged
   `whitelisted:true|false` with take-rate metadata.
   WARNING **Phase-0 scar:** this query, NOT `whitelisted_assets` (which is active-only).
3. **Underlyings** — cw20 LP -> `minter` -> pair -> `pair{}` asset_infos; native/factory
   LP -> pair from `factory/{addr}/` denom -> `pair{}`. Each underlying denom is distinct
   (wBTC.axl != wBTC.eureka — variations preserved, resolved in Stage 2).

## Identity (Stage 2 / 2.1)

Discovered identity per token from the cosmos chain-registry (authoritative) +
SkeletonSwap (logo backfill): `discovered{ symbol, display_name, decimals, logo_url,
coingecko_id, variation_of }`. Stage 2.1 verifies each `coingecko_id` against the
committed CG terra-2 index (`docs/curated/coingecko-terra2-index.json`, built by the
manual GitHub Action), with provenance states `cg_confirmed` / `registry_assigned` /
`mismatch` / `no_mapping`, and an identity sub-score (0-100).

## Pricing (Stage 3.0 / 3.1) — four sources, snapshot-coherent

All price sources **and** LST hub ratios are fetched in one tight batch so they
describe the **same instant**. Comparing sources captured at different times is invalid
(snapshot-coherence). The four sources:

| Source | What | How |
|--------|------|-----|
| **TLA** | `backend.erisprotocol.com/prices` | denom -> price_usd (what the TLA UI shows) |
| **CoinGecko** | `simple/price` | by verified `coingecko_id` |
| **Astroport** | `tokens.byChain` | direct `priceUsd` (dug from tRPC envelope) |
| **SkeletonSwap** | warlock `pools` | **pair-implied**, anchor method (below) |

Per token, `prices{}` carries all available sources + a source-agnostic
`price_confidence` (sources_available, sources_agreeing, spread_pct, flags), and a
composite `scoring.overall` = 0.75 x price + 0.25 x identity (weights editable in
`scoring_weights.json`). A missing price grades on identity and is marked `partial` —
never faked to 0.

### SkeletonSwap pair-implied pricing — the rules that earned their keep

- **Anchor method, NOT tvl/2.** `price_token = (reserve_anchor / reserve_token) x
  anchor_price`, using LUNA/USDC/USDt as trusted anchors. The naive tvl/2 method is
  wrong — it gives one token two different prices. Anchor method validated 7/8 within
  3%. (XYK reserve-ratio = price; see `astroport.md`.)
- **Skip stableswap pools.** Their amplified curve means reserve ratio != price; pricing
  them gives wrong answers. Pools whose type contains `stable` are skipped.
- **Liquidity floor `SS_MIN_TVL_USD` ($500).** A near-empty pool still produces a
  number, but it's noise — a ~$0.16-liquidity pool once manufactured a $43k wBTC price.
  Pools below the floor are skipped. (Reduced noisy SS prices 24 -> 10.)

### LST redemption cross-check — five hubs

For each LST (ampLUNA, arbLUNA, ampROAR, ampCAPA, bLUNA) the cron queries its on-chain
hub for the exchange rate (in the same snapshot) and computes
`redemption_price = base_price x ratio`. Per the proven doctrine:

- **The hub-ratio redemption price is the ROBUST/primary number.** The market/TLA price
  is a weaker cross-check that can legitimately differ.
- The `lst{}` block carries `hub_ratio`, `redemption_price`, `market_price`,
  `market_vs_redemption_pct` (signed), and `review_flag`. Language is **neutral**
  ("market sits above/below redemption value") — never an auto-alarm.
- **Only a large gap (> `LST_REVIEW_FLAG_PCT`, 10%) is flagged for review.** A 2%
  threshold would false-alarm on timing noise — confirmed: an ampLUNA gap read 8% one
  snapshot and 0.5% the next (pure timing).
- **arbLUNA legitimately diverges** because it's a strategy (arbitrage) vault, not a
  clean staking derivative — its market can sit below redemption due to the 25-day /
  5%-instant-exit withdrawal cost. This is expected, not a depeg. Full mechanism +
  sources: `ecosystem-knowledge/eris-protocol.md`.
- **xASTRO is intentionally price-only** (no redemption cross-check) — its hub is on
  Neutron (cross-chain), not worth the squeeze. Documented in `config/contracts.js`.

We **surface source disagreement, never hide or "correct" it** — e.g. Astroport
misprices bLUNA at ~LUNA's price; we report it and let the spread flag `wide_divergence`.

## Output

`tla-core` `token-catalog` module, snapshots product. Every stage enriches the **same**
`current.json` (the page reads it throughout). Forward-only.

```
token-catalog/snapshots/
- current.json             pools[] + tokens[] (identity + prices + lst + scoring)
- daily/{YYYY-MM-DD}.json  forward-only daily snapshot
- index.json               manifest
- heartbeat.json           standard heartbeat
```

`current.json` token shape (final):

```
tokens[] {
  denom, kind, found_in_pools[],
  discovered { symbol, display_name, decimals, logo_url, coingecko_id, variation_of },
  identity_flags, sources,
  prices { tla, coingecko, astroport, skeletonswap }   each { usd, captured_at, status },
  price_confidence { sources_available, sources_agreeing, spread_pct, score, flags },
  lst { is_lst, hub_ratio, base, redemption_price, market_price,
        market_vs_redemption_pct, review_flag, note },     (LSTs only)
  scoring { identity, price, overall, partial, weights }
}
```

`pricing_stats` also carries the full live `lst_ratios` table.

## The override layer

Per-field overrides let a human correct what discovery reads: `{ discovered,
override:bool, value, note }`. `override:false` -> use `discovered`; `true` -> use
`value`. Overrides live in `token_overrides.json` (curated, tla-core) — **never** in
the cron's discovered output; merged at read time. Discovery keeps running underneath,
so clearing an override auto-returns to the live read.

## Single source

Structural addresses (gauge, staking buckets, **LST hubs**) come from
`config/contracts.js`. The cron has **zero** hardcoded addresses.

## Render setup

- Repo: `thealliancedao/platform-crons` - Root dir: `token-catalog`
- Build: `npm i` - Start: `node token-catalog.js`
- Schedule: hourly is reasonable now that pricing is live (prices move; identity/
  discovery don't need fresher than 6h, but the batch is cheap).
- Env: `GITHUB_TOKEN` (fine-grained, `thealliancedao/tla-core`, Contents r+w),
  `GITHUB_REPO` (optional, defaults to the org).

Without `GITHUB_TOKEN` it writes local `token-catalog.json` + `heartbeat.json` only.

## Recent changes

- **1.4.2-stage3.1** — concurrent-write hardening. Commit now retries on GitHub
  409/422 sha-conflict (multiple crons write to tla-core; a file's sha can change
  between our GET and PUT). Re-fetches fresh sha and retries up to 5x. No
  data/logic change — fixes intermittent run failures as the cron fleet grew.

- **1.4.1-stage3.1** — dust-pool floor fix (`SS_MIN_TVL_USD`). A ~$0.16-liquidity pool
  was manufacturing a $43k wBTC price; pools below $500 TVL are now skipped (noisy SS
  prices 24 -> 10, `wide_divergence` flags 8 -> 3 — real disagreements only). Version
  bumped from 1.4.0 so the fix committed cleanly (lesson: bump version on every code
  change so `meta.version` verifies deployment).
- **1.4.0-stage3.1** — DEX pricing. Added Astroport (`tokens.byChain`, direct priceUsd)
  + SkeletonSwap (warlock pools, anchor-method pair-implied, stableswap skipped) ->
  four-source agreement per token.
- **1.3.0-stage3** — pricing + LST ratios. Snapshot-coherent TLA + CoinGecko prices;
  five LST hubs queried for redemption cross-check (redemption = robust, market = weak,
  neutral framing, 10% review threshold). LST_HUBS added to `config/contracts.js`.
  arbLUNA confirmed as a strategy LST (see ecosystem-knowledge). xASTRO deferred
  (Neutron cross-chain).
- **1.2.0-stage2.1** — verification + identity score (CG terra-2 index, provenance
  states, identity sub-score).
- **1.1.0-stage2** — identity (chain-registry authoritative + SkeletonSwap logo
  backfill; overrides merge on read).
- **1.0.2-stage1** — DEX labels (cw2 contract_info -> Astroport / Skeleton Swap + version).
- **1.0.1-stage1** — single-asset handling (xASTRO, ampCAPA, ... resolve as single_asset).
- **1.0.0-stage1** — discovery (active + inactive pools, underlying resolution).
  Consolidated the discovery half of network-and-prices + contract-token-catalog +
  tla-registry.
