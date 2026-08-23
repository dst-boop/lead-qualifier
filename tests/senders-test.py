"""Sending as the right address.

One advisor, several work addresses: a firm domain on Google, an employer
mailbox on Microsoft, aliases hanging off either. All of them are accounts the
user has signed into here — the app never sends as anyone who has not — and
which one to use is a per-message decision.

The property that matters is that an address the user has NOT connected is
refused rather than quietly swapped for one they have. Sending from the wrong
address is a mistake only the recipient notices.
"""
import json, os, sys, threading, time

os.environ["NO_PROXY"] = os.environ["no_proxy"] = "127.0.0.1,localhost"
for k in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"):
    os.environ.pop(k, None)
os.environ.update(USE_FIRESTORE="0", APP_BASE_URL="http://127.0.0.1:8124")
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient

STUB = "http://127.0.0.1:8743"
sent = []

stub = FastAPI()


@stub.get("/userinfo")
async def userinfo():
    return {"email": "dst@financialplannersofamerica.com"}


@stub.get("/sendAs")
async def send_as():
    return {"sendAs": [
        {"sendAsEmail": "dst@financialplannersofamerica.com", "isPrimary": True,
         "displayName": "Dan Treacy"},
        {"sendAsEmail": "advisors@financialplannersofamerica.com", "isPrimary": False,
         "displayName": "FPA Advisors", "verificationStatus": "accepted"},
        {"sendAsEmail": "notverified@example.com", "isPrimary": False,
         "verificationStatus": "pending"},
    ]}


@stub.post("/gmail/send")
async def gmail_send(request: Request):
    sent.append(("gmail", await request.json()))
    return {"id": "m1"}


@stub.get("/graph/me")
async def graph_me():
    return {"mail": "dan.treacy@equitable.com", "displayName": "Dan Treacy"}


@stub.post("/graph/me/sendMail")
async def graph_send(request: Request):
    sent.append(("graph", await request.json()))
    return JSONResponse({}, status_code=202)


@stub.post("/graph/me/events")
async def graph_event(request: Request):
    sent.append(("graph-event", await request.json()))
    return {"id": "e1"}


threading.Thread(target=lambda: uvicorn.run(stub, host="127.0.0.1", port=8743,
                                            log_level="error"), daemon=True).start()
for _ in range(60):
    try:
        import httpx
        if httpx.get(STUB + "/userinfo", timeout=1).status_code == 200:
            break
    except Exception:
        time.sleep(0.1)

import webapp.main as M

M.GOOGLE_USERINFO_URL = STUB + "/userinfo"
M.GMAIL_SENDAS_URL = STUB + "/sendAs"
M.GMAIL_SEND_URL = STUB + "/gmail/send"
M.GCAL_EVENTS_URL = STUB + "/gcal/events"
M.GRAPH = STUB + "/graph"

HAVE = {"google": True, "microsoft": True}


async def fake_google_token(session):
    return "gtok" if HAVE["google"] else None


def fake_ms_token(session):
    return "mtok" if HAVE["microsoft"] else None


M._google_token = fake_google_token
M._ms_token = fake_ms_token


async def fake_active(request):
    if HAVE["google"]:
        return ("google", "gtok")
    if HAVE["microsoft"]:
        return ("microsoft", "mtok")
    from fastapi import HTTPException
    raise HTTPException(status_code=401, detail="Not signed in")


M._active_token = fake_active

c = TestClient(M.app)
n = bad = 0


def ck(name, cond, d=""):
    global n, bad
    n += 1
    print(("ok   " if cond else "FAIL ") + name + ("  " + str(d) if d else ""))
    if not cond:
        bad += 1


# --- what addresses are on offer --------------------------------------------
r = c.get("/api/senders").json()
addrs = [s["address"] for s in r["senders"]]
ck("both connected accounts are offered",
   "dst@financialplannersofamerica.com" in addrs and "dan.treacy@equitable.com" in addrs, addrs)
