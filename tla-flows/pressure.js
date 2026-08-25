'use strict';
// tla-flows/pressure.js — v1.0 (2026-08-24)
// "Are the rewards building liquidity on Terra, or leaving?" — and the token-pressure
// question underneath it — answered from the flow events tla-flows already captures.
//
// Per epoch (7-day, genesis 2022-10-31T00:00Z, 1-indexed) this derives:
//   luna_rewards — every LUNA reward claimed via TLA, split into FATES the events prove:
//       compounded : amplified-vault claims that bond straight into ampLUNA (erishub/bond)
//       swapped    : LUNA offered in a swap inside the claim tx (rotated into another asset)
//       held       : claimed to the wallet and not swapped in that tx — still on Terra as far
//                    as this ledger can see. Whether it later left Terra is NOT captured
//                    (no IBC-out stream yet); this product never claims it is.
//   tokens — per token: bought / sold (every swap inside claim, zap-in, zap-out txs, by
//       context), liquidity added (provides) / removed (withdraw refunds, zap-out assets),
//       USD at the day's committed price. net_pressure_usd = bought − sold.
// Laws: null-vs-0 (unknown denoms are listed, never silently dropped); write-once daily
// rows (a day already committed is never rewritten); a failed read aborts, never rebuilds.
const EPOCH_GENESIS_MS = Date.parse('2022-10-31T00:00:00Z');
const EPOCH_MS = 7 * 86400e3;
const epochOf = (iso) => Math.floor((Date.parse(iso) - EPOCH_GENESIS_MS) / EPOCH_MS) + 1;
const epochStartIso = (n) => new Date(EPOCH_GENESIS_MS + (n - 1) * EPOCH_MS).toISOString();
const DEFAULT_DECIMALS = 6;

function catalogMaps(catalog) {
    // token-catalog snapshot: tokens[] of {denom, discovered:{symbol,decimals}, effective?}
    const sym = {}, dec = {};
    for (const t of (catalog && catalog.tokens) || []) {
        const s = (t.effective && t.effective.symbol) || (t.discovered && t.discovered.symbol);
        if (!t.denom || !s) continue;
        sym[t.denom] = s; sym['native:' + t.denom] = s; sym['cw20:' + t.denom] = s;
        const d = (t.effective && t.effective.decimals != null) ? t.effective.decimals : (t.discovered && t.discovered.decimals != null ? t.discovered.decimals : DEFAULT_DECIMALS);
        dec[s] = d;
    }
    if (!sym.uluna) { sym.uluna = 'LUNA'; sym['native:uluna'] = 'LUNA'; dec.LUNA = 6; }
    return { sym, dec };
}

