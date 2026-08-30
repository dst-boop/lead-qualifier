// The Life Data doctrine and the loop that closes.
//
// "As the app is used, data enriched, leads used and converted, the app MUST
//  continuously analyze to better grade, enrich, source, and identify the
//  highest quality leads."
//
// Two halves. lifeInsights() reads outcomes back into the grading — did the
// leads the rubric liked actually convert? — and it must stay honest: no rate
// on a sample too small to mean anything, suggestions only, never silent
// retuning. The Life Data export is the lifetime record: every lead, its
// grade, what fired, what was bought, and what happened, in one CSV.
const { chromium } = require('playwright');

const feat = o => ({ whitepages: true, ai_qc: true, server_state: true, drive: false,
                     zoominfo: false, edgar: true, zi_mcp: false, opportunities: false,
                     free_sources: true, ...o });
const me = o => ({ signed_in: true, provider: 'password', name: 'ana',
                   email: 'ana@x.com', providers: { google: true, microsoft: true },
                   features: feat(), storage: 'firestore', linked_google: false,
                   linked_microsoft: false, ...o });

(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })
    .catch(() => chromium.launch());
  const ctx = await b.newContext({ viewport: { width: 1500, height: 1000 } });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  p.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE: ' + m.text()); });

  await p.route('**/api/me', r => r.fulfill({ json: me() }));
  await p.route('**/api/settings', r => r.fulfill({ json: { ok: true } }));
  await p.route('**/api/lists', r => r.fulfill({ json: { lists: [{ id: 'default', name: 'All leads', count: 0, role: 'owner', owner: '' }], settings: {} } }));
  await p.route('**/api/lists/*', r => r.request().method() === 'GET'
    ? r.fulfill({ json: { list: { id: 'default', name: 'All leads' }, settings: {}, leads: [] } })
    : r.fulfill({ json: { ok: true, lists: [{ id: 'default', name: 'All leads', count: 1, role: 'owner', owner: '' }] } }));

  let fail = 0, n = 0;
  const ck = (name, c, d) => { n++; console.log((c ? 'ok   ' : 'FAIL ') + name + (d !== undefined ? '  ' + d : '')); if (!c) fail++; };

  await p.goto('http://127.0.0.1:8099/', { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => window.ME && typeof lifeInsights === 'function', null, { timeout: 15000 });
  await p.waitForTimeout(400);

  // --- the math, on a cohort built to have known answers ----------------------
  // 30 worked leads. Tier A converts at 60%, C at 10%. Signal V fires on ten
  // worked leads (8 set) and misses on twenty (2 set). The same ten carry
  // household data. Six work at Meridian (all set).
  const I = await p.evaluate(() => {
    const mk = (i, o) => ({ id: 'L' + i, firstName: 'F' + i, lastName: 'N' + i, title: 'VP',
      employer: o.emp || ('Co' + i), state: 'NY', status: o.st, tier: o.tier, score: o.sc || 70,
      signals: o.sig || [], activity: [], ...o });
    const L = [];
    for (let i = 0; i < 10; i++) L.push(mk(i, { st: i < 6 ? 'Set' : 'Called', tier: 'A',
      sig: [{ k: 'V', label: 'tenure', hit: i < 5 }], hd: i < 5 ? { age: 60 } : undefined,
      emp: i < 6 ? 'Meridian' : undefined }));
    for (let i = 10; i < 20; i++) L.push(mk(i, { st: i < 13 ? 'Set' : 'Not Interested', tier: 'B',
      sig: [{ k: 'V', label: 'tenure', hit: i < 15 }], hd: i < 15 ? { age: 61 } : undefined }));
    for (let i = 20; i < 30; i++) L.push(mk(i, { st: i < 21 ? 'Set' : 'Has Advisor', tier: 'C',
      sig: [{ k: 'V', label: 'tenure', hit: false }] }));
    for (let i = 30; i < 35; i++) L.push(mk(i, { st: 'New', tier: 'B' }));
    window.__cohort = L;
    return lifeInsights(L);
  });
  ck('the funnel counts leads, worked, and set', I.n === 35 && I.worked === 30 && I.wonN === 10,
     JSON.stringify({ n: I.n, worked: I.worked, wonN: I.wonN }));
  const tA = I.tiers.find(t => t.t === 'A'), tC = I.tiers.find(t => t.t === 'C');
  ck('tier set-rates are computed on worked leads only',
     tA && Math.round(tA.rate * 100) === 60 && tC && Math.round(tC.rate * 100) === 10,
     JSON.stringify(I.tiers));
  const sV = I.signals.find(s => s.k === 'V');
  ck('signal lift compares fired vs not-fired among worked leads',
     sV && sV.hitN === 10 && sV.missN === 20, JSON.stringify(sV));
  ck('  ...with the right rates on each side',
     sV && Math.round(sV.hitRate * 100) === 80 && Math.round(sV.missRate * 100) === 10,
     sV && sV.hitRate + ' vs ' + sV.missRate);
  const eHd = I.enrich.find(e => /household/i.test(e.name));
  ck('enrichment spend is judged by outcome, both sides sampled',
     eHd && eHd.yesN === 10 && eHd.noN === 20 && eHd.yesRate === 0.8,
     JSON.stringify(eHd));
  ck('an employer with enough worked leads is ranked',
     I.employers.some(x => x.e === 'Meridian' && x.n === 6 && Math.round(x.rate * 100) === 100),
     JSON.stringify(I.employers));
  ck('the strongest signal earns a source-toward-it suggestion',
     I.suggest.some(s => /strongest predictor/.test(s)), I.suggest.join(' | ').slice(0, 120));
  ck('a paying enrichment earns an earning-its-cost suggestion',
     I.suggest.some(s => /earning its cost/.test(s)));
  ck('a converting employer suggestion carries the Equitable pre-approval warning',
     I.suggest.some(s => /Meridian/.test(s) && /Equitable pre-approval/.test(s)));

  // --- honesty guards ---------------------------------------------------------
  const small = await p.evaluate(() => lifeInsights(window.__cohort.slice(0, 4)));
  ck('four worked leads produce NO signal rows — no noise wearing a percent sign',
     small.signals.length === 0 && small.tiers.length === 0, JSON.stringify(small.signals));
  const flat = await p.evaluate(() => {
    // Tier C converting as well as A must be called out, not hidden.
    const L = window.__cohort.map(x => ({ ...x }));
    L.filter(x => x.tier === 'C').forEach((x, i) => { x.status = i < 7 ? 'Set' : 'Called'; });
    return lifeInsights(L);
  });
  ck('a rubric that is not separating quality says so',
     flat.suggest.some(s => /not separating quality/.test(s)), flat.suggest.join('|').slice(0, 100));

  // --- the panel --------------------------------------------------------------
  await p.evaluate(() => { state.leads = window.__cohort; activeList = 'default'; render(); });
  await p.click('#btnMore'); await p.waitForTimeout(150);
  await p.click('#btnInsights'); await p.waitForTimeout(250);
  const panel = await p.evaluate(() => ({
    open: document.getElementById('mInsights').classList.contains('open'),
    text: document.getElementById('insBody').innerText.replace(/\s+/g, ' '),
  }));
  ck('the panel opens from the More menu', panel.open);
  ck('  ...showing tiers, signals, enrichment and employers',
     /Set rate by tier/.test(panel.text) && /Signal lift/.test(panel.text)
     && /enrichment spend/.test(panel.text) && /Employers that convert/.test(panel.text),
     panel.text.slice(0, 140));
  ck('  ...and its suggestions promise no silent changes',
     /never silent changes/.test(panel.text) && /ICP settings/.test(panel.text));
  ck('  ...with no off-master warning when on All leads', !/lifetime picture/.test(panel.text));
  await p.evaluate(() => { closeModal('mInsights'); activeList = 'camp1'; renderInsights(); });
  ck('on a campaign list it points at All leads for the lifetime picture',
     await p.evaluate(() => /lifetime picture/.test(document.getElementById('insBody').innerText)));
  await p.evaluate(() => { activeList = 'default'; });

  // --- too-few-outcomes message renders, rather than empty sections -----------
  await p.evaluate(() => { state.leads = window.__cohort.slice(0, 8).map(x => ({ ...x, status: 'New' })); renderInsights(); });
  ck('with nothing worked the panel says what to do, not nothing',
     await p.evaluate(() => /Keep setting statuses/.test(document.getElementById('insBody').innerText)));

  // --- Life Data export -------------------------------------------------------
  await p.evaluate(() => { state.leads = window.__cohort; render(); });
  const csv = await p.evaluate(() => new Promise(res => {
    const old = window.dl;
    window.dl = (blob, name) => { window.dl = old; blob.text().then(t => res({ name, t })); };
    document.getElementById('btnLifeData').click();
  }));
  ck('the export is named for what it is', /^life-data-\d{4}-\d{2}-\d{2}\.csv$/.test(csv.name), csv.name);
  const lines = csv.t.split('\r\n');
  ck('every lead is in it — current, worked, and untouched alike',
     lines.length === 1 + 35, lines.length);
  const H = lines[0].split(',');
  ck('the header carries identity, grade, provenance and outcome',
     ['Status', 'Set', 'Tier', 'Score', 'Signals fired', 'Household data', 'AI grade', 'Created', 'Last updated']
       .every(h => H.includes(h)), lines[0]);
  const setCol = H.indexOf('Set'), stCol = H.indexOf('Status');
  const parse = l => { const o = []; let cur = '', q = false;
    for (const c of l) { if (q) { if (c === '"') q = false; else cur += c; }
      else if (c === '"') q = true; else if (c === ',') { o.push(cur); cur = ''; } else cur += c; }
    o.push(cur); return o; };
  const rows = lines.slice(1).map(parse);
  ck('a converted lead is marked Set=yes',
     rows.filter(r => r[setCol] === 'yes').length === 10, rows.filter(r => r[setCol] === 'yes').length);
  ck('an untouched lead still exports, as New',
     rows.filter(r => r[stCol] === 'New').length === 5);

  // --- the menu explains both, like everything else in it ---------------------
  const menu = await p.evaluate(() => ['btnInsights', 'btnLifeData'].map(id => {
    const el = document.getElementById(id);
    return { label: (el.childNodes[0].textContent || '').trim(), says: (el.querySelector('small') || {}).textContent || '' };
  }));
  ck('both menu items explain themselves', menu.every(m => m.says.length > 40), JSON.stringify(menu.map(m => m.label)));

  ck('no page errors', errs.length === 0, errs.slice(0, 2).join(' | '));
  console.log(fail ? `\nFAILURES: ${fail} of ${n}` : `\nall ${n} checks passed`);
  await b.close(); process.exit(fail ? 1 : 0);
})();
