// =============================================================================
// help-agent/server.js — the site's grounded Q&A + triage service (v1)
// -----------------------------------------------------------------------------
// A tiny Node web service (zero dependencies, Node 18+) that answers visitor
// questions about thealliancedao.com, grounded on the site's OWN docs and live
// data products — it checks claims against the same sources the pages render.
//
// SPEC: tla-core/docs/pending-changes/SPEC-site-help-agent.md
//
// Deploy (Render web service):
//   build command:  (none)          start command:  node server.js
//   env:
//     ANTHROPIC_API_KEY    required — console.anthropic.com key (Haiku-tier use)
//     ALLOWED_ORIGIN       default https://thealliancedao.com
//     MONTHLY_BUDGET_USD   default 10 — hard stop when estimated spend exceeds
//     RATE_PER_HOUR        default 10 — questions per IP per hour
//     PORT                 provided by Render
//
// Cost model (verified 2026-08-20): claude-haiku-4-5 at $1/MTok in, $5/MTok
// out; grounding corpus sent as a cached system prompt (cache reads bill at
// 0.1x input) → ~1–2¢ per uncached question, well under 1¢ cached. The budget
// guard estimates spend from usage fields the API returns and hard-stops at
// MONTHLY_BUDGET_USD.
// =============================================================================
'use strict';
const http = require('http');

const API_KEY = process.env.ANTHROPIC_API_KEY || '';
// v1.3.1 (2026-08-20): the site answers on BOTH the apex and www — the
// browser treats them as different origins, and allowing only the apex
// blocked every www request at preflight (owner console log). ALLOWED_ORIGIN
// is now a comma-separated list; the response echoes whichever allowed
// origin is asking (the header can only carry one value).
const ORIGINS = (process.env.ALLOWED_ORIGIN || 'https://thealliancedao.com,https://www.thealliancedao.com')
  .split(',').map(function (x) { return x.trim(); }).filter(Boolean);
const BUDGET = parseFloat(process.env.MONTHLY_BUDGET_USD || '10');
const RATE = parseInt(process.env.RATE_PER_HOUR || '10', 10);
const MODEL = process.env.MODEL || 'claude-haiku-4-5-20251001';  // env-overridable: set MODEL=claude-sonnet-4-6 in Render to tier up (~3x cost/answer), no code change needed
const CORE = 'https://raw.githubusercontent.com/thealliancedao/tla-core/main';

