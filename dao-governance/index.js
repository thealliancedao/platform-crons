// =============================================================================
// dao-governance — org cron (NEW, 2026-08-11). Replaces the hand-exported
// governance corpus in defipatriot/adao_json_storage with automatic chain
// capture, writing the SHAPE dao_governance_tool.html already consumes.
// =============================================================================
// THE THREE-WAY SPLIT (SPEC-dao-governance-capture):
//   proposals → THIS CRON (chain-derived, automatic)
//   members   → org catalog/snapshots (already there: adao 155, liondao 70,
//               pixellions 76) — this cron JOINS names from it, never stores
//               its own member list
//   registry  → stays hand-curated per DAO (the trust layer). This cron READS
//               it (to find each DAO's proposal module + to mark messages
//               trusted/unverified) and never writes it.
//
// REGISTRY-DRIVEN BY CONSTRUCTION: DAOs are discovered by listing folders in
// dao-originations. Adding a DAO = add a folder with governance/registry.json.
// No hardcoded enumeration anywhere.
//
// ⚠ MODES — RUN IN THIS ORDER THE FIRST TIME (chain shape is unverified;
// the build sandbox had no chain access):
//   PROBE=1   → queries one DAO, writes probe.json with RAW chain responses
//               and the mapped output side by side. Writes nothing else.
//               Review it before trusting the mapping.
//   VERIFY=1  → maps ALL proposals and DIFFS against the existing (migrated)
//               proposals.json without writing. The 37 migrated aDAO
//               proposals are the fixture: titles/statuses/vote tallies must
//               reproduce. Report-only.
//   (default) → capture + publish.
// Kill-switch: DAO_GOVERNANCE=0. Scope: DAO_ONLY=<folder,folder>.
//
// 1.2.0 (2026-08-22) — THREE GOVERNANCE SHAPES, ONE OUTPUT. registry.kind:
//   "daodao"     (default) dao-proposal-single via the DAO core — as before.
//   "anchor-gov" Anchor-style gov contract (Capapult/CAPA governance:
//                registry.govAddress; polls / voters / config queries). Same
//                chain (phoenix-1), same address space — a CosmWasm contract,
//                not another layer. End is a HEIGHT; we carry the height and an
//                ESTIMATED end time (current height + measured block time),
//                flagged `estimated:true`, never presented as chain truth.
//   "x-gov"      Cosmos SDK x/gov (Terra/LUNA governance) via LCD REST. Tally
//                from the chain; total power = bonded stake; quorum/threshold
//                from gov params. Per-voter lists are NOT captured (thousands
//                of votes; `votersNote` says so) — the tally is the record.
// Every kind maps to the SAME proposals.json shape the site and the help
// agent's audit consume. Unverified chain shapes go through PROBE=1 first —
// the anchor-gov query names follow the Anchor gov contract; the CAPA fork
// answered {config:{}} on chain (owner HAR 2026-08-22) and carries abstain.
// =============================================================================

const https = require('https');
const crypto = require('crypto');

const LCD = process.env.TERRA_LCD || 'https://terra-lcd.publicnode.com';
const LCD_FALLBACK = process.env.TERRA_LCD_FALLBACK || 'https://phoenix-lcd.terra.dev';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const CORE_REPO = process.env.CORE_REPO || 'thealliancedao/tla-core';
const DAO_REPO = process.env.DAO_REPO || 'thealliancedao/dao-originations';
const BRANCH = process.env.GITHUB_BRANCH || 'main';
const PROBE = process.env.PROBE === '1';
const VERIFY = process.env.VERIFY === '1';
const PAGE = 30;
const VOTERS_CAP = 300;          // anchor-gov per-poll voter capture cap (honest: `votersTruncated`)

// LCD REST GET (x/gov, staking, blocks) — JSON or null, primary then fallback.
async function lcdGet(path) {
  for (const base of [LCD, LCD_FALLBACK]) {
    try { const r = await req(`${base}${path}`); if (r.status === 200) return JSON.parse(r.body); } catch (e) { /* fallback */ }
  }
  return null;
}

// -----------------------------------------------------------------------------
// HTTP
// -----------------------------------------------------------------------------
function req(url, { method = 'GET', headers = {}, body = null, timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const r = https.request({
      method, hostname: u.hostname, port: 443, path: u.pathname + (u.search || ''),
      headers: {
        'User-Agent': 'org-dao-governance/1.2.0',
        ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}),
        ...headers,
      }, timeout: timeoutMs,
    }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume(); return resolve(req(new URL(res.headers.location, url).toString(), { method, headers, body, timeoutMs }));
      }
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    r.on('error', reject);
    r.on('timeout', () => r.destroy(new Error('timeout ' + url)));
    if (body) r.write(body);
    r.end();
  });
}
const gh = () => ({ Authorization: `token ${GITHUB_TOKEN}`, Accept: 'application/vnd.github.v3+json' });

