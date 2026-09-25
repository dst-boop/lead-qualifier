"""Autopilot runs: one approval, server-held caps, resumable progress.

The page runs the steps; the server holds the run — which step it reached, and
the WhitePages cap the operator approved, enforced in _wp_fetch where the
credit is actually spent. The vendor call is stubbed (no credits, no network).
"""
import os, sys

os.environ["USE_FIRESTORE"] = "0"
os.environ.setdefault("SESSION_SECRET", "t" * 32)
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from fastapi.testclient import TestClient
import webapp.main as M

WHO = {"email": "dan@fpa.com"}


async def fake_email(request): return WHO["email"]
async def fake_active(request): return ("google", "tok")
M._signed_in_email = fake_email
M._active_token = fake_active
M.WHITEPAGES_API_KEY = "wp-test-not-real"
calls = []


async def fake_http_get(self, url, params=None, headers=None):
    calls.append(params)
    return type("R", (), {"status_code": 200, "text": "{}",
                          "json": lambda self: {"results": [{"name": "Dana Whitfield", "line_type": "Mobile"}]}})()
import httpx
httpx.AsyncClient.get = fake_http_get

c = TestClient(M.app)
n = 0; bad = 0


def ck(name, cond, d=""):
    global n, bad
    n += 1
    print(("ok   " if cond else "FAIL ") + name + ("  " + str(d)[:120] if d else ""))
    if not cond:
        bad += 1


c.get("/api/lists")
PROFILE = {"name": "Full demographic", "steps": [
    {"k": "free", "on": True}, {"k": "wp", "on": True, "tiers": ["A", "B", "Z"], "cap": 2},
    {"k": "qc", "on": True, "tiers": ["A"], "cap": 50}, {"k": "bogus", "on": True}]}

# --- starting a run -----------------------------------------------------------------
r = c.post("/api/autopilot", json={"list_id": "default", "profile": PROFILE})
job = r.json().get("job") or {}
ck("a run starts with the approved WhitePages cap taken from its profile",
   r.status_code == 200 and job.get("caps", {}).get("wp") == 2 and job.get("status") == "running", r.json())
ck("  ...unknown steps and tiers are dropped, not trusted",
   [s["k"] for s in job["profile"]["steps"]] == ["free", "wp", "qc"]
   and job["profile"]["steps"][1]["tiers"] == ["A", "B"])
ck("a profile with nothing on is refused",
   c.post("/api/autopilot", json={"list_id": "default",
                                  "profile": {"steps": [{"k": "wp", "on": False}]}}).status_code == 400)
ck("a list that is not yours is refused",
   c.post("/api/autopilot", json={"list_id": "boss@x.com~camp", "profile": PROFILE}).status_code == 400)
ck("the run can be read back to resume it",
   c.get("/api/autopilot", params={"list_id": "default"}).json()["job"]["id"] == job["id"])

# --- the cap is held where the credit is spent -----------------------------------------
H = {"X-Autopilot-Job": f"default:{job['id']}"}
r1 = c.post("/api/verify-phone", json={"phone": "2065550101", "last_name": "Whitfield"}, headers=H)
r2 = c.post("/api/verify-phone", json={"phone": "2065550102", "last_name": "Whitfield"}, headers=H)
ck("lookups inside the cap go through", r1.status_code == 200 and r2.status_code == 200 and len(calls) == 2)
r3 = c.post("/api/verify-phone", json={"phone": "2065550103", "last_name": "Whitfield"}, headers=H)
ck("the next one is refused with a sentence naming the approved cap",
   r3.status_code == 400 and "2 WhitePages lookups you approved" in r3.json()["detail"], r3.json())
ck("  ...and nothing was sent to WhitePages", len(calls) == 2)
r4 = c.post("/api/verify-phone", json={"phone": "2065550101", "last_name": "Whitfield"}, headers=H)
ck("an answer already cached costs nothing and is not refused", r4.status_code == 200 and len(calls) == 2)
ck("the server's count is 2", c.get("/api/autopilot", params={"list_id": "default"}).json()["job"]["wp_spent"] == 2)
r5 = c.post("/api/verify-phone", json={"phone": "2065550104", "last_name": "Whitfield"})
ck("a lookup outside the run is not held to the run's cap", r5.status_code == 200 and len(calls) == 3)

# --- progress from the page cannot touch the caps or the count -------------------------
r = c.put("/api/autopilot", json={"list_id": "default", "id": job["id"], "step": 2, "status": "paused",
                                  "progress": {"wp_spent": 0, "done": 14, "note": "x" * 500}})
j = r.json()["job"]
ck("progress is recorded", j["step"] == 2 and j["status"] == "paused" and j["progress"].get("done") == 14, j)
ck("  ...but the client cannot reset the WhitePages count or raise the cap",
   j["wp_spent"] == 2 and j["caps"]["wp"] == 2)
