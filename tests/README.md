# Tests

These lived in a scratch directory for most of the project's life, which meant
they vanished whenever the container was recycled and never travelled with the
code. They are here now.

## Running them

```bash
cd tests && npm install     # once — Playwright only
./run.sh
```

`run.sh` reuses a server already listening on 8099, or starts one and shuts it
down afterwards. It exits non-zero if any suite fails, so it is safe to put in
front of a deploy.

Chromium is expected at `/opt/pw-browsers/chromium`; each suite falls back to
Playwright's own download if that path is absent.

## Why they drive a browser

The app is a single HTML file with no module boundary — `scoreLead` and
`guessColumns` are not importable. Loading the page in Chromium and calling them
there is the only way to test the code that actually ships, rather than a copy of
it. Backend routes are the exception: `zi-oauth-test.py`, `edgar-test.py`, `zi-mcp-test.py`, `prospecting-test.py`
and `opportunities-test.py` drive FastAPI (or the parsers) directly.

## Regression suites — these gate a deploy

| Suite | Covers |
|---|---|
| `score-test.js` | every scoring rule, one case per rule, plus the mobile gate and state exclusion |
| `mobile-test.js` | a lead with no mobile is held out of the tiers, and what it would be worth enriched |
| `isolation-test.js` | one browser, two accounts — neither can see or adopt the other's list |
| `automap-test.js` | CSV column matching: punctuation, BOM, word boundaries, name splitting, the template round-trip |
| `recipe-test.js` | a changed default refreshes untouched text and never overwrites what a user wrote |
| `zi-ui-test.js` | the ZoomInfo connect/disconnect states in the auth bar |
| `zi-oauth-test.py` | the per-user ZoomInfo OAuth flow against a stub that validates PKCE properly |
| `edgar-test.py` | SEC lookups: the required User-Agent, the rate limit, ambiguous company names, and every way an age can fail to be real |
| `edgar-ui-test.js` | the 🏛 button — score change, the filing evidence shown, and a miss that is recorded rather than retried |
| `zi-mcp-test.py` | ZoomInfo via the MCP connector — that both halves of the request are sent, the token is per-user, and failures are errors rather than empty lists |
| `zi-mcp-ui-test.js` | saving and removing the MCP token, and that the credential never reaches localStorage or the lead-state document |
| `prospecting-test.py` | the WARN and Form 5500 parsers — company-name normalisation, column aliasing, the join, and that an unmatched event survives without acquiring a made-up dollar figure |
| `opportunities-test.py` | the source endpoints against a stub WARN feed and a stub zipped DOL file: the probe reports what came back, one dead feed does not sink the refresh, and a signed-out visitor gets nothing |
| `scs-test.js` | the SCS campaign — tenure scoring including the 46-year run that must not be flagged, inferred age never firing signal A as confirmed, the 59½ badge, `positionStartDateMax` not `Min`, credit-cap parking, and the JSON batch importer |
| `research-prompt-test.js` | a real research-tool export end to end — what the app can and cannot read from it, that self-declared estimates never reach a scoring field, the generated research prompt, and pasting a Drive link |
| `opps-ui-test.js` | the Money-in-motion modal — server ranking preserved, unpriced employers badged and dashed rather than estimated, refresh refetching, and the copy-search prompt |
| `upgrade-test.js` | an older saved list still loads and rescores |
| `hh-test.js` | household matching — telling a spouse apart from a wrong number |
| `v3-test.js` | scoring and export against the v3 column layout |

**Every one of these exits non-zero when it fails.** That was not always true:
`score-test.js`, `hh-test.js`, `v3-test.js` and `upgrade-test.js` counted their
failures, printed them, and exited 0 — so `score-test.js` sat at 11 failures
through weeks of runs that all reported success. If you add a suite, wire the
counter to `process.exit`, then break it on purpose once to prove it fails.

## Diagnostic scripts — these print, they do not judge

`audit.js` · `cov-test.js` · `rescore-test.js` · `map-test.js` · `state-test.js`
· `layout-test.js` · `props-test.js` · `drive-test.js`

These walk a flow and print what they find for a human to read. They are useful
when something looks wrong and useless as a gate, so `run.sh` leaves them out.
Run them by hand: `node audit.js`.
