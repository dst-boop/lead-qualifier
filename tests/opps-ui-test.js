// The Money-in-motion modal. The thing worth guarding is that the table never
// invents a dollar figure: an employer with no Form 5500 match has to show up
// (it is still a real separation event) but with an em-dash where the money
// would be, and a badge saying why. The rest is plumbing — ranked order comes
// from the server and the UI must not resort it, refresh must actually refetch.
const { chromium } = require('playwright');
const feat=(o)=>({whitepages:true,ai_qc:true,server_state:false,drive:false,
  zoominfo:false,edgar:false,zi_mcp:false,opportunities:true,...o});
const me=(o)=>({signed_in:true,provider:'google',name:'Dan',email:'d@f.com',
  providers:{google:true},features:feat(),storage:'firestore',encryption:'kms',...o});

const OPPS={built_at:1756000000,items:[
  {id:'a1',employer:'Cordova Industrial Group',city:'Montclair',state:'NJ',
   effective_date:'2026-06-30',days_until:12,workers:412,plan_matched:true,
   plan_name:'Cordova 401(k)',avg_balance:87692,dollars_in_motion:36129000},
  {id:'b2',employer:'Halstead Marine',city:'Portland',state:'ME',
   effective_date:'2026-07-15',days_until:-3,workers:58,plan_matched:false,
   plan_name:null,avg_balance:null,dollars_in_motion:null},
]};

