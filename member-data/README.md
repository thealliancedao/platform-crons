# member-data Cron

The **VP layer** of TLA Stats — owns the complete voting-power picture: who holds
VP, how they direct it, and how efficiently (idle vs deployed). This is the
foundation for "are voters using their power well, and where should support shift?"

Replaces the old system's four crons that each re-walked the same lock
enumeration (adao-positions, tla-participants, tla-vp-holders, tla-locks). Walks
it ONCE and produces all views. Every wallet is treated equally — aDAO is just
one member.

## The three metrics (the product)

**1. Total Available VP** — all VP held in TLA locks (the system ceiling). The
canonical figure is the escrow's **`total_vamp.vp` = fixed + voting_power**
(published as `system.total_tla_vp` — matches the TLA UI header; SPEC-vp-definition-fix,
shipped 1.1.0). Max-bucket VP is kept only as a sanity reference
(`max_bucket_vp_reference`) — pool-summing 4x-inflates because each wallet's VP
allocates once per bucket across 4 buckets.

**2. VP Voting per Bucket** — how much VP is actually cast into each of the 4
buckets. NOT an even split of the total: voters allocate unevenly and some VP
sits idle, so each bucket's voting total is its own measured number (you might
see 25M in stable, 21M in project).

**3. Per-Wallet Efficiency** — for each wallet:
- **Influence** — its vote on an LP as a share of *that LP's total votes* (e.g.
  aDAO's 708K on LUNA-USDC out of the pool's total = its control of that LP).
- **Utilization** — how much of its available VP is actually deployed vs **IDLE**.
  A bucket voted under 10000 bps is underutilized; a bucket not voted at all is
  idle. Idle VP is power left on the table — VP that could be directing rewards
  and earning bribes but isn't.

> Bribes / vAPR are deliberately NOT computed here — they layer on top via the
> `flows` cron, joined using the influence numbers this cron produces. Boundary:
> **VP held + directed = member-data; bribe economics = flows.** A wallet's
> influence % (from here) x a pool's bribe pot (from flows) = its bribe share.

## How it works

1. **Held VP** — enumerate the voting-escrow CW721 (`all_tokens` -> `owner_of` +
   `lock_info`); `lock_info.voting_power` is the chain's final VP per lock (already
   includes the LST redemption rate and lock-time coefficient — VP is ground
   truth from the contract, not re-derived). Aggregate per wallet.
