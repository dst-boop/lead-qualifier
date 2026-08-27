// "Leads need to be searchable by age" — plus the 📞+ button that did not come
// back.
//
// Age is the axis this whole practice turns on and it was the one thing the
// table could not be narrowed by. The subtlety is not the range; it is the
// leads with no age at all. They are not old and they are not young, and a
// range filter that silently drops them hides exactly the leads most worth
// enriching. So they are set aside, counted, and reported.
const { chromium } = require('playwright');

const feat = o => ({ whitepages: true, ai_qc: false, server_state: true, drive: false,
                     zoominfo: false, edgar: false, zi_mcp: false, opportunities: false, ...o });
const me = o => ({ signed_in: true, provider: 'google', name: 'Dan', email: 'dan@fpa.com',
                   providers: { google: true }, features: feat(), storage: 'firestore', ...o });

const Y = new Date().getFullYear();
const hd = (o) => Object.assign({ read: 2, owner: 'x', aliases: [], mobiles: [],
  phoneRecords: [], emailRecords: [], jobs: [], properties: [], relatives: [],
  priorPlaces: [] }, o);

const LEADS = [
  // age 62, from a birth date
  { id: 'a', firstName: 'Ada', lastName: 'Alpha', employer: 'Meridian', title: 'CFO',
    mobilePhone: '(973) 555-0142', email: 'a@m.com', status: 'New', activity: [],
    hd: hd({ dob: { year: Y - 62, month: 1, day: 2 } }) },
  // age 55, from a birth date
  { id: 'b', firstName: 'Bea', lastName: 'Bravo', employer: 'Meridian', title: 'CFO',
    mobilePhone: '(973) 555-0143', email: 'b@m.com', status: 'New', activity: [],
    hd: hd({ dob: { year: Y - 55, month: 1, day: 2 } }) },
  // age 48, from an SEC proxy
  { id: 'c', firstName: 'Cara', lastName: 'Charlie', employer: 'Halstead', title: 'VP',
    mobilePhone: '(207) 555-0118', email: 'c@h.com', status: 'New', activity: [],
    edgar: { age: 48, asOf: '2026-01' } },
  // no age at all, and nothing to infer one from
  { id: 'd', firstName: 'Dev', lastName: 'Delta', employer: 'Cordova', title: 'Director',
    mobilePhone: '(212) 555-0155', email: 'd@c.com', status: 'New', activity: [] },
  // no age either — the pair proves the count, not just the flag
  { id: 'e', firstName: 'Eve', lastName: 'Echo', employer: 'Cordova', title: 'Director',
    mobilePhone: '(212) 555-0156', email: 'e@c.com', status: 'New', activity: [] },
  // checked under the old code: a verdict, and an hd with none of the new fields
  { id: 'f', firstName: 'Fay', lastName: 'Foxtrot', employer: 'Halstead', title: 'VP',
    mobilePhone: '(207) 555-0119', email: 'f@h.com', status: 'New', activity: [],
    pv: { label: 'Mobile · name ✓', ok: true, field: 'mobilePhone', wrong: false },
    hd: { owner: 'Fay Foxtrot', age: 57, city: 'Kent', state: 'WA', mobiles: [] } }];

