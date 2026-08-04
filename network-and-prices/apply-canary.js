// Insert PHASE 6.5 PRICE CANARY + wiring — anchored, count===1 enforced.
'use strict';
const fs = require('fs');
let src = fs.readFileSync('index.js', 'utf8');
function rep(old, neu, label) {
    const n = src.split(old).length - 1;
    if (n !== 1) { console.error(`❌ anchor drift: "${label}" count=${n}`); process.exit(1); }
    src = src.replace(old, neu);
    console.log(`  ✓ ${label}`);
}

// C1: the canary block, inserted before the MAIN section header
rep(`// -----------------------------------------------------------------------------
// MAIN
// -----------------------------------------------------------------------------`,
`// -----------------------------------------------------------------------------
// PHASE 6.5: PRICE CANARY — xyk-implied cross-check vs our own dex captures
// -----------------------------------------------------------------------------
//
// "Mismatched prices are how users get misled, and we only caught arbLUNA by
// validating against an external UI." (CHANGES_PENDING, 2026-07) This makes the
// cross-check STANDING and self-contained: every final_price_usd is compared
// against the price implied by the deepest xyk pool in tla-core's own dex-data
// captures that pairs the token with a trusted anchor (USDC/USDT/LUNA).
//
// DOCTRINE — concentrated and stable pools are EXCLUDED as references. Their
// reserve ratio deviates from price BY DESIGN; reading one as a market price
// manufactures phantom divergences (this exact trap produced a false arbLUNA
// "market $0.055/$0.20" sighting — audited 2026-08-03, see
// docs/pending-changes/AUDIT-eris-apr-pricing.md). Do not re-add them.
//
// SkeletonSwap references are included but marked reference_unverified (SS
// reserves come from an unverified upstream) — their flags are advisory.
// The canary NEVER changes final prices and NEVER fails the run: it is a
// review signal, matching the hub-primary doctrine in Phase 6 (a thin pool
// must not override a proven price source; humans review flags).
const CANARY = {
    DRIFT_FLAG_PCT: 10,      // matches Phase 6 REVIEW_FLAG_PCT convention
    MIN_DEPTH_USD: 5000,     // ignore thin references (2 × anchor-side USD)
    DEX_FEEDS: [
        ['astroport',    'https://raw.githubusercontent.com/thealliancedao/tla-core/main/dex-data/astroport/snapshots/current.json'],
        ['skeletonswap', 'https://raw.githubusercontent.com/thealliancedao/tla-core/main/dex-data/skeletonswap/snapshots/current.json'],
    ],
    ANCHORS: ['USDC', 'USDT', 'LUNA'],   // anchor at OUR final prices → measures internal consistency
};

function runPriceCanary(tokenPrices, dexPayloads) {
    const finals = {};
    for (const [sym, t] of Object.entries(tokenPrices || {})) {
        const p = t && t.final_price_usd;
        if (Number.isFinite(p) && p > 0) finals[sym] = p;
    }
    const anchorPrice = (sym) => finals[sym] || (sym === 'USDC' || sym === 'USDT' ? 1.0 : null);

    // Collect candidate references: xyk pools pairing a priced token with an anchor.
    const refs = new Map();   // sym -> best {implied, depth, pool, dex, unverified}
    for (let i = 0; i < CANARY.DEX_FEEDS.length; i++) {
        const d = dexPayloads[i];
        if (!d) continue;
        const dexName = CANARY.DEX_FEEDS[i][0];
        const unverified = dexName === 'skeletonswap';
        for (const p of (d.pools || [])) {
            if ((p.pool_type || 'xyk') !== 'xyk') continue;   // DOCTRINE: xyk only
            const a = p.assets;
            if (!Array.isArray(a) || a.length !== 2) continue;
            for (const k of [0, 1]) {
                const tok = a[k], anc = a[1 - k];
                if (!CANARY.ANCHORS.includes(anc.symbol)) continue;
                if (CANARY.ANCHORS.includes(tok.symbol)) continue;   // anchors don't canary each other here
                const ap = anchorPrice(anc.symbol);
                if (!ap) continue;
                const ta = Number(tok.amount_raw) / 10 ** (tok.decimals ?? 6);
                const aa = Number(anc.amount_raw) / 10 ** (anc.decimals ?? 6);
                if (!(ta > 0 && aa > 0)) continue;
                const implied = aa * ap / ta;
                const depth = aa * ap * 2;
                if (depth < CANARY.MIN_DEPTH_USD) continue;
                const cur = refs.get(tok.symbol);
                // deepest reference wins; a verified (Astroport) ref beats an
                // unverified (SS) ref at any depth — trust before size.
                const better = !cur
                    || (cur.unverified && !unverified)
                    || (cur.unverified === unverified && depth > cur.depth);
                if (better) refs.set(tok.symbol, { implied, depth, pool: p.pool_name, dex: dexName, anchor: anc.symbol, unverified });
            }
        }
    }

    const flagged = [], checked = [], noRef = [];
    for (const [sym, ours] of Object.entries(finals)) {
        if (CANARY.ANCHORS.includes(sym)) continue;
        const r = refs.get(sym);
        if (!r) { noRef.push(sym); continue; }
        const drift = (ours / r.implied - 1) * 100;
        const row = {
            symbol: sym, final_price_usd: ours, implied_price_usd: r.implied,
            drift_pct: Math.round(drift * 100) / 100,
            ref_pool: r.pool, ref_dex: r.dex, ref_anchor: r.anchor,
            ref_depth_usd: Math.round(r.depth),
            reference_unverified: r.unverified,
        };
        checked.push(sym);
        if (Math.abs(drift) > CANARY.DRIFT_FLAG_PCT) flagged.push(row);
    }
    flagged.sort((a, b) => Math.abs(b.drift_pct) - Math.abs(a.drift_pct));
    return {
        checked: checked.length,
        flagged,
        no_xyk_reference: noRef.sort(),
        thresholds: { drift_flag_pct: CANARY.DRIFT_FLAG_PCT, min_depth_usd: CANARY.MIN_DEPTH_USD },
        doctrine: 'xyk-only references; concentrated/stable excluded by design; SS refs unverified; canary never changes final prices',
    };
}

// -----------------------------------------------------------------------------
// MAIN
// -----------------------------------------------------------------------------`, 'C1 canary block');

