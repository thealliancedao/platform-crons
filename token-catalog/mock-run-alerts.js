#!/usr/bin/env node
// mock-run-alerts.js — gate for Rev 1.8.0 stage 2c: the curated alert stamp on the REAL committed catalog + registry.
// Usage: TLA_CORE_DIR=<tla-core> node --max-old-space-size=200 mock-run-alerts.js
'use strict';
const fs = require('fs'), path = require('path');
const CORE = process.env.TLA_CORE_DIR; if (!CORE) { console.error('TLA_CORE_DIR required'); process.exit(1); }
const { stampAssetAlerts } = require('./token-catalog.js');
let fails = 0; const check = (n, ok, d) => { console.log(`${ok ? '✓' : '✗'} ${n}${d !== undefined ? ' — ' + JSON.stringify(d).slice(0, 200) : ''}`); if (!ok) fails++; };
const cat = JSON.parse(fs.readFileSync(path.join(CORE, 'token-catalog/snapshots/current.json')));
const reg = JSON.parse(fs.readFileSync(path.join(CORE, 'docs/curated/alerts.json')));
const tokens = cat.tokens.map(t => ({ ...t }));
const st = stampAssetAlerts(tokens, reg);
const active = reg.alerts.filter(a => a.kind === 'asset' && ['migrating', 'winding_down', 'watch'].includes(a.status));
check('every active asset entry in the registry matches a catalog token (nothing unmatched)', st.unmatched.length === 0 && st.stamped === active.length, st);
check('stamped tokens = exactly the registry denoms; symbol agrees with the catalog\'s effective/discovered symbol', tokens.filter(t => t.alert).every(t => active.some(a => a.denom === t.denom) && (((t.effective && t.effective.symbol) || (t.discovered && t.discovered.symbol)) === t.alert.symbol)), tokens.filter(t => t.alert).map(t => [t.denom.slice(0, 12), t.alert.symbol]));
check('a forum entry stamps no token (kind asset only)', !tokens.some(t => t.alert && reg.alerts.find(a => a.id === t.alert.id).kind !== 'asset'));
check('discovered / effective untouched by the stamp', tokens.every((t, i) => JSON.stringify(t.discovered) === JSON.stringify(cat.tokens[i].discovered) && JSON.stringify(t.effective) === JSON.stringify(cat.tokens[i].effective)));
const retired = JSON.parse(JSON.stringify(reg)); retired.alerts.forEach(a => { a.status = 'retired'; });
const t2 = cat.tokens.map(t => ({ ...t })); const st2 = stampAssetAlerts(t2, retired);
check('a retired entry stamps nothing (history kept, alert gone)', st2.stamped === 0 && !t2.some(t => t.alert));
const t3 = cat.tokens.map(t => ({ ...t, alert: { id: 'stale' } })); stampAssetAlerts(t3, null);
check('a failed read (null doc) clears stale stamps and stamps nothing', !t3.some(t => t.alert));
console.log(`\n=== TOKEN-CATALOG ALERT GATE (1.8.0): ${fails ? 'FAIL' : 'PASS'} — ${fails} failed ===`); process.exit(fails ? 1 : 0);
