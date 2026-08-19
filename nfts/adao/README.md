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

## BANDWIDTH GATE (2026-08-12) — read before changing the publish path

`nfts.json` is ~6.4 MB, and GitHub's contents API requires it **base64-encoded
in the request body** (+34%), so each publish costs ~8.5 MB OUTBOUND. At the
15-minute hot cadence that is **~24 GB/month from this one file** — roughly 85%
of the platform's entire Render bandwidth bill, and the reason the overage
warnings started.

The cron now hashes CHAIN STATE and skips the publish when nothing changed:

- **Hashed:** ownership, custody, staking, pending-claim, broken status, and
  each listing's marketplace / seller / **raw** price / denom / type / bidder.
- **Deliberately NOT hashed:** `price_usd` and `price_usd_source` — DERIVED
  from the live price feed, not chain. They move every run as LUNA moves, so
  including them would make the hash always differ and save nothing.
  `summary.json` (0.11 MB) still publishes every run with fresh USD and
  backing, so the site's headline numbers stay live regardless.
- **Order-independent:** records are sorted by id before hashing.
- **FULL runs always publish**, hash or not — guaranteeing at least one full
  rewrite per escalation cycle, so the file cannot drift stale indefinitely and
  any corruption self-heals. `FORCE_PUBLISH=1` forces a write on any run.

The heartbeat carries `chainStateFingerprint`, `nfts_last_published_at` and
`nfts_published_this_run`, so a consumer can distinguish "the cron ran 2 min
ago" from "the inventory file is 40 min old". **The freshness signal is the
heartbeat, not nfts.json's own `capturedAt`** — `lib/cron-registry.js` already
reads the heartbeat, so nothing on the site needs to change.

Gate: 9/9 on live data — ignores USD drift across all 65 listings while
detecting ownership changes, new listings, relists, delistings, stake/unstake
and broken-status flips.

## ANALYTICS RUNS INSIDE THE INVENTORY JOB (2026-08-12)

`analytics.js` is not a separate Render job. It is a pure JOIN over files
`index.js` just wrote (nfts.json, sales-history.json, sales-enriched.json) plus
the rarity map — no chain calls — so running it in the same job guarantees it
reads THIS run's output and removes a job from the fleet. Gated to warm/full
runs so hot runs stay light (`NFT_ANALYTICS=0` disables, `=always` forces).

It publishes TWO products: `analytics.json` (floors by rarity grade/object,
sales by grade) and `nft-analytics.json` (the shape `nft-explorer-app.js`
REQUIRES — it throws without `volume` + `leaderboards`; its legacy producer no
longer exists in any repo). Rarity comes from
`thealliancedao/nft-collections/adao/rarity/` — the old `defipatriot/nft-metadata`
URL is DELETED (404) and was silently breaking this.

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
