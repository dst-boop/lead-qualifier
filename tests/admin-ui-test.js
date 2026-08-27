// The admin panel: the firm in one table, and reclaim behind a confirm.
//
// Two things are worth pinning here. The button must not exist for an ordinary
// advisor — not because hiding it is the control (the server checks the role on
// every call, and this suite's sibling proves that) but because showing an
// advisor a button that will 403 is a lie about what they can do.
//
// And reclaim must ASK, naming what moves and what the advisor loses. It is the
// one action in this app that takes something away from a colleague, and it is
// two clicks from a table of every list in the firm.
const { chromium } = require('playwright');

const feat = o => ({ whitepages: false, ai_qc: false, server_state: true, drive: false,
                     zoominfo: false, edgar: false, zi_mcp: false, opportunities: false,
                     free_sources: true, ...o });
const me = o => ({ signed_in: true, provider: 'google', name: 'Boss', email: 'boss@fpa.com',
                   providers: { google: true }, features: feat(), storage: 'firestore',
                   is_admin: true, ...o });

const OVERVIEW = {
  you: 'boss@fpa.com',
  total_leads: 1240,
  advisors: [
    { email: 'boss@fpa.com', lists: 2, leads: 40, last_seen: Date.now() / 1000, is_admin: true },
    { email: 'ada@fpa.com', lists: 3, leads: 1200, last_seen: Date.now() / 1000 - 86400 * 3, is_admin: false },
    { email: 'ben@fpa.com', lists: 1, leads: 0, last_seen: Date.now() / 1000 - 86400, is_admin: false }],
  lists: [
    { ref: 'ada@fpa.com~l1', owner: 'ada@fpa.com', id: 'l1', name: 'Q3 rollovers',
      count: 1200, shares: ['ben@fpa.com'], reclaimed_from: '' },
    { ref: 'boss@fpa.com~l9', owner: 'boss@fpa.com', id: 'l9', name: 'My own',
      count: 40, shares: [], reclaimed_from: 'someone@fpa.com' }],
  backend: 'firestore' };