// Contents-API read (strongly consistent; see consistency law in
// cron-dex-data-log — never the raw CDN for state this run may mutate).
async function readRepoFile(repo, path) {
  const r = await req(`https://api.github.com/repos/${repo}/contents/${encodeURI(path)}?ref=${BRANCH}`,
    { headers: { ...gh(), Accept: 'application/vnd.github.raw' } });
  if (r.status === 404) return null;
  if (r.status !== 200) throw new Error(`read ${path}: HTTP ${r.status}`);
  return r.body;
}
async function listRepoDir(repo, path = '') {
  const r = await req(`https://api.github.com/repos/${repo}/contents/${encodeURI(path)}?ref=${BRANCH}&per_page=1000`, { headers: gh() });
  if (r.status !== 200) throw new Error(`list ${repo}/${path}: HTTP ${r.status}`);
  return JSON.parse(r.body);
}
function blobSha(content) {
  const b = Buffer.from(content);
  return crypto.createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex');
}
async function publish(repo, path, content, message) {
  if (PROBE || VERIFY) { console.log(`  [report-only] would write ${repo}/${path}`); return true; }
  const api = `/repos/${repo}/contents/${encodeURI(path)}`;
  for (let a = 1; a <= 4; a++) {
    const cur = await req(`https://api.github.com${api}?ref=${BRANCH}`, { headers: gh() }).then(r => { try { return JSON.parse(r.body); } catch { return {}; } });
    const r = await req(`https://api.github.com${api}`, {
      method: 'PUT', headers: gh(),
      body: JSON.stringify({ message, content: Buffer.from(content).toString('base64'), branch: BRANCH, ...(cur.sha ? { sha: cur.sha } : {}) }),
    });
    if (r.status === 200 || r.status === 201) {
      const stored = (() => { try { return JSON.parse(r.body).content.sha; } catch { return null; } })();
      if (stored !== blobSha(content)) throw new Error(`${path}: blob sha mismatch`);
      console.log(`  ✅ ${path} (blob sha server-verified)`);
      return true;
    }
    if ([409, 422].includes(r.status) || r.status >= 500) { await new Promise(s => setTimeout(s, 400 * a)); continue; }
    throw new Error(`write ${path}: HTTP ${r.status} ${r.body.slice(0, 140)}`);
  }
  throw new Error(`write ${path}: retries exhausted`);
}

// -----------------------------------------------------------------------------
// CHAIN
// -----------------------------------------------------------------------------
let query = async function queryImpl(addr, q) {
  const b64 = Buffer.from(JSON.stringify(q)).toString('base64');
  for (const base of [LCD, LCD_FALLBACK]) {
    try {
      const r = await req(`${base}/cosmwasm/wasm/v1/contract/${addr}/smart/${b64}`);
      if (r.status === 200) return JSON.parse(r.body).data;
    } catch (e) { /* try fallback */ }
  }
  return null;
};

// -----------------------------------------------------------------------------
// MAPPING — chain (dao-proposal-single) → the shape the audit tool consumes.
// Field names verified against the migrated corpus; RAW chain field names are
// the standard dao-proposal-single ones and MUST be confirmed by PROBE=1
// before this is trusted in production.
// -----------------------------------------------------------------------------
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

function pctOf(part, whole) { return whole > 0 ? (part / whole) * 100 : 0; }

// threshold shapes: {threshold_quorum:{threshold:{percent:"0.5"},quorum:{percent:"0.1"}}}
// or {absolute_percentage:{percentage:{percent:"0.5"}}}
function readThresholds(th) {
  const pct = x => x && x.percent != null ? num(x.percent) * 100 : (x && x.majority ? 50 : null);
  if (!th) return { quorumThreshold: null, passThreshold: null };
  if (th.threshold_quorum) return { quorumThreshold: pct(th.threshold_quorum.quorum), passThreshold: pct(th.threshold_quorum.threshold) };
  if (th.absolute_percentage) return { quorumThreshold: 0, passThreshold: pct(th.absolute_percentage.percentage) };
  return { quorumThreshold: null, passThreshold: null };
}

const STATUS_LABEL = { open: 'Open', rejected: 'Rejected', passed: 'Passed', executed: 'Executed', closed: 'Closed', execution_failed: 'Execution Failed', veto_timelock: 'Veto Timelock', vetoed: 'Vetoed' };

function decodeMsgs(msgs, registry) {
  const decoded = [];
  let treasuryImpact = null;
  for (const m of msgs || []) {
    const w = m.wasm?.execute;
    const bank = m.bank?.send;
    if (w) {
      let action = null, inner = null;
      try { inner = JSON.parse(Buffer.from(w.msg, 'base64').toString()); action = Object.keys(inner)[0]; } catch { /* opaque */ }
      const known = registry?.contracts?.[w.contract_addr];
      const allowed = known?.validActions || [];
      decoded.push({
        type: 'wasm.execute',
        contract: w.contract_addr,
        contractName: known?.name || null,
        action,
        trusted: !!known,                                  // in the vetted registry
        actionAllowed: known ? (allowed.length === 0 || allowed.includes('execute')) : null,
        verificationStatus: known ? 'trusted' : 'not_yet_verified',
        funds: w.funds || [],
        args: inner ? inner[action] : null,
      });
      for (const f of w.funds || []) {
        treasuryImpact = treasuryImpact || { outflows: [] };
        treasuryImpact.outflows.push({ denom: f.denom, amount: f.amount, to: w.contract_addr });
      }
    } else if (bank) {
      const known = registry?.contracts?.[bank.to_address];
      decoded.push({ type: 'bank.send', to: bank.to_address, toName: known?.name || null, trusted: !!known, verificationStatus: known ? 'trusted' : 'not_yet_verified', amount: bank.amount });
      treasuryImpact = treasuryImpact || { outflows: [] };
      for (const a of bank.amount || []) treasuryImpact.outflows.push({ denom: a.denom, amount: a.amount, to: bank.to_address });
    } else {
      decoded.push({ type: Object.keys(m)[0] || 'unknown', trusted: false, verificationStatus: 'not_yet_verified', raw: m });
    }
  }
  return { decodedActions: decoded, treasuryImpact };
}

