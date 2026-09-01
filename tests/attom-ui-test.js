// The Attom trial, in the record.
//
// Temporary by construction: the row exists only while the trial key does and
// only for a lead with a street address (the household enrich and web
// research provide exactly that). The value renders with its range and the
// deed check — a surname on the deed corroborates, a trust or LLC warns —
// and both a hit and a miss retire the button. The evaluation is wired too:
// Attom joins the What's-converting enrichment comparison, and the Life Data
// export carries the value out.
const { chromium } = require('playwright');

const feat = o => ({ whitepages: true, ai_qc: false, server_state: true, drive: false,
                     zoominfo: false, edgar: false, zi_mcp: false, opportunities: false,
                     free_sources: true, attom: true, ...o });
const me = o => ({ signed_in: true, provider: 'password', name: 'ana', email: 'ana@x.com',
                   providers: { google: true }, features: feat(), storage: 'firestore', ...o });

(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })
    .catch(() => chromium.launch());
  const p = await b.newPage({ viewport: { width: 1500, height: 1000 } });
  // A content suite: it asserts on what the record holds, so open every
  // fold up front. recordcard-test.js owns the folded-by-default behavior.
  await p.addInitScript(()=>{window.__unfold=true;});
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  p.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE: ' + m.text()); });

  let reply = { found: true, address: '926 Crystal Bayou Blvd, Knoxville, TN 37853',
                avm: 612000, avm_high: 655000, avm_low: 570000, avm_score: 91,
                sale_amount: 240000, sale_date: '2004-06-15', year_built: 1992,
                owners: ['TIM J SHAUGHNESSY', 'BARBARA SHAUGHNESSY'] };
  const asked = [];
  await p.route('**/api/me', r => r.fulfill({ json: me() }));
  await p.route('**/api/settings', r => r.fulfill({ json: { ok: true } }));
  await p.route('**/api/attom', r => { asked.push(JSON.parse(r.request().postData()));
    return r.fulfill({ json: reply }); });
  await p.route('**/api/lists', r => r.fulfill({ json: { lists: [{ id: 'default', name: 'All leads', count: 3, role: 'owner', owner: '' }], settings: {} } }));
  await p.route('**/api/lists/*', r => r.request().method() === 'GET'
    ? r.fulfill({ json: { list: { id: 'default', name: 'All leads' }, settings: {}, leads: [
        // t: household enriched — has the address Attom needs.
        { id: 't', firstName: 'Tim', lastName: 'Shaughnessy', title: 'Owner',
          employer: 'Preferred Construction', email: 't@x.com', status: 'New', activity: [],
          hd: { street: '926 Crystal Bayou Blvd', city: 'Knoxville', state: 'TN', zip: '37853',
                age: 68, mobiles: [], read: 99 },
          pv: { label: 'Mobile', ok: true, field: 'mobilePhone' }, mobilePhone: '(865) 555-0101' },
        // n: no address anywhere — the row must not appear.
        { id: 'n', firstName: 'Nia', lastName: 'Cole', title: 'VP', employer: 'Acme',
          email: 'n@x.com', status: 'New', activity: [] },
        // x: deed under an LLC — the corroboration warning case.
        { id: 'x', firstName: 'Raj', lastName: 'Patel', title: 'CEO', employer: 'Zed',
          email: 'r@x.com', status: 'New', activity: [],
          street: '5 Elm St', city: 'Rye', state: 'NY', zip: '10580' }] } })
    : r.fulfill({ json: { ok: true, lists: [] } }));

  let fail = 0, n = 0;
  const ck = (name, c, d) => { n++; console.log((c ? 'ok   ' : 'FAIL ') + name + (d !== undefined ? '  ' + d : '')); if (!c) fail++; };

  await p.goto('http://127.0.0.1:8099/', { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => window.ME && typeof attomAddr === 'function', null, { timeout: 15000 });
  await p.waitForTimeout(500);

  // --- the row appears exactly where it can act -------------------------------
  ck('a lead with a household address offers the trial lookup', await p.evaluate(() =>
     researchActions(byId('t')).some(a => a[0] === 'attomValue')));
  ck('  ...its label says it is a trial', await p.evaluate(() =>
     /trial/.test((researchActions(byId('t')).find(a => a[0] === 'attomValue') || [])[1])));
  ck('a lead with no address gets no row — nothing to ask about', await p.evaluate(() =>
     !researchActions(byId('n')).some(a => a[0] === 'attomValue')));
  ck('a lead with only list-address fields still qualifies', await p.evaluate(() =>
     researchActions(byId('x')).some(a => a[0] === 'attomValue')));
  ck('without the trial key the row is gone everywhere', await p.evaluate(() => {
     const was = ME.features.attom; ME.features.attom = false;
     const gone = !researchActions(byId('t')).some(a => a[0] === 'attomValue');
     ME.features.attom = was; return gone; }));

  // --- the lookup -------------------------------------------------------------
  await p.evaluate(() => attomValue('t'));
  await p.waitForTimeout(400);
  ck('the household address is what gets priced',
     asked.length === 1 && /Crystal Bayou/.test(asked[0].street) && asked[0].city === 'Knoxville',
     JSON.stringify(asked[0] || {}));
  await p.evaluate(() => { expanded = null; toggleDetail('t'); });
  await p.waitForTimeout(300);
  let text = await p.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));
  ck('the record shows the estimate with its confidence and range',
     /Estimated value \(confidence 91\/100\)/.test(text) && /\$612,000/.test(text)
     && /\$570,000–\$655,000/.test(text), text.slice(0, 60));
  ck('  ...the last sale and year built', /Last sale · 2004-06-15/.test(text) && /\$240,000/.test(text) && /1992/.test(text));
  ck('  ...and the deed, which carries their surname — corroborated',
     /TIM J SHAUGHNESSY/.test(text) && !/does not carry their surname/.test(text));
  ck('  ...labelled an estimate and trial data, not an appraisal',
     /an automated estimate, not an appraisal/.test(text) && /Trial data/.test(text));
  ck('the row retires — recorded, never re-billed', await p.evaluate(() =>
     !researchActions(byId('t')).some(a => a[0] === 'attomValue')));

  // --- the deed warning -------------------------------------------------------
  reply = { found: true, address: '5 Elm St, Rye, NY 10580', avm: 890000,
            owners: ['ELM STREET HOLDINGS LLC'] };
  await p.evaluate(() => attomValue('x'));
  await p.waitForTimeout(400);
  await p.evaluate(() => { expanded = null; toggleDetail('x'); });
  await p.waitForTimeout(300);
  text = await p.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));
  ck('a deed without their surname warns instead of corroborating',
     /does not carry their surname/.test(text) && /trust, an LLC, or the wrong door/.test(text));

  // --- a miss is an answer ----------------------------------------------------
  reply = { found: false, reason: 'No property on file at that address.' };
  await p.evaluate(() => { const L = byId('n'); L.street = '1 Void Way'; L.city = 'Nowhere'; L.state = 'KS'; render(); });
  await p.evaluate(() => attomValue('n'));
  await p.waitForTimeout(400);
  ck('a miss is recorded on the lead with its reason', await p.evaluate(() =>
     byId('n').attom && byId('n').attom.found === false && /No property/.test(byId('n').attom.reason)));
  ck('  ...and retires the row like any recorded answer', await p.evaluate(() =>
     !researchActions(byId('n')).some(a => a[0] === 'attomValue')));

  // --- the evaluation is wired ------------------------------------------------
  const roi = await p.evaluate(() => {
    const L = [];
    for (let i = 0; i < 20; i++) L.push({ id: 'e' + i, status: i % 2 ? 'Set' : 'Called',
      tier: 'B', signals: [], activity: [],
      attom: i < 10 ? { avm: 500000 } : undefined });
    return lifeInsights(L).enrich.map(e => e.name);
  });
  ck('What’s-converting compares Attom-valued leads against the rest',
     roi.includes('Attom home value'), JSON.stringify(roi));
  const csv = await p.evaluate(() => new Promise(res => {
    const old = window.dl;
    window.dl = (blob, name) => { window.dl = old; blob.text().then(t => res(t)); };
    document.getElementById('btnLifeData').click();
  }));
  ck('the Life Data export carries the home value out',
     csv.split('\r\n')[0].endsWith('Home value (Attom)')
     && csv.split('\r\n').some(l => l.endsWith(',612000')), csv.split('\r\n')[0].slice(-40));

  ck('no page errors', errs.length === 0, errs.slice(0, 2).join(' | '));
  console.log(fail ? `\nFAILURES: ${fail} of ${n}` : `\nall ${n} checks passed`);
  await b.close(); process.exit(fail ? 1 : 0);
})();