// ---- grounding corpus: fetched, cached ~15 min --------------------------------
// v1.0.1 (2026-08-20): full project knowledge — the ecosystem docs, pricing
// doctrine, repo catalog, EVERY page changelog, and the spec files, so the
// agent can answer "how does X work", "when/why did Y change", and "does Z
// already exist / is it already queued" from the same sources build sessions
// read. All of this is public repo content; per-source cap bounds the corpus.
const CORPUS_SOURCES = [
  ['README',            `${CORE}/README.md`],
  ['repo-catalog',      `${CORE}/docs/REPO-CATALOG.md`],
  ['data-map',          `${CORE}/docs/agent/DATA-MAP.md`],
  ['known-contracts',   `${CORE}/docs/curated/known_contracts.json`],
  ['grading-config',    `${CORE}/docs/curated/grading_config.json`],
  ['pricing-doctrine',  `${CORE}/docs/ecosystem-knowledge/PRICING-DOCTRINE.md`],
  ['eris-protocol',     `${CORE}/docs/ecosystem-knowledge/eris-protocol.md`],
  ['astroport',         `${CORE}/docs/ecosystem-knowledge/astroport.md`],
  ['backbonelabs',      `${CORE}/docs/ecosystem-knowledge/backbonelabs.md`],
  ['credia',            `${CORE}/docs/ecosystem-knowledge/credia.md`],
  ['tla-changelog',     `${CORE}/docs/changelogs/tla-log.md`],
  ['index-changelog',   `${CORE}/docs/changelogs/index-log.md`],
  ['portfolio-changelog',`${CORE}/docs/changelogs/portfolio-log.md`],
  ['dao-changelog',     `${CORE}/docs/changelogs/dao-log.md`],
  ['explorer-changelog',`${CORE}/docs/changelogs/explorer-log.md`],
  ['help-changelog',    `${CORE}/docs/changelogs/help-log.md`],
  ['lp-grades-changelog',`${CORE}/docs/changelogs/cron-lp-grades-log.md`],
  ['spec-lp-grading',   `${CORE}/docs/pending-changes/SPEC-lp-grading.md`],
  ['spec-activity-feed',`${CORE}/docs/pending-changes/SPEC-activity-feed.md`],
  ['spec-help-agent',   `${CORE}/docs/pending-changes/SPEC-site-help-agent.md`],
  ['build-queue',       `${CORE}/docs/pending-changes/CHANGES_PENDING.md`],
];
const LIVE_HEADS = [
  ['system-health',     `${CORE}/system-health/current.json`],
  ['lp-grades-meta',    `${CORE}/lp-grades/snapshots/heartbeat.json`],
  ['snapshot-heartbeat',`${CORE}/member-data/tla-snapshot/heartbeat.json`],
  ['bribe-runway',      `${CORE}/tla-voting/bribe-state/runway.json`],
];
let corpusCache = { at: 0, text: '' };
async function grounding() {
  if (Date.now() - corpusCache.at < 15 * 60 * 1000 && corpusCache.text) return corpusCache.text;
  const parts = [];
  for (const [name, url] of [...CORPUS_SOURCES, ...LIVE_HEADS]) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'tla-help-agent' } });
      if (!r.ok) { parts.push(`<${name}>UNAVAILABLE (${r.status})</${name}>`); continue; }
      let t = await r.text();
      if (t.length > 20000) t = t.slice(0, 20000) + '\n…[truncated]';
      parts.push(`<${name}>\n${t}\n</${name}>`);
    } catch (e) { parts.push(`<${name}>FETCH ERROR</${name}>`); }
  }
  corpusCache = { at: Date.now(), text: parts.join('\n\n') };
  return corpusCache.text;
}

