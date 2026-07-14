// =============================================================================
// member-data / index.js  — orchestrator
// =============================================================================
// The VP layer (Option A): owns the COMPLETE voting-power picture.
//
//   1. TOTAL AVAILABLE VP   — walk the CW721 lock enumeration (held VP).
//   2. VP VOTING PER BUCKET  — aggregate each wallet's allocation per bucket.
//   3. PER-WALLET EFFICIENCY — influence (% of an LP's votes) + utilization
//      (deployed vs IDLE VP — the "leaving VP / bribes on the table" signal).
//
// Walks the lock enumeration ONCE and queries user_info per wallet ONCE, then
// produces all views — replacing the old system's 4 crons that each re-walked
// the same enumeration (~858 chain calls x4). Every wallet treated equally
// (aDAO is just one member).
//
// Bribes / vAPR are deliberately NOT here — they layer on top via `flows`,
// joined using the influence numbers this cron produces. (Boundary: VP held +
// directed = member-data; bribe economics = flows.)
//
// Output (tla-core), member-data module:
//   member-data/snapshots/current.json     full: system totals + every wallet
//   member-data/snapshots/holders.json      light: address + vp + utilization
//   member-data/snapshots/daily/<date>.json forward-only daily archive
//   member-data/snapshots/heartbeat.json    freshness signal
// =============================================================================

const { queryContract, parallelMap, enumerateAllTokens, fetchJson, pushToGithub, GITHUB_REPO } = require('./lib/chain');
const { parseWalletVoting, aggregateBucketVoting, computeInfluence } = require('./lib/vp');

// SINGLE SOURCE OF TRUTH: structural contract addresses + bucket names come from
// the shared config. Fix an address there once and every cron is fixed. (Same
// `require('../config/contracts.js')` pattern the other org crons use.)
const C = require('../config/contracts.js');
const TLA_GAUGE_CONTROLLER = C.GAUGE_CONTROLLER.addr;
const TLA_VOTING_ESCROW    = C.VOTING_ESCROW.addr;

const VERSION = 'member-data-1.1.0';  // 1.1.0 (2026-07-14): SPEC-vp-definition-fix — VP = boost+fixed everywhere; canonical total = total_vamp.vp

const BATCH_CONCURRENCY = 5;  // safe for publicnode LCD (matches proven crons)

const TLA_EPOCH_START_MS = Date.parse('2022-10-31T00:00:00Z');
const EPOCH_MS = 7 * 24 * 60 * 60 * 1000;
const currentEpoch = () => Math.floor((Date.now() - TLA_EPOCH_START_MS) / EPOCH_MS) + 1;
const todayUtc = () => new Date().toISOString().slice(0, 10);

// Pool-name lookup from token-catalog (reuse, don't re-query). gauge_pool_id -> name.
async function buildPoolNameMap() {
  const map = new Map();
  try {
    const tc = await fetchJson(
      `https://raw.githubusercontent.com/${GITHUB_REPO}/main/token-catalog/snapshots/current.json?t=${Date.now()}`,
      'token-catalog'
    );
    for (const p of (tc.pools || [])) {
      const gid = p.gauge_pool_id;
      if (gid) map.set(gid, p.name || p.pool_name || null);
    }
  } catch (e) {
    // Non-fatal: names just stay null; VP math is unaffected.
    console.warn('  ⚠ could not load token-catalog pool names (non-fatal):', e.message);
  }
  return map;
}

