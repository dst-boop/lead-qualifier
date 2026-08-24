// The signals surface.
//
// This is a watchlist, and the way a watchlist fails is by crying wolf: if it
// shows the same events every morning with no way to tell what changed, it
// stops being read by the second week. So what matters here is that "new" is
// visible, that marking seen sticks, and that an unconfirmed signal is never
// dressed up as a confirmed one.
const { chromium } = require('playwright');

const feat=o=>({whitepages:false,ai_qc:false,server_state:true,drive:false,zoominfo:false,
                edgar:true,zi_mcp:false,opportunities:true,...o});
const me=o=>({signed_in:true,provider:'google',name:'Dan',email:'dan@fpa.com',
              providers:{google:true},features:feat(),storage:'firestore',encryption:'kms',...o});

const SIGNALS=[
  {id:'s1',lead_id:'a',kind:'warn',urgency:0,days:38,confirmed:true,new:true,
   name:'Elena Basilio',employer:'Cordova Industrial Group',tier:'B',
   headline:'Cordova Industrial Group filed a WARN notice — 412 people',
   detail:'Effective 2026-09-30, Montclair, NJ. Plan average 87,692 per head.',
   source:'state WARN notice'},
  {id:'s2',lead_id:'b',kind:'filing',urgency:0,days:2,confirmed:true,new:true,
   name:'Marcus Armstrong',employer:'Boeing',tier:'A',
   headline:'Named in an 8-K officer departure at Boeing',
   detail:'Item 5.02 — Marcus Armstrong to retire effective 31 December',
   source:'https://www.sec.gov/Archives/edgar/data/12927/x.htm'},
  {id:'s3',lead_id:'c',kind:'age',urgency:2,days:37,confirmed:false,new:false,
   name:'Jean Okafor',employer:'IBM',tier:'C',
   headline:'Turns 59½ in about 37 days',
   detail:'Age 59 (started 1988 + 22) — inferred, worth confirming',
   source:'age on file'}];

