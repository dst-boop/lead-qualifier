// The master list: one list every lead lands on, that cannot be lost.
//
// "Each user should have 1 master list that all leads are on and cannot be
// over written by accident."
//
// The mechanism under test is capture: a lead imported into a CAMPAIGN list
// must also land on the master, deduped, without the user doing anything —
// because that is what lets a campaign list be deleted without losing anyone.
// The mock server here is stateful for exactly that reason: the assertion is
// what ends up in the master document, not what the client says it sent.
const { chromium } = require('playwright');

const feat = o => ({ whitepages: false, ai_qc: false, server_state: true, drive: false,
                     zoominfo: false, edgar: false, zi_mcp: false, opportunities: false,
                     free_sources: true, ...o });
const me = o => ({ signed_in: true, provider: 'google', name: 'Dan', email: 'dan@fpa.com',
                   providers: { google: true }, features: feat(), storage: 'firestore', ...o });

// The server's lists, as documents. index() derives what /api/lists returns.
const STORE = {
  default: { name: 'All leads', leads: [] },
  c1: { name: 'Q3 campaign', leads: [] },
};
const index = () => Object.entries(STORE).map(([id, l]) => (
  { id, name: l.name, count: l.leads.length, role: 'owner', owner: '', master: id === 'default' }));

(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })
    .catch(() => chromium.launch());
  const ctx = await b.newContext({ viewport: { width: 1500, height: 1000 } });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  p.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE: ' + m.text()); });

  await p.route('**/api/me', r => r.fulfill({ json: me() }));
  await p.route('**/api/settings', r => r.fulfill({ json: { ok: true } }));
  await p.route('**/api/lists', r => r.fulfill({ json: { lists: index(), settings: {} } }));
  await p.route('**/api/lists/*', r => {
    const id = decodeURIComponent(r.request().url().split('/api/lists/')[1].split('?')[0]);
    if (!STORE[id]) return r.fulfill({ status: 404, json: { detail: 'No such list.' } });
    if (r.request().method() === 'GET')
      return r.fulfill({ json: { list: { id, name: STORE[id].name }, settings: {}, leads: STORE[id].leads } });
    if (r.request().method() === 'PUT') {
      STORE[id].leads = r.request().postDataJSON().leads;
      return r.fulfill({ json: { ok: true, leads: STORE[id].leads.length, lists: index() } });
    }
    return r.fulfill({ json: { ok: true, lists: index() } });
  });

  let fail = 0, n = 0;
  const ck = (name, c, d) => { n++; console.log((c ? 'ok   ' : 'FAIL ') + name + (d !== undefined ? '  ' + d : '')); if (!c) fail++; };
  await p.goto('http://127.0.0.1:8099/', { waitUntil: 'domcontentloaded' });
  await p.evaluate(() => localStorage.clear());
  await p.goto('http://127.0.0.1:8099/', { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => window.ME && typeof landLead === 'function', null, { timeout: 15000 });
  await p.waitForTimeout(600);

  // --- the switcher tells you which list is the safe one ----------------------
  await p.click('#btnLists'); await p.waitForTimeout(200);
  const rows = await p.evaluate(() => [...document.querySelectorAll('#listRows .listrow')]
    .map(x => x.textContent.replace(/\s+/g, ' ').trim()));
  ck('the master is marked in the switcher', rows.some(t => /All leads.*master/.test(t)), rows.join(' | '));
  ck('  ...and campaign lists are not', !rows.some(t => /Q3 campaign.*master/.test(t)), rows.join(' | '));
  await p.keyboard.press('Escape'); await p.waitForTimeout(150);

  // --- capture: a lead added to a campaign list lands on the master -----------
  await p.evaluate(() => switchList('c1'));
  await p.waitForTimeout(600);
  await p.evaluate(() => {
    landLead({ id: 'x1', firstName: 'Janet', lastName: 'Melter', email: 'jm@x.com',
               status: 'New', activity: [] });
    save();
  });
  await p.waitForTimeout(1200);
  ck('the lead is on the campaign list', STORE.c1.leads.length === 1, STORE.c1.leads.length);
  ck('  ...AND on the master, without the user doing anything',
     STORE.default.leads.length === 1 && STORE.default.leads[0].lastName === 'Melter',
     STORE.default.leads.map(l => l.lastName));

  // --- capture dedupes against what the master already holds ------------------
  await p.evaluate(() => {
    landLead({ id: 'x2', firstName: 'Janet', lastName: 'Melter', email: 'jm@x.com',
               status: 'New', activity: [] });
    landLead({ id: 'x3', firstName: 'Paul', lastName: 'Okafor', email: 'po@x.com',
               status: 'New', activity: [] });
    save();
  });
  await p.waitForTimeout(1200);
  ck('a duplicate of someone already on the master is not added twice',
     STORE.default.leads.filter(l => l.lastName === 'Melter').length === 1,
     STORE.default.leads.map(l => l.lastName));
  ck('  ...while the genuinely new lead lands', STORE.default.leads.some(l => l.lastName === 'Okafor'),
     STORE.default.leads.map(l => l.lastName));

  // --- deleting from a campaign list never touches the master -----------------
  await p.evaluate(() => { state.leads = state.leads.filter(l => l.lastName !== 'Melter'); save(); });
  await p.waitForTimeout(1000);
  ck('removed from the campaign list', !STORE.c1.leads.some(l => l.lastName === 'Melter'),
     STORE.c1.leads.map(l => l.lastName));
  ck('  ...still on the master — the master is the archive',
     STORE.default.leads.some(l => l.lastName === 'Melter'),
     STORE.default.leads.map(l => l.lastName));

  // --- the master cannot be deleted -------------------------------------------
  await p.evaluate(() => switchList('default'));
  await p.waitForTimeout(700);
  const del = await p.evaluate(() => {
    const d = document.getElementById('btnDeleteList');
    return { disabled: d.disabled, title: d.title };
  });
  ck('the delete button is disabled on the master', del.disabled === true, JSON.stringify(del));
  ck('  ...and its tooltip says why, not just "no"',
     /master list/.test(del.title) && /Campaign lists are the deletable kind/.test(del.title), del.title);

  // --- adding while ON the master does not double-land -------------------------
  const before = STORE.default.leads.length;
  await p.evaluate(() => {
    landLead({ id: 'x4', firstName: 'Rita', lastName: 'Sandoval', email: 'rs@x.com',
               status: 'New', activity: [] });
    save();
  });
  await p.waitForTimeout(1200);
  ck('a lead imported directly into the master lands exactly once',
     STORE.default.leads.filter(l => l.lastName === 'Sandoval').length === 1
     && STORE.default.leads.length === before + 1,
     STORE.default.leads.map(l => l.lastName));

  // --- restore MERGES into the master, never replaces it ----------------------
  const backup = JSON.stringify({ settings: {}, leads: [
    { id: 'b1', firstName: 'Rita', lastName: 'Sandoval', email: 'rs@x.com', status: 'New', activity: [] },
    { id: 'b2', firstName: 'Newton', lastName: 'Fields', email: 'nf@x.com', status: 'New', activity: [] }] });
  await p.setInputFiles('#jsonFile', { name: 'backup.json', mimeType: 'application/json',
                                       buffer: Buffer.from(backup) });
  await p.waitForTimeout(500);
  const q = await p.evaluate(() => document.getElementById('cfMsg').textContent);
  ck('restoring onto the master says ADDED, not replaces', /ADDED to your master list/.test(q), q);
  await p.evaluate(() => cfDone(true));
  await p.waitForTimeout(1200);
  ck('  ...the new lead from the backup landed',
     STORE.default.leads.some(l => l.lastName === 'Fields'), STORE.default.leads.map(l => l.lastName));
  ck('  ...the duplicate did not land twice',
     STORE.default.leads.filter(l => l.lastName === 'Sandoval').length === 1,
     STORE.default.leads.map(l => l.lastName));
  ck('  ...and nothing already on the master was lost',
     STORE.default.leads.some(l => l.lastName === 'Melter'),
     STORE.default.leads.map(l => l.lastName));

  // --- switching lists flushes pending captures --------------------------------
  // switchList saves the outgoing list directly, bypassing save(); a capture
  // that waited for "the next edit" would wait forever if the tab closed.
  await p.evaluate(() => switchList('c1'));
  await p.waitForTimeout(600);
  await p.evaluate(() => {
    landLead({ id: 'x9', firstName: 'Ines', lastName: 'Duarte', email: 'id@x.com',
               status: 'New', activity: [] });
    switchList('default');   // no save() in between, deliberately
  });
  await p.waitForTimeout(1200);
  ck('a capture queued right before switching lists still lands on the master',
     STORE.default.leads.some(l => l.lastName === 'Duarte'),
     STORE.default.leads.map(l => l.lastName));

  // --- stress: capture against a 5,000-lead master ------------------------------
  // Seeded AFTER leaving the master: switching away saves the page's copy of
  // the outgoing list, and seeding first let that save clobber the 5,000 rows
  // — the first version of this test measured a 7-lead master and called it
  // stress. The store is seeded once the page can no longer overwrite it.
  await p.evaluate(() => switchList('c1'));
  await p.waitForTimeout(800);
  STORE.default.leads = Array.from({ length: 5000 }, (_, i) => (
    { id: 'm' + i, firstName: 'F' + i, lastName: 'Ln' + i, email: 'p' + i + '@x.com',
      status: 'New', activity: [] }));
  const t0 = Date.now();
  await p.evaluate(() => {
    landLead({ id: 'y1', firstName: 'Nova', lastName: 'Quist', email: 'nq@x.com',
               status: 'New', activity: [] });
    landLead({ id: 'y2', firstName: 'F17', lastName: 'Ln17', email: 'p17@x.com',
               status: 'New', activity: [] });   // dup of a master row
    save();
  });
  await p.waitForFunction(() => true);
  await p.waitForTimeout(1500);
  const took = Date.now() - t0;
  ck('capture against a 5,000-lead master lands the new lead',
     STORE.default.leads.some(l => l.lastName === 'Quist'), STORE.default.leads.length);
  ck('  ...refuses the duplicate',
     STORE.default.leads.filter(l => l.lastName === 'Ln17').length === 1);
  ck('  ...and every one of the 5,000 survives the merge — append, never replace',
     STORE.default.leads.length === 5001, STORE.default.leads.length);
  ck('  ...and the whole round trip is not pathological', took < 6000, took + 'ms');

  // --- a retried flush while STANDING on the master ----------------------------
  // A failed flush requeues; if the user has switched to the master by the
  // time it retries, writing to the server behind the page's back would be
  // clobbered by the page's own next save. It must land in the page instead.
  await p.evaluate(() => switchList('default'));
  await p.waitForTimeout(800);
  await p.evaluate(() => {
    MASTER_PENDING.push({ id: 'z1', firstName: 'Rex', lastName: 'Abara', email: 'ra@x.com',
                          status: 'New', activity: [] });
    return flushToMaster();
  });
  await p.waitForTimeout(1200);
  ck('the retried capture lands in the page the user is looking at',
     await p.evaluate(() => state.leads.some(l => l.lastName === 'Abara')));
  ck('  ...and reaches the server through the normal save, not behind its back',
     STORE.default.leads.some(l => l.lastName === 'Abara'),
     STORE.default.leads.length);

  ck('no page errors', errs.length === 0, errs.slice(0, 2).join(' | '));
  console.log(fail ? `\nFAILURES: ${fail} of ${n}` : `\nall ${n} checks passed`);
  await b.close(); process.exit(fail ? 1 : 0);
})();