async function run() {
  const started = new Date();
  console.log(`${VERSION} — VP layer census`);
  const errors = [];

  // 1) Enumerate all lock NFTs (held VP source) + pool names + the escrow's
  //    own system total (SPEC-vp-definition-fix: total_vamp.vp = fixed +
  //    voting_power is the CANONICAL Total TLA VP — matches the TLA UI header).
  const [{ tokens: tokenIds, incomplete }, poolNames, totalVamp] = await Promise.all([
    enumerateAllTokens(TLA_VOTING_ESCROW),
    buildPoolNameMap(),
    queryContract(TLA_VOTING_ESCROW, { total_vamp: {} }),
  ]);
  if (!totalVamp) errors.push('total_vamp query failed — canonical total missing this run');
  if (incomplete) errors.push('lock enumeration incomplete (a page query failed) — census is PARTIAL');
  console.log(`  locks enumerated: ${tokenIds.length}${incomplete ? ' (INCOMPLETE)' : ''}`);

  // 2) For each lock: owner + lock_info (held VP per lock). Aggregate per wallet.
  const lockRecords = await parallelMap(tokenIds, async (tid) => {
    const [ownerR, lockR] = await Promise.all([
      queryContract(TLA_VOTING_ESCROW, { owner_of: { token_id: tid } }),
      queryContract(TLA_VOTING_ESCROW, { lock_info: { token_id: tid, time: 'next' } }),
    ]);
    return { token_id: tid, owner: ownerR?.owner || null, lock: lockR || null };
  }, BATCH_CONCURRENCY);

  const walletSet = new Set();
  const locksByWallet = new Map();
  let lockErrors = 0;
  for (const r of lockRecords) {
    if (!r || r._error || !r.owner) { lockErrors++; continue; }
    walletSet.add(r.owner);
    if (!locksByWallet.has(r.owner)) locksByWallet.set(r.owner, []);
    locksByWallet.get(r.owner).push({
      token_id: r.token_id,
      // SPEC-vp-definition-fix (2026-07-13): vp is TOTAL = boost + fixed,
      // matching the held-VP definition it cross-checks against.
      vp_boost_raw: r.lock?.voting_power || '0',
      vp_fixed_raw: r.lock?.fixed_amount || '0',
      vp_human: ((parseFloat(r.lock?.voting_power) || 0) + (parseFloat(r.lock?.fixed_amount) || 0)) / 1e6,
      end_period: r.lock?.end?.period ?? null,
      coefficient: r.lock?.coefficient ? Number(r.lock.coefficient) : null,
      asset: r.lock?.asset || null,
    });
  }
  if (lockErrors) errors.push(`${lockErrors} lock owner/info fetch errors`);
  const wallets = [...walletSet];
  console.log(`  unique wallets (lock holders): ${wallets.length}`);

  // 3) Per wallet: user_info from gauge controller (DIRECTED VP allocation).
  console.log(`  querying user_info for ${wallets.length} wallets...`);
  const userInfos = await parallelMap(wallets, async (wallet) => {
    const ui = await queryContract(TLA_GAUGE_CONTROLLER, { user_info: { user: wallet, time: 'next' } });
    return { wallet, userInfo: ui };
  }, BATCH_CONCURRENCY);

  // 4) Parse each wallet's voting (held + directed + utilization).
  const walletVotings = [];
  let uiErrors = 0;
  const votingByWallet = new Map();
  for (const r of userInfos) {
    if (!r || r._error) { uiErrors++; continue; }
    const v = parseWalletVoting(r.userInfo, poolNames);
    v.address = r.wallet;
    // attach held-from-locks (cross-check vs userInfo boost+fixed total —
    // both sides total-basis per SPEC-vp-definition-fix)
    const locks = locksByWallet.get(r.wallet) || [];
    v.lock_count = locks.length;
    v.vp_from_locks_human = locks.reduce((s, l) => s + l.vp_human, 0);
    walletVotings.push(v);
    votingByWallet.set(r.wallet, v);
  }
  if (uiErrors) errors.push(`${uiErrors} user_info fetch errors`);

  // 5) METRIC 1 & 2: system aggregates (available VP, per-bucket voting, canonical total).
  const agg = aggregateBucketVoting(walletVotings);

  // 6) METRIC 3: per-wallet influence (needs the pool totals from agg).
  for (const v of walletVotings) {
    v.influence = computeInfluence(v, agg.vp_per_pool_per_bucket);
  }

  // rank by VP held
  walletVotings.sort((a, b) => (b.total_vp_held_human || 0) - (a.total_vp_held_human || 0));
  walletVotings.forEach((v, i) => { v.rank = i + 1; });

  const status = (incomplete || lockErrors > 0 || uiErrors > 0) ? 'partial' : 'ok';

  // ---- outputs ----
  const meta = {
    version: VERSION,
    generated_at: started.toISOString(),
    epoch: currentEpoch(),
    status,
    errors: errors.length ? errors : null,
    wallet_count: walletVotings.length,
    lock_count: tokenIds.length,
  };

  const current = {
    meta,
    system: {
      // METRIC 1 — canonical Total TLA VP = escrow total_vamp (fixed + boost).
      // SPEC-vp-definition-fix (2026-07-13): matches the TLA UI "Total Voting
      // Power" header; retires the old max-bucket convention.
      total_tla_vp: totalVamp ? {
        fixed: parseFloat(totalVamp.fixed) || 0,
        voting_power: parseFloat(totalVamp.voting_power) || 0,
        vp: parseFloat(totalVamp.vp) || 0,
        vp_human: (parseFloat(totalVamp.vp) || 0) / 1e6,
      } : null,
      max_bucket_vp_reference: agg.max_bucket_vp,  // lower-bound sanity check
      total_vp_held_all_wallets: Number(walletVotings.reduce((s, v) => s + (v.total_vp_held_human || 0), 0).toFixed(2)),
      // METRIC 2: VP voting per bucket
      vp_voting_per_bucket: agg.vp_voting_per_bucket,
    },
    // METRIC 3: per-wallet — held, directed, utilization, influence
    wallets: walletVotings,
  };

  const holders = {
    meta,
    holders: walletVotings.map(v => ({
      rank: v.rank,
      address: v.address,
      vp_held: v.total_vp_held_human,
      avg_utilization_pct: v.avg_utilization_pct,
      unvoted_buckets: v.unvoted_buckets,
      fully_utilized: v.fully_utilized,
    })),
  };

  const date = todayUtc();
  const ok1 = await pushToGithub('member-data/snapshots/current.json', current, `member-data: census ${date}`);
  const ok2 = await pushToGithub('member-data/snapshots/holders.json', holders, `member-data: holders ${date}`);
  const ok3 = await pushToGithub(`member-data/snapshots/daily/${date}.json`, current, `member-data: daily ${date}`);
  const ok4 = await pushToGithub('member-data/snapshots/heartbeat.json', {
    version: VERSION, generated_at: started.toISOString(), epoch: currentEpoch(),
    status, wallet_count: walletVotings.length, lock_count: tokenIds.length,
    total_tla_vp_human: totalVamp ? (parseFloat(totalVamp.vp) || 0) / 1e6 : null,
    max_bucket_vp_reference: agg.max_bucket_vp,
  }, `member-data: heartbeat ${date}`);

  console.log(`  outputs: ${[ok1, ok2, ok3, ok4].filter(Boolean).length}/4 written`);
  console.log(`  canonical Total TLA VP (total_vamp.vp): ${totalVamp ? ((parseFloat(totalVamp.vp)||0)/1e6).toLocaleString() : 'MISSING'} | max-bucket ref: ${agg.max_bucket_vp.toLocaleString()}`);
  console.log(`  VP voting per bucket:`, agg.vp_voting_per_bucket);
  console.log(`  status: ${status}`);
  if (status !== 'ok' && !ok1) process.exit(1);
}

run().catch((e) => { console.error('fatal:', e); process.exit(1); });
