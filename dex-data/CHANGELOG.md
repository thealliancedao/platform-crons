# dex-data — changelog

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
