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
// Kill-switch: DAO_GOVERNANCE=0.
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

// -----------------------------------------------------------------------------
// HTTP
// -----------------------------------------------------------------------------
function req(url, { method = 'GET', headers = {}, body = null, timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const r = https.request({
      method, hostname: u.hostname, port: 443, path: u.pathname + (u.search || ''),
      headers: {
        'User-Agent': 'org-dao-governance/1.0',
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
async function findProposalModule(registry) {
  const candidates = Object.entries(registry.contracts || {})
    .filter(([, v]) => (v.validActions || []).includes('propose') || /proposal/i.test(v.name || ''));
  // Self-verifying: the real module answers proposal_count.
  for (const [addr, meta] of candidates) {
    const c = await query(addr, { proposal_count: {} });
    if (c != null) return { addr, meta, count: num(c) };
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

async function captureDao(dao) {
  console.log(`\n=== ${dao} ===`);
  const regRaw = await readRepoFile(DAO_REPO, `${dao}/governance/registry.json`);
  if (!regRaw) { console.log('  ⚠ no registry.json — skipped (a DAO without a vetted registry cannot be trust-scored)'); return null; }
  const registry = JSON.parse(regRaw);
  const mod = await findProposalModule(registry);
  if (!mod) { console.log('  ⚠ no proposal module answered proposal_count — skipped'); return null; }
  console.log(`  proposal module: ${mod.meta.name} (${mod.addr.slice(0, 14)}…) count=${mod.count}`);

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
  const daos = entries.filter(e => e.type === 'dir').map(e => e.name);
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

module.exports = { main, _test: { mapProposal, readThresholds, outcomeReason, decodeMsgs, verifyAgainst, pctOf, setQuery: fn => { query = fn; } } };
if (require.main === module) {
  if (process.env.DAO_GOVERNANCE === '0') { console.log('disabled'); process.exit(0); }
  main().then(() => process.exit(0)).catch(e => { console.error('❌', e.message); process.exit(1); });
}
