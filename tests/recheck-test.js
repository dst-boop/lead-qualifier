// "I already pressed the 📞 button once for her. It goes away after being
// pressed."
//
// The row button was rendered on `!L.pv`, so one press hid it for good. That
// was tolerable when the check returned three fields and re-running bought
// nothing. It stopped being tolerable the moment the check started returning
// the whole person record: every lead checked under the old code holds a
// verdict, no record, and no way to ask for one.
//
// So the rule is: the button is gone only when there is nothing more to learn.
// A lead with a verdict but no record gets a distinct button that says what
// re-running would buy, and any checked lead can be re-checked from the panel
// behind a confirm, because it spends a credit.
const { chromium } = require('playwright');

const feat = o => ({ whitepages: true, ai_qc: false, server_state: true, drive: false,
                     zoominfo: false, edgar: false, zi_mcp: false, opportunities: false, ...o });
const me = o => ({ signed_in: true, provider: 'google', name: 'Dan', email: 'dan@fpa.com',
                   providers: { google: true }, features: feat(), storage: 'firestore', ...o });

// Three states that must look different on the row.
const LEADS = [
  // never checked
  { id: 'a', firstName: 'Ada', lastName: 'Alpha', employer: 'Meridian',
    mobilePhone: '(973) 555-0142', status: 'New', activity: [] },
  // checked under the old code: a verdict, but no record was ever kept
  { id: 'b', firstName: 'Bea', lastName: 'Bravo', employer: 'Meridian',
    mobilePhone: '(973) 555-0143', status: 'New', activity: [],
    pv: { label: 'Mobile · name ✓', ok: true, field: 'mobilePhone', wrong: false } },
  // checked under the new code: verdict and record both present
  { id: 'c', firstName: 'Cara', lastName: 'Charlie', employer: 'Halstead',
    mobilePhone: '(207) 555-0118', status: 'New', activity: [],
    pv: { label: 'Mobile · name ✓', ok: true, field: 'mobilePhone', wrong: false },
    hd: { owner: 'Cara Charlie', dob: { year: 1966, month: 2, day: 0 }, aliases: [],
          mobiles: ['(207) 555-0118'], phoneRecords: [], emailRecords: [], jobs: [],
          properties: [], relatives: [], priorPlaces: [] } },
  // no number at all — nothing to check, under any rule
  { id: 'd', firstName: 'Dev', lastName: 'Delta', employer: 'Cordova',
    mobilePhone: '', status: 'New', activity: [] }];

const RECORD = {
  owner: 'Bea Bravo', aliases: ['Bea Hausfeld'], age: 59,
  dob: { year: 1966, month: 2, day: 0, text: 'Feb 1966' },
  home_street: '2 Oak St', home_city: 'Renton', home_state: 'WA', home_zip: '98055',
  mobiles: ['(973) 555-0143'],
  phone_records: [{ number: '(973) 555-0143', type: 'Mobile', carrier: 'T-Mobile USA' }],
  phones_total: 3, addresses_total: 4, emails: ['bea@home.com'],
  email_records: [{ email: 'bea@home.com', type: 'personal', recent: true }],
  jobs: [], properties: [], properties_owned: 0, prior_places: [], relatives: [] };

