# tla-flows — changelog

## 3.6.2 — 2026-11-25 — the catch-up walk at a usable pace

- First production run of 3.6.1: the 701 blocks of the 2026-11-24 window took four minutes (it found the change: height
  23,900,625, two records). The walk fetched each block's results one at a time — about 3 blocks a second, so a run's 7-minute
  box held ~1,200 blocks and the long span would have needed ten days while the nodes prune ~15,000 blocks a day.
- A block and its results are now read together, six heights at once (`ADMIN_REWALK_CONCURRENCY`). Same records, same order.
- Gate `mock-run-contract-watch.js` 40/40 (43/43 with `FULL=1`), unchanged cases.

## 3.6.1 — 2026-11-25 — contract changes: the catch-up walk

- The forward stream (3.6.0) starts at block 23,905,365 (2026-11-25 ~03:47 UTC). The stored walks end at 2026-06-16. What lies
  between is only on the public nodes, for as long as they keep those blocks — a rolling ~2½ months.
- `tla-core contract-watch/rewalk.json` lists block spans to walk again **for contract changes only** (the flows of those
  blocks are already filed): `{ jobs: [{ id, from, to }] }`. Each run takes the first unfinished job, walks at most
  `ADMIN_REWALK_BLOCKS` of it (default 3,000) and never past `ADMIN_REWALK_MINUTES` of the run (default 7), files what it finds
  through the stream's keyed merge, and writes `next` / `walked` / `found` / `pruned_to` / `done` back. No file, or every job
  done: nothing happens. `ADMIN_REWALK=0` switches it off.
- A span that begins below what the nodes still hold is searched once for its first available block, over the whole span.
  An RPC error or a failed publish leaves `next` at the last filed block: nothing is skipped, nothing is filed twice.
- It never touches the forward cursor. The heartbeat reports each run as `counts.contract_catch_up`.
- Gate `mock-run-contract-watch.js` 43/43 (with `FULL=1`): section R — no file, a job taken in two runs, idle, a span already
  filed, a failed publish, a pruned start, the off switch.

## 3.6.0 — 2026-11-25 — contract changes: who changed a list, a setting, a role, the code

- **Why.** On 2026-11-24 the single gauge's reward list lost two assets. The hourly snapshot showed the list change; nothing
  captured could say who sent it. The walk had seen the transaction — it touches a watched staking contract — and dropped it,
  because it is not a deposit, a withdrawal or a claim.
- **`lib/admin-classifier.js` 1.0.0** reads the same events the walk already has (block_results; no tx body, no extra chain read):
  - for **every contract on the chain**: an upgrade (`migrate`, with the code id and the contract's own previous → new version
    when it reports one), an admin change (`update_contract_admin`), new code stored (`store_code`);
  - for the **watched contracts**: a list / setting / role / governance / delegation / reserve change, picked by the action's
    name (`CHANGE_RE`), and the weekly distribution (kind `epoch`, `routine: true`);
  - **anything a watched DAO's passed proposal changes**, on whatever contract it lands (its member group, a sub-DAO, a
    treasury tool).
  - Each record says who and how: `signer` (the account that sent the message) and `via` — `{ kind: 'dao_proposal', dao,
    proposal_module, proposal_id }` when a DAO DAO proposal module's execute precedes it in the same message, `{ kind: 'authz' }`
    for an authz exec, `null` when it was sent directly.
  - The vocabulary is the census of the stored walk: 1,103,059 transactions, 238 distinct wasm action names; 20 are changes
    (121 events in 17 months) and no user action or callback matches.
- **The walk** (`index.js`): one cheap look per transaction (`adminTouch`), the classifier on the ones that pass, and a new
  stream — `tla-core contract-watch/events/<YYYY>/<MM>.json` — with the transfers stream's rules: keyed merge (`k` =
  `txhash:n`), never-shrink, a failed publish holds the cursor. Watched = `config/contracts.js` + `docs/curated/
  known_contracts.json` + the capture registry + the optional `docs/curated/contract-watch.json` (158 contracts today). The
  heartbeat counts `contract_changes` and `contracts_watched`.
