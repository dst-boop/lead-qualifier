// "There should be 1 button the user needs to press to enrich leads with All
// Free enrichment sources."
//
// One button, two free sources, and one line the button must not cross. The
// public record (FEC donations, SEC insider filings) runs per lead; proxy-
// statement ages run per EMPLOYER, because one filing answers for everyone who
// works there — that batching is what made ages affordable at list scale and
// let this button stop telling the user to go and press a second one.
//
// WhitePages stays out, and that is the assertion with teeth: it spends lookup
// credits from a finite pool, so no list-scale button may ever touch it.
//
// The rest is honesty at scale, unchanged: a rate limit mid-run must not read
// as "no donations", and already-read leads must not be re-fetched.
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
  // Swept already, and works somewhere private — one employer that files no
  // proxy at all, so the batch reader must handle "not a public company".
  mk('e', 'Echo', { employer: 'Nowhere LLC',
                    pub: { sources: { fec: { ran: true }, edgar: { ran: true } },
                           donations: {}, filings: [], links: {}, at: 1 } }),
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
  // WhitePages spends credits: no list-scale button may ever call it.
  let paid = 0;
  await p.route('**/api/enrich', r => { paid++; r.fulfill({ json: { found: false } }); });
  await p.route('**/api/verify-phone', r => { paid++; r.fulfill({ json: {} }); });
  // The per-lead proxy reader is the expensive shape this button must NOT use:
  // one 45,000-token read per lead. It has a batch endpoint now.
  let perLead = 0;
  await p.route('**/api/edgar', r => { perLead++; r.fulfill({ json: {} }); });
  // The batch reader: one call per employer, however many leads work there.
  const rosters = [];
  await p.route('**/api/edgar-roster', r => {
    const body = r.request().postDataJSON();
    rosters.push(body);
    if (/nowhere/i.test(body.employer)) {
      return r.fulfill({ json: { found: false, company: {}, filing: {}, roster_size: 0,
                                 matches: {}, reason: 'No public company on file matching “Nowhere LLC”.' } });
    }
    // Acme's proxy names Alpha and Charlie; nobody else on the list is in it.
    const matches = {};
    (body.people || []).forEach(x => {
      if (x.last_name === 'Alpha') matches[x.i] = { age: 61, title: 'Chief Financial Officer', as_of: '2026', name: 'F. Alpha' };
      if (x.last_name === 'Charlie') matches[x.i] = { age: 54, title: 'Director', as_of: '2026', name: 'FCharlie Charlie' };
    });
    r.fulfill({ json: { found: true, company: { name: 'ACME CORP', cik: '0000000002' },
                        filing: { url: 'https://www.sec.gov/x.htm', filed: '2026-03-14' },
                        roster_size: 11, matches, reason: '' } });
  });

  let fail = 0, n = 0;
  const ck = (name, c, d) => { n++; console.log((c ? 'ok   ' : 'FAIL ') + name + (d !== undefined ? '  ' + d : '')); if (!c) fail++; };
  await p.goto('http://127.0.0.1:8099/', { waitUntil: 'domcontentloaded' });
  await p.evaluate(() => localStorage.clear());
  await p.goto('http://127.0.0.1:8099/', { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => window.ME && window.ME.signed_in && typeof enrichAllFree === 'function',
                          null, { timeout: 15000 });
  await p.waitForTimeout(600);

  // --- asking first, honestly ------------------------------------------------
  ck('there is ONE enrichment button, in the top bar, not buried in a menu',
     await p.evaluate(() => {
       const b = document.getElementById('btnFreeAll');
       return !!b && b.closest('.menu') === null && /Enrich all \(free\)/.test(b.textContent);
     }));
  ck('  ...and the old two-step sweep button is gone',
     await p.evaluate(() => !document.getElementById('btnSweep')));
  await p.evaluate(() => { enrichAllFree(); });
  await p.waitForTimeout(300);
  ck('it asks before starting', await p.evaluate(() =>
    document.getElementById('mConfirm').classList.contains('open')));
  const q = await p.evaluate(() => document.getElementById('cfMsg').textContent);
  ck('  ...with the true public-record count: 5 — four fresh plus the gap lead',
     /Public record for 5 leads/.test(q), q.slice(0, 90));
  ck('  ...naming the gap refill explicitly', /1 to fill gaps/.test(q), q);
  ck('  ...saying it is free', /no credits, no lookups spent/.test(q));
  ck('  ...and that the complete lead is skipped', /1 already read is skipped/.test(q), q);
  ck('  ...counting the age half by employer, not by lead',
     /ages for 6 leads across 2 employers/.test(q), q);
  ck('  ...promising one read per employer', /one read per employer, not per lead/.test(q), q);
  ck('  ...and naming what it deliberately leaves out: the one that costs credits',
     /WhitePages is not included/.test(q) && /spends lookup credits/.test(q), q);
  await p.evaluate(() => cfDone(false));
  await p.waitForTimeout(300);
  ck('declining runs nothing', calls.length === 0, calls.length);

  // --- the sweep -------------------------------------------------------------
  await p.evaluate(() => { enrichAllFree(); });
  await p.waitForTimeout(250);
  await p.evaluate(() => cfDone(true));
  await p.waitForFunction(() => !document.getElementById('btnFreeAll').textContent.includes('stop'),
                          null, { timeout: 20000 });
  await p.waitForTimeout(400);

  ck('the four unread leads AND the gap lead were searched',
     calls.sort().join() === 'FAlpha,FBravo,FCharlie,FDelta,FGolf', calls.join());
  ck('  ...the complete lead was not re-fetched', !calls.includes('FEcho'));
  ck('  ...nor the lead with no surname', !calls.includes('Ff'));
  ck('  ...and WhitePages was never touched — it spends credits', paid === 0, paid);

  // --- the ages rode along, without a second press ---------------------------
  ck('the proxy reader ran as part of the same press',
     rosters.length === 2, rosters.length);
  ck('  ...once per employer, not once per lead — 6 leads, 2 calls',
     rosters.map(r => r.employer).sort().join() === 'Acme,Nowhere LLC',
     rosters.map(r => r.employer).join());
  ck('  ...carrying every lead at that employer in one request',
     (rosters.find(r => r.employer === 'Acme').people || []).length === 5,
     JSON.stringify((rosters.find(r => r.employer === 'Acme').people || []).map(x => x.last_name)));
  ck('  ...and never used the per-lead endpoint', perLead === 0, perLead);

  const after = await p.evaluate(() => {
    const by = Object.fromEntries(state.leads.map(L => [L.id, L]));
    return { aSec: by.a.pub.filings.length, aRet: by.a.pub.donations.says_retired,
             bDon: by.b.pub.donations.count, cEmpty: !by.c.pub.donations.count && by.c.pub.filings.length === 0,
             dFec: by.d.pub.sources.fec.ran, eAt: by.e.pub.at,
             gFilled: by.g.pub.sources.fec.ran === true && by.g.pub.donations.count === 2,
             aLogged: by.a.activity.some(x => x.k === 'pub'),
             cLogged: by.c.activity.some(x => x.k === 'pub'),
             aAge: by.a.edgar && by.a.edgar.age, cAge: by.c.edgar && by.c.edgar.age,
             bAge: by.b.edgar && by.b.edgar.age, bReason: by.b.edgar && by.b.edgar.reason,
             aAgeLogged: by.a.activity.some(x => x.k === 'edgar'),
             fAge: by.f.edgar };
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
  ck('the ages landed on the two people the proxy names', after.aAge === 61 && after.cAge === 54,
     [after.aAge, after.cAge].join());
  ck('  ...and the age is logged with the filing it came from', after.aAgeLogged === true);
  ck('a lead at that employer who is NOT in the proxy records the miss',
     after.bAge === null && /not listed|states no ages/.test(after.bReason || ''), after.bReason);
  ck('  ...so the next press does not read the same filing for them again',
     await p.evaluate(() => !!state.leads.find(x => x.id === 'b').edgar));
  ck('a lead with no surname is not sent to the proxy reader either',
     after.fAge === undefined, JSON.stringify(after.fAge));

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
  ck('  ...and the ages it read, with the employers it read them from',
     /2 ages from proxy statements \(1 employer read\)/.test(summary), summary);
  ck('  ...counts who told the FEC they are retired', /1 told the FEC/.test(summary));
  ck('  ...and the refilled gap lead counts among the donors', /3 donors/.test(summary), summary);
  ck('  ...and reports the rate-limited lookups as gaps, not as empties',
     /1 donation lookup did not run/.test(summary), summary);

  // --- running it again ------------------------------------------------------
  await p.evaluate(() => { enrichAllFree(); });
  await p.waitForTimeout(300);
  const q2 = await p.evaluate(() => document.getElementById('cfMsg').textContent);
  ck('a second press offers exactly the surviving gap — Delta — and nothing else',
     /Public record for 1 lead/.test(q2) && /1 to fill gaps/.test(q2), q2.slice(0, 100));
  ck('  ...and does not re-read a single proxy statement', !/ages for/.test(q2), q2.slice(0, 120));
  await p.evaluate(() => cfDone(false));
  await p.waitForTimeout(200);
  // Close Delta's gap by hand, and only then is the list truly done.
  await p.evaluate(() => { state.leads.find(x => x.id === 'd').pub.sources.fec.ran = true; });
  const before = rosters.length;
  await p.evaluate(() => { enrichAllFree(); });
  await p.waitForTimeout(300);
  const again = await p.evaluate(() => document.getElementById('mConfirm').classList.contains('open'));
  ck('with everything read, a third press says there is nothing to do',
     !again && /already been read/.test(await p.evaluate(() => document.getElementById('toast').textContent)),
     await p.evaluate(() => document.getElementById('toast').textContent));
  ck('  ...and reads nothing', rosters.length === before, rosters.length - before);

  ck('no page errors', errs.length === 0, errs.slice(0, 2).join(' | '));
  console.log(fail ? `\nFAILURES: ${fail} of ${n}` : `\nall ${n} checks passed`);
  await b.close(); process.exit(fail ? 1 : 0);
})();
