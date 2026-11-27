#!/usr/bin/env node
// dao-governance/probe-validator-votes.js — PROBE (2026-11-27): the node's own answers for the two public endpoints
// validator-votes.js reads, and the table it makes of them, for every Terra proposal in its voting period.
//   GET /cosmos/staking/v1beta1/validators?status=BOND_STATUS_BONDED     GET /cosmos/gov/v1/proposals/{id}/votes
// Read-only GETs to a public node; nothing is written to any repo by this script — it prints one JSON document
// (or writes it to OUT). Raw samples are the FIRST TWO rows of each answer exactly as the node sent them, with one change:
// a voter that is not a validator's own account is written as "<wallet>" (delegators are people; validators are public).
const https = require('https'); const fs = require('fs'); const VV = require('./validator-votes.js');
const LCD = process.env.TERRA_LCD || 'https://terra-lcd.publicnode.com', LCD2 = process.env.TERRA_LCD_FALLBACK || 'https://phoenix-lcd.terra.dev';
const get = (url) => new Promise((res) => { const r = https.get(url, { headers: { 'User-Agent': 'tla-dao-governance-probe', Accept: 'application/json' }, timeout: 20000 }, (m) => { let b = ''; m.on('data', (c) => { b += c; }); m.on('end', () => res({ status: m.statusCode, body: b })); }); r.on('error', () => res({ status: 0, body: '' })); r.on('timeout', () => { r.destroy(); res({ status: 0, body: '' }); }); });
let requests = 0, failed = 0; const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getJson = async (p) => { for (const base of [LCD, LCD2]) { requests++; await sleep(350); const r = await get(base + p); if (r.status === 200) { try { return JSON.parse(r.body); } catch (e) { /* next */ } } failed++; } return null; };
(async () => {
  const out = { probe: 'gov-validator-votes', at: new Date().toISOString(), lib: VV.VERSION, node: 'public LCD', raw: {}, proposals: [] };
  const list = await getJson('/cosmos/gov/v1/proposals?proposal_status=PROPOSAL_STATUS_VOTING_PERIOD&pagination.limit=20'); const open = (list && list.proposals) || [];
  out.open_ids = open.map((p) => Number(p.id)); out.raw.proposal_keys = open[0] ? Object.keys(open[0]) : null;
  const v = await getJson('/cosmos/staking/v1beta1/validators?status=BOND_STATUS_BONDED&pagination.limit=2'); out.raw.validators_first_two = v ? { validators: v.validators, pagination: v.pagination } : null;
  const valAccounts = new Set(); { const all = await getJson('/cosmos/staking/v1beta1/validators?status=BOND_STATUS_BONDED&pagination.limit=200'); for (const x of (all && all.validators) || []) { const a = VV.toAccount(x.operator_address); if (a) valAccounts.add(a); } out.raw.validators_page_of_200 = all ? { n: (all.validators || []).length, pagination: all.pagination } : null; }
  for (const p of open.slice(0, 4)) { const id = Number(p.id);
    const first = await getJson(`/cosmos/gov/v1/proposals/${id}/votes?pagination.limit=2`); const mask = (x) => Object.assign({}, x, { voter: valAccounts.has(x.voter) ? x.voter : '<wallet>' });
    const tally = await getJson(`/cosmos/gov/v1/proposals/${id}/tally`);
    const R = await VV.read({ id, getJson });
    out.proposals.push({ id, title: p.title || null, voting_end_time: p.voting_end_time || null, raw_votes_first_two: first ? { votes: (first.votes || []).map(mask), pagination: first.pagination } : null, tally: tally ? tally.tally : null, result: R }); }
  out.requests = requests; out.failed = failed;
  const txt = JSON.stringify(out, null, 1); if (process.env.OUT) fs.writeFileSync(process.env.OUT, txt + '\n'); else console.log(txt);
  console.error(`probe: ${out.open_ids.length} open proposal(s) ${out.open_ids.join(', ')} · ${requests} requests, ${failed} failed`);
})();
