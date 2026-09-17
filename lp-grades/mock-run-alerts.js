#!/usr/bin/env node
// mock-run-alerts.js — gate for lp-grades 2.1.0: pools inherit curated alerts through their underlyings (token-catalog
// stamp) and forum entries by name. Runs applyAlerts (live module) on the COMMITTED lp-grades product rows + a catalog
// stamped from the committed registry by token-catalog's own stampAssetAlerts (no third copy of either rule).
// Usage: TLA_CORE_DIR=<tla-core> node --max-old-space-size=200 mock-run-alerts.js
'use strict';
const fs = require('fs'), path = require('path');
const CORE = process.env.TLA_CORE_DIR; if (!CORE) { console.error('TLA_CORE_DIR required'); process.exit(1); }
const { applyAlerts } = require('./lp-grades.js');
const { stampAssetAlerts } = require('../token-catalog/token-catalog.js');
let fails = 0; const check = (n, ok, d) => { console.log(`${ok ? '✓' : '✗'} ${n}${d !== undefined ? ' — ' + JSON.stringify(d).slice(0, 260) : ''}`); if (!ok) fails++; };
const J = (p) => JSON.parse(fs.readFileSync(path.join(CORE, p)));
const grades = J('lp-grades/snapshots/current.json'), cat = J('token-catalog/snapshots/current.json'), reg = J('docs/curated/alerts.json');
stampAssetAlerts(cat.tokens, reg);
const rows = grades.pools.map(r => ({ ...r }));
const st = applyAlerts(rows, cat, reg);
// relation: the set of pools carrying an asset alert == the set whose token-catalog underlyings include a stamped denom
const stamped = new Set(cat.tokens.filter(t => t.alert).map(t => t.denom));
const tcPools = Object.fromEntries(cat.pools.map(p => [p.gauge_pool_id, p]));
const expect = rows.filter(r => (tcPools[r.gauge_pool_id] && tcPools[r.gauge_pool_id].underlyings || []).some(d => stamped.has(d))).map(r => r.name).sort();
const got = rows.filter(r => r.alerts && r.alerts.some(a => a.kind === 'asset')).map(r => r.name).sort();
check(`asset-alerted pools = every pool whose underlyings hold a stamped denom (${got.length})`, JSON.stringify(got) === JSON.stringify(expect), { got, expect });
// The catalog's underlyings are the oracle, not the name: SkeletonSwap's "USDC" pools (no .n suffix) hold the same Noble
// denom (dex-data assets agree) — name-matching would have missed four gauges. Named pools must at least say USDC.
check('every NAMED alerted pool says USDC (the unnamed cw20:/native: gauge ids are inactive gauges holding the denom too)', got.filter(n => !/^(cw20|native):/.test(n)).every(n => /USDC/.test(n)), got.filter(n => !/USDC/.test(n)));
check('the alert names its route: every asset alert row says which underlying denom carried it', rows.filter(r => r.alerts).every(r => r.alerts.filter(a => a.kind === 'asset').every(a => /^token-catalog underlying /.test(a.via))));
check('grades untouched: v2 letter / composite / streak identical to the committed product on every row', rows.every((r, i) => JSON.stringify(r.v2) === JSON.stringify(grades.pools[i].v2) && r.grade === grades.pools[i].grade));
const share = rows.filter(r => r.alerts).reduce((s, r) => s + (r.vp || 0), 0) / rows.reduce((s, r) => s + (r.vp || 0), 0);
console.log(`  (asset-alerted VP share on epoch ${grades.epoch}: ${(share * 100).toFixed(1)}% · staked $${Math.round(rows.filter(r => r.alerts && r.alerts.some(a => a.kind === 'asset')).reduce((s, r) => s + (r.staked_usd || 0), 0)).toLocaleString()})`);
const forumRows = rows.filter(r => r.alerts && r.alerts.some(a => a.kind === 'forum'));
const forumNames = reg.alerts.filter(a => a.kind === 'forum').flatMap(a => a.affects.pool_names);
check(`forum entries attach to the pools they name (${forumRows.map(r => r.name).join(', ')}); unmatched names reported, not guessed`, forumRows.length + st.forum_unmatched.length === forumNames.length, { forum_pools: st.forum_pools, unmatched: st.forum_unmatched });
check('a pool can carry both (USDC.n-SOLID: asset wind-down AND the CAPA bribe forum post)', (() => { const r = rows.find(r => r.name === 'USDC.n-SOLID'); return r && r.alerts && r.alerts.some(a => a.kind === 'asset') && r.alerts.some(a => a.kind === 'forum'); })());
check('every alert row carries kind · id · status · headline · source_url', rows.filter(r => r.alerts).every(r => r.alerts.every(a => a.kind && a.id && a.status && a.headline && 'source_url' in a)));
const rows2 = grades.pools.map(r => ({ ...r, alerts: [{ kind: 'asset', id: 'stale' }] })); applyAlerts(rows2, { tokens: [], pools: cat.pools }, null);
check('no stamps + no registry → no alerts on any row (stale fields cleared)', !rows2.some(r => r.alerts));
console.log(`\n=== LP-GRADES ALERT GATE (2.1.0): ${fails ? 'FAIL' : 'PASS'} — ${fails} failed ===`); process.exit(fails ? 1 : 0);
