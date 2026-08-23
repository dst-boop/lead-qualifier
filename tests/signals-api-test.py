"""The signals endpoint against stub feeds.

What this pins down is the cost shape and the failure shape. One EDGAR
round-trip per distinct employer rather than per lead — a list of forty people
at four companies must cost four lookups, not forty. And a source being down
degrades to the signals that do not need it, rather than taking the whole
watchlist with it.
"""
import json, os, sys, threading, time

os.environ["NO_PROXY"] = os.environ["no_proxy"] = "127.0.0.1,localhost"
for k in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"):
    os.environ.pop(k, None)
STUB = "http://127.0.0.1:8745"
WARN_CSV = ("Company Name,City,State,Number of Employees Affected,Layoff Date,Notice Date\n"
            "Cordova Industrial Group,Montclair,NJ,412,12/30/2026,10/01/2026\n")
os.environ.update(
    USE_FIRESTORE="0", APP_BASE_URL="http://127.0.0.1:8126",
    WARN_FEEDS=json.dumps([{"id": "nj", "state": "NJ", "format": "csv", "url": STUB + "/warn.csv"}]),
    SOURCE_MIN_WORKERS="1", EDGAR_USER_AGENT="FPA test dst@example.com")
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import uvicorn
from fastapi import FastAPI
from fastapi.responses import PlainTextResponse
from fastapi.testclient import TestClient

stub = FastAPI()


@stub.get("/warn.csv")
async def warn():
    return PlainTextResponse(WARN_CSV)


threading.Thread(target=lambda: uvicorn.run(stub, host="127.0.0.1", port=8745,
                                            log_level="error"), daemon=True).start()
import httpx
for _ in range(60):
    try:
        if httpx.get(STUB + "/warn.csv", timeout=1).status_code == 200:
            break
    except Exception:
        time.sleep(0.1)

import webapp.main as M

WHO = {"e": "dan@fpa.com"}
CIK_CALLS, EIGHTK_CALLS = [], []


async def em(r):
    return WHO["e"]
M._signed_in_email = em


async def fake_cik(employer):
    CIK_CALLS.append(employer)
    return {"cik": "0000012927", "title": employer} if "boeing" in employer.lower() else None
M._edgar_company_cik = fake_cik


async def fake_8k(cik, within_days=45):
    EIGHTK_CALLS.append(cik)
    return {"url": "https://www.sec.gov/x", "filed": "2026-08-21", "days_ago": 2,
            "accession": "0000012927-26-000045",
            "summary": "Item 5.02 — Chief Financial Officer to retire 31 December"}
M._edgar_recent_8k = fake_8k

c = TestClient(M.app)
YEAR = time.gmtime().tm_year
n = bad = 0


def ck(name, cond, d=""):
    global n, bad
    n += 1
    print(("ok   " if cond else "FAIL ") + name + ("  " + str(d) if d else ""))
    if not cond:
        bad += 1


LEADS = [
    {"id": "a", "firstName": "Marcus", "lastName": "Armstrong", "employer": "Boeing",
     "title": "Chief Operating Officer", "status": "New",
     "edgar": {"age": 60, "asOf": "2026-03"}},
    {"id": "b", "firstName": "Ray", "lastName": "Okonjo", "employer": "Boeing",
     "title": "Senior Manager, Logistics", "status": "New",
     "edgar": {"age": 41, "asOf": "2026-03"}},
    {"id": "c", "firstName": "Elena", "lastName": "Basilio",
     "employer": "Cordova Industrial Group, Inc.", "status": "New"},
    {"id": "d", "firstName": "Jean", "lastName": "Okafor", "employer": "IBM",
     "status": "New", "gradYear": str(YEAR - 38)},
]

r = c.post("/api/signals", json={"leads": LEADS}).json()
kinds = {(s["lead_id"], s["kind"]) for s in r["signals"]}
ck("the WARN employer raises a signal", ("c", "warn") in kinds, sorted(kinds))
ck("the officer-departure filing raises one", ("a", "filing") in kinds, sorted(kinds))
ck("a lead about to turn 59½ raises one", ("d", "age") in kinds, sorted(kinds))
ck("someone past it recently raises one", ("a", "age") in kinds, sorted(kinds))
ck("a 41-year-old manager raises nothing — the 8-K is about one named officer",
   not any(k[0] == "b" for k in kinds), sorted(kinds))
ck("everything is marked new on a first run", all(s["new"] for s in r["signals"]))
ck("  ...and counted", r["new"] == len(r["signals"]), (r["new"], len(r["signals"])))
ck("the WARN signal sorts first", r["signals"][0]["kind"] == "warn",
   [s["kind"] for s in r["signals"]])
ck("  ...carrying the headcount", "412" in r["signals"][0]["headline"], r["signals"][0]["headline"])

ck("one CIK lookup per distinct employer, not per lead",
   len(CIK_CALLS) == 3, CIK_CALLS)
ck("  ...and one 8-K fetch per employer that resolved", len(EIGHTK_CALLS) == 1, EIGHTK_CALLS)

# marking seen
r2 = c.post("/api/signals", json={"leads": LEADS, "mark_seen": True}).json()
ck("marking seen still returns everything", len(r2["signals"]) == len(r["signals"]))
r3 = c.post("/api/signals", json={"leads": LEADS}).json()
ck("a later run marks nothing new", r3["new"] == 0, r3["new"])
ck("  ...but keeps reporting them", len(r3["signals"]) == len(r["signals"]))

LEADS2 = LEADS + [{"id": "e", "firstName": "New", "lastName": "Person", "employer": "Cordova Industrial Group",
                   "status": "New"}]
r4 = c.post("/api/signals", json={"leads": LEADS2}).json()
ck("a newly added lead's signal is new", r4["new"] == 1, r4["new"])
ck("  ...and sorts to the top", r4["signals"][0]["lead_id"] == "e",
   [(s["lead_id"], s["new"]) for s in r4["signals"][:3]])

# what one advisor has seen is not what another has seen
WHO["e"] = "sam@fpa.com"
r5 = c.post("/api/signals", json={"leads": LEADS}).json()
ck("another advisor sees them all as new", r5["new"] == len(r5["signals"]), r5["new"])
WHO["e"] = "dan@fpa.com"

# degrading
M._load_warn = lambda: (_ for _ in ()).throw(RuntimeError("feed down"))
r6 = c.post("/api/signals", json={"leads": LEADS}).json()
ck("a dead WARN feed does not take the watchlist down", r6["signals"], len(r6["signals"]))
ck("  ...the age and filing signals survive",
   {s["kind"] for s in r6["signals"]} >= {"age", "filing"}, {s["kind"] for s in r6["signals"]})
ck("  ...and it says which source is missing",
   any("WARN" in x for x in r6["notes"]), r6["notes"])

M.EDGAR_USER_AGENT = ""
r7 = c.post("/api/signals", json={"leads": LEADS}).json()
ck("no EDGAR key means no filing signals, not an error",
   not any(s["kind"] == "filing" for s in r7["signals"]), {s["kind"] for s in r7["signals"]})
ck("  ...and it says so", any("EDGAR" in x for x in r7["notes"]), r7["notes"])

ck("an empty list is fine", c.post("/api/signals", json={"leads": []}).json()["signals"] == [])
WHO["e"] = ""
ck("signed out gets nothing", c.post("/api/signals", json={"leads": LEADS}).status_code == 401)

print()
print(f"FAILURES {bad} of {n}" if bad else f"all {n} checks passed")
sys.exit(1 if bad else 0)
