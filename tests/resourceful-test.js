// "You need to be more resourceful when enriching and qualifying the leads."
//
// The Tim Shaughnessy case, replayed: a business owner with no location and
// no contact info, whose employer's own About page and one web search hold
// everything — Knoxville, the spouse, "over two decades", an office number,
// the email pattern, an age in print. The app now does what the operator did
// by hand: prefilled searches to click, the employer's site read on the
// publisher's terms, and an AI web search through a licensed API. Every
// finding carries its quote and source, and NOTHING lands on the lead until
// the operator accepts it.
const { chromium } = require('playwright');

const feat = o => ({ whitepages: true, ai_qc: true, server_state: true, drive: false,
                     zoominfo: false, edgar: false, zi_mcp: false, opportunities: false,
                     free_sources: true, site_reader: true, web_research: true, ...o });
const me = o => ({ signed_in: true, provider: 'password', name: 'ana', email: 'ana@x.com',
                   providers: { google: true }, features: feat(), storage: 'firestore', ...o });

const SITE_OK = { ok: true, root: 'https://preferredconstructiontn.com',
  pages: [{ url: 'https://preferredconstructiontn.com/about-us', title: 'About Us', chars: 900 }],
  findings: {
    owners: [{ name: 'Tim Shaughnessy', title: 'Owner',
               quote: 'Tim and Barb Shaughnessy bring their zeal to the helm of Preferred Construction' }],
    year_founded: 2003, year_founded_quote: 'serving Knoxville since 2003',
    years_in_business: 23, years_in_business_quote: null,
    ages: [{ name: 'Tim Shaughnessy', age: 68, quote: 'Tim, 68, still walks every job site' }],
    career_start_year: 1981, career_start_quote: 'began his career in 1981' } };

const WEB_OK = { ok: true, searched: '"Tim Shaughnessy" "Preferred Construction, LLC" Business Owner',
  found: {
    summary: 'Owner of Preferred Construction, a Knoxville TN remodeler, with his wife Barbara.',
    location: { city: 'Knoxville', state: 'TN',
                quote: 'added to this bustling community', url: 'https://preferredconstructiontn.com/about-us' },
    age_hints: [{ hint: 'over two decades at the helm',
                  quote: 'For over two decades, Tim and Barbara Shaughnessy...', url: 'https://preferredconstructiontn.com' }],
    ages: [],
    spouse: { name: 'Barbara Shaughnessy', quote: 'Tim and Barb Shaughnessy bring their zeal', url: 'https://preferredconstructiontn.com/about-us' },
    office_phone: { number: '865-309-5180', quote: 'Contact us', url: 'https://preferredconstructiontn.com/contact' },
    email_pattern: { pattern: 'first@PreferredConstructionTN.com', quote: 'tim@PreferredConstructionTN.com', url: 'https://preferredconstructiontn.com/contact' },
    links: { instagram: 'https://instagram.com/preferredconstructiontn' } } };

