// gate-by-wallet.mjs — lib/by-wallet.js against the REAL ledgers (nft-collections checkout beside platform-crons, or NC=…)
// and the REAL inventory snapshot: the per-wallet replay must agree with the chain's current attribution to the token.
// Relations, never literals: no token held by two wallets; agreement ≥ 99 % of attributable tokens; every token the
// inventory could not attribute (Enterprise-unattributed, DAODAO custody-unattributed) that the ledger names is reported;
// system addresses have no block; every event carries its role; the heap stays under the Render budget.
//   node --max-old-space-size=200 gate-by-wallet.mjs [slug …]     (default: every slug with ledger + snapshots present)
import fs from 'fs'; import path from 'path'; import { createRequire } from 'module'; import { fileURLToPath } from 'url';
const require = createRequire(import.meta.url); const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BW = require('./lib/by-wallet.js');
const NC = process.env.NC || path.join(__dirname, '../../../nft-collections');
const venues = JSON.parse(fs.readFileSync(path.join(NC, 'venues.json'), 'utf8')).venues;
let pass = 0, fail = 0; const ok = (c, m, d) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m, d === undefined ? '' : '\n      got: ' + JSON.stringify(d).slice(0, 800)); } };
const slugs = process.argv.slice(2).length ? process.argv.slice(2) : fs.readdirSync(NC).filter(s => fs.existsSync(path.join(NC, s, 'ledger/index.json')) && fs.existsSync(path.join(NC, s, 'snapshots/nfts.json')));
if (!slugs.length) { console.log('no collection with ledger/index.json + snapshots/nfts.json under ' + NC + ' — nothing to gate'); process.exit(1); }
// shard rule
ok(BW.SHARDS.length === 32 && new Set(BW.SHARDS).size === 32 && BW.shardOf('terra1hr8zsfpch47qygc96c8e6rzkd2t7mafqx77ulw') === 'w' && BW.shardOf('not-an-address') === '_' && !BW.SHARDS.includes('_'), 'shard rule: 32 bech32 chars + "_" for non-terra ids; the fallback never collides with a real shard');
for (const slug of slugs) {
  console.log(`\n== ${slug} ==`);
  const cj = JSON.parse(fs.readFileSync(path.join(NC, slug, 'collection.json'), 'utf8')); const ix = JSON.parse(fs.readFileSync(path.join(NC, slug, 'ledger/index.json'), 'utf8'));
  const system = BW.systemAddresses(cj, venues); const custodians = new Map(Object.entries((cj.capture && cj.capture.custodians) || {}).map(([a, c]) => [a, c.role]));
  ok(system.has(cj.nft_contract) && [...custodians.keys()].every(a => system.has(a)) && Object.values(venues).every(v => system.has(v.address)), 'system set: the contract, every custodian (keys of capture.custodians) and every venue', [...system].length);
  const t0 = Date.now(); const P = BW.makeProjector({ system, custodians }); let rows = 0;
  for (const mk of ix.months) { const f = path.join(NC, slug, 'ledger', mk + '.json'); if (!fs.existsSync(f)) continue; const m = JSON.parse(fs.readFileSync(f, 'utf8')); for (const r of BW.orderRows(m)) { P.add(r); rows++; } }
  const W = P.finish(); const heap = Math.round(process.memoryUsage().heapUsed / 1e6);
  console.log(`  ${rows} ledger rows → ${Object.keys(W).length} wallets in ${Date.now() - t0} ms, heap ${heap} MB`);
  ok(heap < 200, 'heap under the Render budget (200 MB)', heap);
  ok(!Object.keys(W).some(a => system.has(a)), 'no system address has a wallet block');
  const hold = {}; for (const [a, w] of Object.entries(W)) for (const h of w.holdings_now.tokens) (hold[h.token_id] ||= []).push(a);
  const dups = Object.entries(hold).filter(([, v]) => v.length > 1); ok(dups.length === 0, 'no token is held by two wallets at once', dups.slice(0, 5));
  const STATES = /^(liquid|listed:[a-z0-9-]+|staked|staked_enterprise|staked:[a-z_]+|unstaking|escrow:[a-z0-9-]+|locked)$/;
  ok(Object.values(W).every(w => w.holdings_now.tokens.every(h => STATES.test(h.state) && (h.acquired || h.opened_by))), 'every open position has a known state and names what opened it (acquired or opened_by)');
  ok(Object.values(W).every(w => w.events.every(e => ['from', 'to', 'self', 'holder'].includes(e.role) && !e.superseded_by)), 'every event carries role ∈ {from,to,self,holder}; no superseded row entered');
  ok(Object.values(W).every(w => w.held_past.tokens.every(p => p.released && p.released.kind && (p.acquired || p.opened_by || /no acquisition record/.test(p.note || '')))), 'every closed position says how it closed and how it opened (or that the ledger never saw it open)');
  const trips = Object.values(W).flatMap(w => w.held_past.tokens.filter(p => p.pnl));
  ok(trips.every(p => (p.pnl.usd == null || typeof p.pnl.usd === 'number') && (p.pnl.token == null || (p.pnl.token.symbol && typeof p.pnl.token.delta === 'number')) && (p.pnl.token || p.pnl.note)), `P&L two ways on ${trips.length} round trips: USD and token-terms, or a note why not`);
  ok(trips.every(p => !p.pnl.token || (p.acquired.price.symbol === p.released.price.symbol)), 'token-terms P&L only when both ends were the same symbol (never converted)');
  // reconciliation vs the inventory's per-token attribution (real_owner)
  const inv = JSON.parse(fs.readFileSync(path.join(NC, slug, 'snapshots/nfts.json'), 'utf8')).records;
  let agree = 0, disagree = 0, ledgerNamesUnattributed = 0, unattributed = 0, invOnly = 0; const dis = [];
  for (const t of inv) { const ro = t.real_owner; const ph = hold[t.id] || [];
    if (!ro || t.unminted) continue;
    if (system.has(ro)) { unattributed++; if (ph.length) ledgerNamesUnattributed++; continue; }
    if (!ph.length) { invOnly++; continue; }
    if (ph.includes(ro)) agree++; else { disagree++; if (dis.length < 6) dis.push([t.id, ro.slice(0, 16), ph.map(a => a.slice(0, 16))]); } }
  const rate = agree / Math.max(1, agree + disagree);
  ok(rate >= 0.99, `replay agrees with the inventory's attribution on ${agree}/${agree + disagree} tokens (${(rate * 100).toFixed(2)} %; disagreements are contract-held tokens: gap contracts to name)`, dis);
  ok(invOnly === 0, `every wallet-attributed token in the inventory is held by a wallet in the replay (${invOnly} not)`, invOnly);
  console.log(`  inventory could not attribute ${unattributed} custodied tokens (Enterprise-unattributed / DAODAO custody-unattributed / contract-held); the ledger names a holder for ${ledgerNamesUnattributed} of them`);
  const nullOpen = Object.values(W).reduce((s, w) => s + w.holdings_now.tokens.filter(h => !h.acquired).length, 0), relNoAcq = Object.values(W).reduce((s, w) => s + (w.counts.released_without_acquisition || 0), 0), gaps = Object.values(W).reduce((s, w) => s + (w.counts.gap_closed || 0), 0);
  console.log(`  labeled honesty: ${nullOpen} open positions with acquired:null · ${relNoAcq} releases without an acquisition · ${gaps} positions closed by a gap`);
  const bodies = BW.shardBodies(slug, W, { system }); const inShards = Object.values(bodies).reduce((s, b) => s + b.wallets_in_shard, 0);
  ok(inShards === Object.keys(W).length && Object.keys(bodies).every(sh => BW.SHARDS.includes(sh) || sh === '_'), `shard bodies partition every wallet (${inShards}) into named shards`, Object.keys(bodies).length);
  const big = Math.max(...Object.values(bodies).map(b => JSON.stringify(b).length)); console.log(`  largest shard ${Math.round(big / 1024)} KB · ${Object.keys(bodies).length} shards`);
}
console.log(`\n${pass}/${pass + fail} passed`); process.exit(fail ? 1 : 0);
