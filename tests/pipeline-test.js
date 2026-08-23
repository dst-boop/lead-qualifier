// The overhaul: four stages in the order the job happens, and a sheet that
// reads itself.
//
// The thing worth guarding is that sourcing is genuinely automatic — the sheet
// a research tool appends to is read on arrival, with no picker and no column
// dialog — and that reading it twice does not duplicate anybody. A sheet that
// grows is the normal case, so every check-in re-reads rows already imported;
// matching on email alone would re-add every row that has no email, which on a
// research tool's output is most of them.
const { chromium } = require('playwright');

const HDR=['Full Name','LinkedIn URL','Current Title','Current Company','Location',
           'Est. Age Range','Mobile Phone','Email Address'];
const R1=['Ada Alpha','https://www.linkedin.com/in/ada/','Chief Financial Officer','Meridian',
          'Newark, New Jersey, United States','55–64','(973) 555-0142','a@meridian.com'];
const R2=['Ben Bravo','https://www.linkedin.com/in/ben/','Director of Engineering','Cordova',
          'Montclair, New Jersey, United States','45–54','',''];
const R3=['Cara Charlie','https://www.linkedin.com/in/cara/','VP Finance','Halstead',
          'Portland, Maine, United States','55–64','(207) 555-0118','c@halstead.com'];

const feat=o=>({whitepages:true,ai_qc:false,server_state:false,drive:true,zoominfo:false,
                edgar:false,zi_mcp:false,opportunities:false,...o});
const me=o=>({signed_in:true,provider:'google',name:'Dan',email:'d@f.com',providers:{google:true},
              features:feat(),storage:'memory',encryption:'none',...o});

