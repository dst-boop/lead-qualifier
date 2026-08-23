// The point of this feature is that a saved token makes ZoomInfo work in an
// ordinary browser. So the checks are: does the app stop telling you to open it
// inside Claude, do the live buttons come back, and does the credential stay out
// of anything that syncs to the browser or the lead-state document.
const { chromium } = require('playwright');
const feat=(o)=>({whitepages:true,ai_qc:true,server_state:false,drive:false,
  zoominfo:false,edgar:false,zi_mcp:true,...o});
const me=(o)=>({signed_in:true,provider:'google',name:'Dan',email:'d@f.com',
  providers:{google:true},features:feat(),storage:'firestore',encryption:'kms',...o});

(async()=>{
  const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium'}).catch(()=>chromium.launch());
  const p=await (await b.newContext()).newPage({viewport:{width:1500,height:1000}});
  const errs=[];p.on('pageerror',e=>errs.push(e.message));
  let who=me(), saved=null, mcpReply={results:['{"data":[]}'],text:'',stop_reason:'end_turn'};
  const puts=[];
  await p.route('**/api/me',r=>r.fulfill({json:who}));
  await p.route('**/api/state',r=>{
    if(r.request().method()==='PUT')puts.push(JSON.parse(r.request().postData()||'{}'));
    return r.fulfill({json:{found:false,settings:{},leads:[]}});
  });
  await p.route('**/api/zi/mcp-token',r=>{
    saved=JSON.parse(r.request().postData()||'{}').token;
    return r.fulfill({json:{connected:!!saved}});
  });
  await p.route('**/api/zi/mcp',r=>r.fulfill({json:mcpReply}));

  // btnBuild / btnEnrich / envWarn live inside a <details> that starts collapsed,
  // so isVisible() would report on the accordion rather than the feature. The
  // code sets style.display, so that is what gets asserted.
  const shown=async id=>await p.evaluate(i=>{
    const el=document.getElementById(i);return !!el&&el.style.display!=='none';},id);

  let fail=0,n=0;
  const ck=(name,c,d)=>{n++;console.log((c?'ok   ':'FAIL ')+name+(d?'  '+d:''));if(!c)fail++;};
  const load=async()=>{
    await p.goto('http://127.0.0.1:8099/',{waitUntil:'domcontentloaded'});
    await p.evaluate(()=>localStorage.clear());
    await p.goto('http://127.0.0.1:8099/',{waitUntil:'networkidle'});await p.waitForTimeout(500);
  };

  // --- ordinary browser, no token -------------------------------------------
  await load();
  ck('standalone warning is shown', await shown('envWarn'));
  ck('Build list is hidden', !(await shown('btnBuild')));
  ck('ziMcpReady() is false', await p.evaluate(()=>ziMcpReady())===false);
  await p.click('#btnMore'); await p.click('#btnSettings');await p.waitForTimeout(400);
  ck('settings explains it is not connected',
     /Not connected/.test(await p.textContent('#ziMcpState')), await p.textContent('#ziMcpState'));
  ck('the token box is a password field',
     await p.getAttribute('#sZiMcp','type')==='password');

  // --- saving a token --------------------------------------------------------
  await p.fill('#sZiMcp','zi-secret-123');
  await p.click('#btnSaveSettings');await p.waitForTimeout(700);
  ck('the token is sent to the backend', saved==='zi-secret-123', JSON.stringify(saved));
  ck('  ...and cleared from the box', await p.inputValue('#sZiMcp')==='');
  ck('  ...it never enters state.settings',
     await p.evaluate(()=>JSON.stringify(state.settings).includes('zi-secret-123'))===false);
  ck('  ...nor anything PUT to /api/state',
     !puts.some(x=>JSON.stringify(x).includes('zi-secret-123')), puts.length+' puts');
  ck('  ...nor localStorage',
     await p.evaluate(()=>JSON.stringify(localStorage).includes('zi-secret-123'))===false);

  ck('Build list appears', await shown('btnBuild'));
  ck('Enrich appears', await shown('btnEnrich'));
  ck('the standalone warning goes away', !(await shown('envWarn')));
  ck('ziMcpReady() is true', await p.evaluate(()=>ziMcpReady())===true);

  // --- the query path --------------------------------------------------------
  mcpReply={results:['{"data":[{"id":7,"lastName":"Whitfield"}]}'],text:'',stop_reason:'end_turn'};
  const got=await p.evaluate(()=>callClaude('find senior execs'));
  ck('callClaude routes through the backend',
     JSON.stringify(got)==='[{"data":[{"id":7,"lastName":"Whitfield"}]}]', JSON.stringify(got));

  mcpReply={results:[],text:'ZoomInfo rejected the token.',stop_reason:'end_turn'};
  const err=await p.evaluate(()=>callClaude('x').then(()=>null,e=>e.message));
  ck('an empty result surfaces the reason', /rejected the token/.test(err||''), JSON.stringify(err));

  // --- removing it -----------------------------------------------------------
  await p.click('#btnMore'); await p.click('#btnSettings');await p.waitForTimeout(400);
  await p.click('#lnkZiMcpClear');await p.waitForTimeout(500);
  ck('remove sends an empty token', saved==='', JSON.stringify(saved));
  ck('  ...Build list hides again', !(await shown('btnBuild')));
  ck('  ...and the warning returns', await shown('envWarn'));

  // --- no Anthropic key on the deployment ------------------------------------
  who=me({features:feat({zi_mcp:false})});
  await load();
  await p.click('#btnMore'); await p.click('#btnSettings');await p.waitForTimeout(400);
  ck('unavailable when the service has no key',
     /Unavailable/.test(await p.textContent('#ziMcpState')), await p.textContent('#ziMcpState'));

  // --- already connected on load ---------------------------------------------
  who=me({zi_mcp_connected:true});
  await load();
  ck('a saved token is honoured on load', await shown('btnBuild'));
  ck('  ...no standalone warning', !(await shown('envWarn')));
  await p.click('#btnMore'); await p.click('#btnSettings');await p.waitForTimeout(400);
  ck('  ...and settings says connected',
     /Connected/.test(await p.textContent('#ziMcpState')), await p.textContent('#ziMcpState'));

  const unexpected=errs.filter(e=>!/Failed to load resource/.test(e));
  ck('no page errors', unexpected.length===0, unexpected.slice(0,2).join(' | '));
  console.log(fail?`\nFAILURES: ${fail} of ${n}`:`\nall ${n} checks passed`);
  await b.close();process.exit(fail?1:0);
})();
