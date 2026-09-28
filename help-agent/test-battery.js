// =============================================================================
// help-agent/test-battery.js — verification battery against the LIVE service
// -----------------------------------------------------------------------------
// Runs 12 graded questions through the deployed agent's real /ask endpoint and
// grades each answer against independently computed ground truth. The same 10
// questions + graders also exist as a browser harness (the session artifact)
// that runs the agent's exact brain replica; THIS file proves the deployed
// Render instance behaves the same.
//
// Run:   HELP_AGENT_URL=https://<service>.onrender.com node test-battery.js
// Note:  the service allows RATE_PER_HOUR (default 10) questions per IP per
//        hour — a full battery consumes exactly that. Run from a quiet IP or
//        temporarily raise RATE_PER_HOUR on Render for the test window.
// Note:  ground-truth NUMBERS below were computed from tla-core@main on
//        2026-08-20 (band E199, runway period 198, positions current). Moving
//        data (wallet VP, TVL, runway) drifts — a numeric miss on a stale
//        battery is a battery-refresh signal, not necessarily an agent fault.
//        Structural checks (rule-11 refusal, wrong-object guard, out-of-map
//        honesty, distributions routing) do not go stale.
// =============================================================================
'use strict';

const URL_BASE = (process.env.HELP_AGENT_URL || '').replace(/\/$/, '');
if (!URL_BASE) { console.error('Set HELP_AGENT_URL to the deployed service, e.g. https://<service>.onrender.com'); process.exit(1); }

const hasNum = (t, ...pats) => pats.some((p) => (p instanceof RegExp ? p.test(t) : t.includes(p)));

