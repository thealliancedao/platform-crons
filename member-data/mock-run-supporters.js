// mock-run-supporters.js — gate for supporters.js: extract (memo filter, bank + cw20, failed tx dropped),
// write-once/never-shrink merge, paging stops at the last committed height. Synthetic LCD fixture (the
// sandbox cannot reach the LCD); shapes follow the SDK 0.47 tx-search response.
'use strict';
const { extractGifts, merge, run, ADDR } = require('./supporters.js');
let P = 0, F = 0; const check = (n, ok, x) => { if (ok) { P++; console.log('  ✓ ' + n); } else { F++; console.log('  ✗ ' + n + (x != null ? '  ← ' + JSON.stringify(x) : '')); } };
const tx = (hash, height, memo, msgs, code = 0) => ({ tr: { txhash: hash, height: String(height), timestamp: '2026-08-26T01:00:00Z', code }, body: { memo, messages: msgs } });
const send = (from, amt, denom = 'uluna') => ({ '@type': '/cosmos.bank.v1beta1.MsgSend', from_address: from, to_address: ADDR, amount: [{ denom, amount: String(amt) }] });
const cw = (from, contract, amt) => ({ '@type': '/cosmwasm.wasm.v1.MsgExecuteContract', sender: from, contract, msg: { transfer: { recipient: ADDR, amount: String(amt) } } });
const mk = (list) => ({ txs: list.map(x => ({ body: x.body })), tx_responses: list.map(x => x.tr) });
const fx = mk([tx('A', 300, 'thanks_defi', [send('terra1alice', 5000000)]), tx('B', 299, 'THANKS_DEFI ', [cw('terra1bob', 'terra1capa', 100000000)]), tx('C', 298, 'gm', [send('terra1carol', 1000000)]), tx('D', 297, 'thanks_defi', [send('terra1dave', 1000000)], 5), tx('E', 296, 'thanks_defi', [send('terra1alice', 2000000, 'ibc/ABC')])]);
const g = extractGifts(fx);
check('extract: only the memo (case/space-insensitive), bank + cw20 shapes, failed tx (code 5) dropped, other memos ignored', g.length === 3 && g.map(x => x.tx_hash).join('') === 'ABE' && g[1].kind === 'cw20' && g[1].denom === 'cw20:terra1capa' && g[0].amount_raw === '5000000', g);
const m1 = merge(null, g);
check('merge into an empty product: 3 gifts, 2 supporters, newest first', m1.added === 3 && m1.product.count === 3 && m1.product.supporters === 2 && m1.product.gifts[0].tx_hash === 'A');
const m2 = merge(m1.product, g.concat(extractGifts(mk([tx('F', 301, 'thanks_defi', [send('terra1erin', 1)])]))));
check('merge again: committed rows untouched, one new row added, ordered by height', m2.added === 1 && m2.product.count === 4 && m2.product.gifts[0].tx_hash === 'F');
let threw = false; try { merge({ gifts: m2.product.gifts }, []); } catch (e) { threw = false; } check('never-shrink: re-merging nothing keeps all rows (no throw, no loss)', !threw && merge({ gifts: m2.product.gifts }, []).product.count === 4);
(async () => {
  // paging: page 1 all newer than the committed height → keep going; page 2 reaches it → stop
  const pages = { '': mk(Array.from({ length: 100 }, (_, i) => tx('P1-' + i, 1000 - i, i === 3 ? 'thanks_defi' : 'x', [send('terra1zed', 7)]))), '&page=2': mk([tx('P2', 500, 'thanks_defi', [send('terra1zed', 8)]), tx('P2b', 290, 'thanks_defi', [send('terra1old', 9)])]) };
  const calls = []; const fetchJson = async (u) => { calls.push(u); const k = (u.match(/&page=\d+/) || [''])[0]; if (!/terra-lcd\.publicnode\.com/.test(u) || !/events=/.test(u)) throw new Error('nope'); return pages[k]; };
  let published = null; const res = await run({ fetchJson, readProduct: async () => m2.product, publish: async (p, obj) => { published = obj; }, log: { log() {} } });
  check('run: walks pages until a tx at or below the last committed height (301), adds the 3 new memo gifts, publishes once, keeps the 4 old rows', res.added === 3 && published && published.count === 7 && calls.length >= 2, [res, published && published.count, calls.length]);
  console.log(`\n=== MOCK GATE: ${P} passed, ${F} failed ===`); process.exit(F ? 1 : 0);
})();
