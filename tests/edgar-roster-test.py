"""One proxy statement, read once, answering for everyone who works there.

"There should be 1 button the user needs to press to enrich leads with All
Free enrichment sources."

Proxy-statement ages were the free source that could not join a list-scale
button: /api/edgar reads a 45,000-token filing to answer about ONE lead, so ten
leads at one employer meant ten readings of one document. This endpoint is the
fix — the document is a table of directors and officers with their ages, so it
is read per employer and matched against every lead who works there.

What has to be true for that to be safe:

- one AI read per company, and none at all for a company that files no proxy or
  is not public (the cheap refusals must stay cheap);
- the second call for the same company must not read anything (the cache), and a
  transient failure must never be cached as an answer;
- an age that cannot be attributed to exactly one person is not reported. Two
  Nguyens on one board is not a puzzle to solve with a coin flip: a wrong age
  silently mis-scores a lead and nobody ever checks it.
"""
import json, os, sys, threading, time

os.environ["NO_PROXY"] = os.environ["no_proxy"] = "127.0.0.1,localhost"
for k in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"):
    os.environ.pop(k, None)

STUB = "http://127.0.0.1:8723"
os.environ.update(EDGAR_USER_AGENT="FPA Lead Qualifier test@example.com",
                  EDGAR_DATA=STUB, EDGAR_WWW=STUB, EDGAR_FTS=STUB,
                  EDGAR_MAX_RPS="20", ANTHROPIC_API_KEY="stub-key",
                  USE_FIRESTORE="0", APP_BASE_URL="http://127.0.0.1:8722")

import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse

stub = FastAPI()
SEEN = {"docs": 0}

TICKERS = {
    "0": {"cik_str": 12927, "ticker": "BA", "title": "The Boeing Company"},
    "1": {"cik_str": 3, "ticker": "ZMS", "title": "Zenith Marine Systems"},
}


@stub.get("/files/company_tickers.json")
async def tickers():
    return TICKERS


@stub.get("/submissions/CIK{cik}.json")
async def subs(cik: str):
    if cik == "0000000003":                      # public, but files no proxy
        return {"filings": {"recent": {"form": ["10-K"], "accessionNumber": ["x"],
                                       "primaryDocument": ["x.htm"],
                                       "filingDate": ["2026-01-01"]}}}
    return {"filings": {"recent": {
        "form": ["DEF 14A"], "accessionNumber": ["0000012927-26-000045"],
        "primaryDocument": ["proxy2026.htm"], "filingDate": ["2026-03-15"]}}}


@stub.get("/Archives/edgar/data/{cik}/{acc}/{doc}")
async def doc(cik: str, acc: str, doc: str):
    SEEN["docs"] += 1
    return HTMLResponse("<html><body>the whole proxy statement</body></html>")


threading.Thread(target=lambda: uvicorn.run(stub, host="127.0.0.1", port=8723,
                                            log_level="error"), daemon=True).start()
time.sleep(1.5)

sys.path.insert(0, os.path.abspath("."))
from webapp import main                                        # noqa: E402
from webapp import freesources                                 # noqa: E402
from fastapi.testclient import TestClient                      # noqa: E402

ROSTER = json.dumps({"people": [
    {"name": "Ellen Whitfield", "age": 63, "title": "Chief Financial Officer"},
    {"name": "Marcus Bell", "age": 58, "title": "Director"},
    {"name": "J. Okonkwo", "age": 47, "title": "Director"},
    # The ambiguous pair: a roster that prints one director's initial and
    # another's full name, both plausibly the lead. This is what the initial
    # match buys and what it costs.
    {"name": "Anh Nguyen", "age": 51, "title": "Director"},
    {"name": "A. Nguyen", "age": 44, "title": "Director"},
    {"name": "Paper Corp", "age": 3, "title": "not a person"},        # dropped: age
    {"name": "", "age": 60, "title": "no name"},                      # dropped: name
]})
CLAUDE = {"reply": ROSTER, "calls": 0, "prompts": [], "boom": False}


class _Block:
    type = "text"

    def __init__(self, t):
        self.text = t


class _Msg:
    stop_reason = "end_turn"

    def __init__(self, t):
        self.content = [_Block(t)]


