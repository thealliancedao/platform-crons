'use strict';
// mock-run-pnl-zap.js — gate for pnl-positions 1.6.0: a deposit's cost is what LEFT THE WALLET (the tx's swaps undone).
// Legs are copied from real TLA zapper txs of 2026-10-14 (tla-flows events 2026/10, amounts only — no wallet), plus synthetic
// multi-hop, partial and conversion cases computed by hand.
//   Z1 zap LUNA → USDC → USDC-SOLID: provides 224.96 USDC + 0 SOLID, swap 5,000 LUNA → 224.96 USDC  ⇒ in = 5,000 LUNA, 0 USDC
//   Z2 zap LUNA → PAXG → PAXG-WBTC: in = 1,000 LUNA
//   Z3 single-sided provide with no swap (LUNA-arbLUNA, 1,250 LUNA + 0 arbLUNA): unchanged
//   Z4 optimal swap: provides 600 LUNA + 50 X, swap 400 LUNA → 50 X ⇒ 1,000 LUNA
//   Z5 multi-hop LUNA → A → B, provides 10 B ⇒ the LUNA offered at the first hop
//   Z6 part of a swap's output not provided (returned to the wallet): only the provided share counts
//   Z7 a swap whose output isn't in this basket (another pool's leg): ignored
//   Z8 exit to one token: refund 100 LUNA + 20 X, swap 20 X → 160 LUNA ⇒ out = 260 LUNA; in a conversion tx the exit stays at the refund
//   Z10/Z11 (1.7.0) start = the pool's tokens at entry: single-sided → LP × basket (D); both sides provided → the legs (M)
//   Z9 the book: a zap deposit's lot carries LUNA as its tokens in and costs the LUNA at that day's price; split pieces all see the swaps
const PP = require('./lib/pnl-positions');
let pass = 0, fail = 0; const check = (n, ok, x) => { if (ok) { pass++; console.log('  ✅ ' + n); } else { fail++; console.log('  ❌ ' + n + (x != null ? ' — ' + JSON.stringify(x) : '')); } };
const USDC = 'ibc/E8481AD838C31D4FC12A504B10F9B4E2F830F8818D2735C2FFC707579B5FA60B', SOLID = 'terra10aa3zdkrc7jwuf8ekl3zq7e7m42vmzqehcmu74e4egc7xkm5kr2s0muyst';
const PAXG = 'ibc/0EF5630576C66968EF0787868CF09FD866FAD131BC148D24A148358A85F0EB62', WBTC = 'ibc/88386AC48152D48B34B082648DF836F975506F0B57DBBFC10A54213B1BF484CB';
const ARB = 'terra1se7rvuerys4kd2snt6vqswh9wugu49vhyzls8ymc02wl37g2p2ms5yz490';
const M = (o) => new Map(Object.entries(o)); const obj = (m) => Object.fromEntries([...m].filter(([, v]) => v > 0.5).map(([k, v]) => [k, Math.round(v)]));
const sw = (offer_asset, offer_amount, ask_asset, return_amount) => ({ offer_asset, offer_amount: String(offer_amount), ask_asset, return_amount: String(return_amount) });

