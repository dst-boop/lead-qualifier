"""What a reverse-phone lookup actually returns, and what the app does with it.

Dan looked Janet Melter up on the consumer site and found her month and year of
birth, her other names, her carrier, six typed email addresses, her employer,
and eleven addresses. The API call the app was already making returns a person
record — the same record — and the app read three fields off it: the owner's
name, the line type, and the address. A comment in the code asserted that the
carrier was "not offered by this API", which was an assertion about
documentation, not about data.

So the rule these tests hold to is the one four earlier bugs in this repo were
caused by breaking: read what is there, and when it is not there, say nothing
rather than something. Every field below is optional. A record with none of
them must produce exactly the behaviour the app had before, and a record with
all of them must not manufacture a single value that was not in it.

The date of birth is the one that matters. Every other age in this app is an
integer as of a filing date or a guess from a graduation year; a month and a
year give the exact month a lead reaches 59½, which is the entire question the
campaign turns on.
"""
import os, sys, time
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from webapp import main as M
from webapp import signals as S

n = bad = 0


def ck(name, cond, d=""):
    global n, bad
    n += 1
    print(("ok   " if cond else "FAIL ") + name + ("  " + str(d) if d else ""))
    if not cond:
        bad += 1


NOW = time.time()
TY = time.gmtime(NOW).tm_year
TM = time.gmtime(NOW).tm_mon

# --- date of birth ----------------------------------------------------------
# The site shows "Aug 1970". The field arrives in more than one shape and none
# of them is guaranteed, so each is matched explicitly rather than handed to a
# permissive parser that would read a range as a date.
ck("a dict of parts is read", M._dob({"date_of_birth": {"year": 1970, "month": 8}})
   == {"year": 1970, "month": 8, "day": 0, "text": "Aug 1970"})
ck("  ...with a named month", M._dob({"dob": {"year": 1966, "month": "February"}})["month"] == 2)
ck("  ...and a day when there is one",
   M._dob({"dob": {"year": 1970, "month": 8, "day": 15}})["text"] == "Aug 15, 1970")
ck("an ISO string is read", M._dob({"date_of_birth": "1970-08"})["month"] == 8)
ck("  ...with a day", M._dob({"date_of_birth": "1970-08-15"})["day"] == 15)
ck("a US date is read", M._dob({"date_of_birth": "08/15/1970"}) ==
   {"year": 1970, "month": 8, "day": 15, "text": "Aug 15, 1970"})
ck("  ...month and year alone", M._dob({"date_of_birth": "08/1970"})["month"] == 8)
# 15/08/1970 can only be day-first, because there is no fifteenth month.
ck("  ...and day-first when the first number cannot be a month",
   M._dob({"date_of_birth": "15/08/1970"}) ==
   {"year": 1970, "month": 8, "day": 15, "text": "Aug 15, 1970"})
ck("a written month is read", M._dob({"born": "Aug 1970"})["month"] == 8)
ck("  ...spelled out with a day", M._dob({"born": "August 15, 1970"})["day"] == 15)

# The refusals matter more than the parses.
ck("no date of birth means no date of birth", M._dob({"age": 55}) == {})
ck("  ...and an age range is not one", M._dob({"age_range": "55-59"}) == {})
ck("  ...nor is an empty string", M._dob({"date_of_birth": ""}) == {})
ck("  ...nor a year in the future", M._dob({"date_of_birth": str(TY + 3)}) == {})
ck("  ...nor a year before there were records", M._dob({"date_of_birth": "1823"}) == {})
ck("a bare year is kept but carries no month",
   M._dob({"date_of_birth": "1970"}) == {"year": 1970, "month": 0, "day": 0, "text": "1970"})
ck("an impossible month is dropped, the year kept",
   M._dob({"date_of_birth": {"year": 1970, "month": 19}})["month"] == 0)
ck("garbage is nothing", M._dob({"date_of_birth": "n/a"}) == {})

# --- what a line says about itself ------------------------------------------
LINES = {"phones": [
    {"number": "(206) 555-0142", "line_type": "Mobile", "carrier": "T-Mobile USA",
     "is_prepaid": False, "do_not_call": True, "score": 92, "spam_score": 0},
    {"number": "(206) 555-0177", "type": "Landline", "carrier": "CenturyLink", "score": 40},
    {"number": "(206) 555-0199", "type": "Mobile"},
]}
ph = M._phone_list(LINES)
ck("the carrier is read, not asserted absent", ph[0]["carrier"] == "T-Mobile USA")
ck("  ...on every line that has one", ph[1]["carrier"] == "CenturyLink")
ck("  ...and left empty on one that does not", ph[2]["carrier"] == "")
ck("a do-not-call flag is carried", ph[0]["dnc"] is True)
# The difference between "no" and "not stated" is the whole point of this app's
# treatment of derived values, and DNC is the field where getting it wrong is a
# fine rather than a bad call.
ck("  ...and a line that says nothing about DNC returns None, not False",
   ph[1]["dnc"] is None and ph[2]["dnc"] is None)