// Reason strings match the legacy corpus's own convention, including the
// quorum detail it wrote for under-quorum proposals.
function outcomeReason(status, { turnout, quorumThreshold, yes, decidingBase, passThreshold }) {
  const quorumMissed = quorumThreshold != null && turnout < quorumThreshold;
  const fmt = n => Number(n.toFixed(2));
  if (status === 'executed') return 'Proposal passed and executed';
  if (status === 'passed') return 'Proposal passed';
  if (status === 'vetoed') return 'Proposal vetoed by council';
  if (['rejected', 'closed'].includes(status)) {
    if (quorumMissed) return `Did not reach quorum (${fmt(turnout)}% < ${fmt(quorumThreshold)}% needed)`;
    if (passThreshold != null && decidingBase > 0 && pctOf(yes, decidingBase) < passThreshold) {
      return `Did not reach pass threshold (${fmt(pctOf(yes, decidingBase))}% yes < ${fmt(passThreshold)}% needed)`;
    }
    return status === 'closed' ? 'Proposal closed' : 'Proposal rejected';
  }
  if (status === 'execution_failed') return 'Execution failed';
  if (status === 'open') return 'Voting in progress';
  return `Status: ${status}`;
}

// -----------------------------------------------------------------------------
// 1.2.0 — anchor-gov (CAPA) mapping. Poll shape (Anchor gov): {id, creator,
// status: in_progress|passed|rejected|executed|expired|failed, end_height, title,
// description, link, deposit_amount, execute_data:[{order,contract,msg(b64)}],
// yes_votes, no_votes, abstain_votes, staked_amount, total_balance_at_end_poll}.
// -----------------------------------------------------------------------------
const ANCHOR_STATUS = { in_progress: 'open', passed: 'passed', rejected: 'rejected', executed: 'executed', expired: 'closed', failed: 'execution_failed' };
function anchorMsgsToWasm(executeData) {
  // Re-express execute_data as wasm.execute msgs so decodeMsgs (registry trust
  // scoring) and the help agent's deep walk see ONE message dialect.
  return (executeData || []).map(e => ({ wasm: { execute: { contract_addr: e.contract, msg: e.msg, funds: [] } } }));
}
function mapAnchorPoll({ poll, voters, config, state, height, names, registry, daoId, idPrefix, blockTimeSec, now }) {
  const yes = num(poll.yes_votes), no = num(poll.no_votes), abstain = num(poll.abstain_votes);
  const total = yes + no + abstain;
  const status = ANCHOR_STATUS[String(poll.status || '').toLowerCase()] || String(poll.status || '').toLowerCase();
  // Power base: snapshot at poll end when closed; live staked total while open.
  const totalPower = status === 'open' ? num(poll.staked_amount) || num(state && state.total_share) : num(poll.total_balance_at_end_poll) || num(poll.staked_amount);
  const quorumThreshold = config && config.quorum != null ? num(config.quorum) * 100 : null;
  const passThreshold = config && config.threshold != null ? num(config.threshold) * 100 : null;
  const turnout = pctOf(total, totalPower);
  const decidingBase = yes + no;
  const msgs = anchorMsgsToWasm(poll.execute_data);
  const { decodedActions, treasuryImpact } = decodeMsgs(msgs, registry);
  const endH = poll.end_height != null ? Number(poll.end_height) : null;
  const estEnd = (endH != null && height != null && blockTimeSec) ? new Date((now || Date.now()) + (endH - height) * blockTimeSec * 1000).toISOString() : null;
  return {
    id: `${idPrefix}${poll.id}`, daoId,
    title: poll.title || `Poll ${poll.id}`, description: poll.description || '', link: poll.link || null,
    status: STATUS_LABEL[status] || (status ? status[0].toUpperCase() + status.slice(1) : 'Unknown'),
    proposer: poll.creator || null,
    startHeight: null,
    expiration: endH != null ? { at_height: endH, ...(estEnd ? { at_time_iso: estEnd, estimated: true, estimate_basis: `height ${height} + ${blockTimeSec.toFixed(2)}s/block` } : {}) } : null,
    live: status === 'open',
    votes: { yes, no, abstain, total },
    voting: { turnout, yesPercent: pctOf(yes, total), noPercent: pctOf(no, total), abstainPercent: pctOf(abstain, total),
      quorumReached: quorumThreshold == null ? null : turnout >= quorumThreshold,
      thresholdReached: passThreshold == null ? null : pctOf(yes, decidingBase) >= passThreshold,
      quorumThreshold, passThreshold },
    outcome: ['passed', 'executed'].includes(status) ? 'passed' : ['rejected', 'closed', 'execution_failed'].includes(status) ? 'rejected' : status === 'open' ? 'pending' : status,
    outcomeReason: outcomeReason(status, { turnout, quorumThreshold, yes, decidingBase, passThreshold }),
    totalPower,
    voters: (voters || []).map(v => ({ address: v.voter, name: names[v.voter] || 'Unknown Member', vote: String(v.vote || '').toLowerCase(), power: num(v.balance) })).sort((a, b) => b.power - a.power),
    ...(voters && voters.length >= VOTERS_CAP ? { votersTruncated: true } : {}),
    decodedActions, treasuryImpact, rawMsgs: msgs,
    governanceKind: 'anchor-gov',
    fetchedAt: new Date().toISOString(),
  };
}

