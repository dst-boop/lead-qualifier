"""Sharing, the leaderboard and contests.

A list belongs to whoever built it. Sharing grants one named colleague access to
one list — there is no firm-wide pool and no way to enumerate what has not been
shared with you, which is what the outsider and viewer cases here pin down.

The leaderboard reads per-advisor daily counters rather than deriving totals
from everyone's leads: drawing one table should not mean reading every lead in
the firm, and a counter document leaks a number where a lead document would leak
a prospect.
"""
import os, json, sys, re
os.environ["USE_FIRESTORE"]="0"; os.environ["APP_BASE_URL"]="http://127.0.0.1:8125"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from fastapi.testclient import TestClient
import webapp.main as M
WHO={"e":"dan@fpa.com"}
async def em(r): return WHO["e"]
M._signed_in_email=em
async def act(r): return ("google","t")
M._active_token=act
c=TestClient(M.app)
n=bad=0
def ck(name,cond,d=""):
    global n,bad;n+=1
    print(("ok   " if cond else "FAIL ")+name+("  "+str(d) if d else ""));
    if not cond: bad+=1

lid=c.get("/api/lists").json()["lists"][0]["id"]
c.put(f"/api/lists/{lid}",json={"leads":[{"id":"a","firstName":"Ada"}]})
r=c.post(f"/api/lists/{lid}/shares",json={"email":"sam@fpa.com","role":"editor"})
ck("a list can be shared", r.status_code==200 and r.json()["shares"][0]["email"]=="sam@fpa.com", r.json())

WHO["e"]="sam@fpa.com"
ls=c.get("/api/lists").json()["lists"]
sh=[l for l in ls if l.get("owner")]
ck("the recipient sees it in their switcher", len(sh)==1 and sh[0]["owner"]=="dan@fpa.com", sh)
ck("  ...addressed as owner~id", sh[0]["id"]=="dan@fpa.com~"+lid, sh[0]["id"])
ck("  ...and it does not become one of their own", len([l for l in ls if not l.get("owner")])==1)
g=c.get(f"/api/lists/{sh[0]['id']}").json()
ck("the recipient can read the leads", [l["firstName"] for l in g["leads"]]==["Ada"], g.get("leads"))
w=c.put(f"/api/lists/{sh[0]['id']}",json={"leads":[{"id":"a","firstName":"Ada"},{"id":"b","firstName":"Ben"}]})
ck("an editor can write back", w.status_code==200, w.status_code)
WHO["e"]="dan@fpa.com"
ck("  ...and the owner sees the edit", len(c.get(f"/api/lists/{lid}").json()["leads"])==2)

# viewer role
c.post(f"/api/lists/{lid}/shares",json={"email":"vic@fpa.com","role":"viewer"})
WHO["e"]="vic@fpa.com"
ref="dan@fpa.com~"+lid
ck("a viewer can read", c.get(f"/api/lists/{ref}").status_code==200)
vw=c.put(f"/api/lists/{ref}",json={"leads":[]})
ck("  ...but not write", vw.status_code==403, vw.status_code)
ck("  ...with a reason", "view-only" in vw.json()["detail"], vw.json()["detail"])
ck("a recipient cannot delete the owner's list", c.delete(f"/api/lists/{ref}").status_code==403)
ck("  ...nor see who else it is shared with", c.get(f"/api/lists/{ref}/shares").status_code==403)
ck("a recipient CAN drop their own access", c.delete(f"/api/lists/{ref}/shares/vic@fpa.com").status_code==200)
ck("  ...and then it is gone from their switcher",
   not [l for l in c.get("/api/lists").json()["lists"] if l.get("owner")])

# an outsider
WHO["e"]="mallory@other.com"
ck("someone not shared with gets 403", c.get(f"/api/lists/{ref}").status_code==403)
ck("  ...and cannot write", c.put(f"/api/lists/{ref}",json={"leads":[]}).status_code==403)

# revoke
WHO["e"]="dan@fpa.com"
c.delete(f"/api/lists/{lid}/shares/sam@fpa.com")
WHO["e"]="sam@fpa.com"
ck("revoking removes it from the recipient",
   not [l for l in c.get("/api/lists").json()["lists"] if l.get("owner")])
