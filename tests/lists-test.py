"""Named lead lists, server-side.

One advisor runs several campaigns at once and the lists must not see each
other. Each list is its own Firestore document keyed email__listId, so a
five-thousand-row import cannot crowd the others towards the per-document
limit, and opening the app reads an index of names and counts rather than
every lead the user owns.
"""
import os, json, sys
os.environ["USE_FIRESTORE"]="0"; os.environ["APP_BASE_URL"]="http://127.0.0.1:8123"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from fastapi.testclient import TestClient
import webapp.main as M

# stand in for a signed-in user
async def fake_email(request): return "dan@fpa.com"
M._signed_in_email=fake_email
async def fake_active(request): return ("google","tok")
M._active_token=fake_active
c=TestClient(M.app)
n=0;bad=0
def ck(name,cond,d=""):
    global n,bad;n+=1
    print(("ok   " if cond else "FAIL ")+name+("  "+str(d) if d else ""))
    if not cond: bad+=1

r=c.get("/api/lists").json()
ck("a first read creates one list", len(r["lists"])==1 and r["lists"][0]["name"]=="My leads", r["lists"])
lid=r["lists"][0]["id"]
ck("  ...called default", lid=="default", lid)

c.put(f"/api/lists/{lid}",json={"leads":[{"id":"a","firstName":"Ada"},{"id":"b","firstName":"Ben"}]})
g=c.get(f"/api/lists/{lid}").json()
ck("leads round-trip", len(g["leads"])==2 and g["leads"][0]["firstName"]=="Ada", len(g["leads"]))
ck("the index carries the count", c.get("/api/lists").json()["lists"][0]["count"]==2)

r2=c.post("/api/lists",json={"name":"SCS — Boeing"}).json()
sid=r2["list"]["id"]
ck("a second list is created", len(r2["lists"])==2 and r2["list"]["name"]=="SCS — Boeing", r2["list"])
ck("  ...and starts empty", c.get(f"/api/lists/{sid}").json()["leads"]==[])
c.put(f"/api/lists/{sid}",json={"leads":[{"id":"c","firstName":"Cara"}]})
ck("the lists do not see each other",
   len(c.get(f"/api/lists/{lid}").json()["leads"])==2 and len(c.get(f"/api/lists/{sid}").json()["leads"])==1)

cp=c.post("/api/lists",json={"name":"Copy","copy_from":lid}).json()
ck("a list can be copied", len(c.get(f"/api/lists/{cp['list']['id']}").json()["leads"])==2)

rn=c.patch(f"/api/lists/{sid}",json={"name":"SCS Q3"}).json()
ck("rename works", rn["list"]["name"]=="SCS Q3")
ck("  ...and shows in the index", any(l["name"]=="SCS Q3" for l in c.get("/api/lists").json()["lists"]))

d=c.delete(f"/api/lists/{sid}")
ck("delete works", d.status_code==200 and len(d.json()["lists"])==2, d.status_code)
ck("  ...and the leads are gone", c.get(f"/api/lists/{sid}").status_code==404)

# cannot delete the last one
ids=[l["id"] for l in c.get("/api/lists").json()["lists"]]
for i in ids[1:]: c.delete(f"/api/lists/{i}")
last=c.delete(f"/api/lists/{ids[0]}")
ck("the only list cannot be deleted", last.status_code==400, last.status_code)
ck("  ...with a reason", "rename it instead" in last.json()["detail"], last.json()["detail"])

ck("a bad list id is refused", c.get("/api/lists/../../etc").status_code in (400,404), c.get("/api/lists/..%2F..%2Fetc").status_code)
ck("an unknown list 404s", c.put("/api/lists/nope",json={"leads":[]}).status_code==404)
ck("an unnamed list is refused", c.post("/api/lists",json={"name":"  "}).status_code==400)

c.put("/api/settings",json={"settings":{"tierA":55}})
ck("settings live on the user, not the list", c.get("/api/lists").json()["settings"]["tierA"]==55)

# --- one user's lists are invisible to another ------------------------------
async def other(request): return "sam@fpa.com"
M._signed_in_email = other
o = c.get("/api/lists").json()
ck("a second user starts with their own empty list",
   len(o["lists"])==1 and c.get(f"/api/lists/{o['lists'][0]['id']}").json()["leads"]==[])
oid = o["lists"][0]["id"]
c.put(f"/api/lists/{oid}", json={"leads":[{"id":"z","firstName":"Zoe"}]})
async def back(request): return "dan@fpa.com"
M._signed_in_email = back
mine = c.get(f"/api/lists/{ids[0]}").json()["leads"]
ck("  ...and writing to it does not touch the first user's",
   [l.get("firstName") for l in mine]==["Ada","Ben"], [l.get("firstName") for l in mine])
ck("  ...even though both are called 'default'", ids[0]=="default" and oid=="default")

# --- the migration off the pre-lists single document ------------------------
async def fresh(request): return "old@fpa.com"
M._signed_in_email = fresh
M._MEM_STATE["old@fpa.com"] = {"data": json.dumps(
    {"settings":{"tierA":61},"leads":[{"id":"1","firstName":"Legacy"}]}), "saved_at": 0}
mig = c.get("/api/lists").json()
ck("an existing single list migrates into a named list",
   len(mig["lists"])==1 and mig["lists"][0]["count"]==1, mig["lists"])
ck("  ...carrying the leads over",
   [l["firstName"] for l in c.get("/api/lists/default").json()["leads"]]==["Legacy"])
ck("  ...and the settings", mig["settings"]["tierA"]==61)
ck("  ...leaving the original array in place to fall back on",
   json.loads(M._MEM_STATE["old@fpa.com"]["data"])["leads"][0]["firstName"]=="Legacy")
ck("  ...and migrating only once",
   c.get("/api/lists").json()["lists"][0]["id"]=="default")

# --- routes that call other routes ------------------------------------------
# save_list, delete_list and the admin transfer return a fresh list index by
# calling get_lists directly. A route called as a plain function never resolves
# its dependencies, so when the signed-in address moved into the signature the
# Depends sentinel arrived where an email belonged and was used as a storage
# key. The saved list came back with the index missing, which is what this
# pins: the nested call must return real data, not a shape.
nested = c.post("/api/lists", json={"name": "Nested call"}).json()["list"]["id"]
r = c.put(f"/api/lists/{nested}", json={"leads": [{"id": "n1", "lastName": "Nested"}]})
ck("saving a list returns the index the nested call built",
   r.status_code == 200 and isinstance(r.json().get("lists"), list)
   and any(x.get("id") == nested for x in r.json()["lists"]), r.text[:140])
ck("  ...with the new count on it, so the switcher is not stale",
   any(x.get("id") == nested and x.get("count") == 1 for x in r.json()["lists"]),
   r.json().get("lists"))

# --- signed out ---------------------------------------------------------------
async def nobody(request): return ""
M._signed_in_email = nobody
ck("a signed-out visitor gets no lists", c.get("/api/lists").status_code==401)
ck("  ...and cannot write one", c.put("/api/lists/default",json={"leads":[]}).status_code==401)
ck("  ...or create one", c.post("/api/lists",json={"name":"x"}).status_code==401)

print()
print(f"FAILURES {bad} of {n}" if bad else f"all {n} checks passed")
sys.exit(1 if bad else 0)
