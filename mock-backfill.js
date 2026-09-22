#!/usr/bin/env node
// ally-positions/mock-backfill.js — drives backfill.js against a SHAPE archive: 6-second blocks from a fixed genesis, state that
// changes by height (pyROAR supply climbing through the festival, ROAR supply falling by the same amount, the validator moving
// rank), and a height floor the "archive" no longer serves. Usage: TLA_CORE_DIR=<tla-core> node ally-positions/mock-backfill.js
'use strict';
const fs = require('fs'); const path = require('path');
const CORE = process.env.TLA_CORE_DIR; if (!CORE) { console.error('TLA_CORE_DIR required'); process.exit(1); }
process.env.TENANT = 'liondao'; process.env.ARCHIVE_LCD = 'https://archive.mock'; process.env.FROM = '2024-09-01'; process.env.TO = '2024-09-05';
const J = (p) => JSON.parse(fs.readFileSync(p, 'utf8')); const T = J(path.join(CORE, 'docs/curated/tenants.json')).tenants.liondao;
const GENESIS = Date.parse('2022-05-28T00:00:00Z'), BLOCK_MS = 6000, LATEST = 25000000, FLOOR = 8000000;   // heights below FLOOR are "pruned"
const timeAt = (h) => new Date(GENESIS + h * BLOCK_MS).toISOString();
const festivalStart = Math.floor((Date.parse('2023-09-01T00:00:00Z') - GENESIS) / BLOCK_MS), festivalEnd = Math.floor((Date.parse('2024-10-04T00:00:00Z') - GENESIS) / BLOCK_MS);
const burnedAt = (h) => h <= festivalStart ? 0 : h >= festivalEnd ? 109690675868390000 : Math.floor(109690675868390000 * (h - festivalStart) / (festivalEnd - festivalStart));
const CORE_U = 'https://raw.githubusercontent.com/thealliancedao/tla-core/main/';
const ok = (o) => ({ ok: true, status: 200, json: async () => o, text: async () => JSON.stringify(o) }); const bad = (code, msg) => ({ ok: false, status: code, json: async () => ({}), text: async () => msg });
const b64q = (u) => { try { return JSON.parse(Buffer.from(u.split('/smart/')[1].split('?')[0], 'base64').toString()); } catch (e) { return null; } };
const calls = [];
global.fetch = async (url, o) => { url = String(url); calls.push(url); const H = o && o.headers && o.headers['x-cosmos-block-height'] ? Number(o.headers['x-cosmos-block-height']) : null;
  if (url.startsWith(CORE_U)) { const f = path.join(CORE, url.slice(CORE_U.length).split('?')[0]); return fs.existsSync(f) ? ok(J(f)) : bad(404, ''); }
  let m = url.match(/\/blocks\/(latest|\d+)$/); if (m) { const h = m[1] === 'latest' ? LATEST : Number(m[1]); if (h < FLOOR) return bad(500, `height ${h} is not available, lowest height is ${FLOOR}`); if (h > LATEST) return bad(500, 'height too high'); return ok({ block: { header: { height: String(h), time: timeAt(h) } } }); }
  if (H != null && H < FLOOR) return bad(500, `height ${H} is not available, lowest height is ${FLOOR}`);
  m = url.match(/\/contract\/([a-z0-9]+)\/smart\//); if (m) { const q = b64q(url); const c = m[1];
    if (c === T.burn.pyroar_cw20 && q.token_info) return ok({ data: { name: 'Burnt ROAR', symbol: 'pyROAR', decimals: 6, total_supply: String(burnedAt(H)) } });
    if (c === T.staking.roar_cw20 && q.token_info) return ok({ data: { name: 'ROAR', symbol: 'ROAR', decimals: 6, total_supply: String(1000000000000000000 - burnedAt(H)) } });
    if (c === T.staking.roar_staking && q.total_staked_at_height) return ok({ data: { total: String(223768000000000000 + (H % 1000) * 1e6), height: H } });
    if (c === T.staking.pl_voting_module && q.total_power_at_height) return ok({ data: { power: String(2500 + Math.floor((H - festivalStart) / 200000)), height: H } }); }
  if (url.includes('/staking/v1beta1/validators?')) { const vs = []; for (let i = 0; i < 100; i++) vs.push({ operator_address: i === 9 ? T.validator.operator : 'terravaloper1mock' + i, tokens: String((100 - i) * 1e12 + (i === 9 ? (H % 3) * 1e6 : 0)), delegator_shares: String((100 - i) * 1e12) + '.0', commission: { commission_rates: { rate: i === 9 ? '0.075' : '0.05' } }, jailed: false, status: 'BOND_STATUS_BONDED' }); return ok({ validators: vs, pagination: {} }); }
  return bad(404, ''); };
