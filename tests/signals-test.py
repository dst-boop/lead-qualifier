"""Money-in-motion signals.

The point of these is that a signal fires once, at the right time, on the right
person — a watchlist that cries wolf is one nobody reads. So most of what is
checked here is the *absence* of a signal: the 45-year-old, the person who
passed 59½ three years ago, the thirty-year veteran who crossed the tenure line
a decade back, and anyone who has already said no.
"""
import os, sys, time
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from webapp import signals as S

NOW = time.time()
YEAR = time.gmtime(NOW).tm_year
n = bad = 0


def ck(name, cond, d=""):
    global n, bad
    n += 1
    print(("ok   " if cond else "FAIL ") + name + ("  " + str(d) if d else ""))
    if not cond:
        bad += 1


def lead(**kw):
    base = {"id": "L1", "firstName": "Ada", "lastName": "Alpha", "employer": "Boeing",
            "status": "New"}
    base.update(kw)
    return base


# --- turning 59.5 -----------------------------------------------------------
s = S.age_signal(lead(edgar={"age": 59.4, "asOf": "2026-03"}), NOW)
ck("someone weeks short of 59½ fires", s is not None and s["kind"] == "age", s)
ck("  ...as approaching, not reached", s and "Turns 59½" in s["headline"], s and s["headline"])
ck("  ...marked confirmed when it came from a filing", s and s["confirmed"] is True)
ck("  ...naming the source", s and "SEC filing" in s["detail"], s and s["detail"])

s = S.age_signal(lead(edgar={"age": 60, "asOf": "2026-03"}), NOW)
ck("someone just past it fires as reached",
   s and "Past 59½" in s["headline"] and s["urgency"] == 1, s and s["headline"])

ck("a 45-year-old does not fire", S.age_signal(lead(edgar={"age": 45, "asOf": "x"}), NOW) is None)
ck("someone 58 is still too far out", S.age_signal(lead(edgar={"age": 58, "asOf": "x"}), NOW) is None)
ck("someone who passed it years ago is not news",
   S.age_signal(lead(edgar={"age": 66, "asOf": "x"}), NOW) is None)
ck("no age at all fires nothing", S.age_signal(lead(), NOW) is None)

inf = S.age_signal(lead(gradYear=str(YEAR - 38)), NOW)
ck("an inferred age can fire", inf is not None, inf)
ck("  ...but is flagged unconfirmed", inf and inf["confirmed"] is False)
ck("  ...and says so in the detail", inf and "inferred" in inf["detail"], inf and inf["detail"])

a1 = S.age_signal(lead(edgar={"age": 59.4, "asOf": "x"}), NOW)
a2 = S.age_signal(lead(edgar={"age": 59.4, "asOf": "x"}), NOW + 5 * 86400)
ck("the id is stable across runs, so 'new' means new", a1["id"] == a2["id"], (a1["id"], a2["id"]))
b1 = S.age_signal(lead(id="L2", edgar={"age": 59.4, "asOf": "x"}), NOW)
ck("  ...and differs per lead", a1["id"] != b1["id"])

# --- tenure ------------------------------------------------------------------
t = S.tenure_signal(lead(yearsAtEmployer="18.4"), 18, NOW)
ck("just past the tenure line fires", t is not None and t["kind"] == "tenure", t)
ck("  ...naming the employer", t and "Boeing" in t["headline"], t and t["headline"])
ck("under the line does not", S.tenure_signal(lead(yearsAtEmployer="12"), 18, NOW) is None)
ck("a 30-year veteran is not a new event",
   S.tenure_signal(lead(yearsAtEmployer="30"), 18, NOW) is None)
ck("an implausible tenure is ignored, not celebrated",
   S.tenure_signal(lead(yearsAtEmployer="126"), 18, NOW) is None)
ck("a start date works when the years column is missing",
   S.tenure_signal(lead(jobStartDate=f"{YEAR-18}-06-01"), 18, NOW) is not None)

