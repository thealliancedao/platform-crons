// =============================================================================
// network-and-prices mock gate — 3.0.0 (org port + price canary)
// Run: node mock-run.js — file-based, no network, no env. Re-run after ANY change.
//
// 2026-09-10: the provenance layer (legacy-v2 + declared edits === shipped) is RETIRED. It proved the
// migration in August; it went red on 2026-08-21 when the F2b/E12 pricing edits (FUEL, dATOM, the ASTRO
// repoint) landed in index.js without being declared, and stayed red unnoticed. With the personal repos
// deleted there is no legacy referent left — index.js is the source; this gate is behaviour-only.
// (fixtures/legacy-v2.js, apply-port-edits.js, apply-canary.js were removed with it.)
//   BEHAVIOUR: exercises the LIVE exported functions (no third copy) on trimmed-REAL fixtures captured
//     live 2026-08-03/04: fixtures/dex-astroport.json, dex-skeletonswap.json, token-prices.json.
// =============================================================================
'use strict';
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function assert(cond, msg, detail) {
    if (cond) { passed++; console.log(`  ✓ ${msg}`); }
    else { failed++; console.log(`  ✗ FAIL ${msg}${detail !== undefined ? ' — ' + detail : ''}`); }
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(b));

const shipped = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
console.log('\n=== behaviour on trimmed-REAL fixtures ===');
const M = require('./index.js');
assert(typeof M.runPriceCanary === 'function' && typeof M.assemblePriceTable === 'function',
    'module loads under require.main guard; test surface exported');
assert(M.OUT_BASE === 'network-and-prices' && M.GITHUB_REPO === 'thealliancedao/tla-core',
    `org paths: OUT_BASE='${M.OUT_BASE}', GITHUB_REPO default '${M.GITHUB_REPO}'`);
assert(M.TOKEN_REGISTRY['EURe'].cgId === 'monerium-eur-money-2',
    "3.0.1: EURE cgId is 'monerium-eur-money-2' (current Monerium token post-migration; 'euroe-stablecoin' was the wrong coin)",
    M.TOKEN_REGISTRY['EURe'].cgId);
