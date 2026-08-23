"""Exercise the EDGAR lookup against a stub SEC and a stub Claude.

EDGAR is unreachable from the environment this was written in — the gateway
answers 403 to CONNECT for data.sec.gov, www.sec.gov and efts.sec.gov — so no
live response has ever been seen. What is testable is our half: that the
User-Agent the SEC requires is actually sent, that the rate limit is respected,
that an ambiguous company match returns nothing rather than the wrong company,
and that a missing or implausible age becomes "not found" instead of a number.
"""
import json, os, sys, threading, time, urllib.parse

os.environ["NO_PROXY"] = os.environ["no_proxy"] = "127.0.0.1,localhost"
for k in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"):
    os.environ.pop(k, None)

STUB = "http://127.0.0.1:8721"
os.environ.update(EDGAR_USER_AGENT="FPA Lead Qualifier test@example.com",
                  EDGAR_DATA=STUB, EDGAR_WWW=STUB, EDGAR_FTS=STUB,
                  EDGAR_MAX_RPS="20", ANTHROPIC_API_KEY="stub-key",
                  APP_BASE_URL="http://127.0.0.1:8720")

import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, HTMLResponse

stub = FastAPI()
SEEN = {"agents": [], "urls": [], "times": []}

TICKERS = {
    "0": {"cik_str": 12927, "ticker": "BA", "title": "The Boeing Company"},
    "1": {"cik_str": 320193, "ticker": "AAPL", "title": "Apple Inc."},
    "2": {"cik_str": 1, "ticker": "ACME", "title": "Acme Industrial Corp"},
    "3": {"cik_str": 2, "ticker": "ACMEH", "title": "Acme Industrial Holdings"},
    "4": {"cik_str": 3, "ticker": "ZMS", "title": "Zenith Marine Systems"},
}

@stub.middleware("http")
async def record(request: Request, call_next):
    SEEN["agents"].append(request.headers.get("user-agent"))
    SEEN["urls"].append(str(request.url.path))
    SEEN["times"].append(time.monotonic())
    return await call_next(request)

@stub.get("/files/company_tickers.json")
async def tickers():
    return TICKERS

@stub.get("/submissions/CIK{cik}.json")
async def subs(cik: str):
    if cik == "0000000003":                      # a company with no proxy on file
        return {"filings": {"recent": {"form": ["10-K"], "accessionNumber": ["x"],
                                       "primaryDocument": ["x.htm"], "filingDate": ["2026-01-01"]}}}
    return {"filings": {"recent": {
        "form": ["8-K", "DEF 14A", "10-K"],
        "accessionNumber": ["0000-00-000000", "0000012927-26-000045", "0000-00-000001"],
        "primaryDocument": ["a.htm", "proxy2026.htm", "tenk.htm"],
        "filingDate": ["2026-04-02", "2026-03-15", "2026-02-01"]}}}

@stub.get("/Archives/edgar/data/{cik}/{acc}/{doc}")
async def doc(cik: str, acc: str, doc: str):
    return HTMLResponse("<html><body><style>x{}</style><table>"
                        "<tr><td>Ellen&nbsp;Whitfield</td><td>63</td><td>Chief Financial Officer</td></tr>"
                        "</table></body></html>")

threading.Thread(target=lambda: uvicorn.run(stub, host="127.0.0.1", port=8721,
                                            log_level="error"), daemon=True).start()
time.sleep(1.5)

sys.path.insert(0, os.path.abspath("."))
from webapp import main                                        # noqa: E402
from fastapi.testclient import TestClient                      # noqa: E402

CLAUDE = {"reply": '{"found":true,"age":63,"title":"Chief Financial Officer",'
                   '"as_of":"2026","quote":"Ellen Whitfield 63 Chief Financial Officer"}',
          "prompts": []}

class _Block:
    type = "text"
    def __init__(self, t): self.text = t

class _Msg:
    stop_reason = "end_turn"
    def __init__(self, t): self.content = [_Block(t)]

