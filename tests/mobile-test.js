const { chromium } = require('playwright');
const ME = { signed_in:true, provider:'google', name:'Dan Treacy',
  email:'dst@financialplannersofamerica.com', providers:{google:true, microsoft:false},
  features:{ whitepages:true, ai_qc:true, server_state:true, drive:true },
  storage:'firestore', encryption:'kms' };

const HEADERS = ['First Name','Last Name','Job Title','Management Level','Company Name',
  'Person State','Mobile Phone','Direct Phone Number','Email Address','Job Start Date',
  'Graduation Year','Years of Experience','Years at Current Employer','Other Current Roles'];
// Two identical high-scorers; only the mobile differs. Plus a CT and an MA lead.
const ROWS = [
  ['Ada','Withmobile','Chief Financial Officer','C Level Exec','Meridian','NJ',
   '(973) 555-0142','(973) 555-8800','a@meridian.com','2025-03-01','1986','34','1','Board member, Acme'],
  ['Bea','Nomobile','Chief Financial Officer','C Level Exec','Meridian','NJ',
   '','(973) 555-8800','b@meridian.com','2025-03-01','1986','34','1','Board member, Acme'],
  ['Cal','Connecticut','VP Finance','VP Level Exec','Coastal','CT',
   '(203) 555-7734','','c@coastal.com','2024-11-15','1988','36','2',''],
  ['Meg','Massachusetts','SVP Ops','VP Level Exec','GSL','MA',
   '(617) 555-4410','','m@gsl.com','2025-08-01','1987','35','1',''],
  ['Lee','Lowscore','Software Engineer','Non-Manager','Bluefin','NJ',
   '','','l@bluefin.io','2023-06-01','2012','13','3',''],
  // 55 on its own, 65 once a mobile lands — must not hide in the bucket as a B.
  ['Ned','Boundary','VP Finance','VP Level Exec','Edge Co','NJ',
   '','(908) 555-1111','n@edge.com','2025-01-01','1986','34','12',''],
];

(async () => {
  const b = await chromium.launch({ executablePath:'/opt/pw-browsers/chromium' }).catch(()=>chromium.launch());
  const p = await b.newPage({ viewport:{width:1440,height:960} });
  const errs=[];
  p.on('pageerror', e=>errs.push('PAGEERROR: '+e.message));
  p.on('console', m=>{ if(m.type()==='error') errs.push('CONSOLE: '+m.text()); });
  await p.route('**/api/me', r=>r.fulfill({json:ME}));
  await p.route('**/api/state', r=>r.request().method()==='PUT'
    ? r.fulfill({json:{ok:true}}) : r.fulfill({json:{found:false, settings:{}, leads:[]}}));
  await p.route('**/api/drive/find*', r=>r.fulfill({json:{files:[
    {id:'f1',name:'401(k) Rollover Leads.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',modifiedTime:'2026-08-20T18:00:00Z'}],searched:'x'}}));
  await p.route('**/api/drive/rows*', r=>r.fulfill({json:{name:'x.xlsx', rows:[HEADERS,...ROWS], truncated:false}}));

  await p.goto('http://127.0.0.1:8099/', {waitUntil:'networkidle'});
  await p.waitForTimeout(400);
  // The sheet is read on arrival — no picker, no mapper, no import button.
  await p.waitForFunction(()=>state.leads.length>0,null,{timeout:8000});
  await p.waitForTimeout(300);

  let fail=0;
  const ck=(name,cond,detail)=>{ console.log((cond?'ok   ':'FAIL ')+name+(detail?'  '+detail:'')); if(!cond)fail++; };

  const L = await p.evaluate(()=>state.leads.map(l=>({
    n:l.lastName, tier:l.tier, would:l.wouldBeTier, score:l.score,
    st:l.state, mob:!!l.mobilePhone, reason:l.exclReason, exSt:l.exclState,
    would_s:l.wouldBeScore })));
  console.log(JSON.stringify(L,null,1));

  const ada=L.find(x=>x.n==='Withmobile'), bea=L.find(x=>x.n==='Nomobile');
  const cal=L.find(x=>x.n==='Connecticut'), meg=L.find(x=>x.n==='Massachusetts');
  const lee=L.find(x=>x.n==='Lowscore');

  ck('lead with a mobile gets a real tier', ada.tier==='A', 'tier='+ada.tier+' score='+ada.score);
  ck('same lead without a mobile is Excluded', bea.tier==='X', 'tier='+bea.tier);
  ck('  ...but keeps its would-be tier A', bea.would==='A', 'wouldBe='+bea.would);
  ck('  ...projects to the same score with a number', bea.would_s===ada.score, ada.score+' vs projected '+bea.would_s);
  ck('  ...actual score is lower (signal C cannot fire)', bea.score<ada.score, bea.score+' < '+ada.score);
  ck('  ...and says why', /no mobile/i.test(bea.reason||''), JSON.stringify(bea.reason));
  ck('CT is no longer blanket-excluded', cal.tier!=='X'&&!cal.exSt, 'tier='+cal.tier);
  ck('MA is no longer blanket-excluded', meg.tier!=='X'&&!meg.exSt, 'tier='+meg.tier);
  ck('low scorer with no mobile is Excluded too', lee.tier==='X', 'tier='+lee.tier);
  ck('  ...and is NOT would-be A', lee.would!=='A', 'wouldBe='+lee.would);

  const noneInABC = await p.evaluate(()=>state.leads.filter(l=>['A','B','C'].includes(l.tier)&&!l.mobilePhone).length);
  ck('no A/B/C lead lacks a mobile', noneInABC===0, 'violations='+noneInABC);

  const label = await p.textContent('#tierRow');
  ck('bucket is not labelled CT/MA', !/CT\/MA/.test(label), label.replace(/\s+/g,' ').slice(0,120));

  // The would-be tier must be visible in the Excluded view, not just in state.
  await p.evaluate(()=>setTier('X')); await p.waitForTimeout(400);
  const chips = await p.textContent('tbody');
  ck('Excluded rows show the would-be tier + score', /→A · 80/.test(chips), chips.replace(/\s+/g,' ').slice(0,100));

  const ned=L.find(x=>x.n==='Boundary');
  ck('boundary lead is held out', ned.tier==='X', 'tier='+ned.tier);
  ck('  ...and projects up into A, not B', ned.would==='A',
     'score='+ned.score+' projected='+ned.would_s+' wouldBe='+ned.would);

  const cov = await p.evaluate(()=>coverage());
  ck('coverage counts held-out leads', cov.noMobile===3, 'noMobile='+cov.noMobile);
  ck('coverage names the would-be A count', cov.heldA===2, 'heldA='+cov.heldA);
  ck('coverage keeps them in the denominator', cov.n===6, 'n='+cov.n);

  // Setting a state filter must still work for anyone who wants one.
  await p.evaluate(()=>{ state.settings.exStates='CT'; rescoreAll(); render(); });
  await p.waitForTimeout(300);
  const cal2 = await p.evaluate(()=>state.leads.find(l=>l.lastName==='Connecticut'));
  ck('state exclusion still works when set', cal2.tier==='X'&&cal2.exclState===true, 'tier='+cal2.tier);

  await p.screenshot({path:'mobile-excl.png', fullPage:true});
  console.log(errs.length ? '\nERRORS:\n  '+errs.join('\n  ') : '\nNo JS errors.');
  console.log(fail ? `\n${fail} CHECK(S) FAILED` : '\nAll checks passed.');
  await b.close();
  process.exit(fail?1:0);
})().catch(e=>{console.error('HARNESS:',e.message);process.exit(1);});
