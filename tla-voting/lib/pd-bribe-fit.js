'use strict';
// tla-voting/lib/pd-bribe-fit.js — v1.0 (2026-08-25, SPEC-lp-grades-v2 §4)
// "What they said, what they did, what changed." For every verified PD placement
// batch: PD's per-pool allocation beside every active Astroport TLA pool's rank on
// PD's OWN stated criterion (trading efficiency = volume ÷ liquidity, and volume) at
// the placement epoch and at every epoch of the paid window; the pools that
// qualified and were not bribed; the VP and payout share each bribed pool actually
// carried per epoch. Descriptive only: the product never says "should".
// Sources (all committed): pd-bribes/current.json (legs, windows), dex-data
// astroport weekly-avg CSVs (liquidity, volume per epoch), tla-snapshot
// pool-status-history (VP per epoch), distributions/history (payout share).
// Laws: placement-time numbers are the record as captured then; a pool missing
// from a series is `null` / "not in series", never reconstructed.

function parseCsv(txt) {
    const lines = String(txt || '').trim().split('\n'); if (lines.length < 2) return [];
    const split = (l) => { const o = []; let c = '', q = false; for (const ch of l) { if (ch === '"') q = !q; else if (ch === ',' && !q) { o.push(c); c = ''; } else c += ch; } o.push(c); return o; };
    const h = split(lines[0]); return lines.slice(1).map(l => Object.fromEntries(split(l).map((v, i) => [h[i], v])));
}

// weekly-avg rows → universe for one epoch: { poolName: { liq, vol, eff, bucket, dex } } (liq > $1K, not deprecated)
function universeFromWeekly(rows) {
    const u = {};
    for (const r of rows || []) {
        if (String(r.deprecated) === 'true') continue;
        const liq = Number(r.avg_liquidity_usd || 0), vol = Number(r.total_volume_usd || 0);
        if (!(liq > 1000)) continue;
        u[r.pool_name] = { liq, vol, eff: vol / liq, bucket: (r.bucket || '').toLowerCase(), dex: r.dex || 'astroport', pool_address: r.pool_address || null };
    }
    return u;
}
const rankBy = (u, key) => { const ks = Object.keys(u).sort((a, b) => u[b][key] - u[a][key]); return Object.fromEntries(ks.map((k, i) => [k, i + 1])); };

/**
 * buildPdFit
 * @param placements  pd-bribes/current.json .placements (verified)
 * @param weeklyByEpoch  { epoch: universe } from universeFromWeekly
 * @param poolStatus  pool-status-history.json (pools[].gauge_pool_id, epochs{E:{vp_human,bucket_pct,status}})
 * @param distributions  distributions/history.json .entries (period, gauges[].assets[] {asset, distribution, total_vp})
 * @param nameOf  { gauge_pool_id: { name, bucket } }
 * @param currentEpoch  number
 */
