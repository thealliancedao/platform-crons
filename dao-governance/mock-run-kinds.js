// MOCK GATE — dao-governance 1.2.0 governance kinds (anchor-gov / x-gov).
// Fixtures: CAPA poll 14 numbers as served by app.solidcapa.com's own chain
// read (owner HAR 2026-08-22) re-expressed in Anchor gov poll shape; an x/gov
// proposal in the /cosmos/gov/v1 shape. Proves the two mappers emit the SAME
// contract the daodao mapper does, and that the kind switch routes correctly.
const m = require('./index.js');
let pass = 0, fail = 0;
const T = (n, c, d = '') => { c ? (pass++, console.log('  ✓ ' + n)) : (fail++, console.log('  ✗ ' + n + ' ' + d)); };
const registry = { dao: 'capapult', daoName: 'Capapult (CAPA)', kind: 'anchor-gov', idPrefix: 'c',
  govAddress: 'terra1sf66d5vap897xlvv2hlcp4l20y4pp42r6ala4snk8mgd246jvufqwe0cnm',
  contracts: { terra1shc5n0sqg30fzvg0e2j826j0g73ypmjw9vkf592ghdph5dhau25qha2rks: { name: 'Solid USDC collateral market', type: 'protocol', validActions: ['execute'] } } };
const config = { owner: 'terra17w8udj62rtuuzq2fxl8c8hpg3wdtlcdt7z423d', quorum: '0.3', threshold: '0.5', voting_period: 100800, timelock_period: 10, proposal_deposit: '200000000000', snapshot_period: 100800 };
const execMsg = Buffer.from(JSON.stringify({ update_config: { max_deposit: '100000000000' } })).toString('base64');
const poll14 = { id: 14, creator: 'terra18hhej6usenw44squvdr8fxxp0c83nlffva5mcl', status: 'passed', end_height: 21409761, title: 'Increase USDC Collateral Cap to 100,000 USDC', description: '…', link: 'https://common.xyz/capapult/discussion/1294996',
  deposit_amount: '200000000000', execute_data: [{ order: 1, contract: 'terra1shc5n0sqg30fzvg0e2j826j0g73ypmjw9vkf592ghdph5dhau25qha2rks', msg: execMsg }],
  yes_votes: '155553697939762', no_votes: '0', abstain_votes: '0', staked_amount: '171215036813713', total_balance_at_end_poll: '171215036813713' };
const pollLive = { ...poll14, id: 15, status: 'in_progress', end_height: 22500000, total_balance_at_end_poll: null, yes_votes: '10', no_votes: '5', abstain_votes: '1' };
const voters = [{ voter: 'terra1hr8zsfpch47qygc96c8e6rzkd2t7mafqx77ulw', vote: 'yes', balance: '100' }, { voter: 'terra1abc', vote: 'no', balance: '50' }];