function buildPressure(events, priceDays, catalog, opts = {}) {
    const { sym, dec } = catalogMaps(catalog);
    const strip = (d) => String(d || '').replace(/^(native|cw20):/, '');
    const symOf = (d) => sym[d] || sym[strip(d)] || null;
    const unknown = new Set();
    const usdOf = (symbol, amountRaw, day) => {
        const p = priceDays && priceDays[day] && priceDays[day][symbol] && priceDays[day][symbol].usd;
        if (!(p > 0)) return null;
        return Number(amountRaw) / 10 ** (dec[symbol] ?? DEFAULT_DECIMALS) * p;
    };
    const epochs = {};
    const E = (n) => epochs[n] || (epochs[n] = { epoch: n, from: epochStartIso(n).slice(0, 10), to: epochStartIso(n + 1).slice(0, 10), events: 0, days: new Set(),
        luna_rewards: { claimed: 0, compounded: 0, swapped: 0, held: 0, claimed_usd: 0, usd_missing_days: 0, claims: 0, claims_swapped: 0, claims_vault: 0 },
        tokens: {} });
    const tok = (ep, s) => ep.tokens[s] || (ep.tokens[s] = { bought: 0, sold: 0, liq_added: 0, liq_removed: 0, bought_usd: 0, sold_usd: 0, liq_added_usd: 0, liq_removed_usd: 0, usd_unpriced_legs: 0, contexts: {} });
    const ctxOf = (e) => e.type === 'claim' ? (e.mechanism === 'amplified_vault' ? 'vault_compound' : 'claim') : e.type === 'deposit' ? (e.via_zap ? 'zap_in' : 'deposit') : e.type === 'withdraw' ? (e.via_zap ? 'zap_out' : 'withdraw') : e.type;
    const addLeg = (ep, s, field, amountRaw, day, ctx) => {
        const t = tok(ep, s); const human = Number(amountRaw) / 10 ** (dec[s] ?? DEFAULT_DECIMALS);
        t[field] += human; const u = usdOf(s, amountRaw, day); if (u == null) t.usd_unpriced_legs++; else t[field + '_usd'] += u;
        const c = t.contexts[ctx] || (t.contexts[ctx] = { bought: 0, sold: 0, liq_added: 0, liq_removed: 0 }); c[field] += human;
    };
    for (const e of events) {
        if (!e || !e.timestamp) continue;
        const n = epochOf(e.timestamp); const ep = E(n); const day = e.timestamp.slice(0, 10); ep.events++; ep.days.add(day);
        const ctx = ctxOf(e);
        // ---- LUNA rewards and their fate ----
        if (e.type === 'claim') {
            const lr = ep.luna_rewards; lr.claims++;
            let claimed = 0;
            for (const c of e.claims || []) claimed += Number(c.reward_amount || 0);
            for (const c of e.claimed_coins || []) if (/uluna$/.test(c.denom)) claimed += Number(c.amount || 0);
            let swapped = 0;
            for (const sw of (e.cost && e.cost.swaps) || []) if (strip(sw.offer_asset) === 'uluna') swapped += Number(sw.offer_amount || 0);
            swapped = Math.min(swapped, claimed);
            if (e.mechanism === 'amplified_vault') { lr.compounded += claimed; lr.claims_vault++; }
            else { lr.swapped += swapped; lr.held += claimed - swapped; if (swapped > 0) lr.claims_swapped++; }
            lr.claimed += claimed;
            const u = usdOf('LUNA', claimed, day); if (u == null) lr.usd_missing_days++; else lr.claimed_usd += u;
        }
        // ---- swaps: sold / bought per token ----
        for (const sw of (e.cost && e.cost.swaps) || []) {
            const so = symOf(sw.offer_asset), sa = symOf(sw.ask_asset);
            if (so) addLeg(ep, so, 'sold', sw.offer_amount || 0, day, ctx); else unknown.add(strip(sw.offer_asset));
            if (sa) addLeg(ep, sa, 'bought', sw.return_amount || 0, day, ctx); else unknown.add(strip(sw.ask_asset));
        }
        // ---- liquidity added / removed per token ----
        for (const pr of e.provides || []) for (const a of pr.assets || []) { if (!(Number(a.amount) > 0)) continue; const s = symOf(a.denom); if (s) addLeg(ep, s, 'liq_added', a.amount, day, ctx); else unknown.add(strip(a.denom)); }
        for (const wl of e.withdraw_liqs || []) for (const a of wl.refund_assets || []) { if (!(Number(a.amount) > 0)) continue; const s = symOf(a.denom); if (s) addLeg(ep, s, 'liq_removed', a.amount, day, ctx); else unknown.add(strip(a.denom)); }
        for (const a of e.zap_out_assets || []) { if (!(Number(a.amount) > 0)) continue; const s = symOf(a.denom); if (s) addLeg(ep, s, 'liq_removed', a.amount, day, ctx); else unknown.add(strip(a.denom)); }
    }
    const rows = Object.values(epochs).sort((a, b) => a.epoch - b.epoch).map(ep => {
        const lr = ep.luna_rewards; const toHuman = (v) => v / 1e6;
        const out = { epoch: ep.epoch, from: ep.from, to: ep.to, events: ep.events, days_covered: ep.days.size,
            luna_rewards: { claimed: toHuman(lr.claimed), compounded: toHuman(lr.compounded), swapped: toHuman(lr.swapped), held: toHuman(lr.held), claimed_usd: lr.claimed_usd,
                pct_compounded: lr.claimed > 0 ? lr.compounded / lr.claimed * 100 : null, pct_swapped: lr.claimed > 0 ? lr.swapped / lr.claimed * 100 : null, pct_held: lr.claimed > 0 ? lr.held / lr.claimed * 100 : null,
                claims: lr.claims, claims_vault: lr.claims_vault, claims_swapped: lr.claims_swapped, usd_missing_days: lr.usd_missing_days,
                left_terra: null, left_terra_note: 'not captured — no IBC-out stream yet; "held" is an upper bound on what stayed' },
            tokens: {} };
        for (const [s, t] of Object.entries(ep.tokens)) out.tokens[s] = { ...t, net_pressure_usd: t.bought_usd - t.sold_usd, net_liquidity_usd: t.liq_added_usd - t.liq_removed_usd };
        return out;
    });
    return { rows, unknown_denoms: [...unknown].sort() };
}

