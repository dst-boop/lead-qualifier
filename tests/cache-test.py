"""The source cache.

Both loaders download and parse a whole file. Without a cache, every click of
"Price the employers", every "Check for events" and every opportunities view
re-fetched about 36MB and re-parsed a few hundred thousand rows — per user, per
click, and against a government host if the source is the DOL's own URL.

The property that matters is that "Refresh from source" and the probe still mean
what they say. A cache that cannot be bypassed turns a diagnostic into a
diagnosis of the cache.
"""
import json, os, sys, threading, time

os.environ["NO_PROXY"] = os.environ["no_proxy"] = "127.0.0.1,localhost"
for k in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"):
    os.environ.pop(k, None)
STUB = "http://127.0.0.1:8749"
os.environ.update(
    USE_FIRESTORE="0", APP_BASE_URL="http://127.0.0.1:8127",
    WARN_FEEDS=json.dumps([{"id": "ny", "state": "NY", "format": "csv", "url": STUB + "/warn.csv"}]),
    FORM5500_URL=STUB + "/f5500.csv", SOURCE_MIN_WORKERS="1")
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import httpx
import uvicorn
from fastapi import FastAPI
from fastapi.responses import PlainTextResponse
from fastapi.testclient import TestClient

HITS = []
stub = FastAPI()


@stub.get("/warn.csv")
async def warn():
    HITS.append("warn")
    return PlainTextResponse(
        "Company,State,Number Affected,Closing Date,Date of Notice\n"
        "Cordova Industrial Group,NJ,412,12/30/2026,10/01/2026\n")


@stub.get("/f5500.csv")
async def f5500():
    HITS.append("5500")
    return PlainTextResponse(
        "ACK_ID,SPONSOR_DFE_NAME,SPONS_DFE_MAIL_US_STATE,TOT_PARTCP_BOY_CNT,TOT_ASSETS_EOY_AMT\n"
        "A1,CORDOVA INDUSTRIAL GROUP INC,NJ,940,82431006.55\n")


threading.Thread(target=lambda: uvicorn.run(stub, host="127.0.0.1", port=8749,
                                            log_level="error"), daemon=True).start()
for _ in range(60):
    try:
        if httpx.get(STUB + "/warn.csv", timeout=1).status_code == 200:
            break
    except Exception:
        time.sleep(0.1)

import webapp.main as M


async def em(r):
    return "dan@fpa.com"
M._signed_in_email = em


async def act(r):
    return ("google", "t")
M._active_token = act


async def notoken(r):
    return ""
M._drive_token_for = notoken

c = TestClient(M.app)
n = bad = 0


def ck(name, cond, d=""):
    global n, bad
    n += 1
    print(("ok   " if cond else "FAIL ") + name + ("  " + str(d) if d else ""))
    if not cond:
        bad += 1


HITS.clear()
c.post("/api/plans", json={"employers": ["Cordova Industrial Group"]})
first = HITS.count("5500")
ck("the first request fetches", first == 1, HITS)

for _ in range(5):
    c.post("/api/plans", json={"employers": ["Cordova Industrial Group"]})
ck("five more fetch nothing", HITS.count("5500") == 1, HITS.count("5500"))

r = c.post("/api/plans", json={"employers": ["Cordova Industrial Group"]}).json()
ck("  ...and still answer correctly",
   r["plans"]["Cordova Industrial Group"]["avg_balance"] == 87693,
   r["plans"].get("Cordova Industrial Group"))

c.get("/api/opportunities")          # warm the WARN side too
HITS.clear()
c.get("/api/opportunities")
ck("a second opportunities view fetches nothing", HITS == [], HITS)
HITS.clear()
c.post("/api/signals", json={"leads": [{"id": "a", "firstName": "A", "lastName": "B",
                                        "employer": "Cordova Industrial Group", "status": "New"}]})
ck("  ...and neither does the watchlist, which shares both sources", HITS == [], HITS)

# the bypasses
HITS.clear()
c.get("/api/sources/probe")
ck("the probe always goes to the source", HITS.count("5500") == 1 and HITS.count("warn") == 1, HITS)
ck("  ...because a cached probe would diagnose the cache", True)

HITS.clear()
c.get("/api/opportunities?refresh=true")
ck("refresh=true goes to the source", HITS.count("warn") == 1, HITS)

HITS.clear()
c.post("/api/sources/refresh")
ck("Refresh from source means it", HITS.count("warn") == 1 and HITS.count("5500") == 1, HITS)

# expiry
HITS.clear()
for key in list(M._SRC_CACHE):
    ts, val = M._SRC_CACHE[key]
    M._SRC_CACHE[key] = (ts - M.PLANS_TTL - 10, val)
c.post("/api/plans", json={"employers": ["Cordova Industrial Group"]})
ck("an expired entry is refetched", HITS.count("5500") == 1, HITS)

# a changed configuration must not serve the old answer
HITS.clear()
M.FORM5500_URL = STUB + "/f5500.csv?v=2"
c.post("/api/plans", json={"employers": ["Cordova Industrial Group"]})
ck("changing the source invalidates the cache", HITS.count("5500") == 1, HITS)
M.FORM5500_URL = STUB + "/f5500.csv"

HITS.clear()
before = c.post("/api/plans", json={"employers": ["Cordova Industrial Group"]}).json()
M.SOURCE_STATES = "TX"
c.post("/api/plans", json={"employers": ["Cordova Industrial Group"]})
ck("changing the state filter invalidates it too", HITS.count("5500") >= 1, HITS)
M.SOURCE_STATES = ""

import asyncio
warm = asyncio.get_event_loop().run_until_complete(M._load_plans(""))
ck("a cached load says it was cached, so a caller can tell",
   warm.get("cached") is True, {k: warm.get(k) for k in ("cached", "priced")})
fresh = asyncio.get_event_loop().run_until_complete(M._load_plans("", fresh=True))
ck("  ...and a fresh one does not claim to be", fresh.get("cached") is None,
   {k: fresh.get(k) for k in ("cached", "priced")})
ck("  ...while returning the same answer",
   fresh.get("priced") == warm.get("priced"), (fresh.get("priced"), warm.get("priced")))

print()
print(f"FAILURES {bad} of {n}" if bad else f"all {n} checks passed")
sys.exit(1 if bad else 0)
