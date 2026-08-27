"""WARN x Form 5500 — the money-in-motion join.

None of these hosts is reachable from the environment this was written in, so
what is tested is the parsing, matching and ranking: that a state renaming a
column does not silently import blanks, that two employers whose names collapse
together do not get each other's plan, and that an event with no plan match is
kept rather than dropped.
"""
import os, sys, io, zipfile
from datetime import date

sys.path.insert(0, os.path.abspath("."))
from webapp import prospecting as P                            # noqa: E402

fail = 0
TOTAL = [0]


def ck(name, cond, detail=""):
    global fail
    TOTAL[0] += 1
    print(("ok   " if cond else "FAIL ") + name + ("  " + str(detail) if detail else ""))
    if not cond:
        fail += 1


# --- company normalising -----------------------------------------------------
ck("legal suffixes fall away", P.norm_company("The Boeing Company, Inc.") == "boeing",
   P.norm_company("The Boeing Company, Inc."))
ck("  ...consistently", P.norm_company("BOEING CORP") == P.norm_company("Boeing Corporation"))
ck("distinct names stay distinct",
   P.norm_company("Acme Industrial Corp") != P.norm_company("Acme Marine Corp"))
ck("punctuation is ignored", P.norm_company("A.B.C. Co.") == P.norm_company("ABC"),
   [P.norm_company("A.B.C. Co."), P.norm_company("ABC")])
ck("dotted initialisms join to undotted ones",
   P.norm_company("J.P. Morgan Chase") == P.norm_company("JP Morgan Chase"),
   P.norm_company("J.P. Morgan Chase"))
ck("a name made only of suffix words does not become empty",
   P.norm_company("The Company") != "", P.norm_company("The Company"))

# --- dates, in every shape a state uses --------------------------------------
for raw, want in [("2026-03-15", "2026-03-15"), ("03/15/2026", "2026-03-15"),
                  ("March 15, 2026", "2026-03-15"), ("Mar 15, 2026", "2026-03-15"),
                  ("2026-03-15T00:00:00", "2026-03-15"), ("", None), ("soon", None)]:
    ck(f"date {raw or '(blank)'!r}", P.to_date(raw) == want, P.to_date(raw))

ck("headcount out of prose", P.to_int("approx. 1,240 employees") == 1240, P.to_int("approx. 1,240 employees"))
ck("money out of prose", P.to_money("$82,431,006.55") == 82431006.55, P.to_money("$82,431,006.55"))

# --- WARN CSV, with a state's own column names -------------------------------
CSV = ("Company Name,City,State,Number of Employees Affected,Layoff Date,Notice Date,Notice Type\n"
       "Cordova Industrial Group,Montclair,NJ,412,06/30/2026,04/01/2026,Closure\n"
       "Halstead Marine LLC,Portland,ME,58,07/15/2026,05/02/2026,Mass Layoff\n"
       ",,,,,,\n"
       "Zenith Systems Inc,Newark,NJ,,08/01/2026,06/01/2026,Layoff\n")
w = P.parse_warn_csv(CSV)
ck("every real row is read", len(w["events"]) == 3, len(w["events"]))
ck("  ...blank rows are not", all(e["employer"] for e in w["events"]))
ck("employer column matched", w["mapped"]["employer"] == "Company Name", w["mapped"]["employer"])
ck("headcount column matched", w["mapped"]["workers"] == "Number of Employees Affected", w["mapped"]["workers"])
ck("  ...and parsed", w["events"][0]["workers"] == 412, w["events"][0]["workers"])
ck("effective date matched, not notice date",
   w["mapped"]["effective_date"] == "Layoff Date" and w["mapped"]["notice_date"] == "Notice Date",
   [w["mapped"]["effective_date"], w["mapped"]["notice_date"]])
ck("  ...and normalised", w["events"][0]["effective_date"] == "2026-06-30", w["events"][0]["effective_date"])
ck("a missing headcount is None, not zero", w["events"][2]["workers"] is None, w["events"][2]["workers"])
# county and reason are genuinely absent from this fixture, and saying so is the
# correct behaviour — what matters is that nothing load-bearing is missing.
REQUIRED_WARN = {"employer", "workers", "effective_date", "state"}
ck("every load-bearing WARN column is mapped",
   REQUIRED_WARN.isdisjoint(w["unmapped"]), w["unmapped"])
ck("  ...and the optional ones are reported absent rather than blank-filled",
   set(w["unmapped"]) <= {"county", "reason", "notice_date"}, w["unmapped"])

# a state that names its columns differently must still work
CSV2 = ("Employer,Site City,ST,Impacted Workers,Effective Date,Received Date\n"
        "Ridgeline Capital,Stamford,CT,90,2026-09-01,2026-07-01\n")