- **History** (`backfill-contract-watch.js`): the same classifier over the walks already stored in a tla-core checkout — the
  FCD archive (contract genesis → 2025-01-07; message boundaries and lifecycle events rebuilt from each transaction's messages)
  and the archive walk (2025-01-07 → 2026-06-16). No chain access. On the 2026-11-15 checkout: 1,155,072 transactions → 741
  records in 27 months — 467 weekly distributions, 112 list changes (47 on the reward lists — 25 whitelist, 22 remove — and 65 amp assets
  initialised in the compounder), 58 settings, 45 upgrades, 29 delegation changes, 14 admin changes, 7 governance, 7 reserve
  withdrawals, 2 role changes (`set_addresses` on the global config, 2024-08-09 and 2024-10-07).
  **All 47 reward-list changes are a Phoenix Directive Stewardship proposal being executed (27 proposals); none was sent
  directly.** Every upgrade was sent directly by a wallet.
- **Not covered, stated on the product:** 2026-06-16 → the first forward record (the walk kept only flows then; public nodes
  hold about the last 2½ months of it); changes made by chain governance at the end of a block (not in a transaction's
  events); settings whose contract emits no action. A daily state read (code id, admin, settings — before → after) is the next
  piece and covers the last two without a sender.
- **Gate** `mock-run-contract-watch.js` 33/33 on real stored transactions found by height + hash: the classifier (A), the
  FCD-era adapter (F), the real `run()` over a chain built from them — month files, flows untouched, idempotent re-walk, a
  failed publish holding the cursor, heartbeat counts (W) — and with `FULL=1` the whole corpus (D). `mock-run-pressure` 12/12;
  `gate-nft-aux` 6/10 and `mock-run-nft-v2` (a fixture path that no longer exists) as before this change.
- Noted, not changed: `mock-run.js` builds its chain from the FCD archive's old uncompressed layout (`state.json`, `part-*.json`);
  since the archive was compacted to `.json.gz` it builds an empty chain and stops in scenario B.

## 3.5.15 — 2026-11-25 — a wallet's P&L file is written when the wallet did something (pnl 1.8.0)

- **Measured first.** Nine days of tla-core's history (2026-11-15 → 11-25, 19,236 commits) pack to 458.6 MB: the data repo grows
  **50 MB a day**. `tla-flows/pnl/ledger/<wallet>.json` is 355.9 MB of it — **39 MB a day, 78 %**, in 24,440 file versions. The next
  writers are small beside it: `member-data/participants` 3.5 MB a day, `member-data/positions` 1.6, `dex-liquidity/events` 1.1,
  `price-history/reserve-implied` 1.0. (A daily archive that repeats `current.json` byte for byte costs nothing: git stores one
  blob.)
- **Why.** "Write only the files that changed" has saved nothing since v3. Every build re-prices every wallet with something open —
  the rate curves end at the hourly "now" sample, so even earlier points of a value curve move a little from one build to the next —
  and each of those files then differs from main. Under the 'events' cadence that was ~230 wallet files every ~2¼ hours. Over twelve
  consecutive builds (2026-11-24 02:35 → 11-25 03:05 UTC) 2,702 wallet files were rewritten; in **40** of them the wallet had done
  anything. Moving nothing but the hourly read's capture time by two hours re-prices 103 of 809 files on a 2026-11-15 checkout.
- **pnl 1.8.0 — the rule.** A wallet's file is written when the wallet did something since its file was last written, or the file is
  new. A file that differs only by prices and rates waits for **the day's re-price**: the first build at/after 03:30 UTC (also a
  forced build, a new builder version, and any run that cannot read the signatures on main). `rollup.json`, `heartbeat.json`,
  `integrity.json` and `ledger/index.json` are written by every build as before, in the same single commit.
  - "Did something" is `activitySignature(doc)`: everything in the file that only the wallet's own events move — per-epoch counts
    and units, cumulative units, each position's counts / open units / receipts moved / not held / disputed, bribes claimed — and
    nothing a price or a rate moves (no key holding USD, no value, no curve). Kept per wallet in `ledger/index.json → signatures`.
  - `heartbeat.full_publish_at` is the last re-price; `heartbeat.publish` says what this build did
    (`mode: full | events`, `wallet_files_written`, `wallet_files_held`). The day's re-price is read from `full_publish_at`, so a
    build made after midnight for new events no longer counts as the day's build.
  - No figure in any ledger changes. What changes is how old the prices in an idle wallet's file can be: up to a day, where it was
    about two hours. The page already states the basis ("positions valued at epoch N") and reads this product as daily.
- **Expected:** ~2,440 wallet-file versions a day → ~270 (the re-price plus the wallets that acted); this folder from ~39 MB a day
  to ~4; the repo from ~50 to ~15.
- **Gates.** `mock-run-pnl.js` 32/32 — R2 and R3 rewritten: both had been red since the cadence left weekly and a build came to
  depend on inputs newer than the cases' 2026-09 `now` (5/9 before this change). R2 covers weekly, daily and 'events' and which kind
  of publish each makes; R3 covers the rule on a real build (a later hourly read re-prices 103 files and moves no signature → 0
  written, 103 held; one moved signature → that file; a file new on main → written; no signatures on main, or the day's re-price →
  all 103) and the signature on a real wallet file. `mock-run-git-batch.js` 9/9 — B5b counts the four files that carry `builtAt`
  (it expected three, from before `integrity.json`); new B5c runs an 'events' build through the real batch and tree listing: 97
  files held, one commit of 4 files, no wallet file on the branch touched. `mock-run-pnl-v3.js` 37/39 and `mock-run-pnl-zap.js`
  19/19, as before.
- `runPnlDuty` takes an optional `build` (default `buildPnl`) so the gate reuses one real build instead of deriving one per case.
- **Not done here, noted:** the earlier points of a value curve should not move at all. They do because a rate is interpolated
  between the last measured sample and "now", and "now" moves. Pinning them (a stored daily rate per pool) would make an idle
  wallet's file byte-stable between events and change P&L figures slightly — a separate, gated change.

