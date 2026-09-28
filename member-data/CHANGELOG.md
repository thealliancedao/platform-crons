# member-data — changelog

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