ck("  ...along with a verified Gmail alias",
   "advisors@financialplannersofamerica.com" in addrs, addrs)
ck("an unverified alias is not offered — Gmail would refuse it at send time",
   "notverified@example.com" not in addrs, addrs)
ck("the primary is the default", r["default"] == "google:dst@financialplannersofamerica.com", r["default"])
ck("each sender says which provider carries it",
   {s["provider"] for s in r["senders"]} == {"google", "microsoft"},
   [s["provider"] for s in r["senders"]])
ck("  ...and which are aliases",
   [s["kind"] for s in r["senders"] if s["address"].startswith("advisors")] == ["alias"])

# --- sending from each ---------------------------------------------------------
sent.clear()
c.post("/api/send-email", json={"to": "lead@x.com", "subject": "s", "body": "b",
                                "sender": "google:dst@financialplannersofamerica.com"})
ck("the primary sends through Gmail", sent and sent[0][0] == "gmail", sent[:1])
import base64
raw = base64.urlsafe_b64decode(sent[0][1]["raw"]).decode()
ck("  ...without forcing a From, which Gmail fills in itself", "From:" not in raw, raw[:80])

sent.clear()
c.post("/api/send-email", json={"to": "lead@x.com", "subject": "s", "body": "b",
                                "sender": "google:advisors@financialplannersofamerica.com"})
raw = base64.urlsafe_b64decode(sent[0][1]["raw"]).decode()
ck("an alias sets the From header", "From: advisors@financialplannersofamerica.com" in raw, raw[:120])

sent.clear()
c.post("/api/send-email", json={"to": "lead@x.com", "subject": "s", "body": "b",
                                "sender": "microsoft:dan.treacy@equitable.com"})
ck("the Outlook address sends through Graph", sent and sent[0][0] == "graph", sent[:1])
ck("  ...and saves to Sent items", sent[0][1].get("saveToSentItems") is True)

# --- an address the user has not connected -------------------------------------
bad_send = c.post("/api/send-email", json={"to": "lead@x.com", "subject": "s", "body": "b",
                                           "sender": "google:someone@else.com"})
ck("an unconnected address is refused", bad_send.status_code == 400, bad_send.status_code)
ck("  ...naming the address rather than a code",
   "someone@else.com" in bad_send.json()["detail"], bad_send.json()["detail"])
ck("  ...and nothing was sent", not any(s for s in sent[1:]), len(sent))

# --- an invite picks the calendar ----------------------------------------------
sent.clear()
c.post("/api/create-event", json={"attendee": "lead@x.com", "subject": "Intro",
                                  "start": "2026-09-01T10:00:00", "end": "2026-09-01T10:30:00",
                                  "sender": "microsoft:dan.treacy@equitable.com"})
ck("an invite goes to the chosen calendar", sent and sent[0][0] == "graph-event", sent[:1])

# --- one account only ----------------------------------------------------------
HAVE["microsoft"] = False
r2 = c.get("/api/senders").json()
ck("disconnecting Outlook drops it from the list",
   all(s["provider"] == "google" for s in r2["senders"]), [s["address"] for s in r2["senders"]])
gone = c.post("/api/send-email", json={"to": "l@x.com", "subject": "s", "body": "b",
                                       "sender": "microsoft:dan.treacy@equitable.com"})
ck("  ...and sending from it is refused, not silently rerouted", gone.status_code == 400, gone.status_code)

# --- no sender named -----------------------------------------------------------
sent.clear()
ok = c.post("/api/send-email", json={"to": "l@x.com", "subject": "s", "body": "b"})
ck("omitting the sender still works, on the signed-in account",
   ok.status_code == 200 and sent[0][0] == "gmail", ok.status_code)

print()
print(f"FAILURES {bad} of {n}" if bad else f"all {n} checks passed")
sys.exit(1 if bad else 0)
