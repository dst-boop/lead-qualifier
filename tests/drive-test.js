const { chromium } = require('playwright');
const ME = { signed_in:true, provider:'google', name:'Dan', email:'d@f.com',
  providers:{google:true}, features:{whitepages:true, ai_qc:false, server_state:false, drive:true},
  storage:'memory', encryption:'kms' };
const FILES = [
  { id:'f1', name:'401(k) Rollover Leads.xlsx', mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', modifiedTime:'2026-08-09T18:00:00Z' },
  { id:'f2', name:'401(k) Rollover Leads (old)', mimeType:'application/vnd.google-apps.spreadsheet', modifiedTime:'2026-07-01T10:00:00Z' },
];
const ROWS = [
  ['First Name','Last Name','Job Title','Management Level','Company Name','Person State','Mobile Phone','Email Address','Job Start Date','Graduation Year','Years of Experience','Years at Current Employer'],
  ['Margaret','Holloway','VP Operations','VP Level Exec','Meridian','NJ','(973) 555-0142','m@x.com','2025-03-01','1986','34','1'],
  ['Ray','Ortiz','Chief Financial Officer','C Level Exec','Coastal','PA','(215) 555-7734','r@y.com','2024-11-15','1988','36','2'],
];
(async () => {
  const b = await chromium.launch({ executablePath:'/opt/pw-browsers/chromium' }).catch(()=>chromium.launch());
  const p = await b.newPage({ viewport:{width:1400,height:900} });
  const errs=[]; p.on('pageerror',e=>errs.push(e.message));
  let searched='';
  await p.route('**/api/me', r=>r.fulfill({json:ME}));
  await p.route('**/api/drive/find*', r=>{ searched=new URL(r.request().url()).searchParams.get('name');
    return r.fulfill({json:{files:FILES, searched}}); });
  await p.route('**/api/drive/rows*', r=>r.fulfill({json:{name:'401(k) Rollover Leads.xlsx', rows:ROWS, truncated:false}}));

  await p.goto('http://127.0.0.1:8099/', {waitUntil:'networkidle'});
  await p.waitForTimeout(400);
  console.log('button visible :', await p.isVisible('#btnDrive'));
  await p.click('#btnDrive');
  await p.waitForTimeout(600);
  console.log('default search :', JSON.stringify(searched));
  console.log('files listed   :', await p.$$eval('#drvList .sigrow', n=>n.length));
  await p.screenshot({ path:'d1-picker.png' });

  await p.click('#drvList .sigrow');            // import the newest
  await p.waitForTimeout(600);
  console.log('mapper open    :', await p.isVisible('#mImport'));
  const mapped = await p.evaluate(() => {
    const g = {}; document.querySelectorAll('#mapRows select').forEach(s=>{
      if (+s.value > -1) g[s.dataset.key] = s.options[s.selectedIndex].text; });
    return g;
  });
  console.log('auto-mapped    :', JSON.stringify(mapped));
  await p.screenshot({ path:'d2-mapper.png' });
  await p.click('#btnDoImport');
  await p.waitForTimeout(800);
  const res = await p.evaluate(()=>({ n:state.leads.length,
    rows:state.leads.map(l=>`${l.lastName} ${l.tier}·${l.score}`).join(', ') }));
  console.log('imported       :', res.n, '->', res.rows);
  await p.screenshot({ path:'d3-scored.png', fullPage:true });
  console.log(errs.length ? 'ERRORS: '+errs.join(' | ') : 'no page errors');
  await b.close();
})().catch(e=>{console.error(e.message);process.exit(1);});
