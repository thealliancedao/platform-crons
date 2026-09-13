// gate-nftc-routing.mjs — v1.13.3: read_product routes aDAO + collection paths to nft-collections, everything else as before.
// Evaluates the routing expression lifted verbatim from server.js (no third copy). Usage: node gate-nftc-routing.mjs
import fs from 'node:fs';
const src = fs.readFileSync(new URL('./server.js', import.meta.url), 'utf8'); let pass = 0, fail = 0;
const ok = (c, m, x) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (x ? ' → ' + x : '')); } };
const expr = src.match(/const url = (p\.startsWith\('dao-originations\/'\)[\s\S]*?`\$\{CORE\}\/\$\{p\}`);/); ok(!!expr, 'routing expression found in server.js');
const prefixes = src.match(/const PRODUCT_PREFIXES = (\[[^\]]+\])/); ok(!!prefixes, 'PRODUCT_PREFIXES found');
const CORE = 'https://raw.githubusercontent.com/thealliancedao/tla-core/main', DAO_REPO = 'https://raw.githubusercontent.com/thealliancedao/dao-originations/main', NFTC_REPO = 'https://raw.githubusercontent.com/thealliancedao/nft-collections/main';
const route = new Function('p', 'CORE', 'DAO_REPO', 'NFTC_REPO', 'return ' + expr[1]); const PP = new Function('return ' + prefixes[1])();
const allowed = (p) => PP.some(pre => p.startsWith(pre));
const cases = [
  ['nfts/adao/transfers/2026/08.json', NFTC_REPO + '/adao/transfers/2026/08.json'],
  ['nfts/adao/snapshots/summary.json', NFTC_REPO + '/adao/snapshots/summary.json'],
  ['nft-collections/pixel-lions/ledger/index.json', NFTC_REPO + '/pixel-lions/ledger/index.json'],
  ['nft-collections/adao/ledger/2026/09.json', NFTC_REPO + '/adao/ledger/2026/09.json'],
  ['member-data/tla-snapshot/current.json', CORE + '/member-data/tla-snapshot/current.json'],
  ['tla-voting/distributions/history.json', CORE + '/tla-voting/distributions/history.json'],
  ['dao-originations/adao/governance/proposals.json', DAO_REPO + '/adao/governance/proposals.json'],
  ['dao-originations/other/x.json', null],
];
for (const [p, want] of cases) { ok(allowed(p) || want === null, 'allowed: ' + p); const got = route(p, CORE, DAO_REPO, NFTC_REPO); ok(got === want, `${p} → ${want === null ? 'refused' : want.replace('https://raw.githubusercontent.com/thealliancedao/', '')}`, got); }
ok(!src.includes(`\${CORE}/nfts/adao`), 'no tla-core/nfts/adao URL is ever built');
console.log(`\n=== NFTC ROUTING GATE: ${pass} passed, ${fail} failed ===`); process.exit(fail ? 1 : 0);
