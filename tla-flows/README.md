# tla-flows — org-tla-flows (TLA LP flow event capture, forward)

**Render job:** `org-tla-flows` · schedule `*/15 * * * *` · entry `index.js`
**Data:** `tla-core/tla-flows/events/` — `heartbeat.json` · `index.json` ·
`cursor.json` · monthly `{YYYY}/{MM}.json` JSON arrays (storage per
TLA-CORE-STORAGE-DESIGN, corrected 2026-07-08)

Captures the LP **deposit / withdraw / claim** event stream from the six
shared custody contracts (compounder + four bucket staking contracts + zapper
— share custody is centralized, so six catch every pool). The two things
snapshots can't recover: the exact intra-day **moment of each claim**, and
each flow's **entry/exit slippage receipt** (`cost`: every swap leg with
spread/commission/leg_cost_pct, plus `provide_liquidity` slippage for
imbalanced Tokens deposits; cross-denom legs kept raw — analysis prices the
rollup downstream).

Scope: ONLY LP flow events on those six contracts. Voting events =
tla-voting; positions/valuations = adao-positions; NFT flows = nfts/adao.
Addresses come from `../config/contracts.js` (ZAPPER added 2026-07-08) —
never hardcoded.

## Reliability behavior (org F-checklist)

- **F1** resilient ASC pager (verbatim from org-tla-voting).
- **F7** cursor advances **only on fully complete scans** — a page-capped,
  stuck, or error scan reports `status: "partial"` and holds the cursor so
  the next run re-reads the window. Merge-dedupe by txhash makes the re-read
  idempotent (no duplicate events, proven in mock scenario C).
- **Never-shrink** per month file and on index totals — fewer merged events
  than committed aborts that publish with an error.
- **Never-seed** — if `index.json` shows history but `cursor.json` is
  unreachable, the run aborts with an error heartbeat rather than
  bootstrapping a shallow window over real history.
- **Retention honesty** — if the cursor falls further behind than
  `RETENTION_BLOCKS` (default 86,400 ≈ 6 days; public nodes retain ~1 week),
  the likely-pruned span is recorded in `known_gaps` with precise heights
  (archive-node target) and the cursor moves on. Never papered over, never
  stuck.
- **publishFile** carries a 409-retry (sha re-fetch ×3) on branch races.

## Classifier

`<<FLOWS CLASSIFIER v1>>` markers. The block must stay **byte-identical**
with the flows-fill derive's copy (`tla-core/.github/scripts/tla-flows/`)
once that ships — verify with a plain diff after any change. Logic = the
proven Rev A.3 parser (42/42 on live compounder data + 8 hand-captured
variations); the org shell adds only a `code !== 0` skip.

## Verification — file-based mock run (binding process rule)

`mock-run.js` drives the **real `run()` loop** with stubbed transports
against **real transactions** from the FCD archive
(`FCD_DIR=<tla-core>/archive/fcd node mock-run.js`). 55,199 raw txs → 32,777
unique. All scenarios pass (2026-07-08):

- **A** backfill of a real window — captured == direct classification (2,822
  events), no duplicate txhashes.
- **B** incremental follow-up — only the delta added.
- **C** crash between month publish and cursor — cursor held, heartbeat
  partial; rerun idempotent (+0 duplicates), then advances.
- **D** page-cap on a huge window — `partial`, cursor NOT advanced.
- **E** 409 race ×2 on month publish — retries succeed, nothing lost.
- **F** retention gap — `known_gaps` recorded with resume heights, cursor
  advances past, prior totals never shrink.
- **G** classifier sweep over the FULL archive (the flows-fill preview):
  **32,615 flows** = 15,727 deposits · 4,499 withdrawals · 12,389 claims;
  16,129 via zap; 20,017 with cost receipts; 118 non-flow; 44 failed skipped.

## Deploy checklist (Camron)

1. Commit this folder + the updated `config/contracts.js` (adds `ZAPPER`).
2. Render → new cron job `org-tla-flows`: repo `thealliancedao/platform-crons`,
   schedule `*/15 * * * *`, command `node tla-flows/index.js`.
3. Env: `GITHUB_TOKEN` (contents-write scoped to `thealliancedao/tla-core`) —
   everything else defaults. First run self-bootstraps ~2h back
   (`TLA_LOOKBACK=1200`); to start deeper, set `TLA_START_HEIGHT` once and
   remove it after the first successful run.
