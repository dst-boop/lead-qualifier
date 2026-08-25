"""'edgar API does not work.'

Five words, no status code, no body — because the debug endpoint, whose one
job is showing what the upstream actually said, answered failures with an
exception page. wp-debug learned this lesson already: when the SEC refuses,
the refusal itself is the diagnostic. These tests hold /api/free-debug to
that standard for every way the EDGAR half can fail:

  - the User-Agent is not configured (the likely cause on this deployment,
    whose own signals panel printed "Not checked: officer-departure filings")
  - the SEC returns 403 (the automated-tool rejection)
  - the SEC returns something that is not JSON
  - and, for symmetry, the FEC half failing

Every one must come back as readable JSON that names the fix, never as a
stack trace summarised by a user as "does not work".
"""
import os, sys, threading, time

os.environ["NO_PROXY"] = os.environ["no_proxy"] = "127.0.0.1,localhost"
for k in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"):
    os.environ.pop(k, None)

STUB = "http://127.0.0.1:8741"
os.environ.update(APP_BASE_URL="http://127.0.0.1:8740", USE_FIRESTORE="0")

import uvicorn
from fastapi import FastAPI, Response

stub = FastAPI()
MODE = {"efts": "ok", "fec": "ok"}
COUNT = {"efts": 0}

EFTS_OK = {"hits": {"total": {"value": 1}, "hits": [
    {"_source": {"display_names": ["Melter Janet K (CIK 0009999999)",
                                   "BOEING CO (BA) (CIK 0000012927)"],
                 "root_forms": ["4"], "file_date": "2025-11-03",
                 "ciks": ["0000012927"], "adsh": "0000320193-24-000005"}}]}}


@stub.get("/LATEST/search-index")
async def efts(q: str = "", forms: str = ""):
    COUNT["efts"] += 1
    # Seen live: identical query, 200 with results, then 500 minutes later.
    if MODE["efts"] == "flaky" and COUNT["efts"] % 2 == 1:
        return Response(status_code=500, content='{"message": "Internal server error"}',
                        media_type="application/json")
    if MODE["efts"] == "403":
        return Response(status_code=403,
                        content="<html>Your Request Originates from an Undeclared "
                                "Automated Tool</html>", media_type="text/html")
    if MODE["efts"] == "html":
        return Response(status_code=200, content="<html>maintenance</html>",
                        media_type="text/html")
    return EFTS_OK


@stub.get("/v1/schedules/schedule_a/")
async def fec():
    if MODE["fec"] == "403":
        return Response(status_code=403, content='{"error":"API_KEY_INVALID"}',
                        media_type="application/json")
    return {"results": [], "pagination": {"count": 0}}


threading.Thread(target=lambda: uvicorn.run(stub, host="127.0.0.1", port=8741,
                                            log_level="error"), daemon=True).start()
time.sleep(1.5)

sys.path.insert(0, os.path.abspath("."))
from webapp import main                                        # noqa: E402
from fastapi.testclient import TestClient                      # noqa: E402

main.EFTS_URL = STUB + "/LATEST/search-index"
main.FEC_API_BASE = STUB + "/v1"

n = bad = 0


def ck(name, cond, d=""):
    global n, bad
    n += 1
    print(("ok   " if cond else "FAIL ") + name + ("  " + str(d) if d else ""))
    if not cond:
        bad += 1


c = TestClient(main.app, base_url="http://127.0.0.1:8740", follow_redirects=False)
main._MEM_SESSIONS["sid"] = {"provider": "google",
                             "google": {"access_token": "at", "expires_at": time.time() + 9999}}
c.cookies.set(main.SESSION_COOKIE, "sid")

# --- the reported case: no User-Agent configured -----------------------------
main.EDGAR_USER_AGENT = ""
r = c.get("/api/free-debug", params={"source": "efts", "name": "Janet Melter"})
ck("with no User-Agent the answer is 200 JSON, not an exception page",
   r.status_code == 200, r.status_code)
d = r.json()
ck("  ...that says the variable by name", "EDGAR_USER_AGENT" in d.get("error", ""), d)
ck("  ...says where to set it", "Cloud Run" in d.get("error", ""))
ck("  ...shows an example value with a contact email", "@" in d.get("error", ""))
ck("  ...and states ua_set plainly", d.get("ua_set") is False)

r = c.post("/api/free-enrich", json={"first_name": "Janet", "last_name": "Melter"})
ck("free-enrich stays graceful too: edgar reported as not run",
   r.json()["sources"]["edgar"]["ran"] is False)
ck("  ...with the reason", "EDGAR_USER_AGENT" in r.json()["sources"]["edgar"]["reason"])

# --- the SEC saying no -------------------------------------------------------
main.EDGAR_USER_AGENT = "Financial Planners of America dst@financialplannersofamerica.com"
MODE["efts"] = "403"
d = c.get("/api/free-debug", params={"source": "efts", "name": "Janet Melter"}).json()
ck("a 403 comes back with its status visible", d.get("status") == 403, d)
ck("  ...the SEC's own words shown verbatim",
   "Undeclared Automated Tool" in d.get("body", ""), d.get("body", "")[:60])
ck("  ...and the explanation names the usual cause",
   "User-Agent" in d.get("error", ""))

MODE["efts"] = "html"
d = c.get("/api/free-debug", params={"source": "efts", "name": "Janet Melter"}).json()
ck("a non-JSON 200 is shown, not parsed into a crash",
   d.get("status") == 200 and "maintenance" in d.get("body", ""), d)

# --- and when it works, it works --------------------------------------------
MODE["efts"] = "ok"
d = c.get("/api/free-debug", params={"source": "efts", "name": "Janet Melter"}).json()
ck("a good answer carries the census", any("display_names" in f for f in d.get("fields", [])),
   (d.get("fields") or [])[:2])
# EDGAR writes people surname-first ("COOK TIMOTHY D"), so the query must NOT
# be a quoted phrase — a phrase is order-sensitive and misses real officers.
ck("  ...and the query is unquoted, because filings write names surname-first",
   "%22" not in d.get("url", "") and 'q=Janet+Melter' in d.get("url", ""), d.get("url"))
ck("  ...and the parsed filings", d.get("read") and d["read"][0]["form"] == "4", d.get("read"))

# --- a transient SEC 500 is retried, not recorded as a gap -------------------
MODE["efts"] = "flaky"
COUNT["efts"] = 0
r = c.post("/api/free-enrich", json={"first_name": "Janet", "last_name": "Melter"})
ck("one SEC hiccup does not cost the lead its EDGAR coverage",
   r.json()["sources"]["edgar"]["ran"] is True, r.json()["sources"]["edgar"])
ck("  ...because the request was retried once", COUNT["efts"] == 2, COUNT["efts"])
MODE["efts"] = "ok"

# --- the FEC half held to the same standard ----------------------------------
MODE["fec"] = "403"
d = c.get("/api/free-debug", params={"source": "fec", "name": "Janet Melter"}).json()
ck("an FEC failure is JSON with the reason, not an exception",
   "FEC" in d.get("error", ""), d)
ck("  ...saying which key is in use", d.get("fec_key") in ("DEMO_KEY", "personal"), d.get("fec_key"))

print()
print(f"FAILURES: {bad} of {n}" if bad else f"all {n} checks passed")
sys.exit(1 if bad else 0)
