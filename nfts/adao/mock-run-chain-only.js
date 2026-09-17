#!/usr/bin/env node
// mock-run-chain-only.js — BINDING gate for Rev C.6: chain-only BBL auctions ARE listings (the #745 lesson).
//
// Live module (index.js + compact-bundle.js), real fixtures (nft-collections checkout), network stubbed at
// globalThis.fetch. The chain-only condition does not exist on main today (#745 sold on 2026-09-14), so ONE
// auction in the exact #745 shape (is_settled false · no bidder · end_time 0 · absent from warlock) is added
// to the chain page, plus one chain-only auction with a bidder (must stay out) and one settled (must stay out).
// Every assertion is a RELATION to the fixture, never a literal frozen on the writing day.
//
// Usage: NFTC_DIR=<nft-collections> SITE_DIR=<aDAO-links-site> TLA_CORE_DIR=<tla-core> [NFT_ROOT=adao] \
//        node --max-old-space-size=200 mock-run-chain-only.js
'use strict';
const fs = require('fs'), path = require('path');
const NFTC = process.env.NFTC_DIR, SITE = process.env.SITE_DIR, CORE = process.env.TLA_CORE_DIR, NFT_ROOT = process.env.NFT_ROOT || 'adao';
if (!NFTC || !SITE || !CORE) { console.error('NFTC_DIR, SITE_DIR and TLA_CORE_DIR required'); process.exit(1); }
process.env.GITHUB_TOKEN = process.env.GITHUB_TOKEN || 'x';
const M = require('./index.js');
const CB = require('./compact-bundle.js');

let fails = 0;
const check = (name, ok, detail) => { console.log(`${ok ? '✓' : '✗'} ${name}${detail !== undefined ? ' — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 300)) : ''}`); if (!ok) fails++; };
const snap = (f) => JSON.parse(fs.readFileSync(path.join(NFTC, NFT_ROOT, 'snapshots', f)));

// ---------------------------------------------------------------- fixtures
const nftsDoc = snap('nfts.json');
const summaryDoc = snap('summary.json');
const records = nftsDoc.records;
check('fixture: 10000 records', records.length === 10000, records.length);
const liveBbl = records.filter(r => r.listing && r.listing.marketplace === 'BBL' && r.listing.raw);
const fromChain = liveBbl.filter(r => r.listing.source !== 'warlock_recovered');
const recovered = liveBbl.filter(r => r.listing.source === 'warlock_recovered');
check(`fixture: BBL listings ${liveBbl.length} = chain ${fromChain.length} + warlock-recovered ${recovered.length}`, liveBbl.length > 0 && liveBbl.length === fromChain.length + recovered.length);
const BLUNA = 'cw20:terra17aj4ty4sz4yhgm08na8drc0v03v2jwr3waxcqrwhajj729zhl7zqnpc0ml';
const minLiveBluna = Math.min(...liveBbl.filter(r => r.listing.denom === BLUNA).map(r => Number(r.listing.price_raw)));

// The synthetic #745-shaped auction: a currently user-held, unlisted token moves into the BBL contract at a reserve
// BELOW today's cheapest live bLUNA ask, so the floor relation is testable. Its record is re-owned exactly the way the
// chain would show it (owner = BBL contract, bbl_listed = true, no other bucket).
const victim = records.find(r => r.user_held && !r.listing && !r.broken);
check('fixture: found an unlisted user-held token to stage as chain-only', !!victim, victim && victim.id);
const CO_ID = 14765, CO_TOKEN = String(victim.id), CO_SELLER = victim.real_owner || victim.owner, CO_RESERVE = String(Math.max(1, Math.floor(minLiveBluna / 2)));
const chainOnlyAuction = { auction_id: CO_ID, auction_type: 'buy_now', nft_contract: M.ADAO_NFT_CONTRACT, token_id: CO_TOKEN, seller: CO_SELLER, denom: BLUNA, reserve_price: CO_RESERVE, amount: '0', bidder: null, end_time: 0, creator_address: CO_SELLER, royalty_fee: '0', is_settled: false, offers: [] };
const victim2 = records.find(r => r.user_held && !r.listing && !r.broken && r.id !== victim.id);
const bidAuction = { ...chainOnlyAuction, auction_id: 14766, token_id: String(victim2.id), bidder: 'terra1bidderxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', amount: CO_RESERVE, end_time: 1700000000 };
const settledAuction = { ...chainOnlyAuction, auction_id: 14767, token_id: String(victim2.id), is_settled: true };
const staged = records.map(r => {
    if (r.id !== victim.id && r.id !== victim2.id) return r;
    return { ...r, owner: M.BBL_MARKETPLACE, real_owner: M.BBL_MARKETPLACE, user_held: false, bbl_listed: true, listing: null };
});