// ---- duty: read committed months, derive, publish (called from the tla-flows run) ----
async function runPressure({ fetchJson, publishFile, apiGetJsonMaybe, months = 4, now = new Date(), version = 'tla-flows-pressure-1.0' }) {
    const BASE = 'https://raw.githubusercontent.com/thealliancedao/tla-core/main';
    const ym = []; for (let i = 0; i < months; i++) { const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1)); ym.push([d.getUTCFullYear(), String(d.getUTCMonth() + 1).padStart(2, '0')]); }
    const events = []; const monthsRead = [];
    for (const [y, m] of ym) { const arr = await fetchJson(`${BASE}/tla-flows/events/${y}/${m}.json?t=${Date.now()}`).catch(() => null); if (Array.isArray(arr)) { events.push(...arr); monthsRead.push(`${y}-${m}`); } }
    if (!events.length) throw new Error('pressure: no flow events readable (abort, never rebuild from nothing)');
    const priceDays = {};
    for (const [y, m] of ym) { const ph = await fetchJson(`${BASE}/price-history/${y}/${m}.json?t=${Date.now()}`).catch(() => null); Object.assign(priceDays, (ph && ph.days) || {}); }
    const catalog = await fetchJson(`${BASE}/token-catalog/snapshots/current.json?t=${Date.now()}`).catch(() => null);
    if (!catalog) throw new Error('pressure: token catalog unreadable (abort)');
    const { rows, unknown_denoms } = buildPressure(events, priceDays, catalog);
    const cur = epochOf(now.toISOString());
    const window = rows.filter(r => r.epoch >= cur - 8);
    const product = { version, generated_at: now.toISOString(), source: 'tla-flows/events (committed), price-history (day), token-catalog (symbols/decimals)', epoch_current: cur, months_read: monthsRead,
        semantics: { luna_rewards: 'every LUNA reward claimed via TLA in the epoch, split by the fate the claim tx proves: compounded (vault → ampLUNA), swapped (LUNA offered in the same tx), held (claimed, not swapped in-tx). left_terra is NOT captured.', tokens: 'bought/sold = swap legs inside claim / zap-in / zap-out txs; liq_added/removed = provide / withdraw-refund / zap-out assets. USD at the day\'s committed price; unpriced legs are counted, not valued.' },
        epochs: window, unknown_denoms };
    await publishFile('tla-flows/pressure/current.json', product, `tla-flows pressure: epochs ${window[0] ? window[0].epoch : '?'}–${cur} (${events.length} events)`);
    // daily rows: one file per epoch, write-once for CLOSED epochs (open epoch rewritten each run)
    let written = 0;
    for (const r of window) {
        const closed = r.epoch < cur; const p = `tla-flows/pressure/epochs/${r.epoch}.json`;
        if (closed && apiGetJsonMaybe) { const exists = await apiGetJsonMaybe(p); if (exists) continue; }
        await publishFile(p, { version, generated_at: now.toISOString(), closed, ...r }, `tla-flows pressure epoch ${r.epoch}${closed ? ' (closed, write-once)' : ' (open)'}`); written++;
    }
    return { epochs: window.length, written, events: events.length, unknown: unknown_denoms.length };
}

module.exports = { buildPressure, runPressure, epochOf, epochStartIso, catalogMaps };
