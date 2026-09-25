"""'Delete this person' reaches the sealed lookup cache.

WhitePages and Attom answers are cached firm-wide under a hash of the query,
so a deletion cannot find them by person. Every paid lookup now reports the
cache ids it used (X-Cache-Refs), the server records that this user asked,
and a deletion purges exactly those ids — and only ones its caller looked up.

The vendor call is stubbed (no credits, no network); the Firestore helpers are
replaced by a dict so the durable cache purge is actually observable.
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

# A dict standing in for Firestore, so FS_CACHE deletes can be seen.
STORE: dict = {}


async def fs_get(col, key): return STORE.get((col, key))
async def fs_set(col, key, val): STORE[(col, key)] = dict(val); return True
async def fs_del(col, key): return STORE.pop((col, key), None) is not None
M._fs_get, M._fs_set, M._fs_del = fs_get, fs_set, fs_del

M.WHITEPAGES_API_KEY = "wp-test-not-real"
fetched = []


async def fake_fetch(kind, params, key, who=""):
    fetched.append(key)
    out = {"results": [{"name": "Dana Whitfield", "line_type": "Mobile", "carrier": "T-Mobile",
                        "is_valid": True}]}
    await M._wp_remember(key, out)
    return out
M._wp_fetch = fake_fetch

c = TestClient(M.app)
n = 0; bad = 0


def ck(name, cond, d=""):
    global n, bad
    n += 1
    print(("ok   " if cond else "FAIL ") + name + ("  " + str(d)[:110] if d else ""))
    if not cond:
        bad += 1


# --- a paid lookup reports the cache entry it used --------------------------------
r = c.post("/api/verify-phone", json={"phone": "2065550123", "first_name": "Dana", "last_name": "Whitfield"})
refs = [x for x in (r.headers.get("X-Cache-Refs") or "").split(",") if x]
ck("a WhitePages lookup reports its cache id", r.status_code == 200 and len(refs) == 1, (r.status_code, refs))
ck("  ...as a hash, never the query", refs and M.CACHE_REF_RE.match(refs[0]) and "2065550123" not in refs[0], refs)
ref = refs[0] if refs else ""
ck("  ...the sealed answer is in the durable cache", (M.FS_CACHE, ref) in STORE)
ck("  ...and the server recorded who asked", (M.FS_CACHE_OWNERS, f"dan@fpa.com|{ref}") in STORE)
r2 = c.post("/api/verify-phone", json={"phone": "2065550123", "last_name": "Whitfield"})
ck("a repeat is served from cache and still reports the id",
   len(fetched) == 1 and r2.headers.get("X-Cache-Refs") == ref)
ck("a request that looks nothing up carries no header", "X-Cache-Refs" not in c.get("/api/me").headers)

# --- someone else cannot purge it ---------------------------------------------------
WHO["email"] = "eve@fpa.com"
r = c.post("/api/leads/forget", json={"keys": ["em:dana@boeing.com"], "cache_refs": [ref]}).json()
ck("a user who never looked it up purges nothing", r.get("cache_purged") == 0 and (M.FS_CACHE, ref) in STORE, r)
WHO["email"] = "dan@fpa.com"

# --- the asker's deletion purges it ---------------------------------------------------
r = c.post("/api/leads/forget", json={"keys": ["em:dana@boeing.com"],
                                     "cache_refs": [ref, "wp:" + "0" * 64, "not-a-ref", "../etc"]}).json()
ck("the asker's deletion purges the cached answer", r.get("cache_purged") == 1, r)
ck("  ...gone from the durable cache", (M.FS_CACHE, ref) not in STORE)
ck("  ...and from this instance's memory", not any(M._cache_ref("wp", k) == ref for k in M._WP_CACHE))
ck("  ...and the ownership record goes with it", (M.FS_CACHE_OWNERS, f"dan@fpa.com|{ref}") not in STORE)
ck("unknown and malformed refs are ignored, not errors", r.get("ok") is True)
c.post("/api/verify-phone", json={"phone": "2065550123", "last_name": "Whitfield"})
ck("asking again after deletion is a fresh (paid) lookup — the answer really went", len(fetched) == 2)


# --- refs are gathered from every row about to go, not just the one on screen --
M._WP_CACHE.clear()
r = c.post("/api/verify-phone", json={"phone": "2065550199", "last_name": "Whitfield"})
ref2 = r.headers.get("X-Cache-Refs")
c.get("/api/lists")
camp = c.post("/api/lists", json={"name": "Boeing SCS"}).json()["list"]["id"]
# The lookup ran on the campaign copy; the master copy on screen has no refs.
c.put(f"/api/lists/{camp}", json={"leads": [{"id": "c1", "email": "dana.w2@boeing.com", "cacheRefs": [ref2]}]})
c.put("/api/lists/default", json={"leads": [{"id": "m1", "email": "dana.w2@boeing.com"}]})
r = c.post("/api/leads/forget", json={"keys": ["lid:m1", "em:dana.w2@boeing.com"], "cache_refs": []}).json()
ck("a lookup run on another list's copy is still purged", r.get("cache_purged") == 1 and (M.FS_CACHE, ref2) not in STORE, r)

# --- a failed delete is not a purge, and is retried ---------------------------------
r = c.post("/api/verify-phone", json={"phone": "2065550177", "last_name": "Whitfield"})
ref3 = r.headers.get("X-Cache-Refs")
real_del, real_fs = M._fs_del, M._firestore


async def flaky_del(col, key):
    return False if col == M.FS_CACHE else await real_del(col, key)
M._fs_del, M._firestore = flaky_del, (lambda: object())
r = c.post("/api/leads/forget", json={"keys": ["em:x@y.com"], "cache_refs": [ref3]}).json()
ck("a Firestore delete that fails is reported, not counted as purged",
   r.get("cache_purged") == 0 and r.get("cache_failed") == 1, r)
ck("  ...the entry and its ownership record both survive, so it can be retried",
   (M.FS_CACHE, ref3) in STORE and (M.FS_CACHE_OWNERS, f"dan@fpa.com|{ref3}") in STORE)
M._fs_del, M._firestore = real_del, real_fs
r = c.post("/api/leads/forget", json={"keys": ["em:someone@else.com"], "cache_refs": []}).json()
ck("the next deletion retries it, even without being handed the id again",
   r.get("cache_purged") == 1 and (M.FS_CACHE, ref3) not in STORE, r)
r = c.post("/api/leads/forget", json={"keys": ["em:third@else.com"], "cache_refs": []}).json()
ck("  ...and once purged it is not retried forever", r.get("cache_purged") == 0 and r.get("cache_failed") == 0, r)

print(("\nFAILURES: %d of %d" % (bad, n)) if bad else "\nall %d checks passed" % n)
sys.exit(1 if bad else 0)