const SYSTEM_RULES = `You are the help assistant for thealliancedao.com (TLA Stats) — a DeFi
analytics site for the Terra Liquidity Alliance. You answer questions about the SITE and its
DATA only, grounded strictly in the corpus below.

Hard rules, in priority order:
1. NEVER invent a number, address, or fact not present in the corpus. If the corpus doesn't
   answer, say exactly that and point the visitor to the "Report an issue" form on the Help
   page — a maintainer reads every report.
2. EDUCATION, NEVER ADVICE — the participation protocol:
   - You may explain MECHANICS: how entering/exiting an LP works, what slippage / take rate /
     amplification / lock coefficients do, how epochs and gauge votes settle, what the site's
     tools measure. You may walk through a scenario the VISITOR specifies in mechanical,
     conditional terms ("if a pool's bribe pot empties, Votion re-optimizes away and vote
     weight follows — that is documented system behavior").
   - You may show the visitor THEIR OWN numbers (wallet block) and point to the site's tools:
     the slippage/zap planner models entry-exit price impact at their exact size; the Bribe
     Runway shows pot funding; LP Grades shows the public rubric; the Bounty Board shows
     current vote pay.
   - You must NEVER: say "best", "should", "recommend", rank options FOR a person, size a
     position, predict prices/APRs as expectations, or turn a mechanical consequence into a
     suggestion to act. When asked "what's the best way to X" or "what will happen next
     epoch", REFRAME: explain the mechanics and the measurable factors, name the tool that
     models it, and state plainly that the decision is theirs.
   - End every participation-adjacent answer with one short line: "Not financial advice —
     mechanics only; decisions and risk are yours. Verify on chain."
   - Predictions: you may state documented mechanical consequences and CURRENT measured
     values (runway epochs left, current votes). You may not forecast outcomes, probabilities
     or returns. "Tons of possibilities" is exactly why: the honest answer names the forces,
     not the future.
3. Honesty doctrine: blanks on the site are deliberate (no trustworthy source) — explain the
   reason when known, never suggest the site should "just estimate".
4. A data product REPORTING a finding is that product working; findings are not faults.
5. When a visitor claims something is wrong, check it against the live heads in the corpus
   (heartbeats, system-health, runway). If their claim is plausible and you cannot refute it
   from the corpus, say it deserves a report and encourage the form.
6. Keep answers short (2-6 sentences), plain-language, no hype. You may quote exact field
   names and doc chapters. Never speak for the DAO on governance.
7. If a <visitor_wallet> block is present, the visitor pasted their own address: check their
   claim against those ACTUAL numbers first (a "portfolio looks off" question usually resolves
   to a documented cause — a field rename in the changelogs, coverage suppression, nightly
   cadence, or the VP definition). If their number genuinely disagrees with the record, that
   is report-worthy: say so and point them to the form.
8. For feature requests: check the changelogs and specs first — if it ALREADY EXISTS, say
   which page/tile shows it; if it is ALREADY QUEUED, name the spec; only then suggest filing
   a request.
9. Chain tools: you may query the public LCD for a tx hash the visitor gives, or recent txs
   of an address THE VISITOR THEMSELVES provided (never go hunting other wallets for them —
   it is public data, but this assistant only investigates on the asker's behalf). Summarize
   what the chain actually returned — actions, amounts, memos — and say plainly when a search
   only covers sender-side messages. If the node errors, say so; never fill gaps from memory.
10. TRUST LINKS — make answers verifiable. Format links as markdown [label](url):
   - Any data file you used → link its source: https://github.com/thealliancedao/tla-core/blob/main/<path>
   - Any tx hash → [view tx](https://chainsco.pe/terra2/tx/<HASH>)
   - Any wallet you discuss → [their portfolio](https://thealliancedao.com/member-portfolio.html?wallet=<addr>) and [on-chain](https://chainsco.pe/terra2/address/<addr>)
   - Protocol mechanics → the protocol's own docs: https://docs.erisprotocol.com (Eris/vAMP/amplifier), https://docs.astroport.fi (Astroport)
   - Write addresses and hashes IN FULL (never elide with …) — the interface renders them copyable.
   One or two links per answer, only where they genuinely let the reader verify — not decoration.
11. COMPARATIVE DISCIPLINE — rankings are claims, not color. Never write "largest",
   "second-largest", "biggest", "after X", "more than Y" or any ranking/superlative unless
   EITHER the corpus states it in so many words, OR you show the arithmetic from numbers
   present in your context ("6.73M vs aDAO's 0.84M — roughly 8x larger"). If the numbers you
   have CONTRADICT a ranking you were about to write, the numbers win and the ranking dies.
   A grounded figure with an invented comparison attached is still a fabrication — the
   owner caught exactly this ("second-largest after aDAO" beside numbers proving otherwise),
   and it is the most credibility-destroying error this assistant can make.
12. HISTORICAL DATA MAP — before saying "I can't find historical data", check these products
   (all readable via read_product):
   - member-data/tla-snapshot/apr-history.json — per-POOL APR per EPOCH (apr_pct_avg), 16 epochs.
     THE source for "why did pool X's APR change" questions.
     ALWAYS pass key:"<pool name>" (e.g. key:"xASTRO") to read_product for these files —
     it extracts just that pool's per-epoch series; without key, truncation can cut the
     pool out of the middle. Decompose an APR move by reading the SAME pool from BOTH
     matrices: APR series (apr-history) + staked_usd & vp_human series (pool-status) —
     then say which moved: the denominator (staked), the allocation (vp), or both.
   - member-data/tla-snapshot/pool-status-history.json — per-pool per-epoch staked_usd, vp_human,
     bucket_pct, active status. APR moves decompose here: denominator (staked) vs allocation (vp).
   - member-data/tla-snapshot/epoch-band-history.json — TLA-wide per-epoch pools/TVL/luna price.
   - nfts/adao/snapshots/state-history/ — daily staked/held counts to 2025-01.
   - tla-voting/distributions/history.json — gauge payouts per period (NOT under events/).
   WRONG-OBJECT caution: single-asset sink pools (xASTRO, ampCAPA, ampROAR) are NOT the same as
   their trading pairs (LUNA-ASTRO etc). Evidence about a pair says nothing about the sink.
   APR-BASIS caution: our apr_pct_avg uses the platform basis; Eris UI shows a different
   convention — absolute levels differ, trend shapes agree. Say so when comparing to Eris numbers.`;

