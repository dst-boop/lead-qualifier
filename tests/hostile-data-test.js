// Hostile data in every lead field, rendered everywhere the row reaches.
//
// Lead fields are attacker-influenced in principle: a CSV from anywhere, a
// pasted list, a vendor export. Every one of the sixteen fields below carries
// a payload that executes if any surface interpolates it into innerHTML
// without esc(). The assertion is empirical — did anything fire — because a
// grep for `${L.` cannot see through helper functions, and the audit that
// produced this suite proved exactly that by finding nothing greppable.
const { chromium } = require('playwright');

const PAY = '"><img src=x onerror="window.__xss=(window.__xss||0)+1">';
const FIELDS = ['firstName', 'lastName', 'title', 'employer', 'state', 'city', 'email',
                'mobilePhone', 'directPhone', 'batch', 'linkedinUrl', 'mgmtLevel',
                'moneyEvent', 'campaign', 'gradYear', 'jobStartDate'];

(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })
    .catch(() => chromium.launch());
  const p = await (await b.newContext({ viewport: { width: 1500, height: 1000 } })).newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));

  const L = { id: 'evil', status: 'New', activity: [], notes: PAY, assignedTo: PAY };
  FIELDS.forEach(f => { L[f] = PAY; });
  await p.route('**/api/me', r => r.fulfill({ json: { signed_in: true, provider: 'google',
    name: 'D', email: 'd@x.com', providers: { google: true },
    features: { whitepages: true, ai_qc: true, server_state: true, drive: false,
                zoominfo: false, edgar: true, zi_mcp: false, opportunities: false,
                free_sources: true }, storage: 'firestore' } }));
  await p.route('**/api/settings', r => r.fulfill({ json: { ok: true } }));
  await p.route('**/api/lists', r => r.fulfill({ json: { lists: [{ id: 'default',
    name: 'All leads', count: 1, role: 'owner', owner: '', master: true }], settings: {} } }));
  await p.route('**/api/lists/*', r => r.request().method() === 'GET'
    ? r.fulfill({ json: { list: { id: 'default', name: 'All leads' }, settings: {}, leads: [L] } })
    : r.fulfill({ json: { ok: true, lists: [] } }));

  let fail = 0, n = 0;
  const ck = (name, c, d) => { n++; console.log((c ? 'ok   ' : 'FAIL ') + name + (d !== undefined ? '  ' + d : '')); if (!c) fail++; };
  await p.goto('http://127.0.0.1:8099/', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1500);

  ck('the hostile lead renders at all — hostile is not a crash',
     await p.evaluate(() => typeof state !== 'undefined' && state.leads.length === 1));
  ck('nothing fired from the table, badges or pipeline',
     await p.evaluate(() => (window.__xss || 0)) === 0,
     await p.evaluate(() => window.__xss || 0));

  await p.evaluate(() => { try { toggleDetail('evil', 'research'); } catch (e) {} });
  await p.waitForTimeout(500);
  ck('nothing fired from the detail and research panels',
     await p.evaluate(() => (window.__xss || 0)) === 0);

  await p.evaluate(() => { document.getElementById('q').value = '"><img src=x onerror="window.__xss=(window.__xss||0)+1">'; render(); });
  await p.waitForTimeout(400);
  ck('nothing fired through the search box', await p.evaluate(() => (window.__xss || 0)) === 0);

  ck('no page errors while rendering hostile data', errs.length === 0, errs.slice(0, 2).join(' | '));
  console.log(fail ? `\nFAILURES: ${fail} of ${n}` : `\nall ${n} checks passed`);
  await b.close(); process.exit(fail ? 1 : 0);
})();
