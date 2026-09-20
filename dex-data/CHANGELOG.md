## dex-data 1.4.3 — 2026-09-20 — eris-apr: a fresh LUNA price (owner's APR audit vs Eris)

- Finding: every eris-apr product since 08-02 says `luna_price_source: token-catalog/tla (fallback)` — the adapters have never
  carried a uluna asset price on a real run, so the catalog's once-a-day price (~12:36Z) priced the whole day. On 2026-09-20
  LUNA moved 19 % intraday and the 18:02Z product read −14.8 % against Eris's own Rewards $ on EVERY pool (same factor);
  the 23:02Z product, on a refreshed catalog price, read +2.1 % — stage 2 (provisions × weight × distribution) is exact.
- Fix: second tier = the org's live LUNA feed (network-and-prices `token_prices.LUNA.final_price_usd`, hourly, the price the
  page trusts), labeled `network-and-prices/<source> (live)` with `luna_price_as_of`; the catalog stays the last resort.
  The formula is untouched. Mock: live feed up → priced live and labeled; live feed down → catalog fallback as before;
  incentive APR scales with the price alone (84/84).
- Still open after this: four pools (LUNA-USDC.n −23 %, LUNA-USDT −22 %, LUNA-INJ −30 %, LUNA-SOLID −12 % on APY) with
  rewards identical to Eris — the trading-fee leg substitution (their pool service is not queryable); a label on the page
  until Eris's fee source is found.

# 1.3.5 — 2026-09-10 — eris-apr: validation marker cleared; Credia row named

## 1.4.0 — 2026-09-13 — state-history duty folded in (moved from the tla-core Action) — PUBLIC endpoints forward

- `lib/state-history.js` — the per-epoch pool-state sampler, MOVED from `tla-core/.github/scripts/dex-state-history/
  {lib,sample}.js` (logic verbatim; those files + the two workflows are deleted — no second copy). It was born as a backfill
  Action (104 epochs from the archive node); forward it is one epoch a week, which is this job's business.
  LAW: Actions = one-time, Render = scheduled. LAW: forward capture uses PUBLIC endpoints — the archive was for history
  the public node cannot see, and is not used by this cron.
- Transport: `PUBLIC_LCD` (default terra-lcd.publicnode.com) — the boundary sample runs ~30 min after Monday 00:00, a few
  hundred blocks back, inside the public node's window. `ARCHIVE_LCD`/`ARCHIVE_RPC` are backfill/repair knobs only (set,
  trigger, remove). In public mode a `depth` answer never completes an epoch (kept incomplete, retried next run) — a
  pruned answer can never freeze blanks under write-once; in archive mode depth stays an honest blank as before.
  Every epoch file and the heartbeat carry `source: public | archive`.
- Folded module after the core snapshots, isolated like credia-rates: fatals THROW (`ArchiveFatal`), never exit.
  Fast exit with ZERO chain traffic unless a started boundary is missing / incomplete (index.json is the truth).
  API reads/writes replace the checkout + git checkpoints; corpus (epoch table, tla-snapshot, tla-flows/events months)
  via raw reads. Index rows keep the Action's exact shape.
- Env: none required. Optional `REQ_DELAY_MS` (150), `REFINE_MAX` (8), `TIME_BUDGET_MIN` (20), `PUBLIC_LCD`,
  `STATE_HISTORY=0`; backfill = `EPOCH_FROM`/`EPOCH_TO` (+ `FORCE=1`, + `ARCHIVE_LCD` when the span is beyond the
  public window). Products unchanged: `dex-data/state-history/{epochs/<n>.json, index.json, cursor.json, heartbeat.json}`.
- Gate `mock-run-state-history.js` 24/24 on real committed inputs + a deterministic fake node: skip-fast with zero
  requests · public mode default (factory handed PUBLIC_LCD, unmasked; archive mode only with ARCHIVE env) · depth in
  public mode → incomplete, same answers in archive mode → complete · one missing epoch sampled with exactly {epoch,
  cursor, index, heartbeat} written and every prior index row byte-equal · write-once · transport failure kept
  incomplete then completed next run · fatal throws · FORCE resamples. `mock-run.js` 82/82 unchanged.

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
