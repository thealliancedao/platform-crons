// gate-nft-root.mjs — (1) DIFFERENTIAL: with default env the patched modules touch exactly the URL set the
// live main modules touch; (2) FLIPPED: with GITHUB_REPO=nft-collections + NFT_ROOT=adao, every aDAO read/write
// goes to nft-collections/adao/... and every TLA-side read still goes to tla-core; nothing mentions nfts/adao.
import { spawnSync } from 'node:child_process';
const [LIVE, PATCHED] = process.argv.slice(2); const MODS = ['index.js', 'flows.js', 'market-history.js', 'analytics.js', 'compact-bundle.js'];
let pass = 0, fail = 0; const ck = (n, c, x) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (x ? ' — ' + JSON.stringify(x).slice(0, 300) : '')); } };
const BODIES = ['', '{}', '[]'];
const probe1 = (dir, mod, env) => { const r = spawnSync('node', [new URL('./probe.js', import.meta.url).pathname, dir, mod], { env: { PATH: process.env.PATH, GITHUB_TOKEN: 'x', ...env }, encoding: 'utf8', timeout: 20000 }); const line = r.stdout.trim().split('\n').pop(); try { return JSON.parse(line); } catch { return { error: r.stderr.slice(-400), reads: [], writes: [] }; } };
// union over three stub behaviours (404 / {} / []) so callers walk as far as each shape lets them
// D.2: a wasm smart query is compared by contract + query variant, not by its base64 body — this gate is about WHICH repo/root/
// contract a module reaches for; a query's own arguments (page size, cursor) are the sister gates' subject (mock-run-chain-only).
const norm = (u) => String(u).replace(/(\/cosmwasm\/wasm\/v1\/contract\/[a-z0-9]+\/smart\/)([A-Za-z0-9+/=]+)/, (_, pre, b64) => { try { return pre + Object.keys(JSON.parse(Buffer.from(b64, 'base64').toString('utf8')))[0]; } catch { return pre + b64; } });
const probe = (dir, mod, env) => { const R = new Set(), W = new Set(); for (const b of BODIES) { const p = probe1(dir, mod, { ...env, PROBE_BODY: b }); p.reads.forEach(u => R.add(norm(u))); p.writes.forEach(u => W.add(norm(u))); } return { reads: [...R].sort(), writes: [...W].sort() }; };
console.log('— R1 differential (default env): patched == live —');
for (const m of MODS) { const a = probe(LIVE, m, {}), b = probe(PATCHED, m, {}); ck(`${m} same reads (${a.reads.length})`, JSON.stringify(a.reads) === JSON.stringify(b.reads) && a.reads.length > 0, { live: a.reads, patched: b.reads }); ck(`${m} same writes (${a.writes.length})`, JSON.stringify(a.writes) === JSON.stringify(b.writes), { live: a.writes, patched: b.writes }); }
console.log('— R2 flipped env: GITHUB_REPO=nft-collections · NFT_ROOT=adao · DATA_REPO=tla-core —');
const FLIP = { GITHUB_REPO: 'thealliancedao/nft-collections', NFT_ROOT: 'adao', DATA_REPO: 'thealliancedao/tla-core' };
const TLA = /\/(network-and-prices|price-history|token-catalog|tla-voting)\//;
for (const m of MODS) { const b = probe(PATCHED, m, FLIP); const all = [...b.reads, ...b.writes];
  ck(`${m} touched something (${all.length})`, all.length > 0, b);
  ck(`${m} no nfts/adao anywhere`, all.every(u => !u.includes('nfts/adao')), all.filter(u => u.includes('nfts/adao')));
  const nc = all.filter(u => u.includes('thealliancedao/nft-collections')); const tc = all.filter(u => u.includes('thealliancedao/tla-core'));
  ck(`${m} every nft-collections URL is under adao/ or a rarity read`, nc.every(u => /nft-collections\/(main\/|contents\/)?adao\//.test(u)), nc.filter(u => !/nft-collections\/(main\/|contents\/)?adao\//.test(u)));
  ck(`${m} every tla-core URL is a TLA-side read`, tc.every(u => TLA.test(u) && !u.startsWith('PUT')), tc.filter(u => !(TLA.test(u) && !u.startsWith('PUT'))));
  ck(`${m} every write goes to nft-collections`, b.writes.every(u => u.includes('thealliancedao/nft-collections')), b.writes.filter(u => !u.includes('nft-collections'))); }
console.log('— R3 NFT_ROOT tolerates stray slashes —');
{ const b = probe(PATCHED, 'compact-bundle.js', { ...FLIP, NFT_ROOT: '/adao/' }); ck('"/adao/" normalises to adao/', [...b.reads, ...b.writes].some(u => u.includes('/adao/snapshots/')) && [...b.reads, ...b.writes].every(u => !u.includes('//adao') && !u.includes('adao//')), b); }
console.log('— R4 resolved PATHS under the flipped env (constants the probe cannot reach at runtime) —');
{ const { createRequire } = await import('node:module'); const req = createRequire(import.meta.url); const path = await import('node:path');
  Object.assign(process.env, FLIP, { GITHUB_TOKEN: 'x' });
  const P = Object.fromEntries(MODS.map(m => [m, req(path.resolve(PATCHED, m)).PATHS]));
  ck('index OUTPUT_PATH = adao/snapshots', P['index.js'].OUTPUT_PATH === 'adao/snapshots', P['index.js']);
  ck('index CLAIMS_PATH = adao/claims/history.json', P['index.js'].CLAIMS_PATH === 'adao/claims/history.json', P['index.js']);
  ck('index state-history under adao/', P['index.js'].stateHistoryPath('2026-09') === 'adao/snapshots/state-history/2026/09.json', P['index.js'].stateHistoryPath('2026-09'));
  ck('index token-catalog read from tla-core', /thealliancedao\/tla-core\/main\/token-catalog\//.test(P['index.js'].TOKEN_CATALOG_URL), P['index.js'].TOKEN_CATALOG_URL);
  ck('flows OUTPUT_PATH = adao/flows', P['flows.js'].OUTPUT_PATH === 'adao/flows', P['flows.js']);
  ck('flows nfts.json + transfers under nft-collections/adao', /nft-collections\/main\/adao\/snapshots\/nfts.json/.test(P['flows.js'].NFTS_URL) && P['flows.js'].transfersPath('2026', '09') === 'adao/transfers/2026/09.json', P['flows.js']);
  ck('market-history NFT_PATH/TRANSFERS_PATH under adao/', P['market-history.js'].NFT_PATH === 'adao/snapshots' && P['market-history.js'].TRANSFERS_PATH === 'adao/transfers', P['market-history.js']);
  ck('market-history price-history + tla-voting read from tla-core', /tla-core\/main\/price-history\//.test(P['market-history.js'].RAW_DATA('price-history/2026/09.json')) && /tla-core\/main\/tla-voting\//.test(P['market-history.js'].RAW_DATA('tla-voting/capture-registry.json')), P['market-history.js'].RAW_DATA('price-history/x'));
  ck('market-history aDAO reads from nft-collections', /nft-collections\/main\/adao\/snapshots\//.test(P['market-history.js'].RAW('adao/snapshots/sales-enriched.json')), P['market-history.js'].RAW('adao/snapshots/x'));
  ck('analytics + compact-bundle NFT_PATH = adao/snapshots', P['analytics.js'].NFT_PATH === 'adao/snapshots' && P['compact-bundle.js'].NFT_PATH === 'adao/snapshots', [P['analytics.js'], P['compact-bundle.js']]);
  ck('NFT_PATH env override still honoured', (() => { process.env.NFT_PATH = 'custom/snap'; delete req.cache[req.resolve(path.resolve(PATCHED, 'analytics.js'))]; const v = req(path.resolve(PATCHED, 'analytics.js')).PATHS.NFT_PATH; delete process.env.NFT_PATH; return v === 'custom/snap'; })()); }
console.log(`\n=== NFT_ROOT GATE: ${pass} passed, ${fail} failed ===`); process.exit(fail ? 1 : 0);
