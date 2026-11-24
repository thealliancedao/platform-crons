## dex-data 1.6.0 — 2026-11-24 — eris-apr: the trading-fee leg is the one Eris's page shows

Checked against a capture of Eris's liquidity-hub page taken in the same minute as our 17:02 UTC run (21 pools).

- **Matched already:** staked $ within 0.6 % on every pool but one small SkeletonSwap pool (1.9 %); rewards per year −0.4 % on
  every pool (our LUNA price is the hourly feed's, an hour older than the page's); incentive APR within 0.4 points.
- **Wrong:** the trading leg of every Astroport row. Astroport's tRPC `tradingFees.apr` is a fraction (0.0427 = 4.27 %) and
  `lib/eris-apr.js` published it as a percent, so the leg read 1/100th of its value and the APR and APY built on it read low by
  the whole leg: LUNA-USDC.inj 38.64 % for Eris's 44.57 %, LUNA-USDT 36.31 % for 43.43 %. Median gap 1.2 points, worst 7.1.
- **Source:** Eris's page does not read tRPC at all. Its bundle (`getAstroportInfo` / `getPoolInfo`) fetches
  `https://app.astroport.fi/api/pools?chainId=phoenix-1` and uses `365 × dayLpFeesUSD ÷ pool TVL`, `?? 0` for a pool the list
  lacks. `fetchAstroportLpFees()` now reads that list first. First live run (18:02 UTC): 293 pools read, all 17 Astroport rows
  from the list, and the list's figure is the same number as tRPC's (LUNA-USDC.inj 4.01 % from both).
- **Timing — corrected the same evening.** This entry first said the list ran 1.3–3× above tRPC on concentrated and stable
  pools (LUNA-USDC.inj 5.83 % on Eris's page at 17:00 against tRPC's 4.27 % at 17:01). That was wrong. Eris's page keeps
  Astroport's list for 60 minutes, so at 17:00 it was showing the figures of about 16:00 — our own 16:01 capture reads 5.88 %
  (and 7.02 % for LUNA-USDT against the page's 6.99 %) — and the trailing-day fees fell sharply in that hour. With the units
  right, this feed and Eris's page agree whenever Eris's copy is fresh, and can differ by one hour's change in fees when it is not. When it cannot be read (or no pool in it carries the field — a changed API),
  the tRPC fraction × 100 stands in, the row says so (`trading_apr_source`, flag `trading_apr_fallback_source`) and
  `meta.trading_leg` counts both. A failed read of the list is not an input error and does not turn the heartbeat `partial`.
- Mock gate: the fixture's `fee_apr` is now a fraction, as on the wire; eight new assertions (list read, pool not in the list,
  wrapped list, numeric strings, a list without the field, one pool without a figure). 97 pass.

## dex-data 1.5.1 — 2026-10-17 — single-asset cw20 gauges are singles

- state-history: a cw20 gauge with no pair minter that the TLA snapshot lists with no pair (wBTC.creda.a, Credia's receipt) is
  `single`, not `unresolved` — the P&L had no basket for it. tla-flows pnl 1.7.1 reads the same rule from the token catalog meanwhile.

## dex-data 1.5.0 — 2026-09-27 — LST ratios anchored on the chain (Milestone A step 3 (i))

- New `lib/ratio-anchor.js` 1.0.0 — ONE rule for the LST ratio series, two callers: the one-time tla-core Action
  `ratio-reanchor` (history) and state-history 1.2.0 (forward). Anchors = each complete epoch's `lst_hubs` chain read at its
  height_time; a day = log-linear between the two bracketing reads at 12:00 UTC (tier `chain_anchored`, `anchors:[eA,eB]`);
  `chain_exact` rows never change; repairs labeled in place (`repair.was` write-once); idempotent.
- Why: price-history/ratios' `interpolated` rows ran ampLUNA +10.6 % / bLUNA +4.9 % high in 2024 (every LST USD row built on
  them too) — the cost basis for Milestone A inherits it. Validation: the chain reads agree with the 2026-05-13+ chain_exact
  archive within 0.08 % (ampLUNA) / 0.31 % (arbLUNA) / 0.09 % (bLUNA) / 0.00 % (ampCAPA).
- state-history 1.2.0: after a new complete epoch, writes the days since the previous complete epoch into
  price-history/ratios (ratios only — the LST USD rows are token-catalog's measured `tla` prices). Isolated (a failure never
  fails the sample); `RATIO_FORWARD=0` turns it off. The series had been frozen since 2026-07-16.
- Gate: `mock-run-ratio-anchor.js` (real tla-core checkout, heap-capped 200 MB) 10/10 — anchors, chain vs archive, the error
  is real, every day between its reads, labels, untouched rows, USD = base × ratio, idempotent, forward = history for the
  newest week, forward writes ratios only. (mock-run-state-history.js is stale on main — its epoch-203 scenario is complete
  in the checkout now; unchanged here.)

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
