// "This is all the information found on Gary. It's great, but it's not laid
//  out well and it's too much. There needs to be simple easy to read data
//  that you can drill down into for more."
//
// So the record leads with a card — the facts a call runs on, each with its
// basis — and every long section folds behind a one-line gist. What is
// guarded here: the card tells the truth (an inferred age is marked, a moved
// lead shows both states), the folds start closed, a fold the operator
// opened stays open across the re-render every action triggers, and the
// __unfold hook the content suites rely on actually unfolds everything.
const { chromium } = require('playwright');

const feat = o => ({ whitepages: true, ai_qc: false, server_state: true, drive: false,
                     zoominfo: false, edgar: false, zi_mcp: false, opportunities: false,
                     free_sources: true, web_research: true, attom: true, ...o });
const me = o => ({ signed_in: true, provider: 'password', name: 'ana', email: 'ana@x.com',
                   providers: { google: true }, features: feat(), storage: 'firestore', ...o });

const GARY = { id: 'g', firstName: 'Gary', lastName: 'Wesselmann', title: 'Senior PM',
  employer: 'Paynecrest', state: 'TN', mobilePhone: '(314) 954-1945', email: 'g@x.com',
  status: 'New', activity: [{ t: Date.now(), k: 'note', d: 'called' }], notes: '',
  pv: { label: 'Mobile · name ✓', ok: true, field: 'mobilePhone' },
  hd: { dob: '1965-06', age: 61, city: 'Chesterfield', state: 'MO', mobiles: ['3149541945'],
        props: 1, read: 99, priorPlaces: ['Mascoutah, IL'], relatives: ['Norma J Wesselmann'],
        emailRecords: [{ email: 'g@sachsco.com', type: 'personal' }] },
  attom: { avm: 543407, score: 93, owners: ['GARY R WESSELMANN'], addr: '2260 Sycamore Dr' },
  plan: { avg: 187007, year: 2025 } };
// A thin lead: no household, no verification — the card must not invent.
const THIN = { id: 't', firstName: 'Bea', lastName: 'Young', title: 'VP', employer: 'Acme',
  state: 'NY', email: 'b@x.com', status: 'New', activity: [], notes: '', gradYear: '1987' };

