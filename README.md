# Lead Qualifier

A lead qualification tool for Financial Planners of America. Import a contact
list, score it against the firm's ideal-prospect rule, verify the phone numbers,
enrich from public records, and work the call list — calling, emailing and
setting meetings from your own connected account.

Live at **https://leads.financialplannersofamerica.com**

## What it does

**Score.** Five weighted signals decide who gets called first:

| | Signal | Weight |
|---|---|---|
| A | Over 59.5 years old, or graduated college before 1990 | 25 |
| R | In role under 60 months **and** holds another current role | 5 |
| T | C / VP / Director / Partner / Owner / President / Founder | 20 |
| E | 10+ years at previous companies at a senior level | 20 |
| C | Mobile **and** email on file | 10 |

Tier A at 60, B at 40, and residents of excluded states are dropped outright.
Every threshold, weight and keyword is editable in **ICP settings**, and the
whole list re-scores the moment you save.

**Verify.** 📞? checks a number against Whitepages Pro — line type, and whether
it actually belongs to the lead. Worth doing: a meaningful share of imported
mobiles turn out to belong to someone else.

**Enrich.** 🏠 returns confirmed age and date of birth, home city and state,
whether they own their home and whether a trust or entity holds the deed, how
many properties they own, and any mobile numbers on file. Matching is
phone-first — a name is not an identifier, and a record from the wrong state is
refused rather than attached.

**Qualify with AI.** Sends leads to Claude in batches, which grades each against
five wealth-management gates and returns per-gate evidence plus a first-call
verification checklist. Needs `ANTHROPIC_API_KEY`.

**Work the list.** Click-to-call, email and calendar invites sent from your
signed-in Google or Microsoft account, round-robin assignment across advisors,
activity logging, and a CRM-shaped CSV export carrying the home address, both
email addresses, the AI grade and the checklist.

## Architecture

FastAPI on Cloud Run, serving a single static HTML file with no build step.
Sessions and saved lead lists live in Firestore. Full reasoning, including the
decisions that were reversed and why, is in [`docs/ADR.md`](docs/ADR.md).

```
webapp/main.py           API: auth, lookups, AI QC, state
webapp/static/index.html the entire frontend
docs/ADR.md              architecture decisions
```

## Run locally

```bash
pip install -r requirements.txt
USE_FIRESTORE=0 PORT=8000 python -m webapp
```

Then open http://localhost:8000. `USE_FIRESTORE=0` keeps state in memory, which
is what you want without GCP credentials. Sign-in and the paid lookups need the
environment variables below.

## Deployment

Cloud Run, `us-east1`, continuously deployed from `main` via the Dockerfile.
Pushing to `main` is the deploy.

| Variable | Purpose |
|---|---|
| `APP_BASE_URL` | Public URL, no trailing slash. OAuth redirects and the HTTPS redirect derive from it |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google sign-in, Gmail send, Calendar — [setup](SETUP-google.md) |
| `MS_CLIENT_ID` / `MS_CLIENT_SECRET` / `MS_TENANT_ID` | Microsoft sign-in — requires an app registered by Equitable IT, [setup](SETUP-microsoft.md) |
| `WHITEPAGES_API_KEY` | Phone verification and enrichment — [setup](SETUP-whitepages.md) |
| `ZI_CLIENT_ID` / `ZI_CLIENT_SECRET` | ZoomInfo REST API, needs a DevPortal entitlement — [setup](SETUP-zoominfo.md) |
| *(none)* | ZoomInfo via the MCP connector — no entitlement, paste a token in ICP settings — [setup](SETUP-zoominfo.md) |
| `ANTHROPIC_API_KEY` | AI quality control, and reading SEC filings — [setup](SETUP-ai-qc.md) |
| `EDGAR_USER_AGENT` | Free exact age for public-company officers from SEC proxy statements — [setup](SETUP-edgar.md) |
| `USE_FIRESTORE=0` | Force memory mode — [setup](SETUP-firestore.md) |

The UI only offers what the deployment has keys for, so an unconfigured
integration hides rather than failing at the click.

## Notes

Endpoints that spend money require sign-in, so a visitor who finds the URL
cannot spend your credits. Enrichment is deliberately one-shot per lead: there
is no refresh scheduler and no TTL, so credits are never consumed in the
background.

Identity data here is **not** an FCRA consumer report and must not drive credit,
insurance or employment eligibility decisions.