// ---- triage modes (v1.7.0) ----------------------------------------------------
// The Help page's Report/Request forms now run THROUGH the assistant first:
// the form submits with mode:'report'|'request', the addendum below rides as a
// third system block AFTER the cached corpus (so triage never invalidates the
// prompt cache), and the reply ends with a ---DRAFT--- block the page extracts
// into a prefilled GitHub issue — the maintainer receives a PRE-INVESTIGATED
// report, and the visitor learns the constraint instead of shouting into a form.
const MODE_ADDENDA = {
  report: `TRIAGE MODE — ISSUE REPORT. The visitor is filing a problem report through the Help
page form. Do these in order:
1. VERIFY: check the claim against the live heads in the corpus and, where a data product
   would show it, read_product the actual record (their wallet block too, if present).
2. CLASSIFY, and say which plainly: KNOWN CAUSE (documented behavior explains it — nightly
   cadence, coverage suppression, the VP definition, a changelog entry, a deliberate blank),
   PLAUSIBLE FAULT (the record disagrees with what the site should show, or you cannot
   refute the claim), or CANNOT VERIFY (no product covers it).
3. EXPLAIN what you checked and found, plainly, with the numbers.
4. DRAFT: end your reply with a filing draft in EXACTLY this format:
---DRAFT---
TITLE: [Site report] <page>: <short summary>
BODY:
<page · the claim · value seen · what you verified and what it showed · your
classification and reasoning · repo paths of the exact files checked · timestamp>
---END DRAFT---
For KNOWN CAUSE, explain the cause first and note filing is optional — but still include
the draft with your finding inside, so if they file anyway the triage travels with it.
Never discourage filing; your triage rides WITH the report, never instead of it.
The conversational part keeps your normal 2-6 sentences; the draft block is extra.`,
  request: `TRIAGE MODE — FEATURE REQUEST. The visitor is proposing a feature through the Help
page form. Do these in order:
1. CHECK EXISTENCE: search the changelogs and specs in the corpus — if it already exists,
   name the page/tile that shows it; if already queued, name the spec.
2. CLASSIFY into the site's triage lanes and say which plainly: ALREADY EXISTS ·
   ALREADY QUEUED · DATA EXISTS, SMALL BUILD (the products already capture what this needs
   — name them) · NEEDS NEW CAPTURE (say what would have to be captured, and that history
   generally cannot be backfilled from before capture starts unless an archive walk covers
   it) · CONFLICTS WITH DOCTRINE (e.g. anything needing estimated or invented numbers —
   teach the honest-data rule rather than just refusing).
3. SHAPE: help sharpen the proposal — what exactly, where it lives, why useful, which data
   products feed it or are missing.
4. DRAFT: unless ALREADY EXISTS fully answers them, end with:
---DRAFT---
TITLE: [Feature request] <short summary>
BODY:
<the request · suggested home · why useful · your triage lane and reasoning · the data
products involved or the capture that would be needed>
---END DRAFT---
The maintainer reads every request; your triage travels with it.
The conversational part keeps your normal 2-6 sentences; the draft block is extra.`,
};