## 3.5.14 — 2026-11-24 — the integrity report stops calling zap positions faults (pnl 1.7.2)

- `tla-flows/pnl/integrity.json` reported `foreign_tokens_in_cost: fault` on 878 positions the day pnl 1.5.0 went live and 916 by
  2026-11-24 (223 wallets). None was a fault. 1.5.0 changed the rule to "a deposit costs what left the wallet" and gave the GATE's
  foreign-token check the exemption for positions entered by a zap or carrying one's cost; the PUBLISHED check in `pnl.js` did not
  get it. Verified on the 223 flagged ledgers of 2026-11-24: 886 carry `zap_in`, the other 30 `carried_in` — every one exempt.
- **pnl 1.7.2:** the published check applies the gate's rule (`zap_in || carried_in` → not held to the pool's tokens) and reports how
  many positions that is (`positions_costed_by_what_left_the_wallet`). Builder bump only; no figure in any ledger changes.
- Nothing watched the file, which is how a fault count sat there for five weeks: system-health 1.1.0 now raises any `fault` count
  above zero (`pnl_integrity`).
- Gate mock-run-pnl-v3 on a 2026-11-15 checkout: 37/39, the same two reds with and without this change — "value vs participants"
  (median 9.5 % non-amp / 14.3 % amp; the open value is the last epoch's reading, the participants' is live, and that week moved)
  and the take-rate check.

## 3.5.13 — 2026-10-17 — wBTC.creda.a gets a cost (pnl 1.7.1)

