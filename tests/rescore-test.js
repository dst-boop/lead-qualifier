const { chromium } = require('playwright');
const ME = { signed_in:true, provider:'google', name:'D', email:'d@f.com', providers:{google:true},
  features:{whitepages:true, ai_qc:false, server_state:false, drive:false}, storage:'memory' };
(async () => {
  const b = await chromium.launch({ executablePath:'/opt/pw-browsers/chromium' }).catch(()=>chromium.launch());
  const p = await b.newPage(); const errs=[]; p.on('pageerror',e=>errs.push(e.message));
  await p.route('**/api/me', r=>r.fulfill({json:ME}));
  // Enrichment returns a confirmed age of 61 and backfills a missing email.
  await p.route('**/api/enrich', r=>r.fulfill({json:{found:true,matched_by:'phone',match_score:95,
    owner:'Tom Brister',age:61,home_street:'5 Pine St',home_city:'Hoboken',home_state:'NJ',
    home_zip:'07030',mobiles:['(201) 555-9021'],phones_total:2,properties_owned:1,
    owns_home:true,owner_type:'individual',co_owners:[],emails:['tb@gmail.com']}}));
  await p.goto('http://127.0.0.1:8099/', {waitUntil:'networkidle'});
  const out = await p.evaluate(async () => {
    // Graduated 2012 and no email: fails the age signal and the contact signal.
    const L = { id:'L1', firstName:'Tom', lastName:'Brister', title:'VP Engineering',
      mgmtLevel:'VP Level Exec', employer:'Bluefin', state:'NJ', status:'New', notes:'', activity:[],
      gradYear:'2012', jobStartDate:'2025-01-01', yearsExperience:'30', yearsAtEmployer:'1',
      mobilePhone:'(201) 555-9021', email:'' };
    scoreLead(L); state.leads=[L];
    const before = { score:L.score, tier:L.tier, A:(L.signals.find(s=>s.k==='A')||{}).hit,
                     C:(L.signals.find(s=>s.k==='C')||{}).hit };
    await enrichHome('L1');
    const a = state.leads[0];
    const after = { score:a.score, tier:a.tier, age:(a.hd||{}).age, email:a.email,
                    A:(a.signals.find(s=>s.k==='A')||{}).hit, C:(a.signals.find(s=>s.k==='C')||{}).hit };
    // What the score SHOULD be once the new facts are taken into account
    scoreLead(a);
    return { before, after, ifRescored:{score:a.score, tier:a.tier,
             A:(a.signals.find(s=>s.k==='A')||{}).hit, C:(a.signals.find(s=>s.k==='C')||{}).hit} };
  });
  console.log('before enrich :', JSON.stringify(out.before));
  console.log('after enrich  :', JSON.stringify(out.after));
  console.log('if rescored   :', JSON.stringify(out.ifRescored));
  const bug = out.after.score !== out.ifRescored.score;
  console.log(bug ? `\nBUG: enrichment learned age ${out.after.age} and an email, but the score stayed ${out.after.score} — should be ${out.ifRescored.score} (${out.before.tier} -> ${out.ifRescored.tier})`
                  : '\nno discrepancy');
  if (errs.length) console.log('ERRORS: '+errs.join(' | '));
  await b.close();
})().catch(e=>{console.error(e.message);process.exit(1);});
