#!/usr/bin/env node
'use strict';
// org-votion Branch D mock gate (1.4.0) — yields from exchange_rates.
// Chain stub: every series grows at a CONSTANT daily rate, so the contract's
// `apr` and our endpoint measurement must agree to 1e-9; arbLUNA's hub rejects
// `exchange_rates` → labeled ratio-series fallback; bLUNA has no hub history →
// ratio series; ampLUNA hub config carries the fee → native gross-up.
const M = require('./index.js');
const Y = require('./yields.js');
let PASS = 0, FAIL = 0;
function check(name, cond, extra) { if (cond) { PASS++; console.log(`  ✓ ${name}`); } else { FAIL++; console.log(`  ✗ ${name}${extra !== undefined ? ' — ' + JSON.stringify(extra).slice(0, 240) : ''}`); } }

const NOW = new Date('2026-08-26T05:00:00Z');
const AMP_HUB = 'terra10788fkzah89xrdm27zkj5yvhj9x3494lxawzm5qq3vvxcqz2yzaqyd3enk';
const ARB_HUB = 'terra1r9gls56glvuc4jedsvc3uwh6vj95mqm9efc7hnweqxa2nlme5cyqxygy5m';
const AMP_CW20 = 'terra1ecgazyd0waaj3g7l9cmy5gulhxkps2gmxu9ghducvuypjq68mq2s5lvsct';
const ARB_CW20 = 'terra1se7rvuerys4kd2snt6vqswh9wugu49vhyzls8ymc02wl37g2p2ms5yz490';
const V_AMP_MAX = 'terra1v7aw9ear_vault_amp_max', V_ARB_MAX = 'terra13aae4fut_vault_arb_max';
const DAILY = { [V_AMP_MAX]: 0.0015, [V_ARB_MAX]: 0.0018, [AMP_HUB]: 0.00042 };   // per-day growth (vault ≈ 73% APY, hub ≈ 16.6% APY)
const FEE = 0.05;

function series(daily, days, start = 1.5) { // REAL shape: [[day_index, {exchange_rate, time_s}]] newest first + apr = (end/start − 1)/span (simple)
  const t0 = Math.floor(NOW.getTime() / 1000); const out = [];
  for (let i = 0; i < days; i++) { const t = t0 - i * 86400; out.push([Math.floor(t / 86400), { exchange_rate: (start * Math.pow(1 + daily, days - 1 - i)).toFixed(15), time_s: t }]); }
  const apr = (Math.pow(1 + daily, days - 1) - 1) / (days - 1);
  return { exchange_rates: out, apr: String(apr) };
}
const FIX = require('./fixtures-yields-arbluna-max-2026-08-26.json');
const CALLS = [];
M.T.queryContract = async (addr, q) => {
  CALLS.push([addr, Object.keys(q)[0]]);
  if (q.exchange_rates) {
    if (addr === ARB_HUB) throw new Error('Error parsing into type QueryMsg: unknown variant `exchange_rates`');
    const d = DAILY[addr]; if (d == null) throw new Error('no such contract');
    const n = q.exchange_rates.limit || 30; if (addr === V_ARB_MAX && n === 30) return FIX; return series(d, n);
  }
  if (q.config && addr === AMP_HUB) return { protocol_reward_fee: String(FEE) };
  throw new Error('unexpected query ' + JSON.stringify(q));
};
// ratio series (price-history/ratios) — arbLUNA + bLUNA fallback; bLUNA stale by 41 days (the real 2026-07-16 hole)
const RATIOS = {};
for (let i = 0; i < 90; i++) { const d = new Date(NOW.getTime() - i * 86400000).toISOString().slice(0, 10); const ym = d.slice(0, 7);
  (RATIOS[ym] = RATIOS[ym] || { days: {} }).days[d] = { arbLUNA: { ratio: 2.98 * Math.pow(1.0004, 90 - i) }, ...(i >= 41 ? { bLUNA: { ratio: 1.76 * Math.pow(1.0003, 90 - i) } } : {}) }; }
const REPO = {}; const WRITES = {};
M.T.githubApiRequest = async (method, apiPath, body, accept) => {
  const m = apiPath.match(/\/contents\/([^?]+)/); const path = m && decodeURIComponent(m[1]);
  if (method === 'GET') {
    const rm = path && path.match(/^price-history\/ratios\/(\d{4})\/(\d{2})\.json$/);
    if (rm && accept === 'application/vnd.github.raw') { const k = `${rm[1]}-${rm[2]}`; if (RATIOS[k]) return JSON.stringify(RATIOS[k]); const e = new Error('404'); e.statusCode = 404; throw e; }
    if (accept === 'application/vnd.github.raw') { if (path in REPO) return JSON.stringify(REPO[path]); const e = new Error('404'); e.statusCode = 404; throw e; }
    if (path in REPO) return { sha: 'x' }; const e = new Error('404'); e.statusCode = 404; throw e;
  }
  if (method === 'PUT') { REPO[path] = JSON.parse(Buffer.from(body.content, 'base64').toString()); WRITES[path] = (WRITES[path] || 0) + 1; return { ok: true }; }
};
M.T.now = () => NOW;
M.T.lcdGet = async (path) => {   // chain staking inputs: provisions 96.46M LUNA, bonded 255.3M, tax 0, 8 active alliances Σw = 0.398 (+1 future-start, excluded)
  if (path.includes('/cosmos/mint/v1beta1/annual_provisions')) return { annual_provisions: '96455271678637.83' };
  if (path.includes('/cosmos/staking/v1beta1/pool')) return { pool: { bonded_tokens: '255306000000000', not_bonded_tokens: '1' } };
  if (path.includes('/cosmos/distribution/v1beta1/params')) return { params: { community_tax: '0.000000000000000000' } };
  if (path.includes('/terra/alliances')) return { alliances: [ ...Array.from({ length: 8 }, (_, i) => ({ denom: 'a' + i, reward_weight: String(0.398 / 8), reward_start_time: '2025-01-01T00:00:00Z' })), { denom: 'future', reward_weight: '0.5', reward_start_time: '2027-01-01T00:00:00Z' } ] };
  return null;
};

