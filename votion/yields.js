'use strict';
// =============================================================================
// org-votion — Branch D: YIELDS (2026-08-26, "New Here? → TLA" data layer)
//
// Reproduces the number Eris shows (their words, 2026-08-26): Votion APY is the
// vault's own on-chain `exchange_rates` growth from compounding; the contract
// returns the per-day series for `limit` days AND an `apr` for that range (a
// DAILY rate); APY = (1 + apr)^365.25 − 1; the headline is asset APY + Votion
// APY. "Asset APY" is the same query on the underlying LST hub. Windows 7/14/30
// (they recommend ≥14–30 for Votion).
//
// Two numbers per window, both published: the contract's `apr` (Eris's) and
// our own measurement from the series endpoints (rate_end/rate_start over the
// measured span). `agree` flags them within AGREE_PP percentage points of APY.
// Never a single unverifiable figure.
//
// Sources, labeled per asset: `hub_exchange_rates` (chain, primary) →
// `ratio_series` (price-history/ratios daily, labeled fallback, staleness
// stated) → null. Native staking APR is an ESTIMATE: the ampLUNA net daily rate
// grossed up by the hub's configured protocol reward fee — method and fee
// published; the SmartStake CSV stays the human reference (gate #0).
//
// Pure function over the T seam (queryContract) + a series reader; the mock
// gate drives it with synthetic constant-growth series where contract apr and
// measured apr must coincide to 1e-9.
// =============================================================================

const DAYS_IN_YEAR = 365.25;
const WINDOWS = [7, 14, 30];
const AGREE_PP = 0.5;                // APY agreement tolerance, percentage points
const RATIO_STALE_DAYS = 2;

const num = (x) => { const n = Number(x); return Number.isFinite(n) ? n : null; };
const round = (x, d = 6) => (x == null ? null : Math.round(x * 10 ** d) / 10 ** d);
const apyOfDaily = (aprDaily) => (aprDaily == null ? null : Math.pow(1 + aprDaily, DAYS_IN_YEAR) - 1);
const tsMs = (t) => { if (t == null) return null; if (typeof t === 'number') return t < 1e12 ? t * 1000 : t; const n = Number(t); if (Number.isFinite(n)) return n < 1e12 ? n * 1000 : n; const p = Date.parse(t); return Number.isFinite(p) ? p : null; };

// exchange_rates response → [{t_ms, rate}] ascending.
// REAL SHAPE (chainscope, arbluna-max, 2026-08-26): { exchange_rates: [[day_index, { exchange_rate, time_s }], …] (newest first), apr }
// where day_index = days since 1970 (20691 → 2026-08-26) and time_s is the sample's unix time. Also tolerates
// [[t, rate]] (the ampLUNA hub's own exchange_rates shape) and [{time, rate}].
function parseSeries(res) {
    const arr = Array.isArray(res) ? res : (res && (res.exchange_rates || res.rates || res.history)) || [];
    const pts = [];
    for (const p of arr) {
        if (Array.isArray(p)) {
            if (p[1] && typeof p[1] === 'object') { const r = num(p[1].exchange_rate ?? p[1].rate); const t = p[1].time_s != null ? tsMs(p[1].time_s) : (num(p[0]) != null ? num(p[0]) * 86400000 : null); if (t != null && r != null) pts.push({ t_ms: t, rate: r }); }
            else { const t = tsMs(p[0]), r = num(p[1]); if (t != null && r != null) pts.push({ t_ms: t, rate: r }); }
        }
        else if (p && typeof p === 'object') { const t = tsMs(p.time ?? p.timestamp ?? p.t ?? p.time_s), r = num(p.rate ?? p.exchange_rate ?? p.value); if (t != null && r != null) pts.push({ t_ms: t, rate: r }); }
    }
    pts.sort((a, b) => a.t_ms - b.t_ms);
    return pts;
}

