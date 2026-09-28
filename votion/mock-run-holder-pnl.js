'use strict';
// mock-run-holder-pnl.js — BINDING gate for votion/holder-pnl.js 1.0.0 on REAL committed data (a tla-core checkout): every Votion
// event since 2025-02, the positions snapshot, the LUNA price series, the LST ratio months, the yields product. Nothing fetched.
// Usage: TLA_CORE_DIR=<tla-core checkout> node votion/mock-run-holder-pnl.js
//   P1 every priced lot: luna_price + lst_stake + votion = usd_now − cost_usd (to 1e-6 $) — the story adds up
//   P2 every lot's vault rate at entry sits inside the vault's own sample range (no invented rates)
//   P3 vTokens: lots never exceed the holder's balance by more than rounding (FIFO withdrawals can't go negative)
//   P4 the owner test wallet: both vaults found, fully covered by deposits (coverage 100%), cost + legs printed
//   P5 across all holders: coverage reported honestly — untracked vTokens carry NO basis and are kept out of the P&L
//   P6 the realized Votion APR sits in a sane band (0–300%) and the advertised 30-day APR is attached where the product has it
//   P7 a lot with no price that day is blank with a reason, never 0
const fs = require('fs'), path = require('path');
const SRC = process.env.TLA_CORE_DIR; if (!SRC) { console.error('TLA_CORE_DIR required'); process.exit(1); }
const HP = require('./holder-pnl.js'); const C = require('../config/contracts.js');
let pass = 0, fail = 0; const check = (n, ok, x) => { if (ok) { pass++; console.log('  ✅ ' + n); } else { fail++; console.log('  ❌ ' + n + (x != null ? ' — ' + JSON.stringify(x).slice(0, 500) : '')); } };
const J = (p) => JSON.parse(fs.readFileSync(path.join(SRC, p), 'utf8'));
const events = []; for (const y of fs.readdirSync(path.join(SRC, 'votion/events')).filter(x => /^20\d\d$/.test(x))) for (const m of fs.readdirSync(path.join(SRC, 'votion/events', y)).filter(x => /^\d\d\.json$/.test(x))) { const d = J(`votion/events/${y}/${m}`); events.push(...(Array.isArray(d) ? d : Object.values(d))); }
const snap = J('votion/snapshots/current.json'); const yields = J('votion/yields/current.json'); const luna = J('price-history/series/LUNA.json').daily;
const ratioMonths = new Map(); const ratio = (day, sym) => { for (let back = 0; back <= 7; back++) { const d = new Date(Date.parse(day + 'T00:00:00Z') - back * 864e5).toISOString().slice(0, 10); const mk = d.slice(0, 7).replace('-', '/'); if (!ratioMonths.has(mk)) { try { ratioMonths.set(mk, J(`price-history/ratios/${mk}.json`).days); } catch { ratioMonths.set(mk, {}); } } const x = ratioMonths.get(mk)[d]; if (x && x[sym] && x[sym].ratio) return x[sym].ratio; } return null; };
const lunaUsd = (day) => { for (let back = 0; back <= 3; back++) { const d = new Date(Date.parse(day + 'T00:00:00Z') - back * 864e5).toISOString().slice(0, 10); if (luna[d] != null) return luna[d]; } return null; };
const lstSymbolOf = (addr) => { for (const [sym, h] of Object.entries(C.LST_HUBS)) if (h.lstDenom === addr) return sym; return null; };
const holders = new Map(); for (const v of snap.vaults) { const m = new Map(); for (const h of (v.holders || [])) m.set(h.address, h.vtoken_balance); holders.set(v.address, m); }
const advertised = (vault) => { const v = (yields.vaults || []).find(x => x.address === vault); const w = v && v.windows && (v.windows['30'] || v.windows['14'] || v.windows['7']); return w ? { apr: w.apr_daily_contract != null ? w.apr_daily_contract * 365.25 : null, apy: w.apy_contract, window_days: w.days } : null; };
const nowDay = Object.keys(luna).sort().pop();
const r = HP.build({ events, vaults: snap.vaults, holders, lunaUsd, ratio, lstSymbolOf, advertised, now: { lunaUsd: lunaUsd(nowDay), day: nowDay } });
console.log(`${events.length} events · ${Object.keys(r.holders).length} holder-vault positions · notes ${JSON.stringify(r.notes)} · LUNA now $${r.luna_usd_now} (${nowDay})`);
const H = Object.values(r.holders); const lots = H.flatMap(h => h.lots.filter(l => !l.blank));
const worst = Math.max(...lots.map(l => Math.abs(l.legs.luna_price + l.legs.lst_stake + l.legs.votion - (l.usd_now - l.cost_usd))));
check(`P1 ${lots.length} priced lots: the three legs sum to usd_now − cost (worst ${worst.toExponential(1)} $)`, lots.length > 50 && worst < 1e-6);
const series = HP.rateSeries(events); const bounds = new Map([...series].map(([v, l]) => [v, [Math.min(...l.map(x => x[1])), Math.max(...l.map(x => x[1]))]]));
const out = H.flatMap(h => h.lots.filter(l => !l.blank && l.src === 'vault_rate_at_time' && (l.v_in < bounds.get(h.vault)[0] - 1e-9 || l.v_in > bounds.get(h.vault)[1] + 1e-9)).map(l => [h.vault.slice(0, 12), l.day, l.v_in]));
check(`P2 every rate-derived entry (${lots.filter(l => l.src === 'vault_rate_at_time').length} lots) sits inside its vault's own sample range`, out.length === 0, out.slice(0, 3));
const over = H.filter(h => h.vtokens_in_lots > h.vtokens_now * 1.0001 + 1e-6); const outs = H.filter(h => h.unexplained_outflow_vtokens > 0);
check(`P3 open lots never exceed the vToken balance (${over.length} over); ${outs.length} position(s) with vTokens sent away reported as unexplained outflow (${outs.map(h => h.unexplained_outflow_vtokens.toFixed(2)).join(', ')} vT)`, over.length === 0, over.slice(0, 3).map(h => [h.wallet, h.vtokens_in_lots, h.vtokens_now]));
const ME = 'terra1hr8zsfpch47qygc96c8e6rzkd2t7mafqx77ulw'; const mine = H.filter(h => h.wallet === ME);
for (const h of mine) { const t = h.totals; if (!t) continue; console.log(`    ${h.lst_symbol} vault: in $${t.cost_usd.toFixed(2)} (${t.lst_in.toFixed(1)} ${h.lst_symbol} = ${t.luna_in.toFixed(0)} LUNA, ${t.first_day}) → now $${t.usd_now.toFixed(2)} (${t.lst_now.toFixed(1)} ${h.lst_symbol} = ${t.luna_now.toFixed(0)} LUNA) · Δ $${t.delta_usd.toFixed(2)} (${(t.delta_pct * 100).toFixed(1)}%) = LUNA price $${t.legs.luna_price.toFixed(2)} (LUNA ${(t.luna_price_pct * 100).toFixed(1)}%) + LST staking $${t.legs.lst_stake.toFixed(2)} + Votion $${t.legs.votion.toFixed(2)} · Votion APR ${(t.apr_votion * 100).toFixed(1)}% vs advertised ${h.advertised && h.advertised.apr != null ? (h.advertised.apr * 100).toFixed(1) + '%' : '—'} · LST APR ${(t.apr_lst * 100).toFixed(1)}%`); }
check(`P4 owner wallet: ${mine.length} vault positions, coverage ${mine.map(h => (h.coverage * 100).toFixed(1) + '%').join(' / ')}, both priced`, mine.length === 2 && mine.every(h => h.totals && h.coverage > 0.999));
const cov = H.filter(h => h.coverage != null); const full = cov.filter(h => h.coverage > 0.999).length; const unt = H.filter(h => h.untracked_vtokens > 0);
check(`P5 coverage: ${full}/${cov.length} positions fully explained by archived deposits; ${unt.length} carry untracked vTokens ($${unt.reduce((s, h) => s + h.untracked_usd_now, 0).toFixed(0)} valued now, no basis, outside the P&L)`, cov.length > 10 && unt.every(h => h.untracked_usd_now >= 0));
const aprs = H.filter(h => h.totals && h.totals.apr_votion != null).map(h => h.totals.apr_votion); const adv = H.filter(h => h.advertised && h.advertised.apr != null).length;
check(`P6 realized Votion APR in 0–300% for all ${aprs.length} (median ${(aprs.sort((a, b) => a - b)[aprs.length >> 1] * 100).toFixed(1)}%); advertised attached to ${adv}`, aprs.length > 0 && aprs.every(a => a >= -0.01 && a <= 3) && adv > 0, aprs.filter(a => a < -0.01 || a > 3));
const blanks = H.flatMap(h => h.lots.filter(l => l.blank));
check(`P7 ${blanks.length} blank lots, each with a reason`, blanks.every(l => l.why && l.cost_usd === undefined));
if (process.env.OUT_FILE) { fs.mkdirSync(path.dirname(process.env.OUT_FILE), { recursive: true }); fs.writeFileSync(process.env.OUT_FILE, JSON.stringify({ meta: { version: 'local (mock-run-holder-pnl)', engine: HP.VERSION, events_read: events.length, luna_usd_now: r.luna_usd_now, notes: r.notes }, holders: r.holders })); console.log('  wrote ' + process.env.OUT_FILE); }   // the page gate reads this
console.log(`\n${pass}/${pass + fail} passed`); process.exit(fail ? 1 : 0);