class _Messages:
    async def create(self, **kw):
        CLAUDE["prompts"].append(kw["messages"][0]["content"])
        return _Msg(CLAUDE["reply"])

class _FakeAnthropic:
    def __init__(self, **kw): self.messages = _Messages()

main.anthropic.AsyncAnthropic = _FakeAnthropic
main.GOOGLE_USERINFO_URL = STUB + "/userinfo"

fail = 0
TOTAL = [0]

def ck(name, cond, detail=""):
    global fail
    TOTAL[0] += 1
    print(("ok   " if cond else "FAIL ") + name + ("  " + str(detail) if detail else ""))
    if not cond:
        fail += 1

def signed_in(sid):
    main._MEM_SESSIONS[sid] = {"provider": "google",
                               "google": {"access_token": "t", "expires_at": time.time() + 9999}}

c = TestClient(main.app, base_url="http://127.0.0.1:8720", follow_redirects=False)
signed_in("sid1")
c.cookies.set(main.SESSION_COOKIE, "sid1")

# --- 1. signed out is refused ------------------------------------------------
anon = TestClient(main.app, base_url="http://127.0.0.1:8720")
r = anon.post("/api/edgar", json={"first_name": "Ellen", "last_name": "Whitfield", "employer": "Boeing"})
ck("signed out is refused", r.status_code == 401, r.status_code)

# --- 2. the happy path -------------------------------------------------------
r = c.post("/api/edgar", json={"first_name": "Ellen", "last_name": "Whitfield", "employer": "Boeing"})
ck("lookup succeeds", r.status_code == 200, r.text[:120])
d = r.json()
ck("  ...finds the age", d.get("found") is True and d.get("age") == 63, json.dumps(d)[:120])
ck("  ...names the company", (d.get("company") or {}).get("name") == "The Boeing Company")
ck("  ...links the actual filing",
   (d.get("filing") or {}).get("url", "").endswith("/Archives/edgar/data/12927/000001292726000045/proxy2026.htm"),
   (d.get("filing") or {}).get("url"))
ck("  ...and quotes where it came from", "Whitfield" in (d.get("quote") or ""), d.get("quote"))

# --- 3. the SEC's own conditions are honoured --------------------------------
ck("every request carries the required User-Agent",
   all(a and "@" in a for a in SEEN["agents"]), SEEN["agents"][:2])
ck("  ...and it is the configured one",
   SEEN["agents"][0] == "FPA Lead Qualifier test@example.com", SEEN["agents"][0])

main.EDGAR_MAX_RPS = 4.0                       # 250ms apart
SEEN["times"].clear()
main._edgar_tickers.clear()
t0 = time.monotonic()
c.post("/api/edgar", json={"first_name": "Ellen", "last_name": "Whitfield", "employer": "Boeing"})
gaps = [b - a for a, b in zip(SEEN["times"], SEEN["times"][1:])]
ck("requests are spaced to stay under the SEC ceiling",
   len(gaps) >= 2 and min(gaps) >= 0.2, [round(g, 3) for g in gaps])
main.EDGAR_MAX_RPS = 20.0

# --- 4. the fussy company match ---------------------------------------------
main._edgar_tickers.clear()
r = c.post("/api/edgar", json={"first_name": "A", "last_name": "B", "employer": "The Boeing Company, Inc."})
ck("legal-suffix noise still matches", r.json().get("found") is not None
   and (r.json().get("company") or {}).get("name") == "The Boeing Company", r.json().get("reason"))

r = c.post("/api/edgar", json={"first_name": "A", "last_name": "B", "employer": "Acme Industrial"})
d = r.json()
ck("an ambiguous employer matches NOTHING", d.get("found") is False and "No public company" in d.get("reason", ""),
   json.dumps(d)[:130])

r = c.post("/api/edgar", json={"first_name": "A", "last_name": "B", "employer": "Treacy Family Partners"})
ck("a private employer says so", r.json().get("found") is False
   and "Private employers" in r.json().get("reason", ""), r.json().get("reason"))

