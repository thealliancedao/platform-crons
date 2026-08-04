// Anchored port edits — every replace asserts count===1 before applying (doctrine).
'use strict';
const fs = require('fs');
let src = fs.readFileSync('index.js', 'utf8');
let edits = 0;
function rep(old, neu, label) {
    const n = src.split(old).length - 1;
    if (n !== 1) { console.error(`❌ anchor drift: "${label}" count=${n}`); process.exit(1); }
    src = src.replace(old, neu);
    edits++; console.log(`  ✓ ${label}`);
}

// E1: header — org-port provenance note
rep(`// =============================================================================
// Network & Prices Cron (v2 — with dual price sources + match quality)
// =============================================================================`,
`// =============================================================================
// Network & Prices Cron — 3.0.0 (ORG PORT + price canary)
// Home: thealliancedao/platform-crons/network-and-prices → publishes to
// thealliancedao/tla-core under network-and-prices/. Ported 2026-08-04 from
// defipatriot/cron-scripts (v2, proven in production since 2026-05); the old
// repo is INSPIRATION-ONLY from here — fixes land here. Parallel-run doctrine:
// keep the old Render job running until legacy fields verify identical, then
// retire it and repoint consumers (capture-engine.js, site CONFIG URLs).
// v3 additions: (a) org output paths, (b) one-time ratio-history/heartbeat
// migration fallback reads from the legacy repo, (c) PHASE 6.5 PRICE CANARY —
// xyk-implied cross-check of every final price against our own dex-data
// captures, (d) require.main guard + module.exports test surface so the mock
// gate can exercise the live functions (no third copy).
// schemaVersion stays 2 DELIBERATELY: all v3 changes are field-additive so
// every existing consumer keeps working unmodified during parallel-run.
// =============================================================================
// (original header follows)
// Network & Prices Cron (v2 — with dual price sources + match quality)
// =============================================================================`, 'E1 header');

// E2: repo default → org data store
rep(`const GITHUB_REPO   = process.env.GITHUB_REPO   || 'defipatriot/network-and-prices-data_2026';`,
`const GITHUB_REPO   = process.env.GITHUB_REPO   || 'thealliancedao/tla-core';
// Org output base inside tla-core; one folder per product family.
const OUT_BASE = 'network-and-prices';
// Legacy home — MIGRATION READS ONLY (ratio-history seed + heartbeat
// continuity on first org runs). Never written. Remove after cutover.
const LEGACY_REPO_RAW = 'https://raw.githubusercontent.com/defipatriot/network-and-prices-data_2026/main';`, 'E2 repo+bases');

// E3: ratio-history read gets legacy fallback (prior-verbatim: legacy doc IS the prior)
rep(`async function appendRatioHistory(ratiosObj, dateStr) {
    const prev = await fetchJsonRaw('data/ratio-history.json');`,
`async function appendRatioHistory(ratiosObj, dateStr) {
    let prev = await fetchJsonRaw(\`\${OUT_BASE}/ratio-history.json\`);
    if (!prev) {   // first org run: seed the series from the legacy repo so history never restarts
        prev = await fetchJsonAbs(\`\${LEGACY_REPO_RAW}/data/ratio-history.json\`);
        if (prev) console.log('  ↪ ratio-history migrated from legacy repo (one-time seed)');
    }`, 'E3 ratio-history fallback');

// E4: ratio-history write path
rep("await pushToGithub('data/ratio-history.json', JSON.stringify(doc, null, 2), `\u{1F4C8} ratio-history ${dateStr} (+${added} new, ${updated} updated)`);",
"await pushToGithub(`${OUT_BASE}/ratio-history.json`, JSON.stringify(doc, null, 2), `\u{1F4C8} ratio-history ${dateStr} (+${added} new, ${updated} updated)`);", 'E4 ratio-history write');

// E5: fetchJsonRaw gains an absolute-URL sibling (for legacy + dex-feed reads)
rep(`function fetchJsonRaw(filepath) {
    return new Promise((resolve) => {
        const url = \`https://raw.githubusercontent.com/\${GITHUB_REPO}/\${GITHUB_BRANCH}/\${filepath}\`;`,
`function fetchJsonAbs(url) {
    return new Promise((resolve) => {
        const req = https.get(url, { timeout: 8000 }, (res) => {
            if (res.statusCode !== 200) { resolve(null); return; }
            let body = ''; res.on('data', c => body += c);
            res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
    });
}
function fetchJsonRaw(filepath) {
    return new Promise((resolve) => {
        const url = \`https://raw.githubusercontent.com/\${GITHUB_REPO}/\${GITHUB_BRANCH}/\${filepath}\`;`, 'E5 fetchJsonAbs');

