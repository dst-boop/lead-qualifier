const { chromium } = require('playwright');
const ME = { signed_in:true, provider:'google', name:'D', email:'d@f.com',
  providers:{google:true}, features:{whitepages:true, ai_qc:false, server_state:false}, storage:'memory' };

async function run(name, verifyJson, expect) {
  const b = await chromium.launch({ executablePath:'/opt/pw-browsers/chromium' }).catch(()=>chromium.launch());
  const p = await b.newPage(); const errs=[]; p.on('pageerror',e=>errs.push(e.message));
  await p.route('**/api/me', r=>r.fulfill({json:ME}));
  await p.route('**/api/verify-phone', r=>r.fulfill({json:verifyJson}));
  await p.goto('http://127.0.0.1:8099/', {waitUntil:'networkidle'});
  const out = await p.evaluate(async () => {
    const L = { id:'L1', firstName:'Margaret', lastName:'Holloway', title:'VP', employer:'X',
      state:'NY', status:'New', notes:'', activity:[], mobilePhone:'(631) 312-1293',
      street:'8 Magnet St', city:'Stony Brook', zip:'11790' };
    state.leads=[L]; await verifyLead('L1');
    const l = state.leads[0];
    return { label:(l.pv||{}).label||'', wrong:!!(l.pv||{}).wrong,
             household:(l.pv||{}).household ? l.pv.household.name : null,
             leadsAfter:state.leads.length, addr:homeAddr(l) };
  });
  const ok = out.wrong===expect.wrong && (out.household||null)===(expect.household||null);
  console.log(`${ok?'ok  ':'FAIL'}  ${name.padEnd(28)} wrong=${out.wrong} household=${out.household} | "${out.label}"`);
  if (errs.length) console.log('   ERRORS: '+errs.join(' | '));
  // exercise the spouse capture
  if (out.household) {
    const added = await p.evaluate(() => { addHousehold('L1');
      const n = state.leads[1]; return { n:state.leads.length, name:(n.firstName+' '+n.lastName).trim(),
        score:n.score, tier:n.tier, phone:n.mobilePhone }; });
    console.log(`      spouse added -> ${added.name} · ${added.phone} · ${added.tier}·${added.score} (total ${added.n})`);
  }
  if (name.startsWith('1')) console.log(`      deep-link address: ${out.addr}`);
  await b.close();
  return ok;
}
(async () => {
  let bad = 0;
  bad += !await run('1. owner matches lead', { valid:true, line_type:'mobile', owner:'Margaret Holloway',
    name_match:true, same_household:true, owner_city:'Stony Brook', owner_state:'NY' }, { wrong:false });
  bad += !await run('2. spouse, same address', { valid:true, line_type:'mobile', owner:'Robert Holloway Sr',
    name_match:false, same_household:true, owner_street:'8 Magnet St', owner_city:'Stony Brook',
    owner_state:'NY', owner_zip:'11790' }, { wrong:false, household:'Robert Holloway Sr' });
  bad += !await run('3. stranger, elsewhere', { valid:true, line_type:'mobile', owner:'Aaron N Skeim',
    name_match:false, same_household:false, owner_city:'Seattle', owner_state:'WA' }, { wrong:true });
  bad += !await run('4. no record', { valid:null, line_type:'', owner:'', name_match:null,
    same_household:null }, { wrong:false });
  console.log(bad ? `${bad} FAILING` : '\nall flows pass');
  // Without an exit code a counted failure prints and still reports success.
  process.exit(bad ? 1 : 0);
})().catch(e=>{console.error(e.message);process.exit(1);});
