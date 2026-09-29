# tla-flows — changelog

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