(async()=>{
  const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium'}).catch(()=>chromium.launch());
  const ctx=await b.newContext({permissions:['clipboard-read','clipboard-write']});
  const p=await ctx.newPage({viewport:{width:1500,height:1000}});
  const errs=[];p.on('pageerror',e=>errs.push(e.message));
  let who=me(), body=OPPS, status=200;
  const asked=[];
  await p.route('**/api/me',r=>r.fulfill({json:who}));
  await p.route('**/api/state',r=>r.fulfill({json:{found:false,settings:{},leads:[]}}));
  await p.route('**/api/opportunities*',r=>{
    asked.push(r.request().url());
    return r.fulfill({status,json:status===200?body:{detail:'source unavailable'}});
  });

  let fail=0,n=0;
  const ck=(name,c,d)=>{n++;console.log((c?'ok   ':'FAIL ')+name+(d?'  '+d:''));if(!c)fail++;};
  const load=async()=>{
    await p.goto('http://127.0.0.1:8099/',{waitUntil:'domcontentloaded'});
    await p.evaluate(()=>localStorage.clear());
    await p.goto('http://127.0.0.1:8099/',{waitUntil:'networkidle'});await p.waitForTimeout(400);
  };
  const shown=async id=>await p.evaluate(i=>{
    const el=document.getElementById(i);return !!el&&el.style.display!=='none';},id);

  // --- the button only exists when the service has feeds configured ----------
  who=me({features:feat({opportunities:false})});
  await load();
  ck('button hidden with no feeds configured', !(await shown('btnOpps')));

  who=me();
  await load();
  ck('button shown when feeds are configured', await shown('btnOpps'));

  // --- opening it ------------------------------------------------------------
  // "Adjust Source so a drop down is not needed": Find employers is a plain
  // button on the card now, no menu in front of it.
  await p.click('#btnOpps');await p.waitForTimeout(500);
  ck('modal opens', await p.isVisible('#mOpps'));
  ck('it fetched without refresh', asked.length===1&&!/refresh/.test(asked[0]), asked[0]);

  const rows=await p.$$('#oppsRows tr');
  ck('one row per employer', rows.length===2, String(rows.length));
  const cells=async(i,j)=>(await p.textContent(`#oppsRows tr:nth-child(${i}) td:nth-child(${j})`)).trim();

  // --- the priced employer ---------------------------------------------------
  ck('employer name shown', (await cells(1,1)).includes('Cordova Industrial Group'));
  ck('  ...with the plan it is leaving', (await cells(1,1)).includes('Cordova 401(k)'));
  ck('  ...and no unpriced badge', !(await cells(1,1)).includes('no plan on file'));
  ck('location shown', await cells(1,2)==='Montclair, NJ', await cells(1,2));
  ck('date carries the countdown', /2026-06-30.*in 12d/.test(await cells(1,3)), await cells(1,3));
  ck('headcount shown', await cells(1,4)==='412', await cells(1,4));
  ck('average balance formatted', await cells(1,5)==='$87,692', await cells(1,5));
  ck('dollars in motion formatted', await cells(1,6)==='$36,129,000', await cells(1,6));

  // --- the unmatched employer: kept, flagged, never priced -------------------
  ck('unmatched employer is still listed', (await cells(2,1)).includes('Halstead Marine'));
  ck('  ...badged as unpriced', (await cells(2,1)).includes('no plan on file'));
  ck('  ...average balance is a dash, not a guess', await cells(2,5)==='—', await cells(2,5));
  ck('  ...so is the total', await cells(2,6)==='—', await cells(2,6));
  ck('  ...and a past date reads as past', /3d ago/.test(await cells(2,3)), await cells(2,3));

  // --- ranking comes from the server ----------------------------------------
  ck('server order is preserved',
     (await cells(1,1)).includes('Cordova')&&(await cells(2,1)).includes('Halstead'));

  // --- the summary line ------------------------------------------------------
  const meta=await p.textContent('#oppsMeta');
  ck('summary counts employers', /2\s*employers/.test(meta), meta);
  ck('  ...and how many were priced', /1 priced from a Form 5500/.test(meta), meta);
  ck('  ...and totals only what it could price', meta.includes('$36,129,000'), meta);

  // --- the copy-search prompt -----------------------------------------------
  const txt=await p.evaluate(()=>oppPrompt(window.__opps[0]));
  ck('prompt names the employer', txt.includes('Cordova Industrial Group'));
  ck('  ...the state', txt.includes('in NJ'));
  ck('  ...the effective date', txt.includes('2026-06-30'));
  ck('  ...the headcount', txt.includes('412 people'));
  ck('  ...asks for the columns the importer maps', /Mobile Phone/.test(txt)&&/Job Start Date/.test(txt));
  ck('  ...and forbids estimating', /blank rather than estimating/i.test(txt));
  const txt2=await p.evaluate(()=>oppPrompt(window.__opps[1]));
  ck('an unpriced employer still gets a usable prompt',
     txt2.includes('Halstead Marine')&&!/\$/.test(txt2));

  await p.click('#oppsRows tr:nth-child(1) button');await p.waitForTimeout(300);
  ck('copy puts the prompt on the clipboard',
     (await p.evaluate(()=>navigator.clipboard.readText())).includes('Cordova Industrial Group'));

  // --- refresh actually refetches -------------------------------------------
  await p.click('#btnOppsRefresh');await p.waitForTimeout(500);
  ck('refresh asks the server to refetch', /refresh=true/.test(asked[asked.length-1]), asked[asked.length-1]);

  // --- an empty result says so instead of showing a blank table -------------
  body={built_at:0,items:[],note:'No feeds have been fetched yet.'};
  await p.click('#btnOppsRefresh');await p.waitForTimeout(500);
  ck('empty result explains itself',
     (await p.textContent('#oppsMeta')).includes('No feeds have been fetched yet.'));
  ck('  ...and the table says nothing yet',
     (await p.textContent('#oppsRows')).includes('Nothing yet.'));

  // --- a failing source degrades ---------------------------------------------
  status=500;
  await p.click('#btnOppsRefresh');await p.waitForTimeout(500);
  ck('a failure is reported in place', /Could not load/.test(await p.textContent('#oppsMeta')),
     await p.textContent('#oppsMeta'));
  ck('the modal is still usable', await p.isVisible('#mOpps'));

  const unexpected=errs.filter(e=>!/Failed to load resource/.test(e));
  ck('no page errors', unexpected.length===0, unexpected.slice(0,2).join(' | '));
  console.log(fail?`\nFAILURES: ${fail} of ${n}`:`\nall ${n} checks passed`);
  await b.close();process.exit(fail?1:0);
})();
