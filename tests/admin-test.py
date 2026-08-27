"""The firm's lead bank: an admin sees everything and can take anything back.

"Both Advisors & Admin can add, upload, and share leads. The admin must have
access to all leads and the ability to reclaim all leads."

So an admin is an advisor with two extra powers, not a second application. The
interesting half of this suite is the half that must NOT work: an ordinary
advisor is one query-string away from every one of these endpoints, and the
only thing between them and the firm's whole pipeline is the check at the top
of each handler.

The other load-bearing property is that reclaiming MOVES a list. A copy would
leave the advisor holding a second, diverging set of the same people, and two
advisors phoning one prospect is the failure this app exists to prevent.
"""
import json, os, sys, threading, time

os.environ["NO_PROXY"] = os.environ["no_proxy"] = "127.0.0.1,localhost"
for k in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"):
    os.environ.pop(k, None)

STUB = "http://127.0.0.1:8727"
os.environ.update(USE_FIRESTORE="0", APP_BASE_URL="http://127.0.0.1:8726",
                  ADMIN_EMAILS="Boss@FPA.com, second.admin@fpa.com")

import uvicorn
from fastapi import FastAPI

stub = FastAPI()
WHO = {"email": "boss@fpa.com", "name": "Boss"}


@stub.get("/userinfo")
async def userinfo():
    return dict(WHO)


threading.Thread(target=lambda: uvicorn.run(stub, host="127.0.0.1", port=8727,
                                            log_level="error"), daemon=True).start()
time.sleep(1.5)

sys.path.insert(0, os.path.abspath("."))
from webapp import main                                        # noqa: E402
from fastapi.testclient import TestClient                      # noqa: E402

main.GOOGLE_USERINFO_URL = STUB + "/userinfo"

n = bad = 0


def ck(name, cond, d=""):
    global n, bad
    n += 1
    print(("ok   " if cond else "FAIL ") + name + ("  " + str(d) if d else ""))
    if not cond:
        bad += 1


def client(email):
    """A signed-in browser for one person. The stub answers with whoever the
    caller last claimed to be, so each request sets it first."""
    c = TestClient(main.app, base_url="http://127.0.0.1:8726", follow_redirects=False)
    sid = "sid-" + email
    main._MEM_SESSIONS[sid] = {"provider": "google",
                               "google": {"access_token": "t",
                                          "expires_at": time.time() + 9999}}
    c.cookies.set(main.SESSION_COOKIE, sid)
    orig = c.request

    def request(method, url, **kw):
        WHO["email"] = email
        return orig(method, url, **kw)

    c.request = request
    return c


boss = client("boss@fpa.com")
ada = client("ada@fpa.com")
ben = client("ben@fpa.com")

# --- the role comes from the environment, and is case-insensitive ------------
ck("the admin is told they are one", boss.get("/api/me").json().get("is_admin") is True)
ck("  ...even though the env spelled it with capitals",
   main._is_admin("BOSS@fpa.com") is True)
ck("an advisor is not", ada.get("/api/me").json().get("is_admin") is False)
ck("  ...and a stranger with a similar address is not",
   main._is_admin("boss@fpa.com.attacker.net") is False)

# --- everyone builds lists the same way --------------------------------------
r = ada.post("/api/lists", json={"name": "Ada's rollovers"})
ck("an advisor can create a list", r.status_code == 200, r.text[:90])
ada_list = r.json()["list"]["id"]
ada.put(f"/api/lists/{ada_list}", json={"leads": [
    {"id": "a1", "firstName": "Janet", "lastName": "Melter", "status": "New", "activity": []},
    {"id": "a2", "firstName": "Paul", "lastName": "Okafor", "status": "Called", "activity": []}]})
r = ben.post("/api/lists", json={"name": "Ben's book"})
ben_list = r.json()["list"]["id"]
ben.put(f"/api/lists/{ben_list}", json={"leads": [
    {"id": "b1", "firstName": "Rita", "lastName": "Sandoval", "status": "New", "activity": []}]})
r = boss.post("/api/lists", json={"name": "Boss's own prospecting"})
ck("an admin builds lists exactly like anyone else", r.status_code == 200, r.text[:90])

