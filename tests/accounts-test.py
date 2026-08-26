"""Accounts for anyone, with providers as attachments.

"This app needs to be accessible and usable by ANYone... A user should be
able to create an account with whatever email they want and link an email
(same or different than login) to send calendar invites."

The load-bearing decision is identity: a password account's email is the key
its lists live under, and linking a Google or Microsoft address afterwards
must never change it — linking a sender that silently re-keyed your leads
would look like the app deleting them.

The rest is the usual honesty at the edges: one error message for both
halves of a failed sign-in (which half was wrong is what a guesser wants
confirmed), a signup against an existing account handled, and a password
session with nothing linked told to link, not handed an empty bearer token.
"""
import os, sys, threading, time, urllib.parse

os.environ["NO_PROXY"] = os.environ["no_proxy"] = "127.0.0.1,localhost"
for k in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"):
    os.environ.pop(k, None)

STUB = "http://127.0.0.1:8751"
os.environ.update(APP_BASE_URL="http://127.0.0.1:8750", USE_FIRESTORE="0")

import uvicorn
from fastapi import FastAPI, Request

stub = FastAPI()
S = {"give_refresh": True}


@stub.post("/token")
async def token(request: Request):
    raw = (await request.body()).decode()
    f = {k: v[0] for k, v in urllib.parse.parse_qs(raw).items()}
    if f.get("grant_type") == "refresh_token":
        return {"access_token": "at-refreshed", "expires_in": 3600}
    out = {"access_token": "at-1", "expires_in": 3600}
    if S["give_refresh"]:
        out["refresh_token"] = "rt-1"
    return out


@stub.get("/userinfo")
async def userinfo():
    return {"name": "Pat", "email": "pat.gmail@gmail.com"}


