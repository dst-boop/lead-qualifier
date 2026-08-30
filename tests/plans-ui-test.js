// Pricing the employers, and the chip it puts on a lead.
//
// The number is an average across a whole plan, not this person's balance, and
// the whole value of it depends on that distinction surviving contact with a
// hurried advisor. So the chip says "~avg", and the tooltip says what it came
// from and what it is not.
const { chromium } = require('playwright');

const feat=o=>({whitepages:false,ai_qc:false,server_state:true,drive:false,zoominfo:false,
                edgar:false,zi_mcp:false,opportunities:true,...o});
const me=o=>({signed_in:true,provider:'google',name:'Dan',email:'dan@fpa.com',
              providers:{google:true},features:feat(),storage:'firestore',encryption:'kms',...o});

(async()=>{
  const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium'}).catch(()=>chromium.launch());
  const p=await b.newPage({viewport:{width:1500,height:1000}});
  const errs=[];p.on('pageerror',e=>errs.push(e.message));
  p.on('console',m=>{if(m.type()==='error')errs.push('CONSOLE: '+m.text());});

  let reply={plans:{
    'Boeing':{plan_name:'The Boeing Company 401(k)',participants:120000,assets:79000000000,
              avg_balance:658333,sponsor:'THE BOEING COMPANY',state:'WA',plan_year:'2024'},
    'Cordova Industrial Group':{plan_name:'Cordova 401(k)',participants:940,assets:82431006,
              avg_balance:87692,sponsor:'CORDOVA INDUSTRIAL GROUP INC',state:'NJ',plan_year:'2024'}},
    asked:3,matched:2};
  const asked=[];
  await p.route('**/api/me',r=>r.fulfill({json:me()}));
  await p.route('**/api/settings',r=>r.fulfill({json:{ok:true}}));
  await p.route('**/api/lists',r=>r.fulfill({json:{lists:[{id:'default',name:'My leads',count:3,role:'owner',owner:''}],settings:{}}}));
  await p.route('**/api/plans',async r=>{asked.push(JSON.parse(r.request().postData()));
    return r.fulfill({json:reply});});
  await p.route('**/api/lists/*',r=>r.request().method()==='GET'
    ? r.fulfill({json:{list:{id:'default',name:'My leads'},settings:{},leads:[
        {id:'a',firstName:'Marcus',lastName:'Armstrong',title:'Senior Director',employer:'Boeing',
         mobilePhone:'(206) 555-0140',email:'m@b.com',status:'New',activity:[]},
        {id:'b',firstName:'Ray',lastName:'Okonjo',title:'Manager',employer:'Boeing',
         mobilePhone:'(206) 555-0141',email:'r@b.com',status:'New',activity:[]},
        {id:'c',firstName:'Elena',lastName:'Basilio',title:'Program Manager',
         employer:'Cordova Industrial Group',mobilePhone:'(973) 555-0142',email:'e@c.com',
         status:'New',activity:[]},
        {id:'d',firstName:'Jean',lastName:'Okafor',title:'Senior Manager',employer:'Halstead Marine',
         mobilePhone:'(914) 555-0122',email:'j@h.com',status:'New',activity:[]}]}})
    : r.fulfill({json:{ok:true,lists:[]}}));

  let fail=0,n=0;
  const ck=(name,c,d)=>{n++;console.log((c?'ok   ':'FAIL ')+name+(d?'  '+d:''));if(!c)fail++;};

  await p.goto('http://127.0.0.1:8099/',{waitUntil:'domcontentloaded'});
  await p.evaluate(()=>localStorage.clear());
  await p.goto('http://127.0.0.1:8099/',{waitUntil:'domcontentloaded'});
  await p.waitForFunction(()=>window.ME&&window.ME.signed_in&&typeof renderPipeline==='function',
                          null,{timeout:15000});
  await p.waitForTimeout(700);

  // "Price the employers should be added to the free Enrich button." No
  // standalone button any more — pricing is a phase of the free sweep, and
  // the sweep's own button says so.
  ck('the standalone pricing button is gone',
     await p.evaluate(()=>!document.getElementById('btnPlans')));
  ck('  ...its job named on the free enrich button instead',
     /Form 5500/.test(await p.getAttribute('#btnFreeAll','title')),
     await p.getAttribute('#btnFreeAll','title'));
  ck('  ...and the sweep runs it as its own phase',
     await p.evaluate(()=>/Pricing employers/.test(enrichAllFree.toString())
       &&/loadPlans\(true\)/.test(enrichAllFree.toString())));

  await p.evaluate(()=>loadPlans());await p.waitForTimeout(700);
  ck('it asks about each distinct employer once, not each lead',
     asked.length===1&&asked[0].employers.length===3, JSON.stringify(asked[0]||{}));
  ck('  ...listing the employers on the list',
     asked[0].employers.sort().join('|')==='Boeing|Cordova Industrial Group|Halstead Marine',
     asked[0].employers.join('|'));

  const chips=await p.$$eval('#rows .badge.planchip',e=>e.map(x=>x.textContent.trim()));
  ck('a chip lands on every lead at a matched employer', chips.length===3, JSON.stringify(chips));
  ck('  ...both Boeing people get the same figure',
     chips.filter(c=>/658,333/.test(c)).length===2, JSON.stringify(chips));
  ck('  ...and Cordova gets its own', chips.some(c=>/87,692/.test(c)), JSON.stringify(chips));
  ck('the figure is marked as an average, not a balance',
     chips.every(c=>c.startsWith('~')&&/avg/.test(c)), JSON.stringify(chips));

  const tip=await p.getAttribute('#rows .badge.planchip','title');
  ck('the tooltip names the plan', /Boeing Company 401\(k\)/.test(tip), tip);
  ck('  ...how many people it averages over', /120,000 participants/.test(tip), tip);
  ck('  ...the plan year', /plan year 2024/.test(tip), tip);
  ck('  ...and says plainly it is not this person’s balance',
     /not this person's balance/.test(tip), tip);

  ck('an unmatched employer gets no chip, not a zero',
     await p.evaluate(()=>{const L=state.leads.find(x=>x.employer==='Halstead Marine');
       return !L.plan;}));

  // --- degrading -----------------------------------------------------------
  reply={plans:{},note:'FORM5500_URL is not set — see SETUP-prospecting.md.'};
  await p.evaluate(()=>{state.leads.forEach(L=>delete L.plan);save();render();});
  await p.evaluate(()=>loadPlans());await p.waitForTimeout(700);
  ck('an unconfigured source says so',
     /FORM5500_URL is not set/.test(await p.textContent('#toast')), await p.textContent('#toast'));
  ck('  ...and invents no figures',
     await p.evaluate(()=>state.leads.every(L=>!L.plan)));
  ck('  ...leaving the free-enrich button usable', await p.evaluate(()=>!document.getElementById('btnFreeAll').disabled));

  ck('no page errors', errs.length===0, errs.slice(0,2).join(' | '));
  console.log(fail?`\nFAILURES: ${fail} of ${n}`:`\nall ${n} checks passed`);
  await b.close();process.exit(fail?1:0);
})();
