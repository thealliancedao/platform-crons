// gate-activity.mjs — the activity fold (lib/activity.js) against the REAL ledgers of all three collections.
// Usage: node gate-activity.mjs [path to nft-collections checkout] [out dir for seed activity.json files]
// Asserts the owner's own cases (2026-09-20): the lock restructure txs fold to one row each and to one row per hour per
// wallet; bulk stakes/unstakes fold with their ids; a same-owner delist+relist inside 24 h is one price change; listings
// carry the tier floor of their day and vs-floor; a listed lock carries its backing.
import fs from 'node:fs'; import path from 'node:path'; import { createRequire } from 'node:module';
const require = createRequire(import.meta.url); const A = require('./lib/activity.js');
const NC = process.argv[2] || path.resolve('../../../nft-collections'); const OUT = process.argv[3] || null;
const J = (p) => JSON.parse(fs.readFileSync(path.join(NC, p), 'utf8'));
let pass = 0, fail = 0; const ok = (c, m, d) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m, d === undefined ? '' : '\n      got: ' + JSON.stringify(d).slice(0, 400)); } };
const WINDOW = 35; const now = Date.now(); const cut = now - WINDOW * 86400e3;
const venues = J('venues.json').venues;
const months = () => { const d = new Date(now), m = []; for (const b of [1, 0]) { const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - b, 1)); m.push(`${x.getUTCFullYear()}/${String(x.getUTCMonth() + 1).padStart(2, '0')}`); } return m; };
function ctxFor(slug) {
  const cj = J(`${slug}/collection.json`); const kind = cj.kind === 'escrow' || (cj.capture && cj.capture.kind === 'escrow') ? 'escrow' : 'nft';
  const custodians = new Map(Object.entries((cj.capture && cj.capture.custodians) || {}).map(([a, c]) => [a, c.role]));
  const system = new Set([cj.nft_contract, ...custodians.keys(), ...Object.values(venues).map(v => v.address)].filter(Boolean));
  const ctx = { now, window_days: WINDOW, kind, venues, custodians, system };
  if (kind === 'nft') {
    const inv = J(`${slug}/snapshots/nfts.json`); const broken = new Set(inv.records.filter(r => r.broken).map(r => String(r.id)));
    let rank1 = new Set(); try { const rr = J(cj.rarity.file.replace(/^[^/]+\//, `${slug}/`)); rank1 = new Set((rr.records || []).filter(r => Number(r.rank) === 1).map(r => String(r.token_id))); } catch { }
    ctx.tierOf = A.makeTierOf({ registryTiers: cj.tiers, brokenIds: broken, rank1Ids: rank1 });
    let fh = null; try { fh = J(`${slug}/snapshots/floor-history.json`); } catch { }
    ctx.floorAt = A.makeFloorAt(fh); ctx.floorNow = fh && fh.rows && fh.rows.length ? fh.rows[fh.rows.length - 1] : null;
  } else {
    const shards = fs.readdirSync(path.join(NC, `${slug}/ledger/by-token`)).filter(f => /^\d+\.json$/.test(f));
    const byTok = new Map(); for (const f of shards) for (const [id, recs] of Object.entries(J(`${slug}/ledger/by-token/${f}`).tokens || {})) byTok.set(String(id), recs);
    ctx.backingOf = (id) => { const t = byTok.get(String(id)); if (!t) return null; const recs = (Array.isArray(t) ? t : (t.records || [])).filter(r => !r.superseded_by && r.lock && r.lock.asset); const last = recs[recs.length - 1]; if (!last) return null; const [, addr, amt] = String(last.lock.asset).match(/^(?:cw20|native):([^:]+):(\d+)$/) || []; if (!addr) return null; const sym = /ecgazyd/.test(addr) ? 'ampLUNA' : /17aj4ty/.test(addr) ? 'bLUNA' : null; return { amount: Number(amt) / 1e6, denom: addr, symbol: sym, usd: null }; };
    // known wallets before the window: every wallet that created / received a lock in any month before the window months
    const known = new Set(); const wm = months(); const ix = J(`${slug}/ledger/index.json`);
    for (const mk of ix.months) for (const r of J(`${slug}/ledger/${mk}.json`)) if (!r.superseded_by && Date.parse(r.ts) < cut && (r.kind === 'lock_create' || r.kind === 'lock_transfer')) known.add(r.to || r.from);
    ctx.knownWallets = known;
  }
  return ctx;
}
const results = {};
for (const slug of ['adao', 'pixel-lions', 'tla-locks']) {
  console.log(`\n== ${slug}`);
  const rows = []; for (const mk of months()) { try { rows.push(...J(`${slug}/ledger/${mk}.json`)); } catch { } }
  const inWin = rows.filter(r => r.ts && Date.parse(r.ts) >= cut);
  const ctx = ctxFor(slug); const t0 = Date.now(); const r = A.fold(inWin, Object.assign({ max_txs: Infinity }, ctx)); results[slug] = { r, ctx };   // the gate reads every hash; the product keeps 12 per episode + tx_count
  console.log(`  ${inWin.length} rows → ${r.episodes.length} episodes in ${Date.now() - t0} ms · ${JSON.stringify(r.stats.by_kind)}`);
  ok(r.episodes.every(e => e.id && e.kind && e.ts && e.count >= 1 && e.txs.length), 'every episode has id/kind/ts/count/txs');
  ok(r.episodes.every(e => e.count === e.tokens.length), 'count = tokens.length');
  const txs = new Set(); for (const e of r.episodes) for (const t of e.txs) txs.add(t);
  const liveTx = new Set(inWin.filter(x => !x.superseded_by && A.KIND_MAP[x.kind]).map(x => x.txhash));
  ok([...liveTx].every(t => txs.has(t)) && r.episodes.every(e => e.tx_count === e.txs.length), 'every live human tx is in some episode (nothing dropped; tx_count = hashes kept)', [...liveTx].filter(t => !txs.has(t)).slice(0, 3));
  ok(r.episodes.every(e => !e.tokens.some(t => t.id === 'undefined' || t.id === 'null')), 'no "#undefined" tokens');
  if (OUT) {
    const env = { product: `${slug}/ledger/activity`, collection: slug, rule_version: A.VERSION, engine: 'seed:gate-activity', window_days: WINDOW, built_at: new Date(now).toISOString(), rules: A.RULES,
      floor_now: ctx.floorNow ? { date: ctx.floorNow.date, per_tier: ctx.floorNow.per_tier } : null, stats: r.stats, episodes: A.fold(inWin, ctx).episodes,
      note: 'SEED written by gate-activity from the committed ledgers; org-nft-flows 1.6.0 overwrites it hourly with the same rule. Facts only: thresholds live in docs/curated/alert-thresholds.json.' };
    fs.mkdirSync(path.join(OUT, slug, 'ledger'), { recursive: true }); fs.writeFileSync(path.join(OUT, slug, 'ledger', 'activity.json'), JSON.stringify(env) + '\n');
  }
}
// ---- the owner's cases
{ const E = results['tla-locks'].r.episodes;
  const byTx = (h) => E.filter(e => e.txs.some(t => t.startsWith(h)));
  const a = byTx('A6396622B3676CD4C8486823A68F7D7AACD44B2AFF253F6FF996C4BAE50C71DE'); ok(a.length === 1 && a[0].kind === 'lock_restructure' && a[0].detail.verbs.includes('lock_split') && a[0].detail.verbs.includes('lock_migrate'), 'A6396622 (split + migrate, one tx) → ONE lock_restructure episode', a.map(e => [e.kind, e.detail.verbs]));
  const f = byTx('F6850F35A92F20FE411B38CF9F70DACA30C5D87ED42F934979ED44B0FD33286F'); ok(f.length === 1, 'F6850F35 (merge) → one episode, folded with the split/migrate 0 min later or alone', f.map(e => [e.kind, e.count]));
  const l = E.filter(e => e.wallet && e.wallet.startsWith('terra1lsasu5') && e.kind === 'lock_restructure'); const three = l.find(e => ['37C8BE86', '9D93B30B', 'D363B019'].every(h => e.txs.some(t => t.startsWith(h))));
  ok(!!three, 'terra1lsasu5: the three set-auto-max + merge txs inside one hour → ONE episode', l.slice(0, 4).map(e => [e.ts, e.txs.map(t => t.slice(0, 8)), e.count]));
  ok(three && three.detail.verbs.includes('lock_permanent') && three.detail.verbs.includes('lock_merge') && three.count >= 6, 'that episode names both verbs and carries all its rows', three && [three.detail.verbs, three.count]);
  const nv = E.filter(e => e.kind === 'lock_new' && e.flags.includes('new_voter')); const old = E.filter(e => e.kind === 'lock_new' && !e.flags.includes('new_voter'));
  ok(E.filter(e => e.kind === 'lock_new').every(e => e.vp != null), 'every lock_new carries vp (voting_power / 1e6)');
  console.log(`  lock_new: ${nv.length} new voters · ${old.length} existing voters`);
  const listed = E.filter(e => e.flags.includes('listed_lock') || e.flags.includes('lock_sold'));
  ok(listed.length > 0 && listed.every(e => e.tokens.every(t => t.backing && t.backing.amount > 0)), 'listed / sold locks carry their backing (amount + asset)', listed.map(e => [e.kind, e.token, e.tokens[0].backing]));
}
{ const E = results['pixel-lions'].r.episodes;
  const bulk = E.filter(e => e.count >= 2); console.log(`  PL bulk episodes: ${bulk.slice(0, 6).map(e => `${e.kind}×${e.count}`).join(' · ')}`);
  ok(bulk.every(e => e.token_ids && e.token_ids.length === e.count), 'bulk episodes carry token_ids');
  const st = E.filter(e => e.kind === 'stake' || e.kind === 'unstake'); ok(st.every(e => e.flags.includes('daodao') || e.custodian), 'stake/unstake episodes name their custodian', st.slice(0, 2).map(e => [e.kind, e.custodian, e.flags]));
  const lst = E.filter(e => e.kind === 'listing' && e.count === 1 && e.tier); ok(lst.length > 0 && lst.every(e => e.floor_then !== undefined), 'single listings carry tier + floor_then', lst.slice(0, 2).map(e => [e.token, e.tier, e.usd, e.floor_then, e.vs_floor_pct]));
  const under = E.filter(e => e.flags.includes('under_floor')); console.log(`  PL under-floor listings: ${under.length}` + (under[0] ? ` e.g. #${under[0].token} ${under[0].usd?.toFixed(2)} vs floor ${under[0].floor_then} (${under[0].vs_floor_pct}%)` : ''));
  const pcs = E.filter(e => e.kind === 'price_change'); console.log(`  PL price changes: ${pcs.length}` + (pcs[0] ? ` e.g. #${pcs[0].token} ${pcs[0].detail.from_amount} → ${pcs[0].detail.to_amount} (${pcs[0].detail.pct}%) in ${pcs[0].detail.hours_between} h` : ''));
  ok(pcs.every(e => e.detail.hours_between <= 24 && e.txs.length === 2), 'price changes: two txs, ≤ 24 h');
}
{ const E = results['adao'].r.episodes; const pcs = E.filter(e => e.kind === 'price_change'); const lst = E.filter(e => e.kind === 'listing');
  console.log(`  aDAO: ${lst.length} listings · ${pcs.length} price changes · sales ${E.filter(e => e.kind === 'sale').length}`);
  const sale = E.find(e => e.kind === 'sale'); ok(!sale || ('days_on_market' in sale) || sale.count > 1, 'a sale carries days_on_market (or null = listed before the window)', sale && [sale.token, sale.days_on_market, sale.list_usd]);
  ok(E.every(e => !(e.kind === 'listing' && e.tier === 'phoenix' && e.vs_floor_pct == null && e.floor_then)), 'phoenix listings measured against the phoenix floor, never base');
}
// ---- synthetic: the price-change and fold rules on hand-made rows (the real window may hold none)
{ const t = (h) => new Date(Date.UTC(2026, 8, 20, h)).toISOString(); const R = (o) => Object.assign({ txhash: 'X' + Math.random().toString(16).slice(2), height: 1, msg_index: 0, collection: 'adao', venue: 'bbl', usd: 10 }, o);
  const rows = [R({ kind: 'list', token_id: '7', from: 'terra1own', to: 'terra1bbl', ts: t(1), price: { amount: '5000000000', denom: 'uluna' }, denom_symbol: 'LUNA', usd: 250 }),
    R({ kind: 'delist', token_id: '7', from: 'terra1bbl', to: 'terra1own', ts: t(5) }),
    R({ kind: 'list', token_id: '7', from: 'terra1own', to: 'terra1bbl', ts: t(6), price: { amount: '4000000000', denom: 'uluna' }, denom_symbol: 'LUNA', usd: 200 }),
    R({ kind: 'delist', token_id: '8', from: 'terra1bbl', to: 'terra1own', ts: t(2) }),
    R({ kind: 'list', token_id: '8', from: 'terra1own', to: 'terra1bbl', ts: t(2 + 30), price: { amount: '1', denom: 'uluna' }, denom_symbol: 'LUNA', usd: 1 }),   // 30 h later: a new listing, not a price change
    ...Array.from({ length: 12 }, (_, i) => R({ kind: 'unstake', token_id: String(100 + i), from: 'terra1dao', to: 'terra1own', custodian: 'daodao_voting', ts: t(10 + (i % 3) / 60), venue: null, txhash: 'U' + (i % 3) })),
  ];
  const tierOf = () => 'base'; const floorAt = () => ({ base: { listing_floor_usd: 210 } });
  const r = A.fold(rows, { now: Date.parse(t(40)), kind: 'nft', venues: {}, custodians: new Map([['terra1dao', 'daodao_voting']]), system: new Set(['terra1bbl', 'terra1dao']), tierOf, floorAt });
  const pc = r.episodes.filter(e => e.kind === 'price_change'); ok(pc.length === 1 && pc[0].token === '7' && pc[0].detail.from_amount === 5000 && pc[0].detail.to_amount === 4000 && pc[0].detail.pct === -20, 'synthetic: delist+relist inside 24 h → ONE price change 5,000 → 4,000 (−20%)', pc);
  ok(pc[0].vs_floor_pct === +(((200 / 210) - 1) * 100).toFixed(1) && pc[0].flags.includes('under_floor'), 'the new price is measured against the day\'s tier floor → under_floor', pc[0] && [pc[0].vs_floor_pct, pc[0].flags]);
  ok(r.episodes.filter(e => e.kind === 'listing').length === 2 && r.episodes.filter(e => e.kind === 'delisting').length === 1, 'synthetic: the 30 h relist stays a listing + a delisting (no pair)', r.stats.by_kind);
  const un = r.episodes.filter(e => e.kind === 'unstake'); ok(un.length === 1 && un[0].count === 12 && un[0].flags.includes('mass') && un[0].flags.includes('daodao') && un[0].token_ids.length === 12, 'synthetic: 12 unstakes over 3 txs in 3 min → ONE episode ×12, flags mass + daodao', un.map(e => [e.count, e.flags]));
}
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
