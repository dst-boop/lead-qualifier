# Money in motion — finding the event first, then the people

Every other part of this app takes a list of people and asks *does this one have
money moving?* That is backwards, and it is why Tier A was unreachable on the
Boeing list: you cannot infer a rollover from a job title.

This inverts it. Start from a **dated event that moves retirement money**, then
go find the people it moves. Two free public sources, joined:

| Source | What it gives | Who publishes it |
|---|---|---|
| **WARN notices** | employer, city, state, headcount, effective date | each state's labor department, under the federal WARN Act |
| **Form 5500** | plan name, total participants, total plan assets | US Department of Labor / EBSA, annual bulk download |

Divide plan assets by participants and you have an **average 401(k) balance**.
Multiply by the number of people being separated and you have
**dollars in motion** at a named employer on a known date. That is the ranking.

An employer with 412 people leaving on 30 June and an $87,692 average balance is
$36M coming loose, with a deadline attached. That is a different object from a
spreadsheet of job titles.

## What the WARN Act actually requires

Employers of 100+ must give **60 days' written notice** before a plant closing or
mass layoff, and states publish those notices. So the list is:

- **forward-looking** — the notice arrives before the separation, not after
- **dated** — you know how long you have
- **named** — employer and location, not a segment

The 60-day window is the whole point. A 401(k) becomes rollable when employment
ends. The notice tells you when that is.

## Configuration

Everything is environment variables on the Cloud Run service. Nothing here is
secret — these are public URLs — so plain env vars, no Secret Manager.

| Variable | Meaning |
|---|---|
| `WARN_FEEDS` | JSON array of feeds (below). **The feature is hidden until this is set.** |
| `FORM5500_URL` | URL of the DOL Form 5500 dataset. A `.zip` is unpacked in memory. |
| `FORM5500_CSV_IN_ZIP` | Substring identifying which CSV inside the zip to read. Default `f_5500`. |
| `SOURCE_STATES` | Comma-separated states to keep, e.g. `NY,NJ,CT,PA`. Empty keeps all. |
| `SOURCE_MIN_WORKERS` | Ignore events smaller than this. Default `25`. |
| `FIRESTORE_OPPS_COLLECTION` | Where the built list is stored. Default `opportunities`. |

### `WARN_FEEDS`

```json
[
  {"id":"ny","state":"NY","format":"csv","url":"https://…/warn.csv"},
  {"id":"nj","state":"NJ","format":"json","url":"https://…/warn.json"}
]
```

`format` is `csv` or `json`. `state` is a fallback used only when a row does not
carry its own state column. `id` is a label that shows up in the probe output so
you can tell which feed failed.

Set it as one line:

```bash
gcloud run services update lead-qualifier --region us-east1 \
  --set-env-vars 'WARN_FEEDS=[{"id":"nj","state":"NJ","format":"csv","url":"https://…"}]'
```

## What New York's file actually looks like

The parser has now been run against **real published New York WARN data**, and
two things it assumed were wrong:

**The date is not in "Layoff Date".** New York files that column as prose —
*"Separations will occur on May 12, 2021 or during the 14-day period beginning
on that date"* — and puts the usable date in **Closing Date**. Before this was
found, the parser returned an effective date for **none** of the rows, which
quietly removes the entire point of a feed that is meant to arrive 60 days
early.

The parser now tries every date-ish column in turn, and if none parses it reads
a date out of the sentence — **but only when the sentence names exactly one.**
Several of New York's rows read like *"postponed from 1/29/2021 – 2/12/2021 to
3/17/2021 – 3/31/2021"*, and no rule picks the right one of those four without
guessing. Those come back with no date and the sentence attached, for a person
to read. A wrong effective date is not a smaller version of a missing one: it
drives a countdown on a real call and nothing on screen would say it was
invented.

**The company name carries its address.** New York writes
`Acitrezza, LLC (Agata & Valentina store) 64 University Place New York, NY 10003`
in the company column. Normalised, that produces a key no Form 5500 sponsor will
ever match — so every New York event would have shown as *"no plan on file"*.
The name is now cut where the street address begins, and the full string kept
alongside, since it is the only location the file gives.

**New York publishes no city or state column** — only county. That is what the
`state` field in your feed entry is for.

## Do the probe first — the column names are not guessed at correctly

**No live WARN feed or Form 5500 file has ever been fetched by this code.** The
environment it was written in blocks `dol.gov`, `data.gov` and the state labor
sites at the network policy, so the column aliases in `webapp/prospecting.py`
were written from published field documentation, not from a response.

They are therefore probably *nearly* right and possibly wrong. `/api/sources/probe`
is how that gets settled, in one request:

```
GET /api/sources/probe
```

Signed in, in a browser. It returns, per feed: how many rows were read, which of
your columns it matched to which field, **which required fields it could not
match**, and the first three parsed rows.

Read `unmapped`. If it says `["workers"]`, the headcount column in that feed is
named something the alias list does not know about. Add it to `WARN_ALIASES` (or
`PLAN_ALIASES`) in `webapp/prospecting.py` and probe again. Two or three rounds
should exhaust it.

Do not skip this and go straight to the modal. A feed whose headcount column went
unmatched produces employers with no dollar figure, which looks like "no plan on
file" and is actually "we could not read your CSV".

## Using it

**Money in motion** appears in the toolbar once `WARN_FEEDS` is set. It lists
employers ranked by dollars in motion:

- **Refresh from source** refetches both sources and rebuilds. Takes a few
  seconds; the Form 5500 file is large.
- **Copy search** puts a ready prompt on the clipboard, naming that employer,
  its state, the effective date and the headcount, and asking for exactly the
  columns the CSV importer auto-maps. Paste it into Claude, or into **Build
  list** if ZoomInfo is connected. The people come back, you import them, and
  the existing scoring takes over.

### An employer with no plan on file is still shown

If Form 5500 has no match for an employer, the row appears with **no plan on
file** and an em-dash where the money would be. It is not dropped and it is not
given an estimated balance. A dated separation of 400 people is worth working
whether or not the DOL file matched the name — but a made-up dollar figure would
poison the ranking, which is the one thing the ranking cannot survive.

Names are matched after normalisation: case, punctuation and corporate suffixes
are stripped (`The Boeing Company, Inc.` → `boeing`), and initialisms are put
back together (`J.P. Morgan` → `jpmorgan`). It still misses when the WARN filer
is a subsidiary and the plan sponsor is the parent. That is a real limit, not a
bug to be fixed with fuzzier matching — loose matching attaches the wrong
employer's plan assets to a layoff, which is worse than a dash.

## Keeping it current on a schedule

`POST /api/sources/refresh` rebuilds and stores the list. Weekly is right — WARN
notices land continuously, Form 5500 updates monthly at most.

```bash
gcloud scheduler jobs create http warn-refresh \
  --schedule "0 6 * * MON" --time-zone "America/New_York" \
  --uri "https://<your-app>/api/sources/refresh" --http-method POST \
  --oidc-service-account-email 835549789051-compute@developer.gserviceaccount.com
```

The route requires a signed-in session, so a scheduler job needs a service
identity the app accepts. Until that is wired, **Refresh from source** in the
modal does the same thing by hand.

## What this does not do

- **It does not find the individuals.** It finds the employer and the date. The
  people still come from ZoomInfo, Claude, or your own list.
- **It only covers mass separations.** An individual retiring at 59½ files no
  WARN notice. Those still come from the age signals — EDGAR for public-company
  officers, or a graduation year on import.
- **Plan assets are a year or two stale.** Form 5500 is an annual filing with a
  long lag. The average balance is an order of magnitude, not a quote.
