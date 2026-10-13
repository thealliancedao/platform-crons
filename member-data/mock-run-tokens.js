'use strict';
// mock-run-tokens.js — BINDING gate for holdings.js 1.0.0 + history-tokens.js 1.0.0 on REAL committed data from a tla-core checkout
// (nothing fetched). Usage: TLA_CORE_DIR=<tla-core checkout> node member-data/mock-run-tokens.js
//   T1 the fold seeds every archived day (2026-08-11 →) and every wallet of the last day's capture has that day's row
//   T2 locks: each wallet's LUNA in locks = the capture's own total_locked_luna_equivalent (±0.5 %) — the day's ratios agree with the capture's
//   T3 Votion: LUNA in Votion = Σ underlying LST × the vault's hub rate, per wallet, to the unit
//   T4 the ampCAPA DAO: CAPA 'dao' = the capture's custody amount
//   T5 a holdings day: wallet tokens come from holdings ONLY (no double count of the TLA capture's wallet natives); st / gov / nft land
//      in their places; ampLUNA backing converted to LUNA at the day's ratio; cov carries 'h'
//   T6 a token with no ratio stays itself (zluna) — never converted at a guessed rate; a place not covered is absent, never 0
//   T7 holdings parsers on the proven chain shapes (Rallies stakes / capagov probes): cw20 balance, CAPA gov staker, cw20_stake + claims,
//      delegations + unbonding; a failed read is null (blank), an empty one is 0
//   T8 nftIndex: listed NFTs apart; broken never backs; staked = real owner ≠ holder
//   T9 shards: one file per first address character + index; the whole product stays small (< 6 MB)
const fs = require('fs'), path = require('path');
const SRC = process.env.TLA_CORE_DIR; if (!SRC) { console.error('TLA_CORE_DIR required'); process.exit(1); }
const HT = require('./history-tokens.js'), HD = require('./holdings.js');
let pass = 0, fail = 0; const check = (n, ok, x) => { if (ok) { pass++; console.log('  ✅ ' + n); } else { fail++; console.log('  ❌ ' + n + (x != null ? ' — ' + JSON.stringify(x).slice(0, 400) : '')); } };
const base = 'https://raw.githubusercontent.com/thealliancedao/tla-core/main';
const J = (rel) => JSON.parse(fs.readFileSync(path.join(SRC, rel), 'utf8'));
const fetchJson = async (u) => { const rel = u.replace(base + '/', '').replace(/\?t=\d+$/, ''); const p = path.join(SRC, rel); if (!fs.existsSync(p)) throw new Error('404 ' + rel); return JSON.parse(fs.readFileSync(p, 'utf8')); };
(async () => {
  const days = fs.readdirSync(path.join(SRC, 'member-data/participants/daily')).filter(f => /^\d{4}-\d\d-\d\d\.json$/.test(f)).map(f => f.slice(0, 10)).sort();
  const last = days[days.length - 1];
  const r = await HT.run({ fetchJson, rawBase: base, env: { HISTORY_TOKENS: 'force' }, publishBatch: null, now: () => new Date(last + 'T23:50:00Z'), log: () => {} });
  const shards = {}; for (const f of r.files) if (!f.path.endsWith('index.json')) Object.assign(shards, JSON.parse(f.content).wallets);
  const rowOf = (a, d) => (shards[a] || []).find(x => x[0] === d);
  const parts = J(`member-data/participants/daily/${last}.json`);
  check(`T1 seeded ${r.index.first_day} → ${r.index.last_day} (${r.index.days} days, ${r.index.wallets} wallets); all ${parts.members.length} of ${last}'s wallets have a row`,
    r.index.first_day === HT.FIRST_ARCHIVE_DAY && r.index.last_day === last && parts.members.every(m => rowOf(m.wallet, last)), r.index);
  let lkOk = 0, lkN = 0, odd = 0; const bad = [];
  for (const m of parts.members) { const want = m.summary && m.summary.total_locked_luna_equivalent; if (!(want > 0)) continue;
    if ((m.locks || []).some(l => !/LUNA$/i.test(l.asset_symbol || ''))) continue;
    // a plain-LUNA lock whose chain amount differs from its amount at lock (1 of 43 on 2026-10-13: 1 LUNA in the lock, 899 at lock): the
    // capture's total takes the amount at lock; this product takes the chain's amount in the lock — counted apart, reported below
    if ((m.locks || []).some(l => l.asset_symbol === 'LUNA' && Math.abs(l.amount_human - (l.fixed_amount_human ?? l.amount_human)) > 0.01)) { odd++; continue; } lkN++;
    const got = ((rowOf(m.wallet, last) || [])[2] || {}).LUNA; const v = got && got.lk; if (v && Math.abs(v - want) / want < 0.005) lkOk++; else bad.push([m.wallet.slice(0, 12), want, v]); }
  check(`T2 LUNA in locks = the capture's own figure for ${lkOk}/${lkN} lock holders (±0.5 %; ${odd} with a plain-LUNA lock whose chain amount ≠ its amount at lock, taken at the chain's amount)`, lkN > 50 && lkOk === lkN, bad.slice(0, 5));
  const vot = J(`votion/snapshots/daily/${last}.json`); const vw = new Map();
  for (const v of vot.vaults) for (const h of v.holders || []) vw.set(h.address, (vw.get(h.address) || 0) + h.underlying_lst * v.lst_luna_hub_rate);
  const vbad = [...vw].filter(([a, l]) => l > 0 && Math.abs((((rowOf(a, last) || [])[2] || {}).LUNA || {}).vt - l) > 1e-3 * Math.max(1, l));
  check(`T3 Votion: ${vw.size} holders, LUNA = underlying × hub rate for each`, vw.size > 5 && vbad.length === 0, vbad.slice(0, 3));
  const cus = parts.members.filter(m => (m.custody || []).length); const cbad = cus.filter(m => { const c = m.custody.reduce((a, x) => a + x.amount, 0); const got = (((rowOf(m.wallet, last) || [])[2] || {}).CAPA || {}).dao; return !(Math.abs(got - c) <= 1e-6 * c + 1e-6); });
  check(`T4 the ampCAPA DAO: ${cus.length} wallets' custody CAPA = 'dao'`, cus.length > 0 && cbad.length === 0, cbad.slice(0, 3).map(m => m.wallet.slice(0, 12)));
  // T5 a synthetic holdings day on top of a real wallet's real capture
  const m = parts.members.find(x => (x.wallet_balances || []).length && (x.locks || []).length);
  const ratios = { ampLUNA: { ratio: 2, base: 'LUNA' }, arbLUNA: { ratio: 3, base: 'LUNA' }, bLUNA: { ratio: 1.7, base: 'LUNA' }, ampCAPA: { ratio: 1.1, base: 'CAPA' } };
  const st = { wallets: new Map() };
  HT.foldDay(st, last, { parts: { members: [m] }, holdings: { wallets: { [m.wallet]: { tokens: { LUNA: 5, CAPA: 100, ampLUNA: 1 }, staked: { LUNA: { delegated: 7, unbonding: 3 } },
    gov: { 'capa-gov': { token: 'CAPA', staked: 50, unstaking: 0 }, 'roar-stake': { token: 'ROAR', staked: 10, unstaking: 2 } }, nft: { unbroken: 2, backing: { token: 'ampLUNA', amount: 200 } } } } }, ratios });
  const [, cov, bag] = st.wallets.get(m.wallet).get(last);
  check(`T5 holdings day: cov '${cov}', wallet LUNA 5 + ls 2 (not the capture's ${m.wallet_balances.length} natives), st 10, CAPA gov 50, ROAR gov 12, nft 400 LUNA`,
    cov === 'ph' && bag.LUNA.w === 5 && bag.LUNA.ls === 2 && bag.LUNA.st === 10 && bag.CAPA.gov === 50 && bag.CAPA.w === 100 && bag.ROAR.gov === 12 && bag.LUNA.nft === 400 && bag.LUNA.lk > 0, { cov, bag });
  const st2 = { wallets: new Map() }; HT.foldDay(st2, last, { parts: { members: [{ wallet: 'terra1x', wallet_balances: [{ symbol: 'zluna', amount_human: 3 }] }] }, ratios, norm: (s) => s });
  const b2 = st2.wallets.get('terra1x').get(last)[2];
  check('T6 zluna (no ratio) stays itself; places not covered are absent', b2.zluna && b2.zluna.w === 3 && !b2.LUNA && !('st' in b2.zluna), b2);
  // T7 parsers on the proven shapes
  const ok7 = HD.parseCw20Balance({ balance: '1500000' }) === '1500000' && HD.parseCw20Balance(null) === null
    && HD.parseCapaGov({ balance: '7', share: '7', locked_balance: [], reward: '0' }) === '7' && HD.parseCapaGov({}) === null
    && JSON.stringify(HD.parseCw20Stake({ balance: '10' }, { claims: [{ amount: '4', release_at: { at_time: '1' } }, { amount: '1' }] })) === JSON.stringify({ staked: '10', unstaking: '5' })
    && HD.parseCw20Stake({ balance: '10' }, null) === null
    && HD.parseDelegations({ delegation_responses: [{ balance: { denom: 'uluna', amount: '3' } }, { balance: { denom: 'uluna', amount: '4' } }] }) === 7n && HD.parseDelegations({ delegation_responses: [] }) === 0n && HD.parseDelegations(null) === null
    && HD.parseUnbonding({ unbonding_responses: [{ entries: [{ balance: '2' }, { balance: '3' }] }] }) === 5n && HD.parseUnbonding(null) === null;
  const nn = HD.nameNatives([{ denom: 'uluna', amount: '2500000' }, { denom: 'factory/terra1abc/zluna', amount: '1000000' }, { denom: 'ibc/XYZ', amount: '9' }, { denom: 'uluna2', amount: '0' }], null);
  check('T7 parsers: cw20 · CAPA gov · cw20_stake + claims · delegations · unbonding; failed = null, empty = 0; natives named (LUNA, LUNA-family factory), the rest kept raw',
    ok7 && nn.tokens.LUNA === 2.5 && nn.tokens.zluna === 1 && nn.unknown['ibc/XYZ'] === '9', nn);
  const ix = HD.nftIndex({ records: [{ id: '1', owner: 'terra1a', real_owner: 'terra1a', broken: false }, { id: '2', owner: 'terra1stake', real_owner: 'terra1a', broken: false },
    { id: '3', owner: 'terra1a', real_owner: 'terra1a', broken: true }, { id: '4', owner: 'terra1mkt', real_owner: 'terra1a', broken: false, listing: { price: 1 } }, { id: '5', unminted: true, owner: 'terra1a' }] }).get('terra1a');
  check('T8 nftIndex: held 2 · staked 1 · listed 1 apart · unbroken 2 · broken 1', ix.held === 2 && ix.staked === 1 && ix.listed === 1 && ix.unbroken === 2 && ix.broken === 1, ix);
  const bytes = r.files.reduce((a, f) => a + f.content.length, 0);
  check(`T9 ${r.files.length - 1} shards + index, ${(bytes / 1e6).toFixed(2)} MB in all, largest ${(Math.max(...r.files.map(f => f.content.length)) / 1e3).toFixed(0)} KB`, r.files.length > 20 && bytes < 6e6);
  console.log(`\n${pass}/${pass + fail} passed`); process.exit(fail ? 1 : 0);
})().catch(e => { console.error('GATE CRASH', e); process.exit(1); });
