# member-data — changelog

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