ck("prepaid is carried when stated", ph[0]["prepaid"] is False)
ck("  ...and is None when not", ph[1]["prepaid"] is None)
ck("a zero spam score is reported as zero", ph[0]["spam"] == "0")
ck("  ...and silence as silence", ph[1]["spam"] == "")
ck("a worded risk level is passed through as worded",
   M._phone_list({"phones": [{"number": "1", "spam_risk": "High"}]})[0]["spam"] == "High")
ck("mobiles are still picked out by type", M._mobiles(LINES) == ["(206) 555-0142", "(206) 555-0199"])

# --- other names ------------------------------------------------------------
ck("aliases are read", M._aliases({"aliases": ["Janet K Hausfeld", "Janette Melter"]})
   == ["Janet K Hausfeld", "Janette Melter"])
ck("  ...as objects too", M._aliases({"akas": [{"name": "J Melter"}]}) == ["J Melter"])
ck("  ...deduplicated", M._aliases({"aliases": ["A B"], "other_names": ["A B", "C D"]})
   == ["A B", "C D"])
ck("  ...and nothing when there are none", M._aliases({}) == [])

# --- emails keep the thing that distinguishes them ---------------------------
EM = {"emails": [
    {"email": "janet.melter@boeing.com", "type": "Professional"},
    {"email": "jkmelter@yahoo.com", "type": "Personal", "is_recently_used": True},
    "plain@example.com",
]}
recs = M._email_list(EM)
ck("every address is kept", len(recs) == 3)
ck("  ...including a bare string, which the old reader dropped entirely",
   recs[2]["email"] == "plain@example.com")
ck("the type is kept", recs[0]["type"] == "professional")
ck("  ...and the recently-used flag", recs[1]["recent"] is True)
ck("  ...which is None, not False, where it was not stated", recs[0]["recent"] is None)

# --- work -------------------------------------------------------------------
jobs = M._jobs({"job_title": "Supply Base Manager", "company": "Boeing"})
ck("a title and employer on the record are read",
   jobs == [{"title": "Supply Base Manager", "employer": "Boeing"}])
ck("  ...from a history list too",
   M._jobs({"jobs": [{"position": "Buyer", "employer": "Boeing"}]})[0]["title"] == "Buyer")
ck("  ...and nothing when the record has no work on it", M._jobs({}) == [])

# --- one reader, both buttons -----------------------------------------------
PERSON = {
    "name": "Janet Melter", "age": 55, "date_of_birth": {"year": 1970, "month": 8},
    "aliases": ["Janet K Hausfeld"], "job_title": "Supply Base Manager",
    "company": "Boeing", "linkedin_url": "https://linkedin.com/in/x",
    "current_addresses": [{"street_line_1": "14 Alexander Ave", "city": "Renton",
                           "state_code": "WA", "postal_code": "98055"}],
    "phones": LINES["phones"],
    "emails": EM["emails"],
    "result_metadata": {"phones": {"additional": 5}},
}
f = M._person_facts(PERSON)
ck("the record's date of birth reaches the facts", f["dob"]["year"] == 1970)
ck("  ...and its aliases", f["aliases"] == ["Janet K Hausfeld"])
ck("  ...and its work", f["jobs"][0]["employer"] == "Boeing")
ck("  ...and its lines, with what each says", f["phone_records"][0]["carrier"] == "T-Mobile USA")
ck("  ...and its typed emails", f["email_records"][1]["recent"] is True)
ck("a capped list still reports the true total", f["phones_total"] == 8, f["phones_total"])
ck("plain email strings are still offered flat for anything that wants them",
   f["emails"][0] == "janet.melter@boeing.com")
ck("the address still resolves", f["home_city"] == "Renton" and f["home_state"] == "WA")

# A record with none of the new fields must behave exactly as before.
BARE = {"name": "Bob Bare", "phones": [{"number": "2065550100", "type": "Landline"}]}
b = M._person_facts(BARE)
ck("a bare record invents nothing: no date of birth", b["dob"] == {})
ck("  ...no aliases", b["aliases"] == [])
ck("  ...no work", b["jobs"] == [])
ck("  ...no emails", b["emails"] == [] and b["email_records"] == [])
ck("  ...and still the name and the line", b["owner"] == "Bob Bare"
   and b["phone_records"][0]["type"] == "Landline")

# --- the signal, with a real date -------------------------------------------
def at(y, m):
    """A lead born in this month, so the arithmetic can be checked at any date."""
    return {"id": "L1", "employer": "Boeing", "hd": {"dob": {"year": y, "month": m}}}


