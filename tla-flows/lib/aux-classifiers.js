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
function classifyNftTx(txr, contracts) {
  if (Number(txr.code || 0) !== 0) return [];
  const events = axEventsOf(txr).filter(e => e.type === 'wasm');
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
  return out;
}

module.exports = { classifyVotionTx, classifyPairLiquidityTx, classifyNftTx, samplesToRecords, mergeKeyed, axAttrs, axAttrsAll, axEventsOf, axCoinList };
