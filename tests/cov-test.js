const { chromium } = require('playwright');
const ME={signed_in:true,provider:'google',name:'D',email:'d@f.com',providers:{google:true},
  features:{whitepages:true,ai_qc:false,server_state:false,drive:true},storage:'memory'};
// A realistic thin export: no Years of Experience, no Job Start Date on most.
const THIN=[['First Name','Last Name','Job Title','Company Name','Person State','Email Address'],
  ['Margaret','Holloway','VP Operations','Meridian','NJ','m@x.com'],
  ['Ray','Ortiz','Chief Financial Officer','Coastal','PA','r@y.com'],
  ['Tom','Brister','Senior Software Engineer','Bluefin','NJ','t@b.io']];
const RICH=[['First Name','Last Name','Job Title','Company Name','Person State','Email Address',
  'Mobile Phone','Job Start Date','Graduation Year','Years of Experience','Years at Current Employer'],
  ['Ann','Diaz','Partner & Board Member','Diaz LLP','NY','a@d.com','(212) 555-1000','2025-02-01','1984','38','1'],
  ['Bob','Cole','VP Finance','Acme','NJ','b@c.com','(973) 555-2000','2025-06-01','1987','35','1']];
(async () => {
  const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium'}).catch(()=>chromium.launch());
  const p=await b.newPage({viewport:{width:1200,height:900}}); const errs=[];
  p.on('pageerror',e=>errs.push(e.message));
  let rows=THIN;
  await p.route('**/api/me',r=>r.fulfill({json:ME}));
  await p.route('**/api/state',r=>r.request().method()==='PUT'?r.fulfill({json:{ok:true}}):r.fulfill({json:{found:false,settings:{},leads:[]}}));
  await p.route('**/api/drive/find*',r=>r.fulfill({json:{files:[{id:'f1',name:'Leads.xlsx',mimeType:'x',modifiedTime:'2026-08-09T18:00:00Z'}],searched:'Leads'}}));
  await p.route('**/api/drive/rows*',r=>r.fulfill({json:{name:'Leads.xlsx',rows,truncated:false}}));
  await p.goto('http://127.0.0.1:8099/',{waitUntil:'networkidle'});

  const load=async()=>{ await p.click('#btnDrive'); await p.waitForTimeout(400);
    await p.click('#drvList .sigrow'); await p.waitForTimeout(400);
    await p.click('#btnDoImport'); await p.waitForTimeout(700); };

  await load();
  const thin=await p.evaluate(()=>{renderCoverage();return coverage();});
  console.log('THIN export —', thin.n, 'leads,', thin.tiers.map(t=>t.n+t.t).join('/'));
  thin.rows.forEach(r=>console.log(`   ${r.k} ${String(r.v).padStart(3)}%  ${r.label}`));
  await p.click('#btnCoverage'); await p.waitForTimeout(400);
  await p.screenshot({path:'c1-coverage-thin.png'});
  await p.click('#mCoverage .mbtn.save');

  rows=RICH;
  await p.evaluate(()=>{state.leads=[];save();render();});
  await load();
  const rich=await p.evaluate(()=>{renderCoverage();return coverage();});
  console.log('\nRICH export —', rich.n, 'leads,', rich.tiers.map(t=>t.n+t.t).join('/'));
  rich.rows.forEach(r=>console.log(`   ${r.k} ${String(r.v).padStart(3)}%  ${r.label}`));
  await p.click('#btnCoverage'); await p.waitForTimeout(400);
  await p.screenshot({path:'c2-coverage-rich.png'});
  console.log(errs.length?'\nERRORS: '+errs.join(' | '):'\nno page errors');
  await b.close();
})().catch(e=>{console.error(e.message);process.exit(1);});