// One window from a series (+ optional contract apr).
// CONTRACT DEFINITION (pinned on the real arbluna-max series 2026-08-26, exact to 1e-18):
//   apr = (rate_end / rate_start − 1) / span_days, span from time_s — a SIMPLE daily rate over the window.
// `apr_daily_measured` reproduces that definition from the same endpoints (so agree ⇒ we read the same series);
// `apr_daily_geometric` is the true compounded daily rate ((end/start)^(1/span) − 1) — published beside it, not instead.
function windowFromSeries(pts, contractAprDaily, days, source) {
    if (!pts || pts.length < 2) return { days, source, points: pts ? pts.length : 0, rate_start: pts && pts[0] ? pts[0].rate : null, rate_end: pts && pts[pts.length - 1] ? pts[pts.length - 1].rate : null, span_days: null, apr_daily_contract: contractAprDaily, apr_daily_measured: null, apr_daily_geometric: null, apy_contract: round(apyOfDaily(contractAprDaily)), apy_measured: null, apy_geometric: null, agree: null };
    const first = pts[0], last = pts[pts.length - 1];
    const span = (last.t_ms - first.t_ms) / 86400000;
    const measured = span > 0 && first.rate > 0 ? (last.rate / first.rate - 1) / span : null;
    const geometric = span > 0 && first.rate > 0 ? Math.pow(last.rate / first.rate, 1 / span) - 1 : null;
    const apyC = apyOfDaily(contractAprDaily), apyM = apyOfDaily(measured), apyG = apyOfDaily(geometric);
    return {
        days, source, points: pts.length, rate_start: first.rate, rate_end: last.rate, span_days: round(span, 5),
        apr_daily_contract: contractAprDaily == null ? null : round(contractAprDaily, 12), apr_daily_measured: measured == null ? null : round(measured, 12), apr_daily_geometric: geometric == null ? null : round(geometric, 12),
        apy_contract: round(apyC), apy_measured: round(apyM), apy_geometric: round(apyG),
        agree: (apyC != null && apyM != null) ? Math.abs(apyC - apyM) * 100 <= AGREE_PP : null,
    };
}

// Series from price-history/ratios daily files (fallback) — readMonth(yyyy, mm) → { days: { 'YYYY-MM-DD': { <sym>: { ratio } } } } | null
async function ratioSeriesWindow(sym, days, readMonth, nowMs) {
    const pts = [];
    const d = new Date(nowMs); const months = [];
    for (let i = 0; i < 3; i++) { const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1; months.unshift([y, String(m).padStart(2, '0')]); d.setUTCMonth(d.getUTCMonth() - 1); }
    for (const [y, m] of months) { const doc = await readMonth(y, m).catch(() => null); const dd = doc && (doc.days || doc); if (!dd || typeof dd !== 'object') continue;
        for (const [day, row] of Object.entries(dd)) { const r = row && row[sym] && num(row[sym].ratio); if (r != null) pts.push({ t_ms: Date.parse(day + 'T00:00:00Z'), rate: r }); } }
    pts.sort((a, b) => a.t_ms - b.t_ms);
    if (!pts.length) return { pts: [], stale_days: null };
    const cutoff = nowMs - days * 86400000;
    const win = pts.filter(p => p.t_ms >= cutoff - 86400000);
    const stale = (nowMs - pts[pts.length - 1].t_ms) / 86400000;
    return { pts: win, stale_days: round(stale, 1) };
}

async function assetYields(sym, hubAddr, T, readMonth, nowMs, errors) {
    const out = { symbol: sym, hub: hubAddr || null, source: null, stale_days: null, windows: {} };
    let hubOk = false;
    if (hubAddr) {
        for (const w of WINDOWS) {
            try {
                const res = await T.queryContract(hubAddr, { exchange_rates: { limit: w } });
                const pts = parseSeries(res); if (pts.length < 2) throw new Error(`exchange_rates(limit ${w}) returned ${pts.length} points`);
                out.windows[w] = windowFromSeries(pts, res && res.apr != null ? num(res.apr) : null, w, 'hub_exchange_rates'); hubOk = true;
            } catch (e) { errors.push({ where: `yields:${sym}:hub:${w}d`, error: e.message }); break; }
        }
    }
    if (hubOk) { out.source = 'hub_exchange_rates'; return out; }
    out.windows = {};
    for (const w of WINDOWS) {
        const { pts, stale_days } = await ratioSeriesWindow(sym, w, readMonth, nowMs);
        out.stale_days = stale_days;
        out.windows[w] = windowFromSeries(pts, null, w, stale_days != null && stale_days > RATIO_STALE_DAYS ? 'ratio_series_stale' : 'ratio_series');
    }
    out.source = out.stale_days != null && out.stale_days > RATIO_STALE_DAYS ? 'ratio_series_stale' : 'ratio_series';
    return out;
}

