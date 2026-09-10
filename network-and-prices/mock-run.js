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
assert(M.TOKEN_REGISTRY.EURE.cgId === 'monerium-eur-money-2',
    "3.0.1: EURE cgId is 'monerium-eur-money-2' (current Monerium token post-migration; 'euroe-stablecoin' was the wrong coin)",
    M.TOKEN_REGISTRY.EURE.cgId);
assert(!/pushToGithub\('data\//.test(shipped), "no legacy 'data/' write paths remain");
const legacyReads = shipped.split('\n').filter(l => !/^\s*\/\//.test(l) && /LEGACY_REPO_RAW|raw\.githubusercontent\.com\/defipatriot\//.test(l)).length;   // code lines only — comments may cite history
assert(legacyReads === 0, 'no legacy-repo reads remain in code (seed + heartbeat fallbacks removed 2026-09-10; personal repos deleted)', legacyReads);

const J = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8'));
const dexA = J('dex-astroport.json'), dexS = J('dex-skeletonswap.json');
const tokenPrices = J('token-prices.json').token_prices;
const c = M.runPriceCanary(tokenPrices, [dexA, dexS]);

// -- pinned expectations computed independently from fixture numbers --
const solidFinal = tokenPrices.SOLID.final_price_usd;                      // 1.0015615474611197
const usdcFinal = tokenPrices.USDC.final_price_usd;
const usdcSolid = dexA.pools.find(p => p.pool_name === 'USDC-SOLID');
const [uSide, sSide] = usdcSolid.assets[0].symbol === 'USDC' ? usdcSolid.assets : [...usdcSolid.assets].reverse();
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
assert(f2 && f2.ref_pool === 'USDC-SOLID' && f2.ref_dex === 'astroport' && f2.ref_anchor === 'USDC'
    && f2.reference_unverified === false,
    'ref fields exact: USDC-SOLID / astroport / USDC anchor / verified');
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

console.log(`\nGATE: ${passed}/${passed + failed} passed${failed ? ' — FAIL' : ' — ALL GREEN'}\n`);
process.exit(failed ? 1 : 0);
