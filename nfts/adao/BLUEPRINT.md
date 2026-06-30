# NFT Collection Blueprint — How to Add a Collection

This documents how NFT collections are organized and how to add a new one
WITHOUT touching any existing collection. aDAO is the reference implementation.

## Organizing principle: collections are isolated sibling folders

Each collection is fully self-contained in its own folder, in BOTH repos:

```
platform-crons/nfts/<collection>/   ← code (cron + analytics + docs)
tla-core/nfts/<collection>/snapshots/ ← that collection's data
```

- **Add a collection** → create `nfts/<name>/` in both repos.
- **Remove a collection** → delete that folder. Nothing else is affected.
- **aDAO is NEVER modified** when another collection is added or removed. This is
  deliberate: aDAO is proven and verified; we never want to risk re-verifying it
  just because a new collection joined. Isolation is at the folder level — the
  strongest kind.

## Why copy-and-configure (not one generic engine)

Each NFT collection has DEEPLY specific mechanics. aDAO has: a "broken/unbroken"
state, ampLUNA backing per NFT, a Phoenix (grade-40) tier, and specific DAODAO +
Enterprise staking contracts. Another collection will have its OWN unique
mechanics we can't predict. A single "generic engine" would couple all
collections to one codebase — so a change for collection #3 could break aDAO.
That's the opposite of what we want.

So instead: **copy aDAO's folder as the starting blueprint, then adapt the copy**
for the new collection. Each collection evolves independently. The universal ~30%
(enumerate tokens, owners, marketplaces, sales, rarity, floor) is the same shape;
the collection-specific ~70% (backing, staking, tier mechanics) is adapted per
collection.

## What a new collection must bring (integration checklist)

To integrate a collection, gather these and swap them into the copied cron's
config block (top of `index.js`, already grouped and labeled):

**Required (universal — every collection has these):**
- [ ] **NFT contract address** (the CW721) — `ADAO_NFT_CONTRACT` equivalent
- [ ] **Total supply** + whether fully minted
- [ ] **Rarity file** — a canonical `token_id → grade/rank + trait + percentile`
      map (aDAO uses `adao-rarity-intended.json`). Without this, no rarity floors.
- [ ] **Which marketplaces** list it (BBL / Atrium / Boost / others) — reuse the
      shared marketplace constants; most Terra NFTs use the same ones.

**Collection-specific (adapt the logic, or remove if N/A):**
- [ ] **Backing mechanic** — does each NFT accrue a token? Which token? (aDAO =
      ampLUNA.) If none, remove the backing logic.
- [ ] **Staking locations** — where can NFTs be staked? (aDAO = DAODAO +
      Enterprise + treasury custody, each a specific contract.) List the contracts
      and what each represents.
- [ ] **Special states** — does it have a "broken"-like mechanic, or special
      tiers (aDAO = Phoenix grade-40, immutable token-id set)? Adapt or remove.
- [ ] **DAO/treasury wallets** — addresses that hold collection NFTs in custody.

## Steps to add a collection

1. **Copy** `platform-crons/nfts/adao/` → `platform-crons/nfts/<newname>/`.
2. **Swap the config block** (top of `index.js`) using the checklist above.
3. **Adapt collection-specific logic** (backing/staking/tiers) for the new
   collection's mechanics. Remove what doesn't apply.
4. **Set OUTPUT_PATH** → `nfts/<newname>/snapshots`.
5. **Seed history** (if the collection has past sales to migrate) into
   `tla-core/nfts/<newname>/snapshots/`.
6. **Deploy** as its own Render job(s). Verify against the collection's own data.
7. aDAO and all other collections are untouched throughout.

## The reference implementation

`nfts/adao/` is the working reference. When in doubt about how a piece should
work, look at how aDAO does it. It captures: per-NFT state, ownership + staker
resolution, marketplace listings (warlock liveness oracle), floor history,
days-on-market, bids, sales history, and (via analytics.js) floor-by-grade +
sales analytics + backing ratios.
