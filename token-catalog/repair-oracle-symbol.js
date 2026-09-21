#!/usr/bin/env node
// repair-oracle-symbol.js — ONE-OFF repair of the oracle (price-history month files) when the token-catalog renames a
// symbol: the days written under the OLD symbol get a row under the CATALOG symbol, labeled; the old row stays, labeled
// superseded_by. Never deletes, never re-prices — the usd / src / confidence of the day are copied byte-for-byte.
//
// Why (2026-09-21, TLA queue item 2): the catalog renamed Noble USDC (ibc/2C962DAB…) from `USDC` to `USDC.n` on
// 2026-08-28 (both keys exist that day, same price). Every reader resolves a denom through the catalog's effective layer
// (lib/denom-symbol.js) and reads the oracle by THAT symbol, so every day before the rename read "no row for USDC.n":
// epoch-history's Bribes column was null for E188–E199, nft-flows priced USDC.n sales as stable_1_1 instead of the day.
//
// Eras carried under the old key (recorded in meta.repairs so the label says what each row is):
//   2026-06-26 → 2026-08-27  rich capture, src `tla` — the SAME stream that writes USDC.n from 08-28 (denom identical).
//   2022-10 → 2026-06-25    thin backfill, src `coingecko` (usd-coin) — the proxy the oracle already used for USDC then.
// USDT (thin CoinGecko `tether`, 2022-10 → 2026-07-17) is NOT aliased to USDt: USDt (from 2026-06-26) is the Terra denom
// priced on the TLA pools, a different source object — "past prices have one source".
//
// Usage (local, on a fresh tla-core checkout; writes the changed month files + the series file in place):
//   node repair-oracle-symbol.js --core <tla-core dir> --from USDC --to USDC.n --denom ibc/2C962DAB… --until 2026-08-27
//   add --dry to print the plan without writing.  Exports the pure `aliasMonth` + `buildSeries` for the gate.
'use strict';
const fs = require('fs'), path = require('path');

const REPAIR_ID = 'oracle-symbol-alias';

// Pure: one month doc in, { doc, changed, days_aliased, days_labeled } out. Days > `until` are never touched.
function aliasMonth(doc, { from, to, denom, until, at }) {
  if (!doc || !doc.days) return { doc, changed: false, days_aliased: 0, days_labeled: 0 };
  let aliased = 0, labeled = 0;
  for (const day of Object.keys(doc.days).sort()) {
    if (day > until) continue;
    const row = doc.days[day]; const src = row && row[from]; if (!src) continue;
    if (!row[to]) {   // the catalog symbol gets the day's record, verbatim, plus the label
      row[to] = Object.assign({}, src, { aliased_from: from, repair: REPAIR_ID, repaired_at: at });
      aliased++;
    }
    if (!src.superseded_by) { src.superseded_by = to; labeled++; }   // the old key stays, labeled (never deleted)
  }
  if (aliased || labeled) {
    const meta = doc.meta || (doc.meta = {});
    const repairs = Array.isArray(meta.repairs) ? meta.repairs : (meta.repairs = []);
    repairs.push({ repair: REPAIR_ID, at, from, to, denom, until, days_aliased: aliased, days_labeled: labeled,
      rule: `token-catalog renamed ${denom.slice(0, 18)}… ${from} → ${to} (2026-08-28); days ≤ ${until} written under ${from} now carry ${to} verbatim (usd/src unchanged); ${from} rows labeled superseded_by, never deleted` });
    return { doc, changed: true, days_aliased: aliased, days_labeled: labeled };
  }
  return { doc, changed: false, days_aliased: 0, days_labeled: 0 };
}

// Pure: the series doc for one symbol from every month doc — the SAME shape token-catalog's maintainPriceSeries seeds
// ({ symbol, unit, source, seeded_at, daily, src, count }), so the cron's daily append continues on it unchanged.
function buildSeries(sym, months, at, existing) {
  const doc = Object.assign({ symbol: sym, unit: 'usd', source: 'tla-core/price-history month files (derived by token-catalog); the oracle, one symbol per file' },
    existing || {}, { symbol: sym, unit: 'usd' });
  doc.seeded_at = (existing && existing.seeded_at) || at; doc.daily = {}; doc.src = {};
  for (const md of months) for (const [d, r] of Object.entries((md && md.days) || {})) if (r[sym] && r[sym].usd != null) { doc.daily[d] = Number(r[sym].usd); if (r[sym].src) doc.src[d] = r[sym].src; }
  const sorted = {}; for (const k of Object.keys(doc.daily).sort()) sorted[k] = doc.daily[k]; doc.daily = sorted;
  doc.updated_at = at; doc.count = Object.keys(doc.daily).length; doc.rebuilt_by = REPAIR_ID;
  return doc;
}

function listMonths(core) {
  const root = path.join(core, 'price-history'); const out = [];
  for (const y of fs.readdirSync(root).filter(x => /^\d{4}$/.test(x)).sort()) for (const f of fs.readdirSync(path.join(root, y)).filter(x => /^\d{2}\.json$/.test(x)).sort()) out.push(path.join(root, y, f));
  return out;
}

function parseArgs() { const a = process.argv.slice(2), o = { core: null, from: null, to: null, denom: null, until: null, dry: false }; for (let i = 0; i < a.length; i++) { if (a[i] === '--core') o.core = a[++i]; else if (a[i] === '--from') o.from = a[++i]; else if (a[i] === '--to') o.to = a[++i]; else if (a[i] === '--denom') o.denom = a[++i]; else if (a[i] === '--until') o.until = a[++i]; else if (a[i] === '--dry') o.dry = true; } return o; }

function main() {
  const a = parseArgs();
  if (!a.core || !a.from || !a.to || !a.denom || !a.until) { console.error('usage: --core <tla-core> --from <old symbol> --to <catalog symbol> --denom <denom> --until <YYYY-MM-DD> [--dry]'); process.exit(1); }
  const at = new Date().toISOString();
  const files = listMonths(a.core); const months = []; let changedFiles = 0, aliased = 0, labeled = 0;
  for (const f of files) {
    const doc = JSON.parse(fs.readFileSync(f, 'utf8'));
    const r = aliasMonth(doc, { from: a.from, to: a.to, denom: a.denom, until: a.until, at });
    if (r.changed) { changedFiles++; aliased += r.days_aliased; labeled += r.days_labeled; if (!a.dry) fs.writeFileSync(f, JSON.stringify(doc, null, 2) + '\n'); console.log(`  ${path.relative(a.core, f)}: +${r.days_aliased} ${a.to} rows, ${r.days_labeled} ${a.from} rows labeled`); }
    months.push(doc);
  }
  const sp = path.join(a.core, 'price-history', 'series', encodeURIComponent(a.to) + '.json');
  const existing = fs.existsSync(sp) ? JSON.parse(fs.readFileSync(sp, 'utf8')) : null;
  const series = buildSeries(a.to, months, at, existing);
  if (!a.dry) fs.writeFileSync(sp, JSON.stringify(series) + '\n');
  console.log(`${a.dry ? '[dry] ' : ''}${changedFiles} month files changed · ${aliased} days aliased ${a.from} → ${a.to} · ${labeled} ${a.from} rows labeled superseded_by · series/${a.to}.json ${existing ? Object.keys(existing.daily || {}).length : 0} → ${series.count} days`);
}

module.exports = { REPAIR_ID, aliasMonth, buildSeries, listMonths };
if (require.main === module) main();