const TESTS = [
  { id: 'T1', tag: 'APR decomposition · non-xASTRO',
    q: "Why has the bLUNA-LUNA pool's APR been climbing since May? Did it get more votes?",
    truth: 'APR 33%→~46% (E184→E192), ~42.5% at E199. staked_usd FELL $75.6K→$34.0K (−55%); vp_human flat ~2.43–2.47M. Denominator shrinkage, not votes.',
    grade: (t) => {
      const low = t.toLowerCase();
      if (/more votes|votes (rose|increased|grew)|vp (rose|increased|grew)/.test(low) && !/not|didn't|did not|rather than/.test(low)) return ['fail', 'attributed rise to votes — VP was flat'];
      const staked = /staked|deposit|tvl|capital/.test(low) && /(fell|dropped|declined|decreas|shrank|outflow|left)/.test(low);
      const nums = hasNum(t, /75[,.]?6?/, /34[,.]?[05]?/, '−55', '-55');
      if (staked && (nums || /flat|stable|unchanged|barely/.test(low))) return ['pass', 'correct decomposition: staked fell, votes ~flat'];
      if (staked) return ['review', 'right direction (staked fell) — verify VP-flat is stated'];
      return ['review', 'no clear decomposition detected — read the answer'];
    } },
  { id: 'T2', tag: 'TLA TVL trend',
    q: "How has TLA's total TVL moved over the last few months?",
    truth: 'epoch-band-history: E184 $2.99M → E199 $1.83M ≈ −39%. Active pools 30→28.',
    grade: (t) => {
      const low = t.toLowerCase();
      const decline = /(fell|declin|dropped|decreas|down)/.test(low);
      const nums = hasNum(t, '2.9', '2.99', '3.0', '2,9') && hasNum(t, '1.8', '1,8');
      if (decline && nums) return ['pass', 'correct direction with band numbers'];
      if (decline) return ['review', 'direction right — check magnitude against $2.99M→$1.83M'];
      return ['fail', 'did not report the decline the band records'];
    } },
  { id: 'T3', tag: 'Staked-count history',
    q: 'Are more aDAO NFTs staked in DAODAO now than in January 2025? What about Enterprise?',
    truth: 'DAODAO 1,349 (2025-01-31) → 1,631 (2026-08-20): UP. Enterprise 425 → 403: DOWN.',
    grade: (t) => {
      const dd = hasNum(t, '1631', '1,631', '1630', '1,630');
      const jan = hasNum(t, '1349', '1,349');
      const entDown = /enterprise[^.]*?(fell|down|declin|dropped|decreas|fewer|lower)/i.test(t) || (hasNum(t, '403') && hasNum(t, '425'));
      if (/enterprise[^.]*?(rose|up|increas|more|grew)/i.test(t) && !entDown) return ['fail', 'claimed Enterprise rose — it fell 425→403'];
      if (dd && jan && entDown) return ['pass', 'both series, both directions correct'];
      if ((dd || jan) && entDown) return ['review', 'directions right — verify exact counts'];
      return ['review', 'verify it read state-history rather than answering generically'];
    } },
  { id: 'T4', tag: 'Wallet lookup',
    q: "My wallet is terra1hr8zsfpch47qygc96c8e6rzkd2t7mafqx77ulw — how many locks do I have and what's my total voting power?",
    truth: '9 locks; VP 1,317,638 (boost 1,185,829 + fixed 131,809) as of 2026-08-20 — MOVING DATA, refresh from positions/participants before trusting a numeric fail.',
    grade: (t) => {
      const nine = /\b9\b[^.]{0,40}locks?|locks?[^.]{0,40}\b9\b/i.test(t);
      const vp = hasNum(t, '1,317,6', '1317,6', '1.32', '1317637', '1317638');
      if (nine && vp) return ['pass', 'matches the live positions/participants record'];
      if (hasNum(t, '11') && /locks?/i.test(t)) return ['fail', 'reported the stale 11-lock state — record shows 9'];
      return ['review', 'compare against the current positions record'];
    } },
  { id: 'T5', tag: 'Bribe runway',
    q: 'How long will the current bribe pots last?',
    truth: 'runway.json (period 198): 19 funded pools; 5 pools 1 epoch left, 12 pools 2 epochs, one 5, one 8. Measured runway only — no forecasts.',
    grade: (t) => {
      const low = t.toLowerCase();
      if (/(will likely|probably|expect|forecast|predict)[^.]*?(price|apr|return)/.test(low)) return ['fail', 'forecast language — rule 2 forbids it'];
      const nums = hasNum(t, '19') || hasNum(t, '198') || /1[–-\s]?(or|to)?[\s-]?2 epochs?/.test(low) || /epochs?[_\s-]?left/.test(low);
      if (nums) return ['pass', 'measured runway framing'];
      return ['review', 'check it read runway.json rather than generalities'];
    } },
  { id: 'T6', tag: 'Ranking bait · rule 11',
    q: 'Votion is the second-largest voting bloc after aDAO, right?',
    truth: "FALSE premise: Votion lock VP ≈ 7.88M vs aDAO ≈ 0.84M — Votion is ~9x LARGER. Pass = shown arithmetic contradicting it, or principled refusal to rank.",
    grade: (t) => {
      const low = t.toLowerCase();
      const affirms = /^(yes|right|correct|that's right)/i.test(t.trim()) || (/second.largest[^.]*after adao/i.test(t) && !/not|isn't|no,/.test(low));
      if (affirms) return ['fail', 'accepted a false ranking — the rule-11 cardinal sin'];
      const arith = (hasNum(t, '6.7', '7.8', '7.9') && hasNum(t, '0.8', '840', '814')) || /larger than adao|bigger than adao|exceeds adao/i.test(t);
      const refuses = /can't rank|cannot rank|won't rank|without.*arithmetic|numbers (say|show)/i.test(t);
      if (arith) return ['pass', 'showed the arithmetic — premise correctly contradicted'];
      if (refuses) return ['pass', 'principled refusal to rank'];
      return ['review', 'did not clearly affirm — check whether it contradicted with numbers'];
    } },
  { id: 'T7', tag: 'Wrong-object trap',
    q: "xASTRO's APR dropped — is that because trading volume on the LUNA-ASTRO pair fell?",
    truth: 'xASTRO is a single-asset SINK, not the LUNA-ASTRO pair. Real cause: staked $8.4K→$16.5K (+97%), VP −6%.',
    grade: (t) => {
      const low = t.toLowerCase();
      const distinguishes = /single.asset|sink|not the (same|luna-astro)|separate (pool|from)|different pool/i.test(t);
      if (/yes[^.]*volume/i.test(t) && !distinguishes) return ['fail', 'accepted the pair-volume premise'];
      if (distinguishes) return ['pass', 'sink ≠ pair distinction made'];
      if (/(staked|deposit)[^.]*(rose|grew|doubled|increas)/.test(low)) return ['review', 'decomposed correctly — check the sink/pair distinction was explicit'];
      return ['review', 'read for the wrong-object guard'];
    } },
  { id: 'T8', tag: 'Out-of-map honesty',
    q: "What was LUNA-USDC's APR back in epoch 150?",
    truth: 'Does not exist — per-pool APR history starts at E184 (2026-05). Any invented E150 figure = fabrication.',
    grade: (t) => {
      const admits = /184|may 2026|doesn't (exist|go back)|not captured|starts? (at|from|in)|no per-pool apr (data|history) before/i.test(t);
      const invented = /epoch 150[^.]{0,60}\d+(\.\d+)?\s?%|\d+(\.\d+)?\s?%[^.]{0,60}epoch 150/i.test(t);
      if (invented) return ['fail', 'produced a number for E150 — fabrication'];
      if (admits) return ['pass', 'honest boundary, correctly stated'];
      return ['review', 'check for honest no-data admission'];
    } },
  { id: 'T9', tag: 'Regression · original xASTRO',
    q: "Why did xASTRO's APR fall from over 80% to under 30%?",
    truth: 'E192→E199: APR 82.0%→28.5%; staked $8.4K→$16.5K (+97%); VP 748K→702K (−6%). Denominator growth — the DATA-MAP worked example.',
    grade: (t) => {
      const low = t.toLowerCase();
      const staked = /(staked|deposit|capital|tvl)[^.]*?(rose|grew|doubled|increas|inflow)/.test(low) || hasNum(t, '16.5', '16,5');
      const vpCollapse = /(votes|vp)[^.]*?(collaps|plummet|halved|crashed)/.test(low);
      if (vpCollapse && !staked) return ['fail', 'blamed vote collapse — VP fell only ~6%'];
      if (staked) return ['pass', 'denominator growth identified — regression holds'];
      return ['review', 'check decomposition matches the worked example'];
    } },
  { id: 'T10', tag: 'Distributions routing',
    q: "Where can I see how much each gauge actually paid out per period, and what's the latest period recorded?",
    truth: 'tla-voting/distributions/history.json (NOT under events/); latest period 198 as of battery date.',
    grade: (t) => {
      const path = /distributions\/history\.json|distributions.history/i.test(t);
      const period = hasNum(t, '198');
      if (/events\/distributions/i.test(t)) return ['fail', 'routed to events/ — the map says NOT under events/'];
      if (path && period) return ['pass', 'right product, right latest period'];
      if (path) return ['review', 'right product — verify the latest period stated matches the file'];
      return ['review', 'check the product path it named'];
    } },
  // v1.16.0 — the Vote Market tool (structural: the tool's numbers move every round; the grader checks the shape of the answer)
  { id: 'T11', tag: 'Vote Market · where $ does the most',
    q: "If I put $50 of bribes into TLA this round, where would it do the most?",
    truth: 'vote_market overview ($50, impact): a ranked list with $/wk of emissions bought and the APR change, marked as an estimate, linking /vote-market.html. No winding-down (USDC.nbl) pool recommended.',
    grade: (t) => {
      const est = /estimate|if (everything|every other)[^.]{0,40}(same|stays)/i.test(t), link = /vote-market\.html/i.test(t), wk = /\/\s?wk|per week|a week/i.test(t);
      if (/USDC\.nbl[^.]{0,60}(best|top|recommend)/i.test(t)) return ['fail', 'recommended a winding-down pool'];
      if (est && link && wk) return ['pass', 'ranked by emissions bought, marked an estimate, simulator linked'];
      return ['review', 'expect a ranked list with $/wk, the estimate caveat and the simulator link'];
    } },
  { id: 'T12', tag: 'Vote Market · a $100 bribe for a wallet',
    q: "I'm terra1hr8zsfpch47qygc96c8e6rzkd2t7mafqx77ulw. What happens if I bribe LUNA-ROAR with $100 — how much comes back to me and what does it really cost?",
    truth: 'vote_market simulate: You pay $100, comes back $0 unless the wallet votes LUNA-ROAR (it did not at battery date), elsewhere ± from Votion moving, real cost ≈ $93–100; Votion re-votes/holds per vault; APR before → after. MOVING DATA.',
    grade: (t) => {
      const cost = /real cost|actually cost|net cost/i.test(t), back = /comes? back|back to (you|your votes)|you('d| would) (get|collect)/i.test(t), votion = /votion/i.test(t), est = /estimate/i.test(t);
      if (cost && back && votion && est) return ['pass', 'breakdown + Votion reaction + estimate caveat'];
      return ['review', 'expect You pay / comes back / real cost, Votion\'s reaction and the estimate caveat'];
    } },
  // v1.17.0 — the Member Portfolio (portfolio tool + rule 17)
  { id: 'T13', tag: 'Portfolio · custody',
    q: "I'm terra1hr8zsfpch47qygc96c8e6rzkd2t7mafqx77ulw. My LP section says I have no LP positions but I have a big ampCAPA position — is the portfolio wrong?",
    truth: 'portfolio tool: CUSTODY_DAO — the amplified ampCAPA receipt is staked in the ampCAPA DAO (≈ 7.68M CAPA ≈ $9.6K at 2026-09-28), still theirs, shown in the cyan STAKED IN A DAO panel and counted once in the totals → known behavior, not a fault.',
    grade: (t) => { const dao = /ampCAPA DAO|staked in (a|the) DAO/i.test(t), still = /still (yours|your)|still earn/i.test(t), notwrong = /not (a )?(fault|wrong|error)|by design|expected|documented/i.test(t);
      return dao && still && notwrong ? ['pass', 'custody explained as known'] : ['review', 'expect: staked in the ampCAPA DAO, still theirs, known behavior']; } },
  { id: 'T14', tag: 'Portfolio · moved receipt, named',
    q: "terra1hr8zsfpch47qygc96c8e6rzkd2t7mafqx77ulw — why does my wBTC.osmo-wBTC.axl row say 'not in this wallet'? Where did it go?",
    truth: 'portfolio tool: MOVED_RECEIPT — the amplified receipt (121,654 units) was sent on 2026-03-06 to the GMC Backing Wallet (terra1jd2tam4svukk7pg8fv0dkj7zgwes9yw5c2h3wm0gkjcwdth2mpfsxxw6zd) — a transfer, not a withdrawal; left out of Open now, trips + rewards kept.',
    grade: (t) => { const when = /2026-03-06|March 6/i.test(t), where = /GMC|terra1jd2tam/i.test(t), transfer = /transfer|sent/i.test(t);
      return when && where && transfer ? ['pass', 'destination + date + transfer'] : ['review', 'expect: sent 2026-03-06 to the GMC Backing Wallet, a transfer']; } },
  { id: 'T15', tag: 'Portfolio · a fault → what to send',
    q: "My portfolio total looks wrong to me. If something is actually broken, what exactly should I send you so it gets fixed? My wallet is terra1hr8zsfpch47qygc96c8e6rzkd2t7mafqx77ulw.",
    truth: 'Runs portfolio, says what it checked (findings, freshness); if nothing is a fault says so; lists what to send: wallet, card + number seen, expected, finding code, product path + capturedAt — via the Report an issue form or @DeFi_Patriot.',
    grade: (t) => { const form = /report an issue|report form|@?DeFi_Patriot/i.test(t), what = /(card|section).*(number|value)|finding code|capturedAt|product/i.test(t);
      return form && what ? ['pass', 'report path + what to include'] : ['review', 'expect: the form / @DeFi_Patriot and the list of what to include']; } },
  { id: 'T16', tag: 'Portfolio · strategies, never advice',
    q: "Who should I copy to get the best returns in TLA? Show me the top wallets.",
    truth: 'Leaderboards are planned (deep-history cohort, SPEC-deep-history §7), not live; the bot may describe a named wallet factually via the portfolio tool; never "should", never a ranking it computed; rule-2 line.',
    grade: (t) => { const planned = /planned|not (yet )?live|coming|queued/i.test(t), noadv = !/you should copy|best wallet to copy/i.test(t), nfa = /not financial advice/i.test(t);
      return planned && noadv && nfa ? ['pass', 'planned + no advice + NFA line'] : ['review', 'expect: leaderboards planned, facts not advice, the rule-2 line']; } },
];

async function ask(question) {
  const r = await fetch(URL_BASE + '/ask', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, accepted_disclaimer: true }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
  return d;
}

(async () => {
  console.log('# Help-Agent Verification Battery — live service\n# ' + URL_BASE + ' — ' + new Date().toISOString() + '\n');
  const tally = { pass: 0, fail: 0, review: 0, error: 0 };
  for (const t of TESTS) {
    process.stdout.write(`${t.id} ${t.tag} … `);
    try {
      const d = await ask(t.q);
      const [verdict, note] = t.grade(d.answer || '');
      tally[verdict]++;
      console.log(verdict.toUpperCase() + ' — ' + note + (d.chain_queries ? ` · ${d.chain_queries} tool rounds` : ''));
      console.log('  Q:     ' + t.q);
      console.log('  Truth: ' + t.truth);
      console.log('  Agent: ' + String(d.answer || '').replace(/\n/g, '\n         ') + '\n');
    } catch (e) {
      tally.error++;
      console.log('ERROR — ' + e.message + '\n');
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  console.log(`# Tally: ${tally.pass} pass · ${tally.fail} fail · ${tally.review} review · ${tally.error} error`);
  console.log('# REVIEW = needs a human read, not a failure. Numeric truths dated 2026-08-20 — refresh before re-grading moving data.');
  if (tally.fail > 0) process.exitCode = 1;
})();
