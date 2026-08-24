// mock-run-last-claims.js — gate for dao-dashboard deriveLastClaims (2026-08-24).
// Fixture = the DAO treasury's actual claim executions from tla-flows events
// 2025-06 → 2026-07 (7 events), as committed. Run: node mock-run-last-claims.js
'use strict';
const { deriveLastClaims, CLAIM_KINDS } = require('./dao-dashboard.js');
const DAO = 'terra1sffd4efk2jpdt894r04qwmtjqrrjfc52tmj6vkzjxqhd8qqu2drs3m5vzm';
const ev = (ts, tx, acts, user = DAO, type = 'claim') => ({ schemaVersion: 3, txhash: tx, height: 1, timestamp: ts, type, user, raw_actions: acts });
const FIX = [
  ev('2025-06-15T00:00:00Z', '41BE8BE400', ['execute', 'execute_proposal_hook', 'asset/claim_rewards', 'ca/withdraw', 'transfer']),
  ev('2025-08-05T00:00:00Z', 'FE786CD861', ['execute', 'execute_proposal_hook', 'asset/claim_rewards', 'ca/withdraw', 'transfer', 'bribe/claim_bribes']),
  ev('2025-09-08T00:00:00Z', 'D4412A470B', ['execute', 'execute_proposal_hook', 'send', 've/deposit_for', 'gauge/update_vote', 'asset/claim_rewards']),
  ev('2025-12-18T00:00:00Z', 'ACE7A4964A', ['execute', 'execute_proposal_hook', 'asset/claim_rewards', 'ca/withdraw', 'transfer']),
  ev('2026-01-11T00:00:00Z', '86A06BC874', ['execute', 'execute_proposal_hook', 'bribe/claim_bribes', 'transfer', 'gauge/claim_rebase', 'send']),
  ev('2026-05-18T00:00:00Z', '5E68783F8A', ['execute', 'execute_proposal_hook', 'asset/claim_rewards', 'ca/withdraw', 'transfer', 'zapper/swap']),
  ev('2026-07-07T00:00:00Z', 'E0F3F7C9B2', ['execute', 'execute_proposal_hook', 'send', 've/deposit_for', 'gauge/update_vote', 'asset/claim_rewards']),
  ev('2026-08-01T00:05:09Z', '79CF7F6587', ['asset/update_rewards', 'ca/claim_rewards', 'erishub/bond'], null),                   // a member's amplified-vault claim: user null → ignored
  ev('2026-08-10T00:00:00Z', 'AAAA', ['asset/claim_rewards'], 'terra1hr8zsfpch47qygc96c8e6rzkd2t7mafqx77ulw'),                   // another wallet → ignored
  ev('2026-05-22T13:17:24Z', '8CA042ED97', ['execute'], DAO, 'deposit'),                                                          // DAO deposit, not a claim → ignored
];
let P = 0, F = 0; const check = (n, ok, x) => { if (ok) { P++; console.log('  ✓ ' + n); } else { F++; console.log('  ✗ ' + n + (x != null ? '  ← ' + JSON.stringify(x) : '')); } };
const r = deriveLastClaims(FIX);
check('deposit rewards last claimed 2026-07-07 (asset/claim_rewards in the lock-adjust tx), not 2025-12-18', r.deposit && r.deposit.date === '2026-07-07' && r.deposit.txhash === 'E0F3F7C9B2', r.deposit);
check('vote (bribes) last claimed 2026-01-11', r.vote && r.vote.date === '2026-01-11', r.vote);
check('rebase last claimed 2026-01-11', r.rebase && r.rebase.date === '2026-01-11', r.rebase);
check('locks last adjusted 2026-07-07', r.locks && r.locks.date === '2026-07-07', r.locks);
check('other wallets, user:null and non-claim DAO events are ignored', !JSON.stringify(r).includes('AAAA') && !JSON.stringify(r).includes('79CF7F6587') && !JSON.stringify(r).includes('8CA042ED97'));
check('empty window → every kind null (unknown), never a date', Object.values(deriveLastClaims([])).every(v => v === null));
check('CLAIM_KINDS covers the four tiles', Object.keys(CLAIM_KINDS).join() === 'deposit,vote,rebase,locks');
console.log(`\n=== MOCK GATE: ${P} passed, ${F} failed ===`); process.exit(F ? 1 : 0);
