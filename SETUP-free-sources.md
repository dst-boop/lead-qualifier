# Free public-record lookups

The ⚖ button on a lead. Costs nothing, needs almost nothing configured, and
answers the question sourced lists get wrong: sourced rows carry the
**employer's** address, while these records carry the person's own.

## What it searches

**FEC individual contributions** — anyone who gives a US campaign more than
$200 is itemised publicly: name, home city/state/ZIP, employer and
occupation, self-reported at the moment of each gift. The panel shows the
timeline: where they gave from, what employer they reported, dated. A last
gift reporting "retired" is dated evidence the retirement already happened.

**SEC insider filings (Forms 3/4/5)** — filed by officers, directors and 10%
holders of public companies. A hit means equity compensation: concentrated
employer stock, which is its own planning conversation.

Every block in the panel ends with a link to the same search on the
government's own site, so each number can be checked by hand.

## The whole list at once — one button

**Enrich all (free)**, in the top bar, is the only button you need to press.
It runs every free source over the list in one pass:

1. **The public record**, per lead — political donations (FEC) and SEC insider
   filings, the same search the ⚖ button runs on one lead.
2. **Proxy-statement ages**, per *employer* — for anyone at a public company,
   the age their employer's latest proxy statement prints, the same answer the
   🏛 button gives.

It asks first and states both counts. Leads with findings get row badges —
**SEC** for insider filings, **RETIRED·FEC** for a self-reported retirement —
and ages land on the lead exactly as the 🏛 button would leave them, with the
filing they came from.

The second half used to be manual, one lead at a time, because reading a proxy
statement to answer about one person is expensive and a list of ten people at
one company meant reading the same document ten times. It is now read **once
per employer** and matched against everyone who works there, so the work scales
with employers rather than leads, is cached for a week (a proxy is filed
annually), and costs nothing at all for the many employers that are private
companies and file no proxy.

### What it will never do

**WhitePages is not included.** It spends lookup credits from a pool you paid
for, and anything that spends money stays a button you press per lead, with the
count in front of you. The confirm dialog says so — "all free sources" is only
a useful promise if what it leaves out is named.

### When a source is down

On the demo FEC key a large list will out-run the shared 40-lookups-an-hour
limit partway through. Each lead records which sources actually ran, the
summary counts the gaps ("N donation lookups did not run"), and pressing the
button again re-checks exactly the leads with gaps — a rate limit is never
allowed to read as "no donations", and a gap is never permanent.

The SEC's search occasionally answers a one-off "Internal server error"; the
app retries once before recording a gap, and a gap it does record is filled by
the next press like any other.

A lead who is simply not in their employer's proxy statement records that fact,
so the next press doesn't read the same filing looking for them again.

## The restriction that matters

> Federal law — 52 U.S.C. §30111(a)(4) — forbids the sale or **use** of FEC
> contributor information for commercial purposes or for soliciting
> contributions.

A prospecting workflow is commercial. Use the donations panel to
**corroborate** what you already know from legitimate sources — that the
person lives where you think, held the job the list claims, retired when you
suspected — not as a reason to contact anyone or as a wealth screen. The
panel repeats this warning. The SEC half carries no such restriction. If
your compliance counsel says to turn the FEC half off entirely, say so — it
is one flag.

## Setup

| Variable | Value |
|---|---|
| `FEC_API_KEY` | *(optional)* defaults to `DEMO_KEY` — works immediately, but 40 requests/hour **shared by every DEMO_KEY user on the IP**. A personal key is free and instant at api.open.fec.gov/developers and raises it to 1,000/hour |
| `EDGAR_USER_AGENT` | already required by the EDGAR features — the insider search reuses it and its rate limiter |

No other configuration. The response says per-source whether each search ran,
and the panel prints "Not checked: …" when one didn't — an empty answer from
a check that never ran is not an all-clear.

## Verifying the parsers against reality

Both parsers were written without a live response in front of them (the build
environment cannot reach either API; your deployment can). To settle any
doubt with one line:

    /api/free-debug?source=fec&name=Janet Melter
    /api/free-debug?source=efts&name=Janet Melter

`fields` is every path in the raw response with a sample; `read` is what the
app extracted. If those two disagree, send them to me — it is a five-minute
fix.

## "edgar API does not work"

`/api/free-debug?source=efts&name=…` no longer answers a failure with an
exception page — it reports what actually happened:

- **`ua_set: false`** — `EDGAR_USER_AGENT` is not set on the service. This is
  the usual cause: the FEC half works out of the box, the SEC half needs this
  one variable. Set it to your firm name plus a contact email, e.g.
  `Financial Planners of America dst@financialplannersofamerica.com`
  (Cloud Run → Edit & deploy new revision → Variables).
- **`status: 403`** with the SEC's body shown — the User-Agent was sent but
  rejected; make sure it contains a real firm name and email address.
- **`status` + `body`** for anything else — the SEC's own words, verbatim.

The ⚖ panel is honest about the same thing: "Not checked: SEC insider
filings — EDGAR_USER_AGENT not set" means the search never ran, not that the
person has no filings.
