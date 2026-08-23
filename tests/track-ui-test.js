// Callbacks, sharing and the team board — the Magic List feature set.
//
// The callback is the one that has to be right. "Call me back Thursday" is the
// commonest outcome of a call, and until now the date lived in someone's head.
// A reminder nobody is shown is worse than no reminder, so what this pins down
// is that a due callback surfaces on the row, in the Track stage, and in a
// filter — and that it stops surfacing once the meeting is set.
const { chromium } = require('playwright');

const feat=o=>({whitepages:false,ai_qc:false,server_state:true,drive:false,zoominfo:false,
                edgar:false,zi_mcp:false,opportunities:false,...o});
const me=o=>({signed_in:true,provider:'google',name:'Dan',email:'dan@fpa.com',
              providers:{google:true},features:feat(),storage:'firestore',encryption:'kms',...o});
const DAY=86400000;

(async()=>{
  const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium'}).catch(()=>chromium.launch());
  const p=await b.newPage({viewport:{width:1500,height:1000}});
  const errs=[];p.on('pageerror',e=>errs.push(e.message));
  p.on('console',m=>{if(m.type()==='error')errs.push('CONSOLE: '+m.text());});

  let lists=[{id:'default',name:'My leads',count:2,role:'owner',owner:''}];
  let shares=[];
  let leaderboard={days:7,team_size:2,rows:[
    {rank:1,email:'dan@fpa.com',you:true,calls:20,emails:5,invites:2,meetings:1,points:41},
    {rank:2,email:'sam@fpa.com',you:false,calls:40,emails:0,invites:0,meetings:0,points:40}]};
  let battles=[];
  const posted=[];
  const LEADS=[
    {id:'a',firstName:'Ada',lastName:'Alpha',title:'CFO',employer:'Meridian',mobilePhone:'(973) 555-0142',
     email:'a@m.com',status:'New',activity:[]},
    {id:'b',firstName:'Ben',lastName:'Bravo',title:'Director',employer:'Cordova',mobilePhone:'(973) 555-0143',
     email:'b@c.com',status:'New',activity:[]}];

  await p.route('**/api/me',r=>r.fulfill({json:me()}));
  await p.route('**/api/settings',r=>r.fulfill({json:{ok:true}}));
  await p.route('**/api/stats',async r=>{posted.push(JSON.parse(r.request().postData()));
    return r.fulfill({json:{ok:true,day:'2026-08-23'}});});
  await p.route('**/api/leaderboard*',r=>r.fulfill({json:leaderboard}));
  await p.route('**/api/battles',async r=>{
    if(r.request().method()==='POST'){
      const bd=JSON.parse(r.request().postData());
      battles=[{id:'b1',name:bd.name,metric:bd.metric,days:bd.days,start_day:'2026-08-23',
        created_by:'dan@fpa.com',over:false,
        rows:[{rank:1,email:'sam@fpa.com',you:false,points:40},
              {rank:2,email:'dan@fpa.com',you:true,points:20}]}];
      return r.fulfill({json:{battle:battles[0]}});
    }
    return r.fulfill({json:{battles}});
  });
  await p.route('**/api/battles/*',r=>{battles=[];return r.fulfill({json:{ok:true}});});
  await p.route('**/api/lists/*/shares/*',async r=>{
    const who=decodeURIComponent(r.request().url().split('/shares/')[1]);
    shares=shares.filter(s=>s.email!==who);return r.fulfill({json:{ok:true,shares}});});
  await p.route('**/api/lists/*/shares',async r=>{
    if(r.request().method()==='POST'){
      const bd=JSON.parse(r.request().postData());
      shares=shares.filter(s=>s.email!==bd.email).concat([{email:bd.email,role:bd.role}]);
      return r.fulfill({json:{shares}});
    }
    return r.fulfill({json:{shares}});});
  await p.route('**/api/lists',r=>r.fulfill({json:{lists,settings:{}}}));
  await p.route('**/api/lists/*',r=>r.request().method()==='GET'
    ? r.fulfill({json:{list:lists[0],leads:JSON.parse(JSON.stringify(LEADS)),settings:{}}})
    : r.fulfill({json:{ok:true,lists}}));

  let fail=0,n=0;
  const ck=(name,c,d)=>{n++;console.log((c?'ok   ':'FAIL ')+name+(d?'  '+d:''));if(!c)fail++;};
  const load=async()=>{
    await p.goto('http://127.0.0.1:8099/',{waitUntil:'domcontentloaded'});
    await p.evaluate(()=>localStorage.clear());
    await p.goto('http://127.0.0.1:8099/',{waitUntil:'domcontentloaded'});
    await p.waitForFunction(()=>window.ME&&window.ME.signed_in&&typeof renderPipeline==='function',
                            null,{timeout:15000});
    await p.waitForTimeout(700);
  };
  const txt=s=>p.textContent(s).then(t=>t.trim().replace(/\s+/g,' '));

  await load();
  ck('two leads loaded', await p.evaluate(()=>state.leads.length)===2);

  // --- setting a callback ------------------------------------------------------
  ck('every row offers a callback button', (await p.$$('#rows .abtn.cb')).length===2);
  await p.click('#rows tr.lead:nth-child(1) .abtn.cb');await p.waitForTimeout(300);
  ck('the dialog names the lead', /Ada Alpha/.test(await txt('#cbWho')), await txt('#cbWho'));
  ck('  ...and defaults a few days out', (await p.inputValue('#cbDate')).length===10);
  ck('  ...with no Clear on a lead that has none',
     await p.evaluate(()=>document.getElementById('cbClear').style.display)==='none');

  const soon=new Date(Date.now()+2*DAY);
  await p.fill('#cbDate',`${soon.getFullYear()}-${String(soon.getMonth()+1).padStart(2,'0')}-${String(soon.getDate()).padStart(2,'0')}`);
  await p.fill('#cbTime','09:30');
  await p.fill('#cbNote','Reviewing the old Boeing 401(k) with his wife first');
  await p.click('#cbSave');await p.waitForTimeout(400);
  const L0=await p.evaluate(()=>{const L=state.leads.find(x=>x.id==='a');
    return {at:L.callbackAt,note:L.callbackNote,status:L.status,acts:L.activity.map(a=>a.k)};});
  ck('the callback is stored', !!L0.at&&L0.note.startsWith('Reviewing'), JSON.stringify(L0).slice(0,90));
  ck('  ...the lead moves off New', L0.status==='Call Back', L0.status);
  ck('  ...and it is logged', L0.acts.includes('callback'), JSON.stringify(L0.acts));
  ck('a scheduled callback is counted in Track',
     /1 callback scheduled/.test(await txt('#sTrack')), await txt('#sTrack'));
  ck('  ...but nothing is due yet',
     await p.evaluate(()=>document.getElementById('btnDue').style.display)==='none');

  // --- one that has come due ---------------------------------------------------
  await p.evaluate(d=>{const L=state.leads.find(x=>x.id==='b');
    L.callbackAt=Date.now()-d;L.callbackNote='Wanted the fee schedule';L.status='Call Back';
    save();render();},2*DAY);
  ck('a due callback surfaces in Track',
     await p.evaluate(()=>document.getElementById('btnDue').style.display)!=='none');
  ck('  ...counted', /1 callback due now/.test(await txt('#btnDue')), await txt('#btnDue'));
  const row=await txt('#rows .cbline.due');
  ck('  ...and shown on the row with what to pick up on',
     /Wanted the fee schedule/.test(row)&&/2d ago/.test(row), row);
  ck('  ...and an overdue promise outranks a higher score',
     await p.evaluate(()=>filtered()[0].lastName)==='Bravo',
     await p.evaluate(()=>filtered().map(L=>L.lastName).join()));

  await p.click('#btnDue');await p.waitForTimeout(400);
  ck('clicking it filters to just the due ones',
     await p.evaluate(()=>filtered().map(L=>L.lastName).join())==='Bravo',
     await p.evaluate(()=>filtered().map(L=>L.lastName).join()));
  await p.evaluate(()=>{document.getElementById('fDue').checked=false;render();});

  // a callback on a lead you have already booked is noise, not a reminder
  await p.evaluate(()=>{state.leads.find(x=>x.id==='b').status='Set';save();render();});
  ck('booking the meeting takes it out of the due queue',
     await p.evaluate(()=>dueLeads().length)===0);
  await p.evaluate(()=>{state.leads.find(x=>x.id==='b').status='Call Back';save();render();});

  // clearing
  await p.click('#rows tr.lead .abtn.cb.due');await p.waitForTimeout(300);
  ck('an existing callback offers Clear',
     await p.evaluate(()=>document.getElementById('cbClear').style.display)!=='none');
  await p.click('#cbClear');await p.waitForTimeout(400);
  ck('  ...and clearing removes it', await p.evaluate(()=>dueLeads().length)===0);

  // --- sharing -------------------------------------------------------------------
  await p.click('#btnMore');await p.waitForTimeout(120);
  await p.click('#btnShareList');await p.waitForTimeout(400);
  ck('the share dialog names the list', /My leads/.test(await txt('#shWho')), await txt('#shWho'));
  ck('  ...and starts empty', /Not shared with anyone/.test(await txt('#shRows')), await txt('#shRows'));
  await p.fill('#shEmail','sam@fpa.com');
  await p.selectOption('#shRole','viewer');
  await p.click('#shAdd');await p.waitForTimeout(500);
  ck('a colleague can be added', /sam@fpa\.com/.test(await txt('#shRows')), await txt('#shRows'));
  ck('  ...with the access level shown', /can view/.test(await txt('#shRows')), await txt('#shRows'));
  await p.click('#shRows .abtn');await p.waitForTimeout(500);
  ck('  ...and removed again', /Not shared with anyone/.test(await txt('#shRows')), await txt('#shRows'));
  await p.click('#mShare .mbtn');await p.waitForTimeout(200);

  // a list shared WITH you is not yours to rename, share on, or delete
  lists=[{id:'default',name:'My leads',count:2,role:'owner',owner:''},
         {id:'sam@fpa.com~l9',name:'Sam — Boeing',count:9,role:'viewer',owner:'sam@fpa.com'}];
  await load();
  await p.click('#btnLists');await p.waitForTimeout(200);
  const rows=await p.$$eval('#listRows .listrow',e=>e.map(x=>x.textContent.replace(/\s+/g,' ').trim()));
  ck('a shared list says whose it is', /shared by sam@fpa\.com/.test(rows[1]), rows[1]);
  ck('  ...and that it is view only', /view only/.test(rows[1]), rows[1]);
  await p.click('#listRows .listrow:nth-child(2)');await p.waitForTimeout(700);
  await p.click('#btnLists');await p.waitForTimeout(200);
  ck('you cannot rename someone else’s list',
     await p.evaluate(()=>document.getElementById('btnRenameList').style.display)==='none');
  ck('  ...nor share it on',
     await p.evaluate(()=>document.getElementById('btnShareList').style.display)==='none');
  ck('  ...and Delete becomes Leave',
     /Leave this shared list/.test(await txt('#btnDeleteList')), await txt('#btnDeleteList'));
  await p.keyboard.press('Escape');

  // --- the team board ------------------------------------------------------------
  await p.click('#btnTeam');await p.waitForTimeout(700);
  ck('opening the board publishes today’s counters', posted.length>0, JSON.stringify(posted[0]||{}));
  ck('  ...as totals, not increments',
     posted[0]&&'calls' in posted[0]&&'meetings' in posted[0], JSON.stringify(posted[0]||{}));
  const lb=await p.$$eval('#lbRows tr',e=>e.map(x=>x.textContent.replace(/\s+/g,' ').trim()));
  ck('the leaderboard lists the team', lb.length===2, JSON.stringify(lb));
  ck('  ...ranked by points, not dials', /^1\s*dan/.test(lb[0])&&/^2\s*sam/.test(lb[1]), lb.join(' | '));
  ck('  ...marking you', /\(you\)/.test(lb[0]), lb[0]);

  ck('no contests to start with', /No contests running/.test(await txt('#btlBox')));
  await p.fill('#btlName','Friday dials');
  await p.fill('#btlWho','sam@fpa.com');
  await p.selectOption('#btlMetric','calls');
  await p.click('#btlStart');await p.waitForTimeout(600);
  const btl=await txt('#btlBox');
  ck('a contest can be started', /Friday dials/.test(btl), btl.slice(0,80));
  ck('  ...showing the metric and window', /calls · 1d/.test(btl), btl.slice(0,120));
  ck('  ...with a scoreboard', /1\. sam/.test(btl)&&/2\. dan \(you\)/.test(btl), btl);
  ck('a nameless contest is refused',
     await p.evaluate(async()=>{document.getElementById('btlName').value='';
       document.getElementById('btlWho').value='x@y.com';
       document.getElementById('btlStart').click();
       await new Promise(r=>setTimeout(r,250));
       return document.getElementById('toast').textContent;})==='Give the contest a name.');

  ck('no page errors', errs.length===0, errs.slice(0,2).join(' | '));
  console.log(fail?`\nFAILURES: ${fail} of ${n}`:`\nall ${n} checks passed`);
  await b.close();process.exit(fail?1:0);
})();
