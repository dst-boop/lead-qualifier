const { chromium } = require('playwright');
const ME={signed_in:true,provider:'google',name:'D',email:'d@f.com',providers:{google:true},
  features:{whitepages:true,ai_qc:true,server_state:false,drive:true},storage:'memory'};
(async () => {
  const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium'}).catch(()=>chromium.launch());
  const p=await b.newPage({viewport:{width:1400,height:900}}); const errs=[];
  p.on('pageerror',e=>errs.push(e.message));
  await p.route('**/api/me',r=>r.fulfill({json:ME}));
  await p.goto('http://127.0.0.1:8099/',{waitUntil:'networkidle'});
  await p.waitForTimeout(400);
  await p.evaluate(()=>{ state.leads=[1,2,3,4,5].map(i=>({id:'L'+i,firstName:'A',lastName:'Lead'+i,
    title:'VP Operations',mgmtLevel:'VP Level Exec',employer:'X',state:'NY',status:'New',notes:'',
    activity:[],gradYear:'1986',jobStartDate:'2025-03-01',yearsExperience:'34',yearsAtEmployer:'1',
    email:'a@b.com',mobilePhone:'555-000'+i})); state.leads.forEach(scoreLead); render(); });
  await p.waitForTimeout(300);
  const m=await p.evaluate(()=>{
    const d=document.querySelector('details.buildpanel');
    const tbl=document.getElementById('tbl');
    return { collapsed:!d.hasAttribute('open'), panelH:Math.round(d.getBoundingClientRect().height),
             tableTop:Math.round(tbl.getBoundingClientRect().top), canOpen:!!d.querySelector('summary') };
  });
  console.log('panel collapsed  :', m.collapsed);
  console.log('panel height     :', m.panelH, 'px (was ~300)');
  console.log('lead table starts:', m.tableTop, 'px from top');
  console.log('still openable   :', m.canOpen);
  await p.screenshot({path:'l1-collapsed.png'});
  await p.click('details.buildpanel summary'); await p.waitForTimeout(300);
  const open=await p.evaluate(()=>document.querySelector('details.buildpanel').hasAttribute('open'));
  console.log('opens on click   :', open);
  console.log(errs.length?'ERRORS: '+errs.join(' | '):'no page errors');
  await b.close();
})().catch(e=>{console.error(e.message);process.exit(1);});
