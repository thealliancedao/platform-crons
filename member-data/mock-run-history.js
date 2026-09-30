#!/usr/bin/env node
// mock-run-history.js — gate for member-data/history-series.js 1.0.0 on the REAL archives (a tla-core checkout).
// Run: TLA_CORE_DIR=<tla-core> node --max-old-space-size=200 mock-run-history.js   (the Render heap cap is part of the gate)
//   H1 seed: every archived day 2026-08-11 → the last archive, one row per wallet per day, sharded by the char after "terra1"
//   H2 values: the owner's 2026-09-28 row == the participants archive's own summary fields; Votion == Σ his holdings that day
//   H3 custody: a day captured before capture-engine 1.2 carries the DAO stake from the CAPA supply history (filled, flagged cuS=1),
//      a day that carried it keeps the capture's own figure (cuS=0) — never both
//   H4 blank beats phantom: a field the day did not carry is null (Credia before it was captured), never 0
//   H5 forward: up to date → skipped outside 23:xx; at 23:xx today refolds in place (row count unchanged); HISTORY=0 disables
//   H6 size: the whole series fits a phone (largest shard, total)
const fs = require('fs'); const path = require('path');
const HS = require('./history-series.js');
const CORE = process.env.TLA_CORE_DIR; if (!CORE) { console.error('TLA_CORE_DIR required'); process.exit(1); }
let pass = 0, fail = 0; const ok = (m, c, x) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (x !== undefined ? ' → ' + JSON.stringify(x).slice(0, 300) : '')); } };
const RAW = 'https://raw.example/tla-core';
const published = new Map();   // path → content (what the duty committed, served back on the next run)
const fetchJson = async (u) => { const rel = String(u).replace(RAW + '/', '').split('?')[0];
  if (published.has(rel)) return JSON.parse(published.get(rel));
  const f = path.join(CORE, rel); if (!fs.existsSync(f)) throw new Error('HTTP 404 ' + rel); return JSON.parse(fs.readFileSync(f, 'utf8')); };