(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })
    .catch(() => chromium.launch());
  const p = await b.newPage({ viewport: { width: 1500, height: 1000 } });
  // A content suite: it asserts on what the record holds, so open every
  // fold up front. recordcard-test.js owns the folded-by-default behavior.
  await p.addInitScript(()=>{window.__unfold=true;});
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  p.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE: ' + m.text()); });

  let siteReply = SITE_OK, webReply = WEB_OK; const siteAsked = [], webAsked = [];
  await p.route('**/api/me', r => r.fulfill({ json: me() }));
  await p.route('**/api/settings', r => r.fulfill({ json: { ok: true } }));
  await p.route('**/api/harvest/site', r => { siteAsked.push(JSON.parse(r.request().postData()));
    return r.fulfill({ json: siteReply }); });
  await p.route('**/api/web-research', r => { webAsked.push(JSON.parse(r.request().postData()));
    return r.fulfill({ json: webReply }); });
  await p.route('**/api/lists', r => r.fulfill({ json: { lists: [{ id: 'default', name: 'All leads', count: 2, role: 'owner', owner: '' }], settings: {} } }));
  await p.route('**/api/lists/*', r => r.request().method() === 'GET'
    ? r.fulfill({ json: { list: { id: 'default', name: 'All leads' }, settings: {}, leads: [
        // Tim: no location, no phones — the record the buttons "did nothing" for.
        { id: 't', firstName: 'Tim', lastName: 'Shaughnessy', title: 'Business Owner',
          employer: 'Preferred Construction, LLC', email: 'tim@PreferredConstructionTN.com',
          status: 'New', activity: [] },
        // A gmail lead: no company site to derive.
        { id: 'g', firstName: 'Gina', lastName: 'Marks', title: 'Owner', employer: 'Marks LLC',
          email: 'gina@gmail.com', status: 'New', activity: [] }] } })
    : r.fulfill({ json: { ok: true, lists: [] } }));

  let fail = 0, n = 0;
  const ck = (name, c, d) => { n++; console.log((c ? 'ok   ' : 'FAIL ') + name + (d !== undefined ? '  ' + d : '')); if (!c) fail++; };

  await p.goto('http://127.0.0.1:8099/', { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => window.ME && typeof siteFromLead === 'function', null, { timeout: 15000 });
  await p.waitForTimeout(500);

  // --- the panel offers the resourceful pair ----------------------------------
  const acts = await p.evaluate(() => researchActions(byId('t')).map(a => a[1]));
  ck('the record with nothing offers the employer’s own site',
     acts.some(a => /own site/.test(a)), JSON.stringify(acts));
  ck('  ...and an AI web search', acts.some(a => /Search the web/.test(a)));
  const webRow = await p.evaluate(() => researchActions(byId('t')).find(a => a[0] === 'webResearch'));
  ck('  ...whose cost is named as tokens, not credits', /AI tokens/.test(webRow[3]), webRow[3]);

  // --- the manual links: the operator's own two hands -------------------------
  const links = await p.evaluate(() => researchLinks(byId('t')));
  ck('a prefilled Google search carries name, employer and title',
     /google\.com\/search\?q=/.test(links)
     && /%22Tim%20Shaughnessy%22/.test(links) && /Business%20Owner/.test(links), links.slice(0, 200));
  ck('  ...FastPeopleSearch gets the slugged name', /fastpeoplesearch\.com\/name\/tim-shaughnessy/.test(links), links);
  ck('  ...and the company site is derived from the email domain',
     /https:\/\/preferredconstructiontn\.com/.test(links));
  ck('a freemail address derives no company site', await p.evaluate(() =>
     !/company site/.test(researchLinks(byId('g'))) && siteFromLead(byId('g')) === ''));

  // --- reading their own site -------------------------------------------------
  await p.evaluate(() => readSite('t'));
  await p.waitForTimeout(500);
  ck('the site read went to the derived domain, no typing needed',
     siteAsked.length === 1 && /preferredconstructiontn\.com/.test(siteAsked[0].website),
     JSON.stringify(siteAsked[0] || {}));
  await p.evaluate(() => { expanded = null; toggleDetail('t'); });
  await p.waitForTimeout(300);
  let text = await p.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));
  ck('the record shows who runs it, in their own words',
     /Tim and Barb Shaughnessy bring their zeal/.test(text), text.slice(0, 80));
  ck('  ...when it was founded', /Founded 2003/.test(text));
  ck('  ...and the age their page prints, with the quote',
     /Tim Shaughnessy, age 68/.test(text) && /still walks every job site/.test(text));
  ck('the age is an OFFER — the lead itself is untouched until accepted',
     await p.evaluate(() => leadAge(byId('t')) === null));
  await p.evaluate(() => acceptWebAge('t', 68, 'site'));
  await p.waitForTimeout(300);
  ck('accepting it makes it the lead’s age', await p.evaluate(() => leadAge(byId('t')) === 68));
  ck('  ...with a basis that names where it came from', await p.evaluate(() =>
     /company site/.test(ageBasis(byId('t')).label)), await p.evaluate(() => ageBasis(byId('t')).label));
  ck('  ...and the age signal now fires', await p.evaluate(() => {
     const L = byId('t'); return (L.signals || []).some(s => s.k === 'A' && s.hit); }));
  ck('the career start is offered from its quote', /began his career in 1981/.test(text));
  ck('  ...and the site row retires from research — recorded, not re-run',
     await p.evaluate(() => !researchActions(byId('t')).some(a => a[0] === 'readSite')));

  // --- the web search ---------------------------------------------------------
  await p.evaluate(() => webResearch('t'));
  await p.waitForTimeout(500);
  ck('the search asks about name, employer and title together',
     webAsked.length === 1 && webAsked[0].last_name === 'Shaughnessy'
     && /Preferred Construction/.test(webAsked[0].employer), JSON.stringify(webAsked[0] || {}));
  await p.evaluate(() => { expanded = null; toggleDetail('t'); });
  await p.waitForTimeout(300);
  text = await p.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));
  ck('the record now says where he is', /Located: Knoxville, TN/.test(text));
  ck('  ...names the spouse', /Spouse: Barbara Shaughnessy/.test(text));
  ck('  ...shows the age clue as a clue, not a number',
     /Age clue: over two decades at the helm/.test(text));
  ck('  ...and the office number with an add button', /Office: 865-309-5180/.test(text));
  await p.evaluate(() => useWebLocation('t'));
  ck('accepting the location writes city and state',
     await p.evaluate(() => byId('t').city === 'Knoxville' && byId('t').state === 'TN'));
  await p.evaluate(() => useWebPhone('t'));
  ck('accepting the office number fills the empty business phone',
     await p.evaluate(() => byId('t').directPhone === '865-309-5180'));
  ck('the web row retires too', await p.evaluate(() =>
     !researchActions(byId('t')).some(a => a[0] === 'webResearch')));

  // --- a miss is an answer ----------------------------------------------------
  siteReply = { ok: false, reason: 'robots.txt disallows every conventional page', findings: null };
  webReply = { ok: true, searched: 'x', found: { summary: null, location: null, age_hints: [], ages: [], spouse: null, office_phone: null, email_pattern: null, links: {} } };
  await p.evaluate(() => { const L = byId('g'); L.employer = 'Marks LLC'; readSite('g'); });
  await p.evaluate(() => { window.appPrompt = async () => 'https://marksllc.example'; return readSite('g'); });
  await p.waitForTimeout(400);
  await p.evaluate(() => webResearch('g'));
  await p.waitForTimeout(400);
  ck('a refused site is recorded with its reason', await p.evaluate(() =>
     byId('g').site && /robots/.test(byId('g').site.reason)));
  ck('an empty web search is recorded as nothing-found, not silence',
     await p.evaluate(() => byId('g').web && !byId('g').web.found && /nothing tied/.test(byId('g').web.reason)));
  ck('  ...and neither row comes back to invite the same read twice',
     await p.evaluate(() => !researchActions(byId('g')).some(a => a[0] === 'readSite' || a[0] === 'webResearch')));
  await p.evaluate(() => { expanded = null; toggleDetail('g'); });
  await p.waitForTimeout(250);
  const gtext = await p.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));
  ck('the record says what was tried and why it gave nothing',
     /robots\.txt disallows/.test(gtext) && /nothing tied to this name and employer/.test(gtext));

  ck('no page errors', errs.length === 0, errs.slice(0, 2).join(' | '));
  console.log(fail ? `\nFAILURES: ${fail} of ${n}` : `\nall ${n} checks passed`);
  await b.close(); process.exit(fail ? 1 : 0);
})();
