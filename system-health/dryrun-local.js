'use strict';
// Real-data dry run: serve the LIVE tla-core checkout through the test seam.
const fs = require('fs'), path = require('path');
const M = require('./index.js');
const ROOT = process.env.TLA_CORE_DIR || '/home/claude/repos/verify/tla-core-main';
const WRITES = {};
M.T.githubApiRequest = async (method, apiPath, body, accept) => {
    const m = apiPath.match(/\/contents\/([^?]+)/); const p = m && decodeURIComponent(m[1]);
    if (method === 'GET') {
        const f = path.join(ROOT, p);
        if (fs.existsSync(f)) return accept === 'application/vnd.github.raw' ? fs.readFileSync(f, 'utf8') : { sha: 'x' };
        if (p in WRITES) return accept === 'application/vnd.github.raw' ? JSON.stringify(WRITES[p]) : { sha: 'x' };
        const e = new Error('404'); e.statusCode = 404; throw e;
    }
    if (method === 'PUT') { WRITES[p] = JSON.parse(Buffer.from(body.content, 'base64').toString()); return { ok: true }; }
};
M.run().then(out => {
    console.log('\n=== DRY-RUN OUTPUT (real production data) ===');
    console.log(JSON.stringify(out, null, 1).slice(0, 4200));
    fs.writeFileSync('/tmp/sh-dryrun.json', JSON.stringify(out, null, 2));
}).catch(e => { console.error('DRY-RUN FATAL:', e); process.exit(1); });