w2 = P.parse_warn_csv(CSV2)
ck("different column names still match", len(w2["events"]) == 1 and w2["events"][0]["workers"] == 90,
   w2["mapped"])
ck("  ...and an absent column is reported, not silently blank",
   "reason" in w2["unmapped"] and "county" in w2["unmapped"], w2["unmapped"])

# a feed with no recognisable employer column must say so rather than import junk
w3 = P.parse_warn_csv("Foo,Bar\n1,2\n")
ck("an unrecognisable feed yields nothing and names the gap",
   w3["events"] == [] and "employer" in w3["unmapped"], w3["unmapped"])

# JSON feeds (Socrata-shaped)
w4 = P.parse_warn_json([
    {"company": "Cordova Industrial Group", "city": "Montclair", "state": "NJ",
     "number_of_employees_affected": "412", "layoff_date": "2026-06-30T00:00:00"}])
ck("JSON feeds parse the same way",
   len(w4["events"]) == 1 and w4["events"][0]["workers"] == 412
   and w4["events"][0]["effective_date"] == "2026-06-30", w4["events"])

# --- Form 5500 ----------------------------------------------------------------
PLANS = ("SPONS_DFE_EIN,SPONSOR_DFE_NAME,PLAN_NAME,SPONS_DFE_MAIL_US_STATE,TOT_PARTCP_BOY_CNT,TOT_ASSETS_EOY_AMT,FORM_TAX_PRD\n"
         "221234567,CORDOVA INDUSTRIAL GROUP INC,Cordova 401(k) Plan,NJ,940,82431006.55,2025-12-31\n"
         "221234567,CORDOVA INDUSTRIAL GROUP INC,Cordova Health Plan,NJ,940,120000.00,2025-12-31\n"
         "060999888,RIDGELINE CAPITAL LLC,Ridgeline Savings Plan,CT,210,31500000.00,2025-12-31\n"
         "990111222,FARAWAY MANUFACTURING CO,Faraway 401(k),TX,5000,900000000.00,2025-12-31\n")
pl = P.parse_5500_csv(PLANS, states={"NJ", "CT"})
ck("plans index by normalised sponsor", "cordova industrial" in pl["plans"], list(pl["plans"]))
ck("out-of-state sponsors are filtered out", "faraway manufacturing" not in pl["plans"], list(pl["plans"]))
c = pl["plans"]["cordova industrial"]
ck("the largest plan wins, not the last seen", c["assets"] == 82431006.55, c["assets"])
ck("  ...average balance is computed", c["avg_balance"] == round(82431006.55 / 940), c["avg_balance"])
ck("EIN is carried", c["ein"] == "221234567", c["ein"])
REQUIRED_PLAN = {"name", "state", "participants", "assets"}
ck("every load-bearing 5500 column is mapped",
   REQUIRED_PLAN.isdisjoint(pl["unmapped"]), pl["unmapped"])
ck("  ...with only the optional ones absent",
   # ack_id is optional here for the same reason assets is not: a file that
   # already carries assets needs no join back to a schedule.
   set(pl["unmapped"]) <= {"plan_type", "plan_year", "ein", "plan_name", "ack_id"},
   pl["unmapped"])

# zipped, the way the DOL ships it
buf = io.BytesIO()
with zipfile.ZipFile(buf, "w") as z:
    z.writestr("readme.txt", "notes")
    z.writestr("f_5500_2025_latest.csv", PLANS)
got = P.unzip_first_csv(buf.getvalue(), "f_5500")
ck("the right CSV is pulled from the archive", got.startswith("SPONS_DFE_EIN"), got[:20])

# --- the join -----------------------------------------------------------------
TODAY = date(2026, 5, 1)
opps = P.build_opportunities(w["events"] + w2["events"], pl["plans"], today=TODAY)
by = {o["employer_key"]: o for o in opps}

ck("a matched employer is priced", by["cordova industrial"]["dollars_in_motion"] ==
   round(round(82431006.55 / 940) * 412), by["cordova industrial"]["dollars_in_motion"])
ck("  ...and carries the plan detail",
   by["cordova industrial"]["plan_participants"] == 940 and by["cordova industrial"]["ein"] == "221234567")
ck("  ...with days until the date", by["cordova industrial"]["days_until"] == 60,
   by["cordova industrial"]["days_until"])
ck("an unmatched employer is KEPT, not dropped", "halstead marine" in by, list(by))
ck("  ...and flagged as unmatched", by["halstead marine"]["plan_matched"] is False)
ck("  ...with no invented dollar figure", by["halstead marine"]["dollars_in_motion"] is None)
ck("biggest money sorts first", opps[0]["employer_key"] == "cordova industrial", opps[0]["employer"])
ck("an event with no headcount still appears", "zenith systems" in by)

