# 1.3.5 — 2026-09-10 — eris-apr: validation marker cleared; Credia row named

`meta.validation` had still read "pending ground-truth reconciliation" after 1.3.3/1.3.4 reconciled every row
to the Eris screen — now states what was reconciled and when. Credia market rows take the catalog's effective
symbol for the receipt token (`wBTC.creda.a`, `pool_name_source: token-catalog symbol (receipt)`) instead of
the adapter's `ibc/88386A… (Credia market)` placeholder. No figure changes; mock 82/82, real-fixture 50/50.

# 1.3.4 — 2026-09-10 — eris-apr: trading leg source-verbatim (single gauges = own yield; SS = 0 by source)

The 1.3.3 gap flag is resolved from the source. Owner HAR of the liquidity-hub
page (chunk 101.f44f1501107e40cb.js, `getPoolInfo`) shows the `trading` leg per
pool kind: Astroport pair = 365 × dayLpFeesUSD / TVL (our fee_apr substitutes);
SkeletonSwap pair = `Promise.resolve(0)` — a hard zero by THEIR source, so our
SS rows now carry `trading_apr_source: "… 0 by Eris source"` and no "assumed"
flag; single gauges = the asset's OWN yield labeled "Staking APR"/"Supply APR":
xASTRO ← Astroport tRPC `protocol.stakingApy` (neutron-1) `weekApr`; ampCAPA ←
hub `exchange_rates{limit:14}.apr × 365.25` (a frozen hub still reports >0
because the last 14 stored points predate the freeze — that is the ~4.8 pp);
Creda ← `metrics.assets[].supply_apy`; anything else 0. The composition itself
is unchanged and re-confirmed verbatim: `apy = aprToApy(0.92·inc) + trading −
take`, `total = inc − take + trading`.

Implementation: `SINGLE_YIELD_SOURCES` (the two hardcoded assets, exactly as
Eris hardcodes `j.TV.xastro` / `j.TV.ampcapa`) read in captureInputs →
`single_yield_by_key`; compose publishes `trading_apr_source` on every row; a
failed source read nulls the leg WITH the 1.3.3 flag kept — never borrowed.

Gates: mock M7d (+11, suite 82/82) incl. source-down honesty; real-fixture gate
50/50 — Credia via the committed supply_apy lands 5.85 vs Eris 5.76 (LUNA price
differs 2.2%); with the screen's own-yield legs our incentive/staked inputs
reproduce ampCAPA 19.65 and xASTRO 33.08 to 0.00 pp. First live run is the
source-read reconcile for the two singles.

# 1.3.3 — 2026-09-10 — eris-apr: SkeletonSwap + Credia staked basis, single names, catalog decimals

Owner audit (Eris screen, 2026-09-10 15:xx UTC) vs the committed product: every
SkeletonSwap gauge pool and the Credia market published `tla_staked_usd = null`
→ APR/APY null (5 SS pools $44.7K/$30.4K/$8.0K/$13.2K/$40.3K + wBTC.creda.a
$80.7K on Eris), and the two single-asset rows had `pool_name: null`. Causes,
one per leg: (1) the SS adapter defers TVL by design ("computed downstream from
reserves × trusted prices") and eris-apr never performed that join; (2) the
Credia adapter left `lp_total_supply` null although the gauge stakes the
vproxy RECEIPT token whose supply is `state.supply_vtotal`; (3) single entries
have no pool record and nothing named them; (4) latent: `catalogPrice` read a
top-level `decimals` that the catalog schema never had → every catalog
fallback priced at 6 decimals (8-dec wBTC would have been 100× off on that
path).

Fix, all labeled: new staked basis
`staked_supply_ratio_x_reserve_implied_tvl (<price source>)` — Σ reserve ×
token-catalog price over the pool's assets, tried ONLY when the adapter TVL is
null and reserves + supply exist; ANY unpriced asset nulls the whole leg with
`reserve_tvl_unpriced:<reason>` (never a partial sum); implied pool TVL
published beside it (`pool_tvl_usd_reserve_implied`). Credia adapter publishes
`lp_total_supply = supply_vtotal` so the standard basis applies. Singles named
from the catalog's `effective` layer (its stated downstream contract;
`pool_name_source`), decimals read from the same layer. NAMED GAP, not guessed:
`single_asset_yield_leg_unmeasured` — Eris's screen adds a leg on single
gauges beyond incentive − take (xASTRO 15.4 vs 33.08, ampCAPA 14.8 vs 19.65)
that the source-confirmed formula does not carry.

