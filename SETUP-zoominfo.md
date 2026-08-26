# ZoomInfo — two doors, and only one needs an API entitlement

**Read this first if the DevPortal turned you away.** ZoomInfo's REST API and its
MCP server are separate doors. The REST integration below needs an API
entitlement on the subscription. The **MCP connector does not** — it takes a
token of its own, and Anthropic makes the connection on your behalf.

## The MCP route (no DevPortal, no entitlement)

Save your **ZoomInfo MCP token** under **ICP settings → ZoomInfo access**. From
then on, Build list and Enrich work in an ordinary browser: the backend asks
Claude, and Claude opens the connection to ZoomInfo's MCP server carrying *your*
token. The app never speaks ZoomInfo's protocol at all.

The token is stored on your account rather than in the browser, encrypted at
rest with the same KMS key as your Google and Microsoft refresh tokens, and is
never sent back to the page — the settings screen reports only whether one
exists. It is deliberately kept out of `state.settings`, because everything in
there is written to localStorage and synced to the lead-state document.

**Without a saved token**, Build and Enrich still work while the app is running
*inside* Claude, using whichever ZoomInfo connector is enabled on that Claude
account. That path was broken until now and is fixed here — see below.

### Configuration

| Variable | Value |
|---|---|
| `ANTHROPIC_API_KEY` | **required** — the same key AI QC uses |
| `ZI_MCP_URL` | *(optional)* defaults to `https://mcp.zoominfo.com/mcp` |
| `ZI_MCP_MODEL` | *(optional)* defaults to `CLAUDE_MODEL` |

### The bug this fixed

The in-Claude bridge sent `mcp_servers` with no matching `mcp_toolset` entry in
`tools`, and without the `mcp-client-2025-11-20` beta. Both halves are mandatory:
*"Omitting the `mcp_toolset` entry is rejected as a validation error."* The call
had been malformed, not merely limited to running inside Claude.

### Not verified

`mcp.zoominfo.com` is unreachable from the environment this was written in — the
egress gateway answers 403 to CONNECT — so **no live MCP response has been seen**.
The request shape is built from Anthropic's documented contract and asserted in
`tests/zi-mcp-test.py`; whether ZoomInfo's server accepts your token is the part
only you can answer. `/api/zi/mcp-debug` asks Claude to list the ZoomInfo tools
it can reach and returns what came back — one request settles it.

### Where the token comes from

This is the open question. If ZoomInfo publishes an MCP token in your account
settings, paste it. If their MCP server uses OAuth instead, the flow in the next
section can be repointed at it — the machinery is already built and tested, and
only the endpoints and a client registration would change. That work was not done
blind against a server this environment cannot reach.

---

# ZoomInfo REST API — each user signs into their own seat

Every advisor connects their **own** ZoomInfo account. Searches, enrichment and
credits are attributed and billed to the person who ran them, not to one shared
service login. Connecting is a second step *on top of* app sign-in: you sign in
with Google or Microsoft to use the app, then connect ZoomInfo to it.

An advisor with no ZoomInfo seat can still use the whole rest of the app — CSV
import, scoring, WhitePages verification, calling, export. They just don't see
the ZoomInfo path.

## What "connected" means

| Situation | Auth bar shows |
|---|---|
| Signed out | just the sign-in links — no ZoomInfo offer |
| Signed in, `ZI_CLIENT_ID` unset | nothing about ZoomInfo |
| Signed in, service configured | **Connect ZoomInfo** |
| Connected | **ZoomInfo connected · Disconnect** |

Two users on the same server never share a token: user B connecting does not
touch user A's seat, and a user who has not connected gets a 401 from
`/api/zi/search` telling them to connect — they cannot spend someone else's
credits.

## Registering the app

ZoomInfo's DevPortal has two kinds of app, and the distinction decides
everything here:

| | **Standard** | **Partner** |
|---|---|---|
| Who it serves | one org — your firm | many customer orgs |
| Approval | self-serve | ZoomInfo review |
| OAuth flow | Authorization Code **or** Client Credentials | Authorization Code + PKCE, mandatory |

A **Standard app is what a single firm needs**, and it may use Authorization
Code Flow precisely so that requests are attributed to an individual user. That
is the whole reason per-user sign-in is possible without partner approval.

This app sends PKCE either way. A Standard app is allowed to, a Partner app
must, so the same flow survives a later move to distributing the tool to other
firms without a rewrite.

**You need an API entitlement on your ZoomInfo subscription to get DevPortal
access at all.** If the DevPortal turns you away, that is the thing to ask your
ZoomInfo rep for — not a different login.

Steps:

