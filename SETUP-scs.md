# The SCS campaign — long tenure, 59½, in-service

The Rollover campaign works a job change: the money becomes movable because the
person left. **SCS works the opposite lead.** Someone who never left. Twenty or
thirty years of contributions at one employer, and — once they pass 59½ — the
ability to take an **in-service distribution** without resigning.

The two campaigns want opposite things from the same number. Rollover rewards a
short tenure; SCS rewards a long one. That is why the campaign is a switch that
reaches the scorer, not a note in a saved search.

## Running an SCS pull

**Build a list from ZoomInfo → Campaign → SCS.**

| Field | Default | What it does |
|---|---|---|
| Employer tickers | `IBM,RTX,XOM,ED,BA` | Large employers with large plans |
| Min years at employer | `18` | Becomes `positionStartDateMax` |
| Management level | `Director,Manager,Non-Manager` | Deliberately *not* C-suite |
| Min accuracy score | `90` | Higher than Rollover — these leads get called |

### Tickers, not names

A ticker resolves to one company. A company name spreads across subsidiaries and
regional entities, and you end up with a list that is nominally "IBM" and
actually eleven different legal entities.

**The one quirk worth knowing: `BA`.** That is Boeing on the NYSE, but ZoomInfo
has resolved it to **BAE Systems**. Check the employer column on the first page
of results — the app prints the employers it got back in the status line for
exactly this reason — and swap to the company name if it came back wrong.

### The date filter runs backwards from Rollover

Rollover sends `positionStartDateMin`: *started after this date*, i.e. recently.
SCS sends **`positionStartDateMax`**: *started before this date*, i.e. long ago.
Min tenure computes it. Getting these two backwards produces a plausible-looking
list of exactly the wrong people, so the prompt says so explicitly and the test
suite asserts it.

### Nothing is filtered on age

ZoomInfo has no age field. Age is worked out **after** the pull, and every row
shows what it was worked out from.

## How SCS leads score

Same 80-point budget, two signals redefined:

| Signal | Rollover | SCS |
|---|---|---|
| **A** age | 59½+ | unchanged |
| **R / V** | recent move **and** a second current role (5) | **V** — tenure: 18+ yrs (20), 30+ yrs (25) |
| **T** level | unchanged | unchanged |
| **E** | prior senior years at other companies (20) | *dropped* |
| **C** contact | email + mobile (10) | unchanged |

**E is dropped deliberately.** Its question — how many years did they spend at
*previous* companies — is close to zero on precisely the best SCS lead, because
the whole thesis is that they never left. V carries that weight instead, so the
totals stay comparable across campaigns and the tier thresholds do not need
retuning.

### The suspect-tenure flag

A start date implying more than **50 years** is flagged as bad data and scores
nothing. ZoomInfo occasionally returns a company founding date or a 1900
placeholder, and an unchecked 120-year tenure sorts straight to the top of the
call list.

The threshold is high on purpose. It was originally lower, and it flagged a
**real 46-year run at Boeing** — the single best lead on that list — as an
error. A long career is unusual, not impossible. Adjust with `scsSuspectYears`
if you find a genuine case above 50.

## The 59½ badge

Every lead in the app, both campaigns, carries one of three chips:

| Chip | Meaning |
|---|---|
| `59½ ✓` | Past 59½ — an in-service distribution is available. Sellable now. |
| `59½ in ~Xy` | Short of it by about X years. Nurture, do not pitch. |
| `verify date` | No age, and nothing to infer one from. |

The toolbar has a **59½+ only** filter, and the export writes the status into
the Comments column.

### Where the age comes from, and why the row tells you

Age arrives from three places, and they are not equally good:

1. **An SEC proxy statement** — an exact age on a dated public filing.
2. **A public record** — from household enrichment.
3. **Worked out from the start of working life** — graduation year, first work
   year, or stated years of experience, plus 22.

The third is an inference. It is wrong for the career-changer and the late
graduate, so it is never presented as a fact: hover any badge and it names its
basis (`graduated 1984 + 22`), and the export writes an `Age basis` field.

**An inferred age never fires the age signal as confirmed.** `leadAge()` returns
only observed ages and is what the score reads; `leadAgeAny()` includes the
inference and is what the badge reads. Keeping them apart is the whole point —
without it, a guessed age silently earns 25 of the 80 points.

## Credit-cap handling

**Enrichment never requests `yearsOfExperience`.** That field killed a batch
once; the request field list is asserted in the test suite so it cannot creep
back in.

When ZoomInfo reports a spent limit — "limit exceeded", a 429, a quota message —
those leads are **parked, not lost**. They get a `retryBlocked` flag, their
ZoomInfo person IDs are kept, and a **Retry blocked (n)** button appears in the
header. One click re-runs exactly those leads when your limit resets.

Previously a capped batch vanished into a status line and the leads looked
enriched-and-empty.

## Paste JSON batch

For a batch worked out in a conversation rather than pulled from ZoomInfo.
**Paste JSON batch** takes an array of lead objects:

```json
[{"firstName":"Ray","lastName":"Okonjo","jobTitle":"Senior Manager",
  "company":"IBM","positionStartDate":"2002-06-01",
  "email":"r@ibm.com","mobilePhone":"2075550117","personId":"900001"}]
```

- Keys go through the same alias table CSV headers use, so `firstName`,
  `first_name` and `"First Name"` all land in the same place.
- A `{"leads":[…]}` / `{"contacts":[…]}` / `{"results":[…]}` wrapper is unwrapped.
- Keep `personId` if you have it — it is what makes a lead enrichable later.
- Pick the campaign in the dialog. It is **stamped on each lead**, so a batch
  keeps scoring by its own rules after the switch moves.
- Tick **Mark as credit-blocked** to land a batch straight in the Retry blocked
  queue — for leads whose IDs you have but whose enrichment did not complete.

## Compliance

The SCS panel carries a standing reminder: **Equitable pre-approval is required
before any SCS outreach**, and SCS+ material must carry the prospectus language.
The app does not check either and cannot.