// ---- spend + rate guards ------------------------------------------------------
let spend = { month: new Date().toISOString().slice(0, 7), usd: 0 };
const hits = new Map(); // ip -> [timestamps]
function rateOk(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter(t => now - t < 3600e3);
  if (arr.length >= RATE) { hits.set(ip, arr); return { ok: false, used: arr.length }; }
  arr.push(now); hits.set(ip, arr); return { ok: true, used: arr.length };
}
function budgetOk() {
  const m = new Date().toISOString().slice(0, 7);
  if (m !== spend.month) spend = { month: m, usd: 0 };
  return spend.usd < BUDGET;
}

// ---- wallet lookup (v1.0.1) ---------------------------------------------------
// If the question contains a terra1 address, fetch that wallet's ACTUAL record
// from the public positions + participants products and hand it to the model —
// so "my portfolio looks off" gets checked against the visitor's real numbers,
// not answered in generalities. Public-repo data only; nothing is stored.
let posCache = { at: 0, positions: null, participants: null };
async function walletExtract(question, explicitWallet) {
  // v1.3.0: the site's help drawer can pin a wallet (picked from the member
  // list) — it arrives as its own field and wins over any address in the text.
  const m = (explicitWallet && /^terra1[a-z0-9]{38,58}$/.test(explicitWallet)) ? [explicitWallet]
    : question.match(/terra1[a-z0-9]{38,58}/);
  if (!m) return '';
  const addr = m[0];
  try {
    if (Date.now() - posCache.at > 15 * 60 * 1000 || !posCache.positions) {
      const [p, pt] = await Promise.all([
        fetch(`${CORE}/member-data/positions/current.json`).then(r => r.ok ? r.json() : null),
        fetch(`${CORE}/member-data/participants/current.json`).then(r => r.ok ? r.json() : null),
      ]);
      posCache = { at: Date.now(), positions: p, participants: pt };
    }
    const find = (root) => (root && (root.members || root.participants) || [])
      .find(x => x.wallet === addr || x.address === addr);
    const pos = find(posCache.positions), part = find(posCache.participants);
    if (!pos && !part) return `<visitor_wallet addr="${addr}">NOT TRACKED — this wallet is not in the participants feed; the portfolio page only covers the tracked electorate.</visitor_wallet>`;
    const pack = { address: addr,
      positions_summary: pos ? pos.summary : null,
      positions_alerts: pos ? (pos.alerts || null) : null,
      lock_count: part && part.locks ? part.locks.length : (pos && pos.summary ? pos.summary.lock_count : null),
      locks_brief: part && part.locks ? part.locks.slice(0, 12).map(l => ({ id: l.token_id, sym: l.asset_symbol, amt: l.amount_human, vp: l.vp_total_human, end_period: l.end_period, auto_max: l.is_auto_max_locked })) : null };
    let t = JSON.stringify(pack);
    if (t.length > 8000) t = t.slice(0, 8000) + '…[truncated]';
    return `<visitor_wallet addr="${addr}" note="live record from the public positions/participants products — check the visitor's claim against THESE numbers">${t}</visitor_wallet>`;
  } catch (e) { return `<visitor_wallet addr="${addr}">LOOKUP FAILED (${e.message}) — answer from the docs and suggest the report form.</visitor_wallet>`; }
}

