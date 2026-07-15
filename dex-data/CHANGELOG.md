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
