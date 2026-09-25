// "The user needs to be able to automate as much of this process as possible
// directly through the app." Autopilot: one plan that states the worst case,
// one approval, then the app runs the steps cheapest-first. The WhitePages
// calls of a run carry the run header (so the server can hold them to the
// approved cap), a refusal stops the step instead of hammering every lead, the
// run survives a reload, and switching lists mid-run is refused.
const { chromium } = require('playwright');

const feat = o => ({ whitepages: true, ai_qc: true, server_state: true, drive: false,
                     zoominfo: false, edgar: false, zi_mcp: false, opportunities: false,
                     free_sources: true, web_research: true, ...o });
const me = o => ({ signed_in: true, provider: 'password', name: 'ana', email: 'ana@x.com',
                   providers: { google: true }, features: feat(), storage: 'firestore',
                   credits: { month: '2026-09', whitepages: { spent: 0, budget: 100, left: 100, yours_left: 40 } }, ...o });

const LEADS = () => [
  { id: 'a', firstName: 'Ada', lastName: 'Zeta', title: 'CFO', employer: 'Boeing', state: 'WA',
    mobilePhone: '(914) 555-0101', email: 'a@x.com', status: 'New', activity: [] },
  { id: 'b', firstName: 'Bea', lastName: 'Young', title: 'VP', employer: 'Acme', state: 'NY',
    email: 'b@x.com', status: 'New', activity: [] },
  { id: 'c', firstName: 'Cal', lastName: 'Xu', title: 'SVP', employer: 'Delta', state: 'GA',
    mobilePhone: '(404) 555-0103', email: 'c@x.com', status: 'New', activity: [] },
];

