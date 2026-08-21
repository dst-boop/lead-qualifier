const { chromium } = require('playwright');

const BASE = { id:'t', status:'New', notes:'', activity:[], state:'NY',
  title:'Chief Financial Officer', employer:'X', email:'work@corp.com',
  mobilePhone:'555-1111', jobStartDate:'2025-01-01', yearsAtEmployer:'1' };

const SCORE_CASES = [
  { n:'R: recent + concurrent role',  L:{ gradYear:'1985', concurrentRoles:'Board member, Acme (Present)' }, want:'ARTEC' },
  { n:'R: recent, no second role',    L:{ gradYear:'1985' },                                                 want:'ATEC'  },
  { n:'R: concurrent but 6yr tenure', L:{ gradYear:'1985', yearsAtEmployer:'6', jobStartDate:'2019-01-01', concurrentRoles:'Advisor (Present)' }, want:'ATEC' },
  { n:'R: manual checkbox true',      L:{ gradYear:'1985', concurrentRole:true },                            want:'ARTEC' },
  { n:'R: column says "none"',        L:{ gradYear:'1985', concurrentRoles:'none' },                         want:'ATEC'  },
  { n:'E: derived from grad year',    L:{ gradYear:'1985', concurrentRoles:'Board (Present)' },              want:'ARTEC' },
  { n:'E: derived from first job yr', L:{ firstJobYear:'1988', hd:{age:62}, concurrentRoles:'Board (Present)' }, want:'ARTEC' },
  { n:'E: grad 2018, too short',      L:{ gradYear:'2018', hd:{age:61}, concurrentRoles:'Board (Present)' },  want:'ARTC'  },
  { n:'E: stated column wins',        L:{ gradYear:'1985', yearsExperience:'11', yearsAtEmployer:'6', jobStartDate:'2019-01-01' }, want:'ATC' },
];

(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' }).catch(() => chromium.launch());
  const p = await b.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto('http://127.0.0.1:8099/', { waitUntil: 'networkidle' });

  const res = await p.evaluate(({cases, base}) => cases.map(c => {
    const L = Object.assign({}, base, c.L);
    scoreLead(L);
    return { n:c.n, want:c.want, got:(L.signals||[]).filter(s=>s.hit).map(s=>s.k).join(''),
             score:L.score, tier:L.tier };
  }), { cases: SCORE_CASES, base: BASE });

  let bad = 0;
  for (const r of res) {
    const ok = r.got === r.want; if (!ok) bad++;
    console.log(`${ok?'ok  ':'FAIL'}  ${r.n.padEnd(30)} got ${(r.got||'-').padEnd(6)} want ${r.want.padEnd(6)} ${String(r.score).padStart(3)} ${r.tier}`);
  }

  // Export: address preference and email ordering
  const exp = await p.evaluate(() => {
    const mk = o => Object.assign({ id:'x', status:'New', notes:'', activity:[],
      firstName:'A', lastName:'B', street:'1 Office Rd', city:'Newark', state:'NJ', zip:'07102' }, o);
    const withHome = mk({ email:'work@corp.com',
      hd:{ street:'8 Magnet St', city:'Stony Brook', state:'NY', zip:'11790', emails:['home@gmail.com'] } });
    const noHome   = mk({ email:'work@corp.com', personalEmail:'me@gmail.com' });
    const bare     = mk({ hd:{ emails:['only@gmail.com'] } });
    return {
      home:   [exportAddress(withHome), exportEmails(withHome)],
      office: [exportAddress(noHome),   exportEmails(noHome)],
      bare:   [exportAddress(bare),     exportEmails(bare)],
    };
  });
  console.log('\nexport, home known  :', JSON.stringify(exp.home));
  console.log('export, no home     :', JSON.stringify(exp.office));
  console.log('export, only WP mail:', JSON.stringify(exp.bare));

  console.log('\n' + (errs.length ? 'PAGE ERRORS: ' + errs.join(' | ') : 'no page errors'));
  console.log(bad ? `${bad} FAILING` : 'all scoring cases pass');
  await b.close();
  // Without an exit code a counted failure prints and still reports success.
  process.exit(bad || errs.length ? 1 : 0);
})().catch(e => { console.error(e.message); process.exit(1); });