ck("  ...and access is refused", c.get(f"/api/lists/{ref}").status_code==403)

# deleting a shared list revokes it. A campaign list, deliberately: the first
# list is the master now, and the master refuses deletion outright.
WHO["e"]="dan@fpa.com"
n2=c.post("/api/lists",json={"name":"Second"}).json()["list"]["id"]
c.post(f"/api/lists/{n2}/shares",json={"email":"sam@fpa.com"})
c.delete(f"/api/lists/{n2}")
WHO["e"]="sam@fpa.com"
ck("deleting a list revokes it from everyone",
   not [l for l in c.get("/api/lists").json()["lists"] if l.get("owner")])

# --- stats + leaderboard ---
WHO["e"]="dan@fpa.com"
c.put("/api/stats",json={"calls":20,"emails":5,"invites":2,"meetings":1})
WHO["e"]="sam@fpa.com"
c.put("/api/stats",json={"calls":40,"emails":0,"invites":0,"meetings":0})
WHO["e"]="dan@fpa.com"
lb=c.get("/api/leaderboard?days=7").json()
ck("the leaderboard covers the domain", lb["team_size"]>=2, lb["team_size"])
by={r["email"]:r for r in lb["rows"]}
ck("  ...counting each advisor's own totals", by["dan@fpa.com"]["calls"]==20 and by["sam@fpa.com"]["calls"]==40)
ck("  ...a meeting outweighs a wall of dials",
   by["dan@fpa.com"]["points"]>by["sam@fpa.com"]["points"],
   f"{by['dan@fpa.com']['points']} vs {by['sam@fpa.com']['points']}")
ck("  ...and it is ranked", lb["rows"][0]["rank"]==1 and lb["rows"][0]["email"]=="dan@fpa.com")
ck("  ...marking you", by["dan@fpa.com"]["you"] is True and by["sam@fpa.com"]["you"] is False)
c.put("/api/stats",json={"calls":20,"emails":5,"invites":2,"meetings":1})
lb2=c.get("/api/leaderboard?days=7").json()
ck("stats are totals, so a replay cannot inflate a score",
   {r["email"]:r for r in lb2["rows"]}["dan@fpa.com"]["calls"]==20)
ck("someone at another firm is not on the board",
   "mallory@other.com" not in by, list(by))

# --- battles ---
b=c.post("/api/battles",json={"name":"Friday dials","days":1,"opponents":["sam@fpa.com"],"metric":"calls"})
ck("a contest can be started", b.status_code==200, b.json())
bid=b.json()["battle"]["id"]
bs=c.get("/api/battles").json()["battles"]
ck("  ...and appears for the person who started it", len(bs)==1 and bs[0]["name"]=="Friday dials")
ck("  ...scored on the chosen metric",
   {r["email"]:r["points"] for r in bs[0]["rows"]}=={"dan@fpa.com":20,"sam@fpa.com":40},
   {r["email"]:r["points"] for r in bs[0]["rows"]})
ck("  ...ranked by it", bs[0]["rows"][0]["email"]=="sam@fpa.com")
WHO["e"]="sam@fpa.com"
ck("the opponent sees it too", len(c.get("/api/battles").json()["battles"])==1)
ck("  ...but cannot end it", c.delete(f"/api/battles/{bid}").status_code==403)
WHO["e"]="vic@fpa.com"
ck("someone not in it does not see it", len(c.get("/api/battles").json()["battles"])==0)
WHO["e"]="dan@fpa.com"
ck("the starter can end it", c.delete(f"/api/battles/{bid}").status_code==200)
ck("a solo contest is refused", c.post("/api/battles",json={"name":"x","opponents":[]}).status_code==400)
ck("an unnamed contest is refused", c.post("/api/battles",json={"name":" ","opponents":["s@f.com"]}).status_code==400)

WHO["e"]=""
ck("signed out sees no leaderboard", c.get("/api/leaderboard").status_code==401)
ck("  ...no battles", c.get("/api/battles").status_code==401)
ck("  ...and cannot post stats", c.put("/api/stats",json={"calls":1}).status_code==401)
print()
print(f"FAILURES {bad} of {n}" if bad else f"all {n} checks passed")
sys.exit(1 if bad else 0)