(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })
    .catch(() => chromium.launch());
  const p = await b.newPage({ viewport: { width: 1500, height: 1000 } });
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  p.on('console', m => { if (m.type() === 'error' && !/status of 400/.test(m.text())) errs.push('CONSOLE: ' + m.text()); });

  const calls = [];                 // [route, hadRunHeader]
  let job = null, wpCharged = 0, refuseWp = false, listRun = null;
  const hdr = r => !!r.request().headers()['x-autopilot-job'];
  const wpRoute = name => r => {
    calls.push([name, hdr(r)]);
    if (hdr(r)) {
      if (refuseWp || wpCharged >= job.caps.wp)
        return r.fulfill({ status: 400, json: { detail: `This autopilot run has used the ${job.caps.wp} WhitePages lookups you approved, so nothing more was looked up.` } });
      wpCharged++;
    }
    return name === 'verify'
      ? r.fulfill({ json: { valid: true, line_type: 'Mobile', name_match: true,
          record: { found: true, age: 61, home_city: 'Rye', home_state: 'NY', mobiles: ['9145550101'], read: 99 } } })
      : r.fulfill({ json: { found: true, age: 62, home_city: 'Nyack', home_state: 'NY', mobiles: ['8455550102'], read: 99, matched_by: 'name' } });
  };
  await p.route('**/api/me', r => r.fulfill({ json: me() }));
  await p.route('**/api/settings', r => r.fulfill({ json: { ok: true } }));
  await p.route('**/api/credits', r => r.fulfill({ json: { whitepages: { left: 100, yours_left: 40 } } }));
  await p.route('**/api/free-enrich', r => { calls.push(['free', hdr(r)]);
    return r.fulfill({ json: { sources: { fec: { ran: true }, edgar: { ran: true } }, donations: { count: 0 }, filings: [] } }); });
  await p.route('**/api/plans', r => { calls.push(['plans', hdr(r)]); return r.fulfill({ json: { plans: {} } }); });
  await p.route('**/api/verify-phone', wpRoute('verify'));
  await p.route('**/api/enrich', wpRoute('enrich'));
  await p.route('**/api/web-research', r => { calls.push(['web', hdr(r)]);
    return r.fulfill({ json: { ok: true, searched: 'x', found: { summary: 'Found.', location: null, age_hints: [], ages: [],
      spouse: null, office_phone: null, email_pattern: null, links: {} } } }); });
  await p.route('**/api/qc', r => { const body = JSON.parse(r.request().postData()); calls.push(['qc', hdr(r), body.leads.length]);
    return r.fulfill({ json: { verdicts: body.leads.map(l => ({ i: l.i, grade: 'B', gates: {}, checklist: [] })) } }); });
  await p.route('**/api/autopilot*', r => {
    const m = r.request().method();
    if (m === 'POST') {
      const body = JSON.parse(r.request().postData());
      const wp = body.profile.steps.find(s => s.k === 'wp');
      job = { id: 'run1', list: body.list_id, profile: body.profile, caps: { wp: wp ? wp.cap : 0 },
              scope: body.scope, status: 'running', step: 0, progress: {}, wp_spent: 0 };
      wpCharged = 0;
      return r.fulfill({ json: { job } });
    }
    if (m === 'PUT') {
      const body = JSON.parse(r.request().postData());
      calls.push(['put:' + body.status + ':' + body.step, false]);
      Object.assign(job, { step: body.step, status: body.status, progress: body.progress, wp_spent: wpCharged });
      return r.fulfill({ json: { job } });
    }
    return r.fulfill({ json: { ok: true, job } });
  });
  await p.route('**/api/lists', r => r.fulfill({ json: { lists: [{ id: 'default', name: 'All leads', count: 3, role: 'owner', owner: '' },
                                                                  { id: 'camp', name: 'Campaign', count: 0, role: 'owner', owner: '' }], settings: {} } }));
  await p.route('**/api/lists/*', r => r.request().method() === 'GET'
    ? r.fulfill({ json: { list: { id: 'default', name: 'All leads' }, settings: {}, leads: LEADS(), autopilot: listRun } })
    : r.fulfill({ json: { ok: true, lists: [], suppressed: [] } }));

  let fail = 0, n = 0;
  // The run finishes when the page reports a final status to the server.
  const settled = async () => { for (let i = 0; i < 150; i++) {
    if (job && job.status !== 'running' && await p.evaluate(() => !AP)) return; await p.waitForTimeout(100); } };
  const ck = (name, c, d) => { n++; console.log((c ? 'ok   ' : 'FAIL ') + name + (d !== undefined ? '  ' + d : '')); if (!c) fail++; };

  await p.goto('http://127.0.0.1:8099/', { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => window.__booted && typeof openAutopilot === 'function', null, { timeout: 15000 });

  // --- the plan: one statement of cost, before anything runs --------------------------
  ck('the Enrich stage offers Autopilot', await p.isVisible('#btnAutopilot'));
  await p.click('#btnAutopilot');
  await p.waitForSelector('#mAutopilot.open');
  const profs = await p.$$eval('#apProfile option', os => os.map(o => o.textContent));
  ck('three starting profiles are offered', profs.length === 3 && profs.includes('Outreach-ready'), JSON.stringify(profs));
  // A ZoomInfo step it cannot run is shown, but switched off and says why.
  await p.selectOption('#apProfile', 'Outreach-ready');
  ck('a step the account cannot run is off and explained',
     await p.$eval('input[data-ap="zi"]', el => el.disabled && !el.checked)
     && /connect ZoomInfo first/.test(await p.textContent('#apSteps')));
  // Every tier, WhitePages cap 2, web cap 1, QC cap 2.
  await p.evaluate(() => {
    AP_DRAFT.steps.forEach(st => { st.tiers = ['A', 'B', 'C']; });
    AP_DRAFT.steps.find(s => s.k === 'wp').cap = 2;
    AP_DRAFT.steps.find(s => s.k === 'web').cap = 1;
    AP_DRAFT.steps.find(s => s.k === 'qc').cap = 2;
    apRenderSteps();
  });
  const plan = await p.textContent('#apPlan');
  ck('the plan states the WhitePages cap and the monthly allowance still applying',
     /at most 2 lookups/.test(plan) && /40 left this month/.test(plan), plan.slice(0, 160));
  ck('  ...and the worst case for today’s leads', /today's worst case 5/.test(plan), plan);
  const runTxt = await p.textContent('#apRun');
  ck('the Run button names what is being approved', /Approve and run — up to 2 WhitePages lookups/.test(runTxt), runTxt);
  ck('nothing ran just from opening the plan', calls.length === 0, JSON.stringify(calls));

  // --- the run ------------------------------------------------------------------------
  await p.click('#apRun');
  await p.waitForTimeout(200); await settled();
  const seq = calls.map(c => c[0]);
  const first = k => seq.indexOf(k);
  ck('steps ran cheapest first: free, WhitePages, web, QC',
     first('free') > -1 && first('free') < first('verify') && first('verify') < first('web') && first('web') < first('qc'), JSON.stringify(seq));
  ck('only WhitePages calls carried the run header',
     calls.filter(c => c[1]).every(c => c[0] === 'verify' || c[0] === 'enrich')
     && calls.filter(c => c[0] === 'verify' || c[0] === 'enrich').every(c => c[1]));
  ck('WhitePages stopped at the approved cap of 2', wpCharged === 2, 'charged=' + wpCharged);
  ck('web research ran for exactly its cap of 1', seq.filter(x => x === 'web').length === 1);
  ck('QC graded no more than its cap of 2', calls.filter(c => c[0] === 'qc').reduce((t, c) => t + c[2], 0) === 2);
  ck('the run was recorded as done on the server', job.status === 'done', job.status);
  ck('the status line clears when the run finishes', !(await p.isVisible('#apNote')));

  // --- a server refusal stops the step, not just one lead ------------------------------
  calls.length = 0; refuseWp = true;
  await p.evaluate(() => { state.leads.forEach(L => { delete L.pv; delete L.hd; delete L.web; delete L.qc; }); });
  await p.evaluate(() => { openAutopilot(); apPickProfile('Full demographic');
    AP_DRAFT.steps.forEach(st => { st.tiers = ['A', 'B', 'C']; }); AP_DRAFT.steps.find(s => s.k === 'wp').cap = 10; apRenderSteps(); });
  await p.click('#apRun');
  await p.waitForTimeout(200); await settled();
  const wpTries = calls.filter(c => c[0] === 'verify' || c[0] === 'enrich').length;
  ck('a refused lookup ends the WhitePages step instead of trying every lead', wpTries === 1, 'tries=' + wpTries);
  ck('  ...and the run still carries on to the later steps', calls.some(c => c[0] === 'qc'));
  refuseWp = false;

  // --- the run survives a reload ------------------------------------------------------
  listRun = { id: 'run9', list: 'default', status: 'running', step: 1, wp_spent: 1, caps: { wp: 3 }, scope: [], progress: {},
              profile: { name: 'Full demographic', steps: [{ k: 'free', on: true }, { k: 'wp', on: true, tiers: ['A', 'B', 'C'], cap: 3 }, { k: 'qc', on: false }] } };
  await p.reload({ waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => window.__booted, null, { timeout: 15000 });
  const note = await p.textContent('#apNote');
  ck('an interrupted run is offered for resume on load',
     /was interrupted at step 2 of 2/.test(note) && /1 of 3 approved WhitePages lookups used/.test(note), note);
  calls.length = 0; job = listRun; wpCharged = 1;
  await p.click('#apNote >> text=Resume');
  await p.waitForTimeout(200); await settled();
  ck('resume picks up at the step it stopped on — the free step is not re-run',
     !calls.some(c => c[0] === 'free') && calls.some(c => c[0] === 'verify' || c[0] === 'enrich'), JSON.stringify(calls.map(c => c[0])));
  ck('  ...and stays inside what was approved', wpCharged <= 3, 'charged=' + wpCharged);

  // --- nothing else changes lists under a running run ---------------------------------
  const blocked = await p.evaluate(async () => {
    AP = { steps: [], i: 0, job: { caps: {} }, spent: {} };
    await switchList('camp'); const still = activeList === 'default'; AP = null; return still; });
  ck('switching lists mid-run is refused', blocked);

  // --- the QC button now states its cost before spending --------------------------------
  const asked = await p.evaluate(async () => { let m = ''; const o = window.appConfirm;
    window.appConfirm = async (msg) => { m = msg; return false; };
    state.leads.forEach(L => { delete L.qc; }); render();
    document.getElementById('btnQC').style.display = ''; document.getElementById('btnQC').click();
    await new Promise(r => setTimeout(r, 200)); window.appConfirm = o; return m; });
  ck('AI quality control asks first, naming the Claude calls', /Claude call/.test(asked) && /no lookup credits/.test(asked), asked);

  ck('no page errors', errs.length === 0, errs.slice(0, 2).join(' | '));
  console.log(fail ? `\nFAILURES: ${fail} of ${n}` : `\nall ${n} checks passed`);
  await b.close(); process.exit(fail ? 1 : 0);
})();
