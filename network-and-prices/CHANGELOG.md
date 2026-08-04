# network-and-prices CHANGELOG

## 3.0.1 — 2026-08-04 — EURE cgId correction (wrong coin)
- TOKEN_REGISTRY EURE cgId 'euroe-stablecoin' → 'monerium-eur-money-2'. The old
  id pointed at EUROe (unrelated, collapsed, ~$0.51 stale); Terra's EURE is
  the Noble channel-253 Monerium EURe (current token; the '-2' id is the post-migration API id — the un-suffixed id belongs to the OLD token) (~$1.15-1.17 on CG, agreeing with
  Astroport). Live impact before fix: flagged_mismatch resolver demoted the
  CORRECT Astroport price as "stale" and shipped $0.5128 as final — EURE USD
  understated ~2.24x platform-wide. Expect direct_match + final ~$1.15 after.
- Canary blind spot documented: EURE trades only in concentrated pools, so
  the xyk canary has no reference for it — match_quality is EURE's guard.
- Shipped as edit E11 in apply-port-edits.js; provenance gate (Layer 1)
  updated to 16 declared edits; new Layer-2 assertion pins the cgId.

## 3.0.0 — 2026-08-04 — ORG PORT + PRICE CANARY
- Ported from `defipatriot/cron-scripts` v2 (legacy repo now inspiration-only).
  Provenance-gated: index.js proven byte-identical to legacy + 15 declared
  edits (mock-run Layer 1).
- Outputs move to `thealliancedao/tla-core` under `network-and-prices/`
  (current.json / daily/ / ratio-history.json / heartbeat.json).
- Migration fallbacks (read-only, remove after cutover): ratio-history seeds
  from the legacy repo on first run (series never restarts); previous-heartbeat
  falls back to legacy so consecutive-stuck counting stays continuous.
- PHASE 6.5 PRICE CANARY: xyk-implied cross-check of every final price vs
  tla-core dex-data captures. xyk-only by doctrine (concentrated/stable
  excluded — phantom-divergence trap, see AUDIT-eris-apr-pricing.md); anchors
  USDC/USDT/LUNA at our finals; depth floor $5k; flag >10%; SS refs marked
  unverified; verified ref beats unverified at any depth; never changes
  finals, never fails the run. Snapshot gains `price_canary`; heartbeat gains
  `price_canary_flags` + `price_canary_symbols`.
- `require.main` guard + module.exports test surface (no-third-copy gate).
- schemaVersion stays 2 deliberately — all changes field-additive so every
  consumer keeps working unmodified during parallel-run.
- Gate: mock-run.js 24/24 on trimmed-real fixtures (live 2026-08-03/04).
  Pinned: SOLID drift −0.11% unflagged vs $90,168 USDC-SOLID ref; CAPA
  correctly floored out at $4.6k depth; concentrated LUNA-arbLUNA proven
  excluded; SOLID ×1.25 mutation flags at exactly +24.86%; bLUNA flag
  carries reference_unverified via its $171k SS pool.

## (v2 and earlier)
See `fixtures/legacy-v2.js` header and the legacy repo history.
