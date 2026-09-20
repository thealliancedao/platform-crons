// gate-nft-tools.mjs — v1.14.0: the NFT tools' logic on REAL fixtures (the nft-collections checkout beside platform-crons,
// or NC=…): a by-wallet shard built by THE rule (nfts/nft-flows/lib/by-wallet.js) from the real ledger, compacted for the
// model; a real token's by-token rows compacted; the collection list from the real tenant registry; every tool result under
// the 12,000-char tool cap so the model never reads a JSON cut mid-object. Relations, never literals.
//   node --max-old-space-size=200 gate-nft-tools.mjs
import fs from 'node:fs'; import path from 'node:path'; import { createRequire } from 'node:module'; import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url); const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NFT = require('./lib/nft-tools.js'); const BW = require('../nfts/nft-flows/lib/by-wallet.js');
const NC = process.env.NC || path.join(__dirname, '../../nft-collections'); const TC = process.env.TENANTS || path.join(__dirname, '../../tla-core/docs/curated/tenants.json');
let pass = 0, fail = 0; const ok = (c, m, d) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m, d === undefined ? '' : '\n      got: ' + JSON.stringify(d).slice(0, 600)); } };
const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
ok(NFT.hasWalletRule() && NFT.walletShard('terra1hr8zsfpch47qygc96c8e6rzkd2t7mafqx77ulw') === BW.shardOf('terra1hr8zsfpch47qygc96c8e6rzkd2t7mafqx77ulw'), 'the wallet shard rule is REQUIRED from nfts/nft-flows/lib/by-wallet.js (one rule, no copy)');
ok(!/BECH32|qpzry9x8gf2tvdw0s3jn54khce6mua7l/.test(fs.readFileSync(path.join(__dirname, 'lib/nft-tools.js'), 'utf8')), 'nft-tools.js carries no copy of the bech32 shard alphabet');
ok(/name: 'nft_wallet'/.test(src) && /name: 'nft_token'/.test(src) && /if \(name === 'nft_wallet' \|\| name === 'nft_token'\) return nftTool/.test(src), 'server.js declares nft_wallet + nft_token and routes them to nftTool');
ok(/'members', 'wallets'\]/.test(src) && /Array\.isArray\(found\.events\)/.test(src), "read_product key extraction lifts wallets[<addr>] and compacts a block's events head/tail");
ok(/14\. NFT DATA MAP/.test(src) && /enterprise_unattributed_count/.test(src) && /never one "staked" number/.test(src), 'system prompt carries the NFT data map with the staked-vs-held discipline');
ok(NFT.tokenShard('2124', 100) === '021' && NFT.tokenShard('0', 100) === '000' && NFT.tokenShard('9999', 100) === '099' && NFT.tokenShard('abc', 100) === 'x', 'token shard = floor(id / shard_size) zero-padded to 3, non-numeric → x');
// tenant registry → collections
if (fs.existsSync(TC)) { const cols = NFT.collectionsFromTenants(JSON.parse(fs.readFileSync(TC, 'utf8'))); ok(cols.includes('adao') && cols.includes('pixel-lions') && !cols.includes('burning-lions'), 'collections from the real tenant registry: adao + pixel-lions (burning-lions not until its registry line)', cols); }
else { const cols = NFT.collectionsFromTenants({ tenants: { a: { live: true, collections: ['adao'] }, l: { live: true, collections: ['pixel-lions', 'x'] }, dead: { live: false, collections: ['zzz'] } } }); ok(cols.join() === 'adao,pixel-lions,x', 'collectionsFromTenants: live tenants only, deduped (registry file not local — fixture used)', cols); }
// real shard from the real ledger
const slug = fs.existsSync(path.join(NC, 'adao/ledger/index.json')) ? 'adao' : 'pixel-lions';
const cj = JSON.parse(fs.readFileSync(path.join(NC, slug, 'collection.json'), 'utf8')); const venues = JSON.parse(fs.readFileSync(path.join(NC, 'venues.json'), 'utf8')).venues;
const system = BW.systemAddresses(cj, venues); const custodians = new Map(Object.entries((cj.capture && cj.capture.custodians) || {}).map(([a, c]) => [a, c.role]));
const ix = JSON.parse(fs.readFileSync(path.join(NC, slug, 'ledger/index.json'), 'utf8')); const P = BW.makeProjector({ system, custodians }); const byTok = {};
for (const mk of ix.months) { const f = path.join(NC, slug, 'ledger', mk + '.json'); if (!fs.existsSync(f)) continue; for (const r of BW.orderRows(JSON.parse(fs.readFileSync(f, 'utf8')))) { P.add(r); if (r.token_id != null && !r.superseded_by) (byTok[r.token_id] ||= []).push(r); } }
const W = P.finish(); const bodies = BW.shardBodies(slug, W, { system });
const biggest = Object.values(W).sort((a, b) => b.events_count - a.events_count)[0]; const shard = bodies[BW.shardOf(biggest.address)];
ok(shard && shard.wallets[biggest.address] === biggest, `the biggest ${slug} wallet (${biggest.events_count} events) sits in shard ${BW.shardOf(biggest.address)}`);
const c = NFT.compactWallet(biggest, slug); const len = JSON.stringify(c).length;
ok(len < 12000, `compacted biggest wallet is under the 12,000-char tool cap (${len})`, len);
ok(c.holdings_now.total === biggest.holdings_now.total && c.held_past.total === biggest.held_past.total && c.counts === biggest.counts && c.realized === biggest.realized, 'compaction keeps the totals, counts and realized P&L exactly');
ok(c.events.total === biggest.events_count && c.events.first.length >= 2 && c.events.last.length >= 2 && c.events.last[c.events.last.length - 1].startsWith(String(biggest.events[biggest.events.length - 1].ts).slice(0, 10)) && c.events.not_shown === biggest.events_count - c.events.first.length - c.events.last.length, 'long event lists are head/tail lines with the total and the not_shown count; the newest event is last', [c.events.total, c.events.not_shown, c.events.last.slice(-1)]);
ok(c.holdings_now.tokens.some(l => /acquired by sale \d{4}-\d{2}-\d{2} for [\d,.]+ (LUNA|bLUNA|USDC|SOLID|ampLUNA) \$[\d,.]+/.test(l)) && c.holdings_now.tokens.every(l => /^#\d+ (liquid|listed:|staked|unstaking|escrow:|locked)/.test(l)), 'holding lines read "#id state since date — acquired by <kind> <date> for <amount> <symbol> $usd"', c.holdings_now.tokens.slice(0, 2));
// a wallet with closed positions and P&L
const flipper = Object.values(W).find(w => w.realized && w.realized.round_trips >= 2 && w.realized.usd.priced >= 1); const cf = flipper && NFT.compactWallet(flipper, slug);
ok(cf && cf.held_past.most_recent.some(l => /P&L [+-]\$[\d.]+ \/ ([+-][\d.]+ LUNA|token-terms n\/a)/.test(l)) && cf.realized.round_trips === flipper.realized.round_trips, 'a flipper\'s compacted block carries P&L two ways per closed position ("P&L +$x / +y LUNA" or "token-terms n/a (why)") and the realized totals', cf && cf.held_past.most_recent.slice(0, 2));
// a token journey
const tid = Object.keys(byTok).sort((a, b) => byTok[b].length - byTok[a].length)[0]; const rows = BW.orderRows(byTok[tid]); const ct = NFT.compactToken(rows, slug, tid, system); const tl = JSON.stringify(ct).length;
ok(ct.records === rows.length && ct.summary.sales === rows.filter(r => r.kind === 'sale' || r.kind === 'mint_purchase').length && ct.summary.listings === rows.filter(r => r.kind === 'list').length && ct.summary.last_custody_event, `the busiest ${slug} token #${tid} (${rows.length} rows): counts are relations to its rows, last custody event named`, ct.summary);
ok(tl < 12000, `compacted token journey under the tool cap (${tl})`, tl);
ok(ct.sales.every(l => /→/.test(l) && /(\$[\d,.]+|usd n\/a)/.test(l)), 'every sale line names from→to and a USD figure or "usd n/a" (never a missing price)', ct.sales.slice(0, 2));
console.log(`\n${pass}/${pass + fail} passed`); process.exit(fail ? 1 : 0);
