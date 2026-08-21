# SEC EDGAR — a free, exact age for public-company officers

Signal A (age) is the largest hole in the scoring model. For **officers and
directors of public companies it is a required public disclosure**: SEC
Regulation S-K Item 401 obliges the proxy statement (form DEF 14A) to list
names, ages and positions. This reads that.

Click **🏛** on a lead. The app finds their employer's most recent proxy
statement, reads it, and writes the age onto the lead — which fires signal A,
worth 25 points, and feeds the career-length input behind signal E.

## What it will and will not answer

**It answers for** Section 16 officers and directors — roughly the C-suite and
the board — at companies that file with the SEC.

**It answers for nobody else.** A private-company owner is not in a proxy
statement. Neither is a long-tenured engineer at a public company. Those come
back as *"not listed with an age"*, and that miss is recorded on the lead so the
button does not keep inviting the same fruitless lookup.

It is **free and unmetered**, unlike every other enrichment here. No credits, no
vendor, no per-lead cost. Missing costs nothing but a few seconds, so it is worth
trying on any lead at a public company.

## Why this source and not a scraper

The SEC **permits** automated access on stated terms: send a descriptive
User-Agent carrying a contact address, and stay under 10 requests per second.
That is a different legal position from LinkedIn or ZoomInfo, where automated
extraction breaches the terms of use — see ADR §10, and the $500,000 judgment
and destruction order that followed *LinkedIn v. hiQ*.

Both SEC conditions are honoured in code. `EDGAR_USER_AGENT` has **no default**:
with it unset the endpoint refuses rather than sending an invented one, because
a bad User-Agent is how a firm gets its whole IP range blocked. Requests are
serialised and spaced to `EDGAR_MAX_RPS`, which defaults to 8 — under the ceiling
rather than at it.

## Setup

Cloud Run → **Edit & deploy new revision → Variables & Secrets**:

| Variable | Value |
|---|---|
| `EDGAR_USER_AGENT` | **required** — e.g. `Financial Planners of America dst@financialplannersofamerica.com` |
| `EDGAR_MAX_RPS` | *(optional)* defaults to `8`; the SEC ceiling is 10 |
| `EDGAR_DATA` | *(optional)* defaults to `https://data.sec.gov` |
| `EDGAR_WWW` | *(optional)* defaults to `https://www.sec.gov` |
| `EDGAR_FTS` | *(optional)* defaults to `https://efts.sec.gov` |

`ANTHROPIC_API_KEY` must also be set — the same key the AI QC button uses. The
🏛 button appears only when both are present.

The User-Agent should name your firm and carry an address the SEC could actually
reach you at. That is the whole basis on which access is granted.

### These defaults have not been exercised against the live SEC

The environment this was built in cannot reach sec.gov — the egress gateway
answers 403 to CONNECT for `data.sec.gov`, `www.sec.gov` and `efts.sec.gov`. **No
live EDGAR response has ever been seen here.** The URLs and JSON shapes come from
SEC documentation, which is why all four hosts are environment variables and why
`/api/edgar-debug` exists from the first commit.

What *is* tested, against a stub that behaves like the SEC: the User-Agent is
sent on every request, the rate limit holds, an ambiguous company name returns
nothing rather than the wrong company, and an age that is missing, non-numeric or
outside a working life becomes "not found" rather than a number.

## Reading a proxy statement

Proxy statements are laid out by dozens of different filing agents, so no
structural assumption survives — a regex aimed at a table cell would silently
match the wrong one. Instead the markup is stripped and the flattened text is
handed to Claude with a strict contract: report only an age **printed in the
document for this person**, never estimate, never infer from career length, never
carry an age across from a similar name, and prefer "not found" to a guess.

Then the answer is checked: a non-integer, or anything outside 18–100, is
discarded. A wrong age here would silently mis-score a lead, which is worse than
no age at all.

**The lead detail shows the sentence the age came from and links the filing**, so
you can confirm it is the right person before you call them. Treat that as part
of the workflow, not decoration — the app is telling you what it read and where.

## Troubleshooting

`/api/edgar-debug` does a raw round-trip and returns the URL, status and first
4 KB of the body. `/api/edgar-debug?url=…` probes any EDGAR URL.

- **"EDGAR_USER_AGENT is not set"** — the variable is missing. Nothing is sent to
  the SEC until it is.
- **502 with "SEC returned 403"** — the SEC rejected the User-Agent. Make sure it
  names your organisation and includes a contact email.
- **502 with "rate-limited this address"** — lower `EDGAR_MAX_RPS`.
- **"No public company on file matching X"** — either a private employer, or the
  name is ambiguous. Ambiguity is deliberate: two companies whose names collapse
  to the same thing return nothing rather than a coin flip. Putting the full
  legal name in the lead's Company field resolves it.
- **"X has no DEF 14A on file"** — the company files with the SEC but has no
  proxy statement, which is normal for some foreign issuers and funds.

## Not built yet

**Form 4 insider holdings** — the dollar value of stock an officer holds, which
would be a real wealth signal and is already Phase 3 on the roadmap. It needs a
different pipeline (ownership XML, matching the person's own CIK) and was left
out rather than half-built alongside this.
