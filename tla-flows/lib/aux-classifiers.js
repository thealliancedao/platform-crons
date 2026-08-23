// =============================================================================
// aux-classifiers — capture classifiers for the registry-extension streams
// (SPEC-registry-extensions-pnl): Votion vault flows, Astroport pair
// liquidity, ADAO/lock NFT transfers. ONE home (no-third-copy doctrine):
// required by the E2 archive backfill job (tla-core registry-backfill.js)
// today; the tla-flows walker adopts them when its WATCH set extends to the
// new contracts (forward capture rides the existing every-block walk).
//
// Doctrine: capture truth, derive later. Where an event shape is not yet
// fixture-locked (Votion vault wasm attrs — §9 of the spec), the classifier
// records DEFENSIVELY: action + full raw attrs + everything derivable from
// the standard event families (tf_mint/tf_burn of the vdenom, cw20/bank LST
// moves). Nothing is guessed; nothing is dropped; derive refines once real
// fixtures land. Records are keyed (field `k`) for the shared mergeKeyed law:
// schema-upgrade in place, lower/equal never overwrites, never-shrink is the
// caller's assert — one law for every extension stream.
// =============================================================================
'use strict';

function axAttrs(ev) { const o = {}; for (const a of (ev.attributes || [])) if (!(a.key in o)) o[a.key] = a.value; return o; }
function axAttrsAll(ev) { const o = {}; for (const a of (ev.attributes || [])) (o[a.key] ||= []).push(a.value); return o; }
function axEventsOf(txr) {
  if (Array.isArray(txr.events) && txr.events.length) return txr.events;
  const out = []; for (const log of (txr.logs || [])) for (const e of (log.events || [])) out.push(e); return out;
}
// '123denomA, 456denomB' → [{amount,denom}]
function axCoinList(s) {
  return String(s || '').split(',').map(x => x.trim()).filter(Boolean).map(x => {
    const m = /^(\d+)(.+)$/.exec(x); return m ? { amount: m[1], denom: m[2] } : { amount: null, denom: x };
  });
}
function axSender(txr) { return txr?.tx?.body?.messages?.[0]?.sender || null; }

// ----------------------------------------------------------------------------- shared merge (keyed, schema-upgrade, never-shrink caller-asserted)
function mergeKeyed(existing, incoming) {
  const byK = new Map();
  for (const r of existing) byK.set(r.k, r);
  let added = 0, upgraded = 0;
  for (const r of incoming) {
    const prev = byK.get(r.k);
    if (!prev) { byK.set(r.k, r); added++; }
    else if (Number(r.schemaVersion || 1) > Number(prev.schemaVersion || 1)) { byK.set(r.k, r); upgraded++; }
  }
  const merged = [...byK.values()].sort((a, b) => (a.height - b.height) || String(a.k).localeCompare(String(b.k)));
  return { merged, added, upgraded };
}

