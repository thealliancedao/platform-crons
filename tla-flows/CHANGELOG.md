# tla-flows — changelog

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
