// =============================================================================
// address-catalog / trusted-catalog.js — ONE trust product (1.3.0, 2026-08-22)
// =============================================================================
// The platform had five places an address could be "known" (docs/curated/
// wallets.json, docs/curated/known_contracts.json, config/contracts.js
// structural set, each DAO's dao-originations registry, the live gauge/pool
// snapshots) and a bare `verified: true` boolean with no HOW. This module folds
// them into `catalog/trusted/current.json`: one row per address, every row
// carrying `verified: [{method, ref, url, by, on}]` so the page, the help agent's
// audit, the DAO page and the news cards read the same answer to "why is this
// address known?".
//
// Precedence of labels: trusted-addresses.json (explicit) > wallets.json >
// known_contracts.json > DAO registries > structural config > live snapshots.
// Verification entries are UNIONED (never dropped); a bare boolean from the
// older files becomes method 'owner' (an honest downgrade — it IS a human
// label). Live-snapshot membership becomes method 'chain' with the capture that
// saw it. Nothing here asserts "safe": methods are evidence, not verdicts.
// Pure function + fixtures gate; the cron only fetches and publishes.
// =============================================================================
'use strict';

const ADDR_RE = /^terra1[02-9ac-hj-np-z]{38,58}$/;
const METHODS = ['chain', 'github', 'scv_audit', 'oak_audit', 'owner', 'project_team', 'dao_registry', 'past_prop', 'docs'];
const TYPES = ['contract', 'treasury', 'multisig', 'dao_core', 'proposal_module', 'pool', 'token', 'router', 'user', 'team_member', 'council_member', 'protocol_wallet', 'protocol'];

const SUBTYPE_TO_TYPE = { treasury: 'treasury', multisig: 'multisig', contract: 'contract', protocol: 'protocol_wallet', protocol_briber: 'protocol_wallet', dao: 'dao_core', wallet: 'user' };
const REGTYPE_TO_TYPE = { dao: 'dao_core', treasury: 'treasury', protocol: 'contract', token: 'token', multisig: 'multisig', contract: 'contract' };

