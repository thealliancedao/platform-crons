'use strict';
// help-agent/lib/nft-tools.js 1.0.0 (2026-09-20, v1.14.0) — the NFT tools' logic, pure and gate-able.
//
// Two questions the bot could not answer before D.1: "what did / does terra1… hold on collection X" (address history,
// past holdings included) and "what happened to token #N" (its journey). Both are answered from the nft-flows shards
// org-nft-flows writes: <slug>/ledger/by-wallet/<shard>.json (the ledger replayed per address; shard = the address's last
// bech32 char — THE rule lives in nfts/nft-flows/lib/by-wallet.js and is required here, never copied) and
// <slug>/ledger/by-token/<shard>.json (shard = floor(id / shard_size) from that product's own index.json).
// The tools fetch one shard, lift one block, and COMPACT it for the model (summary first, events head/tail) — the model
// never sees a truncated JSON cut mid-object. Collections come from the tenant registry (tla-core/docs/curated/tenants.json).

const path = require('path');
let BW = null; try { BW = require(path.join(__dirname, '..', '..', 'nfts', 'nft-flows', 'lib', 'by-wallet.js')); } catch (e) { BW = null; }   // the platform-crons checkout holds every cron; Render clones the whole repo
const NFTC_REPO = 'https://raw.githubusercontent.com/thealliancedao/nft-collections/main';
const ADDR = /^terra1[a-z0-9]{38,58}$/;

function walletShard(address) { if (!BW) throw new Error('by-wallet rule unavailable (nfts/nft-flows/lib/by-wallet.js not found beside help-agent)'); return BW.shardOf(address); }
const walletShardUrl = (slug, address) => `${NFTC_REPO}/${slug}/ledger/by-wallet/${walletShard(address)}.json`;
function tokenShard(tokenId, shardSize) { const n = Number(tokenId); if (!Number.isInteger(n) || n < 0) return 'x'; return String(Math.floor(n / (shardSize || 100))).padStart(3, '0'); }
const tokenShardUrl = (slug, tokenId, shardSize) => `${NFTC_REPO}/${slug}/ledger/by-token/${tokenShard(tokenId, shardSize)}.json`;

// live tenants → their collections (the registry's line is the whole switch: a new collection appears here the day it is added)
function collectionsFromTenants(tenantsJson) {
  const out = []; for (const t of Object.values((tenantsJson && tenantsJson.tenants) || {})) if (t && t.live !== false) for (const c of (t.collections || [])) if (!out.includes(c)) out.push(c);
  return out;
}

