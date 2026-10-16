// =============================================================================
// lp-grades / vp-holders.js — who holds the TLA vote, in aggregate (1.0.0, 2026-10-16)
// =============================================================================
// The scorecard says which pools earn support; this says who supplies it. From the complete electorate (member-data/participants:
// every lock owner, enumerated from the escrow), the address catalog's NAMED entities (DAOs, treasuries, protocols) and Votion's
// vault snapshot, it publishes lp-grades/scorecard/holders.json:
//   • by_group × activity — voting power of Votion vaults / named entities / individual wallets that provide TLA liquidity / individual
//     wallets that do not, split by how they vote: active (changed votes in the last 4 epochs) · set-and-forget (votes allocated, last
//     changed earlier — they still count) · not voting (VP with no allocation)
//   • by_entity — each named entity's VP (individual wallets only as one total)
//   • concentration — top 1 / 5 / 10 wallets' share and how many wallets make 50% / 80% (counts, no addresses)
//   • votion — who holds Votion's vaults (and so the VP they vote): named entities by label, everyone else as one total
// PUBLIC + §8b: only named entities (catalog `entities`, public organisations) appear by name; individuals appear only as totals and
// counts. No individual address is written. Descriptive only. 1.1.0: hidden organisations (config) count as individuals; concentration tiers + size bands.
'use strict';

const ACTIVE_EPOCHS = 4;