4. Watch the first 2–3 runs: heartbeat `status: "ok"`, cursor advancing,
   month file appearing under `tla-flows/events/2026/07.json`.
5. Add the heartbeat to `system-health.js` `MONITORED`:
   `…/tla-core/main/tla-flows/events/heartbeat.json`. **Not optional** —
   outage tolerance is days (retention).
6. After a clean day: mark the CHANGES_PENDING deploy item done; the old
   `defipatriot/cron-scripts/tla-flows` (never deployed) goes to the retire
   board.

## Env

`GITHUB_TOKEN` (required) · `GITHUB_REPO` (default `thealliancedao/tla-core`)
· `GITHUB_BRANCH` (main) · `LCD_PRIMARY` / `LCD_FALLBACK` · `MAX_PAGES` (60)
· `PAGER_*` knobs · `TLA_START_HEIGHT` (first-run override) · `TLA_LOOKBACK`
(1200) · `RETENTION_BLOCKS` (86400).

## Recent changes

# Rev C (2.0.0) — 2026-07-08 — BLOCK-WALKER engine (forward capture done right)
- The tx_search index-scanner (a backfill species) is deleted from this cron;
  the engine now walks each new block since its cursor via RPC — /block
  (header time + raw txs, SHA-256 → txhash) + /block_results (per-tx events),
  skipped for empty blocks. Cost scales with elapsed time, never node
  retention. No pagers, no probing, no empty-page rituals.
- New: watched-contract gate (block data sees the whole chain — spec D4),
  block budget with safe catch-up partial progress (D8), exact pruned-block
  gap recording (D10), cursor = last_block (schema 2, migrates v1).
- Unchanged: <<FLOWS CLASSIFIER v1>> byte-identical · monthly merge/dedupe/
  never-shrink · publisher · heartbeat · Render job/env/token.
- Mock suite rebuilt (8 scenarios) — ALL PASSED on real data, including the
  REAL RPC block 21,823,668 verbatim: one record, hash chain-verified
  (2334BA2B…), withdraw/amplified/via_zap. Doctrine now in the spec (§0):
  backfill tools and forward tools are different species.

# Rev B.1.2 — 2026-07-08 — hard request deadline (first live run stalled)
- `httpGet`'s 20s timer was a socket-IDLE timeout only; a tarpitting LCD that
  trickles bytes never idles → the first live run hung after "first run:"
  with flat network metrics. Added a hard total deadline (2× idle budget,
  40s) that destroys the request → error path → normal retry. Idle timer
  renamed `idle-timeout`; deadline errors read `deadline-40s` in probe logs.
- ⚠ org-tla-voting shares this transport pattern and has the same latent
  weakness — port this fix there next time it's touched (queued in
  CHANGES_PENDING conformance notes).
- Full mock suite re-run — ALL PASSED.

# Rev B.1.1 — 2026-07-08 — observability (first live run looked hung)
- The pager lift had dropped tla-voting's progress lines, so a first run
  (which probes the full ~1-week retained index per contract) printed nothing
  for many minutes. Restored: `scanning…` announcements, page-1 probe
  progress every 8 attempts (with error counts), per-page commit lines, and
  per-contract DONE lines with wall-clock seconds. No loop-logic change;
  full mock suite re-run — ALL PASSED.

# Rev B.1 — 2026-07-08 — org rework of Rev A.3 (deploy review)
- Classifier lifted intact from `cron-scripts/tla-flows` Rev A.3 (42/42
  verified) into an org-conformant shell; `<<FLOWS CLASSIFIER v1>>` markers.
- Fixed the Rev A.3 page-cap data-loss bug (silent truncation + cursor
  advance → now `partial` + cursor held, F7).
- Storage: daily-jsonl plan superseded → monthly `{YYYY}/{MM}.json` merge
  with txhash dedupe + never-shrink (crash-rewind idempotent). Module renamed
  `flows` → `tla-flows` (resolves the nfts/adao collision).
- GitHub API publisher (with 409-retry), tla-core standard heartbeat,
  known_gaps retention honesty, never-seed rule, addresses from
  `config/contracts.js` (ZAPPER added), `code !== 0` skip.
- `mock-run.js` added; full scenario suite passing on 55,199 real archived
  txs (results above).