(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })
    .catch(() => chromium.launch());
  const ctx = await b.newContext({ viewport: { width: 1500, height: 1000 } });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  p.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE: ' + m.text()); });

  let who = me(), calls = 0;
  await p.route('**/api/me', r => r.fulfill({ json: who }));
  await p.route('**/api/settings', r => r.fulfill({ json: { ok: true } }));
  await p.route('**/api/lists', r => r.fulfill({ json: { lists: [{ id: 'default', name: 'My leads', count: 4, role: 'owner', owner: '' }], settings: {} } }));
  await p.route('**/api/lists/*', r => r.request().method() === 'GET'
    ? r.fulfill({ json: { list: { id: 'default', name: 'My leads' }, settings: {}, leads: JSON.parse(JSON.stringify(LEADS)) } })
    : r.fulfill({ json: { ok: true, lists: [] } }));
  await p.route('**/api/verify-phone', r => { calls++; r.fulfill({ json: {
    valid: true, line_type: 'Mobile', carrier: 'T-Mobile USA', owner: 'Bea Bravo',
    name_match: true, owner_city: 'Renton', owner_state: 'WA', same_household: true,
    record: RECORD } }); });

  let fail = 0, n = 0;
  const ck = (name, c, d) => { n++; console.log((c ? 'ok   ' : 'FAIL ') + name + (d !== undefined ? '  ' + d : '')); if (!c) fail++; };
  const load = async () => {
    await p.goto('http://127.0.0.1:8099/', { waitUntil: 'domcontentloaded' });
    await p.evaluate(() => localStorage.clear());
    await p.goto('http://127.0.0.1:8099/', { waitUntil: 'domcontentloaded' });
    await p.waitForFunction(() => window.ME && window.ME.signed_in && typeof canVerify === 'function',
                            null, { timeout: 15000 });
    await p.waitForTimeout(600);
  };
  // Buttons on a lead's row, by the phone glyph they carry.
  const rowBtns = name => p.evaluate(who => {
    const tr = [...document.querySelectorAll('#rows tr.lead')].find(t => t.textContent.includes(who));
    if (!tr) return null;
    return [...tr.querySelectorAll('button')].map(x => x.textContent.trim())
      .filter(t => /☎|📞/.test(t));
  }, name);

  await load();

  // --- the reported bug -------------------------------------------------------
  ck('a lead never checked offers the check', (await rowBtns('Ada')).length === 1,
     JSON.stringify(await rowBtns('Ada')));
  const bea = await rowBtns('Bea');
  ck('a lead checked before the record was read still offers something',
     bea.length === 1, JSON.stringify(bea));
  // This is the bug in one line: it used to be zero.
  ck('  ...which is the whole point — it used to be nothing', bea.length > 0);
  ck('  ...and it is a different button, not the first-time one',
     bea[0] !== (await rowBtns('Ada'))[0], JSON.stringify([bea[0], (await rowBtns('Ada'))[0]]));
  const tip = await p.evaluate(() => {
    const tr = [...document.querySelectorAll('#rows tr.lead')].find(t => t.textContent.includes('Bea'));
    return [...tr.querySelectorAll('button')].map(x => x.title).find(t => /re-check|Re-check/i.test(t)) || '';
  });
  ck('  ...whose tooltip says what re-running buys',
     /date of birth/.test(tip), tip.slice(0, 80));
  ck('  ...and that it costs a lookup', /1 lookup/.test(tip), tip.slice(-30));

  // A lead already read in full does not need a row button; the panel has one.
  ck('a lead whose record was already read has no row button',
     (await rowBtns('Cara')).length === 0, JSON.stringify(await rowBtns('Cara')));
  ck('a lead with no number has none either',
     (await rowBtns('Dev')).length === 0, JSON.stringify(await rowBtns('Dev')));

  // --- the panel offers a re-check for anything already checked ---------------
  await p.evaluate(() => toggleDetail('c'));
  await p.waitForTimeout(300);
  ck('the panel offers a re-check on a fully-read lead',
     await p.evaluate(() => !![...document.querySelectorAll('button')]
       .find(x => /Re-check this number/.test(x.textContent))));
  ck('  ...saying plainly that it spends a lookup',
     /Spends one lookup/.test(await p.evaluate(() => document.body.innerText)));
  await p.evaluate(() => toggleDetail('c'));

  await p.evaluate(() => toggleDetail('b'));
  await p.waitForTimeout(300);
  ck('  ...and on a half-read one, explains what is missing',
     /re-checking pulls the rest of it/i.test(await p.evaluate(() => document.body.innerText)));
  await p.evaluate(() => toggleDetail('b'));

  // --- a credit is never spent by a stray click -------------------------------
  calls = 0;
  await p.evaluate(() => { verifyLead('b', true); });
  await p.waitForTimeout(400);
  ck('re-checking asks first', await p.evaluate(() =>
    document.getElementById('mConfirm').classList.contains('open')));
  ck('  ...naming the cost in the question',
     /spends one lookup/i.test(await p.evaluate(() => document.getElementById('cfMsg').textContent)),
     await p.evaluate(() => document.getElementById('cfMsg').textContent.slice(0, 60)));
  await p.evaluate(() => cfDone(false));
  await p.waitForTimeout(400);
  ck('  ...and saying no spends nothing', calls === 0, calls);

  // --- saying yes does the thing ---------------------------------------------
  await p.evaluate(() => { verifyLead('b', true); });
  await p.waitForTimeout(300);
  await p.evaluate(() => cfDone(true));
  await p.waitForTimeout(700);
  ck('saying yes runs the lookup', calls === 1, calls);
  const after = await p.evaluate(() => {
    const L = state.leads.find(x => x.id === 'b');
    return { hasHd: !!(L.hd && L.hd.dob), dob: dobLabel(L), sell: sellable(L).label,
             btns: [...document.querySelectorAll('#rows tr.lead')]
               .find(t => t.textContent.includes('Bea'))
               .querySelectorAll('button').length };
  });
  ck('  ...and the record lands on the lead', after.hasHd === true);
  ck('  ...so the birth date is there now', after.dob === 'Feb 1966', after.dob);
  ck('  ...and the badge names a month', /59½/.test(after.sell), after.sell);
  // Having learned everything, the row goes quiet again.
  const beaNow = await rowBtns('Bea');
  ck('  ...and the re-check button retires once there is nothing left to learn',
     beaNow.length === 0, JSON.stringify(beaNow));

  // A first check is not a re-check and must not nag.
  calls = 0;
  await p.evaluate(() => { verifyLead('a'); });
  await p.waitForTimeout(500);
  ck('a first check does not ask for confirmation', calls === 1, calls);
  ck('  ...and no dialog is left open', await p.evaluate(() =>
    !document.getElementById('mConfirm').classList.contains('open')));

  // --- the integration being off is a different thing from being done ---------
  who = me({ features: feat({ whitepages: false }) });
  await load();
  ck('with WhitePages unconfigured no lead offers a check',
     (await rowBtns('Ada')).length === 0 && (await rowBtns('Bea')).length === 0);
  ck('  ...and the panel does not offer one either',
     await p.evaluate(() => { toggleDetail('c');
       return ![...document.querySelectorAll('button')]
         .some(x => /Re-check this number/.test(x.textContent)); }));

  ck('no page errors', errs.length === 0, errs.slice(0, 2).join(' | '));
  console.log(fail ? `\nFAILURES: ${fail} of ${n}` : `\nall ${n} checks passed`);
  await b.close(); process.exit(fail ? 1 : 0);
})();