- Owner: "the wBTC I just recently brought into TLA … wouldn't when we staked it be the cost we know?" — Rallies showed "Cost unknown".
  Cause: the state-history sampler pairs every cw20 gauge through its minter; Credia's wBTC receipt (wBTC.creda.a, terra1jjvy…) is
  minted by its market, not a pair, so it was filed `unresolved` — never a single. The P&L had no basket for it: **all 37 open
  wBTC.creda.a positions in every ledger had no cost and no value** (and the gate's curve "now" point was missing pool 35).
- **pnl 1.7.1:** an `unresolved` gauge the token catalog knows as a token is a single (1 receipt = itself, priced from
  price-history `wBTC.creda.a`, daily since 2026-08-03). Builder bump: every ledger rebuilds on the next run. Gate pnl v3: 38/39
  (was 37/39 — the curve check passes now; the take-rate check's failure is unrelated data drift, unchanged).
- dex-data state-history: a cw20 with no pair minter that the TLA snapshot lists as a gauge with no pair is classified `single`.
- Not fixed (data, not code): ampCAPA lots from before 2026-05-13 have no ampCAPA price for their day (the series starts then), so
  those positions stay "cost unknown".

## 3.5.12 — 2026-10-14 — a partly amplified add still owns its legs (pnl 1.7.0)

- The first app-built LP → LP convert (USDC.inj-SOLID → LUNA-arbLUNA) showed "started 2,362 LUNA", ~16 short. Cause: the app
  amplifies the expected LP **minus the slippage limit** (the on-chain minimum; the rest stays in the wallet), so the stake's bond
  (742,429,213) never equals the add's share (745,915,125); `splitEvent` matched amplified stakes to provides by exact share only, so the
  deposit got no provide legs and fell back to the pool's basket — cost in LUNA + arbLUNA (1,583 + 308.5) instead of the USDC.inj + SOLID
  that went in, no swaps undone, and a derived start.
- **pnl-positions 1.8.0:** when no add matches exactly, an amplified stake takes the one unused add of its own pool whose share covers
  the bond; its legs are scaled to bond ÷ share. The convert now costs 57.77 USDC.inj + 51.78 SOLID (what went in, swaps and the
  arb-vault make undone) and starts at exactly the provided legs × that share (1,591.6 LUNA + 306.2 arbLUNA, tier M).
- Builder bump (tla-flows-pnl-1.7.0): every ledger rebuilds on the next run. Gates: mock-run-pnl-zap 19/19 (+Z13, the real tx);
  mock-run-pnl-v3 37/39 (same two pre-existing reds).

## 3.5.11 — 2026-10-14 — P&L follows new activity (pnl 1.6.1)

- Owner: "boost the run frequency on the crons that power the app data, make this stuff show up sooner". The walker already files
  new events every hour; the P&L built once a day, so a deposit / convert / exit showed its cost the next morning.
- **`PNL_CADENCE=events` (the new default):** the daily build, plus a rebuild as soon as the walker's `events/index.json` total has moved
  since the last build and that build is at least `PNL_MIN_GAP_MIN` old (default 120, floor 30). New activity shows within ~2 h; quiet
  hours cost nothing. The heartbeat records `events_index_total` (what the build saw). `daily` / `weekly` still available.
- Why not every hour flat: each build re-reads every event month and price month from GitHub raw (~270 MB) — fine every couple of hours
  when something happened, wasteful hourly on quiet days. Lower `PNL_MIN_GAP_MIN` on Render if fresher is worth it.

## 3.5.10 — 2026-10-14 — a make is a cost leg too

- The first app-built LP → LP convert (USDC.inj-SOLID → LUNA-arbLUNA, one tx) turned 963.5 LUNA into 309.25 arbLUNA at Eris'
  arb vault (the app routes LUNA → arbLUNA there when it pays more than a swap). The walker kept only `action: swap` legs, so the P&L
  would have read that arbLUNA as sent from the wallet. `flowsExtractCost` now records a **make** in tx order: `{kind:'make',
  offer_asset:'uluna', offer_amount: deposit_amount, ask_asset: <the minted token>, return_amount: share}` from
  `arb/execute_deposit` + the token's `mint` (shape proven by the wallet-txs probe of that tx). pnl-positions undoes it like a swap.
- Gate mock-run-pnl-zap 17/17 (+Z12: the real tx's legs — 3 swaps + the make — undo to the refund tokens that went in: 58.29 USDC.inj
  + 51.78 SOLID; the 0.13 USDC.inj that stayed in the wallet isn't charged).
- Not yet: Eris' amp hub bond (LUNA → ampLUNA) and other makers — same treatment once a real tx proves their event shape.

## 3.5.9 — 2026-10-14 — started-with tokens, both sides (pnl 1.6.0)

- Owner: "what I'm trying to show is the token amounts you started with for both sides vs what it is today … the yield growing the token
  amounts and what IL has done by balancing … USD P&L is almost always driven by token prices". `tok_in` (3.5.8) is what left the wallet —
  for a zap, one token — so there was no "both sides at entry" to compare with.
- **pnl-positions 1.7.0:** every lot keeps `start` — the pool's tokens it held the moment it went in. Both sides provided (a balanced add,
  or a zap's optimal swap) → those legs, exact (`start_tier: 'M'`); one side only (single-sided provide) or no provide leg → the LP it got ×
  the pool's basket per LP at the nearest epoch read (`'D'`). Carried through partial exits and migrations like the cost.
  `open_tok.tok_start` + `start_tier` sit next to `tok_in` and `tok_now`. With `open_lp.lp_in_raw` vs the LP now, a page can split
  started → now into **compounding** (more LP) and **rebalancing** (each LP holding a different mix).
- Example (a 2025 LUNA-SOLID amplified position): started 159.7 LUNA + 43.3 SOLID → now 472.2 LUNA + 22.0 SOLID.
- Gates: mock-run-pnl-zap 15/15 (+Z10 single-sided start from the basket, +Z11 a zap's provided legs as start). mock-run-pnl-v3 37/39 (same
  two pre-existing reds).

## 3.5.8 — 2026-10-14 — a deposit costs what left the wallet: zaps and conversions count their swaps (pnl 1.5.0)

- Owner (wallet app → Positions): a zap of LUNA into LUNA-arbLUNA / PAXG-WBTC "shows the LUNA in but not the swaps to zap in … when we are
  swapping LPs … we need to make sure we are seeing all the swaps". The walker already records every swap leg of a tx (`cost.swaps`), but
  the book costed a deposit from the PROVIDED legs only — post-swap. A zap of 5,000 LUNA into USDC-SOLID was booked as "224.96 USDC in"
  (cost $224.96) and the swap's loss was nowhere; an LP → LP conversion lost it between the two positions.
- **pnl-positions 1.6.0:** a deposit's tokens in / cost = the provided legs with that tx's swaps undone (each provided swap output is
  replaced by what was offered for it; multi-hop unwinds newest first; only the share of a swap's output that this deposit provided).
  The zap above now books **5,000 LUNA in**, valued that day — the swap loss is in the cost. A single-sided provide with no swap (LUNA into
  LUNA-arbLUNA) is unchanged: that LUNA really went in alone. A **withdraw with no provide in its tx** (exit to one token) is booked as what
  came back after the swaps. In a **conversion** (withdraw + swaps + provide in one tx) the old position exits at its refund and the new
  one's cost is those refund tokens — the swap loss lands once, on the new position.
- Every piece of a split tx now sees the tx's swaps (`tx_swaps`, used only for this — the signer's first piece still carries them as
  cost). With several deposits in one tx, a swap into a token two or more of them hold can't be placed and is left out (the treasury's
  15-stake proposal keeps LUNA + FUEL only).
- Positions carry `zap_in` / `zap_out` counts. The builder bump (tla-flows-pnl-1.5.0) rebuilds every ledger on the next daily run, history
  included — no `PNL=force`.
- Gates: new **mock-run-pnl-zap.js** 13/13 (legs from real 2026-10-14 zapper txs + hand-computed multi-hop, partial, foreign-swap,
  exit and conversion cases). mock-run-pnl-v3 37/39 — the same two reds as before this change (take-rate threshold, owner curve now-point);
  its foreign-token check now exempts positions entered by a zap or carrying one's cost (2,687 — they cost what left the wallet: LUNA,
  ampLUNA, ASTRO …) and holds every other position to its pool's tokens (0 foreign).

## 3.5.7 — 2026-09-30 — one event per stake; a figure that fails its invariants is flagged, never shown as fact (pnl 1.4.0)

- Owner (aDAO treasury portfolio): "I don't feel like we put that much money in … why so many positions in one place and not another"
  and "there should be no way to have bad data". The builder filed a tx under its FIRST stake only: the treasury's 15-stake DAO proposal
  of 2026-05-22 became one LUNA-FUEL deposit carrying every token (cost 56,641 LUNA for a 11,056-LUNA position) and 10 of its 16 pools had
  no cost. DAO-wide 1,044 stakes / unstakes in 247 wallets were never booked.
- **pnl-positions 1.5.0** `splitEvent()` — one event per (user, pool, mechanism) from the walker's `flows[]`; each gets only its own pool's
  provide / withdraw legs (pair → LP from state-history; an amplified stake also claims the provide whose share equals its bond amount);
  tx-wide legs (swap cost, fee, zap-out) stay on the signer's first piece. Protocol contracts (compounder, zapper, buckets, gauge, escrow,
  bribe manager — config/contracts.js) are never wallets (the compounder had become one with 16 positions).