# state and size filters
ck("state filter applies",
   {o["employer_key"] for o in P.build_opportunities(w["events"] + w2["events"], pl["plans"],
                                                     states={"NJ"}, today=TODAY)}
   == {"cordova industrial", "zenith systems"})
ck("minimum headcount applies",
   [o["employer_key"] for o in P.build_opportunities(w["events"], pl["plans"],
                                                     min_workers=100, today=TODAY)]
   == ["cordova industrial"])

# the ambiguity rule, restated for this join
amb = P.parse_5500_csv(
    "SPONSOR_DFE_NAME,SPONS_DFE_MAIL_US_STATE,TOT_PARTCP_BOY_CNT,TOT_ASSETS_EOY_AMT\n"
    "ACME INDUSTRIAL CORP,NJ,100,1000000\n"
    "ACME INDUSTRIAL HOLDINGS,NJ,200,9000000\n", states={"NJ"})
ck("two sponsors that normalise alike collapse to one key",
   len(amb["plans"]) == 1, list(amb["plans"]))
ck("  ...and it is the larger plan, which is the one a rollover comes from",
   amb["plans"]["acme industrial"]["assets"] == 9000000.0, amb["plans"]["acme industrial"]["assets"])

ck("ids are stable across rebuilds",
   P.build_opportunities(w["events"], pl["plans"], today=TODAY)[0]["id"]
   == P.build_opportunities(w["events"], pl["plans"], today=TODAY)[0]["id"])

# --- against a real New York WARN file --------------------------------------
# The header below is verbatim from New York's published WARN data. Everything
# in this block was written after running the parser over the real file and
# finding it returned an effective date for none of the fifty rows: NY files
# "Layoff Date" as prose and puts the date in "Closing Date". A null effective
# date is not cosmetic — it is the field the sixty-days-early premise rests on.
NY_HDR = ("Company,Business Type,County,Total Employees,Number Affected,Date of Notice,"
          "Layoff Date,Closing Date,Reason for Dislocation,Classification,"
          "Reason Stated for Filing,Union,Contact,Phone,FEIN NUM,Event Number,Case_ID")
NY_ROWS = [
    # the ordinary case: prose in Layoff Date, a real date in Closing Date
    ('"Acitrezza, LLC (Agata & Valentina store) 64 University Place New York, NY 10003",'
     'Specialty Food,New York,59,59,2/11/2021,'
     '"Separations will occur on May 12, 2021 or during the 14-day period beginning on that date.",'
     '5/12/2021,Economic,Plant Closing,Plant Closing,None,X,555,45-1196450,2020-0423,9525'),
    # no closing date, and the prose names exactly one
    ('Halstead Marine LLC 12 Commercial St Portland,Marine,Cumberland,120,58,3/01/2021,'
     '"Six employees will be permanently separated on 5/2/2021.",'
     '-----,Economic,Layoff,Layoff,None,X,555,11-1111111,2021-0001,1'),
    # no closing date, and the prose names several — unresolvable
    ('Ridgeline Capital,Finance,Westchester,300,11,1/15/2021,'
     '"A total of 11 employee separations have been postponed from 1/29/2021 - 2/12/2021 '
     'to 3/17/2021 - 3/31/2021.",'
     '----,Economic,Layoff,Layoff,None,X,555,22-2222222,2021-0002,2'),
    # nothing anywhere
    ('Cordova Industrial Group Inc,Manufacturing,Essex,900,412,4/01/2021,'
     'To be determined,To be determined,Economic,Layoff,Layoff,None,X,555,33-3333333,2021-0003,3'),
]
ny = P.parse_warn_csv(NY_HDR + "\n" + "\n".join(NY_ROWS), "NY")
ev = {e["employer"]: e for e in ny["events"]}

ck("the real NY header maps employer, headcount and notice date",
   ny["mapped"]["employer"] == "Company" and ny["mapped"]["workers"] == "Number Affected"
   and ny["mapped"]["notice_date"] == "Date of Notice", ny["mapped"])
ck("NY publishes no city or state column", set(ny["unmapped"]) == {"city", "state"}, ny["unmapped"])
ck("  ...so the feed's own state fills it in", all(e["state"] == "NY" for e in ny["events"]))

ck("the address glued to the company name is cut off",
   "Acitrezza, LLC (Agata & Valentina store)" in ev, sorted(ev))
ck("  ...leaving a key a plan sponsor could match",
   "university" not in ev["Acitrezza, LLC (Agata & Valentina store)"]["employer_key"],
   ev["Acitrezza, LLC (Agata & Valentina store)"]["employer_key"])
