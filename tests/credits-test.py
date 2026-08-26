"""Two allowances, and the promise that nothing pays twice for one question.

"Costs MUST be minimized when using paid enrichment. ZoomInfo has 2000 credits
per month. White pages has 1000 credits per month. Use them strategically. Keep
in mind the rules of relooking them up."

Two things were wrong before this. The WhitePages cache — the whole mechanism
by which re-checking a lead costs nothing — lived in process memory, so Cloud
Run recycling the instance (which it does whenever traffic pauses) threw it
away and the same lead cost a second credit the next morning. And the spend
counter reset with it, so the only way to learn the allowance was gone was to
be refused by the vendor.

So: the cache is durable and sealed (it holds dates of birth), the ledger is a
document per calendar month incremented atomically, and the allowance is
checked at the one place a credit is actually spent — which means every caller
is covered without any of them having to remember.
"""
import json, os, sys, threading, time

os.environ["NO_PROXY"] = os.environ["no_proxy"] = "127.0.0.1,localhost"
for k in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"):
    os.environ.pop(k, None)

STUB = "http://127.0.0.1:8725"
os.environ.update(WHITEPAGES_API_KEY="wp-key", WHITEPAGES_BASE_URL=STUB,
                  WHITEPAGES_MONTHLY_CREDITS="5", ZOOMINFO_MONTHLY_CREDITS="20",
                  USE_FIRESTORE="0", APP_BASE_URL="http://127.0.0.1:8724")

import uvicorn
from fastapi import FastAPI, Request

stub = FastAPI()
HITS = {"n": 0}


@stub.get("/userinfo")
async def userinfo():
    return {"name": "Dan", "email": "dan@fpa.com"}


@stub.get("/v2/person")
async def person(request: Request):
    HITS["n"] += 1
    return {"results": [{"id": "p1", "match_score": 90,
                         "name": "Janet Melter", "age": 61,
                         "current_addresses": [{"city": "Kent", "state_code": "WA"}]}]}


threading.Thread(target=lambda: uvicorn.run(stub, host="127.0.0.1", port=8725,
                                            log_level="error"), daemon=True).start()
time.sleep(1.5)

sys.path.insert(0, os.path.abspath("."))
from webapp import main                                        # noqa: E402
from fastapi.testclient import TestClient                      # noqa: E402

main.GOOGLE_USERINFO_URL = STUB + "/userinfo"

# Stand-in Firestore: the point of this suite is what survives a restart, and
# without a backing store there is nothing to survive into.
STORE = {}
_orig = (main._fs_get, main._fs_set, main._fs_del)


async def _get(col, key):
    return STORE.get((col, key))


async def _set(col, key, doc):
    STORE[(col, key)] = doc
    return True


async def _del(col, key):
    STORE.pop((col, key), None)
    return True


async def _inc(col, key, deltas):
    cur = STORE.setdefault((col, key), {})
    for f, v in deltas.items():
        cur[f] = int(cur.get(f) or 0) + v
    return True


main._fs_get, main._fs_set, main._fs_del, main._fs_inc = _get, _set, _del, _inc

n = bad = 0


def ck(name, cond, d=""):
    global n, bad
    n += 1
    print(("ok   " if cond else "FAIL ") + name + ("  " + str(d) if d else ""))
    if not cond:
        bad += 1


c = TestClient(main.app, base_url="http://127.0.0.1:8724", follow_redirects=False)
main._MEM_SESSIONS["sid"] = {"provider": "google",
                             "google": {"access_token": "t", "expires_at": time.time() + 9999}}
c.cookies.set(main.SESSION_COOKIE, "sid")

MONTH = main._month()

# --- the allowance is visible before anything is spent ------------------------
r = c.get("/api/credits")
d = r.json()
ck("the allowances are readable", r.status_code == 200, r.text[:120])
ck("  ...WhitePages knows its budget", d["whitepages"]["budget"] == 5, d["whitepages"])
ck("  ...ZoomInfo knows its own", d["zoominfo"]["budget"] == 20, d["zoominfo"])
ck("  ...nothing spent yet", d["whitepages"]["left"] == 5 and d["zoominfo"]["left"] == 20)
ck("  ...and it says when the pool refills",
   d["resets_on"] > MONTH and d["resets_on"].endswith("-01"), d["resets_on"])
ck("signed out cannot read the budget",
   TestClient(main.app, base_url="http://127.0.0.1:8724").get("/api/credits").status_code == 401)

# --- a lookup spends exactly one, and is counted where it happens -------------
r = c.post("/api/verify-phone", json={"phone": "2065550142"})
ck("a phone check answers", r.status_code == 200, r.text[:120])
ck("  ...having called the vendor once", HITS["n"] == 1, HITS["n"])
ck("  ...and charged exactly one credit",
   c.get("/api/credits").json()["whitepages"]["spent"] == 1)

