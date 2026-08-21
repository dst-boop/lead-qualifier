const { chromium } = require('playwright');

// Everything a signed-in user has, so nothing is hidden behind a feature flag.
const ME = { signed_in:true, provider:'google', name:'Dan Treacy',
  email:'dst@financialplannersofamerica.com', providers:{google:true, microsoft:false},
  features:{ whitepages:true, ai_qc:true, server_state:true, drive:true },
  storage:'firestore', encryption:'kms' };

const HEADERS = ['First Name','Last Name','Job Title','Management Level','Company Name',
  'Person State','Person City','Person Street','Person Zip Code','Mobile Phone',
  'Direct Phone Number','Email Address','Job Start Date','Graduation Year',
  'Years of Experience','Years at Current Employer','Number of Employees',
  'LinkedIn Contact Profile URL','Mobile Phone Do Not Call'];
const ROWS = [
  ['Margaret','Holloway','VP Operations','VP Level Exec','Meridian Health','NJ','Montclair','9 Elm Ave','07042','(973) 555-0142','(973) 555-8800','m@meridian.com','2025-03-01','1986','34','1','4200','https://linkedin.com/in/mh','False'],
  ['Ray','Ortiz','Chief Financial Officer','C Level Exec','Coastal Mfg','PA','Bryn Mawr','2 Oak Rd','19010','(215) 555-7734','(215) 555-2210','r@coastal.com','2024-11-15','1988','36','2','850','','False'],
  ['Tom','Brister','Senior Software Engineer','Non-Manager','Bluefin','NJ','Hoboken','5 Pine St','07030','(201) 555-9021','','t@bluefin.io','2023-06-01','2012','13','3','45','','False'],
  ['Alice','Ferraro','SVP Finance','VP Level Exec','GSL','CT','Stamford','7 Bay St','06901','(203) 555-4410','(203) 555-1200','a@gsl.com','2025-08-01','1987','35','1','2300','','False'],
  ['Priya','Raman','VP Product','VP Level Exec','Clearline','NJ','Edison','3 Fir Ln','08817','(732) 555-8874','(732) 555-3000','p@clearline.com','2025-05-12','1989','33','1','5600','','True'],
];

