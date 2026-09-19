'use strict';
// tx-body.js — nft-flows 1.5.0 (2026-09-19, CHANGES_PENDING B.1 "Boost list prices · Atrium listing denoms"): decode the
// message bodies of a raw Terra tx (base64 protobuf, as /block and /tx return it) WITHOUT a protobuf library — the only
// shapes the classifier needs are Tx → body → messages[] (Any) and /cosmwasm.wasm.v1.MsgExecuteContract (sender, contract,
// msg = JSON bytes, funds = field 5). Every other message type is kept as { '@type' } only, so a walk never guesses at a body.
// Output matches the FCD archive's `messages` shape exactly ({ '@type', sender, contract, msg: <object>, funds: [{denom, amount}] })
// so classify.js's msgBodyFor / innerSendNftMsg read a raw part and an FCD part the same way.
// ONE home: platform-crons (the forward cron decodes at walk time); nft-collections' walk / resolve-msg-bodies require() this file
// from the run-time checkout (CRONS_DIR), never a copy.
const EXEC = '/cosmwasm.wasm.v1.MsgExecuteContract';

function varint(buf, i) { let x = 0n, s = 0n, b; do { if (i >= buf.length) throw new Error('varint past end'); b = buf[i++]; x |= BigInt(b & 0x7f) << s; s += 7n; } while (b & 0x80); return [x, i]; }
// walk one protobuf message: yields { field, wire, value } — value is a Buffer for wire 2, a BigInt for wire 0, Buffer for 1/5
function* fields(buf) {
  let i = 0;
  while (i < buf.length) {
    let tag; [tag, i] = varint(buf, i); const field = Number(tag >> 3n), wire = Number(tag & 7n);
    if (wire === 0) { let v; [v, i] = varint(buf, i); yield { field, wire, value: v }; }
    else if (wire === 2) { let n; [n, i] = varint(buf, i); n = Number(n); if (i + n > buf.length) throw new Error('length past end'); yield { field, wire, value: buf.subarray(i, i + n) }; i += n; }
    else if (wire === 1) { yield { field, wire, value: buf.subarray(i, i + 8) }; i += 8; }
    else if (wire === 5) { yield { field, wire, value: buf.subarray(i, i + 4) }; i += 4; }
    else throw new Error('unsupported wire type ' + wire);
  }
}
function decodeCoin(buf) { const c = { denom: null, amount: null }; for (const f of fields(buf)) { if (f.field === 1 && f.wire === 2) c.denom = f.value.toString('utf8'); if (f.field === 2 && f.wire === 2) c.amount = f.value.toString('utf8'); } return c; }
function decodeExecute(buf) {
  const m = { '@type': EXEC, sender: null, contract: null, msg: null, funds: [] };
  for (const f of fields(buf)) {
    if (f.wire !== 2) continue;
    if (f.field === 1) m.sender = f.value.toString('utf8');
    else if (f.field === 2) m.contract = f.value.toString('utf8');
    else if (f.field === 3) { const s = f.value.toString('utf8'); try { m.msg = JSON.parse(s); } catch { m.msg = null; m.msg_raw = s; } }
    else if (f.field === 5) m.funds.push(decodeCoin(f.value));   // cosmwasm.wasm.v1.MsgExecuteContract: funds = 5 (4 is reserved)
  }
  return m;
}
function decodeAny(buf) { let typeUrl = null, value = null; for (const f of fields(buf)) { if (f.field === 1 && f.wire === 2) typeUrl = f.value.toString('utf8'); if (f.field === 2 && f.wire === 2) value = f.value; } return { typeUrl, value }; }
// Tx (cosmos.tx.v1beta1.Tx): field 1 = body (TxBody), whose field 1 = repeated messages (Any)
function decodeTxMessages(txB64) {
  const tx = Buffer.isBuffer(txB64) ? txB64 : Buffer.from(String(txB64), 'base64');
  const out = [];
  for (const f of fields(tx)) {
    if (f.field !== 1 || f.wire !== 2) continue;   // body
    for (const g of fields(f.value)) {
      if (g.field !== 1 || g.wire !== 2) continue;   // messages
      const any = decodeAny(g.value);
      if (any.typeUrl === EXEC && any.value) out.push(decodeExecute(any.value));
      else out.push({ '@type': any.typeUrl });   // known shape, body not modeled — never guessed
    }
  }
  return out;
}
module.exports = { decodeTxMessages, EXEC, _fields: fields };
