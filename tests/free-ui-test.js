// "Why can't we find this information? He's from Knoxville, TN. Use free
// resources better."
//
// Two answers on trial here. The free sources: political donations and SEC
// insider filings, both federal, both with real APIs, rendered with the same
// coverage honesty as the signals panel. And the Knoxville fix itself: the
// lookup failed because the lead row carries the employer's address, the user
// knew the real city, and the app had nowhere to accept that knowledge.
const { chromium } = require('playwright');

const feat = o => ({ whitepages: true, ai_qc: false, server_state: true, drive: false,
                     zoominfo: false, edgar: true, zi_mcp: false, opportunities: false,
                     free_sources: true, ...o });
const me = o => ({ signed_in: true, provider: 'google', name: 'Dan', email: 'dan@fpa.com',
                   providers: { google: true }, features: feat(), storage: 'firestore', ...o });

const LEADS = [
  // The reported case: Greg lives in Knoxville; the list says Atlanta, where
  // the employer is. WhitePages already failed once (hd.rejected is set).
  { id: 'g', firstName: 'Greg', lastName: 'Harmon', title: 'VP Operations',
    employer: 'Cordova Industries', city: 'Atlanta', state: 'GA',
    mobilePhone: '', email: 'g@cordova.com', status: 'New', activity: [],
    hd: { city: '', state: '', mobiles: [], owner: '',
          rejected: 'closest match lives in TN, lead is in GA' } },
  { id: 'b', firstName: 'Bea', lastName: 'Bravo', employer: 'Meridian',
    mobilePhone: '(973) 555-0143', email: 'b@m.com', status: 'New', activity: [] }];

const PUB = {
  sources: { fec: { ran: true, note: '' }, edgar: { ran: true, note: '' } },
  donations: {
    count: 6, total: 5400, biggest: 2800, first: '2018-10-02', latest: '2026-03-11',
    employers: [{ value: 'RETIRED', n: 1, last: '2026-03-11' },
                { value: 'CORDOVA INDUSTRIES', n: 5, last: '2024-10-30' }],
    occupations: [{ value: 'VP OPERATIONS', n: 5, last: '2024-10-30' }],
    places: [{ value: 'Knoxville, TN', n: 6, last: '2026-03-11' }],
    streets: [{ value: '12 Cherokee Trl, Knoxville', n: 6, last: '2026-03-11' }], ytd_max: 2800,
    employer_match: true, says_retired: true },
  filings: [{ form: '4', date: '2025-11-03', person: 'Harmon Gregory (CIK 0009)',
              company: 'CORDOVA INDUSTRIES INC (CIK 0002)',
              url: 'https://www.sec.gov/Archives/edgar/data/2/0002-index.htm' }],
  links: { fec: 'https://www.fec.gov/data/receipts/individual-contributions/?contributor_name=Greg%20Harmon',
           edgar: 'https://www.sec.gov/edgar/search/#/q=%22Greg%20Harmon%22&forms=3,4,5' } };

