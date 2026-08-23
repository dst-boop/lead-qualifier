// The SCS campaign. Rollover and SCS want opposite things out of the same
// tenure number — one sells because the person left, the other because they
// never did — so the campaign has to reach the scorer, and the two searches
// have to ask ZoomInfo for opposite ends of positionStartDate. Both are easy to
// get backwards and neither fails loudly, which is what this suite is for.
//
// The 50-year suspect threshold has a specific origin: a real 46-year run at
// one employer was being flagged as a bad date, which loses the single best
// lead on the list. A tenure test that does not cover the long-but-real case
// is not testing the thing that went wrong.
const { chromium } = require('playwright');
const YEAR = new Date().getFullYear();
const startedYearsAgo = y => `${YEAR - y}-06-01`;

(async()=>{
  const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium'}).catch(()=>chromium.launch());
  const ctx=await b.newContext();
  const p=await ctx.newPage();
  const errs=[];p.on('pageerror',e=>errs.push(e.message));
  await p.route('**/api/me',r=>r.fulfill({json:{signed_in:true,provider:'google',name:'Dan',
    email:'d@f.com',providers:{google:true},
    features:{whitepages:true,ai_qc:true,server_state:false,drive:false,zoominfo:false,
              edgar:false,zi_mcp:false,opportunities:false},
    storage:'memory',encryption:'none'}}));
  await p.goto('http://127.0.0.1:8099/',{waitUntil:'domcontentloaded'});
  await p.evaluate(()=>localStorage.clear());
  await p.goto('http://127.0.0.1:8099/',{waitUntil:'networkidle'});
  await p.waitForTimeout(400);

  let fail=0,n=0;
  const ck=(name,c,d)=>{n++;console.log((c?'ok   ':'FAIL ')+name+(d?'  '+d:''));if(!c)fail++;};
  const score=(L)=>p.evaluate(L=>{const x={...L};scoreLead(x);
    return {score:x.score,tier:x.tier,sig:x.signals.map(s=>[s.k,s.pts,s.label,!!s.hit,!!s.conf])};},L);
  const sigOf=(r,k)=>r.sig.find(s=>s[0]===k);

  const BASE={firstName:'Ray',lastName:'Okonjo',title:'Senior Manager',mgmtLevel:'Manager',
    employer:'IBM',email:'r@ibm.com',mobilePhone:'(207) 555-0117',state:'NY'};

  // --- tenure is the SCS balance signal -------------------------------------
  const t10=await score({...BASE,campaign:'scs',jobStartDate:startedYearsAgo(10)});
  ck('10 yrs tenure does not qualify', sigOf(t10,'V')[1]===0, sigOf(t10,'V')[2]);
  const t18=await score({...BASE,campaign:'scs',jobStartDate:startedYearsAgo(18)});
  ck('18 yrs qualifies', sigOf(t18,'V')[1]===20, JSON.stringify(sigOf(t18,'V')));
  const t29=await score({...BASE,campaign:'scs',jobStartDate:startedYearsAgo(29)});
  ck('  ...still 20 just under the bonus', sigOf(t29,'V')[1]===20, String(sigOf(t29,'V')[1]));
  const t30=await score({...BASE,campaign:'scs',jobStartDate:startedYearsAgo(30)});
  ck('30 yrs takes the bonus', sigOf(t30,'V')[1]===25, String(sigOf(t30,'V')[1]));
  ck('  ...and scores above the 18-year lead', t30.score>t18.score, `${t30.score} vs ${t18.score}`);

  // --- the case that set the threshold --------------------------------------
  const t46=await score({...BASE,campaign:'scs',employer:'Boeing',jobStartDate:startedYearsAgo(46)});
  ck('a real 46-year run is NOT flagged as a bad date',
     sigOf(t46,'V')[3]===true&&!/implausible/.test(sigOf(t46,'V')[2]), sigOf(t46,'V')[2]);
  ck('  ...and it earns the bonus', sigOf(t46,'V')[1]===25, String(sigOf(t46,'V')[1]));
  const t60=await score({...BASE,campaign:'scs',jobStartDate:startedYearsAgo(60)});
  ck('60 years is flagged as implausible', /implausible/.test(sigOf(t60,'V')[2]), sigOf(t60,'V')[2]);
  ck('  ...and scores nothing for it', sigOf(t60,'V')[1]===0);
  const t126=await score({...BASE,campaign:'scs',jobStartDate:'1900-01-01'});
  ck('a 1900 placeholder cannot outrank a real lead', t126.score<t30.score, `${t126.score} vs ${t30.score}`);

  // --- rollover is untouched by any of it ------------------------------------
  const r30=await score({...BASE,campaign:'rollover',jobStartDate:startedYearsAgo(30)});
  ck('rollover has no V signal', !sigOf(r30,'V'));
  ck('  ...and still has E', !!sigOf(r30,'E'));
  ck('  ...and long tenure earns it nothing', r30.score<t30.score, `${r30.score} vs ${t30.score}`);
  const scsHasNoE=await score({...BASE,campaign:'scs',jobStartDate:startedYearsAgo(20),yearsExperience:'35'});
  ck('scs drops E rather than double-counting tenure', !sigOf(scsHasNoE,'E'));

  // --- the weight budget is unchanged ----------------------------------------
  const maxScs=await score({...BASE,campaign:'scs',jobStartDate:startedYearsAgo(35),
    title:'Director',mgmtLevel:'Director',edgar:{age:63,asOf:'2026'}});
  ck('a perfect SCS lead tops out at 80, same as rollover', maxScs.score===80, String(maxScs.score));
  ck('  ...and lands in tier A', maxScs.tier==='A', maxScs.tier);

  // --- age inference, and the line it must not cross -------------------------
  const inf=await p.evaluate(y=>{
    const L={gradYear:String(y-40)};
    return {any:leadAgeAny(L),conf:leadAge(L),basis:ageBasis(L),src:ageSource(L)};},YEAR);
  ck('an age is inferred from graduation year', inf.any===62, String(inf.any));
  ck('  ...but leadAge() still reports nothing confirmed', inf.conf===null, String(inf.conf));
  ck('  ...and the basis says it was worked out', inf.basis.kind==='inferred', JSON.stringify(inf.basis));
  ck('  ...naming what it came from', /graduated/.test(inf.basis.label), inf.basis.label);
  const filed=await p.evaluate(()=>ageBasis({edgar:{age:61,asOf:'2026-03'}}));
  ck('a filed age is marked filed, not inferred', filed.kind==='filed', JSON.stringify(filed));

  // the inference must never award the confirmed-age points
  const infScore=await score({...BASE,campaign:'scs',jobStartDate:startedYearsAgo(20),
                              firstJobYear:String(YEAR-40)});
  const A=sigOf(infScore,'A');
  ck('an inferred age never fires signal A as confirmed', !(A[3]&&A[4]), JSON.stringify(A));

  // --- the 59½ badge ---------------------------------------------------------
  const badges=await p.evaluate(y=>({
    yes:sellable({edgar:{age:63,asOf:'2026'}}),
    soon:sellable({edgar:{age:54,asOf:'2026'}}),
    none:sellable({firstName:'x'}),
    inferred:sellable({gradYear:String(y-42)}),
    edge:sellable({hd:{age:59}}),
  }),YEAR);
  ck('63 is sellable now', badges.yes.k==='yes'&&badges.yes.label==='59½ ✓', badges.yes.label);
  ck('54 is a nurture, with the wait shown', badges.soon.k==='soon'&&/in ~6y/.test(badges.soon.label), badges.soon.label);
  ck('59 is not yet sellable', badges.edge.k==='soon', badges.edge.label);
  ck('no age at all reads "verify date"', badges.none.k==='unknown'&&badges.none.label==='verify date', badges.none.label);
  ck('an inferred age still gets a badge', badges.inferred.k==='yes', badges.inferred.label);
  ck('  ...whose tooltip admits the basis', /inferred|graduated/.test(badges.inferred.title), badges.inferred.title);

  // --- the search asks for the opposite end of the date range ----------------
  // The build panel is collapsed outside Claude, so open it before driving it.
  await p.evaluate(()=>document.querySelector('details.buildpanel').setAttribute('open',''));
  await p.click('#campScs');await p.waitForTimeout(200);
  const sp=await p.evaluate(()=>scsPrompt());
  ck('SCS uses positionStartDateMax', /positionStartDateMax/.test(sp.prompt));
  ck('  ...and never positionStartDateMin', !/positionStartDateMin/.test(sp.prompt.replace(/Do not substitute positionStartDateMin\./,'')));
  ck('  ...dated by the tenure input', sp.prompt.includes(sp.maxDate)&&sp.maxDate.startsWith(String(YEAR-18)), sp.maxDate);
  ck('  ...searches by ticker', /companyTicker: "IBM,RTX,XOM,ED,BA"/.test(sp.prompt));
  ck('  ...at the SCS management levels', /Director,Manager,Non-Manager/.test(sp.prompt));
  ck('  ...and accuracy 90', /contactAccuracyScoreMin: "90"/.test(sp.prompt));
  ck('  ...requiring email and mobile', /requiredFields: "email,mobilePhone"/.test(sp.prompt));
  ck('the BA ticker collision is documented in the panel',
     /BAE Systems/.test(await p.textContent('#scsInner')));
  ck('the compliance note names both requirements',
     /Equitable pre-approval/.test(await p.textContent('#scsInner'))
     &&/prospectus/.test(await p.textContent('#scsInner')));
  ck('the SCS panel is shown and the rollover one hidden',
     await p.evaluate(()=>document.getElementById('scsInner').style.display===''
       &&document.getElementById('rolloverInner').style.display==='none'));

  // A saved campaign has to drive the switch, not the other way round: the
  // build panel reverting to Rollover on another machine runs the wrong search
  // and the mistake only shows up in what comes back.
  const restored=await p.evaluate(()=>{
    state.settings.campaign='scs';state.settings.scsMinTenure=25;state.settings.scsTickers='GE,MMM';
    document.getElementById('campScs').checked=false;
    document.getElementById('campRollover').checked=true;
    syncCampaignUI();
    return {scs:document.getElementById('campScs').checked,
            shown:document.getElementById('scsInner').style.display,
            tenure:document.getElementById('sTenure').value,
            tickers:document.getElementById('sTickers').value};});
  ck('a saved SCS campaign restores the switch', restored.scs===true&&restored.shown==='', JSON.stringify(restored));
  ck('  ...and the saved tickers and tenure', restored.tenure==='25'&&restored.tickers==='GE,MMM', JSON.stringify(restored));
  await p.evaluate(()=>{state.settings.scsMinTenure=18;state.settings.scsTickers='IBM,RTX,XOM,ED,BA';syncCampaignUI();});

  // --- enrichment must never ask for the field that capped the account -------
  const enr=await p.evaluate(()=>{
    const src=enrichLeads.toString();
    return {yoe:/yearsOfExperience/.test(src), fields:(src.match(/requiredFields: \[[^\]]*\]/)||[''])[0]};});
  ck('enrichment never requests yearsOfExperience', enr.yoe===false, enr.fields.slice(0,90));

  // --- a spent credit limit parks leads instead of losing them ---------------
  const lim=await p.evaluate(()=>['ZoomInfo: limit exceeded for this account',
    'HTTP 429 Too Many Requests','You have exceeded your limit of 1000 credits',
    'insufficient credits remaining','quota reached'].map(isLimitError));
  ck('every shape of a credit cap is recognised', lim.every(Boolean), JSON.stringify(lim));
  const notLim=await p.evaluate(()=>['no contact records were found','network error',
    'ZoomInfo returned nothing usable'].map(isLimitError));
  ck('  ...and an ordinary failure is not', notLim.every(x=>!x), JSON.stringify(notLim));

  const parked=await p.evaluate(()=>{
    state.leads=[{id:'a',firstName:'A',lastName:'B',contactId:'1',retryBlocked:true,status:'New',activity:[],tier:'C',score:0},
                 {id:'b',firstName:'C',lastName:'D',contactId:'2',status:'New',activity:[],tier:'C',score:0}];
    renderBlocked();
    const btn=document.getElementById('btnRetryBlocked');
    return {n:blockedLeads().length,shown:btn.style.display!=='none',text:btn.textContent};});
  ck('parked leads surface in the header', parked.n===1&&parked.shown&&/Retry blocked \(1\)/.test(parked.text),
     JSON.stringify(parked));
  const cleared=await p.evaluate(()=>{
    state.leads.forEach(L=>L.retryBlocked=false);renderBlocked();
    return document.getElementById('btnRetryBlocked').style.display;});
  ck('  ...and the button hides when nothing is parked', cleared==='none', cleared);

  // --- the 59½ filter ---------------------------------------------------------
  const filt=await p.evaluate(()=>{
    state.leads=[
      {id:'1',firstName:'Old',lastName:'Enough',status:'New',activity:[],edgar:{age:63,asOf:'2026'},mobilePhone:'1',campaign:'scs'},
      {id:'2',firstName:'Not',lastName:'Yet',status:'New',activity:[],edgar:{age:50,asOf:'2026'},mobilePhone:'1',campaign:'scs'}];
    state.leads.forEach(scoreLead);
    document.getElementById('fSellable').checked=true;
    const on=filtered().map(L=>L.firstName);
    document.getElementById('fSellable').checked=false;
    return {on,off:filtered().length};});
  ck('the 59½+ filter keeps only sellable leads',
     filt.on.length===1&&filt.on[0]==='Old', JSON.stringify(filt.on));
  ck('  ...and clearing it brings the rest back', filt.off===2, String(filt.off));

  // --- export carries the campaign and the sellable status -------------------
  await p.evaluate(()=>{
    state.leads=[{id:'1',firstName:'Old',lastName:'Enough',status:'New',activity:[],
      edgar:{age:63,asOf:'2026'},mobilePhone:'1',email:'e@x.com',campaign:'scs',signals:[]}];
    state.leads.forEach(scoreLead);});
  const dl=p.waitForEvent('download');
  await p.click('#btnExport');
  const file=await dl;
  const fs=require('fs');const path=await file.path();
  const csv=fs.readFileSync(path,'utf8');
  ck('export names the campaign', /Campaign: SCS/.test(csv));
  ck('  ...the sellable status', /59\.5: sellable now/.test(csv));
  ck('  ...and where the age came from', /Age basis: SEC filing/.test(csv));

  ck('no page errors', errs.length===0, errs.slice(0,2).join(' | '));
  console.log(fail?`\nFAILURES: ${fail} of ${n}`:`\nall ${n} checks passed`);
  await b.close();process.exit(fail?1:0);
})();
