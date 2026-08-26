'use strict';
// member-data/supporters.js — v1.0 (2026-08-26, owner request)
// The permanent record behind supporters.html: every transfer into the builder's wallet that carries the memo
// "thanks_defi", walked from the chain (LCD tx search, newest first, paged until the last known tx), merged
// WRITE-ONCE / NEVER-SHRINK into member-data/supporters/current.json. The page reads this product first and
// only falls back to a live LCD read when it is missing. Names are NOT resolved here (the page names senders
// from the public address catalog at render time — pattern ≠ identity). Isolated: a failure never blocks the
// rest of member-data.
const ADDR = 'terra1hr8zsfpch47qygc96c8e6rzkd2t7mafqx77ulw';
const MEMO = 'thanks_defi';
const LCDS = ['https://terra-lcd.publicnode.com', 'https://terra.publicnode.com'];
const PRODUCT = 'member-data/supporters/current.json';
const VERSION = 'supporters-1.0';

// pure: LCD /cosmos/tx/v1beta1/txs response → gifts [{tx_hash, height, ts, from, denom, amount_raw, kind}]
function extractGifts(resp, addr = ADDR, memo = MEMO) {
    const out = [];
    const txs = (resp && resp.txs) || [], trs = (resp && resp.tx_responses) || [];
    trs.forEach((tr, i) => {
        const body = (txs[i] && txs[i].body) || (tr.tx && tr.tx.body) || {};
        if (String(body.memo || '').trim().toLowerCase() !== memo) return;
        if (tr.code && Number(tr.code) !== 0) return;   // failed tx
        for (const m of body.messages || []) {
            const t = m['@type'] || '';
            if (/MsgSend$/.test(t) && m.to_address === addr) for (const c of m.amount || []) out.push({ tx_hash: tr.txhash, height: Number(tr.height), ts: tr.timestamp, from: m.from_address, denom: c.denom, amount_raw: String(c.amount), kind: 'bank' });
            else if (/MsgExecuteContract$/.test(t)) { const msg = m.msg || {}; const tf = msg.transfer || (msg.send && msg.send.contract === addr ? msg.send : null); if (tf && (tf.recipient === addr || tf.contract === addr)) out.push({ tx_hash: tr.txhash, height: Number(tr.height), ts: tr.timestamp, from: m.sender, denom: 'cw20:' + m.contract, amount_raw: String(tf.amount), kind: 'cw20' }); }
        }
    });
    return out;
}
// pure: merge new gifts into an existing product — never drops a committed row, never rewrites one
function merge(existing, gifts, now = new Date()) {
    const rows = Array.isArray(existing && existing.gifts) ? existing.gifts.slice() : [];
    const seen = new Set(rows.map(g => g.tx_hash + '|' + g.denom + '|' + g.amount_raw + '|' + g.from));
    let added = 0;
    for (const g of gifts) { const k = g.tx_hash + '|' + g.denom + '|' + g.amount_raw + '|' + g.from; if (seen.has(k)) continue; seen.add(k); rows.push(g); added++; }
    rows.sort((a, b) => b.height - a.height);
    if (existing && Array.isArray(existing.gifts) && rows.length < existing.gifts.length) throw new Error('never-shrink: merged fewer rows than committed');
    return { product: { version: VERSION, address: ADDR, memo: MEMO, generated_at: now.toISOString(), count: rows.length, supporters: new Set(rows.map(r => r.from)).size, method: 'LCD tx search transfer.recipient=<address>, newest first, paged back to the last committed height; only txs whose memo equals the tag and whose code is 0; bank MsgSend amounts and cw20 transfers to the address; write-once per (tx, denom, amount, sender); never-shrink.', gifts: rows }, added };
}
async function fetchPage(fetchJson, offsetOrKey, params) {
    for (const lcd of LCDS) for (const p of ['events', 'query']) {
        const u = `${lcd}/cosmos/tx/v1beta1/txs?${p}=transfer.recipient%3D%27${ADDR}%27&order_by=ORDER_BY_DESC&limit=100${params}`;
        try { const r = await fetchJson(u); if (r && Array.isArray(r.tx_responses)) return r; } catch (e) { /* next */ }
    }
    return null;
}
async function run({ fetchJson, readProduct, publish, log = console }) {
    const existing = await readProduct(PRODUCT).catch(() => null);
    const lastHeight = existing && existing.gifts && existing.gifts.length ? existing.gifts[0].height : 0;
    let gifts = [], page = 0, done = false;
    while (!done && page < 20) {                       // ≤ 2,000 newest transfers per run; the product carries the rest
        const r = await fetchPage(fetchJson, null, page ? `&page=${page + 1}` : '');
        if (!r) { if (page === 0) throw new Error('LCD tx search unavailable on every endpoint'); break; }
        gifts = gifts.concat(extractGifts(r));
        const heights = (r.tx_responses || []).map(t => Number(t.height));
        if (!heights.length || Math.min(...heights) <= lastHeight || (r.tx_responses || []).length < 100) done = true;
        page++;
    }
    const { product, added } = merge(existing, gifts);
    if (added || !existing) await publish(PRODUCT, product, `supporters: +${added} (${product.count} gifts, ${product.supporters} supporters)`);
    log.log(`  supporters: walked ${page} page(s), +${added} new, ${product.count} total from ${product.supporters} supporters`);
    return { added, count: product.count };
}
module.exports = { extractGifts, merge, run, ADDR, MEMO, PRODUCT };
