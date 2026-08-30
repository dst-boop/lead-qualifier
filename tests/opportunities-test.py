"""The opportunity endpoints against a stub WARN feed and a stub DOL file.

The real hosts are unreachable from here, so this proves the plumbing: that the
probe reports what came back rather than what was hoped for, that a broken feed
degrades instead of taking the whole refresh down, and that a signed-out visitor
cannot pull the list.
"""
import asyncio, io, json, os, sys, threading, time, zipfile

os.environ["NO_PROXY"] = os.environ["no_proxy"] = "127.0.0.1,localhost"
for k in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"):
    os.environ.pop(k, None)

STUB = "http://127.0.0.1:8741"
WARN_CSV = ("Company Name,City,State,Number of Employees Affected,Layoff Date,Notice Date\n"
            "Cordova Industrial Group,Montclair,NJ,412,06/30/2026,04/01/2026\n"
            "Halstead Marine LLC,Portland,ME,58,07/15/2026,05/02/2026\n"
            "Ridgeline Capital,Stamford,CT,90,09/01/2026,07/01/2026\n")
PLAN_CSV = ("SPONS_DFE_EIN,SPONSOR_DFE_NAME,PLAN_NAME,SPONS_DFE_MAIL_US_STATE,TOT_PARTCP_BOY_CNT,TOT_ASSETS_EOY_AMT\n"
            "221234567,CORDOVA INDUSTRIAL GROUP INC,Cordova 401(k),NJ,940,82431006.55\n"
            "060999888,RIDGELINE CAPITAL LLC,Ridgeline Savings,CT,210,31500000.00\n")

os.environ.update(
    WARN_FEEDS=json.dumps([
        {"id": "nj", "state": "NJ", "format": "csv", "url": STUB + "/warn.csv"},
        {"id": "dead", "state": "XX", "format": "csv", "url": STUB + "/missing.csv"},
    ]),
    FORM5500_URL=STUB + "/f5500.zip",
    SOURCE_STATES="NJ,CT,ME", SOURCE_MIN_WORKERS="25",
    APP_BASE_URL="http://127.0.0.1:8740")

import uvicorn
from fastapi import FastAPI
from fastapi.responses import PlainTextResponse, Response, JSONResponse

stub = FastAPI()
HITS = []


@stub.get("/warn.csv")
async def warn():
    HITS.append("warn")
    return PlainTextResponse(WARN_CSV)


@stub.get("/warn_feeds.json")
async def warn_feeds_json():
    HITS.append("feeds-url")
    return PlainTextResponse(json.dumps(
        [{"id": "nj", "state": "NJ", "format": "csv", "url": STUB + "/warn.csv"}]))


@stub.get("/missing.csv")
async def missing():
    HITS.append("missing")
    return PlainTextResponse("gone", status_code=404)


@stub.get("/f5500.zip")
async def f5500():
    HITS.append("5500")
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("notes.txt", "x")
        z.writestr("f_5500_2025_latest.csv", PLAN_CSV)
    return Response(buf.getvalue(), media_type="application/zip")


threading.Thread(target=lambda: uvicorn.run(stub, host="127.0.0.1", port=8741,
                                            log_level="error"), daemon=True).start()
time.sleep(1.5)

sys.path.insert(0, os.path.abspath("."))
from webapp import main                                        # noqa: E402
from fastapi.testclient import TestClient                      # noqa: E402

fail = 0
TOTAL = [0]


def ck(name, cond, detail=""):
    global fail
    TOTAL[0] += 1
    print(("ok   " if cond else "FAIL ") + name + ("  " + str(detail) if detail else ""))
    if not cond:
        fail += 1


main._MEM_SESSIONS["s1"] = {"provider": "google",
                            "google": {"access_token": "t", "expires_at": time.time() + 9999}}
c = TestClient(main.app, base_url="http://127.0.0.1:8740")
c.cookies.set(main.SESSION_COOKIE, "s1")

# --- access -------------------------------------------------------------------
anon = TestClient(main.app, base_url="http://127.0.0.1:8740")
ck("signed out cannot read opportunities", anon.get("/api/opportunities").status_code == 401)
ck("signed out cannot probe", anon.get("/api/sources/probe").status_code == 401)
ck("signed out cannot refresh", anon.post("/api/sources/refresh").status_code == 401)

