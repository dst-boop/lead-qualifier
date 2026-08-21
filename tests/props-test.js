const { chromium } = require('playwright');
const ME={signed_in:true,provider:'google',name:'D',email:'d@f.com',providers:{google:true},
  features:{whitepages:true,ai_qc:false,server_state:false,drive:false},storage:'memory'};
(async () => {
  const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium'}).catch(()=>chromium.launch());
  const p=await b.newPage({viewport:{width:1300,height:1000}}); const errs=[];
  p.on('pageerror',e=>errs.push(e.message));
  await p.route('**/api/me',r=>r.fulfill({json:ME}));
  await p.route('**/api/enrich',r=>r.fulfill({json:{found:true,matched_by:'phone',match_score:94,
    owner:'Margaret Holloway',age:63,home_street:'9 Elm Ave',home_city:'Montclair',home_state:'NJ',
    home_zip:'07042',mobiles:['(973) 555-0142'],phones_total:5,properties_owned:3,owns_home:true,
    owner_type:'trust',co_owners:['Holloway Family Trust'],emails:['mh@gmail.com'],linkedin_url:'',
    properties:['9 Elm Ave, Montclair, NJ 07042','118 Ocean Dr, Avalon, NJ 08202','4 Sussex Ct, Vail, CO 81657'],
    prior_places:['Hoboken, NJ','Brooklyn, NY'],
    relatives:['Robert Holloway','Ellen Holloway']}}));
  await p.goto('http://127.0.0.1:8099/',{waitUntil:'networkidle'});
  await p.evaluate(()=>{ state.leads=[{id:'L1',firstName:'Margaret',lastName:'Holloway',
    title:'VP Operations',mgmtLevel:'VP Level Exec',employer:'Meridian',state:'NJ',status:'New',
    notes:'',activity:[],gradYear:'1986',jobStartDate:'2025-03-01',yearsExperience:'34',
    yearsAtEmployer:'1',email:'m@x.com',mobilePhone:'(973) 555-0142',street:'',city:'',zip:''}];
    state.leads.forEach(scoreLead); render(); });
  const btn=await p.$('button[title^="WhitePages: home"]');
  await btn.click(); await p.waitForTimeout(900);
  await p.click('button:has-text("More")'); await p.waitForTimeout(600);
  const out=await p.evaluate(()=>({
    props:propertyList(state.leads[0]).map(x=>x.label+': '+x.addr),
    links:document.querySelectorAll('tr.detail a[href*="zillow"]').length,
    rel:/Robert Holloway/.test(document.querySelector('tr.detail').textContent),
    prior:/Hoboken, NJ/.test(document.querySelector('tr.detail').textContent),
    score:state.leads[0].score, tier:state.leads[0].tier }));
  out.props.forEach(s=>console.log('  '+s));
  console.log('zillow links :', out.links, '(one per address, home deduped)');
  console.log('relatives    :', out.rel, '| prior places:', out.prior);
  console.log('rescored     :', out.tier+'·'+out.score);
  await p.screenshot({path:'p1-properties.png', fullPage:true});
  console.log(errs.length?'ERRORS: '+errs.join(' | '):'no page errors');
  await b.close();
})().catch(e=>{console.error(e.message);process.exit(1);});
