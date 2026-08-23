#!/usr/bin/env node
// mock-run-custody.js — BINDING gate for the daodao_custody_unattributed bucket
// and the raw-custody count fix (the 9981 bug).
//
// Real fixture: the committed nfts.json from tla-core (the poisoned base where
// the 19 stranded tokens carry all-false buckets). No network; pure functions.
// Usage: TLA_CORE_DIR=/path/to/tla-core node mock-run-custody.js
//
// Scenarios:
//  W  warm-fresh   — classifyOwner from raw chain owner, resolution strands the 19
//                    → daodao_custody_unattributed, sum == 10000
//  H  hot-carry    — records verbatim from the committed (poisoned) base; RAW
//                    custody count must still read 1650 (flag-filter read 1631)
//  T  tracker-sweep — pending block carries the 19 as claimable (C.5 sweep shape)
//                    → all 19 promote to daodao_pending_claim, attributed, sum == 10000
//  E  tracker-empty — pending block empty → the 19 land/stay custody-unattributed,
//                    NEVER no-bucket, sum == 10000
'use strict';
const fs = require('fs'), path = require('path');
const CORE = process.env.TLA_CORE_DIR;
if (!CORE) { console.error('TLA_CORE_DIR required'); process.exit(1); }
const M = require('./index.js');

const DAODAO = 'terra1c57ur376szdv8rtes6sa9nst4k536dynunksu8tx5zu4z5u3am6qmvqx47';   // read from index.js — keep in sync
const doc = JSON.parse(fs.readFileSync(path.join(CORE, 'nfts/adao/snapshots/nfts.json')));
const base = doc.records;
if (base.length !== 10000) { console.error(`fixture: expected 10000 records, got ${base.length}`); process.exit(1); }

const BUCKETS = ['unminted','daodao_staked','treasury_held','dao_wallet_8ywv_held','enterprise_staked',
  'enterprise_dao_broken','bbl_listed','atrium_listed','boost_listed','daodao_pending_claim',
  'daodao_custody_unattributed','user_held'];