function buildPdFit({ placements, weeklyByEpoch, poolStatus, distributions, nameOf, currentEpoch }) {
    const vpByGauge = {}; for (const p of (poolStatus && poolStatus.pools) || []) vpByGauge[p.gauge_pool_id] = p.epochs || {};
    const payout = {};   // `${period}|${gauge}|${bareId}` → distribution fraction
    for (const e of (distributions || [])) for (const g of e.gauges || []) for (const a of g.assets || []) { const id = a.asset && (a.asset.cw20 || a.asset.native); if (id) payout[`${e.period}|${g.gauge}|${id}`] = Number(a.distribution); }
    const batches = [];
    for (const pl of placements || []) {
        const legsIn = pl.legs || []; if (!legsIn.length) continue;
        const start = Math.min(...legsIn.map(l => l.start)), end = Math.max(...legsIn.map(l => l.end));
        const ref = start - 1;                                  // the epoch PD could have measured when it placed
        const u0 = weeklyByEpoch[ref] || null;
        const rEff0 = u0 ? rankBy(u0, 'eff') : {}, rVol0 = u0 ? rankBy(u0, 'vol') : {};
        // aggregate legs by gauge id (a batch can carry two legs on one gauge)
        const byGauge = {};
        for (const l of legsIn) { const k = l.pool_gauge_id; const b = byGauge[k] || (byGauge[k] = { gauge_pool_id: k, gauge: l.gauge, luna_per_epoch: 0, luna_total: 0, start: l.start, end: l.end }); b.luna_per_epoch += Number(l.per_epoch_display || 0); b.luna_total += Number(l.net_display || 0); }
        const total = Object.values(byGauge).reduce((s, b) => s + b.luna_per_epoch, 0) || 1;
        const legs = Object.values(byGauge).map(b => {
            const nm = (nameOf[b.gauge_pool_id] && nameOf[b.gauge_pool_id].name) || null; const bare = b.gauge_pool_id.replace(/^(cw20|native):/, '');
            const inU = !!(nm && u0 && u0[nm]);
            const effByEpoch = {}, rankByEpoch = {}, volByEpoch = {}, vpByEpoch = {}, pctByEpoch = {}, payoutByEpoch = {};
            for (let e = ref; e <= end; e++) {
                const u = weeklyByEpoch[e]; if (u && nm && u[nm]) { effByEpoch[e] = u[nm].eff; volByEpoch[e] = u[nm].vol; rankByEpoch[e] = rankBy(u, 'eff')[nm]; } else { effByEpoch[e] = null; volByEpoch[e] = null; rankByEpoch[e] = null; }
                const v = vpByGauge[b.gauge_pool_id] && vpByGauge[b.gauge_pool_id][String(e)]; vpByEpoch[e] = v ? v.vp_human : null; pctByEpoch[e] = v ? v.bucket_pct : null;
                const py = payout[`${e}|${b.gauge}|${bare}`]; payoutByEpoch[e] = py == null ? null : py;
            }
            return { pool: nm || bare.slice(0, 14) + '…', gauge_pool_id: b.gauge_pool_id, gauge: b.gauge, in_universe: inU, luna_per_epoch: b.luna_per_epoch, luna_total: b.luna_total, share_pct: b.luna_per_epoch / total * 100,
                at_placement: inU ? { epoch: ref, eff: u0[nm].eff, vol: u0[nm].vol, liq: u0[nm].liq, rank_eff: rEff0[nm], rank_vol: rVol0[nm], of: Object.keys(u0).length } : null,
                by_epoch: { eff: effByEpoch, eff_rank: rankByEpoch, vol: volByEpoch, vp_human: vpByEpoch, bucket_pct: pctByEpoch, payout_share: payoutByEpoch } };
        }).sort((a, b) => b.luna_per_epoch - a.luna_per_epoch);
        const bribedNames = new Set(legs.map(l => l.pool));
        const n = legs.length;
        const topN0 = u0 ? Object.keys(rEff0).filter(k => rEff0[k] <= n) : [];
        const uEnd = weeklyByEpoch[Math.min(end, currentEpoch)] || null; const rEffEnd = uEnd ? rankBy(uEnd, 'eff') : {};
        const topNEnd = uEnd ? Object.keys(rEffEnd).filter(k => rEffEnd[k] <= n) : [];
        const half = u0 ? Math.floor(Object.keys(u0).length / 2) : null;
        const toTopHalf = u0 ? legs.filter(l => l.in_universe && rEff0[l.pool] <= half).reduce((s, l) => s + l.luna_per_epoch, 0) / total * 100 : null;
        batches.push({
            proposal_id: pl.proposal_id, title: pl.title || null, executed_at: pl.executed_at || null,
            stated_criterion: /efficiency|volume/i.test(pl.title || '') ? (pl.title.match(/based on (.+)$/i) || [null, pl.title])[1] : null,
            window: { start, end, reference_epoch: ref, epochs: end - start + 1 }, luna_per_epoch_total: total, pools_bribed: n,
            universe_at_placement: u0 ? Object.entries(u0).map(([k, v]) => ({ pool: k, bucket: v.bucket, dex: v.dex, vol: v.vol, liq: v.liq, eff: v.eff, rank_eff: rEff0[k], rank_vol: rVol0[k], bribed: bribedNames.has(k) })).sort((a, b) => a.rank_eff - b.rank_eff) : null,
            legs,
            qualified_not_bribed_at_placement: topN0.filter(k => !bribedNames.has(k)),
            qualified_not_bribed_at_window_end: topNEnd.filter(k => !bribedNames.has(k)),
            share_to_top_half_by_efficiency_pct: toTopHalf,
            notes: [u0 ? null : `no weekly-avg series for E${ref} (placement predates capture) — fit not computed`, legs.some(l => !l.in_universe) ? `pools outside the Astroport weekly series (SS / single / Credia) are shown with their LUNA but no rank: ${legs.filter(l => !l.in_universe).map(l => l.pool).join(', ')}` : null].filter(Boolean),
        });
    }
    return batches.sort((a, b) => a.proposal_id - b.proposal_id);
}

