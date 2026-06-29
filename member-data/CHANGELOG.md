# member-data — changelog

## 1.0.1 — 2026-06-29 — single-source config

- Contract addresses (GAUGE_CONTROLLER, VOTING_ESCROW) and BUCKETS now imported
  from the shared `config/contracts.js` instead of local copies, per the
  single-source-of-truth doctrine. Fix an address there once and every cron is
  fixed. (index.js -> ../config; lib/vp.js -> ../../config. Both paths verified.)
- No behavior change; nothing data-related is hardcoded. canonical_total_vp and
  all VP figures are COMPUTED live from the chain census every run (they change
  as people lock/unlock/adjust and as LST rates move — never a fixed value).

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
