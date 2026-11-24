# member-data — changelog

## 1.7.1 — 2026-11-24 — tla-snapshot 1.2.0: USDC.inj is named; a pool off its gauge's list earns nothing

Found by the pre-promotion health check of TLA Stats (the page read TLA TVL $697.8K where the Eris-method feed read $1.02M, and
"Epoch rewards" 380,709 LUNA where the chain distributes ~339K).

- **Names.** `tla-snapshot.js` named IBC tokens from a hand registry only. USDC.inj was never added, so since its pools joined the
  gauges (period 204) that side read `symbol: null / price_source: no_symbol`: four pools had no USD value, no staked value and no APR —
  LUNA-USDC.inj among them, the largest TLA pool. An IBC denom the registry does not know is now named from the price feed's own
  denom (the key the price lookup uses) and the token-catalog (`lib/denom-symbol.js`), decimals from the token-catalog only; with no
  decimals it stays unknown. Registry entries are untouched.
- **Reward list.** A pool was `active` when it held ≥ 1 % of its gauge's votes in `gauge_infos`. An asset taken off a gauge's list keeps
  its old votes there but is in no distribution; nine such pools were `active` with an estimated share on top of a chain distribution
  that already sums to 100 %. The staking contracts' `whitelisted_asset_details` is now read (the token-catalog's `gauge_status` stands
  in when that read fails; a list that does not name what the chain is paying is dropped, not obeyed). Such a pool is
  `voted_but_below_threshold` — the existing "has votes, earns nothing" class, so no reader meets a new status value — with
  `status_reason: 'dewhitelisted'`, `gauge_whitelisted: false`, and rewards of zero with `source: 'dewhitelisted'`.
- **Additive fields:** `version` (file + heartbeat), `voting_power.{fixed_human,total_human,pct_of_reward_list}`, per bucket
  `bucket_vp_total_human / reward_list_vp_total_human / off_list_vp_total_human / dewhitelisted_count`,
  `totals.dewhitelisted_pools_count`, `totals.rewards.{pools_dewhitelisted,tla_tvl_in_distribution_usd}`; heartbeat
  `stats.{dewhitelisted_pools,unpriced_paid_pools,reward_list_unread}`. Nothing renamed or removed.
- `lib/tla-alerts.js` 1.0.1: a pool that moves to that class because it is off the list is said to be exactly that.
- Gate `mock-run-snapshot.js` 19/19 on the real files of 2026-11-24: the four USDC.inj pools value within 3 % of the Eris-method feed
  (LUNA-USDC.inj $259,776 vs $259,705, APR 49.9 % vs 49.9 %); TLA staked in the paid pools $1,015,424 vs $1,015,773; per-pool
  emissions add up to 100.2 % of the emission (the published file: 112.1 %).
- Not changed (to be settled against the reference screen): pool VP and "Total VP" are still the boost part only
  (`voting_power`); the chain's distribution counts boost + fixed. Both are now in the file.
- Known: `mock-run-tla-alerts.js` has one failing calibration check on today's history (`pool_apr_move` 15.5/month vs a limit of
  12) — it fails the same way without this change.


## 1.7.0 — 2026-10-13 — the wallet data + history layer the aDAO dashboard and other apps read

- Owner: wallet data and history get built out in the alliance DAO repo as the data layer and history layer, so the aDAO dashboard
  and other apps read a single source of truth. Contract + reader notes: README "The wallet data + history layer".
- `holdings.js` 1.0.0 (tla-participants phase 8, the 23:xx run): every participant's wallet tokens (bank in full, named by the token
  catalog; the wallet-app registry cw20s), LUNA delegated + unbonding, CAPA governance (`staker`), ROAR staking (`staked_balance_at_height`
  + `claims`), aDAO NFT backing (a join on the NFT inventory: held + staked unbroken × per-NFT backing). Failed read = null + reason.
- `history-tokens.js` 1.0.0: tokens by place per wallet per day, folded from the participants / member / holdings / Votion archives,
  the CAPA census and the LST ratio history. Seeds 2026-08-11 → today; then refolds the last day (its archive may have been rewritten
  since) → today. 246 wallets × 64 days, 2.7 MB.
- tla-participants: `member-data/participants/debt.json` every run — loans only (Credia + Solid: collateral, debt, health, liquidation), ~25 KB
  for a phone (a wallet dashboard's home "Debt" row). nft-inventory `earn.js` 1.0.0: `<slug>/snapshots/earn.json` (value = avg of the last 3 sales of
  NFTs unbroken today; yield = backing growth per NFT over ~30 days → APR on value and on backing).