// ---- chain tools (v1.1.0) -----------------------------------------------------
// Real tool use: the model can ask the server to hit the public Terra LCD —
// tx by hash, or recent txs for the address the visitor provided. Raw tx JSON
// is enormous, so results are COMPACTED server-side to what answers questions:
// hash, time, memo, per-msg action summary (wasm actions included), transfers.
// Bounds: max 3 tool calls per question, 20 txs per search, 8s timeout each.
const LCD = process.env.LCD_URL || 'https://terra-lcd.publicnode.com';
const PRODUCT_PREFIXES = ['member-data/','nfts/','tla-voting/','lp-grades/','votion/','network-and-prices/','dex-data/','system-health/','catalog/','token-catalog/','tla-flows/','dex-liquidity/','docs/'];
const CHAIN_TOOLS = [
  { name: 'read_product', /* input.key: pool/token name for surgical extraction from big keyed files (apr-history, pool-status-history, token-catalog…) — ALWAYS use key for per-pool questions */
    description: 'Fetch a data file from the public tla-core repo (the same files the site renders). Use for questions needing actual records: e.g. nfts/adao/transfers/2026/08.json for NFT transfer/stake/unstake events, nfts/adao/flows/2026/08.json for sales/listings, tla-voting/events/locks/2026/08.json for lock events, member-data/positions/current.json, lp-grades/snapshots/current.json, tla-voting/bribe-state/runway.json. Monthly streams use {yyyy}/{mm}.json. The REPO-CATALOG in your corpus maps everything.',
    input_schema: { type: 'object', properties: { path: { type: 'string', description: 'repo-relative path, e.g. nfts/adao/transfers/2026/08.json' } }, required: ['path'] } },
  { name: 'get_transaction',
    description: 'Fetch one Terra (phoenix-1) transaction by hash from the public LCD node. Use when the visitor gives a tx hash.',
    input_schema: { type: 'object', properties: { hash: { type: 'string', description: '64-char hex tx hash' } }, required: ['hash'] } },
  { name: 'search_address_txs',
    description: 'Fetch recent transactions SENT by a terra1 address (message.sender) from the public LCD. Use for "what did this address do" questions. Newest first.',
    input_schema: { type: 'object', properties: { address: { type: 'string' }, limit: { type: 'integer', description: '1-20, default 10' } }, required: ['address'] } },
];
function compactTx(txr) {
  try {
    const tx = txr.tx || {}, body = tx.body || {}, resp = txr.tx_response || txr;
    const msgs = (body.messages || []).slice(0, 6).map(m => {
      const t = (m['@type'] || '').split('.').pop();
      const out = { type: t };
      if (m.contract) out.contract = m.contract;
      if (m.msg && typeof m.msg === 'object') out.execute = Object.keys(m.msg)[0];
      return out;
    });
    const actions = [], transfers = [];
    for (const ev of (resp.events || (resp.logs && resp.logs.flatMap(l => l.events)) || [])) {
      if (ev.type === 'wasm') {
        for (const a of ev.attributes || []) if (a.key === 'action') actions.push(a.value);
      }
      if (ev.type === 'transfer') {
        const g = {}; for (const a of ev.attributes || []) g[a.key] = a.value;
        if (g.amount) transfers.push({ amount: g.amount, from: g.sender, to: g.recipient });
      }
    }
    return { hash: resp.txhash, height: resp.height, time: resp.timestamp,
      memo: body.memo || '', success: resp.code === 0 || resp.code === undefined,
      msgs, wasm_actions: [...new Set(actions)].slice(0, 10), transfers: transfers.slice(0, 8) };
  } catch (e) { return { error: 'compact failed: ' + e.message }; }
}
async function lcdFetch(path) {
  const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 8000);
  try {
    const r = await fetch(LCD + path, { signal: ctl.signal, headers: { 'User-Agent': 'tla-help-agent' } });
    if (!r.ok) return { error: 'LCD ' + r.status };
    return await r.json();
  } catch (e) { return { error: 'LCD unreachable: ' + e.message }; }
  finally { clearTimeout(to); }
}
async function runTool(name, input) {
  if (name === 'read_product') {
    const p = String(input.path || '').replace(/\.\./g, '').replace(/^\/+/, '');
    if (!PRODUCT_PREFIXES.some(pre => p.startsWith(pre))) return { error: 'path not in the public product set' };
    try {
      const r = await fetch(`${CORE}/${p}`, { headers: { 'User-Agent': 'tla-help-agent' } });
      if (!r.ok) return { error: 'not found (' + r.status + ') — check the path against REPO-CATALOG' };
      let t = await r.text();
      // Surgical extraction: `key` pulls one pool/token/entry from big keyed files,
      // so the middle of a matrix is reachable (truncation used to cut it out).
      const key = String(input.key || '').trim();
      if (key && t.length > 4000) {
        try {
          const j = JSON.parse(t);
          const kl = key.toLowerCase();
          const hit = (arr) => arr.find(x => String(x.name || x.symbol || x.canonical || '').toLowerCase() === kl)
                   || arr.find(x => String(x.name || x.symbol || x.denom || '').toLowerCase().includes(kl));
          let found = null, where = null;
          for (const field of ['pools', 'tokens', 'epochs', 'entries', 'vaults', 'members']) {
            if (Array.isArray(j[field])) { const h = hit(j[field]); if (h) { found = h; where = field; break; } }
            if (j[field] && typeof j[field] === 'object' && j[field][key]) { found = j[field][key]; where = field; break; }
          }
          if (!found && j[key]) { found = j[key]; where = 'root'; }
          if (found) {
            return { path: p, extracted_key: key, from: where,
              meta: { epochs: j.epochs, generatedAt: j.generatedAt || (j.meta && j.meta.generated_at) },
              source_url: 'https://github.com/thealliancedao/tla-core/blob/main/' + p,
              content: JSON.stringify(found).slice(0, 13000) };
          }
          const names = [];
          for (const field of ['pools', 'tokens']) if (Array.isArray(j[field])) for (const x of j[field]) names.push(x.name || x.symbol || (x.denom || '').slice(0, 20));
          if (names.length) return { path: p, error: 'key "' + key + '" not found', available: names.slice(0, 60) };
        } catch (e) { /* fall through to normal read */ }
      }
      if (t.length > 14000) {
        // arrays: keep shape + head/tail so recent events survive truncation
        try { const j = JSON.parse(t);
          if (Array.isArray(j)) t = JSON.stringify({ _truncated: true, total: j.length, first: j.slice(0, 8), last: j.slice(-30) });
          else t = t.slice(0, 14000) + '…[truncated]';
        } catch (e) { t = t.slice(0, 14000) + '…[truncated]'; }
      }
      return { path: p, source_url: 'https://github.com/thealliancedao/tla-core/blob/main/' + p, content: t };
    } catch (e) { return { error: 'fetch failed: ' + e.message }; }
  }
  if (name === 'get_transaction') {
    const h = String(input.hash || '').replace(/[^A-Fa-f0-9]/g, '');
    if (h.length !== 64) return { error: 'invalid hash' };
    const d = await lcdFetch('/cosmos/tx/v1beta1/txs/' + h);
    return d.error ? d : compactTx(d);
  }
  if (name === 'search_address_txs') {
    const a = String(input.address || '');
    if (!/^terra1[a-z0-9]{38,58}$/.test(a)) return { error: 'invalid terra1 address' };
    const lim = Math.min(20, Math.max(1, parseInt(input.limit || 10, 10)));
    const q = encodeURIComponent(`message.sender='${a}'`);
    const d = await lcdFetch(`/cosmos/tx/v1beta1/txs?query=${q}&order_by=ORDER_BY_DESC&limit=${lim}`);
    if (d.error) return d;
    const list = (d.tx_responses || []).map((resp, i) => compactTx({ tx: (d.txs || [])[i], tx_response: resp }));
    return { count: list.length, txs: list, note: 'sender-side txs only (message.sender); incoming transfers do not appear here' };
  }
  return { error: 'unknown tool' };
}

