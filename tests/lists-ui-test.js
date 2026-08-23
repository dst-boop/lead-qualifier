// The list switcher and the From picker.
//
// Two properties are worth the test. Switching lists must flush the list you
// are leaving before it loads the one you are opening — otherwise the last few
// edits land on the wrong list, and nothing about the UI would show it. And the
// From picker must not appear when there is only one address, because a
// dropdown with one option asks the user to confirm a choice they do not have.
const { chromium } = require('playwright');

const feat=o=>({whitepages:true,ai_qc:false,server_state:true,drive:false,zoominfo:false,
                edgar:false,zi_mcp:false,opportunities:false,...o});
const me=o=>({signed_in:true,provider:'google',name:'Dan',email:'d@f.com',providers:{google:true,microsoft:true},
              features:feat(),storage:'firestore',encryption:'kms',...o});

(async()=>{
  const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium'}).catch(()=>chromium.launch());
  const p=await b.newPage({viewport:{width:1500,height:1000}});
  const errs=[];p.on('pageerror',e=>errs.push(e.message));
  p.on('console',m=>{if(m.type()==='error')errs.push('CONSOLE: '+m.text());});

  // server-side lists, in memory
  let lists=[{id:'default',name:'My leads',count:1},{id:'l2',name:'SCS — Boeing',count:0}];
  let store={default:[{id:'a',firstName:'Ada',lastName:'Alpha',title:'CFO',employer:'Meridian',
                       mobilePhone:'(973) 555-0142',email:'a@m.com',status:'New',activity:[]}],
             l2:[]};
  let senderList=[{id:'google:dst@fpa.com',provider:'google',address:'dst@fpa.com',primary:true,kind:'primary'},
                  {id:'google:advisors@fpa.com',provider:'google',address:'advisors@fpa.com',primary:false,kind:'alias'},
                  {id:'microsoft:dan@equitable.com',provider:'microsoft',address:'dan@equitable.com',primary:true,kind:'primary'}];
  const emails=[];

  await p.route('**/api/me',r=>r.fulfill({json:me()}));
  await p.route('**/api/senders',r=>r.fulfill({json:{senders:senderList,default:(senderList[0]||{}).id||''}}));
  await p.route('**/api/settings',r=>r.fulfill({json:{ok:true}}));
  await p.route('**/api/send-email',async r=>{emails.push(JSON.parse(r.request().postData()));return r.fulfill({json:{ok:true}});});
  await p.route('**/api/lists',async r=>{
    if(r.request().method()==='POST'){
      const body=JSON.parse(r.request().postData());
      const id='l'+(lists.length+1);
      store[id]=body.copy_from?JSON.parse(JSON.stringify(store[body.copy_from]||[])):[];
      lists=lists.concat([{id,name:body.name,count:store[id].length}]);
      return r.fulfill({json:{list:lists[lists.length-1],lists}});
    }
    return r.fulfill({json:{lists,settings:{}}});
  });
  await p.route('**/api/lists/*',async r=>{
    const id=decodeURIComponent(r.request().url().split('/api/lists/')[1].split('?')[0]);
    const m=r.request().method();
    if(m==='GET'){
      const entry=lists.find(l=>l.id===id);
      if(!entry)return r.fulfill({status:404,json:{detail:'No such list.'}});
      return r.fulfill({json:{list:entry,leads:store[id]||[],settings:{}}});
    }
    if(m==='PUT'){
      store[id]=JSON.parse(r.request().postData()).leads;
      lists=lists.map(l=>l.id===id?{...l,count:store[id].length}:l);
      return r.fulfill({json:{ok:true,lists}});
    }
    if(m==='PATCH'){
      const name=JSON.parse(r.request().postData()).name;
      lists=lists.map(l=>l.id===id?{...l,name}:l);
      return r.fulfill({json:{list:lists.find(l=>l.id===id),lists}});
    }
    if(m==='DELETE'){lists=lists.filter(l=>l.id!==id);delete store[id];
      return r.fulfill({json:{ok:true,lists}});}
  });

  let fail=0,n=0;
  const ck=(name,c,d)=>{n++;console.log((c?'ok   ':'FAIL ')+name+(d?'  '+d:''));if(!c)fail++;};
  // networkidle is the wrong signal here: this page keeps a few requests in
  // flight after boot, and a slow first paint right after another suite makes
  // it time out. Wait for the thing that actually matters instead.
  const load=async()=>{
    await p.goto('http://127.0.0.1:8099/',{waitUntil:'domcontentloaded'});
    await p.evaluate(()=>localStorage.clear());
    await p.goto('http://127.0.0.1:8099/',{waitUntil:'domcontentloaded'});
    await p.waitForFunction(()=>window.ME&&window.ME.signed_in&&typeof renderLists==='function',
                            null,{timeout:15000});
    await p.waitForTimeout(600);
  };
  const leadNames=()=>p.evaluate(()=>state.leads.map(L=>L.firstName));

  await load();
  ck('the switcher shows the open list', (await p.textContent('#listName')).trim()==='My leads',
     await p.textContent('#listName'));
  ck('it opened the first list', (await leadNames()).join()==='Ada', (await leadNames()).join());

  await p.click('#btnLists');await p.waitForTimeout(150);
  const rows=await p.$$eval('#listRows .listrow',els=>els.map(e=>e.textContent.replace(/\s+/g,' ').trim()));
  ck('both lists are listed with their counts',
     rows.length===2&&/My leads1$/.test(rows[0])&&/SCS — Boeing0$/.test(rows[1]), JSON.stringify(rows));
  ck('  ...and the open one is ticked', rows[0].startsWith('✓'), rows[0]);

  // --- switching -------------------------------------------------------------
  await p.click('#listRows .listrow:nth-child(2)');await p.waitForTimeout(600);
  ck('switching opens the other list', (await leadNames()).length===0, (await leadNames()).join());
  ck('  ...and renames the button', (await p.textContent('#listName')).trim()==='SCS — Boeing');

  // an edit on the second list, then straight back — the edit must not follow
  await p.evaluate(()=>{state.leads.push({id:'z',firstName:'Zed',lastName:'Zulu',status:'New',
    activity:[],mobilePhone:'1',email:'z@x.com'});scoreLead(state.leads[0]);save();render();});
  await p.click('#btnLists');await p.waitForTimeout(150);
  await p.click('#listRows .listrow:nth-child(1)');await p.waitForTimeout(700);
  ck('going back shows the first list only', (await leadNames()).join()==='Ada', (await leadNames()).join());
  ck('  ...and the edit stayed on the list it was made on',
     await p.evaluate(()=>fetch('/api/lists/l2').then(r=>r.json()).then(d=>d.leads.map(L=>L.firstName).join()))==='Zed');

  // --- creating, renaming, deleting -------------------------------------------
  await p.click('#btnLists');await p.waitForTimeout(120);
  await p.click('#btnNewList');await p.waitForTimeout(250);
  await p.fill('#apInput','WARN — Cordova');
  await p.click('#mPrompt .mbtn.save');await p.waitForTimeout(700);
  ck('a new list is created and opened', (await p.textContent('#listName')).trim()==='WARN — Cordova',
     await p.textContent('#listName'));
  ck('  ...and it is empty', (await leadNames()).length===0);

  await p.click('#btnLists');await p.waitForTimeout(120);
  await p.click('#btnRenameList');await p.waitForTimeout(250);
  await p.fill('#apInput','WARN — Cordova Q4');
  await p.keyboard.press('Enter');await p.waitForTimeout(500);
  ck('renaming works', (await p.textContent('#listName')).trim()==='WARN — Cordova Q4');

  await p.click('#btnLists');await p.waitForTimeout(120);
  await p.click('#btnCopyList');await p.waitForTimeout(250);
  ck('a duplicate is pre-named', (await p.inputValue('#apInput')).startsWith('Copy of'), await p.inputValue('#apInput'));
  await p.click('#mPrompt .mbtn:not(.save)');await p.waitForTimeout(300);
  ck('  ...and cancelling creates nothing',
     await p.evaluate(()=>myLists.length)===3, String(await p.evaluate(()=>myLists.length)));

  await p.click('#btnLists');await p.waitForTimeout(120);
  await p.click('#btnDeleteList');await p.waitForTimeout(300);
  await p.click('#cfYes');await p.waitForTimeout(700);
  ck('deleting drops it and opens another',
     await p.evaluate(()=>myLists.length)===2&&(await p.textContent('#listName')).trim()==='My leads',
     await p.textContent('#listName'));

  // --- the From picker ---------------------------------------------------------
  await p.evaluate(()=>{state.leads[0].email='a@m.com';render();});
  await p.click('#rows tr.lead .abtn.em');await p.waitForTimeout(600);
  ck('the From row appears with more than one address',
     await p.evaluate(()=>document.getElementById('emFromRow').style.display!=='none'));
  const opts=await p.$$eval('#emFrom option',e=>e.map(o=>o.textContent));
  ck('  ...listing every connected address', opts.length===3, JSON.stringify(opts));
  ck('  ...labelled by provider', /Gmail/.test(opts[0])&&/Outlook/.test(opts[2]), JSON.stringify(opts));
  ck('  ...and marking the alias', /alias/.test(opts[1]), opts[1]);

  await p.selectOption('#emFrom','microsoft:dan@equitable.com');
  await p.click('#btnSendEmail');await p.waitForTimeout(600);
  ck('the chosen address is sent to the server',
     emails.length===1&&emails[0].sender==='microsoft:dan@equitable.com', JSON.stringify(emails[0]||{}));
  ck('  ...and recorded on the lead',
     await p.evaluate(()=>state.leads[0].activity.some(a=>/from dan@equitable\.com/.test(a.d||''))),
     await p.evaluate(()=>JSON.stringify(state.leads[0].activity)));
  ck('  ...and remembered for next time',
     await p.evaluate(()=>state.settings.sendAs)==='microsoft:dan@equitable.com');

  await p.click('#rows tr.lead .abtn.em');await p.waitForTimeout(400);
  ck('the remembered address is preselected',
     await p.inputValue('#emFrom')==='microsoft:dan@equitable.com', await p.inputValue('#emFrom'));
  await p.click('#mEmail .mbtn:not(.save)');await p.waitForTimeout(200);

  // one address is not a choice
  senderList=[{id:'google:dst@fpa.com',provider:'google',address:'dst@fpa.com',primary:true,kind:'primary'}];
  await load();
  await p.click('#rows tr.lead .abtn.em');await p.waitForTimeout(600);
  ck('a single address hides the picker entirely',
     await p.evaluate(()=>document.getElementById('emFromRow').style.display)==='none');

  ck('no page errors', errs.length===0, errs.slice(0,2).join(' | '));
  console.log(fail?`\nFAILURES: ${fail} of ${n}`:`\nall ${n} checks passed`);
  await b.close();process.exit(fail?1:0);
})();