- tla-participants: source 3, followed wallets (`tla-core docs/curated/followed-wallets.json`, addresses only, ≤ FOLLOWED_MAX).
- Finding: one plain-LUNA lock reports 1 LUNA in the lock but 899 at lock (token 765); the capture's `total_locked_luna_equivalent`
  takes the amount at lock, history-tokens takes the chain's amount in the lock. Left for a look at the escrow's lock_info.
- Gate `mock-run-tokens.js` 9/9 on real data (locks = the capture's own LUNA for 197/197 wallets; Votion to the unit; DAO custody exact).


## history-series 1.2.1 — 2026-09-30 — an unpriced row blanks the LP only when it matters

- The aDAO treasury's LP band vanished 08-21 → 09-06: 16 LP rows captured, one $0 xASTRO row unpriced — 1.2.0 blanked the whole day.
  Now a day keeps its LP when the priced rows hold ≥ 90 % of the last recorded LP, flagged partial (new column `lpu` = unpriced rows).
  The GMC case (the unpriced row WAS the position) still blanks. Mock 22/22 (+H9 the treasury's 17 days).

## history-series 1.2.0 — 2026-09-29 — blank, not $0, for an LP the capture could not price

- The GMC backing wallet's chart showed $0 of LP until 09-28 and then a jump to $33K ("1d −99.6 %" on the page): its wBTC.creda.a
  stake was in every daily capture, but UNPRICED (estimated_position_usd null) until capture-engine priced Credia receipts on 09-28 —
  and the series wrote the summary's 0. A day with an unpriced LP position now records lp and the TLA total as BLANK; the chart shows a
  gap. The deep backfill fills those days properly.
- A series built by an older version rebuilds every day by itself (no HISTORY=force to set and remove).
- Gate: mock-run-history 21/21 (H8: GMC's 48 pre-09-28 days blank, priced from 09-28; the owner's day-to-day check skips 8 blank days).

## 1.6.0 — 2026-09-28 — Solid for every participant (SPEC-portfolio-solid)

- New shared `lib/solid-reader.js` 1.0.0. The protocol is read ONCE per run as a census, paged to the end (stops on an EMPTY page —
  a contract may cap the limit): overseer `all_collaterals` (what is LOCKED), market `borrower_infos` (SOLID owed), every custody's
  `borrowers` (deposited; `spendable` = not locked), oracle `prices`, overseer `whitelist`, cw20 `token_info` (decimals; the token catalog
  as the labelled fallback — a Solid wrapper takes its ibc token's decimals). The protocol's own `borrow_limit` is asked only for the
  wallets with a loan.
- **The oracle unit is proven**: `price` is uusd per RAW unit → USD per token = price × 10^(decimals − 6) (ampLUNA / bLUNA = the price
  feed; wBTC 828.44 → $82,844; WETH 2.64e-9 → $2,645). The catalog's WBTC.axl $60.5K is the stale one.
- tla-participants phase 3c `attachSolid`: `portfolio.solid` = collateral per token (locked, idle, USD, max LTV), SOLID debt, borrow limit
  (protocol, else computed), health = limit ÷ loan and its band (safe ≥ 1.5 · watch · at risk < 1.2 · liquidatable < 1), liquidation
  (one collateral: the price it falls to; several: the % they must all fall), net. Summary: `solid_collateral_usd / solid_idle_usd /
  solid_debt_usd / solid_health`. A wallet with nothing in Solid gets nothing (no "$0"). The participants doc gains `solid_protocol`
  (total SOLID owed, collateral locked per token, oracle prices) and `discovery.solid` (census stats). Isolated; `SOLID=0` disables.
- history-series 1.1.0: rows gain `ss` / `sb` (Solid collateral incl. idle / SOLID debt, USD) — null before capture.
- Gate `mock-run-solid.js` S1–S7 9/9 on the chain's recorded answers (solid-probe 1.3): the oracle unit on four assets; the owner's test
  position (limit 0.012243 = the protocol's, computed within 0.1 %, health 1.01 → at risk); deposited = locked + spendable on every
  recorded row; a real borrower (190,100 ampLUNA vs 8,040 SOLID → health 1.43, liquidates at a 29.9 % ampLUNA fall); paging; attach;
  a dead chain touches no one. S8 (the full census vs the protocol's limits) runs once solid-probe 1.4 has committed its fixture.
  mock-run-history H7 (Solid columns) 20/20.

## 1.5.0 — 2026-09-28 — history series: one daily series per wallet for the member portfolio's chart

- Owner: "portfolio trackers have a lot of functionality in their charts — time frames, trends … a central chart the user can change".
  The page's trend read the member archive (~390 KB a day, registered members only) and sampled 17 days — "all" drew 7 dots; the
  participants archive (every lock holder, ~2.5 MB a day) was never readable from a phone.
- New fold `history-series.js` 1.0.0: every archived day (participants + member archive + Votion's daily) folded once into
  `member-data/history/series/<c>.json` (32 shards by the character after "terra1", ~1.2 MB in all, largest ~80 KB) + `index.json`.
  Row: day · TLA total · locks (USD, LUNA at that day's hub rates, LUNA stamped) · LP · staked in a DAO · wallet · Votion (USD, VP) ·
  Credia supplied / borrowed · VP · VP if adjusted · pending rewards · LUNA price · lock count · source. Null = not captured that day.
- The CAPA custody fill for days before capture-engine 1.2 moved here from the page (same rule: nearest supply capture ≤ 7 days back ×
  CAPA that day, cuS=1). New: the supply history's hole (2026-08-10 → 08-23) — a stake held on BOTH sides is carried at the earlier
  capture's CAPA (a lower bound), cuS=2; it was the owner's false $10K dip on 08-17 … 08-23.
- Seeds 2026-08-11 → today on its first run; then refolds today at 23:xx (and fills any missing day). ONE commit per write
  (tla-flows `lib/git-batch.js`). `HISTORY=0` disables, `HISTORY=force` rebuilds, `HISTORY=1` refolds today now.
- Gate `mock-run-history.js` H1–H6 19/19 on the real archives under a 200 MB heap (the owner's 09-28 row == the archive's own fields;
  Votion == Σ his holdings; the DAO stake once; blanks stay null; forward refold in place; largest shard 77 KB).

## 1.4.1 — 2026-09-28 — single-asset cw20 gauges valued (capture-engine 1.2.1)

- Found on the GMC BTC Backing Treasury: its wBTC.creda.a backing (0.3971 tokens, ≈ $33.1K, active single gauge) read "unknown, $0".
  The engine looked a cw20 asset up only by LP-token address — a single-asset gauge has none — so every holder of a cw20 single got a
  nameless $0 row (7 in the hourly read). Now: LP address, else gauge id `cw20:<addr>`.
- A single priced by symbol assumed 6 decimals (wBTC.creda.a has 8 → 100× if a price existed). When the price feed has no symbol price,
  the single is priced from the pool's own row, decimals-free: user_lp × staked_in_tla_usd ÷ amp_lp.underlying_lp_amount.
- `amplifiedPosition()` extracted (pure) and exported; gate `mock-run-singles.js` S1–S5 on real data (S4: 99 pair rows unchanged).

## 1.4.0 — 2026-09-28 — receipts held by a custodian count in every member's totals (capture-engine 1.2)

- Owner: "my ampCAPA is staked in the ampCAPA DAO — still my position, still earning; did it make it into past balances and trends?"
  It did not: the engine only saw what sits in the wallet, so every total, the daily archive and the trends missed DAO-staked receipts
  (owner: $7,156 → $16,854 with the stake; 25 wallets hold one).
- `config/contracts.js` gains `CUSTODIANS` (the ampCAPA DAO voting module — what it holds, which pool, how the stake is measured) and
  `SOLID` (the Capapult CDP set from solid-probe 1.3).
- `lib/capture-engine.js` 1.2: `loadCustody()` reads each custodian's measuring product once per run (the CAPA supply product's
  `capa_equiv.receipt_dao`), prices it at the run's CAPA price → `portfolio.custody[]`, `summary.custody_usd`, and the portfolio total
  includes it with `summary.total_includes_custody = true` so no reader adds it twice. No price → amounts kept, USD blank; product
  unreadable → no custody, error recorded, capture unaffected.
- The shared lib changes every engine user: member-data and ally-positions carry a version bump so Render rebuilds them.
- Gate: `mock-run-custody.js` K1–K6 on real data (owner $9,697.62; 25 wallets = the product's DAO total; no-price / unreadable / pre-1.2).

## 1.3.0 — 2026-09-27 — Credia for every TLA participant (Milestone A · the rewards planner's loan panel)

- tla-participants: new phase 3b `attachCredia` — ONE Credia Portfolio-contract query per participant (`{portfolio:{address}}`,
  contract from `config/contracts.js` CREDIA.portfolio) through the shared `lib/credia-reader.js` 1.0.0 (the same parse
  ally-positions 1.5.1 uses — one code path). Each portfolio gains `credia: { supplied[], debt[], health, supplied_usd,
  debt_usd, net_usd, source }`; USD is Credia's own oracle (the venue's contract is the source). Asset names/decimals from the
  token catalog (shared resolver); an unknown asset keeps its USD with `symbol: null` (never guessed); the TLA ampLP receipt is
  labelled. `summary` gains `credia_supplied_usd`, `credia_borrowed_usd`, `credia_lt_health_factor`.
- A failed read is `credia.error` on that member and never stops the run; an empty read is 0, never null.
  `discovery.credia = { read, failed, with_position, borrowers }`.
- Additive only — no existing field changes. Gate: `TLA_CORE_DIR=<tla-core> node member-data/mock-run-credia.js` (7/7, on the
  real captured answer tla-core docs/fixtures/2026-09-27/credia-portfolio-ryan.json + the committed catalog).

## 1.2.1 — 2026-09-21 — stables named by the catalog symbol (TLA queue item 1)

- tla-snapshot `IBC_REGISTRY`: `USDC` → `USDC.n`, `USDT` → `USDt`, `EURE` → `EURe` — the token-catalog's effective symbols.
  network-and-prices 3.1.0 keys `token_prices` by them, and the PriceResolver's direct lookup would otherwise miss the
  stables and fall to pool-derived / prev-daily prices. `lp_health.asset_N.symbol` on the stable pools now reads the catalog
  symbol (the pool names already did: LUNA-USDC.n).
- dao-dashboard 1.8 `DENOM_MAP`: Noble USDC → `USDC.n` (treasury token named and priced by the catalog symbol). dao_treasury
  3.3 normalizes `USDC.n` = `USDC` in its "What changed" matching so the rename does not read as a DAO action across the
  boundary; `token_prices` in the dashboard product keys `USDC.n` from this run on (older epoch snapshots keep `USDC`).

## 1.1.3 — 2026-09-13 — dao-dashboard reads the aDAO NFT products from nft-collections/adao/

- dao-dashboard 1.7: `summary.json` + `nft-analytics.json` (the NFT strips) now come from `thealliancedao/nft-collections/adao/snapshots/`; tla-core/nfts/adao is gone. No other change. mock-run-last-claims identical to 1.1.2.

## 1.1.1 — 2026-09-10 — tla-snapshot: dead votion read retired

`sources.votion` had been `false` on every run: tla-snapshot still fetched
`votion-epoch-{N}.json` from the personal repo `defipatriot/votion-data_2026`,
which is gone with the parallel-pair cleanup (404 for every epoch, incl. old
ones). The three per-pool fields it attached (`votion_current_vp`,
`votion_optimized_vp`, `lockup_contributions`) were never read by tla-stats
(Rev T4.1 reads `tla-core/votion/*` directly). Removed the fetch, the phase-7
attach, and the `sources.votion` key; org-votion is the only votion source.
Removal only — no figure changes.

## 1.0.2 — 2026-06-29 — concurrent-write hardening

- pushToGithub now retries on GitHub 409/422 sha-conflict (same fix as the other
  crons). Multiple crons write to tla-core; a file's sha can change between our
  GET and PUT, which GitHub rejects with 409. We re-fetch the fresh sha and retry
  (up to 5x, small backoff). No data/logic change.

## 1.0.0 — 2026-06-29 — initial VP layer

The VP-efficiency intelligence layer (Option A: owns held + directed VP).

**What it computes (the three metrics the product needs):**
1. Total Available VP (canonical max-bucket, avoiding the 4x pool-sum inflation).
2. VP voting per bucket (measured per bucket, not an even split).
3. Per-wallet influence (% of an LP's votes) + utilization (idle/underused VP —
   the "leaving VP and bribes on the table" signal).

**Design decisions (recorded):**
- **Option A boundary** — member-data owns the complete VP picture (held +
  directed + efficiency). Bribes/vAPR layer on top via flows, joined using the
  influence numbers here. Held vs directed both needed because utilization =
  held - directed, so they must be in one coherent snapshot.
- **Consolidation** — replaces 4 old crons that each re-walked the same lock
  enumeration (~858 calls x4). Walks once, produces all views.
- **Canonical VP** — max bucket VP, per ecosystem-knowledge tla.vp_canonical
  (pool-summing 4x-inflates). VP per lock is the chain's voting_power (already
  includes LST redemption rate + lock coefficient), not re-derived.
- **Every wallet equal** — aDAO is just one member; the same metrics apply to all.

**Verified:** efficiency math validated against aDAO's actual bucket allocations
from the Eris voting UI (stable 100% utilized, bluechip underutilized, single
idle -> avg utilization surfaces the idle VP correctly).

**Deferred:** bribes/vAPR (flows); ally-protocol view (adao-allies) if wanted as
a member sub-type; multi-wallet entity clustering (cannot be proven on-chain).
