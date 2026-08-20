# ZoomInfo — each user signs into their own seat

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