const B = require('./backfill.js');
let pass = 0, fail = 0; const ok2 = (m, c, x) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m + (x !== undefined ? ' → ' + JSON.stringify(x).slice(0, 300) : '')); } };
(async () => {
  const res = await B.run({ fast: true });
  ok2('5 days read (2024-09-01 … 09-05), none skipped', res.rows.length === 5 && res.skipped.length === 0, res.skipped);
  const r0 = res.rows[0];
  ok2('the height is the LAST block of the UTC day: block_time ≤ 23:59:59.999 and the next block is past midnight', r0.block_time.startsWith('2024-09-01T23:59:5') && Date.parse(timeAt(r0.height + 1)) > Date.parse('2024-09-01T23:59:59.999Z'), [r0.height, r0.block_time, timeAt(r0.height + 1)]);
  ok2('every field read at that height and marked ok; pyROAR + ROAR supplies are the fixture at that height (state, not now)', ['pyroar_supply', 'roar_supply', 'roar_staked', 'pixelions_staked', 'validator'].every(k => r0.reads[k] === 'ok') && Math.abs(r0.pyroar_supply - burnedAt(r0.height) / 1e6) < 1e-6 && Math.abs(r0.roar_supply - (1e18 - burnedAt(r0.height)) / 1e6) < 1e-3, r0.reads);
  ok2('Δ pyROAR day over day = ROAR burned that day (the festival curve), and ROAR supply falls by the same amount', res.rows.slice(1).every((r, i) => Math.abs((r.pyroar_supply - res.rows[i].pyroar_supply) + (r.roar_supply - res.rows[i].roar_supply)) < 1e-3) && res.rows[1].pyroar_supply > res.rows[0].pyroar_supply, res.rows.map(r => Math.round(r.pyroar_supply)));
  ok2('validator row: rank #10 of 100, tokens, commission 0.075, not jailed — from the bonded set at that height', r0.validator.rank === 10 && r0.validator.of === 100 && r0.validator.commission_rate === 0.075 && r0.validator.jailed === false, r0.validator);
  ok2('pixeLions staked from total_power_at_height (a count, not a share)', Number.isInteger(r0.pixelions_staked) && r0.pixelions_staked > 2500, r0.pixelions_staked);
  // never-shrink merge
  const ORIG = JSON.parse(JSON.stringify(res.rows)); const doc1 = B.merge(null, JSON.parse(JSON.stringify(res.rows)), res.meta);
  const later = JSON.parse(JSON.stringify(res.rows.slice(2))); later[0].roar_staked = null; later[0].reads.roar_staked = 'timeout'; later[1].pixelions_staked = later[1].pixelions_staked + 7; later.push({ day: '2024-09-06', height: 999, block_time: 'x', reads: { pyroar_supply: 'ok' }, pyroar_supply: 1 });
  const doc2 = B.merge(doc1, later, res.meta);
  ok2('merge never shrinks: a re-read null does not erase a measured value; a new day is added; a differing re-read keeps the previous under `superseded`', doc2.day_count === 6 && doc2.days[2].roar_staked === ORIG[2].roar_staked && doc2.days[3].pixelions_staked === ORIG[3].pixelions_staked + 7 && doc2.days[3].superseded && doc2.days[3].superseded.pixelions_staked.previous === ORIG[3].pixelions_staked, [doc2.day_count, doc2.days[3].superseded]);
  // the archive's floor
  process.env.FROM = '2023-01-01'; process.env.TO = '2023-01-02'; delete require.cache[require.resolve('./backfill.js')]; const B2 = require('./backfill.js');
  const res2 = await B2.run({ fast: true });
  ok2('a day below the archive\'s lowest height is SKIPPED with the node\'s own message — never interpolated, never written', res2.rows.length === 0 && res2.skipped.length === 2 && /does not serve height/.test(res2.skipped[0].reason) && /lowest height is/.test(res2.skipped[0].reason), res2.skipped);
  ok2('no ARCHIVE_LCD → the run refuses', await (async () => { process.env.ARCHIVE_LCD = ''; delete require.cache[require.resolve('./backfill.js')]; try { await require('./backfill.js').run({ fast: true }); return false; } catch (e) { return /ARCHIVE_LCD is required/.test(e.message); } })());
  fs.mkdirSync('out', { recursive: true }); fs.writeFileSync('out/history-mock-daily.json', JSON.stringify(doc1, null, 1));
  console.log(`${pass} passed, ${fail} failed · out/history-mock-daily.json`); process.exit(fail ? 1 : 0);
})().catch(e => { console.error('✗', e); process.exit(1); });
