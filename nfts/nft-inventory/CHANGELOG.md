# nfts/nft-inventory — changelog

## nft-inventory Rev D.2 — 2026-09-19 — BBL completeness from cw721 ownership · dao-controlled only with a custody block

- Measured on both collections (aDAO chain 30 / warlock 43, PL 30 / 72): BBL's `auction_by_contract` returns the `limit`
  auctions with the lexicographically LARGEST token ids and its `start_after` cursor (an auction_id in queries.md, never seen
  to advance) hands back the same page. The sweep used to break silently on that "stuck" page; warlock quietly carried the
  rest, and the C.6 chain-only detection could only see page 1 — the inverse #745 (PL: 1 BBL-held token invisible to both).
- The sweep asks for 100 rows (the contract's cap is the page size — 30 today), tries the auction_id cursor then the last
  row's token_id, and WARNS ONCE when neither advances. Completeness moved to `fetchMarketplaces(bblOwnedTokenIds)`: every
  token the BBL contract HOLDS (cw721 owner) that the sweep missed is fetched by auction_id when warlock knows it (`auction{}`
  → a real chain row, source `chain`, no warning; the warlock row is the fallback only when that query fails, warned as
  `warlock_only_by_id_failed`) or by token (`nft_auction{}` → `chain_only` when structurally live, warned as before; a
  bidder / timed end → `chain_only_not_structurally_live`; no auction → stays "marketplace-owned, no active listing").
  Without the warlock liveness oracle a completed row is `chain` with `warlock_visible:null`, never a guessed chain-only.
- Field names for `auction` / `nft_auction` SELF-RESOLVE: plausible shapes are tried, the contract's serde error ("expected
  one of `…`") is read for the real ones, the answering shape is memoized and reported. `summary.listing_resolver.bbl_sweep`
  = { asked, page_size, pages, cursor (auction_id | token_id | stuck | single_page), rows, completed_by_id,
  completed_by_token, complete, owned, query_shapes }. `warlock_only_missing_from_chain_sweep` warnings are gone (a completed
  row is not a warning) — listing_resolver_warnings should read 0 on both collections unless something is truly chain-only.
- dao-controlled.json publishes only for a collection whose manifest has a `custody` block (`HAS_CUSTODY`; aDAO true, PL
  false — PL's first run fired aDAO's ids_total / operator guards on a set that does not exist for it). The stale
  pixel-lions/snapshots/dao-controlled.json is to be deleted by hand.
- Heartbeat `stats.rev` = D.2 (was stuck at C.6). fetchJson error bodies carry 400 chars (the serde message).
- Gates: mock-run-chain-only (stubbed contract = the measured live behaviour; C.6 + D.2 completion, warlock-down and
  by-id-failing paths; 31 checks) · gate-collection-config (18: + the run-ally PATH case in a child process exactly as
  run-ally.js spawns it, venues as a relation to the manifest, HAS_CUSTODY) · gate-nft-root (47: smart queries compared by
  contract + variant, not base64 body) · market-history / compact-bundle mocks unchanged. Every mock under
  --max-old-space-size=200. mock-run-custody's W 12 vs 8 on today's fixture is pre-existing and unchanged.

## nft-inventory Rev D.1 · compact-bundle 1.3.0 · analytics 1.1.1 — 2026-09-18 — collection-agnostic

- Every collection-specific address / token-id set / feature switch is a COLLECTION CONFIG. Default (COLLECTION unset or
  `adao`) = the aDAO literals verbatim — a no-op for the aDAO service. `COLLECTION=<slug>` loads
  nft-collections/<slug>/collection.json (+ venues.json) at the start of the run: contract, DAO core + DAODAO module from
  `governance`, Enterprise legacy custodian by ROLE from `capture.custodians`, treasury / council / operator wallets from
  `custody`, backing token from `backing.token.address` (none → Phase 6 skipped, backing null everywhere), break mechanism,
  Phoenix ids from `tiers.phoenix.token_ids`, venues from `marketplaces`. NFT_ROOT defaults to the slug.
- compact-bundle 1.3.0: trait columns, supply, metadata + rarity inputs from the manifest (index.js sets COLLECTION_TRAITS /
  COLLECTION_SUPPLY / METADATA_URL / RARITY_URL); a second rank oracle (BBL rarity) only where one exists. The aDAO bundle
  is byte-identical to 1.2.0 (same columns, same order — aDAO's manifest trait list IS the old column list).
- The aDAO manifest now carries its literals (`custody`, `tiers`, `backing.token.address`): gate-collection-config.mjs
  proves configFromManifest(adao/collection.json) === ADAO_DEFAULT_CONFIG field by field, PL resolves from its own
  manifest, applyCollection rebinds the classifier, and the bundle differential holds. 15/15. Existing mocks unchanged.
- Vocabulary caveat: the record flag `unminted` means "held by the DAO core" — right for aDAO (mint-era stock), a misnomer
  for a fully-minted collection. The flag name is kept (bundle bits are additive-only); the manifest-driven explorer
  labels it per collection.
- Queued: move this folder to nfts/nft-inventory (engine name, not a tenant) once both services run — a Render root
  change on both.

## market-history 1.5.0 — 2026-09-18 — the usd-daily copies are retired (oracle series instead)

- luna/bluna-usd-daily are no longer read or written. token-catalog 1.9.0 publishes tla-core/price-history/series/<SYMBOL>.json
  (one sorted day→usd map per catalog symbol, derived from the oracle month files, seeded once, appended daily); app 2.0.5
  and nft-explorer 4.34 read those. market-history loads the trailing three oracle months for forward sales / closes.
- Owner action after commit: delete nft-collections/adao/snapshots/luna-usd-daily.json and bluna-usd-daily.json.
- mock-run-market-history skips G1/G2 when the copies are gone and builds the LUNA-on-day view from the oracle. GATE PASS
  with and without the copies.

## market-history 1.4.1 · nft-inventory banner — 2026-09-18

- 1.4.0's first run stamped `denom_symbol` on 3,172 listing-history segments in memory and then skipped the publish
  (only opened/closed counted as a change) — 1.4.1 publishes when segments were stamped. The usd-daily rebuild log now
  separates value corrections (bLUNA) from precision rewrites (LUNA: same number, fewer decimals) and added days.
- index.js: the startup banner said Rev C.4; it is C.6 (heartbeat was already right).

## market-history 1.4.0 — 2026-09-18 — the org price oracle is the only source for past USD (owner)

- `dayUsd` reads tla-core/price-history first (source `price-history:<src>`), par stables second, never the copies.
  Audit: the luna-usd-daily copy matched the oracle on all 1,572 days; the bluna-usd-daily copy (CoinGecko's bLUNA
  market chart) differed from the oracle's LUNA×ratio on 261 of 379 days, worst 29.6%, and had a 515-day hole.
- `syncDailyFromOracle`: both copies are rebuilt from the oracle (first run: whole span; later runs: tails) and labeled;
  kept only because app.html, release-history.html and nft-explorer-app.js still read them (repoint queued).
- mock G3 now asserts oracle pricing (8-decimal oracle vs 16-decimal copy tolerance). GATE PASS.

## market-history 1.3.0 — 2026-09-18 — denom → symbol from the shared resolver; listing-history segments stamped

- `symbolFor(denom)`: lib/denom-symbol.js (token-catalog effective layer) first, the local DENOM_MAP only when the catalog
  read fails. Every new listing-history segment carries `denom_symbol`; `maintainListingHistory` stamps the ones written
  before the field (3,172 on today's fixture: LUNA, bLUNA, SOLID — 0 unknown). Sales-enriched rows resolve the same way.
- mock-run-market-history: resolver built on the real catalog; new check (every segment stamped, ≥95% resolved, never an
  address as a symbol). GATE PASS.

## NFT_ROOT / DATA_REPO — 2026-09-12 — aDAO migration step 1 (no-op until the env flips)

- ALL FIVE modules resolve their aDAO paths from `NFT_ROOT` (default `nfts/adao`) instead of literal
  strings: snapshots/, flows/, transfers/, claims/, state-history/. `GITHUB_REPO` stays the WRITE repo.
- NEW `DATA_REPO` (default `thealliancedao/tla-core`, never follows GITHUB_REPO) for the TLA-side reads:
  network-and-prices, token-catalog (was a hardcoded tla-core URL), price-history, tla-voting/capture-registry.
- `NFT_PATH` env still honoured (market-history / analytics / compact-bundle), now defaulting to `${NFT_ROOT}/snapshots`.
- Each module exports `PATHS` (its resolved paths) so gates can assert them without a third copy.
- Gate: `gate-nft-root.mjs` (47/47) — DIFFERENTIAL: with default env the patched modules touch byte-for-byte the
  same URL set as the live modules (reads and writes, three stub behaviours); FLIPPED (GITHUB_REPO=nft-collections,
  NFT_ROOT=adao): no URL mentions nfts/adao, every aDAO read/write lands under nft-collections/adao/, every TLA-side
  read still hits tla-core, every write goes to nft-collections; PATHS asserted directly for the constants the runtime
  probe cannot reach (state-history, claims, price-history, tla-voting).
- Versions: index.js (rev in header), flows 0.2.0, market-history 1.2.0, analytics 1.1.0, compact-bundle 1.1.0.
- The flip (later, one Render env change on org-nft-inventory + org-nft-adao-daily):
  `GITHUB_REPO=thealliancedao/nft-collections` · `NFT_ROOT=adao` (+ the token must have nft-collections write).
- NOTE: mock-run-market-history / -compact-bundle / -custody fail identically on live main and on this patch
  (dated fixture expectations, e.g. "19 stranded", "reaches yesterday") — fixture drift, not this change.


## compact-bundle 1.0.0 — 2026-08-23 — the first-paint product (explorer perf)

- NEW compact-bundle.js in the warm/full pass (runs last — a derived view of
  everything above): dict-encoded traits + grade + both ranks + status bitmask
  + listing USD for all 10,000 tokens in ONE 437KB product
  (nfts/adao/snapshots/explorer-bundle.json) vs the 16.3MB the page loads
  today. Rebuilt whole each pass, never merged, no history of its own.
- REFUSES to publish on any count mismatch vs summary.json (a fast wrong
  bundle is worse than a slow right page). Metadata-join floor 9,990/10,000.
- Gate: mock-run-compact-bundle.js on the real committed inputs — 10,000 rows
  id-sorted, 437KB, #6192 trait round-trip, flags reconcile (1,631 staked,
  17+2 custody, 5,828 unminted), ranks match rarity records, refusal proven.
- Page consumption (boot swap + background hydrate + lazy BBL detail) is the
  next explorer delivery — the product must land and verify first.


## market-history 1.1.0 — 2026-08-23 — unresolved-exit sentinel (the "never again" invariant)

- Every marketplace exit is a sale or a delist — no third thing. The sentinel
  (warm/full, trailing 60d, `SENTINEL_WINDOW_DAYS` overridable) flags every v1
  exit record with no v2 sale/cancel record for the same tx: loud log lines +
  `stats.unresolved_exits` and the tx list in market-history-heartbeat.json.
  Motivated by the missed 2026-08-21 Atrium sale of #6192 (owner-caught).
- Registry-driven marketplace set (nft_marketplace stream entries) — a new
  venue is guarded the moment it's registered, no code change.
- Gate G6 on the REAL committed 2026/08 month: the missed sale tx flags
  pre-resolution, clears on resolution, window respected. Shape-aware: passes
  both before and after the resolve-market-exits Action runs.
- Companion: coverage & gap register appended to tla-core/docs/DATA-MAP.md
  (FCD→walker seam Jan 7–9 2025, OTC invisibility, vocabulary lock status,
  frozen-spot semantics).


## market-history 1.0.0 — 2026-08-23 — the ported duty (Analytics tab un-frozen)

- **NEW module market-history.js** — forward maintenance of sales-enriched.json,
  listing-history.json, luna-usd-daily.json, bluna-usd-daily.json (frozen since
  June when the data-repo Action retired without the duty being ported). Inputs:
  classifyNftTx v2 records (nfts/adao/transfers) + org price-history. Merges INTO
  the same org paths — deeper history, never a side file. Laws enforced in code:
  entry-keyed prior rows byte-verbatim, never-shrink (throws, refuses publish),
  ambiguous v2 sales NEVER enriched (warned for a human), missing price days left
  blank (no carry-forward fabrication), repairs labeled (repair field).
- **Wired into the warm/full pass** after analytics, isolated like analytics
  (a failure never taints inventory). Analytics re-derives from committed inputs
  next pass — never from in-flight state.
- **flows.js: delisting→sale upgrade at rollup** — the "future sales feed" the
  diff comment promised. A delisting whose token has a same-day non-ambiguous v2
  sale record retypes to sale (upgraded_from:'delisting', chain price carried).
- **Gate (permanent): mock-run-market-history.js** — real committed products +
  the 64 REAL batch-settle sales (self-derived from the FCD archive via the
  same-repo live classifier). G1/G2 daily fills (prior-verbatim, no fabricated
  days, idempotent), G3 the 64 (labeled, priced day-of, legs sum to gross, prior
  1,259 byte-verbatim, re-feed adds 0, ambiguous refused), G4 listing lifecycle
  (open/close/unmatched, all-ever-seen dedupe — a closed listing can never be
  phantom-reopened by scan-window overlap), G5 flows upgrade.
- One-off recovery of the 64 lives in tla-core (.github/scripts/nft-market-history)
  per repo-placement law — runs the LIVE classifier + enricher, idempotent.


## C.6 — 2026-08-23 — raw-custody count + daodao_custody_unattributed bucket (the 9981 fix)

- **Root cause of classification sum 9981**: `daodaoCustodyCount` filtered on the
  `daodao_staked` FLAG, which prior resolution had already flipped to false for
  the 19 stranded tokens — so custody read 1631, chain count = 1631−1631 = 0,
  the tracker looked reconciled, and the C.5 sweep never re-fired. Custody now
  counts RAW chain ownership (`owner == staking contract`): 1650 in every mode.
- **New bucket `daodao_custody_unattributed`**: the third custody state the old
  "custody = active + pending; no third state" model denied — unstaked long ago,
  claim window expired, never claimed (includes legacy 1319/3605/6847/7123).
  Resolution strands land here; the chain claims tracker promotes attributable
  ones to `daodao_pending_claim` (with real unstaker as real_owner); tokens that
  leave custody clear entirely. A held token is never no-bucket.
- Summary/heartbeat/console carry the new count; classification-sum guard
  includes it (expects 10,000 again).
- **Gate (permanent): `mock-run-custody.js`** — real committed nfts.json (the
  poisoned 19-token base), four scenarios: warm-fresh, hot-carry, tracker-sweep,
  tracker-empty. All must sum to 10,000 with the 19 bucketed and never phantom.


## 1.0.0 — 2026-06-29 — org migration + analytics + blueprint

- **Inventory cron**: migrated proven Rev C.4 into the org. Plumbing only
  (GITHUB_REPO → thealliancedao/tla-core; OUTPUT_PATH → nfts/adao/snapshots;
  409-retry on commit; startup tag). 2,200+ lines of NFT logic byte-for-byte
  identical to the proven version — verified by diff.
- **analytics.js** (new): floor by grade(1-40) + object, backing-to-floor ratio,
  all-time sales analytics from existing sales-history.json (no backfill — history
  was already captured to 2023-12). Validated on real data (1,043 LUNA sales /
  177,643 LUNA all-time). Separate module; reads cron outputs, logic untouched.
- **BLUEPRINT.md** (new): how to add a collection without touching aDAO. Collections
  are isolated sibling folders (nfts/<collection>/ in both repos).
- **History seeded**: sales-history, sales-enriched, floor-history,
  listing-first-seen, pending-claims copied from old data repo into
  tla-core/nfts/adao/snapshots/ so accumulated history carries forward.

Deferred: floor by planet/inhabitant (rarity data is grade+object, no separate
category); price source → token-catalog (verified follow-up).