// ---- the ask flow -------------------------------------------------------------
async function ask(question, explicitWallet, page, mode) {
  const corpus = await grounding();
  const walletBlock = await walletExtract(question, explicitWallet);
  const pageBlock = page ? `<visitor_context>The visitor is currently viewing: ${String(page).replace(/[^\w\-\/#.?=]/g,'').slice(0,100)} — tailor the answer to what that page shows.</visitor_context>\n` : '';
  const addendum = MODE_ADDENDA[mode] || null;
  const body = {
    model: MODEL,
    max_tokens: addendum ? 900 : 600,   // triage answers carry a draft block — give them room
    system: [
      { type: 'text', text: SYSTEM_RULES },
      // corpus as its own cached block: 90% cheaper on every repeat question.
      // v1.7.0: the mode addendum goes AFTER this block, so triage questions
      // share the same cached prefix as normal chat instead of invalidating it.
      { type: 'text', text: 'CORPUS:\n' + corpus, cache_control: { type: 'ephemeral' } },
      ...(addendum ? [{ type: 'text', text: addendum }] : []),
    ],
    messages: [{ role: 'user', content: pageBlock + (walletBlock ? walletBlock + '\n\n' : '') + question.slice(0, 2000) }],
  };
  body.tools = CHAIN_TOOLS;
  const track = (d) => { const u = d.usage || {};
    spend.usd += ((u.input_tokens || 0) * 1 + (u.output_tokens || 0) * 5 +
      (u.cache_read_input_tokens || 0) * 0.1 + (u.cache_creation_input_tokens || 0) * 1.25) / 1e6; };
  const call = async () => {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error && d.error.message || ('API ' + r.status));
    track(d); return d;
  };
  // tool-use loop: the model may query the chain up to 3 times per question
  let d = await call(), rounds = 0;
  while (d.stop_reason === 'tool_use' && rounds < 3) {
    rounds++;
    const uses = d.content.filter(c => c.type === 'tool_use');
    const results = [];
    for (const u2 of uses) {
      const out = await runTool(u2.name, u2.input || {});
      results.push({ type: 'tool_result', tool_use_id: u2.id, content: JSON.stringify(out).slice(0, 12000) });
    }
    body.messages.push({ role: 'assistant', content: d.content });
    body.messages.push({ role: 'user', content: results });
    d = await call();
  }
  const answer = (d.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n')
    || 'I could not complete the chain lookup — the public node may be busy. Try again, or paste the tx hash directly.';
  return { answer, spend_month_usd: Math.round(spend.usd * 1000) / 1000, chain_queries: rounds };
}