// -----------------------------------------------------------------------------
// 1.2.0 — x/gov (LUNA) mapping. /cosmos/gov/v1 proposal: {id, messages[@type],
// status: PROPOSAL_STATUS_*, final_tally_result{yes_count,abstain_count,no_count,
// no_with_veto_count}, submit_time, voting_start_time, voting_end_time, title,
// summary, proposer}. Threshold excludes abstain; quorum = voted / bonded.
// -----------------------------------------------------------------------------
const XGOV_STATUS = { PROPOSAL_STATUS_VOTING_PERIOD: 'open', PROPOSAL_STATUS_DEPOSIT_PERIOD: 'deposit', PROPOSAL_STATUS_PASSED: 'passed', PROPOSAL_STATUS_REJECTED: 'rejected', PROPOSAL_STATUS_FAILED: 'execution_failed' };
function mapXGovProposal({ p, tally, bonded, params, registry, daoId, idPrefix }) {
  const t = tally || p.final_tally_result || {};
  const yes = num(t.yes_count ?? t.yes), no = num(t.no_count ?? t.no), abstain = num(t.abstain_count ?? t.abstain), veto = num(t.no_with_veto_count ?? t.no_with_veto);
  const total = yes + no + abstain + veto;
  const status = XGOV_STATUS[p.status] || String(p.status || '').toLowerCase();
  const totalPower = num(bonded);
  const quorumThreshold = params && params.quorum != null ? num(params.quorum) * 100 : null;
  const passThreshold = params && params.threshold != null ? num(params.threshold) * 100 : null;
  const vetoThreshold = params && params.veto_threshold != null ? num(params.veto_threshold) * 100 : null;
  const turnout = pctOf(total, totalPower);
  const decidingBase = yes + no + veto;
  const msgs = (p.messages || []).map(m => ({ [m['@type'] || 'unknown']: m }));
  const decodedActions = (p.messages || []).map(m => ({ type: m['@type'] || 'unknown', trusted: false, verificationStatus: 'not_yet_verified', raw: m }));
  return {
    id: `${idPrefix}${p.id}`, daoId,
    title: p.title || (p.messages && p.messages[0] && p.messages[0].content && p.messages[0].content.title) || `Proposal ${p.id}`,
    description: p.summary || (p.messages && p.messages[0] && p.messages[0].content && p.messages[0].content.description) || '',
    status: STATUS_LABEL[status] || (status ? status[0].toUpperCase() + status.slice(1) : 'Unknown'),
    proposer: p.proposer || null,
    startHeight: null, submitTime: p.submit_time || null, votingStartTime: p.voting_start_time || null,
    expiration: p.voting_end_time ? { at_time_iso: new Date(p.voting_end_time).toISOString() } : null,
    live: status === 'open',
    votes: { yes, no, abstain, total, noWithVeto: veto },
    voting: { turnout, yesPercent: pctOf(yes, total), noPercent: pctOf(no, total), abstainPercent: pctOf(abstain, total), vetoPercent: pctOf(veto, total),
      quorumReached: quorumThreshold == null ? null : turnout >= quorumThreshold,
      thresholdReached: passThreshold == null ? null : pctOf(yes, decidingBase) >= passThreshold,
      vetoed: vetoThreshold == null ? null : pctOf(veto, total) >= vetoThreshold,
      quorumThreshold, passThreshold, vetoThreshold },
    outcome: status === 'passed' ? 'passed' : ['rejected', 'execution_failed'].includes(status) ? 'rejected' : status === 'open' ? 'pending' : status,
    outcomeReason: outcomeReason(status, { turnout, quorumThreshold, yes, decidingBase, passThreshold }),
    totalPower,
    voters: [], votersNote: 'x/gov: per-voter list not captured (validator + delegator votes run to thousands); the chain tally is the record.',
    decodedActions, treasuryImpact: null, rawMsgs: msgs,
    governanceKind: 'x-gov',
    fetchedAt: new Date().toISOString(),
  };
}