// ----------------------------------------------------------------------------- Votion vaults (defensive v1 — raw-capture until fixtures lock the shape)
// vaults: Map/obj address → { vdenom, lst } (from votion/snapshots vault list)
function classifyVotionTx(txr, vaults) {
  if (Number(txr.code || 0) !== 0) return [];
  const events = axEventsOf(txr);
  const out = [];
  const sender = axSender(txr);
  for (const [vault, meta] of Object.entries(vaults)) {
    const vdenom = meta.vdenom;
    const vaultWasm = events.filter(e => e.type === 'wasm' && axAttrs(e)._contract_address === vault);
    if (!vaultWasm.length) continue;
    const actions = [...new Set(vaultWasm.map(e => axAttrs(e).action).filter(Boolean))];
    // measured legs from the standard event families (shape-independent):
    let vMinted = null, vBurned = null;
    for (const e of events) {
      const a = axAttrs(e);
      if (e.type === 'tf_mint' && String(a.amount || '').endsWith(vdenom)) vMinted = String(a.amount).slice(0, -vdenom.length);
      if (e.type === 'tf_burn' && String(a.amount || '').endsWith(vdenom)) vBurned = String(a.amount).slice(0, -vdenom.length);
    }
    // LST cw20 transfers touching the vault (deposit in / withdrawal out)
    let lstIn = null, lstOut = null;
    for (const e of events.filter(e => e.type === 'wasm')) {
      const a = axAttrs(e);
      if (a._contract_address !== meta.lst) continue;
      if ((a.action === 'transfer' || a.action === 'send' || a.action === 'transfer_from')) {
        if (a.to === vault) lstIn = a.amount || lstIn;
        if (a.from === vault) lstOut = a.amount || lstOut;
      }
    }
    const kind = vMinted ? 'deposit' : (vBurned ? 'withdraw' : 'other');
    out.push({
      schemaVersion: 1, k: `${txr.txhash}|${vault}`,
      txhash: txr.txhash, height: Number(txr.height), timestamp: txr.timestamp,
      vault, kind, user: sender,
      vtoken_minted: vMinted, vtoken_burned: vBurned,
      lst_in: lstIn, lst_out: lstOut, lst: meta.lst,
      // rate sample when both legs measured (LST per vtoken at this height)
      rate_sample: (vMinted && lstIn) ? +(Number(lstIn) / Number(vMinted)).toFixed(10)
                 : (vBurned && lstOut) ? +(Number(lstOut) / Number(vBurned)).toFixed(10) : null,
      actions,
      raw_vault_attrs: vaultWasm.map(axAttrsAll),   // defensive: full truth kept until fixtures lock the shape
    });
  }
  return out;
}

// ----------------------------------------------------------------------------- Astroport pair liquidity (+ swap price samples, not persisted as records)
// pairs: obj address → { name, bucket }
function classifyPairLiquidityTx(txr, pairs) {
  if (Number(txr.code || 0) !== 0) return { records: [], swapSamples: [] };
  const events = axEventsOf(txr).filter(e => e.type === 'wasm');
  const records = [], swapSamples = [];
  let idx = 0;
  for (const e of events) {
    const a = axAttrs(e);
    const pair = a._contract_address;
    if (!pairs[pair]) continue;
    if (a.action === 'provide_liquidity') {
      records.push({ schemaVersion: 1, k: `${txr.txhash}|${pair}|provide|${idx++}`,
        txhash: txr.txhash, height: Number(txr.height), timestamp: txr.timestamp,
        pair, pool_name: pairs[pair].name || null, kind: 'provide',
        provider: a.receiver || a.sender || axSender(txr), sender: a.sender || null,
        assets: axCoinList(a.assets), share: a.share || null });
    } else if (a.action === 'withdraw_liquidity') {
      records.push({ schemaVersion: 1, k: `${txr.txhash}|${pair}|withdraw|${idx++}`,
        txhash: txr.txhash, height: Number(txr.height), timestamp: txr.timestamp,
        pair, pool_name: pairs[pair].name || null, kind: 'withdraw',
        provider: a.sender || axSender(txr), sender: a.sender || null,
        refund_assets: axCoinList(a.refund_assets), share: a.withdrawn_share || null });
    } else if (a.action === 'swap' && a.offer_amount != null && a.return_amount != null) {
      // reserve-implied price sample (v1 source: swaps riding captured liquidity
      // txs — zaps carry them; provenance-linked, derivation happens later)
      swapSamples.push({ pair, pool_name: pairs[pair].name || null,
        date: String(txr.timestamp).slice(0, 10), height: Number(txr.height), txhash: txr.txhash,
        offer_asset: a.offer_asset, offer_amount: a.offer_amount,
        ask_asset: a.ask_asset, return_amount: a.return_amount,
        spread_amount: a.spread_amount ?? null, commission_amount: a.commission_amount ?? null });
    }
  }
  return { records, swapSamples };
}

// price samples → monthly sample records (LAST swap per pair per day wins)
function samplesToRecords(swapSamples) {
  const byKey = new Map();
  for (const s of swapSamples) {
    const k = `${s.pair}|${s.date}`;
    const prev = byKey.get(k);
    if (!prev || s.height > prev.height) byKey.set(k, s);
  }
  return [...byKey.values()].map(s => ({ schemaVersion: 1, k: `${s.pair}|${s.date}`,
    height: s.height, timestamp: `${s.date}T00:00:00Z`, ...s }));
}