// ---------------------------------------------------------------- network stub
const chainAuctions = [...fromChain.map(r => ({ ...r.listing.raw, nft_contract: M.ADAO_NFT_CONTRACT, token_id: String(r.listing.token_id), is_settled: false })), chainOnlyAuction, bidAuction, settledAuction];
const warlockNfts = liveBbl.map(r => ({ nft_token_id: String(r.listing.token_id), auction: { auction_id: Number(r.listing.internal_id), seller: r.listing.seller, reserve_price: r.listing.price_raw, denom: r.listing.denom, auction_type: r.listing.listing_type, end_time: r.listing.end_time ?? null } }));
let warlockDown = false;
const seen = { bbl: 0, warlock: 0, atrium: 0, boost: 0 };
const json = (b) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(b), text: () => Promise.resolve(JSON.stringify(b)) });
const nope = (s, t) => Promise.resolve({ ok: false, status: s, json: () => Promise.reject(new Error(t)), text: () => Promise.resolve(t) });
globalThis.fetch = (u) => {
    const url = String(u);
    if (url.includes('warlock.backbonelabs.io')) { seen.warlock++; if (warlockDown) return Promise.reject(new Error('ECONNRESET warlock')); const page = Number((url.match(/page=(\d+)/) || [])[1] || 1); return json({ nfts: page === 1 ? warlockNfts : [] }); }
    if (url.includes(`/contract/${M.BBL_MARKETPLACE}/smart/`)) { seen.bbl++; const q = JSON.parse(Buffer.from(url.split('/smart/')[1], 'base64').toString()); const sa = q.auction_by_contract.start_after; return json({ data: { auctions: sa ? [] : chainAuctions } }); }
    if (url.includes(`/contract/${M.ATRIUM_MARKETPLACE}/smart/`)) { seen.atrium++; return json({ data: { listings: [] } }); }
    if (url.includes(`/contract/${M.BOOST_MARKETPLACE}/smart/`)) { seen.boost++; return json({ data: { launches: [] } }); }
    if (url.includes('boostdao') || url.includes('boost')) { seen.boost++; return json({ launches: [] }); }
    if (url.includes('token-catalog/snapshots/current.json')) { const f = path.join(CORE, 'token-catalog/snapshots/current.json'); return fs.existsSync(f) ? json(JSON.parse(fs.readFileSync(f))) : nope(404, 'no catalog fixture'); }
    return nope(404, 'unstubbed ' + url.slice(0, 120));
};