# --- probe --------------------------------------------------------------------
r = c.get("/api/sources/probe")
ck("probe succeeds", r.status_code == 200, r.text[:120])
d = r.json()
ck("  ...reports the configured states", d["states"] == ["CT", "ME", "NJ"], d["states"])
feeds = {f["id"]: f for f in d["warn"]["feeds"]}
ck("a working feed reports its event count", feeds["nj"].get("events") == 3, feeds["nj"])
ck("  ...and which column it matched for employer",
   feeds["nj"]["mapped"]["employer"] == "Company Name", feeds["nj"]["mapped"])
ck("a broken feed reports the error, and does not take the probe down",
   "404" in str(feeds["dead"].get("error", "")), feeds["dead"])
ck("the 5500 file is read through the zip", d["form5500"].get("kept") == 2, d["form5500"])
ck("  ...and a sample record comes back so the parser can be checked",
   d["form5500"]["sample"][0].get("avg_balance") is not None, d["form5500"].get("sample"))

# --- refresh ------------------------------------------------------------------
r = c.post("/api/sources/refresh")
ck("refresh succeeds", r.status_code == 200, r.text[:150])
d = r.json()
ck("  ...stores every qualifying event", d["stored"] == 3, d)
ck("  ...and counts the ones priced by a plan", d["matched"] == 2, d)

# --- reading it back ----------------------------------------------------------
r = c.get("/api/opportunities")
d = r.json()
items = {i["employer_key"]: i for i in d["items"]}
ck("the list comes back", d["count"] == 3, d.get("count"))
ck("biggest money first", d["items"][0]["employer_key"] == "cordova industrial",
   d["items"][0]["employer"])
ck("  ...priced from the plan", items["cordova industrial"]["dollars_in_motion"] ==
   round(round(82431006.55 / 940) * 412), items["cordova industrial"]["dollars_in_motion"])
ck("an unmatched employer is kept and flagged",
   items["halstead marine"]["plan_matched"] is False
   and items["halstead marine"]["dollars_in_motion"] is None, items.get("halstead marine"))
ck("the source URL state survives", items["ridgeline capital"]["state"] == "CT")

# --- warmth -------------------------------------------------------------------
# The advisor's own list, posted the same way /api/signals takes it, deciding
# which of these employers is already a door rather than a cold call.

ck("signed out cannot ask for warmth",
   anon.post("/api/opportunities/warmth", json={"leads": []}).status_code == 401)

_LEADS = [
    {"id": "1", "firstName": "Margaret", "lastName": "Halvorsen",
     "employer": "Cordova Industrial Group Inc", "status": "Set"},
    {"id": "2", "firstName": "Daniel", "lastName": "Okonkwo",
     "employer": "Ridgeline Capital LLC", "status": "Called"},
    {"id": "3", "firstName": "Anne", "lastName": "Delacroix",
     "employer": "Halstead Marine", "status": "Has Advisor"},
]
r = c.post("/api/opportunities/warmth", json={"leads": _LEADS, "refresh": True})
ck("warmth endpoint answers", r.status_code == 200, r.text[:160])
d = r.json()
byname = {o["employer"]: o for o in d["items"]}
ck("  ...over the same events the GET route returns", d["count"] == 3, d.get("count"))
ck("a booked meeting marks that employer 'set'",
   byname["Cordova Industrial Group"]["warmth"] == "set",
   byname["Cordova Industrial Group"]["warmth"])
ck("a call in progress marks that employer 'engaged'",
   byname["Ridgeline Capital"]["warmth"] == "engaged", byname["Ridgeline Capital"]["warmth"])
ck("an employer whose only contact has an advisor stays cold",
   byname["Halstead Marine LLC"]["warmth"] == "cold", byname["Halstead Marine LLC"]["warmth"])
ck("  ...with the decline reported rather than hidden",
   byname["Halstead Marine LLC"]["declined_leads"] == 1)
ck("the tally counts each band", d["warmth"] == {"set": 1, "engaged": 1, "cold": 1}, d.get("warmth"))
ck("warmth is the default ordering for this route",
   d["items"][0]["employer"] == "Cordova Industrial Group", d["items"][0]["employer"])

r = c.post("/api/opportunities/warmth", json={"leads": _LEADS, "sort": "dollars"})
_order = [o["employer"] for o in r.json()["items"]]
ck("  ...and dollars ordering is still available",
   _order == ["Cordova Industrial Group", "Ridgeline Capital", "Halstead Marine LLC"], _order)
