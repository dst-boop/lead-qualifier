"""One allowance per person, and the promise that nothing pays twice.

"For now, each user gets 100 credits from whitepages per month."
"Each user MUST have a own ZoomInfo subscription."

So there are two ceilings on WhitePages and they answer different questions:
your own hundred, which resets on the first, and the firm's pool, which needs
an admin to raise. Telling a user "the allowance is spent" without saying whose
sends half of them to the wrong place.

ZoomInfo has no ceiling here at all. Every user brings their own subscription,
so the app counts usage — for reconciling against their own dashboard — and
never pretends to hold a pool it does not have.

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
                  WHITEPAGES_MONTHLY_CREDITS="5", WHITEPAGES_USER_CREDITS="3",
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


def client(email):
    """A signed-in browser for one advisor.

    The session carries the address, which is how a paid lookup names its
    spender without a round trip to the identity provider for every credit.
    """
    tc = TestClient(main.app, base_url="http://127.0.0.1:8724", follow_redirects=False)
    sid = "sid-" + email
    main._MEM_SESSIONS[sid] = {"provider": "google", "identity": email,
                               "google": {"access_token": "t",
                                          "expires_at": time.time() + 9999}}
    tc.cookies.set(main.SESSION_COOKIE, sid)
    return tc


c = client("dan@fpa.com")

MONTH = main._month()

# --- the allowance is visible before anything is spent ------------------------
r = c.get("/api/credits")
d = r.json()
ck("the allowances are readable", r.status_code == 200, r.text[:120])
ck("  ...the budget shown is the USER's, not the firm's",
   d["whitepages"]["budget"] == 3, d["whitepages"])
ck("  ...with the firm's pool alongside it",
   d["whitepages"]["firm_budget"] == 5, d["whitepages"])
ck("  ...ZoomInfo is their own subscription, not an allowance of ours",
   d["zoominfo"] == {"used": 0, "own_subscription": True}, d["zoominfo"])
ck("  ...nothing spent yet", d["whitepages"]["left"] == 3)
ck("  ...and it says when the pool refills",
   d["resets_on"] > MONTH and d["resets_on"].endswith("-01"), d["resets_on"])
ck("signed out cannot read the budget",
   TestClient(main.app, base_url="http://127.0.0.1:8724").get("/api/credits").status_code == 401)

# --- a lookup spends exactly one, and is counted where it happens -------------
r = c.post("/api/verify-phone", json={"phone": "2065550142"})
ck("a phone check answers", r.status_code == 200, r.text[:120])
ck("  ...having called the vendor once", HITS["n"] == 1, HITS["n"])
ck("  ...and charged exactly one credit, to the person who spent it",
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

# --- your own hundred stops you, and says it was yours ------------------------
STORE[(main.FS_LEDGER, MONTH + "|dan@fpa.com")] = {"wp": 3}
STORE[(main.FS_LEDGER, MONTH)] = {"wp": 3}
main._WP_CACHE.clear()
before = HITS["n"]
r = c.post("/api/verify-phone", json={"phone": "2125550001"})
ck("with YOUR allowance spent, a new lookup is refused", r.status_code == 400, r.status_code)
ck("  ...before anything reaches the vendor", HITS["n"] == before, HITS["n"])
msg = r.json()["detail"]
ck("  ...saying the exhausted allowance was yours, so you know to wait",
   "your WhitePages lookups" in msg and "3" in msg, msg)
ck("  ...with the date it comes back",
   "reset" in msg and "Nothing was looked up" in msg, msg)
ck("  ...and pointing at the sources that are still free",
   "Enrich all (free)" in msg, msg)

# --- the firm's pool stops you differently, and says so ----------------------
# You have room; the firm does not. Waiting for the first of the month is the
# wrong advice here — an admin has to raise it.
STORE[(main.FS_LEDGER, MONTH + "|dan@fpa.com")] = {"wp": 0}
STORE[(main.FS_LEDGER, MONTH)] = {"wp": 5}
main._WP_CACHE.clear()
r = c.post("/api/verify-phone", json={"phone": "2125550002"})
ck("the firm's pool refuses even when you have your own left",
   r.status_code == 400, r.status_code)
fmsg = r.json()["detail"]
ck("  ...and says it was the FIRM's, not yours",
   "firm" in fmsg and "you have 3 of your own left" in fmsg, fmsg)
ck("  ...naming the fix that actually works: an admin", "admin can raise it" in fmsg, fmsg)

# --- one user's spending does not touch another's ----------------------------
STORE.clear()
main._WP_CACHE.clear()
dan, ada = client("dan@fpa.com"), client("ada@fpa.com")
dan.post("/api/verify-phone", json={"phone": "2065551111"})
dan.post("/api/verify-phone", json={"phone": "2065552222"})
ck("one advisor's lookups are charged to them",
   dan.get("/api/credits").json()["whitepages"]["spent"] == 2,
   dan.get("/api/credits").json()["whitepages"])
ck("  ...and leave a colleague's allowance untouched",
   ada.get("/api/credits").json()["whitepages"]["spent"] == 0
   and ada.get("/api/credits").json()["whitepages"]["left"] == 3,
   ada.get("/api/credits").json()["whitepages"])
ck("  ...while both count against the firm's pool",
   (firm := STORE.get((main.FS_LEDGER, MONTH), {})).get("wp") == 2, firm)
dan.post("/api/verify-phone", json={"phone": "2065553333"})
r = dan.post("/api/verify-phone", json={"phone": "2065554444"})
ck("the fourth lookup exhausts that advisor at their own limit",
   r.status_code == 400 and "your WhitePages lookups" in r.json()["detail"],
   r.json().get("detail"))
r = ada.post("/api/verify-phone", json={"phone": "2065555555"})
ck("  ...and the colleague can still work, from their own hundred",
   r.status_code == 200, r.status_code)

# --- but an answer already paid for is still served when the allowance is gone
# Dan is exhausted at this point. One of the numbers he already paid for must
# still answer: it costs nothing, and refusing it would punish him for the
# app's own bookkeeping.
before2 = HITS["n"]
r = dan.post("/api/verify-phone", json={"phone": "2065551111"})
ck("a cached answer still works with the allowance spent — it costs nothing",
   r.status_code == 200 and HITS["n"] == before2, (r.status_code, HITS["n"] - before2))

# --- ZoomInfo: their subscription, so usage is counted and nothing is capped --
STORE.clear()
r = c.post("/api/credits", json={"kind": "zi", "n": 8})
ck("the app records what it ran on the user's own subscription",
   r.status_code == 200 and r.json()["used"] == 8, r.text[:120])
ck("  ...and says whose subscription it was", r.json()["own_subscription"] is True, r.json())
ck("  ...with no allowance of ours attached to it", "left" not in r.json(), r.json())
r = c.post("/api/credits", json={"kind": "zi", "n": 4})
ck("  ...usage accumulates rather than replaces", r.json()["used"] == 12, r.json())
ck("a huge ZoomInfo month is NOT refused — the ceiling is theirs, not ours",
   c.post("/api/credits", json={"kind": "zi", "n": 5000}).status_code == 200)
ck("WhitePages cannot be self-reported: the server counts what it spends",
   c.post("/api/credits", json={"kind": "wp", "n": 50}).status_code == 400)
ck("  ...and says why", "counted where it is spent" in
   c.post("/api/credits", json={"kind": "wp", "n": 50}).json()["detail"])
ck("a nonsense kind is refused",
   c.post("/api/credits", json={"kind": "bitcoin", "n": 5}).status_code == 400)
ck("a negative report cannot invent usage",
   c.post("/api/credits", json={"kind": "zi", "n": -100}).json()["used"] == 5012)

# --- the budget rides on /api/me, so a page load costs no extra request -------
me = c.get("/api/me").json()
ck("/api/me carries the budget", bool(me.get("credits")), list(me.keys()))
ck("  ...as the signed-in person's own, not the firm's",
   me["credits"]["whitepages"]["budget"] == 3, me.get("credits"))
ck("  ...and ZoomInfo as a subscription rather than an allowance",
   me["credits"]["zoominfo"]["own_subscription"] is True
   and "budget" not in me["credits"]["zoominfo"], me["credits"].get("zoominfo"))
ck("  ...and how long an answer is remembered for",
   me["credits"]["cache_days"] == round(main.WP_TTL / 86400), me["credits"].get("cache_days"))

# --- the month is a boundary, not a running total ----------------------------
ck("the ledger is keyed by calendar month", any(
   k[1] == MONTH for k in STORE if k[0] == main.FS_LEDGER),
   [k[1] for k in STORE if k[0] == main.FS_LEDGER])
ck("  ...and by month-and-person for the per-user half", any(
   k[1].startswith(MONTH + "|") for k in STORE if k[0] == main.FS_LEDGER),
   [k[1] for k in STORE if k[0] == main.FS_LEDGER])
y, m = (int(x) for x in MONTH.split("-"))
ck("  ...and the reset date is the first of the next one",
   main._month_resets() == (f"{y + 1:04d}-01-01" if m == 12 else f"{y:04d}-{m + 1:02d}-01"),
   main._month_resets())

# --- the allowance must not be skippable by having an old cookie -------------
# A session created before the identity stamp shipped carries no name, and
# sessions last thirty days. The per-user cap then applied to everyone EXCEPT
# those users, which is precisely backwards — they were handed the firm's whole
# pool as their personal allowance.
ck("a session predating the identity stamp still knows who it is",
   main._identity({"provider": "google",
                   "google": {"email": "Dan@FPA.com", "refresh_token": "r"}})
   == "dan@fpa.com")
ck("  ...and a password account is unaffected by that fallback",
   main._identity({"provider": "password", "account_email": "pat@anywhere.com",
                   "google": {"email": "other@gmail.com"}}) == "pat@anywhere.com")

import asyncio  # noqa: E402
STORE.clear()
unnamed = asyncio.run(main._wp_left(""))
ck("a spender who cannot be named gets ONE allowance, not the firm's pool",
   unnamed["mine"] == 3, unnamed)
ck("  ...and is flagged as unnamed rather than silently trusted",
   unnamed["named"] is False, unnamed)
ck("  ...while a named one is marked as such",
   asyncio.run(main._wp_left("dan@fpa.com"))["named"] is True)
asyncio.run(main._ledger_add("wp", 3, ""))
ck("  ...and their spending lands in a bucket that can run out",
   asyncio.run(main._wp_left(""))["mine"] == 0,
   asyncio.run(main._wp_left("")))
ck("  ...without touching a named colleague's hundred",
   asyncio.run(main._wp_left("ada@fpa.com"))["mine"] == 3)
block = asyncio.run(main._credit_block(""))
ck("the panel never shows more left than the budget it is measured against",
   block["whitepages"]["yours_left"] <= block["whitepages"]["budget"],
   block["whitepages"])

print()
print(f"FAILURES: {bad} of {n}" if bad else f"all {n} checks passed")
sys.exit(1 if bad else 0)
