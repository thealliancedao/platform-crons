# lp-grades — the unified LP grading cron

Implements `tla-core/docs/pending-changes/SPEC-lp-grading.md`. Grades every TLA
pool (active AND inactive) as QUALITY = A (trading, windowed, anti-gamed) ×
B (asset & chain value), with the support-gap C as a separate bucket-aware
overlay, honest states (new/inactive/provisional), and first-class confidence.

**A composer, not a fetcher.** Reads only org products: token-catalog,
tla-snapshot (+ pool-status-history), dex-data weekly-avg (both DEXes),
pd-bribes, network-and-prices, curated guides/overrides. Fetches nothing from
chain or DEX APIs.

**The rubric lives in `tla-core/docs/curated/grading_config.json`** — every
weight, curve, threshold, boundary, and lens. Edit → next run reflects it. The
cron HALTS on a missing/invalid/non-normalized config and echoes
config_version + sha into every output.

Null rules (the honesty core):
- null-by-DESIGN renormalizes (SkeletonSwap volume, single-asset depth);
  singles grade B-only, capped at the config ceiling, provisional.
- null-by-MISSING-DATA does NOT grade: a pair pool with no window trading data
  publishes B sub-scores as context but gets no quality grade.
- Grades compute on COMPLETED epochs only (the in-progress epoch is the
  gaming surface).

Output (tla-core):
- `lp-grades/snapshots/current.json` — pools, sub-scores + inputs, grades,
  overlay, states, confidence, lenses, medians, rubric echo
- `lp-grades/snapshots/heartbeat.json` — standard heartbeat
- `lp-grades/epochs/{epoch}.json` — write-once per-epoch archive

Gate mode (mock-gate law): `LOCAL_DATA_DIR=/path/to/tla-core node lp-grades.js`
runs the REAL compute on REAL data from disk, publishing to `GATE_OUT_DIR`
(default ./gate-out). Gated 2026-08-19 on production data: 75 pools, 31 graded,
44 inactive, confidence tiers verified against the real epoch-198 capture gap,
write-once archive verified, config sum-check halt verified.

Render: service root `platform-crons/lp-grades`, build `npm i`, start
`node lp-grades.js`, env `GITHUB_TOKEN` (scoped to thealliancedao/tla-core).
Schedule: daily 23:15 UTC (after dex-data ~22:01 and the hourly snapshot :01 —
all inputs same-day).
