"""Not spending credits.

"I dont want to waste credits, Prevent multiple whitepages look ups in
unnecessary scenarios. Since not all leads have mobile numbers, Use People
search and the other features available."

The published billing rule is why most of this file exists:

    "successful (2xx) and client-error (4xx) responses are billed;
     throttling (429) and server errors (5xx) are not."

A malformed request costs exactly what a good one costs. Sending "New York"
where a two-letter code is required buys a 400 and a charge. So the tests below
are mostly about calls that must NOT happen: the stub counts every request it
receives, and a passing test usually means that counter did not move.

The second half is the ladder. A lead with no mobile used to fall straight to a
name search, which is the query that returns a stranger with the same surname.
An email address identifies a person nearly as well as a phone number does —
nobody shares one — so it sits between them.
"""
import os, sys, threading, time, urllib.parse

os.environ["NO_PROXY"] = os.environ["no_proxy"] = "127.0.0.1,localhost"
for k in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"):
    os.environ.pop(k, None)

STUB = "http://127.0.0.1:8731"
os.environ.update(APP_BASE_URL="http://127.0.0.1:8730", USE_FIRESTORE="0",
                  WHITEPAGES_CACHE_SECONDS="3600")

import uvicorn
from fastapi import FastAPI, Request

stub = FastAPI()
HITS = {"n": 0, "last": None, "queries": []}
PERSON = {
    "id": "P123", "name": "Janet Melter", "age": 55,
    "date_of_birth": {"year": 1970, "month": 8},
    "aliases": ["Janet K Hausfeld"],
    "current_addresses": [{"street_line_1": "1019 E Laurel St", "city": "Kent",
                           "state_code": "WA", "postal_code": "98030"}],
    "phones": [{"number": "2065550142", "type": "Mobile", "carrier": "T-Mobile USA",
                "score": 95}],
    "emails": [{"email": "jkmelter@yahoo.com", "type": "Personal"}],
    "match_score": 92,
}


@stub.get("/v2/person")
@stub.get("/v2/person/")
async def person(request: Request):
    HITS["n"] += 1
    q = dict(request.query_params)
    HITS["last"] = q
    HITS["queries"].append(q)
    # Answer only the queries that identify her; everything else is a miss.
    if q.get("phone") == "2065550142" or q.get("email") == "jkmelter@yahoo.com" \
       or (q.get("last_name") == "Melter" and q.get("state_code") == "WA"):
        return {"results": [PERSON], "metadata": {"result_count": 1}}
    return {"results": [], "metadata": {"result_count": 0}}


@stub.get("/v2/property/")
async def prop(request: Request):
    HITS["n"] += 1
    HITS["queries"].append(dict(request.query_params) | {"_kind": "property"})
    return {"result": {"ownership_info": {"owner_type": "trust",
                                          "person_owners": [{"name": "Janet Melter"}]}}}


threading.Thread(target=lambda: uvicorn.run(stub, host="127.0.0.1", port=8731,
                                            log_level="error"), daemon=True).start()
time.sleep(1.5)

sys.path.insert(0, os.path.abspath("."))
from webapp import main                                        # noqa: E402
from fastapi.testclient import TestClient                      # noqa: E402

main.WHITEPAGES_API_KEY = "k" * 40
main.WHITEPAGES_BASE_URL = STUB

n = bad = 0


def ck(name, cond, d=""):
    global n, bad
    n += 1
    print(("ok   " if cond else "FAIL ") + name + ("  " + str(d) if d else ""))
    if not cond:
        bad += 1


c = TestClient(main.app, base_url="http://127.0.0.1:8730", follow_redirects=False)
main._MEM_SESSIONS["sid"] = {"provider": "google",
                             "google": {"access_token": "at", "expires_at": time.time() + 9999}}
c.cookies.set(main.SESSION_COOKIE, "sid")


def reset():
    HITS["n"] = 0
    HITS["queries"] = []
    main._WP_CACHE.clear()
    main.WP_SPEND.update(calls=0, served_from_cache=0, refused=0)