(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })
    .catch(() => chromium.launch());
  const ctx = await b.newContext({ viewport: { width: 1600, height: 1000 } });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  p.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE: ' + m.text()); });

  await p.route('**/api/me', r => r.fulfill({ json: me() }));
  await p.route('**/api/settings', r => r.fulfill({ json: { ok: true } }));
  await p.route('**/api/lists', r => r.fulfill({ json: { lists: [{ id: 'default', name: 'My leads', count: 6, role: 'owner', owner: '' }], settings: {} } }));
  await p.route('**/api/lists/*', r => r.request().method() === 'GET'
    ? r.fulfill({ json: { list: { id: 'default', name: 'My leads' }, settings: {}, leads: JSON.parse(JSON.stringify(LEADS)) } })
    : r.fulfill({ json: { ok: true, lists: [] } }));

  let fail = 0, n = 0;
  const ck = (name, c, d) => { n++; console.log((c ? 'ok   ' : 'FAIL ') + name + (d !== undefined ? '  ' + d : '')); if (!c) fail++; };
  await p.goto('http://127.0.0.1:8099/', { waitUntil: 'domcontentloaded' });
  await p.evaluate(() => localStorage.clear());
  await p.goto('http://127.0.0.1:8099/', { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => window.ME && window.ME.signed_in && typeof ageBound === 'function',
                          null, { timeout: 15000 });
  await p.waitForTimeout(600);

  const setAge = async (lo, hi) => {
    await p.fill('#fAgeMin', lo === null ? '' : String(lo));
    await p.fill('#fAgeMax', hi === null ? '' : String(hi));
    await p.waitForTimeout(300);
  };
  const shown = () => p.evaluate(() => filtered().map(L => L.lastName).sort().join(','));

  // --- the controls exist and read sensibly -----------------------------------
  ck('the toolbar has an age range', await p.evaluate(() =>
    !!document.getElementById('fAgeMin') && !!document.getElementById('fAgeMax')));
  ck('an empty box is no bound, not a bound of zero',
     await p.evaluate(() => ageBound('fAgeMin') === null));
  ck('  ...and nothing is filtered while both are empty',
     await shown() === 'Alpha,Bravo,Charlie,Delta,Echo,Foxtrot', await shown());

  // --- a range ----------------------------------------------------------------
  await setAge(50, 60);
  ck('50 to 60 keeps only the ages in it', await shown() === 'Bravo,Foxtrot', await shown());
  await setAge(59, null);
  ck('a minimum alone is an open top end', await shown() === 'Alpha', await shown());
  await setAge(null, 50);
  ck('a maximum alone is an open bottom end', await shown() === 'Charlie', await shown());
  await setAge(62, 62);
  ck('a single year is allowed', await shown() === 'Alpha', await shown());
  await setAge(90, 99);
  ck('a range nobody is in shows nobody', await shown() === '', '"' + await shown() + '"');

  // --- the leads with no age --------------------------------------------------
  // This is the part that matters. A lead with no age is the one most worth
  // enriching, so it must not vanish quietly.
  await setAge(50, 60);
  const cap = await p.evaluate(() => document.getElementById('rowCap').innerText.replace(/\s+/g, ' '));
  ck('leads with no age are reported, not silently dropped',
     /no age on file/.test(cap), cap);
  ck('  ...and counted correctly — the two with no age, not the one merely out of range',
     /\b2\b/.test(cap), cap);
  ck('  ...with a way to fix it', /enrich/i.test(cap), cap);
  await setAge(null, null);
  const cap2 = await p.evaluate(() => document.getElementById('rowCap').innerText);
  ck('  ...and nothing is said when no range is set', !/no age on file/.test(cap2), cap2);

  // --- sorting ----------------------------------------------------------------
  await p.selectOption('#fSort', 'age'); await p.waitForTimeout(300);
  const oldest = await p.evaluate(() => filtered().map(L => L.lastName).join(','));
  ck('sorting by age puts the oldest first', /^Alpha,Foxtrot,Bravo,Charlie/.test(oldest), oldest);
  // Unknown is not old and not young; either end would read as an answer.
  ck('  ...and the unknown ages last', /Delta,Echo$/.test(oldest), oldest);
  await p.selectOption('#fSort', 'ageAsc'); await p.waitForTimeout(300);
  const youngest = await p.evaluate(() => filtered().map(L => L.lastName).join(','));
  ck('sorting the other way puts the youngest first', /^Charlie,Bravo,Foxtrot,Alpha/.test(youngest), youngest);
  ck('  ...and still the unknown ages last', /Delta,Echo$/.test(youngest), youngest);
  await p.selectOption('#fSort', 'score'); await p.waitForTimeout(300);

  // --- jumping to a lead must not land on an empty table ----------------------
  await setAge(20, 25);
  await p.evaluate(() => focusLead('a'));
  await p.waitForTimeout(400);
  ck('jumping to a lead clears the age range rather than showing nothing',
     await p.evaluate(() => document.getElementById('fAgeMin').value) === '');
  ck('  ...and the lead is actually on screen',
     await p.evaluate(() => filtered().some(L => L.id === 'a')));

  // --- the button that did not come back --------------------------------------
  // Reported: "The button didnt reappear, but I was able to find recheck".
  // Fay was checked under the old code AND enriched under it, so she has an
  // hd — which the first version read as "already read in full".
  await p.fill('#q', ''); await p.waitForTimeout(300);
  ck('a lead with an old-style household record is not counted as fully read',
     await p.evaluate(() => !fullyRead(state.leads.find(L => L.id === 'f'))));
  // The phone glyphs moved into the row's research panel; the question is the
  // same one, asked of the function that decides what is still worth buying.
  ck('  ...so the re-check is still offered', await p.evaluate(() =>
    researchActions(state.leads.find(L => L.id === 'f')).some(a => a[0] === 'recheck')));
  ck('a record written by the current reader IS fully read',
     await p.evaluate(() => fullyRead(state.leads.find(L => L.id === 'a'))));
  ck('  ...so no re-check is offered on it', await p.evaluate(() =>
    !researchActions(state.leads.find(L => L.id === 'a')).some(a => a[0] === 'recheck')));
  // She has never been phone-checked at all, so the first-time check is right.
  ck('  ...though a first check still is, since she has never had one', await p.evaluate(() =>
    researchActions(state.leads.find(L => L.id === 'a')).some(a => a[0] === 'verifyLead')));
  ck('a lead never checked is unaffected either way',
     await p.evaluate(() => !fullyRead(state.leads.find(L => L.id === 'd'))));

  ck('no page errors', errs.length === 0, errs.slice(0, 2).join(' | '));
  console.log(fail ? `\nFAILURES: ${fail} of ${n}` : `\nall ${n} checks passed`);
  await b.close(); process.exit(fail ? 1 : 0);
})();