# --- the same question again is free, and does not reach the vendor -----------
r = c.post("/api/verify-phone", json={"phone": "2065550142"})
ck("asking the identical question again still answers", r.status_code == 200)
ck("  ...without calling the vendor", HITS["n"] == 1, HITS["n"])
ck("  ...and without charging for it",
   c.get("/api/credits").json()["whitepages"]["spent"] == 1)

# --- the saving survives the instance recycle that used to destroy it ---------
main._WP_CACHE.clear()                       # what a Cloud Run restart does
r = c.post("/api/verify-phone", json={"phone": "2065550142"})
ck("after a restart the answer is STILL remembered — this is the whole saving",
   r.status_code == 200 and HITS["n"] == 1, HITS["n"])
ck("  ...so the restart cost nothing",
   c.get("/api/credits").json()["whitepages"]["spent"] == 1)
doc = [v for k, v in STORE.items() if k[0] == main.FS_CACHE][0]
ck("  ...stored through the same envelope as sessions, so KMS covers it too",
   ("ct" in doc and "dek" in doc) or "data" in doc, sorted(doc))
ck("  ...and stamped, so the cache window is enforceable at all",
   isinstance(doc.get("at"), float), doc.get("at"))
ck("  ...and it reads back as what was cached",
   main._unseal(doc) is not None, str(main._unseal(doc))[:60])

# --- a stale entry is re-asked, not served forever ---------------------------
key = [k for k in STORE if k[0] == main.FS_CACHE][0]
STORE[key]["at"] = time.time() - (main.WP_TTL + 10)
main._WP_CACHE.clear()
r = c.post("/api/verify-phone", json={"phone": "2065550142"})
ck("an answer older than the cache window is asked again", HITS["n"] == 2, HITS["n"])
ck("  ...and charged for", c.get("/api/credits").json()["whitepages"]["spent"] == 2)

# --- the allowance stops the spending, before the vendor has to --------------
STORE[(main.FS_LEDGER, MONTH)] = {"wp": 5, "zi": 0}
main._WP_CACHE.clear()
before = HITS["n"]
r = c.post("/api/verify-phone", json={"phone": "2125550001"})
ck("with the month's allowance spent, a new lookup is refused",
   r.status_code == 400, r.status_code)
ck("  ...before anything reaches the vendor", HITS["n"] == before, HITS["n"])
msg = r.json()["detail"]
ck("  ...naming the allowance, the reset date, and that nothing was spent",
   "1000" not in msg and "5 lookups" in msg and "resets" in msg
   and "Nothing was looked up" in msg, msg)
ck("  ...and pointing at the sources that are still free",
   "Enrich all (free)" in msg, msg)

# --- but an answer already paid for is still served when the pool is empty ----
r = c.post("/api/verify-phone", json={"phone": "2065550142"})
ck("a cached answer still works with the allowance spent — it costs nothing",
   r.status_code == 200 and HITS["n"] == before, r.status_code)

# --- ZoomInfo: reported by the client, because two routes bypass this server --
STORE[(main.FS_LEDGER, MONTH)] = {"wp": 0, "zi": 0}
r = c.post("/api/credits", json={"kind": "zi", "n": 8})
ck("the app can report what it spent through the user's own connector",
   r.status_code == 200 and r.json()["spent"] == 8, r.text[:120])
ck("  ...and is told what is left", r.json()["left"] == 12, r.json())
r = c.post("/api/credits", json={"kind": "zi", "n": 4})
ck("  ...reports accumulate rather than replace", r.json()["spent"] == 12, r.json())
ck("a nonsense kind is refused",
   c.post("/api/credits", json={"kind": "bitcoin", "n": 5}).status_code == 400)
ck("a negative report cannot give credits back",
   c.post("/api/credits", json={"kind": "zi", "n": -100}).json()["spent"] == 12)
ck("an absurd report is clamped rather than trusted",
   c.post("/api/credits", json={"kind": "zi", "n": 10 ** 9}).json()["spent"] <= 10012)

# --- the budget rides on /api/me, so a page load costs no extra request -------
me = c.get("/api/me").json()
ck("/api/me carries the budget", bool(me.get("credits")), list(me.keys()))
ck("  ...with both pools", me["credits"]["whitepages"]["budget"] == 5
   and me["credits"]["zoominfo"]["budget"] == 20, me.get("credits"))
ck("  ...and how long an answer is remembered for",
   me["credits"]["cache_days"] == round(main.WP_TTL / 86400), me["credits"].get("cache_days"))

# --- the month is a boundary, not a running total ----------------------------
ck("the ledger is keyed by calendar month", (main.FS_LEDGER, MONTH) in STORE,
   [k[1] for k in STORE if k[0] == main.FS_LEDGER])
y, m = (int(x) for x in MONTH.split("-"))
ck("  ...and the reset date is the first of the next one",
   main._month_resets() == (f"{y + 1:04d}-01-01" if m == 12 else f"{y:04d}-{m + 1:02d}-01"),
   main._month_resets())

print()
print(f"FAILURES: {bad} of {n}" if bad else f"all {n} checks passed")
sys.exit(1 if bad else 0)
