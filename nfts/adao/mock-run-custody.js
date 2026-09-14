#!/usr/bin/env node
// mock-run-custody.js — BINDING gate for the daodao_custody_unattributed bucket
// and the raw-custody count fix (the 9981 bug).
//
// Real fixture: the committed nfts.json from tla-core (the poisoned base where
// the 19 stranded tokens carry all-false buckets). No network; pure functions.
// Usage: NFTC_DIR=/path/to/nft-collections [NFT_ROOT=adao] node mock-run-custody.js
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
// 2026-09-14 (B.7): aDAO fixtures read from a nft-collections checkout (NFTC_DIR) + NFT_ROOT (adao) — tla-core/nfts/adao was deleted 2026-09-13
const NFTC = process.env.NFTC_DIR, NFT_ROOT = process.env.NFT_ROOT || 'adao';
if (!NFTC) { console.error('NFTC_DIR required (nft-collections checkout)'); process.exit(1); }
const M = require('./index.js');

const DAODAO = 'terra1c57ur376szdv8rtes6sa9nst4k536dynunksu8tx5zu4z5u3am6qmvqx47';   // read from index.js — keep in sync
const doc = JSON.parse(fs.readFileSync(path.join(NFTC, NFT_ROOT, 'snapshots/nfts.json')));
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
// 2026-09-14 (B.7): the literals (19 stranded · 1650 raw · 1631 flagged) were one day's snapshot. The laws are RELATIONS —
// raw custody = flagged + stranded, the stranded set is what resolution strands, promotion moves exactly that set —
// so they bind to the fixture: N = stranded.length.
const N = stranded.length;
const LEGACY4 = ['1319','3605','6847','7123'];
let fails = 0;
const check = (name, ok, detail) => { console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`); if (!ok) fails++; };

const nb = noBucket(base).length;
const shape = nb === 0 ? 'healed (post-C.6)' : 'poisoned (pre-fix)';
console.log(`fixture: ${base.length} records · capturedAt ${doc.capturedAt} · custody-not-active ${stranded.length} · shape: ${shape}`);
check('fixture: N custody-not-active (N ≥ 1), base fully bucketed OR poisoned-N', N >= 1 && (nb === 0 || nb === N), `${N} custody-not-active, ${nb} no-bucket`);
check('legacy 4: each is either still custody-not-active or has since left/been attributed (never silently rebucketed)', LEGACY4.every(id => { const r = base.find(x => String(x.id) === id); return r && (stranded.includes(r) || r.owner !== DAODAO || r.daodao_staked); }), LEGACY4.map(id => { const r = base.find(x => String(x.id) === id); return `${id}:${stranded.includes(r) ? 'stranded' : r.owner !== DAODAO ? 'left' : 'staked'}`; }).join(' '));

// --- H: hot-carry — RAW custody count on the poisoned base -------------------
{
  const rawCustody = base.filter(r => r.owner === DAODAO).length;
  const flagCustody = base.filter(r => r.daodao_staked).length;
  check('H: raw custody = flagged + stranded (the flag-filter under-read by exactly N — the bug)', rawCustody === flagCustody + N && N > 0, `raw ${rawCustody} = flag ${flagCustody} + ${N}`);
  const { block } = M.applyPendingEvents({ lastScannedHeight: 0, entries: [] }, [], [],
    { custodyCount: rawCustody, totalPower: flagCustody, tipHeight: 1, scanFailed: false });
  check('H: chain count = N, drift visible (sweep would fire)', block.count === N && block.reconciled === false,
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
  check('W: resolution strands exactly the N → custody-unattributed', un.length === N, `${un.length} vs ${N}`);
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
  check('T: all N promote to pending_claim', pend.length === N, `${pend.length} vs ${N}`);
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
  check('E: empty tracker → all N in custody-unattributed', un.length === N, `${un.length} vs ${N}`);
  check('E: no stale pending survives', recs.filter(r => r.daodao_pending_claim).length === 0);
  check('E: bucket sum == 10000', bucketSum(recs) === 10000, `${bucketSum(recs)}`);
  // a token that LEFT custody with a stale flag clears entirely
  const gone = { ...stranded[0], owner: 'terra1someuserwalletxxx', daodao_pending_claim: true, daodao_custody_unattributed: false, user_held: true };
  M.applyPendingClaimFlags([gone], { in_window: [], claimable: [] });
  check('E: left-custody stale flag clears (no phantom)', !gone.daodao_pending_claim && !gone.daodao_custody_unattributed);
}

console.log(fails === 0 ? '\nGATE PASS' : `\nGATE FAIL (${fails})`);
process.exit(fails === 0 ? 0 : 1);