console.log('— undo / apply swaps —');
{ const m = M({ [USDC]: 224964636, [SOLID]: 0 }); PP.undoSwaps(m, [sw('uluna', 5000000000, USDC, 224964636)]); check('Z1 USDC-SOLID zap = 5,000 LUNA in', JSON.stringify(obj(m)) === JSON.stringify({ uluna: 5000000000 }), obj(m)); }
{ const m = M({ [PAXG]: 10634764185517760, [WBTC]: 0 }); PP.undoSwaps(m, [sw('uluna', 1000000000, PAXG, 10634764185517760)]); check('Z2 PAXG-WBTC zap = 1,000 LUNA in', JSON.stringify(obj(m)) === JSON.stringify({ uluna: 1000000000 }), obj(m)); }
{ const m = M({ uluna: 1250000000, [ARB]: 0 }); const n = PP.undoSwaps(m, []); check('Z3 single-sided, no swap: unchanged', n === 0 && obj(m).uluna === 1250000000, obj(m)); }
{ const m = M({ uluna: 600, X: 50 }); PP.undoSwaps(m, [sw('uluna', 400, 'X', 50)]); check('Z4 optimal swap → 1,000 LUNA', JSON.stringify(obj(m)) === JSON.stringify({ uluna: 1000 }), obj(m)); }
{ const m = M({ B: 10 }); PP.undoSwaps(m, [sw('native:uluna', 700, 'A', 30), sw('A', 30, 'cw20:B', 10)]); check('Z5 multi-hop unwinds to the first offer (prefixes normalised)', JSON.stringify(obj(m)) === JSON.stringify({ uluna: 700 }), obj(m)); }
{ const m = M({ X: 40, uluna: 0 }); PP.undoSwaps(m, [sw('uluna', 1000, 'X', 50)]); check('Z6 only the provided share of a swap counts (40 of 50 → 800 LUNA)', JSON.stringify(obj(m)) === JSON.stringify({ uluna: 800 }), obj(m)); }
{ const m = M({ uluna: 500, Y: 5 }); PP.undoSwaps(m, [sw('uluna', 300, 'Z', 9)]); check('Z7 a swap into another basket is ignored', JSON.stringify(obj(m)) === JSON.stringify({ uluna: 500, Y: 5 }), obj(m)); }
{ const m = M({ uluna: 100, X: 20 }); PP.applySwaps(m, [sw('X', 20, 'uluna', 160)]); check('Z8 exit to LUNA = refund after the swap (260 LUNA)', JSON.stringify(obj(m)) === JSON.stringify({ uluna: 260 }), obj(m)); }

console.log('— the book —');
const ctx = { rates: PP.finishRates(PP.newRates()), pools: PP.finishPools(PP.newPools()), priceUsd: (d) => (d === 'uluna' ? 0.045 : d === USDC ? 1 : null), lunaUsd: () => 0.045,
  amountDisplay: (d, raw) => (d === 'uluna' || d === USDC || d === SOLID || d === 'X' ? raw / 1e6 : null), symbolOf: (d) => ({ uluna: 'LUNA', [USDC]: 'USDC', [SOLID]: 'SOLID', X: 'X' })[d] };
const POOL = 'native:factory/terra1pool/uLP';
const base = { txhash: 'T1', timestamp: '2026-10-14T02:15:43Z', user: 'u', pool: POOL, mechanism: 'amplified' };
{ const book = PP.newBook();
  const e = { ...base, type: 'deposit', amount: '100', provides: [{ pair: 'p', assets: [{ denom: USDC, amount: '224964636' }, { denom: SOLID, amount: '0' }] }], cost: { swaps: [sw('uluna', 5000000000, USDC, 224964636)] }, flows: [{ type: 'deposit', mechanism: 'amplified', user: 'u', pool: POOL, amount: '100', bond_amount: '110639727' }] };
  for (const piece of PP.splitEvent(e, null, new Set())) PP.applyEvent(book, ctx, piece, new Set());
  const p = book.positions.get(PP.keyOf(POOL, 'amplified')), lot = p && p.lots[0];
  check('Z9 lot tokens in = LUNA (not USDC)', lot && lot.items.length === 1 && lot.items[0].denom === 'uluna' && Math.abs(lot.items[0].amount - 5000) < 1e-6, lot && lot.items);
  check('Z9 cost = 5,000 LUNA × $0.045 = $225 (the swap loss is in it)', lot && Math.abs(lot.in_usd - 225) < 1e-6, lot && lot.in_usd);
  check('Z9 counted as a zap in', p.zap_in === 1, p.zap_in); }
{ // conversion: withdraw pool A (refund 100 LUNA + 20 X) and provide pool B in ONE tx; the deposit piece is not the signer's first, so it has no cost.swaps
  const A = 'native:factory/terra1a/uLP', B = 'native:factory/terra1b/uLP';
  const e = { ...base, txhash: 'T2', type: 'withdraw', pool: A, amount: '50', withdraw_liqs: [{ pair: 'pa', refund_assets: [{ denom: 'uluna', amount: '100000000' }, { denom: 'X', amount: '20000000' }] }],
    provides: [{ pair: 'pb', assets: [{ denom: USDC, amount: '9000000' }, { denom: 'uluna', amount: '100000000' }] }], cost: { swaps: [sw('X', 20000000, USDC, 9000000)] },
    flows: [{ type: 'withdraw', mechanism: 'non_amplified', user: 'u', pool: A, amount: '50' }, { type: 'deposit', mechanism: 'non_amplified', user: 'u', pool: B, amount: '70' }] };
  const pieces = PP.splitEvent(e, new Map([['pa', 'factory/terra1a/uLP'], ['pb', 'factory/terra1b/uLP']]), new Set());
  check('Z9 every piece sees the tx swaps and that the tx provides', pieces.length === 2 && pieces.every((x) => x.tx_swaps && x.tx_swaps.length === 1 && x.tx_has_provide), pieces.map((x) => [x.type, !!x.tx_swaps, x.tx_has_provide]));
  const book = PP.newBook(); for (const x of pieces) PP.applyEvent(book, ctx, x, new Set());
  const pb = book.positions.get(PP.keyOf(B, 'non_amplified'));
  check('Z9 conversion: the new position\'s tokens in are the old position\'s refund (100 LUNA + 20 X), not the swapped USDC', pb && JSON.stringify(pb.lots[0].items.map((i) => [i.denom, i.amount]).sort()) === JSON.stringify([['X', 20], ['uluna', 100]]), pb && pb.lots[0].items); }