2. **Directed VP** — per wallet, `gauge_controller.user_info{user,time:'next'}`
   returns `gauge_votes[]`: per-bucket allocations as `[[poolKey, weight_bps]]`
   (10000 bps = 100% of that bucket's vote slot).
3. **Compute** — utilization (bps vs 10000 per bucket; idle buckets), system
   per-bucket voting totals, the canonical `total_vamp` total (max-bucket kept
   as reference), and per-wallet influence.

Pool names are read from token-catalog (`gauge_pool_id` -> name) rather than
re-queried — reuse, not duplication. Names are cosmetic; VP math is unaffected if
the lookup is unavailable.

## Honest data discipline

- **Enumeration completeness** — if an `all_tokens` page returns null (query
  FAILED, not end-of-list), the census is marked `partial`, never published as a
  complete `ok` census on truncated data.
- **Fail vs empty** — a failed query is distinguished from a legitimately-empty
  result; failures surface in `meta.errors`, never silently coerced.
- **VP is the chain's number** — we use `voting_power` from the contract, not a
  re-derived value, so the held VP can't drift from what the chain says.

## Output (tla-core, member-data module)

```
member-data/snapshots/current.json      full: system totals + every wallet
member-data/snapshots/holders.json       light: address + vp + utilization (tiles)
member-data/snapshots/daily/<date>.json  forward-only daily archive
member-data/snapshots/heartbeat.json     freshness signal
```

`current.json` shape: `system { total_tla_vp {fixed, voting_power, vp, vp_human}, max_bucket_vp_reference, total_vp_held_all_wallets,
vp_voting_per_bucket }` + `wallets[] { address, rank, total_vp_held_human,
vp_from_locks_human, lock_count, buckets{<bucket>{ allocations, utilization_pct,
idle_bps }}, unvoted_buckets, avg_utilization_pct, fully_utilized, influence }`.

## The wallet data + history layer (1.7.0, 2026-10-13) — the ONE place apps read a wallet's past

The aDAO dashboard and other apps read these products; none keeps its own wallet history. Each app reads
**now** live from the chain and **the past** from here. This section is that contract's only home — the apps link here.

```
member-data/participants/daily/<date>.json   every participant's TLA position (hourly, the day's last run kept)
member-data/holdings/daily/<date>.json        what each participant holds OUTSIDE TLA (once a day, 23:xx UTC) — holdings.js
member-data/holdings/current.json · heartbeat.json
member-data/history/series/<c>.json + index    one USD row per wallet per day (history-series.js)
member-data/history/tokens/<c>.json + index    tokens BY PLACE per wallet per day (history-tokens.js)
member-data/participants/debt.json             loans only, every run: Credia + Solid collateral, debt, health, liquidation (~25 KB)
nft-collections <slug>/snapshots/earn.json     one unbroken NFT's value (avg of the last 3 unbroken sales) + backing APR (nft-inventory earn.js)
```

**Who is covered.** Participants = TLA lock holders ∪ bribe providers ∪ **followed wallets** (`tla-core docs/curated/followed-wallets.json`,
addresses only; a wallet that asks to be followed without a lock — e.g. one that only LPs). Registered aDAO members come from
the positions archive. A wallet's history starts the day it is first covered — no archive, no row (never back-filled by guess).

**holdings rec** (per wallet): `tokens {SYM: amount}` liquid in the wallet (all natives named by the token catalog + the `HOLDINGS.cw20`
tokens) · `unknown {denom: raw}` · `staked.LUNA {delegated, unbonding}` · `gov {capa-gov|roar-stake: {token, staked, unstaking}}` ·
`nft {held, staked, listed, unbroken, broken, backing {token: ampLUNA, amount}}` (backing = held + staked unbroken × the inventory's
per-NFT backing; listed NFTs apart) · `errors[]` (a failed read is null + a reason — never 0). Queries: tla-core `docs/queries.md` §22.

**history/tokens row**: `[day, cov, { SYM: { place: amount } }]` — human units of the BASE token after that day's LST ratio
(`price-history/ratios`: ampLUNA / arbLUNA / bLUNA → LUNA, ampCAPA → CAPA, ampROAR → ROAR; any other token stays itself).
Places: `w` wallet · `ls` wallet, liquid-staked · `st` with validators · `lk` TLA locks · `lp` TLA LPs (pool share) · `dao` held by a
custodian (the ampCAPA DAO) · `gov` governance stakes · `nft` aDAO backing · `rw` pending rewards / rebase / bribes · `vt` Votion ·
`cs` CAPA elsewhere per the CAPA census (≥10K CAPA wallets, only on a day without holdings). `cov` says what the day covered:
`p` TLA capture · `h` holdings · `v` Votion · `c` CAPA census. **A place a day did not cover is absent — read cov, never assume 0.**
Before 2026-10-13 (no holdings) a wallet's LUNA has no `st` / `nft` and only LUNA-family natives in `w`; an app should show those
days as partial, not as a drop. index.json maps each symbol to its denom (null = the pool snapshot's loose name, e.g. `WBTC`).

**Cost.** holdings ≈ 19 reads a wallet once a day (~4,000 at 210 wallets, concurrency 5); history-tokens is a fold (no chain reads).
Env: `HOLDINGS=0|1` (off / force now), `HOLDINGS_HOUR` (23), `HISTORY_TOKENS=0|force|1`, `FOLLOWED=0`, `FOLLOWED_MAX` (500).
Gate: `TLA_CORE_DIR=<tla-core checkout> node member-data/mock-run-tokens.js` (9/9 on real data).

## Render setup

- Repo: `thealliancedao/platform-crons` · Root dir: `member-data`
- Build: `npm i` (no deps) · Start: `node index.js`
- Schedule: per-epoch is the natural cadence (votes settle per epoch); daily is
  fine for capturing drift. Hourly is overkill (VP doesn't move that fast).
- Env: `GITHUB_TOKEN` (fine-grained, `thealliancedao/tla-core`, Contents r+w).
  Without a token it writes to `./out/`.
- Chain cost: ~1 enumeration + ~2 queries/lock + 1 user_info/wallet. Bounded
  concurrency (5) protects publicnode LCD.

## Recent changes

- **1.7.0 (2026-10-13)** — the wallet data + history layer (section above): `holdings.js` 1.0.0, `history-tokens.js` 1.0.0,
  followed wallets as a participants source. Seeded fold: 246 wallets × 64 days (2026-08-11 → 10-13), 2.7 MB in 32 shards.

- **1.1.0 (2026-07-14)** — VP definition fix (SPEC-vp-definition-fix). Held VP
  = **boost + fixed** everywhere (`lib/vp.js` doctrine header corrected);
  queries the escrow's `total_vamp` and publishes
  `system.total_tla_vp {fixed, voting_power, vp, vp_human}` as CANONICAL —
  `canonical_total_vp` renamed `max_bucket_vp_reference` (sanity check only);
  per-lock census entries + the held-vs-locks cross-check move to total basis.
  Live-verified on Render: Total TLA VP **27,973,049.25** = TLA UI, 4/4
  outputs, status ok. (Mock: 11/11 assertions on real chain fixtures.)
- **1.0.0** — initial VP layer. Three metrics (available VP, per-bucket voting,
  per-wallet influence + utilization/idle). Walks the lock enumeration once +
  user_info per wallet (Option A: held + directed in one coherent snapshot).
  Canonical max-bucket VP. Bribes/vAPR deferred to flows. Mined proven mechanics
  from tla-vp-holders + capture-engine; validated efficiency math against aDAO's
  real allocations.