(async () => {
    // --- A: reconcile with warlock UP --------------------------------------------------------------
    const mk = await M.fetchMarketplaces();
    const bbl = mk.bbl;
    const co = bbl.filter(l => l.source === 'chain_only');
    const wr = mk.listingWarnings;
    check('A: BBL listings = every warlock-visible auction + exactly the one structurally-live chain-only auction', bbl.length === liveBbl.length + 1 && co.length === 1, `${bbl.length} = ${liveBbl.length} + ${co.length}`);
    check('A: the chain-only listing is labeled source:chain_only · warlock_visible:false and carries the contract fields', co[0] && co[0].warlock_visible === false && String(co[0].internal_id) === String(CO_ID) && String(co[0].token_id) === CO_TOKEN && co[0].seller === CO_SELLER && co[0].price_raw === CO_RESERVE && co[0].denom === BLUNA, co[0] && { id: co[0].internal_id, tok: co[0].token_id });
    check('A: every other BBL listing is labeled warlock_visible:true with source chain|warlock_recovered', bbl.filter(l => l.source !== 'chain_only').every(l => l.warlock_visible === true && (l.source === 'chain' || l.source === 'warlock_recovered')));
    check('A: the chain-only auction WITH a bidder and the settled one are NOT listings', !bbl.some(l => String(l.internal_id) === '14766' || String(l.internal_id) === '14767'));
    check('A: the warning stays (chain_only_not_on_warlock, included:true) — visible, never silent', wr.filter(w => w.reason === 'chain_only_not_on_warlock').length === 1 && wr.find(w => w.reason === 'chain_only_not_on_warlock').included === true && wr.find(w => w.reason === 'chain_only_not_on_warlock').token_id === CO_TOKEN);
    check('A: the bidder one is warned under its own reason (chain_only_not_structurally_live), settled is silent', wr.filter(w => w.reason === 'chain_only_not_structurally_live').length === 1 && wr.find(w => w.reason === 'chain_only_not_structurally_live').auction_id === '14766');
    check('A: warlock-recovered count unchanged by the change', wr.filter(w => w.reason === 'warlock_only_missing_from_chain_sweep').length === recovered.length, `${wr.filter(w => w.reason === 'warlock_only_missing_from_chain_sweep').length} vs ${recovered.length}`);
    check('A: isStructurallyLiveAuction — #745 shape true; bidder false; timed false; settled false; end_time null true', M.isStructurallyLiveAuction(chainOnlyAuction) && !M.isStructurallyLiveAuction(bidAuction) && !M.isStructurallyLiveAuction({ ...chainOnlyAuction, end_time: 1700000000 }) && !M.isStructurallyLiveAuction(settledAuction) && M.isStructurallyLiveAuction({ ...chainOnlyAuction, end_time: null }));

    // --- B: merge into records + price ---------------------------------------------------------------
    const priceData = await M.fetchPriceData();
    const merged = M.mergeMarketplaceListings(staged.map(r => ({ ...r })), mk, priceData);
    const vr = merged.find(r => r.id === victim.id);
    check('B: the chain-only token\'s record carries the listing (source chain_only) and real_owner = seller', vr.listing && vr.listing.source === 'chain_only' && vr.listing.warlock_visible === false && vr.real_owner === CO_SELLER, vr.listing && { src: vr.listing.source, ro: vr.real_owner });
    check('B: it is priced like any other bLUNA listing (price_display / price_usd via the sister cron)', vr.listing.price_token_symbol === 'bLUNA' && /bLUNA$/.test(vr.listing.price_display) && (vr.listing.price_usd == null || vr.listing.price_usd > 0), vr.listing.price_display);
    const v2 = merged.find(r => r.id === victim2.id);
    check('B: the bidder/settled token stays "marketplace-owned, no active listing" (blank beats phantom)', v2.listing && v2.listing.marketplace_owner_no_listing === true);

    // --- C: aggregate — floor INCLUDES the chain-only ask -------------------------------------------
    const agg = M.aggregate(merged, [], [], mk, null, priceData);
    const bl = agg.marketplaces.bbl.by_token.bLUNA;
    const expectMin = Math.min(...merged.filter(r => r.listing && r.listing.marketplace === 'BBL' && r.listing.price_amount != null && r.listing.price_token_symbol === 'bLUNA').map(r => r.listing.price_amount));
    check('C: summary.marketplaces.bbl.by_token.bLUNA.min = the min over ALL decorated BBL listings (chain-only included)', bl && bl.min === expectMin, `${bl && bl.min} vs ${expectMin}`);
    check('C: that min IS the chain-only ask (staged below every live ask) — the #745 floor is no longer a phantom', bl && bl.min === Number(CO_RESERVE) / 1e6, `${bl && bl.min} vs ${Number(CO_RESERVE) / 1e6}`);
    check('C: chain_only_count = 1 on bbl, 0 on atrium/boost; count = count_resolved for bbl', agg.marketplaces.bbl.chain_only_count === 1 && agg.marketplaces.atrium.chain_only_count === 0 && agg.marketplaces.boost.chain_only_count === 0 && agg.marketplaces.bbl.count === agg.marketplaces.bbl.count_resolved, agg.marketplaces.bbl);
    check('C: bbl count = warlock-visible + chain-only', agg.marketplaces.bbl.count === liveBbl.length + 1, agg.marketplaces.bbl.count);

    // --- D: floor-history row — the tier floor counts it ---------------------------------------------
    if (priceData.luna_usd != null) {
        const row = M.buildFloorHistoryRow(merged, null, {}, null, new Date().toISOString());
        const tier = M.tierOf(vr);
        const t = row.per_tier[tier];
        const expectFloor = Math.min(...merged.filter(r => r.listing && r.listing.marketplace && M.tierOf(r) === tier && r.listing.price_usd != null).map(r => r.listing.price_usd));
        check(`D: floor-history per_tier.${tier}.listing_floor_usd = min over that tier's listings (chain-only counted) and ≤ the chain-only ask`, t && t.listing_floor_usd != null && Math.abs(t.listing_floor_usd - expectFloor) < 1e-5 && t.listing_floor_usd <= vr.listing.price_usd + 1e-6 && t.listed_count === merged.filter(r => r.listing && r.listing.marketplace && M.tierOf(r) === tier).length, t && { floor: t.listing_floor_usd, ask: vr.listing.price_usd, listed: t.listed_count });
    } else console.log('  (D skipped: no LUNA price in the token-catalog fixture)');

    // --- E: warlock DOWN — structurally live chain set published, visibility unknown (null) ----------
    warlockDown = true;
    const mk2 = await M.fetchMarketplaces();
    check('E: warlock down → every structurally-live chain auction published with warlock_visible:null (not false)', mk2.bbl.length === fromChain.length + 1 && mk2.bbl.every(l => l.warlock_visible === null && l.source === 'chain'), `${mk2.bbl.length} vs ${fromChain.length + 1}`);
    check('E: warlock down → bidder + settled still out; one warlock_unavailable warning', !mk2.bbl.some(l => ['14766', '14767'].includes(String(l.internal_id))) && mk2.listingWarnings.length === 1 && mk2.listingWarnings[0].reason === 'warlock_unavailable_chain_set_unfiltered' && mk2.listingWarnings[0].published === mk2.bbl.length);
    warlockDown = false;

    // --- F: compact bundle carries the chain-only bit -------------------------------------------------
    const meta = JSON.parse(fs.readFileSync(path.join(SITE, 'assets/nft-metadata/all_nfts_metadata.json')));
    const ri = JSON.parse(fs.readFileSync(path.join(SITE, 'assets/nft-metadata/adao-rarity-intended.json')));
    const rb = JSON.parse(fs.readFileSync(path.join(SITE, 'assets/nft-metadata/adao-rarity-bbl.json')));
    const sum2 = { ...summaryDoc, bbl_listed_count: merged.filter(r => r.bbl_listed).length, daodao_pending_claim_count: merged.filter(r => r.daodao_pending_claim).length, daodao_custody_unattributed_count: merged.filter(r => r.daodao_custody_unattributed).length, unminted_count: merged.filter(r => r.unminted).length, daodao_staked_count: merged.filter(r => r.daodao_staked).length, broken_count: merged.filter(r => r.broken).length };
    const bundle = CB.buildBundle({ ...nftsDoc, records: merged }, sum2, meta, ri, rb);
    const F = Object.fromEntries(bundle.fields.map((f, i) => [f, i]));
    const bitRows = bundle.rows.filter(r => r[F.flags] & bundle.flagBits.listing_chain_only);
    check('F: bundle flagBits.listing_chain_only = 8192 and exactly the chain-only token carries it', bundle.flagBits.listing_chain_only === CB.LISTING_CHAIN_ONLY_BIT && bitRows.length === 1 && bitRows[0][0] === Number(CO_TOKEN), bitRows.map(r => r[0]));
    check('F: its listing_usd is the chain-only ask (rounded to cents) so the explorer prices it on boot', vr.listing.price_usd == null || bitRows[0][F.listing_usd] === Math.round(vr.listing.price_usd * 100) / 100);
    check('F: the record flags are untouched by the derived bit (bbl_listed bit still set, no FLAG_BITS rename)', (bitRows[0][F.flags] & bundle.flagBits.bbl_listed) !== 0 && Object.keys(CB.FLAG_BITS).length === 13);

    // --- G: the LIVE fixture (no chain-only today) is a no-op: same BBL set as committed ---------------
    const chainOnlyToday = summaryDoc.listing_resolver && (summaryDoc.listing_resolver.warnings || []).filter(w => w.reason === 'chain_only_not_on_warlock').length;
    check(`G: on the committed main fixture there are ${chainOnlyToday || 0} chain-only auctions — the visible set is unchanged by C.6 (relabel only)`, bbl.filter(l => l.warlock_visible === true).length === liveBbl.length);

    const mb = Math.round(process.memoryUsage().rss / 1048576);
    console.log(`\nfetch calls: ${JSON.stringify(seen)} · rss ${mb} MB · heap cap ${process.execArgv.join(' ') || '(none — run with --max-old-space-size=200)'}`);
    console.log(`\n=== CHAIN-ONLY GATE (C.6): ${fails === 0 ? 'PASS' : 'FAIL'} — ${fails} failed ===`);
    process.exit(fails ? 1 : 0);
})().catch(e => { console.error('gate crashed:', e); process.exit(1); });
