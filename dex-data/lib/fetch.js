// =============================================================================
// dex-data / lib / fetch.js
// =============================================================================
// Shared HTTP helpers — redirect-following, timeout, retry/backoff. Lifted from
// the proven skeletonswap-lp / astroport crons. Two Terra LCD endpoints are
// used for retry/backoff on any chain query (publicnode primary + fallback).
// =============================================================================

const https = require('https');

const TERRA_LCD_ENDPOINTS = [
  'https://terra-rest.publicnode.com',
  'https://terra.publicnode.com',
];

function httpRequest(url, { method = 'GET', headers = {}, body = null, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error(`bad url: ${url}`)); }
    const reqOpts = {
      method,
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + (u.search || ''),
      headers: {
        'User-Agent': 'dex-data-cron/1.0',
        ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}),
        ...headers,
      },
      timeout: timeoutMs,
    };
    const req = https.request(reqOpts, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return resolve(httpRequest(next, { method, headers, body, timeoutMs }));
      }
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode} from ${url}: ${data.slice(0, 160)}`));
        resolve({ status: res.statusCode, body: data });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error(`timeout ${timeoutMs}ms: ${url}`)));
    if (body) req.write(body);
    req.end();
  });
}

async function fetchJsonWithRetry(url, label = 'fetch', { tries = 3, timeoutMs = 15000 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await httpRequest(url, { timeoutMs });
      return JSON.parse(res.body);
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }
  throw new Error(`${label} failed after ${tries} tries: ${lastErr && lastErr.message}`);
}

// CosmWasm smart query with LCD fallback across both endpoints. Returns the
// `data` field of the smart-query response, or throws after exhausting both.
// IMPORTANT: distinguishes a failed query (throws) from a legitimately-empty
// result (returns the empty value) — never silently coerces a failure to [].
async function queryContract(contractAddr, queryObj, { tries = 2, timeoutMs = 15000 } = {}) {
  const queryB64 = Buffer.from(JSON.stringify(queryObj)).toString('base64');
  let lastErr;
  for (const base of TERRA_LCD_ENDPOINTS) {
    for (let i = 0; i < tries; i++) {
      try {
        const url = `${base}/cosmwasm/wasm/v1/contract/${contractAddr}/smart/${queryB64}`;
        const res = await httpRequest(url, { timeoutMs });
        const parsed = JSON.parse(res.body);
        if (parsed && 'data' in parsed) return parsed.data;
        throw new Error('no data field in smart-query response');
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 350 * (i + 1)));
      }
    }
  }
  throw new Error(`queryContract ${contractAddr} failed on both LCDs: ${lastErr && lastErr.message}`);
}

module.exports = { httpRequest, fetchJsonWithRetry, queryContract, TERRA_LCD_ENDPOINTS };
