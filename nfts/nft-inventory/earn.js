'use strict';
// =============================================================================
// nfts/nft-inventory / earn.js 1.0.0 (2026-10-13) — what ONE unbroken NFT of a backed collection is worth and what it earns.
// -----------------------------------------------------------------------------
// Owner (2026-10-13, Rallies' Home "Earning" row): "for an aDAO NFT we could use the avg of the last 3 sales in USD for unbroken base to
// identify the value staked, then calculate avg rewards to backing to figure out aDAO NFTs APR". One small file the apps read; the math
// lives here, once.
//   value  = the average USD of the last 3 sales of NFTs that are unbroken today (sales-enriched notional_usd — the oracle's USD that day)
//   earns  = the growth of the backing per unbroken NFT (state-history backing.per_nft_ampluna) over the last ~30 days, per year,
//            × today's backing-token USD (summary.backing.ampluna_usd)
//   APR    = earns ÷ value (and ÷ the backing itself, for the "on backing" view)
// A pure join over files this job already wrote — no chain reads. Missing input → that field null with the reason, never a guess.
// Output: <NFT_ROOT>/snapshots/earn.json
// =============================================================================
const VERSION = 'nft-earn-1.0.0';
const num = (x) => (x == null || x === '' || !isFinite(Number(x))) ? null : Number(x);

// pure: { records (nfts.json), sales (sales-enriched .sales), days ({ date: state-history row }), summary } → earn doc body
function computeEarn({ records, sales, days, summary, window = 30, last = 3, now = new Date() }) {
  const out = { value: null, backing: null, yield: null, notes: [] };
  const broken = new Set((records || []).filter(r => r && r.broken).map(r => String(r.id)));
  const ok = (sales || []).filter(s => s && s.token_id != null && !broken.has(String(s.token_id)) && num(s.notional_usd) > 0 && s.timestamp)
    .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp))).slice(0, last);
  if (ok.length === last) out.value = { method: `average of the last ${last} sales of NFTs unbroken today (USD at the oracle price that day)`,
    sales: ok.map(s => ({ token_id: String(s.token_id), at: s.timestamp, usd: Math.round(num(s.notional_usd) * 100) / 100, paid: `${s.amount} ${s.denom_symbol || ''}`.trim(), marketplace: s.marketplace || null })),
    avg_usd: Math.round(ok.reduce((a, s) => a + num(s.notional_usd), 0) / last * 100) / 100 };
  else out.notes.push(`value: only ${ok.length} priced sale(s) of unbroken NFTs`);
  const ds = Object.keys(days || {}).filter(d => days[d] && days[d].backing && num(days[d].backing.per_nft_ampluna) > 0).sort();
  const b = summary && summary.backing; const px = num(b && b.ampluna_usd);
  if (ds.length >= 2) {
    const d1 = ds[ds.length - 1]; const target = new Date(Date.parse(d1 + 'T00:00:00Z') - window * 864e5).toISOString().slice(0, 10);
    const d0 = ds.filter(d => d <= target).pop() || ds[0];
    const n = (Date.parse(d1) - Date.parse(d0)) / 864e5; const a1 = num(days[d1].backing.per_nft_ampluna), a0 = num(days[d0].backing.per_nft_ampluna);
    out.backing = { token: 'ampLUNA', per_nft_now: a1, at: d1, per_nft_then: a0, then: d0, days: n, token_usd: px, per_nft_usd: px != null ? Math.round(a1 * px * 100) / 100 : null };
    if (n >= 7) {
      const perYear = (a1 - a0) * 365 / n;
      out.yield = { per_nft_per_year: perYear, per_nft_per_week: perYear / 52, usd_per_nft_per_week: px != null ? perYear / 52 * px : null,
        apr_on_backing_pct: a1 > 0 ? perYear / a1 * 100 : null,
        apr_on_value_pct: px != null && out.value ? perYear * px / out.value.avg_usd * 100 : null,
        method: `growth of the ${'ampLUNA'} backing per unbroken NFT over ${n} days (${d0} → ${d1}), per year` };
    } else out.notes.push(`yield: only ${n} day(s) of backing history`);
  } else out.notes.push('backing: no state history');
  return out;
}

async function run(deps) {
  const { readJson, publish, root, log = console.log, now = new Date() } = deps;
  const S = `${root}/snapshots`;
  const [nfts, enr, summary] = await Promise.all([readJson(`${S}/nfts.json`), readJson(`${S}/sales-enriched.json`), readJson(`${S}/summary.json`)]);
  if (!summary || !summary.backing) { log('  earn: no backing in this collection — skipped'); return { status: 'skipped' }; }
  const days = {};
  for (let i = 0; i < 3; i++) { const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1)); const m = await readJson(`${S}/state-history/${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}.json`); if (m && m.days) Object.assign(days, m.days); }
  const body = computeEarn({ records: (nfts && (nfts.records || (nfts.data && nfts.data.records))) || [], sales: (enr && enr.sales) || [], days, summary, now });
  const doc = { schemaVersion: 1, product: 'nfts/earn', version: VERSION, generated_at: now.toISOString(), collection: root, ...body };
  await publish(`${S}/earn.json`, doc, `nft earn: ${body.value ? '$' + body.value.avg_usd : 'no value'} · ${body.yield && body.yield.apr_on_value_pct != null ? body.yield.apr_on_value_pct.toFixed(1) + '% APR' : 'no APR'}`);
  log(`  earn: value ${body.value ? '$' + body.value.avg_usd : '—'} · backing ${body.backing ? body.backing.per_nft_now.toFixed(2) + ' ampLUNA' : '—'} · ${body.yield ? (body.yield.apr_on_value_pct != null ? body.yield.apr_on_value_pct.toFixed(1) + '% on value, ' : '') + body.yield.apr_on_backing_pct.toFixed(1) + '% on backing' : 'no yield'}`);
  return { status: 'ok', doc };
}
module.exports = { VERSION, computeEarn, run };
