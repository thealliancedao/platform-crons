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
  // v1.11.0 (2026-08-22): trust_register tier from catalog/trusted/current.json (how each address is known) + Capapult/Terra registries.
  // v1.10.0 (2026-08-22): privacy-preserving question log → tla-core/help-agent/questions/<yyyy-mm>.json (QUESTION_LOG=1 + GITHUB_TOKEN).
  // v1.9.3 (2026-08-22): period/per-period/runway as audit strings (model was recounting inclusively).
  // v1.9.2 (2026-08-22): generic deep walk (+ info/amount and cw20-call token pairing) — nested base64 anywhere, every address/amount resolved, explicit unresolved list the model must print.
  // v1.9.1 (2026-08-22): audit decodes base64 msgs, converts amounts via registries (never the model), recognises swap routers, resolves DEX pools + per-DAO registries.
  // v1.9.0 proposal audit (2026-08-21): registry-backed, evidence-tiered check of pasted proposal messages.
  // v1.8.0 foundations intake (2026-08-21): sourced chapters from the
  // primary-source mega-read — the bot answers from receipts, not vibes.
  ['skeletonswap',      `${CORE}/docs/ecosystem-knowledge/skeletonswap.md`],
  ['solid-protocol',    `${CORE}/docs/ecosystem-knowledge/solid-protocol.md`],
  ['votion',            `${CORE}/docs/ecosystem-knowledge/votion.md`],
  ['phoenix-directive', `${CORE}/docs/ecosystem-knowledge/phoenix-directive.md`],
  ['terra-tla',         `${CORE}/docs/ecosystem-knowledge/terra-liquidity-alliance.md`],
  ['depeg-and-fork',    `${CORE}/docs/ecosystem-knowledge/terra-depeg-and-fork.md`],
  ['audits-registry',   `${CORE}/docs/ecosystem-knowledge/AUDITS.md`],
  ['foundations-index', `${CORE}/docs/ecosystem-knowledge/FOUNDATIONS-SOURCES.md`],
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
   convention — absolute levels differ, trend shapes agree. Say so when comparing to Eris numbers.
13. READING DISCIPLINE (battery v1.8.1, 2026-08-21 — each of these was a graded miss):
   - "Latest period/epoch" in any history product = the MAX period over ALL entries, never
     the first or second entry you see. distributions/history.json runs period 96 → current.
   - Three forces move a pool's USD APR: capital (staked), allocation (vp), and LUNA PRICE —
     rewards are fixed in LUNA per epoch, so USD rewards fall when LUNA falls. Name all three;
     never say rewards are "fixed" in dollars.
   - Name the FIELD when you cite staked USD: apr-history "staked_usd_avg" is the epoch MEAN,
     pool-status "staked_usd" is the LAST capture in the epoch. They differ; do not mix them
     across a table or between answers without saying which.
   - Lock lifecycle: compare a lock's "end_period" to the CURRENT epoch. If end_period is in
     the past the lock has EXPIRED (dormant, still holding its fixed VP until withdrawn) —
     say "expired", never "expires". Count locks per asset from "asset_symbol"; state counts
     only if they match the IDs you list.
   - Arb radar cards read "best ~$X → ~$Y net": $X is the trade SIZE, $Y is the profit. A
     pool shown as "(unlisted)" with no dex is a MIGRATION CORPSE (e.g. the drained
     ampROAR-ROAR Astroport pair) — not a venue anyone can trade; say so, do not speculate
     "contract-owned or paused".
   - Repo doc paths: CHANGES_PENDING lives at docs/pending-changes/CHANGES_PENDING.md. Link
     only paths you have seen in the corpus.`;

// ---- triage modes (v1.7.0) ----------------------------------------------------
// The Help page's Report/Request forms now run THROUGH the assistant first:
// the form submits with mode:'report'|'request', the addendum below rides as a
// third system block AFTER the cached corpus (so triage never invalidates the
// prompt cache), and the reply ends with a ---DRAFT--- block the page extracts
// into a prefilled GitHub issue — the maintainer receives a PRE-INVESTIGATED
// report, and the visitor learns the constraint instead of shouting into a form.
const MODE_ADDENDA = {
  audit: `PROPOSAL AUDIT MODE. A <proposal_audit> block (deterministic, registry-backed) is attached.
Present it; do not re-derive or guess. Rules:
1. Per message, in order: the action, the contract it is sent to, and for every address
   its EVIDENCE TIER in these exact words — "chain-verified (structural: queried hourly by
   our capture engine)", "chain-verified (listed by the TLA gauge controller)", "chain-verified
   (token seen in live pools)", "chain-verified (DEX pool in the live Astroport snapshot)",
   "curated label (a human label we maintain — not chain proof)", "<DAO>'s own vetted registry (a
   human label that DAO maintains — not chain proof)", or "UNKNOWN to every registry (unverified —
   not necessarily bad)". Write addresses in full.