Gates: mock M7c (+7, suite 71/71); real-fixture gate on the committed
2026-09-10 products vs the owner's screen 40/40 — 18 Astroport rows
byte-identical (regression), SS/Credia staked within 0.5% of Eris (ATOM-LUNA
1.35%), APR within 0.4 pp, all six within 1.5% of member-data's independent
figure, 26/26 fully priced (was 20/26). Clears the product's "pending
ground-truth reconciliation" marker for pair pools; singles carry the gap flag.

# 1.3.1 — 2026-08-02 — eris-apr resilience: token-catalog price fallback (labeled)

First live run (during a live astroport tRPC outage — their backend 500ing on
an internal 403) proved two things: every chain-input shape parsed (status ok,
28 gauge entries) AND the product's USD legs all rode the astroport adapter
(LUNA price + asset prices), so one upstream DEX outage nulled 28/28. Fix:
token-catalog (the org price home, PRICING-DOCTRINE priority tla > coingecko >
astroport > skeletonswap) now backs up the LUNA price and single-asset prices
— adapter prices stay PRIMARY, every fallback use is source-labeled
(`token-catalog/<src> (fallback)` in `luna_price_source` / staked basis).
Pair-pool TVL legs have no substitute and stay honestly null when astroport is
down. Gate: M7b, full suite 64/64 (incl. catalog-also-down -> honest nulls,
run survives).

# 1.3.0 — 2026-08-02 — eris-apr rider: cron-published Eris-convention APR (audit fix #4)

