# dao-governance — org cron

Chain-derived governance capture for every DAO in `thealliancedao/dao-originations`.
Replaces the hand-exported corpus that lived in `defipatriot/adao_json_storage`.

## The three-way split
| Layer | Owner | Where |
|---|---|---|
| **proposals** | THIS CRON (automatic) | `<dao>/governance/proposals.json` + `history/<yyyy>/<mm>.json` |
| **members** | org address-catalog (already had them) | `tla-core/catalog/snapshots/current.json` — joined here for voter names, never stored |
| **registry** | HUMAN, per DAO | `<dao>/governance/registry.json` — the trust layer; this cron only reads it |

## Registry-driven
DAOs are discovered by LISTING folders in dao-originations. Each DAO's proposal
module is found from its own registry (contracts with `propose` in validActions)
and self-verified by a `proposal_count` query. Adding a DAO = add a folder.

## Trust join (why the registry matters)
Each proposal's msgs are decoded; targets found in that DAO's registry are
marked `trusted`, everything else `not_yet_verified` — surfaced, never hidden.
New proposals get auto-triaged against vetted knowledge; anything unknown is
flagged for a human. Each collection maintains its own registry.

## Modes — RUN IN ORDER THE FIRST TIME
```
PROBE=1   node index.js   # dump RAW chain response + mapped output; writes nothing
VERIFY=1  node index.js   # map everything, DIFF vs the migrated corpus; writes nothing
          node index.js   # capture + publish
```
Kill-switch `DAO_GOVERNANCE=0`. Suggested cadence: every 6h (proposals are slow;
the index news feed already probes live ones client-side).

## Known legacy divergences (deliberate, gate-asserted)
1. **Vetoed proposals**: legacy emitted `outcome: "unknown"` + empty reason (no
   veto branch). We classify as rejected with an explicit reason.
2. **thresholdReached**: legacy divided yes by ALL votes (abstain included), so
   3 abstain-heavy proposals showed "threshold not reached" despite having
   EXECUTED on chain. dao-proposal-single excludes abstain — we use yes/(yes+no).
3. **id casing**: legacy mixed `a1..a9` with `A31..A37` in one file; normalized.

## Gate
`node mock-run.js` — 20/20 against the REAL 37-proposal vetted corpus.
