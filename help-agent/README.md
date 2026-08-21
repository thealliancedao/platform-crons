# help-agent — the site's grounded Q&A service (v1)

Spec: `tla-core/docs/pending-changes/SPEC-site-help-agent.md`.
The Help page (help.html) works fully WITHOUT this service (v0: FAQ + GitHub
report/request forms). Deploying this adds the live assistant.

## Deploy on Render (new **Web Service**, this folder)
1. New → Web Service → repo `thealliancedao/platform-crons`, root `help-agent/`
2. Build command: *(none)* · Start command: `node server.js`
3. Environment:
   - `ANTHROPIC_API_KEY` — create at console.anthropic.com ($5 free credits on signup)
   - `ALLOWED_ORIGIN` = `https://thealliancedao.com`
   - `MONTHLY_BUDGET_USD` = `10` (hard stop — the service refuses past this)
   - `RATE_PER_HOUR` = `10`
4. Free instance type works (sleeps when idle; ~30-60s first-question wake).
   Starter ($7/mo) stays always-on.
5. Copy the service URL into `help.html` → `HELP_AGENT_URL` and commit.

## Cost (verified 2026-08-20)
claude-haiku-4-5: $1/MTok in, $5/MTok out; cache reads 0.1×. Grounding corpus
is sent as a cached system block → ~1–2¢ per uncached question, <1¢ cached.
The budget guard estimates spend from the API's returned usage and hard-stops
at MONTHLY_BUDGET_USD — worst case per month IS the cap.

## What it can do (v1.6.0)
- Grounded on the FULL project knowledge: ecosystem docs, pricing doctrine,
  repo catalog, every page changelog, the spec files, the build queue, the
  agent DATA-MAP (question → product → recipe), and live product heads
  (heartbeats, system-health, bribe runway).
- **read_product with surgical `key` extraction (v1.6)**: fetches any
  whitelisted tla-core data file; `key:"<pool>"` pulls one entry from big
  keyed matrices (apr-history, pool-status-history, token-catalog) so the
  middle of a file is reachable past truncation.
- **Comparative discipline (rule 11, v1.6)**: no rankings/superlatives unless
  the corpus states them or the arithmetic is shown from in-context numbers.
- **Historical data map (rule 12, v1.6)**: mapped products must be checked
  before any "no historical data" answer; wrong-object (sink ≠ pair) and
  APR-basis cautions built in.
- `MODEL` env var: default claude-haiku-4-5; set `MODEL=claude-sonnet-4-6`
  on Render to tier up (~3x cost/answer), no code change.
- **Wallet lookup**: a terra1… address in the question pulls that wallet's
  real record from the public positions/participants products — "my
  portfolio looks off" gets checked against the visitor's actual numbers.
- Feature-request routing: checks changelogs+specs first — "already exists
  (here's where)" / "already queued (here's the spec)" / "file a request".
- **Chain queries (v1.1)**: real tool use against the public Terra LCD —
  tx-by-hash and recent-txs-by-address (the visitor's own address only, per
  its rules). Results are compacted server-side (actions, transfers, memo)
  before reaching the model; max 3 chain calls per question, 8s timeouts.
  Env: `LCD_URL` (default terra-lcd.publicnode.com).

## Verification battery
`test-battery.js` runs 10 graded questions (data-map coverage, rule-11
ranking bait, wrong-object trap, out-of-map honesty, wallet lookup, the
xASTRO regression) against the LIVE service and grades answers against
ground truth dated in-file:

```
HELP_AGENT_URL=https://<service>.onrender.com node test-battery.js
```

Exit code 1 on any FAIL; REVIEW verdicts need a human read. A full run
spends the default 10/hour per-IP rate allowance. Moving-data truths
(wallet VP, TVL, runway) are dated 2026-08-20 — refresh before trusting a
numeric fail; structural checks don't go stale.

## Endpoints
- `GET /health` → `{ok, model, month_spend_usd, budget_usd}`
- `POST /ask {question, accepted_disclaimer, wallet?, page?, mode?}` →
  `{answer, spend_month_usd}`. `mode: "report"|"request"` (v1.7.0) switches on
  triage: the reply verifies/classifies first and ends with a `---DRAFT---`
  block the Help page turns into a prefilled GitHub issue (900-token cap in
  triage; the mode addendum rides AFTER the cached corpus so the prompt cache
  is shared with normal chat). (429 over rate,
  503 over budget or unconfigured — every error message routes the visitor
  to the always-working report form)