console.log('— 1.7.0 start: the pool\'s tokens at entry, both sides —');
{ // single-sided zap of 1,250 LUNA into LUNA-arbLUNA: LP minted 365.105152 (bond), pool basket 2 LUNA + 0.5 ARB per LP (raw per raw)
  const P = PP.newPools(); PP.addEpochState(P, { complete: true, epoch: 207, start_time: '2026-10-12T00:00:00Z', pairs: { [POOL]: { ok: true, total_share: '1000000', assets: [{ denom: 'uluna', amount: '2000000' }, { denom: ARB, amount: '500000' }] } } });
  const c2 = { ...ctx, pools: PP.finishPools(P), amountDisplay: (d, raw) => (d === 'uluna' || d === ARB || d === USDC || d === 'X' ? raw / 1e6 : null), priceUsd: (d) => (d === 'uluna' ? 0.045 : d === ARB ? 0.14 : 1) };
  const book = PP.newBook();
  const e = { ...base, txhash: 'T3', type: 'deposit', amount: '1', provides: [{ pair: 'p', assets: [{ denom: 'uluna', amount: '1250000000' }, { denom: ARB, amount: '0' }], share: '365105152' }], cost: { swaps: [] },
    flows: [{ type: 'deposit', mechanism: 'amplified', user: 'u', pool: POOL, amount: '1', bond_amount: '365105152' }] };
  for (const x of PP.splitEvent(e, null, new Set())) PP.applyEvent(book, c2, x, new Set());
  const lot = book.positions.get(PP.keyOf(POOL, 'amplified')).lots[0];
  const st = Object.fromEntries((lot.start || []).map((i) => [i.denom, +i.amount.toFixed(4)]));
  check('Z10 single-sided: start = LP × basket (730.2103 LUNA + 182.5526 arbLUNA), tier D; in = 1,250 LUNA', st.uluna === 730.2103 && st[ARB] === 182.5526 && lot.start_tier === 'D' && lot.items[0].amount === 1250, { st, tier: lot.start_tier, items: lot.items }); }
{ // optimal-swap zap: 1,000 LUNA → 400 swapped to 50 X, provided 600 LUNA + 50 X ⇒ in = 1,000 LUNA, start = 600 LUNA + 50 X (exact, M)
  const book = PP.newBook();
  const e = { ...base, txhash: 'T4', type: 'deposit', amount: '1', provides: [{ pair: 'p', assets: [{ denom: 'uluna', amount: '600000000' }, { denom: 'X', amount: '50000000' }] }], cost: { swaps: [sw('uluna', 400000000, 'X', 50000000)] },
    flows: [{ type: 'deposit', mechanism: 'amplified', user: 'u', pool: POOL, amount: '1', bond_amount: '77' }] };
  for (const x of PP.splitEvent(e, null, new Set())) PP.applyEvent(book, ctx, x, new Set());
  const lot = book.positions.get(PP.keyOf(POOL, 'amplified')).lots[0];
  check('Z11 two-sided after a swap: start = the provided legs (exact), in = what left the wallet', lot.start_tier === 'M' && JSON.stringify(lot.start.map((i) => [i.denom, i.amount])) === JSON.stringify([['uluna', 600], ['X', 50]]) && lot.items.length === 1 && lot.items[0].amount === 1000, { start: lot.start, items: lot.items }); }

console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
