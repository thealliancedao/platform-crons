// gate-portfolio-tool.mjs — BINDING gate for help-agent lib/portfolio-tool.js 1.0.0 on REAL committed data (a tla-core checkout).
// Usage: TLA_CORE_DIR=<tla-core> node help-agent/gate-portfolio-tool.mjs
//   B1 the owner: named, tracked, custody (ampCAPA DAO) found and coded CUSTODY_DAO; the moved wBTC receipt coded MOVED_RECEIPT naming
//      where it went (the registry label when the build has it); APR blank explained; the Votion story numbers are the product's
//   B2 the GMC Backing Wallet: named from the registry; its wBTC.creda.a backing in an active pool (no INACTIVE_LP); no unknown rows
//   B3 every finding has a code, a kind (known | check | fault) and plain words; a fault carries the report block
//   B4 an untracked wallet → NOT_TRACKED, no crash, no invented numbers
//   B5 freshness block names each product's path and time
import fs from 'fs'; import path from 'path'; import { createRequire } from 'module';
const require = createRequire(import.meta.url); const PT = require('./lib/portfolio-tool.js');
const CORE = process.env.TLA_CORE_DIR; if (!CORE) { console.error('TLA_CORE_DIR required'); process.exit(1); }
let pass = 0, fail = 0; const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (x !== undefined ? ' → ' + JSON.stringify(x).slice(0, 500) : '')); } };
const fetchJson = async (url, rel) => { const f = path.join(CORE, rel); if (!fs.existsSync(f)) return null; return JSON.parse(fs.readFileSync(f, 'utf8')); };
const J = (p) => JSON.parse(fs.readFileSync(path.join(CORE, p), 'utf8'));
const OWNER = 'terra1hr8zsfpch47qygc96c8e6rzkd2t7mafqx77ulw', GMC = 'terra1jd2tam4svukk7pg8fv0dkj7zgwes9yw5c2h3wm0gkjcwdth2mpfsxxw6zd';
const now = Date.parse(J('member-data/participants/current.json').capturedAt) + 60e3;
const codes = (r) => r.findings.map(f => f.code);

const o = await PT.run({ wallet: OWNER }, { fetchJson, now }); console.log(`owner: ${o.name} · findings ${codes(o).join(', ')}`);
const cu = o.findings.find(f => f.code === 'CUSTODY_DAO');
ok(`B1 owner named (${o.name}), tracked, custody ${cu && cu.evidence.usd} in ${cu && cu.evidence.where} coded CUSTODY_DAO`, o.name && o.tracked && cu && /ampCAPA DAO/.test(cu.says) && o.summary.includes_custody, o.findings);
const mv = o.findings.find(f => f.code === 'MOVED_RECEIPT' && /wBTC\.osmo-wBTC\.axl/.test(f.says));
ok(`B1 the moved wBTC receipt: "${mv && mv.says.slice(0, 160)}"`, mv && /2026-03-06/.test(mv.says) && /terra1jd2tam|GMC/.test(mv.says), o.findings.map(f => f.code));
ok('B1 APR blanks explained (APR_BLANK_UNPRICED)', codes(o).includes('APR_BLANK_UNPRICED'));
const hp = J('votion/holder-pnl/current.json'); const hv = Object.values(hp.holders).filter(h => h.wallet === OWNER && h.totals);
ok(`B1 Votion stories = the product's (${hv.map(h => h.lst_symbol + ' ' + h.totals.cost_usd.toFixed(2) + '→' + h.totals.usd_now.toFixed(2)).join(' · ')})`, o.votion && hv.length === o.votion.filter(v => v.totals).length && hv.every(h => o.votion.some(v => v.vault === h.vault && Math.abs(v.totals.in_usd - h.totals.cost_usd) < 0.01 && Math.abs(v.totals.luna_price_usd - h.totals.legs.luna_price) < 0.01)));

const g = await PT.run({ wallet: GMC }, { fetchJson, now }); console.log(`GMC: ${g.name} · lp ${JSON.stringify(g.lp_live)} · findings ${codes(g).join(', ')}`);
const wb = (g.lp_live || []).find(l => l.pool === 'wBTC.creda.a');
ok(`B2 GMC named "${g.name}" (${g.name_from}); wBTC.creda.a backing ${wb && '$' + wb.usd} status ${wb && wb.status}; no inactive / unknown rows`, /GMC/.test(g.name || '') && wb && wb.status === 'active' && wb.usd > 1000 && !codes(g).includes('INACTIVE_LP') && !codes(g).includes('UNKNOWN_LP_ROW'), g);

const all = o.findings.concat(g.findings);
ok(`B3 ${all.length} findings, each coded with a kind and words`, all.every(f => f.code && ['known', 'check', 'fault'].includes(f.kind) && f.says.length > 20));
const faultRun = await PT.run({ wallet: OWNER }, { fetchJson, now: now + 50 * 36e5 });
ok('B3 a fault (products 50 h old → STALE_PRODUCT) carries the report block: where to send it and what to include', faultRun.findings.some(f => f.code === 'STALE_PRODUCT' && f.kind === 'fault') && faultRun.report && /Report an issue/.test(faultRun.report.send_to) && faultRun.report.include.length >= 4, faultRun.report);

const x = await PT.run({ wallet: 'terra1' + 'q'.repeat(38) }, { fetchJson, now });
ok('B4 an untracked wallet → NOT_TRACKED, no summary invented', codes(x).includes('NOT_TRACKED') && !x.summary && x.tracked === false, x);
ok('B4 a non-address → an error, not a guess', !!(await PT.run({ wallet: 'hello' }, { fetchJson, now })).error);
ok(`B5 freshness names the paths + times (participants ${o.freshness.participants.hours} h, pnl ${o.freshness.pnl.builder})`, o.freshness.participants.path && o.freshness.participants.at && o.freshness.pnl.at && o.freshness.votion_holder_pnl.at);
console.log(`\n${pass}/${pass + fail} passed`); process.exit(fail ? 1 : 0);