(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })
    .catch(() => chromium.launch());
  const ctx = await b.newContext({ viewport: { width: 1500, height: 1000 } });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  p.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE: ' + m.text()); });

  let pubBody = PUB, enrichCalls = [], freeCalls = 0;
  await p.route('**/api/me', r => r.fulfill({ json: me() }));
  await p.route('**/api/settings', r => r.fulfill({ json: { ok: true } }));
  await p.route('**/api/lists', r => r.fulfill({ json: { lists: [{ id: 'default', name: 'My leads', count: 2, role: 'owner', owner: '' }], settings: {} } }));
  await p.route('**/api/lists/*', r => r.request().method() === 'GET'
    ? r.fulfill({ json: { list: { id: 'default', name: 'My leads' }, settings: {}, leads: JSON.parse(JSON.stringify(LEADS)) } })
    : r.fulfill({ json: { ok: true, lists: [] } }));
  await p.route('**/api/free-enrich', r => { freeCalls++; r.fulfill({ json: pubBody }); });
  await p.route('**/api/enrich', r => {
    enrichCalls.push(r.request().postDataJSON());
    r.fulfill({ json: { found: true, matched_by: 'name', match_score: 90,
      owner: 'Greg Harmon', aliases: [], age: 60, dob: { year: 1966, month: 2, day: 0, text: 'Feb 1966' },
      home_street: '12 Cherokee Trl', home_city: 'Knoxville', home_state: 'TN', home_zip: '37919',
      mobiles: ['(865) 555-0134'], phone_records: [{ number: '(865) 555-0134', type: 'Mobile', carrier: '' }],
      phones_total: 2, addresses_total: 3, emails: [], email_records: [], jobs: [],
      properties: [], properties_owned: 1, prior_places: [], relatives: [],
      owns_home: null, owner_type: '', co_owners: [] } });
  });

  let fail = 0, n = 0;
  const ck = (name, c, d) => { n++; console.log((c ? 'ok   ' : 'FAIL ') + name + (d !== undefined ? '  ' + d : '')); if (!c) fail++; };
  await p.goto('http://127.0.0.1:8099/', { waitUntil: 'domcontentloaded' });
  await p.evaluate(() => localStorage.clear());
  await p.goto('http://127.0.0.1:8099/', { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => window.ME && window.ME.signed_in && typeof freeLookup === 'function',
                          null, { timeout: 15000 });
  await p.waitForTimeout(600);

  // --- the free lookup --------------------------------------------------------
  // The six research actions moved off the row and into the panel that opens
  // under it: one Research button per row rather than up to eleven glyphs.
  ck('every lead with a surname offers research', await p.evaluate(() =>
    [...document.querySelectorAll('#rows tr.lead')].every(tr =>
      [...tr.querySelectorAll('button')].some(x => /Look this person up/.test(x.title)))));
  ck('  ...and the public record is one of the actions inside it', await p.evaluate(() =>
    researchActions(state.leads.find(x => x.id === 'g')).some(a => a[0] === 'freeLookup')));
  ck('  ...listed as costing nothing', await p.evaluate(() =>
    (researchActions(state.leads.find(x => x.id === 'g')).find(a => a[0] === 'freeLookup') || [])[3] === 'free'));
  await p.evaluate(() => toggleDetail('g', 'research'));
  await p.waitForTimeout(350);
  ck('  ...and the panel says what it looks for, not just its name', await p.evaluate(() =>
    /Political donations/.test(document.getElementById('research-g').textContent)),
    await p.evaluate(() => (document.getElementById('research-g') || {}).textContent || 'no panel'));
  await p.evaluate(() => toggleDetail('g'));
  await p.waitForTimeout(250);

  await p.evaluate(() => freeLookup('g'));
  await p.waitForTimeout(600);
  const g = await p.evaluate(() => state.leads.find(x => x.id === 'g'));
  ck('the result lands on the lead', g.pub && g.pub.donations.count === 6);
  ck('  ...and the activity log says it cost nothing',
     /free — no lookups spent/.test(g.activity[g.activity.length - 1].note || '') ||
     /free — no lookups spent/.test(JSON.stringify(g.activity)), JSON.stringify(g.activity).slice(0, 120));

  await p.evaluate(() => toggleDetail('g'));
  await p.waitForTimeout(300);
  const text = await p.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));
  ck('the panel shows the donations with their span', /6 · \$5,400/.test(text), (text.match(/6 · \$[\d,]+/) || [])[0]);
  // This line is the Knoxville answer: where he told a federal form he lives.
  ck('  ...and where he gave from', /Gave from Knoxville, TN/.test(text));
  ck('  ...explaining why that beats the list address', /where they told a federal form they live/.test(text));
  ck('  ...the street shown as identity confirmation, with its limit stated',
     /12 Cherokee Trl, Knoxville/.test(text) && /not for mailing/.test(text));
  ck('  ...the employer as he reported it, dated', /cordova industries · 2024-10/.test(text));
  ck('the retired report is called out as the event having happened',
     /told the FEC they are retired/i.test(text) && /event having already happened/.test(text));
  ck('the insider filing shows with its meaning', /Form 4 · 2025-11-03/.test(text) && /equity compensation/i.test(text));
  ck('  ...linking to the SEC archive itself', await p.evaluate(() =>
    !![...document.querySelectorAll('a')].find(a => a.href.includes('sec.gov/Archives'))));
  ck('every number is checkable: both source links render', await p.evaluate(() =>
    !![...document.querySelectorAll('a')].find(a => a.href.includes('fec.gov/data/receipts')) &&
    !![...document.querySelectorAll('a')].find(a => a.href.includes('sec.gov/edgar/search'))));

  // --- coverage honesty -------------------------------------------------------
  pubBody = { sources: { fec: { ran: false, reason: 'FEC rate limit hit' },
                         edgar: { ran: true, note: '' } },
              donations: {}, filings: [], links: PUB.links };
  await p.evaluate(() => { state.leads.find(x => x.id === 'b').pub = undefined; });
  await p.evaluate(() => freeLookup('b'));
  await p.waitForTimeout(500);
  await p.evaluate(() => { expanded = null; toggleDetail('b'); });
  await p.waitForTimeout(300);
  const t2 = await p.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));
  ck('a source that did not run is named, not silent', /Not checked: political donations/.test(t2), (t2.match(/Not checked[^.]*/) || [])[0]);
  ck('  ...with the reason', /rate limit/.test(t2));
  ck('  ...while the one that ran reports its empty honestly', /SEC insider filings none found/.test(t2));
  ck('an empty answer neither invents a donation nor a filing', await p.evaluate(() => {
    const L = state.leads.find(x => x.id === 'b');
    return !L.pub.donations.count && L.pub.filings.length === 0; }));

  // --- the Knoxville fix ------------------------------------------------------
  await p.evaluate(() => { expanded = null; toggleDetail('g'); });
  await p.waitForTimeout(300);
  ck('a failed WhitePages lookup offers "search where you know they live"',
     await p.evaluate(() => !![...document.querySelectorAll('button')]
       .find(x => /Know where they live/.test(x.textContent))));
  ck('  ...saying why the first search missed', /usually carries the employer/.test(
     await p.evaluate(() => document.body.innerText)));

  await p.evaluate(() => { retryWhere('g'); });
  await p.waitForTimeout(300);
  ck('it asks for the city in a modal', await p.evaluate(() =>
    document.getElementById('mPrompt').classList.contains('open')));
  await p.evaluate(() => { document.getElementById('apInput').value = 'Knoxville, TN'; apDone(true); });
  await p.waitForTimeout(600);
  ck('the lookup was retried in the supplied city', enrichCalls.length === 1 &&
     enrichCalls[0].city === 'Knoxville' && enrichCalls[0].state === 'TN',
     JSON.stringify(enrichCalls[0] || {}));
  const after = await p.evaluate(() => {
    const L = state.leads.find(x => x.id === 'g');
    return { city: L.hd.city, dob: dobLabel(L), basis: L.hd.matchedBy, mobile: L.mobilePhone };
  });
  ck('  ...and this time he was found', after.city === 'Knoxville', after.city);
  ck('  ...birth date and all', after.dob === 'Feb 1966');
  ck('  ...gaining the mobile the list never had', after.mobile === '(865) 555-0134');
  // The record was matched on a location the user typed, not one any source
  // supplied. That is a weaker basis and it must say so forever.
  ck('  ...on a basis that names who supplied the location',
     /you supplied/.test(after.basis), after.basis);

  // Garbage in the prompt is refused before it costs anything.
  const before = enrichCalls.length;
  await p.evaluate(() => { retryWhere('g'); });
  await p.waitForTimeout(200);
  await p.evaluate(() => { document.getElementById('apInput').value = 'Tennessee'; apDone(true); });
  await p.waitForTimeout(400);
  ck('a place with no state code is refused before the lookup', enrichCalls.length === before);

  ck('no page errors', errs.length === 0, errs.slice(0, 2).join(' | '));
  console.log(fail ? `\nFAILURES: ${fail} of ${n}` : `\nall ${n} checks passed`);
  await b.close(); process.exit(fail ? 1 : 0);
})();