// C2: run the canary in main (dex feeds fetched here; graceful on failure)
rep(`    // Phase 6 (depends on 3, 4, 5)
    const tokenPrices = assemblePriceTable({ astroData, cgData, lstRatios: ratios.ratios });`,
`    // Phase 6 (depends on 3, 4, 5)
    const tokenPrices = assemblePriceTable({ astroData, cgData, lstRatios: ratios.ratios });

    // Phase 6.5 — price canary (never fails the run; skipped if dex feeds unavailable)
    console.log('\\u{1F426} Running price canary (xyk-implied cross-check)...');
    let priceCanary;
    try {
        const dexPayloads = await Promise.all(CANARY.DEX_FEEDS.map(([, u]) => fetchJsonAbs(u)));
        if (dexPayloads.every(d => !d)) {
            priceCanary = { status: 'skipped', reason: 'dex-data feeds unavailable' };
        } else {
            priceCanary = runPriceCanary(tokenPrices, dexPayloads);
            console.log(\`  \\u2713 canary: \${priceCanary.checked} checked, \${priceCanary.flagged.length} flagged, \${priceCanary.no_xyk_reference.length} without xyk reference\`);
            for (const f of priceCanary.flagged) {
                console.warn(\`  \\u26A0 CANARY \${f.symbol}: ours $\${f.final_price_usd} vs xyk-implied $\${f.implied_price_usd.toFixed(6)} (\${f.drift_pct > 0 ? '+' : ''}\${f.drift_pct}%) ref \${f.ref_pool} (\${f.ref_dex}, $\${f.ref_depth_usd.toLocaleString()})\${f.reference_unverified ? ' [UNVERIFIED REF]' : ''}\`);
            }
        }
    } catch (e) {
        priceCanary = { status: 'skipped', reason: e.message.slice(0, 120) };
    }`, 'C2 main wiring');

// C3: snapshot carries the canary block (additive field)
rep(`        network,
        luna_market: market,
        lst_ratios: ratios.ratios,
        token_prices: tokenPrices,
    };`,
`        network,
        luna_market: market,
        lst_ratios: ratios.ratios,
        token_prices: tokenPrices,
        price_canary: priceCanary,   // v3 additive — see PHASE 6.5
    };`, 'C3 snapshot field');

// C4: heartbeat surfaces canary flags (main publish path)
rep(`            stats: {
                tokens_priced: Object.keys(tokenPrices || {}).length,
                lst_ratios:    Object.keys(ratios.ratios || {}).length,
                source_failures: sourceFailures,
            },`,
`            stats: {
                tokens_priced: Object.keys(tokenPrices || {}).length,
                lst_ratios:    Object.keys(ratios.ratios || {}).length,
                source_failures: sourceFailures,
                price_canary_flags: (priceCanary && priceCanary.flagged) ? priceCanary.flagged.length : 0,
                price_canary_symbols: (priceCanary && priceCanary.flagged) ? priceCanary.flagged.map(f => f.symbol) : [],
            },`, 'C4 heartbeat stats');

fs.writeFileSync('index.js', src);
console.log('\nCanary inserted + wired.');
