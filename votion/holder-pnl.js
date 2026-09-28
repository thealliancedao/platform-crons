'use strict';
/**
 * votion/holder-pnl.js 1.0.0 (2026-09-28) — THE Votion position story per holder per vault (owner: "what went in in USD at the
 * time, in underlying LUNA and in LST — why am I down: LUNA's price, not the position").
 *
 * For every deposit lot (FIFO; withdrawals burn the oldest vTokens first):
 *   entry  lst_in = vTokens × vault rate at entry (the event's own lst_in when it has one) · r_in = LST→LUNA ratio that day ·
 *          P_in = LUNA USD that day · luna_in = lst_in × r_in · cost_usd = luna_in × P_in
 *   now    lst_now = vTokens × vault rate now · luna_now = lst_now × r_now · usd_now = luna_now × P_now
 *   Δ USD  = luna_price  luna_in × (P_now − P_in)                 — what LUNA's own price did to the money that went in
 *          + lst_stake   lst_in × (r_now − r_in) × P_now          — the LST's staking gain (more LUNA per LST)
 *          + votion      (lst_now − lst_in) × r_now × P_now        — the vault's compounding (bribes + rebase → more LST per vToken)
 *   The three legs sum to usd_now − cost_usd exactly (asserted per lot).
 *   APRs (simple, the Eris definition the yields product uses): votion = (v_now / v_in − 1) × 365.25 / days,
 *   lst = (r_now / r_in − 1) × 365.25 / days — beside the ADVERTISED vault APR (votion/yields 30-day window).
 * Honesty: vTokens deposited but no longer held and never withdrawn (sent to another wallet) leave FIFO as `unexplained_outflow_vtokens`;
 * vTokens the holder has that no deposit explains (a transfer in, a pre-archive deposit) are valued now with NO basis
 * (`untracked_vtokens`, their USD kept out of the P&L); a lot whose day has no LUNA price or ratio is `blank` (never guessed).
 * Inputs are plain data — the votion cron (Branch B, daily) passes what it already read; the gate passes committed files.
 */
const VERSION = 'votion-holder-pnl-1.0.0';
const DAY = 86400000, YEAR = 365.25;
const dayOf = (ts) => String(ts).slice(0, 10);

// rate series per vault from the events' own samples (deposits + compounds carry rate_sample = LST per vToken)
function rateSeries(events) {
  const by = new Map();
  for (const e of events) { if (e.rate_sample == null || !e.vault) continue; (by.get(e.vault) || by.set(e.vault, []).get(e.vault)).push([Date.parse(e.timestamp), Number(e.rate_sample)]); }
  for (const l of by.values()) l.sort((a, b) => a[0] - b[0]);
  return by;
}
function rateAt(series, vault, t) {   // the last sample at or before t; else the first after (a deposit before the first compound)
  const l = series.get(vault); if (!l || !l.length) return null;
  let lo = 0, hi = l.length - 1, best = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (l[m][0] <= t) { best = m; lo = m + 1; } else hi = m - 1; }
  return best >= 0 ? l[best][1] : l[0][1];
}
const userOf = (e) => { for (const a of (e.raw_vault_attrs || [])) { if (a.recipient && a.recipient[0]) return a.recipient[0]; if (a.user && a.user[0]) return a.user[0]; } return e.user || null; };

/**
 * build({ events, vaults, holders, lunaUsd(day), ratio(day, lstSymbol), now:{ lunaUsd, day }, lstSymbolOf(lstContract), advertised(vaultAddr) })
 *   vaults:  [{ address, lst_contract, exchange_rate, lst_luna_hub_rate, label }]   (votion/snapshots/current.json)
 *   holders: Map vault → Map wallet → vtoken_balance (human)
 */
