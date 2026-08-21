// The auth bar is the only place a user learns their ZoomInfo seat exists, so
// every combination of (service configured, this user connected) has to say the
// right thing — and a signed-out visitor must not be offered a seat at all.
const { chromium } = require('playwright');
const me=(o)=>({signed_in:false,providers:{google:true,microsoft:true},
  features:{whitepages:true,ai_qc:true,server_state:true,drive:true,zoominfo:false},
  storage:'firestore',encryption:'kms',...o});

(async()=>{
  const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium'}).catch(()=>chromium.launch());
  const p=await (await b.newContext()).newPage({viewport:{width:1400,height:900}});
  const errs=[]; p.on('pageerror',e=>errs.push('PAGEERROR: '+(e.stack||e.message)));
  p.on('console',m=>{if(m.type()==='error')errs.push('CONSOLE: '+m.text());});

  let who=me({}), ziBody=null, ziStatus=200, ziResp={data:[]};
  await p.route('**/api/me',r=>r.fulfill({json:who}));
  await p.route('**/api/state',r=>r.fulfill({json:{found:false,settings:{},leads:[]}}));
  await p.route('**/api/zi/search',r=>{
    ziBody=JSON.parse(r.request().postData()||'{}');
    return r.fulfill({status:ziStatus,json:ziStatus===200?ziResp:{detail:'Connect your ZoomInfo account first.'}});
  });

  let fail=0,n=0;
  const ck=(name,c,d)=>{n++;console.log((c?'ok   ':'FAIL ')+name+(d?'  '+d:''));if(!c)fail++;};
  const reload=async()=>{await p.goto('http://127.0.0.1:8099/',{waitUntil:'networkidle'});await p.waitForTimeout(500);};
  const bar=()=>p.innerHTML('#authbar');

  // --- signed out ------------------------------------------------------
  await reload();
  let h=await bar();
  ck('signed out: no ZoomInfo offer', !/ZoomInfo/i.test(h), h.replace(/<[^>]+>/g,'').trim().slice(0,60));

  // --- signed in, service not configured -------------------------------
  who=me({signed_in:true,provider:'google',name:'Dan',email:'dst@fpa.com'});
  await reload(); h=await bar();
  ck('service unconfigured: nothing to connect', !/ZoomInfo/i.test(h));

  // --- signed in, configured, not connected ----------------------------
  who=me({signed_in:true,provider:'google',name:'Dan',email:'dst@fpa.com',
    features:{whitepages:true,ai_qc:true,server_state:true,drive:true,zoominfo:true}});
  await reload(); h=await bar();
  ck('configured + disconnected: offers Connect', /Connect ZoomInfo/.test(h));
  ck('  ...pointing at the login route', /href="\/auth\/zoominfo\/login"/.test(h));
  ck('  ...and does not claim to be connected', !/ZoomInfo connected/.test(h));
  ck('  ...ziConnected() is false', await p.evaluate(()=>ziConnected())===false);

  // --- signed in, configured, connected --------------------------------
  who=me({signed_in:true,provider:'microsoft',name:'Dan',email:'dst@fpa.com',zi_connected:true,
    features:{whitepages:true,ai_qc:true,server_state:true,drive:true,zoominfo:true}});
  await reload(); h=await bar();
  ck('connected: says so', /ZoomInfo connected/.test(h));
  ck('  ...offers Disconnect', /href="\/auth\/zoominfo\/disconnect"/.test(h));
  ck('  ...and stops offering Connect', !/Connect ZoomInfo/.test(h));
  ck('  ...ziConnected() is true', await p.evaluate(()=>ziConnected())===true);
  ck('sign out still reachable', /href="\/auth\/logout"/.test(h));

  // --- ziSearch() shape -------------------------------------------------
  ziResp={maxResults:2,data:[{id:1},{id:2}]};
  const out=await p.evaluate(()=>ziSearch('search/contact',{jobTitleList:['Founder']}));
  ck('ziSearch posts path+body', ziBody&&ziBody.path==='search/contact'
     &&JSON.stringify(ziBody.body)==='{"jobTitleList":["Founder"]}', JSON.stringify(ziBody));
  ck('  ...defaults to POST', ziBody&&ziBody.method==='POST', ziBody&&ziBody.method);
  ck('  ...returns the raw payload unshaped', out&&out.maxResults===2&&out.data.length===2, JSON.stringify(out));

  ziStatus=401;
  const err=await p.evaluate(()=>ziSearch('search/contact',{}).then(()=>null,e=>e.message));
  ck('a 401 surfaces the server’s own words', err==='Connect your ZoomInfo account first.', JSON.stringify(err));

  // The deliberate 401 above makes the browser log a failed-resource line of its
  // own. That one is expected; anything else is a regression.
  const unexpected=errs.filter(e=>!/Failed to load resource.*401/.test(e));
  ck('no unexpected page errors', unexpected.length===0, unexpected.slice(0,2).join(' | '));
  console.log(fail?`\nFAILURES: ${fail} of ${n}`:`\nall ${n} checks passed`);
  await b.close(); process.exit(fail?1:0);
})();