# --- WARN --------------------------------------------------------------------
warn = S.index_warn([
    {"id": "w1", "employer": "The Boeing Company, Inc.", "workers": 412, "state": "WA",
     "city": "Renton", "effective_date": "2026-09-30", "days_until": 38, "avg_balance": 87692},
    {"id": "w2", "employer": "Boeing", "workers": 40, "effective_date": "2027-01-01",
     "days_until": 131},
])
ck("WARN employers are matched on a normalised name", "boeing" in warn, list(warn))
ck("  ...and the soonest event wins", warn["boeing"]["id"] == "w1", warn["boeing"]["id"])

w = S.warn_signal(lead(), warn, NOW)
ck("an employer with a WARN notice fires", w is not None and w["kind"] == "warn", w)
ck("  ...at the top urgency", w and w["urgency"] == 0)
ck("  ...naming the headcount", w and "412 people" in w["headline"], w and w["headline"])
ck("  ...the date and the plan average",
   w and "2026-09-30" in w["detail"] and "87,692" in w["detail"], w and w["detail"])
ck("an employer with no notice fires nothing",
   S.warn_signal(lead(employer="Cordova"), warn, NOW) is None)
ck("a lead with no employer fires nothing", S.warn_signal(lead(employer=""), warn, NOW) is None)

# --- 8-K ---------------------------------------------------------------------
fil = {"boeing": {"accession": "0000012927-26-000045", "days_ago": 2,
                  "summary": "Item 5.02 — Kevin Ortberg to retire effective 31 December",
                  "url": "https://www.sec.gov/x"}}
# An item 5.02 concerns one named officer. Firing it at everyone who works
# there is the false positive that makes a watchlist unreadable.
named = S.filing_signal(lead(lastName="Ortberg", title="Chief Executive Officer"), fil)
ck("a lead named in the filing fires", named is not None, named)
ck("  ...at the top urgency", named and named["urgency"] == 0, named and named["urgency"])
ck("  ...as confirmed", named and named["confirmed"] is True)
ck("  ...saying they were named", named and "Named in an 8-K" in named["headline"],
   named and named["headline"])
ck("  ...and linking the filing", named and named["source"].startswith("https://"))

officer = S.filing_signal(lead(lastName="Alpha", title="Chief Financial Officer"), fil)
ck("another officer at the company is offered it", officer is not None, officer)
ck("  ...at a lower urgency", officer and officer["urgency"] == 2, officer and officer["urgency"])
ck("  ...marked unconfirmed", officer and officer["confirmed"] is False)
ck("  ...and hedged in the text",
   officer and "may or may not concern" in officer["detail"], officer and officer["detail"])

ck("a manager two levels down is NOT told about it",
   S.filing_signal(lead(lastName="Alpha", title="Senior Manager, Logistics"), fil) is None)
ck("neither is someone with no title at all",
   S.filing_signal(lead(lastName="Alpha"), fil) is None)
ck("an employer with no filing fires nothing",
   S.filing_signal(lead(employer="Cordova", title="Chief Executive Officer"), fil) is None)

# --- the whole list ----------------------------------------------------------
leads = [
    lead(id="a", firstName="Marcus", title="Chief Operating Officer", edgar={"age": 60, "asOf": "x"}),
    lead(id="b", firstName="Priya", employer="Cordova", edgar={"age": 59.3, "asOf": "x"}),
    lead(id="c", firstName="Tom", employer="Cordova", edgar={"age": 40, "asOf": "x"}),
    lead(id="d", firstName="Jean", edgar={"age": 61, "asOf": "x"}, status="Not Interested"),
    lead(id="e", firstName="Sam", edgar={"age": 60, "asOf": "x"}, status="Has Advisor"),
]
out = S.build_signals(leads, warn, fil, 18, NOW)
ids = {s["lead_id"] for s in out}
ck("someone who said no raises no signal", "d" not in ids and "e" not in ids, sorted(ids))
ck("a 40-year-old at a quiet employer raises none", "c" not in ids, sorted(ids))
ck("the WARN employer sorts first", out[0]["kind"] == "warn", [s["kind"] for s in out])
ck("  ...ahead of the age signals", [s["kind"] for s in out].index("warn") == 0)
ck("every signal carries the person's name",
   all(s.get("name") for s in out), [s.get("name") for s in out])

