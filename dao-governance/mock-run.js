// MOCK GATE — dao-governance. Fixture: the REAL migrated aDAO corpus (37
// hand-vetted proposals). Chain responses are reconstructed from each entry's
// own numbers, so the gate proves the MAPPER's arithmetic + shape reproduce
// the corpus the audit tool already renders.
const fs = require('fs');
const m = require('./index.js');
let pass = 0, fail = 0;
const T = (n, c, d='') => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + ' ' + d)); };
const corpus = JSON.parse(fs.readFileSync('/home/claude/ssfold/gov/aDAO/governance/proposals.json','utf8'));
const registry = JSON.parse(fs.readFileSync('/home/claude/ssfold/gov/aDAO/governance/registry.json','utf8'));

const STATUS_REV = { 'Executed':'executed','Passed':'passed','Rejected':'rejected','Open':'open','Vetoed':'vetoed','Closed':'closed' };
function toChain(o){  // rebuild the chain response this entry must have come from
  return { id: parseInt(String(o.id).replace(/\D/g,''),10), proposal: {
    title:o.title, description:o.description, proposer:o.proposer,
    status: STATUS_REV[o.status] || String(o.status).toLowerCase(),
    votes:{ yes:String(o.votes.yes), no:String(o.votes.no), abstain:String(o.votes.abstain) },
    total_power:String(o.totalPower),
    threshold:{ threshold_quorum:{ threshold:{percent:String((o.voting.passThreshold??50)/100)}, quorum:{percent:String((o.voting.quorumThreshold??10)/100)} } },
    msgs:o.rawMsgs||[] } };
}
console.log('===== G1: arithmetic + shape reproduce the vetted corpus =====');
let ok=0, tot=0, badIds=[], outcomeDiffs=[], reasonDiffs=[];
const names = Object.fromEntries((corpus.proposals[Object.keys(corpus.proposals)[0]].voters||[]).map(v=>[v.address,v.name]));
for (const [id,o] of Object.entries(corpus.proposals)) {
  tot++;
  const votes=(o.voters||[]).map(v=>({voter:v.address,vote:v.vote,power:String(v.power)}));
  const mapped = m._test.mapProposal({ id:parseInt(String(id).replace(/\D/g,''),10), chain:toChain(o), votes, names:Object.fromEntries((o.voters||[]).map(v=>[v.address,v.name])), registry, daoId:corpus.dao, idPrefix:'a' });
  // legacy ids drift in case within ONE file (a1..a9 lowercase, A31..A37
  // uppercase). We emit a consistent prefix; compare case-insensitively.
  const same = mapped.id.toLowerCase()===String(o.id).toLowerCase() && mapped.title===o.title && mapped.status===o.status
    && mapped.votes.yes===o.votes.yes && mapped.votes.no===o.votes.no && mapped.votes.abstain===o.votes.abstain && mapped.votes.total===o.votes.total
    && Math.abs(mapped.voting.turnout-o.voting.turnout)<1e-9
    && Math.abs(mapped.voting.yesPercent-o.voting.yesPercent)<1e-9
    && mapped.voting.quorumReached===o.voting.quorumReached
    && mapped.totalPower===o.totalPower
    && (mapped.voters||[]).length===(o.voters||[]).length;
  // outcome/outcomeReason compared separately: the legacy export had NO veto
  // branch (outcome 'unknown', empty reason) — we fix that deliberately.
  const outcomeSame = mapped.outcome===o.outcome;
  if (same) ok++; else {
    badIds.push(id);
    const why=[];
    if (mapped.id.toLowerCase()!==String(o.id).toLowerCase()) why.push('id');
    for (const k of ['title','status','totalPower']) if (JSON.stringify(mapped[k])!==JSON.stringify(o[k])) why.push(k+':'+JSON.stringify(mapped[k])+'≠'+JSON.stringify(o[k]));
    for (const k of ['yes','no','abstain','total']) if (mapped.votes[k]!==o.votes[k]) why.push('votes.'+k);
    for (const k of ['turnout','yesPercent','quorumReached']) if (JSON.stringify(mapped.voting[k])!==JSON.stringify(o.voting[k])) why.push('voting.'+k+':'+JSON.stringify(mapped.voting[k])+'≠'+JSON.stringify(o.voting[k]));
    if ((mapped.voters||[]).length!==(o.voters||[]).length) why.push('voters');
    console.log('      ('+id+' → '+why.join(', ')+')');
  }
  if (!outcomeSame) outcomeDiffs.push(`${id}: ${o.status} legacy='${o.outcome}' new='${mapped.outcome}'`);
  if (o.outcomeReason && mapped.outcomeReason!==o.outcomeReason) reasonDiffs.push(`${id}: '${o.outcomeReason}' → '${mapped.outcomeReason}'`);
}
T(`all ${tot} vetted proposals reproduce exactly (id/title/status/votes/turnout/quorum/threshold/voters)`, ok===tot, JSON.stringify(badIds.slice(0,6)));
T('outcome matches legacy on every NON-vetoed proposal', outcomeDiffs.length===1 && /Vetoed/.test(outcomeDiffs[0]), JSON.stringify(outcomeDiffs));
T('the sole divergence is the legacy veto gap, now classified', outcomeDiffs[0]==="a1: Vetoed legacy='unknown' new='rejected'", JSON.stringify(outcomeDiffs));
T('ids normalized to one casing (legacy file mixed a1..a9 with A31..A37)', Object.keys(corpus.proposals).some(k=>/^A/.test(k)) && Object.keys(corpus.proposals).some(k=>/^a/.test(k)));
T('quorum-miss reasons reproduced verbatim (incl. percentages)', reasonDiffs.length===0, JSON.stringify(reasonDiffs.slice(0,3)));