// ----------------------------------------------------------------------------- NFT transfers (cw721 — ADAO collection + vAMP lock NFTs)
// contracts: obj address → label
function classifyNftTx(txr, contracts, markets = {}) {
  if (Number(txr.code || 0) !== 0) return [];
  const allEvents = axEventsOf(txr);
  const events = allEvents.filter(e => e.type === 'wasm');
  const out = []; let idx = 0;
  const ACTIONS = new Set(['transfer_nft', 'send_nft', 'mint', 'burn']);
  for (const e of events) {
    const a = axAttrs(e);
    const c = a._contract_address;
    if (!contracts[c] || !ACTIONS.has(a.action)) continue;
    out.push({ schemaVersion: 1, k: `${txr.txhash}|${c}|${a.action}|${a.token_id ?? idx}|${idx++}`,
      txhash: txr.txhash, height: Number(txr.height), timestamp: txr.timestamp,
      contract: c, contract_label: contracts[c], action: a.action,
      token_id: a.token_id ?? null,
      from: a.sender || a.owner || null, to: a.recipient || a.owner || null,
      minter: a.minter || null });
  }

  // --- v2: marketplace lifecycle (SPEC classifyNftTx v2 — sale/list/cancel/bid) ---
  // markets: { address → { label, fee_wallet, royalty_recipients[] } } from the
  // capture-registry `nft_marketplace` stream. Doctrine: capture truth, derive
  // later. Sale vs cancel is decided by MONEY MOVEMENT (payout legs from the
  // marketplace + NFT exit), refined by the marketplace's own wasm attrs where
  // the vocabulary is fixture-locked (BBL). Nothing guessed: when neither legs
  // nor attrs decide, the record says so (resolution:'ambiguous') and carries
  // the full raw attrs for a later derive.
  const marketAddrs = Object.keys(markets || {});
  if (!marketAddrs.length) return out;
  const SALE_VERBS   = new Set(['settle', 'buy_nft']);                    // BBL settle; Atrium buy_nft (fixture-locked 2026-08-21 tx 995038E5…)
  const CANCEL_VERBS = new Set(['cancel_auction', 'admin_cancel_auction']);
  const LIST_VERBS   = new Set(['create_auction']);
  // Atrium's buy_nft speaks price/listing_id where BBL's settle speaks
  // amount/auction_id — normalize so downstream reads one vocabulary.
  const normAttrs = (a) => a && ({ ...a,
    amount: a.amount ?? a.price ?? null,
    auction_id: a.auction_id ?? a.listing_id ?? null });
  const asCoin = (s) => { const m = /^(\d+)(.+)$/.exec(String(s || '').split(',')[0].trim()); return m ? { amount: m[1], denom: m[2] } : null; };
  for (const M of marketAddrs) {
    const meta = markets[M] || {};
    const mwasm = events.filter(e => axAttrs(e)._contract_address === M);
    // NFT moves on WATCHED collections touching M (exit = sale/cancel, entry = list)
    const exits = [], entries = [];
    for (const e of events) {
      const a = axAttrs(e);
      if (!contracts[a._contract_address]) continue;
      if (a.action !== 'transfer_nft' && a.action !== 'send_nft') continue;
      if (a.sender === M) exits.push({ token_id: a.token_id ?? null, to: a.recipient || null, nft_contract: a._contract_address });
      if (a.recipient === M || a.contract === M) entries.push({ token_id: a.token_id ?? null, from: a.sender || a.owner || null, nft_contract: a._contract_address });
    }
    if (!mwasm.length && !exits.length && !entries.length) continue;
    // money legs (standard families — shape-independent): payouts FROM M, payments TO M.
    // Each leg keeps its POSITION in the event stream (`seq`) — batch-settle txs
    // are segmented by order (each settle's legs follow it), never by pooling.
    const payouts = [], payments = [];
    let seq = 0;
    const seqOf = new Map();                 // event object → stream position
    for (const e of allEvents) { seqOf.set(e, seq++); }
    for (const e of allEvents) {
      const at = seqOf.get(e);
      if (e.type === 'transfer') {           // bank
        const a = axAttrsAll(e);             // bank transfer events can batch (parallel key lists)
        const n = Math.max((a.recipient || []).length, (a.sender || []).length, (a.amount || []).length);
        for (let i = 0; i < n; i++) {
          const coin = asCoin((a.amount || [])[i]); if (!coin) continue;
          const rec = { to: (a.recipient || [])[i] || null, from: (a.sender || [])[i] || null, ...coin, seq: at };
          if (rec.from === M) payouts.push(rec);
          if (rec.to === M) payments.push(rec);
        }
      } else if (e.type === 'wasm') {        // cw20
        const a = axAttrs(e);
        if (a.action !== 'transfer' && a.action !== 'send' && a.action !== 'transfer_from') continue;
        if (!a.amount || (!a.from && !a.to)) continue;
        const rec = { to: a.to || null, from: a.from || null, amount: String(a.amount), denom: a._contract_address, seq: at };
        if (rec.from === M) payouts.push(rec);
        if (rec.to === M) payments.push(rec);
      }
    }
    // ordered marketplace anchors for segmentation: settle events and NFT exits
    const settleSeqs = [];
    for (const e of mwasm) { const a = axAttrs(e); if (SALE_VERBS.has(a.action)) settleSeqs.push({ seq: seqOf.get(e), attrs: normAttrs(a) }); }
    const exitSeqOf = new Map();             // token_id → stream position of its exit
    for (const e of events) {
      const a = axAttrs(e);
      if (contracts[a._contract_address] && (a.action === 'transfer_nft' || a.action === 'send_nft') && a.sender === M)
        exitSeqOf.set(a.token_id ?? null, seqOf.get(e));
    }
    // legs for a settle at position s: payouts between s and the next settle
    const legsForSettle = (s) => {
      const next = settleSeqs.map(x => x.seq).filter(x => x > s).sort((a, b) => a - b)[0] ?? Infinity;
      return payouts.filter(p => p.seq > s && p.seq < next);
    };
    const actions = [...new Set(mwasm.map(e => axAttrs(e).action).filter(Boolean))];
    const rawAttrs = mwasm.map(axAttrsAll);
    const attrsFor = (verbs, tokenId) => {                 // marketplace attrs for THIS token when carried
      const hits = mwasm.map(axAttrs).filter(a => verbs.has(a.action));
      return normAttrs(hits.find(a => tokenId != null && a.token_id === tokenId) || (hits.length === 1 ? hits[0] : null));
    };
    const roleOf = (to) => to === (meta.fee_wallet || null) ? 'marketplace_fee'
      : (meta.royalty_recipients || []).includes(to) ? 'royalty' : 'other';
    const base = (kind, token_id) => ({ schemaVersion: 2,
      k: `${txr.txhash}|${M}|${kind}|${token_id ?? idx}|${idx++}`,
      txhash: txr.txhash, height: Number(txr.height), timestamp: txr.timestamp,
      contract: M, contract_label: meta.label || null, action: kind, token_id,
      market_actions: actions, raw_market_attrs: rawAttrs });
    for (const x of exits) {
      const settle = attrsFor(SALE_VERBS, x.token_id);
      const cancel = attrsFor(CANCEL_VERBS, x.token_id);
      // legs: segmented by order when a settle anchors this exit (its legs sit
      // between it and the next settle); pooled only in the single-exit case.
      const xSeq = exitSeqOf.get(x.token_id) ?? Infinity;
      const mySettle = settleSeqs.length
        ? settleSeqs.filter(s => s.seq < xSeq).sort((a, b) => b.seq - a.seq)[0]   // nearest settle BEFORE this exit
          || settleSeqs.find(s => s.attrs.token_id === x.token_id) || null
        : null;
      const sAttr = (mySettle && mySettle.attrs) || settle || null;
      // decision order: settle vocabulary → sale; cancel vocabulary → cancel;
      // then money movement; ambiguous ONLY when payouts exist, exits are
      // multiple, and no vocabulary decides (refuse to guess attribution).
      if (!sAttr && !cancel && exits.length > 1 && payouts.length > 0) {
        out.push({ ...base('sale', x.token_id), nft_contract: x.nft_contract, buyer: x.to,
          seller: null, denom: null, gross_amount: null, legs: payouts.map(p => ({ ...p, role: roleOf(p.to) })),
          payments_in: payments, resolution: 'ambiguous' });
        continue;
      }
      const rawLegs = mySettle ? legsForSettle(mySettle.seq) : payouts;
      // exclude buyer-directed legs ONLY when they carry no role — a role-tagged
      // leg to the buyer is real (e.g. the fee wallet buying an NFT still pays
      // itself the fee); a role-less leg to the buyer is refund/change.
      const outLegs = rawLegs.map(p => ({ ...p, role: roleOf(p.to) }))
        .filter(p => p.to !== x.to || p.role !== 'other');
      const isSale = sAttr ? true : cancel ? false : outLegs.length > 0 ? true : false;
      if (isSale) {
        const grossFromLegs = outLegs.reduce((s, p) => s + Number(p.amount), 0);
        // net leg: anchored to the settle's seller when the attr names one
        // (an outbid-refund leg can be larger than the net — size alone lies)
        const otherLegs = outLegs.filter(p => p.role === 'other');
        const sellerLeg = (sAttr && sAttr.seller ? otherLegs.filter(p => p.to === sAttr.seller) : otherLegs)
          .sort((a, b) => Number(b.amount) - Number(a.amount))[0]
          || otherLegs.sort((a, b) => Number(b.amount) - Number(a.amount))[0] || null;
        const gross = (sAttr && sAttr.amount) || (grossFromLegs ? String(grossFromLegs) : null);
        out.push({ ...base('sale', x.token_id), nft_contract: x.nft_contract,
          buyer: x.to,
          seller: (sAttr && sAttr.seller) || (sellerLeg && sellerLeg.to) || null,
          denom: (sAttr && sAttr.denom) || (sellerLeg && sellerLeg.denom) || (outLegs[0] && outLegs[0].denom) || null,
          gross_amount: gross,
          seller_net: sellerLeg ? sellerLeg.amount : null,
          marketplace_fee: (outLegs.find(p => p.role === 'marketplace_fee') || {}).amount || null,
          royalty_fee: (outLegs.find(p => p.role === 'royalty') || {}).amount || null,
          royalty_recipient: (outLegs.find(p => p.role === 'royalty') || {}).to || null,
          auction_id: (sAttr && sAttr.auction_id) || (cancel && cancel.auction_id) || null,
          legs: outLegs, payments_in: payments,
          // honesty flag: when all three legs are measured, they must sum to gross
          legs_consistent: (gross != null && outLegs.length)
            ? String(outLegs.reduce((s, p) => s + Number(p.amount), 0)) === String(gross) : null,
          resolution: sAttr ? 'attrs' : 'legs' });
      } else {
        out.push({ ...base('cancel', x.token_id), nft_contract: x.nft_contract,
          returned_to: x.to,
          auction_id: (cancel && cancel.auction_id) || null,
          refund_legs: payouts.filter(p => p.to === x.to || !cancel).map(p => ({ ...p, role: roleOf(p.to) })),
          resolution: cancel ? 'attrs' : 'no_payout' });
      }
    }
    for (const x of entries) {
      const cr = attrsFor(LIST_VERBS, x.token_id);
      out.push({ ...base('list', x.token_id), nft_contract: x.nft_contract,
        seller: x.from,
        auction_id: (cr && cr.auction_id) || null,
        listing_type: (cr && cr.auction_type) || null,
        denom: (cr && cr.denom) || null,
        reserve_price: (cr && (cr.reserve || cr.reserve_price)) || null,
        resolution: cr ? 'attrs' : 'entry_only' });
    }
    // bid without an NFT exit in the same tx (deferred auction bid — money enters, NFT stays)
    if (!exits.length) {
      for (const a of mwasm.map(axAttrs).filter(a => a.action === 'place_bid')) {
        out.push({ ...base('bid', a.token_id ?? null),
          bidder: a.bidder || null, bid_amount: a.bid_amount || null,
          auction_id: a.auction_id || null, resolution: 'attrs' });
      }
    }
  }
  return out;
}

module.exports = { classifyVotionTx, classifyPairLiquidityTx, classifyNftTx, samplesToRecords, mergeKeyed, axAttrs, axAttrsAll, axEventsOf, axCoinList };