function build(o) {
  const series = rateSeries(o.events);
  const byVault = new Map(o.vaults.map(v => [v.address, v]));
  const flows = o.events.filter(e => (e.kind === 'deposit' || e.kind === 'withdraw') && byVault.has(e.vault)).sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp) || (a.height - b.height));
  const lots = new Map();   // vault|wallet → [{ vt, t, v_in, lst_in, src }]
  const realized = new Map();   // vault|wallet → [{ vt, t_in, t_out, lst_in, lst_out, v_in, v_out }]
  const notes = { deposits: 0, withdraws: 0, lst_from_event: 0, lst_from_rate: 0, withdraw_unmatched_vt: 0, no_user: 0 };
  for (const e of flows) {
    const w = userOf(e); if (!w) { notes.no_user++; continue; }
    const k = e.vault + '|' + w; const t = Date.parse(e.timestamp);
    if (e.kind === 'deposit') {
      const vt = Number(e.vtoken_minted || 0) / 1e6; if (!(vt > 0)) continue; notes.deposits++;
      const lstEv = e.lst_in != null ? Number(e.lst_in) / 1e6 : null; const v = lstEv ? lstEv / vt : rateAt(series, e.vault, t);
      if (lstEv) notes.lst_from_event++; else notes.lst_from_rate++;
      (lots.get(k) || lots.set(k, []).get(k)).push({ vt, t, v_in: v, lst_in: v != null ? vt * v : null, src: lstEv ? 'event' : 'vault_rate_at_time', tx: e.txhash });
    } else {
      let vt = Number(e.vtoken_burned || 0) / 1e6; if (!(vt > 0)) continue; notes.withdraws++;
      const vOut = e.lst_out != null && Number(e.vtoken_burned) ? (Number(e.lst_out) / 1e6) / vt : rateAt(series, e.vault, t);
      const l = lots.get(k) || [];
      while (vt > 1e-9 && l.length) { const lot = l[0]; const take = Math.min(lot.vt, vt); (realized.get(k) || realized.set(k, []).get(k)).push({ vt: take, t_in: lot.t, t_out: t, v_in: lot.v_in, v_out: vOut, lst_in: lot.v_in != null ? take * lot.v_in : null, lst_out: vOut != null ? take * vOut : null }); lot.vt -= take; if (lot.lst_in != null) lot.lst_in = lot.vt * lot.v_in; vt -= take; if (lot.vt <= 1e-9) l.shift(); }
      if (vt > 1e-9) notes.withdraw_unmatched_vt += vt;   // burned more than the archive saw deposited (pre-archive / transferred in)
    }
  }
  const out = { version: VERSION, now_day: o.now.day, luna_usd_now: o.now.lunaUsd, notes, holders: {} };
  for (const [vault, hm] of o.holders) {
    const V = byVault.get(vault); if (!V) continue; const sym = o.lstSymbolOf(V.lst_contract); const vNow = V.exchange_rate, rNow = V.lst_luna_hub_rate, P = o.now.lunaUsd;
    const adv = o.advertised ? o.advertised(vault) : null;
    for (const [wallet, vtNow] of hm) {
      const k = vault + '|' + wallet; const ls = (lots.get(k) || []).filter(l => l.vt > 1e-9).map(l => Object.assign({}, l));
      // vTokens the archive saw deposited but the wallet no longer holds and no withdraw explains (sent to another wallet):
      // burned FIFO as an unexplained outflow — reported, never valued as a loss
      let outflow = Math.max(0, ls.reduce((s, l) => s + l.vt, 0) - vtNow); const outflowVt = outflow > 1e-6 ? outflow : 0;
      while (outflow > 1e-9 && ls.length) { const take = Math.min(ls[0].vt, outflow); ls[0].vt -= take; outflow -= take; if (ls[0].vt <= 1e-9) ls.shift(); }
      const rows = []; let blank = 0;
      for (const l of ls) {
        const d = dayOf(new Date(l.t).toISOString()); const Pin = o.lunaUsd(d), rIn = o.ratio(d, sym);
        if (l.v_in == null || Pin == null || rIn == null || vNow == null || rNow == null || P == null) { blank++; rows.push({ vt: l.vt, day: d, blank: true, why: l.v_in == null ? 'no vault rate at entry' : Pin == null ? 'no LUNA price that day' : rIn == null ? 'no LST ratio that day' : 'no current rate / price' }); continue; }
        const lstIn = l.vt * l.v_in, lunaIn = lstIn * rIn, cost = lunaIn * Pin, lstNow = l.vt * vNow, lunaNow = lstNow * rNow, usdNow = lunaNow * P;
        const legs = { luna_price: lunaIn * (P - Pin), lst_stake: lstIn * (rNow - rIn) * P, votion: (lstNow - lstIn) * rNow * P };
        const days = Math.max(1 / 24, (Date.parse(o.now.day + 'T00:00:00Z') - l.t) / DAY);
        rows.push({ vt: l.vt, day: d, days: +days.toFixed(2), src: l.src, v_in: l.v_in, r_in: rIn, luna_usd_in: Pin, lst_in: lstIn, luna_in: lunaIn, cost_usd: cost, lst_now: lstNow, luna_now: lunaNow, usd_now: usdNow, legs, apr_votion: (vNow / l.v_in - 1) * YEAR / days, apr_lst: (rNow / rIn - 1) * YEAR / days, luna_price_pct: P / Pin - 1 });
      }
      const ok = rows.filter(r => !r.blank); const sum = (f) => ok.reduce((s, r) => s + f(r), 0);
      const vtLots = ls.reduce((s, l) => s + l.vt, 0); const untracked = Math.max(0, vtNow - vtLots);
      const cost = sum(r => r.cost_usd), usdNow = sum(r => r.usd_now), lstIn = sum(r => r.lst_in), lstNow = sum(r => r.lst_now), lunaIn = sum(r => r.luna_in), lunaNow = sum(r => r.luna_now);
      const w8 = (f) => { const den = sum(r => r.cost_usd * r.days); return den > 0 ? sum(r => f(r) * r.cost_usd * r.days) / den : null; };
      const rl = (realized.get(k) || []).filter(x => x.lst_in != null && x.lst_out != null);
      out.holders[k] = {
        vault, wallet, lst_symbol: sym, vtokens_now: vtNow, vtokens_in_lots: vtLots, untracked_vtokens: untracked > 1e-6 ? untracked : 0, unexplained_outflow_vtokens: outflowVt,
        untracked_usd_now: untracked > 1e-6 && vNow != null && rNow != null && P != null ? untracked * vNow * rNow * P : 0,
        lots: rows, lots_blank: blank,
        totals: ok.length ? { cost_usd: cost, usd_now: usdNow, delta_usd: usdNow - cost, delta_pct: cost > 0 ? usdNow / cost - 1 : null,
          legs: { luna_price: sum(r => r.legs.luna_price), lst_stake: sum(r => r.legs.lst_stake), votion: sum(r => r.legs.votion) },
          lst_in: lstIn, lst_now: lstNow, luna_in: lunaIn, luna_now: lunaNow,
          luna_price_pct: w8(r => r.luna_price_pct), apr_votion: w8(r => r.apr_votion), apr_lst: w8(r => r.apr_lst), first_day: ok.map(r => r.day).sort()[0] } : null,
        realized: rl.length ? { vt: rl.reduce((s, x) => s + x.vt, 0), lst_in: rl.reduce((s, x) => s + x.lst_in, 0), lst_out: rl.reduce((s, x) => s + x.lst_out, 0) } : null,
        advertised: adv,
        coverage: vtNow > 0 ? Math.min(1, vtLots / vtNow) : null,
      };
    }
  }
  return out;
}
module.exports = { VERSION, build, rateSeries, rateAt, userOf };