now_idx = TY * 12 + (TM - 1)
# 59 years and 6 months before this month, exactly.
born_idx = now_idx - (59 * 12 + 6)
this_month = at(born_idx // 12, (born_idx % 12) + 1)
ck("someone who reaches 59½ this month fires",
   (S.age_signal(this_month, NOW) or {}).get("kind") == "age")
ck("  ...saying it is this month", "this month" in S.age_signal(this_month, NOW)["headline"])
ck("  ...as confirmed, because it came from a date and not a guess",
   S.age_signal(this_month, NOW)["confirmed"] is True)
# The record has a month, not a day, and in this one month the day decides.
ck("  ...but admitting the day is not on file",
   "no day of birth" in S.age_signal(this_month, NOW)["detail"],
   S.age_signal(this_month, NOW)["detail"])
ck("  ...and naming the month it came from",
   "Born" in S.age_signal(this_month, NOW)["detail"])

soon_idx = born_idx + 2          # born two months later, so 59½ is two months out
soon = at(soon_idx // 12, (soon_idx % 12) + 1)
s = S.age_signal(soon, NOW)
ck("two months out fires as approaching", s and "Turns 59" in s["headline"], s and s["headline"])
ck("  ...naming the month rather than a number of days",
   s and S.MONTH_NAME[(S.half_month(soon) % 12) + 1] in s["headline"], s and s["headline"])

far = at((born_idx + 8) // 12, ((born_idx + 8) % 12) + 1)
ck("eight months out is not news yet", S.age_signal(far, NOW) is None)
old = at((born_idx - 30) // 12, ((born_idx - 30) % 12) + 1)
ck("someone who passed 59½ years ago is not an event", S.age_signal(old, NOW) is None)
past = at((born_idx - 4) // 12, ((born_idx - 4) % 12) + 1)
s = S.age_signal(past, NOW)
ck("four months past fires as available now", s and "Past 59" in s["headline"], s and s["headline"])
ck("  ...at the top urgency, because the money is movable today", s and s["urgency"] == 0)

# --- the age itself ---------------------------------------------------------
# Born this month: the birthday may or may not have happened, and the record
# does not say which. The age reported is the one they have certainly reached.
same = at(TY - 56, TM)
ck("in the birthday month the age is the one certainly reached, not the higher one",
   S._age_now(same)[0] == 55.0, S._age_now(same))
after = at(TY - 56, TM - 1 if TM > 1 else 12)
ck("a month after the birthday it is the full age",
   S._age_now(at(TY - 56, TM - 1))[0] == 56.0 if TM > 1 else True, S._age_now(after))
ck("  ...and it says where it came from", "born" in S._age_now(same)[1], S._age_now(same)[1])
ck("  ...marked confirmed", S._age_now(same)[2] is True)

# A date of birth outranks everything else on the lead.
mixed = {"id": "L", "hd": {"dob": {"year": TY - 56, "month": TM}, "age": 61},
         "edgar": {"age": 48, "asOf": "2026-01"}, "gradYear": 1985}
ck("a date of birth beats a proxy statement and a household age",
   S._age_now(mixed)[0] == 55.0, S._age_now(mixed))
# Without one, nothing about the old precedence changes.
ck("with no date of birth the old order is untouched",
   S._age_now({"id": "L", "edgar": {"age": 48, "asOf": "2026-01"},
               "hd": {"age": 61}})[0] == 48.0)
ck("a year with no month is a band, not an age",
   S._age_now({"id": "L", "hd": {"dob": {"year": 1970, "month": 0}}})[0] is None)
ck("  ...and fires no dated signal", S.half_month({"hd": {"dob": {"year": 1970}}}) is None)
ck("a string date of birth from an older enrichment still reads",
   S.dob_parts({"hd": {"dob": "1970-08-15"}}) == (1970, 8))
ck("  ...in US order too", S.dob_parts({"hd": {"dob": "08/15/1970"}}) == (1970, 8))
ck("a lead with no household record at all is unaffected",
   S.dob_parts({"id": "L"}) == (0, 0) and S.half_month({"id": "L"}) is None)

# --- the census that closes the loop ----------------------------------------
cens = M._key_census({"results": [PERSON], "metadata": {"n": 1}})
ck("the census names the path to the date of birth",
   any("date_of_birth" in c for c in cens), cens[:3])
ck("  ...and shows the value, so its shape is visible",
   any("1970" in c for c in cens))
ck("  ...describes a list by its length and first item",
   any("phones[] — 3 item(s)" in c for c in cens), [c for c in cens if "phones[]" in c])
ck("  ...and distinguishes a null from an absent key",
   any(c.endswith("= null") for c in M._key_census({"a": None})))

print()
print(f"FAILURES: {bad} of {n}" if bad else f"all {n} checks passed")
sys.exit(1 if bad else 0)