(async () => {
  console.log('org-votion Branch D mock gate');
  const vaults = [{ address: V_AMP_MAX, label: 'Votion ampLUNA-MAX', lst_contract: AMP_CW20 }, { address: V_ARB_MAX, label: 'Votion arbLUNA-MAX', lst_contract: ARB_CW20 }];
  const r = await M.runBranchD(NOW, vaults);
  const doc = REPO['votion/yields/current.json'];
  check('D1 current.json + daily written', !!doc && !!REPO['votion/yields/daily/2026-08-26.json']);
  check('D2 status partial (arbLUNA hub rejected → fallback recorded, not fatal)', r.status === 'partial' && r.errors.some(e => /arbLUNA:hub/.test(e.where)), r.errors);
  const amp30 = doc.vaults[0].windows[30];
  check('D3 vault contract apr == measured apr (contract definition reproduced, 1e-12)', Math.abs(amp30.apr_daily_contract - amp30.apr_daily_measured) < 1e-12 && amp30.agree === true, amp30);
  check('D4 APY = (1+apr)^365.25 − 1 (Eris formula)', Math.abs(amp30.apy_contract - (Math.pow(1 + amp30.apr_daily_contract, 365.25) - 1)) < 1e-6, amp30.apy_contract);
  const real = doc.vaults[1].windows[30];
  check('D4b REAL arbluna-max series: parsed 30 pts, contract apr reproduced (12-dp product rounding), APY 57.94%', real.points === 30 && Math.abs(real.apr_daily_measured - 0.001252035586581811) < 1e-12 && Math.abs(real.apy_contract - 0.5794) < 5e-4 && real.agree === true, real);
  check('D4c geometric published beside it (compounded daily < simple daily here)', real.apr_daily_geometric < real.apr_daily_measured && real.apy_geometric != null, real);
  const hub30 = doc.assets.ampLUNA.windows[30];
  check('D5 ampLUNA asset from hub exchange_rates, agrees', doc.assets.ampLUNA.source === 'hub_exchange_rates' && hub30.agree === true, hub30);
  const h = doc.vaults[0].headline[30];
  check('D6 headline = asset + votion (additive, Eris UI)', Math.abs(h.total_apy - (hub30.apy_contract + amp30.apy_contract)) < 1e-9, h);
  check('D7 arbLUNA asset → ratio_series fallback, labeled, fresh', doc.assets.arbLUNA.source === 'ratio_series' && doc.assets.arbLUNA.windows[30].apy_measured > 0.1 && doc.assets.arbLUNA.windows[30].apr_daily_contract === null, doc.assets.arbLUNA);
  check('D8 bLUNA → ratio_series_stale (41d), value still measured, staleness stated', doc.assets.bLUNA.source === 'ratio_series_stale' && doc.assets.bLUNA.stale_days >= 40 && doc.assets.bLUNA.windows[30].source === 'ratio_series_stale', doc.assets.bLUNA);
  const n = doc.native_staking;
  check('D9 native est = amp daily ÷ (1 − fee), fee published', n.fee === FEE && Math.abs(n.apr_daily_est - hub30.apr_daily_contract / (1 - FEE)) < 1e-9 && /CROSS-CHECK/.test(n.method), n);
  check('D9b native PRIMARY from chain: apr_gross = provisions ÷ bonded = 37.78% (the Allnodes number), apr_stakers = gross ÷ 1.398 = 27.02% (the SmartStake number), future-start alliance excluded', Math.abs(n.apr_gross - 0.3778) < 5e-4 && Math.abs(n.apr_stakers - 0.3778 / 1.398) < 5e-4 && Math.abs(n.inputs.total_reward_weight - 1.398) < 1e-9 && n.inputs.alliances_active === 8 && n.references.allnodes_2026_08_26 === 0.3778, n);
  check('D9c crosscheck gap (chain vs amp-hub gross-up) published in pp', typeof n.crosscheck_gap_pp === 'number', n.crosscheck_gap_pp);
  check('D10 all 3 windows present on every vault + asset', doc.vaults.every(v => [7, 14, 30].every(w => v.windows[w])) && Object.values(doc.assets).every(a => [7, 14, 30].every(w => a.windows[w])));
  check('D11 arbLUNA vault headline uses its LST (arbLUNA) not ampLUNA, votion_apy = the real 57.94%', Math.abs(doc.vaults[1].headline[30].asset_apy - doc.assets.arbLUNA.windows[30].apy_measured) < 1e-9 && Math.abs(doc.vaults[1].headline[30].votion_apy - 0.5794) < 5e-4, doc.vaults[1].headline[30]);
  const reads = CALLS.filter(c => c[1] === 'exchange_rates').length;
  check('D12 read budget: 3 windows × (2 vaults + ampLUNA hub) + 1 failed probe each for arb + bLUNA hubs = 11 exchange_rates reads', reads === 11, reads);
  // pure-function shape tolerance
  check('D13 parseSeries tolerates [{time,rate}] and ISO times', Y.parseSeries([{ time: '2026-08-25T00:00:00Z', rate: '1.5' }, { time: '2026-08-26T00:00:00Z', rate: '1.5015' }]).length === 2);
  console.log(`\n${PASS} passed, ${FAIL} failed`); process.exit(FAIL ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