console.log('===== K1: anchor-gov mapper =====');
const a = m._test.mapAnchorPoll({ poll: poll14, voters, config, state: { total_share: '171215036813713' }, height: 22491789, blockTimeSec: 6.1, now: Date.UTC(2026, 7, 22, 16, 0), names: { terra1hr8zsfpch47qygc96c8e6rzkd2t7mafqx77ulw: 'DeFi_Patriot' }, registry, daoId: 'capapult', idPrefix: 'c' });
T('id prefixed c14, status Passed, outcome passed', a.id === 'c14' && a.status === 'Passed' && a.outcome === 'passed');
T('tally: yes 155,553,697,939,762 / total power 171,215,036,813,713', a.votes.yes === 155553697939762 && a.totalPower === 171215036813713);
T('turnout 90.85% ≥ quorum 30 → quorumReached; yes 100% of deciding ≥ 50 → threshold', Math.abs(a.voting.turnout - 90.853) < 0.01 && a.voting.quorumReached === true && a.voting.thresholdReached === true && a.voting.quorumThreshold === 30 && a.voting.passThreshold === 50);
T('execute_data re-expressed as wasm.execute and decoded: action update_config, trusted via registry', a.decodedActions.length === 1 && a.decodedActions[0].type === 'wasm.execute' && a.decodedActions[0].action === 'update_config' && a.decodedActions[0].trusted === true && a.decodedActions[0].args.max_deposit === '100000000000');
T('voters joined from names, sorted by power', a.voters[0].name === 'DeFi_Patriot' && a.voters[0].power === 100 && a.voters[1].name === 'Unknown Member');
T('closed poll: expiration carries height AND an estimate flagged estimated:true (past)', a.expiration.at_height === 21409761 && a.expiration.estimated === true && new Date(a.expiration.at_time_iso) < new Date(Date.UTC(2026, 7, 22, 16, 0)));
T('governanceKind stamped', a.governanceKind === 'anchor-gov' && a.live === false);
const l = m._test.mapAnchorPoll({ poll: pollLive, voters: [], config, state: { total_share: '171215036813713' }, height: 22491789, blockTimeSec: 6.1, now: Date.UTC(2026, 7, 22, 16, 0), names: {}, registry, daoId: 'capapult', idPrefix: 'c' });
T('live poll: Open/pending/live:true, power base = staked_amount, end estimate ≈ +13.9h', l.live === true && l.status === 'Open' && l.outcome === 'pending' && l.totalPower === 171215036813713 && Math.abs((new Date(l.expiration.at_time_iso) - Date.UTC(2026, 7, 22, 16, 0)) / 3600e3 - (8211 * 6.1 / 3600)) < 0.01);
T('no blockTime ⇒ no estimate, height kept (blank beats phantom)', m._test.mapAnchorPoll({ poll: pollLive, voters: [], config, state: null, height: null, blockTimeSec: null, names: {}, registry, daoId: 'capapult', idPrefix: 'c' }).expiration.at_time_iso === undefined);
T('no config ⇒ thresholds null, reached null (never invented)', (() => { const x = m._test.mapAnchorPoll({ poll: poll14, voters: [], config: null, state: null, height: null, blockTimeSec: null, names: {}, registry, daoId: 'capapult', idPrefix: 'c' }); return x.voting.quorumThreshold === null && x.voting.quorumReached === null; })());

console.log('===== K2: x/gov mapper =====');
const xp = { id: '4849', messages: [{ '@type': '/cosmos.gov.v1.MsgExecLegacyContent', content: { '@type': '/cosmos.gov.v1beta1.TextProposal', title: 'Signal: remove WBTC from TLA', description: 'd' } }], status: 'PROPOSAL_STATUS_PASSED',
  final_tally_result: { yes_count: '300000000000000', abstain_count: '20000000000000', no_count: '10000000000000', no_with_veto_count: '5000000000000' }, submit_time: '2026-08-01T00:00:00Z', voting_start_time: '2026-08-02T00:00:00Z', voting_end_time: '2026-08-09T00:00:00Z', title: 'Signal: remove WBTC from TLA', summary: 's', proposer: 'terra1abc' };
