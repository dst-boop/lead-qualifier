// The importer against a real research-tool export, and the prompt that would
// have prevented it.
//
// Do Browser was pointed at a prospecting brief and returned 155 people in 22
// columns. Four of those columns are readable by this app. There is no email,
// no phone, no date and no real age, and every one of the 155 lands in Excluded
// with a score of 20 out of 80. The header row below is that file's, verbatim;
// the rows are synthetic, because a test fixture is no place for 155 real
// people's names.
//
// Two things are guarded here. That a column announcing itself as an estimate
// never reaches a scoring field on its own — "Est. Age Range" was filled in for
// all 155, derived from job title, and mapped to age it would be worth 25 of
// the 80 points. And that the generated research prompt asks for the columns
// the importer actually reads, so the next run comes back usable.
const { chromium } = require('playwright');

const HEADERS = ['Full Name','LinkedIn URL','Current Title','Current Company','Industry',
  'Previous Company','Years at Current Role','Location','Est. Age Range','Est. Annual Income',
  'Est. Assets','401(k) Rollover Opportunity','Lead Category','Life Event Signal',
  'Money in Motion Indicator','Lead Score (1-100)','Priority','Notes','Status','Date Added',
  'Assigned FA','Follow-Up Date'];
const ROW = ['Dana Ellsworth','https://www.linkedin.com/in/example/','Vice President of Engineering',
  'Cordova Industrial Group','Technology','VP Engineering at Halstead','','Sterling, Virginia, United States',
  '55–64','$250k+','$1M–$2.5M','High — Recent job change','HENRY','Job Change (last 6 mo)',
  'Yes — Active signal','100','🔴 Hot','Past: VP Engineering','New','2026-08-23','',''];
