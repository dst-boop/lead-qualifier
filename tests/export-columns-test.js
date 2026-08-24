// The exported call list, checked against the four things wrong with it.
//
//   First & Last name need to be in separate columns
//   State must be 2 letter abbreviation
//   Address type must be home
//   LinkedIn link must be included
//
// The first is the interesting one. The export was writing firstName and
// lastName faithfully; the *lead* held "Paul Dawe" in firstName with lastName
// empty, on 342 rows, because a source column carrying a whole name was mapped
// to First Name and never split. Faithful output of bad data is still bad
// output, so the export splits, and so does the import — one fixes the list
// that exists, the other stops it recurring.
const { chromium } = require('playwright');

const feat = o => ({ whitepages: true, ai_qc: false, server_state: true, drive: false,
                     zoominfo: false, edgar: false, zi_mcp: false, opportunities: false, ...o });
const me = o => ({ signed_in: true, provider: 'google', name: 'Dan', email: 'dan@fpa.com',
                   providers: { google: true }, features: feat(), storage: 'firestore', ...o });

const LEADS = [
  // exactly the shape of the reported row: whole name in First Name, full
  // state name, no street
  { id: 'a', firstName: 'Paul Dawe', lastName: '', title: 'Retired - Former CEO',
    employer: 'HSBC Asset Management', city: 'New York', state: 'New York',
    mobilePhone: '(212) 555-0142', email: 'p@h.com', status: 'New', activity: [],
    linkedinUrl: 'https://www.linkedin.com/in/pauldawe' },
  // a properly split name must not be touched
  { id: 'b', firstName: 'Bea', lastName: 'Bravo', employer: 'Meridian',
    city: 'Newark', state: 'NJ', mobilePhone: '(973) 555-0143', email: 'b@m.com',
    status: 'New', activity: [] },
  // a suffix belongs to the surname, not instead of it
  { id: 'c', firstName: 'Robert Holloway Sr', lastName: '', employer: 'Halstead',
    city: 'Portland', state: 'Oregon', mobilePhone: '(207) 555-0118',
    email: 'r@h.com', status: 'New', activity: [] },
  // comma form
  { id: 'd', firstName: 'Delta, Dev', lastName: '', employer: 'Cordova',
    city: 'Austin', state: 'texas', mobilePhone: '(512) 555-0155',
    email: 'd@c.com', status: 'New', activity: [] },
  // one word is a first name, not a surname
  { id: 'e', firstName: 'Cher', lastName: '', employer: 'Cordova',
    city: 'Reno', state: 'NV', mobilePhone: '(775) 555-0156', email: 'e@c.com',
    status: 'New', activity: [] },
  // a real home address from the public record
  { id: 'f', firstName: 'Janet', lastName: 'Melter', employer: 'Boeing',
    city: 'Seattle', state: 'Washington', mobilePhone: '(206) 555-0142',
    email: 'j@b.com', status: 'New', activity: [],
    hd: { read: 2, owner: 'Janet Melter', street: '1019 E Laurel St', city: 'Kent',
          state: 'WA', zip: '98030', aliases: [], mobiles: [], phoneRecords: [],
          emailRecords: [], jobs: [], properties: [], relatives: [], priorPlaces: [] } }];