class _Messages:
    async def create(self, **kw):
        CLAUDE["calls"] += 1
        CLAUDE["prompts"].append(kw["messages"][0]["content"])
        if CLAUDE["boom"]:
            raise main.anthropic.APIError("upstream is having a day")
        return _Msg(CLAUDE["reply"])


class _FakeAnthropic:
    def __init__(self, **kw):
        self.messages = _Messages()


class _FakeAPIError(Exception):
    pass


main.anthropic.AsyncAnthropic = _FakeAnthropic
main.anthropic.APIError = _FakeAPIError

n = bad = 0


def ck(name, cond, d=""):
    global n, bad
    n += 1
    print(("ok   " if cond else "FAIL ") + name + ("  " + str(d) if d else ""))
    if not cond:
        bad += 1


c = TestClient(main.app, base_url="http://127.0.0.1:8722", follow_redirects=False)
main._MEM_SESSIONS["sid"] = {"provider": "google",
                             "google": {"access_token": "t", "expires_at": time.time() + 9999}}
c.cookies.set(main.SESSION_COOKIE, "sid")

PEOPLE = [{"i": 0, "first_name": "Ellen", "last_name": "Whitfield"},
          {"i": 1, "first_name": "Marcus", "last_name": "Bell"},
          {"i": 2, "first_name": "Jerome", "last_name": "Okonkwo"},
          {"i": 3, "first_name": "Priya", "last_name": "Raghunathan"},
          {"i": 4, "first_name": "Anh", "last_name": "Nguyen"}]

# --- signed out is refused ----------------------------------------------------
anon = TestClient(main.app, base_url="http://127.0.0.1:8722")
r = anon.post("/api/edgar-roster", json={"employer": "Boeing", "people": PEOPLE})
ck("signed out is refused", r.status_code == 401, r.status_code)

# --- one read, many answers ---------------------------------------------------
r = c.post("/api/edgar-roster", json={"employer": "Boeing", "people": PEOPLE})
ck("the roster reads", r.status_code == 200, r.text[:140])
d = r.json()
m = d.get("matches") or {}
ck("  ...one AI call for the whole company", CLAUDE["calls"] == 1, CLAUDE["calls"])
ck("  ...and one document fetched, not one per lead", SEEN["docs"] == 1, SEEN["docs"])
ck("  ...the officer is matched", (m.get("0") or {}).get("age") == 63, m.get("0"))
ck("  ...so is a second lead at the same employer", (m.get("1") or {}).get("age") == 58, m.get("1"))
ck("  ...a printed initial still matches a full first name",
   (m.get("2") or {}).get("age") == 47, m.get("2"))
ck("  ...someone not in the proxy gets no age", "3" not in m, m.get("3"))
ck("the title comes back as printed",
   (m.get("0") or {}).get("title") == "Chief Financial Officer", m.get("0"))
ck("  ...dated to the filing year, not to today",
   (m.get("0") or {}).get("as_of") == "2026", m.get("0"))
ck("the company and filing are named for the evidence line",
   (d.get("company") or {}).get("name") == "The Boeing Company"
   and (d.get("filing") or {}).get("url", "").endswith("proxy2026.htm"),
   json.dumps({"c": d.get("company"), "f": d.get("filing")})[:140])

# --- the refusal that matters -------------------------------------------------
ck("TWO Nguyens on one board means NO age for a Nguyen — a coin flip would "
   "silently mis-score the lead", "4" not in m, m.get("4"))

# --- junk rows never become facts ---------------------------------------------
kept = [p["name"] for p in freesources.roster_people(json.loads(ROSTER))]
ck("a company row in the table is not a person (age 3 is a misread table cell)",
   "Paper Corp" not in kept, kept)
ck("  ...and neither is a nameless row", "" not in kept, kept)
ck("  ...the five real people survive", d["roster_size"] == 5, d["roster_size"])

# --- the cache: a proxy is filed once a year ----------------------------------
r2 = c.post("/api/edgar-roster", json={"employer": "boeing co", "people": PEOPLE})
ck("a second call for the same company reads nothing again",
   r2.status_code == 200 and CLAUDE["calls"] == 1 and SEEN["docs"] == 1,
   (CLAUDE["calls"], SEEN["docs"]))