ck("  ...and oversized values are dropped", "note" not in j["progress"])
r6 = c.post("/api/verify-phone", json={"phone": "2065550105", "last_name": "Whitfield"}, headers=H)
ck("a paused run spends nothing", r6.status_code == 400 and "no longer active" in r6.json()["detail"])
ck("an unknown status is refused",
   c.put("/api/autopilot", json={"list_id": "default", "id": job["id"], "status": "hacked"}).status_code == 400)

# --- a new run replaces the old one ----------------------------------------------------
job2 = c.post("/api/autopilot", json={"list_id": "default", "profile": PROFILE}).json()["job"]
ck("a new run starts its own count at zero",
   c.get("/api/autopilot", params={"list_id": "default"}).json()["job"]["wp_spent"] == 0)
ck("the old run's progress writes are refused",
   c.put("/api/autopilot", json={"list_id": "default", "id": job["id"], "status": "running"}).status_code == 409)
r7 = c.post("/api/verify-phone", json={"phone": "2065550106", "last_name": "Whitfield"}, headers=H)
ck("  ...and the old run's header spends nothing", r7.status_code == 400)

# --- someone else cannot spend against it ----------------------------------------------
WHO["email"] = "eve@fpa.com"
r8 = c.post("/api/verify-phone", json={"phone": "2065550107", "last_name": "Whitfield"},
            headers={"X-Autopilot-Job": f"default:{job2['id']}"})
ck("another user's lookups cannot draw on this run", r8.status_code == 400)
WHO["email"] = "dan@fpa.com"

# --- refusals carry a code; a refused lookup is refunded ---------------------------------
job3 = c.post("/api/autopilot", json={"list_id": "default", "profile": PROFILE}).json()["job"]
H3 = {"X-Autopilot-Job": f"default:{job3['id']}"}
real_left = M._wp_left


async def no_allowance(who=""):
    return {"mine": 0, "firm": 0, "left": 0, "capped_by": "user"}
M._wp_left = no_allowance
r = c.post("/api/verify-phone", json={"phone": "2065550201", "last_name": "Whitfield"}, headers=H3)
ck("an exhausted allowance is a coded refusal", r.status_code == 400 and r.headers.get("X-Refusal") == "allowance", dict(r.headers))
ck("  ...and the run is not charged for a lookup that never went out",
   c.get("/api/autopilot", params={"list_id": "default"}).json()["job"]["wp_spent"] == 0)
M._wp_left = real_left
c.post("/api/verify-phone", json={"phone": "2065550202", "last_name": "Whitfield"}, headers=H3)
c.post("/api/verify-phone", json={"phone": "2065550203", "last_name": "Whitfield"}, headers=H3)
r = c.post("/api/verify-phone", json={"phone": "2065550204", "last_name": "Whitfield"}, headers=H3)
ck("the run cap is a coded refusal", r.status_code == 400 and r.headers.get("X-Refusal") == "run-cap")
ck("  ...and the refused attempt is given back, the count stays at the cap",
   c.get("/api/autopilot", params={"list_id": "default"}).json()["job"]["wp_spent"] == 2)

# --- one page drives a run at a time ------------------------------------------------------
put = lambda holder, take=False: c.put("/api/autopilot", json={"list_id": "default", "id": job3["id"],
                                                               "status": "running", "holder": holder, "take": take})
ck("the page driving a run can write to it", put("tabA").status_code == 200)
ck("the run reads as live while that page keeps writing",
   c.get("/api/autopilot", params={"list_id": "default"}).json()["job"]["live"] is True)
r = put("tabB")
ck("a second page is refused while the first is live", r.status_code == 409 and "another tab" in r.json()["detail"], r.json())
ck("  ...unless it takes the run over", put("tabB", take=True).status_code == 200)
ck("  ...after which the first page is the one refused", put("tabA").status_code == 409)

# --- deleting a list deletes its run ------------------------------------------------------
camp = c.post("/api/lists", json={"name": "Scratch"}).json()["list"]["id"]
c.post("/api/autopilot", json={"list_id": camp, "profile": PROFILE})
c.delete(f"/api/lists/{camp}")
ck("a deleted list leaves no autopilot run behind",
   not any(k.startswith(f"dan@fpa.com__{camp}") for k in M._MEM_AUTOPILOT))

# --- discard ---------------------------------------------------------------------------
c.delete("/api/autopilot", params={"list_id": "default"})
ck("a discarded run is gone", c.get("/api/autopilot", params={"list_id": "default"}).json()["job"] is None)

print(("\nFAILURES: %d of %d" % (bad, n)) if bad else "\nall %d checks passed" % n)
sys.exit(1 if bad else 0)
