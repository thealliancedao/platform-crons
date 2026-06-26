# Token-Catalog Cron

The platform's **WORTH layer** — what tokens exist in TLA and what they're worth.
The companion to address-catalog (the WHO layer). Built in **stages** so each is
verifiable on a parallel run before the next is layered on:

| Stage | Adds | Status |
|-------|------|--------|
| **1 — discovery** | pools (active + inactive) + underlying tokens | ✅ this file |
| 2 — identity | native/IBC/wrapped, route, logo, variations, + override layer | next |
| 3 — pricing | DEX / TLA-hub / CoinGecko prices + agreement check | next |

Reserves & slippage grading (#10/#11) are **out of scope** — that's the `dex-data`
domain. Token-catalog stops at "what exists and what it's worth."

## Why discovery first

You can't price what you don't know exists. Stage 1 enumerates the **complete**
TLA pool set and resolves every LP to its underlying tokens. That token set *is*
the price list — Stage 3 prices exactly what discovery finds, nothing more (only
what's in TLA, not all of Astroport/SkeletonSwap/Credia).

## Discovery chain (grounded in queries.md, proven in tla-registry)

1. **Active pools** — gauge `distributions` (active set + vote %).
2. **Inactive pools** — `whitelisted_asset_details` on each of the 4 staking
   buckets. Returns the COMPLETE set incl. below-threshold and dewhitelisted, each
   flagged `whitelisted:true|false` with take-rate metadata.
   ⚠ **Phase-0 scar:** this query, NOT `whitelisted_assets` (which is active-only).
3. **Underlyings** — cw20 LP → `minter` → pair → `pair{}` asset_infos;
   native/factory LP → pair from `factory/{addr}/` denom → `pair{}`. Each
   underlying denom is distinct (wBTC.axl ≠ wBTC.eureka — variations preserved,
   resolved in Stage 2).

## Output

`tla-core` `token-catalog` module, snapshots product. Stage 2/3 enrich the **same**
`current.json` (the page reads it throughout). Forward-only.

```
token-catalog/snapshots/
├── current.json             pools[] + tokens[]
├── daily/{YYYY-MM-DD}.json  forward-only daily snapshot
├── index.json               manifest
└── heartbeat.json           standard heartbeat
```

`current.json` (Stage 1):

```
meta            { version, schemaVersion, stage:'discovery', generated_at, epoch, status, source }
counts          { pools_total, pools_active, pools_inactive, pools_below_threshold,
                  pools_dewhitelisted, unique_tokens }
discovery_stats { active_query_ok, buckets_succeeded/checked, underlyings{} }
pools[]         { gauge_pool_id, bucket, lp_address, lp_type, gauge_status,
                  distribution_pct, total_vp, take_rate, underlyings[], architecture }
tokens[]        { denom, kind, found_in_pools[] }   ← identity/price fields added Stage 2/3
```

`gauge_status` is one of `active` | `inactive_below_threshold` | `dewhitelisted`.

## The override layer (Stage 2, designed in now)

Stage 2 adds per-field overrides so a human can correct what discovery reads. Each
overridable field becomes a block: `{ discovered, override:bool, value, note }`.
Rule: `override:false` → use `discovered`; `override:true` → use `value`. Overrides
live in `token_overrides.json` (curated, tla-core) — **never** in the cron's
discovered output; merged at read time. Discovery keeps running underneath, so
clearing an override auto-returns to the live read (e.g. if Astroport fixes a
mislabeled denom, reverting the override restores the 1:1 match and lifts the LP
grade). An editable HTML page toggles these and downloads the updated overrides to
commit (or PR → approve).

## Single source

Structural addresses (gauge, staking buckets) come from `config/contracts.js`.
The cron has **zero** hardcoded addresses.

## Render setup

- Repo: `thealliancedao/platform-crons` · Root dir: `token-catalog`
- Build: `npm i` · Start: `node token-catalog.js`
- Schedule: every 6h is plenty for Stage 1 (pricing in Stage 3 may want fresher).
- Env: `GITHUB_TOKEN` (fine-grained, `thealliancedao/tla-core`, Contents r+w),
  `GITHUB_REPO` (optional, defaults to the org).

Without `GITHUB_TOKEN` it writes local `token-catalog.json` + `heartbeat.json` only.

## Recent changes

- **1.0.0-stage1** — discovery. Active pools (gauge `distributions`) + inactive
  (`whitelisted_asset_details` per bucket, active+below_threshold+dewhitelisted) +
  underlying resolution (`minter`→`pair`). Forward-only snapshots shape. Identity
  and pricing fields stubbed null pending Stages 2/3. Consolidates the discovery
  half of network-and-prices + contract-token-catalog + chain/tla-registry.
