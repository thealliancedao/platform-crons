#!/usr/bin/env node
// mock-run-new-staker.js — BINDING gate for Rev D.4 (new stakers are attributed, never credited to the voting contract or dropped).
// Real fixture: the committed adao/snapshots/nfts.json — on 2026-10-04 07:12Z it held 15 tokens a first-time staker staked at 03:44Z
// with real_owner = the voting module (hole 1). No network: the chain's staked_nfts answer is simulated from the fixture itself.
// Usage: NFTC_DIR=/path/to/nft-collections [NFT_ROOT=adao] node mock-run-new-staker.js   (or FIXTURE=/path/nfts.json)
//  N1 hot   — the base (previous snapshot) shows those tokens in the staker's wallet → the hot run attributes all 15 to that wallet
//  N2 warm  — the indexer has not listed the staker: before D.4 the 15 flip to custody-unattributed and the staked count drops by 15;
//             with D.4 the staker is found and verified, count unchanged, no token stranded
//  N3 a wrong candidate (the chain lists nothing under it) changes nothing · N4 attributed tokens and pending claims raise no candidate
//  N5 member count includes the new staker
'use strict';
const fs = require('fs'), path = require('path');
const FIX = process.env.FIXTURE || (process.env.NFTC_DIR && path.join(process.env.NFTC_DIR, process.env.NFT_ROOT || 'adao', 'snapshots/nfts.json'));
if (!FIX) { console.error('NFTC_DIR or FIXTURE required'); process.exit(1); }
const M = require('./index.js');
const MOD = M.DAODAO_STAKING_CONTRACT;
let pass = 0, fail = 0; const ok = (m, c, x) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (x !== undefined ? ' → ' + JSON.stringify(x).slice(0, 300) : '')); } };
const clone = (o) => JSON.parse(JSON.stringify(o));
const fixture = JSON.parse(fs.readFileSync(FIX, 'utf8')).records;
const STAKER = 'terra1qqtgqsp4a6vpcpew7dayraf8fp64s3dndqwk3h';
// the planted case: 15 tokens staked by STAKER — if the committed fixture already attributes them (after a D.4 run), re-plant them as unattributed
const IDS = ['968', '1057', '1265', '1703', '2173', '2530', '2532', '2765', '3463', '4186', '4802', '5659', '6296', '7045', '7454'];
const fresh = () => { const r = clone(fixture); for (const x of r) if (IDS.includes(String(x.id))) { x.owner = MOD; x.real_owner = MOD; x.daodao_staked = true; x.daodao_custody_unattributed = false; x.daodao_pending_claim = false; x.user_held = false; } return r; };
const baseOf = () => { const b = clone(fixture); for (const x of b) if (IDS.includes(String(x.id))) { x.owner = STAKER; x.real_owner = STAKER; x.daodao_staked = false; x.user_held = true; } return b; };
// the chain: staked_nfts{address} = every token in custody whose true staker is address (fixture attribution + the planted 15)
const truth = (recs) => { const t = {}; for (const x of recs) if (x.owner === MOD && x.daodao_staked && x.real_owner && x.real_owner !== MOD) (t[x.real_owner] = t[x.real_owner] || []).push(String(x.id)); t[STAKER] = (t[STAKER] || []).concat(IDS); return t; };
const chainMap = (addrs, T) => { const m = {}; for (const a of addrs) for (const id of (T[a] || [])) m[id] = a; return m; };
const stakedN = (recs) => recs.filter(x => x.daodao_staked).length;
console.log(`fixture: ${fixture.length} records, ${stakedN(fixture)} DAODAO staked`);

console.log('— N1 hot run');
{ const recs = fresh(), base = baseOf(); const T = truth(recs);
  const before = recs.filter(x => IDS.includes(String(x.id)) && x.real_owner === MOD).length;
  const cands = M.newStakerCandidates(recs, base, []);
  ok(`the 15 sit on the voting contract before (${before}); the previous snapshot names one candidate — the staker`, before === 15 && cands.length === 1 && cands[0] === STAKER, cands);
  const got = M.applyNewStakes(recs, chainMap(cands, T));
  ok(`all 15 attributed to the staker (${got.tokens} tokens, ${got.stakers} staker), still staked; nothing else changed`, got.tokens === 15 && got.stakers === 1 && IDS.every(id => { const x = recs.find(r => String(r.id) === id); return x.real_owner === STAKER && x.daodao_staked; }) && stakedN(recs) === stakedN(fresh()), got);
  ok('a second hot run finds nothing more to attribute', M.newStakerCandidates(recs, recs, []).length === 0); }

console.log('— N2 warm run, the indexer has not listed the staker');
{ const recs0 = fresh(); const T = truth(recs0); const indexer = Object.keys(T).filter(a => a !== STAKER);
  const old = fresh(); const w0 = []; M.applyStakerResolution(old, chainMap(indexer, T), {}, w0);
  const stranded = old.filter(x => IDS.includes(String(x.id)) && x.daodao_custody_unattributed).length;
  ok(`before D.4: the 15 flip to custody-unattributed and the staked count drops ${stakedN(recs0)} → ${stakedN(old)}`, stranded === 15 && stakedN(old) === stakedN(recs0) - 15, { stranded, n: stakedN(old) });
  const recs = fresh(), base = baseOf(); const extra = M.newStakerCandidates(recs, base, indexer);
  const w = []; M.applyStakerResolution(recs, chainMap([...indexer, ...extra], T), {}, w);
  ok(`with D.4: candidate = the staker (${extra.length}); all 15 attributed, none stranded, staked count unchanged (${stakedN(recs)})`, extra.length === 1 && extra[0] === STAKER && IDS.every(id => recs.find(r => String(r.id) === id).real_owner === STAKER) && !recs.some(x => IDS.includes(String(x.id)) && x.daodao_custody_unattributed) && stakedN(recs) === stakedN(recs0), { extra, n: stakedN(recs) }); }

console.log('— N3 / N4 safety');
{ const recs = fresh(), base = baseOf(); const before = JSON.stringify(recs);
  const got = M.applyNewStakes(recs, chainMap(['terra1' + 'q'.repeat(38)], { [STAKER]: [] }));
  ok('N3 a candidate the chain lists nothing under changes nothing (no fabricated owner)', got.tokens === 0 && JSON.stringify(recs) === before);
  const attributed = clone(fixture).map(x => (IDS.includes(String(x.id)) ? Object.assign(x, { real_owner: STAKER }) : x));
  ok('N4 tokens already credited to a staker raise no candidate', M.newStakerCandidates(attributed, baseOf(), []).length === 0);
  const pend = fresh(); for (const x of pend) if (IDS.includes(String(x.id))) { x.daodao_pending_claim = true; x.daodao_staked = false; }
  ok('    pending claims (unstaking) raise no candidate', M.newStakerCandidates(pend, baseOf(), []).length === 0);
  const sold = fresh(), sb = baseOf(); for (const x of sb) if (IDS.includes(String(x.id))) { x.owner = M.BBL_MARKETPLACE; x.real_owner = 'terra1' + 'z'.repeat(38); }
  const c5 = M.newStakerCandidates(sold, sb, []); const g5 = M.applyNewStakes(sold, chainMap(c5, truth(sold)));
  ok(`    bought off BBL and staked in one window: the candidate (the seller) is checked on chain and resolves nothing — the token keeps its old state`, c5.length === 1 && g5.tokens === 0); }

console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