- **Cost sanity** — open cost > 100 × both today's value and the held value of its own entry tokens, and > $10K → disputed, out of every
  total (the live build had an xASTRO cost of $33.8 billion; DAO net read −$33.8B). **Unrealized** counts costed positions only; a
  position with no measured cost is held (value) but never profit (`open.value_without_cost_usd`; was $151K of "gain" DAO-wide).
- **`tla-flows/pnl/integrity.json`** on every build: foreign tokens in a cost · live position without a cost · units ≠ chain · implausible
  cost · contract as wallet (faults) · cost not measured (check), with per_wallet codes for the page and the help bot. First live build
  (2026-10-01 03:34): every fault check 0 except the 3 xASTRO costs (disputed); 81 positions without a measured cost (incl. the owner's
  donated ampCAPA to the treasury — cost to the DAO is 0).
- Gate mock-run-pnl-v3 42/43 (+V16: no foreign token in any of 6,636 positions · no contract wallet · no counted cost > $1M · treasury
  LUNA-FUEL = LUNA + FUEL only · 16/16 treasury live positions costed · the 05-22 proposal books 9 treasury stakes; V1 rewritten: the
  event count changes by exactly the split − contract events). The one red is the pre-existing take-rate threshold check.
- Treasury after: net −$13,467 / +89,104 LUNA (was −$18,695 / +26,878), 18 positions (was 7).

## 3.5.6 — 2026-09-29 — the P&L builds DAILY (pnl 1.3.1)

- Owner: "should P&L run more often than weekly?" The build is a pure derive over committed files (no chain reads), writes only
  changed files in one commit — nothing makes weekly necessary. Now once per UTC day at/after 03:30 UTC (the daily prices and ratios
  are in), so a new deposit / withdrawal / claim shows in "How you've done" within a day. `PNL_CADENCE=weekly` restores the old cadence.
- A ledger built by an older builder version is rebuilt on the next run by itself — after a deploy there is no `PNL=force` to set (or to
  forget to remove). `PNL=force` still forces; `PNL=0` still disables.
- Gate: the six gate cases (due after 03:30, not before, already built today, older builder, weekly cadence, off). mock-run-pnl-v3 is
  31/32 on today's data both with and without this change — the one red (take-rate "LP in ≥ LP now" on 142/149 < 99 %) is a
  pre-existing, data-dependent threshold, not this change.

## 3.5.5 — 2026-09-28 — tokens in / out on every trip (pnl 1.3.0, pnl-positions 1.4.0)

- Owner: "when you shift from USD to LUNA shouldn't this be USD to Tokens — so you can see how things did in USD in and out, or token
  amounts in and out?" The build already knew each lot's tokens (the provided legs, or the derived basket) and each exit's (the
  refund legs, or the basket) — it only published USD and LUNA.
- Trips gain `tok_in` / `tok_out` (appended to trip_cols — readers decode by name): [[symbol, amount], …], the consumed lots' tokens
  in and the matched share of what came out. Positions gain `realized.tok_in / tok_out` (Σ trips) and, for open lots, `open_tok`:
  the entry tokens, the tokens the units hold now, and `hold_usd / hold_luna` — the entry tokens at today's prices (LP vs hold).
- Gate V15 (5): 13,340/13,340 valued trips carry tokens; tokens out × price-history/series that day == the trip's out USD within 3 %
  on 5,244/5,468 measured exits; position totals == Σ trips; no raw denom names. 32/32 on main's data under the 200 MB heap.
- Needs one `PNL=force` run on org-tla-flows after the deploy (the weekly build for epoch 205 already ran on 1.2.4).

## 3.5.4 — 2026-09-28 — moved beats disputed (pnl 1.2.5, pnl-positions 1.3.1)

- The referee decides "not held" BEFORE the gauge-ceiling check for a wallet the hourly read covers (the position is not in the wallet,
  whatever its size), and a ceiling dispute whose open units the transfer record explains (gross units sent ≥ 99 % of units open —
  receipts that arrived by transfer never opened lots, so net under-counts) becomes a moved receipt, named where it went.
