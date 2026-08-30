"""The web-research route's gates and its findings hygiene.

The route itself talks to the Claude API, which this suite cannot reach — what
it CAN prove is everything around that call: the route refuses politely without
a key and without a name, and _clean_web_findings enforces the quoting
discipline so an unsourced value never reaches a screen dressed as a sourced
one. The live-call plumbing follows the same pattern as /api/qc and the site
reader, both already covered.
"""
import os, sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("SESSION_SECRET", "t" * 32)

import time

from fastapi.testclient import TestClient
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

# --- the gates ---------------------------------------------------------------
main.ANTHROPIC_API_KEY = ""
r = c.post("/api/web-research", json={"first_name": "Tim", "last_name": "Shaughnessy"})
ck("without a key the route says which key, not 500",
   r.status_code == 400 and "ANTHROPIC_API_KEY" in r.json()["detail"], r.json())

main.ANTHROPIC_API_KEY = "sk-test-not-real"
r = c.post("/api/web-research", json={"first_name": "Tim", "last_name": ""})
ck("without a last name it refuses before spending a token",
   r.status_code == 400 and "last name" in r.json()["detail"], r.json())
main.ANTHROPIC_API_KEY = ""

# --- the feature flag --------------------------------------------------------
me = c.get("/api/me").json()
ck("web_research flag follows the key", me["features"]["web_research"] is False)
ck("site_reader flag follows the harvest user agent",
   me["features"]["site_reader"] == bool(main.HARVEST_USER_AGENT))

# --- findings hygiene --------------------------------------------------------
clean = main._clean_web_findings

got = clean({
    "summary": "Tim Shaughnessy owns Preferred Construction in Knoxville.",
    "location": {"city": "Knoxville", "state": "tn",
                 "quote": "bring their zeal to the helm ... Knoxville", "url": "https://x.com/a"},
    "age_hints": [{"hint": "over two decades at the helm",
                   "quote": "For over two decades, Tim and Barbara...", "url": "https://x.com/b"}],
    "ages": [{"name": "Tim Shaughnessy", "age": 68, "quote": "Tim, 68, founded...", "url": "https://x.com/c"}],
    "spouse": {"name": "Barbara Shaughnessy", "quote": "Tim and Barb Shaughnessy bring...", "url": "https://x.com/a"},
    "office_phone": {"number": "865-309-5180", "quote": "Contact us", "url": "https://x.com/d"},
    "email_pattern": {"pattern": "first@preferredconstructiontn.com", "quote": "tim@...", "url": "https://x.com/d"},
    "links": {"company_site": "https://preferredconstructiontn.com", "instagram": "https://instagram.com/p",
              "evil": "https://nope", "linkedin": "not-a-url"},
})
ck("a quoted, sourced finding survives", got["location"]["city"] == "Knoxville")
ck("  ...with the state normalised to caps", got["location"]["state"] == "TN")
ck("a printed age survives with its name", got["ages"][0]["age"] == 68 and "Shaughnessy" in got["ages"][0]["name"])
ck("the spouse and the hint ride along", got["spouse"]["name"].startswith("Barbara") and len(got["age_hints"]) == 1)
ck("only known link kinds survive, and only real URLs",
   set(got["links"]) == {"company_site", "instagram"}, got["links"])

got = clean({
    "location": {"city": "Knoxville", "state": "TN"},                       # no quote
    "ages": [{"name": "Tim", "age": 68, "url": "https://x"},                # no quote
             {"name": "Tim", "age": 12, "quote": "q", "url": "https://x"},  # implausible
             {"age": 70, "quote": "q", "url": "https://x"}],                # no name
    "age_hints": [{"hint": "decades", "quote": "q"}],                       # no url
    "office_phone": {"number": "555", "quote": "q", "url": "https://x"},    # too short
    "spouse": {"quote": "q", "url": "https://x"},                           # no name
})
ck("an unquoted location is dropped, not passed through", got["location"] is None)
ck("unquoted, implausible and nameless ages are all dropped", got["ages"] == [])
ck("a hint without a source is dropped", got["age_hints"] == [])
ck("a five-digit phone is not a phone", got["office_phone"] is None)
ck("a nameless spouse is nothing", got["spouse"] is None)

print(("\nFAILURES: %d of %d" % (fail, TOTAL[0])) if fail else "\nall %d checks passed" % TOTAL[0])
sys.exit(1 if fail else 0)