// E6: previous-heartbeat read → org path with legacy continuity fallback
rep(`function fetchPreviousHeartbeat() {
    return new Promise((resolve) => {
        const url = \`https://raw.githubusercontent.com/\${GITHUB_REPO}/\${GITHUB_BRANCH}/data/heartbeat.json\`;`,
`async function fetchPreviousHeartbeat() {
    const org = await fetchJsonRaw(\`\${OUT_BASE}/heartbeat.json\`);
    if (org) return org;
    // First org runs: read the legacy heartbeat so consecutive-stuck counting
    // stays continuous across the migration. Read-only; remove after cutover.
    return fetchJsonAbs(\`\${LEGACY_REPO_RAW}/data/heartbeat.json\`);
}
function _legacyFetchPreviousHeartbeat_unused() {
    return new Promise((resolve) => {
        const url = \`https://raw.githubusercontent.com/\${GITHUB_REPO}/\${GITHUB_BRANCH}/data/heartbeat.json\`;`, 'E6 heartbeat fallback');

// E7: main product path
rep(`await pushToGithub('data/network-and-prices.json', content,`,
`await pushToGithub(\`\${OUT_BASE}/current.json\`, content,`, 'E7 current.json');

// E8: daily archive path (push + log)
rep("await pushToGithub(`data/daily/${dateStr}.json`, content,",
    "await pushToGithub(`${OUT_BASE}/daily/${dateStr}.json`, content,", 'E8 daily push');
rep("console.log(`  \u2713 End-of-day archive written to data/daily/${dateStr}.json`);",
    "console.log(`  \u2713 End-of-day archive written to ${OUT_BASE}/daily/${dateStr}.json`);", 'E8b daily log');

// E9: heartbeat write path
rep("await pushToGithub('data/heartbeat.json', JSON.stringify(heartbeat, null, 2),",
"await pushToGithub(`${OUT_BASE}/heartbeat.json`, JSON.stringify(heartbeat, null, 2),", 'E9 heartbeat write');

// E10: auto-run guard + test-surface exports (enables the no-third-copy gate)
rep(`captureNetworkAndPrices()
    .then(() => process.exit(0))
    .catch((err) => {
        console.error('\\n\u274C Failed:', err.message);
        console.error(err.stack);
        process.exit(1);
    });`,
`if (require.main === module) {
    captureNetworkAndPrices()
        .then(() => process.exit(0))
        .catch((err) => {
            console.error('\\n\u274C Failed:', err.message);
            console.error(err.stack);
            process.exit(1);
        });
}

// Test surface for mock-run.js — the gate exercises THESE live functions on
// real fixtures; it must never re-implement them (no-third-copy doctrine).
module.exports = {
    assemblePriceTable, classifyMatchQuality, computeDataFingerprint,
    classifyFreshness, runPriceCanary, CANARY,
    TOKEN_REGISTRY, CALCULATED_TOKENS, OUT_BASE, GITHUB_REPO,
};`, 'E10 guard+exports');

// E11 (3.0.1): EURE cgId correction. Legacy mapped EURE → 'euroe-stablecoin'
// (EUROe — an UNRELATED, collapsed euro token, ~$0.51 stale). Terra's EURE is
// the Noble channel-253 denom = Monerium EUR emoney, CG id 'monerium-eur-money-2'
// (verified 2026-08-04 on the live CG page API-ID field by Camron; ~$1.15-1.17, agreeing with Astroport; Monerium
// lists Noble among its deployment chains). Live impact of the bug: the
// flagged_mismatch resolver demoted the CORRECT Astroport $1.15 as "stale" and
// shipped $0.5128 as final. CG migration trap: the OLD Monerium token kept
// API id 'monerium-eur-money' under the '-old' slug; the CURRENT token's API
// id is 'monerium-eur-money-2' — URL slugs are NOT API ids after migrations. — EURE USD understated ~2.24× platform-wide.
// NOTE: EURE only trades in CONCENTRATED pools, so the xyk canary has no
// reference for it — match_quality is the guard for this token; expect
// direct_match after this fix.
rep(`    EURE:    { cgId: 'euroe-stablecoin',     astroportAddresses: { 'phoenix-1': 'ibc/8D52B251B447B7160421ACFBD50F6B0ABE5F98D2C404B03701130F12044439A1' }, preferChain: 'phoenix-1' },`,
`    EURE:    { cgId: 'monerium-eur-money-2', astroportAddresses: { 'phoenix-1': 'ibc/8D52B251B447B7160421ACFBD50F6B0ABE5F98D2C404B03701130F12044439A1' }, preferChain: 'phoenix-1' },   // 3.0.1: was 'euroe-stablecoin' (wrong coin) — see E11`, 'E11 EURE cgId (3.0.1)');

fs.writeFileSync('index.js', src);
const leftover = (src.match(/pushToGithub\('data\//g) || []).length;
console.log('\nApplied ' + edits + " edits · remaining legacy 'data/' write refs: " + leftover);
if (leftover) process.exit(1);
