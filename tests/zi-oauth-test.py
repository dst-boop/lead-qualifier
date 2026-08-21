"""Exercise the per-user ZoomInfo OAuth flow against a stub ZoomInfo.

The point is not to prove ZoomInfo's real endpoints behave this way — the egress
proxy blocks zoominfo.com, so that stays unverified until the user registers an
app. The point is to prove *our* half: PKCE is real S256, state is checked, the
token lands on the right user's session, refresh works, and an unconnected user
cannot reach the API. Pointing ZI_* at a local stub is also the test that the
env-configurability actually works.
"""
import base64, hashlib, json, os, sys, threading, time, urllib.parse

os.environ["NO_PROXY"] = os.environ["no_proxy"] = "127.0.0.1,localhost"
for k in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"):
    os.environ.pop(k, None)

STUB = "http://127.0.0.1:8711"
os.environ.update(
    ZI_CLIENT_ID="cid", ZI_CLIENT_SECRET="csec",
    ZI_AUTH_URL=STUB + "/authorize",
    ZI_TOKEN_URL=STUB + "/oauth/token",
    ZI_API_BASE=STUB + "/zi",
    APP_BASE_URL="http://127.0.0.1:8710",
)

import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

# ---------------------------------------------------------------- stub ZoomInfo
stub = FastAPI()
STATE = {"issued": 0, "last_auth_header": None, "refreshes": 0}


@stub.post("/oauth/token")
async def token(request: Request):
    raw = (await request.body()).decode()
    f = {k: v[0] for k, v in urllib.parse.parse_qs(raw).items()}
    if f.get("client_id") != "cid" or f.get("client_secret") != "csec":
        return JSONResponse({"error": "bad_client"}, status_code=401)
    if f.get("grant_type") == "refresh_token":
        if f.get("refresh_token") != "rt-1":
            return JSONResponse({"error": "bad_refresh"}, status_code=401)
        STATE["refreshes"] += 1
        return {"access_token": "at-refreshed", "expires_in": 3600}
    # authorization_code: verify PKCE the way a real server would
    v = f.get("code_verifier", "")
    want = base64.urlsafe_b64encode(
        hashlib.sha256(v.encode()).digest()).decode().rstrip("=")
    if want != CHALLENGE["value"]:
        return JSONResponse({"error": "pkce_mismatch"}, status_code=400)
    if f.get("redirect_uri") != "http://127.0.0.1:8710/auth/zoominfo/callback":
        return JSONResponse({"error": "bad_redirect"}, status_code=400)
    STATE["issued"] += 1
    return {"access_token": "at-1", "refresh_token": "rt-1", "expires_in": 3600}


@stub.post("/zi/search/contact")
async def search(request: Request):
    STATE["last_auth_header"] = request.headers.get("authorization")
    body = await request.json()
    return {"maxResults": 1, "data": [{"id": 1, "echo": body}]}


@stub.get("/userinfo")
async def userinfo():
    return {"name": "Dan Treacy", "email": "dst@financialplannersofamerica.com"}


CHALLENGE = {"value": None}
threading.Thread(target=lambda: uvicorn.run(stub, host="127.0.0.1", port=8711,
                                            log_level="error"), daemon=True).start()
time.sleep(1.5)

# ---------------------------------------------------------------- app under test
sys.path.insert(0, os.path.abspath("."))
from webapp import main                                        # noqa: E402
from fastapi.testclient import TestClient                      # noqa: E402

main.GOOGLE_USERINFO_URL = STUB + "/userinfo"
main.GOOGLE_CLIENT_ID, main.GOOGLE_CLIENT_SECRET = "g", "g"

fail = 0


TOTAL = [0]


def ck(name, cond, detail=""):
    global fail
    TOTAL[0] += 1
    print(("ok   " if cond else "FAIL ") + name + ("  " + str(detail) if detail else ""))
    if not cond:
        fail += 1


def signed_in_session(sid):
    main._MEM_SESSIONS[sid] = {
        "provider": "google",
        "google": {"access_token": "g-at", "expires_at": time.time() + 9999},
    }


c = TestClient(main.app, base_url="http://127.0.0.1:8710", follow_redirects=False)

# --- 1. anonymous visitor cannot start the flow -----------------------------
r = c.get("/auth/zoominfo/login")
ck("anonymous connect is refused", r.status_code in (302, 307)
   and r.headers["location"] == "/?zi=signin", r.status_code)
ck("  ...and no token was parked on the anon session",
   not any(s.get("zoominfo") for s in main._MEM_SESSIONS.values()))

# --- 2. signed-in user starts the flow --------------------------------------
signed_in_session("sidA")
c.cookies.set(main.SESSION_COOKIE, "sidA")
r = c.get("/auth/zoominfo/login")
ck("signed-in user is redirected to ZoomInfo", r.status_code in (302, 307), r.status_code)
q = urllib.parse.parse_qs(urllib.parse.urlparse(r.headers["location"]).query)
ck("  ...to the configured auth URL",
   r.headers["location"].startswith(STUB + "/authorize"), r.headers["location"][:60])
ck("  ...with PKCE S256", q.get("code_challenge_method") == ["S256"], q.get("code_challenge_method"))
ck("  ...and a real challenge", bool(q.get("code_challenge", [""])[0]))
ck("  ...and our redirect_uri",
   q.get("redirect_uri") == ["http://127.0.0.1:8710/auth/zoominfo/callback"], q.get("redirect_uri"))
CHALLENGE["value"] = q["code_challenge"][0]
sent_state = q["state"][0]