(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })
    .catch(() => chromium.launch());
  const p = await b.newPage({ viewport: { width: 1500, height: 1000 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.route('**/api/me', r => r.fulfill({ json: me() }));
  await p.route('**/api/settings', r => r.fulfill({ json: { ok: true } }));
  await p.route('**/api/lists', r => r.fulfill({ json: { lists: [{ id: 'default', name: 'All leads', count: 2, role: 'owner', owner: '' }], settings: {} } }));
  await p.route('**/api/lists/*', r => r.request().method() === 'GET'
    ? r.fulfill({ json: { list: { id: 'default', name: 'All leads' }, settings: {}, leads: [GARY, THIN] } })
    : r.fulfill({ json: { ok: true, lists: [] } }));

  let fail = 0, n = 0;
  const ck = (name, c, d) => { n++; console.log((c ? 'ok   ' : 'FAIL ') + name + (d !== undefined ? '  ' + d : '')); if (!c) fail++; };

  await p.goto('http://127.0.0.1:8099/', { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => window.__booted === true, null, { timeout: 15000 });
  await p.evaluate(() => toggleDetail('g'));
  await p.waitForTimeout(400);

  // --- the card ---------------------------------------------------------------
  const card = await p.evaluate(() => [...document.querySelectorAll('.leadcard .fact')]
    .map(f => [f.querySelector('b').textContent, f.querySelector('.fv').textContent,
               (f.querySelector('small') || {}).textContent || '']));
  const get = l => card.find(c => c[0] === l) || [];
  ck('the card leads with the facts a call runs on', card.length >= 6, JSON.stringify(card.map(c => c[0])));
  ck('age carries its basis', get('Age')[1] === '61' && /born Jun 1965/.test(get('Age')[2]), JSON.stringify(get('Age')));
  ck('59½ reads as already reached, with the month', get('59½')[1] === 'Reached' && /Dec 2024/.test(get('59½')[2]), JSON.stringify(get('59½')));
  ck('lives-in shows where they actually live, and flags the list state',
     /Chesterfield, MO/.test(get('Lives in')[1]) && /list says TN/.test(get('Lives in')[2]), JSON.stringify(get('Lives in')));
  ck('the home shows the Attom estimate', get('Home')[1] === '$543K', JSON.stringify(get('Home')));
  ck('the phone reads verified', get('Phone')[1] === 'Verified', JSON.stringify(get('Phone')));
  ck('the plan average rides along', /187,007/.test(get('Avg plan')[1]), JSON.stringify(get('Avg plan')));

  // --- the folds --------------------------------------------------------------
  const folds = await p.evaluate(() => ({
    total: document.querySelectorAll('tr.detail details.drill').length,
    open: document.querySelectorAll('tr.detail details.drill[open]').length,
    gists: [...document.querySelectorAll('tr.detail details.drill summary .gist')].map(g => g.textContent) }));
  ck('the long sections are folded', folds.total >= 6, folds.total);
  ck('  ...and start closed — simple first, depth on demand', folds.open === 0, folds.open);
  ck('  ...each with a gist doing the summarising',
     folds.gists.some(g => /Chesterfield, MO/.test(g)) && folds.gists.some(g => /est\./.test(g)),
     JSON.stringify(folds.gists));
  const before = await p.evaluate(() => document.body.innerText);
  ck('folded content stays out of the reading flow', !/Mascoutah/.test(before));
  ck('the notes box is not behind a fold — it is a work tool', /Notes \/ comments/i.test(before));
  ck('so is the research panel', /Look this person up/i.test(before));

  // --- drill in, and the place survives the re-render -------------------------
  await p.evaluate(() => { document.querySelectorAll('tr.detail details.drill')[1].open = true; });
  await p.waitForTimeout(200);
  ck('opening a fold shows the depth', /Also known as|Born/.test(await p.evaluate(() => document.body.innerText)));
  await p.evaluate(() => render());
  await p.waitForTimeout(300);
  ck('a re-render keeps the fold the operator opened',
     await p.evaluate(() => document.querySelectorAll('tr.detail details.drill[open]').length === 1));

  // --- a thin lead does not pretend -------------------------------------------
  await p.evaluate(() => { expanded = null; toggleDetail('t'); });
  await p.waitForTimeout(300);
  const thin = await p.evaluate(() => [...document.querySelectorAll('.leadcard .fact')]
    .map(f => [f.querySelector('b').textContent, f.querySelector('.fv').textContent,
               (f.querySelector('small') || {}).textContent || '']));
  const tg = l => thin.find(c => c[0] === l) || [];
  ck('an inferred age is marked as worked out, never presented bare',
     /graduated 1987/.test(tg('Age')[2]), JSON.stringify(tg('Age')));
  ck('an unchecked phone says so', tg('Phone')[1] === 'Unchecked', JSON.stringify(tg('Phone')));

  // --- the hook the content suites lean on ------------------------------------
  await p.evaluate(() => { window.__unfold = true; expanded = null; toggleDetail('g'); });
  await p.waitForTimeout(300);
  ck('__unfold opens every fold for the content suites', await p.evaluate(() =>
     document.querySelectorAll('tr.detail details.drill:not([open])').length === 0));
  ck('  ...so the depth is all present', /Mascoutah/.test(await p.evaluate(() => document.body.innerText)));

  ck('no page errors', errs.length === 0, errs.slice(0, 2).join(' | '));
  console.log(fail ? `\nFAILURES: ${fail} of ${n}` : `\nall ${n} checks passed`);
  await b.close(); process.exit(fail ? 1 : 0);
})();
