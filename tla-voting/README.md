# tla-voting — org-tla-voting (TLA voting event capture, forward)

**Render job:** `org-tla-voting` · schedule `0 */6 * * *` · entry `index.js`
**Spec:** `tla-core/docs/pending-changes/SPEC-tla-voting.md`
**Data:** `tla-core/tla-voting/events/` (vote / lock / bribe / reward streams + rollups + cursor + heartbeat + index)

Scope: ONLY the event log of the three voting contracts — the act of voting,
the VP lifecycle, vote incentives, vote proceeds. Positions/valuations =
adao-positions; LP flows = tla-flows; VP state = member-data.

## What it owns (one-contract-one-owner)

| Contract | Stream(s) |
|---|---|
| Gauge controller | vote-events + reward-events (distributions, claims) |
| Voting escrow / vAMP minter | lock-events + reward-events (claim_rebase, compound) |
| Incentive manager (BRIBE_MANAGER) | bribe-events + reward-events (claim_bribes, distributions) |

No other cron may scan these contracts; this cron scans nothing else.
Addresses come from `../config/contracts.js` — never hardcode.

## How it relates to the seed

The one-time seed Action lives in `tla-core/.github/scripts/tla-voting/`.
It built the streams "as if this cron ran all along": legacy Aug-2024→Jun-2026
votes/locks (bootstrapped from the frozen `defipatriot/tla-history-data_2026`
capture — now the **irreplaceable** source of that era, see below) + everything
public nodes retained at seed time (2026-07-07). This cron forward-maintains:
sweep the retained window, classify, merge append-only, advance the cursor.

The classifier block (`<<CLASSIFIER v3>>` markers) is **byte-identical** with
the seed script's. Never edit one without the other — verify with a plain diff
(or md5 of the block) after any change.

## ⚠ Retention stakes (read this)

On 2026-07-07 we discovered public Terra nodes pruned their **tx index to
~1 week** (previously reached Aug 2024). Consequences:

- An outage of this cron longer than a few days **loses events permanently**
  (recoverable only via a future archive-node run). The heartbeat monitor is
  not optional.
- Any hole that does occur is recorded in each stream's `known_gaps` (with the
  precise resume height) — never silently papered over.

**Coverage after the FCD archive fill (2026-07-08):** all four streams start at
TRUE contract genesis (the three contracts deployed 2024-08-27). The FCD
indexer (`phoenix-fcd.terra.dev` — frozen archive, genesis→~2025-01-07) filled
everything below the old horizons via `fcd-fill.js`. Remaining holes, recorded
in `known_gaps` (archive-node targets): votes/locks **2026-06-15→22**, and
bribes/rewards **Jan-2025→Jun-2026** (FCD freeze → org capture start). The
frozen `defipatriot/tla-history-data_2026` remains the sole source of
votes/locks for Jan-2025→Jun-15-2026 — keep frozen, never deleted.

## Reliability behavior

- **F1** resilient ASC pager (publicnode ignores `pagination.offset`).
- **F2** null ≠ [] on every page; incomplete scans mark status `partial`.
- **F3** never-shrink per stream — fewer merged events than committed aborts
  the publish with an error heartbeat.
- **F7** cursor and per-stream `lastScannedHeight` advance **only on complete
  scans** — an incomplete scan keeps the prior frontier so the next run
  re-detects any hole instead of skipping past it.
- **F8** horizons only ever move down (archive deepening appends below them).
- **Never seeds**: if all committed priors are unreachable, it aborts with an
  error heartbeat. Recovery path is the seed Action, which owns bootstrap.
- Unrecognized actions land losslessly as `event:<ns>/<key>` with raw args and
  are tallied in `discovered_actions` — promote later via classifier update +
  rollup recompute, never a re-backfill.

## Data notes for consumers

- All amounts are raw integer strings with canonical denoms
  (`native:` / `cw20:`); pricing joins `price-history` downstream.
- Lock math: sum `canonical === true` only (wrapper-layer views are kept but
  flagged).
- `add_bribe` events carry their **native epoch range**
  (`epoch_start`/`epoch_end`/`dist_func`) and separate `fee_funds` (the 10-LUNA
  anti-spam fee) from the bribe `coins`.
- Distribution pot events are **tx-gross** (`coins_basis:
  'gross_coin_received'`): a tx batching take_rate+rebase+bribes msgs carries
  the same tx-gross coins on each — **never sum across distribution types**.
  Per-msg splitting is a known refinement candidate.
- Briber/wrapper **attribution is not here** — raw addresses/namespaces only;
  identity joins live in address-catalog (spec §2).

## Env (Render)

`GITHUB_TOKEN` (scoped to tla-core), `GITHUB_REPO` (default
`thealliancedao/tla-core`), `GITHUB_BRANCH` (main), `LCD_PRIMARY` /
`LCD_FALLBACK`, `MAX_PAGES` (60), `PAGER_RETRIES` / `PAGER_ERR_BACKOFF` /
`PAGER_PROBE_DELAY`.

## Recent changes

- **2026-07-08 (data, not code)** — FCD archive fill executed: streams extended
  to contract genesis (votes 8,270 · locks 13,585 · bribes 172 · rewards
  6,038). Cron code unchanged; it forward-maintains on top of the filled
  streams. See `tla-core/docs/changelogs/cron-tla-voting-log.md` Rev 2.
- **1.0.0 (2026-07-08)** — initial forward cron. Classifier v3 (byte-identical
  with seed v3.3): chain-confirmed add_bribe shape, target-contract filter,
  reward union across sweeps, gap honesty with precise resume boundaries,
  change-only stream publishing to keep commit noise down.
