// "I want all these features at list scale if they are free."
//
// The gate is the interesting part. The FEC and SEC searches cost nothing, so
// running them across a list changes nothing about money — what it changes is
// honesty at scale: a rate limit mid-sweep must not read as "no donations",
// already-swept leads must not be re-fetched, and the two paid lookups
// (WhitePages credits, Anthropic tokens for the proxy-age reader) must never
// ride along. The sweep's job is to aim those, not to spend them.
const { chromium } = require('playwright');

const feat = o => ({ whitepages: true, ai_qc: false, server_state: true, drive: false,
                     zoominfo: false, edgar: true, zi_mcp: false, opportunities: false,
                     free_sources: true, fec_personal_key: false, ...o });
const me = o => ({ signed_in: true, provider: 'google', name: 'Dan', email: 'dan@fpa.com',
                   providers: { google: true }, features: feat(), storage: 'firestore', ...o });

const mk = (id, ln, extra) => Object.assign(
  { id, firstName: 'F' + (ln || id), lastName: ln, employer: 'Acme', mobilePhone: '',
    email: '', status: 'New', activity: [] }, extra || {});
const LEADS = [
  mk('a', 'Alpha'),                                  // insider + retired donor
  mk('b', 'Bravo'),                                  // plain donor
  mk('c', 'Charlie'),                                // nothing on record
  mk('d', 'Delta'),                                  // FEC rate-limited for this one
  mk('e', 'Echo', { pub: { sources: { fec: { ran: true }, edgar: { ran: true } },
                           donations: {}, filings: [], links: {}, at: 1 } }), // swept, complete
  mk('f', ''),                                       // no surname — nothing to search
  // Swept while FEC was rate-limited: holds a result with a recorded hole.
  // The first sweep version skipped it forever, which made "sweep again later
  // to fill them" a false promise.
  mk('g', 'Golf', { pub: { sources: { fec: { ran: false, reason: 'FEC rate limit hit' },
                                      edgar: { ran: true } },
                           donations: {}, filings: [], links: {}, at: 1 } })];

const ANSWERS = {
  FAlpha: { sources: { fec: { ran: true }, edgar: { ran: true } },
    donations: { count: 3, total: 900, first: '2020-01-01', latest: '2026-02-01',
                 employers: [{ value: 'RETIRED', n: 1, last: '2026-02-01' }],
                 occupations: [], places: [{ value: 'Kent, WA', n: 3, last: '2026-02-01' }],
                 streets: [], employer_match: null, says_retired: true },
    filings: [{ form: '4', date: '2025-11-03', person: 'Alpha F (CIK 1)',
                company: 'ACME CORP (CIK 2)', url: 'https://www.sec.gov/Archives/edgar/data/2/x' }],
    links: {} },
  FBravo: { sources: { fec: { ran: true }, edgar: { ran: true } },
    donations: { count: 1, total: 250, employers: [], occupations: [],
                 places: [{ value: 'Reno, NV', n: 1, last: '2024-05-01' }], streets: [],
                 employer_match: null, says_retired: false },
    filings: [], links: {} },
  FCharlie: { sources: { fec: { ran: true, note: 'no itemised contributions under this name' },
                         edgar: { ran: true, note: 'no insider filings under this name' } },
    donations: {}, filings: [], links: {} },
  FDelta: { sources: { fec: { ran: false, reason: 'FEC rate limit hit' },
                       edgar: { ran: true } },
    donations: {}, filings: [], links: {} },
  FGolf: { sources: { fec: { ran: true }, edgar: { ran: true } },
    donations: { count: 2, total: 700, employers: [], occupations: [],
                 places: [{ value: 'Boise, ID', n: 2, last: '2025-01-01' }], streets: [],
                 employer_match: null, says_retired: false },
    filings: [], links: {} } };

