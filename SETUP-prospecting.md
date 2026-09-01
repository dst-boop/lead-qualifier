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

**The env vars are the fallback, not the front door.** An admin sets both the
WARN feed source and the Form 5500 files inside the app (Money in motion →
the settings under the table): values are fetched and validated before they
are stored, and a stored value wins over its env var. No gcloud, no `^|^`
quoting. The rows below matter for deployments that prefer config at deploy
time, and as the fallback when nothing is saved in the app.

| Variable | Meaning |
|---|---|
| `WARN_FEEDS` | JSON array of feeds (below). **The feature is hidden until this is set.** |
| `FORM5500_URL` | The DOL Form 5500 dataset — and optionally the **5500-SF** (short form) alongside it, separated by a comma or space (use `^|^` if comma). A `.zip` is unpacked in memory. **Google Drive links or file ids** also work. The SF carries its assets inline and is where small plans file — the business-owner population — so including it prices employers Schedule H never will. |
| `FORM5500_SCHEDULE_URLS` | Schedule H and Schedule I, comma-separated. **Required for any dollar figure** — see below. |
| `FORM5500_CSV_IN_ZIP` | Substring identifying which CSV inside the zip to read. Default `f_5500`. |
| `SOURCE_STATES` | Comma-separated states to keep, e.g. `NY,NJ,CT,PA`. Empty keeps all. |
| `SOURCE_COUNTIES` | Comma-separated counties to keep, e.g. `Nassau,Suffolk`. Empty keeps all. Narrows *inside* a state — see below. |
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

Set it as one line — **with the `^|^` prefix**. gcloud splits `--set-env-vars`
and `--update-env-vars` values on commas, so passing JSON without it shreds the
value at every comma and the app then reports *"WARN_FEEDS is set but is not
valid JSON"* in Money in motion. The `^|^` prefix tells gcloud to split on `|`
instead, which the JSON never contains:

```bash
gcloud run services update lead-qualifier --region us-east1 \
  --update-env-vars '^|^WARN_FEEDS=[{"id":"nj","state":"NJ","format":"csv","url":"https://…"}]'
```

## Every state, not just the ones that publish a CSV

`WARN_FEEDS` reads CSV and JSON. That is the whole reason the country is hard:
a large share of states publish WARN as an HTML table or a PDF, and no amount
of configuration reaches those. Finding the URL is not the problem — parsing
what is behind it is.

`tools/warn_sync.py` solves that by not solving it. It runs
[`warn-scraper`](https://pypi.org/project/warn-scraper/) (Big Local News, at
Stanford), which has a per-state module for each of those sites and writes
every one out as CSV, and then publishes the result as static files the app
reads over plain HTTPS. The messy part stays where people who watch those
sites for a living already maintain it.

```bash
pip install warn-scraper
python -m tools.warn_sync --list          # what is covered today
python -m tools.warn_sync --out data/warn \
    --base-url https://raw.githubusercontent.com/OWNER/REPO/warn-data
```

It writes one `<state>.csv` per jurisdiction plus `warn_feeds.json`, which holds
exactly the value to set as `WARN_FEEDS` — paste it in with the `^|^` prefix
above.

### Coverage, and what is not covered

As of the current release, **41 jurisdictions: 40 states and DC.**

```
AK AL AZ CA CO CT DC DE FL GA HI IA ID IL IN KS KY LA MD ME MI MO MT NE
NJ NM NY OH OK OR PA RI SC SD TN TX UT VA VT WA WI
```

**Ten states have no scraper at all:** AR, MA, MN, MS, NC, ND, NH, NV, WV, WY.
Those are not partially covered or stale — they produce nothing, and the report
says so on every run rather than letting a silent gap read as "no layoffs
there." If one of them matters to you, the fix is a scraper module upstream or
a hand-configured feed entry alongside the generated ones; `WARN_FEEDS` is a
plain list, so the two mix.

The state list is read from the installed package, not hard-coded here, so a
release that adds a state is picked up by upgrading the dependency.

### A failed state costs that state and nothing else

Forty state websites means something is broken most weeks — a redesign, an
expired certificate, a 503. `sync()` catches per state, so one failure loses
that state's file and leaves the rest published. The run only exits non-zero
when *every* state failed, which means the run itself is broken rather than a
website. A state that produced an empty file is counted as failed, not
published as an empty feed, because an empty CSV looks exactly like a quiet
month.