- Found by the bot's new portfolio tool: the GMC Backing Wallet's 12.7M wBTC.osmo-wBTC.axl units, sent to terra1tt48s9jp… on
  2026-03-17, read "ours $27,162 vs the whole gauge $137.87 · disputed". Gate V14 (2): 27/27 on main's data.

## 3.5.3 — 2026-09-28 — where receipts went, named; a custodian keeps a position held (pnl 1.2.4, pnl-positions 1.3.0)

- Owner: "show what address it was sent to — its name if it's registered — and fix this for anyone, any LP, not just this one."
- Every amplified receipt transfer in `tla-flows/transfers` (all 666 since 2025-01) is mapped to its pool by the receipt denom (the
  compounder's amp_denom → underlying LP, archived registry `amplp_mappings`, 65 vaults) and aggregated per wallet × pool × counterparty
  → `position.moves[]` (to, label, kind, out/in/net units, first/last day, last tx). Counterparties are named by the registry: a
  CUSTODIAN (config), an org-catalog entity, a known contract, a member's name — else the bare address.
- A position the chain read cannot find in the wallet whose receipt sits with a custodian is `held_in` (kept open and counted), not
  "not held": 7 positions across the ledger (each wallet confirmed in the CAPA supply product's DAO stakes); not-held 36 → 29.
- Owner: ampCAPA held in the ampCAPA DAO; wBTC.osmo-wBTC.axl not held — sent to terra1jd2tam…6zd on 2026-03-06 (121,654 units = the
  ledger's open lot), unregistered.
- Gate V13 (4 checks) + V12 updated: 25/25 on main's data; heap 200 MB OK.

## 3.5.2 — 2026-09-28 — "not held": open lots whose receipt left the wallet stop counting as open (pnl 1.2.3, pnl-positions 1.2.0)

- Owner report: the portfolio showed ampCAPA (amplified) and wBTC.osmo-wBTC.axl (amplified) as open. Both receipts left the wallet by
  TRANSFER — the ampCAPA receipt is staked in the ampCAPA DAO (3.36M receipts ≈ 7.68M CAPA), the wBTC one was sent to
  terra1jd2tam…6zd on 2026-03-06 — which the flow ledger sees as neither a deposit nor a withdraw, so the lots stayed "open".
- The referee (hourly participants read) now also answers "not held": a wallet the read covered with NO row for a pool × mechanism
  the ledger still has open (≥ $1). Such a position is marked `not_held` — its open lots leave Open now, unrealized, net and the
  curve's "now" point; its realized trips and claims stay (a dispute drops the whole position; this does not).
  `totals.positions_not_held`, `totals.not_held_usd`; the DAO rollup sums them; `referees.wallets_read`.
- Where the receipt went is the page's job for now (member-portfolio 3.7 reads the ampCAPA DAO live and counts it as custody).
  Queued: model receipt / LP transfers in the ledger itself (tla-flows/transfers) so a custodian keeps the lots' basis.
- Gate: mock-run-pnl-v3 V12 (owner's two positions not held, trips/rewards kept, Open now = held only, now point clean; 36 not-held
  positions across members, every one truly absent from the chain read). 21/21 on main's data.

## 3.5.1 — 2026-09-27 — the weekly P&L publishes as ONE commit; pool names in the ledger

- New `lib/git-batch.js` 1.0.0: `publishBatch` builds the new tree on the branch head in size-bounded chunks (≤ 4 MB / 200 files
  per request), makes one commit and moves the ref fast-forward only; if main moved meanwhile the ref update is refused and the
  batch is rebuilt on the new head (never a force push). `listTree` lists a folder's blob shas via git trees (the Contents API
  stops at 1,000 entries; the ledger is ~790 and growing).
- Why: the first v3 build (2026-09-27) published ~790 files as ~790 commits (~20 min); a second forced run started while the
  first was still writing, both PUT the same ledger files (409s), and the run's `pressure` write lost its race.
- `pnl.js` 1.2.1 uses `publishBatch` when given (index.js gives it); per-file stays as the fallback. Ledger positions carry the
  pool `name` from dex-data/state-history's index (names are data).
- Gate `mock-run-git-batch.js` 7/7 (fake git-data API: 790 × 40 KB files → one commit in 8 chunks; main moved mid-build →
  rebuilt, the other commit kept; no-op → no commit; 1,500-entry listing; runPnlDuty on the real build → one batch of 792 files,
  then one batch of the 3 builtAt files). mock-run-pnl 9/9, mock-run-pnl-v3 17/17.


## 3.5.0 — 2026-09-27 — build-pnl v3: positions, round trips, attribution, value curve (Milestone A step 3 (ii))

- New `lib/pnl-positions.js` 1.0.0, driven by `pnl.js` 1.2.0 (the weekly duty, same slot). Per wallet × pool × mechanism:
  lots at deposit (provided legs = measured; else units × measured rate × the epoch's pair basket = derived), FIFO trips at
  withdraw (partial lots proportional; refund legs measured), `market_usd` + `lp_usd` = Δ exactly, in USD and LUNA;
  non-amp ⇄ amp migrations carry their basis (a segment, not an exit); LUNA claims split to pools (by open value when a claim
  lists several); bribe income from tla-voting `claim_bribes`; a value curve at every state-history epoch plus a "now" point.
- Rate curves are measured from the txs themselves (60k samples: provide/withdraw_liq shares↔LP, bond/unbond amplp↔LP) plus
  the participants "now" read. The sampler's compounder `total_lp/total_amplp` is NOT the redemption rate (0.95 and falling
  where users are paid 1.16 and rising) — used only where no tx sampled a key (none today).
- Referees: a position worth more than 2× its whole gauge, or > 50 % off the hourly participants read, is DISPUTED — listed
  with both figures, left out of every total (21 today, mostly the xASTRO single gauge — decimals question queued). An LP trip
  returning > 5× or < 0.1× is SUSPECT, labeled, left out of totals (7).
- Catalog identity from `effective` first (was `discovered` only): unpriced fee legs 35,254 → 8,027; Phase A/B counts, claims
  and claimed yield unchanged on every wallet (differential).
- Ledger docs gain `v3` (trip rows by `trip_cols`, curve pools by index); rollup rows gain `v3` totals; heartbeat gains the
  DAO v3 totals. Output 33 MB (was 14).
- Gate `mock-run-pnl-v3.js` 17/17: Phase A/B differential, hand-computed FIFO + migration, attribution identity on 13,129
  trips, units == on-chain shares on 141/148 positions, value within 2 % median of participants, totals add up, curve "now" ==
  open value on 724 wallets, deterministic, one build under a 200 MB heap. mock-run-pnl.js 9/9 (now at 400 MB — it holds
  several builds).


## 3.4.3 — 2026-09-17 — NFT aux records carry denom_symbol from the shared resolver

- `index.js` stamps `denom_symbol` / `denom_decimals` on every sale / bid / list record via lib/denom-symbol.js (token-catalog
  effective layer); catalog read failure → null with a reason. mock-run-nft-bid adds the resolver checks.

## 3.4.2 — 2026-09-17 — NFT aux bid classifier: scope, settle-in-tx, denom from the payment leg

- `classifyNftTx` bid branch (deferred bid, no NFT exit in the tx): (1) a `place_bid` whose `nft_contract` is not a
  collection this leg watches is dropped — the BBL marketplace is contract-wide, the leg is not (seven Pixel Lions
  buy-nows 09-11..09-14 had landed in adao/transfers/2026/09 as aDAO "bids": place_bid+settle on terra17z7…, no
  currency — the fourth classifier with the first-event blind spot); (2) a place_bid whose auction settles in the same
  tx is never a bid; (3) the bid's `denom` is read from the same-tx payment leg INTO the marketplace (cw20 send →
  the cw20 contract, bank transfer → native denom), matched on `bid_amount`, else the single payment leg, and labeled
  `denom_resolution` (same_tx_payment_amount_match | same_tx_single_payment | payment_amount_mismatch |
  no_payment_leg) — null is explicit, never guessed. Records now carry `nft_contract`.
- Gate `mock-run-nft-bid.js` (TLA_CORE_DIR + NFTC_DIR, `--max-old-space-size=200`, rss 193 MB): 13/13 — the two
  genuine 2023 aDAO deferred bids in the FCD archive (denom uluna, amount-matched), the 09-14 Pixel Lions buy-now from
  the held raw part (aDAO leg → nothing; PL leg → sale, no bid), the seven committed phantom rows all settle-in-tx on
  the PL contract; archive sale/list/cancel counts unchanged (1151 / 2793 / 1602).
- `mock-run-nft-v2.js`: G5 read repointed to NFTC_DIR/adao/snapshots/sales-enriched.json (was the deleted
  tla-core/nfts/adao path — crashed on live main too); GATE PASS (G1–G6, 1151/1151 enriched matched).
- NOT done here (write-once): the seven phantom rows already in nft-collections/adao/transfers/2026/09.json stay;
  index Live Activity still renders them as aDAO bids until they are labeled superseded (or B.2 retires the leg).


## 3.4.0 — 2026-09-13 — weekly P&L rollup duty folded in (moved from the build-pnl.js Action)

- `pnl.js` — Phase-A rollup + per-wallet epoch ledger, MOVED from `tla-core/.github/scripts/tla-flows/build-pnl.js`
  (derive verbatim; that script + `tla-flows-pnl.yml` are deleted — no second copy). Rolling up tla-flows' own events
  is tla-flows' business: a folded duty beside `pressure`, once per epoch at/after Mon 03:30 UTC (the Action's slot).
  LAW: Actions = one-time, Render = scheduled. Pure derive over committed files — zero chain access.