function buildTrusted({ curated, wallets, known, contracts, daoRegs, snapshot, astro, generatedAt }) {
  const rows = {};
  const issues = [];
  const on = (generatedAt || new Date().toISOString()).slice(0, 10);
  const row = (a) => rows[a] || (rows[a] = { address: a, label: null, type: null, protocol: null, description: null, verified: [], sources: [] });
  const addV = (a, v) => { const r = row(a); const key = v.method + '|' + (v.ref || '') + '|' + (v.by || ''); if (!r.verified.some(x => x.method + '|' + (x.ref || '') + '|' + (x.by || '') === key)) r.verified.push(v); };
  const setIf = (r, k, v) => { if (v != null && v !== '' && r[k] == null) r[k] = v; };

  // 1. explicit trust register (highest precedence for label/type/description)
  for (const [a, v] of Object.entries((curated && curated.addresses) || {})) {
    if (!ADDR_RE.test(a)) { issues.push(`trusted-addresses: bad address key ${a}`); continue; }
    const r = row(a); r.label = v.label || r.label; r.type = v.type || r.type; r.protocol = v.protocol || r.protocol; r.description = v.description || r.description; r.sources.push('trusted-addresses.json');
    if (v.type && !TYPES.includes(v.type)) issues.push(`trusted-addresses ${a.slice(0, 12)}…: unknown type '${v.type}'`);
    let valid = 0;
    for (const x of (v.verified || [])) { if (!METHODS.includes(x.method)) { issues.push(`trusted-addresses ${a.slice(0, 12)}…: unknown method '${x.method}'`); continue; } valid++; addV(a, { method: x.method, ref: x.ref || null, url: x.url || null, by: x.by || null, on: x.on || null }); }
    if (!valid) issues.push(`trusted-addresses ${a.slice(0, 12)}…: no valid verification entries — listed, not trusted`);
  }
  // 2. wallets.json (entities) — bare boolean → owner label
  for (const [a, v] of Object.entries((wallets && wallets.wallets) || {})) {
    if (!ADDR_RE.test(a) || !v || !v.label) continue;
    const r = row(a); setIf(r, 'label', v.label); setIf(r, 'type', SUBTYPE_TO_TYPE[v.subtype] || null); setIf(r, 'protocol', v.protocol); setIf(r, 'description', v.description); r.sources.push('wallets.json');
    if (v.verified === true) addV(a, { method: 'owner', ref: 'wallets.json verified:true (' + (v.subtype || 'entity') + ')', url: null, by: 'DeFi_Patriot', on: (wallets._meta && wallets._meta.lastUpdated) || null });
    for (const x of (v.verification || [])) if (METHODS.includes(x.method)) addV(a, { method: x.method, ref: x.ref || null, url: x.url || null, by: x.by || null, on: x.on || null });
  }
  // 3. known_contracts.json — owner labels
  for (const [a, v] of Object.entries((known && known.contracts) || {})) {
    if (!ADDR_RE.test(a) || !v || !v.name) continue;
    const r = row(a); setIf(r, 'label', v.name); setIf(r, 'type', REGTYPE_TO_TYPE[v.type] || 'contract'); setIf(r, 'protocol', v.protocol); setIf(r, 'description', v.description); r.sources.push('known_contracts.json');
    addV(a, { method: 'owner', ref: 'known_contracts.json (' + (v.type || 'contract') + ')', url: null, by: 'DeFi_Patriot', on: (known._meta && known._meta.lastUpdated) || null });
  }
  // 4. per-DAO registries — each DAO's own vetting
  for (const [dao, reg] of Object.entries(daoRegs || {})) {
    if (!reg) continue;
    const url = 'https://github.com/thealliancedao/dao-originations/blob/main/' + dao + '/governance/registry.json';
    for (const [a, v] of Object.entries(reg.contracts || {})) {
      if (!ADDR_RE.test(a)) continue;
      const r = row(a); setIf(r, 'label', v.name); setIf(r, 'type', REGTYPE_TO_TYPE[v.type] || 'contract'); setIf(r, 'protocol', v.protocol || null); r.sources.push('dao-registry:' + dao);
      addV(a, { method: 'dao_registry', ref: dao + ' registry (' + (v.name || v.type) + ')', url, by: reg.daoName || reg.dao || dao, on: reg.lastUpdated || null });
    }
    for (const a of [reg.coreAddress, reg.govAddress].filter(x => ADDR_RE.test(String(x || '')))) { const r = row(a); setIf(r, 'label', (reg.daoName || dao) + ' core'); setIf(r, 'type', 'dao_core'); r.sources.push('dao-registry:' + dao); addV(a, { method: 'dao_registry', ref: dao + ' registry ' + (reg.coreAddress === a ? 'coreAddress' : 'govAddress'), url, by: reg.daoName || dao, on: reg.lastUpdated || null }); }
  }
  // 5. structural contracts (config) — queried every run
  for (const [k, v] of Object.entries(contracts || {})) {
    if (!v || !ADDR_RE.test(String(v.addr || ''))) continue;
    const r = row(v.addr); setIf(r, 'label', v.role || k); setIf(r, 'type', 'contract'); setIf(r, 'protocol', 'Eris'); setIf(r, 'description', v.role); r.sources.push('catalog.contracts:' + k);
    addV(v.addr, { method: 'chain', ref: 'structural contract `' + k + '` — queried by the capture engine every run; responses match the expected schema', url: 'https://chainsco.pe/terra2/address/' + v.addr, by: 'address-catalog cron', on });
  }
  // 6. live gauge set + pools — chain-listed
  for (const p of (snapshot && snapshot.pools) || []) {
    for (const [a, what] of [[p.pool_address, 'pool'], [p.lp_address, 'LP token']]) {
      if (!ADDR_RE.test(String(a || ''))) continue;
      const r = row(a); setIf(r, 'label', p.name + ' ' + what + ' (' + (p.dex || 'DEX') + ')'); setIf(r, 'type', what === 'pool' ? 'pool' : 'token'); setIf(r, 'protocol', p.dex || null); r.sources.push('tla-snapshot');
      addV(a, { method: 'chain', ref: 'listed by the TLA gauge controller (' + (p.bucket || '?') + ' bucket, ' + (p.status || '?') + ') — ' + what, url: 'https://www.erisprotocol.com/terra/amp-governance', by: 'member-data cron', on });
    }
  }
  for (const p of (astro && astro.pools) || []) {
    if (!ADDR_RE.test(String(p.pool_address || ''))) continue;
    const r = row(p.pool_address); setIf(r, 'label', p.pool_name + ' pool (Astroport)'); setIf(r, 'type', 'pool'); setIf(r, 'protocol', 'Astroport'); r.sources.push('dex-data:astroport');
    addV(p.pool_address, { method: 'chain', ref: 'pool in the daily Astroport snapshot (' + (p.pool_type || '?') + (p.tla_relevant ? ', TLA-relevant' : '') + ')', url: 'https://app.astroport.fi/pools', by: 'dex-data cron', on });
  }

  // finalize: strongest method first, counts, unverified flagging
  const ORDER = ['chain', 'github', 'scv_audit', 'oak_audit', 'past_prop', 'dao_registry', 'docs', 'project_team', 'owner'];
  const out = Object.values(rows).map(r => {
    r.verified.sort((a, b) => ORDER.indexOf(a.method) - ORDER.indexOf(b.method));
    r.methods = [...new Set(r.verified.map(v => v.method))];
    r.sources = [...new Set(r.sources)];
    r.human_only = r.methods.length > 0 && r.methods.every(m => ['owner', 'project_team', 'dao_registry', 'docs'].includes(m));
    return r;
  }).sort((a, b) => (a.human_only - b.human_only) || String(a.protocol || 'zz').localeCompare(String(b.protocol || 'zz')) || String(a.label || '').localeCompare(String(b.label || '')));
  const byMethod = {}; for (const r of out) for (const m of r.methods) byMethod[m] = (byMethod[m] || 0) + 1;
  const byType = {}; for (const r of out) byType[r.type || 'untyped'] = (byType[r.type || 'untyped'] || 0) + 1;
  return {
    meta: { version: 'trusted-catalog-1.3.0', generated_at: generatedAt || new Date().toISOString(), status: issues.length ? 'ok-with-issues' : 'ok',
      how_to_read: 'Each row lists HOW the address is known (verified[]). chain/github/scv_audit/oak_audit are checkable without trusting this site; owner/project_team/dao_registry/docs are human labels; past_prop is precedent, not endorsement. human_only:true rows have no chain-level evidence. Nothing here asserts an address is safe — the chain is the source of truth; every row links to the explorer.',
      methods: METHODS, types: TYPES, sources: ['docs/curated/trusted-addresses.json', 'docs/curated/wallets.json', 'docs/curated/known_contracts.json', 'dao-originations/*/governance/registry.json', 'config/contracts.js (structural)', 'member-data/tla-snapshot (gauge set)', 'dex-data/astroport (pools)'],
      counts: { addresses: out.length, by_method: byMethod, by_type: byType, human_only: out.filter(r => r.human_only).length }, issues },
    needs_verification: (curated && curated._needs_verification && curated._needs_verification.candidates) || [],
    addresses: out,
  };
}

module.exports = { buildTrusted, METHODS, TYPES };
