# dex-data Cron

Forward-capture of DEX trading data for TLA Stats — **Component A** of the
trading-quality grading system (`SPEC-grading-and-dex-data.md`). Captures the
right primitives correctly NOW so trustworthy, un-gameable history accrues.

This cron CAPTURES; it does not grade. The grade composes later (asset-value
rubric + support gap) once history is statistically real. Get the data right first.

## Per-DEX separation (by design)

Each DEX is a **self-contained, independently pluggable** adapter in `dexes/`.
This is deliberate so a DEX can be shut off or a new one added without touching
any other, and one DEX failing never affects the others.

```
dexes/
  _contract.js     the adapter interface + normalizePool() (common pool shape)
  astroport.js     enabled  — pools.getAll + TLA gauge cross-reference
  skeletonswap.js  enabled  — warlock backend; trust_start = post-warlock-fix
  credia.js        DISABLED — placeholder; fill capture() + enable to add Credia
```

- **Add a DEX:** drop a module in `dexes/`, add it to the registry in `index.js`.
- **Remove/disable a DEX:** `enabled:false` (or remove from registry).
- **Isolation:** each `capture()` runs in its own try/catch; a failure is logged
  and the run continues with the others (partial success is success).

Each adapter is **self-contained** — it fetches its own source (per platform
doctrine: new crons query sources themselves, not other crons' output) and
normalizes to one common per-pool shape so downstream grading is DEX-agnostic.

## The aggregation doctrine (lib/aggregate.js) — the thing we got right

The core design decision, settled before building:

- **VOLUME is a FLOW → aggregate by SUM.** A period's volume is the TOTAL that
  traded; zeros are real "no trades"; an average is only a derived convenience.
  Example: `1000, 0, 3000, 6500, 0, 0, 100000` over a week → week volume =
  **110,500** (the sum). The old cron's `/42` (averaging volume by a fixed
  expected count, missing = 0) was wrong — it both mis-denominated volume and
  conceptually misframed a flow as a level. We do not carry that forward.
- **LIQUIDITY is a STOCK → time-weighted AVERAGE**, plus **min** and a
  **coefficient of variation (cv)** for stability. Avg alone hides risk: a pool
  that averages deep but briefly drains is more dangerous than a steadily-deep
  one, and avg-only is gameable by a momentary injection around a snapshot.
- **Capital efficiency = volume / avg-liquidity** — often more decision-useful
  than either number alone ("is this liquidity actually used?").
- **Gap honesty** — every aggregate carries `snapshots_used` /
  `snapshots_expected` / `has_gaps` / `coverage_pct`. A summed volume with
  missing chunks UNDERSTATES; we flag low-coverage aggregates, never present
  them as firm.

### Notable windows (neutral capture for later forensics)

`notableWindows()` records intra-window volume concentrations (e.g. any bucket
≥10% of the window total) as **neutral observations** (`volume_concentration`),
NOT "problem" flags. A concentration may be wash, a healthy whale trade, or a
busy hour — that judgment comes LATER (v2 wallet-attribution forensics via
block-range tx search). We capture the moment now (it can't be reconstructed
later) without pre-judging it.

> v2 (deferred): rising-threshold consolidation (notable at day → epoch → month
> → year scale) over accrued daily files, and wallet attribution of flagged
> windows. The fine-grained daily files are retained so nothing is lost.

## Trust start-lines (per-DEX)

Each adapter declares `trust_start` — the date its data is trustworthy from. The
grader must exclude pre-trust data. **SkeletonSwap = post-warlock-fix** (pre-fix
SS data went stale). Astroport has no hard cutoff, but its averaging METHOD was
fixed here (sum vs the old /42), so we vet the method, not just match old numbers.

## Output (per-DEX, independent paths)

```
dex-data/<dex>/snapshots/current.json       latest capture (meta + pools[])
dex-data/<dex>/snapshots/daily/<date>.json  forward-only daily archive
dex-data/<dex>/snapshots/heartbeat.json     freshness signal
dex-data/index.json                         which DEXes are enabled + last status
```

Per-pool normalized shape: `dex, pool_address, pool_name, pool_type, bucket,
tla_relevant, assets[], tvl_usd, volume_24h_usd, volume_7d_usd, fees_24h_usd,
fee_apr, lp_total_supply, raw{}`.

## Render setup

- Repo: `thealliancedao/platform-crons` · Root dir: `dex-data`
- Build: `npm i` (no deps) · Start: `node index.js`
- Schedule: frequent enough to resist single-snapshot gaming — hourly to start;
  finer (e.g. 15-min) later for notable-window granularity.
- Env: `GITHUB_TOKEN` (fine-grained, `thealliancedao/tla-core`, Contents r+w),
  `GITHUB_REPO` (optional, defaults to the org). Without a token it writes to
  `./out/` locally.

## Recent changes

- **1.0.0** — initial forward-capture. Per-DEX adapters (Astroport, SkeletonSwap;
  Credia placeholder). Correct aggregation doctrine (volume=sum, liquidity=avg+
  min+cv, capital-efficiency ratio, gap honesty). Neutral notable-window capture.
  Per-DEX trust_start. Mined the proven discovery (pools.getAll + gauge
  cross-reference) from the old astroport cron; fixed the /42 averaging bug.

## Fail honest, never fake (SkeletonSwap case)

If a DEX has no trustworthy source for a metric, the pool shows **null** for that
metric — never a fabricated or stale-sourced number to make pools look votable.
SkeletonSwap has no trustworthy volume source, so SS volume is honestly null. A
pool too thin to verify can't be confidently graded or voted on — which is
correct pressure on the DEX/project to expose proper data, not on us to subsidize
its absence. A null is a feature: it says "unverifiable," which is more
trustworthy than any best-effort guess and can't be gamed.
