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
Per-holder vdenom balance × exchange rate = underlying LST; USD via the
**three-link hub chain (1.2.0, AUDIT-eris-apr-pricing fix #1):**
`underlying_lst × LST's OWN hub exchange_rate × LUNA_USD` — every LST gets
its own hub rate (amp ~1.34, arb ~2.9), queried on-chain each run, never a
catalog LST price and never another LST's rate (the old catalog pricing
collapsed that difference → the 2.2× arbLUNA understatement). Catalog LST
price survives ONLY as a labeled `(fallback)` when the hub query fails
(status → partial, heartbeat `lst_rate_fallback_in_use`). Per-row
`underlying_usd_price_source` + per-vault `lst_luna_hub_rate`/`lst_hub_addr`/
`lst_rate_source` + real `vault_tvl_usd` published; share × vault VP =
implied VP. Writes
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
