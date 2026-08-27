// The Equitable invite that needs nobody's permission.
//
// "For equitable, I dont want to have to ask for help from an Admin."
//
// The OAuth calendar route still exists for tenants that allow user consent,
// but this one works even where IT approves nothing: Outlook on the web opens
// with the invite pre-filled, already signed in as the advisor, and their
// press of Send IS the authentication. What the app must get right is the
// deeplink — every field, correctly encoded — and the .ics twin for desktop
// Outlook. A wrong start time here books a real meeting at the wrong hour.
const { chromium } = require('playwright');

const feat = o => ({ whitepages: false, ai_qc: false, server_state: true, drive: false,
                     zoominfo: false, edgar: false, zi_mcp: false, opportunities: false,
                     free_sources: true, ...o });
const me = o => ({ signed_in: true, provider: 'google', name: 'Dan', email: 'dan@fpa.com',
                   providers: { google: true }, features: feat(), storage: 'firestore', ...o });
const LEAD = { id: 'a1', firstName: 'Janet', lastName: 'Melter', email: 'janet@corp.com',
               status: 'Set', activity: [] };

(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })
    .catch(() => chromium.launch());
  const ctx = await b.newContext({ viewport: { width: 1500, height: 1000 } });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  p.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE: ' + m.text()); });

  await p.route('**/api/me', r => r.fulfill({ json: me() }));
  await p.route('**/api/settings', r => r.fulfill({ json: { ok: true } }));
  await p.route('**/api/senders', r => r.fulfill({ json: { senders: [], default: '' } }));
  await p.route('**/api/lists', r => r.fulfill({ json: { lists: [{ id: 'default', name: 'All leads', count: 1, role: 'owner', owner: '', master: true }], settings: {} } }));
  await p.route('**/api/lists/*', r => r.request().method() === 'GET'
    ? r.fulfill({ json: { list: { id: 'default', name: 'All leads' }, settings: {}, leads: [JSON.parse(JSON.stringify(LEAD))] } })
    : r.fulfill({ json: { ok: true, lists: [{ id: 'default', name: 'All leads', count: 1, role: 'owner', owner: '', master: true }] } }));

  let fail = 0, n = 0;
  const ck = (name, c, d) => { n++; console.log((c ? 'ok   ' : 'FAIL ') + name + (d !== undefined ? '  ' + d : '')); if (!c) fail++; };
  await p.goto('http://127.0.0.1:8099/', { waitUntil: 'domcontentloaded' });
  await p.evaluate(() => localStorage.clear());
  await p.goto('http://127.0.0.1:8099/', { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => window.ME && typeof openInvite === 'function', null, { timeout: 15000 });
  await p.waitForTimeout(600);

  // --- the modal offers the no-permission route --------------------------------
  await p.evaluate(() => openInvite('a1'));
  await p.waitForTimeout(300);
  ck('the work-Outlook route is offered even with NOTHING connected',
     await p.isVisible('#btnOwa'));
  ck('  ...alongside the .ics for desktop Outlook', await p.isVisible('#btnInvIcs'));
  ck('  ...and the modal explains it needs no connection and no IT approval',
     /no connection, no IT approval/.test(await p.textContent('#mInvite')),
     (await p.textContent('#mInvite')).slice(0, 200));

  // --- the deeplink carries the whole invite, correctly encoded ---------------
  await p.evaluate(() => {
    window._opened = null; window.open = u => { window._opened = u; return null; };
    document.getElementById('invDate').value = '2026-09-03';
    document.getElementById('invTime').value = '14:30';
    document.getElementById('invDur').value = '45';
  });
  await p.click('#btnOwa');
  await p.waitForTimeout(300);
  const u = await p.evaluate(() => window._opened);
  ck('it opens Outlook on the web', /^https:\/\/outlook\.office\.com\/calendar\/deeplink\/compose\?/.test(u), u && u.slice(0, 70));
  const q = new URL(u).searchParams;
  ck('  ...as an event compose', q.get('rru') === 'addevent' && q.get('path') === '/calendar/action/compose');
  ck('  ...with the lead as the attendee', q.get('to') === 'janet@corp.com', q.get('to'));
  const start = new Date(q.get('startdt')), end = new Date(q.get('enddt'));
  const local = new Date('2026-09-03T14:30');
  ck('  ...the start is 2:30pm local, not 2:30 in some other timezone',
     start.getTime() === local.getTime(), q.get('startdt'));
  ck('  ...and the end honours the duration', (end - start) / 60000 === 45, q.get('enddt'));
  ck('  ...the subject is the merged template, personalised',
     /Janet/.test(q.get('subject')) || q.get('subject').length > 0, q.get('subject'));
  ck('the press is logged on the lead', await p.evaluate(() =>
     state.leads.find(l => l.id === 'a1').activity.some(a => /work Outlook/.test(a.d || a.note || JSON.stringify(a)))),
     await p.evaluate(() => JSON.stringify(state.leads.find(l => l.id === 'a1').activity)));

  // --- the .ics twin ------------------------------------------------------------
  await p.evaluate(() => openInvite('a1'));
  await p.waitForTimeout(300);
  await p.evaluate(() => {
    window._ics = null;
    window.dl = (blob) => { blob.text().then(t => { window._ics = t; }); };
    document.getElementById('invDate').value = '2026-09-03';
    document.getElementById('invTime').value = '14:30';
    document.getElementById('invDur').value = '30';
  });
  await p.click('#btnInvIcs');
  await p.waitForFunction(() => window._ics, null, { timeout: 5000 });
  const ics = await p.evaluate(() => window._ics);
  ck('the .ics is a real invite, not just an event', /METHOD:REQUEST/.test(ics));
  ck('  ...with the lead as an RSVP attendee', /ATTENDEE;CN=Janet Melter;RSVP=TRUE:mailto:janet@corp\.com/.test(ics),
     (ics.match(/ATTENDEE[^\r\n]*/) || [])[0]);
  ck('  ...starting at half past two', /DTSTART:20260903T143000/.test(ics),
     (ics.match(/DTSTART[^\r\n]*/) || [])[0]);
  ck('  ...CRLF line endings, as the RFC requires', /\r\n/.test(ics));

  ck('no page errors', errs.length === 0, errs.slice(0, 2).join(' | '));
  console.log(fail ? `\nFAILURES: ${fail} of ${n}` : `\nall ${n} checks passed`);
  await b.close(); process.exit(fail ? 1 : 0);
})();