ck("  ...with the unpriced employer sorting last rather than crashing the sort",
   r.json()["items"][-1]["dollars_in_motion"] is None)

r = c.post("/api/opportunities/warmth", json={"leads": []})
ck("no leads posted leaves every door cold rather than failing",
   all(o["warmth"] == "cold" for o in r.json()["items"]), r.json().get("warmth"))

r = c.get("/api/opportunities")
ck("the GET route is unchanged and carries no warmth",
   "warmth" not in (r.json()["items"][0] if r.json().get("items") else {}))

# --- degrading ----------------------------------------------------------------
main.FORM5500_URL = STUB + "/missing.csv"
r = c.get("/api/opportunities", params={"refresh": "true"})
d = r.json()
ck("a dead 5500 file does not lose the WARN events", d["count"] == 3, d.get("count"))
ck("  ...they are simply unpriced", d["matched"] == 0, d.get("matched"))
main.FORM5500_URL = STUB + "/f5500.zip"

# An empty panel has two very different causes and a new account met the wrong
# answer to both: "see SETUP-prospecting.md", which is neither an explanation
# nor something a user can act on.
main.WARN_FEEDS = ""
r = c.get("/api/opportunities", params={"refresh": "true"})
d = r.json()
ck("nothing configured says who fixes it, not which file to read",
   d["count"] == 0 and "an admin" in d.get("note", "") and ".md" not in d.get("note", ""),
   d.get("note"))
ck("  ...and says the rest of the app does not depend on it",
   "work without it" in d.get("note", ""), d.get("note"))
ck("  ...and flags itself as unconfigured, so the UI need not parse prose",
   d.get("configured") is False, d.get("configured"))

# A variable that was typed and is doing nothing is the worst of the three
# silences: configured from the outside, reporting no layoffs from the inside.
# Reported live as "0 feeds ran and reported no notices", which named neither
# the cause nor the fix.
for bad, want in [("not json at all", "not valid JSON"),
                  ('{"id":"nj"}', "must be a list"),
                  ('[{"id":"nj","state":"NJ"}]', 'none of them carries a "url"')]:
    main.WARN_FEEDS = bad
    feeds, complaint = asyncio.run(main._warn_feeds_checked())
    ck(f"a WARN_FEEDS that {want[:28]} is named, not called empty",
       feeds == [] and want in complaint, complaint[:110])
    r = c.get("/api/opportunities", params={"refresh": "true"})
    ck("  ...and the panel says so rather than 'no notices'",
       want in r.json().get("note", "") and "0 feeds ran" not in r.json().get("note", ""),
       r.json().get("note", "")[:110])
main.WARN_FEEDS = '[{"id":"nj","state":"NJ","format":"csv","url":"' + STUB + '/warn.csv"}]'
ck("a well-formed setting produces no complaint",
   asyncio.run(main._warn_feeds_checked()) == ([{"id": "nj", "state": "NJ", "format": "csv",
                                                 "url": STUB + "/warn.csv"}], ""),
   asyncio.run(main._warn_feeds_checked())[1])
# The URL form: one token, no commas, immune to gcloud's env-var splitting.
main.WARN_FEEDS = STUB + "/warn_feeds.json"
feeds_u, complaint_u = asyncio.run(main._warn_feeds_checked())
ck("WARN_FEEDS may be one URL to a JSON file holding the feed list",
   feeds_u == [{"id": "nj", "state": "NJ", "format": "csv",
                "url": STUB + "/warn.csv"}] and complaint_u == "",
   complaint_u or str(feeds_u)[:80])
main.WARN_FEEDS = STUB + "/warn_feeds_missing.json"
feeds_m, complaint_m = asyncio.run(main._warn_feeds_checked())
ck("  ...and a URL that cannot be fetched is named, not called empty",
   feeds_m == [] and "fetching it failed" in complaint_m, complaint_m[:100])
main.WARN_FEEDS = ""          # back to the unconfigured precondition below
r = c.post("/api/sources/refresh")
ck("  ...and refresh refuses to overwrite with nothing",
   r.json()["stored"] == 0 and "WARN_FEEDS" in r.json().get("note", ""), r.json().get("note"))

print(("\nFAILURES: %d of %d" % (fail, TOTAL[0])) if fail else "\nall %d checks passed" % TOTAL[0])
sys.exit(1 if fail else 0)
