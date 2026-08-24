# WhitePages phone verification and household enrichment

Two per-lead buttons.

**📞? Verify** looks the number up and shows:

- whether the number is **valid**
- **line type** (Mobile / Landline / VoIP …) — mobile shows green
- **carrier**, and the **do-not-call** and **spam** flags where the record
  carries them
- whether the number's **owner matches the lead's name** — including a match on
  a **former or married name**, which says which one it matched

**🏠 Enrich** looks the person up by name and shows the same household panel.

### Re-checking a number

The 📞? button appears on a lead that has never been checked. Once it has an
answer the button changes rather than disappearing:

- **📞+** on a lead checked *before* the app read the whole record — pressing it
  pulls the date of birth, other names, every line and every email. This is the
  one to press on anything you checked before this feature shipped.
- **Re-check this number** inside the lead's panel, for anything else.

Both spend a lookup, so both ask first and say so. Once a lead's record has been
read in full the row button retires — there is nothing left to learn without
new data at the other end.

### One lookup, not two

A reverse-phone query on this API is a *person search* (see below), so it comes
back as a full person record. Verify now keeps that record instead of reading
three fields off it, which means **pressing 📞? fills the household panel for
free**. Enrich is a second lookup only when the phone check found nothing, or
when you want the property lookup that goes with it.

### What the household panel shows

- **Date of birth** — month and year, when the record has one. This is the most
  valuable field in the response; see below.
- **The month they reach 59½**, worked out from it
- **Other names on file** — married, maiden, misspelt
- **Home city and state** — where they live, not where the company is
- **Every phone line**, with its type, carrier, and DNC or spam flag
- **Every email address**, with its type (professional / personal) and whether
  it was recently used
- **Employer and title on the record**, flagged when it disagrees with your list
- **Whether they own their home**, and whether the deed is held by a person, a
  trust, or an entity — Enrich only
- **How many properties and how many addresses** are on file

Blank fields on the lead are filled in from the record. Fields you already have
are never overwritten — the record's version shows in the panel instead, so you
can judge which is right.

### The date of birth is the one that matters

Every other age in this app is an integer as of a filing date, a round number
from a household record, or a graduation year plus twenty-two. A month and a
year give the **exact month a lead reaches 59½** — "Born Aug 1970" means
February 2030 — and 59½ is the whole question the SCS campaign turns on. So it
outranks everything else, including an age printed in an SEC proxy statement.

**It carries no day**, and the app is explicit about that:

- The age shown is the one they have **certainly** reached. In their birthday
  month it can be a year low. It is never a year high.
- The 59½ answer is a **month**, not a date.
- In that month the badge reads **"59½ this month"** rather than a green tick,
  and tells you to confirm the date on the call. Eligibility that month turns on
  a day nobody has looked up.

Where the record has no date of birth, nothing changes: the app falls back to
the ages it had before and labels them as it did before.

### There is no home value in this API

Property Search returns ownership, residents, geolocation, APN and county —
no assessed value, no market estimate, no AVM. If a dollar figure per house is
needed, it has to come from a property-data provider (ATTOM, Estated, county
assessor records), not from here.

Ownership is the substitute, and it is not a bad one: **who holds the deed**
is a genuine wealth signal. A house in a trust or an LLC means the household
has already done estate or entity planning, and the count of deeded properties
separates one-home owners from people with a portfolio.

Both write into the CSV export comments. Enrich also backfills empty street,
city, zip and mobile fields on the lead, so a lead with no mobile number can
gain one.

## Credits

Lookups cost money, and the published billing rule is the one to know:

> successful (2xx) and client-error (4xx) responses are billed; throttling
> (429) and server errors (5xx) are not.

**A malformed request costs the same as a good one.** Sending a full state name
where a two-letter code is required buys a 400 and a charge. So the app checks
every parameter against the documented constraint *before* the call goes out,
and refuses what cannot succeed for free. A refused lookup says so: *"Not sent,
so not billed — 'New York' is not a two-letter state code."*

Three things keep the bill down:

1. **Nothing invalid is ever sent.** Phone patterns, five-digit ZIPs, real state
   codes, ages inside the documented 18–65, pages inside 1–10, and the two pairs
   of parameters the API rejects when combined.