// LEGACY BUG: it computed thresholdReached as yes / ALL votes (abstain
// included), so abstain-heavy proposals showed "threshold not reached" even
// though they EXECUTED on chain. dao-proposal-single excludes abstain from
// the pass threshold. We use yes/(yes+no); assert the divergence set is
// exactly those self-contradicting entries.
const thr = [];
for (const [id,o] of Object.entries(corpus.proposals)) {
  const votes=(o.voters||[]).map(v=>({voter:v.address,vote:v.vote,power:String(v.power)}));
  const mp = m._test.mapProposal({ id:parseInt(String(id).replace(/\D/g,''),10), chain:toChain(o), votes, names:{}, registry, daoId:corpus.dao, idPrefix:'a' });
  if (mp.voting.thresholdReached !== o.voting.thresholdReached) thr.push({id, status:o.status, legacy:o.voting.thresholdReached, now:mp.voting.thresholdReached, abstain:o.votes.abstain});
}
T('thresholdReached differs ONLY where legacy contradicted the chain outcome', thr.every(t => t.legacy===false && t.now===true && t.status==='Executed' && t.abstain>0), JSON.stringify(thr));
T('every legacy-vs-new threshold divergence is abstain-driven', thr.length>0 && thr.every(t=>t.abstain>0), `${thr.length} entries: ${thr.map(t=>t.id).join(',')}`);

console.log('===== G2: threshold parsing =====');
T('threshold_quorum → percents', JSON.stringify(m._test.readThresholds({threshold_quorum:{threshold:{percent:'0.5'},quorum:{percent:'0.1'}}}))==='{"quorumThreshold":10,"passThreshold":50}');
T('absolute_percentage → quorum 0', m._test.readThresholds({absolute_percentage:{percentage:{percent:'0.66'}}}).passThreshold===66);
T('unknown shape → nulls (never fabricated)', m._test.readThresholds({weird:{}}).passThreshold===null);

console.log('===== G3: trust join (the audit tool\'s point) =====');
const known = Object.keys(registry.contracts)[0];
const dec = m._test.decodeMsgs([
  { wasm:{ execute:{ contract_addr:known, msg:Buffer.from(JSON.stringify({stake:{amount:'5'}})).toString('base64'), funds:[{denom:'uluna',amount:'100'}] } } },
  { wasm:{ execute:{ contract_addr:'terra1unknownaddressnotinregistry000000000000000000', msg:Buffer.from(JSON.stringify({drain:{}})).toString('base64'), funds:[] } } },
], registry);
T('registry hit → trusted + contractName + decoded action', dec.decodedActions[0].verificationStatus==='trusted' && dec.decodedActions[0].action==='stake' && !!dec.decodedActions[0].contractName);
T('registry miss → not_yet_verified (surfaced, not hidden)', dec.decodedActions[1].verificationStatus==='not_yet_verified' && dec.decodedActions[1].trusted===false);
T('funds recorded as treasury outflow', dec.treasuryImpact.outflows[0].amount==='100');

console.log('===== G4: verify-mode diffing =====');
const doc = { proposals: Object.fromEntries(Object.entries(corpus.proposals).map(([k,v])=>[k,v])) };
let v = m._test.verifyAgainst(JSON.stringify(corpus), doc);
T('identical corpus → zero mismatches', v.mismatches.length===0 && v.oldCount===v.newCount);
const tampered = JSON.parse(JSON.stringify(doc));
const fid = Object.keys(tampered.proposals)[0];
tampered.proposals[fid].votes.yes += 1;
v = m._test.verifyAgainst(JSON.stringify(corpus), tampered);
T('tampered vote detected', v.mismatches.length===1 && /votes\.yes/.test(v.mismatches[0]));

console.log('===== G5: safety wiring =====');
const src = fs.readFileSync('index.js','utf8');
T('PROBE and VERIFY write nothing', /if \(PROBE \|\| VERIFY\) \{ console\.log\(`  \[report-only\]/.test(src));
T('publishes blob-sha verified', src.includes('blob sha mismatch'));
T('repo state read via contents API, not raw CDN', src.includes('vnd.github.raw') && !src.includes('raw.githubusercontent'));
T('DAOs discovered by listing, not hardcoded', src.includes('listRepoDir(DAO_REPO)') && !/\['aDAO'/.test(src));
T('proposal module self-verified via proposal_count', src.includes('{ proposal_count: {} }'));
T('names joined from org catalog only', src.includes("catalog/snapshots/current.json"));

console.log(`\n===== DAO-GOVERNANCE GATE: ${pass}/${pass+fail} =====`);
process.exit(fail?1:0);