- **eris-apr rider (AUDIT-eris-apr-pricing fix #4):** new `lib/eris-apr.js` +
  orchestrator stage publishing `dex-data/eris-apr/{current,daily/<date>,heartbeat}`.
  Implements Eris's OWN displayed-APR pipeline source-confirmed via Philipp
  (audit §Gauge-LP-APR), VERBATIM mixed convention: `eris_apy_pct =
  aprToApy(incentive×0.92, 365.25) + trading − take` and `eris_apr_pct =
  incentive − take + trading` (their linear `total`, no 0.92 — per source).
  Inputs: `/terra/alliances` + `annual_provisions` (LCD), connector→gauge
  SELF-DISCOVERED from alliance factory denoms via `{config:{}}` probes (zero
  hardcoded connector addresses), controller `distributions` raw (never
  normalized; sum deviations reported), per-bucket `total_staked_balances` +
  `yearly_take_rate` from `whitelisted_asset_details` configs. TLA-staked USD =
  staked/lp-supply ratio × pool TVL (unit-free); single-asset entries priced
  via adapter asset prices; zero staked = $0 by identity. Edge cases verbatim
  (0/0→0; tvl==0→Infinity published null+flag). Honest nulls with reasons,
  components always published; substitution stated (trading = our fee_apr).
  Stage isolated like a DEX — its failure never touches per-DEX products.
  Gate: mock-run M7, 21 asserts on hand-computed fixtures, full suite 59/59.
  ⚠ Deploy step: reconcile against BOTH ground-truth tables (SPEC-lp-apr §7 +
  §2.10) before any page consumes the figures — `meta.validation` carries the
  pending marker until then.

# 1.1.0 — 2026-07-15 — bucket labels now GAUGE TRUTH (defect register #8, closed)

The bug, found by cross-checking tonight's committed snapshots against
token-catalog's gauge truth (join on pair_address): Astroport derived buckets
from `total_staked_balances` MEMBERSHIP — where LP happens to be STAKED — which
disagrees with the gauge's own classification exactly where cross-bucket strays
exist. Three live mislabels: LUNA-SOLID stable→project, USDC-USDT
bluechip→single, LUNA-WHALE null→project. SkeletonSwap labeled NOTHING (27
gauge pools bucket:null — "join is downstream" was a gap, not a design).

The fix — `lib/bucket-truth.js`, shared by both adapters:
- Truth source: `whitelisted_asset_details` on the 4 bucket contracts (the
  COMPLETE gauge set, active + below-threshold + dewhitelisted, each flagged
  whitelisted:true|false — the same source token-catalog's discovery uses).
  Contracts now imported from config/contracts.js (EDIT RULE honored; the
  adapter's hardcoded copy retired).
- Pair resolution, self-contained: cw20 LP → `{minter:{}}` → pair address;
  native factory LP → denom parse. Both adapters join on pool_address; no
  reads of other crons' output.
- Honesty rules: multi-bucket appearances keep ALL of them — whitelisted wins,
  canonical order breaks ties, `ambiguous_buckets` DECLARED (the USDC-USDT
  bluechip stray is now data, not a mislabel). Dewhitelisted-only assets keep
  their bucket with whitelisted:false (ghosts visible, not hidden). Total
  truth failure → bucket:null + meta.bucket_errors — NEVER a fallback to
  staked-membership; a missing label is honest, a wrong one is not.
- `raw.gauge` per TLA pool: gauge_pool_id, whitelisted, ambiguity.
  meta.bucket_source declared in both adapters.
- Memoized per process — one truth fetch serves both adapters per run.

Mock gate NEW (mock-run.js, binding for future main-loop changes): 31/31 —
pure resolution rules, the crafted chain reproducing all three real mislabels
+ ghost + factory-native + minter-failure + total-failure paths, both
adapters end-to-end on stubbed network.

Deploy: commit the folder — no schedule/env change. Verify next run:
LUNA-SOLID shows project, USDC-USDT single, SS pools carry buckets.

---

# dex-data — changelog

## 1.0.2 — 2026-06-29 — concurrent-write hardening

- Commit function now retries on GitHub 409/422 sha-conflict. With several crons
  writing to the same tla-core repo, a file's sha can change between our GET and
  PUT (another cron committed first), which GitHub rejects with 409. We now
  re-fetch the fresh sha and retry (up to 5x, small backoff). Almost all
  collisions resolve on the first retry. No data/logic change.

## 1.0.1 — 2026-06-26 — SkeletonSwap trustworthy-source fix

First-run verification did its job. Astroport captured perfectly (275 pools, 36
TLA-relevant, all fields mapped, zero nulls on tvl/volume/fees). SkeletonSwap
surfaced a real architectural correction:

- **Was reading warlock** (dex.warlock.backbonelabs.io) — which the proven old SS
  cron deliberately moved OFF as the stale source (the very reason trust_start
  exists). Rebuilt to the trustworthy path: pools_list.json metadata + DIRECT
  chain reserves ({"pool":{}} -> data.assets[].amount + total_share).
- **Volume honestly NULL** — confirmed against the old cron, SkeletonSwap has no
  trustworthy volume source (old cron writes it empty: "no trustworthy source").
  We null it rather than fake it from warlock. Fail honest, never fake.
- **TVL null at capture** — priced downstream by joining trustworthy chain
  reserves to token-catalog's trustworthy prices; we never invent a price in the
  adapter.
- Grading implication: SkeletonSwap contributes liquidity/depth (once priced) but
  NOT volume to grades — honest data, not a flaw.

## 1.0.0 — 2026-06-26 — initial forward-capture

The first cron of the trading-quality grading system (Component A of
SPEC-grading-and-dex-data.md). Captures DEX pool primitives correctly so
trustworthy, un-gameable history starts accruing immediately (forward-capture
urgency: past on-chain state is pruned and unrecoverable).

**The journey / why it's built this way:**

- **Per-DEX separation** (requested): each DEX is a self-contained adapter so one
  can be shut off or added without touching others, and isolated failures don't
  cascade. Astroport + SkeletonSwap live; Credia a disabled placeholder.
- **The aggregation fix** — reading the old astroport cron revealed the averaging
  method the user rightly doubted: volume was divided by a fixed `/42` expected
  count (missing = 0), while liquidity averaged by actual count. That's a real
  bug — it mis-denominates volume and conceptually misframes a FLOW as a level.
  Settled the correct doctrine before building: **volume = SUM (flow), liquidity
  = time-weighted AVG + min + cv (stock)**, with capital-efficiency ratio and
  gap-honesty metadata on every aggregate. Validated against the user's own week
  example.
- **Mined, not inherited** — took the proven discovery (Astroport `pools.getAll`
  + 4 staking-contract `total_staked_balances` cross-reference for active+inactive
  TLA pools) from the old cron, but built fresh structure and fixed the averaging.
- **Neutral notable-window capture** — records intra-window volume concentrations
  as observations, not "problem" flags; judgment (wash/whale/organic) deferred to
  v2 wallet-attribution forensics. Captures the moment now since it can't be
  reconstructed later.
- **Per-DEX trust_start** — SkeletonSwap data trustworthy only post-warlock-fix;
  the grader excludes pre-trust history.

**Deferred (v2+):** rising-threshold consolidation of notable windows (day →
epoch → month → year), wallet attribution via block-range tx search, depth/
slippage simulation refinement, wash/bot filtering, the grade composition itself.
