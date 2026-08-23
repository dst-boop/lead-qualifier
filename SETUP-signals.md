# Tracking leads for money-in-motion events

The rest of the app finds people. This watches the ones you have already found,
and tells you when something happens that makes their retirement money movable.

**Check for events** in the Track card. Everything behind it is free — no
credits, no vendor.

## What it detects

| | Event | Source | How reliable |
|---|---|---|---|
| ◑ | **Turning 59½** | the age on file | Exact, if the age is confirmed |
| ⚠ | **Their employer files a WARN notice** | state labor departments | Exact, and 60 days early |
| 🏛 | **Their employer files an 8-K officer departure** | SEC EDGAR | Exact, within days |
| ⏳ | **Tenure crosses the in-service threshold** | position start date | Arithmetic |

### Turning 59½ is the one that matters most

It is the only money-in-motion event you can know about **before it happens,
with certainty, for free**. It is a date, not a search.

Leads are surfaced from 90 days out, and again once they cross. Someone who
passed 59½ more than a year ago is not an event — the badge on their row
already says so — so they are left out.

If the age was inferred rather than confirmed, the signal says so and is badged
**unconfirmed**. Worth ten seconds with 🏛 or 🏠 before you call.

### The 8-K signal is narrower than it looks

SEC item 5.02 — *departure or election of directors and principal officers* — is
a required disclosure with a four-business-day deadline. It is the fastest free
notice that a senior person's employment is ending.

But it concerns **one named officer**, not everyone at the company. So:

- If the filing **names your lead**, that is the strongest signal this app can
  produce. Top of the list, marked confirmed.
- Otherwise it is offered **only to officers of that company**, hedged as *"may
  or may not concern this lead"*.
- A manager two levels down is never told about it. They learn nothing from it,
  and a watchlist that cries wolf stops being read by the second week.

WARN notices are the opposite case and are shown to everyone at that employer —
a mass separation genuinely affects the whole workforce.

### Who is left out entirely

Anyone marked **Not Interested** or **Has Advisor**. An event about someone who
has already said no is not an opportunity.

## Knowing what changed

The panel marks events **NEW since you last looked**, and new ones sort above
equally urgent ones you have already seen.

**Mark all as seen** records them against your account — per advisor, so two
people sharing a list each track their own. Nothing is hidden afterwards; it
just stops being shouted.

## Getting told, rather than looking

**Email me this** sends the whole digest to your own address, from whichever
account you have picked as your sender.

For a genuinely unattended morning email — one that arrives without you opening
the app — the server would need to send mail while you are not there. That is
possible: Google refresh tokens are already stored KMS-wrapped and are valid
offline, so a scheduled job could mint a token and send as you.

**That is not built, on purpose.** It means the server acting on your behalf
while you are not present, and that is your call to make rather than mine.
Say the word and it is a small change: a Cloud Scheduler job hitting a new
endpoint, walking each user's lists, and sending the same digest.

Until then, the panel is a deliberate two clicks: **Check for events**, then
**Email me this** if you want a copy to work from.

## Setup

Nothing, for the age and tenure signals — they work on any list.

| For | Set |
|---|---|
| WARN notices | `WARN_FEEDS` (and `FORM5500_URL` to price them) — see `SETUP-prospecting.md` |
| 8-K filings | `EDGAR_USER_AGENT` — see `SETUP-edgar.md` |

Both are optional. A missing source is **named in the panel** rather than
silently producing fewer signals: *"WARN feeds unavailable"* is information,
and a shorter list with no explanation is not.

## Cost

One EDGAR round-trip per **distinct employer**, capped at 25 per check — a list
of forty people at four companies costs four lookups. The WARN feeds are
fetched once per check. Nothing is per lead, and nothing spends a credit.

| Variable | |
|---|---|
| `FIRESTORE_SEEN_COLLECTION` | Which signals each advisor has seen. Default `signals_seen`. |
