# tla-voting — org-tla-voting 2.3.1 (TLA voting capture, forward)

**Render job:** `org-tla-voting` · schedule `0 * * * *` (hourly — D6) · entry `index.js`
**Specs:** `SPEC-tla-voting-bribe-state.md` (2.2.0 bribe-state + classifier v6) + `SPEC-tla-voting-rollups.md` (2.1.0 rollups + classifier v5) + `SPEC-tla-voting-capture-fix.md` (2.0.0 architecture) over `SPEC-tla-voting.md` (module contract)
**Data:** `tla-core/tla-voting/events/` (monthly per-stream partitions + cursor + heartbeat + index), `tla-core/tla-voting/vote-state/` (per-period state harvest + lock-state retention), `tla-core/tla-voting/bribe-state/` (per-period tribute ledger — build #3), and `tla-core/tla-voting/distributions/`

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
│   ├── locks/{YYYY}/{MM}.json per-period lock-state snapshots (2.2.0 retention
│   │                          rider — end/underlying/asset/VP per lock)
│   ├── index.json             last_harvested_period, pending_wallets, wallets_seen
│   └── heartbeat.json
├── bribe-state/               build #3 (SPEC-tla-voting-bribe-state)
│   ├── {YYYY}/{MM}.json       per-period VERBATIM tribute ledger records, keyed
│   │                          by the PERIOD'S EPOCH END DATE (history lands in
│   │                          its historical months — deliberate D4 deviation
│   │                          from vote-state's capturedAt-month)
│   ├── index.json             last_harvested_period, walked_down_to,
│   │                          floor_period + floor_certificate
│   └── heartbeat.json         + bribe_capture coverage
└── distributions/             unchanged (single history.json, DECIDED deviation)
```

## bribe-state (build #3 — the tribute completeness layer)

The committed bribe stream held 173 events; the manager's books hold thousands
— the take-rate flow (four bucket contracts calling `add_bribe` internally)
is invisible to message-level classification BY CONSTRUCTION, and the
2025-01→2026-06 capture hole swallowed the rest. The manager retains its
complete per-period, per-pool, per-denom ledger (retention PROVEN to period
100), so the harvest recovers the entire tribute history of TLA from state:

- **Query (CHAIN-PINNED, queries.md Q-IncentiveManager-Bribes):**
  `{bribes:{period:{period:N}}}` — the `period` field is the ve3 **Time
  enum**, NEVER a bare number (serde-json-wasm fallback error; cost four
  probes). `{bribes:{}}` = current.
- **Walk-down (D2):** budgeted genesis capture — `BRIBE_WALK_BUDGET`
  (default 30) periods per hourly run, down from the current period until
  the floor certifies (FLOOR_CONFIRM consecutive floor-shaped responses —
  the distributions register rule; transient failures never masquerade as
  the floor). `floor_period` records what the chain says (expect ≈96).
- **Forward (D3):** one harvest per period, distributions-head trigger,
  self-healing — a missed flip recovers on the next run (retained state).
- **Record (D5):** `{schemaVersion, period, harvested_at, source, buckets:
  <chain VERBATIM>}` — zero derived fields; totals/USD live in rollups.
- **bribe_capture (D7, heartbeat):** event-derived per-period sums vs the
  state buckets → coverage % per denom. A COVERAGE metric, not an alarm —
  events are structurally partial (that's why state exists); the alarm is
  coverage DROPPING for direct-bribe denominators.

## rollups schema 5 (build #3.5) — the blind spot becomes a number

`bribe_ledger` in rollups.json joins the two sources by what each can know:
**state** = the manager's verbatim per-period, per-denom totals (complete
back to the floor); **attributed** = event-derived amounts (direct bribes +
v6 promoted — the only per-briber source; the chain ledger knows pools and
amounts, not who paid); **unattributed** = state − attributed, clamped ≥ 0
with any surplus declared. THE NO-DIVISION LAW: an event spanning multiple
epochs counts in FULL toward lifetime sums only, never split across periods;
single-period events for periods the harvest hasn't reached land in
`events_outside_state`. `bribers[]` gains `via` counts (msg vs wasm_event).
`bribers_coverage_note` is RETIRED — replaced by measured remainders that
shrink as v6 captures forward. Grace: no bribe-state index yet → a declared
`awaiting` status, never a failure.

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

## <<CLASSIFIER v6>> — sole live home

v6 = v5 + the **contract-bribe promotion** (SPEC-tla-voting-bribe-state D6):
when a manager-touching tx produced NO bribe event from top-level msgs (the
take-rate tribute flow — FCD census: 2,793 `bribe/add_bribe` events vs 173
captured, 751 FCD-era txs contract-initiated), the manager's own
`wasm {action:'bribe/add_bribe', added:'<denom>:<amt>', start, end}` events
are promoted: type `bribe_add`, `via:'wasm_event'`, coins from `added`,
epoch range from start/end (chain-proven on FCD tx `69D072693314…` — two
events, ASTRO 226225967 + 447102559). `briber` = the initiating contract via
the event's own `msg_index` → that message's target (msg_index is a property
on FCD-trimmed events, an attribute on live LCD events; first-msg-target
fallback), `briber_source:'msg_target'`. Pool pairing from same-tx
`asset/track_bribes_callback {asset, bribe}` ONLY on a single unambiguous
denom+amount match — the add is bucket-AGGREGATED, so ambiguity stays
`pool:null` (honest; state has the per-pool truth). Direct bribes never
reach the hook (their msg already classified) — v3–v5 behavior unchanged.

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
- **Lock-state retention rider (2.2.0):** the enumeration's `lock_info`
  answers are retained as ONE record per period in
  `vote-state/locks/{YYYY}/{MM}.json` — per lock: `end` (verbatim:
  `{period:N}` | `'permanent'`), `underlying_amount`, `asset`, `amount`,
  `start`, `coefficient`, `slope`, `voting_power`, `fixed_amount`. Derivables
  downstream: avg lock duration, permanent-vs-timed split, per-lock sizes,
  LST composition of total VP. Soft-fail (surfaces in heartbeat as
  `partial`, never blocks the harvest); full harvests only.
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
`VS_PACE_MS` (150), `BRIBE_WALK_BUDGET` (30 — walk-down periods per run),
`BS_PACE_MS` (150). Schedule unchanged: `0 * * * *` (hourly).

## Mock gate

`TLA_CORE_DIR=<tla-core checkout> node mock-run.js` — 108 assertions on REAL
fixtures (FCD txs vs committed events): classifier v4/v5/v6 parity, token_id
promotion, walker gate/budget/crash/pruned/corrupt/migration/layout-guard,
vote-state harvest/completion/vote_capture/enumeration-abort + lock-state
rider, rollups schema 5, bribe-state walk-down/floor-confirm/forward/
epoch-month-routing/verbatim (R8–R12 incl. the real take-rate tx
69D072693314), bribe_ledger math + edges (R13a/R13). Passed 2026-07-15
pre-delivery. Re-run after ANY main-loop
change (binding). Note: the harness reads the committed streams' MONTHLY
layout (post-restructure) since 2.2.0.

## Recent changes

- **2.3.1 (2026-07-18) — v6.1: governance-executed bribes (the PD class).**
  Fixture tx `402AE7B1…AAAA7` (chainscope, DeFi_Patriot): one execute-proposal
  msg → PD DAO core makes TEN `add_bribe` calls, every event at msg_index 0 —
  identical dedup keys silently collapsed them to ONE (9/10 dropped,
  26,284 of 34,763 LUNA lost). Fix: collision-aware promoted msg_index
  (unique 100000+pi ONLY when 2+ promoted bribes share an index; the
  single-add take-rate class keeps byte-identical keys — no historical dupes
  on re-walk). Attribution: NEW `dao_attr` source — exactly one wasm `dao`
  attribute in the tx → that DAO core is the briber (its funds pay; dynamic:
  an unknown DAO surfaces as its own address, never absorbed by a
  shared-module label); zero or 2+ → msg_target fallback. Also reconciles
  the gate with the in-place rollups schema-6 (briber board) bump. Mock gate
  **116/116** (R10b: the PD fixture + dao-ambiguity + collision-only
  activation + key-parity assertions). Second confirmed fixture: proposal
  247 tx `1CA243A3…AF1E` (37,912.49 LUNA, epochs 189–192). Changelog Rev 9.
- **2.3.0 (2026-07-15) — build #3.5.** Rollups schema 5: `bribe_ledger`
  (state totals vs event attribution per period/denom, unattributed
  remainder measured, no-division law, events_outside_state declared,
  surplus clamped + declared), `bribers[].via` counts,
  `bribers_coverage_note` retired. Mock gate 108/108 (R7 rewritten, R13a +
  R13 added). Changelog Rev 8.

- **2.2.0 (2026-07-15) — build #3 (SPEC-tla-voting-bribe-state).** NEW
  `bribe-state/` product (`lib/bribe-state.js`): budgeted in-cron genesis
  walk of the incentive manager's per-period tribute ledger (Time enum
  query, retention proven to period 100) + per-period forward harvest,
  verbatim D5 records routed to the PERIOD'S epoch-end month, floor
  certified never presumed. `<<CLASSIFIER v6>>` contract-bribe promotion
  (the 97% blind spot's attribution layer). `bribe_capture` coverage
  invariant. Lock-state retention rider on vote-state
  (`vote-state/locks/{YYYY}/{MM}.json`). Mock gate 96/96 on real fixtures
  (incl. real take-rate tx 69D072693314). Changelog Rev 7.

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
