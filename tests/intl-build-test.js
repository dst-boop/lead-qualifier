// Two things reported together: the ZoomInfo panel with nothing to press, and
// international numbers sitting in the call queue.
//
// The build panel used to hide its own buttons when neither route to ZoomInfo
// was available, leaving a form and no action. That reads as broken rather than
// as unconfigured, which is exactly how it was reported. The fix is that the
// panel always offers the search — to run, or to copy and run elsewhere — and
// always says which.
//
// The phone rule is a licensing fact, not a formatting one: a +44 mobile is not
// a lead a US-licensed advisor can work, and the US do-not-call regime does not
// reach it. Segregated rather than deleted, because a US employee posted abroad
// is a judgement for a person.
const { chromium } = require('playwright');

const feat=o=>({whitepages:false,ai_qc:false,server_state:true,drive:false,zoominfo:false,
                edgar:false,zi_mcp:true,opportunities:false,...o});
const me=o=>({signed_in:true,provider:'google',name:'Dan',email:'dan@fpa.com',
              providers:{google:true},features:feat(),zi_mcp_connected:false,
              storage:'firestore',encryption:'kms',...o});

const LEADS=[
  {id:'a',firstName:'Ada',lastName:'Alpha',title:'Chief Financial Officer',employer:'Meridian',
   mobilePhone:'(973) 555-0142',email:'a@m.com',status:'New',activity:[]},
  {id:'b',firstName:'Bruno',lastName:'Bravo',title:'Chief Financial Officer',employer:'Meridian GmbH',
   mobilePhone:'+49 151 23456789',email:'b@m.de',status:'New',activity:[]},
  {id:'c',firstName:'Cara',lastName:'Charlie',title:'Director',employer:'Halstead',
   mobilePhone:'+44 7700 900123',directPhone:'(207) 555-0118',email:'c@h.com',status:'New',activity:[]},
  {id:'d',firstName:'Dev',lastName:'Delta',title:'Director',employer:'Cordova',
   mobilePhone:'',directPhone:'+91 98765 43210',email:'d@c.com',status:'New',activity:[]},
  {id:'e',firstName:'Eve',lastName:'Echo',title:'Director',employer:'Cordova',
   mobilePhone:'12125550143',email:'e@c.com',status:'New',activity:[]}];

