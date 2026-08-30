"""The Attom trial route, against a stub gateway.

Ten days of key means every duplicate call is trial budget burned, so the
durable cache and the recorded miss matter more than usual. The suite proves:
the gates (no key, no address), the AVM parse, the profile fallback filling
owner and sale, a miss remembered as an answer, the cache short-circuiting a
second ask, and a dead key surfacing as "the trial may have ended" rather
than a mystery 502.
"""
import asyncio, json, os, sys, threading, time

os.environ["NO_PROXY"] = os.environ["no_proxy"] = "127.0.0.1,localhost"
for k in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"):
    os.environ.pop(k, None)
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("SESSION_SECRET", "t" * 32)
os.environ["ATTOM_API_KEY"] = "trial-key"
os.environ["ATTOM_BASE"] = "http://127.0.0.1:8749"

import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient

stub = FastAPI()
HITS = []

AVM = {"status": {"code": 0, "total": 1}, "property": [{
    "avm": {"amount": {"value": 612000, "high": 655000, "low": 570000, "scr": 91}},
    "sale": {"amount": {"saleamt": 240000}, "salesearchdate": "2004-06-15"},
    "summary": {"yearbuilt": 1992}}]}
PROFILE = {"status": {"code": 0, "total": 1}, "property": [{
    "assessment": {"assessed": {"assdttlvalue": 498000}, "market": {"mktttlvalue": 601200}},
    "sale": {"amount": {"saleamt": 240000}, "salesearchdate": "2004-06-15"},
    "summary": {"yearbuilt": 1992},
    "owner": {"owner1": {"firstnameandmi": "TIM J", "lastname": "SHAUGHNESSY"},
              "owner2": {"firstnameandmi": "BARBARA", "lastname": "SHAUGHNESSY"}}}]}


@stub.get("/propertyapi/v1.0.0/attomavm/detail")
async def avm(request: Request):
    HITS.append(("avm", request.query_params.get("address1")))
    if request.headers.get("apikey") == "dead-key":
        return JSONResponse({"msg": "unauthorized"}, status_code=401)
    if "nowhere" in (request.query_params.get("address1") or "").lower():
        return JSONResponse({"status": {"msg": "SuccessWithoutResult"}}, status_code=400)
    return AVM


@stub.get("/propertyapi/v1.0.0/property/expandedprofile")
async def profile(request: Request):
    HITS.append(("profile", request.query_params.get("address1")))
    if request.headers.get("apikey") == "dead-key":
        return JSONResponse({"msg": "unauthorized"}, status_code=401)
    if "nowhere" in (request.query_params.get("address1") or "").lower():
        return JSONResponse({"status": {"msg": "SuccessWithoutResult"}}, status_code=400)
    return PROFILE


srv = uvicorn.Server(uvicorn.Config(stub, host="127.0.0.1", port=8749, log_level="error"))
threading.Thread(target=srv.run, daemon=True).start()
for _ in range(80):
    if srv.started:
        break
    time.sleep(0.05)

from webapp import main

TOTAL = [0]
fail = 0


def ck(name, cond, detail=""):
    global fail
    TOTAL[0] += 1
    print(("ok   " if cond else "FAIL ") + name + (("  " + str(detail)[:110]) if detail else ""))
    if not cond:
        fail += 1


c = TestClient(main.app)
main._MEM_SESSIONS["sid-ana"] = {"provider": "google", "identity": "ana@x.com",
                                 "google": {"access_token": "t",
                                            "expires_at": time.time() + 9999}}
c.cookies.set(main.SESSION_COOKIE, "sid-ana")

# --- gates -------------------------------------------------------------------
ck("the feature flag rides the trial key", c.get("/api/me").json()["features"]["attom"] is True)
r = c.post("/api/attom", json={"street": "", "city": "Knoxville", "state": "TN"})
ck("no street address is refused with the fix named",
   r.status_code == 400 and "household" in r.json()["detail"], r.json())

was_key = main.ATTOM_API_KEY
main.ATTOM_API_KEY = ""
r = c.post("/api/attom", json={"street": "1 Main St", "city": "Rye", "state": "NY"})
ck("without the key the route says the trial is off",
   r.status_code == 400 and "trial feature is off" in r.json()["detail"], r.json())
ck("  ...and the flag goes dark with it — the button vanishes cleanly",
   c.get("/api/me").json()["features"]["attom"] is False)
main.ATTOM_API_KEY = was_key

# --- the happy path: AVM first, profile fills the deed ----------------------
r = c.post("/api/attom", json={"street": "926 Crystal Bayou Blvd", "city": "Knoxville",
                               "state": "TN", "zip": "37853"})
d = r.json()
ck("a priced door returns the estimate with its confidence",
   d["found"] and d["avm"] == 612000 and d["avm_score"] == 91, json.dumps(d)[:110])
ck("  ...the range around it", d["avm_low"] == 570000 and d["avm_high"] == 655000)
ck("  ...the sale and the year built ride along",
   d["sale_amount"] == 240000 and d["year_built"] == 1992)
ck("  ...and the deed names both Shaughnessys — the corroboration check",
   len(d.get("owners") or []) == 2 and all("SHAUGHNESSY" in o for o in d["owners"]), d.get("owners"))
ck("  ...one call to each endpoint, no more",
   [h[0] for h in HITS] == ["avm", "profile"], HITS)

# --- the cache: trial budget is never spent twice on one door ---------------
HITS.clear()
r = c.post("/api/attom", json={"street": "926 Crystal Bayou Blvd", "city": "Knoxville",
                               "state": "TN", "zip": "37853"})
ck("the second ask is answered from the cache", r.json().get("cached") is True)
ck("  ...with zero calls to Attom", HITS == [], HITS)

# --- a miss is an answer -----------------------------------------------------
HITS.clear()
r = c.post("/api/attom", json={"street": "9 Nowhere Ln", "city": "Rye", "state": "NY"})
d = r.json()
ck("no property comes back as found:false with a reason, not an error",
   r.status_code == 200 and d["found"] is False and "No property" in d["reason"], d)
HITS.clear()
r = c.post("/api/attom", json={"street": "9 Nowhere Ln", "city": "Rye", "state": "NY"})
ck("  ...and the miss is remembered too — no second spend on an empty door",
   r.json().get("cached") is True and HITS == [], HITS)

# --- a dead key says what it means ------------------------------------------
main.ATTOM_API_KEY = "dead-key"
r = c.post("/api/attom", json={"street": "5 Elm St", "city": "Rye", "state": "NY"})
ck("a rejected key names the likely cause — the trial ended",
   r.status_code == 502 and "trial may have ended" in r.json()["detail"], r.json())
main.ATTOM_API_KEY = was_key

print(("\nFAILURES: %d of %d" % (fail, TOTAL[0])) if fail else "\nall %d checks passed" % TOTAL[0])
sys.exit(1 if fail else 0)
