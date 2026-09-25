"""Tier 4 profile screenshots, and "delete this person".

The screenshot route sends one operator-chosen image to the Claude API and
keeps nothing. This suite cannot reach the API, so it stubs the client and
proves everything around the call: the gates refuse before a token is spent,
the image travels as an image block and is never written to storage, the
findings are quoted or dropped, and the token cost comes back to be reported.

Then the purge path the new fields add obligations to: one call removes a
person from every list the caller owns, master included, and leaves a
namesake at another employer alone.
"""
import base64, json, os, sys

os.environ["USE_FIRESTORE"] = "0"
os.environ.setdefault("SESSION_SECRET", "t" * 32)
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from fastapi.testclient import TestClient
import webapp.main as M


async def fake_email(request): return "dan@fpa.com"
async def fake_active(request): return ("google", "tok")
M._signed_in_email = fake_email
M._active_token = fake_active
c = TestClient(M.app)
n = 0; bad = 0


def ck(name, cond, d=""):
    global n, bad
    n += 1
    print(("ok   " if cond else "FAIL ") + name + ("  " + str(d)[:110] if d else ""))
    if not cond:
        bad += 1


PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
png_url = "data:image/png;base64," + base64.b64encode(PNG).decode()
lead = {"first_name": "Dana", "last_name": "Whitfield", "employer": "Boeing"}

# --- the gates -----------------------------------------------------------------
M.ANTHROPIC_API_KEY = ""
r = c.post("/api/profile-image", json={**lead, "image": png_url})
ck("without a key the route says which key", r.status_code == 400 and "ANTHROPIC_API_KEY" in r.json()["detail"])
ck("the feature flag follows the key", c.get("/api/me").json().get("features", {}).get("profile_image") in (False, None))

M.ANTHROPIC_API_KEY = "sk-test-not-real"
calls = []


class Usage:
    input_tokens = 1400
    output_tokens = 310


class Block:
    type = "text"

    def __init__(self, t): self.text = t


REPLY = {"text": "{}"}


class FakeMessages:
    async def create(self, **kw):
        calls.append(kw)
        return type("Msg", (), {"content": [Block(REPLY["text"])], "stop_reason": "end_turn", "usage": Usage()})()


class FakeClient:
    def __init__(self, **kw): self.messages = FakeMessages()


M.anthropic.AsyncAnthropic = FakeClient

r = c.post("/api/profile-image", json={**lead, "last_name": "", "image": png_url})
ck("no last name, no call — a namesake check needs one", r.status_code == 400 and not calls, r.json())
r = c.post("/api/profile-image", json={**lead, "image": "https://linkedin.com/in/dana"})
ck("a URL is not an image: there is no fetch path", r.status_code == 415 and not calls, r.json())
r = c.post("/api/profile-image", json={**lead, "image": "data:image/svg+xml;base64,PHN2Zz4="})
ck("SVG is refused (scriptable, and not a screenshot)", r.status_code == 415 and not calls)
jpeg_lie = "data:image/jpeg;base64," + base64.b64encode(PNG).decode()
r = c.post("/api/profile-image", json={**lead, "image": jpeg_lie})
ck("a file whose bytes contradict its type is refused before spending", r.status_code == 415 and not calls, r.json())
big = "data:image/png;base64," + base64.b64encode(b"\x89PNG" + b"\x00" * (M.PROFILE_IMAGE_MAX_BYTES + 10)).decode()
r = c.post("/api/profile-image", json={**lead, "image": big})
ck("over 5 MB is refused with a crop hint", r.status_code == 413 and "Crop" in r.json()["detail"] and not calls)
r = c.post("/api/profile-image", json={**lead, "image": "data:image/png;base64,@@@@"})
ck("garbage base64 is refused", r.status_code in (400, 415) and not calls)

# --- a real read, stubbed --------------------------------------------------------
writes = []
orig_set = M._fs_set


async def spy_set(col, key, val):
    writes.append((col, key))
    return await orig_set(col, key, val)
M._fs_set = spy_set

REPLY["text"] = "Here you go:\n" + json.dumps({
    "profile_name": "Dana Whitfield",
    "location": {"city": "Seattle", "state": "wa", "quote": "Greater Seattle Area"},
    "education": [
        {"school": "Purdue University", "degree": "BS", "field": "Mechanical Engineering",
         "start_year": 1982, "end_year": 1986, "quote": "Purdue University BS, Mechanical Engineering 1982 - 1986"},
        {"school": "University of Washington", "degree": "MBA", "end_year": 1994,
         "quote": "University of Washington MBA 1994"},
        {"school": "Nowhere", "degree": "BA", "end_year": 1990},                # unquoted
    ],
    "certifications": [{"name": "PE", "issuer": "WA DOL", "year": 1991, "quote": "Professional Engineer (PE)"},
                       {"name": "PMP"}],                                          # unquoted
    "career": [
        {"title": "Director, Propulsion", "employer": "Boeing", "start_year": 1996, "current": True,
         "quote": "Director, Propulsion · Boeing · 1996 - Present"},
        {"title": "Engineer", "employer": "Pratt & Whitney", "start_year": 1986, "end_year": 1996,
         "quote": "Engineer · Pratt & Whitney · 1986 - 1996"},
        {"title": "Time traveller", "start_year": 2010, "end_year": 1990, "quote": "odd"},
    ],
    "interests": [{"text": "Habitat for Humanity volunteer", "quote": "Volunteer, Habitat for Humanity"}],
})
r = c.post("/api/profile-image", json={**lead, "image": png_url})
d = r.json()
ck("a good screenshot reads", r.status_code == 200 and d["ok"], d)
ck("  ...the image went to Claude as an image block, not text",
   calls and calls[-1]["messages"][0]["content"][0]["type"] == "image"
   and calls[-1]["messages"][0]["content"][0]["source"]["media_type"] == "image/png")