# --- the refusals, first ------------------------------------------------------
ck("an advisor cannot read the firm overview",
   ada.get("/api/admin/overview").status_code == 403, ada.get("/api/admin/overview").status_code)
r = ada.post("/api/admin/transfer", json={"owner": "ben@fpa.com", "list_id": ben_list})
ck("an advisor cannot reclaim somebody else's list", r.status_code == 403, r.status_code)
ck("  ...and is told plainly why", "Admins only" in r.json()["detail"], r.json()["detail"])
r = ada.post("/api/admin/transfer", json={"owner": "ben@fpa.com", "to": "ada@fpa.com"})
ck("an advisor cannot assign a colleague's whole book to themselves",
   r.status_code == 403, r.status_code)
anon = TestClient(main.app, base_url="http://127.0.0.1:8726")
ck("signed out gets 401, not 403 — a different problem with a different fix",
   anon.get("/api/admin/overview").status_code == 401)
ck("  ...and cannot transfer either",
   anon.post("/api/admin/transfer", json={"owner": "ben@fpa.com"}).status_code == 401)

# --- what the admin sees ------------------------------------------------------
ov = boss.get("/api/admin/overview").json()
emails = sorted(a["email"] for a in ov["advisors"])
ck("the admin sees every advisor who has ever signed in",
   emails == ["ada@fpa.com", "ben@fpa.com", "boss@fpa.com"], emails)
ck("  ...with what each is carrying",
   next(a for a in ov["advisors"] if a["email"] == "ada@fpa.com")["leads"] == 2,
   [(a["email"], a["leads"]) for a in ov["advisors"]])
ck("  ...and which of them are admins",
   next(a for a in ov["advisors"] if a["email"] == "boss@fpa.com")["is_admin"] is True
   and next(a for a in ov["advisors"] if a["email"] == "ada@fpa.com")["is_admin"] is False)
refs = {l["ref"] for l in ov["lists"]}
ck("every list in the firm is listed, addressed owner~id",
   f"ada@fpa.com~{ada_list}" in refs and f"ben@fpa.com~{ben_list}" in refs, sorted(refs))
ck("  ...and the firm's total is counted once", ov["total_leads"] == 3, ov["total_leads"])

# --- the admin can open and work any list ------------------------------------
r = boss.get(f"/api/lists/ada@fpa.com~{ada_list}")
ck("the admin can open an advisor's list without being shared it",
   r.status_code == 200, r.text[:90])
ck("  ...and sees the leads themselves", len(r.json()["leads"]) == 2, r.text[:90])
ck("  ...as an editor, not as the owner", r.json()["list"]["role"] == "editor",
   r.json()["list"].get("role"))
r = boss.put(f"/api/lists/ada@fpa.com~{ada_list}", json={"leads": [
    {"id": "a1", "firstName": "Janet", "lastName": "Melter", "status": "Set", "activity": []},
    {"id": "a2", "firstName": "Paul", "lastName": "Okafor", "status": "Called", "activity": []}]})
ck("  ...and can save a change to it", r.status_code == 200, r.text[:90])
ck("  ...which the advisor sees on their own copy",
   [l["status"] for l in ada.get(f"/api/lists/{ada_list}").json()["leads"]] == ["Set", "Called"])
r = ben.get(f"/api/lists/ada@fpa.com~{ada_list}")
ck("an ordinary advisor still cannot open a colleague's list", r.status_code == 403,
   r.status_code)

# --- reclaiming moves the list, whole ----------------------------------------
r = boss.post("/api/admin/transfer", json={"owner": "ada@fpa.com", "list_id": ada_list})
ck("the admin can reclaim a list", r.status_code == 200, r.text[:120])
ck("  ...with every lead on it", r.json()["leads"] == 2, r.json().get("leads"))
gone = ada.get("/api/lists").json()["lists"]
ck("  ...and it is GONE from the advisor, not copied",
   not any(l["id"] == ada_list for l in gone), [l["id"] for l in gone])