function mapProposal({ id, chain, votes, names, registry, daoId, idPrefix }) {
  const p = chain.proposal || chain;
  const yes = num(p.votes?.yes), no = num(p.votes?.no), abstain = num(p.votes?.abstain);
  const total = yes + no + abstain;
  const totalPower = num(p.total_power);
  const { quorumThreshold, passThreshold } = readThresholds(p.threshold);
  const turnout = pctOf(total, totalPower);
  const yesPercent = pctOf(yes, total);
  const noPercent = pctOf(no, total);
  const abstainPercent = pctOf(abstain, total);
  // Pass threshold EXCLUDES abstain (dao-proposal-single semantics). The
  // legacy hand-export divided yes by ALL votes, which printed "threshold not
  // reached" on proposals that had in fact executed on chain (gate-proven on
  // 3 abstain-heavy aDAO proposals). Chain truth wins.
  const decidingBase = yes + no;
  const status = String(p.status || '').toLowerCase();
  const { decodedActions, treasuryImpact } = decodeMsgs(p.msgs, registry);
  return {
    id: `${idPrefix}${id}`,
    daoId,
    title: p.title || `Proposal ${id}`,
    description: p.description || '',
    status: STATUS_LABEL[status] || (status ? status[0].toUpperCase() + status.slice(1) : 'Unknown'),
    proposer: p.proposer || null,
    // 1.1.0: timing straight from the chain object (DAODAO single-choice):
    // start_height + expiration {at_time: nanos | at_height | never}. Lets the
    // site merge several DAOs' proposals chronologically and show time left.
    startHeight: p.start_height != null ? Number(p.start_height) : null,
    expiration: p.expiration && p.expiration.at_time ? { at_time_iso: new Date(Number(String(p.expiration.at_time).slice(0, 13))).toISOString() }
              : p.expiration && p.expiration.at_height != null ? { at_height: Number(p.expiration.at_height) }
              : p.expiration && 'never' in p.expiration ? { never: true } : null,
    live: status === 'open',
    votes: { yes, no, abstain, total },
    voting: {
      turnout,
      yesPercent,
      noPercent,
      abstainPercent,
      quorumReached: quorumThreshold == null ? null : turnout >= quorumThreshold,
      thresholdReached: passThreshold == null ? null : pctOf(yes, decidingBase) >= passThreshold,
      quorumThreshold,
      passThreshold,
    },
    // Outcome classification. NOTE vs the legacy hand-export: it emitted
    // outcome 'unknown' + an EMPTY reason for vetoed proposals (it had no
    // veto branch). We classify veto as rejected with an explicit reason —
    // a deliberate improvement, flagged in the gate.
    outcome: ['passed', 'executed'].includes(status) ? 'passed'
      : ['rejected', 'vetoed', 'closed', 'execution_failed'].includes(status) ? 'rejected'
      : status === 'open' ? 'pending' : status,
    outcomeReason: outcomeReason(status, { turnout, quorumThreshold, yes, decidingBase, passThreshold }),
    totalPower,
    voters: (votes || []).map(v => ({
      address: v.voter,
      name: names[v.voter] || 'Unknown Member',
      vote: v.vote,
      power: num(v.power),
    })).sort((a, b) => b.power - a.power),
    decodedActions,
    treasuryImpact,
    rawMsgs: p.msgs || [],
    fetchedAt: new Date().toISOString(),
  };
}

// -----------------------------------------------------------------------------
// CAPTURE
// -----------------------------------------------------------------------------
// 1.1.0 (2026-08-22): CHAIN-FIRST module resolution. The old rule — "first
// registry contract that answers proposal_count" — silently captured aDAO's
// proposals into lion-dao/ because that registry carries aDAO's entries first.
// Now: find THIS DAO's core (registry entry named *Core* whose name matches the
// folder, or the registry's sole core), ask the core itself which proposal
// modules it owns ({proposal_modules:{}}), keep the Enabled ones, verify each
// answers proposal_count. Registry names only route; the chain decides.
// Fallback (no core found / core query fails): registry candidates whose name
// matches the folder first, then the rest — never another DAO's module by order.
function folderTokens(dao) {
  const t = String(dao || '').toLowerCase().split(/[^a-z]+/).filter(x => x && x !== 'dao');
  if (t.includes('adao')) t.push('alliance');
  return t;
}
function nameMatches(name, tokens) { const n = String(name || '').toLowerCase(); return tokens.some(t => n.includes(t)); }
async function findProposalModule(registry, dao) {
  const tokens = folderTokens(dao);
  const entries = Object.entries(registry.contracts || {});
  // 1.1.1 (2026-08-22): an EXPLICIT registry.coreAddress wins. Name-routing bit us
  // once more: lion-dao's entry labelled "Lion DAO Core" was the pixeLions α
  // stewardship msig (45 proposals), and the real DAODAO core was labelled
  // "Lion DAO Treasury". Labels are human; the core address is the contract.
  const explicit = registry.coreAddress && /^terra1[02-9ac-hj-np-z]{38,58}$/.test(registry.coreAddress) ? [registry.coreAddress, (registry.contracts || {})[registry.coreAddress] || { name: (registry.daoName || dao) + ' Core', type: 'dao' }] : null;
  const cores = entries.filter(([, v]) => /core/i.test(v.name || '') && String(v.type || '').toLowerCase() === 'dao');
  const myCores = cores.filter(([, v]) => nameMatches(v.name, tokens));
  const core = explicit || (myCores[0] || (cores.length === 1 ? cores[0] : null));
  if (core) {
    const pm = await query(core[0], { proposal_modules: {} });
    const mods = Array.isArray(pm) ? pm : (pm && pm.proposal_modules) || [];
    for (const m of mods) {
      const addr = m.address || m.addr || m; const status = String(m.status || 'Enabled');
      if (!/enabled/i.test(status)) continue;
      const c = await query(addr, { proposal_count: {} });
      if (c != null) {
        const meta = (registry.contracts || {})[addr] || { name: `${core[1].name.replace(/\s*core\s*$/i, '')} Proposal Module (from core)`, type: 'dao' };
        return { addr, meta, count: num(c), resolvedFrom: (explicit ? 'registry.coreAddress:' : 'core:') + core[0], coreModules: mods.length };
      }
    }
    console.log(`  ⚠ core ${core[0].slice(0, 14)}… listed ${mods.length} modules but none answered proposal_count — falling back to registry names`);
  }
  const candidates = entries.filter(([, v]) => (v.validActions || []).includes('propose') || /proposal/i.test(v.name || ''));
  const ordered = candidates.filter(([, v]) => nameMatches(v.name, tokens)).concat(candidates.filter(([, v]) => !nameMatches(v.name, tokens)));
  for (const [addr, meta] of ordered) {
    if (!nameMatches(meta.name, tokens) && cores.length) continue;   // never drift into another DAO's module when a core exists
    const c = await query(addr, { proposal_count: {} });
    if (c != null) return { addr, meta, count: num(c), resolvedFrom: 'registry-name' };
  }
  return null;
}

