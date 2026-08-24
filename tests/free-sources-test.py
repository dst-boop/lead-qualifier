"""Free public records: FEC donations and SEC insider filings.

The prompt behind this feature was a lookup that failed: "Why can't we find
this information? He's from Knoxville, TN." The free sources answer a
different half of that question than WhitePages does — the FEC knows where a
person told a federal form they LIVE, which is exactly the field the lead
list gets wrong (it carries the employer's address).

Both parsers were written without a live response — the build environment
cannot reach either host — which is the condition this repo has been wrong
under five times. So these tests hold the defensive line rather than the
happy path: both documented key spellings must read, absence must stay
absent, and above all a namesake's donations must never be attributed to the
lead. A dollar figure that looks looked-up is worse than no figure.
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from webapp import freesources as F

n = bad = 0


def ck(name, cond, d=""):
    global n, bad
    n += 1
    print(("ok   " if cond else "FAIL ") + name + ("  " + str(d) if d else ""))
    if not cond:
        bad += 1


# --- reading rows, in both dialects ------------------------------------------
API = {"results": [
    {"contributor_name": "MELTER, JANET K", "contributor_city": "KNOXVILLE",
     "contributor_state": "tn", "contributor_zip": "379195555",
     "contributor_employer": "Boeing", "contributor_occupation": "Supply Base Manager",
     "contribution_receipt_amount": 500,
     "contribution_receipt_date": "2024-03-15T00:00:00",
     "committee": {"name": "Some PAC"}},
    {"contbr_nm": "Janet Melter", "contbr_city": "knoxville", "contbr_st": "TN",
     "contbr_zip": "37919", "contbr_employer": "RETIRED",
     "contbr_occupation": "RETIRED", "contb_receipt_amt": "1000.00",
     "contb_receipt_dt": "2026-01-02"},
    {"contributor_name": "SMITH, BOB", "contribution_receipt_amount": 50,
     "contribution_receipt_date": "2020-01-01"},
]}
rows = F.fec_rows(API)
ck("the JSON-API spelling reads", rows[0]["employer"] == "Boeing")
ck("  ...and the bulk-file spelling too", rows[1]["amount"] == 1000.0)
ck("the state is normalised", rows[0]["state"] == "TN")
ck("  ...the city titled", rows[0]["city"] == "Knoxville")
ck("  ...the zip cut to five", rows[0]["zip"] == "37919")
ck("  ...the timestamp cut to a day", rows[0]["date"] == "2024-03-15")
ck("a row with nothing invents nothing",
   F.fec_rows({"results": [{}]})[0]["employer"] == "")
ck("an empty payload is an empty list", F.fec_rows({}) == [] and F.fec_rows(None) == [])

# --- the namesake guard ------------------------------------------------------
m = F.match_rows(rows, "Melter", "Janet")
ck("both spellings of her name match", len(m) == 2)
ck("Bob Smith's money is not hers", all("SMITH" not in r["name"].upper() for r in m))
ck("no surname, no matches at all", F.match_rows(rows, "") == [])
ck("a first-name mismatch is refused",
   F.match_rows(rows, "Melter", "Gregory") == [], F.match_rows(rows, "Melter", "Gregory"))
# The lead row says the employer's state. Her donations say Knoxville. If the
# matcher filtered by the lead's state it would discard the real person —
# which is the reported bug, inverted.
ck("rows are NOT filtered by the lead's state", len(F.match_rows(rows, "Melter", "Janet")) == 2)

# --- what the summary says ---------------------------------------------------
s = F.summarize_fec(m, "The Boeing Company, Inc.")
ck("the total is summed", s["total"] == 1500.0)
ck("  ...the largest gift kept", s["biggest"] == 1000.0)
ck("  ...the span dated", s["first"] == "2024-03-15" and s["latest"] == "2026-01-02")
ck("the place is where she gave from", s["places"][0]["value"] == "Knoxville, TN")
ck("  ...counted", s["places"][0]["n"] == 2)
ck("the employer matches the list after normalisation", s["employer_match"] is True)
ck("the timeline survives: Boeing dated, then retired dated later",
   any(e["value"] == "BOEING" and e["last"] == "2024-03-15" for e in s["employers"])
   and any(e["value"] == "RETIRED" and e["last"] == "2026-01-02" for e in s["employers"]))
ck("she told the FEC she is retired — the summary says so", s["says_retired"] is True)
ck("an empty match summarises to nothing at all", F.summarize_fec([]) == {})

lone = F.summarize_fec([rows[0]], "Raytheon")
ck("a different employer is a False, not a silence", lone["employer_match"] is False)
ck("no employer to compare is a None, not a False",
   F.summarize_fec([rows[0]], "")["employer_match"] is None)
junk = F.fec_rows({"results": [{"contributor_name": "MELTER, J",
                                "contributor_employer": "N/A",
                                "contribution_receipt_amount": 250,
                                "contribution_receipt_date": "2023-05-05"}]})
ck('"N/A" is not an employer', F.summarize_fec(F.match_rows(junk, "Melter"))["employers"] == [])

# --- insider filings ---------------------------------------------------------
EFTS = {"hits": {"total": {"value": 2}, "hits": [
    {"_id": "0000320193-24-000005:wk-form4.xml",
     "_source": {"display_names": ["Melter Janet K (CIK 0009999999)",
                                   "BOEING CO (BA) (CIK 0000012927)"],
                 "root_forms": ["4"], "file_date": "2025-11-03",
                 "ciks": ["0000012927"], "adsh": "0000320193-24-000005"}},
    {"_source": {"display_names": ["SMITH JOHN (CIK 0001)"], "root_form": "4",
                 "file_date": "2024-01-01", "ciks": ["0001"],
                 "adsh": "0001-24-000001"}}]}}
hits = F.efts_hits(EFTS)
ck("elasticsearch-shaped hits read", len(hits) == 2)
f = F.match_filings(hits, "Melter", "Janet")
ck("her filing matches, his does not", len(f) == 1 and "Melter" in f[0]["person"])
ck("  ...the company is the OTHER display name", "BOEING" in f[0]["company"])
ck("  ...the form and date survive", f[0]["form"] == "4" and f[0]["date"] == "2025-11-03")
ck("  ...and the link is the SEC's own archive",
   f[0]["url"].startswith("https://www.sec.gov/Archives/edgar/data/12927/"), f[0]["url"])
ck("an empty response is an empty list", F.efts_hits({}) == [] and F.efts_hits(None) == [])
ck("no surname, no filings", F.match_filings(hits, "") == [])
# A surname appearing only in prose would arrive without the person in
# display_names; requiring it there is what keeps this list honest.
prose = F.efts_hits({"hits": {"hits": [{"_source": {
    "display_names": ["ACME CORP (CIK 0002)"], "root_form": "8-K",
    "file_date": "2024-06-01", "ciks": ["0002"], "adsh": "0002-24-000001"}}]}})
ck("a company-only hit does not become an insider filing",
   F.match_filings(prose, "Melter") == [])

print()
print(f"FAILURES: {bad} of {n}" if bad else f"all {n} checks passed")
sys.exit(1 if bad else 0)
