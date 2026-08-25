// mock-run-pressure.js — gate for tla-flows/pressure.js buildPressure on REAL committed
// August 2026 flow events (first 400) + committed prices + the committed token catalog.
// Usage: TLA_CORE_DIR=/path/to/tla-core node mock-run-pressure.js
'use strict';
const fs = require('fs'), path = require('path');
const CORE = process.env.TLA_CORE_DIR; if (!CORE) { console.error('TLA_CORE_DIR required'); process.exit(1); }
const { buildPressure, epochOf } = require('./pressure.js');
const J = (p) => JSON.parse(fs.readFileSync(path.join(CORE, p), 'utf8'));
const events = J('tla-flows/events/2026/08.json'); const prices = J('price-history/2026/08.json').days; const catalog = J('token-catalog/snapshots/current.json');
let P = 0, F = 0; const check = (n, ok, x) => { if (ok) { P++; console.log('  ✓ ' + n); } else { F++; console.log('  ✗ ' + n + (x != null ? '  ← ' + JSON.stringify(x) : '')); } };
check('epoch math matches docs/epoch_1-300_date.json: epoch 200 opens 2026-08-24T00:00Z; 08-23 is 199; 08-01 is 196', epochOf('2026-08-24T00:00:00Z') === 200 && epochOf('2026-08-23T23:59:59Z') === 199 && epochOf('2026-08-01T00:05:09Z') === 196);
const { rows, unknown_denoms } = buildPressure(events, prices, catalog);
check('one row per epoch touched by August events, ascending', rows.length >= 4 && rows.every((r, i) => i === 0 || r.epoch === rows[i - 1].epoch + 1), rows.map(r => r.epoch));
const r196 = rows.find(r => r.epoch === 196);
// independent recomputation for epoch 196
const ev196 = events.filter(e => epochOf(e.timestamp) === 196);
const claimed = ev196.filter(e => e.type === 'claim').reduce((s, e) => s + (e.claims || []).reduce((a, c) => a + Number(c.reward_amount || 0), 0) + (e.claimed_coins || []).filter(c => /uluna$/.test(c.denom)).reduce((a, c) => a + Number(c.amount || 0), 0), 0) / 1e6;
const vault = ev196.filter(e => e.type === 'claim' && e.mechanism === 'amplified_vault').reduce((s, e) => s + (e.claimed_coins || []).filter(c => /uluna$/.test(c.denom)).reduce((a, c) => a + Number(c.amount || 0), 0), 0) / 1e6;
check('E196 claimed LUNA equals an independent sum of claims[].reward_amount + vault claimed_coins', Math.abs(r196.luna_rewards.claimed - claimed) < 1e-6, [r196.luna_rewards.claimed, claimed]);
check('E196 compounded = vault claims exactly; compounded + swapped + held = claimed (identity)', Math.abs(r196.luna_rewards.compounded - vault) < 1e-6 && Math.abs(r196.luna_rewards.compounded + r196.luna_rewards.swapped + r196.luna_rewards.held - r196.luna_rewards.claimed) < 1e-6, r196.luna_rewards);
check('E196 fates are percentages that sum to 100 and left_terra is null with a note (not captured, never 0)', Math.abs(r196.luna_rewards.pct_compounded + r196.luna_rewards.pct_swapped + r196.luna_rewards.pct_held - 100) < 1e-6 && r196.luna_rewards.left_terra === null && /not captured/.test(r196.luna_rewards.left_terra_note));
// a claim with an in-tx swap must count as swapped (LUNA sold) and buy the ask token
const csE = events.find(e => e.type === 'claim' && e.cost && e.cost.swaps && e.cost.swaps.some(sw => sw.offer_asset === 'uluna')); const rC = csE && rows.find(r => r.epoch === epochOf(csE.timestamp));
check('a claim that swaps LUNA in-tx: that epoch shows LUNA sold in context claim, swapped > 0, and the ask token bought', csE && rC && rC.tokens.LUNA && rC.tokens.LUNA.contexts.claim && rC.tokens.LUNA.contexts.claim.sold > 0 && rC.luna_rewards.swapped > 0 && Object.values(rC.tokens).some(t => t.contexts.claim && t.contexts.claim.bought > 0), rC && [rC.epoch, rC.luna_rewards.swapped]);
check('claim txs that zap OUT (ampLUNA → LUNA, e.g. claim + ca/withdraw + zapper/swap) count ampLUNA as sold, LUNA as bought, in context claim', rows.some(r => r.tokens.ampLUNA && r.tokens.ampLUNA.contexts.claim && r.tokens.ampLUNA.contexts.claim.sold > 0));
// zap-in adds liquidity and buys; withdraw refunds remove liquidity
check('zap-in provides count as liq_added (context zap_in); withdraw refunds as liq_removed', Object.values(r196.tokens).some(t => t.contexts.zap_in && t.contexts.zap_in.liq_added > 0) && Object.values(r196.tokens).some(t => (t.contexts.withdraw && t.contexts.withdraw.liq_removed > 0) || (t.contexts.zap_out && t.contexts.zap_out.liq_removed > 0)));
check('USD is at the day\'s committed price: LUNA bought_usd/bought ≈ a LUNA price seen in August', (() => { const t = r196.tokens.LUNA; if (!t || !(t.bought > 0)) return true; const px = t.bought_usd / t.bought; return px > 0.03 && px < 0.08; })());
check('net_pressure_usd = bought_usd − sold_usd and net_liquidity_usd = added − removed, every token', rows.every(r => Object.values(r.tokens).every(t => Math.abs(t.net_pressure_usd - (t.bought_usd - t.sold_usd)) < 1e-6 && Math.abs(t.net_liquidity_usd - (t.liq_added_usd - t.liq_removed_usd)) < 1e-6)));
check('unknown denoms are listed, not dropped (an array, possibly empty)', Array.isArray(unknown_denoms));
// a fabricated unknown denom must surface
const { unknown_denoms: u2 } = buildPressure([{ timestamp: '2026-08-05T00:00:00Z', type: 'deposit', mechanism: 'non_amplified', via_zap: true, cost: { swaps: [{ offer_asset: 'uluna', offer_amount: '1000000', ask_asset: 'terra1notacatalogtokenxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', return_amount: '5' }] } }], prices, catalog);
check('an unknown ask token is reported in unknown_denoms', u2.includes('terra1notacatalogtokenxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'));
console.log(`\n=== MOCK GATE: ${P} passed, ${F} failed ===`); process.exit(F ? 1 : 0);
