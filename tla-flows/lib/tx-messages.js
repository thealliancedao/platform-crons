'use strict';
/**
 * tla-flows / lib/tx-messages.js 1.0.0 (2026-11-25) — WHAT WAS SENT: the messages of a transaction, read from its own bytes.
 *
 * Why: a change record built from events says that a contract changed and who sent it. For many changes the events do not
 * carry the values — `set_addresses` on the TLA address book emits nothing, most `update_config` calls emit nothing. The
 * transaction's own message does. The walk already holds the bytes (it hashes them for the tx hash).
 *
 * What is read: TxRaw.body_bytes → TxBody.messages (field 1) and nothing else — not the memo, not the fee, not the signers'
 * keys or signatures. Each message is an Any { type_url, value }; four wasm messages and authz MsgExec are opened:
 *   cosmwasm.wasm.v1.MsgExecuteContract { sender 1, contract 2, msg 3 (JSON bytes), funds 5 }
 *   cosmwasm.wasm.v1.MsgMigrateContract { sender 1, contract 2, code_id 3, msg 4 (JSON bytes) }
 *   cosmwasm.wasm.v1.MsgUpdateAdmin     { sender 1, new_admin 2, contract 3 }
 *   cosmwasm.wasm.v1.MsgClearAdmin      { sender 1, contract 3 }
 *   cosmos.authz.v1beta1.MsgExec        { grantee 1, msgs 2 (Any, repeated) }
 *
 * Never trusted on its own: attachSent() puts a message on a record only when the bytes agree with what the EVENTS already
 * said about that record — the same message index, the same message type, the same sender. Bytes that do not parse, or do
 * not agree, attach nothing; the record is filed as before.
 */
const VERSION = 'tx-messages-1.0.0';
const MAX_JSON = 6000;   // characters of one message's JSON kept on a record; longer → { too_long: n }

function varint(buf, pos) {
  let v = 0n, s = 0n;
  for (;;) {
    if (pos >= buf.length) throw new Error('varint past the end');
    const b = buf[pos++]; v |= BigInt(b & 0x7f) << s;
    if (!(b & 0x80)) return [v, pos];
    s += 7n; if (s > 63n) throw new Error('varint too long');
  }
}
// one protobuf message → its fields in order: { no, v } for a varint, { no, b } for length-delimited bytes
function fields(buf) {
  const out = []; let pos = 0;
  while (pos < buf.length) {
    let tag; [tag, pos] = varint(buf, pos); const no = Number(tag >> 3n), wt = Number(tag & 7n);
    if (wt === 0) { let v; [v, pos] = varint(buf, pos); out.push({ no, v }); }
    else if (wt === 2) { let len; [len, pos] = varint(buf, pos); const l = Number(len); if (pos + l > buf.length) throw new Error('field past the end'); out.push({ no, b: buf.subarray(pos, pos + l) }); pos += l; }
    else if (wt === 1) pos += 8; else if (wt === 5) pos += 4; else throw new Error('wire type ' + wt);
  }
  return out;
}
const first = (fs, no) => fs.find((f) => f.no === no);
const str = (f) => (f && f.b ? f.b.toString('utf8') : null);
function jsonOf(f) {
  if (!f || !f.b) return undefined;
  const s = f.b.toString('utf8'); if (s.length > MAX_JSON) return { too_long: s.length };
  try { return JSON.parse(s); } catch (e) { return undefined; }
}
const anyOf = (b) => { const f = fields(b); return { type: str(first(f, 1)), value: (first(f, 2) || {}).b || Buffer.alloc(0) }; };
function decodeMsg(any, depth = 0) {
  const t = any.type || '', out = { type: t };
  let f; try { f = fields(any.value); } catch (e) { return out; }
  if (/\.MsgExecuteContract$/.test(t)) {
    out.sender = str(first(f, 1)); out.contract = str(first(f, 2)); out.msg = jsonOf(first(f, 3));
    out.funds = f.filter((x) => x.no === 5 && x.b).map((x) => { const c = fields(x.b); return { denom: str(first(c, 1)), amount: str(first(c, 2)) }; });
  } else if (/\.MsgMigrateContract$/.test(t)) {
    out.sender = str(first(f, 1)); out.contract = str(first(f, 2)); const c = first(f, 3); out.code_id = c && c.v != null ? String(c.v) : null; out.msg = jsonOf(first(f, 4));
  } else if (/\.MsgUpdateAdmin$/.test(t)) { out.sender = str(first(f, 1)); out.new_admin = str(first(f, 2)); out.contract = str(first(f, 3)); }
  else if (/\.MsgClearAdmin$/.test(t)) { out.sender = str(first(f, 1)); out.contract = str(first(f, 3)); }
  else if (/authz\.v1beta1\.MsgExec$/.test(t) && depth < 2) { out.sender = str(first(f, 1)); out.inner = f.filter((x) => x.no === 2 && x.b).map((x) => decodeMsg(anyOf(x.b), depth + 1)); }
  return out;
}
// base64 of a transaction's bytes → its messages, in order
function messagesOf(b64) {
  const body = first(fields(Buffer.from(String(b64), 'base64')), 1);
  if (!body || !body.b) throw new Error('no body in the transaction bytes');
  return fields(body.b).filter((f) => f.no === 1 && f.b).map((f) => decodeMsg(anyOf(f.b)));
}

/**
 * recs: the change records of ONE transaction (lib/admin-classifier.js, each with msg_index / msg_type / signer).
 * Every record that was SENT (not a proposal being executed — the proposal's messages are in the governance capture — and
 * not the weekly routine) gets `sent`: { to, msg?, code_id?, new_admin?, funds? } and schemaVersion 2, when the bytes
 * agree with the events. Returns how many records got one.
 */
function attachSent(recs, b64) {
  if (!Array.isArray(recs) || !recs.some((r) => r && !r.routine && !r.observed && !(r.via && r.via.kind === 'dao_proposal'))) return 0;
  let msgs; try { msgs = messagesOf(b64); } catch (e) { return 0; }
  let n = 0;
  for (const r of recs) {
    if (!r || r.routine || r.observed || (r.via && r.via.kind === 'dao_proposal') || r.msg_index == null) continue;
    let m = msgs[r.msg_index];
    if (!m || m.type !== r.msg_type || !m.sender || m.sender !== r.signer) continue;       // the bytes must say what the events said
    if (m.inner) { if (m.inner.length !== 1) continue; m = m.inner[0]; }                   // through authz: the one granted message
    if (!m.contract) continue;
    const sent = { to: m.contract };
    if (m.msg !== undefined) sent.msg = m.msg;
    if (m.code_id) sent.code_id = m.code_id;
    if (typeof m.new_admin === 'string') sent.new_admin = m.new_admin;
    if (m.funds && m.funds.length) sent.funds = m.funds;
    r.sent = sent; r.schemaVersion = 2; n++;
  }
  return n;
}

module.exports = { VERSION, MAX_JSON, fields, messagesOf, attachSent };