ck("  ...and the original is kept, since it is the only address given",
   "New York, NY 10003" in ev["Acitrezza, LLC (Agata & Valentina store)"]["employer_raw"])

ck("a prose layoff date defers to the real closing date",
   ev["Acitrezza, LLC (Agata & Valentina store)"]["effective_date"] == "2021-05-12",
   ev["Acitrezza, LLC (Agata & Valentina store)"]["effective_date"])
ck("a placeholder closing date falls back to a single date in the prose",
   ev["Halstead Marine LLC"]["effective_date"] == "2021-05-02",
   ev["Halstead Marine LLC"]["effective_date"])
ck("prose naming several dates yields none — no rule picks the right one",
   ev["Ridgeline Capital"]["effective_date"] is None,
   ev["Ridgeline Capital"]["effective_date"])
ck("  ...and the sentence is handed back for a person to read",
   "postponed" in ev["Ridgeline Capital"]["date_note"], ev["Ridgeline Capital"]["date_note"][:60])
ck("no date anywhere is simply no date",
   ev["Cordova Industrial Group Inc"]["effective_date"] is None)
ck("  ...with no invented note either",
   ev["Cordova Industrial Group Inc"]["date_note"] == "",
   ev["Cordova Industrial Group Inc"]["date_note"])

ck("a company name with no address is left alone",
   P.company_from_cell("Michael Page International Inc.") == "Michael Page International Inc.")
ck("  ...and a cut that would leave nothing keeps the original",
   P.company_from_cell("3M") == "3M", P.company_from_cell("3M"))
ck("one date in a sentence is read", P.date_from_prose("separated effective 2/11/2021")[0] == "2021-02-11")
ck("  ...two are refused", P.date_from_prose("from 1/29/2021 to 3/17/2021")[0] is None)
ck("  ...and the sentence comes back instead",
   "1/29/2021" in P.date_from_prose("from 1/29/2021 to 3/17/2021")[1])


# --- county filtering --------------------------------------------------------
# New York's WARN file publishes no city and no state column, only county, so
# county is the only way to work one metro rather than a whole state.

ck("a county name normalises to its bare form", P.norm_county("Nassau County") == "nassau",
   P.norm_county("Nassau County"))
ck("  ...however it is abbreviated", P.norm_county("NASSAU CO.") == P.norm_county("Nassau"))
ck("  ...and a parish or borough is the same thing",
   P.norm_county("Orleans Parish") == "orleans" and P.norm_county("Bronx Borough") == "bronx")
ck("a two-word county keeps both words", P.norm_county("St. Lawrence County") == "st lawrence",
   P.norm_county("St. Lawrence County"))
ck("a county named only by the word county does not become empty",
   P.norm_county("County") != "", P.norm_county("County"))

_LI = [
    {"employer_key": "a", "company": "Alpha", "state": "NY", "county": "Nassau", "workers": 100},
    {"employer_key": "b", "company": "Beta", "state": "NY", "county": "Suffolk County", "workers": 90},
    {"employer_key": "c", "company": "Gamma", "state": "NY", "county": "Erie", "workers": 400},
    {"employer_key": "d", "company": "Delta", "state": "NY", "county": "", "workers": 80},
]
_NJ = {"employer_key": "e", "company": "Eps", "state": "NJ", "county": "Nassau", "workers": 70}


def _keys(opps):
    return sorted(o["employer_key"] for o in opps)


_got = P.build_opportunities(_LI, {}, counties={"nassau", "suffolk"})
ck("a county outside the set is dropped", "c" not in _keys(_got), _keys(_got))
ck("  ...however the feed spells the ones you want", _keys(_got) == ["a", "b", "d"], _keys(_got))
ck("an event with no county is kept, exactly as with no state", "d" in _keys(_got))
ck("no county filter keeps everything", len(P.build_opportunities(_LI, {}, counties=None)) == 4)
ck("an empty county set is not a filter",
   len(P.build_opportunities(_LI, {}, counties=set())) == 4)
ck("state and county filters compose",
   _keys(P.build_opportunities(_LI + [_NJ], {}, states={"NY"}, counties={"nassau"})) == ["a", "d"],
   _keys(P.build_opportunities(_LI + [_NJ], {}, states={"NY"}, counties={"nassau"})))
ck("county filtering does not disturb the dollars-first ranking",
   [o["employer_key"] for o in _got] == ["a", "b", "d"],
   [o["employer_key"] for o in _got])


print(("\nFAILURES: %d of %d" % (fail, TOTAL[0])) if fail else "\nall %d checks passed" % TOTAL[0])
sys.exit(1 if fail else 0)