const CSV = [HEADERS, ROW].map(r=>r.map(v=>/[",\n]/.test(v)?'"'+v.replace(/"/g,'""')+'"':v).join(',')).join('\r\n');

(async()=>{
  const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium'}).catch(()=>chromium.launch());
  const p=await b.newPage();
  const errs=[];p.on('pageerror',e=>errs.push(e.message));
  await p.goto('http://127.0.0.1:8099/',{waitUntil:'networkidle'});

  let fail=0,n=0;
  const ck=(name,c,d)=>{n++;console.log((c?'ok   ':'FAIL ')+name+(d?'  '+d:''));if(!c)fail++;};

  const r=await p.evaluate(csv=>{
    const rows=parseCSV(csv), hdr=rows[0], map=guessColumns(hdr);
    const got={}; FIELDS.forEach(([k])=>{ if(map[k]>-1) got[k]=hdr[map[k]]; });
    const L={}; FIELDS.forEach(([k])=>{const i=map[k];L[k]=(i>-1&&rows[1][i]!==undefined)?(''+rows[1][i]).trim():'';});
    if(L.fullName&&!L.firstName){const [f,l]=splitName(L.fullName);L.firstName=f;L.lastName=l;}
    const sc=scoreLead(L,DEFAULTS);
    const used=new Set(Object.values(map).filter(i=>i>-1));
    return {map:got, lead:L, tier:sc.tier, score:sc.score,
            signals:sc.signals.map(s=>[s.k,s.pts]),
            ignored:hdr.filter((h,i)=>!used.has(i)),
            derivedFlagged:hdr.filter(h=>looksDerived(h)),
            prompt:researchPrompt(), prompt2:researchPrompt({employer:'Cordova Industrial Group',state:'NJ'})};
  },CSV);

  // --- what the file actually gives the app ---------------------------------
  ck('the four readable columns are mapped',
     r.map.fullName==='Full Name'&&r.map.title==='Current Title'&&
     r.map.employer==='Current Company'&&r.map.linkedinUrl==='LinkedIn URL',
     JSON.stringify(r.map));
  ck('no email column exists to map', !r.map.email);
  ck('no mobile column exists to map', !r.map.mobilePhone);
  ck('the name is split for the table', r.lead.firstName==='Dana'&&r.lead.lastName==='Ellsworth');
  ck('the lead is Excluded', r.tier==='X', r.tier);
  ck('  ...scoring only the title signal', r.score===20, String(r.score));
  ck('  ...with age worth nothing', r.signals.find(s=>s[0]==='A')[1]===0);
  ck('  ...and contact worth nothing', r.signals.find(s=>s[0]==='C')[1]===0);

  // --- the estimate guard ----------------------------------------------------
  ck('"Est. Age Range" is recognised as derived', r.derivedFlagged.includes('Est. Age Range'));
  ck('  ...as are the other Est. columns',
     r.derivedFlagged.includes('Est. Annual Income')&&r.derivedFlagged.includes('Est. Assets'),
     r.derivedFlagged.join(' | '));
  ck('  ...and nothing else is', r.derivedFlagged.length===3, r.derivedFlagged.join(' | '));
  ck('the estimated columns are left out of the import',
     ['Est. Age Range','Est. Annual Income','Est. Assets'].every(h=>r.ignored.includes(h)));
  ck('the fabricated score is left out too', r.ignored.includes('Lead Score (1-100)'));

  // a real column that merely mentions age must still map
  const clean=await p.evaluate(()=>{
    const m=guessColumns(['Full Name','Graduation Year','Years of Experience','Mobile Phone']);
    return {grad:m.gradYear,exp:m.yearsExperience,mob:m.mobilePhone};});
  ck('the guard does not touch ordinary columns',
     clean.grad===1&&clean.exp===2&&clean.mob===3, JSON.stringify(clean));
  const near=await p.evaluate(()=>{
    const m=guessColumns(['Estimated Graduation Year','Graduation Year']);
    return m.gradYear;});
  ck('an estimated column loses to the real one beside it', near===1, String(near));

  // --- the generated prompt --------------------------------------------------
  const t=r.prompt;
  ck('the prompt names every template column',
     await p.evaluate(p=>TEMPLATE_COLS.every(([,h])=>p.includes(h)), t));
  ck('  ...forbids estimating', /Do not estimate, infer, approximate, or derive/.test(t));
  ck('  ...names the specific mistake this file made',
     /Do not infer age from job title/.test(t)&&/41-year-old vice president/.test(t));
  ck('  ...rejects a supplied score column', /Do not add a score, priority, rating/.test(t));
  ck('  ...says a blank is better than a guess', /leave it blank/i.test(t));
  ck('  ...makes the mobile the gate', /Mobile Phone/.test(t)&&/gate/.test(t));
  ck('  ...excludes financial services', /financial services/i.test(t));
  ck('  ...carries the live ICP age', t.includes(String(59.5)));
  ck('  ...and the live title list',
     await p.evaluate(p=>p.includes(DEFAULTS.titles), t));
  ck('  ...offers sources beyond one profile site',
     /SEC proxy statement/.test(t)&&/WARN notice/.test(t));
  ck('  ...asks for a sheet with one header row', /One header row/.test(t));
  ck('employer form targets a single employer',
     /Find current and recent employees of Cordova Industrial Group in NJ/.test(r.prompt2));

  // --- pasting a Drive link --------------------------------------------------
  const ids=await p.evaluate(()=>[
    driveIdFrom('https://docs.google.com/spreadsheets/d/1v3URKpbKulo4QLav3ZHoVlltLXn0IytTSMxste6HnWM/edit?usp=sharing'),
    driveIdFrom('  https://drive.google.com/file/d/1v3URKpbKulo4QLav3ZHoVlltLXn0IytTSMxste6HnWM/view '),
    driveIdFrom('1v3URKpbKulo4QLav3ZHoVlltLXn0IytTSMxste6HnWM'),
    driveIdFrom('401(k) Rollover Leads'),
    driveIdFrom('Boeing'),
    driveIdFrom('')]);
  const ID='1v3URKpbKulo4QLav3ZHoVlltLXn0IytTSMxste6HnWM';
  ck('a pasted sheet URL yields its id', ids[0]===ID, String(ids[0]));
  ck('  ...so does a Drive file URL', ids[1]===ID, String(ids[1]));
  ck('  ...and a bare id', ids[2]===ID, String(ids[2]));
  ck('a file name is still a search', ids[3]===null&&ids[4]===null&&ids[5]===null, JSON.stringify(ids.slice(3)));

  ck('no page errors', errs.length===0, errs.slice(0,2).join(' | '));
  console.log(fail?`\nFAILURES: ${fail} of ${n}`:`\nall ${n} checks passed`);
  await b.close();process.exit(fail?1:0);
})();
