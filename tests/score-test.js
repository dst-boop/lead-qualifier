const { chromium } = require('playwright');

// One case per rule. `expect` lists the signal keys that must hit.
//
// Two model changes made the old fixtures wrong, and because the harness never
// exited non-zero, 11 failures reported as a pass for weeks:
//   - R needs a recent move AND a second current role. A move alone is an
//     ordinary job change; the second seat is what marks a real one.
//   - No states are excluded by default. That was a personal territory rule,
//     not a product rule.
// Every case that means to exercise R therefore carries concurrentRoles.
const SECOND = 'Board Member, Ridgeline Capital';
const CASES = [
  { n:'all five',             L:{ gradYear:'1985', jobStartDate:'2024-06-01', concurrentRoles:SECOND, title:'Chief Financial Officer', mgmtLevel:'C Level Exec', yearsExperience:'30', yearsAtEmployer:'2', email:'a@b.com', mobilePhone:'555-1111' }, expect:'ARTEC' },
  { n:'age via enrichment',   L:{ hd:{age:61}, gradYear:'1998', jobStartDate:'2024-06-01', concurrentRoles:SECOND, title:'VP Sales', yearsExperience:'25', yearsAtEmployer:'2', email:'a@b.com', mobilePhone:'555' }, expect:'ARTEC' },
  { n:'grad 1990 = miss A',   L:{ gradYear:'1990', jobStartDate:'2024-06-01', concurrentRoles:SECOND, title:'VP Sales', yearsExperience:'25', yearsAtEmployer:'2', email:'a@b.com', mobilePhone:'555' }, expect:'RTEC' },
  { n:'grad 1989 = hit A',    L:{ gradYear:'1989', jobStartDate:'2024-06-01', concurrentRoles:SECOND, title:'VP Sales', yearsExperience:'25', yearsAtEmployer:'2', email:'a@b.com', mobilePhone:'555' }, expect:'ARTEC' },
  { n:'age 59 = miss A',      L:{ hd:{age:59}, jobStartDate:'2024-06-01', concurrentRoles:SECOND, title:'VP', yearsExperience:'25', yearsAtEmployer:'2', email:'a@b.com', mobilePhone:'555' }, expect:'RTEC' },

  // --- signal R: BOTH halves are required, so each half gets its own case ---
  { n:'R: 72mo in role = miss',  L:{ gradYear:'1985', jobStartDate:'2019-01-01', concurrentRoles:SECOND, title:'VP', yearsExperience:'30', yearsAtEmployer:'7', email:'a@b.com', mobilePhone:'555' }, expect:'ATEC' },
  { n:'R: no second role = miss',L:{ gradYear:'1985', jobStartDate:'2024-06-01', title:'VP', yearsExperience:'30', yearsAtEmployer:'2', email:'a@b.com', mobilePhone:'555' }, expect:'ATEC' },
  { n:'R: ticked by hand = hit', L:{ gradYear:'1985', jobStartDate:'2024-06-01', concurrentRole:true, title:'VP', yearsExperience:'30', yearsAtEmployer:'2', email:'a@b.com', mobilePhone:'555' }, expect:'ARTEC' },

  { n:'IC title = no T, no E',L:{ gradYear:'1985', jobStartDate:'2024-06-01', concurrentRoles:SECOND, title:'Senior Software Engineer', yearsExperience:'30', yearsAtEmployer:'2', email:'a@b.com', mobilePhone:'555' }, expect:'ARC' },
  { n:'Director counts',      L:{ gradYear:'1985', jobStartDate:'2024-06-01', concurrentRoles:SECOND, title:'Director of Ops', yearsExperience:'30', yearsAtEmployer:'2', email:'a@b.com', mobilePhone:'555' }, expect:'ARTEC' },
  { n:'Deputy Dir excluded',  L:{ gradYear:'1985', jobStartDate:'2024-06-01', concurrentRoles:SECOND, title:'Deputy Director', yearsExperience:'30', yearsAtEmployer:'2', email:'a@b.com', mobilePhone:'555' }, expect:'ARC' },
  { n:'prior 9yrs = miss E',  L:{ gradYear:'1985', jobStartDate:'2024-06-01', concurrentRoles:SECOND, title:'Owner', yearsExperience:'11', yearsAtEmployer:'2', email:'a@b.com', mobilePhone:'555' }, expect:'ARTC' },

  // --- the mobile gate: no number means no tier, whatever the score ---
  { n:'email only = miss C',  L:{ gradYear:'1985', jobStartDate:'2024-06-01', concurrentRoles:SECOND, title:'President', yearsExperience:'30', yearsAtEmployer:'2', email:'a@b.com' }, expect:'ARTE', tier:'X' },
  { n:'no mobile = tier X',   L:{ gradYear:'1985', jobStartDate:'2024-06-01', concurrentRoles:SECOND, title:'President', mgmtLevel:'C Level Exec', yearsExperience:'30', yearsAtEmployer:'2', email:'a@b.com' }, expect:'ARTE', tier:'X', wouldBe:'A' },

  // --- state exclusion is opt-in, not a default ---
  { n:'CT kept by default',   L:{ state:'CT', gradYear:'1985', title:'CEO', mobilePhone:'555', email:'a@b.com', yearsExperience:'30', yearsAtEmployer:'2' }, expect:'ATEC' },
  { n:'CT excluded when set', L:{ state:'CT', gradYear:'1985', title:'CEO', mobilePhone:'555', email:'a@b.com' }, settings:{exStates:'CT,MA'}, expect:'X' },
  { n:'MA excluded when set', L:{ state:'MA', gradYear:'1985', title:'CEO', mobilePhone:'555', email:'a@b.com' }, settings:{exStates:'CT,MA'}, expect:'X' },
  { n:'NJ kept when CT set',  L:{ state:'NJ', gradYear:'1985', title:'CEO', mobilePhone:'555', email:'a@b.com', yearsExperience:'30', yearsAtEmployer:'2' }, settings:{exStates:'CT,MA'}, expect:'ATEC' },
];

