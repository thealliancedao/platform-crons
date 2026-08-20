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
const ORIGIN = process.env.ALLOWED_ORIGIN || 'https://thealliancedao.com';
const BUDGET = parseFloat(process.env.MONTHLY_BUDGET_USD || '10');
const RATE = parseInt(process.env.RATE_PER_HOUR || '10', 10);
const MODEL = 'claude-haiku-4-5-20251001';  // dated string from the owner's console model card (2026-08-20)
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
   only covers sender-side messages. If the node errors, say so; never fill gaps from memory.`;

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
async function walletExtract(question) {
  const m = question.match(/terra1[a-z0-9]{38,58}/);
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
const CHAIN_TOOLS = [
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
async function ask(question) {
  const corpus = await grounding();
  const walletBlock = await walletExtract(question);
  const body = {
    model: MODEL,
    max_tokens: 600,
    system: [
      { type: 'text', text: SYSTEM_RULES },
      // corpus as its own cached block: 90% cheaper on every repeat question
      { type: 'text', text: 'CORPUS:\n' + corpus, cache_control: { type: 'ephemeral' } },
    ],
    messages: [{ role: 'user', content: (walletBlock ? walletBlock + '\n\n' : '') + question.slice(0, 2000) }],
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
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
const server = http.createServer(async (req, res) => {
  cors(res);
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
        const out = await ask(q);
        out.rate_used = rl.used; out.rate_limit = RATE;
        send(200, out);
      } catch (e) { send(500, { error: 'Assistant error: ' + e.message }); }
    });
    return;
  }
  send(404, { error: 'Not found. Endpoints: GET /health, POST /ask {question}.' });
});
server.listen(process.env.PORT || 8787, () => console.log('help-agent listening'));
