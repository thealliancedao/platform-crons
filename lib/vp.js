// =============================================================================
// member-data / lib / vp.js
// =============================================================================
// The VP-efficiency doctrine, as code. Computes the three metrics:
//
//   1. TOTAL AVAILABLE VP  — all VP held in TLA locks (the system ceiling).
//   2. VP VOTING PER BUCKET — how much VP is actually cast into each of the 4
//      buckets (NOT an even split of the total — voters allocate unevenly, and
//      some VP sits idle, so each bucket's voting total is its own number).
//   3. PER-WALLET EFFICIENCY — for each wallet:
//      - influence: its vote on an LP as a share of that LP's total votes
//      - utilization: how much of its available VP is actually deployed vs IDLE
//
// KEY CONCEPTS (from the Eris voting model + ecosystem-knowledge):
//   - A wallet's total VP (userInfo.voting_power) is what it CAN direct.
//   - gauge_votes[] gives its allocation per bucket: votes = [[poolKey, bps]].
//     Weights are basis points; 10000 bps = 100% of that bucket's vote slot.
//   - In TLA, a wallet votes PER BUCKET — it can allocate up to 100% (10000 bps)
//     within EACH bucket independently. So "fully utilized" = voting 10000 bps
//     in every bucket it chooses to participate in.
//   - IDLE VP: a bucket the wallet hasn't voted in at all, or bps summing under
//     10000 within a bucket = VP left on the table (could earn bribes/direct
//     rewards but isn't).
//   - CANONICAL total VP = max bucket VP (pool-summing 4x-inflates because each
//     wallet's VP allocates once per bucket). See ecosystem-knowledge tla.vp_canonical.
// =============================================================================

const BUCKETS = ['stable', 'project', 'bluechip', 'single'];
const FULL_BPS = 10000;

// Parse one wallet's userInfo (gauge_controller) into a normalized voting shape.
// Returns held VP + per-bucket allocations with utilization.
function parseWalletVoting(userInfo, poolNameByGaugeId = new Map()) {
  const totalVpHuman = (parseFloat(userInfo?.voting_power) || 0) / 1e6;
  const fixedAmountHuman = (parseFloat(userInfo?.fixed_amount) || 0) / 1e6;

  // per-bucket allocation
  const buckets = {};
  const gaugeVotes = Array.isArray(userInfo?.gauge_votes) ? userInfo.gauge_votes : [];
  const votedBuckets = new Set();

  for (const gv of gaugeVotes) {
    const bucket = gv.gauge;
    votedBuckets.add(bucket);
    const votes = Array.isArray(gv.votes) ? gv.votes : [];
    let bpsSum = 0;
    const allocations = votes.map(([poolKey, weightBps]) => {
      const bps = Number(weightBps) || 0;
      bpsSum += bps;
      return {
        pool_gauge_id: poolKey,
        pool_name: poolNameByGaugeId.get(poolKey) || null,
        weight_bps: bps,
        weight_pct: bps / 100, // bps -> %
      };
    });
    // Within-bucket utilization: did they allocate the full 10000 bps?
    const utilizationPct = (bpsSum / FULL_BPS) * 100;
    buckets[bucket] = {
      period: gv.period ?? null,
      allocations,
      total_bps: bpsSum,
      utilization_pct: Number(utilizationPct.toFixed(2)), // 100 = fully used this bucket
      idle_bps: Math.max(0, FULL_BPS - bpsSum),           // unallocated weight in this bucket
    };
  }

  // Buckets the wallet did NOT vote in at all = fully idle for that bucket.
  const unvotedBuckets = BUCKETS.filter(b => !votedBuckets.has(b));

  // Overall utilization: of the 4 buckets, how many are fully used? And a simple
  // aggregate — average utilization across the 4 buckets (an unvoted bucket = 0%).
  const perBucketUtil = BUCKETS.map(b => buckets[b]?.utilization_pct ?? 0);
  const avgUtilizationPct = Number((perBucketUtil.reduce((a, c) => a + c, 0) / BUCKETS.length).toFixed(2));

  return {
    total_vp_held_human: totalVpHuman,   // what this wallet CAN direct
    fixed_amount_human: fixedAmountHuman,
    buckets,                             // per-bucket allocation + utilization
    unvoted_buckets: unvotedBuckets,     // buckets with zero allocation (idle)
    avg_utilization_pct: avgUtilizationPct, // headline: how fully is VP deployed across all 4 buckets
    fully_utilized: unvotedBuckets.length === 0 && BUCKETS.every(b => (buckets[b]?.total_bps ?? 0) >= FULL_BPS),
  };
}

// METRIC 2: VP voting per bucket — aggregate across all wallets. Each wallet's
// held VP contributes to a bucket proportional to the bps it allocated there.
// (A wallet with 1M VP voting 5000 bps in stable contributes 0.5M to stable's
// voting total.) Buckets summed independently; the MAX bucket is the canonical
// total available VP reference.
function aggregateBucketVoting(walletVotings) {
  const bucketVp = Object.fromEntries(BUCKETS.map(b => [b, 0]));
  const bucketPoolVp = {}; // bucket -> { poolGaugeId -> vp }
  for (const b of BUCKETS) bucketPoolVp[b] = {};

  let totalHeld = 0;
  for (const w of walletVotings) {
    totalHeld += w.total_vp_held_human || 0;
    for (const b of BUCKETS) {
      const bd = w.buckets[b];
      if (!bd) continue;
      for (const a of bd.allocations) {
        // VP this wallet directs at this pool in this bucket = held * (bps/10000)
        const vpToPool = (w.total_vp_held_human || 0) * (a.weight_bps / FULL_BPS);
        bucketVp[b] += vpToPool;
        bucketPoolVp[b][a.pool_gauge_id] = (bucketPoolVp[b][a.pool_gauge_id] || 0) + vpToPool;
      }
    }
  }

  const maxBucket = Math.max(...BUCKETS.map(b => bucketVp[b]));
  return {
    vp_voting_per_bucket: Object.fromEntries(BUCKETS.map(b => [b, Number(bucketVp[b].toFixed(2))])),
    vp_per_pool_per_bucket: bucketPoolVp, // for influence-% denominators
    canonical_total_vp: Number(maxBucket.toFixed(2)), // max bucket = canonical Total TLA VP
  };
}

// METRIC 3a: influence — a wallet's vote on an LP as a share of that LP's total
// votes. Needs the wallet's vp-to-pool and the pool's total (from aggregate).
function computeInfluence(walletVoting, bucketPoolVp) {
  const out = {};
  for (const b of BUCKETS) {
    const bd = walletVoting.buckets[b];
    if (!bd) continue;
    out[b] = bd.allocations.map(a => {
      const walletVpToPool = (walletVoting.total_vp_held_human || 0) * (a.weight_bps / FULL_BPS);
      const poolTotalVp = bucketPoolVp[b]?.[a.pool_gauge_id] || 0;
      return {
        pool_gauge_id: a.pool_gauge_id,
        pool_name: a.pool_name,
        wallet_vp_to_pool: Number(walletVpToPool.toFixed(2)),
        pool_total_vp: Number(poolTotalVp.toFixed(2)),
        // influence: this wallet's share of all votes on this LP
        influence_pct: poolTotalVp > 0 ? Number((walletVpToPool / poolTotalVp * 100).toFixed(3)) : null,
      };
    });
  }
  return out;
}

module.exports = {
  BUCKETS, FULL_BPS,
  parseWalletVoting, aggregateBucketVoting, computeInfluence,
};