// ── "steak" hubs (bLUNA — Backbone, 2026-10-13) ─────────────────────────────
// No exchange_rates history: `state` → { total_usteak, total_native, exchange_rate }, and the rate rises ONLY when someone calls
// `harvest` (rewards withdrawn by bonds / unbonds sit in the hub's bank balance until then). Proven by the bluna-probe 1.0 chain probe
// (2026-10-13): rate 1.769853 unchanged since at least 2026-08-01, 4 of 8 validators jailed (1.05M of 2.44M LUNA), 282k LUNA idle.
// So two numbers, both published, never one for the other:
//   realised_apr  — what holders actually got: the rate's own growth (ratio series, rate now from `state`) over 30 days
//   potential_apr — what it would pay if harvested: Σ bonded delegation × (1 − commission) × apr_stakers × (1 − hub fee) ÷ total_native
//                   (provisions leg only, like apr_stakers — the alliance take-rate leg is unmeasured)
async function steakHub(sym, hubAddr, T, readMonth, nowMs, aprStakers, errors) {
    const st = await T.queryContract(hubAddr, { state: {} });
    const native = num(st && st.total_native), shares = num(st && st.total_usteak), rate = num(st && st.exchange_rate);
    if (native == null || shares == null || rate == null) throw new Error('not a steak hub (no total_native / total_usteak / exchange_rate)');
    const out = { kind: 'steak', rate_now: rate, total_native_luna: native / 1e6, fee_rate: null, realised_apr: null, rate_unchanged_days: null, potential_apr: null,
        delegated_luna: null, bonded_luna: null, jailed_luna: null, idle_luna: null, pending_rewards_luna: null, validators: [],
        method: 'realised_apr = (rate_now ÷ rate 30 days ago − 1) ÷ span × 365.25 (rate history: price-history/ratios; now: hub state). potential_apr = Σ bonded (1 − commission) × apr_stakers × (1 − fee_rate) ÷ total_native — provisions leg only; what holders would get if the hub harvested.' };
    try { const c = await T.queryContract(hubAddr, { config: {} }); out.fee_rate = num(c && c.fee_rate); } catch (e) { errors.push({ where: `yields:${sym}:steak:config`, error: e.message }); }
    // rate history: when did it last move, and the 30-day realised rate
    const { pts } = await ratioSeriesWindow(sym, 90, readMonth, nowMs);
    const all = [...pts, { t_ms: nowMs, rate }];
    let changed = null; for (let i = all.length - 1; i > 0; i--) if (Math.abs(all[i].rate - all[i - 1].rate) > 1e-9) { changed = all[i].t_ms; break; }
    out.rate_unchanged_days = changed == null ? (pts.length ? round((nowMs - pts[0].t_ms) / 86400000, 0) : null) : round((nowMs - changed) / 86400000, 1);
    out.rate_unchanged_since_at_least = changed == null && pts.length ? new Date(pts[0].t_ms).toISOString().slice(0, 10) : null;
    const old = pts.filter(p => p.t_ms <= nowMs - 30 * 86400000).pop() || pts[0];
    if (old && nowMs - old.t_ms >= 7 * 86400000) out.realised_apr = round((rate / old.rate - 1) / ((nowMs - old.t_ms) / 86400000) * DAYS_IN_YEAR, 8);
    if (!T.lcdGet) return out;
    try {
        const d = await T.lcdGet(`/cosmos/staking/v1beta1/delegations/${hubAddr}?pagination.limit=100`);
        let bondedNet = 0, delegated = 0, bonded = 0, jailed = 0;
        for (const x of (d && d.delegation_responses) || []) {
            const v = x.delegation && x.delegation.validator_address, amt = (num(x.balance && x.balance.amount) || 0) / 1e6; if (!v) continue; delegated += amt;
            const vi = await T.lcdGet(`/cosmos/staking/v1beta1/validators/${v}`); const val = vi && vi.validator;
            const ok = !!val && val.status === 'BOND_STATUS_BONDED' && !val.jailed, com = num(val && val.commission && val.commission.commission_rates && val.commission.commission_rates.rate);
            out.validators.push({ validator: v, moniker: val && val.description ? val.description.moniker : null, luna: round(amt, 0), bonded: ok, jailed: !!(val && val.jailed), commission: com });
            if (ok) { bonded += amt; bondedNet += amt * (1 - (com || 0)); } else jailed += amt;
        }
        out.delegated_luna = round(delegated, 0); out.bonded_luna = round(bonded, 0); out.jailed_luna = round(jailed, 0);
        if (aprStakers != null && native > 0) out.potential_apr = round(bondedNet * aprStakers * (1 - (out.fee_rate || 0)) / (native / 1e6), 8);
    } catch (e) { errors.push({ where: `yields:${sym}:steak:delegations`, error: e.message }); }
    try { const r = await T.lcdGet(`/cosmos/distribution/v1beta1/delegators/${hubAddr}/rewards`); const l = ((r && r.total) || []).find(x => x.denom === 'uluna'); out.pending_rewards_luna = l ? round(num(l.amount) / 1e6, 0) : 0; }
    catch (e) { errors.push({ where: `yields:${sym}:steak:rewards`, error: e.message }); }
    try { const b = await T.lcdGet(`/cosmos/bank/v1beta1/balances/${hubAddr}/by_denom?denom=uluna`); out.idle_luna = b && b.balance ? round(num(b.balance.amount) / 1e6, 0) : null; }
    catch (e) { errors.push({ where: `yields:${sym}:steak:balance`, error: e.message }); }
    return out;
}

