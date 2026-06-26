// =============================================================================
// dex-data / lib / aggregate.js
// =============================================================================
// The aggregation doctrine, as code. See SPEC-grading-and-dex-data.md.
//
// THE CORE RULE (settled by design before building):
//   - VOLUME is a FLOW  -> aggregate by SUM   (it accumulates over a period;
//     zeros are real "no trades"; the period TOTAL is the truth, an average is
//     only a derived convenience). Averaging a flow / dividing by a fixed
//     "expected" count is WRONG — that was the old cron's /42 bug, which both
//     mis-denominated volume and conceptually misframed a flow as a level.
//   - LIQUIDITY is a STOCK -> aggregate by time-weighted AVERAGE (it exists at
//     every instant; summing it is meaningless). We also carry MIN and a
//     VARIABILITY measure, because an average alone hides risk: a pool that
//     averages deep but briefly drains is more dangerous than a steadily-deep
//     one, and avg-only is gameable by a momentary injection around a snapshot.
//
// GAP HONESTY: every aggregate carries snapshots_used / snapshots_expected /
//   has_gaps. A summed volume with missing chunks UNDERSTATES; we never hide
//   that — a low-coverage aggregate is flagged, not presented as firm. (Validity
//   gate, per platform doctrine.)
// =============================================================================

// Sum a flow (volume). Missing points contribute nothing (they are real zeros
// of "no volume in that bucket"). The TOTAL is the honest number.
function sumFlow(points) {
  let total = 0;
  for (const v of points) {
    const n = Number(v);
    if (Number.isFinite(n)) total += n;
  }
  return total;
}

// Aggregate a stock (liquidity): average over the points that actually exist
// (NOT divided by a fixed expected count — a stock's average is over real
// observations). Also return min and a coefficient-of-variation as a stability
// signal. Empty input -> nulls (we do not fabricate a 0 level).
function aggregateStock(points) {
  const nums = points.map(Number).filter(Number.isFinite);
  if (nums.length === 0) {
    return { avg: null, min: null, max: null, stddev: null, cv: null, n: 0 };
  }
  const n = nums.length;
  const sum = nums.reduce((a, b) => a + b, 0);
  const avg = sum / n;
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const variance = nums.reduce((a, b) => a + (b - avg) * (b - avg), 0) / n;
  const stddev = Math.sqrt(variance);
  // coefficient of variation: stddev / avg — scale-free volatility of the level.
  // Low cv = steady depth (good); high cv = flickering liquidity (riskier).
  const cv = avg > 0 ? stddev / avg : null;
  return { avg, min, max, stddev, cv, n };
}

// Build the data-quality metadata every aggregate must carry. `expected` is how
// many sample points SHOULD exist for the window at the capture cadence; `used`
// is how many we actually have. has_gaps when used < expected.
function coverage(used, expected) {
  const u = Number(used) || 0;
  const e = Number(expected) || 0;
  return {
    snapshots_used: u,
    snapshots_expected: e,
    has_gaps: e > 0 ? u < e : null,
    coverage_pct: e > 0 ? Number((u / e * 100).toFixed(1)) : null,
  };
}

// Capital efficiency: volume (flow) over average liquidity (stock). How hard is
// the liquidity working? High = liquidity is well-used; low = idle depth. Often
// more decision-useful for "more/less incentive?" than either number alone.
function volumeToLiquidity(volumeSum, avgLiquidity) {
  if (avgLiquidity == null || avgLiquidity <= 0 || volumeSum == null) return null;
  return Number((volumeSum / avgLiquidity).toFixed(6));
}

// Full aggregate for one pool over one window, from arrays of per-snapshot
// volume points and liquidity points. This is the canonical shape downstream
// grading reads. `expectedPoints` drives the gap-honesty metadata.
function aggregateWindow({ volumePoints = [], liquidityPoints = [], expectedPoints = 0 }) {
  const volume_total = sumFlow(volumePoints);
  const liq = aggregateStock(liquidityPoints);
  // Coverage is judged against the liquidity series (a continuous stock should
  // have a point per snapshot); volume buckets can legitimately be 0.
  const cov = coverage(liq.n, expectedPoints);
  return {
    // VOLUME — the flow, summed (the truth for the window)
    volume_total,
    // LIQUIDITY — the stock, averaged + risk shape
    liquidity_avg: liq.avg,
    liquidity_min: liq.min,
    liquidity_max: liq.max,
    liquidity_stddev: liq.stddev,
    liquidity_cv: liq.cv,
    // DERIVED — capital efficiency
    volume_to_liquidity: volumeToLiquidity(volume_total, liq.avg),
    // HONESTY — coverage metadata; consumers must check has_gaps before trusting
    ...cov,
  };
}

// ---------------------------------------------------------------------------
// Notable-window detection (neutral observation, NOT a "problem" flag).
// Records intra-window concentration so a later forensics pass (wallet
// attribution via block-range tx search) can find the moments worth
// investigating — without judging them here. A concentration can be wash,
// a healthy whale trade, or a busy hour; capture neutrally, judge later.
// ---------------------------------------------------------------------------
// buckets: [{ t (ISO or unix), volume }]. thresholdPct: a bucket whose volume
// is >= this share of the window total is recorded as a notable concentration.
function notableWindows(buckets, thresholdPct = 10) {
  const valid = (buckets || [])
    .map(b => ({ t: b.t, volume: Number(b.volume) }))
    .filter(b => Number.isFinite(b.volume) && b.volume > 0);
  const total = valid.reduce((a, b) => a + b.volume, 0);
  if (total <= 0) return [];
  const out = [];
  for (const b of valid) {
    const pct = b.volume / total * 100;
    if (pct >= thresholdPct) {
      out.push({
        t: b.t,
        volume: b.volume,
        pct_of_window: Number(pct.toFixed(1)),
        // neutral: we record WHAT we saw, not a verdict. Forensics (wallet
        // attribution) decides later if this is wash / whale / organic.
        observation: 'volume_concentration',
      });
    }
  }
  // most-concentrated first
  return out.sort((a, b) => b.pct_of_window - a.pct_of_window);
}

module.exports = {
  sumFlow,
  aggregateStock,
  coverage,
  volumeToLiquidity,
  aggregateWindow,
  notableWindows,
};
