'use strict';
// run-ally.js 1.0.0 (2026-09-18) — ONE Render service per ALLY, one process per collection.
// Reads tla-core/docs/curated/tenants.json (the ONE list of allies and their collections), then runs `node index.js`
// once per collection of ALLY with COLLECTION=<slug>, sequentially, each in its own process: a failure in one collection
// never touches the next, each writes only its own folder, and a collection is added or removed by editing the tenants
// file — no new service, no env change. Exit code = number of collections that failed (Render shows it red).
//   env ALLY=liondao (required) · everything else passes through to index.js (GITHUB_TOKEN, GITHUB_REPO, DATA_REPO …)
//   env TENANTS_URL (optional) — defaults to the org copy on main; COLLECTIONS=a,b overrides the list for a manual run.
const { spawnSync } = require('child_process'); const https = require('https'); const path = require('path');
const ALLY = String(process.env.ALLY || '').trim(); if (!ALLY) { console.error('ALLY missing (e.g. ALLY=liondao) — one service per ally'); process.exit(2); }
const TENANTS_URL = process.env.TENANTS_URL || `https://raw.githubusercontent.com/${process.env.DATA_REPO || 'thealliancedao/tla-core'}/main/docs/curated/tenants.json`;
const get = (url) => new Promise((res, rej) => https.get(url + (url.includes('?') ? '&' : '?') + 'cb=' + Date.now(), { headers: { 'User-Agent': 'run-ally/1.0' } }, (r) => { let b = ''; r.on('data', c => b += c); r.on('end', () => r.statusCode === 200 ? res(JSON.parse(b)) : rej(new Error(`HTTP ${r.statusCode} ${url}`))); }).on('error', rej));
(async () => {
  let list;
  if (process.env.COLLECTIONS) list = process.env.COLLECTIONS.split(',').map(s => s.trim()).filter(Boolean);
  else { const t = await get(TENANTS_URL); const ally = t.tenants && t.tenants[ALLY]; if (!ally) { console.error(`ally "${ALLY}" not in tenants.json (${Object.keys(t.tenants || {}).join(', ')})`); process.exit(2); } list = ally.collections || []; }
  console.log(`🦁 run-ally ${ALLY} · collections: ${list.join(', ') || '(none)'}`);
  let failed = 0;
  for (const slug of list) {
    console.log(`\n================ ${ALLY} / ${slug} ================`);
    const env = Object.assign({}, process.env, { COLLECTION: slug }); delete env.NFT_ROOT;   // the slug is the root, always
    const r = spawnSync(process.execPath, ['--max-old-space-size=200', path.join(__dirname, 'index.js')], { env, stdio: 'inherit' });
    if (r.status !== 0) { failed++; console.error(`❌ ${slug} exited ${r.status}${r.signal ? ' (' + r.signal + ')' : ''}`); } else console.log(`✅ ${slug} done`);
  }
  console.log(`\nrun-ally ${ALLY}: ${list.length - failed}/${list.length} ok`); process.exit(failed);
})().catch(e => { console.error('FATAL', e.message); process.exit(2); });
