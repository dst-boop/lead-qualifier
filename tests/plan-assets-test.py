"""Assets, which are not in the file everyone assumes they are in.

The DOL's published layout for f_5500 lists 140 fields. None of them is money:
it carries participant counts and nothing else numeric about the plan. Assets
live on Schedule H (100+ participants) and Schedule I (smaller), separate files
joined on ACK_ID.

Without that join every sponsor comes back with a headcount and no average
balance — so dollars-in-motion cannot be computed, the ranking has nothing to
rank on, and the app looks configured while producing nothing. These checks are
built from the real column names in that layout.
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from webapp import prospecting as P

n = bad = 0


def ck(name, cond, d=""):
    global n, bad
    n += 1
    print(("ok   " if cond else "FAIL ") + name + ("  " + str(d) if d else ""))
    if not cond:
        bad += 1


# Column names verbatim from f_5500_2025_latest_layout.txt
F5500 = (
    "ACK_ID,FORM_TAX_PRD,PLAN_NAME,SPONSOR_DFE_NAME,SPONS_DFE_MAIL_US_STATE,"
    "SPONS_DFE_EIN,TOT_PARTCP_BOY_CNT,TYPE_PENSION_BNFT_CODE\n"
    "20260101A,2025-01-01,Cordova 401(k),CORDOVA INDUSTRIAL GROUP INC,NJ,221234567,940,2E\n"
    "20260101B,2025-01-01,Halstead Savings,HALSTEAD MARINE LLC,ME,060999888,58,2E\n"
    "20260101C,2025-01-01,Ridgeline Plan,RIDGELINE CAPITAL LLC,CT,060111222,210,2E\n")

base = P.parse_5500_csv(F5500)

ck("the real 5500 columns all map except assets",
   set(base["unmapped"]) == {"assets"}, base["unmapped"])
ck("  ...sponsor, state, participants and plan name are found",
   base["mapped"]["name"] == "SPONSOR_DFE_NAME"
   and base["mapped"]["state"] == "SPONS_DFE_MAIL_US_STATE"
   and base["mapped"]["participants"] == "TOT_PARTCP_BOY_CNT"
   and base["mapped"]["plan_name"] == "PLAN_NAME", base["mapped"])
ck("  ...and ACK_ID is kept, which is the only way back to the money",
   base["plans"]["cordova industrial"]["ack_id"] == "20260101A",
   base["plans"]["cordova industrial"].get("ack_id"))
ck("nothing has an average balance yet",
   all(p["avg_balance"] is None for p in base["plans"].values()))

# --- Schedule H --------------------------------------------------------------
SCH_H = ("ACK_ID,TOT_ASSETS_BOY_AMT,TOT_ASSETS_EOY_AMT\n"
         "20260101A,79000000.00,82431006.55\n"
         "20260101C,30000000.00,31500000.00\n")
h = P.parse_schedule_assets(SCH_H)
ck("Schedule H is read", h["kept"] == 2, h)
ck("  ...on the end-of-year figure, which is what the plan is leaving with",
   h["column"] == "TOT_ASSETS_EOY_AMT", h["column"])

rep = P.attach_assets(base["plans"], h["assets"])
ck("assets join back onto the sponsors", rep["filled"] == 2, rep)
ck("  ...and the average balance follows",
   base["plans"]["cordova industrial"]["avg_balance"] == 87693,
   base["plans"]["cordova industrial"]["avg_balance"])
ck("  ...for each of them independently",
   base["plans"]["ridgeline capital"]["avg_balance"] == 150000,
   base["plans"]["ridgeline capital"]["avg_balance"])
ck("a sponsor with no schedule row stays unpriced rather than zero",
   base["plans"]["halstead marine"]["avg_balance"] is None
   and base["plans"]["halstead marine"]["assets"] is None,
   base["plans"]["halstead marine"])

# --- Schedule I, for the small plans ----------------------------------------
SCH_I = "ACK_ID,SMALL_TOT_ASSETS_EOY_AMT\n20260101B,4100000.00\n"
i = P.parse_schedule_assets(SCH_I)
ck("Schedule I's differently-named column is found",
   i["column"] == "SMALL_TOT_ASSETS_EOY_AMT" and i["kept"] == 1, i)
rep2 = P.attach_assets(base["plans"], i["assets"])
ck("  ...and fills the small plan the big schedule missed",
   rep2["filled"] == 1 and base["plans"]["halstead marine"]["avg_balance"] == 70690,
   base["plans"]["halstead marine"]["avg_balance"])
ck("  ...without disturbing what was already priced",
   base["plans"]["cordova industrial"]["avg_balance"] == 87693)

# --- the failure modes -------------------------------------------------------
none_j = P.parse_5500_csv(F5500)
mismatched = P.attach_assets(none_j["plans"], {"WRONG-YEAR-ID": 1.0})
ck("schedule ids from another year join nothing", mismatched["filled"] == 0, mismatched)
ck("  ...and report the sponsor count, so a probe can say 0 of 3",
   mismatched["sponsors"] == 3, mismatched)

noack = P.parse_schedule_assets("TOT_ASSETS_EOY_AMT\n123\n")
ck("a schedule with no ACK_ID is refused, not half-read",
   noack["assets"] == {} and "no ACK_ID" in (noack.get("note") or ""), noack)
noamt = P.parse_schedule_assets("ACK_ID,PLAN_NAME\n20260101A,x\n")
ck("a schedule with no assets column is refused too",
   noamt["assets"] == {}, noamt)
ck("an empty file is not a crash", P.parse_schedule_assets("")["assets"] == {})

dupes = P.parse_schedule_assets(
    "ACK_ID,TOT_ASSETS_EOY_AMT\n20260101A,1000.00\n20260101A,82431006.55\n")
ck("an amended filing keeps the larger figure",
   dupes["assets"]["20260101A"] == 82431006.55, dupes["assets"])

already = P.parse_5500_csv(
    "ACK_ID,SPONSOR_DFE_NAME,TOT_PARTCP_BOY_CNT,TOT_ASSETS_EOY_AMT\n"
    "20260101A,CORDOVA INDUSTRIAL GROUP INC,940,82431006.55\n")
ck("a pre-joined file needs no schedule at all",
   already["plans"]["cordova industrial"]["avg_balance"] == 87693,
   already["plans"]["cordova industrial"]["avg_balance"])
untouched = P.attach_assets(already["plans"], {"20260101A": 1.0})
ck("  ...and is not overwritten by one", untouched["filled"] == 0
   and already["plans"]["cordova industrial"]["assets"] == 82431006.55)

print()
print(f"FAILURES {bad} of {n}" if bad else f"all {n} checks passed")
sys.exit(1 if bad else 0)
