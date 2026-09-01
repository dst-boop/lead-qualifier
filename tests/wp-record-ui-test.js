// The reverse-phone lookup was always buying a whole person record; the app
// read three fields off it and then charged a second lookup for the rest.
//
// The field worth the most is the date of birth. An age of 59 says "somewhere
// in a twelve-month band". A birth month says "February 2030", which is the
// difference between a lead you nurture and a lead you call. So most of what
// is checked here is that the month survives — into the age, into the badge,
// into the score — and that where the record is silent the app says nothing
// rather than rounding a guess into a date.
const { chromium } = require('playwright');

const feat = o => ({ whitepages: true, ai_qc: false, server_state: true, drive: false,
                     zoominfo: false, edgar: false, zi_mcp: false, opportunities: false, ...o });
const me = o => ({ signed_in: true, provider: 'google', name: 'Dan', email: 'dan@fpa.com',
                   providers: { google: true }, features: feat(), storage: 'firestore', ...o });

const LEADS = [
  { id: 'a', firstName: 'Janet', lastName: 'Melter', title: 'Supply Base Manager',
    employer: 'Boeing', mobilePhone: '(206) 555-0142', email: '', status: 'New', activity: [] },
  { id: 'b', firstName: 'Bob', lastName: 'Bare', title: 'Director', employer: 'Halstead',
    mobilePhone: '(207) 555-0118', email: 'bob@h.com', status: 'New', activity: [] }];

// The record the API returns for a reverse-phone query — the full person, not
// just the line. Shaped after the consumer page Dan looked at.
const RECORD = {
  owner: 'Janet Melter', aliases: ['Janet K Hausfeld', 'Janette Melter'],
  age: 55, dob: { year: 1970, month: 8, day: 0, text: 'Aug 1970' },
  home_street: '14 Alexander Ave', home_city: 'Renton', home_state: 'WA', home_zip: '98055',
  mobiles: ['(206) 555-0142', '(206) 555-0199'],
  phone_records: [
    { number: '(206) 555-0142', type: 'Mobile', carrier: 'T-Mobile USA', prepaid: false,
      dnc: true, spam: '0', score: 92 },
    { number: '(206) 555-0177', type: 'Landline', carrier: 'CenturyLink', dnc: null, spam: '' }],
  phones_total: 8, addresses_total: 11,
  emails: ['janet.melter@boeing.com', 'jkmelter@yahoo.com'],
  email_records: [
    { email: 'janet.melter@boeing.com', type: 'professional', recent: null },
    { email: 'jkmelter@yahoo.com', type: 'personal', recent: true }],
  jobs: [{ title: 'Supply Base Manager', employer: 'Boeing' }],
  linkedin_url: 'https://linkedin.com/in/janet', properties: [], properties_owned: 1,
  prior_places: ['Kent, WA'], relatives: ['Karl Melter'] };

