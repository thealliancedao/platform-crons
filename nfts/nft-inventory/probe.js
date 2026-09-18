'use strict';
// probe.js — load ONE aDAO cron module under the current env with every network primitive stubbed,
// drive its entrypoint, and print every URL / GitHub API path it touched (reads AND writes) as JSON.
// Usage: node probe.js <dir> <module>   (env: GITHUB_REPO / DATA_REPO / NFT_ROOT / NFT_PATH as under test)
const path = require('path'), https = require('https'), { EventEmitter } = require('events');
const [dir, mod] = process.argv.slice(2);
const hits = { reads: new Set(), writes: new Set() };
function fakeRes(status, body) { const r = new EventEmitter(); r.statusCode = status; r.headers = {}; r.setEncoding = () => {}; r.resume = () => {}; process.nextTick(() => { r.emit('data', body); r.emit('end'); }); return r; }
const BODY = process.env.PROBE_BODY || '';   // '' → 404 on every read; '{}' / '[]' → 200 with that body so callers walk further
https.get = (url, opts, cb) => { if (typeof opts === 'function') cb = opts; hits.reads.add(String(url).replace(/[?&](t|cb|_)=\d+/, '')); const req = new EventEmitter(); req.setTimeout = () => req; req.destroy = () => {}; req.end = () => {}; cb && cb(BODY ? fakeRes(200, BODY) : fakeRes(404, '')); return req; };
https.request = (opts, cb) => {
  const p = typeof opts === 'string' ? opts : (opts.path || ''); const m = (opts.method || 'GET').toUpperCase(); const host = opts.hostname || opts.host || '';
  const key = `${m} https://${host}${p}`.replace(/[?&](t|cb|_)=\d+/, '');
  (m === 'GET' ? hits.reads : hits.writes).add(key);
  const req = new EventEmitter(); req.setTimeout = () => req; req.destroy = () => {}; req.write = () => {}; req.end = () => { cb && cb(fakeRes(m === 'GET' ? 404 : 201, m === 'GET' ? '' : '{"content":{"sha":"x"}}')); }; return req; };
global.fetch = async (url, init) => { const m = ((init && init.method) || 'GET').toUpperCase(); const key = (m === 'GET' ? '' : m + ' ') + String(url).replace(/[?&](t|cb|_)=\d+/, ''); (m === 'GET' ? hits.reads : hits.writes).add(key); const ok = !!BODY && m === 'GET' && /githubusercontent/.test(String(url)); return { ok, status: ok ? 200 : 404, statusText: 'stub', json: async () => { if (!ok) throw new Error('stub 404'); return JSON.parse(BODY); }, text: async () => ok ? BODY : '', headers: { get: () => null } }; };
process.exit = (c) => { throw new Error('exit ' + c); };
(async () => {
  const M = require(path.resolve(dir, mod));
  const entry = { 'index.js': async () => { await Promise.allSettled([M.loadPendingState && M.loadPendingState(), M.fetchPriceData && M.fetchPriceData(), M.fetchBackingData && M.fetchBackingData(), M.runWithAnalytics && M.runWithAnalytics()]); },
                  'flows.js': async () => { await M.run(); }, 'market-history.js': async () => { await M.main(); }, 'analytics.js': async () => { await M.main(); }, 'compact-bundle.js': async () => { await M.main(); } }[mod];
  try { await Promise.race([entry(), new Promise(r => setTimeout(r, 4000))]); } catch (e) { /* stubs make it fail — the URLs it reached for are the evidence */ }
  console.log(JSON.stringify({ reads: [...hits.reads].sort(), writes: [...hits.writes].sort() }));
  process.reallyExit(0);
})();