verifier = main._MEM_SESSIONS["sidA"]["zi_verifier"]
recomputed = base64.urlsafe_b64encode(
    hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
ck("  ...challenge really is sha256(verifier)", recomputed == CHALLENGE["value"])

# --- 3. a forged state is rejected ------------------------------------------
r = c.get("/auth/zoominfo/callback", params={"code": "x", "state": "not-ours"})
ck("forged state is rejected", r.headers.get("location") == "/?zi=state", r.headers.get("location"))
ck("  ...and nothing was connected", not main._MEM_SESSIONS["sidA"].get("zoominfo"))

# state was consumed, so restart the flow for the happy path
r = c.get("/auth/zoominfo/login")
q = urllib.parse.parse_qs(urllib.parse.urlparse(r.headers["location"]).query)
CHALLENGE["value"] = q["code_challenge"][0]
sent_state = q["state"][0]

# --- 4. the happy path ------------------------------------------------------
r = c.get("/auth/zoominfo/callback", params={"code": "authcode", "state": sent_state})
ck("callback connects the account", r.headers.get("location") == "/?zi=ok", r.headers.get("location"))
ck("  ...token stored on THIS user's session",
   main._MEM_SESSIONS["sidA"]["zoominfo"]["access_token"] == "at-1")
ck("  ...refresh token kept", main._MEM_SESSIONS["sidA"]["zoominfo"]["refresh_token"] == "rt-1")
ck("  ...stub validated PKCE and issued once", STATE["issued"] == 1, STATE["issued"])

# --- 5. /api/me reports it ---------------------------------------------------
me = c.get("/api/me").json()
ck("/api/me: signed in", me.get("signed_in") is True, me.get("signed_in"))
ck("/api/me: feature advertised", me["features"]["zoominfo"] is True)
ck("/api/me: this user is connected", me.get("zi_connected") is True)

# --- 6. the proxy uses THIS user's token ------------------------------------
r = c.post("/api/zi/search", json={"path": "search/contact", "body": {"q": 1}})
ck("search proxies through", r.status_code == 200, r.status_code)
ck("  ...with the user's bearer token",
   STATE["last_auth_header"] == "Bearer at-1", STATE["last_auth_header"])
ck("  ...and returns ZoomInfo's raw JSON unshaped",
   r.json().get("data", [{}])[0].get("echo") == {"q": 1}, json.dumps(r.json())[:80])

# --- 7. a second user on the same server is NOT connected -------------------
signed_in_session("sidB")
c2 = TestClient(main.app, base_url="http://127.0.0.1:8710", follow_redirects=False)
c2.cookies.set(main.SESSION_COOKIE, "sidB")
me2 = c2.get("/api/me").json()
ck("second user is not connected", me2.get("zi_connected") is False, me2.get("zi_connected"))
r = c2.post("/api/zi/search", json={"path": "search/contact", "body": {}})
ck("  ...and cannot borrow the first user's seat", r.status_code == 401, r.status_code)
ck("  ...with a message that says what to do",
   "onnect your ZoomInfo" in r.json().get("detail", ""), r.json().get("detail"))

# --- 8. expiry triggers a refresh, not a re-auth ----------------------------
main._MEM_SESSIONS["sidA"]["zoominfo"]["expires_at"] = time.time() - 5
r = c.post("/api/zi/search", json={"path": "search/contact", "body": {}})
ck("expired token refreshes silently", r.status_code == 200, r.status_code)
ck("  ...via the refresh grant", STATE["refreshes"] == 1, STATE["refreshes"])
ck("  ...and uses the new token",
   STATE["last_auth_header"] == "Bearer at-refreshed", STATE["last_auth_header"])

# --- 9. unrenewable expiry asks for reconnect -------------------------------
main._MEM_SESSIONS["sidA"]["zoominfo"] = {"access_token": "dead", "expires_at": time.time() - 5}
r = c.post("/api/zi/search", json={"path": "search/contact", "body": {}})
ck("dead token without refresh asks to reconnect", r.status_code == 401, r.status_code)
ck("  ...and is cleared from the session",
   not main._MEM_SESSIONS["sidA"].get("zoominfo"))

# --- 10. disconnect ----------------------------------------------------------
signed_in_session("sidC")
main._MEM_SESSIONS["sidC"]["zoominfo"] = {"access_token": "at-1", "expires_at": time.time() + 999}
c3 = TestClient(main.app, base_url="http://127.0.0.1:8710", follow_redirects=False)
c3.cookies.set(main.SESSION_COOKIE, "sidC")
ck("connected before disconnect", c3.get("/api/me").json().get("zi_connected") is True)
c3.get("/auth/zoominfo/disconnect")
ck("disconnect clears the seat", c3.get("/api/me").json().get("zi_connected") is False)
ck("  ...but keeps the user signed in to the app",
   c3.get("/api/me").json().get("signed_in") is True)

# --- 11. unconfigured service hides the feature ------------------------------
main.ZI_CLIENT_ID = main.ZI_CLIENT_SECRET = ""
ck("feature hidden when service is unconfigured",
   c3.get("/api/me").json()["features"]["zoominfo"] is False)
r = c3.get("/auth/zoominfo/login")
ck("  ...and connecting fails loudly, not silently", r.status_code == 500, r.status_code)

print("\nFAILURES: %d of %d" % (fail, TOTAL[0]) if fail else "\nall %d checks passed" % TOTAL[0])
sys.exit(1 if fail else 0)