(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' }).catch(() => chromium.launch());
  const p = await b.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(e.message));
  await p.goto('http://127.0.0.1:8099/', { waitUntil: 'networkidle' });

  const out = await p.evaluate((cases) => cases.map(c => {
    const saved = {...state.settings};
    if (c.settings) Object.assign(state.settings, c.settings);
    const L = Object.assign({ id:'t', status:'New', notes:'', activity:[] }, c.L);
    scoreLead(L);
    state.settings = saved;                       // never leak one case into the next
    return { n:c.n, expect:c.expect, wantTier:c.tier, wantWouldBe:c.wouldBe,
             tier:L.tier, score:L.score, wouldBe:L.wouldBeTier,
             hit:(L.signals||[]).filter(s => s.hit).map(s => s.k).join('') || (L.tier==='X' ? 'X' : '') };
  }), CASES);

  let bad = 0;
  for (const r of out) {
    const why = [];
    if (r.hit !== r.expect) why.push(`signals ${r.hit||'-'} want ${r.expect}`);
    if (r.wantTier && r.tier !== r.wantTier) why.push(`tier ${r.tier} want ${r.wantTier}`);
    if (r.wantWouldBe && r.wouldBe !== r.wantWouldBe) why.push(`wouldBe ${r.wouldBe||'-'} want ${r.wantWouldBe}`);
    if (why.length) bad++;
    console.log(`${why.length ? 'FAIL' : 'ok  '}  ${r.n.padEnd(24)} ${String(r.score).padStart(3)} pts  tier ${r.tier}  ${why.join(' · ')}`);
  }
  if (errs.length) { console.log('PAGE ERRORS: ' + errs.join(' | ')); bad++; } else console.log('no page errors');
  console.log(bad ? `${bad} FAILING` : `all ${out.length} cases pass`);
  await b.close();
  process.exit(bad ? 1 : 0);          // without this a failing run reported success
})().catch(e => { console.error(e.message); process.exit(1); });
