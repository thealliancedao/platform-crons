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
const VERSION = 'supporters-1.2';   // 1.2 (2026-09-20, owner): TARGETS from tla-core/docs/curated/supporters.json — the builder's wallet (current.json) plus every ally treasury (thanks_adao / thanks_liondao / thanks_pixel_lions), each walked by its own memo into its own product; the registry line is the whole switch   // 1.1 (2026-09-10): LCD answer visible in the log (rows/newest height/memo hits); second event key (coin_received.receiver) when transfer.recipient answers empty

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
// 1.1: the owner's 2026-09-10 test gift (50 LUNA, memo thanks_defi, block 22778110) did not appear after two hourly
// runs while the parser accepts that exact tx — so the LCD event search must be answering empty. Two changes: every
// answer is logged (rows, newest height, memo hits) so the log says WHY, and an empty first page under
// transfer.recipient is retried under coin_received.receiver (same event, the key some indexers serve instead).
const EVENT_KEYS = ['transfer.recipient', 'coin_received.receiver'];
async function fetchPage(fetchJson, offsetOrKey, params, log = console, addr = ADDR) {   // 1.2: per target address
    let empty = null;
    for (const key of EVENT_KEYS) {
        for (const lcd of LCDS) for (const p of ['events', 'query']) {
            const u = `${lcd}/cosmos/tx/v1beta1/txs?${p}=${encodeURIComponent(key)}%3D%27${addr}%27&order_by=ORDER_BY_DESC&limit=100${params}`;
            try {
                const r = await fetchJson(u);
                if (r && Array.isArray(r.tx_responses)) {
                    const n = r.tx_responses.length, newest = n ? r.tx_responses[0].height : null;
                    log.log(`  supporters: ${key} via ${new URL(lcd).host} (${p}) → ${n} tx${n === 1 ? '' : 's'}${newest ? `, newest height ${newest}` : ''}`);
                    if (n) return r;
                    empty = empty || r;   // an honest empty answer — keep it, but try the other key first
                }
            } catch (e) { /* next */ }
        }
    }
    return empty;
}
const DEFAULT_TARGETS = [{ key: 'defi', label: 'The builder (DeFi_Patriot)', kind: 'builder', address: ADDR, memo: MEMO, product: PRODUCT }];
const REGISTRY = 'docs/curated/supporters.json';
async function runTarget(t, { fetchJson, readProduct, publish, log = console }) {
    const existing = await readProduct(t.product).catch(() => null);
    const lastHeight = existing && existing.gifts && existing.gifts.length ? existing.gifts[0].height : 0;
    let gifts = [], page = 0, done = false;
    while (!done && page < 20) {                       // ≤ 2,000 newest transfers per run; the product carries the rest
        const r = await fetchPage(fetchJson, null, page ? `&page=${page + 1}` : '', log, t.address);
        if (!r) { if (page === 0) throw new Error('LCD tx search unavailable on every endpoint'); break; }
        const found = extractGifts(r, t.address, t.memo); gifts = gifts.concat(found);
        if (page === 0) log.log(`  supporters[${t.key}]: page 1 → ${found.length} tx${found.length === 1 ? '' : 's'} with memo "${t.memo}" (last committed height ${lastHeight})`);
        const heights = (r.tx_responses || []).map(x => Number(x.height));
        if (!heights.length || Math.min(...heights) <= lastHeight || (r.tx_responses || []).length < 100) done = true;
        page++;
    }
    const { product, added } = merge(existing, gifts);
    product.address = t.address; product.memo = t.memo; product.target = { key: t.key, label: t.label, kind: t.kind, tenant: t.tenant || null };   // 1.2: the product says whose gifts these are
    if (added || !existing) await publish(t.product, product, `supporters[${t.key}]: +${added} (${product.count} gifts, ${product.supporters} supporters)`);
    log.log(`  supporters[${t.key}]: walked ${page} page(s), +${added} new, ${product.count} total from ${product.supporters} supporters`);
    return { key: t.key, added, count: product.count };
}
// 1.2: every target of the curated registry (tla-core/docs/curated/supporters.json), the builder's wallet as the fallback
// when the registry is unreadable. Targets are isolated — one failing LCD walk never blocks the others.
async function run({ fetchJson, readProduct, publish, log = console, readRegistry }) {
    let targets = DEFAULT_TARGETS;
    try { const reg = readRegistry ? await readRegistry() : await readProduct(REGISTRY); if (reg && Array.isArray(reg.targets) && reg.targets.length) targets = reg.targets.filter(t => t && t.address && t.memo && t.product && t.key); } catch (e) { log.log('  supporters: registry unreadable (' + e.message + ') — builder wallet only'); }
    const out = [];
    for (const t of targets) { try { out.push(await runTarget(t, { fetchJson, readProduct, publish, log })); } catch (e) { log.log(`  supporters[${t.key}] failed (isolated): ${e.message}`); out.push({ key: t.key, error: e.message }); } }
    return { targets: out, added: out.reduce((s, x) => s + (x.added || 0), 0), count: out.reduce((s, x) => s + (x.count || 0), 0) };
}
module.exports = { extractGifts, merge, run, runTarget, ADDR, MEMO, PRODUCT, REGISTRY, DEFAULT_TARGETS, VERSION };
