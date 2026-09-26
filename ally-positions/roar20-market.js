/* =============================================================================
 * ally-positions/roar20-market.js 1.1.0 (2026-09-26) — ROAR20's MARKET, captured server-side every hour.
 * -----------------------------------------------------------------------------
 * Why a cron and not the page: the home asked DexScreener from the visitor's browser and the card stayed "Coming" (a browser-side
 * read can be refused, rate-limited or CORS-blocked, and it leaves no history). Here the positions job asks, once an hour, and
 * publishes one small file the site already knows how to read (raw GitHub), plus an hourly series so the 24h move and volume are
 * OURS to show even when a source omits them.
 *
 * Sources, in order (the first that answers with a price wins; every source that answers is kept beside it for cross-checking):
 *   1. DexScreener   api.dexscreener.com/tokens/v1/<chain>/<mint>            — price, 24h change, 24h volume, market cap, liquidity
 *   2. GeckoTerminal api.geckoterminal.com/api/v2/networks/<chain>/tokens/<mint> (+ /pools for the 24h change)
 *   3. Jupiter       lite-api.jup.ag/price/v3?ids=<mint>                       — price (and 24h change when it gives one)
 *   4. DexScreener   api.dexscreener.com/latest/dex/tokens/<mint>              — the legacy endpoint (1.1.0)
 *   5. pump.fun      frontend-api-v3.pump.fun/coins/<mint>                      — usd_market_cap ÷ supply (1.1.0; the bonding curve, before any DEX pair)
 * The registry holds the literals (tenants.json <tenant>.roar20: chain, mint); this file names none.
 *
 * Output (dao-originations/<dao>/roar20/):
 *   market.json          { price_usd, chg_24h_pct, volume_24h_usd, market_cap_usd, fdv_usd, liquidity_usd, dex, pair_url, source, sources{…}, capturedAt }
 *   market-history.json  { points: [{ t, price_usd, volume_24h_usd, market_cap_usd, source }] } — hourly, the last 90 days
 * A failed read writes nothing new (the last good file stands) and says so in the log; it never fails the positions run.
 * ============================================================================= */
'use strict';
const VERSION = '1.1.0';   // 1.1.0: DexScreener's legacy endpoint and pump.fun's own coin API as further sources (a pump.fun coin still on its bonding curve has no DEX pair); every source's answer or error is logged on each run
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const KEEP_MS = 90 * 864e5;

async function getJson(url, timeoutMs = 12000) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try { const r = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'thealliancedao-positions-cron' }, signal: ctrl.signal }); if (!r.ok) return { error: 'HTTP ' + r.status }; return { data: await r.json() }; }
  catch (e) { return { error: e.name === 'AbortError' ? 'timeout' : e.message }; } finally { clearTimeout(t); }
}

async function dexscreener(chain, mint) {
  const r = await getJson(`https://api.dexscreener.com/tokens/v1/${chain}/${mint}`); if (r.error) return { error: r.error };
  const pairs = Array.isArray(r.data) ? r.data : (r.data && Array.isArray(r.data.pairs) ? r.data.pairs : []);
  if (!pairs.length) return { error: 'no pairs listed' };
  const p = pairs.slice().sort((a, b) => ((b.liquidity && b.liquidity.usd) || 0) - ((a.liquidity && a.liquidity.usd) || 0))[0];
  return { price_usd: num(p.priceUsd), chg_24h_pct: num(p.priceChange && p.priceChange.h24), volume_24h_usd: pairs.reduce((t, x) => t + (num(x.volume && x.volume.h24) || 0), 0), market_cap_usd: num(p.marketCap), fdv_usd: num(p.fdv), liquidity_usd: num(p.liquidity && p.liquidity.usd), dex: p.dexId || null, pair_url: p.url || null, pairs: pairs.length };
}
async function geckoterminal(chain, mint) {
  const r = await getJson(`https://api.geckoterminal.com/api/v2/networks/${chain}/tokens/${mint}`); if (r.error) return { error: r.error };
  const a = r.data && r.data.data && r.data.data.attributes; if (!a) return { error: 'no token attributes' };
  let chg = null, dex = null, url = null; const pr = await getJson(`https://api.geckoterminal.com/api/v2/networks/${chain}/tokens/${mint}/pools?page=1`);
  const top = pr.data && Array.isArray(pr.data.data) ? pr.data.data[0] : null; if (top && top.attributes) { chg = num(top.attributes.price_change_percentage && top.attributes.price_change_percentage.h24); url = `https://www.geckoterminal.com/${chain}/pools/${top.attributes.address}`; dex = top.relationships && top.relationships.dex && top.relationships.dex.data ? top.relationships.dex.data.id : null; }
  return { price_usd: num(a.price_usd), chg_24h_pct: chg, volume_24h_usd: num(a.volume_usd && a.volume_usd.h24), market_cap_usd: num(a.market_cap_usd), fdv_usd: num(a.fdv_usd), liquidity_usd: num(a.total_reserve_in_usd), dex, pair_url: url };
}
async function jupiter(chain, mint) {
  if (chain !== 'solana') return { error: 'Jupiter is Solana only' };
  const r = await getJson(`https://lite-api.jup.ag/price/v3?ids=${mint}`); if (r.error) return { error: r.error };
  const x = r.data && r.data[mint]; if (!x) return { error: 'no price for the mint' };
  return { price_usd: num(x.usdPrice), chg_24h_pct: num(x.priceChange24h), volume_24h_usd: null, market_cap_usd: null, fdv_usd: null, liquidity_usd: null, dex: 'jupiter (aggregate)', pair_url: null };
}