async function vaultYields(v, T, errors) {
    const out = { address: v.address, label: v.label || null, lst_contract: v.lst_contract || null, lst_symbol: v.lst_symbol || null, windows: {} };
    for (const w of WINDOWS) {
        try {
            const res = await T.queryContract(v.address, { exchange_rates: { limit: w } });
            const pts = parseSeries(res); if (pts.length < 2) throw new Error(`exchange_rates(limit ${w}) returned ${pts.length} points`);
            out.windows[w] = windowFromSeries(pts, res && res.apr != null ? num(res.apr) : null, w, 'vault_exchange_rates');
        } catch (e) { errors.push({ where: `yields:vault:${(v.label || v.address).slice(0, 24)}:${w}d`, error: e.message }); out.windows[w] = windowFromSeries([], null, w, 'vault_exchange_rates'); }
    }
    return out;
}

// ── Native staking APR from chain (2026-08-26, owner's source hunt) ────────
// The published figures disagree because they deduct different things: Allnodes 37.78% =
// annual provisions ÷ bonded (before the Alliance module's share); SmartStake 27.6% ≈ what a
// LUNA staker receives after alliance reward weights (37.78 × 1/1.398 = 27.0). Chain-derived:
//   apr_gross    = annual_provisions ÷ bonded_tokens                       (the Allnodes-style number)
//   apr_stakers  = apr_gross × (1 − community_tax) × 1 ÷ total_reward_weight  (what LUNA stakers get, before validator commission)
// total_reward_weight = Σ ACTIVE alliance reward_weight + 1 — the same active filter eris-apr uses
// (reward_start_time in the past). Inputs and every term are published so the number is re-derivable.
async function nativeFromChain(T, nowMs, errors) {
    const out = { apr_gross: null, apr_stakers: null, apy_stakers: null, inputs: { annual_provisions_luna: null, bonded_luna: null, community_tax: null, total_reward_weight: null, alliances_active: null }, source: 'chain: /cosmos/mint annual_provisions · /cosmos/staking pool · /cosmos/distribution params · /terra/alliances' };
    if (!T.lcdGet) { errors.push({ where: 'yields:native:chain', error: 'no lcdGet on T' }); return out; }
    try {
        const p = await T.lcdGet('/cosmos/mint/v1beta1/annual_provisions'); const ap = num(p && (p.annual_provisions != null ? p.annual_provisions : p));
        const pool = await T.lcdGet('/cosmos/staking/v1beta1/pool'); const bonded = num(pool && pool.pool && pool.pool.bonded_tokens);
        const dp = await T.lcdGet('/cosmos/distribution/v1beta1/params'); const tax = num(dp && dp.params && dp.params.community_tax);
        const al = await T.lcdGet('/terra/alliances?pagination.limit=200'); const alliances = Array.isArray(al && al.alliances) ? al.alliances : Array.isArray(al) ? al : [];
        const active = alliances.filter(a => { const t = Date.parse(a.reward_start_time || ''); return Number.isFinite(t) && t < nowMs; });
        const trw = active.reduce((s, a) => s + (num(a.reward_weight) || 0), 0) + 1;
        out.inputs = { annual_provisions_luna: ap != null ? ap / 1e6 : null, bonded_luna: bonded != null ? bonded / 1e6 : null, community_tax: tax, total_reward_weight: alliances.length ? trw : null, alliances_active: alliances.length ? active.length : null };
        if (ap != null && bonded) {
            out.apr_gross = round(ap / bonded, 8);
            if (tax != null && alliances.length) { out.apr_stakers = round(ap / bonded * (1 - tax) / trw, 8); out.apy_stakers = round(Math.pow(1 + out.apr_stakers / DAYS_IN_YEAR, DAYS_IN_YEAR) - 1, 6); }
            else errors.push({ where: 'yields:native:chain', error: `missing ${tax == null ? 'community_tax ' : ''}${alliances.length ? '' : 'alliances'} — apr_stakers left null` });
        } else errors.push({ where: 'yields:native:chain', error: 'annual_provisions or bonded_tokens unreadable' });
    } catch (e) { errors.push({ where: 'yields:native:chain', error: e.message }); }
    return out;
}