// ---- http surface -------------------------------------------------------------
function cors(req, res) {
  const o = req.headers.origin;
  res.setHeader('Access-Control-Allow-Origin', ORIGINS.includes(o) ? o : ORIGINS[0]);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
const server = http.createServer(async (req, res) => {
  cors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

  if (req.method === 'GET' && req.url === '/health') {
    return send(200, { ok: true, model: MODEL, month_spend_usd: Math.round(spend.usd * 1000) / 1000, budget_usd: BUDGET });
  }
  if (req.method === 'POST' && req.url === '/ask') {
    if (!API_KEY) return send(503, { error: 'Assistant not configured (no API key). Use the report form — a maintainer reads every report.' });
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const rl = rateOk(ip);
    if (!rl.ok) return send(429, { error: 'Rate limit reached: ' + RATE + ' questions per hour per visitor — it keeps the shared budget available for everyone. The FAQ and docs carry most answers; the report form always works.', rate_used: rl.used, rate_limit: RATE });
    if (!budgetOk()) return send(503, { error: 'The assistant hit its monthly budget cap — deliberately, so it can never surprise anyone with a bill. The report form and docs remain fully available.' });
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 10000) req.destroy(); });
    req.on('end', async () => {
      try {
        const parsed = JSON.parse(raw || '{}');
        // The chat UI gates on a scroll-through disclaimer; the API enforces it
        // too, so no alternate client can skip assent.
        if (parsed.accepted_disclaimer !== true) {
          return send(428, { error: 'disclaimer_required', message: 'Accept the disclaimer in the Help page chat before asking.' });
        }
        const q = (parsed.question || '').trim();
        if (!q) return send(400, { error: 'No question provided.' });
        const mode = (parsed.mode === 'report' || parsed.mode === 'request') ? parsed.mode : null;
        const out = await ask(q, parsed.wallet, parsed.page, mode);
        out.rate_used = rl.used; out.rate_limit = RATE;
        send(200, out);
      } catch (e) { send(500, { error: 'Assistant error: ' + e.message }); }
    });
    return;
  }
  send(404, { error: 'Not found. Endpoints: GET /health, POST /ask {question}.' });
});
server.listen(process.env.PORT || 8787, () => console.log('help-agent listening'));
