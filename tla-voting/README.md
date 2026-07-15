# tla-voting — org-tla-voting 2.1.0 (TLA voting capture, forward)

**Render job:** `org-tla-voting` · schedule `0 * * * *` (hourly — D6) · entry `index.js`
**Specs:** `SPEC-tla-voting-rollups.md` (2.1.0 rollups + classifier v5) + `SPEC-tla-voting-capture-fix.md` (2.0.0 architecture) over `SPEC-tla-voting.md` (module contract)
**Data:** `tla-core/tla-voting/events/` (monthly per-stream partitions + cursor + heartbeat + index) and `tla-core/tla-voting/vote-state/` (per-period state harvest) and `tla-core/tla-voting/distributions/`

Scope: ONLY the voting layer of the three governance contracts — the act of
voting, the VP lifecycle, vote incentives, vote proceeds. Positions/valuations
= adao-positions; LP flows = tla-flows; VP state snapshots = member-data.

## Two layers, one truth (2.0.0 — the capture fix)

The 2026-07-14 reconciliation proved three loss classes in 1.x: tx_search drops
events even inside claimed coverage, and the gauge's `gauge/vote` wasm event
emits only `{action, vp}` — wrapped/contract-path votes (Votion vaults, DAO DAO
executions, Polytone) **cannot** be attributed from events at all. Hence:

- **Layer A — `vote-state/` (completeness + attribution).** Once per period
  (`lib/vote-state.js`): enumerate every lock owner fresh (never a hardcoded
  list) ∪ previously-seen wallets → gauge `user_info` per wallet → full
  allocation with period stamps. Any entry stamped P = that actor voted in P.
  Catches aggregators, DAOs, cross-chain proxies, and silent drops BY
  CONSTRUCTION — it never watches transactions. ~700 paced queries per week.
  Where events and state disagree, **state wins**.
- **Layer B — `events/` (fine-grained tx detail for direct votes).** Heights,
  hashes, msg detail — via the Rev C **block-walker** (lifted from tla-flows):
  walk every block since the cursor, gate on the three contracts, fetch each
  gated tx decoded by hash (hours old at most — deep inside index retention),
  feed the unchanged classifier input shape. Forward capture done as forward
  capture; block data cannot lie the way tx_search pagination did.

## What it owns (one-contract-one-owner)

| Contract | Stream(s) |
|---|---|
| Gauge controller | events/votes + events/rewards + vote-state + distributions |
| Voting escrow / vAMP minter | events/locks + events/rewards (claim_rebase, compound) |
| Incentive manager (BRIBE_MANAGER) | events/bribes + events/rewards (claim_bribes, distributions) |

No other cron may scan these contracts; this cron scans nothing else.
Addresses come from `../config/contracts.js` — never hardcode.

## Storage layout (post-restructure — the cron REFUSES the monolith layout)

```
tla-voting/
├── events/                    index schemaVersion ≥ 4 REQUIRED (self-enforcing
│   ├── {votes,locks,bribes,rewards}/{YYYY}/{MM}.json    deploy sequencing)
│   ├── index.json  cursor.json  heartbeat.json
│   ├── rollups.json           schema 4 — rebuilt on harvest runs (SPEC-tla-voting-rollups)
│   └── reconciliation.json    detail artifact (2026-07-14 diagnostic)
├── vote-state/
│   ├── {YYYY}/{MM}.json       per-(period,wallet) records, dedup + never-shrink
│   ├── index.json             last_harvested_period, pending_wallets, wallets_seen
│   └── heartbeat.json
└── distributions/             unchanged (single history.json, DECIDED deviation)
```

## rollups.json schema 4 (build #2 — the honest merge)