- Fold changes only: inputs via raw reads of the same files (events months from events/index.json months_present,
  price-history months probed 2022/01→now, catalog, wallets.json, epoch table); outputs RETURNED and the duty writes
  ONLY files whose git blob sha differs from main (one directory listing per folder) — per-wallet ledger docs no longer
  carry `builtAt` (ledger/index.json + rollup.json do), so an unchanged wallet costs no commit. Fatals throw (`PnlFatal`),
  never exit. `PNL=0` disables, `PNL=force` runs now.
- Gate `mock-run-pnl.js` 13/13: DIFFERENTIAL against the retired script on a real checkout — same 769 files, every one
  byte-identical minus builtAt/builder; weekly gate (inside built epoch → skip · new epoch before 03:30 → skip · at 03:31
  → runs · force · PNL=0); write-only-changed (last week's build on main → only rollup + heartbeat + ledger/index written,
  0 wallets; one drifted wallet → that wallet too); fatal throws. gate-nft-aux 10/10 and mock-run 11/11 unchanged.


## 3.3.0 — 2026-09-12 — NFT aux stream may publish to a second repo (aDAO migration)

- NEW env `NFT_AUX_REPO` (default = GITHUB_REPO) and `NFT_AUX_ROOT` (default `nfts/adao/transfers`): the aDAO
  transfers aux stream — an aDAO product — reads its month file from and writes it to that repo/folder. Every other
  write (events, cursor, index, heartbeat, votion / dex-liquidity / price-sample aux streams, pressure) is unchanged.
