"""Why the consent screen appeared on every single sign-in.

Reported: "Why do I have to do this every time I sign in?", with a screenshot of
Google asking to approve Drive, Calendar and Gmail — the same four scopes, again.

The cause was one line: prompt=consent on every authorisation. It was there for
a real reason. Google issues a refresh token only on a grant that shows the
consent screen, and without a refresh token the session dies after an hour. So
the app guaranteed one by asking every time.

The cost of that guarantee is that a person reads the same consent screen so
often it stops being a decision, which is the opposite of what a consent screen
is for.

So consent is asked for once, and the callback notices if it did not get what it
needed and goes round exactly one more time.

The second half of this file is the trap that opens up the moment the first half
lands: a re-authorisation returns NO refresh token, because the one on file is
still good. Writing it in unconditionally would replace a working token with
None and end the session an hour later. That bug could not bite while consent
was forced, and would have started biting the day it stopped.
"""
import os, sys, threading, time, urllib.parse

os.environ["NO_PROXY"] = os.environ["no_proxy"] = "127.0.0.1,localhost"
for k in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"):
    os.environ.pop(k, None)

STUB = "http://127.0.0.1:8721"
os.environ.update(APP_BASE_URL="http://127.0.0.1:8720", USE_FIRESTORE="0")

import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

# --------------------------------------------------------------- stub Google
stub = FastAPI()
# give_refresh mirrors the real rule: a refresh token comes back only when the
# grant showed consent.
S = {"give_refresh": True, "grants": 0}


@stub.post("/token")
async def token(request: Request):
    raw = (await request.body()).decode()
    f = {k: v[0] for k, v in urllib.parse.parse_qs(raw).items()}
    if f.get("grant_type") == "refresh_token":
        return {"access_token": "at-refreshed", "expires_in": 3600}
    S["grants"] += 1
    out = {"access_token": "at-%d" % S["grants"], "expires_in": 3600}
    if S["give_refresh"]:
        out["refresh_token"] = "rt-1"
    return out


@stub.get("/userinfo")
async def userinfo():
    return {"name": "Dan", "email": "dst@financialplannersofamerica.com"}


threading.Thread(target=lambda: uvicorn.run(stub, host="127.0.0.1", port=8721,
                                            log_level="error"), daemon=True).start()
time.sleep(1.5)

sys.path.insert(0, os.path.abspath("."))
from webapp import main                                        # noqa: E402
from fastapi.testclient import TestClient                      # noqa: E402

main.GOOGLE_CLIENT_ID, main.GOOGLE_CLIENT_SECRET = "gid", "gsec"
main.GOOGLE_TOKEN_URL = STUB + "/token"
main.GOOGLE_USERINFO_URL = STUB + "/userinfo"

n = bad = 0


def ck(name, cond, d=""):
    global n, bad
    n += 1
    print(("ok   " if cond else "FAIL ") + name + ("  " + str(d) if d else ""))
    if not cond:
        bad += 1


c = TestClient(main.app, base_url="http://127.0.0.1:8720", follow_redirects=False)


def q_of(resp):
    return {k: v[0] for k, v in
            urllib.parse.parse_qs(urllib.parse.urlparse(resp.headers["location"]).query).items()}


def use(sid):
    """Adopt a session id. The app only honours one it already knows about."""
    main._MEM_SESSIONS.setdefault(sid, {})
    c.cookies.set(main.SESSION_COOKIE, sid)


def sign_in(sid, give_refresh=True):
    """One full round trip, returning the callback's redirect target."""
    S["give_refresh"] = give_refresh
    use(sid)
    r = c.get("/auth/google/login")
    state = q_of(r)["state"]
    cb = c.get(f"/auth/google/callback?state={state}&code=abc")
    return r, cb


# --- a first sign-in still has to ask ---------------------------------------
# Someone who has never granted anything must see the screen: that is the one
# time it is a real decision, and the only time a refresh token is on offer.
use("sid-new")
r = c.get("/auth/google/login")
p = q_of(r)
ck("a first sign-in asks for consent", p.get("prompt") == "consent", p.get("prompt"))
ck("  ...offline, so the grant outlives the hour", p.get("access_type") == "offline")
ck("  ...and carries a state to check", bool(p.get("state")))

# --- the second sign-in does not -------------------------------------------
r, cb = sign_in("sid-1")
ck("the grant lands a refresh token",
   main._MEM_SESSIONS["sid-1"]["google"]["refresh_token"] == "rt-1",
   main._MEM_SESSIONS["sid-1"]["google"])
ck("  ...and goes straight into the app", cb.headers["location"] == "/", cb.headers["location"])

r = c.get("/auth/google/login")
p = q_of(r)
# This is the whole point of the change.
ck("signing in again does NOT ask for consent again",
   p.get("prompt") != "consent", p.get("prompt"))
ck("  ...but still lets them switch account, which is what the button is for",
   p.get("prompt") == "select_account", p.get("prompt"))
ck("  ...and keeps the scopes already granted",
   p.get("include_granted_scopes") == "true", p.get("include_granted_scopes"))

# --- the trap: a re-auth returns no refresh token ---------------------------
# Google withholds it because the one on file is still valid. The old code
# wrote tok.get("refresh_token") in unconditionally.
before = main._MEM_SESSIONS["sid-1"]["google"]["refresh_token"]
S["give_refresh"] = False
state = q_of(c.get("/auth/google/login"))["state"]
cb = c.get(f"/auth/google/callback?state={state}&code=abc2")
after = main._MEM_SESSIONS["sid-1"]["google"]["refresh_token"]
ck("a re-auth with no refresh token keeps the one on file",
   after == before == "rt-1", (before, after))
ck("  ...and takes the new access token", 
   main._MEM_SESSIONS["sid-1"]["google"]["access_token"].startswith("at-"),
   main._MEM_SESSIONS["sid-1"]["google"]["access_token"])
ck("  ...and does not bounce, because nothing is missing",
   cb.headers["location"] == "/", cb.headers["location"])

# --- no refresh token and none on file: ask once, exactly once --------------
use("sid-2")
S["give_refresh"] = False
state = q_of(c.get("/auth/google/login"))["state"]
cb = c.get(f"/auth/google/callback?state={state}&code=abc3")
ck("a grant with no refresh token and none on file goes round again",
   cb.headers["location"] == "/auth/google/login?force=1", cb.headers["location"])
r = c.get("/auth/google/login?force=1")
p = q_of(r)
ck("  ...and that trip does ask for consent", p.get("prompt") == "consent", p.get("prompt"))
# If the forced trip also comes back empty, accept the hour rather than loop.
state = p["state"]
cb = c.get(f"/auth/google/callback?state={state}&code=abc4")
ck("  ...and if that one also comes back empty it gives up rather than looping",
   cb.headers["location"] == "/", cb.headers["location"])
ck("  ...leaving a usable session, just a short-lived one",
   main._MEM_SESSIONS["sid-2"]["google"]["access_token"].startswith("at-"))

# --- the state check is untouched -------------------------------------------
use("sid-3")
c.get("/auth/google/login")
cb = c.get("/auth/google/callback?state=forged&code=abc")
ck("a forged state is still refused", cb.headers["location"] == "/", cb.headers["location"])
ck("  ...and grants nothing",
   not (main._MEM_SESSIONS.get("sid-3") or {}).get("google"),
   (main._MEM_SESSIONS.get("sid-3") or {}).get("google"))

print()
print(f"FAILURES: {bad} of {n}" if bad else f"all {n} checks passed")
sys.exit(1 if bad else 0)
