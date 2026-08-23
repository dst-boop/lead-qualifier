"""ZoomInfo through the MCP connector, using the user's own token.

The bug this replaces: the app sent `mcp_servers` with no matching `mcp_toolset`
entry and no mcp-client beta, which the API rejects as a validation error. These
checks assert the request Anthropic actually receives, because that shape is the
whole feature.

mcp.zoominfo.com is unreachable from the environment this was written in, so the
Anthropic client is stubbed and what is verified is our half of the contract.
"""
import json, os, sys, time

os.environ["NO_PROXY"] = os.environ["no_proxy"] = "127.0.0.1,localhost"
for k in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"):
    os.environ.pop(k, None)
os.environ.update(ANTHROPIC_API_KEY="stub-key", APP_BASE_URL="http://127.0.0.1:8730")

sys.path.insert(0, os.path.abspath("."))
from webapp import main                                        # noqa: E402
from fastapi.testclient import TestClient                      # noqa: E402

SENT = []
REPLY = {"blocks": [("mcp_tool_result", ['{"data":[{"id":1,"lastName":"Whitfield"}]}'])],
         "stop_reason": "end_turn"}


class _Part:
    def __init__(self, t): self.text = t


class _Block:
    def __init__(self, kind, payload):
        self.type = kind
        if kind == "mcp_tool_result":
            self.content = [_Part(t) for t in payload]
        else:
            self.text = payload


class _Msg:
    def __init__(self):
        self.stop_reason = REPLY["stop_reason"]
        self.content = [_Block(k, v) for k, v in REPLY["blocks"]]


class _BetaMessages:
    async def create(self, **kw):
        SENT.append(kw)
        if REPLY.get("raise"):
            raise REPLY["raise"]
        return _Msg()


class _Beta:
    def __init__(self): self.messages = _BetaMessages()


class _Fake:
    def __init__(self, **kw): self.beta = _Beta()


main.anthropic.AsyncAnthropic = _Fake

fail = 0
TOTAL = [0]


def ck(name, cond, detail=""):
    global fail
    TOTAL[0] += 1
    print(("ok   " if cond else "FAIL ") + name + ("  " + str(detail) if detail else ""))
    if not cond:
        fail += 1


def signed_in(sid):
    main._MEM_SESSIONS[sid] = {"provider": "google",
                               "google": {"access_token": "t", "expires_at": time.time() + 9999}}


c = TestClient(main.app, base_url="http://127.0.0.1:8730", follow_redirects=False)
signed_in("s1")
c.cookies.set(main.SESSION_COOKIE, "s1")

# --- 1. signed out ------------------------------------------------------------
anon = TestClient(main.app, base_url="http://127.0.0.1:8730")
ck("signed out cannot save a token",
   anon.post("/api/zi/mcp-token", json={"token": "x"}).status_code == 401)
ck("signed out cannot query", anon.post("/api/zi/mcp", json={"prompt": "hi"}).status_code == 401)

# --- 2. no token saved --------------------------------------------------------
r = c.post("/api/zi/mcp", json={"prompt": "find people"})
ck("no token = 401, not a silent empty result", r.status_code == 401, r.status_code)
ck("  ...and says where to put one", "ICP settings" in r.json().get("detail", ""), r.json().get("detail"))
ck("  ...nothing was sent to Claude", len(SENT) == 0)

# --- 3. saving a token --------------------------------------------------------
r = c.post("/api/zi/mcp-token", json={"token": "zi-tok-abc"})
ck("token saves", r.status_code == 200 and r.json().get("connected") is True, r.text[:80])
ck("  ...into the session, where KMS covers it",
   main._MEM_SESSIONS["s1"]["zi_mcp"]["token"] == "zi-tok-abc")

me = c.get("/api/me").json() if False else None   # /api/me needs a live userinfo; state checked directly
ck("  ...and the reader sees it", main._zi_mcp_token(main._MEM_SESSIONS["s1"]) == "zi-tok-abc")

# --- 4. THE contract: both halves of the MCP connector ------------------------
SENT.clear()
r = c.post("/api/zi/mcp", json={"prompt": "senior execs in NJ"})
ck("query succeeds", r.status_code == 200, r.text[:120])
kw = SENT[0]
ck("the mcp-client beta is sent", kw.get("betas") == ["mcp-client-2025-11-20"], kw.get("betas"))
srv = (kw.get("mcp_servers") or [{}])[0]
ck("the server is declared by URL", srv.get("type") == "url" and srv.get("url") == "https://mcp.zoominfo.com/mcp", srv.get("url"))
ck("  ...carrying THIS user's token", srv.get("authorization_token") == "zi-tok-abc", srv.get("authorization_token"))
tools = kw.get("tools") or []
ck("an mcp_toolset entry is present — omitting it is a validation error",
   any(t.get("type") == "mcp_toolset" for t in tools), tools)