seen = {s["id"] for s in out}
again = S.build_signals(leads, warn, fil, 18, NOW, seen=seen)
ck("a second run marks nothing new", not any(s["new"] for s in again))
ck("  ...but still reports them", len(again) == len(out), (len(again), len(out)))
leads.append(lead(id="f", firstName="New", employer="Cordova", edgar={"age": 59.4, "asOf": "x"}))
third = S.build_signals(leads, warn, fil, 18, NOW, seen=seen)
newones = [s for s in third if s["new"]]
ck("a genuinely new one is marked", len(newones) == 1 and newones[0]["lead_id"] == "f", newones)
# Same urgency, so the unseen one has to come first — that is the whole point
# of tracking what has been looked at.
same = [s for s in third if s["urgency"] == newones[0]["urgency"]]
ck("  ...and outranks an equally urgent one already seen",
   same[0]["lead_id"] == "f", [(s["lead_id"], s["new"]) for s in same])

ck("an empty list is fine", S.build_signals([], {}, {}, 18, NOW) == [])
# A WARN event matched to an employer here and priced in the prospecting
# module must agree on what counts as the same company, or the two halves of
# the app disagree about one lead. Assert the agreement, not a remembered value.
from webapp import prospecting as P
_cases = ["The Boeing Company, Inc.", "J.P. Morgan", "A.B.C. Co.",
          "Acme Industrial Holdings", "IBM", "", "Halstead Marine LLC"]
ck("company normalisation agrees with the prospecting module",
   all(S.norm_company(c) == P.norm_company(c) for c in _cases),
   [(c, S.norm_company(c), P.norm_company(c)) for c in _cases
    if S.norm_company(c) != P.norm_company(c)])
ck("  ...and still strips suffixes", S.norm_company("The Boeing Company, Inc.") == "boeing")

# --- imported money-in-motion events (WealthFeed and its kind) ---------------
# Verbatim passthrough is the contract: a vendor's event name we never
# anticipated must surface as itself, not vanish in a taxonomy mapping.
s = S.imported_signal(lead(moneyEvent="Sold business to PE firm",
                           moneyEventDate="2026-08-01"), NOW)
ck("an imported event fires", s is not None and s["kind"] == "imported", s)
ck("  ...with the vendor's words as the headline",
   s["headline"] == "Sold business to PE firm")
ck("  ...dated, recent, urgent", s["urgency"] == 1 and s["days"] is not None)
ck("  ...and telling the caller to verify", "verify on the call" in s["detail"].lower(), s["detail"])
s = S.imported_signal(lead(moneyEvent="IPO Lockup Expiry Window Alpha-7"), NOW)
ck("an event from no known taxonomy survives untouched",
   s["headline"] == "IPO Lockup Expiry Window Alpha-7")
ck("  ...undated ranks below dated", s["urgency"] == 2 and s["days"] is None)
ck("  ...and says it is undated", "undated" in s["detail"], s["detail"])
ck("US-style dates read too",
   S.imported_signal(lead(moneyEvent="x", moneyEventDate="08/01/2026"), NOW)["days"] is not None)
ck("a year-old event is not in motion any more",
   S.imported_signal(lead(moneyEvent="Old news", moneyEventDate="2020-01-01"), NOW) is None)
ck("no event, no signal", S.imported_signal(lead(), NOW) is None)
ck("  ...whitespace is no event", S.imported_signal(lead(moneyEvent="   "), NOW) is None)
sigs = S.build_signals([lead(moneyEvent="Inheritance", status="Not Interested")], now=NOW)
ck("someone who said no is skipped even with an event", sigs == [], sigs)
sigs = S.build_signals([lead(moneyEvent="Inheritance", moneyEventDate="2026-08-10")], now=NOW)
ck("build_signals carries it with the lead's name attached",
   any(x["kind"] == "imported" and x["name"] == "Ada Alpha" for x in sigs), sigs[:1])

print()
print(f"FAILURES {bad} of {n}" if bad else f"all {n} checks passed")
sys.exit(1 if bad else 0)