(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })
    .catch(() => chromium.launch());
  const ctx = await b.newContext({ viewport: { width: 1500, height: 1000 } });
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
  await p.waitForFunction(() => window.ME && window.ME.signed_in && typeof exportName === 'function',
                          null, { timeout: 15000 });
  await p.waitForTimeout(600);

  // Capture the CSV the download would carry, without a download.
  const csv = await p.evaluate(() => new Promise(res => {
    const real = window.dl;
    window.dl = blob => { blob.text().then(res); window.dl = real; };
    document.getElementById('btnExport').click();
  }));
  const rows = csv.trim().split('\r\n').map(l => {
    // Minimal RFC4180 split: quoted fields may contain commas.
    const out = []; let cur = '', q = false;
    for (let i = 0; i < l.length; i++) {
      const ch = l[i];
      if (q) { if (ch === '"' && l[i + 1] === '"') { cur += '"'; i++; }
               else if (ch === '"') q = false; else cur += ch; }
      else if (ch === '"') q = true;
      else if (ch === ',') { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur); return out;
  });
  const H = rows[0], idx = k => H.indexOf(k);
  const by = {}; rows.slice(1).forEach(r => { by[(r[idx('First Name')] + ' ' + r[idx('Last Name')]).trim()] = r; });
  const F = (row, k) => row[idx(k)];

  // --- 4. LinkedIn ------------------------------------------------------------
  ck('the header carries a LinkedIn column', idx('LinkedIn URL') > -1, H.join('|'));
  // Appended, so a CRM mapping built against the old file still lines up.
  ck('  ...at the end, so no existing column moved',
     idx('LinkedIn URL') === H.length - 1 && idx('First Name') === 0
     && idx('Lead External ID') === H.length - 2, H.join('|'));
  ck('  ...and the URL is in it',
     F(by['Paul Dawe'], 'LinkedIn URL') === 'https://www.linkedin.com/in/pauldawe',
     F(by['Paul Dawe'], 'LinkedIn URL'));
  ck('  ...left empty where there is none', F(by['Bea Bravo'], 'LinkedIn URL') === '');

  // --- 1. names in separate columns -------------------------------------------
  ck('a whole name in First Name is split', !!by['Paul Dawe'], Object.keys(by).join(' / '));
  ck('  ...first name only in the first column',
     F(by['Paul Dawe'], 'First Name') === 'Paul', F(by['Paul Dawe'], 'First Name'));
  ck('  ...surname only in the second',
     F(by['Paul Dawe'], 'Last Name') === 'Dawe', F(by['Paul Dawe'], 'Last Name'));
  ck('a name already split is left alone',
     F(by['Bea Bravo'], 'First Name') === 'Bea' && F(by['Bea Bravo'], 'Last Name') === 'Bravo');
  // "Robert Holloway Sr" — the surname is Holloway, and Sr goes with it.
  ck('a suffix does not become the surname',
     F(by['Robert Holloway Sr'], 'First Name') === 'Robert'
     && /Holloway/.test(F(by['Robert Holloway Sr'], 'Last Name')),
     JSON.stringify([F(by['Robert Holloway Sr'], 'First Name'), F(by['Robert Holloway Sr'], 'Last Name')]));
  ck('comma form is read the right way round',
     F(by['Dev Delta'], 'First Name') === 'Dev' && F(by['Dev Delta'], 'Last Name') === 'Delta',
     Object.keys(by).join(' / '));
  // Blanking First Name to invent a surname would be worse than leaving it.
  ck('a single word stays a first name rather than being promoted',
     F(by['Cher'], 'First Name') === 'Cher' && F(by['Cher'], 'Last Name') === '',
     JSON.stringify([F(by['Cher'], 'First Name'), F(by['Cher'], 'Last Name')]));

  // --- 2. two-letter state ----------------------------------------------------
  ck('a full state name becomes a code', F(by['Paul Dawe'], 'State/Province') === 'NY',
     F(by['Paul Dawe'], 'State/Province'));
  ck('  ...a code is left as it is', F(by['Bea Bravo'], 'State/Province') === 'NJ');
  ck('  ...lower case is handled', F(by['Dev Delta'], 'State/Province') === 'TX',
     F(by['Dev Delta'], 'State/Province'));
  ck('  ...and so is Oregon', F(by['Robert Holloway Sr'], 'State/Province') === 'OR');
  // The public-record address wins, and brings its own state.
  ck('a home address from the record exports its own state',
     F(by['Janet Melter'], 'State/Province') === 'WA'
     && F(by['Janet Melter'], 'City') === 'Kent',
     [F(by['Janet Melter'], 'City'), F(by['Janet Melter'], 'State/Province')].join(','));
  const codes = await p.evaluate(() => ['New York', 'new york', 'NY', 'ny', 'Washington DC',
    'D.C.', '', 'Ontario'].map(v => [v, stateCode(v)]));
  ck('every spelling resolves to the code', JSON.stringify(codes.slice(0, 4).map(c => c[1])) === '["NY","NY","NY","NY"]',
     JSON.stringify(codes));
  ck('  ...the District of Columbia resolves however it is punctuated',
     codes[4][1] === 'DC' && codes[5][1] === 'DC', JSON.stringify([codes[4], codes[5]]));
  ck('  ...nothing stays nothing', codes[6][1] === '');
  // A province is fixable in the CRM; a blank is not.
  ck('  ...and something unrecognised passes through rather than being blanked',
     codes[7][1] === 'Ontario', codes[7][1]);

  // --- 3. address type --------------------------------------------------------
  ck('the address type is Home', F(by['Paul Dawe'], 'Address Type') === 'Home',
     F(by['Paul Dawe'], 'Address Type'));
  ck('  ...on every row', rows.slice(1).every(r => F(r, 'Address Type') === 'Home'),
     rows.slice(1).map(r => F(r, 'Address Type')).join(','));
  ck('  ...and a real home address is Home because it is one',
     F(by['Janet Melter'], 'Address Type') === 'Home');

  // --- and the import stops it recurring --------------------------------------
  const imported = await p.evaluate(() => {
    const map = {}; FIELDS.forEach(([k], i) => { map[k] = -1; });
    const hdr = ['First Name', 'Employer', 'City', 'State'];
    map.firstName = 0; map.employer = 1; map.city = 2; map.state = 3;
    const L = leadFromRow(['Grace Hopper', 'Navy', 'Arlington', 'Virginia'], map, 'test');
    const M = leadFromRow(['Madonna', 'Music', 'Detroit', 'MI'], map, 'test');
    return [[L.firstName, L.lastName], [M.firstName, M.lastName]];
  });
  ck('an import splits a whole name in the First Name column',
     JSON.stringify(imported[0]) === '["Grace","Hopper"]', JSON.stringify(imported[0]));
  ck('  ...and leaves a single word alone',
     JSON.stringify(imported[1]) === '["Madonna",""]', JSON.stringify(imported[1]));

  ck('no page errors', errs.length === 0, errs.slice(0, 2).join(' | '));
  console.log(fail ? `\nFAILURES: ${fail} of ${n}` : `\nall ${n} checks passed`);
  await b.close(); process.exit(fail ? 1 : 0);
})();