(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })
    .catch(() => chromium.launch());
  const ctx = await b.newContext({ viewport: { width: 1500, height: 1000 } });
  const p = await ctx.newPage();
  // A content suite: it asserts on what the record holds, so open every
  // fold up front. recordcard-test.js owns the folded-by-default behavior.
  await p.addInitScript(()=>{window.__unfold=true;});
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  p.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE: ' + m.text()); });

  let verifyBody = null;
  await p.route('**/api/me', r => r.fulfill({ json: me() }));
  await p.route('**/api/settings', r => r.fulfill({ json: { ok: true } }));
  await p.route('**/api/lists', r => r.fulfill({ json: { lists: [{ id: 'default', name: 'My leads', count: 2, role: 'owner', owner: '' }], settings: {} } }));
  await p.route('**/api/lists/*', r => r.request().method() === 'GET'
    ? r.fulfill({ json: { list: { id: 'default', name: 'My leads' }, settings: {}, leads: JSON.parse(JSON.stringify(LEADS)) } })
    : r.fulfill({ json: { ok: true, lists: [] } }));
  await p.route('**/api/verify-phone', r => r.fulfill({ json: verifyBody }));

  let fail = 0, n = 0;
  const ck = (name, c, d) => { n++; console.log((c ? 'ok   ' : 'FAIL ') + name + (d !== undefined ? '  ' + d : '')); if (!c) fail++; };
  const load = async () => {
    await p.goto('http://127.0.0.1:8099/', { waitUntil: 'domcontentloaded' });
    await p.evaluate(() => localStorage.clear());
    await p.goto('http://127.0.0.1:8099/', { waitUntil: 'domcontentloaded' });
    await p.waitForFunction(() => window.ME && window.ME.signed_in && typeof sellable === 'function',
                            null, { timeout: 15000 });
    await p.waitForTimeout(600);
  };
  await load();

  // --- reading a date of birth, whatever shape it arrives in ------------------
  const shapes = await p.evaluate(() => {
    const f = d => { const L = { hd: { dob: d } }; const o = dobOf(L); return o ? [o.year, o.month, o.day] : null; };
    return { obj: f({ year: 1970, month: 8, day: 0 }), iso: f('1970-08'), isoDay: f('1970-08-15'),
             us: f('08/15/1970'), usShort: f('08/1970'), yearOnly: f('1970'),
             none: f(''), missing: f(null), junk: f('n/a'), range: f('55-59') };
  });
  ck('the stored object shape reads', JSON.stringify(shapes.obj) === '[1970,8,0]', JSON.stringify(shapes.obj));
  // Leads enriched before this change hold whatever string the API gave, and
  // they must not silently lose the date they already paid for.
  ck('  ...and so does a string from an older enrichment', JSON.stringify(shapes.iso) === '[1970,8,0]');
  ck('  ...with a day', JSON.stringify(shapes.isoDay) === '[1970,8,15]');
  ck('  ...in US order', JSON.stringify(shapes.us) === '[1970,8,15]');
  ck('  ...month and year only', JSON.stringify(shapes.usShort) === '[1970,8,0]');
  ck('a bare year reads as a year with no month', JSON.stringify(shapes.yearOnly) === '[1970,0,0]');
  ck('nothing reads as nothing', shapes.none === null && shapes.missing === null && shapes.junk === null);
  // "55-59" contains no year, so it must not become one.
  ck('an age range is not a date of birth', shapes.range === null, JSON.stringify(shapes.range));

  // --- the age, and the month it turns into ----------------------------------
  const age = await p.evaluate(() => {
    const n = new Date(), y = n.getFullYear(), m = n.getMonth() + 1;
    const at = (yy, mm) => ({ hd: { dob: { year: yy, month: mm } } });
    return {
      thisMonth: dobAge(at(y - 56, m)),
      lastMonth: dobAge(at(y - 56, m === 1 ? 12 : m - 1)),
      nextMonth: dobAge(at(y - 56, m === 12 ? 1 : m + 1)),
      yearOnly: dobAge({ hd: { dob: { year: y - 56, month: 0 } } }),
      half: halfMonth({ hd: { dob: { year: 1970, month: 8 } } }),
      label: monLabel(halfMonth({ hd: { dob: { year: 1970, month: 8 } } })),
      janLabel: monLabel(halfMonth({ hd: { dob: { year: 1970, month: 7 } } })),
    };
  });
  // In the birthday month the day decides, and the record has no day. The age
  // shown is the one they have certainly reached — a month behind at worst,
  // never ahead.
  ck('in the birthday month the age is the one certainly reached', age.thisMonth === 55, age.thisMonth);
  ck('  ...a month after, the full age', age.lastMonth === 56, age.lastMonth);
  ck('  ...a month before, one less', age.nextMonth === 55, age.nextMonth);
  ck('a year with no month yields no age at all', age.yearOnly === null, age.yearOnly);
  // Aug 1970 + 59y + 6mo = Feb 2030. This is the arithmetic the whole campaign
  // rests on, so it is checked against a number worked out by hand.
  ck('Aug 1970 reaches 59½ in Feb 2030', age.label === 'Feb 2030', age.label);
  ck('  ...and Jul 1970 in Jan 2030', age.janLabel === 'Jan 2030', age.janLabel);

  // --- what the badge says ----------------------------------------------------
  const sell = await p.evaluate(() => {
    const n = new Date(), y = n.getFullYear(), m = n.getMonth() + 1;
    // Walk back 59 years and 6 months from a given offset in months.
    const born = off => { const i = (y * 12 + (m - 1)) - (59 * 12 + 6) + off;
                          return { hd: { dob: { year: Math.floor(i / 12), month: (i % 12) + 1 } } }; };
    return { now: sellable(born(0)), past: sellable(born(-14)), soon: sellable(born(3)),
             far: sellable(born(40)),
             noDob: sellable({ hd: { age: 61 } }),
             nothing: sellable({}) };
  });
  ck('someone reaching 59½ this month is called out as this month',
     sell.now.k === 'yes' && /this month/.test(sell.now.label), sell.now.label);
  // A green tick in the one month where eligibility turns on a day nobody
  // looked up would be the app asserting something it does not know.
  ck('  ...and the tooltip says the day is not on file',
     /no day of birth/.test(sell.now.title), sell.now.title);
  ck('someone past it is available now', sell.past.k === 'yes' && /✓/.test(sell.past.label), sell.past.label);
  ck('  ...naming the month they crossed', /reached 59½ in \w{3} \d{4}/.test(sell.past.title), sell.past.title);
  ck('three months out counts in months', sell.soon.k === 'soon' && sell.soon.label === '59½ in 3mo', sell.soon.label);
  ck('  ...and a long way out names the month instead of a big number',
     sell.far.k === 'soon' && /59½ \w{3} \d{4}/.test(sell.far.label), sell.far.label);
  ck('  ...saying it came from a birth date, not a guess',
     /public record/.test(sell.far.title), sell.far.title);
  ck('without a date of birth the old wording is untouched',
     sell.noDob.k === 'yes' && sell.noDob.label === '59½ ✓', sell.noDob.label);
  ck('  ...and with nothing at all it still asks for a date', sell.nothing.k === 'unknown');

  // --- the basis shown on the row --------------------------------------------
  const basis = await p.evaluate(() => ({
    dob: ageBasis({ hd: { dob: { year: 1966, month: 2 } } }),
    beatsFiling: ageBasis({ hd: { dob: { year: 1966, month: 2 } }, edgar: { age: 48, asOf: '2026-01' } }),
    filing: ageBasis({ edgar: { age: 48, asOf: '2026-01' } }),
    record: ageBasis({ hd: { age: 61 } }),
    inferred: ageBasis({ gradYear: 1985 }),
    ageFromDob: leadAge({ hd: { dob: { year: 1966, month: 2 } }, edgar: { age: 48, asOf: '2026-01' } }),
  }));
  ck('a date of birth is its own basis', basis.dob.kind === 'dob' && /born Feb 1966/.test(basis.dob.label), basis.dob.label);
  // A proxy statement prints an integer as of a filing date; a birth record
  // prints the month it happened. The record wins.
  ck('  ...and outranks an SEC filing', basis.beatsFiling.kind === 'dob' && basis.ageFromDob === 60, basis.ageFromDob);
  ck('the old precedence is otherwise unchanged',
     basis.filing.kind === 'filed' && basis.record.kind === 'record' && basis.inferred.kind === 'inferred');

  // --- folding a record onto a lead ------------------------------------------
  const applied = await p.evaluate(r => {
    const L = { id: 'z', firstName: 'Janet', lastName: 'Melter', employer: 'Boeing',
                mobilePhone: '(206) 555-0142', email: '', street: '', city: 'Seattle',
                zip: '', linkedinUrl: '', activity: [], status: 'New' };
    applyRecord(L, r, 'phone');
    return { email: L.email, street: L.street, city: L.city, zip: L.zip,
             linkedin: L.linkedinUrl, dnc: L.mobileDnc, tier: L.tier, score: L.score,
             hdDob: L.hd.dob, aliases: L.hd.aliases, jobs: L.hd.jobs,
             phones: L.hd.phoneRecords.length, addr: L.hd.addressesTotal };
  }, RECORD);
  // The personal address is the one a 59-year-old reads, and the work one goes
  // through their employer's mail system.
  ck('the blank email is filled from the personal address, not the work one',
     applied.email === 'jkmelter@yahoo.com', applied.email);
  ck('a blank street is filled', applied.street === '14 Alexander Ave');
  // Backfill fills blanks. It does not overrule what the user or the source
  // list already put on the lead.
  ck('a city already on the lead is NOT overwritten', applied.city === 'Seattle', applied.city);
  ck('a blank zip is filled', applied.zip === '98055');
  ck('the LinkedIn URL is filled', /janet/.test(applied.linkedin));
  // A DNC flag on the number the app is about to dial changes what the user is
  // allowed to do, so it has to land where the call guard reads it.
  ck('a do-not-call flag on the dialled line reaches the lead', applied.dnc === 'true', applied.dnc);
  ck('the date of birth is stored whole', applied.hdDob && applied.hdDob.month === 8);
  ck('the aliases are stored', applied.aliases.length === 2);
  ck('the lines are stored with what each says', applied.phones === 2);
  ck('the address count is stored', applied.addr === 11);
  ck('the lead is re-scored, so the new age counts', typeof applied.score === 'number' && applied.tier);

  // A record with nothing in it must leave the lead as it was.
  const bare = await p.evaluate(() => {
    const L = { id: 'z', firstName: 'Bob', lastName: 'Bare', email: 'bob@h.com',
                city: 'Portland', activity: [], status: 'New' };
    applyRecord(L, { owner: 'Bob Bare', aliases: [], dob: {}, emails: [], email_records: [],
                     mobiles: [], phone_records: [], jobs: [] }, 'phone');
    return { email: L.email, city: L.city, dnc: L.mobileDnc, dob: dobOf(L),
             sell: sellable(L).k };
  });
  ck('an empty record overwrites nothing', bare.email === 'bob@h.com' && bare.city === 'Portland');
  ck('  ...invents no date of birth', bare.dob === null);
  ck('  ...sets no do-not-call flag', bare.dnc === undefined, bare.dnc);
  ck('  ...and leaves the lead asking for a date', bare.sell === 'unknown');

  // An earlier Enrich established the deed; a later phone check must not blank
  // it, because the phone call never looked at the property.
  const kept = await p.evaluate(r => {
    const L = { id: 'z', lastName: 'Melter', activity: [], status: 'New',
                hd: { ownsHome: true, ownerType: 'trust', coOwners: ['Janet Melter'] } };
    applyRecord(L, r, 'phone');
    return { owns: L.hd.ownsHome, type: L.hd.ownerType, co: L.hd.coOwners.length };
  }, RECORD);
  ck('a phone check does not erase what Enrich found about the deed',
     kept.owns === true && kept.type === 'trust' && kept.co === 1, JSON.stringify(kept));

  // --- pressing the button ----------------------------------------------------
  verifyBody = { valid: true, line_type: 'Mobile', carrier: 'T-Mobile USA', prepaid: false,
                 dnc: false, spam: '0', owner: 'Janet Melter', name_match: true,
                 matched_alias: '', owner_city: 'Renton', owner_state: 'WA',
                 owner_street: '14 Alexander Ave', owner_zip: '98055',
                 same_household: true, record: RECORD };
  await p.evaluate(() => verifyLead('a'));
  await p.waitForTimeout(700);
  const after = await p.evaluate(() => {
    const L = state.leads.find(x => x.id === 'a');
    return { label: L.pv.label, hasHd: !!(L.hd && L.hd.dob), dobLbl: dobLabel(L),
             sell: sellable(L).label, email: L.email };
  });
  ck('the phone check reports the carrier it was told', /T-Mobile USA/.test(after.label), after.label);
  // One lookup, not two: the record came back with the line.
  ck('  ...and fills the household panel from the same lookup', after.hasHd === true);
  ck('  ...so the birth date is on the lead without pressing Enrich',
     after.dobLbl === 'Aug 1970', after.dobLbl);
  ck('  ...and the badge now names a month', /59½/.test(after.sell), after.sell);
  ck('  ...and the personal email came across', after.email === 'jkmelter@yahoo.com', after.email);

  await p.evaluate(() => toggleDetail('a'));
  await p.waitForTimeout(300);
  const text = await p.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));
  ck('the panel shows when they were born', /Born Aug 1970/.test(text));
  ck('  ...and the month they reach 59½', /Reaches 59½ Feb 2030/.test(text), (text.match(/Reaches 59.{0,20}/) || [])[0]);
  ck('  ...saying that is a month and not a date', /No day of birth on file/.test(text));
  ck('  ...their other names', /Janet K Hausfeld/.test(text));
  ck('  ...the carrier beside the line', /T-Mobile USA/.test(text));
  ck('  ...the do-not-call flag on that line', /DNC/.test(text));
  ck('  ...both email addresses with their types', /jkmelter@yahoo\.com/.test(text) && /recently used/.test(text));
  ck('  ...the work the record carries', /Supply Base Manager at Boeing/.test(text));
  ck('  ...and the true number of addresses on file', /Addresses on file/.test(text) && /11/.test(text));

  // A record that disagrees with the list about the employer is worth saying so
  // about: which one is current decides whether there is a plan to roll over.
  const clash = await p.evaluate(() => {
    const L = state.leads.find(x => x.id === 'a');
    L.hd.jobs = [{ title: 'Buyer', employer: 'Raytheon Technologies' }];
    render();
    return document.body.innerText.replace(/\s+/g, ' ');
  });
  await p.waitForTimeout(200);
  ck('a different employer on the record is flagged, not silently shown',
     /The list says Boeing; this record says otherwise/.test(clash),
     (clash.match(/The list says.{0,60}/) || [])[0]);
  ck('  ...and "The Boeing Company, Inc." is not treated as a different employer',
     await p.evaluate(() => normCo('The Boeing Company, Inc.') === normCo('Boeing')));

  // A lookup that found nothing must leave the lead exactly as it was.
  verifyBody = { valid: null, line_type: '', carrier: '', prepaid: null, owner: '',
                 name_match: null, note: 'no record found' };
  await p.evaluate(() => verifyLead('b'));
  await p.waitForTimeout(600);
  const miss = await p.evaluate(() => {
    const L = state.leads.find(x => x.id === 'b');
    return { hd: L.hd || null, email: L.email, label: L.pv.label };
  });
  ck('a lookup that found nothing attaches nothing', miss.hd === null, JSON.stringify(miss.hd));
  ck('  ...and says so', /no record for this number/.test(miss.label), miss.label);
  ck('  ...leaving the lead untouched', miss.email === 'bob@h.com');

  // A number registered to a stranger elsewhere is bad data from the import.
  // Attaching that stranger's birth date to this lead would be worse than the
  // wrong number itself.
  verifyBody = { valid: true, line_type: 'Mobile', carrier: 'Verizon', owner: 'Karl Other',
                 name_match: false, owner_city: 'Tulsa', owner_state: 'OK',
                 owner_street: '9 Elm St', owner_zip: '74101', same_household: false,
                 record: Object.assign({}, RECORD, { owner: 'Karl Other' }) };
  await p.evaluate(() => verifyLead('b'));
  await p.waitForTimeout(600);
  const wrong = await p.evaluate(() => {
    const L = state.leads.find(x => x.id === 'b');
    return { hd: L.hd || null, wrong: !!L.pv.wrong, dob: dobOf(L) };
  });
  ck("a stranger's record is not attached to the lead", wrong.hd === null, JSON.stringify(wrong.hd));
  ck('  ...and the number is still flagged as wrong', wrong.wrong === true);
  ck('  ...so no birth date is borrowed from them', wrong.dob === null);

  ck('no page errors', errs.length === 0, errs.slice(0, 2).join(' | '));
  console.log(fail ? `\nFAILURES: ${fail} of ${n}` : `\nall ${n} checks passed`);
  await b.close(); process.exit(fail ? 1 : 0);
})();