# --- 5. no proxy statement on file ------------------------------------------
r = c.post("/api/edgar", json={"first_name": "A", "last_name": "B", "employer": "Zenith Marine Systems"})
ck("no DEF 14A is reported, not crashed",
   r.json().get("found") is False and "no DEF 14A" in r.json().get("reason", ""), r.json().get("reason"))

# The full legal name is unambiguous even when its short form is not.
main._edgar_tickers.clear(); main._edgar_exact.clear()
r = c.post("/api/edgar", json={"first_name": "A", "last_name": "B", "employer": "Acme Industrial Holdings"})
ck("the full legal name beats the collision",
   (r.json().get("company") or {}).get("name") == "Acme Industrial Holdings", r.json().get("reason"))

# --- 6. a wrong or missing age must never become a score --------------------
CLAUDE["reply"] = '{"found":false,"age":null,"title":null,"as_of":null,"quote":null}'
r = c.post("/api/edgar", json={"first_name": "Nobody", "last_name": "Here", "employer": "Boeing"})
ck("person absent from the filing = not found", r.json().get("found") is False, r.json())
ck("  ...and says why in plain words", "not listed with an age" in r.json().get("reason", ""), r.json().get("reason"))

CLAUDE["reply"] = '{"found":true,"age":7,"title":"CFO","as_of":"2026","quote":"x"}'
r = c.post("/api/edgar", json={"first_name": "A", "last_name": "B", "employer": "Boeing"})
ck("an implausible age is rejected", r.json().get("found") is False and r.json().get("age") is None, r.json())

CLAUDE["reply"] = '{"found":true,"age":"sixty-three","title":"CFO","as_of":"2026","quote":"x"}'
r = c.post("/api/edgar", json={"first_name": "A", "last_name": "B", "employer": "Boeing"})
ck("a non-numeric age is rejected", r.json().get("found") is False, r.json())

CLAUDE["reply"] = "I could not find that person."
r = c.post("/api/edgar", json={"first_name": "A", "last_name": "B", "employer": "Boeing"})
ck("a non-JSON reply is an error, not a silent zero", r.status_code == 502, r.status_code)

# --- 7. the prompt forbids guessing -----------------------------------------
p0 = CLAUDE["prompts"][0]
ck("the prompt bans estimating", "Never estimate" in p0)
ck("  ...and prefers a miss to a guess", "prefer found=false" in p0)
ck("  ...and the markup is stripped before sending", "<table>" not in p0 and "Whitfield" in p0)
ck("  ...including script/style blocks", "<style>" not in p0 and "x{}" not in p0)

# --- 8. configuration ---------------------------------------------------------
CLAUDE["reply"] = '{"found":true,"age":63,"title":"CFO","as_of":"2026","quote":"x"}'
me = c.get("/api/me").json()
ck("/api/me advertises the feature", me["features"]["edgar"] is True, me["features"])

main.EDGAR_USER_AGENT = ""
r = c.post("/api/edgar", json={"first_name": "A", "last_name": "B", "employer": "Boeing"})
ck("no User-Agent configured = loud failure, not a bad request to the SEC",
   r.status_code == 500 and "EDGAR_USER_AGENT" in r.json().get("detail", ""), r.status_code)
ck("  ...and the feature is hidden", c.get("/api/me").json()["features"]["edgar"] is False)
main.EDGAR_USER_AGENT = "FPA Lead Qualifier test@example.com"

r = c.post("/api/edgar", json={"first_name": "", "last_name": "", "employer": "Boeing"})
ck("a nameless lead is refused", r.status_code == 400, r.status_code)
r = c.post("/api/edgar", json={"first_name": "A", "last_name": "B", "employer": ""})
ck("an employerless lead is refused", r.status_code == 400, r.status_code)

print(("\nFAILURES: %d of %d" % (fail, TOTAL[0])) if fail else "\nall %d checks passed" % TOTAL[0])
sys.exit(1 if fail else 0)