ck("  ...and still answers", ((r2.json().get("matches") or {}).get("0") or {}).get("age") == 63)

# --- the cheap refusals stay cheap --------------------------------------------
r = c.post("/api/edgar-roster", json={"employer": "Hollis & Wray LLP", "people": PEOPLE})
d = r.json()
ck("a private employer is refused without reading anything",
   r.status_code == 200 and d["found"] is False and CLAUDE["calls"] == 1,
   (d.get("reason"), CLAUDE["calls"]))
ck("  ...and says why in words a user can act on",
   "Private employers do not file proxy statements" in d["reason"], d["reason"])
r = c.post("/api/edgar-roster", json={"employer": "Zenith Marine Systems", "people": PEOPLE})
d = r.json()
ck("a public company with no DEF 14A costs no AI call either",
   d["found"] is False and CLAUDE["calls"] == 1, (d.get("reason"), CLAUDE["calls"]))
ck("  ...naming the company and what is missing",
   "Zenith Marine Systems" in d["reason"] and "DEF 14A" in d["reason"], d["reason"])
r = c.post("/api/edgar-roster", json={"employer": "", "people": PEOPLE})
ck("no employer is a 400, not an empty answer", r.status_code == 400, r.status_code)

# --- a transient failure is not an answer, and is never cached ----------------
CLAUDE["boom"] = True
r = c.post("/api/edgar-roster", json={"employer": "Zenith Marine Systems", "people": PEOPLE})
ck("the no-proxy verdict is still cached (it is a fact, not an outage)",
   r.json()["found"] is False and CLAUDE["calls"] == 1, CLAUDE["calls"])
main._SRC_CACHE.pop("proxy:0000012927", None)
r = c.post("/api/edgar-roster", json={"employer": "Boeing", "people": PEOPLE})
ck("an AI outage is a 502, not an empty roster", r.status_code == 502, r.status_code)
CLAUDE["boom"] = False
r = c.post("/api/edgar-roster", json={"employer": "Boeing", "people": PEOPLE})
ck("  ...and nothing was cached, so the next call answers properly",
   ((r.json().get("matches") or {}).get("0") or {}).get("age") == 63, r.text[:120])

# --- what the reader is told --------------------------------------------------
prompt = CLAUDE["prompts"][0]
ck("the prompt asks for everyone with a stated age, not for one person",
   "List every person whose age the document states" in prompt)
ck("  ...and forbids estimating one", "Never estimate an age" in prompt)
ck("  ...naming the cost of being wrong", "silently mis-scores a lead" in prompt)

# --- the matcher, directly ----------------------------------------------------
R = [{"name": "Ellen Whitfield", "age": 63, "title": ""},
     {"name": "Anh Nguyen", "age": 51, "title": ""},
     {"name": "A. Nguyen", "age": 44, "title": ""},
     {"name": "Bao Tran", "age": 44, "title": ""}]
ck("matcher: surname plus first name", freesources.roster_match(R, "Whitfield", "Ellen")["age"] == 63)
ck("matcher: a namesake pair returns nothing", freesources.roster_match(R, "Nguyen", "Anh") is None)
ck("matcher: an unrelated first name is still told apart",
   freesources.roster_match(R, "Tran", "Bao")["age"] == 44)
ck("matcher: no surname, no answer", freesources.roster_match(R, "", "Ellen") is None)
ck("matcher: a wrong first name is not a match",
   freesources.roster_match(R, "Whitfield", "Marcus") is None)
ck("matcher: an unknown surname is not a match",
   freesources.roster_match(R, "Petrosyan", "Ellen") is None)
ck("matcher: an age outside a working life is dropped before matching",
   freesources.roster_people({"people": [{"name": "Ellen Whitfield", "age": 3}]}) == [])
ck("matcher: a non-integer age is dropped",
   freesources.roster_people({"people": [{"name": "E W", "age": "sixty"}]}) == [])
ck("matcher: True is not an age",
   freesources.roster_people({"people": [{"name": "E W", "age": True}]}) == [])

print()
print(f"FAILURES: {bad} of {n}" if bad else f"all {n} checks passed")
sys.exit(1 if bad else 0)
