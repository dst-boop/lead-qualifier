// Auto-map has to survive files nobody designed for this app: odd punctuation,
// a single name column, decoy headers, and columns it should leave alone.
const { chromium } = require('playwright');
const me=(o)=>({signed_in:true,provider:'google',name:'Dan',email:'dst@fpa.com',
  providers:{google:true,microsoft:true},
  features:{whitepages:true,ai_qc:true,server_state:true,drive:true,zoominfo:false},
  storage:'firestore',encryption:'kms',...o});

(async()=>{
  const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium'}).catch(()=>chromium.launch());
  const p=await (await b.newContext()).newPage({viewport:{width:1400,height:1000}});
  const errs=[]; p.on('pageerror',e=>errs.push('PAGEERROR: '+(e.stack||e.message)));
  p.on('console',m=>{if(m.type()==='error')errs.push('CONSOLE: '+m.text());});
  await p.route('**/api/me',r=>r.fulfill({json:me()}));
  await p.route('**/api/state',r=>r.fulfill({json:{found:false,settings:{},leads:[]}}));
  await p.goto('http://127.0.0.1:8099/',{waitUntil:'networkidle'});
  await p.waitForTimeout(500);

  let fail=0,n=0;
  const ck=(name,c,d)=>{n++;console.log((c?'ok   ':'FAIL ')+name+(d?'  '+d:''));if(!c)fail++;};
  const guess=h=>p.evaluate(hs=>{const g=guessColumns(hs);const o={};
    for(const k in g)o[k]=hs[g[k]];return o;},h);

  // --- punctuation and case: one alias must cover every exporter's spelling ---
  let g=await guess(['First_Name','LAST-NAME','e-mail address','Mobile.Phone','Job Title']);
  ck('underscores map', g.firstName==='First_Name', g.firstName);
  ck('hyphens + caps map', g.lastName==='LAST-NAME', g.lastName);
  ck('punctuated email maps', g.email==='e-mail address', g.email);
  ck('dotted mobile maps', g.mobilePhone==='Mobile.Phone', g.mobilePhone);

  // --- a BOM in cell A1 is what Excel actually writes -----------------------
  g=await guess(['﻿First Name','Last Name']);
  ck('BOM does not break the first column', g.firstName==='﻿First Name', JSON.stringify(g.firstName));

  // --- the word-boundary bug: "state" inside "Real Estate" -----------------
  g=await guess(['First Name','Real Estate Holdings','Person State']);
  ck('"Real Estate" is not read as State', g.state==='Person State', g.state);
  g=await guess(['First Name','Real Estate Holdings']);
  ck('...and with no real state column, State stays unmapped', g.state===undefined, g.state);

  // --- the regression the old comment records: email vs street -------------
  g=await guess(['Email Address','Person Street','First Name']);
  ck('email does not land in Street', g.street==='Person Street'&&g.email==='Email Address',
     JSON.stringify({street:g.street,email:g.email}));

  // --- one name column ------------------------------------------------------
  g=await guess(['Name','Company Name','Title','Email']);
  ck('single Name column is caught', g.fullName==='Name', g.fullName);
  ck('...and Company Name still goes to employer', g.employer==='Company Name', g.employer);
  ck('...without stealing first/last', g.firstName===undefined&&g.lastName===undefined, JSON.stringify([g.firstName,g.lastName]));
  g=await guess(['First Name','Last Name','Account Name']);
  ck('with real first/last, Full Name stays out of it', g.fullName===undefined, g.fullName);

  // --- name splitting -------------------------------------------------------
  const sp=await p.evaluate(()=>({
    plain:splitName('John Smith'), comma:splitName('Smith, John'),
    mid:splitName('Mary Anne Van Der Berg'), suffix:splitName('Robert Downey Jr.'),
    creds:splitName('Ellen Whitfield CFP'), one:splitName('Cher'), blank:splitName('  ')}));
  ck('"John Smith"', JSON.stringify(sp.plain)==='["John","Smith"]', JSON.stringify(sp.plain));
  ck('"Smith, John"', JSON.stringify(sp.comma)==='["John","Smith"]', JSON.stringify(sp.comma));
  ck('multi-word surname keeps the middle names in first',
     JSON.stringify(sp.mid)==='["Mary Anne Van Der","Berg"]', JSON.stringify(sp.mid));
  ck('"Jr." is not the surname', JSON.stringify(sp.suffix)==='["Robert","Downey Jr."]', JSON.stringify(sp.suffix));
  ck('"CFP" is not the surname', JSON.stringify(sp.creds)==='["Ellen","Whitfield CFP"]', JSON.stringify(sp.creds));
  ck('one word is a surname', JSON.stringify(sp.one)==='["","Cher"]', JSON.stringify(sp.one));
  ck('blank is blank', JSON.stringify(sp.blank)==='["",""]', JSON.stringify(sp.blank));

  // --- the mapper actually shows its work ----------------------------------
  const csv=(rows)=>rows.map(r=>r.join(',')).join('\n');
  const load=async(text)=>{
    await p.evaluate(t=>{
      const dt=new DataTransfer();
      dt.items.add(new File([t],'quarterly-list.csv',{type:'text/csv'}));
      const el=document.getElementById('csvFile');
      el.files=dt.files; el.dispatchEvent(new Event('change'));
    },text);
    await p.waitForTimeout(400);
  };
  await load(csv([
    ['First_Name','LAST-NAME','Job Title','Mobile Phone','Email','Person State','Favourite Colour','Internal Ref'],
    ['Ellen','Whitfield','Managing Partner','(973) 555-0148','e@x.com','NJ','blue','X1']]));
  ck('mapper opens', await p.isVisible('#mImport'));
  const sum=await p.textContent('#mapSummary');
  ck('summary counts what was mapped', /\b6 of \d+ fields mapped from 8 columns/.test(sum), JSON.stringify(sum.slice(0,70)));
  ck('summary names the ignored columns', /Favourite Colour/.test(sum)&&/Internal Ref/.test(sum), '');
  const badges=await p.evaluate(()=>{
    const o={auto:0,none:0,manual:0};
    document.querySelectorAll('#mapRows .badge').forEach(b=>{
      o[b.classList.contains('auto')?'auto':b.classList.contains('manual')?'manual':'none']++;});
    return o;});
  ck('every matched field is badged "auto"', badges.auto===6, JSON.stringify(badges));
  ck('unmatched fields say "not found"', badges.none===await p.evaluate(()=>FIELDS.length-6), JSON.stringify(badges));

  // changing a dropdown by hand must be distinguishable from a guess
  await p.selectOption('#mapRows select[data-key="city"]','6');
  const after=await p.evaluate(()=>document.querySelector('#mapRows tr[data-row="city"] .badge').className);
  ck('a hand edit is badged "you set"', /manual/.test(after), after);
  ck('...and the count goes up', /\b7 of \d+ fields mapped/.test(await p.textContent('#mapSummary')), '');

  await p.click('#btnRemap'); await p.waitForTimeout(200);
  ck('Auto-map again restores the guess',
     await p.evaluate(()=>document.querySelector('#mapRows select[data-key="city"]').value)==='-1', '');
  await p.click('#btnClearMap'); await p.waitForTimeout(200);
  ck('Clear all empties every row', /\b0 of \d+ fields mapped/.test(await p.textContent('#mapSummary')), '');
  ck('...and warns what is now missing', /Missing:/.test(await p.textContent('#mapSummary')), '');

  // --- a file with no mobile column is called out BEFORE importing ---------
  await p.click('#mImport .mbtn[onclick*="mImport"]'); await p.waitForTimeout(200);
  await load(csv([['Full Name','Job Title','Email Address'],['Ray Okonjo','SVP','r@x.com']]));
  const s2=await p.textContent('#mapSummary');
  ck('no-mobile file is flagged up front', /Missing:.*Mobile Phone/.test(s2), JSON.stringify(s2.slice(0,150)));
  ck('...explaining the consequence', /land in Excluded/.test(s2), '');
  ck('...and the split is announced', /split into first and last/.test(s2), '');
  ck('name row is not flagged missing when Full Name covers it',
     !(await p.evaluate(()=>document.querySelector('#mapRows tr[data-row="firstName"]').classList.contains('miss'))), '');

  // --- import really does split ---------------------------------------------
  await p.click('#btnDoImport'); await p.waitForTimeout(600);
  const lead=await p.evaluate(()=>state.leads[0]);
  ck('imported one lead', await p.evaluate(()=>state.leads.length)===1);
  ck('  ...first name split out', lead.firstName==='Ray', lead.firstName);
  ck('  ...last name split out', lead.lastName==='Okonjo', lead.lastName);
  ck('  ...fullName is not left on the lead', lead.fullName===undefined, JSON.stringify(lead.fullName));
  ck('  ...and it scored', typeof lead.score==='number', lead.score+'/'+lead.tier);

  // --- the template ---------------------------------------------------------
  await p.click('#btnTemplate'); await p.waitForTimeout(300);
  ck('template modal opens from the toolbar', await p.isVisible('#mTemplate'));
  const trows=await p.evaluate(()=>document.querySelectorAll('#tmplRows tr').length);
  ck('template lists its columns', trows>=15, 'rows='+trows);
  const tcsv=await p.evaluate(()=>templateCSV());
  // Parse it with the app's own reader — one example value contains a comma, so
  // a naive split counts a phantom column and the check lies.
  const tp=await p.evaluate(t=>parseCSV(t),tcsv);
  ck('template CSV has header + 2 examples', tp.length===3, 'lines='+tp.length);
  ck('  ...columns line up with the header',
     tp.every(r=>r.length===tp[0].length), tp.map(r=>r.length).join('/'));
  ck('  ...a comma inside a value survives the round trip',
     tp[1].some(v=>v.includes(',')), JSON.stringify(tp[1].find(v=>v.includes(','))));
  ck('  ...header names are ones the app knows', tp[0].includes('First Name')&&tp[0].includes('Mobile Phone'), '');

  // the real test of a template: feed it back in and everything must map
  const rt=await p.evaluate(t=>{
    const hs=t.trim().split('\r\n')[0].split(',');
    const g=guessColumns(hs);
    return {cols:hs.length,mapped:Object.keys(g).length,
      missing:hs.filter((h,i)=>!Object.values(g).includes(i))};
  },tcsv);
  ck('every template column round-trips through the auto-map',
     rt.missing.length===0&&rt.mapped===rt.cols, JSON.stringify(rt));
  // The "also recognised" list is a promise to the user; check it is true.
  const extra=await p.evaluate(()=>{
    const g=guessColumns(TEMPLATE_EXTRA);
    const hit=new Set(Object.values(g));
    return TEMPLATE_EXTRA.filter((h,i)=>!hit.has(i));
  });
  ck('every "also recognised" column really is recognised', extra.length===0, JSON.stringify(extra));
  // And the template's own example row must import into a scoreable lead.
  const roundTrip=await p.evaluate(t=>{
    const rows=parseCSV(t), g=guessColumns(rows[0]), L={};
    FIELDS.forEach(([k])=>{const i=g[k];L[k]=(i>-1&&i!==undefined&&rows[1][i]!==undefined)?rows[1][i].trim():'';});
    scoreLead(L);
    return {tier:L.tier,score:L.score,name:L.firstName+' '+L.lastName,mobile:!!L.mobilePhone};
  },tcsv);
  ck('the example row scores as a real lead', roundTrip.mobile&&roundTrip.score>0,
     JSON.stringify(roundTrip));
  ck('  ...and lands in a callable tier', ['A','B','C'].includes(roundTrip.tier), roundTrip.tier);

  ck('no page errors', errs.length===0, errs.slice(0,2).join(' | '));
  console.log(fail?`\nFAILURES: ${fail} of ${n}`:`\nall ${n} checks passed`);
  await b.close(); process.exit(fail?1:0);
})();