2. **The same question is asked once.** Answers are cached on the exact query
   for `WHITEPAGES_CACHE_SECONDS` (default 30 days) — including *"no such
   person"*, which was paid for and does not change. Pressing 📞? then 🏠 on the
   same lead now costs one lookup, not two.
3. **Nothing is bought speculatively.** The deed lookup used to run
   automatically inside Enrich; it is now its own **Check the deed** button that
   says what it costs.

`/api/wp-spend` reports what was billed, what came from memory, and what was
refused before it could be charged. It counts rather than estimates, and it
deliberately does *not* call the account-usage endpoint — that endpoint is
billed too, and asking what you have spent should not spend anything.

Every activity-log entry now ends with what the press cost, e.g.
`[1 lookup]` or `[no lookup — already on file]`.

## Finding someone with no mobile number

Person search is one endpoint. Phone, email, address and name are all
`GET /v2/person/` with different parameters, and they differ enormously in how
well they identify a person. Enrich climbs this ladder and stops at the first
answer, so a rung is only paid for when the one below found nothing:

| Rung | Why it is where it is |
|---|---|
| **Phone** | A number identifies a person. Best available. |
| **Email** | Nearly as good — nobody shares one. This is the rung that makes a lead with no mobile worth pressing. |
| **First + last name, with a location** | Documented as matching each part specifically, unlike the loose `name` field. |

A name with **no** city, state or ZIP is refused without spending anything.
That query is the one that returns a stranger with the same surname, and the
app has attributed one of those to a lead before.

## Which API you have

Two incompatible flavours of this API exist, and the key you hold works with
exactly one of them:

| Flavour | Base URL | Paths | Header |
|---|---|---|---|
| **Whitepages Pro** (default) | `https://api.whitepages.com` | `/v2/person`, `/v2/property/` | `X-Api-Key` |
| **Trestle** | `https://api.trestleiq.com` | `/3.1/phone`, … | `x-api-key` |

The app defaults to Whitepages Pro and infers the paths from the base URL, so
setting `WHITEPAGES_BASE_URL` to the Trestle host switches the whole dialect.

### There is no /v2/phone

Reverse phone lookup is a *mode of person search* — `GET /v2/person?phone=` —
not its own endpoint. Calling `/v2/phone` returns 404, which reads as "no
record found" while the API account records **no usage at all**, because
nothing was billed. Zero usage on the dashboard is the tell.

## Setup

1. Get your API key from your account dashboard (Pro keys arrive by email
   after signing up for a trial).
2. Cloud Run → your service → **Edit & deploy new revision → Variables & Secrets**:

| Variable | Value |
|---|---|
| `WHITEPAGES_API_KEY` | your API key |
| `WHITEPAGES_BASE_URL` | *(optional)* defaults to `https://api.whitepages.com` |
| `WHITEPAGES_PHONE_PATH` | *(optional)* override for reverse-phone lookups |
| `WHITEPAGES_PERSON_PATH` | *(optional)* override |
| `WHITEPAGES_PROPERTY_PATH` | *(optional)* override |

3. Deploy. Both buttons appear once you sign in.

## Troubleshooting

The app now reports the upstream status code and the exact URL it called, so a
failed lookup tells you which of these it is:

- **403** — the key is wrong, or has extra whitespace. The message says so.
- **404** — treated as "no record found" and shown as such. If *every* lookup
  returns it, the path is wrong for your account; set the `*_PATH` overrides.

### Which fields does *my* key actually return?

Accounts differ in what they are entitled to, and the two dialects name things
differently. Rather than guess, ask:

    /api/wp-debug?phone=2065550142

The response now includes a **`fields`** list — every path in the response, its
type, and a short sample — and **`read`**, which is what the app made of it. So
"does my key return a date of birth" is one line to read rather than four
thousand characters of JSON, and if a field is present under a name the app does
not recognise, `fields` is where that shows up.

It spends a credit, like any other lookup, and needs you signed in.
- **Anything else** — the error text comes straight through from the API.

## Notes

- **Each click costs one Reverse Phone lookup** on your plan — that's why the
  endpoint requires sign-in (visitors to the URL can't spend your credits) and
  verification is per-lead rather than automatic for the whole CSV.
- The lookup uses Trestle's Reverse Phone API (`/3.1/phone`, `x-api-key` header).
- Compliance: this data is non-FCRA. Fine for deciding whether/how to contact a
  lead; it must not be used for credit, insurance, or employment eligibility
  decisions.