ck("  ...leaving the advisor's other lists alone", len(gone) >= 1, gone)
mine = boss.get("/api/lists").json()["lists"]
got = next((l for l in mine if l.get("reclaimed_from") == "ada@fpa.com"), None)
ck("the list is now the admin's own", got is not None, [l.get("name") for l in mine])
ck("  ...keeping its name", got and got["name"] == "Ada's rollovers", got)
ck("  ...and recording where it came from", got and got["reclaimed_from"] == "ada@fpa.com")
leads = boss.get(f"/api/lists/{got['id']}").json()["leads"]
ck("  ...with the work already done on it intact",
   [l["status"] for l in leads] == ["Set", "Called"], [l.get("status") for l in leads])
r = ada.get(f"/api/lists/{ada_list}")
ck("the advisor asking for the old list gets a clean 404, not a stale copy",
   r.status_code == 404, r.status_code)

# --- a share on a reclaimed list does not survive it -------------------------
r = ben.post("/api/lists", json={"name": "Ben's shared one"})
shared_id = r.json()["list"]["id"]
ben.put(f"/api/lists/{shared_id}", json={"leads": [{"id": "s1", "lastName": "Vance",
                                                    "status": "New", "activity": []}]})
ben.post(f"/api/lists/{shared_id}/shares", json={"email": "ada@fpa.com", "role": "editor"})
ck("a colleague can see a list shared with them",
   any(l["id"] == f"ben@fpa.com~{shared_id}" for l in ada.get("/api/lists").json()["lists"]))
boss.post("/api/admin/transfer", json={"owner": "ben@fpa.com", "list_id": shared_id})
ck("  ...but not after it is reclaimed — the share goes with it",
   not any(l["id"] == f"ben@fpa.com~{shared_id}"
           for l in ada.get("/api/lists").json()["lists"]),
   [l["id"] for l in ada.get("/api/lists").json()["lists"]])

# --- reclaiming everything from one advisor ----------------------------------
# The case that actually comes up: somebody leaves, and their pipeline has to
# keep being worked by somebody else tomorrow morning.
ben.post("/api/lists", json={"name": "Ben leftover one"})
ben.post("/api/lists", json={"name": "Ben leftover two"})
before = len(ben.get("/api/lists").json()["lists"])
r = boss.post("/api/admin/transfer", json={"owner": "ben@fpa.com"})
ck("the admin can reclaim an advisor's entire book in one call",
   r.status_code == 200 and len(r.json()["moved"]) == before, r.text[:140])
ck("  ...leaving them with nothing of the firm's",
   ben.get("/api/lists").json()["lists"] == []
   or all(l.get("count", 0) == 0 for l in ben.get("/api/lists").json()["lists"]),
   ben.get("/api/lists").json()["lists"])

# --- assigning back out is the same operation, reversed ----------------------
mine = boss.get("/api/lists").json()["lists"]
give = next(l for l in mine if l.get("reclaimed_from") == "ada@fpa.com")
r = boss.post("/api/admin/transfer", json={"list_id": give["id"], "to": "ada@fpa.com"})
ck("the admin can hand a list to an advisor", r.status_code == 200, r.text[:120])
ck("  ...and it arrives with its leads",
   any(l.get("count") == 2 for l in ada.get("/api/lists").json()["lists"]),
   [(l.get("name"), l.get("count")) for l in ada.get("/api/lists").json()["lists"]])
ck("  ...and has left the admin", not any(l["id"] == give["id"]
   for l in boss.get("/api/lists").json()["lists"]))

# --- the refusals that stop a transfer being a mistake -----------------------
r = boss.post("/api/admin/transfer", json={"owner": "boss@fpa.com", "to": "boss@fpa.com"})
ck("a transfer to yourself is refused rather than silently doing nothing",
   r.status_code == 400, r.status_code)
r = boss.post("/api/admin/transfer", json={"owner": "nobody@fpa.com", "list_id": "lzzzzzzzzzz"})
ck("reclaiming from someone with nothing says so", r.status_code == 404, r.status_code)
r = boss.post("/api/admin/transfer", json={"owner": "ada@fpa.com", "list_id": "../etc/passwd"})
ck("a bad list id is refused before anything is read", r.status_code == 400, r.status_code)
r = boss.post("/api/admin/transfer", json={"owner": "not-an-email", "list_id": ada_list})
ck("an owner that is not an address is refused", r.status_code == 400, r.status_code)

print()
print(f"FAILURES: {bad} of {n}" if bad else f"all {n} checks passed")
sys.exit(1 if bad else 0)