const bucketSum = (recs) => recs.filter(r => BUCKETS.some(k => r[k])).length;
const noBucket = (recs) => recs.filter(r => !BUCKETS.some(k => r[k]));
// The 19 in DAODAO custody but not actively staked. The COMMITTED base evolves:
// pre-fix (poisoned) they carry no bucket at all; post-fix (healed by C.6) they
// split pending/unattributed. The gate asserts the LAWS on either shape.
const stranded = base.filter(r => r.owner === DAODAO && !r.daodao_staked);
const LEGACY4 = ['1319','3605','6847','7123'];
let fails = 0;
const check = (name, ok, detail) => { console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`); if (!ok) fails++; };

const nb = noBucket(base).length;
const shape = nb === 0 ? 'healed (post-C.6)' : 'poisoned (pre-fix)';
console.log(`fixture: ${base.length} records · capturedAt ${doc.capturedAt} · custody-not-active ${stranded.length} · shape: ${shape}`);
check('fixture: 19 custody-not-active, base fully bucketed OR poisoned-19', stranded.length === 19 && (nb === 0 || nb === 19), `${stranded.length} custody-not-active, ${nb} no-bucket`);
check('legacy 4 among the custody-not-active', LEGACY4.every(id => stranded.some(r => String(r.id) === id)));

// --- H: hot-carry — RAW custody count on the poisoned base -------------------
{
  const rawCustody = base.filter(r => r.owner === DAODAO).length;
  const flagCustody = base.filter(r => r.daodao_staked).length;
  check('H: raw custody reads 1650 on carried flags', rawCustody === 1650, `raw ${rawCustody}`);
  check('H: flag-filter would have read 1631 (the bug)', flagCustody === 1631, `flag ${flagCustody}`);
  const { block } = M.applyPendingEvents({ lastScannedHeight: 0, entries: [] }, [], [],
    { custodyCount: rawCustody, totalPower: 1631, tipHeight: 1, scanFailed: false });
  check('H: chain count = 19, drift visible (sweep would fire)', block.count === 19 && block.reconciled === false,
    `count ${block.count} reconciled ${block.reconciled}`);
}

// --- W: warm-fresh — classify from raw owner, resolution strands -------------
{
  const recs = base.map(r => ({ ...r, ...M.classifyOwner(r.owner, r.broken), real_owner: r.owner }));
  // daodaoMap: every ACTIVELY staked token resolves; the 19 are absent (real shape)
  const daodaoMap = {}; for (const r of base) if (r.daodao_staked && r.real_owner !== DAODAO) daodaoMap[String(r.id)] = r.real_owner;
  const entMap = {}; for (const r of base) if (r.enterprise_staked && !r.enterprise_unattributed) entMap[String(r.id)] = r.real_owner;
  const warnings = [];
  M.applyStakerResolution(recs, daodaoMap, entMap, warnings);
  const un = recs.filter(r => r.daodao_custody_unattributed);
  check('W: resolution strands exactly the 19 → custody-unattributed', un.length === 19, `${un.length}`);
  check('W: stranded set matches base stranded ids', un.every(r => stranded.some(s => s.id === r.id)));
  check('W: no record left without a bucket', noBucket(recs).length === 0, `${noBucket(recs).length}`);
  check('W: bucket sum == 10000', bucketSum(recs) === 10000, `${bucketSum(recs)}`);
  check('W: real_owner stays contract (no fabricated address)', un.every(r => r.real_owner === DAODAO));
}

// --- T: tracker sweep attributes the 19 as claimable → pending ---------------
{
  const recs = base.map(r => ({ ...r }));
  const claimable = stranded.map((r, i) => ({ token_id: r.id, address: `terra1unstaker${i}xxxxxx` }));
  M.applyPendingClaimFlags(recs, { in_window: [], claimable });
  const pend = recs.filter(r => r.daodao_pending_claim);
  check('T: all 19 promote to pending_claim', pend.length === 19, `${pend.length}`);
  check('T: promotion clears unattributed', pend.every(r => !r.daodao_custody_unattributed));
  check('T: real_owner = unstaker (attributed)', pend.every(r => r.real_owner.startsWith('terra1unstaker')));
  check('T: bucket sum == 10000', bucketSum(recs) === 10000, `${bucketSum(recs)}`);
}

// --- E: tracker empty — downgrade/land in custody-unattributed, never no-bucket
{
  // seed half the stranded as stale-pending (prior warm shape), half as bare (poisoned shape after resolution)
  const recs = base.map(r => {
    const c = { ...r };
    if (stranded.some(s => s.id === r.id)) {
      const idx = stranded.findIndex(s => s.id === r.id);
      if (idx % 2 === 0) c.daodao_pending_claim = true; else c.daodao_custody_unattributed = true;
    }
    return c;
  });
  M.applyPendingClaimFlags(recs, { in_window: [], claimable: [] });
  const un = recs.filter(r => r.daodao_custody_unattributed);
  check('E: empty tracker → all 19 in custody-unattributed', un.length === 19, `${un.length}`);
  check('E: no stale pending survives', recs.filter(r => r.daodao_pending_claim).length === 0);
  check('E: bucket sum == 10000', bucketSum(recs) === 10000, `${bucketSum(recs)}`);
  // a token that LEFT custody with a stale flag clears entirely
  const gone = { ...stranded[0], owner: 'terra1someuserwalletxxx', daodao_pending_claim: true, daodao_custody_unattributed: false, user_held: true };
  M.applyPendingClaimFlags([gone], { in_window: [], claimable: [] });
  check('E: left-custody stale flag clears (no phantom)', !gone.daodao_pending_claim && !gone.daodao_custody_unattributed);
}

console.log(fails === 0 ? '\nGATE PASS' : `\nGATE FAIL (${fails})`);
process.exit(fails === 0 ? 0 : 1);
