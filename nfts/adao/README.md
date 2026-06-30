# nfts/adao — aDAO NFT Collection

The aDAO NFT collection's data layer, and the **reference implementation** for any
future NFT collection (see BLUEPRINT.md). Fully self-contained: adding or removing
another collection never touches this folder.

## Two components

- **index.js** — inventory cron (migrated Rev C.4, proven). Full per-NFT state:
  ownership + staker resolution (DAODAO/Enterprise/treasury), marketplace listings
  (warlock liveness oracle across BBL/Atrium/Boost), broken/unbroken, ampLUNA
  backing, floor history, days-on-market, bids, sales history. Run modes via
  RUN_MODE (full weekly / warm daily / hot 15-min).
- **analytics.js** — collection analytics for holders: floor by rarity grade
  (1-40) + by object trait, backing-to-floor ratio, all-time sales analytics
  (per grade/object, most-sought-after), all-time volume. Reads the inventory
  cron's outputs; proven logic untouched.

## Data location

Writes to `tla-core/nfts/adao/snapshots/`. (Each collection writes to its own
`nfts/<collection>/snapshots/` — fully isolated.)

## Render jobs (this folder)

- `nfts-adao-full` — RUN_MODE=full, weekly
- `nfts-adao-warm` — RUN_MODE=warm, daily
- `nfts-adao-hot`  — RUN_MODE=hot, every 15 min
- `nfts-adao-analytics` — runs analytics.js, daily (after the cron)
Root dir for all: `nfts/adao`. Env: GITHUB_TOKEN (+ RUN_MODE for the cron jobs).

## Adding another collection

See **BLUEPRINT.md** — copy this folder, swap the config, adapt collection-specific
mechanics. aDAO stays untouched.

## Recent changes

- **1.0.0 (org-migrated)** — migrated Rev C.4 into the org under nfts/adao.
  Plumbing only: repo → tla-core, path → nfts/adao/snapshots, 409-retry added.
  NFT logic untouched. Added analytics.js (new) + BLUEPRINT.md. History seeded
  from old data repo. Price source still reads old network-and-prices (live);
  swap to token-catalog deferred as a verified follow-up.
