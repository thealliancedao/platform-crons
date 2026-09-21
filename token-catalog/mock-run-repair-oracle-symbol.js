#!/usr/bin/env node
// mock-run-repair-oracle-symbol.js — gate for repair-oracle-symbol.js (TLA queue item 2, 2026-09-21) on the REAL oracle.
// Runs on a tla-core checkout BEFORE or AFTER the repair (the alias is idempotent): applies aliasMonth in memory and
// asserts the invariants, then folds the real tla-snapshot dailies with the repaired oracle (member-data's
// epoch-history-rollup, the live exported functions — no third copy) and asserts E188–E199 now carry a bribes_usd.
// Usage: TLA_CORE_DIR=<tla-core> node --max-old-space-size=200 mock-run-repair-oracle-symbol.js
'use strict';
const fs = require('fs'), path = require('path');
const CORE = process.env.TLA_CORE_DIR; if (!CORE) { console.error('TLA_CORE_DIR required'); process.exit(1); }
const R = require('./repair-oracle-symbol.js');
const DS = require('../lib/denom-symbol.js');
const EH = require('../member-data/epoch-history-rollup.js');
let fails = 0; const check = (n, ok, d) => { console.log(`${ok ? '✓' : '✗'} ${n}${d !== undefined ? ' — ' + JSON.stringify(d).slice(0, 220) : ''}`); if (!ok) fails++; };

const FROM = 'USDC', TO = 'USDC.n', DENOM = 'ibc/2C962DAB9F57FE0921435426AE75196009FAA1981BF86991203C8411F8980FDB', UNTIL = '2026-08-31', RENAME_DAY = '2026-08-28';
const at = '2026-09-21T00:00:00.000Z';

// the catalog says which symbol the denom has today — the rule the readers use
const cat = JSON.parse(fs.readFileSync(path.join(CORE, 'token-catalog/snapshots/current.json'), 'utf8'));
const resolve = DS.buildResolver(cat);
check(`catalog resolves ${DENOM.slice(0, 18)}… to ${TO} (the reader's symbol)`, resolve(DENOM).symbol === TO, resolve(DENOM));

const files = R.listMonths(CORE); const months = [], before = [];
// `before` = the pre-repair oracle, reconstructed from whatever is on disk (the alias is reversible: drop the labeled rows,
// the labels and the repair record) — so the gate reads the same on a checkout before or after the repair was committed.
const unrepair = (doc) => { for (const row of Object.values(doc.days || {})) { if (row[TO] && row[TO].aliased_from === FROM) delete row[TO]; if (row[FROM] && row[FROM].superseded_by === TO) delete row[FROM].superseded_by; } if (doc.meta && Array.isArray(doc.meta.repairs)) { doc.meta.repairs = doc.meta.repairs.filter(r => !(r.repair === R.REPAIR_ID && r.from === FROM && r.to === TO)); if (!doc.meta.repairs.length) delete doc.meta.repairs; } return doc; };
for (const f of files) { const doc = unrepair(JSON.parse(fs.readFileSync(f, 'utf8'))); before.push(JSON.parse(JSON.stringify(doc))); R.aliasMonth(doc, { from: FROM, to: TO, denom: DENOM, until: UNTIL, at }); months.push(doc); }
const allDays = (docs) => { const o = {}; for (const d of docs) Object.assign(o, d.days || {}); return o; };
const A = allDays(before), B = allDays(months);
const fromDays = Object.keys(A).filter(d => A[d][FROM]).sort();
check(`every ${FROM} day ≤ ${UNTIL} (${fromDays.filter(d => d <= UNTIL).length}) now has a ${TO} row with the same usd and src`, fromDays.filter(d => d <= UNTIL).every(d => B[d][TO] && B[d][TO].usd === A[d][FROM].usd && B[d][TO].src === A[d][FROM].src), { first: fromDays[0], last: fromDays[fromDays.length - 1] });
check(`aliased rows are labeled (aliased_from ${FROM}, repair ${R.REPAIR_ID}) and only on days ${FROM} existed and ${TO} did not`, Object.keys(B).every(d => !B[d][TO] || !B[d][TO].aliased_from || (A[d][FROM] && !A[d][TO] && d <= UNTIL)));
check(`no ${TO} row written by the cron itself (${RENAME_DAY} on) was touched`, Object.keys(A).filter(d => A[d][TO]).every(d => JSON.stringify(A[d][TO]) === JSON.stringify(B[d][TO])), { cronDays: Object.keys(A).filter(d => A[d][TO]).length });
check(`every ${FROM} row ≤ ${UNTIL} is labeled superseded_by ${TO}; its usd/src unchanged (never deleted, never re-priced)`, fromDays.filter(d => d <= UNTIL).every(d => B[d][FROM] && B[d][FROM].superseded_by === TO && B[d][FROM].usd === A[d][FROM].usd && B[d][FROM].src === A[d][FROM].src));
check(`the rename day ${RENAME_DAY} carries both keys with the same usd (the identity evidence)`, A[RENAME_DAY] && A[RENAME_DAY][FROM] && A[RENAME_DAY][TO] && A[RENAME_DAY][FROM].usd === A[RENAME_DAY][TO].usd, { usd: A[RENAME_DAY] && A[RENAME_DAY][TO] && A[RENAME_DAY][TO].usd });
check('rows of every other symbol are byte-identical', Object.keys(A).every(d => Object.keys(A[d]).every(k => k === FROM || JSON.stringify(A[d][k]) === JSON.stringify(B[d][k]))));
check('USDT (thin CoinGecko tether) is NOT aliased to USDt — a different source object', !Object.keys(B).some(d => B[d].USDt && B[d].USDt.aliased_from));
const rep = months.filter(m => m.meta && Array.isArray(m.meta.repairs) && m.meta.repairs.some(r => r.repair === R.REPAIR_ID && r.from === FROM && r.to === TO));
check('every changed month file carries ONE repair record in meta (idempotent: a second application changes nothing)', rep.length === months.filter(m => Object.values(m.days).some(r => r[TO] && r[TO].aliased_from)).length && months.every(m => { const c = JSON.stringify(m); const r2 = R.aliasMonth(JSON.parse(c), { from: FROM, to: TO, denom: DENOM, until: UNTIL, at }); return !r2.changed; }), { changed_files: rep.length });