async function dexscreenerLegacy(chain, mint) {
  const r = await getJson(`https://api.dexscreener.com/latest/dex/tokens/${mint}`); if (r.error) return { error: r.error };
  const pairs = (r.data && Array.isArray(r.data.pairs) ? r.data.pairs : []).filter(p => !chain || p.chainId === chain); if (!pairs.length) return { error: 'no pairs listed' };
  const p = pairs.slice().sort((a, b) => ((b.liquidity && b.liquidity.usd) || 0) - ((a.liquidity && a.liquidity.usd) || 0))[0];
  return { price_usd: num(p.priceUsd), chg_24h_pct: num(p.priceChange && p.priceChange.h24), volume_24h_usd: pairs.reduce((t, x) => t + (num(x.volume && x.volume.h24) || 0), 0), market_cap_usd: num(p.marketCap), fdv_usd: num(p.fdv), liquidity_usd: num(p.liquidity && p.liquidity.usd), dex: p.dexId || null, pair_url: p.url || null };
}
async function pumpfun(chain, mint) {
  if (chain !== 'solana') return { error: 'pump.fun is Solana only' };
  let r = await getJson(`https://frontend-api-v3.pump.fun/coins/${mint}`); if (r.error) r = await getJson(`https://frontend-api.pump.fun/coins/${mint}`); if (r.error) return { error: r.error };
  const c = r.data || {}; const dec = num(c.decimals) != null ? num(c.decimals) : 6; const sup = num(c.total_supply) != null ? num(c.total_supply) / Math.pow(10, dec) : null; const mc = num(c.usd_market_cap);
  if (!mc || !sup) return { error: 'no usd_market_cap / total_supply' };
  return { price_usd: mc / sup, chg_24h_pct: null, volume_24h_usd: null, market_cap_usd: mc, fdv_usd: null, liquidity_usd: null, dex: c.complete ? 'pump.fun (graduated' + (c.pump_swap_pool ? ', PumpSwap' : c.raydium_pool ? ', Raydium' : '') + ')' : 'pump.fun (bonding curve)', pair_url: `https://pump.fun/coin/${mint}` };
}

// history → the 24h change and the 24h-ago price, ours, when the winning source did not give one
function fromHistory(points, now, price) {
  const target = now - 864e5; let best = null; for (const p of points) { const d = Math.abs(p.t - target); if (num(p.price_usd) && d <= 3 * 3600e3 && (!best || d < Math.abs(best.t - target))) best = p; }
  return best && price ? { chg_24h_pct: (price / best.price_usd - 1) * 100, basis: new Date(best.t).toISOString() } : null;
}