async function fetchProposals(addr) {
  const out = [];
  let startAfter = null;
  for (let guard = 0; guard < 40; guard++) {
    const q = { list_proposals: { limit: PAGE, ...(startAfter != null ? { start_after: startAfter } : {}) } };
    const res = await query(addr, q);
    const page = res?.proposals || [];
    if (!page.length) break;
    out.push(...page);
    startAfter = page[page.length - 1].id;
    if (page.length < PAGE) break;
  }
  return out;
}

async function fetchVotes(addr, id) {
  const out = [];
  let startAfter = null;
  for (let guard = 0; guard < 20; guard++) {
    const q = { list_votes: { proposal_id: id, limit: PAGE, ...(startAfter ? { start_after: startAfter } : {}) } };
    const res = await query(addr, q);
    const page = res?.votes || [];
    if (!page.length) break;
    out.push(...page);
    startAfter = page[page.length - 1].voter;
    if (page.length < PAGE) break;
  }
  return out;
}

// Names come from the ORG CATALOG (single source of truth for identity) —
// this cron never keeps its own member list.
async function loadNames(slug) {
  try {
    const raw = await readRepoFile(CORE_REPO, 'catalog/snapshots/current.json');
    if (!raw) return {};
    const cat = JSON.parse(raw);
    const rows = cat.addresses || cat.by_address || [];
    const names = {};
    const put = (addr, label) => { if (addr && label && !names[addr]) names[addr] = label; };
    if (Array.isArray(rows)) {
      for (const r of rows) if (!slug || !r.slug || r.slug === slug) put(r.address, r.label || r.name);
    } else {
      for (const [addr, r] of Object.entries(rows)) put(addr, r.label || r.name || (Array.isArray(r) ? r[0]?.label : null));
    }
    return names;
  } catch (e) {
    console.log(`  ⚠ name join unavailable (${e.message.slice(0, 50)}) — voters get 'Unknown Member'`);
    return {};
  }
}

// ---- 1.2.0 anchor-gov fetchers ------------------------------------------------
async function fetchAnchorPolls(gov) {
  const out = []; let startAfter = null;
  for (let guard = 0; guard < 40; guard++) {
    const res = await query(gov, { polls: { limit: PAGE, order_by: 'desc', ...(startAfter != null ? { start_after: startAfter } : {}) } });
    const page = res?.polls || [];
    if (!page.length) break;
    out.push(...page); startAfter = page[page.length - 1].id;
    if (page.length < PAGE) break;
  }
  return out;
}
async function fetchAnchorVoters(gov, pollId) {
  const out = []; let startAfter = null;
  for (let guard = 0; guard < VOTERS_CAP / PAGE; guard++) {
    const res = await query(gov, { voters: { poll_id: pollId, limit: PAGE, order_by: 'asc', ...(startAfter ? { start_after: startAfter } : {}) } });
    const page = res?.voters || [];
    if (!page.length) break;
    out.push(...page); startAfter = page[page.length - 1].voter;
    if (page.length < PAGE) break;
  }
  return out;
}
// Block time measured from the chain (latest vs latest-1000), never assumed.
async function measureBlockTime() {
  const latest = await lcdGet('/cosmos/base/tendermint/v1beta1/blocks/latest');
  const h = latest && latest.block && latest.block.header ? Number(latest.block.header.height) : null;
  if (!h) return { height: null, blockTimeSec: null };
  const past = await lcdGet(`/cosmos/base/tendermint/v1beta1/blocks/${h - 1000}`);
  if (!past || !past.block) return { height: h, blockTimeSec: null };
  const dt = (new Date(latest.block.header.time) - new Date(past.block.header.time)) / 1000;
  return { height: h, blockTimeSec: dt > 0 ? dt / 1000 : null, now: new Date(latest.block.header.time).getTime() };
}
async function captureAnchorGov(dao, registry) {
  const gov = registry.govAddress;
  if (!gov) { console.log('  ⚠ kind=anchor-gov but no registry.govAddress — skipped'); return null; }
  const [config, state, polls, bt] = await Promise.all([query(gov, { config: {} }), query(gov, { state: {} }), fetchAnchorPolls(gov), measureBlockTime()]);
  if (!config) { console.log('  ⚠ gov contract did not answer {config:{}} — skipped (the chain decides)'); return null; }
  console.log(`  anchor-gov ${gov.slice(0, 14)}… polls=${polls.length} quorum=${config.quorum} threshold=${config.threshold} height=${bt.height} blockTime=${bt.blockTimeSec}`);
  const names = await loadNames((registry.dao || dao).toLowerCase().replace(/[^a-z]/g, ''));
  if (PROBE) {
    const probe = { dao, kind: 'anchor-gov', gov, config, state, rawFirst: polls[0] || null, rawVotersFirst: polls[0] ? await fetchAnchorVoters(gov, polls[0].id) : null };
    probe.mappedFirst = polls[0] ? mapAnchorPoll({ poll: polls[0], voters: probe.rawVotersFirst, config, state, height: bt.height, blockTimeSec: bt.blockTimeSec, now: bt.now, names, registry, daoId: registry.dao, idPrefix: registry.idPrefix || 'c' }) : null;
    console.log(JSON.stringify(probe, null, 1).slice(0, 4000));
    return { dao, probe };
  }
  const proposals = {}; const idPrefix = registry.idPrefix || 'c';
  for (const poll of polls) {
    const voters = await fetchAnchorVoters(gov, poll.id);
    const m = mapAnchorPoll({ poll, voters, config, state, height: bt.height, blockTimeSec: bt.blockTimeSec, now: bt.now, names, registry, daoId: registry.dao, idPrefix });
    proposals[m.id] = m;
  }
  return { dao, registry, doc: { dao: registry.dao, daoName: registry.daoName || registry.dao, exportedAt: new Date().toISOString(), source: 'org dao-governance cron (chain-derived, anchor-gov)', governanceKind: 'anchor-gov', govAddress: gov, proposalCount: Object.keys(proposals).length, proposals } };
}
// ---- 1.2.0 x/gov (LUNA) ----------------------------------------------------------
async function captureXGov(dao, registry) {
  const lim = registry.limit || 60;
  const [list, pool, params] = await Promise.all([
    lcdGet(`/cosmos/gov/v1/proposals?pagination.limit=${lim}&pagination.reverse=true`),
    lcdGet('/cosmos/staking/v1beta1/pool'),
    // PROBE 2026-08-22 showed quorum=null: the v1 route is /params/{type}, not a query arg. v1beta1 fallback for older nodes.
    (async () => (await lcdGet('/cosmos/gov/v1/params/tallying')) || (await lcdGet('/cosmos/gov/v1beta1/params/tallying')))(),
  ]);
  const props = (list && list.proposals) || [];
  if (!props.length) { console.log('  ⚠ x/gov returned no proposals — skipped'); return null; }
  const bonded = pool && pool.pool ? pool.pool.bonded_tokens : null;
  const tp = (params && (params.params || params.tally_params)) || null;
  console.log(`  x/gov proposals=${props.length} bonded=${bonded} quorum=${tp && tp.quorum} threshold=${tp && tp.threshold}`);
  const proposals = {}; const idPrefix = registry.idPrefix || 'l';
  for (const p of props) {
    const live = p.status === 'PROPOSAL_STATUS_VOTING_PERIOD';
    const tally = live ? ((await lcdGet(`/cosmos/gov/v1/proposals/${p.id}/tally`)) || {}).tally : null;
    const m = mapXGovProposal({ p, tally, bonded, params: tp, registry, daoId: registry.dao, idPrefix });
    proposals[m.id] = m;
  }
  if (PROBE) { console.log(JSON.stringify({ dao, kind: 'x-gov', rawFirst: props[0], mappedFirst: proposals[Object.keys(proposals)[0]] }, null, 1).slice(0, 4000)); return { dao, probe: true }; }
  return { dao, registry, doc: { dao: registry.dao, daoName: registry.daoName || registry.dao, exportedAt: new Date().toISOString(), source: 'org dao-governance cron (chain-derived, x/gov)', governanceKind: 'x-gov', bondedTokens: bonded, window: `newest ${lim}`, proposalCount: Object.keys(proposals).length, proposals } };
}

