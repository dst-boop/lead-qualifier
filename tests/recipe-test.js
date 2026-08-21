// A changed default must refresh boilerplate nobody touched, and must never
// silently delete something a user wrote.
const { chromium } = require('playwright');
const me={signed_in:true,provider:'google',name:'Dan',email:'d@f.com',providers:{google:true},
  features:{whitepages:true,ai_qc:true,server_state:true,drive:true,zoominfo:false},storage:'firestore',encryption:'kms'};
const OLD='STANDARD WEEKLY PULL — run in Claude with the ZoomInfo connector, then import the CSV here.\n\n1. Contact search with locationSearchType = Person (where they live, not company HQ)\n2. excludedRegions = whatever states you do not cover (leave blank for all)\n3. managementLevel: run C-Level first, then VP-Level as a separate search\n4. positionStartDateMin = last 12-18 months (the orphaned-401k signal)\n5. requiredFields = email, mobilePhone\n6. excludeJobTitle = Assistant, Associate, Junior, Coordinator\n7. pageSize = 100 — searching is free; enrichment costs credits. Request DNC flags on any enrichment.\n\nWiza: export contacts to CSV and import here — columns map automatically.';
const MINE='MY OWN RECIPE — call the Boeing lifers first, ignore everything else.';
const LEAD={id:'L1',firstName:'A',lastName:'B',status:'New',activity:[],mobilePhone:'555'};

(async()=>{
  const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium'}).catch(()=>chromium.launch());
  const p=await (await b.newContext()).newPage({viewport:{width:1400,height:1000}});
  const errs=[];p.on('pageerror',e=>errs.push(e.message));
  let server={found:false,settings:{},leads:[]};
  await p.route('**/api/me',r=>r.fulfill({json:me}));
  await p.route('**/api/state',r=>r.request().method()==='PUT'
    ? r.fulfill({json:{ok:true}}) : r.fulfill({json:server}));

  let fail=0,n=0;
  const ck=(name,c,d)=>{n++;console.log((c?'ok   ':'FAIL ')+name+(d?'  '+d:''));if(!c)fail++;};
  // Each scenario is a different account arriving fresh. Without wiping the
  // browser copy, load 2 adopts what load 1 saved and never reads the server
  // state the scenario is actually testing.
  const load=async()=>{
    await p.goto('http://127.0.0.1:8099/',{waitUntil:'domcontentloaded'});
    await p.evaluate(()=>localStorage.clear());
    await p.goto('http://127.0.0.1:8099/',{waitUntil:'networkidle'});
    await p.waitForTimeout(500);
  };
  const recipe=()=>p.evaluate(()=>state.settings.recipe);

  // 1. an account carrying the OLD shipped recipe gets the new one
  server={found:true,settings:{recipe:OLD,modelVersion:3,orgName:'FPA'},leads:[LEAD]};
  await load();
  const r1=await recipe();
  ck('untouched old recipe is refreshed', /Contact Info: Business Email AND Mobile Phone/.test(r1), r1.slice(0,48));
  ck('  ...and the API-era text is gone', !/locationSearchType/.test(r1));
  ck('  ...while other settings survive', await p.evaluate(()=>state.settings.orgName)==='FPA');

  // 2. an account that WROTE its own recipe keeps every character
  server={found:true,settings:{recipe:MINE,modelVersion:3},leads:[LEAD]};
  await load();
  ck('a hand-written recipe is untouched', await recipe()===MINE, JSON.stringify((await recipe()).slice(0,40)));

  // 3. an edited-but-similar recipe still counts as the user's
  server={found:true,settings:{recipe:OLD+'\n\n8. Skip anyone in CT.',modelVersion:3},leads:[LEAD]};
  await load();
  ck('an old recipe with one added line is kept', /Skip anyone in CT/.test(await recipe())&&/locationSearchType/.test(await recipe()));

  // 4. a brand-new account gets the current default
  server={found:false,settings:{},leads:[]};
  await load();
  ck('a new account gets the current recipe', /Management Level: C-Level, VP, Director/.test(await recipe()));

  // 5. the reset link is there for anyone who did edit theirs
  server={found:true,settings:{recipe:MINE,modelVersion:3},leads:[LEAD]};
  await load();
  await p.click('#btnSettings');await p.waitForTimeout(400);
  ck('settings shows the user recipe', (await p.inputValue('#sRecipe'))===MINE);
  await p.click('#lnkResetRecipe');await p.waitForTimeout(300);
  const box=await p.inputValue('#sRecipe');
  ck('reset link loads the default', /Records Under Management/.test(box), box.slice(0,40));
  ck('  ...but does not save until you do', await recipe()===MINE);

  // 6. content checks — the recipe must carry what the credits doc actually says
  const d=await p.evaluate(()=>DEFAULTS.recipe);
  [['AND logic on Contact Info',/AND, not ANY/],
   ['one credit per record',/One credit per exported record/],
   ['Records Under Management',/re-pulled or re-enriched free for a year/],
   ['Enhance charges only for updates',/only for records it successfully updates/],
   ['views are not credits',/spends a view even if you never export/],
   ['Management Level export column',/add Management Level/],
   ['the unsolved age gap',/45 of the 80 available points/]
  ].forEach(([label,re])=>ck('recipe states: '+label, re.test(d)));

  // 7. settings must follow the account even with nothing imported yet — this
  // is what signing in on a second machine looks like before the first import.
  server={found:true,settings:{recipe:MINE,orgName:'FPA',wTitle:33,modelVersion:3},leads:[]};
  await load();
  ck('settings survive an account with no leads', await recipe()===MINE, JSON.stringify((await recipe()).slice(0,40)));
  ck('  ...including scoring weights', await p.evaluate(()=>+state.settings.wTitle)===33, await p.evaluate(()=>state.settings.wTitle));
  ck('  ...and org details', await p.evaluate(()=>state.settings.orgName)==='FPA');

  ck('no page errors', errs.length===0, errs.slice(0,2).join(' | '));
  console.log(fail?`\nFAILURES: ${fail} of ${n}`:`\nall ${n} checks passed`);
  await b.close();process.exit(fail?1:0);
})();