(async()=>{
  const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium'}).catch(()=>chromium.launch());
  const p=await b.newPage({viewport:{width:1500,height:1000}});
  const errs=[];p.on('pageerror',e=>errs.push(e.message));
  p.on('console',m=>{if(m.type()==='error')errs.push('CONSOLE: '+m.text());});

  let payload={signals:SIGNALS,new:2,checked:3,notes:[]};
  const posted=[],mails=[];
  await p.route('**/api/me',r=>r.fulfill({json:me()}));
  await p.route('**/api/settings',r=>r.fulfill({json:{ok:true}}));
  await p.route('**/api/lists',r=>r.fulfill({json:{lists:[{id:'default',name:'My leads',count:3,role:'owner',owner:''}],settings:{}}}));
  await p.route('**/api/signals',async r=>{posted.push(JSON.parse(r.request().postData()));
    return r.fulfill({json:payload});});
  await p.route('**/api/send-email',async r=>{mails.push(JSON.parse(r.request().postData()));
    return r.fulfill({json:{ok:true}});});
  await p.route('**/api/lists/*',r=>r.request().method()==='GET'
    ? r.fulfill({json:{list:{id:'default',name:'My leads'},settings:{},leads:[
        {id:'a',firstName:'Elena',lastName:'Basilio',title:'Program Manager',employer:'Cordova Industrial Group',
         mobilePhone:'(973) 555-0142',email:'e@c.com',status:'New',activity:[]},
        {id:'b',firstName:'Marcus',lastName:'Armstrong',title:'Chief Operating Officer',employer:'Boeing',
         mobilePhone:'(206) 555-0140',email:'m@b.com',status:'New',activity:[]},
        {id:'c',firstName:'Jean',lastName:'Okafor',title:'Senior Manager',employer:'IBM',
         mobilePhone:'(914) 555-0122',email:'j@i.com',status:'New',activity:[]}]}})
    : r.fulfill({json:{ok:true,lists:[]}}));

  let fail=0,n=0;
  const ck=(name,c,d)=>{n++;console.log((c?'ok   ':'FAIL ')+name+(d?'  '+d:''));if(!c)fail++;};
  const txt=s=>p.textContent(s).then(t=>t.trim().replace(/\s+/g,' '));

  await p.goto('http://127.0.0.1:8099/',{waitUntil:'domcontentloaded'});
  await p.evaluate(()=>localStorage.clear());
  await p.goto('http://127.0.0.1:8099/',{waitUntil:'domcontentloaded'});
  await p.waitForFunction(()=>window.ME&&window.ME.signed_in&&typeof renderPipeline==='function',
                          null,{timeout:15000});
  await p.waitForTimeout(700);

  await p.click('#btnSignals');await p.waitForTimeout(700);
  ck('it posts the open list, not a lead at a time',
     posted.length===1&&posted[0].leads.length===3, JSON.stringify((posted[0]||{}).leads||[]).slice(0,40));
  ck('  ...and carries the tenure setting', posted[0].min_tenure===18, posted[0].min_tenure);
  ck('  ...without marking anything seen', posted[0].mark_seen===false);

  const meta=await txt('#sigMeta');
  ck('the count is stated', /3 events across 3 leads/.test(meta), meta);
  ck('  ...and how many are new', /2 new since you last looked/.test(meta), meta);

  const rows=await p.$$eval('#sigRows .sigrow',e=>e.map(x=>x.textContent.replace(/\s+/g,' ').trim()));
  ck('one row per event', rows.length===3, String(rows.length));
  ck('the WARN event leads', /Elena Basilio/.test(rows[0])&&/412 people/.test(rows[0]), rows[0].slice(0,70));
  ck('  ...marked NEW', /NEW/.test(rows[0]), rows[0].slice(0,50));
  ck('the named 8-K says so', /Named in an 8-K/.test(rows[1]), rows[1].slice(0,70));
  ck('  ...and links the filing itself',
     await p.evaluate(()=>{const a=document.querySelector('#sigRows a');return a&&a.href;})
       ==='https://www.sec.gov/Archives/edgar/data/12927/x.htm');
  ck('an inferred age is badged unconfirmed', /unconfirmed/.test(rows[2]), rows[2].slice(0,60));
  ck('  ...and says what it was inferred from', /started 1988 \+ 22/.test(rows[2]), rows[2]);
  ck('  ...and is not marked NEW', !/NEW/.test(rows[2]), rows[2].slice(0,60));

  // --- acting on one ------------------------------------------------------------
  await p.click('#sigRows .sigrow:nth-child(1) .abtn');await p.waitForTimeout(700);
  ck('Open closes the panel and finds the lead',
     await p.evaluate(()=>document.getElementById('mSignals').classList.contains('open'))===false);
  ck('  ...by searching for them',
     await p.evaluate(()=>document.getElementById('q').value)==='Elena Basilio',
     await p.evaluate(()=>document.getElementById('q').value));
  ck('  ...leaving exactly that lead on screen',
     await p.evaluate(()=>filtered().map(L=>L.lastName).join())==='Basilio');

  await p.evaluate(()=>{document.getElementById('q').value='';render();});
  await p.click('#btnSignals');await p.waitForTimeout(600);
  await p.click('#sigRows .sigrow:nth-child(1) .abtn:nth-child(2)');await p.waitForTimeout(400);
  ck('the clock button opens a callback for that lead',
     /Elena Basilio/.test(await txt('#cbWho')), await txt('#cbWho'));
  await p.evaluate(()=>{closeModal('mCallback');});await p.waitForTimeout(200);

  // --- marking seen ---------------------------------------------------------------
  payload={signals:SIGNALS.map(s=>({...s,new:false})),new:0,checked:3,notes:[]};
  await p.click('#sigMark');await p.waitForTimeout(700);
  ck('marking seen asks the server to record it', posted[posted.length-1].mark_seen===true);
  ck('  ...and the panel stops shouting', /nothing new/.test(await txt('#sigMeta')), await txt('#sigMeta'));
  ck('  ...while still listing the events', (await p.$$('#sigRows .sigrow')).length===3);

  // --- emailing it to yourself ------------------------------------------------------
  await p.click('#sigMail');await p.waitForTimeout(600);
  ck('the digest goes to your own address', mails.length===1&&mails[0].to==='dan@fpa.com',
     JSON.stringify(mails[0]||{}).slice(0,60));
  ck('  ...naming every event', /Elena Basilio/.test(mails[0].body)&&/Marcus Armstrong/.test(mails[0].body));
  ck('  ...with the sources', /sec\.gov/.test(mails[0].body)&&/WARN notice/.test(mails[0].body));
  ck('  ...and how many leads were checked', /Checked 3 leads/.test(mails[0].body), mails[0].body.slice(-90));

  // --- degrading -----------------------------------------------------------------
  payload={signals:[],new:0,checked:3,notes:['WARN feeds unavailable: TimeoutError']};
  await p.evaluate(()=>loadSignals(false));await p.waitForTimeout(700);
  // This used to assert "Nothing moving. Every lead was checked against the
  // WARN feeds, the SEC filing index and their own age" — printed
  // unconditionally, including on a deployment where none of the three had
  // run. Zero events is good news only for the checks that actually happened.
  ck('an empty result does not claim checks that did not run',
     !/Every lead was checked/.test(await txt('#sigRows')), await txt('#sigRows'));
  ck('  ...it names what was skipped instead',
     /Not checked:/.test(await txt('#sigRows')), await txt('#sigRows'));
  ck('  ...and says why that matters',
     /only good news for the checks that ran/.test(await txt('#sigRows')));
  ck('  ...and a missing source is named, not hidden',
     /WARN feeds unavailable/.test(await txt('#sigMeta')), await txt('#sigMeta'));

  // With everything configured and every age known, it may say so plainly.
  payload={signals:[],new:0,checked:3,notes:[],
           coverage:{leads:3,with_age:3,with_birth_date:2,warn:true,warn_events:12,
                     filings:true,employers_checked:2}};
  await p.evaluate(()=>loadSignals(false));await p.waitForTimeout(700);
  const quiet=await txt('#sigRows');
  ck('a genuinely complete check reports a real all-clear',
     /Checked:/.test(quiet)&&!/Not checked/.test(quiet), quiet);
  ck('  ...naming the sources that ran',
     /mass-separation notices/.test(quiet)&&/officer-departure filings/.test(quiet), quiet);
  ck('  ...and that every age was available', /every age/.test(quiet), quiet);
  // A birth date is a month; an age is a twelve-month band. Say which.
  ck('  ...and how many 59½ dates are exact rather than estimated',
     /2 leads have birth dates/.test(quiet), quiet);

  payload={signals:[],new:0,checked:3,notes:[],
           coverage:{leads:3,with_age:3,with_birth_date:0,warn:true,warn_events:1,
                     filings:true,employers_checked:1}};
  await p.evaluate(()=>loadSignals(false));await p.waitForTimeout(700);
  ck('with no birth dates at all it says the 59½ dates are bands',
     /band rather than a month/.test(await txt('#sigRows')), await txt('#sigRows'));

  ck('no page errors', errs.length===0, errs.slice(0,2).join(' | '));
  console.log(fail?`\nFAILURES: ${fail} of ${n}`:`\nall ${n} checks passed`);
  await b.close();process.exit(fail?1:0);
})();
