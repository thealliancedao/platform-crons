'use strict';
// mock-run-singles.js — BINDING gate for capture-engine 1.2.1 amplifiedPosition() on REAL committed data (a tla-core checkout): the TLA
// snapshot pools, network-and-prices, the participants product's own amplified rows. Nothing fetched.
// Usage: TLA_CORE_DIR=<tla-core checkout> node member-data/mock-run-singles.js
//   S1 the GMC BTC Backing Treasury's wBTC.creda.a backing (read "unknown, $0" before): found by gauge id, named, active, valued
//      user_lp × staked_in_tla_usd ÷ underlying — decimals-free
//   S2 that implied price per whole token (8 decimals) agrees with the token catalog's wBTC.creda.a price (±2 %) — no 100× error
//   S3 a 6-decimal single (ampCAPA) keeps its symbol-price path, same value as before
//   S4 amplified LP-pair rows: recomputed = the value the hourly read wrote (±1 %) — the fix moves nothing else
//   S5 every amplified row the hourly read left "unknown" with no pool now resolves to a pool
const fs = require('fs'), path = require('path');
const SRC = process.env.TLA_CORE_DIR; if (!SRC) { console.error('TLA_CORE_DIR required'); process.exit(1); }
const E = require('../lib/capture-engine.js');
let pass = 0, fail = 0; const check = (n, ok, x) => { if (ok) { pass++; console.log('  ✅ ' + n); } else { fail++; console.log('  ❌ ' + n + (x != null ? ' — ' + JSON.stringify(x).slice(0, 400) : '')); } };
const J = (p) => JSON.parse(fs.readFileSync(path.join(SRC, p), 'utf8'));
const snap = J('member-data/tla-snapshot/current.json'), np = J('network-and-prices/current.json'), part = J('member-data/participants/current.json'), cat = J('token-catalog/snapshots/current.json');
const poolByLpAddr = new Map(), poolByGaugeId = new Map();
for (const p of snap.pools || []) { if (p.lp_address) poolByLpAddr.set(p.lp_address.toLowerCase(), p); if (p.gauge_pool_id) poolByGaugeId.set(p.gauge_pool_id, p); }
const ctx = { tokenPrices: np.token_prices || {}, poolByLpAddr, poolByGaugeId, lunaPriceUsd: np.token_prices.LUNA.final_price_usd };
const assetOf = (gid) => gid && gid.startsWith('cw20:') ? { cw20: gid.slice(5) } : gid ? { native: gid.slice(7) } : null;
const A = 'terra1jjvy4s4tyw3ym6s3wk896up6jthvha9vtwaetah3z33sd788lttswhrcpc', GMC = 'terra1jd2tam4svukk7pg8fv0dkj7zgwes9yw5c2h3wm0gkjcwdth2mpfsxxw6zd';
const g = part.members.find(m => m.wallet === GMC); const gr = g && g.lp_positions.find(l => l.is_amplified && l.user_lp_raw);
const P1 = E.amplifiedPosition({ asset: { cw20: A }, user_lp: gr.user_lp_raw, user_amplp: gr.user_amplp_raw, total_lp: gr.compounder_total_lp, total_amplp: gr.compounder_total_amplp }, 'single', ctx);
const pool = poolByGaugeId.get('cw20:' + A); const want = Number(gr.user_lp_raw) * pool.staked_in_tla_usd / pool.amp_lp.underlying_lp_amount;
check(`S1 GMC BTC Backing Treasury: ${gr.user_lp_raw} raw wBTC.creda.a (${(gr.user_lp_raw / 1e8).toFixed(4)} tokens) → ${P1.pool_name} (${P1.status || 'status?'}), $${P1.estimated_position_usd && P1.estimated_position_usd.toFixed(2)}`,
  P1.pool_name === 'wBTC.creda.a' && P1.pool_gauge_id === 'cw20:' + A && Math.abs(P1.estimated_position_usd - want) < 1e-6 && /decimals-free/.test(P1.price_source), P1);
const tk = cat.tokens.find(x => x.denom === A || x.denom === 'cw20:' + A); const catPx = tk.prices.tla.usd; const implied = pool.staked_in_tla_usd / pool.amp_lp.underlying_lp_amount * 1e8;
check(`S2 implied $${implied.toFixed(0)} per wBTC.creda.a (8 dec) vs the catalog's $${catPx.toFixed(0)} — within 2 %`, Math.abs(implied / catPx - 1) < 0.02);
const ampRow = part.members.flatMap(m => m.lp_positions).find(l => l.is_amplified && l.pool_name === 'ampCAPA' && l.user_lp_raw && l.estimated_position_usd);
if (ampRow) { const P3 = E.amplifiedPosition({ asset: assetOf(ampRow.pool_gauge_id), user_lp: ampRow.user_lp_raw, user_amplp: ampRow.user_amplp_raw, total_lp: ampRow.compounder_total_lp, total_amplp: ampRow.compounder_total_amplp }, 'single', ctx);
  const exp = Number(ampRow.user_lp_raw) / 1e6 * ctx.tokenPrices.ampCAPA.final_price_usd;
  check(`S3 ampCAPA single keeps the symbol path: $${P3.estimated_position_usd.toFixed(2)} (token_prices[ampCAPA], 6 dec)`, /token_prices\[ampCAPA\]/.test(P3.price_source) && Math.abs(P3.estimated_position_usd - exp) < 1e-6, P3); }
else console.log('  (no ampCAPA amplified row in the hourly read — S3 skipped)');
let n = 0, off = []; for (const m of part.members) for (const l of m.lp_positions) { if (!l.is_amplified || !l.pool_gauge_id || !l.estimated_position_usd || l.estimated_position_usd < 10) continue; const p = poolByGaugeId.get(l.pool_gauge_id); if (!p || !p.lp_health) continue;
  const R = E.amplifiedPosition({ asset: assetOf(l.pool_gauge_id), user_lp: l.user_lp_raw, user_amplp: l.user_amplp_raw, total_lp: l.compounder_total_lp, total_amplp: l.compounder_total_amplp }, l.bucket, ctx); n++; if (!(R.estimated_position_usd > 0) || Math.abs(R.estimated_position_usd / l.estimated_position_usd - 1) > 0.01) off.push([m.wallet.slice(-6), l.pool_name, l.estimated_position_usd, R.estimated_position_usd]); }
check(`S4 ${n} amplified LP-pair rows recompute to the hourly read's value (±1 %) — ${off.length} off`, n > 20 && off.length === 0, off.slice(0, 4));
const unk = part.members.flatMap(m => m.lp_positions.filter(l => l.is_amplified && !l.pool_gauge_id && l.status === 'unknown').map(l => ({ w: m.wallet, l })));
const res = unk.map(({ w, l }) => { const cands = [...poolByGaugeId.values()].filter(p => p.is_single && p.bucket === l.bucket); const hit = cands.map(p => E.amplifiedPosition({ asset: assetOf(p.gauge_pool_id), user_lp: l.user_lp_raw, user_amplp: l.user_amplp_raw, total_lp: l.compounder_total_lp, total_amplp: l.compounder_total_amplp }, l.bucket, ctx)).find(r => r.pool_name && Number(r.compounder_total_lp) === Number(l.compounder_total_lp));
  return hit ? hit.pool_name : null; });
check(`S5 ${unk.length} "unknown" amplified rows in the hourly read: each belongs to a single gauge the engine now finds (${[...new Set(res)].join(', ')})`, unk.length > 0 && res.every(Boolean), res);
console.log(`\n${pass}/${pass + fail} passed`); process.exit(fail ? 1 : 0);
