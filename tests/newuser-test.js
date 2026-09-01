// What a brand-new account actually meets.
//
// Three things reported from a real first session, all the same complaint: the
// app assumes you already know what it knows.
//
//   "Money in Motion did not work"   -> a panel whose empty state said
//                                       "see SETUP-prospecting.md"
//   "Google message doesnt go away"  -> a password account told to "sign in
//                                       with Google", under a primary button
//                                       that could only ever fail for them
//   "I dont know what each of these are" -> a menu of six nouns
//
// A first-run experience is not a nice-to-have here: every user after Dan
// arrives with no Google link, no WARN feeds and no idea what a search recipe
// is, and each of these was a dead end with no way out of it.
const { chromium } = require('playwright');

const feat = o => ({ whitepages: false, ai_qc: true, server_state: true, drive: false,
                     zoominfo: false, edgar: false, zi_mcp: false, opportunities: false,
                     free_sources: true, ...o });
const me = o => ({ signed_in: true, provider: 'password', name: 'newuser',
                   email: 'newuser@anywhere.com', providers: { google: true, microsoft: true },
                   features: feat(), storage: 'firestore', linked_google: false,
                   linked_microsoft: false, ...o });

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

  let who = me();
  await p.route('**/api/me', r => r.fulfill({ json: who }));
  await p.route('**/api/settings', r => r.fulfill({ json: { ok: true } }));
  await p.route('**/api/lists', r => r.fulfill({ json: { lists: [{ id: 'default', name: 'My leads', count: 0, role: 'owner', owner: '' }], settings: {} } }));
  // The second act links Google, and the sheet is checked on arrival.
  await p.route('**/api/drive/find*', r => r.fulfill({ json: { files: [], searched: 'x' } }));
  await p.route('**/api/drive/rows*', r => r.fulfill({ json: { name: 'x', rows: [] } }));
  await p.route('**/api/lists/*', r => r.request().method() === 'GET'
    ? r.fulfill({ json: { list: { id: 'default', name: 'My leads' }, settings: {}, leads: [] } })
    : r.fulfill({ json: { ok: true, lists: [{ id: 'default', name: 'My leads', count: 1, role: 'owner', owner: '' }] } }));

  let fail = 0, n = 0;
  const ck = (name, c, d) => { n++; console.log((c ? 'ok   ' : 'FAIL ') + name + (d !== undefined ? '  ' + d : '')); if (!c) fail++; };
  const load = async () => {
    await p.goto('http://127.0.0.1:8099/', { waitUntil: 'domcontentloaded' });
    await p.evaluate(() => localStorage.clear());
    await p.goto('http://127.0.0.1:8099/', { waitUntil: 'domcontentloaded' });
    await p.waitForFunction(() => window.ME && typeof syncFromSheet === 'function', null, { timeout: 15000 });
    await p.waitForTimeout(500);
  };
  await load();

  // --- the primary button must be one they can press --------------------------
  const buttons = await p.evaluate(() => ({
    sync: document.getElementById('btnSync').classList.contains('primary'),
    csv: document.getElementById('btnCsv').classList.contains('primary') }));
  ck('with no Google linked, the sheet button is not the primary one',
     buttons.sync === false, JSON.stringify(buttons));
  ck('  ...and Import a file takes the primary slot — it actually works',
     buttons.csv === true, JSON.stringify(buttons));

  // --- and the message it gives must be actionable ----------------------------
  await p.evaluate(() => syncFromSheet(true));
  await p.waitForTimeout(400);
  const line = await p.evaluate(() => document.getElementById('srcNote').textContent.replace(/\s+/g, ' '));
  ck('pressing it explains what the feature needs', /needs a Google account linked/.test(line), line);
  ck('  ...names the control that fixes it', /Add a Google address/.test(line), line);
  ck('  ...and does NOT tell a password account to go and sign in with Google',
     !/sign in with Google/.test(line), line);
  ck('  ...saying the app works without it, and how', /Import a file or Paste a list/.test(line), line);

  // --- with Google linked, the sheet is the primary action again --------------
  who = me({ features: feat({ drive: true }), linked_google: true });
  await load();
  const linked = await p.evaluate(() => ({
    sync: document.getElementById('btnSync').classList.contains('primary'),
    csv: document.getElementById('btnCsv').classList.contains('primary') }));
  ck('once Google is linked the sheet button leads again',
     linked.sync === true && linked.csv === false, JSON.stringify(linked));

  // --- every menu item says what it does --------------------------------------
  await p.click('#btnMore');
  await p.waitForTimeout(250);
  const items = await p.evaluate(() => [...document.querySelectorAll('#moreMenu button')]
    .filter(b => b.offsetParent !== null)
    .map(b => ({ label: (b.childNodes[0].textContent || '').trim(),
                 says: (b.querySelector('small') || {}).textContent || '' })));
  ck('the menu has items', items.length >= 6, items.length);
  const bare = items.filter(i => !i.says.trim());
  ck('every visible item explains itself — none is a bare noun',
     bare.length === 0, JSON.stringify(bare.map(i => i.label)));
  const cov = items.find(i => /Data coverage/.test(i.label));
  ck('  ...and the explanation is a sentence, not a restatement of the label',
     cov && cov.says.length > 30 && !/^Data coverage/.test(cov.says), cov && cov.says);
  const recipe = items.find(i => /Search recipe/.test(i.label));
  ck('  ...including the ones only their author understood',
     recipe && /ZoomInfo filters/.test(recipe.says), recipe && recipe.says);
  ck('the labels themselves are unchanged — messages elsewhere point at them by name',
     items.some(i => /ICP settings/.test(i.label)), items.map(i => i.label).join(' | '));

  // --- "There needs to be less buttons" ---------------------------------------
  // Counted, not eyeballed, because this is the kind of thing that creeps back
  // one well-meaning button at a time.
  who = me({ features: feat({ drive: true, whitepages: true, edgar: true, opportunities: true }),
             linked_google: true });
  await p.route('**/api/lists/*', r => r.request().method() === 'GET'
    ? r.fulfill({ json: { list: { id: 'default', name: 'My leads' }, settings: {}, leads: [
        { id: 'x1', firstName: 'Ada', lastName: 'Alpha', title: 'CFO', employer: 'Meridian',
          mobilePhone: '(973) 555-0142', email: 'a@m.com', status: 'New', activity: [] }] } })
    : r.fulfill({ json: { ok: true, lists: [{ id: 'default', name: 'My leads', count: 1, role: 'owner', owner: '' }] } }));
  await load();
  // "Adjust Source so a drop down is not needed" — every way in is a visible
  // button now, each explaining itself in its title, and no menu hides any.
  const src = await p.evaluate(() => ({
    n: [...document.querySelectorAll('#stSource .stacts > *')].filter(e => e.offsetParent !== null).length,
    dropdown: !!document.getElementById('btnAdd'),
    paste: !!document.getElementById('btnPaste') && !document.getElementById('btnPaste').closest('.menu'),
    build: !!document.getElementById('btnBuildOpen') && !document.getElementById('btnBuildOpen').closest('.menu'),
    titled: ['btnPaste', 'btnBuildOpen'].every(id => (document.getElementById(id).title || '').length > 20),
  }));
  ck('the Source stage has no dropdown — every way in is a visible button',
     !src.dropdown && src.paste && src.build && src.n === 5, JSON.stringify(src));
  ck('  ...each explaining itself in its title', src.titled);
  // The actions cell only — the phone number is also a button, but it is the
  // number itself, not chrome.
  const row = await p.evaluate(() => {
    const tr = document.querySelector('#rows tr.lead');
    return [...tr.querySelectorAll('.act button')].filter(b => b.offsetParent !== null)
      .map(b => b.textContent.trim());
  });
  ck('a lead row carries five actions at most, not eleven', row.length <= 5, JSON.stringify(row));
  ck('  ...and Research is one of them, standing for six lookups',
     row.some(t => /Research/.test(t)), JSON.stringify(row));
  ck('  ...with the lookups themselves one press away, costs stated',
     await p.evaluate(() => {
       toggleDetail('x1', 'research');
       const t = document.getElementById('research-x1').textContent;
       return /WhitePages lookup/.test(t) && /free/.test(t);
     }));
  // "There should not be 2 whitepage look up buttons. It should just be 1."
  ck('  ...and WhitePages is ONE row, not a number check plus a household',
     await p.evaluate(() => researchActions(byId('x1'))
       .filter(a => /WhitePages/.test(a[3])).length === 1),
     await p.evaluate(() => JSON.stringify(researchActions(byId('x1')).map(a => a[1]))));
  ck('  ...that checks the number first and searches by name only on a miss',
     await p.evaluate(() => /verifyLead/.test(wpLookup.toString())
       && /enrichHome/.test(wpLookup.toString())
       && /hd/.test(wpLookup.toString())));

  // --- the allowance, where it is spent ---------------------------------------
  // It lived only in the coverage panel, which is not where anyone is standing
  // when they decide whether one lead is worth a paid lookup.
  await p.evaluate(() => {
    CREDITS = { month: '2026-08', resets_on: '2026-09-01',
                whitepages: { spent: 92, budget: 100, left: 8, yours_left: 8,
                              firm_left: 400, firm_budget: 1000, capped_by: 'you' },
                zoominfo: { used: 3, own_subscription: true } };
    // toggleDetail toggles; an earlier check may have left it open.
    if (expanded !== 'x1') toggleDetail('x1', 'research'); else render();
  });
  await p.waitForTimeout(250);
  const panel = await p.evaluate(() => document.getElementById('research-x1').textContent);
  ck('the research panel says what is left of your allowance',
     /8 of your 100 lookups left/.test(panel), panel.slice(-160));
  ck('  ...and colours it when it is nearly gone',
     await p.evaluate(() => {
       const el = [...document.querySelectorAll('#research-x1 p')]
         .find(e => /WhitePages:/.test(e.textContent));
       return el && /rgb\(/.test(getComputedStyle(el).color) && el.style.color !== '';
     }));
  await p.evaluate(() => {
    CREDITS.whitepages = { spent: 2, budget: 100, left: 40, yours_left: 98,
                           firm_left: 40, firm_budget: 1000, capped_by: 'firm' };
    if (expanded !== 'x1') toggleDetail('x1', 'research'); else render();
  });
  await p.waitForTimeout(250);
  const firm = await p.evaluate(() => document.getElementById('research-x1').textContent);
  ck('when the firm is the tighter ceiling it says so, not your own number',
     /firm's pool/.test(firm) && /lower than your own 98/.test(firm), firm.slice(-180));

  // --- a menu that opens off the edge of the screen ---------------------------
  // Reported as "Cant see Other Ways menu". It is anchored to its trigger's
  // right edge, which is right for a button near the right of the window and
  // wrong for one near the left — and "Other ways" moves to the card's left
  // edge as soon as the button row wraps, which it does below about 1300px.
  // Measured at -98px, entirely off screen.
  for (const w of [1280, 980]) {
    await p.setViewportSize({ width: w, height: 900 });
    await p.waitForTimeout(200);
    for (const [btn, menu] of [['btnMore', 'moreMenu'], ['btnLists', 'listMenu']]) {
      await p.click('#' + btn); await p.waitForTimeout(150);
      const box = await p.evaluate(id => {
        const m = document.getElementById(id), r = m.getBoundingClientRect();
        return { left: Math.round(r.left), right: Math.round(r.right), vw: innerWidth };
      }, menu);
      ck(`at ${w}px the ${menu} opens on screen`,
         box.left >= 0 && box.right <= box.vw, JSON.stringify(box));
      await p.keyboard.press('Escape'); await p.waitForTimeout(100);
    }
  }
  await p.setViewportSize({ width: 1500, height: 1000 });
  await p.waitForTimeout(200);

  // --- the table is workable without hunting -----------------------------------
  // "It's hard to scroll and I cant see the buttons or easily click in and out
  // of records." The Actions cell rides sticky on the right so the working
  // controls never scroll away, and the whole row is a click target.
  const sticky = await p.evaluate(() => {
    const td = document.querySelector('#rows tr.lead td:last-child');
    const st = getComputedStyle(td);
    return { pos: st.position, bg: st.backgroundColor };
  });
  ck('the Actions cell is sticky, so its buttons never scroll out of reach',
     sticky.pos === 'sticky', JSON.stringify(sticky));
  ck('  ...with its own background — content cannot bleed through it',
     sticky.bg !== 'rgba(0, 0, 0, 0)', sticky.bg);
  await p.evaluate(() => { expanded = null; render(); });
  await p.waitForTimeout(200);
  await p.click('#rows tr.lead td:nth-child(4)');    // plain text cell
  await p.waitForTimeout(250);
  ck('clicking anywhere on a row opens the record',
     await p.evaluate(() => expanded === 'x1'), await p.evaluate(() => expanded));
  await p.click('#rows tr.lead td:nth-child(4)');
  await p.waitForTimeout(250);
  ck('  ...and clicking again closes it', await p.evaluate(() => expanded === null));
  await p.evaluate(() => { const sel = document.querySelector('#rows tr.lead select'); sel.click(); });
  await p.waitForTimeout(200);
  ck('  ...but a press on the status dropdown is a press on the dropdown',
     await p.evaluate(() => expanded === null));

  // --- the sweep counter counts what it says ------------------------------------
  const sweepSrc = await p.evaluate(() => enrichAllFree.toString());
  ck('the progress label names its phase and counts that phase\'s unit',
     /SWEEP.phase.*SWEEP.done.*SWEEP.total/.test(sweepSrc.match(/label=.*?;/s)[0])
     && /phase:'Public record'/.test(sweepSrc) && /Reading proxies/.test(sweepSrc),
     (sweepSrc.match(/label=.*?;/s) || [])[0]);
  ck('  ...and never sums leads with employers into one fake denominator',
     !/pubTodo\.length\+ageTodo\.length/.test(sweepSrc));

  // --- the watched sheet is the user\'s choice ----------------------------------
  const asked = [];
  await p.route('**/api/drive/find*', r => { asked.push(decodeURIComponent(r.request().url()));
    return r.fulfill({ json: { files: [], searched: 'x' } }); });
  ck('the Source card names the watched sheet and offers to change it',
     await p.evaluate(() => /Watching “Wealth Management Lead Prospecting”/.test(
       document.getElementById('sheetLine').textContent)
       && /watch a different sheet/.test(document.getElementById('sheetLine').textContent)),
     await p.evaluate(() => document.getElementById('sheetLine').textContent));
  await p.evaluate(() => { state.settings.sourceSheet = 'Q4 Prospects'; render(); syncFromSheet(true); });
  await p.waitForTimeout(500);
  ck('a renamed watch is searched for by ITS name, not the default',
     asked.some(u => /name=Q4 Prospects/.test(u)), asked.join(' | '));
  ck('  ...and the card shows the new name',
     await p.evaluate(() => /Watching “Q4 Prospects”/.test(
       document.getElementById('sheetLine').textContent)));
  await p.evaluate(() => { state.settings.sourceSheet =
    'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/edit'; });
  const watched = await p.evaluate(() => watchedSheet());
  ck('a pasted Drive link is used directly, no name search at all',
     watched.id === '1AbCdEfGhIjKlMnOpQrStUvWxYz012345' && !watched.name, JSON.stringify(watched));
  await p.evaluate(() => { state.settings.sourceSheet = ''; });

  // --- an open record shares the page instead of taking it over -----------------
  await p.evaluate(() => { expanded = null; render(); });
  await p.click('#rows tr.lead td:nth-child(4)');
  await p.waitForTimeout(250);
  const rec = await p.evaluate(() => {
    const g = document.querySelector('tr.detail .detail-grid');
    const st = getComputedStyle(g);
    const heads = [...g.querySelectorAll('.dsec > details.drill > summary > span:first-child, .dsec > h4')].map(h => h.textContent.trim());
    return { overflowY: st.overflowY, maxHeight: st.maxHeight, heads,
             anchor: !!document.getElementById('research-x1') };
  });
  ck('the open record scrolls inside itself instead of taking over the page',
     rec.overflowY === 'auto' && rec.maxHeight !== 'none' && /vh|px/.test(rec.maxHeight),
     JSON.stringify({ overflowY: rec.overflowY, maxHeight: rec.maxHeight }));
  ck('  ...it opens on the score, with research after it and before CRM fields',
     rec.heads[0] === 'Why this score'
     && rec.heads.indexOf('Look this person up') > 0
     && rec.heads.indexOf('Look this person up') < rec.heads.indexOf('CRM export fields'),
     rec.heads.join(' | '));
  ck('  ...and the Research button\'s scroll anchor still exists', rec.anchor);
  await p.evaluate(() => {
    const ov = document.querySelector('.overlay'); if (ov) ov.classList.add('open');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  });
  await p.waitForTimeout(150);
  ck('Escape with a dialog open closes the dialog, not the record underneath',
     await p.evaluate(() => expanded === 'x1' && !document.querySelector('.overlay.open')),
     await p.evaluate(() => JSON.stringify({ expanded, overlayOpen: !!document.querySelector('.overlay.open') })));
  await p.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
  await p.waitForTimeout(150);
  ck('  ...and a second Escape closes the record itself',
     await p.evaluate(() => expanded === null), await p.evaluate(() => expanded));

  ck('no page errors', errs.length === 0, errs.slice(0, 2).join(' | '));
  console.log(fail ? `\nFAILURES: ${fail} of ${n}` : `\nall ${n} checks passed`);
  await b.close(); process.exit(fail ? 1 : 0);
})();