ck("  ...and it names the same server",
   tools and tools[0].get("mcp_server_name") == srv.get("name"),
   [t.get("mcp_server_name") for t in tools] + [srv.get("name")])
ck("the prompt is passed through",
   kw["messages"][0]["content"] == "senior execs in NJ", kw["messages"][0]["content"])
ck("results come back raw, not parsed",
   r.json()["results"] == ['{"data":[{"id":1,"lastName":"Whitfield"}]}'], r.json()["results"])

# --- 5. max_tokens is clamped, not trusted -----------------------------------
SENT.clear()
c.post("/api/zi/mcp", json={"prompt": "x", "max_tokens": 999999})
ck("an absurd max_tokens is clamped", SENT[0]["max_tokens"] == 16000, SENT[0]["max_tokens"])
SENT.clear()
c.post("/api/zi/mcp", json={"prompt": "x", "max_tokens": 1})
ck("  ...and a tiny one is floored", SENT[0]["max_tokens"] == 256, SENT[0]["max_tokens"])

# --- 6. failure modes ---------------------------------------------------------
REPLY["blocks"] = [("text", "I could not reach ZoomInfo.")]
r = c.post("/api/zi/mcp", json={"prompt": "x"})
ck("no tool result returns the text so the user sees why",
   r.status_code == 200 and r.json()["results"] == [] and "could not reach" in r.json()["text"],
   json.dumps(r.json())[:120])

REPLY["stop_reason"] = "refusal"
r = c.post("/api/zi/mcp", json={"prompt": "x"})
ck("a refusal is an error, not an empty list", r.status_code == 502, r.status_code)
REPLY["stop_reason"] = "end_turn"

class _Boom(Exception):
    pass
REPLY["raise"] = main.anthropic.APIError("boom", request=None, body=None) \
    if hasattr(main.anthropic, "APIError") else _Boom("boom")
r = c.post("/api/zi/mcp", json={"prompt": "x"})
ck("an API error surfaces as 502", r.status_code == 502, r.status_code)
REPLY["raise"] = None
REPLY["blocks"] = [("mcp_tool_result", ['{"data":[]}'])]

# --- 7. clearing --------------------------------------------------------------
r = c.post("/api/zi/mcp-token", json={"token": ""})
ck("an empty token clears the saved one", r.json().get("connected") is False)
ck("  ...and it is gone from the session", "zi_mcp" not in main._MEM_SESSIONS["s1"])
ck("  ...so queries refuse again", c.post("/api/zi/mcp", json={"prompt": "x"}).status_code == 401)

# --- 8. one user's token is not another's ------------------------------------
# Each account needs its own client — reusing `c` here would write back to s1,
# whose token test 7 just cleared.
signed_in("s2")
cs2 = TestClient(main.app, base_url="http://127.0.0.1:8730")
cs2.cookies.set(main.SESSION_COOKIE, "s2")
cs2.post("/api/zi/mcp-token", json={"token": "mine"})
ck("the second account's token is its own", main._zi_mcp_token(main._MEM_SESSIONS["s2"]) == "mine")
ck("  ...and did not leak back to the first",
   main._zi_mcp_token(main._MEM_SESSIONS["s1"]) == "", main._zi_mcp_token(main._MEM_SESSIONS["s1"]))
c2 = TestClient(main.app, base_url="http://127.0.0.1:8730")
signed_in("s3")
c2.cookies.set(main.SESSION_COOKIE, "s3")
ck("a second account has no token", main._zi_mcp_token(main._MEM_SESSIONS["s3"]) == "")
ck("  ...and cannot query", c2.post("/api/zi/mcp", json={"prompt": "x"}).status_code == 401)

# --- 9. the debug probe -------------------------------------------------------
r = c.get("/api/zi/mcp-debug")
ck("debug reports the missing token rather than throwing",
   r.status_code == 200 and "No ZoomInfo MCP token" in r.json().get("error", ""), r.json())
c.post("/api/zi/mcp-token", json={"token": "zi-tok-abc"})
SENT.clear()
REPLY["blocks"] = [("text", "search_contacts, enrich_contacts")]
r = c.get("/api/zi/mcp-debug")
d = r.json()
ck("debug names the URL it tried", d.get("mcp_url") == "https://mcp.zoominfo.com/mcp", d.get("mcp_url"))
ck("  ...lists the block types that came back", d.get("block_types") == ["text"], d.get("block_types"))
ck("  ...and uses the same two-part shape",
   SENT[0].get("betas") == ["mcp-client-2025-11-20"]
   and any(t.get("type") == "mcp_toolset" for t in SENT[0].get("tools") or []), SENT[0].get("tools"))

print(("\nFAILURES: %d of %d" % (fail, TOTAL[0])) if fail else "\nall %d checks passed" % TOTAL[0])
sys.exit(1 if fail else 0)
