// Tier 4: the operator uploads a screenshot of a lead's public profile and
// Claude reads the printed text. Every finding carries the text it was read
// from, NOTHING lands on the lead until the operator confirms it, a screenshot
// of somebody else can confirm nothing, and a confirmed line survives a
// re-read. Then "delete this person" — the purge path those new fields owe —
// takes the lead and everything learned about them off every list at once.
const { chromium } = require('playwright');

const feat = o => ({ whitepages: true, ai_qc: true, server_state: true, drive: false,
                     zoominfo: false, edgar: false, zi_mcp: false, opportunities: false,
                     free_sources: true, site_reader: false, web_research: true,
                     profile_image: true, ...o });
const me = o => ({ signed_in: true, provider: 'password', name: 'ana', email: 'ana@x.com',
                   providers: { google: true }, features: feat(), storage: 'firestore', ...o });

const FOUND = {
  profile_name: 'Dana Whitfield',
  location: { city: 'Seattle', state: 'WA', quote: 'Greater Seattle Area' },
  education: [
    { school: 'Purdue University', degree: 'BS', field: 'Mechanical Engineering', start_year: 1982,
      end_year: 1986, quote: 'Purdue University BS, Mechanical Engineering 1982 - 1986' },
    { school: 'University of Washington', degree: 'MBA', field: null, start_year: null,
      end_year: 1994, quote: 'University of Washington MBA 1994' }],
  certifications: [{ name: 'PE', issuer: 'WA DOL', year: 1991, quote: 'Professional Engineer (PE)' }],
  career: [
    { title: 'Director, Propulsion', employer: 'Boeing', start_year: 1996, end_year: null, current: true,
      quote: 'Director, Propulsion · Boeing · 1996 - Present' },
    { title: 'Engineer', employer: 'Pratt & Whitney', start_year: 1986, end_year: 1996, current: false,
      quote: 'Engineer · Pratt & Whitney · 1986 - 1996' }],
  interests: [{ text: 'Habitat for Humanity volunteer', quote: 'Volunteer, Habitat for Humanity' }],
  grad_year: { year: 1986, quote: 'Purdue University BS, Mechanical Engineering 1982 - 1986', school: 'Purdue University' },
  career_start: { year: 1986, quote: 'Engineer · Pratt & Whitney · 1986 - 1996' } };