Rebuilt on harvest runs (or `FORCE_ROLLUPS=1`), from vote-state ∪ events —
state wins, `events_visibility: 'full'|'none'` says which voters events can
see (contract-path voters like the Votion vaults finally rank; #1 by VP).
Per voter: state (vp, stamped gauge allocations), event vote detail, canonical
lock net-by-denom, and the THREE-NUMBER CLAIMS model: raw `amount`,
`usd_at_claim` ("if sold when claimed" — immutable, priced per-claim from
price-history), `usd_at_build` (fallback — **the site computes live
today-value as amount × current price**). Pending recipe (display-side):
**live earned = claims.totals + `user_claimable` + `user_pending_rebase`**.
Honesty ledger in the file: `claim_coverage` declares the
2025-01-08→2026-06-14 reward-capture hole; `bribers_coverage_note` declares
the ~97% tribute blind spot (build #3); zero-claims split as `claim_tx_count`
vs `paid_claim_count`; unjoinable denoms land in `unpriced[]`, never dropped.
Pots retired to `distributions/history.json` (one truth per fact).

## <<CLASSIFIER v5>> — sole live home

v5 = v4 + the **rebase-income promotion**: the gauge's own
`wasm {action:'gauge/claim_rebase', rebase_amount, user}` event declares the
claimed amount even when the recipient is a wrapper (chain-proven live on tx
`9B2DD008…` — Votion vault compound; trimmed real fixture at
`fixtures/compound_probe.json`). compound events get coins from it (income at
the GAUGE boundary — pre-swap, pre-wrapper-fee) with
`coins_source:'gauge_event'`; claim_rebase gets the same backstop when the
coin parse finds nothing; true zero-claims stay `coins:null`. Forward-only —
pre-2.1.0 compound events keep null (fill rider queued).

v4 = v3 verbatim + the lock **token_id promotion**: null token_ids are filled
from the tx's own escrow wasm events (CW721 `mint` on creates — chain-proven on
FCD tx `09A186D9…` → token_id 542; metadata-update events on deposit_for/
extends), owner-matched, ambiguity stays null (`token_id_source: 'wasm_event'`
flags provenance). Since 2.0.0 this cron is the classifier's ONLY live copy:
the seed and fcd-fill are layout-guarded off (they keep v3 for git history).
Any future monthly-aware fill lifts v4 FROM HERE and diff-verifies the block.

## vote-state semantics (read before consuming)

- Record: `{period, wallet, vp:{fixed,boost,total}, gauge_votes:[{gauge,
  period_stamp, votes, post_flip_change}], voted_this_period,
  raw_gauge_votes, capturedAt}`. `vp.total = fixed + boost` (the VP law).
- **Period-stamp field caveat:** the stamp is parsed tolerantly
  (`period`/`vote_period`/`last_vote_period`) and `raw_gauge_votes` is retained
  VERBATIM per record — pin the exact field name with one browser probe before
  relying on stamp-derived fields (spec §3).
- Timing honesty: `user_info` is CURRENT state; stamps carry only the LAST
  vote period per gauge. Entries stamped > the harvested period are flagged
  `post_flip_change` (overwritten before we read — recorded, never guessed).
  Pre-harvest history beyond each actor's last-vote stamp is unrecoverable —
  the chain never emitted it.
- Completion mode: individual `user_info` failures land in
  `index.pending_wallets` (+`pending_period`); `last_harvested_period`
  advances only when pending is empty; the next run retries pending only.
  A failed ENUMERATION aborts the whole harvest (incomplete universe = the
  exact failure mode this layer closes).
- `vote_capture` (heartbeat): events replay vs the same `user_info` results →
  MATCH/MISMATCH/CHAIN_ONLY/EVENTS_ONLY + match_rate — the permanent
  capture-integrity alarm (skipped in completion mode).

## ⚠ Retention stakes (still true — walker edition)

Public nodes prune the **tx index to ~1 week** and blocks on a longer-but-
finite window. An outage beyond block retention loses tx detail permanently;
pruned block ranges are recorded with EXACT bounds in
`index.known_gaps_walker` (walker D10). The vote-state layer degrades far more
gracefully — a missed harvest recovers everything not overwritten since, with
true stamps. Historical per-stream `known_gaps` (tx_search era) remain in
`index.streams[*].known_gaps`; archive-node targets unchanged: votes/locks
2026-06-15→22, bribes/rewards Jan-2025→Jun-2026. The frozen
`defipatriot/tla-history-data_2026` stays the sole source of votes/locks
Jan-2025→Jun-15-2026 — never deleted.

## Reliability behavior

- **F1** no pagination left to truncate (walker); the escrow `all_tokens` walk
  distinguishes end-of-list from failure.
- **F2** null ≠ [] on every read; failed wallets → pending, failed months →
  publish skipped + `partial`.
- **F3** never-shrink per touched month file (both products); corrupt existing
  files are refused, never overwritten.
- **F7** cursor advances ONLY when every publish landed; a failed walk/decode
  holds the cursor and the window re-walks (dedup absorbs the overlap).
- **F8** horizons untouched (historical floors); pruned gaps exact-bounds.
- **Never seeds events**: unreachable/absent priors → error heartbeat + abort.
  vote-state MAY self-start (no history to clobber; first harvest = the heal).
- Unrecognized actions still land losslessly as `event:<ns>/<key>` +
  `discovered_actions`.

## Data notes for consumers

- All amounts raw integer strings, canonical denoms; pricing joins
  price-history downstream.
- Lock math: sum `canonical === true` only. Creates carry `token_id` from
  2.0.0 (`token_id_source: 'wasm_event'`); pre-2.0.0 creates in the retained
  window stay null (FCD re-derive queued for genesis→Jan-2025).
- `add_bribe`: native epoch range + `fee_funds` separated from bribe `coins`.
- Distribution pots are tx-gross — never sum across distribution types.
- Attribution is NOT here — raw addresses/namespaces only; identity joins
  live in address-catalog (spec §2). rollups.json is FROZEN pending build #2.

## Env (Render)

`GITHUB_TOKEN` (scoped to tla-core), `GITHUB_REPO`/`GITHUB_BRANCH`,
`RPC_PRIMARY`/`RPC_FALLBACK`, `LCD_PRIMARY`/`LCD_FALLBACK`,
`WALK_CONCURRENCY` (4), `MAX_BLOCKS_PER_RUN` (2000), `CONFIRM_LAG` (3),
`TLA_LOOKBACK` (700, cursor-migration fallback only), `VS_CONCURRENCY` (5),
`VS_PACE_MS` (150). **Schedule change with this deploy: `0 */6 * * *` → `0 * * * *`.**

## Mock gate

`TLA_CORE_DIR=<tla-core checkout> node mock-run.js` — 44 assertions on REAL
fixtures (FCD txs vs committed events): classifier v4 parity, token_id
promotion (89/89 null creates filled on the FCD sample), walker
gate/budget/crash/pruned/corrupt/migration/layout-guard, vote-state harvest/
completion/vote_capture/enumeration-abort. Passed 2026-07-15 pre-delivery.
Re-run after ANY main-loop change (binding).

## Recent changes

- **2.1.0 (2026-07-15) — build #2 (SPEC-tla-voting-rollups).** rollups.json
  schema 4 (`lib/rollups.js`): voters from vote-state ∪ events with
  visibility flags, three-number claims (amount / usd_at_claim /
  usd_at_build + live today-value recipe), canonical lock sums, bribers with
  blind-spot label, pots retired to distributions, claim-coverage honesty
  ledger. `<<CLASSIFIER v5>>` rebase-income promotion. Mock gate 63/63 on
  real fixtures (incl. the live compound probe tx). Changelog Rev 6.

- **2.0.0 (2026-07-15) — the capture fix (SPEC-tla-voting-capture-fix).**
  Walker transport replaces tx_search (Rev C lift; gated by-hash decode);
  monthly per-stream writes (index schemaVersion ≥ 4 enforced); NEW
  vote-state per-period harvest (`lib/vote-state.js`) — the completeness +
  attribution layer, first harvest heals the Rev 4 misses; `<<CLASSIFIER v4>>`
  token_id promotion; `vote_capture` invariant in the heartbeat; rollups
  frozen pending build #2; schedule → hourly. Mock gate 44/44 on real
  fixtures. Full story: `tla-core/docs/changelogs/cron-tla-voting-log.md` Rev 5.
- **1.1.0 (2026-07-14)** — distributions forward capture
  (`<<DISTRIBUTIONS CORE v1>>`, byte-identical with the harvester —
  diff-verify after ANY change) + the 40s hard-deadline `httpGet` port.
  Changelog Rev 3.
- **2026-07-08 (data, not code)** — FCD archive fill: streams extended to
  contract genesis. Changelog Rev 2.
