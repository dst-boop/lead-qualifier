// The SEC button, and what happens to a lead after it runs. The important
// behaviour is that a confirmed age changes the score AND shows its evidence —
// an age with no filing link is a number the advisor cannot check.
const { chromium } = require('playwright');
const me=(o)=>({signed_in:true,provider:'google',name:'Dan',email:'d@f.com',providers:{google:true},
  features:{whitepages:true,ai_qc:true,server_state:false,drive:false,zoominfo:false,edgar:true},
  storage:'firestore',encryption:'kms',...o});
const HDR=['First Name','Last Name','Job Title','Company Name','Person State','Mobile Phone','Email Address','Job Start Date'];
const ROW=['Ellen','Whitfield','Chief Financial Officer','Boeing','NJ','(973) 555-0148','e@b.com','2024-06-01'];

(async()=>{
  const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium'}).catch(()=>chromium.launch());
  const p=await (await b.newContext()).newPage({viewport:{width:1500,height:1000}});
  const errs=[];p.on('pageerror',e=>errs.push(e.message));
  let who=me(), edgarReply={found:true,age:63,title:'Chief Financial Officer',as_of:'2026',
    quote:'Ellen Whitfield 63 Chief Financial Officer',
    company:{name:'The Boeing Company',cik:'0000012927'},
    filing:{url:'https://www.sec.gov/Archives/edgar/data/12927/x/proxy.htm',filed:'2026-03-15'},reason:''};
  let edgarStatus=200, sent=null;
  await p.route('**/api/me',r=>r.fulfill({json:who}));
  await p.route('**/api/state',r=>r.fulfill({json:{found:false,settings:{},leads:[]}}));
  await p.route('**/api/edgar',r=>{
    sent=JSON.parse(r.request().postData()||'{}');
    return r.fulfill({status:edgarStatus,json:edgarStatus===200?edgarReply:{detail:'SEC 403 — check EDGAR_USER_AGENT'}});
  });

  let fail=0,n=0;
  const ck=(name,c,d)=>{n++;console.log((c?'ok   ':'FAIL ')+name+(d?'  '+d:''));if(!c)fail++;};
  const load=async()=>{
    await p.goto('http://127.0.0.1:8099/',{waitUntil:'domcontentloaded'});
    await p.evaluate(()=>localStorage.clear());
    await p.goto('http://127.0.0.1:8099/',{waitUntil:'networkidle'});await p.waitForTimeout(400);
  };
  const importOne=async(row)=>{
    await p.evaluate(t=>{const dt=new DataTransfer();dt.items.add(new File([t],'t.csv',{type:'text/csv'}));
      const el=document.getElementById('csvFile');el.files=dt.files;el.dispatchEvent(new Event('change'));},
      [HDR.join(','),row.join(',')].join('\n'));
    await p.waitForTimeout(500);
    await p.click('#btnDoImport');await p.waitForTimeout(700);
  };

  await load(); await importOne(ROW);
  const before=await p.evaluate(()=>({t:state.leads[0].tier,s:state.leads[0].score}));
  ck('imports without an age', before.s>0, JSON.stringify(before));
  ck('signal A starts unhit',
     await p.evaluate(()=>!state.leads[0].signals.find(x=>x.k==='A').hit));
  ck('the SEC button is offered', await p.isVisible('button[onclick^="edgarAge"]'));

  await p.click('button[onclick^="edgarAge"]');await p.waitForTimeout(600);
  ck('it sends name and employer',
     sent&&sent.last_name==='Whitfield'&&sent.employer==='Boeing', JSON.stringify(sent));
  const after=await p.evaluate(()=>({t:state.leads[0].tier,s:state.leads[0].score,
    a:state.leads[0].signals.find(x=>x.k==='A')}));
  ck('signal A now hits', after.a.hit===true, JSON.stringify(after.a&&after.a.label));
  ck('  ...worth the full age weight', after.s===before.s+25, before.s+' -> '+after.s);
  ck('  ...and the label credits the SEC', /SEC proxy statement 2026/.test(after.a.label), after.a.label);
  // 30 -> 55 is T(20) + C(10) + A(25). Tier A needs 60, so B is the correct
  // landing spot — a lead with no recent move and no prior-experience data
  // cannot reach A on age alone.
  ck('  ...tier improves', after.t==='B'&&before.t==='C', before.t+' -> '+after.t);
  ck('the button disappears once answered', !(await p.isVisible('button[onclick^="edgarAge"]')));

  // the evidence has to be visible, or the advisor cannot check the person
  await p.click('button[onclick^="toggleDetail"]');await p.waitForTimeout(400);
  const detail=await p.innerHTML('#rows');
  ck('the detail shows the age', /Age 63/.test(detail));
  ck('  ...quotes the filing text', /Ellen Whitfield 63/.test(detail));
  ck('  ...links the actual document',
     /href="https:\/\/www\.sec\.gov\/Archives\/edgar\/data\/12927\/x\/proxy\.htm"/.test(detail));
  ck('  ...and asks the advisor to confirm', /confirm this is the right person/.test(detail));

  // a miss must be recorded, not silently retried forever
  await load(); await importOne(ROW);
  edgarReply={found:false,age:null,title:'',as_of:'',quote:'',
    company:{name:'The Boeing Company'},filing:{url:'u',filed:'2026-03-15'},
    reason:'Ellen Whitfield is not listed with an age in that proxy statement.'};
  await p.click('button[onclick^="edgarAge"]');await p.waitForTimeout(600);
  ck('a miss leaves the score alone',
     await p.evaluate(()=>state.leads[0].score)===before.s, '');
  ck('  ...and does not re-offer the button', !(await p.isVisible('button[onclick^="edgarAge"]')));
  await p.click('button[onclick^="toggleDetail"]');await p.waitForTimeout(400);
  ck('  ...but explains itself in the detail',
     /not listed with an age/.test(await p.innerHTML('#rows')));

  // no employer means nothing to look up
  await load();
  await importOne(['Ray','Okonjo','SVP','','ME','(207) 555-0117','r@x.com','2024-09-15']);
  ck('no employer, no button', !(await p.isVisible('button[onclick^="edgarAge"]')));

  // service not configured
  await load(); who=me({features:{whitepages:true,ai_qc:true,server_state:false,drive:false,zoominfo:false,edgar:false}});
  await load(); await importOne(ROW);
  ck('feature off, no button', !(await p.isVisible('button[onclick^="edgarAge"]')));

  // an SEC error surfaces rather than vanishing
  who=me(); await load(); await importOne(ROW);
  edgarStatus=502;
  await p.click('button[onclick^="edgarAge"]');await p.waitForTimeout(600);
  ck('an SEC error is shown to the user',
     /EDGAR_USER_AGENT/.test(await p.textContent('#toast')), await p.textContent('#toast'));
  ck('  ...and nothing is written to the lead',
     await p.evaluate(()=>state.leads[0].edgar===undefined), '');

  const unexpected=errs.filter(e=>!/Failed to load resource/.test(e));
  ck('no page errors', unexpected.length===0, unexpected.slice(0,2).join(' | '));
  console.log(fail?`\nFAILURES: ${fail} of ${n}`:`\nall ${n} checks passed`);
  await b.close();process.exit(fail?1:0);
})();
