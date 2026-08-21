const { chromium } = require('playwright');
const TITLES = [
  ['Senior Director, Information Technology & Chief Information Security Officer', true,  'real dual seat (from your list)'],
  ['Partner & Board Member',                     true,  'partner plus a board seat'],
  ['Chief Financial Officer and Board of Directors', true, '"and" separator'],
  ['Managing Director / Founder',                true,  'slash separator'],
  ['President & CEO',                            false, 'one seat, two names'],
  ['Chairman and CEO',                           false, 'one seat, two names'],
  ['VP Sales and Marketing',                     false, 'one role, two functions'],
  ['Chief Financial Officer',                    false, 'single title'],
  ['Senior Software Engineer',                   false, 'not senior at all'],
  ['Deputy Chief Pilot - Production',            false, 'hyphen is not a separator'],
];
(async () => {
  const b = await chromium.launch({ executablePath:'/opt/pw-browsers/chromium' }).catch(()=>chromium.launch());
  const p = await b.newPage(); const errs=[]; p.on('pageerror',e=>errs.push(e.message));
  await p.route('**/api/me', r=>r.fulfill({json:{signed_in:false,providers:{},features:{}}}));
  await p.goto('http://127.0.0.1:8099/', {waitUntil:'networkidle'});

  const res = await p.evaluate(t => t.map(([title,want,why]) => ({title,want,why,got:!!dualTitle(title),roles:dualTitle(title)})), TITLES);
  let bad=0;
  console.log('--- concurrent role from title ---');
  for (const r of res) { const ok=r.got===r.want; if(!ok)bad++;
    console.log(`${ok?'ok  ':'FAIL'}  ${r.want?'YES':'no '}  ${r.title.slice(0,55).padEnd(56)} ${r.roles||''}`); }

  console.log('\n--- manual override still wins ---');
  const ov = await p.evaluate(() => ({
    boxOn:  hasConcurrentRole({title:'Chief Financial Officer', concurrentRole:true}),
    boxOff: hasConcurrentRole({title:'Partner & Board Member', concurrentRole:false}),
    column: hasConcurrentRole({title:'Chief Financial Officer', concurrentRoles:'Board member, Acme (Present)'}),
  }));
  console.log('  box on over single title :', ov.boxOn, '(want true)');
  console.log('  box off over dual title  :', ov.boxOff, '(want false)');
  console.log('  mapped column            :', ov.column, '(want true)');
  bad += (ov.boxOn!==true)+(ov.boxOff!==false)+(ov.column!==true);

  console.log('\n--- tie-break within equal scores ---');
  const order = await p.evaluate(() => {
    const mk = (last, extra) => Object.assign({ id:last, firstName:'A', lastName:last, title:'VP Ops',
      mgmtLevel:'VP Level Exec', employer:'X', state:'NY', status:'New', notes:'', activity:[],
      gradYear:'1985', jobStartDate:'2025-01-01', yearsExperience:'34', yearsAtEmployer:'1',
      email:'a@b.com', mobilePhone:'555-0000' }, extra);
    state.leads = [
      mk('Plain', {}),
      mk('Enriched', { hd:{age:63} }),
      mk('Verified', { pv:{ok:true,label:'mobile'} }),
      mk('WrongNum', { pv:{wrong:true,label:'mobile'} }),
      mk('Stale',    { jobStartDate:'2021-06-01' }),
    ];
    state.leads.forEach(scoreLead);
    document.getElementById('fSort').value='score';
    return filtered().map(l=>`${l.lastName}(${l.score})`).join(' > ');
  });
  console.log(' ', order);

  console.log(errs.length ? '\nERRORS: '+errs.join(' | ') : (bad?`\n${bad} FAILING`:'\nall pass'));
  await b.close();
  // Without an exit code a counted failure prints and still reports success.
  process.exit(bad || errs.length ? 1 : 0);
})().catch(e=>{console.error(e.message);process.exit(1);});