async function runPdFit({ fetchJson, fetchText, publishFile, apiGetJsonMaybe, version = 'pd-bribe-fit-1.0', now = new Date() }) {
    const B = 'https://raw.githubusercontent.com/thealliancedao/tla-core/main';
    const t = Date.now();
    const [pd, ps, dist, snap] = await Promise.all([fetchJson(`${B}/tla-voting/pd-bribes/current.json?t=${t}`), fetchJson(`${B}/member-data/tla-snapshot/pool-status-history.json?t=${t}`), fetchJson(`${B}/tla-voting/distributions/history.json?t=${t}`), fetchJson(`${B}/member-data/tla-snapshot/current.json?t=${t}`)]);
    if (!pd || !ps || !snap) throw new Error('pd-bribe-fit: a source product is unreadable (abort)');
    const nameOf = {}; for (const p of snap.pools || []) if (p.gauge_pool_id) nameOf[p.gauge_pool_id] = { name: p.name, bucket: p.bucket };
    const currentEpoch = Math.max(...(ps.epochs || [0]));
    const placements = (pd.placements || []).filter(p => (p.legs || []).length);
    const minE = Math.min(...placements.map(p => Math.min(...p.legs.map(l => l.start)))) - 1, maxE = currentEpoch;
    const weeklyByEpoch = {}; let read = 0;
    for (let e = Math.max(minE, 150); e <= maxE; e++) { const txt = await fetchText(`${B}/dex-data/astroport/weekly-avg/2026-epoch-${e}.csv?t=${t}`).catch(() => null); if (txt) { weeklyByEpoch[e] = universeFromWeekly(parseCsv(txt)); read++; } }
    const batches = buildPdFit({ placements, weeklyByEpoch, poolStatus: ps, distributions: (dist && dist.entries) || [], nameOf, currentEpoch });
    const product = { version, generated_at: now.toISOString(), epoch_current: currentEpoch, weekly_epochs_read: read,
        method: 'For each verified PD placement batch: allocation per gauge (LUNA/epoch) beside every active Astroport TLA pool\'s rank by trading efficiency (volume ÷ liquidity, weekly-avg) and by volume at the epoch before the window, and per epoch through the window; pools that ranked in the top-N (N = pools bribed) and were not bribed; VP, bucket share and payout share per epoch for each bribed gauge. Pools outside the Astroport weekly series carry no rank (SS / single / Credia).',
        stated_criterion_source: 'PD proposal titles as executed on chain (e.g. "[tla] Adding vote incentives based on trading efficiency + volume")',
        batches };
    await publishFile('tla-voting/pd-bribes/fit/current.json', product, `pd-bribe-fit: ${batches.length} batches, epochs to ${currentEpoch}`);
    let written = 0;
    for (const b of batches) { const closed = b.window.end < currentEpoch; const p = `tla-voting/pd-bribes/fit/batches/${b.proposal_id}.json`; if (closed && apiGetJsonMaybe && await apiGetJsonMaybe(p)) continue; await publishFile(p, { version, generated_at: now.toISOString(), closed, ...b }, `pd-bribe-fit batch ${b.proposal_id}${closed ? ' (closed, write-once)' : ' (open)'}`); written++; }
    return { batches: batches.length, written, weekly_epochs_read: read };
}

module.exports = { buildPdFit, runPdFit, universeFromWeekly, parseCsv, rankBy };