(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })
    .catch(() => chromium.launch());
  const ctx = await b.newContext({ viewport: { width: 1500, height: 1000 } });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  p.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE: ' + m.text()); });

  const calls = [];
  await p.route('**/api/me', r => r.fulfill({ json: me() }));
  await p.route('**/api/settings', r => r.fulfill({ json: { ok: true } }));
  await p.route('**/api/lists', r => r.fulfill({ json: { lists: [{ id: 'default', name: 'My leads', count: 6, role: 'owner', owner: '' }], settings: {} } }));
  await p.route('**/api/lists/*', r => r.request().method() === 'GET'
    ? r.fulfill({ json: { list: { id: 'default', name: 'My leads' }, settings: {}, leads: JSON.parse(JSON.stringify(LEADS)) } })
    : r.fulfill({ json: { ok: true, lists: [] } }));
  await p.route('**/api/free-enrich', r => {
    const body = r.request().postDataJSON();
    calls.push(body.first_name);
    r.fulfill({ json: ANSWERS[body.first_name] ||
      { sources: { fec: { ran: true }, edgar: { ran: true } }, donations: {}, filings: [], links: {} } });
  });
  // The two paid lookups must never be called by a sweep.
  let paid = 0;
  await p.route('**/api/enrich', r => { paid++; r.fulfill({ json: { found: false } }); });
  await p.route('**/api/verify-phone', r => { paid++; r.fulfill({ json: {} }); });
  await p.route('**/api/edgar', r => { paid++; r.fulfill({ json: {} }); });

  let fail = 0, n = 0;
  const ck = (name, c, d) => { n++; console.log((c ? 'ok   ' : 'FAIL ') + name + (d !== undefined ? '  ' + d : '')); if (!c) fail++; };
  await p.goto('http://127.0.0.1:8099/', { waitUntil: 'domcontentloaded' });
  await p.evaluate(() => localStorage.clear());
  await p.goto('http://127.0.0.1:8099/', { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => window.ME && window.ME.signed_in && typeof sweepFree === 'function',
                          null, { timeout: 15000 });
  await p.waitForTimeout(600);

  // --- asking first, honestly ------------------------------------------------
  ck('the sweep lives in the More menu', await p.evaluate(() =>
    /Sweep public records \(free\)/.test(document.getElementById('btnSweep').textContent)));
  await p.evaluate(() => { sweepFree(); });
  await p.waitForTimeout(300);
  ck('it asks before starting', await p.evaluate(() =>
    document.getElementById('mConfirm').classList.contains('open')));
  const q = await p.evaluate(() => document.getElementById('cfMsg').textContent);
  ck('  ...with the true count: 5 — four fresh plus the gap lead', /5 leads/.test(q), q.slice(0, 80));
  ck('  ...naming the gap refill explicitly', /1 of them to fill gaps/.test(q), q);
  ck('  ...saying it is free', /no credits, no lookups spent/.test(q));
  ck('  ...and that the complete lead is skipped', /1 already swept/.test(q), q);
  await p.evaluate(() => cfDone(false));
  await p.waitForTimeout(300);
  ck('declining runs nothing', calls.length === 0, calls.length);

  // --- the sweep -------------------------------------------------------------
  await p.evaluate(() => { sweepFree(); });
  await p.waitForTimeout(250);
  await p.evaluate(() => cfDone(true));
  await p.waitForFunction(() => !document.getElementById('btnSweep').textContent.includes('stop'),
                          null, { timeout: 15000 });
  await p.waitForTimeout(400);

  ck('the four unswept leads AND the gap lead were searched',
     calls.sort().join() === 'FAlpha,FBravo,FCharlie,FDelta,FGolf', calls.join());
  ck('  ...the complete lead was not re-fetched', !calls.includes('FEcho'));
  ck('  ...nor the lead with no surname', !calls.includes('Ff'));
  ck('  ...and no paid endpoint was touched', paid === 0, paid);

  const after = await p.evaluate(() => {
    const by = Object.fromEntries(state.leads.map(L => [L.id, L]));
    return { aSec: by.a.pub.filings.length, aRet: by.a.pub.donations.says_retired,
             bDon: by.b.pub.donations.count, cEmpty: !by.c.pub.donations.count && by.c.pub.filings.length === 0,
             dFec: by.d.pub.sources.fec.ran, eAt: by.e.pub.at,
             gFilled: by.g.pub.sources.fec.ran === true && by.g.pub.donations.count === 2,
             aLogged: by.a.activity.some(x => x.k === 'pub'),
             cLogged: by.c.activity.some(x => x.k === 'pub') };
  });
  ck('the insider result landed', after.aSec === 1);
  ck('  ...and the retired flag', after.aRet === true);
  ck('the donor result landed', after.bDon === 1);
  ck('an empty answer stays empty', after.cEmpty === true);
  ck('the rate-limited lead records that FEC did not run', after.dFec === false);
  ck('the complete lead is untouched', after.eAt === 1, after.eAt);
  ck('the gap lead is filled: FEC now ran and the donations landed', after.gFilled === true);
  ck('a hit is logged in the activity', after.aLogged === true);
  ck('  ...but 300 "nothing found" entries are not written', after.cLogged === false);

  // --- what the rows now say -------------------------------------------------
  const rowText = await p.evaluate(() => {
    const tr = [...document.querySelectorAll('#rows tr.lead')].find(t => t.textContent.includes('FAlpha'));
    const sec = tr.querySelector('.badge.sec'), ret = tr.querySelector('.badge.fecret');
    return { sec: sec && sec.textContent, secTip: sec && sec.title,
             ret: ret && ret.textContent, retTip: ret && ret.title };
  });
  ck('the officer is badged SEC', rowText.sec === 'SEC');
  ck('  ...with the filing in the tooltip', /Form 4 2025-11-03/.test(rowText.secTip.replace(/\s+/g, ' ')) || /Form 4/.test(rowText.secTip), rowText.secTip.slice(0, 80));
  ck('the FEC-retired lead is badged', /RETIRED·FEC/.test(rowText.ret), rowText.ret);
  ck('  ...saying it is self-reported and dated', /self-reported/.test(rowText.retTip));
  ck('a lead with nothing found has neither badge', await p.evaluate(() => {
    const tr = [...document.querySelectorAll('#rows tr.lead')].find(t => t.textContent.includes('FCharlie'));
    return !tr.querySelector('.badge.sec') && !tr.querySelector('.badge.fecret'); }));

  // --- the summary counts the gaps -------------------------------------------
  const summary = await p.evaluate(() => document.getElementById('toast').textContent);
  ck('the summary counts the officers', /1 SEC insider/.test(summary), summary);
  ck('  ...aiming the paid age lookup at them', /age lookup will work/.test(summary));
  ck('  ...counts who told the FEC they are retired', /1 told the FEC/.test(summary));
  ck('  ...and the refilled gap lead counts among the donors', /3 donors/.test(summary), summary);
  ck('  ...and reports the rate-limited lookups as gaps, not as empties',
     /1 donation lookups did not run/.test(summary), summary);

  // --- running it again ------------------------------------------------------
  await p.evaluate(() => { sweepFree(); });
  await p.waitForTimeout(300);
  const q2 = await p.evaluate(() => document.getElementById('cfMsg').textContent);
  ck('a second sweep offers exactly the surviving gap — Delta — and nothing else',
     /1 lead\?/.test(q2) && /1 of them to fill gaps/.test(q2), q2.slice(0, 90));
  await p.evaluate(() => cfDone(false));
  await p.waitForTimeout(200);
  // Close Delta's gap by hand, and only then is the list truly done.
  await p.evaluate(() => { state.leads.find(x => x.id === 'd').pub.sources.fec.ran = true; });
  await p.evaluate(() => { sweepFree(); });
  await p.waitForTimeout(300);
  const again = await p.evaluate(() => document.getElementById('mConfirm').classList.contains('open'));
  ck('with every gap closed, a third sweep says there is nothing to do',
     !again && /already been swept/.test(await p.evaluate(() => document.getElementById('toast').textContent)),
     await p.evaluate(() => document.getElementById('toast').textContent));

  ck('no page errors', errs.length === 0, errs.slice(0, 2).join(' | '));
  console.log(fail ? `\nFAILURES: ${fail} of ${n}` : `\nall ${n} checks passed`);
  await b.close(); process.exit(fail ? 1 : 0);
})();
