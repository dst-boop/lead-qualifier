const { chromium } = require('playwright');

const ME = (server_state) => ({
  signed_in: true, provider: 'google', name: 'Dan Treacy', email: 'dst@f.com',
  providers: { google: true, microsoft: false },
  features: { whitepages: true, ai_qc: false, server_state },
  storage: server_state ? 'firestore' : 'memory',
});
const LEAD = (id, last) => ({ id, firstName: 'A', lastName: last, title: 'CEO', employer: 'X',
  state: 'NY', status: 'New', notes: '', activity: [], gradYear: '1985',
  jobStartDate: '2025-01-01', yearsExperience: '30', yearsAtEmployer: '1',
  email: 'a@b.com', mobilePhone: '555-0000' });

async function run(name, opts) {
  const { server_state, serverLeads, localLeads } = opts;
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' }).catch(() => chromium.launch());
  const page = await b.newPage();
  const errs = [], puts = [];
  page.on('pageerror', e => errs.push(e.message));

  await page.route('**/api/me', r => r.fulfill({ json: ME(server_state) }));
  await page.route('**/api/state', async r => {
    if (r.request().method() === 'PUT') {
      puts.push(JSON.parse(r.request().postData()));
      return r.fulfill({ json: { ok: true, leads: puts.at(-1).leads.length } });
    }
    if (opts.failGet) return r.fulfill({ status: 503, json: { detail: 'backend down' } });
    return r.fulfill({ json: serverLeads
      ? { found: true, settings: { orgName: 'FromServer' }, leads: serverLeads }
      : { found: false, settings: {}, leads: [] } });
  });

  // seed the browser copy before the app boots
  await page.addInitScript(seed => {
    if (seed) localStorage.setItem('lq-data', JSON.stringify({ settings: { orgName: 'FromBrowser' }, leads: seed }));
  }, localLeads || null);

  await page.goto('http://127.0.0.1:8099/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);

  const got = await page.evaluate(() => ({
    n: state.leads.length,
    names: state.leads.map(l => l.lastName).join(','),
    org: state.settings.orgName || '',
    note: (document.getElementById('syncNote') || {}).textContent || '',
  }));
  console.log(`${name}\n  leads=${got.n} [${got.names}] org=${got.org} note="${got.note.trim()}" PUTs=${puts.length}`
    + (puts.length ? ` (last had ${puts.at(-1).leads.length})` : '')
    + (errs.length ? `\n  ERRORS: ${errs.join(' | ')}` : ''));
  await b.close();
  return { got, puts, errs };
}

(async () => {
  await run('1. signed in, server has the list', { server_state: true, serverLeads: [LEAD('S1','Server'), LEAD('S2','Server2')] });
  await run('2. first sign-in — browser list migrates up', { server_state: true, serverLeads: null, localLeads: [LEAD('B1','Browser')] });
  await run('3. signed in, both empty', { server_state: true, serverLeads: null, localLeads: null });
  await run('4. no Firestore — browser copy wins', { server_state: false, serverLeads: [LEAD('S1','Server')], localLeads: [LEAD('B1','Browser')] });
  await run('5. server read FAILS — must not overwrite', { server_state: true, failGet: true, localLeads: [] });
})().catch(e => { console.error(e.message); process.exit(1); });
