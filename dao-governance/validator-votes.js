/* lib/validator-votes.js — 1.0.0 (2026-11-27) — how each validator voted on a chain governance proposal (Cosmos x/gov).
 * Owner, on a Terra proposal card: "for props can we show who voted and how they voted please — validators".
 *
 * read({ id, getJson })  → every BONDED validator, largest stake first, with the vote its own account has cast (or none):
 *     validators  GET /cosmos/staking/v1beta1/validators?status=BOND_STATUS_BONDED     (paged)
 *     votes       GET /cosmos/gov/v1/proposals/{id}/votes                               (paged — every voter; only validators kept)
 *   A validator votes from the account behind its operator address: the same key, written with the account prefix
 *   (terravaloper1… → terra1…). That conversion is done here (bech32), nothing is looked up by name.
 * The chain keeps individual votes ONLY while a vote is open — once it closes they are gone from state. So this can be read
 * live for an open proposal; for a closed one only a copy taken while it was open exists (the dao-governance capture keeps one).
 *
 * What a row means: the validator's vote counts for all LUNA staked with it, EXCEPT where a delegator casts their own vote —
 * so "stake" here is the most a validator's vote can carry, not exactly what the tally counted for it.
 * Never guessed: a page of votes that cannot be read, or more pages than the cap, makes the result `complete: false`, and the
 * page then says a validator shown as "not voted" may have voted.
 *
 * The SAME file runs in the browser (window.ValidatorVotes) and in the hosted capture (platform-crons dao-governance/validator-votes.js
 * is a copy — keep the two identical). Pure except for the injected getJson(path) → parsed JSON or null.
 */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.ValidatorVotes = factory(); })(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const VERSION = '1.0.0';
  const CH = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l', GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  const polymod = (v) => { let c = 1; for (const x of v) { const t = c >>> 25; c = (((c & 0x1ffffff) << 5) ^ x) >>> 0; for (let i = 0; i < 5; i++) if ((t >>> i) & 1) c = (c ^ GEN[i]) >>> 0; } return c; };
  const hrpExpand = (h) => [...h].map((c) => c.charCodeAt(0) >> 5).concat([0], [...h].map((c) => c.charCodeAt(0) & 31));
  function bech32Decode(s) { s = String(s || ''); if (s !== s.toLowerCase() || s.length < 8 || s.length > 120) return null; const p = s.lastIndexOf('1'); if (p < 1 || p + 7 > s.length) return null;
    const hrp = s.slice(0, p), data = []; for (const c of s.slice(p + 1)) { const i = CH.indexOf(c); if (i < 0) return null; data.push(i); }
    if (polymod(hrpExpand(hrp).concat(data)) !== 1) return null; return { hrp, data: data.slice(0, -6) }; }
  function bech32Encode(hrp, data) { const pm = (polymod(hrpExpand(hrp).concat(data, [0, 0, 0, 0, 0, 0])) ^ 1) >>> 0; const ck = [0, 1, 2, 3, 4, 5].map((i) => (pm >>> (5 * (5 - i))) & 31); return hrp + '1' + data.concat(ck).map((x) => CH[x]).join(''); }
  /** terravaloper1… → terra1… (the account behind an operator address). null when the input is not a valid …valoper address. */
  function toAccount(valoper) { const d = bech32Decode(valoper); if (!d || !/valoper$/.test(d.hrp)) return null; return bech32Encode(d.hrp.replace(/valoper$/, ''), d.data); }

  const OPT = { VOTE_OPTION_YES: 'yes', VOTE_OPTION_ABSTAIN: 'abstain', VOTE_OPTION_NO: 'no', VOTE_OPTION_NO_WITH_VETO: 'no_with_veto', 1: 'yes', 2: 'abstain', 3: 'no', 4: 'no_with_veto' };
  const KINDS = ['yes', 'no', 'no_with_veto', 'abstain', 'split', 'none'];
  const LABEL = { yes: 'Yes', no: 'No', no_with_veto: 'No with veto', abstain: 'Abstain', split: 'Split vote', none: 'Not voted' };
  /** one vote record of the chain → { vote, weights } ; a vote split over several options is 'split' with its weights */
  function voteOf(v) { const opts = (Array.isArray(v && v.options) && v.options.length ? v.options : (v && v.option != null ? [{ option: v.option, weight: '1' }] : [])).map((o) => ({ k: OPT[o.option] || null, w: Number(o.weight) })).filter((o) => o.k && o.w > 0);
    if (!opts.length) return null; if (opts.length === 1) return { vote: opts[0].k }; return { vote: 'split', weights: Object.fromEntries(opts.map((o) => [o.k, Math.round(o.w * 1e4) / 1e4])) }; }
  const pct = (a, b) => (b > 0n ? Number(a * 1000000n / b) / 10000 : 0);

  async function read(o) { const id = String(o.id).replace(/\D/g, ''), getJson = o.getJson, pageSize = o.pageSize || 500, maxPages = o.maxPages || 40; const why = [];
    // 1. the bonded validators
    const vals = []; { let key = null, pages = 0; do { const r = await getJson(`/cosmos/staking/v1beta1/validators?status=BOND_STATUS_BONDED&pagination.limit=200${key ? '&pagination.key=' + encodeURIComponent(key) : ''}`);
        if (!r || !Array.isArray(r.validators)) { if (!vals.length) return { ok: false, error: 'the validator list could not be read' }; why.push('a page of the validator list could not be read'); break; }
        for (const v of r.validators) { const account = toAccount(v.operator_address); let stake = 0n; try { stake = BigInt(String(v.tokens || '0').split('.')[0]); } catch (e) { stake = 0n; } if (account) vals.push({ moniker: String((v.description && v.description.moniker) || '').slice(0, 60) || null, operator: v.operator_address, account, stake }); }
        key = r.pagination && r.pagination.next_key ? r.pagination.next_key : null; pages++; } while (key && pages < 10); }
    if (!vals.length) return { ok: false, error: 'the validator list came back empty' };
    const byAccount = new Map(vals.map((v) => [v.account, v]));
    // 2. every vote on the proposal; only the validators' own are kept
    let voters = 0, key = null, pages = 0, readAny = false; do { const r = await getJson(`/cosmos/gov/v1/proposals/${id}/votes?pagination.limit=${pageSize}${key ? '&pagination.key=' + encodeURIComponent(key) : ''}`);
      if (!r || !Array.isArray(r.votes)) { if (!readAny) return { ok: false, error: 'the votes could not be read' }; why.push('a page of votes could not be read'); key = null; break; }
      readAny = true; for (const v of r.votes) { voters++; const val = byAccount.get(v.voter); if (val) { const x = voteOf(v); if (x) { val.vote = x.vote; if (x.weights) val.weights = x.weights; } } }
      key = r.pagination && r.pagination.next_key ? r.pagination.next_key : null; pages++; } while (key && pages < maxPages);
    if (key) why.push(`more than ${maxPages * pageSize} votes — the list was not read to the end`);
    // 3. the table
    const total = vals.reduce((t, v) => t + v.stake, 0n); vals.sort((a, b) => (b.stake > a.stake ? 1 : b.stake < a.stake ? -1 : a.operator < b.operator ? -1 : 1));
    const by = Object.fromEntries(KINDS.map((k) => [k, { n: 0, stake_pct: 0 }])); const sums = Object.fromEntries(KINDS.map((k) => [k, 0n]));
    const list = vals.map((v, i) => { const k = v.vote || 'none'; by[k].n++; sums[k] += v.stake; const row = { rank: i + 1, moniker: v.moniker, operator: v.operator, stake_pct: pct(v.stake, total), vote: v.vote || null }; if (v.weights) row.weights = v.weights; return row; });
    for (const k of KINDS) by[k].stake_pct = pct(sums[k], total);
    const voted = vals.length - by.none.n;
    return { ok: true, version: VERSION, proposal_id: Number(id), read_at: new Date(o.now || Date.now()).toISOString(), validators: vals.length, voted, voted_stake_pct: pct(total - sums.none, total), voters_total: voters, complete: why.length === 0, why_incomplete: why.length ? why : undefined, by, list };
  }

  // ── drawing (browser) ─────────────────────────────────────────────────────────────────────────────────────────────────
  const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const f1 = (x) => (Number(x) || 0).toFixed(x < 10 ? 2 : 1) + '%';
  const COL = { yes: '#34d399', no: '#f87171', no_with_veto: '#fb923c', abstain: '#94a3b8', split: '#c4b5fd', none: '#3b4252' };
  const when = (iso) => new Date(iso).toLocaleString('en-US', { timeZone: 'UTC', hour12: false, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) + ' UTC';
  const CSS = '.vv{font-size:14px;color:#e5e7eb;line-height:1.45}.vv b{color:#fff}.vv-bar{display:flex;gap:2px;height:16px;margin:8px 0 6px;border-radius:4px;overflow:hidden}.vv-bar i{display:block;min-width:2px}.vv-leg{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:13px;color:#cbd5e1}.vv-leg i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:5px}' +
    '.vv-f{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0 6px}.vv-f button{font:inherit;font-size:13px;padding:3px 10px;border-radius:999px;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.04);color:#cbd5e1;cursor:pointer}.vv-f button.on{background:rgba(34,211,238,.16);border-color:#22d3ee;color:#cffafe}' +
    '.vv-t{width:100%;border-collapse:collapse;font-size:14px}.vv-t th{text-align:left;font-size:13px;font-weight:600;color:#94a3b8;padding:4px 8px;border-bottom:1px solid rgba(255,255,255,.12)}.vv-t td{padding:5px 8px;border-bottom:1px solid rgba(255,255,255,.06);vertical-align:middle}.vv-t td.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}.vv-t tr.none td{color:#94a3b8}.vv-t th:nth-child(1){width:3rem}.vv-t th:nth-child(3){width:6rem}.vv-t th:nth-child(4){width:17rem}@media(max-width:640px){.vv-t th:nth-child(4){width:auto}}' +
    '.vv-p{display:inline-block;font-size:13px;font-weight:600;padding:1px 9px;border-radius:999px;white-space:nowrap}.vv-wrap{max-height:460px;overflow:auto;border:1px solid rgba(255,255,255,.08);border-radius:8px}.vv-note{font-size:13px;color:#94a3b8;margin-top:8px}.vv-warn{font-size:13px;color:#fde68a;border:1px solid rgba(251,191,36,.45);background:rgba(251,191,36,.07);border-radius:8px;padding:6px 10px;margin:8px 0}';
  const pill = (r) => { const k = r.vote || 'none'; const txt = k === 'split' ? 'Split: ' + Object.entries(r.weights || {}).map(([o, w]) => `${LABEL[o]} ${Math.round(w * 100)}%`).join(' · ') : LABEL[k]; return `<span class="vv-p" style="background:${k === 'none' ? 'transparent' : COL[k] + '26'};color:${k === 'none' ? '#94a3b8' : COL[k]};${k === 'none' ? 'border:1px solid rgba(255,255,255,.14)' : ''}">${esc(txt)}</span>`; };
  /** the table as HTML. opts.asOf = text said before the read time (e.g. "as last read while the vote was open,") */
  function html(R, opts) { opts = opts || {}; if (!R || !R.ok) return `<div class="vv"><style>${CSS}</style><div class="vv-warn">${esc((R && R.error) || 'The validators\' votes could not be read right now.')}</div></div>`;
    const f = opts.filter && KINDS.includes(opts.filter) ? opts.filter : 'all'; const rows = R.list.filter((r) => f === 'all' || (r.vote || 'none') === f); const shown = KINDS.filter((k) => R.by[k] && R.by[k].n > 0);
    return `<div class="vv" data-vv-root data-filter="${f}"><style>${CSS}</style>
      <div data-vv="sum"><b>${R.voted}</b> of <b>${R.validators}</b> validators have voted — they hold <b>${f1(R.voted_stake_pct)}</b> of the staked LUNA. <span style="color:#94a3b8">${esc(opts.asOf || 'Read from the chain')} ${esc(when(R.read_at))}.</span></div>
      ${R.complete ? '' : `<div class="vv-warn" data-vv="incomplete"><b>The votes were not read to the end</b> (${esc((R.why_incomplete || []).join('; '))}). A validator shown as "not voted" may have voted.</div>`}
      <div class="vv-bar" data-vv="bar" role="img" aria-label="${esc(shown.map((k) => `${LABEL[k]} ${f1(R.by[k].stake_pct)} of stake`).join(', '))}">${shown.map((k) => `<i data-k="${k}" style="flex:${R.by[k].stake_pct.toFixed(4)} 1 0;background:${COL[k]}" title="${LABEL[k]} — ${R.by[k].n} validator${R.by[k].n === 1 ? '' : 's'}, ${f1(R.by[k].stake_pct)} of the staked LUNA"></i>`).join('')}</div>
      <div class="vv-leg" data-vv="legend">${shown.map((k) => `<span data-k="${k}"><i style="background:${COL[k]}"></i>${LABEL[k]} <b>${R.by[k].n}</b> · ${f1(R.by[k].stake_pct)} of stake</span>`).join('')}</div>
      <div class="vv-f" data-vv="filter">${['all'].concat(shown).map((k) => `<button type="button" data-vv-f="${k}" class="${k === f ? 'on' : ''}">${k === 'all' ? 'All ' + R.validators : LABEL[k] + ' ' + R.by[k].n}</button>`).join('')}</div>
      <div class="vv-wrap"><table class="vv-t"><thead><tr><th>#</th><th>Validator</th><th style="text-align:right">Stake</th><th>Vote</th></tr></thead><tbody>${rows.map((r) => `<tr class="${r.vote || 'none'}" data-op="${esc(r.operator)}"><td class="n">${r.rank}</td><td>${esc(r.moniker || r.operator.slice(0, 16) + '…')}</td><td class="n">${f1(r.stake_pct)}</td><td>${pill(r)}</td></tr>`).join('') || '<tr><td colspan="4" style="color:#94a3b8">No validator in this group.</td></tr>'}</tbody></table></div>
      <div class="vv-note">Stake is each validator's share of all LUNA staked with the validators in the active set, largest first. A validator's vote counts for the LUNA staked with it, except where a delegator casts their own vote — so the tally above can differ from these shares. ${R.voters_total != null ? `${Number(R.voters_total).toLocaleString('en-US')} accounts have voted in all; only validators are listed here.` : ''} The chain keeps individual votes only while a vote is open.</div></div>`; }
  /** draw into an element and make the filter buttons work */
  function mount(el, R, opts) { opts = Object.assign({}, opts); el.innerHTML = html(R, opts); if (el.__vvWired) { el.__vv = { R, opts }; return; } el.__vvWired = true; el.__vv = { R, opts };
    el.addEventListener('click', (ev) => { const b = ev.target && ev.target.closest ? ev.target.closest('[data-vv-f]') : null; if (!b) return; ev.preventDefault(); const s = el.__vv; s.opts.filter = b.getAttribute('data-vv-f'); el.innerHTML = html(s.R, s.opts); }); }

  const GONE = 'The chain keeps individual votes only while a vote is open — once it closes they are no longer in its state. This page began keeping a copy of the validators\' votes on 27 Nov 2026, so there is no list for this proposal.';
  /** fill a card's section: live from the chain while the vote is open; for a closed vote the copy kept on the card (card.validatorVotes), else a plain line */
  async function fill(card, el, o) { const kept = card && card.validatorVotes && Array.isArray(card.validatorVotes.list) ? Object.assign({}, card.validatorVotes, { ok: true }) : null;
    if (card && card.live) { const R = await read({ id: card.id, getJson: o.getJson, now: o.now }); if (R.ok) { mount(el, R, {}); return 'live'; } if (kept) { mount(el, kept, { asOf: 'The live read failed — as last captured' }); return 'kept-after-failure'; } mount(el, R, {}); return 'failed'; }
    if (kept) { mount(el, kept, { asOf: 'As last read while the vote was open,' }); return 'kept'; }
    el.innerHTML = `<div data-vv="gone" style="font-size:13px;color:#cbd5e1;line-height:1.5">${esc(GONE)}</div>`; return 'gone'; }

  return { VERSION, read, html, mount, fill, toAccount, voteOf, LABEL, KINDS, _bech32: { decode: bech32Decode, encode: bech32Encode } };
});