# --- refused before it can be billed ----------------------------------------
# Each of these would come back 400, and a 400 is billed.
reset()
BAD = [
    ({"phone": "555"}, "a phone fragment"),
    ({"phone": "not a number"}, "a phone that is not one"),
    ({"email": "jkmelter"}, "an email with no domain"),
    ({"zipcode": "980"}, "a short ZIP"),
    ({"state_code": "New York"}, "a state name where a code is required"),
    ({"state_code": "ZZ"}, "a state that does not exist"),
    ({"name": "J Melter", "last_name": "Melter"}, "name combined with last_name"),
    ({"last_name": "M", "strict_match": "true", "include_fuzzy_matching": "true"},
     "strict and fuzzy together"),
    ({"last_name": "M", "min_age": 12}, "an age under the documented floor"),
    ({"last_name": "M", "max_age": 90}, "an age over the documented ceiling"),
    ({"last_name": "M", "min_age": 60, "max_age": 50}, "a range that is upside down"),
    ({"last_name": "M", "page": 11}, "a page past the documented limit"),
    ({"last_name": "M", "page_size": 50}, "a page size over the limit"),
    ({"last_name": "M", "radius": 500}, "a radius over the limit"),
    ({"city": ""}, "nothing to search on"),
]
for params, why in BAD:
    try:
        main.wp_validate(dict(params))
        ck(f"refuses {why}", False, params)
    except main.WPRefused:
        ck(f"refuses {why}", True)
ck("  ...and none of them reached the network", HITS["n"] == 0, HITS["n"])

# The reason has to name the offending value, or the user cannot fix it.
try:
    main.wp_validate({"state_code": "New York"})
except main.WPRefused as e:
    ck("  ...saying which value was wrong", "New York" in str(e), str(e))

# --- good queries still go ---------------------------------------------------
for params, why in [
    ({"phone": "2065550142"}, "ten bare digits"),
    ({"phone": "(206) 555-0142"}, "a formatted number"),
    ({"phone": "+1-206-555-0142"}, "an international-format US number"),
    ({"email": "jkmelter@yahoo.com"}, "an email"),
    ({"last_name": "Melter", "state_code": "WA"}, "a surname with a state"),
    ({"last_name": "Melter", "min_age": 55, "max_age": 65}, "a legal age band"),
    ({"name": "Janet Melter", "city": "Kent"}, "a full name with a city"),
]:
    try:
        main.wp_validate(dict(params))
        ck(f"allows {why}", True)
    except main.WPRefused as e:
        ck(f"allows {why}", False, e)

# Empty values are dropped, not sent: an empty state_code is a 400, not a
# wildcard.
out = main.wp_validate({"last_name": "Melter", "state_code": "", "city": None})
ck("empty parameters are dropped rather than sent", out == {"last_name": "Melter"}, out)


# --- the same question is asked once ----------------------------------------
reset()
r1 = c.post("/api/verify-phone", json={"phone": "2065550142", "last_name": "Melter"})
ck("a first lookup goes out", HITS["n"] == 1 and r1.json()["owner"] == "Janet Melter",
   (HITS["n"], r1.status_code))
r2 = c.post("/api/verify-phone", json={"phone": "2065550142", "last_name": "Melter"})
ck("the same lookup again is answered from memory", HITS["n"] == 1, HITS["n"])
ck("  ...with the same answer", r2.json()["owner"] == "Janet Melter")
ck("  ...and the saving is counted", main.WP_SPEND["served_from_cache"] == 1,
   main.WP_SPEND)
# The formatting of the number must not create a second cache entry.
r3 = c.post("/api/verify-phone", json={"phone": "(206) 555-0142", "last_name": "Melter"})
ck("the same number written differently is still the same question",
   HITS["n"] == 1, HITS["n"])

# Pressing Verify then Enrich used to buy the same record twice.
reset()
c.post("/api/verify-phone", json={"phone": "2065550142", "last_name": "Melter"})
before = HITS["n"]
e = c.post("/api/enrich", json={"first_name": "Janet", "last_name": "Melter",
                                "phone": "2065550142", "state": "WA"}).json()
ck("Enrich after Verify costs nothing extra", HITS["n"] == before, (before, HITS["n"]))
ck("  ...and still finds her", e.get("found") is True and e["dob"]["year"] == 1970, e.get("dob"))
ck("  ...reporting what it spent", e.get("steps") == ["phone"], e.get("steps"))