// run({ tenant: <tenants.json block>, outRoot, publish, readJson, log }) → the market doc (or null when every source failed)
async function run(o) {
  const t = o.tenant || {}; const R = t.roar20 || {}; const log = o.log || console.log;
  if (!R.mint) { log('  roar20 market: tenants.json roar20.mint not set — skipped'); return null; }
  const chain = R.chain || 'solana'; const now = Date.now();
  const tries = [['DexScreener', dexscreener], ['GeckoTerminal', geckoterminal], ['Jupiter', jupiter], ['DexScreener (legacy)', dexscreenerLegacy], ['pump.fun', pumpfun]];
  const sources = {}; let win = null;
  for (const [name, fn] of tries) { let r; try { r = await fn(chain, R.mint); } catch (e) { r = { error: e.message }; } sources[name] = r.error ? { error: r.error } : { price_usd: r.price_usd, chg_24h_pct: r.chg_24h_pct, volume_24h_usd: r.volume_24h_usd, market_cap_usd: r.market_cap_usd }; if (!win && !r.error && num(r.price_usd)) win = Object.assign({ source: name }, r); }
  log('  roar20 sources: ' + Object.entries(sources).map(([k, v]) => k + ' ' + (v.error ? '✗ ' + v.error : '$' + v.price_usd)).join(' · '));
  if (!win) { log('  roar20 market: every source failed — ' + Object.entries(sources).map(([k, v]) => k + ': ' + v.error).join(' · ') + ' (the last good file stands)'); return null; }
  const histPath = `${o.outRoot}/roar20/market-history.json`; let hist = null; try { hist = await o.readJson(histPath); } catch (e) { hist = null; }
  const points = (hist && Array.isArray(hist.points) ? hist.points : []).filter(p => p && now - p.t <= KEEP_MS);
  // fill what the winner did not give from the other sources (labeled), then the 24h move from our own history
  const filled = {}; for (const k of ['chg_24h_pct', 'volume_24h_usd', 'market_cap_usd', 'fdv_usd', 'liquidity_usd']) { if (win[k] == null) { for (const [name, v] of Object.entries(sources)) if (name !== win.source && v && num(v[k]) != null) { win[k] = v[k]; filled[k] = name; break; } } }
  if (win.chg_24h_pct == null) { const h = fromHistory(points, now, win.price_usd); if (h) { win.chg_24h_pct = h.chg_24h_pct; filled.chg_24h_pct = 'our hourly history (vs ' + h.basis + ')'; } }
  const doc = { product: `${o.outRoot}/roar20/market`, engine: VERSION, capturedAt: new Date(now).toISOString(), chain, mint: R.mint, symbol: R.label || 'ROAR20',
    price_usd: win.price_usd, chg_24h_pct: win.chg_24h_pct, volume_24h_usd: win.volume_24h_usd, market_cap_usd: win.market_cap_usd, fdv_usd: win.fdv_usd, liquidity_usd: win.liquidity_usd, dex: win.dex, pair_url: win.pair_url,
    source: win.source, filled_from: Object.keys(filled).length ? filled : null, sources, note: 'captured by the positions job each hour; the first source that answers with a price wins, the others are kept for cross-checking; a figure filled from another source says which' };
  points.push({ t: now, price_usd: doc.price_usd, volume_24h_usd: doc.volume_24h_usd, market_cap_usd: doc.market_cap_usd, source: doc.source });
  const histDoc = { product: `${o.outRoot}/roar20/market-history`, engine: VERSION, updatedAt: doc.capturedAt, keep_days: 90, points };
  log(`  roar20 market: ${doc.source} $${doc.price_usd} · 24h ${doc.chg_24h_pct == null ? '—' : doc.chg_24h_pct.toFixed(1) + '%'} · vol ${doc.volume_24h_usd == null ? '—' : '$' + Math.round(doc.volume_24h_usd)} → ${await o.publish(`${o.outRoot}/roar20/market.json`, JSON.stringify(doc, null, 1), `🔥 ${o.tenantSlug || ''} roar20 market ${doc.capturedAt}`)}`);
  log(`  roar20 market-history (${points.length} points) → ${await o.publish(histPath, JSON.stringify(histDoc), `📈 ${o.tenantSlug || ''} roar20 market history`)}`);
  return doc;
}
module.exports = { VERSION, run, dexscreener, geckoterminal, jupiter, dexscreenerLegacy, pumpfun, fromHistory };
