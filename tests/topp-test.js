// "Lead Qualifier needs to merge into Prospect Pilot." The move is a file: the
// leads in the exact columns ProspectPilot's contact import reads. The headers
// are a contract with that importer (prospectpilot.io, prospect-data-quality.mjs
// CONTACT_ALIASES / ZOOMINFO_ALIASES), so they are pinned here verbatim.
const { chromium } = require('playwright');

const feat = o => ({ whitepages: false, ai_qc: false, server_state: true, drive: false,
                     zoominfo: false, edgar: false, zi_mcp: false, opportunities: false,
                     free_sources: false, ...o });
const me = { signed_in: true, provider: 'password', name: 'ana', email: 'ana@x.com',
             providers: { google: true }, features: feat(), storage: 'firestore' };

const LEADS = [
  { id: 'a', firstName: 'Ada', lastName: 'Zeta', title: 'CFO', employer: 'Boeing', state: 'WA', city: 'Seattle',
    email: 'ada@boeing.com', directPhone: '(206) 555-0100', mobilePhone: '(206) 555-0101',
    linkedinUrl: 'https://www.linkedin.com/in/ada-zeta', contactId: '12345', accuracy: '95',
    jobStartDate: '2004-03-01', mgmtLevel: 'C Level Exec', directDnc: 'false', mobileDnc: 'true',
    status: 'Set', activity: [], hd: { age: 61, mobiles: ['2065550199'] }, qc: { grade: 'A' } },
  { id: 'b', firstName: 'Bea', lastName: 'Young, Jr.', title: 'VP "Ops"', employer: 'Acme', state: 'NY',
    email: 'b@acme.com', status: 'Not Interested', activity: [] },
  { id: 'c', firstName: 'Cy', lastName: '', employer: 'Delta', status: 'New', activity: [] },
];

(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })
    .catch(() => chromium.launch());
  const p = await b.newPage({ viewport: { width: 1400, height: 900 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  p.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE: ' + m.text()); });
  await p.route('**/api/me', r => r.fulfill({ json: me }));
  await p.route('**/api/settings', r => r.fulfill({ json: { ok: true } }));
  await p.route('**/api/lists', r => r.fulfill({ json: { lists: [{ id: 'default', name: 'All leads', count: 3, role: 'owner', owner: '' }], settings: {} } }));
  await p.route('**/api/lists/*', r => r.request().method() === 'GET'
    ? r.fulfill({ json: { list: { id: 'default', name: 'All leads' }, settings: {}, leads: LEADS } })
    : r.fulfill({ json: { ok: true, lists: [] } }));

  let fail = 0, n = 0;
  const ck = (name, c, d) => { n++; console.log((c ? 'ok   ' : 'FAIL ') + name + (d !== undefined ? '  ' + d : '')); if (!c) fail++; };

  await p.goto('http://127.0.0.1:8099/', { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => window.ME && typeof ppFiles === 'function' && state.leads.length === 3, null, { timeout: 15000 });
  await p.evaluate(() => { window.__files = []; window.dl = (blob, name) => blob.text().then(t => __files.push({ name, t })); });

  await p.evaluate(() => document.getElementById('btnToPP').click());
  await p.waitForFunction(() => __files.length === 1, null, { timeout: 5000 });
  const f = await p.evaluate(() => __files[0]);
  const lines = f.t.split('\r\n');
  ck('one file, named for ProspectPilot', /^prospectpilot-import-\d{4}-\d{2}-\d{2}\.csv$/.test(f.name), f.name);
  ck('the headers are the ones ProspectPilot\'s importer reads',
     lines[0] === 'First Name,Last Name,Company,Title,Email,Direct Phone,Mobile Phone,LinkedIn URL,City,State,Country,Management Level,Suppressed,ZoomInfo Contact ID,Contact Accuracy Score,Job Start Date,Direct Phone Do Not Call,Mobile Phone Do Not Call', lines[0]);
  ck('a lead with no last name is left out, the other two carry', lines.length === 3, lines.length);
  ck('identity, routes, ZoomInfo id and do-not-call flags carry',
     lines[1] === 'Ada,Zeta,Boeing,CFO,ada@boeing.com,(206) 555-0100,(206) 555-0101,https://www.linkedin.com/in/ada-zeta,Seattle,WA,US,C Level Exec,no,12345,95,2004-03-01,false,true', lines[1]);
  ck('Not Interested arrives suppressed, and commas and quotes are escaped',
     lines[2] === 'Bea,"Young, Jr.",Acme,"VP ""Ops""",b@acme.com,,,,,NY,US,,yes,,,,,', lines[2]);
  ck('household mobiles, age and grades do not travel',
     !f.t.includes('2065550199') && !f.t.includes('61') && !/,A,|grade/i.test(f.t));
  const toast = await p.evaluate(() => (document.getElementById('toast') || {}).textContent || '');
  ck('the operator is told what to do, what was left out, and to delete the file',
     /2 leads ready for ProspectPilot/.test(toast) && /1 without a name/.test(toast) && /delete it once it is uploaded/.test(toast), toast);

  // Over the importer's 5,000-row ceiling, the list comes down in parts.
  const parts = await p.evaluate(() => {
    const many = Array.from({ length: 10001 }, (_, i) => ({ firstName: 'F' + i, lastName: 'L', employer: 'Co' }));
    const out = ppFiles(many);
    return { n: out.files.length, sizes: out.files.map(t => t.split('\r\n').length - 1),
             headed: out.files.every(t => t.startsWith('First Name,')) };
  });
  ck('10,001 leads come down as three files of at most 5,000',
     parts.n === 3 && parts.sizes.join() === '5000,5000,1' && parts.headed, JSON.stringify(parts));
  ck('do-not-call values are normalised, unknowns left blank', await p.evaluate(() =>
     [ppFlag('True'), ppFlag('N'), ppFlag('maybe'), ppFlag(undefined)].join() === 'true,false,,'));

  ck('no page errors', errs.length === 0, errs.slice(0, 2).join(' | '));
  console.log(fail ? `\nFAILURES: ${fail} of ${n}` : `\nall ${n} checks passed`);
  await b.close(); process.exit(fail ? 1 : 0);
})();
