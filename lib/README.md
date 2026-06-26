# lib/ — shared library

Shared code the crons borrow from, so each cron doesn't re-write the same
functions. Every file carries a **status banner** at the top; this table is the
index. The rule: **a cron may only `require()` an `ACTIVE` file.** `STAGED` and
`PARKED` files live here as labeled reference / build-on points — nothing live
depends on them, so the running crons stay reliable.

## Status key
- **ACTIVE** — wired into a live cron right now. Safe to depend on.
- **STAGED** — complete & tested, not yet wired. Reference + future build-on.
- **PARKED** — a direction started but not shipped. Kept for when it returns.

## Index

| File | Status | Purpose | Used by |
|---|---|---|---|
| `capture-engine.js` | **ACTIVE** | Per-address position-capture engine: chain queries, member portfolio, epoch info, primitives | address-catalog, adao-positions, contract-token-catalog, tla-locks, tla-participants, votion-positions |
| `ally-capture.js` | **ACTIVE** | Ally-DAO member discovery (DAODAO communities: Pixel Lions, Lion DAO). The multi-tenant member mechanism | address-catalog, adao-allies |
| `error-reporter.js` | **ACTIVE** | Sanitizes errors so failures surface safely on System Health | votion-positions (should be wired into all) |
| `tla-decompose.js` | **STAGED** | Shared LP position→USD + APR math (dual-use: cron + browser) | activates with aDAO-data / dex-data |
| `tier-builder.js` | **STAGED** | Pure history-rollup cascade (hourly→daily→epoch→monthly→yearly) | activates when rollups return (deferred with fuel) |
| `portfolio-assembler.js` | **PARKED** | Joins cron outputs into one per-address portfolio (Portfolio Tracker feature) | nobody — NOT cron code |
| `portfolio-alerts.js` | **PARKED** | Alert ruleset on an assembled portfolio (Portfolio Tracker feature) | nobody — NOT cron code |

## Notes
- `capture-engine.js` is the foundation — audited clean, every export is used
  (incl. `computeMemberSummary`, called internally by `fetchMemberPortfolio`).
- The two `portfolio-*` files are the **Portfolio Tracker** direction: built and
  tested, not shipped. They *consume* cron output, so they belong to the site/app
  layer if the tracker ever ships — not to a cron. Kept here as labeled reference.
- When a STAGED file gets wired into a live cron, update its banner to ACTIVE and
  update this table.
