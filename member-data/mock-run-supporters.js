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
  // 1.2: the curated registry drives the targets — the builder's wallet + an ally treasury, each walked by its own memo
  const LION = 'terra1tkersa2mqwy2h8exj799qx2xrhdu0dkymk9psp6v0k4kz4tkxucssgluec';
  const sendTo = (from, to, amt) => ({ '@type': '/cosmos.bank.v1beta1.MsgSend', from_address: from, to_address: to, amount: [{ denom: 'uluna', amount: String(amt) }] });
  const byAddr = { [ADDR]: mk([tx('R1', 900, 'thanks_defi', [sendTo('terra1amy', ADDR, 1000000)])]), [LION]: mk([tx('R2', 901, 'thanks_liondao', [sendTo('terra1ben', LION, 2000000)]), tx('R3', 899, 'thanks_defi', [sendTo('terra1cal', LION, 5)])]) };
  const pub = {}; const fetch2 = async (u) => { const a = (u.match(/%27(terra1[a-z0-9]+)%27/) || [])[1]; if (!/terra-lcd\.publicnode\.com/.test(u) || !/events=/.test(u)) throw new Error('nope'); return byAddr[a] || mk([]); };
  const reg = { targets: [{ key: 'defi', label: 'builder', kind: 'builder', address: ADDR, memo: 'thanks_defi', product: 'member-data/supporters/current.json' }, { key: 'liondao', label: 'Lion DAO treasury', kind: 'ally', tenant: 'liondao', address: LION, memo: 'thanks_liondao', product: 'member-data/supporters/liondao.json' }] };
  const r2 = await run({ fetchJson: fetch2, readProduct: async (p) => (p === 'docs/curated/supporters.json' ? reg : null), publish: async (p, obj) => { pub[p] = obj; }, log: { log() {} } });
  check('1.2 registry: two targets walked, two products published, each with its own address + memo + target block', r2.targets.length === 2 && pub['member-data/supporters/current.json'] && pub['member-data/supporters/liondao.json'] && pub['member-data/supporters/liondao.json'].address === LION && pub['member-data/supporters/liondao.json'].memo === 'thanks_liondao' && pub['member-data/supporters/liondao.json'].target.key === 'liondao', Object.keys(pub));
  check('1.2 a gift to the treasury with the WRONG memo (thanks_defi sent to Lion DAO) is not counted for either target', pub['member-data/supporters/liondao.json'].count === 1 && pub['member-data/supporters/liondao.json'].gifts[0].tx_hash === 'R2' && pub['member-data/supporters/current.json'].count === 1, [pub['member-data/supporters/liondao.json'].gifts.map(g => g.tx_hash), pub['member-data/supporters/current.json'].gifts.map(g => g.tx_hash)]);
  const r3 = await run({ fetchJson: fetch2, readProduct: async (p) => { if (p === 'docs/curated/supporters.json') throw new Error('404'); return null; }, publish: async (p, obj) => { pub[p] = obj; }, log: { log() {} } });
  check('1.2 registry unreadable → the builder wallet alone (never silent, never nothing)', r3.targets.length === 1 && r3.targets[0].key === 'defi');
  console.log(`\n=== MOCK GATE: ${P} passed, ${F} failed ===`); process.exit(F ? 1 : 0);
})();