The report names each failure and its reason. Failed states are left alone
rather than retried, which is how you get blocked.

### The files are deliberately not normalised

Each state's CSV keeps that state's own column names. `webapp/prospecting.py`
already matches columns by alias, per feed — that is what the alias table is
for — and collapsing forty schemas into one here would mean maintaining a
second mapping that could silently disagree with the first. Run the probe after
adding feeds; it reports the columns it actually matched.

### The scheduled run publishes to a data branch, never to `main`

`.github/workflows/warn-sync.yml` runs this daily and commits to a **`warn-data`
branch**. That is not tidiness. **Pushing to `main` is the deploy** — a job that
committed data on a schedule would redeploy Cloud Run several times a week to
ship nothing, and would put the app's release history at the mercy of forty
state websites. Nothing deploys from `warn-data`; the app just fetches from it.

For the same reason `warn-scraper` is installed *in the workflow* and is not in
`requirements.txt`. It is a build-time tool for this job, not a dependency of
the service, and it has no business in the image Cloud Run runs.

The workflow replaces the CSVs rather than merging them, so a state that stops
being scraped disappears instead of lingering as a stale file the app keeps
fetching. It needs `contents: write` and nothing else, and it skips the commit
entirely when nothing changed.

## Working one metro rather than a whole state

`SOURCE_STATES=NY` is too coarse for an advisor who covers Long Island. It
returns Buffalo and Syracuse alongside Hicksville, and the list stops being a
call list.

`SOURCE_COUNTIES` narrows inside the state:

```bash
gcloud run services update lead-qualifier --region us-east1 \
  --set-env-vars 'SOURCE_STATES=NY,SOURCE_COUNTIES=Nassau,Suffolk'
```

This matters more for New York than anywhere else, because — as the next
section explains — **New York's WARN file publishes no city and no state
column, only county.** County is not one filter among several there. It is the
only geography the feed carries.

Names are matched on their bare form, so `Nassau`, `Nassau County` and
`NASSAU CO.` are the same county, and parishes and boroughs normalise the same
way. Write them however you like.

Two behaviours worth knowing:

- **An event with no county is kept**, exactly as an event with no state is kept
  by `SOURCE_STATES`. A feed that omits the column should not silently empty
  your list; the row arrives and you can see it.
- **The two filters compose.** `SOURCE_STATES=NY` with
  `SOURCE_COUNTIES=Nassau,Suffolk` will not admit a New Jersey row that happens
  to have a county called Nassau.

For the five boroughs the county names are **New York** (Manhattan), **Kings**
(Brooklyn), **Queens**, **Bronx** and **Richmond** (Staten Island) — the county
is what the filing carries, not the borough name people say.

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

## The 5500 file contains no money

This is the thing most likely to waste an afternoon, and it is not obvious.

`f_5500_2025_latest.csv` has 140 fields. It carries the sponsor, the state, the
plan name, the EIN and **participant counts** — and nothing numeric about
assets. Plan assets are on:

- **Schedule H** — plans with 100+ participants, column `TOT_ASSETS_EOY_AMT`
- **Schedule I** — smaller plans, column `SMALL_TOT_ASSETS_EOY_AMT`

Both are separate downloads from the same DOL page, joined back on `ACK_ID`.

Without them every employer comes back with a headcount and no average balance:
**Price the employers** finds nothing, and dollars-in-motion cannot be computed,
so the ranking has nothing to rank on. The app would look configured and produce
nothing.

```
FORM5500_SCHEDULE_URLS = <Schedule H>,<Schedule I>
```

Schedule H is applied first and Schedule I fills the gaps, so a large plan keeps
the large-plan figure. Either alone works; both is better.

The probe reports `priced` — how many sponsors ended up with a balance. If that
is 0 while `rows_read` is large, the schedules are missing, or they are from a
different plan year and the `ACK_ID`s do not line up.

## Where to host the files: Drive or the DOL directly

Both work. `FORM5500_URL`, `FORM5500_SCHEDULE_URLS` and WARN feed URLs all take
either a public URL or a Drive reference.

**Drive is the better default**, for three reasons that have nothing to do with
convenience:

- **The DOL path moves every year.** `.../2025/Latest/...` becomes `.../2026/...`,
  and the old one keeps working for a while before it does not. A Drive file
  does not move.