async function captureDao(dao) {
  console.log(`\n=== ${dao} ===`);
  const regRaw = await readRepoFile(DAO_REPO, `${dao}/governance/registry.json`);
  if (!regRaw) { console.log('  ⚠ no registry.json — skipped (a DAO without a vetted registry cannot be trust-scored)'); return null; }
  const registry = JSON.parse(regRaw);
  const kind = String(registry.kind || 'daodao').toLowerCase();
  if (kind === 'anchor-gov') return captureAnchorGov(dao, registry);
  if (kind === 'x-gov') return captureXGov(dao, registry);
  const mod = await findProposalModule(registry, dao);
  if (!mod) { console.log('  ⚠ no proposal module answered proposal_count — skipped'); return null; }
  console.log(`  proposal module: ${mod.meta.name} (${mod.addr.slice(0, 14)}…) count=${mod.count} via ${mod.resolvedFrom}`);
  if (registry.dao && !nameMatches(registry.dao, folderTokens(dao)) && !nameMatches(dao, folderTokens(registry.dao))) console.log(`  ⚠ registry drift: folder "${dao}" but registry.dao="${registry.dao}" — the name join may label the wrong DAO's members`);

  const slug = (registry.dao || dao).toLowerCase().replace(/[^a-z]/g, '');
  const names = await loadNames(slug);
  console.log(`  name join: ${Object.keys(names).length} labeled addresses from org catalog`);

  const chainProps = await fetchProposals(mod.addr);
  console.log(`  fetched ${chainProps.length} proposals`);

  if (PROBE) {
    const probe = { dao, module: mod.addr, rawFirst: chainProps[0] || null, rawVotesFirst: chainProps[0] ? await fetchVotes(mod.addr, chainProps[0].id) : null };
    probe.mappedFirst = chainProps[0] ? mapProposal({ id: chainProps[0].id, chain: chainProps[0], votes: probe.rawVotesFirst, names, registry, daoId: registry.dao, idPrefix: 'a' }) : null;
    console.log(JSON.stringify(probe, null, 1).slice(0, 4000));
    return { dao, probe };
  }

  const proposals = {};
  const idPrefix = (registry.idPrefix || 'a');
  for (const cp of chainProps) {
    const votes = await fetchVotes(mod.addr, cp.id);
    const m = mapProposal({ id: cp.id, chain: cp, votes, names, registry, daoId: registry.dao, idPrefix });
    proposals[m.id] = m;
  }

  const doc = {
    dao: registry.dao,
    daoName: registry.daoName || registry.dao,
    exportedAt: new Date().toISOString(),
    source: 'org dao-governance cron (chain-derived)',
    proposalModule: mod.addr,
    governanceKind: 'daodao',
    proposalCount: Object.keys(proposals).length,
    proposals,
  };
  return { dao, doc, registry };
}