2. Say what the messages DO in plain words (e.g. "approves the bribe manager to pull 1.75B ROAR,
   then posts that ROAR as a 10-period linear bribe on LUNA-ROAR (project gauge) from E199").
3. Show the arithmetic EXACTLY as the audit states it: allowance vs amount, "periods_text",
   "per_period", "amount_human", and "runway_text" — copy these strings; never recount periods
   (the distribution end is exclusive) and never redo the division.
4. FLAGS verbatim, each on its own line. If none: "No flags raised by the registry checks."
5. What is NOT checked — always state it: this audit does not verify who posted the proposal,
   does not read the proposal's text, does not check the DAO's treasury balance or that the
   bribe token is the one the text claims beyond the registry name, and cannot see intent.
6. NEVER say "safe", "legit", "genuine", or "approved". Say what MATCHES the registries and what
   does not. Audits: the bribe manager, gauge controller and vAMP minter are covered by the Eris
   contracts-ve3 SCV audit (see the AUDITS chapter) — cite that only for those contracts.
7. INDEPENDENT VERIFICATION IS MANDATORY. For every address, print its "verify" links as
   markdown — at minimum the chain explorer link; for TLA ve3 contracts also the Eris source
   repo and the SCV audit, plus the "how_to_confirm" sentence. Say explicitly, once: "This
   site's registry is ours; it is not the source of truth — the chain is. Use the links to
   check every address without trusting us." Never imply our label alone makes an address good.
8. AMOUNTS AND TOKENS: quote amounts ONLY as the audit's "human" strings (e.g. "5,377 LUNA").
   Never convert raw micro-units yourself and never name a token the audit did not resolve —
   an unresolved denom is written as "unresolved denom ibc/…" . A swap is described from the
   audit's "swap" block: amount_in → denom_out, min_out, the pool(s) and their tier, and the
   destination with its tier. Misnaming a token or a magnitude is the worst error here.
9. UNRESOLVED IS A SECTION, NOT A GAP. The audit's "unresolved" block lists addresses, token
   denoms and actions no registry could classify. Print it under "## Unresolved" verbatim. For
   anything in it, say what the message literally contains and stop — do not infer the token,
   the counterparty, or the purpose. If "nested_decoded" shows inner messages, describe them
   from "decoded_msg", never from the base64. Anything not in the audit block is not known.
10. End with the one-line standard: "Not financial or voting advice — registry facts only.
   Verify on chain." Keep the whole answer structured and under ~30 lines.`,
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
  { name: 'audit_proposal',
    description: 'Registry-backed audit of a governance proposal\'s wasm/bank messages: resolves every address against the platform registries with an evidence tier (structural / gauge_set / token / curated / unknown), checks allowance=amount, gauge/bucket match, distribution math, current runway, and flags admin/upgrade actions. Use whenever a visitor pastes proposal messages or asks whether a proposal is genuine.',
    input_schema: { type: 'object', properties: { messages_json: { type: 'string', description: 'the raw JSON (array of messages) pasted by the visitor' } }, required: ['messages_json'] } },
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
// ---- PROPOSAL AUDIT (v1.9.0) ------------------------------------------------------
// Deterministic, registry-backed check of a governance proposal's wasm messages.
// Every address is resolved against the platform's registries and the result is
// TIERED by how it is known, so the answer can say exactly what is proven and
// what is not:
//   structural — in catalog.contracts: the capture engine QUERIES this contract
//                every hour and gets the expected responses (chain-verified live)
//   gauge_set  — the gauge controller itself lists this pool (chain-verified live)
//   token      — a denom the token-catalog cron sees in live pools (chain-verified)
//   curated    — owner-labelled in docs/curated (a human label, not chain proof)
//   unknown    — no registry knows it (NOT a verdict of bad — a verdict of unknown)
// The model never invents a tier; it reports these. Nothing here says "safe".
const AUDIT_SRC = {
  catalog: 'catalog/snapshots/current.json', known: 'docs/curated/known_contracts.json',
  wallets: 'docs/curated/wallets.json', snapshot: 'member-data/tla-snapshot/current.json',
  tokens: 'token-catalog/snapshots/current.json', runway: 'tla-voting/bribe-state/runway.json',
  astro: 'dex-data/astroport/snapshots/current.json', prices: 'network-and-prices/current.json',
  trusted: 'catalog/trusted/current.json',   // v1.11.0: ONE trust product (how each address is known)
};
const DAO_REGISTRIES = { 'AllianceDAO': 'adao', 'Lion DAO': 'lion-dao', 'Pixel Lions': 'pixel-lions', 'Capapult': 'capapult', 'Terra': 'terra' };
const DAO_REPO = 'https://raw.githubusercontent.com/thealliancedao/dao-originations/main';
let auditCache = { at: 0, reg: null }; let runwayCurrentPeriod = null;
async function auditRegistries() {
  if (auditCache.reg && Date.now() - auditCache.at < 10 * 60 * 1000) return auditCache.reg;
  const get = async (p) => { try { const r = await fetch(`${CORE}/${p}`, { headers: { 'User-Agent': 'tla-help-agent' } }); return r.ok ? await r.json() : null; } catch { return null; } };
  const [cat, known, wallets, snap, tokens, runway, astro, prices, trusted] = await Promise.all(Object.values(AUDIT_SRC).map(get));
  const daoRegs = await Promise.all(Object.entries(DAO_REGISTRIES).map(async ([name, folder]) => { try { const r = await fetch(`${DAO_REPO}/${folder}/governance/registry.json`); return r.ok ? [name, await r.json()] : null; } catch { return null; } }));
  const reg = { structural: {}, gauge: {}, token: {}, curated: {}, entities: {}, runway: {}, pool: {}, denom: {}, daoreg: {}, trusted: {}, loaded: { catalog: !!cat, known: !!known, wallets: !!wallets, snapshot: !!snap, tokens: !!tokens, runway: !!runway, astroport: !!astro, prices: !!prices, trusted: !!trusted, dao_registries: daoRegs.filter(Boolean).map(x => x[0]) } };
  // v1.11.0: the trust product — every known address with HOW it is known (verified[]).
  for (const r of (trusted && trusted.addresses) || []) if (r && r.address) reg.trusted[r.address] = { label: r.label, type: r.type, protocol: r.protocol, description: r.description, methods: r.methods || [], verified: r.verified || [], human_only: !!r.human_only };
  // DEX pools (Astroport snapshot) — pool address → pair
  for (const p of (astro && astro.pools) || []) if (p.pool_address) reg.pool[p.pool_address] = { name: p.pool_name, dex: p.dex || 'Astroport', type: p.pool_type || null, tla: !!p.tla_relevant, assets: (p.assets || []).map(a => a.symbol || a.denom) };
  // denom → symbol/decimals: token-catalog chain-registry identity, then network-and-prices astroport addresses; uluna fixed
  reg.denom['uluna'] = { symbol: 'LUNA', decimals: 6, source: 'native' };
  for (const t of (tokens && tokens.tokens) || []) { const cr = t.sources && t.sources.chain_registry; if (t.denom && cr && cr.symbol) reg.denom[t.denom] = { symbol: cr.symbol, decimals: cr.decimals != null ? cr.decimals : 6, source: 'token-catalog chain-registry' }; }
  for (const [sym, v] of Object.entries((prices && prices.token_prices) || {})) { const a = v && v.prices && v.prices.astroport && v.prices.astroport.address; if (a && !reg.denom[a]) reg.denom[a] = { symbol: sym, decimals: 6, source: 'network-and-prices registry' }; }
  for (const e of (known && known._meta && known._meta.skipped_token_entries) || []) if (e.address && !reg.denom[e.address]) reg.denom[e.address] = { symbol: String(e.name || '').replace(/\s*token.*$/i, ''), decimals: 6, source: 'known_contracts token list (decimals assumed 6)' };
  // per-DAO curated registries (dao-originations) — contracts each DAO has vetted
  for (const x of daoRegs) { if (!x) continue; const [name, r] = x; for (const [a, v] of Object.entries(r.contracts || {})) if (!reg.daoreg[a]) reg.daoreg[a] = { dao: name, name: v.name, type: v.type, protocol: v.protocol || null }; if (r.coreAddress && !reg.daoreg[r.coreAddress]) reg.daoreg[r.coreAddress] = { dao: name, name: name + ' core', type: 'dao' }; }
  for (const [k, v] of Object.entries((cat && cat.contracts) || {})) if (v && v.addr) reg.structural[v.addr] = { key: k, role: v.role || null };
  for (const p of (snap && snap.pools) || []) { const id = String(p.gauge_pool_id || ''); const addr = id.replace(/^(cw20|native):/, ''); if (addr) reg.gauge[addr] = { name: p.name, dex: p.dex, bucket: p.bucket, status: p.status, gauge_pool_id: id }; if (p.lp_address) reg.gauge[p.lp_address] = reg.gauge[p.lp_address] || { name: p.name, dex: p.dex, bucket: p.bucket, status: p.status, gauge_pool_id: id }; }
  for (const t of (tokens && tokens.tokens) || []) { const d = String(t.denom || ''); if (d) reg.token[d] = { symbol: t.symbol || null, kind: t.kind || null, pools: (t.found_in_pools || []).length }; }
  for (const [a, v] of Object.entries((known && known.contracts) || {})) reg.curated[a] = { name: v.name, type: v.type, protocol: v.protocol, audited_note: v.description || null };
  for (const e of (known && known._meta && known._meta.skipped_token_entries) || []) if (e.address) reg.curated[e.address] = reg.curated[e.address] || { name: e.name, type: e.type, protocol: null };
  for (const [a, v] of Object.entries((wallets && wallets.wallets) || {})) reg.entities[a] = { label: v.label, subtype: v.subtype, protocol: v.protocol, flags: v.flags || [] };
  for (const [a, v] of Object.entries((cat && cat.entities) || {})) reg.entities[a] = reg.entities[a] || { label: v.label, subtype: v.subtype, protocol: v.protocol, flags: v.flags || [] };
  runwayCurrentPeriod = runway && runway.current_period != null ? Number(runway.current_period) : null;
  for (const r of (runway && runway.pools) || []) { const addr = String(r.pool || '').replace(/^(cw20|native):/, ''); reg.runway[addr] = { epochs_left: r.epochs_left, funders: (r.funders || []).map(f => f.label || f.briber), denoms: Object.keys(r.by_denom || {}) }; }
  auditCache = { at: Date.now(), reg }; return reg;
}
// INDEPENDENT verification — places that are not this site's registry. The
// registry tells you what WE think an address is; these let the visitor check
// without trusting us. Chain explorer for every address; for the TLA ve3
// contracts the Eris source repo + the SCV audit; Eris docs/UI where they list
// the contract; Astroport for pools.
const VE3_REPO = 'https://github.com/erisprotocol/contracts-ve3';
const VE3_AUDIT = 'https://github.com/SCV-Security/PublicReports/blob/main/Eris%20Protocol/ERIS%20-%20Contracts%20ve3%20-%20Audit%20Report%20v1.0.pdf';
const ERIS_DOCS = 'https://docs.erisprotocol.com/products/amp-governance/';
const STRUCTURAL_PROVENANCE = {
  gauge_controller: { built_by: 'Eris Protocol', source: VE3_REPO, audit: VE3_AUDIT, docs: ERIS_DOCS, how_to_confirm: 'Eris\'s own TLA UI (erisprotocol.com → Amp Governance) transacts with this address; query /cosmwasm/wasm/v1/contract/<addr> on any Terra LCD and compare the code_id\'s checksum with the contracts-ve3 build' },
  voting_escrow:    { built_by: 'Eris Protocol', source: VE3_REPO, audit: VE3_AUDIT, docs: ERIS_DOCS, how_to_confirm: 'the vAMP lock NFTs in your wallet are minted by this contract — check any lock NFT\'s contract on the explorer' },
  bribe_manager:    { built_by: 'Eris Protocol', source: VE3_REPO, audit: VE3_AUDIT, docs: ERIS_DOCS, how_to_confirm: 'every existing TLA bribe (tla-voting/bribes history on this site, and the explorer\'s tx list for this address) was posted to this contract; Eris\'s Amp Governance UI claims bribes from it' },
  compounder:       { built_by: 'Eris Protocol', source: 'https://github.com/erisprotocol/contracts-tokenfactory', audit: 'https://github.com/SCV-Security/PublicReports/blob/main/Eris%20Protocol/Eris%20Protocol%20-%20amp-compounder%20-%20Audit%20Report%20v1.0.pdf', docs: 'https://docs.erisprotocol.com/', how_to_confirm: 'ampLP tokens are minted by this contract' },
  dao_main_wallet:  { built_by: 'AllianceDAO (DAODAO)', source: 'https://daodao.zone/dao/terra1sffd4efk2jpdt894r04qwmtjqrrjfc52tmj6vkzjxqhd8qqu2drs3m5vzm', audit: null, docs: null, how_to_confirm: 'DAODAO shows this as the AllianceDAO treasury' },
};
function verifyLinks(a, tiers) {
  const links = [{ label: 'Chain explorer (address, code, tx history)', url: 'https://chainsco.pe/terra2/address/' + a }, { label: 'Address catalog — how this site knows it', url: 'https://thealliancedao.com/address-catalog.html?q=' + a }];
  for (const t of tiers) {
    if (t.tier === 'structural' && STRUCTURAL_PROVENANCE[t.key]) { const p = STRUCTURAL_PROVENANCE[t.key]; links.push({ label: 'Source code — ' + p.built_by, url: p.source }); if (p.audit) links.push({ label: 'Independent audit (SCV Security)', url: p.audit }); if (p.docs) links.push({ label: 'Protocol docs', url: p.docs }); t.how_to_confirm = p.how_to_confirm; t.built_by = p.built_by; }
    if (t.tier === 'gauge_set' && t.dex === 'Astroport') links.push({ label: 'Astroport pool', url: 'https://app.astroport.fi/pools' });
    if (t.tier === 'gauge_set') links.push({ label: 'Eris Amp Governance (gauge list)', url: 'https://www.erisprotocol.com/terra/amp-governance' });
  }
  return links;
}
function resolveAddr(reg, a) {
  const out = { address: a, tiers: [] };
  if (reg.structural[a]) out.tiers.push({ tier: 'structural', ...reg.structural[a], evidence: 'catalog.contracts — queried hourly by the capture engine; responses match the expected contract schema' });
  if (reg.gauge[a]) out.tiers.push({ tier: 'gauge_set', ...reg.gauge[a], evidence: 'listed by the TLA gauge controller in the live tla-snapshot' });
  if (reg.token[a]) out.tiers.push({ tier: 'token', ...reg.token[a], evidence: 'denom seen in live DEX pools by the token-catalog cron' });
  if (reg.entities[a]) out.tiers.push({ tier: 'curated', ...reg.entities[a], evidence: 'owner-curated label (docs/curated/wallets.json) — a human label, not chain proof' });
  if (reg.curated[a]) out.tiers.push({ tier: 'curated', ...reg.curated[a], evidence: 'owner-curated label (docs/curated/known_contracts.json) — a human label, not chain proof' });
  if (reg.pool[a]) out.tiers.push({ tier: 'dex_pool', ...reg.pool[a], evidence: 'pool listed in the live Astroport snapshot captured by the dex-data cron (chain-verified)' });
  if (reg.daoreg[a]) out.tiers.push({ tier: 'dao_registry', ...reg.daoreg[a], evidence: 'in ' + reg.daoreg[a].dao + '\'s own vetted contract registry (dao-originations) — a human label maintained per DAO, not chain proof' });
  // v1.11.0: trust product tier — lists each verification (method · ref · by · on · url). Evidence, not a verdict.
  if (reg.trusted[a]) { const t = reg.trusted[a]; out.tiers.push({ tier: 'trust_register', label: t.label, type: t.type, protocol: t.protocol, methods: t.methods, human_only: t.human_only, verified: t.verified.map(v => ({ method: v.method, ref: v.ref, by: v.by, on: v.on, url: v.url || null })), evidence: t.human_only ? 'known ONLY by human labels (' + t.methods.join(', ') + ') — no chain-level evidence' : 'known by ' + t.methods.join(', ') + ' — see verified[] for each check and its link' }); }
  if (!out.tiers.length) out.tiers.push({ tier: 'unknown', evidence: 'no platform registry knows this address — unverified, not necessarily bad' });
  out.verify = verifyLinks(a, out.tiers);
  return out;
}
const GAUGES = ['stable', 'project', 'bluechip', 'single'];
function decodeMsg(m) {
  // wasm.execute.msg may be an object or a base64 JSON string (DAODAO exports both)
  if (m && typeof m === 'object') return { msg: m, encoded: false };
  if (typeof m === 'string') { try { return { msg: JSON.parse(Buffer.from(m, 'base64').toString('utf8')), encoded: true }; } catch {} try { return { msg: JSON.parse(m), encoded: false }; } catch {} }
  return { msg: {}, encoded: false, undecodable: true };
}
// GENERIC WALK (v1.9.2): the audit must not depend on recognising a message shape.
// Walk the decoded message recursively; at every node: a base64 string that decodes
// to JSON (cw20 `send` hooks, router sub-msgs, DAODAO wrappers) is decoded and
// walked; every terra1… address is resolved; every {denom, amount} pair is
// denominated; every amount-like field whose token cannot be determined is listed
// as unresolved. Whatever is left unresolved is reported AS unresolved — the model
// presents that list verbatim instead of filling the blanks.
function walkMsg(reg, node, path, acc, depth) {
  if (depth > 12 || node == null) return;
  if (typeof node === 'string') {
    if (/^terra1[02-9ac-hj-np-z]{38,58}$/.test(node)) { acc.addresses.add(node); return; }
    if (node.length > 16 && /^[A-Za-z0-9+/=]+$/.test(node)) { try { const j = JSON.parse(Buffer.from(node, 'base64').toString('utf8')); if (j && typeof j === 'object') { acc.decoded.push({ path, keys: Object.keys(j).slice(0, 6) }); walkMsg(reg, j, path + '(b64)', acc, depth + 1); return; } } catch {} }
    if (/^\d{7,}$/.test(node)) acc.big_numbers.push({ path, value: node, note: 'large integer with no denom context — not converted' });
    return;
  }
  if (Array.isArray(node)) { node.forEach((x, i) => walkMsg(reg, x, path + '[' + i + ']', acc, depth + 1)); return; }
  if (typeof node === 'object') {
    if (typeof node.denom === 'string' && node.amount != null) { const h = human(reg, node.denom, node.amount); acc.amounts.push({ path, ...h }); if (!h.symbol) acc.unresolved_denoms.add(node.denom); }
    // token-at-a-different-depth shapes: Astroport {info:{native_token:{denom}}|{token:{contract_addr}}, amount},
    // cw20 {info:{cw20:addr}}, Skip {native:{denom,amount}} (caught above), and any {asset_info|info|token, amount}
    if (node.amount != null && typeof node.denom !== 'string' && !node.cw20) {
      const info = node.info || node.asset_info || node.token_info || null;
      const tokenId = info && (((info.native_token || {}).denom) || ((info.token || {}).contract_addr) || info.cw20 || info.native || (typeof info === 'string' ? info : null));
      if (tokenId) { const h = human(reg, tokenId, node.amount); acc.amounts.push({ path, ...h, shape: 'info+amount' }); if (!h.symbol) acc.unresolved_denoms.add(tokenId); }
      else if (acc.tokenContext) { const h = human(reg, acc.tokenContext, node.amount); acc.amounts.push({ path, ...h, shape: 'cw20 call on token contract' }); if (!h.symbol) acc.unresolved_denoms.add(acc.tokenContext); }
      else if (/^\d{7,}$/.test(String(node.amount))) acc.big_numbers.push({ path: path + '.amount', value: String(node.amount), note: 'amount with no token context — not converted' });
    }
    if (node.cw20 && typeof node.cw20 === 'string' && node.amount != null) { const d = reg.denom[node.cw20]; acc.amounts.push({ path, raw: String(node.amount), denom: node.cw20, symbol: d ? d.symbol : null, human: d ? (Number(node.amount) / Math.pow(10, d.decimals)).toLocaleString('en-US', { maximumFractionDigits: 6 }) + ' ' + d.symbol : null, note: d ? undefined : 'cw20 not in any registry — amount left raw' }); if (!d) acc.unresolved_denoms.add(node.cw20); }
    for (const [k, v] of Object.entries(node)) { if (k === 'denom' || k === 'amount') continue; walkMsg(reg, v, path ? path + '.' + k : k, acc, depth + 1); }
  }
}
function human(reg, denom, raw) {
  const d = reg.denom[denom]; const n = Number(raw);
  if (!d) return { raw: String(raw), denom, symbol: null, human: null, note: 'denom not in any registry — amount left raw, NOT converted' };
  const v = n / Math.pow(10, d.decimals);
  return { raw: String(raw), denom, symbol: d.symbol, decimals: d.decimals, human: v.toLocaleString('en-US', { maximumFractionDigits: 6 }) + ' ' + d.symbol, source: d.source };
}
const RISKY_KEYS = ['migrate', 'update_admin', 'clear_admin', 'set_owner', 'transfer_ownership', 'update_config', 'propose_new_owner', 'instantiate', 'burn', 'mint'];
function extractMessages(text) {
  // find the first JSON array/object in the pasted text that looks like cosmos msgs
  const m = text.match(/(\[[\s\S]*\]|\{[\s\S]*\})/); if (!m) return null;
  for (const cand of [m[1], m[1].replace(/,\s*([\]}])/g, '$1')]) { try { const j = JSON.parse(cand); return Array.isArray(j) ? j : [j]; } catch {} }
  return null;
}
async function auditProposal(msgs) {
  const reg = await auditRegistries();
  const findings = [], addresses = {}, flags = [];
  const seen = (a) => { if (!addresses[a]) addresses[a] = resolveAddr(reg, a); return addresses[a]; };
  const allowances = [];
  msgs.forEach((raw, i) => {
    const ex = raw && raw.wasm && raw.wasm.execute; const bank = raw && raw.bank; const stake = raw && (raw.staking || raw.distribution || raw.gov);
    const f = { index: i + 1, kind: ex ? 'wasm.execute' : bank ? 'bank' : Object.keys(raw || {}).join(',') || 'unknown', notes: [] };
    if (ex) {
      f.contract = seen(ex.contract_addr); const dec = decodeMsg(ex.msg); const msg = dec.msg || {}; const action = Object.keys(msg)[0] || '?'; f.action = action; f.msg_was_base64 = !!dec.encoded; if (dec.undecodable) flags.push(`msg ${i + 1}: execute msg could not be decoded`);
      f.funds = (ex.funds || []).map(x => human(reg, x.denom, x.amount));
      const body = msg[action] || {};
      f.decoded_msg = JSON.stringify(msg).slice(0, 2000);
      const acc = { addresses: new Set(), amounts: [], decoded: [], big_numbers: [], unresolved_denoms: new Set(), tokenContext: reg.denom[ex.contract_addr] ? ex.contract_addr : null };
      walkMsg(reg, msg, action, acc, 0);
      acc.addresses.forEach(a => seen(a));
      f.nested_decoded = acc.decoded; f.amounts_found = acc.amounts; f.unresolved = { denoms: [...acc.unresolved_denoms], raw_numbers_without_token: acc.big_numbers, addresses: [...acc.addresses].filter(a => resolveAddr(reg, a).tiers[0].tier === 'unknown') };
      if (acc.unresolved_denoms.size) flags.push(`msg ${i + 1}: ${acc.unresolved_denoms.size} token denom(s) unknown to every registry — amounts left raw`);
      // swap routers (Skip Go / Astroport router): swap_and_action / execute_swap_operations
      const sa = action === 'swap_and_action' ? body : null;
      if (sa) {
        const ops = (((sa.user_swap || {}).swap_exact_asset_in || {}).operations) || [];
        const first = ops[0] || {}, last = ops[ops.length - 1] || {};
        const min = sa.min_asset && sa.min_asset.native ? human(reg, sa.min_asset.native.denom, sa.min_asset.native.amount) : null;
        const dest = sa.post_swap_action && sa.post_swap_action.transfer && sa.post_swap_action.transfer.to_address;
        f.swap = { venue: ((sa.user_swap || {}).swap_exact_asset_in || {}).swap_venue_name || null, denom_in: reg.denom[first.denom_in] ? reg.denom[first.denom_in].symbol : first.denom_in || null, denom_out: reg.denom[last.denom_out] ? reg.denom[last.denom_out].symbol : last.denom_out || null,
          amount_in: f.funds[0] || null, min_out: min, pools: ops.map(o => { const r = seen(o.pool); return { address: o.pool, known_as: r.tiers[0].name || null, tier: r.tiers[0].tier }; }), destination: dest ? seen(dest) : null, destination_is_sender: false };
        if (dest && !reg.entities[dest] && !reg.daoreg[dest] && !reg.structural[dest]) flags.push(`msg ${i + 1}: swap proceeds are sent to an address no registry knows (${dest})`);
        if (!min) flags.push(`msg ${i + 1}: swap has no minimum-output guard`);
      }
      JSON.stringify(body).replace(/terra1[02-9ac-hj-np-z]{38,58}/g, (a) => { seen(a); return a; });
      if (action === 'increase_allowance') { allowances.push({ token: ex.contract_addr, spender: body.spender, amount: body.amount }); f.spender = seen(body.spender); f.amount = body.amount; }
      if (action === 'add_bribe') {
        const b = body.bribe || {}, info = b.info || {}, tok = info.cw20 || info.native, fi = body.for_info || {}, pool = fi.cw20 || fi.native, dist = (body.distribution && body.distribution.func) || {};
        f.bribe = { token: tok ? seen(tok) : null, amount: b.amount, gauge: body.gauge, pool: pool ? seen(pool) : null, distribution: dist };
        if (!GAUGES.includes(body.gauge)) flags.push(`msg ${i + 1}: gauge "${body.gauge}" is not one of ${GAUGES.join('/')}`);
        const g = pool && reg.gauge[pool]; if (g && g.bucket && body.gauge && g.bucket !== body.gauge) flags.push(`msg ${i + 1}: pool ${g.name} is in the ${g.bucket} bucket but the bribe targets gauge "${body.gauge}"`);
        if (!g) flags.push(`msg ${i + 1}: for_info pool is NOT in the live gauge set — the bribe would target a pool the controller does not list`);
        const al = allowances.find(x => x.token === tok && x.spender === ex.contract_addr);
        if (info.cw20) { if (!al) flags.push(`msg ${i + 1}: cw20 bribe with no matching increase_allowance to this contract`); else if (al.amount !== b.amount) flags.push(`msg ${i + 1}: allowance ${al.amount} ≠ bribe amount ${b.amount} (leftover approval)`); else f.notes.push('allowance equals bribe amount — nothing left approved'); }
        if (dist.start != null && dist.end != null) {
          const n = Number(dist.end) - Number(dist.start);   // end is exclusive: E199→E209 = 10 periods (E199..E208)
          f.bribe.periods = n; f.bribe.periods_text = `${n} periods (E${dist.start} through E${Number(dist.end) - 1}; end ${dist.end} is exclusive)`;
          if (b.amount && n > 0) { const pp = human(reg, tok, String(Math.round(Number(b.amount) / n))); f.bribe.per_period = pp.human || (pp.raw + ' raw'); f.bribe.amount_human = (human(reg, tok, b.amount).human || b.amount + ' raw'); }
          f.notes.push(`${dist.func_type || 'linear'} distribution: ${f.bribe.periods_text}`);
        }
        const rw = pool && reg.runway[pool]; if (rw) { f.bribe.current_runway = rw; const cur = runwayCurrentPeriod; if (cur != null) f.bribe.runway_text = `today's pot is funded for ${rw.epochs_left} more period(s) after the current one (E${cur}) — i.e. through E${cur + rw.epochs_left}; this bribe runs E${dist.start}–E${Number(dist.end) - 1}`; }
        if (!(reg.structural[ex.contract_addr] && reg.structural[ex.contract_addr].key === 'bribe_manager')) flags.push(`msg ${i + 1}: add_bribe is sent to an address that is NOT the registered TLA bribe manager`);
      }
      if (RISKY_KEYS.includes(action)) flags.push(`msg ${i + 1}: "${action}" is an administrative/upgrade action — treat as high-scrutiny`);
      if ((ex.funds || []).some(x => x.denom === 'uluna' && Number(x.amount) > 1e9)) flags.push(`msg ${i + 1}: attaches ${human(reg, 'uluna', (ex.funds || []).find(x => x.denom === 'uluna').amount).human} in funds (over 1,000 LUNA)`);
    } else if (bank) { const send = bank.send || {}; f.to = send.to_address ? seen(send.to_address) : null; f.amount = send.amount; if (f.to && f.to.tiers[0].tier === 'unknown') flags.push(`msg ${i + 1}: bank send to an address no registry knows`); }
    else if (stake) { f.notes.push('staking/distribution/gov module message — outside TLA gauge mechanics'); }
    findings.push(f);
  });
  const tiers = Object.values(addresses).map(a => a.tiers[0].tier);
  const unresolved = { addresses: Object.values(addresses).filter(a => a.tiers[0].tier === 'unknown').map(a => a.address), denoms: [...new Set(findings.flatMap(f => (f.unresolved && f.unresolved.denoms) || []))], actions: findings.filter(f => f.kind === 'wasm.execute' && !/^(increase_allowance|add_bribe|swap_and_action|transfer|send|execute|propose|vote|claim|stake|unstake|withdraw|deposit|update_config|migrate|update_admin|mint|burn)$/.test(f.action)).map(f => `msg ${f.index}: ${f.action}`) };
  return {
    summary: { messages: msgs.length, addresses: Object.keys(addresses).length, unknown_addresses: tiers.filter(t => t === 'unknown').length, flags: flags.length },
    registries_loaded: reg.loaded, findings, addresses, flags, unresolved,
    how_to_read: 'Tiers are evidence, not verdicts. structural/gauge_set/token = chain-verified by live captures; trust_register = the platform trust product listing HOW the address is known (methods chain/github/scv_audit/oak_audit are checkable without trusting this site; owner/project_team/dao_registry/docs are human labels; past_prop is precedent) — print its verified[] entries with their links; curated = a human label; unknown = unverified. No finding here asserts a proposal is "safe". This site\'s registry is NOT the source of truth — the chain is; every address carries independent `verify` links (explorer, source repo, audit) so the reader can check without trusting this site.',
  };
}
async function runTool(name, input) {
  if (name === 'audit_proposal') {
    const msgs = Array.isArray(input.messages) ? input.messages : extractMessages(String(input.messages_json || ''));
    if (!msgs) return { error: 'could not parse proposal messages — paste the raw JSON array of messages' };
    return auditProposal(msgs);
  }
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

// ---- QUESTION LOG (v1.10.0) ----------------------------------------------------
// What do people ask? Append a privacy-preserving record per question to
// tla-core/help-agent/questions/<yyyy-mm>.json (GitHub Contents API, batched).
// Stored: time, page, mode, the question with every terra1… address and tx
// hash REDACTED, whether a wallet was pinned (true/false — never the address),
// answer length, audit flag, cost. Never: IP, wallet, the answer text.
// Off unless QUESTION_LOG=1 and GITHUB_TOKEN are set on the service.
const QLOG_ON = process.env.QUESTION_LOG === '1' && !!process.env.GITHUB_TOKEN;
const QLOG_REPO = process.env.GITHUB_REPO || 'thealliancedao/tla-core';
const QLOG_FLUSH_MS = 10 * 60 * 1000, QLOG_MAX = 25;
let qlog = [], qlogTimer = null;
function redact(q) { return String(q).replace(/terra1[02-9ac-hj-np-z]{38,58}/g, '[address]').replace(/\b[0-9A-Fa-f]{64}\b/g, '[txhash]').slice(0, 600); }
function logQuestion(rec) { if (!QLOG_ON) return; qlog.push(rec); if (qlog.length >= QLOG_MAX) flushQlog(); else if (!qlogTimer) qlogTimer = setTimeout(flushQlog, QLOG_FLUSH_MS); }
async function flushQlog() {
  if (qlogTimer) { clearTimeout(qlogTimer); qlogTimer = null; }
  const batch = qlog.splice(0); if (!batch.length) return;
  const ym = new Date().toISOString().slice(0, 7), path = `help-agent/questions/${ym}.json`;
  const api = `https://api.github.com/repos/${QLOG_REPO}/contents/${path}`;
  const hdrs = { Authorization: 'Bearer ' + process.env.GITHUB_TOKEN, 'User-Agent': 'tla-help-agent', Accept: 'application/vnd.github+json' };
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      let sha = null, doc = { schemaVersion: 1, product: 'help-agent questions', month: ym, note: 'privacy-preserving: addresses/tx hashes redacted, no IP, no wallet, no answer text', questions: [] };
      const g = await fetch(api, { headers: hdrs });
      if (g.ok) { const j = await g.json(); sha = j.sha; try { doc = JSON.parse(Buffer.from(j.content, 'base64').toString('utf8')); } catch {} }
      doc.questions = (doc.questions || []).concat(batch); doc.count = doc.questions.length; doc.updatedAt = new Date().toISOString();
      const body = { message: `help-agent questions ${ym} (+${batch.length})`, content: Buffer.from(JSON.stringify(doc, null, 2)).toString('base64') }; if (sha) body.sha = sha;
      const put = await fetch(api, { method: 'PUT', headers: { ...hdrs, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (put.ok) return; if (put.status !== 409 && put.status !== 422) { console.log('qlog put failed', put.status); return; }
    } catch (e) { console.log('qlog error', e.message.slice(0, 80)); }
    await new Promise(r => setTimeout(r, 400 * attempt + Math.random() * 400));
  }
  qlog = batch.concat(qlog);   // keep for the next flush
}

// ---- the ask flow -------------------------------------------------------------
async function ask(question, explicitWallet, page, mode) {
  const corpus = await grounding();
  const walletBlock = await walletExtract(question, explicitWallet);
  const pageBlock = page ? `<visitor_context>The visitor is currently viewing: ${String(page).replace(/[^\w\-\/#.?=]/g,'').slice(0,100)} — tailor the answer to what that page shows.</visitor_context>\n` : '';
  let addendum = MODE_ADDENDA[mode] || null;
  // v1.9.0: pasted proposal messages → deterministic audit first, then the model explains it
  let auditBlock = '';
  if (/"contract_addr"|"wasm"\s*:|"bank"\s*:\s*\{/.test(question)) {
    const msgs = extractMessages(question);
    if (msgs) { try { const a = await auditProposal(msgs); auditBlock = '\n\n<proposal_audit>' + JSON.stringify(a).slice(0, 14000) + '</proposal_audit>'; addendum = (addendum ? addendum + '\n\n' : '') + MODE_ADDENDA.audit; } catch (e) { auditBlock = '\n\n<proposal_audit>{"error":"audit failed: ' + String(e.message).slice(0, 80) + '"}</proposal_audit>'; } }
  }
  const body = {
    model: MODEL,
    max_tokens: auditBlock ? 1100 : addendum ? 900 : 600,   // triage answers carry a draft block; audits carry a per-message table
    system: [
      { type: 'text', text: SYSTEM_RULES },
      // corpus as its own cached block: 90% cheaper on every repeat question.
      // v1.7.0: the mode addendum goes AFTER this block, so triage questions
      // share the same cached prefix as normal chat instead of invalidating it.
      { type: 'text', text: 'CORPUS:\n' + corpus, cache_control: { type: 'ephemeral' } },
      ...(addendum ? [{ type: 'text', text: addendum }] : []),
    ],
    messages: [{ role: 'user', content: pageBlock + (walletBlock ? walletBlock + '\n\n' : '') + question.slice(0, auditBlock ? 9000 : 2000) + auditBlock }],
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
    req.on('data', c => { raw += c; if (raw.length > 20000) req.destroy(); });   // v1.10.0: proposal pastes are long
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
        const t0 = Date.now();
        const out = await ask(q, parsed.wallet, parsed.page, mode);
        out.rate_used = rl.used; out.rate_limit = RATE;
        send(200, out);
        logQuestion({ at: new Date().toISOString(), page: String(parsed.page || '').slice(0, 80) || null, mode: mode || (/"contract_addr"|"wasm"\s*:/.test(q) ? 'audit' : 'chat'),
          question: redact(q), wallet_pinned: !!parsed.wallet, answer_chars: (out.answer || '').length, chain_queries: out.chain_queries || 0, ms: Date.now() - t0 });
      } catch (e) { send(500, { error: 'Assistant error: ' + e.message }); }
    });
    return;
  }
  send(404, { error: 'Not found. Endpoints: GET /health, POST /ask {question}.' });
});
server.listen(process.env.PORT || 8787, () => console.log('help-agent listening'));