# --- a miss is an answer too -------------------------------------------------
reset()
c.post("/api/verify-phone", json={"phone": "2125550001", "last_name": "Nobody"})
ck("a lookup that found nobody still went out", HITS["n"] == 1, HITS["n"])
c.post("/api/verify-phone", json={"phone": "2125550001", "last_name": "Nobody"})
ck("  ...but is not asked twice — 'no such person' was paid for once",
   HITS["n"] == 1, HITS["n"])

# --- the ladder --------------------------------------------------------------
# A lead with no mobile. This used to drop straight to a name search.
reset()
e = c.post("/api/enrich", json={"first_name": "Janet", "last_name": "Melter",
                                "email": "jkmelter@yahoo.com", "state": "WA"}).json()
ck("a lead with no phone is found by email", e.get("found") is True, e)
ck("  ...matched on the email, and it says so", e.get("matched_by") == "email", e.get("matched_by"))
ck("  ...in one call, not two", HITS["n"] == 1, HITS["n"])
ck("  ...and the email query was the one sent",
   HITS["last"].get("email") == "jkmelter@yahoo.com", HITS["last"])

# Phone first when both are present: a number identifies better than an address.
reset()
e = c.post("/api/enrich", json={"first_name": "Janet", "last_name": "Melter",
                                "phone": "2065550142", "email": "jkmelter@yahoo.com",
                                "state": "WA"}).json()
ck("with both, the phone is tried first and the email never spent",
   e.get("steps") == ["phone"] and HITS["n"] == 1, (e.get("steps"), HITS["n"]))

# Falling all the way down costs every rung, and says so.
reset()
e = c.post("/api/enrich", json={"first_name": "Janet", "last_name": "Melter",
                                "phone": "2125550999", "email": "nobody@example.com",
                                "state": "WA"}).json()
ck("a full fall-through tries each rung in order",
   e.get("steps") == ["phone", "email", "name"], e.get("steps"))
ck("  ...and the name query used the individual fields, not the loose one",
   HITS["last"].get("last_name") == "Melter" and "name" not in HITS["last"], HITS["last"])
ck("  ...and still found her at the bottom", e.get("found") is True, e.get("found"))

# A name with nowhere is the query that returns a stranger. Refuse it for free.
reset()
e = c.post("/api/enrich", json={"first_name": "Janet", "last_name": "Melter"}).json()
ck("a name with no location is refused rather than paid for",
   e.get("found") is False and HITS["n"] == 0, (e, HITS["n"]))
ck("  ...saying what to add", "add a location" in (e.get("rejected") or ""), e.get("rejected"))

# --- the property lookup is a second call, so it is asked for ---------------
reset()
e = c.post("/api/enrich", json={"first_name": "Janet", "last_name": "Melter",
                                "phone": "2065550142", "state": "WA"}).json()
ck("Enrich does not buy the property lookup unless asked",
   HITS["n"] == 1 and e.get("property_checked") is False, (HITS["n"], e.get("property_checked")))
reset()
e = c.post("/api/enrich", json={"first_name": "Janet", "last_name": "Melter",
                                "phone": "2065550142", "state": "WA",
                                "want_property": True}).json()
ck("  ...and does when asked", "property" in (e.get("steps") or []), e.get("steps"))
ck("  ...reading the deed", e.get("owner_type") == "trust", e.get("owner_type"))

# --- what it all cost --------------------------------------------------------
reset()
c.post("/api/verify-phone", json={"phone": "2065550142", "last_name": "Melter"})
c.post("/api/verify-phone", json={"phone": "2065550142", "last_name": "Melter"})
c.post("/api/verify-phone", json={"phone": "555", "last_name": "Melter"})
sp = c.get("/api/wp-spend").json()
ck("the spend report counts what was billed", sp["billed_calls"] == 1, sp)
ck("  ...what was saved", sp["answered_from_cache"] == 1, sp)
ck("  ...and what was refused before it could be", sp["refused_before_sending"] == 1, sp)
ck("  ...as a percentage a person can read", sp["saved_pct"] == 50, sp)

# A refusal must reach the user as a refusal, not as a mysterious failure.
r = c.post("/api/verify-phone", json={"phone": "555", "last_name": "Melter"})
ck("a refused lookup says it was not billed",
   "not billed" in r.json().get("detail", ""), r.json())

print()
print(f"FAILURES: {bad} of {n}" if bad else f"all {n} checks passed")
sys.exit(1 if bad else 0)