const BUDGET = 11000;   // chars — under the server's tool_result slice, with room for the wrapper; lists shrink until it fits
const money = (m) => m && m.amount != null ? `${m.decimals != null ? (Number(m.amount) / Math.pow(10, m.decimals)).toLocaleString('en-US', { maximumFractionDigits: 4 }) : m.amount + '(raw)'} ${m.symbol || m.denom || '?'}${m.usd != null ? ' $' + Number(m.usd).toLocaleString('en-US', { maximumFractionDigits: 2 }) : ' (usd n/a)'}` : '';
const evMoney = (e) => e.price ? money({ amount: e.price.amount, decimals: e.denom_decimals, symbol: e.denom_symbol, denom: e.price.denom, usd: e.usd }) : '';
// one ledger row → one line the model can read: date · kind(role) · #token · price · from→to · venue/custodian · tx
const evLine = (e) => [String(e.ts || '').slice(0, 10), `${e.kind}${e.role ? '(' + e.role + ')' : ''}`, e.token_id != null ? '#' + e.token_id : null, evMoney(e) || null, (e.from || e.to) ? `${e.from || '?'}→${e.to || '?'}` : null, e.venue ? 'venue:' + e.venue : (e.custodian ? 'custodian:' + e.custodian : null), e.note ? 'note:' + e.note : null, e.repaired_by ? 'repaired' : null, e.txhash ? 'tx:' + e.txhash : null].filter(Boolean).join(' · ');
const holdLine = (h) => `#${h.token_id} ${h.state} since ${String(h.since || '').slice(0, 10)}${h.broken ? ' (broken)' : ''} — ${h.acquired ? `acquired by ${h.acquired.kind} ${String(h.acquired.ts).slice(0, 10)}${h.acquired.price ? ' for ' + money(h.acquired.price) : ''}` : `no acquisition record (ledger first saw it ${h.opened_by ? h.opened_by.kind + ' ' + String(h.opened_by.ts).slice(0, 10) : '?'})`}`;
const pastLine = (p) => `#${p.token_id} ${p.acquired ? `${p.acquired.kind} ${String(p.acquired.ts).slice(0, 10)}${p.acquired.price ? ' for ' + money(p.acquired.price) : ''}` : 'acquisition unknown'} → ${p.released ? `${p.released.kind} ${String(p.released.ts).slice(0, 10)}${p.released.price ? ' for ' + money(p.released.price) : ''}${p.released.note ? ' (' + p.released.note + ')' : ''}` : '?'}${p.held_days != null ? ` · held ${p.held_days}d` : ''}${p.pnl ? ` · P&L ${p.pnl.usd != null ? (p.pnl.usd >= 0 ? '+$' : '-$') + Math.abs(p.pnl.usd) : 'usd n/a'} / ${p.pnl.token ? (p.pnl.token.delta >= 0 ? '+' : '') + p.pnl.token.delta + ' ' + p.pnl.token.symbol : 'token-terms n/a' + (p.pnl.note ? ' (' + p.pnl.note + ')' : '')}` : ''}`;
function fit(build, caps) {   // shrink the list caps until the JSON fits the budget (never cut mid-object)
  let out = build(caps); let guard = 0;
  while (JSON.stringify(out).length > BUDGET && guard++ < 12) { for (const k of Object.keys(caps)) caps[k] = Math.max(2, Math.floor(caps[k] * 0.6)); out = build(caps); }
  return out;
}
// A wallet block → what the model needs: summary first (never trimmed), then holdings / past / events as one-line strings,
// each list capped and labeled with what was left out.
function compactWallet(block, slug) {
  if (!block) return null;
  const ev = block.events || []; const hold = block.holdings_now || { total: 0, by_state: {}, tokens: [] }; const past = block.held_past || { total: 0, tokens: [] };
  const holdTokens = hold.tokens || [], pastTokens = past.tokens || [];
  return fit((c) => ({
    collection: slug, address: block.address, first_seen: block.first_seen, last_seen: block.last_seen, events_count: block.events_count, counts: block.counts,
    holdings_now: { total: hold.total, by_state: hold.by_state, tokens: holdTokens.slice(0, c.hold).map(holdLine), not_shown: holdTokens.length > c.hold ? holdTokens.length - c.hold : undefined, note: 'state = where the token sits now: liquid · listed:<venue> · staked (DAODAO) · staked_enterprise · staked:<legacy role> · unstaking · escrow · locked; a staked or listed token is still this wallet\'s' },
    held_past: { total: past.total, distinct_tokens: past.distinct_tokens, most_recent: pastTokens.slice(-c.past).reverse().map(pastLine), not_shown: pastTokens.length > c.past ? pastTokens.length - c.past : undefined, note: 'closed positions, newest first; "acquisition unknown" = the ledger saw the wallet release it but never receive it (pre-ledger)' },
    realized: block.realized,
    events: { total: ev.length, first: ev.slice(0, c.head).map(evLine), last: ev.length > c.head ? ev.slice(-c.tail).map(evLine) : [], not_shown: Math.max(0, ev.length - c.head - c.tail) || undefined, note: 'oldest first, then the newest; the by-wallet shard holds every row' },
    source_url: `https://github.com/thealliancedao/nft-collections/blob/main/${slug}/ledger/by-wallet/${walletShard(block.address)}.json`,
  }), { hold: 60, past: 30, head: 4, tail: 25 });
}

// A token's journey rows → the facts a visitor asks first + the rows as lines.
function compactToken(rows, slug, tokenId, system) {
  if (!rows || !rows.length) return null;
  const sys = system || new Set(); const isW = (a) => a && !sys.has(a);
  const sales = rows.filter(r => r.kind === 'sale' || r.kind === 'mint_purchase');
  const hands = rows.filter(r => (r.kind === 'sale' || r.kind === 'transfer' || r.kind === 'mint_purchase' || r.kind === 'venue_out') && isW(r.to) && r.to !== r.from).length;
  const listings = rows.filter(r => r.kind === 'list').length;
  const last = rows[rows.length - 1]; const lastCustody = [...rows].reverse().find(r => ['sale', 'transfer', 'mint_purchase', 'list', 'delist', 'stake', 'unstake', 'claim', 'stake_enterprise', 'unstake_enterprise', 'venue_in', 'venue_out', 'lock_create', 'lock_withdraw', 'lock_transfer'].includes(r.kind));
  return fit((c) => ({
    collection: slug, token_id: String(tokenId), records: rows.length, first: rows[0].ts, last: last.ts,
    summary: { hand_changes: hands, listings, sales: sales.length, last_custody_event: lastCustody ? evLine(lastCustody) : null, note: 'hand_changes = sale/transfer/mint_purchase/venue_out into a non-system address; the holder is the `to` of the last custody event unless that is a custodian or a venue (then the token is staked/listed and the holder is that event\'s `from`)' },
    sales: sales.slice(-c.sales).map(evLine), sales_not_shown: sales.length > c.sales ? sales.length - c.sales : undefined,
    events: { total: rows.length, first: rows.slice(0, c.head).map(evLine), last: rows.length > c.head ? rows.slice(-c.tail).map(evLine) : [], not_shown: Math.max(0, rows.length - c.head - c.tail) || undefined },
  }), { sales: 20, head: 4, tail: 30 });
}

module.exports = { VERSION: '1.0.0', NFTC_REPO, ADDR, walletShard, walletShardUrl, tokenShard, tokenShardUrl, collectionsFromTenants, compactWallet, compactToken, hasWalletRule: () => !!BW };