function build({ participants, catalog, votionSnap, votionVaults, epoch, hide, verified }) {
  // 1.1.0 (owner 2026-10-16): organisations we know but do not name here (Fuel, Galactic Mining Club) count as individual wallets
  const HIDE = new Set(hide || ['Fuel', 'Galactic Mining Club']);
  const members = (participants && participants.members) || [];
  const ent = (catalog && catalog.entities) || {};
  const vaultSet = new Set(((votionVaults && votionVaults.vaults) || []).map(v => v.address).filter(Boolean));
  const vaultLabel = {}; for (const v of (votionVaults && votionVaults.vaults) || []) vaultLabel[v.address] = v.label;
  const E = Number((participants && participants.epoch && participants.epoch.number) || epoch || 0);
  const named0 = (a) => ent[a] ? { label: ent[a].label, protocol: (ent[a].protocol === 'TLA' ? 'aDAO' : ent[a].protocol) || ent[a].label, subtype: ent[a].subtype || null } : null;   // the catalog files aDAO's own wallets under protocol 'TLA'
  // 1.2.0: contracts proven on chain to be controlled by an organisation (docs/curated/entity-verify: the contract's admin IS that
  // organisation's DAO) are named for it — e.g. a sub-DAO of the Phoenix Directive that holds Votion vault tokens.
  const VER = {}; for (const c of ((verified && verified.checks) || [])) if (c && c.admin_matches && c.address && c.org) VER[c.address] = { label: (c.dao_name ? '"' + c.dao_name + '" ' : '') + 'sub-DAO (admin: ' + c.org + ' DAO)', protocol: c.org, subtype: 'sub-dao' };
  const named = (a) => { if (VER[a]) return VER[a]; const n = named0(a); return n && !HIDE.has(n.protocol) && !HIDE.has(n.label) ? n : null; };

  const GROUPS = [['votion', 'Votion vaults'], ['entity', 'Named DAOs & protocols'], ['ind_lp', 'Individual wallets — provide TLA liquidity'], ['ind', 'Individual wallets — no TLA liquidity']];
  const ACTS = [['active', 'Active (votes changed in the last ' + ACTIVE_EPOCHS + ' epochs)'], ['set', 'Set-and-forget (votes still count, last changed earlier)'], ['none', 'Not voting (no votes allocated)']];
  const cell = {}; for (const [g] of GROUPS) { cell[g] = {}; for (const [a] of ACTS) cell[g][a] = { wallets: 0, vp: 0 }; }
  const byEntity = {}; const vps = []; let total = 0, wallets = 0;

  for (const m of members) {
    const vp = Number((m.summary && m.summary.voting_power_human) || 0); if (!(vp > 0)) continue;
    wallets++; total += vp; vps.push(vp);
    const vb = (m.voting && m.voting.votes_per_bucket) || {};
    const ps = Object.values(vb).filter(b => b && Array.isArray(b.votes) && b.votes.length).map(b => Number(b.period)).filter(Number.isFinite);
    const act = !ps.length ? 'none' : (Math.max(...ps) >= E - ACTIVE_EPOCHS + 1 ? 'active' : 'set');
    const n = named(m.wallet);
    const lp = Number((m.summary && m.summary.total_lp_position_usd) || 0) > 1;
    const g = vaultSet.has(m.wallet) ? 'votion' : n ? 'entity' : lp ? 'ind_lp' : 'ind';
    cell[g][act].wallets++; cell[g][act].vp += vp;
    const ek = vaultSet.has(m.wallet) ? 'Votion' : n ? n.protocol : null;
    if (ek) { const e = byEntity[ek] = byEntity[ek] || { entity: ek, vp: 0, wallets: 0, labels: [] }; e.vp += vp; e.wallets++; const lab = vaultSet.has(m.wallet) ? 'vault ' + (vaultLabel[m.wallet] || '') : n.label; if (!e.labels.includes(lab)) e.labels.push(lab); }
  }
  const pct = (x) => total ? Math.round(x / total * 10000) / 100 : null; const r2 = (x) => Math.round(x * 100) / 100;
  const by_group = GROUPS.map(([g, label]) => ({ group: g, label, wallets: ACTS.reduce((s, [a]) => s + cell[g][a].wallets, 0), vp: r2(ACTS.reduce((s, [a]) => s + cell[g][a].vp, 0)), pct: pct(ACTS.reduce((s, [a]) => s + cell[g][a].vp, 0)),
    activity: Object.fromEntries(ACTS.map(([a]) => [a, { wallets: cell[g][a].wallets, vp: r2(cell[g][a].vp), pct: pct(cell[g][a].vp) }])) }));
  const by_activity = ACTS.map(([a, label]) => { const vp = GROUPS.reduce((s, [g]) => s + cell[g][a].vp, 0); return { activity: a, label, wallets: GROUPS.reduce((s, [g]) => s + cell[g][a].wallets, 0), vp: r2(vp), pct: pct(vp) }; });
  const entSum = Object.values(byEntity).reduce((s, e) => s + e.vp, 0);
  const by_entity = Object.values(byEntity).sort((a, b) => b.vp - a.vp).map(e => ({ entity: e.entity, wallets: e.wallets, vp: r2(e.vp), pct: pct(e.vp), labels: e.labels }))
    .concat([{ entity: 'Individual wallets', wallets: wallets - Object.values(byEntity).reduce((s, e) => s + e.wallets, 0), vp: r2(total - entSum), pct: pct(total - entSum), labels: [] }]);
  vps.sort((a, b) => b - a); const top = (k) => pct(vps.slice(0, k).reduce((s, x) => s + x, 0));
  const nFor = (f) => { let s = 0; for (let i = 0; i < vps.length; i++) { s += vps[i]; if (s >= f * total) return i + 1; } return vps.length; };
  const concentration = { top1_pct: top(1), top5_pct: top(5), top10_pct: top(10), wallets_for_50pct: nFor(0.5), wallets_for_80pct: nFor(0.8), wallets, note: 'a Votion vault or a DAO counts as one wallet' };
  // the same among individual wallets only (vaults and named entities out), as shares of ALL voting power
  const ivps = members.filter(m => !vaultSet.has(m.wallet) && !named(m.wallet)).map(m => Number((m.summary && m.summary.voting_power_human) || 0)).filter(x => x > 0).sort((a, b) => b - a);
  const itot = ivps.reduce((s, x) => s + x, 0); const itop = (k) => pct(ivps.slice(0, k).reduce((s, x) => s + x, 0));
  const inFor = (f) => { let s2 = 0; for (let i = 0; i < ivps.length; i++) { s2 += ivps[i]; if (s2 >= f * itot) return i + 1; } return ivps.length; };
  // how the vote is spread: the largest wallets in tiers, and wallets by size band (a vault or a DAO counts as one wallet)
  const tiers = [[1, 1], [2, 3], [4, 5], [6, 10], [11, 20], [21, 50], [51, vps.length]].filter(([a]) => a <= vps.length).map(([a, b]) => ({ from: a, to: Math.min(b, vps.length), pct: pct(vps.slice(a - 1, Math.min(b, vps.length)).reduce((s2, x) => s2 + x, 0)) }));
  const bands = [['≥ 5% each', 0.05, 1.01], ['1–5%', 0.01, 0.05], ['0.1–1%', 0.001, 0.01], ['under 0.1%', 0, 0.001]].map(([label, lo, hi]) => { const xs = vps.filter(v => v / total >= lo && v / total < hi); return { label, wallets: xs.length, pct: pct(xs.reduce((s2, x) => s2 + x, 0)) }; });
  concentration.tiers = tiers; concentration.bands = bands;
  concentration.individuals = { wallets: ivps.length, top1_pct: itop(1), top5_pct: itop(5), top10_pct: itop(10), wallets_for_half_of_individual_vp: inFor(0.5) };

  // Votion: who holds the vaults (each holder's share of a vault ≈ its share of that vault's VP)
  let votion = null;
  if (votionSnap && Array.isArray(votionSnap.vaults)) {
    const vEnt = {}; let usd = 0, holders = 0, vpAll = 0, other = { holders: 0, usd: 0, implied_vp: 0 }; const seen = new Set();
    for (const v of votionSnap.vaults) for (const h of v.holders || []) {
      const u = Number(h.underlying_usd || 0), ivp = Number(h.implied_vp || 0); usd += u; vpAll += ivp; if (!seen.has(h.address)) { seen.add(h.address); holders++; }
      const n = named(h.address);
      if (n) { const e = vEnt[n.protocol] = vEnt[n.protocol] || { entity: n.protocol, usd: 0, implied_vp: 0, labels: [] }; e.usd += u; e.implied_vp += ivp; if (!e.labels.includes(n.label)) e.labels.push(n.label); }
      else { other.usd += u; other.implied_vp += ivp; }
    }
    other.holders = holders - Object.keys(vEnt).length;   // approximate: one named entity may hold through several labels
    const vp_ = (x) => vpAll ? Math.round(x / vpAll * 10000) / 100 : null;
    votion = { holders, tvl_usd: r2(usd), implied_vp: r2(vpAll), pct_of_all_vp_total: pct(vpAll), discovery: (votionSnap.meta && votionSnap.meta.discovery_basis) || null,
      by_entity: Object.values(vEnt).sort((a, b) => b.implied_vp - a.implied_vp).map(e => ({ entity: e.entity, usd: r2(e.usd), implied_vp: r2(e.implied_vp), pct_of_votion_vp: vp_(e.implied_vp), pct_of_all_vp: pct(e.implied_vp), labels: e.labels }))
        .concat([{ entity: 'Individual wallets', holders: other.holders, usd: r2(other.usd), implied_vp: r2(other.implied_vp), pct_of_votion_vp: vp_(other.implied_vp), pct_of_all_vp: pct(other.implied_vp) }]) };
  }
  return { schemaVersion: 1, product: 'lp-grades/scorecard-holders', epoch: E, capturedAt: participants && participants.capturedAt || null,
    rule: 'Complete electorate (every lock owner). Named = the address catalog’s entities (public organisations); individual wallets appear only as totals and counts. Active = votes changed in the last ' + ACTIVE_EPOCHS + ' epochs; set-and-forget votes still count. Descriptive only.',
    total_vp: r2(total), wallets, by_group, by_activity, by_entity, concentration, votion };
}

module.exports = { build, ACTIVE_EPOCHS };