let commits = 0; const publishBatch = async (files, message) => { commits++; for (const f of files) published.set(f.path, f.content); return { commit: 'mock' + commits, files: files.length }; };
const OWNER = 'terra1hr8zsfpch47qygc96c8e6rzkd2t7mafqx77ulw';
const lastArchive = fs.readdirSync(path.join(CORE, 'member-data/participants/daily')).filter(f => /^\d{4}-\d\d-\d\d\.json$/.test(f)).sort().pop().slice(0, 10);
const at = (day, h) => () => new Date(day + 'T' + String(h).padStart(2, '0') + ':30:00Z');
const quiet = () => {};
(async () => {
  console.log('— H1 seed from the real archives —');
  const r1 = await HS.run({ fetchJson, publishBatch, rawBase: RAW, env: {}, now: at(lastArchive, 12), log: quiet });
  const ix = JSON.parse(published.get(HS.OUT_DIR + '/index.json'));
  const nDays = fs.readdirSync(path.join(CORE, 'member-data/participants/daily')).filter(f => f.endsWith('.json')).length;
  ok(`seeded ${ix.days} days (${ix.first_day} → ${ix.last_day}) = the ${nDays} archived days, ${ix.wallets} wallets, one commit`, r1.status === 'ok' && ix.first_day === '2026-08-11' && ix.last_day === lastArchive && ix.days === nDays && commits === 1, { r1: r1.status, ix: [ix.first_day, ix.last_day, ix.days] });
  const P = JSON.parse(fs.readFileSync(path.join(CORE, 'member-data/participants/daily', lastArchive + '.json'), 'utf8'));
  ok(`every lock holder in the last archive has a series (${P.members.length} participants ⊆ ${ix.wallets} wallets)`, ix.wallets >= P.members.length);
  const sh = JSON.parse(published.get(`${HS.OUT_DIR}/${HS.shardOf(OWNER)}.json`));
  ok(`the owner lives in shard "${HS.shardOf(OWNER)}" (the char after terra1) with the column list`, HS.shardOf(OWNER) === 'h' && Array.isArray(sh.wallets[OWNER]) && sh.cols.join() === HS.COLS.join());
  const rows = sh.wallets[OWNER]; const C = Object.fromEntries(HS.COLS.map((c, i) => [c, i]));
  ok(`the owner has one row per archived day (${rows.length}), ascending, no duplicates`, rows.length === nDays && rows.every((r, i) => !i || r[0] > rows[i - 1][0]));

  console.log('— H2 values == the archive\'s own fields —');
  const me = P.members.find(m => m.wallet === OWNER).summary; const last = rows[rows.length - 1];
  ok(`${lastArchive}: p ${last[C.p]} == total ${me.total_portfolio_value_usd.toFixed(2)} · lk ${last[C.lk]} · lp ${last[C.lp]} · vp ${last[C.vp]} · fx ${last[C.fx]}`,
    Math.abs(last[C.p] - me.total_portfolio_value_usd) < 0.01 && Math.abs(last[C.lk] - me.total_locked_usd) < 0.01 && Math.abs(last[C.lp] - me.total_lp_position_usd) < 0.01 && Math.abs(last[C.vp] - me.voting_power_human) < 0.01 && Math.abs(last[C.fx] - me.fixed_amount_human) < 0.01 && last[C.src] === 'p');
  const V = JSON.parse(fs.readFileSync(path.join(CORE, 'votion/snapshots/daily', lastArchive + '.json'), 'utf8')); let vu = 0; for (const v of V.vaults) for (const h of v.holders || []) if (h.address === OWNER) vu += h.underlying_usd;
  ok(`Votion that day = Σ his vault holdings $${vu.toFixed(2)} (row ${last[C.vt]})`, Math.abs(last[C.vt] - vu) < 0.02);
  ok(`LUNA price that day = the archive's luna_price_used_usd (${P.luna_price_used_usd})`, Math.abs(last[C.px] - P.luna_price_used_usd) < 1e-6);

  console.log('— H3 the DAO stake once —');
  const pre = rows.find(r => r[C.cuS] === 1), post = rows.find(r => r[C.cuS] === 0);
  ok(`a day before capture-engine 1.2 (${pre && pre[0]}) carries the ampCAPA DAO stake from the CAPA supply history: cu $${pre && pre[C.cu]} flagged cuS=1, in p`, pre && pre[C.cu] > 1000);
  const D0 = pre && JSON.parse(fs.readFileSync(path.join(CORE, 'member-data/participants/daily', pre[0] + '.json'), 'utf8')).members.find(m => m.wallet === OWNER);
  ok(`  … p = the archive total $${D0 && D0.summary.total_portfolio_value_usd.toFixed(2)} + the fill $${pre && pre[C.cu]} (added once)`, pre && D0 && Math.abs(pre[C.p] - (D0.summary.total_portfolio_value_usd + pre[C.cu])) < 0.02);
  ok(`a day that carried custody keeps its own figure (cuS=0, ${post && post[0]}: $${post && post[C.cu]}) and p is the archive total unchanged`, post && Math.abs(post[C.p] - P.members.find(m => m.wallet === OWNER).summary.total_portfolio_value_usd) < 0.02 || (post && post[0] !== lastArchive));

  const hole = rows.filter(r => r[0] >= '2026-08-17' && r[0] <= '2026-08-23');
  ok(`the CAPA supply history's hole (08-10 → 08-23): 08-17 … 08-23 carry the stake held on both sides (cuS=2, ${hole.length} days) — no false $10K dip`, hole.length === 7 && hole.every(r => r[C.cuS] === 2 && r[C.cu] > 5000));
  const pr = rows.filter(r => r[C.p] != null); const blanks = rows.length - pr.length;
  let worst = 0; for (let i = 1; i < pr.length; i++) worst = Math.max(worst, Math.abs(pr[i][C.p] / pr[i - 1][C.p] - 1)); ok(`day-to-day moves in the owner's total stay under 25% (worst ${(worst * 100).toFixed(1)}%; ${blanks} day(s) blank — an LP the capture could not price)`, worst < 0.25);
  // H9 (1.2.1) the aDAO treasury 08-21 → 09-06: 16 LP rows captured, only a $0 xASTRO row unpriced — the LP band stays (flagged partial)
  { const S = await (async () => { const ix = JSON.parse(published.get(`${HS.OUT_DIR}/index.json`)); const T = 'terra1sffd4efk2jpdt894r04qwmtjqrrjfc52tmj6vkzjxqhd8qqu2drs3m5vzm'; const sh = JSON.parse(published.get(`${HS.OUT_DIR}/${HS.shardOf(T)}.json`)); return { C: Object.fromEntries(ix.cols.map((c, i) => [c, i])), rows: sh.wallets[T] || [] }; })();
    const gap = S.rows.filter(r => r[0] >= '2026-08-21' && r[0] <= '2026-09-06');
    ok(`H9 aDAO treasury 08-21 → 09-06: ${gap.length} days keep their LP value (min $${Math.min(...gap.map(r => r[S.C.lp] ?? 0))}), flagged partial on ${gap.filter(r => r[S.C.lpu] > 0).length} (was: blank)`, gap.length >= 10 && gap.every(r => r[S.C.lp] > 5000) && gap.some(r => r[S.C.lpu] > 0), gap.slice(0, 3)); }
  // H8 (1.2.0) the GMC backing wallet: its wBTC.creda.a stake was captured unpriced before 09-28 — those days are BLANK, not $0
  { const G = 'terra1jd2tam4svukk7pg8fv0dkj7zgwes9yw5c2h3wm0gkjcwdth2mpfsxxw6zd'; const gr = []; const gs = published.get(`${HS.OUT_DIR}/${HS.shardOf(G)}.json`); for (const f of gs ? [gs] : []) { const d = JSON.parse(f); if (d.wallets && d.wallets[G]) gr.push(...d.wallets[G]); }
    const before = gr.filter(r => r[0] < '2026-09-28'), after = gr.filter(r => r[0] >= '2026-09-28');
    ok(`H8 GMC backing wallet: ${before.length} days before 09-28 carry lp = blank (the stake was there, unpriced) and TLA total blank; from 09-28 the priced $${after[0] && after[0][C.lp]}`, before.length > 0 && before.every(r => r[C.lp] === null && r[C.p] === null) && after.length > 0 && after.every(r => r[C.lp] > 30000)); }
  console.log('— H4 blank beats phantom —');
  const first = rows[0]; const D1 = JSON.parse(fs.readFileSync(path.join(CORE, 'member-data/participants/daily', first[0] + '.json'), 'utf8')).members.find(m => m.wallet === OWNER);
  ok(`${first[0]}: Credia was not captured yet → cs/cb null (not 0)`, D1 && D1.summary.credia_supplied_usd === undefined ? (first[C.cs] === null && first[C.cb] === null) : true, first);
  ok(`${lastArchive}: Credia captured → cs ${last[C.cs]} (0 = captured, nothing supplied)`, last[C.cs] === 0 || last[C.cs] > 0);

  console.log('— H5 forward —');
  const n0 = commits;
  const r2 = await HS.run({ fetchJson, publishBatch, rawBase: RAW, env: {}, now: at(lastArchive, 14), log: quiet });
  ok('up to date at 14:30 → skipped, no commit', r2.status === 'skipped' && commits === n0, r2);
  const r3 = await HS.run({ fetchJson, publishBatch, rawBase: RAW, env: {}, now: at(lastArchive, 23), log: quiet });
  const rows3 = JSON.parse(published.get(`${HS.OUT_DIR}/h.json`)).wallets[OWNER];
  ok(`23:30 → today refolds in place: one commit, still ${rows3.length} rows (no duplicate day)`, r3.status === 'ok' && commits === n0 + 1 && rows3.length === rows.length && r3.folded === 1, r3.status);
  const r4 = await HS.run({ fetchJson, publishBatch, rawBase: RAW, env: { HISTORY: '0' }, now: at(lastArchive, 23), log: quiet });
  ok('HISTORY=0 → disabled', r4.status === 'skipped' && r4.reason === 'HISTORY=0');

  console.log('— H7 Solid (1.1.0) —');
  const C2 = Object.fromEntries(HS.COLS.map((c, i) => [c, i]));
  const rs = HS.rowOf('2026-09-29', { summary: { total_portfolio_value_usd: 10, solid_collateral_usd: 22946.7, solid_idle_usd: 3.3, solid_debt_usd: 7911.6 } }, 'p', null, null, 0.05);
  const rn = HS.rowOf('2026-09-29', { summary: { total_portfolio_value_usd: 10 } }, 'p', null, null, 0.05);
  ok(`a day with Solid: ss = collateral + idle (${rs[C2.ss]}), sb = debt (${rs[C2.sb]}); a day / wallet without Solid: null (not 0); the archive's own rows have no Solid yet (${rows.filter(r => r[C.ss] != null).length} with)`, rs[C2.ss] === 22950 && rs[C2.sb] === 7911.6 && rn[C2.ss] === null && rn[C2.sb] === null);
  console.log('— H6 size —');
  let tot = 0, max = 0, maxP = ''; for (const [p, c] of published) if (p.startsWith(HS.OUT_DIR)) { tot += c.length; if (c.length > max) { max = c.length; maxP = p; } }
  ok(`largest shard ${(max / 1024).toFixed(0)} KB (${maxP.split('/').pop()}), all ${(tot / 1024 / 1024).toFixed(2)} MB — a phone reads one shard`, max < 600 * 1024);
  const heap = process.memoryUsage().heapUsed / 1048576; ok(`heap after the seed ${heap.toFixed(0)} MB (< 200 cap)`, heap < 200);
  console.log(`\n${pass}/${pass + fail} passed`); process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