threading.Thread(target=lambda: uvicorn.run(stub, host="127.0.0.1", port=8751,
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


c = TestClient(main.app, base_url="http://127.0.0.1:8750", follow_redirects=False)
main._MEM_SESSIONS["sid"] = {}
c.cookies.set(main.SESSION_COOKIE, "sid")

# The attachment vault, backed by a dict so this suite can watch what a real
# Firestore would hold — the same shim the consent-vault test uses.
VAULT = {}
_orig = (main._fs_get, main._fs_set, main._fs_del)


async def _vget(col, key):
    return VAULT.get((col, key)) if col == main.FS_VAULT else await _orig[0](col, key)


async def _vset(col, key, doc):
    if col == main.FS_VAULT:
        VAULT[(col, key)] = doc
        return True
    return await _orig[1](col, key, doc)


async def _vdel(col, key):
    if col == main.FS_VAULT:
        VAULT.pop((col, key), None)
        return True
    return await _orig[2](col, key)


main._fs_get, main._fs_set, main._fs_del = _vget, _vset, _vdel

# --- creating an account -----------------------------------------------------
r = c.post("/auth/signup", json={"email": "Pat@AnyWhere.com", "password": "correct horse battery"})
ck("any email creates an account", r.status_code == 200, (r.status_code, r.text[:80]))
ck("  ...normalised to lower case", r.json()["email"] == "pat@anywhere.com")
me = c.get("/api/me").json()
ck("the session is signed in", me["signed_in"] is True and me["provider"] == "password", me.get("provider"))
ck("  ...as the account email", me["email"] == "pat@anywhere.com", me.get("email"))
ck("  ...with nothing linked yet", me["linked_google"] is False and me["linked_microsoft"] is False)

r = c.post("/auth/signup", json={"email": "pat@anywhere.com", "password": "another password!"})
ck("the same email cannot be registered twice", r.status_code == 409, r.status_code)
ck("  ...and the message says to sign in", "sign in" in r.json()["detail"], r.json()["detail"])
r = c.post("/auth/signup", json={"email": "short@x.com", "password": "tiny"})
ck("a short password is refused with advice, not a rule-dump",
   r.status_code == 400 and "phrase" in r.json()["detail"], r.json().get("detail"))
r = c.post("/auth/signup", json={"email": "not-an-email", "password": "long enough phrase"})
ck("a non-email is refused by validation", r.status_code == 422, r.status_code)

# --- signing in --------------------------------------------------------------
main._MEM_SESSIONS["sid2"] = {}
c.cookies.set(main.SESSION_COOKIE, "sid2")
r = c.post("/auth/password-login", json={"email": "pat@anywhere.com", "password": "wrong password!!"})
wrong_pw = r.json()["detail"]
ck("a wrong password is refused", r.status_code == 401)
r = c.post("/auth/password-login", json={"email": "nobody@anywhere.com", "password": "whatever this is"})
ck("an unknown email gets the IDENTICAL message — no account enumeration",
   r.status_code == 401 and r.json()["detail"] == wrong_pw, r.json()["detail"])
r = c.post("/auth/password-login", json={"email": "PAT@anywhere.com", "password": "correct horse battery"})
ck("the right password signs in, case-insensitively", r.status_code == 200)

# --- the account owns its data ----------------------------------------------
r = c.post("/api/lists", json={"name": "Pat's prospects"})
ck("a password account can create a list", r.status_code == 200, (r.status_code, r.text[:80]))
list_id = r.json()["list"]["id"]

# --- a bare account is told to link, not handed an empty token ---------------
r = c.get("/api/senders")
ck("no linked accounts means no senders, not an error",
   r.status_code == 200 and r.json()["senders"] == [], r.text[:80])
r = c.post("/api/send-email", json={"to": "lead@x.com", "subject": "s", "body": "b"})
ck("sending with nothing linked is refused with the fix named",
   r.status_code == 400 and "link a Google or Microsoft" in r.json()["detail"],
   r.json().get("detail"))

# --- linking a Google address does not change who you are --------------------
login = c.get("/auth/google/login")
state = {k: v[0] for k, v in urllib.parse.parse_qs(
    urllib.parse.urlparse(login.headers["location"]).query).items()}["state"]
cb = c.get(f"/auth/google/callback?state={state}&code=abc")
ck("the google link round-trip lands", cb.headers["location"] == "/", cb.headers["location"])
sess = main._MEM_SESSIONS["sid2"]
ck("  ...the tokens are attached", bool(sess.get("google", {}).get("refresh_token")))
ck("  ...but the provider is still the password account", sess["provider"] == "password",
   sess["provider"])
me = c.get("/api/me").json()
ck("  ...and /api/me agrees: same identity, google now linked",
   me["provider"] == "password" and me["email"] == "pat@anywhere.com"
   and me["linked_google"] is True, (me.get("provider"), me.get("email")))
r = c.get("/api/lists").json()
ck("the list created before linking is still there — the key never moved",
   any(x["id"] == list_id for x in r["lists"]), r["lists"])
r = c.get("/api/senders").json()
ck("the linked gmail is now a sender", any("pat.gmail@gmail.com" in x["address"]
   for x in r["senders"]), [x["address"] for x in r["senders"]])

# --- connections stick to the person, not the browser tab --------------------
# "Once a user creates an account, they should NOT have to resign in to all
# their accounts they have connected (claude, zoominfo, etc)."
import asyncio  # noqa: E402

ck("a session cookie lasts a month, not a workday",
   main.SESSION_TTL >= 30 * 24 * 3600, main.SESSION_TTL)
ck("linking google vaulted the connection under the account",
   any(k[1] == "att-google:pat@anywhere.com" for k in VAULT),
   [k[1] for k in VAULT])
r = c.post("/api/zi/mcp-token", json={"token": "zi-mcp-tok-1"})
ck("saving a ZoomInfo MCP token vaults it too",
   r.status_code == 200 and any(k[1] == "att-zimcp:pat@anywhere.com" for k in VAULT),
   [k[1] for k in VAULT])
# Microsoft and ZoomInfo OAuth need their own stubs to link for real; seed
# their vault entries directly in the exact shape _save_all_attachments writes.
asyncio.run(main._save_attachment("pat@anywhere.com", "msal",
                                  {"cache": "CACHE-BLOB", "mode": "calendar"}))
asyncio.run(main._save_attachment("pat@anywhere.com", "zoominfo",
                                  {"refresh_token": "zi-rt", "connected_at": 1}))

main._MEM_SESSIONS["sid3"] = {}
c.cookies.set(main.SESSION_COOKIE, "sid3")
r = c.post("/auth/password-login", json={"email": "pat@anywhere.com", "password": "correct horse battery"})
ck("password sign-in on a brand-new browser works", r.status_code == 200)
me = c.get("/api/me").json()
ck("google comes back linked with NO oauth round-trip", me["linked_google"] is True, me)
ck("  ...microsoft comes back linked", me["linked_microsoft"] is True)
ck("  ...zoominfo comes back connected", me["zi_connected"] is True)
ck("  ...the MCP token comes back", me["zi_mcp_connected"] is True)
sess3 = main._MEM_SESSIONS["sid3"]
ck("the restored google connection already refreshed itself into a live token",
   sess3["google"]["refresh_token"] == "rt-1"
   and sess3["google"]["access_token"] == "at-refreshed",
   sess3.get("google"))
ck("the msal cache and calendar-only mode round-tripped",
   sess3["ms_token_cache"] == "CACHE-BLOB" and sess3["ms_mode"] == "calendar",
   (sess3.get("ms_token_cache"), sess3.get("ms_mode")))
ck("the zoominfo shape forces a refresh too",
   sess3["zoominfo"]["refresh_token"] == "zi-rt" and sess3["zoominfo"]["expires_at"] == 0,
   sess3.get("zoominfo"))

# --- a live connection is newer than anything vaulted ------------------------
sess3["google"] = {"access_token": "live-at", "refresh_token": "rt-live",
                   "expires_at": time.time() + 3000, "email": "pat.gmail@gmail.com"}
asyncio.run(main._restore_attachments(sess3, "pat@anywhere.com"))
ck("a live session connection is not clobbered by the vault",
   sess3["google"]["refresh_token"] == "rt-live", sess3["google"])

# --- disconnect means disconnect ---------------------------------------------
c.post("/api/zi/mcp-token", json={"token": ""})
ck("clearing the MCP token clears the vault too",
   not any(k[1] == "att-zimcp:pat@anywhere.com" for k in VAULT), [k[1] for k in VAULT])
c.get("/auth/zoominfo/disconnect")
ck("zoominfo disconnect clears the vault too",
   not any(k[1] == "att-zoominfo:pat@anywhere.com" for k in VAULT), [k[1] for k in VAULT])
main._MEM_SESSIONS["sid4"] = {}
c.cookies.set(main.SESSION_COOKIE, "sid4")
c.post("/auth/password-login", json={"email": "pat@anywhere.com", "password": "correct horse battery"})
me = c.get("/api/me").json()
ck("the next sign-in does not resurrect what was disconnected",
   me["zi_connected"] is False and me["zi_mcp_connected"] is False,
   (me.get("zi_connected"), me.get("zi_mcp_connected")))
ck("  ...while google and microsoft still restore",
   me["linked_google"] is True and me["linked_microsoft"] is True,
   (me.get("linked_google"), me.get("linked_microsoft")))

print()
print(f"FAILURES: {bad} of {n}" if bad else f"all {n} checks passed")
sys.exit(1 if bad else 0)