async function hubProtocolFee(hubAddr, T, errors) {
    try { const c = await T.queryContract(hubAddr, { config: {} }); const f = num(c && (c.protocol_reward_fee ?? c.reward_fee ?? c.fee)); if (f == null || f < 0 || f >= 1) throw new Error('no protocol_reward_fee in hub config'); return f; }
    catch (e) { errors.push({ where: 'yields:native:hub_fee', error: e.message }); return null; }
}

// vaults: [{ address, label, lst_contract }] · hubs: { ampLUNA: addr, arbLUNA: addr, bLUNA: addr } · lstSymbolOf: cw20 → symbol
async function buildYields({ T, vaults, hubs, lstSymbolOf, readRatioMonth, now, version }) {
    const errors = []; const nowMs = now.getTime();
    const assets = {};
    for (const [sym, hub] of Object.entries(hubs)) assets[sym] = await assetYields(sym, hub, T, readRatioMonth, nowMs, errors);
    const chain = await nativeFromChain(T, nowMs, errors);
    // a hub with no exchange_rates history may be a steak hub (bLUNA): read its state — realised vs potential, both published
    for (const [sym, hub] of Object.entries(hubs)) if (hub && assets[sym].source !== 'hub_exchange_rates') {
        try { assets[sym].steak = await steakHub(sym, hub, T, readRatioMonth, nowMs, chain.apr_stakers, errors); assets[sym].source = 'steak_state'; assets[sym].stale_days = null; }
        catch (e) { errors.push({ where: `yields:${sym}:steak`, error: e.message }); }
    }
    const vaultRows = [];
    for (const v of vaults) {
        const row = await vaultYields({ ...v, lst_symbol: lstSymbolOf(v.lst_contract) }, T, errors);
        const a = row.lst_symbol && assets[row.lst_symbol];
        row.headline = {};
        for (const w of WINDOWS) {
            const vw = row.windows[w], aw = a && a.windows[w];
            const votion = vw ? (vw.apy_contract ?? vw.apy_measured) : null, asset = aw ? (aw.apy_contract ?? aw.apy_measured) : null;
            row.headline[w] = { asset_apy: asset, votion_apy: votion, total_apy: (asset != null && votion != null) ? round(asset + votion) : null, method: 'total_apy = asset_apy + votion_apy (Eris UI convention, additive)' };
        }
        vaultRows.push(row);
    }
    // native staking — PRIMARY: chain-derived (provisions, bonded, community tax, alliance weights);
    // CROSS-CHECK: ampLUNA net daily rate grossed up by the hub fee (an estimate, said so).
    // First live run (2026-08-26 18:47): bonded 316.1M → gross 30.5%, provisions leg to stakers 21.8% — BELOW every
    // published figure, while ampLUNA's realized 30d APY is 36.9%, ABOVE gross. Staking provisions alone cannot do
    // that: LUNA delegators also receive the Alliance module's TAKE-RATE rewards, paid in the alliance assets, which
    // the Eris hub collects and compounds. That leg is not measured here yet — published as a named gap, with the
    // realized ampLUNA figure as the reference ceiling. The hub-fee gross-up was dropped: the hub config no longer
    // exposes protocol_reward_fee, and the realized number is the better reference anyway.
    let native = { ...chain, basis_window_days: 30,
        method: 'apr_stakers = annual_provisions ÷ bonded × (1 − community_tax) ÷ total_reward_weight (Σ active alliance weights + 1) — the LUNA-provisions leg only, before validator commission; apr_gross = provisions ÷ bonded (what validator sites quote). NOT INCLUDED: alliance take-rate rewards paid to delegators in alliance assets (unmeasured — see take_rate_leg). ampluna_realized_apy_30d = the ampLUNA hub\'s own exchange-rate growth, everything included, after its validators\' commission and its fee.',
        take_rate_leg: { status: 'unmeasured', note: 'Alliance take rates on alliance-staked assets are redistributed to LUNA delegators in those assets; not captured yet. ampLUNA realized minus the provisions leg bounds it from above.' },
        references: { allnodes_2026_08_26: 0.3778, stakely_2026_08_26: 0.2813, smartstake_csv: 'docs/Staking APR.csv' } };
    const amp = assets.ampLUNA, w30 = amp && amp.windows[30];
    if (w30) { native.ampluna_realized_apy_30d = w30.apy_contract ?? w30.apy_measured; native.ampluna_realized_apr_30d = (w30.apr_daily_contract ?? w30.apr_daily_measured) != null ? round((w30.apr_daily_contract ?? w30.apr_daily_measured) * DAYS_IN_YEAR, 8) : null;
        if (native.apr_stakers != null && native.ampluna_realized_apr_30d != null) native.gap_vs_ampluna_pp = round((native.ampluna_realized_apr_30d - native.apr_stakers) * 100, 2); }
    const status = vaultRows.every(r => WINDOWS.every(w => r.windows[w].apy_contract == null && r.windows[w].apy_measured == null)) ? 'error' : (errors.length ? 'partial' : 'ok');
    return {
        doc: {
            meta: { version, generated_at: now.toISOString(), status, windows: WINDOWS, days_in_year: DAYS_IN_YEAR, agree_tolerance_pp: AGREE_PP,
                    method: 'Eris: apr = contract exchange_rates(limit).apr = (rate_end/rate_start − 1)/span_days (simple daily, span from time_s; pinned exact 2026-08-26); apy = (1+apr)^365.25 − 1; headline = asset + Votion. measured = same definition from the series endpoints; geometric = compounded daily rate, published beside it.' },
            assets, vaults: vaultRows, native_staking: native, _errors: errors.length ? errors : null,
        }, status, errors,
    };
}

module.exports = { buildYields, parseSeries, windowFromSeries, apyOfDaily, WINDOWS, DAYS_IN_YEAR, AGREE_PP };
