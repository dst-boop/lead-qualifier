// "User needs to be able to select multiple people at once to Enrich with
//  whitepages" — and both phases of the credit guardrail have to survive the
// plural. The confirmation names the worst-case lookup count before anything
// runs; each lead goes through the same wpLookup as the single button, so the
// number is checked first, the name search runs only on a miss, answered
// leads are skipped, and re-checks stay per-lead. Plus the sortable headers,
// which live on the same table.
const { chromium } = require('playwright');

const feat = o => ({ whitepages: true, ai_qc: false, server_state: true, drive: false,
                     zoominfo: false, edgar: false, zi_mcp: false, opportunities: false,
                     free_sources: true, ...o });
const me = o => ({ signed_in: true, provider: 'password', name: 'ana', email: 'ana@x.com',
                   providers: { google: true }, features: feat(), storage: 'firestore',
                   credits: { month: '2026-08',
                              whitepages: { spent: 2, budget: 100, left: 98, yours_left: 98 } }, ...o });

(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })
    .catch(() => chromium.launch());
  const p = await b.newPage({ viewport: { width: 1500, height: 1000 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  p.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE: ' + m.text()); });

  let verifies = 0, enriches = 0;
  await p.route('**/api/me', r => r.fulfill({ json: me() }));
  await p.route('**/api/settings', r => r.fulfill({ json: { ok: true } }));
  await p.route('**/api/credits', r => r.fulfill({ json: { month: '2026-08',
    whitepages: { spent: 2, budget: 100, left: 98, yours_left: 98 } } }));
  await p.route('**/api/verify-phone', r => { verifies++;
    return r.fulfill({ json: { valid: true, line_type: 'Mobile', name_match: true,
      record: { found: true, age: 61, home_city: 'Rye', home_state: 'NY', mobiles: ['9145550101'],
                read: 99 } } }); });
  await p.route('**/api/enrich', r => { enriches++;
    return r.fulfill({ json: { found: true, age: 62, home_city: 'Nyack', home_state: 'NY',
                               mobiles: ['8455550102'], read: 99, matched_by: 'name' } }); });
  await p.route('**/api/lists', r => r.fulfill({ json: { lists: [{ id: 'default', name: 'All leads', count: 4, role: 'owner', owner: '' }], settings: {} } }));
  await p.route('**/api/lists/*', r => r.request().method() === 'GET'
    ? r.fulfill({ json: { list: { id: 'default', name: 'All leads' }, settings: {}, leads: [
        // a: number to check, nothing known — verify first, home only on a miss.
        { id: 'a', firstName: 'Ada', lastName: 'Zeta', title: 'CFO', employer: 'Boeing', state: 'WA',
          mobilePhone: '(914) 555-0101', email: 'a@x.com', status: 'New', activity: [] },
        // b: no phone at all — straight to the name search.
        { id: 'b', firstName: 'Bea', lastName: 'Young', title: 'VP', employer: 'Acme', state: 'NY',
          email: 'b@x.com', status: 'New', activity: [] },
        // c: fully answered — nothing left to buy.
        { id: 'c', firstName: 'Cara', lastName: 'Xu', title: 'SVP', employer: 'Delta', state: 'GA',
          mobilePhone: '(404) 555-0103', email: 'c@x.com', status: 'New', activity: [],
          pv: { label: 'Mobile · name ✓', ok: true, field: 'mobilePhone' },
          hd: { age: 60, city: 'Atlanta', state: 'GA', mobiles: [], read: 99 } },
        // d: checked before the app read whole records — a re-check, which is
        // a deliberate per-lead re-spend and must NOT be swept into bulk.
        { id: 'd', firstName: 'Dev', lastName: 'Waters', title: 'EVP', employer: 'Chevron', state: 'TX',
          mobilePhone: '(713) 555-0104', email: 'd@x.com', status: 'New', activity: [],
          pv: { label: 'Mobile', ok: true, field: 'mobilePhone' } }] } })
    : r.fulfill({ json: { ok: true, lists: [] } }));

  let fail = 0, n = 0;
  const ck = (name, c, d) => { n++; console.log((c ? 'ok   ' : 'FAIL ') + name + (d !== undefined ? '  ' + d : '')); if (!c) fail++; };

  await p.goto('http://127.0.0.1:8099/', { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => window.ME && typeof wpPlan === 'function', null, { timeout: 15000 });
  await p.waitForTimeout(600);

  // --- selection --------------------------------------------------------------
  ck('every row carries a checkbox', await p.evaluate(() =>
     document.querySelectorAll('#rows .selbox').length === 4));
  await p.click('#selAll');
  await p.waitForTimeout(250);
  const bar = await p.evaluate(() => ({
    hidden: document.getElementById('bulkBar').hidden,
    text: document.getElementById('bulkCount').textContent }));
  ck('select-all raises the action bar', bar.hidden === false, JSON.stringify(bar));
  ck('  ...which counts who actually has a lookup left — 2 of the 4',
     /4 selected/.test(bar.text) && /2 with a WhitePages lookup left/.test(bar.text), bar.text);
  ck('  ...and prices the worst case, not a promise', /4 lookups max/.test(bar.text), bar.text);
  ck('ticking a box does not open the record', await p.evaluate(() => expanded === null));

  // --- the ask, before the spend ----------------------------------------------
  await p.click('#bulkWp'); await p.waitForTimeout(300);
  const q = await p.evaluate(() => document.getElementById('cfMsg').textContent);
  ck('the confirmation names the count and worst case',
     /2 leads/.test(q) && /worst case 4 lookups/.test(q), q.slice(0, 110));
  ck('  ...says the answered are skipped', /2 already answered are skipped/.test(q), q.slice(-120));
  ck('  ...and shows the allowance', /98 of your monthly lookups left/.test(q), q.slice(-80));
  await p.evaluate(() => cfDone(false)); await p.waitForTimeout(300);
  ck('saying no spends nothing', verifies === 0 && enriches === 0);

  // --- the run ----------------------------------------------------------------
  await p.click('#bulkWp'); await p.waitForTimeout(300);
  await p.evaluate(() => cfDone(true));
  await p.waitForTimeout(1500);
  ck('the lead with a number got the cheap call, once', verifies === 1, verifies);
  ck('  ...and its record filled the household, so no second lookup for her',
     await p.evaluate(() => !!(state.leads.find(L => L.id === 'a').hd)) && enriches === 1, enriches);
  ck('the phoneless lead went straight to the name search',
     await p.evaluate(() => !!(state.leads.find(L => L.id === 'b').hd)));
  ck('the answered lead was not touched',
     await p.evaluate(() => { const L = state.leads.find(x => x.id === 'c'); return L.hd.city === 'Atlanta'; }));
  ck('the re-check candidate was left for its own per-lead button',
     await p.evaluate(() => !state.leads.find(x => x.id === 'd').hd));
  ck('afterwards the selection clears and the bar goes away',
     await p.evaluate(() => document.getElementById('bulkBar').hidden === true));

  // --- sortable headers -------------------------------------------------------
  await p.click('#tbl th.sortable[data-sort="name,nameDesc"]'); await p.waitForTimeout(250);
  const names1 = await p.evaluate(() => [...document.querySelectorAll('#rows .name')].map(e => e.textContent.trim()));
  ck('clicking Name sorts A to Z by last name',
     names1.join('|') === 'Dev Waters|Cara Xu|Bea Young|Ada Zeta', names1.join('|'));
  ck('  ...and the select tells the same story',
     await p.evaluate(() => document.getElementById('fSort').value === 'name'));
  ck('  ...with the arrow on the header',
     await p.evaluate(() => document.querySelector('#tbl th.sortable[data-sort="name,nameDesc"]').dataset.dir !== ''));
  await p.click('#tbl th.sortable[data-sort="name,nameDesc"]'); await p.waitForTimeout(250);
  const names2 = await p.evaluate(() => [...document.querySelectorAll('#rows .name')].map(e => e.textContent.trim()));
  ck('clicking again flips it', names2.join('|') === 'Ada Zeta|Bea Young|Cara Xu|Dev Waters', names2.join('|'));
  await p.click('#tbl th.sortable[data-sort="employer,employerDesc"]'); await p.waitForTimeout(250);
  ck('Employer sorts too', await p.evaluate(() =>
     [...document.querySelectorAll('#rows .subline')].slice(0, 1)[0].textContent.trim() === 'Acme'));

  ck('no page errors', errs.length === 0, errs.slice(0, 2).join(' | '));
  console.log(fail ? `\nFAILURES: ${fail} of ${n}` : `\nall ${n} checks passed`);
  await b.close(); process.exit(fail ? 1 : 0);
})();