const params = { quorum: '0.334', threshold: '0.5', veto_threshold: '0.334' };
const x = m._test.mapXGovProposal({ p: xp, tally: null, bonded: '600000000000000', params, registry: {}, daoId: 'terra', idPrefix: 'l' });
T('id l4849, Passed, expiration from voting_end_time (chain time, no estimate flag)', x.id === 'l4849' && x.status === 'Passed' && x.expiration.at_time_iso === '2026-08-09T00:00:00.000Z' && x.expiration.estimated === undefined);
T('tally incl. veto: total 335T of 600T bonded → turnout 55.83% ≥ 33.4', x.votes.total === 335e12 && x.votes.noWithVeto === 5e12 && Math.abs(x.voting.turnout - 55.833) < 0.01 && x.voting.quorumReached === true);
T('threshold base excludes abstain: 300/(300+10+5)=95.24% yes; veto 1.49% < 33.4', Math.abs((x.votes.yes / (x.votes.yes + x.votes.no + x.votes.noWithVeto)) * 100 - 95.238) < 0.01 && x.voting.thresholdReached === true && x.voting.vetoed === false);
T('voters empty with explicit votersNote; messages untrusted by construction', x.voters.length === 0 && /not captured/.test(x.votersNote) && x.decodedActions[0].trusted === false && x.decodedActions[0].type === '/cosmos.gov.v1.MsgExecLegacyContent');
const xl = m._test.mapXGovProposal({ p: { ...xp, id: '4850', status: 'PROPOSAL_STATUS_VOTING_PERIOD', final_tally_result: null }, tally: { yes_count: '1', no_count: '0', abstain_count: '0', no_with_veto_count: '0' }, bonded: '600000000000000', params, registry: {}, daoId: 'terra', idPrefix: 'l' });
T('live x/gov: live:true, Open, pending, uses the /tally result not final_tally_result', xl.live === true && xl.status === 'Open' && xl.outcome === 'pending' && xl.votes.yes === 1);
T('deposit-period proposals are not live', m._test.mapXGovProposal({ p: { ...xp, status: 'PROPOSAL_STATUS_DEPOSIT_PERIOD' }, tally: null, bonded: '1', params, registry: {}, daoId: 'terra', idPrefix: 'l' }).live === false);

console.log('===== K3: one output contract across kinds =====');
const d = m._test.mapProposal({ id: 1, chain: { proposal: { title: 't', status: 'open', votes: { yes: '1', no: '0', abstain: '0' }, total_power: '10', threshold: { threshold_quorum: { threshold: { percent: '0.5' }, quorum: { percent: '0.1' } } }, msgs: [] } }, votes: [], names: {}, registry: {}, daoId: 'x', idPrefix: 'a' });
const must = ['id', 'daoId', 'title', 'description', 'status', 'proposer', 'expiration', 'live', 'votes', 'voting', 'outcome', 'outcomeReason', 'totalPower', 'voters', 'decodedActions', 'treasuryImpact', 'rawMsgs', 'fetchedAt'];
T('anchor-gov and x-gov carry every field the daodao mapper emits', must.every(k => k in a) && must.every(k => k in x) && must.every(k => k in d));
const src = require('fs').readFileSync(__dirname + '/index.js', 'utf8');
T('kind switch: anchor-gov and x-gov branch BEFORE findProposalModule', src.indexOf("kind === 'anchor-gov'") < src.indexOf('const mod = await findProposalModule(registry, dao)') && src.indexOf("kind === 'x-gov'") < src.indexOf('const mod = await findProposalModule(registry, dao)'));
T('daodao output now stamped governanceKind too', /governanceKind: 'daodao'/.test(src));
T('block time is MEASURED from the chain (latest vs latest-1000), not assumed', /blocks\/\$\{h - 1000\}/.test(src) && !/6\.\d+\s*\*\s*1000/.test(src.replace(/mock/g, '')));
// K4 (appended 1.2.0b): veto_timelock arrives as an object — Lion DAO a24 regression.
{
  const v = m._test.mapProposal({ id: 24, chain: { proposal: { title: 'x', status: { veto_timelock: { expiration: { at_time: '1756000000000000000' } } }, votes: { yes: '5', no: '0', abstain: '0' }, total_power: '10', threshold: { threshold_quorum: { threshold: { percent: '0.5' }, quorum: { percent: '0.1' } } }, msgs: [] } }, votes: [], names: {}, registry: {}, daoId: 'liondao', idPrefix: 'a' });
  const ok = v.status === 'Veto Timelock' && v.pending === true && v.live === false && v.outcome === 'pending' && v.vetoLockUntil === '2025-08-24T01:46:40.000Z';
  console.log((ok ? '  ✓ ' : '  ✗ ') + 'veto_timelock object ⇒ status Veto Timelock, pending:true, outcome pending, vetoLockUntil parsed' + (ok ? '' : ' ' + JSON.stringify({ s: v.status, p: v.pending, o: v.outcome, u: v.vetoLockUntil })));
  ok ? pass++ : fail++;
}
console.log(`\n===== KINDS GATE: ${pass}/${pass + fail} =====`);
process.exit(fail ? 1 : 0);