- **The DOL ships a zip.** The app unpacks it in memory, which works, but it is
  megabytes of decompression on a request path for no benefit over a file that
  was unzipped once by hand.
- **Cloud egress is not guaranteed.** A government host may rate-limit or block
  a cloud IP range, and that failure looks like an empty result.

**The DOL link is better on exactly one axis:** it stays current on its own. DOL
updates the datasets around the first of each month; a Drive copy is as stale as
the day you downloaded it. If you go the Drive route, put a note in your
calendar to refresh it quarterly — the plan data changes slowly, but not never.

Drive sources are read with the **signed-in user's** Google credentials, so the
file must be in that account's Drive and Google sign-in must be connected. A
Microsoft-only session gets a clear message rather than a silent empty result.

## The file is fetched once, not once per click

Both the 5500 file and the WARN feeds are cached in memory after the first
fetch. Before this, every "Price the employers", every "Check for events" and
every opportunities view re-downloaded and re-parsed the whole file — per user,
per click, and against a government host if the source was the DOL's own URL.

| | Default | Variable |
|---|---|---|
| Form 5500 | 24 hours | `PLANS_CACHE_SECONDS` |
| WARN feeds | 6 hours | `WARN_CACHE_SECONDS` |

The cache is per instance, so Cloud Run scaling to zero means the next request
pays for one fetch. That is correct, not a miss.

**Three things always bypass it**, because otherwise they would be lying:
`/api/sources/probe`, **Refresh from source**, and `/api/opportunities?refresh=true`.
A cached probe diagnoses the cache rather than the source.

Changing any source URL or `SOURCE_STATES` invalidates the entry automatically —
the cache key is the configuration.

## Keeping the files in Google Drive

`FORM5500_URL`, `FORM5500_SCHEDULE_URLS` and any WARN feed URL accept a **Google
Drive share link, a bare file id, or `drive:<id>`** instead of a public URL.

That is often the better arrangement. The DOL publishes behind a path that
changes each year; a file dropped in Drive is stable, can be unzipped once by
hand, and is under the control of whoever will notice when it goes stale.

Drive sources are read with the **signed-in user's** Google credentials, so the
file must be in that account's Drive and Google sign-in must be connected. A
Microsoft-only session gets a clear message rather than a silent empty result.

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

## Which of these doors is already open

Ranking by dollars answers *where is the most money moving*. It does not answer
*which of these can I actually get into*, and that second question is the one
that decides whether the week is spent cold calling.

`POST /api/opportunities/warmth` takes the advisor's own leads — posted by the
client, exactly as `/api/signals` takes them, so it works on an unsaved list and
on a list shared by another advisor — and marks every opportunity with the
warmest way in that already exists at that employer.

```
POST /api/opportunities/warmth
{"leads": [...], "sort": "warmth"}
```

| Warmth | Means | Comes from a lead at that employer marked |
|---|---|---|
| `set` | A meeting is booked. You are already inside. | Set |
| `engaged` | A live conversation is running. | Called, Call Back |
| `known` | A name and a number, not a stranger company. | New, or anything unrecognised |
| `cold` | You know no one here. | *(no leads at that employer)* |

Each row also carries `known_leads`, `declined_leads`, `lead_statuses`, and
`warmest_lead` — id, name and status — so the row can link straight to the
person rather than making you search for them.

Employers are matched with the same normaliser the WARN × 5500 join uses, so
`Beacon Materials Corp` on the notice finds `Beacon Materials Corporation` on
your list.

**A lead who has said no does not make a door warm.** Anyone marked *Not
Interested* or *Has Advisor* is left out of the warmth judgement, for the same
reason `signals.py` skips them. They are still counted in `declined_leads` and
returned, because *"the three people I know there all have advisors"* is worth
seeing **before** you spend a week on that employer, not after.

### Ordering

`sort` is `warmth` by default on this route and `dollars` on the GET route,
which is unchanged. Warmth ordering keeps dollars as the tie-break, so within a
band the bigger event still wins:

```
set      Beacon Materials      $30M   meeting booked with Margaret Halvorsen
engaged  Northwind Robotics    $40M   Daniel Okonkwo, called
cold     Cascade Health        $50M   nobody
```

The $50M event is the biggest and it is last, because there is no way into it
yet. That inversion is the entire point of the route — work the open doors
first, and let the cold giant wait until it is the best thing left.
