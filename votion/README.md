# org-votion — Votion vault + holder capture (G2)

Votion users are invisible to every other cron (their LST hides inside a
vault's single veLUNA lock). This module makes them visible — and starts the
daily archive whose absence was the most time-sensitive gap in
UI-DATA-READINESS.

ONE self-escalating cron, two branches (v1):

**A — vaults (every run, hourly, ~20 LCD queries):** discover vaults
(code_id 3677 listing, seed fallback declared), per-vault `{state:{}}`
staked + vdenom supply → exchange rate, escrow `lock_info` → VP as
**fixed + voting_power** (the old cron's boost-only undercount corrected),
and each vault's gauge `user_info` → **per-pool Votion NOW from chain**
(replaces the API-derived figure). Writes `votion/snapshots/vaults.json` +
appends to `votion/history/{YYYY}/{MM}.json` (the series that later yields
realized compounding APY as a pure derivation).

**B — positions (daily, concurrency ≤5):** holder reconstruction from
`votion-la/deposit` events, **incremental** via `holders-registry.json`
(grow-only holder sets + per-vault tx totals; cursors advance ONLY on
complete walks — a failed page can never lose holders or skip deposits).
Per-holder vdenom balance × exchange rate = underlying LST; USD from
token-catalog prices (priority tla → coingecko → astroport → skeletonswap,
per-row `underlying_usd_price_source` tag — the arbLUNA hub-vs-market
transparency lesson); share × vault VP = implied VP. Writes
`snapshots/current.json` + `snapshots/daily/{date}.json` (THE archive).
Zero balance = exited (drops from current, stays in registry); failed
balance read ≠ zero (recorded, holder retained). No names — identity joins
downstream via address-catalog.

**Member sweep (1.1.0):** every wallet member-data currently tracks gets one
full-balances query per daily run; any votion vdenom found makes that wallet
a holder — so every TLA participant's Votion position lands in the portfolio
layer automatically, even pre-retention depositors tx_search can never see.
The candidate list is DYNAMIC (self-updates with member-data — nothing
hardcoded); every value is live-verified; sweep coverage + failures are
declared in the output (member_sweep block), and a failed sweep makes the
run partial, never silently thin. Rows carry found_via
(member_sweep | tx_discovery | curated).

**C — optimizer projection (v1.1, deferred):** Eris Votion API
current-vs-optimized capture; old `votion` cron keeps covering it Sundays
until then.

## Failure semantics
`partial` if any vault's discovery/balances were incomplete; `error` if zero
vaults resolve. All failures in heartbeat `_errors`. null ≠ [] throughout.

## Run
Render cron `org-votion`, hourly at :20. Env: `GITHUB_TOKEN` (rw tla-core).
Node stdlib only. Mock gate (binding): `node mock-run.js` — 28 checks.