(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })
    .catch(() => chromium.launch());
  const ctx = await b.newContext({ viewport: { width: 1500, height: 1000 } });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  p.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE: ' + m.text()); });

  let who = me();
  const transfers = [];
  await p.route('**/api/me', r => r.fulfill({ json: who }));
  await p.route('**/api/settings', r => r.fulfill({ json: { ok: true } }));
  await p.route('**/api/lists', r => r.fulfill({ json: { lists: [{ id: 'default', name: 'My leads', count: 0, role: 'owner', owner: '' }], settings: {} } }));
  await p.route('**/api/lists/*', r => r.request().method() === 'GET'
    ? r.fulfill({ json: { list: { id: 'default', name: 'My leads' }, settings: {}, leads: [] } })
    : r.fulfill({ json: { ok: true, lists: [] } }));
  await p.route('**/api/admin/overview', r => r.fulfill({ json: OVERVIEW }));
  await p.route('**/api/admin/transfer', r => {
    transfers.push(r.request().postDataJSON());
    r.fulfill({ json: { moved: [{ leads: 1200 }], leads: 1200, overview: OVERVIEW } });
  });

  let fail = 0, n = 0;
  const ck = (name, c, d) => { n++; console.log((c ? 'ok   ' : 'FAIL ') + name + (d !== undefined ? '  ' + d : '')); if (!c) fail++; };
  const load = async () => {
    await p.goto('http://127.0.0.1:8099/', { waitUntil: 'domcontentloaded' });
    await p.evaluate(() => localStorage.clear());
    await p.goto('http://127.0.0.1:8099/', { waitUntil: 'domcontentloaded' });
    await p.waitForFunction(() => window.ME && typeof loadAdmin === 'function', null, { timeout: 15000 });
    await p.waitForTimeout(500);
  };

  // --- an ordinary advisor never sees it --------------------------------------
  who = me({ is_admin: false, email: 'ada@fpa.com', name: 'Ada' });
  await load();
  ck('an advisor is not shown an Admin button',
     await p.evaluate(() => document.getElementById('btnAdmin').style.display) === 'none',
     await p.evaluate(() => document.getElementById('btnAdmin').style.display));

  // --- the admin sees the firm ------------------------------------------------
  who = me();
  await load();
  ck('the admin is shown the button',
     await p.evaluate(() => document.getElementById('btnAdmin').style.display) !== 'none');
  await p.click('#btnAdmin');
  await p.waitForTimeout(500);
  ck('  ...and it opens the panel',
     await p.evaluate(() => document.getElementById('mAdmin').classList.contains('open')));
  const summary = await p.evaluate(() => document.getElementById('adminSummary').textContent.replace(/\s+/g, ' '));
  ck('the panel counts the whole firm, not just what was shared',
     /1,240 leads/.test(summary) && /2 lists/.test(summary) && /3 advisors/.test(summary), summary);

  const advisors = await p.evaluate(() => [...document.querySelectorAll('#adminAdvisors tr')]
    .map(t => t.textContent.replace(/\s+/g, ' ').trim()));
  ck('every advisor is listed', advisors.length === 3, advisors.length);
  ck('  ...with the admin marked as one', /admin/.test(advisors[0]) && /\(you\)/.test(advisors[0]), advisors[0]);
  ck('  ...and their lead counts', /1,200/.test(advisors[1]), advisors[1]);
  ck('  ...and when they were last active', /3 days ago/.test(advisors[1]), advisors[1]);

  const lists = await p.evaluate(() => [...document.querySelectorAll('#adminLists tr')]
    .map(t => t.textContent.replace(/\s+/g, ' ').trim()));
  ck('every list is listed, including ones never shared with the admin',
     lists.some(t => /Q3 rollovers/.test(t)), lists.join(' | '));
  ck('  ...naming who it is shared with', /ben@fpa\.com/.test(lists.find(t => /Q3/.test(t))),
     lists.find(t => /Q3/.test(t)));
  ck('  ...and where a reclaimed one came from',
     /reclaimed from someone@fpa\.com/.test(lists.find(t => /My own/.test(t))),
     lists.find(t => /My own/.test(t)));

  // --- you cannot reclaim from yourself ---------------------------------------
  ck("the admin's own list offers no Reclaim button — it is already theirs",
     await p.evaluate(() => {
       const row = [...document.querySelectorAll('#adminLists tr')].find(t => /My own/.test(t.textContent));
       return ![...row.querySelectorAll('button')].some(b => /Reclaim/.test(b.textContent));
     }));
  ck('  ...and neither does their own advisor row',
     await p.evaluate(() => {
       const row = [...document.querySelectorAll('#adminAdvisors tr')].find(t => /boss@fpa/.test(t.textContent));
       return ![...row.querySelectorAll('button')].some(b => /Reclaim/.test(b.textContent));
     }));
  ck('an advisor carrying nothing is not offered a pointless reclaim',
     await p.evaluate(() => {
       const row = [...document.querySelectorAll('#adminAdvisors tr')].find(t => /ben@fpa/.test(t.textContent));
       return ![...row.querySelectorAll('button')].some(b => /Reclaim/.test(b.textContent));
     }));

  // --- reclaim asks first, and says what it takes -----------------------------
  await p.evaluate(() => { adminReclaim('ada@fpa.com', 'l1'); });
  await p.waitForTimeout(400);
  ck('reclaiming asks before it takes anything',
     await p.evaluate(() => document.getElementById('mConfirm').classList.contains('open')));
  const q = await p.evaluate(() => document.getElementById('cfMsg').textContent.replace(/\s+/g, ' '));
  ck('  ...naming the list and the number of leads', /Q3 rollovers/.test(q) && /1,200 leads/.test(q), q);
  ck('  ...saying the advisor loses access', /ada@fpa\.com loses access/.test(q), q);
  ck('  ...that it is a move, not a copy', /not a copy/.test(q), q);
  ck('  ...that anyone it was shared with loses it too', /shared with loses it too/.test(q), q);
  ck('  ...and that it can be handed back', /hand it back/.test(q), q);
  await p.evaluate(() => cfDone(false));
  await p.waitForTimeout(300);
  ck('declining takes nothing', transfers.length === 0, JSON.stringify(transfers));

  await p.evaluate(() => { adminReclaim('ada@fpa.com', 'l1'); });
  await p.waitForTimeout(300);
  await p.evaluate(() => cfDone(true));
  await p.waitForTimeout(600);
  ck('confirming sends exactly one transfer', transfers.length === 1, JSON.stringify(transfers));
  ck('  ...naming the owner and the list', transfers[0].owner === 'ada@fpa.com'
     && transfers[0].list_id === 'l1', JSON.stringify(transfers[0]));
  ck('  ...and the toast reports what moved',
     /Reclaimed 1,200 leads from ada@fpa\.com/.test(
       await p.evaluate(() => document.getElementById('toast').textContent)),
     await p.evaluate(() => document.getElementById('toast').textContent));

  // --- reclaiming a whole book sends no list id -------------------------------
  await p.evaluate(() => { adminReclaim('ada@fpa.com', ''); });
  await p.waitForTimeout(300);
  const q2 = await p.evaluate(() => document.getElementById('cfMsg').textContent.replace(/\s+/g, ' '));
  ck('reclaiming everything says how many lists and leads',
     /all 1 of ada@fpa\.com/.test(q2) && /1,200 leads/.test(q2), q2);
  await p.evaluate(() => cfDone(true));
  await p.waitForTimeout(500);
  ck('  ...and sends an empty list id, meaning all of them',
     transfers[1] && transfers[1].list_id === '', JSON.stringify(transfers[1]));

  ck('no page errors', errs.length === 0, errs.slice(0, 2).join(' | '));
  console.log(fail ? `\nFAILURES: ${fail} of ${n}` : `\nall ${n} checks passed`);
  await b.close(); process.exit(fail ? 1 : 0);
})();
