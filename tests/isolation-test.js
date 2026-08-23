const { chromium } = require('playwright');
const HDR=['First Name','Last Name','Job Title','Management Level','Company Name','Person State','Mobile Phone','Email Address'];
const ROW=['Ada','Alpha','Chief Financial Officer','C Level Exec','Meridian','NJ','(973) 555-0142','a@meridian.com'];

const me=(o)=>({signed_in:false,providers:{google:true,microsoft:true},
  features:{whitepages:true,ai_qc:true,server_state:true,drive:true},
  storage:'firestore',encryption:'kms',...o});

(async()=>{
  const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium'}).catch(()=>chromium.launch());
  const ctx=await b.newContext();                 // one browser profile = one shared machine
  const p=await ctx.newPage({viewport:{width:1400,height:900}});
  const errs=[]; p.on('pageerror',e=>errs.push('PAGEERROR: '+(e.stack||e.message)));
  p.on('console',m=>{if(m.type()==='error')errs.push('CONSOLE: '+m.text());});

  let who=me({}); let serverDb={};              // email -> {settings,leads}
  const puts=[];
  await p.route('**/api/me',r=>r.fulfill({json:who}));
  await p.route('**/api/state',r=>{
    const em=who.email||'';
    if(r.request().method()==='PUT'){
      const body=JSON.parse(r.request().postData()||'{}');
      puts.push({as:em,n:(body.leads||[]).length});
      serverDb[em]=body; return r.fulfill({json:{ok:true}});
    }
    const d=serverDb[em];
    return r.fulfill({json:d?{found:true,...d}:{found:false,settings:{},leads:[]}});
  });
  // Drive is per-account: A has a prospecting sheet, B does not. That is the
  // only honest way to mock automatic sourcing here — B's list must stay empty
  // because B's own Drive is empty, not because sourcing was switched off.
  await p.route('**/api/drive/find*',r=>r.fulfill({json:{
    files:(who.email==='a@firm.com')?[{id:'f1',name:'Wealth Management Lead Prospecting',
      mimeType:'application/vnd.google-apps.spreadsheet',modifiedTime:'2026-08-20T18:00:00Z'}]:[],
    searched:'x'}}));
  await p.route('**/api/drive/rows*',r=>r.fulfill({json:{name:'x.xlsx',rows:[HDR,ROW],truncated:false}}));

  let fail=0;
  const ck=(n,c,d)=>{console.log((c?'ok   ':'FAIL ')+n+(d?'  '+d:''));if(!c)fail++;};
  const leadCount=()=>p.evaluate(()=>state.leads.length);
  const reload=async()=>{await p.goto('http://127.0.0.1:8099/',{waitUntil:'networkidle'});await p.waitForTimeout(600);};

  // --- User A signs in and imports a lead -------------------------------
  who=me({signed_in:true,provider:'google',name:'User A',email:'a@firm.com'});
  await reload();
  await p.waitForFunction(()=>state.leads.length>0,null,{timeout:8000});
  await p.waitForTimeout(300);
  ck('user A imports a lead', await leadCount()===1, 'n='+await leadCount());

  // --- User A signs out -------------------------------------------------
  who=me({}); await reload();
  ck('signed out shows NO leads', await leadCount()===0, 'n='+await leadCount());
  const emptyTxt=await p.textContent('#empty');
  ck('  ...and says why', /Sign in to see your leads/.test(emptyTxt), JSON.stringify(emptyTxt.trim().slice(0,46)));
  ck('  ...import is disabled', await p.isDisabled('#btnCsv'), '');

  // --- User B signs in on the SAME browser ------------------------------
  const putsBefore=puts.length;
  who=me({signed_in:true,provider:'microsoft',name:'User B',email:'b@firm.com'});
  await reload();
  ck('user B sees an empty list', await leadCount()===0, 'n='+await leadCount());
  const leaked=puts.slice(putsBefore).filter(x=>x.as==='b@firm.com'&&x.n>0);
  ck('user B did NOT upload A’s leads', leaked.length===0, JSON.stringify(puts.slice(putsBefore)));
  ck('server never stored leads for B', !(serverDb['b@firm.com']||{leads:[]}).leads.length, '');

  // --- User A returns: their list is still theirs -----------------------
  who=me({signed_in:true,provider:'google',name:'User A',email:'a@firm.com'});
  await reload();
  ck('user A still has their lead', await leadCount()===1, 'n='+await leadCount());

  // --- Legacy shared key is migrated once, then gone --------------------
  await p.evaluate(()=>localStorage.setItem('lq-data',JSON.stringify({settings:{},leads:[
    {id:'x1',firstName:'Leg',lastName:'Acy',title:'CFO',employer:'Old',state:'NJ',mobilePhone:'(201) 555-1111',email:'l@old.com',activity:[]}]})));
  serverDb={};                                    // fresh accounts, nothing on server
  who=me({signed_in:true,provider:'google',name:'User C',email:'c@firm.com'});
  await reload();
  ck('first account adopts the legacy list', await leadCount()===1, 'n='+await leadCount());
  const legacyGone=await p.evaluate(()=>localStorage.getItem('lq-data')===null);
  ck('  ...and the shared key is deleted', legacyGone, '');
  who=me({signed_in:true,provider:'google',name:'User D',email:'d@firm.com'});
  await reload();
  ck('second account does NOT inherit it', await leadCount()===0, 'n='+await leadCount());

  console.log(errs.length?'\nERRORS:\n  '+errs.join('\n  '):'\nNo JS errors.');
  console.log(fail?`\n${fail} CHECK(S) FAILED`:'\nAll checks passed.');
  await b.close(); process.exit(fail?1:0);
})().catch(e=>{console.error('HARNESS:',e.message);process.exit(1);});