prompt = calls[-1]["messages"][0]["content"][1]["text"]
ck("  ...and the prompt forbids reading a photograph for age or appearance",
   "photograph" in prompt and "age" in prompt and "Do not compute an age" in prompt)
ck("  ...and nothing about it was written to storage", writes == [], writes)
ck("  ...and the response says so", d.get("stored") is False)
ck("  ...with the token cost to report", d["tokens"] == {"input": 1400, "output": 310}, d.get("tokens"))
f = d["found"]
ck("unquoted lines are dropped", len(f["education"]) == 2 and len(f["certifications"]) == 1, (len(f["education"]), len(f["certifications"])))
ck("a year range running backwards loses its years, not its line",
   any(x["title"] == "Time traveller" and x["start_year"] is None for x in f["career"]))
ck("the bachelor's year is the graduation proxy — not the MBA",
   f["grad_year"] and f["grad_year"]["year"] == 1986 and "Purdue" in f["grad_year"]["quote"], f["grad_year"])
ck("career start is the earliest printed start", f["career_start"]["year"] == 1986, f["career_start"])
ck("state normalised", f["location"]["state"] == "WA")

clean = M._clean_image_findings
g = clean({"education": [{"school": "State U", "degree": "Master of Science", "end_year": 1990, "quote": "q"}]})
ck("a master's alone yields no graduation proxy", g["grad_year"] is None)
g = clean({"education": [{"school": "State U", "degree": "Bachelor of Arts", "end_year": 1979, "quote": "q"}]})
ck("'Bachelor of Arts' counts", g["grad_year"] and g["grad_year"]["year"] == 1979)
g = clean({"education": [{"school": "State U", "end_year": 1979, "quote": "q"}]})
ck("an unlabeled degree is not guessed to be a bachelor's", g["grad_year"] is None)
g = clean({"education": 5, "career": "VP at Boeing", "certifications": {"name": "PE"}, "interests": None})
ck("wrong shapes are dropped, not a 500", g["education"] == [] and g["career"] == [] and g["certifications"] == [])
g = clean("not a dict")
ck("junk in, empty out", g["education"] == [] and g["location"] is None)
g = clean({"location": {"city": "Austin", "state": "TX"}})
ck("an unquoted location is dropped", g["location"] is None)

REPLY["text"] = "I could not find anything."
r = c.post("/api/profile-image", json={**lead, "image": png_url})
ck("no JSON back is a loud 502, not an empty success", r.status_code == 502)

# --- delete this person ----------------------------------------------------------
dana = {"id": "d1", "firstName": "Dana", "lastName": "Whitfield", "employer": "Boeing",
        "email": "dana@boeing.com", "img": {"found": {"education": []}},
        "profile": {"education": [{"school": "Purdue"}]}, "hd": {"age": 61}}
dana_copy = dict(dana, id="d1")                                       # master copy of the same row
namesake = {"id": "n1", "firstName": "Dana", "lastName": "Whitfield", "employer": "Chevron",
            "email": "dana.w@chevron.com"}
other = {"id": "o1", "firstName": "Ada", "lastName": "Lee", "employer": "Delta"}
c.get("/api/lists")
c.put("/api/lists/default", json={"leads": [dana_copy, namesake, other]})
camp = c.post("/api/lists", json={"name": "Boeing SCS"}).json()["list"]["id"]
c.put(f"/api/lists/{camp}", json={"leads": [dict(dana, id="d9")]})   # a different row id, same email

r = c.post("/api/leads/forget", json={"keys": ["lid:d1", "em:dana@boeing.com"]})
d = r.json()
ck("forget answers with where it removed from", r.status_code == 200 and d["total"] == 2, d)
master = c.get("/api/lists/default").json()["leads"]
ck("  ...the master copy is gone — the archive is not exempt",
   [x["id"] for x in master] == ["n1", "o1"], [x["id"] for x in master])
ck("  ...the campaign copy is gone too", c.get(f"/api/lists/{camp}").json()["leads"] == [])
ck("  ...the namesake at another employer is untouched", any(x["id"] == "n1" for x in master))
counts = {l["id"]: l["count"] for l in c.get("/api/lists").json()["lists"]}
ck("  ...and the index counts follow", counts.get("default") == 2 and counts.get(camp) == 0, counts)
r = c.post("/api/leads/forget", json={"keys": []})
ck("no keys, no sweep", r.status_code == 400)
r = c.post("/api/leads/forget", json={"keys": ["nonsense"]})
ck("keys without a kind are ignored, not matched loosely", r.status_code == 400)

lk = M._lead_keys({"id": "a", "contactId": 7, "email": " X@Y.com ", "linkedinUrl": "https://LinkedIn.com/in/x/?trk=1",
                   "firstName": "A", "lastName": "B", "employer": "Co"})
ck("server keys mirror the client's dedupeKeys",
   lk == {"lid:a", "id:7", "em:x@y.com", "li:https://linkedin.com/in/x", "ne:a b@co"}, lk)

print(("\nFAILURES: %d of %d" % (bad, n)) if bad else "\nall %d checks passed" % n)
sys.exit(1 if bad else 0)