// A real 1x1 PNG, so the browser's own decode path runs on the upload.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })
    .catch(() => chromium.launch());
  const p = await b.newPage({ viewport: { width: 1500, height: 1000 } });
  await p.addInitScript(() => { window.__unfold = true; });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  p.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE: ' + m.text()); });

  let reply = { ok: true, found: FOUND, tokens: { input: 1400, output: 310 }, stored: false };
  const asked = [], forgot = [];
  await p.route('**/api/me', r => r.fulfill({ json: me() }));
  await p.route('**/api/settings', r => r.fulfill({ json: { ok: true } }));
  await p.route('**/api/profile-image', r => { asked.push(JSON.parse(r.request().postData()));
    return r.fulfill({ json: reply }); });
  await p.route('**/api/leads/forget', r => { forgot.push(JSON.parse(r.request().postData()));
    return r.fulfill({ json: { ok: true, removed: { default: 1 }, total: 1, shared_lists_not_touched: 0 } }); });
  await p.route('**/api/lists', r => r.fulfill({ json: { lists: [{ id: 'default', name: 'All leads', count: 3, role: 'owner', owner: '' }], settings: {} } }));
  await p.route('**/api/lists/*', r => r.request().method() === 'GET'
    ? r.fulfill({ json: { list: { id: 'default', name: 'All leads' }, settings: {}, leads: [
        { id: 'd', firstName: 'Dana', lastName: 'Whitfield', title: 'Director', employer: 'Boeing',
          email: 'dana@boeing.com', gradYear: '1988', status: 'New', activity: [] },
        { id: 'm', firstName: 'Mark', lastName: 'Ortiz', title: 'VP', employer: 'Delta',
          email: 'mark@delta.com', status: 'New', activity: [] },
        { id: 'n', firstName: 'Dana', lastName: 'Whitfield', title: 'Manager', employer: 'Chevron',
          status: 'New', activity: [] }] } })
    : r.fulfill({ json: { ok: true, lists: [] } }));

  let fail = 0, n = 0;
  const ck = (name, c, d) => { n++; console.log((c ? 'ok   ' : 'FAIL ') + name + (d !== undefined ? '  ' + d : '')); if (!c) fail++; };
  const text = () => p.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));
  const reopen = async id => { await p.evaluate(i => { expanded = null; toggleDetail(i); }, id); await p.waitForTimeout(250); };

  await p.goto('http://127.0.0.1:8099/', { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => window.__booted && typeof readProfileImage === 'function', null, { timeout: 15000 });

  // --- offered, priced as tokens ------------------------------------------------
  const row = await p.evaluate(() => researchActions(byId('d')).find(a => a[0] === 'profileImage'));
  ck('the research panel offers a profile screenshot', !!row);
  ck('  ...priced as AI tokens, not credits', row && /AI tokens/.test(row[3]), row && row[3]);
  ck('  ...and says the image is not kept', row && /not kept/.test(row[2]));
  ck('dark without the feature', await p.evaluate(() => {
    const f = ME.features.profile_image; ME.features.profile_image = false;
    const off = !researchActions(byId('d')).some(a => a[0] === 'profileImage');
    ME.features.profile_image = f; return off; }));

  // --- the real upload path: file chooser -> browser decode -> POST ----------------
  const [chooser] = await Promise.all([p.waitForEvent('filechooser'), p.evaluate(() => { profileImage('d'); })]);
  await chooser.setFiles({ name: 'dana.png', mimeType: 'image/png', buffer: PNG });
  await p.waitForFunction(() => byId('d').img, null, { timeout: 5000 });
  ck('the screenshot was posted as a data URL with the lead’s name',
     asked.length === 1 && /^data:image\/png;base64,/.test(asked[0].image) && asked[0].last_name === 'Whitfield',
     asked[0] && asked[0].image.slice(0, 30));
  ck('  ...and no URL of any profile was sent', asked.length === 1 && !/https?:/.test(JSON.stringify(asked[0]).replace(asked[0].image, '')));

  // --- nothing lands until confirmed ------------------------------------------------
  ck('the graduation year on the lead is untouched until confirmed',
     await p.evaluate(() => byId('d').gradYear === '1988'));
  ck('  ...no profile lines are on the lead yet', await p.evaluate(() => !hasProfile(byId('d'))));
  ck('the extraction is recorded with its provenance and cost', await p.evaluate(() =>
     byId('d').img.src === 'extracted-from-image' && byId('d').img.tokens.input === 1400));
  ck('the row retires — one answer, not an invitation to spend again',
     await p.evaluate(() => !researchActions(byId('d')).some(a => a[0] === 'profileImage')));
  await reopen('d');
  let t = await text();
  ck('the record shows each line with the text it came from',
     /Education: Purdue University/.test(t) && /Purdue University BS, Mechanical Engineering 1982 - 1986/.test(t));
  ck('the conflict with the list’s grad year is surfaced, not resolved',
     /Bachelor’s 1986 — the list says 1988/.test(t) && /Replace 1988 with 1986/.test(t));
  ck('the token cost is on the record', /1,710 AI tokens/.test(t));
  ck('  ...and it says the image itself was not kept', /image itself was not kept/.test(t));
  ck('the activity log carries the read', await p.evaluate(() =>
     byId('d').activity.some(a => a.k === 'img' && /bachelor’s 1986/.test(a.d))));

  // --- confirming -------------------------------------------------------------------
  const before = await p.evaluate(() => byId('d').score);
  await p.evaluate(() => confirmImgGrad('d'));
  ck('confirming the grad year writes it, marked as from a screenshot',
     await p.evaluate(() => byId('d').gradYear === 1986 && byId('d').gradYearSrc === 'image'));
  ck('  ...and the age basis says so, still as an inference',
     await p.evaluate(() => /graduated 1986 \(screenshot\)/.test(ageBasis(byId('d')).label) && ageBasis(byId('d')).kind === 'inferred'),
     await p.evaluate(() => ageBasis(byId('d')).label));
  ck('  ...and never as a confirmed age', await p.evaluate(() => leadAge(byId('d')) === null));
  ck('  ...and the lead was re-scored', await p.evaluate(() => typeof byId('d').score === 'number'), before);
  await p.evaluate(() => { confirmImgItem('d', 'certifications', 0); confirmImgItem('d', 'education', 0); confirmImgItem('d', 'education', 0); });
  ck('a confirmed line moves onto the lead’s profile, once', await p.evaluate(() =>
     byId('d').profile.certifications.length === 1 && byId('d').profile.education.length === 1
     && byId('d').profile.education[0].src === 'extracted-from-image' && byId('d').profile.education[0].confirmedAt > 0));
  ck('an unknown kind is ignored', await p.evaluate(() => { confirmImgItem('d', 'salary', 0); return !byId('d').profile.salary; }));
  await reopen('d');
  t = await text();
  ck('the record lists what was confirmed', /Confirmed from screenshots/i.test(t) && /Certifications: PE · WA DOL · 1991/.test(t));

  // --- Life Data carries confirmed lines ---------------------------------------------
  const csv = await p.evaluate(() => new Promise(res => {
    const orig = window.dl; window.dl = (blob) => { blob.text().then(res); window.dl = orig; };
    document.getElementById('btnLifeData').click(); }));
  const [head, ...rows] = csv.split('\r\n');
  const H = head.split(',');
  const dRow = rows.find(r => r.includes('Whitfield') && r.includes('Boeing')) || '';
  ck('Life Data has the confirmed education and certification columns',
     H.includes('Education (confirmed from screenshot)') && H.includes('Certifications (confirmed from screenshot)'));
  ck('  ...filled for the lead', /Purdue University/.test(dRow) && /PE · WA DOL · 1991/.test(dRow), dRow.slice(-120));

  // --- a namesake's screenshot confirms nothing ---------------------------------------
  reply = { ok: true, found: { ...FOUND, profile_name: 'Mark Chen' }, tokens: { input: 900, output: 200 } };
  await p.evaluate(() => readProfileImage('m', 'data:image/png;base64,iVBORw0KGgo='));
  await p.waitForTimeout(300);
  await reopen('m');
  t = await text();
  ck('a profile naming someone else is flagged loudly', /This profile says Mark Chen/.test(t));
  ck('  ...with no confirm buttons offered', await p.evaluate(() =>
     !document.querySelector('#research-m') || !document.body.innerHTML.includes("confirmImgGrad('m')")));
  await p.evaluate(() => { confirmImgGrad('m'); confirmImgItem('m', 'education', 0); });
  ck('  ...and a direct call cannot write either', await p.evaluate(() => !byId('m').gradYear && !hasProfile(byId('m'))));
  ck('the log names the mismatch', await p.evaluate(() => byId('m').activity.some(a => /NAME MISMATCH/.test(a.d))));

  // --- a re-read keeps what was confirmed, behind a confirmation ----------------------
  let prompted = '';
  await p.evaluate(() => { window.appConfirm = async (m) => { window.__asked = m; return false; }; profileImage('d'); });
  await p.waitForTimeout(200);
  prompted = await p.evaluate(() => window.__asked || '');
  ck('reading another screenshot asks first, naming the token spend', /AI tokens again/.test(prompted), prompted);
  reply = { ok: true, found: { profile_name: null, location: null, education: [], certifications: [], career: [], interests: [], grad_year: null, career_start: null }, tokens: { input: 800, output: 20 } };
  await p.evaluate(() => readProfileImage('d', 'data:image/png;base64,iVBORw0KGgo='));
  await p.waitForTimeout(300);
  ck('an unreadable screenshot is recorded as a miss with its reason', await p.evaluate(() =>
     byId('d').img.found === null && /no profile text/.test(byId('d').img.reason)));
  ck('  ...and the lines confirmed earlier are still on the lead', await p.evaluate(() =>
     byId('d').profile.certifications.length === 1 && byId('d').gradYear === 1986));

  // --- delete this person ------------------------------------------------------------
  await reopen('d');
  ck('the record offers Delete this person', /Delete this person/.test(await text()));
  await p.evaluate(() => { window.appConfirm = async () => false; return forgetLead('d'); });
  ck('declining the confirmation deletes nothing', forgot.length === 0 && await p.evaluate(() => !!byId('d')));
  await p.evaluate(() => { window.appConfirm = async (m) => { window.__asked = m; return true; }; return forgetLead('d'); });
  await p.waitForTimeout(200);
  ck('the confirmation names what goes and that it is final', await p.evaluate(() =>
     /screenshot extractions/.test(window.__asked) && /master list/.test(window.__asked) && /cannot be undone/.test(window.__asked)));
  ck('the server is asked to forget them by row id and email',
     forgot.length === 1 && forgot[0].keys.includes('lid:d') && forgot[0].keys.includes('em:dana@boeing.com'),
     JSON.stringify(forgot[0]));
  ck('  ...and by name@employer, which the server only honours on rows with no identity of their own',
     forgot.length === 1 && forgot[0].keys.includes('ne:dana whitfield@boeing'));
  ck('the lead is gone from the page', await p.evaluate(() => !byId('d')));
  ck('  ...and the namesake at Chevron is still here', await p.evaluate(() => !!byId('n')));


  // --- rows the server keeps off a save are dropped from the page too ----------
  await p.unroute('**/api/lists/*');
  await p.route('**/api/lists/*', r => r.fulfill({ json: { ok: true, lists: [{ id: 'default', name: 'All leads', count: 1, role: 'owner', owner: '' }], suppressed: ['m'] } }));
  await p.evaluate(() => { byId('n').notes = 'touched'; save(); });
  await p.waitForFunction(() => !byId('m'), null, { timeout: 3000 }).catch(() => {});
  ck('a row the server refused as deleted-earlier leaves the page', await p.evaluate(() => !byId('m') && !!byId('n')));

  // --- a list someone else owns is never written from here -----------------------
  await p.waitForTimeout(700);                 // let dropSuppressed's own save land first
  let puts = 0;
  await p.unroute('**/api/lists/*');
  await p.route('**/api/lists/*', r => { if (r.request().method() === 'PUT') puts++;
    return r.fulfill({ json: { ok: true, lists: [], suppressed: [] } }); });
  await p.evaluate(() => { activeList = 'boss@x.com~camp'; window.appConfirm = async () => true; return forgetLead('n'); });
  await p.waitForTimeout(700);
  ck('deleting while a shared list is open purges your lists on the server', forgot.length === 2);
  ck('  ...but leaves the owner\u2019s list alone: no local removal, no write back',
     await p.evaluate(() => !!byId('n')) && puts === 0, 'puts=' + puts);


  // --- paid lookups hand back their cache ids; deletion sends them -------------
  const REF = 'wp:' + 'a'.repeat(64);
  await p.route('**/api/verify-phone', r => r.fulfill({ json: { valid: true }, headers: { 'X-Cache-Refs': REF } }));
  const got = await p.evaluate(async () => { const d = await api('/api/verify-phone', { phone: '1' });
    const L = byId('n'); keepRefs(L, d); keepRefs(L, d);
    return { refs: L.cacheRefs, leaks: Object.keys(d).includes('__refs') || JSON.stringify(d).includes('__refs') }; });
  ck('a lookup\u2019s cache id is kept on the lead, once', JSON.stringify(got.refs) === JSON.stringify([REF]), JSON.stringify(got));
  ck('  ...without leaking into the response object that gets saved', !got.leaks);
  await p.evaluate(() => { activeList = 'default'; window.appConfirm = async () => true; return forgetLead('n'); });
  await p.waitForTimeout(300);
  ck('Delete this person sends the lead\u2019s cache ids for purging',
     forgot.length === 3 && JSON.stringify(forgot[2].cache_refs) === JSON.stringify([REF]), JSON.stringify(forgot[2] || {}));

  ck('no page errors', errs.length === 0, errs.slice(0, 2).join(' | '));
  console.log(fail ? `\nFAILURES: ${fail} of ${n}` : `\nall ${n} checks passed`);
  await b.close(); process.exit(fail ? 1 : 0);
})();