// the series file the readers with a long window use (explorer floor band, release-history)
const sp = path.join(CORE, 'price-history', 'series', encodeURIComponent(TO) + '.json');
const series = R.buildSeries(TO, months, at, fs.existsSync(sp) ? JSON.parse(fs.readFileSync(sp, 'utf8')) : null);
const toDays = Object.keys(B).filter(d => B[d][TO] && B[d][TO].usd != null).sort();
check(`series/${TO}.json = every ${TO} day in every month file (${toDays.length}), sorted, values identical, src carried`, series.count === toDays.length && Object.keys(series.daily).join() === toDays.join() && toDays.every(d => series.daily[d] === Number(B[d][TO].usd) && (!B[d][TO].src || series.src[d] === B[d][TO].src)), { first: toDays[0], last: toDays[toDays.length - 1] });
if (fs.existsSync(sp)) { const onDisk = JSON.parse(fs.readFileSync(sp, 'utf8')); if (onDisk.rebuilt_by === R.REPAIR_ID) check(`series/${TO}.json on disk (rebuilt by the repair) matches the rebuild (count ${onDisk.count})`, onDisk.count === series.count && Object.keys(onDisk.daily).join() === Object.keys(series.daily).join()); else console.log(`  (series/${TO}.json on disk is the cron's seed — ${onDisk.count} days; the repair rebuilds it to ${series.count})`); }

// the fold that needed it: member-data's epoch-history on the real dailies, oracle = the repaired months
const dailyDir = path.join(CORE, 'member-data/tla-snapshot/daily'), erisDir = path.join(CORE, 'dex-data/eris-apr/daily');
const dfiles = fs.readdirSync(dailyDir).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
const days = dfiles.map(f => ({ snap: JSON.parse(fs.readFileSync(path.join(dailyDir, f), 'utf8')), eris: fs.existsSync(path.join(erisDir, f)) ? JSON.parse(fs.readFileSync(path.join(erisDir, f), 'utf8')) : null }));
const epochsBefore = EH.fold(days, { resolve, oracleDays: EH.oracleFromMonths(before) });
const epochsAfter = EH.fold(days, { resolve, oracleDays: EH.oracleFromMonths(months) });
const wasNull = epochsBefore.filter(e => e.bribes_usd == null && (e.bribes_unpriced || []).includes(TO)).map(e => e.epoch);
check(`before the repair the fold left epochs unpriced on ${TO} (the symptom: E188–E199)`, wasNull.length >= 12 && wasNull[0] === 188 && wasNull[wasNull.length - 1] === 199, wasNull);
const nowPriced = epochsAfter.filter(e => wasNull.includes(e.epoch));
check(`after the repair those epochs price (${nowPriced.filter(e => typeof e.bribes_usd === 'number').length}/${wasNull.length}); the rest are unpriced on another symbol only (E196: FUEL absent from the oracle on 2026-08-02)`, nowPriced.every(e => (typeof e.bribes_usd === 'number' && e.bribes_usd > 0) || (e.bribes_usd == null && (e.bribes_unpriced || []).length && !e.bribes_unpriced.includes(TO))) && nowPriced.filter(e => typeof e.bribes_usd === 'number').length >= 11, nowPriced.map(e => [e.epoch, e.bribes_usd, e.bribes_unpriced]));
const stillNull = epochsAfter.filter(e => e.bribes_usd == null).map(e => [e.epoch, e.bribes_unpriced]);
check('the only epochs still unpriced are unpriced on a symbol the oracle never carried that day (FUEL), never on ' + TO, stillNull.every(([, u]) => !(u || []).includes(TO)), stillNull);
check('every epoch priced before the repair prices to the same cent after it', epochsBefore.every(e => e.bribes_usd == null || epochsAfter.find(x => x.epoch === e.epoch).bribes_usd === e.bribes_usd));

console.log(`\nrss ${Math.round(process.memoryUsage().rss / 1048576)} MB\n=== ORACLE SYMBOL ALIAS GATE: ${fails ? 'FAIL' : 'PASS'} — ${fails} failed ===`); process.exit(fails ? 1 : 0);