(async()=>{
  const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium'}).catch(()=>chromium.launch());
  // Viewport belongs on the context: passing it to newPage() is silently
  // ignored, which left the page at 1280x720 and the build panel's buttons a
  // few pixels below the fold.
  const ctx=await b.newContext({permissions:['clipboard-read','clipboard-write'],
                                viewport:{width:1500,height:1000}});
  const p=await ctx.newPage();
  const errs=[];p.on('pageerror',e=>errs.push(e.message));
  p.on('console',m=>{if(m.type()==='error')errs.push('CONSOLE: '+m.text());});

  let who=me();
  await p.route('**/api/me',r=>r.fulfill({json:who}));
  await p.route('**/api/settings',r=>r.fulfill({json:{ok:true}}));
  await p.route('**/api/lists',r=>r.fulfill({json:{lists:[{id:'default',name:'My leads',count:5,role:'owner',owner:''}],settings:{}}}));
  await p.route('**/api/lists/*',r=>r.request().method()==='GET'
    ? r.fulfill({json:{list:{id:'default',name:'My leads'},settings:{},leads:JSON.parse(JSON.stringify(LEADS))}})
    : r.fulfill({json:{ok:true,lists:[]}}));

  let fail=0,n=0;
  const ck=(name,c,d)=>{n++;console.log((c?'ok   ':'FAIL ')+name+(d?'  '+d:''));if(!c)fail++;};
  const txt=s=>p.textContent(s).then(t=>t.trim().replace(/\s+/g,' '));
  const load=async()=>{
    await p.goto('http://127.0.0.1:8099/',{waitUntil:'domcontentloaded'});
    await p.evaluate(()=>localStorage.clear());
    await p.goto('http://127.0.0.1:8099/',{waitUntil:'domcontentloaded'});
    await p.waitForFunction(()=>window.ME&&window.ME.signed_in&&typeof renderPipeline==='function',
                            null,{timeout:15000});
    await p.waitForTimeout(700);
    await p.evaluate(()=>document.querySelector('details.buildpanel').setAttribute('open',''));
  };

  // --- the panel is never a dead end -----------------------------------------
  await load();
  ck('with no token the Build button is hidden',
     await p.evaluate(()=>document.getElementById('btnBuild').style.display)==='none');
  ck('  ...but Copy this search is not',
     await p.evaluate(()=>{const el=document.getElementById('btnCopySearch');
       return !!el&&el.style.display!=='none';}));
  const line=await txt('#bStatus');
  ck('  ...and the panel says why there is no button',
     /No ZoomInfo token saved/.test(line), line);
  ck('  ...naming where to fix it', /ICP settings/.test(line), line);
  ck('  ...and what to do meanwhile', /Copy this search/.test(line), line);

  await p.click('#btnCopySearch');await p.waitForTimeout(400);
  const copied=await p.evaluate(()=>navigator.clipboard.readText());
  ck('the copied search is the rollover one', /search_contacts/.test(copied)&&/positionStartDateMin/.test(copied),
     copied.slice(0,60));
  ck('  ...carrying the filters on screen', /New York/.test(copied), copied.slice(0,200));
  ck('  ...and telling Claude not to spend credits', /Do NOT call any enrich tool/.test(copied));

  // Shipped bug: the action row lived inside the rollover panel, so choosing
  // SCS hid Build, Enrich, Paste and Copy — a form with nothing to press, which
  // is how "Build a list from ZoomInfo doesn't work" was reported.
  await p.click('#campScs');await p.waitForTimeout(300);
  ck('the actions survive switching to SCS',
     await p.evaluate(()=>{const r=document.getElementById('btnCopySearch').getBoundingClientRect();
       return r.width>0&&r.height>0;}));
  // "Reachable" now has a third shape: Paste a list moved into the Source
  // stage's "Other ways" menu, so it is present and pressable but sized zero
  // until that menu is opened. Still reachable; still not a dead form.
  ck('  ...all of them',
     await p.evaluate(()=>['btnBuild','btnEnrich','btnPaste','btnCopySearch']
       .every(id=>{const el=document.getElementById(id);
                   if(!el)return false;
                   const r=el.getBoundingClientRect();
                   return r.width>0
                     ||getComputedStyle(el).display==='none'
                     ||!!el.closest('.menu');})));
  ck('  ...and are not inside a campaign panel',
     await p.evaluate(()=>!document.getElementById('rolloverInner')
       .contains(document.getElementById('btnBuild'))
       &&!document.getElementById('scsInner').contains(document.getElementById('btnBuild'))));
  await p.click('#btnCopySearch');await p.waitForTimeout(400);
  const scs=await p.evaluate(()=>navigator.clipboard.readText());
  ck('switching campaign copies the SCS search instead',
     /positionStartDateMax/.test(scs)&&/companyTicker/.test(scs), scs.slice(0,70));
  await p.click('#campRollover');await p.waitForTimeout(300);

  // with a token, the button comes back and the line changes
  who=me({zi_mcp_connected:true});
  await load();
  ck('a saved token restores the Build button',
     await p.evaluate(()=>document.getElementById('btnBuild').style.display)!=='none');
  ck('  ...and the line says it is connected',
     /Connected to ZoomInfo/.test(await txt('#bStatus')), await txt('#bStatus'));

  // A deployment with no Anthropic key is not an error any more: the route
  // that works for EVERY user is their own Claude account with the ZoomInfo
  // connector, and the panel teaches it as steps.
  who=me({features:feat({zi_mcp:false})});
  await load();
  const nokey=await txt('#bStatus');
  ck('no API key reads as the everyone-route, not an error',
     /No API needed/.test(nokey)&&!(await p.evaluate(()=>document.getElementById('bStatus').classList.contains('err'))), nokey.slice(0,60));
  ck('  ...naming the one-time connector setup', /Settings . Connectors . ZoomInfo/.test(nokey.replace(/\s+/g,' ')), nokey);
  ck('  ...and the way back in', /Paste a list/.test(nokey));
  ck('  ...with Open in Claude on offer', await p.evaluate(()=>{
    const b=document.getElementById('btnOpenClaude');
    return !!b&&b.getBoundingClientRect().width>0;}));

  // The portable prompt: same search, an ending a human can use. In-app the
  // harness reads the tool result, so Claude says DONE; pasted into
  // claude.ai, the PERSON is the harness and needs a CSV back.
  const portable=await p.evaluate(()=>portablePrompt());
  ck('the portable prompt never says DONE', !/\bDONE\b/.test(portable), portable.slice(-90));
  ck('  ...it demands a CSV code block with the exact header row',
     /output ONLY a CSV code block/.test(portable)&&portable.includes('First Name,Last Name,Job Title'), portable.slice(-200));
  ck('  ...and forbids invented values', /never guess or fill a value/.test(portable));
  ck('  ...while the in-app prompt still says DONE, because the harness reads the result',
     await p.evaluate(()=>/DONE/.test(rolloverPrompt())));
  // The round trip is guaranteed, not hoped for: every header in the demanded
  // row is an exact alias the mapper recognises.
  const trip=await p.evaluate(()=>{
    const heads=PORTABLE_HEADERS.split(',');
    const g=guessColumns(heads);
    return {mapped:Object.keys(g).length,total:heads.length,
            missing:heads.filter((h,i)=>!Object.values(g).includes(i))};
  });
  ck('every demanded header round-trips through the mapper',
     trip.mapped===trip.total&&trip.missing.length===0, JSON.stringify(trip));
  const opened=await p.evaluate(()=>{
    let url=null;const orig=window.open;window.open=u=>{url=u;return null;};
    document.getElementById('btnOpenClaude').click();window.open=orig;return url;});
  ck('Open in Claude opens claude.ai with the search pre-filled',
     opened&&opened.startsWith('https://claude.ai/new?q=')
       &&decodeURIComponent(opened.slice(24)).includes('search_contacts'), (opened||'').slice(0,50));

  // --- international numbers --------------------------------------------------
  who=me();
  await load();
  const regions=await p.evaluate(()=>['(973) 555-0142','+49 151 23456789','+44 7700 900123',
    '+1 212 555 0143','12125550143','2125550143','+1-212-555-0143','','555','+52 55 1234 5678']
    .map(v=>[v,phoneRegion(v)]));
  const R=Object.fromEntries(regions);
  ck('a formatted US number is US', R['(973) 555-0142']==='us');
  ck('  ...as is a bare ten-digit', R['2125550143']==='us');
  ck('  ...and eleven starting with 1', R['12125550143']==='us');
  ck('  ...and an explicit +1', R['+1 212 555 0143']==='us'&&R['+1-212-555-0143']==='us');
  ck('a German mobile is international', R['+49 151 23456789']==='intl');
  ck('  ...a UK one too', R['+44 7700 900123']==='intl');
  ck('  ...and a Mexican one, despite sharing a continent', R['+52 55 1234 5678']==='intl');
  ck('nothing is nothing', R['']==='');
  ck('a fragment is unusable rather than foreign', R['555']==='bad', R['555']);

  const rows=await p.evaluate(()=>state.leads.map(L=>({n:L.lastName,tier:L.tier,intl:!!L.intl,why:L.exclReason})));
  const by=Object.fromEntries(rows.map(r=>[r.n,r]));
  ck('the German lead is held out of the tiers', by.Bravo.tier==='X'&&by.Bravo.intl===true, by.Bravo);
  ck('  ...with a reason a person can act on',
     /outside the US and Canada/.test(by.Bravo.why), by.Bravo.why);
  ck('the US lead is unaffected', by.Alpha.tier!=='X'&&by.Alpha.intl===false, by.Alpha);
  ck('a US bare-11-digit number is not mistaken for foreign',
     by.Echo.tier!=='X'&&by.Echo.intl===false, by.Echo);
  ck('a foreign mobile beats a US desk line — the mobile is what gets dialled',
     by.Charlie.intl===true, by.Charlie);
  ck('with no mobile at all, a foreign desk line still counts',
     by.Delta.intl===true, by.Delta);

  const badge=await p.evaluate(()=>{
    const tr=[...document.querySelectorAll('#rows tr.lead')]
      .find(t=>t.textContent.includes('Bruno'));
    const b=tr&&tr.querySelector('.badge.intl');
    return b?{text:b.textContent.trim(),title:b.title}:null;});
  ck('the row is badged', badge&&badge.text==='INTL', badge&&badge.text);
  // The first version printed a country code and got Germany wrong, reading
  // +49 as +491: codes are one to three digits and length does not separate
  // them. A wrong code beside the number looks looked-up, which is worse than
  // no code at all.
  ck('  ...without guessing a country code', badge&&!/\+\d/.test(badge.text), badge&&badge.text);
  ck('  ...though the tooltip shows the number itself',
     badge&&/\+49151/.test(badge.title), badge&&badge.title);
  ck('  ...and the tooltip explains the licensing reason, not a format one',
     badge&&/US-licensed advisor/.test(badge.title), badge&&badge.title);

  const card=await p.evaluate(()=>{
    const c=[...document.querySelectorAll('#tierRow .card')].find(x=>/International/i.test(x.textContent));
    return c?c.textContent.replace(/\s+/g,' ').trim():null;});
  ck('Qualify counts them separately', card&&/3/.test(card), card);

  await p.evaluate(()=>toggleIntl());await p.waitForTimeout(300);
  ck('clicking it shows only those leads',
     await p.evaluate(()=>filtered().map(L=>L.lastName).sort().join())==='Bravo,Charlie,Delta',
     await p.evaluate(()=>filtered().map(L=>L.lastName).sort().join()));
  await p.evaluate(()=>toggleIntl());await p.waitForTimeout(300);
  ck('  ...and unclicking brings everyone back',
     await p.evaluate(()=>filtered().length)===5, await p.evaluate(()=>filtered().length));
  ck('by default they are simply out of the call order',
     await p.evaluate(()=>filtered().filter(L=>L.tier!=='X').map(L=>L.lastName).join())==='Alpha,Echo',
     await p.evaluate(()=>filtered().filter(L=>L.tier!=='X').map(L=>L.lastName).join()));

  // The invisible sign-in: accent-blue links on the EA-blue strip were
  // blue-on-blue. The strip's links must be the palette's ice, not the
  // page's accent.
  const linkColor=await p.evaluate(()=>{
    const a=document.querySelector('#authbar a');
    return a?getComputedStyle(a).color:'no links';});
  ck('auth-bar links are ice blue on the dark strip, not accent-on-navy',
     linkColor==='rgb(182, 211, 223)', linkColor);

  // One door. "I didnt realize that sign in/create account and sign in with
  // google were two different options" — they aren't, and the UI said they
  // were: three bar links reading as three systems. The bar now offers one
  // entry and the modal holds every route, with the fact that makes it safe
  // to pick any of them (same email, same account) said out loud.
  who={signed_in:false,providers:{google:true,microsoft:true},features:feat()};
  await p.goto('http://127.0.0.1:8099/',{waitUntil:'domcontentloaded'});
  await p.waitForFunction(()=>window.ME&&window.ME.signed_in===false);
  await p.waitForTimeout(200);
  const barLinks=await p.evaluate(()=>[...document.querySelectorAll('#authbar a')].map(a=>a.textContent.trim()));
  ck('signed out, the bar has ONE way in',
     barLinks.length===1&&/Sign in \/ create an account/.test(barLinks[0]), barLinks.join('|'));
  await p.evaluate(()=>openAuth());
  const modal=await p.evaluate(()=>({
    open:document.getElementById('mAuth').classList.contains('open'),
    title:document.getElementById('auTitle').textContent.trim(),
    hint:document.querySelector('#mAuth .hint').textContent.replace(/\s+/g,' ').trim(),
    prov:[...document.querySelectorAll('#auProv a')].map(a=>[a.textContent.trim(),a.getAttribute('href')]),
    or:getComputedStyle(document.getElementById('auOr')).display!=='none'}));
  ck('the modal is the door, and its title says both verbs',
     modal.open&&/Sign in or create an account/.test(modal.title), modal.title);
  ck('  ...it states the rule that makes any route safe: same address, same account',
     /same address lands in the same account/.test(modal.hint), modal.hint);
  ck('  ...Google and Microsoft are routes inside it',
     modal.prov.length===2&&modal.prov[0][1]==='/auth/google/login'
     &&modal.prov[1][1]==='/auth/login', JSON.stringify(modal.prov));
  ck('  ...labelled Continue with, not a second Sign in',
     modal.prov.every(x=>/^Continue with /.test(x[0])), JSON.stringify(modal.prov));
  ck('  ...and the divider offers email as the third route', modal.or===true);
  await p.evaluate(()=>{document.getElementById('mAuth').classList.remove('open');
    ME.providers={};openAuth();});
  const bare=await p.evaluate(()=>({prov:document.getElementById('auProv').innerHTML,
    or:getComputedStyle(document.getElementById('auOr')).display!=='none'}));
  ck('with no providers configured the divider vanishes with the buttons',
     bare.prov===''&&bare.or===false, JSON.stringify(bare));

  ck('no page errors', errs.length===0, errs.slice(0,2).join(' | '));
  console.log(fail?`\nFAILURES: ${fail} of ${n}`:`\nall ${n} checks passed`);
  await b.close();process.exit(fail?1:0);
})();