(async () => {
  const b = await chromium.launch({ executablePath:'/opt/pw-browsers/chromium' }).catch(()=>chromium.launch());
  const p = await b.newPage({ viewport:{width:1440,height:960} });
  const errs = [], warns = [], net = [];
  p.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
  p.on('console', m => { if (m.type()==='error') errs.push('CONSOLE: '+m.text());
                         if (m.type()==='warning') warns.push(m.text()); });
  p.on('requestfailed', r => net.push(r.url()+' — '+(r.failure()||{}).errorText));

  const sent = [];
  await p.route('**/api/me', r=>r.fulfill({json:ME}));
  await p.route('**/api/state', r=>r.request().method()==='PUT'
    ? r.fulfill({json:{ok:true}}) : r.fulfill({json:{found:false, settings:{}, leads:[]}}));
  await p.route('**/api/drive/find*', r=>r.fulfill({json:{files:[
    {id:'f1',name:'401(k) Rollover Leads.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',modifiedTime:'2026-08-09T18:00:00Z'}], searched:'401(k) Rollover Leads'}}));
  await p.route('**/api/drive/rows*', r=>r.fulfill({json:{name:'401(k) Rollover Leads.xlsx', rows:[HEADERS,...ROWS], truncated:false}}));
  await p.route('**/api/verify-phone', r=>r.fulfill({json:{valid:true,line_type:'mobile',
    owner:'Margaret Holloway',name_match:true,same_household:true,owner_city:'Montclair',owner_state:'NJ'}}));
  await p.route('**/api/enrich', r=>r.fulfill({json:{found:true,matched_by:'phone',match_score:92,
    owner:'Margaret Holloway',age:61,dob:'1965-04-00',home_street:'9 Elm Ave',home_city:'Montclair',
    home_state:'NJ',home_zip:'07042',mobiles:['(973) 555-0142'],mobile_count:1,phones_total:4,
    properties_owned:2,owns_home:true,owner_type:'trust',co_owners:['Holloway Family Trust'],
    emails:['mh@gmail.com'],linkedin_url:''}}));
  await p.route('**/api/qc', async r=>{ const body=JSON.parse(r.request().postData());
    await r.fulfill({json:{verdicts: body.leads.map(l=>({i:l.i, ageEst:l.age||58, ageStatus:l.age?'CONFIRMED':'INFERRED',
      gates:{NW:{s:'INFERRED',ev:'senior exec'},YHE:{s:'FAIL',ev:''},'401K':{s:'INFERRED',ev:'recent move'},
             WL:{s:'UNKNOWN',ev:''},INT:{s:'UNKNOWN',ev:''}}, jobHopper:false, grade:'A',
      checklist:['Confirm net worth'], note:'Senior exec.'}))}}); });
  await p.route('**/api/send-email', r=>{ sent.push('email'); return r.fulfill({json:{ok:true,provider:'google'}}); });
  await p.route('**/api/create-event', r=>{ sent.push('event'); return r.fulfill({json:{ok:true,provider:'google'}}); });

  const step = async (name, fn) => {
    const before = errs.length;
    try { await fn(); } catch (e) { errs.push(`STEP "${name}" threw: ${e.message}`); }
    console.log(`${errs.length===before?'ok  ':'ERR '}  ${name}`);
  };

  await p.goto('http://127.0.0.1:8099/', {waitUntil:'networkidle'});
  await p.waitForTimeout(500);

  await step('loads, auth bar rendered', async () => {
    const bar = await p.textContent('#authbar');
    if (!/Signed in as/.test(bar)) throw new Error('auth bar: '+bar);
  });
  await step('feature buttons visible', async () => {
    for (const id of ['#btnDrive','#btnQC']) if (!await p.isVisible(id)) throw new Error(id+' hidden');
  });
  await step('drive picker → mapper → import', async () => {
    await p.click('#btnDrive'); await p.waitForTimeout(500);
    await p.click('#drvList .sigrow'); await p.waitForTimeout(500);
    await p.click('#btnDoImport'); await p.waitForTimeout(800);
    const n = await p.evaluate(()=>state.leads.length);
    if (n !== 5) throw new Error('imported '+n+' of 5');
  });
  await step('tiers assigned', async () => {
    const t = await p.evaluate(()=>state.leads.map(l=>l.lastName+':'+l.tier+l.score).join(' '));
    console.log('        ', t);
  });
  await step('duplicate import is deduped', async () => {
    await p.click('#btnDrive'); await p.waitForTimeout(400);
    await p.click('#drvList .sigrow'); await p.waitForTimeout(400);
    await p.click('#btnDoImport'); await p.waitForTimeout(700);
    const n = await p.evaluate(()=>state.leads.length);
    if (n !== 5) throw new Error('after re-import: '+n+' leads (expected 5)');
  });
  await step('AI QC pass', async () => {
    await p.click('#btnQC'); await p.waitForTimeout(2000);
    const g = await p.evaluate(()=>state.leads.filter(l=>l.qc).length);
    if (!g) throw new Error('no QC verdicts attached');
  });
  await step('verify phone', async () => {
    const btn = await p.$('button[title^="WhitePages check"]');
    if (!btn) throw new Error('no verify button'); await btn.click(); await p.waitForTimeout(900);
  });
  await step('enrich household', async () => {
    const btn = await p.$('button[title^="WhitePages: home"]');
    if (!btn) throw new Error('no enrich button'); await btn.click(); await p.waitForTimeout(900);
    const hd = await p.evaluate(()=>{const l=state.leads.find(x=>x.hd&&x.hd.age);return l?l.hd.age:null;});
    if (hd !== 61) throw new Error('age not stored: '+hd);
  });
  await step('detail row opens', async () => {
    await p.click('button:has-text("More")'); await p.waitForTimeout(600);
    if (!await p.isVisible('tr.detail')) throw new Error('detail row not shown');
  });
  await p.screenshot({path:'a1-detail.png', fullPage:true});
  await step('email modal sends', async () => {
    await p.click('tr.detail button:has-text("Close")').catch(()=>{});
    await p.waitForTimeout(300);
    const em = await p.$('button.abtn.em:not([disabled])');
    if (em) { await em.click(); await p.waitForTimeout(500);
      const go = await p.$('#btnSendEmail'); if (go) { await go.click(); await p.waitForTimeout(700); } }
  });
  await step('invite modal creates event', async () => {
    const inv = await p.$('button.abtn.inv:not([disabled])');
    if (inv) { await inv.click(); await p.waitForTimeout(400);
      await p.fill('#invDate','2026-08-20').catch(()=>{});
      await p.click('#btnMakeIcs'); await p.waitForTimeout(800); }
  });
  await step('export builds a CSV', async () => {
    const dl = p.waitForEvent('download', {timeout:5000}).catch(()=>null);
    await p.click('#btnExport'); const d = await dl;
    if (!d) throw new Error('no download fired');
    console.log('         file:', d.suggestedFilename());
  });
  await step('settings open and save', async () => {
    await p.click('#btnSettings').catch(async()=>{ await p.click('button:has-text("ICP settings")'); });
    await p.waitForTimeout(500);
    const save = await p.$('#btnSaveSettings, .mbtn.save');
    if (save) await save.click();
    await p.waitForTimeout(500);
  });
  await p.screenshot({path:'a2-final.png', fullPage:true});

  console.log('\nsent to backend:', sent.join(', ') || 'nothing');
  console.log('failed requests:', net.length ? net.join(' | ') : 'none');
  console.log(errs.length ? '\nERRORS:\n  '+errs.join('\n  ') : '\nNo JS errors across all steps.');
  await b.close();
})().catch(e=>{console.error('HARNESS:', e.message);process.exit(1);});
