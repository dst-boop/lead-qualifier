const { chromium } = require('playwright');
// The exact header set from the user's ZoomInfo export — no street column.
const ZI = ['First Name','Last Name','Job Title','Management Level','Company Name',
  'Person State','Person City','Mobile Phone','Direct Phone Number','Email Address',
  'Job Start Date','Graduation Year','Number of Employees','LinkedIn Contact Profile URL'];
const WITH_STREET = ZI.concat(['Person Street','Person Zip Code']);
(async () => {
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' }).catch(()=>chromium.launch());
  const p = await b.newPage(); const errs=[]; p.on('pageerror',e=>errs.push(e.message));
  await p.goto('http://127.0.0.1:8099/', { waitUntil:'networkidle' });
  const out = await p.evaluate(([a,b]) => {
    const show = h => { const g = guessColumns(h);
      const inv = {}; for (const k in g) inv[k] = h[g[k]];
      return { street: inv.street||'(none)', email: inv.email||'(none)',
               city: inv.city||'(none)', state: inv.state||'(none)',
               zip: inv.zip||'(none)', mobile: inv.mobilePhone||'(none)',
               dupes: Object.values(g).length !== new Set(Object.values(g)).size };
    };
    return { noStreet: show(a), withStreet: show(b) };
  }, [ZI, WITH_STREET]);
  console.log('no street column :', JSON.stringify(out.noStreet));
  console.log('with street col  :', JSON.stringify(out.withStreet));
  console.log(errs.length ? 'ERRORS: '+errs.join(' | ') : 'no page errors');
  await b.close();
})().catch(e=>{console.error(e.message);process.exit(1);});