// -----------------------------------------------------------------------------
// VERIFY — diff against the migrated corpus without writing.
// -----------------------------------------------------------------------------
function verifyAgainst(existingRaw, doc) {
  const old = JSON.parse(existingRaw);
  const oldP = old.proposals || {};
  const rows = [];
  for (const [id, o] of Object.entries(oldP)) {
    const n = doc.proposals[id];
    if (!n) { rows.push(`${id}: MISSING in new capture`); continue; }
    const diffs = [];
    if (o.title !== n.title) diffs.push(`title '${o.title}' → '${n.title}'`);
    if (o.status !== n.status) diffs.push(`status ${o.status} → ${n.status}`);
    for (const k of ['yes', 'no', 'abstain', 'total']) if (num(o.votes?.[k]) !== num(n.votes?.[k])) diffs.push(`votes.${k} ${o.votes?.[k]} → ${n.votes?.[k]}`);
    if (Math.abs(num(o.totalPower) - num(n.totalPower)) > 0) diffs.push(`totalPower ${o.totalPower} → ${n.totalPower}`);
    if (Math.abs(num(o.voting?.turnout) - num(n.voting?.turnout)) > 0.01) diffs.push(`turnout ${o.voting?.turnout} → ${n.voting?.turnout}`);
    if (diffs.length) rows.push(`${id}: ${diffs.join(' | ')}`);
  }
  const added = Object.keys(doc.proposals).filter(id => !oldP[id]);
  return { mismatches: rows, added, oldCount: Object.keys(oldP).length, newCount: Object.keys(doc.proposals).length };
}

// -----------------------------------------------------------------------------
// MAIN
// -----------------------------------------------------------------------------
async function main() {
  console.log(`🏛  dao-governance ${new Date().toISOString()}${PROBE ? ' [PROBE]' : ''}${VERIFY ? ' [VERIFY]' : ''}`);
  const entries = await listRepoDir(DAO_REPO);
  // DAO_ONLY=capapult,terra — restrict a run (PROBE on one DAO without paging through the others' output).
  const only = String(process.env.DAO_ONLY || '').split(',').map(x => x.trim()).filter(Boolean);
  const daos = entries.filter(e => e.type === 'dir').map(e => e.name).filter(d => !only.length || only.includes(d));
  console.log(`DAOs discovered in ${DAO_REPO}: ${daos.join(', ') || '(none)'}`);

  const results = [];
  for (const dao of daos) {
    try {
      const r = await captureDao(dao);
      if (!r || !r.doc) { results.push({ dao, status: 'skipped' }); continue; }
      if (VERIFY) {
        const existing = await readRepoFile(DAO_REPO, `${dao}/governance/proposals.json`);
        if (!existing) { console.log('  (no existing corpus to diff)'); results.push({ dao, status: 'verify-nobase', count: r.doc.proposalCount }); continue; }
        const v = verifyAgainst(existing, r.doc);
        console.log(`  VERIFY: old ${v.oldCount} vs new ${v.newCount} | mismatches ${v.mismatches.length} | new ids ${v.added.length}`);
        for (const m of v.mismatches.slice(0, 25)) console.log(`    ✗ ${m}`);
        if (v.added.length) console.log(`    + new: ${v.added.join(', ')}`);
        results.push({ dao, status: v.mismatches.length ? 'verify-mismatch' : 'verify-clean', ...v });
        continue;
      }
      const body = JSON.stringify(r.doc, null, 1);
      await publish(DAO_REPO, `${dao}/governance/proposals.json`, body, `🏛 ${dao} proposals — ${r.doc.proposalCount} (chain-derived)`);
      const d = new Date();
      await publish(DAO_REPO, `${dao}/governance/history/${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}.json`, body, `🏛 ${dao} proposals snapshot ${d.toISOString().slice(0, 10)}`);
      results.push({ dao, status: 'ok', count: r.doc.proposalCount });
    } catch (e) {
      console.error(`  ❌ ${dao}: ${e.message}`);
      results.push({ dao, status: 'error', error: e.message });
    }
  }

  if (!PROBE && !VERIFY) {
    const hb = {
      schemaVersion: 1, cron: 'dao-governance', capturedAt: new Date().toISOString(),
      status: results.every(r => r.status === 'ok') ? 'ok' : (results.some(r => r.status === 'ok') ? 'partial' : 'error'),
      daos: results,
    };
    await publish(DAO_REPO, 'heartbeat.json', JSON.stringify(hb, null, 1), `📍 dao-governance heartbeat`);
  }
  console.log('\n✅ dao-governance complete');
  return results;
}

module.exports = { main, _test: { mapProposal, mapAnchorPoll, mapXGovProposal, anchorMsgsToWasm, readThresholds, outcomeReason, decodeMsgs, verifyAgainst, pctOf, findProposalModule, folderTokens, setQuery: fn => { query = fn; } } };
if (require.main === module) {
  if (process.env.DAO_GOVERNANCE === '0') { console.log('disabled'); process.exit(0); }
  main().then(() => process.exit(0)).catch(e => { console.error('❌', e.message); process.exit(1); });
}