- `publishFile` / `apiGetJsonAt` take an optional `repo` (default GITHUB_REPO); `AUX_REPOS` maps each aux stream
  to its repo; both exported.
- Gate: `gate-nft-aux.mjs` (10/10) drives the REAL run() over a synthetic 3-block chain holding one aDAO
  transfer_nft tx with a capture-registry watching the contract — DEFAULT env: patched == live for every
  (repo, path) read and written; FLIPPED env: the NFT month file is read from and written to
  nft-collections/adao/transfers/, nothing under nfts/adao is touched, core + other aux traffic identical.
  mock-run.js binding suite 11/11 on live and patched.
- The flip (later, one Render env change on org-tla-flows): `NFT_AUX_REPO=thealliancedao/nft-collections`,
  `NFT_AUX_ROOT=adao/transfers`; the service token needs contents:write on BOTH repos.

Module changelog for the block-walker (index.js, lib/aux-classifiers.js) and its
gates. Page-facing changelogs live in tla-core/docs/changelogs/ — this file is
for capture-layer changes only.

## 2026-08-23 (later) — Atrium vocabulary fixture-locked; Jun-12→v2-deploy exits resolved

The owner supplied a REAL Atrium sale (tx 995038E5…, 2026-08-21, #6192, 49.99
SOLID, listing 549) — which corrected the record ("no sales since June 12" was a
BBL-only-filter error in the audit) and locked Atrium's shape: `buy_nft` joins
SALE_VERBS with attr normalization (price/listing_id → amount/auction_id). Gate
G6 asserts the fixture end-to-end (buyer/seller/gross/denom/auction, legs
consistent, fee 0 / royalty 0 as the chain says). Zero regression on the
11,582-tx FCD suite. Companion one-off in tla-core
(`nft-resolve-market-exits`) fetches every marketplace-exit tx since the last
enriched sale from the LCD, archives the raw responses, and merges v2 records
into the transfers months — the next warm's market-history pass appends the
sales. Chain fact flagged: the Atrium sale paid ZERO royalty to the DAO (BBL
enforces 5%) — a governance question, recorded in the registry note.

## 2026-08-23 — classifyNftTx v2: marketplace sales ride the walk (gated)

**The Analytics tab's inputs had no maintainer.** `sales-enriched.json` (last sale
2026-06-12) and `listing-history.json` were written by the retired data-repo Action;
the duty was never ported (parallel-run doctrine gap). First repair lands the
capture: **classifyNftTx v2** (`platform-crons/tla-flows/lib/aux-classifiers.js`)
emits `sale` / `list` / `cancel` / `bid` records for watched marketplaces, riding
the existing every-block walk. Sale-vs-cancel decided by money movement (payout
legs from the marketplace + NFT exit); BBL vocabulary (settle/create/cancel)
fixture-locked; batch-settle txs segmented by event order, never pooled;
multi-exit with no vocabulary → `resolution:'ambiguous'`, raw attrs archived
(capture truth, derive later). Registry-first: BBL / Atrium / Boost added to
`tla-voting/capture-registry.json` as `nft_marketplace` stream entries (BBL with
chain-evidenced fee/royalty roles; Atrium/Boost generic until a fixture locks
their shape).

**Gate (permanent: `tla-flows/mock-run-nft-v2.js`, full FCD archive, 11,582 txs):**
1,151 sales · 2,793 lists · 1,602 cancels · 0 ambiguous · 0 leg-inconsistent ·
v1 transfer records byte-identical · 1,087/1,087 enriched overlap on
gross+seller+buyer. v2 also corrects history: the old pipeline dropped **64
sales inside batch-settle txs** and misattributed fee/royalty/net on 13 more
(its legs don't sum to gross; v2's sum exactly). Walker suite parity: all 8
mock scenarios identical pristine-vs-modified (B/C carry a pre-existing
environment failure — logged as an open item).

Next in this arc: flows.js delisting→sale upgrade from the new records, then
sales-enriched/listing-history/luna-usd-daily forward-fill (merge INTO the org
path), then the four field-drift panel fixes on the page.
