// "Integrate wealthfeed."
//
// WealthFeed has no public API and no Zapier app — its outbound paths are
// partner CRM syncs and CSV export. So the integration is an import lane:
// their export lands through the existing column mapper, the money-in-motion
// event becomes a first-class lead field, and the event text flows to the
// signals panel VERBATIM. No taxonomy mapping for a vendor's event names —
// this app has been wrong five times parsing schemas it had not seen, and an
// event we did not anticipate must surface as itself, not vanish.
const { chromium } = require('playwright');
const me=(o)=>({signed_in:true,provider:'google',name:'Dan',email:'dst@fpa.com',
  providers:{google:true,microsoft:true},
  features:{whitepages:true,ai_qc:false,server_state:true,drive:false,zoominfo:false,free_sources:true},
  storage:'firestore',encryption:'kms',...o});

(async()=>{
  const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium'}).catch(()=>chromium.launch());
  const p=await (await b.newContext({viewport:{width:1500,height:1000}})).newPage();
  const errs=[]; p.on('pageerror',e=>errs.push('PAGEERROR: '+(e.stack||e.message)));
  p.on('console',m=>{if(m.type()==='error')errs.push('CONSOLE: '+m.text());});
  let sigPayload=null;
  await p.route('**/api/me',r=>r.fulfill({json:me()}));
  await p.route('**/api/lists', r=>r.fulfill({json:{lists:[{id:'default',name:'My leads',count:0}],settings:{}}}));
  await p.route('**/api/lists/*', r=>r.request().method()==='GET'
    ? r.fulfill({json:{list:{id:'default',name:'My leads'},leads:[],settings:{}}})
    : r.fulfill({json:{ok:true,lists:[{id:'default',name:'My leads',count:0}]}}));
  await p.route('**/api/settings', r=>r.fulfill({json:{ok:true}}));
  await p.route('**/api/signals', r=>{sigPayload=r.request().postDataJSON();
    r.fulfill({json:{signals:[],coverage:{}}});});
  await p.goto('http://127.0.0.1:8099/',{waitUntil:'networkidle'});
  await p.waitForTimeout(500);

  let fail=0,n=0;
  const ck=(name,c,d)=>{n++;console.log((c?'ok   ':'FAIL ')+name+(d?'  '+d:''));if(!c)fail++;};
  const guess=h=>p.evaluate(hs=>{const g=guessColumns(hs);const o={};
    for(const k in g)o[k]=hs[g[k]];return o;},h);

  // --- WealthFeed-flavoured headers auto-map ---------------------------------
  let g=await guess(['First Name','Last Name','Money in Motion Event','Event Date',
                     'Estimated Net Worth','Household Income','Company','Mobile Phone']);
  ck('the event column maps', g.moneyEvent==='Money in Motion Event', g.moneyEvent);
  ck('  ...the date maps separately', g.moneyEventDate==='Event Date', g.moneyEventDate);
  ck('  ...net worth maps, as reported', g.netWorthEst==='Estimated Net Worth', g.netWorthEst);
  ck('  ...income maps', g.incomeEst==='Household Income', g.incomeEst);
  ck('  ...without disturbing the ordinary columns',
     g.firstName==='First Name'&&g.employer==='Company'&&g.mobilePhone==='Mobile Phone');
  // "Event Date" must not be eaten by the event field's looser aliases.
  g=await guess(['First Name','Last Name','Trigger Event','Trigger Date']);
  ck('trigger spellings map too', g.moneyEvent==='Trigger Event'&&g.moneyEventDate==='Trigger Date',
     JSON.stringify([g.moneyEvent,g.moneyEventDate]));
  g=await guess(['First Name','Last Name','Real Estate Holdings']);
  ck('"Real Estate Holdings" is not an event', g.moneyEvent===undefined, g.moneyEvent);
  // The derived-column embargo and its one deliberate door: a declared
  // estimate may land in a field labelled "as reported" — and only there.
  g=await guess(['First Name','Estimated Net Worth','Estimated Age','Est. Income']);
  ck('a declared-estimate column reaches the declared-estimate field',
     g.netWorthEst==='Estimated Net Worth'&&g.incomeEst==='Est. Income',
     JSON.stringify([g.netWorthEst,g.incomeEst]));
  ck('  ...while "Estimated Age" stays embargoed from every fact field',
     !Object.values(g).includes('Estimated Age'), JSON.stringify(g));

  // --- import carries the fields, verbatim -----------------------------------
  await p.evaluate(()=>{
    const rows=[['First Name','Last Name','Mobile Phone','Money in Motion Event','Event Date','Estimated Net Worth'],
      ['Karen','Voss','(206) 555-0101','Sold business to PE firm','2026-08-01','$4,200,000'],
      ['Leo','Marsh','(206) 555-0102','IPO Lockup Expiry Window Alpha-7','',''],
      ['Ana','Quist','(206) 555-0103','','','']];
    const map=guessColumns(rows[0]);
    importRows(rows.slice(1),map,'WealthFeed export Aug 2026');
    save();render();
  });
  await p.waitForTimeout(400);
  const leads=await p.evaluate(()=>state.leads.map(L=>({n:L.lastName,ev:L.moneyEvent||'',
    d:L.moneyEventDate||'',nw:L.netWorthEst||'',chip:!!document.querySelector('#rows .badge.mim')})));
  const by=Object.fromEntries(leads.map(l=>[l.n,l]));
  ck('the event lands on the lead, verbatim', by.Voss.ev==='Sold business to PE firm', by.Voss.ev);
  ck('  ...with its date', by.Voss.d==='2026-08-01');
  ck('  ...and the reported net worth', by.Voss.nw==='$4,200,000', by.Voss.nw);
  ck('an event name from no known taxonomy survives untouched',
     by.Marsh.ev==='IPO Lockup Expiry Window Alpha-7', by.Marsh.ev);
  ck('a lead without an event gets nothing invented', by.Quist.ev===''&&by.Quist.d==='');

  // --- the chip ---------------------------------------------------------------
  const chip=await p.evaluate(()=>{
    const tr=[...document.querySelectorAll('#rows tr.lead')].find(t=>t.textContent.includes('Voss'));
    const c=tr&&tr.querySelector('.badge.mim');
    return c?{text:c.textContent,title:c.title}:null;});
  ck('the row is chipped', !!chip, chip);
  ck('  ...short on the row, whole in the tooltip',
     chip&&chip.text.length<20&&chip.title.includes('Sold business to PE firm'), chip&&chip.text);
  ck('  ...saying where it came from and what to do',
     chip&&/imported from/.test(chip.title)&&/Verify on the call/.test(chip.title));
  ck('a lead without an event has no chip', await p.evaluate(()=>{
    const tr=[...document.querySelectorAll('#rows tr.lead')].find(t=>t.textContent.includes('Quist'));
    return !tr.querySelector('.badge.mim');}));

  // --- the fields reach the signals check -------------------------------------
  await p.evaluate(()=>loadSignals(false));
  await p.waitForTimeout(400);
  ck('the signals payload carries the event fields',
     sigPayload&&sigPayload.leads.some(L=>L.moneyEvent==='Sold business to PE firm'
       &&L.moneyEventDate==='2026-08-01'),
     sigPayload&&JSON.stringify(sigPayload.leads[0]).slice(0,80));

  ck('no page errors', errs.length===0, errs.slice(0,2).join(' | '));
  console.log(fail?`\nFAILURES: ${fail} of ${n}`:`\nall ${n} checks passed`);
  await b.close();process.exit(fail?1:0);
})();
