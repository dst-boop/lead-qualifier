"""Zero events across 342 leads: nothing happened, or nothing was looked at?

The money-in-motion panel reported "0 events across 342 leads" and then said:

    Nothing moving. Every lead was checked against the WARN feeds, the SEC
    filing index and their own age.

Two of those three were untrue. The deployment had no WARN_FEEDS, so
mass-separation notices were never checked — and unlike EDGAR, which at least
announced its own absence, the WARN path said nothing at all when unconfigured.
The third ran but had nothing to work with if no lead carries an age.

On a watchlist, silence mistaken for an all-clear is the most expensive kind of
wrong this app can be. Zero events is good news only for the checks that ran, so
the response now says which ran and over how much.
"""
import os, sys, time

os.environ.update(USE_FIRESTORE="0", APP_BASE_URL="http://127.0.0.1:8740")
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from webapp import main                                        # noqa: E402
from fastapi.testclient import TestClient                      # noqa: E402

n = bad = 0


def ck(name, cond, d=""):
    global n, bad
    n += 1
    print(("ok   " if cond else "FAIL ") + name + ("  " + str(d) if d else ""))
    if not cond:
        bad += 1


c = TestClient(main.app, base_url="http://127.0.0.1:8740", follow_redirects=False)
main._MEM_SESSIONS["sid"] = {
    "provider": "google",
    "google": {"access_token": "at", "expires_at": time.time() + 9999},
}
c.cookies.set(main.SESSION_COOKIE, "sid")


# Who is signed in is settled by a round trip to the provider, which is not
# what this file is about. Same stand-in the other signals suite uses.
async def _who(_request):
    return "dst@financialplannersofamerica.com"


main._signed_in_email = _who

Y = time.gmtime().tm_year
NO_AGE = [{"id": f"L{i}", "firstName": "A", "lastName": "B", "employer": "Boeing",
           "status": "New"} for i in range(5)]
WITH_AGE = NO_AGE[:2] + [
    {"id": "X1", "employer": "Boeing", "status": "New",
     "edgar": {"age": 58, "asOf": "2026-01"}},
    {"id": "X2", "employer": "Boeing", "status": "New",
     "hd": {"dob": {"year": Y - 60, "month": 3}}},
]


def sig(leads):
    return c.post("/api/signals", json={"leads": leads}).json()


# --- the unconfigured deployment says so ------------------------------------
main.WARN_FEEDS = ""
main.EDGAR_USER_AGENT = ""
d = sig(NO_AGE)
notes = " ".join(d.get("notes") or [])
ck("with no WARN feeds configured, the response says so", "No WARN feed source is set" in notes, notes)
# EDGAR always announced itself; WARN never did. That asymmetry is the bug.
ck("  ...as EDGAR already did", "EDGAR_USER_AGENT is not set" in notes, notes)
ck("  ...and points at the setup doc", "Money in motion" in notes, notes)

cov = d.get("coverage") or {}
ck("coverage reports that WARN did not run", cov.get("warn") is False, cov)
ck("  ...nor filings", cov.get("filings") is False, cov)
ck("  ...over how many leads", cov.get("leads") == 5, cov)
# The detector that needs nothing configured still needs an age.
ck("  ...and that not one of them had an age to check",
   cov.get("with_age") == 0, cov)
ck("  ...so the zero is honest about being uninformative",
   d.get("signals") == [], d.get("signals"))

# --- ages present ------------------------------------------------------------
d = sig(WITH_AGE)
cov = d["coverage"]
ck("with some ages on file, the count is reported", cov["with_age"] == 2, cov)
ck("  ...of the whole list", cov["leads"] == 4, cov)
# A birth date is a month; an age is a twelve-month band. The panel says which.
ck("  ...and how many carry an actual birth date", cov["with_birth_date"] == 1, cov)

# A lead genuinely near 59.5 still fires — the coverage work must not have
# broken the thing it reports on.
ck("a lead near 59½ still produces an event",
   any(s["kind"] == "age" for s in d["signals"]), d["signals"])

# --- configured ---------------------------------------------------------------
main.EDGAR_USER_AGENT = "Test test@example.com"
d = sig(NO_AGE)
ck("with EDGAR configured the note goes away",
   "EDGAR_USER_AGENT" not in " ".join(d.get("notes") or []), d.get("notes"))
ck("  ...and coverage says the check ran", d["coverage"]["filings"] is True)
ck("  ...while WARN still reports honestly", d["coverage"]["warn"] is False)
main.EDGAR_USER_AGENT = ""

print()
print(f"FAILURES: {bad} of {n}" if bad else f"all {n} checks passed")
sys.exit(1 if bad else 0)