1. ZoomInfo DevPortal → create a **Standard** app.
2. Set the redirect URI to exactly:
   `https://leads.financialplannersofamerica.com/auth/zoominfo/callback`
   (for local work, `http://127.0.0.1:8099/auth/zoominfo/callback` — it must
   match `APP_BASE_URL` + `/auth/zoominfo/callback`, character for character).
3. Choose **Authorization Code** flow, and enable PKCE if it is offered.
4. Copy the client ID and secret.

## Setup

Cloud Run → your service → **Edit & deploy new revision → Variables & Secrets**:

| Variable | Value |
|---|---|
| `ZI_CLIENT_ID` | client ID from the DevPortal |
| `ZI_CLIENT_SECRET` | client secret |
| `ZI_AUTH_URL` | *(optional)* defaults to `https://auth.zoominfo.com/authorize` |
| `ZI_TOKEN_URL` | *(optional)* defaults to `https://auth.zoominfo.com/oauth/token` |
| `ZI_API_BASE` | *(optional)* defaults to `https://api.zoominfo.com` |
| `ZI_SCOPES` | *(optional)* defaults to `openid profile email offline_access` |

Deploy. **Connect ZoomInfo** appears in the auth bar for every signed-in user.

### The four endpoint variables are not decoration

**The default URLs have not been exercised against a live ZoomInfo tenant.**
Outbound requests to `zoominfo.com` are blocked from the build environment, so
every probe returned 403 and the real authorize/token hostnames could not be
confirmed. They are read from the environment for exactly that reason: when the
DevPortal shows you the real values, set them here — no code change, no deploy
of new code, just the variables.

Everything on *our* side of the flow is tested against a stub that validates
PKCE, client credentials and redirect URI the way a real server would:
`scratchpad/shots/zi-oauth-test.py`.

## Troubleshooting

`/api/zi-debug` does a raw round-trip with the signed-in user's token and returns
the URL it called, the status, and the first 4 KB of the body. It exists from
day one on purpose — the WhitePages integration cost two wrong parsers before
the same probe finally showed what the API actually returned.

- **"ZoomInfo app credentials not configured"** — `ZI_CLIENT_ID` /
  `ZI_CLIENT_SECRET` are not set on the service.
- **Redirected to `/?zi=signin`** — you hit the connect URL without being
  signed into the app. Sign in first; a ZoomInfo seat is never attached to an
  anonymous session.
- **Redirected to `/?zi=state`** — the OAuth state did not match. Usually a
  stale or bookmarked callback URL; start again from the auth bar.
- **"ZoomInfo sign-in failed (404)"** with the body shown — `ZI_TOKEN_URL` is
  wrong. This is surfaced rather than swallowed because it is the most likely
  first failure.
- **`/api/zi/search` returns 502 with an upstream status** — the token is fine
  but the path or body is not. `path` is passed through verbatim, so check it
  against ZoomInfo's API reference.

## Notes

- `/api/zi/search` is a **thin passthrough, not a parser**. It hands back
  ZoomInfo's raw JSON for the client to shape. No response from a live tenant
  has been seen yet, and ADR §12's rule is not to write a parser before seeing
  one. A change at ZoomInfo's end therefore surfaces as odd data rather than as
  a silently empty list.
- Access tokens refresh automatically. A token that expires with no usable
  refresh token is cleared, and the user is asked to reconnect rather than
  shown a confusing failure.
- **Disconnect** drops the ZoomInfo token only. You stay signed into the app.
- The in-Claude ZoomInfo bridge (`callClaude`) still exists and is unchanged. It
  borrows whichever ZoomInfo connector that Claude user has enabled, works only
  inside Claude, and is not per-user in this sense. The connected-seat path
  above is the one that works in an ordinary browser.
- Credits are the user's own. That is the point, but it also means a search run
  from this app spends the seat's monthly allowance the same as one run in
  ZoomInfo's own UI.


## The route for everyone: no API key, no server token

Every teammate can build lists with nothing but their own Claude account and
their own ZoomInfo seat:

1. **One-time**: in claude.ai → Settings → Connectors → **ZoomInfo** →
   Connect, signing in with your own ZoomInfo credentials.
2. In the app's **Build a list from ZoomInfo** panel, set the filters and
   press **Open in Claude** (or Copy this search and paste it yourself).
3. Claude runs the search through your connector and answers with a **CSV
   code block** whose header row this app recognises on sight.
4. Back here: **Paste a list**. The columns map themselves.

The pasted prompt tells Claude exactly which tool to call, with which
parameters, to never call an enrich tool (search is free; enrichment spends
credits), to return only the CSV, and to leave cells empty rather than guess
at fields the search did not return.

The in-app Build button still exists for deployments with an Anthropic API
key and a saved ZoomInfo token — same search, no copy-paste. The connector
route is the one that needs neither.