(async()=>{
  const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium'}).catch(()=>chromium.launch());
  const p=await b.newPage({viewport:{width:1500,height:1000}});
  const errs=[];p.on('pageerror',e=>errs.push(e.message));
  p.on('console',m=>{if(m.type()==='error')errs.push('CONSOLE: '+m.text());});

  let who=me(), rows=[HDR,R1,R2], files=[{id:'f1',name:'Wealth Management Lead Prospecting',
    mimeType:'application/vnd.google-apps.spreadsheet',modifiedTime:'2026-08-22T18:00:00Z'}];
  const asked=[];
  await p.route('**/api/me',r=>r.fulfill({json:who}));
  await p.route('**/api/state',r=>r.fulfill({json:{found:false,settings:{},leads:[]}}));
  await p.route('**/api/drive/find*',r=>{asked.push(decodeURIComponent(r.request().url()));
    return r.fulfill({json:{files,searched:'x'}});});
  await p.route('**/api/drive/rows*',r=>r.fulfill({json:{name:'Wealth Management Lead Prospecting',rows,truncated:false}}));

  let fail=0,n=0;
  const ck=(name,c,d)=>{n++;console.log((c?'ok   ':'FAIL ')+name+(d?'  '+d:''));if(!c)fail++;};
  const load=async()=>{
    await p.goto('http://127.0.0.1:8099/',{waitUntil:'domcontentloaded'});
    await p.evaluate(()=>localStorage.clear());
    await p.goto('http://127.0.0.1:8099/',{waitUntil:'networkidle'});
    await p.waitForTimeout(700);
  };
  const txt=s=>p.textContent(s).then(t=>t.trim().replace(/\s+/g,' '));

  // --- the sheet reads itself ------------------------------------------------
  await load();
  ck('it looked for the prospecting sheet by name',
     asked.some(u=>u.includes('Wealth Management Lead Prospecting')), asked[0]);
  ck('leads arrive with no picker and no mapper',
     await p.evaluate(()=>state.leads.length)===2, String(await p.evaluate(()=>state.leads.length)));
  ck('  ...and no dialog was opened',
     await p.evaluate(()=>!document.querySelector('.overlay.open')));
  ck('the source stage says what happened', /Added 2 new leads/.test(await txt('#srcNote')), await txt('#srcNote'));
  ck('  ...and warns that the sheet has no phone for everyone',
     /cannot be called until they are enriched/.test(await txt('#srcNote'))===false, await txt('#srcNote'));

  const names=await p.evaluate(()=>state.leads.map(L=>L.firstName+' '+L.lastName).sort());
  ck('a single Name column is split', names.join('|')==='Ada Alpha|Ben Bravo', names.join('|'));
  ck('the estimated age column never made it in',
     await p.evaluate(()=>state.leads.every(L=>!L.gradYear&&!leadAge(L))));

  // --- re-reading a sheet that grew -----------------------------------------
  rows=[HDR,R1,R2,R3];
  await p.click('#btnSync');await p.waitForTimeout(800);
  ck('a second check adds only the new row',
     await p.evaluate(()=>state.leads.length)===3, String(await p.evaluate(()=>state.leads.length)));
  ck('  ...and says the rest were already there',
     /Added 1 new lead from/.test(await txt('#srcNote'))&&/2 already on your list/.test(await txt('#srcNote')),
     await txt('#srcNote'));

  await p.click('#btnSync');await p.waitForTimeout(800);
  ck('checking again with nothing new changes nothing',
     await p.evaluate(()=>state.leads.length)===3, String(await p.evaluate(()=>state.leads.length)));
  ck('  ...and says so plainly', /is up to date/.test(await txt('#srcNote')), await txt('#srcNote'));

  // the row with no email and no id must still be recognised on re-read
  const keys=await p.evaluate(()=>{
    const ben=state.leads.find(L=>L.lastName==='Bravo');
    return {ben:dedupeKeys(ben),hasEmail:!!ben.email};});
  ck('a lead with no email is matched on its profile URL',
     keys.hasEmail===false&&keys.ben.some(k=>k.startsWith('li:')), JSON.stringify(keys.ben));
  ck('  ...and on name plus employer as well',
     keys.ben.some(k=>k.startsWith('ne:')), JSON.stringify(keys.ben));

  // --- the four stages -------------------------------------------------------
  ck('stage 1 counts the list', await txt('#cSource')==='3', await txt('#cSource'));
  ck('stage 3 counts what is worth working',
     /worth working/.test(await txt('#sQualify')), await txt('#sQualify'));
  ck('  ...and reports how many are already past 59½',
     /past 59½/.test(await txt('#sQualify')), await txt('#sQualify'));
  ck('stage 4 starts empty', /Nobody worked yet/.test(await txt('#sTrack')), await txt('#sTrack'));
  const stages=await p.evaluate(()=>['stSource','stEnrich','stQualify','stTrack']
    .map(id=>document.getElementById(id).querySelector('h2').textContent));
  ck('the stages are in the order the job happens',
     stages.join(' → ')==='Source → Enrich → Qualify → Track', stages.join(' → '));

  // --- enrich stage only offers what it can actually do ----------------------
  ck('nothing to enrich without ZoomInfo ids',
     await p.evaluate(()=>document.getElementById('btnEnrichAll').disabled)===true);
  ck('  ...and it says why rather than showing a dead button',
     /no ZoomInfo id|Nothing to enrich/.test(await txt('#sEnrich')), await txt('#sEnrich'));
  const withIds=await p.evaluate(()=>{
    state.leads[0].contactId='555';state.leads[0].mobilePhone='';
    render();
    return {n:document.getElementById('cEnrich').textContent,
            label:document.getElementById('btnEnrichAll').textContent,
            off:document.getElementById('btnEnrichAll').disabled};});
  ck('a lead with an id and a gap becomes enrichable',
     withIds.n==='1'&&withIds.label==='Enrich 1'&&withIds.off===false, JSON.stringify(withIds));

  // --- track stage -----------------------------------------------------------
  const tracked=await p.evaluate(()=>{
    state.leads[0].status='Called';state.leads[1].status='Set';render();
    return {c:document.getElementById('cTrack').textContent,
            sub:document.getElementById('sTrack').textContent,
            chips:[...document.querySelectorAll('#trackRow .chipcount')].map(x=>x.textContent.trim())};});
  ck('stage 4 counts meetings set', tracked.c==='1', tracked.c);
  ck('  ...and how many were worked', /2 leads worked/.test(tracked.sub), tracked.sub);
  ck('  ...with a chip per status', tracked.chips.join('|')==='Called 1|Set 1', tracked.chips.join('|'));
  await p.click('#trackRow .chipcount');await p.waitForTimeout(200);
  ck('a status chip filters the table',
     await p.evaluate(()=>document.getElementById('fStatus').value)==='Called');
  await p.click('#trackRow .chipcount');await p.waitForTimeout(200);
  ck('  ...and clicking it again clears the filter',
     await p.evaluate(()=>document.getElementById('fStatus').value)==='');

  // --- an uncallable lead never heads the call list --------------------------
  const order=await p.evaluate(()=>{
    state.leads=[
      {id:'x',firstName:'High',lastName:'NoPhone',title:'Chief Executive Officer',employer:'A',
       email:'e@x.com',status:'New',activity:[],edgar:{age:64,asOf:'2026'}},
      {id:'y',firstName:'Lower',lastName:'Callable',title:'Manager',employer:'B',
       email:'f@x.com',mobilePhone:'(212) 555-0100',status:'New',activity:[]}];
    state.leads.forEach(scoreLead);
    document.getElementById('fSort').value='score';
    return filtered().map(L=>({n:L.lastName,t:L.tier,s:L.score}));});
  ck('a callable lead outranks a higher-scoring excluded one',
     order[0].n==='Callable'&&order[1].n==='NoPhone', JSON.stringify(order));
  ck('  ...even though the excluded one scores more',
     order[1].s>order[0].s, `${order[1].s} vs ${order[0].s}`);

  // --- the enrich stage tells the truth about why it is idle -----------------
  const idle=await p.evaluate(()=>{
    state.leads=[{id:'p',firstName:'P',lastName:'Q',contactId:'1',retryBlocked:true,
                  status:'New',activity:[]}];
    state.leads.forEach(scoreLead);render();
    return document.getElementById('sEnrich').textContent;});
  ck('parked leads are named as the reason, not "nothing waiting"',
     /waiting on your credit limit/.test(idle), idle);
  const noId=await p.evaluate(()=>{
    state.leads=[{id:'p',firstName:'P',lastName:'Q',email:'e@x.com',status:'New',activity:[]}];
    state.leads.forEach(scoreLead);render();
    return document.getElementById('sEnrich').textContent;});
  ck('a file-sourced lead with no id is explained too',
     /is missing contact details/.test(noId)&&/no ZoomInfo id/.test(noId), noId);

  // --- the overflow menu -----------------------------------------------------
  ck('the secondary actions start hidden', await p.evaluate(()=>document.getElementById('moreMenu').hidden));
  await p.click('#btnMore');await p.waitForTimeout(150);
  ck('  ...open on More', await p.evaluate(()=>!document.getElementById('moreMenu').hidden));
  await p.keyboard.press('Escape');await p.waitForTimeout(150);
  ck('  ...and close on Escape', await p.evaluate(()=>document.getElementById('moreMenu').hidden));

  // --- nothing about JSON survives ------------------------------------------
  const gone=await p.evaluate(()=>({btn:!!document.getElementById('btnPasteJson'),
    modal:!!document.getElementById('mJson'),fn:typeof window.leadFromJson}));
  ck('the JSON importer is gone', !gone.btn&&!gone.modal&&gone.fn==='undefined', JSON.stringify(gone));

  // --- degrading when there is no sheet, and when Drive is not connected -----
  files=[];
  await load();
  ck('a missing sheet is explained, not silent',
     /No sheet named/.test(await txt('#srcNote')), await txt('#srcNote'));
  ck('  ...and names the sheet to create',
     (await txt('#srcNote')).includes('Wealth Management Lead Prospecting'));

  who=me({features:feat({drive:false})});
  await load();
  ck('without Drive it asks for Google rather than failing',
     /Sign in with Google/.test(await txt('#srcNote')), await txt('#srcNote'));
  ck('  ...and no leads were invented', await p.evaluate(()=>state.leads.length)===0);

  ck('no page errors', errs.length===0, errs.slice(0,2).join(' | '));
  console.log(fail?`\nFAILURES: ${fail} of ${n}`:`\nall ${n} checks passed`);
  await b.close();process.exit(fail?1:0);
})();