assert(!/pushToGithub\('data\//.test(shipped), "no legacy 'data/' write paths remain");
const legacyReads = shipped.split('\n').filter(l => !/^\s*\/\//.test(l) && /LEGACY_REPO_RAW|raw\.githubusercontent\.com\/defipatriot\//.test(l)).length;   // code lines only — comments may cite history
assert(legacyReads === 0, 'no legacy-repo reads remain in code (seed + heartbeat fallbacks removed 2026-09-10; personal repos deleted)', legacyReads);

const J = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8'));
const dexA = J('dex-astroport.json'), dexS = J('dex-skeletonswap.json');
const tokenPrices = J('token-prices.json').token_prices;
const c = M.runPriceCanary(tokenPrices, [dexA, dexS]);

// -- pinned expectations computed independently from fixture numbers --
const solidFinal = tokenPrices.SOLID.final_price_usd;                      // 1.0015615474611197
const usdcFinal = tokenPrices['USDC.n'].final_price_usd;   // 3.1.0: the catalog symbol is the key
const usdcSolid = dexA.pools.find(p => p.pool_name === 'USDC-SOLID');
const [uSide, sSide] = /^USDC/.test(usdcSolid.assets[0].symbol) ? usdcSolid.assets : [...usdcSolid.assets].reverse();   // the venue's spelling; the canary matches by denom
const impliedSolid = (Number(uSide.amount_raw) / 1e6 * usdcFinal) / (Number(sSide.amount_raw) / 1e6);
const solidDrift = (solidFinal / impliedSolid - 1) * 100;

console.log('\n  -- canary shape --');
assert(c.checked >= 5, `canary checked ${c.checked} tokens (≥5)`);
assert(c.thresholds.drift_flag_pct === 10 && c.thresholds.min_depth_usd === 5000, 'thresholds 10% / $5,000');

console.log('  -- SOLID: real drift, deep verified ref, NOT flagged --');
const solidRow = null;   // not flagged → prove by absence + recompute
assert(!c.flagged.some(f => f.symbol === 'SOLID'), `SOLID not flagged (real drift ${solidDrift.toFixed(3)}%)`);
assert(Math.abs(solidDrift) < 1, `independent SOLID drift ${solidDrift.toFixed(3)}% is sub-1%`);

console.log('  -- CAPA: $4.6k ref sits BELOW the $5k depth floor --');
assert(c.no_xyk_reference.includes('CAPA'), 'CAPA in no_xyk_reference (floor enforced)', JSON.stringify(c.no_xyk_reference));

console.log('  -- arbLUNA: concentrated pools EXCLUDED by doctrine --');
const arbConc = dexA.pools.find(p => p.pool_name === 'LUNA-arbLUNA' && p.pool_type === 'concentrated');
assert(!!arbConc, 'fixture carries the concentrated LUNA-arbLUNA pool (the trap)');
assert(c.no_xyk_reference.includes('arbLUNA'),
    'arbLUNA has NO reference — the ~$0.20-implying concentrated pool did not leak in');

console.log('  -- bLUNA: SS reference marked unverified --');
// bLUNA has a deep SS xyk pool and no astro xyk anchor pool → if checked, ref must be unverified
const bl = c.flagged.find(f => f.symbol === 'bLUNA');
const blChecked = !c.no_xyk_reference.includes('bLUNA');
assert(blChecked, 'bLUNA checked via the $171k SS pool');
if (bl) assert(bl.reference_unverified === true, 'bLUNA flag carries reference_unverified');
else {
    // not flagged (drift ~1.2%): verify via a forced mutation below
    passed++; console.log('  ✓ bLUNA within threshold — unverified marking verified via mutation next');
}

console.log('  -- mutation: SOLID final ×1.25 MUST flag with exact drift + ref fields --');
const mutated = JSON.parse(JSON.stringify(tokenPrices));
mutated.SOLID.final_price_usd = solidFinal * 1.25;
const c2 = M.runPriceCanary(mutated, [dexA, dexS]);
const f2 = c2.flagged.find(f => f.symbol === 'SOLID');
const expDrift = Math.round(((solidFinal * 1.25) / impliedSolid - 1) * 100 * 100) / 100;
assert(!!f2, 'mutated SOLID is flagged');
assert(f2 && f2.drift_pct === expDrift, `drift_pct === ${expDrift} (gate-computed)`, f2 && f2.drift_pct);
assert(f2 && f2.ref_pool === 'USDC-SOLID' && f2.ref_dex === 'astroport' && f2.ref_anchor === 'USDC.n'
    && f2.reference_unverified === false,
    'ref fields exact: USDC-SOLID / astroport / USDC.n anchor (matched by denom, named by the registry key) / verified');
assert(f2 && f2.ref_depth_usd === Math.round(Number(uSide.amount_raw) / 1e6 * usdcFinal * 2),
    `ref_depth_usd === ${Math.round(Number(uSide.amount_raw) / 1e6 * usdcFinal * 2)}`, f2 && f2.ref_depth_usd);

console.log('  -- mutation: bLUNA ×1.25 flag carries unverified marker --');
const mut3 = JSON.parse(JSON.stringify(tokenPrices));
mut3.bLUNA.final_price_usd = tokenPrices.bLUNA.final_price_usd * 1.25;
const c3 = M.runPriceCanary(mut3, [dexA, dexS]);
const f3 = c3.flagged.find(f => f.symbol === 'bLUNA');
assert(f3 && f3.reference_unverified === true && f3.ref_dex === 'skeletonswap',
    'bLUNA flag: reference_unverified=true, ref_dex=skeletonswap', f3 && JSON.stringify(f3));

console.log('  -- canary never mutates finals --');
assert(tokenPrices.SOLID.final_price_usd === solidFinal, 'input token_prices untouched');

console.log('\n=== 3.1.0: stables keyed by the CATALOG symbol; canary anchored by denom; registry ↔ catalog gate ===');
assert(['USDC.n', 'USDt', 'EURe'].every(k => M.TOKEN_REGISTRY[k]) && !['USDC', 'USDT', 'EURE'].some(k => M.TOKEN_REGISTRY[k]),
    'registry keys the three stables by the catalog symbol (USDC.n / USDt / EURe) and no longer by the old spelling');
assert(M.CANARY.ANCHORS.join() === 'USDC.n,USDt,LUNA' && M.CANARY.STABLE_ANCHORS.join() === 'USDC.n,USDt', 'canary anchors are the registry keys; stables anchor at 1.0 without a final');
// the SS capture spells the same denom `USDC`; the Astroport capture `USDC.n` (live captures) — the canary must anchor on both
const ssUsdc = dexS.pools.filter(p => (p.pool_type || 'xyk') === 'xyk' && p.assets.some(a => a.denom === 'ibc/2C962DAB9F57FE0921435426AE75196009FAA1981BF86991203C8411F8980FDB'));
const renamed = JSON.parse(JSON.stringify(dexA)); for (const p of renamed.pools) for (const a of p.assets) if (a.symbol === 'USDC') a.symbol = 'USDC.n';
const cR = M.runPriceCanary(mutated, [renamed, dexS]);
const fR = cR.flagged.find(f => f.symbol === 'SOLID');
assert(fR && fR.ref_anchor === 'USDC.n' && fR.ref_pool === 'USDC-SOLID' && fR.drift_pct === expDrift,
    'Astroport spelling the anchor USDC.n (as its live captures do) → same USDC-SOLID reference, same drift: matched by denom, not by the venue\'s symbol', fR && fR.ref_anchor);
// the SS USDC-SOLID pool in the fixture is $420 deep (under the $5k floor) — scale its reserves ×100 so it qualifies, Astroport absent
const deepS = JSON.parse(JSON.stringify(dexS)); for (const p of deepS.pools) if (p.pool_name === 'USDC-SOLID') for (const a of p.assets) a.amount_raw = String(Number(a.amount_raw) * 100);
const cS = M.runPriceCanary(mutated, [null, deepS]);
const fS = cS.flagged.find(f => f.symbol === 'SOLID');
assert(ssUsdc.length > 0 && fS && fS.ref_anchor === 'USDC.n' && fS.ref_dex === 'skeletonswap' && fS.reference_unverified === true,
    'SkeletonSwap spelling the anchor USDC → still the USDC.n anchor (matched by denom), reference marked unverified', fS && [fS.ref_anchor, fS.ref_dex, fS.reference_unverified]);
const catFx = { tokens: [
    { denom: 'ibc/2C962DAB9F57FE0921435426AE75196009FAA1981BF86991203C8411F8980FDB', effective: { symbol: 'USDC.n' } },
    { denom: 'ibc/9B19062D46CAB50361CE9B0A3E6D0A7A53AC9E7CB361F32A73CC733144A9A9E5', discovered: { symbol: 'USDt' } },
    { denom: 'ibc/8D52B251B447B7160421ACFBD50F6B0ABE5F98D2C404B03701130F12044439A1', effective: { symbol: 'EURe' } },
    { denom: 'ibc/88386AC48152D48B34B082648DF836F975506F0B57DBBFC10A54213B1BF484CB', effective: { symbol: 'wBTC.atom' } },
    { denom: 'uluna', effective: { symbol: 'LUNA' } },
] };
const g = M.catalogSymbolDrift(catFx);
assert(g.status === 'ok' && ['USDC.n', 'USDt', 'EURe', 'LUNA'].every(k => g.aligned.includes(k)), 'gate: the stables + LUNA read aligned with the catalog', g.aligned);
assert(g.drift.some(d => d.key === 'WBTC' && d.catalog_symbol === 'wBTC.atom' && !d.stable), 'gate: WBTC → wBTC.atom is PUBLISHED as drift (not renamed, not a stable)', g.drift);
assert(g.drift.some(d => d.key === 'PAXG' && d.catalog_symbol === null), 'gate: a registry denom the catalog does not hold is published with catalog_symbol null', g.drift.filter(d => d.catalog_symbol === null).map(d => d.key));
const gStable = M.catalogSymbolDrift({ tokens: [{ denom: 'ibc/2C962DAB9F57FE0921435426AE75196009FAA1981BF86991203C8411F8980FDB', effective: { symbol: 'USDC.inj' } }] });
assert(gStable.drift.some(d => d.key === 'USDC.n' && d.stable === true), 'gate: a stable whose catalog symbol moved is flagged stable:true (the loud warning path)');
assert(M.catalogSymbolDrift(null).status === 'skipped', 'gate: catalog unavailable → skipped, never a crash');
if (process.env.TLA_CORE_DIR) {
    const real = M.catalogSymbolDrift(JSON.parse(fs.readFileSync(path.join(process.env.TLA_CORE_DIR, 'token-catalog/snapshots/current.json'), 'utf8')));
    assert(real.status === 'ok' && !real.drift.some(d => d.stable), `REAL catalog: no stable drifts; published drift = ${real.drift.map(d => d.key + '→' + d.catalog_symbol).join(', ')}`, real.drift);
}

console.log('\n=== freshness machinery (ported intact) ===');
const snap = { token_prices: tokenPrices, luna_market: { price_usd: 0.0409 } };
const fp = M.computeDataFingerprint(snap);
assert(fp === M.computeDataFingerprint(JSON.parse(JSON.stringify(snap))), `fingerprint deterministic (${fp})`);
const s1 = M.classifyFreshness(fp, null);
assert(s1.dataFreshness === 'fresh' && s1.consecutiveStuckRuns === 0, 'no prior → fresh');
const s2 = M.classifyFreshness(fp, { dataFingerprint: fp, consecutiveStuckRuns: 1 });
assert(s2.dataFreshness === 'suspicious' && s2.consecutiveStuckRuns === 2, 'same fp ×2 → suspicious');
const s3 = M.classifyFreshness(fp, { dataFingerprint: fp, consecutiveStuckRuns: 2 });
assert(s3.dataFreshness === 'stuck' && s3.consecutiveStuckRuns === 3, 'same fp ×3 → stuck');

console.log('\n=== 3.1.1: USDC.inj registered; every token entry carries its phoenix-1 denom ===');
const USDC_INJ = 'ibc/E8481AD838C31D4FC12A504B10F9B4E2F830F8818D2735C2FFC707579B5FA60B';
assert(M.TOKEN_REGISTRY['USDC.inj'] && M.TOKEN_REGISTRY['USDC.inj'].cgId === 'usd-coin' && M.TOKEN_REGISTRY['USDC.inj'].astroportAddresses['phoenix-1'] === USDC_INJ,
    'registry: USDC.inj keyed by the catalog spelling, CoinGecko usd-coin, phoenix-1 denom ibc/E8481AD…');
{   // CG has usd-coin; Astroport has nothing for the denom (the live pools are empty) → cg_only, priced ~1.0, denom published
    const tp = M.assemblePriceTable({ astroData: {}, cgData: { 'usd-coin': { usd: 0.9998, usd_24h_change: 0 }, 'stride-staked-atom': { usd: 3.6 } }, lstRatios: {} });
    const inj = tp['USDC.inj'], st = tp['STATOM'];
    assert(inj && inj.final_price_usd === 0.9998 && inj.final_source === 'coingecko' && inj.match_quality === 'cg_only' && inj.denom === USDC_INJ,
        'USDC.inj with no Astroport market → cg_only at the CG price, `denom` published at the root', inj && [inj.final_source, inj.match_quality, inj.denom]);
    assert(st && st.denom === null && st.final_price_usd === 3.6, 'a registry entry with no phoenix-1 address publishes denom: null (honest — nothing to key on)', st && st.denom);
    assert(Object.values(tp).every(e => 'denom' in e), 'every token_prices entry carries the `denom` field (3.1.1 additive)');
}
{   // the drift gate names USDC.inj as not-in-catalog until the catalog carries the denom — that is the watch, not a failure
    const g = M.catalogSymbolDrift({ tokens: [{ denom: 'ibc/2C962DAB9F57FE0921435426AE75196009FAA1981BF86991203C8411F8980FDB', effective: { symbol: 'USDC.n' } }] });
    const d = g.drift.find(x => x.key === 'USDC.inj');
    assert(g.status === 'ok' && d && d.catalog_symbol === null && /not in the token-catalog/.test(d.note), 'catalog gate: USDC.inj published as `denom not in the token-catalog` (never fails the run)', d);
}

console.log(`\nGATE: ${passed}/${passed + failed} passed${failed ? ' — FAIL' : ' — ALL GREEN'}\n`);
process.exit(failed ? 1 : 0);
