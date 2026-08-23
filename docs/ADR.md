# Lead Qualifier — Architecture Decision Record

**Version 2.1** · Supersedes v2.0 · Single-tenant build (one advisor, one ZoomInfo seat)

v2.0 was written from vendor documentation. v2.1 is written from live API
responses and a deployed app. Where the two disagreed, documentation lost —
twice, expensively. That is itself a finding, recorded in §12.

---

## Changelog from v2.0

| # | Change | Effect |
|---|---|---|
| 1 | The identity vendor is **Whitepages Pro**, not Trestle | v2.0 §4 deleted in full — wrong paths, wrong auth, wrong prices |
| 2 | **No IP allowlist** to satisfy | Cloud NAT static IP dropped from Phase 0; removes cost and a day |
| 3 | **No `/v2/phone` endpoint** — reverse phone is a mode of person search | Fixed; was silently returning nothing |
| 4 | **No home value** in the API at any price | Ownership substitutes; a valuation vendor becomes a real decision |
| 5 | The TCPA litigator flag was Trestle's | §8.3's automated routing has no data source — see §8.3 |
| 6 | **A name is not an identifier** | New §5: identity resolution, phone-first with geographic corroboration |
| 7 | ZoomInfo mobiles are materially wrong | New §11: data quality, and its effect on funnel math and TCPA exposure |
| 8 | Firestore shipped | Phase 0 nearly closed; KMS is what remains |
| 9 | Scoring model replaced | Five signals, weights total 80, tiers at 60/40 |

---

## 1. Executive summary

The app is deployed, on a custom domain, with server-side state. What follows
is what has been proven in production, not what was planned.

**Working today:** FastAPI on Cloud Run at
`leads.financialplannersofamerica.com`, HTTPS-only with HSTS · Google
sign-in · Gmail send and Calendar invites from the signed-in account ·
WhitePages phone verification and household enrichment · Firestore-backed
sessions and per-account lead lists · a five-signal scoring model · AI quality
control against Claude, awaiting an API key.

**The six decisions that still matter:**

1. **ZoomInfo via OAuth 2.0 Authorization Code + PKCE against a self-registered
   Standard App.** Unchanged from v2.0 and still unstarted. Request
   `api:data:contact`, `api:data:company`, `api:entitlements:read` and nothing
   else.
2. **Whitepages Pro is the identity vendor.** `https://api.whitepages.com`,
   `X-Api-Key` header, `/v2/person` and `/v2/property/`. It works from Cloud
   Run's ordinary egress. See §4.
3. **A name is not an identifier.** Match on phone; fall back to name only with
   geographic corroboration; refuse rather than guess. See §5.
4. **Microsoft Graph remains the default provider** where an M365 work account
   is in play, but Google is what is actually wired and used today.
5. **LinkedIn: compliant primitives only.** Unchanged, and extended to
   real-estate sites. See §10.
6. **Enrichment is terminal.** Enrich once, never refresh. Shipped as written.

**Open dependencies:** confirm the ZoomInfo seat carries API entitlement by
registering a Standard App; decide whether to buy property valuation data;
find a TCPA risk source or make that step manual.

---

## 2. Target architecture

```
   Browser — vanilla JS, no build step
   └─ localStorage mirror (offline fallback, survives sign-out)
            │  HTTPS only (301 + HSTS), HTTP-only session cookie
            ▼
   ┌──────────────── Cloud Run (us-east1) ─────────────────┐
   │ FastAPI / uvicorn — single container                   │
   │   OAuth (Google · Microsoft) · lookups · AI QC          │
   │   session + state middleware · compliance hooks         │
   └───┬──────────────┬──────────────┬──────────────┬──────┘
       │              │              │              │
       │   ordinary Cloud Run egress — no static IP required
       ▼              ▼              ▼              ▼
  ┌─────────┐  ┌────────────┐  ┌────────────┐  ┌────────────┐
  │Firestore│  │Whitepages  │  │Google APIs │  │Claude API  │
  │sessions │  │Pro /v2     │  │Gmail·Cal   │  │AI QC pass  │
  │lead_    │  │X-Api-Key   │  │            │  │            │
  │ state   │  └────────────┘  └────────────┘  └────────────┘
  └─────────┘  ┌────────────┐  ┌────────────┐
               │ZoomInfo    │  │MS Graph    │
               │(not built) │  │(alternate) │
               └────────────┘  └────────────┘
```

**Trust boundaries.** (1) Browser ↔ Cloud Run: session cookie only — no
third-party token ever reaches the browser. (2) All vendor secrets are
server-side. (3) Every endpoint that spends money requires sign-in, so a
visitor who finds the public URL cannot spend credits. (4) Outbound
communications fork to the audit sink at or before send.

---

## 3. ZoomInfo — unchanged from v2.0

Nothing has been learned that changes §3 of v2.0, because none of it has been
built. Carried forward verbatim in intent:

- One current API; entitlement is governed by **OAuth scopes**, not URL path.
- Request Data scopes only. Never request Audiences or GTM scopes.
- `api:entitlements:read` earns its place: it turns a missing entitlement into
  a clear message at link time instead of an opaque 403 mid-job.
- **Standard App**, not Partner App — single tenant, so the review drops out.
- Contact state uses the single `state` field **with
  `locationSearchType: "Person"`**. Never map `company.state` to the grid's
  State column.
- Search consumes no credits; enrich does. Let users iterate filters freely.
- Read `X-RateLimit-*` and `Retry-After` rather than hard-coding backoff.

**First action, ~10 minutes, still outstanding:** register a Standard App at
`developer.zoominfo.com` and check whether `api:data:contact` and
`api:data:company` are selectable. That is the entitlement answer.

---

## 4. Whitepages Pro — corrected

v2.0 §4 described Trestle. It was the wrong vendor, and acting on it produced a
day of failures. Replaced entirely.

### 4.1 What it actually is

| | |
|---|---|
| Base URL | `https://api.whitepages.com` |
| Auth | `X-Api-Key` request header |
| Person search | `GET /v2/person` |
| **Reverse phone** | **`GET /v2/person?phone=` — a mode of person search** |
| Property | `GET /v2/property/` (trailing slash; follow redirects) |
| Envelope | `{"results": [...], "metadata": {...}}` |

**There is no `/v2/phone`.** Calling it returns 404, which reads as "no record
found" while the API account records **no usage at all** — nothing is billed
for a path that does not exist. Zero usage on the dashboard is the tell that a
request is not landing, and it is the single most useful diagnostic signal this
API gives.

**No IP allowlist.** Calls succeed from Cloud Run's random egress IPs. The
Cloud NAT static IP in v2.0's Phase 0 existed only to satisfy Trestle's
allowlist and is dropped. Revisit only if ZoomInfo requires IP restrictions.

### 4.2 What it returns

Person records carry: `name`, `aliases[]`, **`age`** and `date_of_birth`,
`match_score`, `matched_by[]`, `phones[]` with `type` and a per-phone
confidence `score`, `current_addresses[]`, `historic_addresses[]`,
`owned_properties[]`, `emails[]` with scores, `relatives[]`, and a
`result_metadata` block.

Lists are capped and report what was withheld — `phones: {displayed: 4,
additional: 3}` — with the full list behind `result_metadata.details_url`.
Counts must add both, or an inventory of "4 phones" is wrong.

**`age` is the most valuable field in the response.** The qualification rule
gates on age, and it was previously inferred from graduation year. It is now a
public-record fact, which moves the base gate from INFERRED to CONFIRMED.

### 4.3 There is no home value

Property search returns ownership, residents, geolocation, APN and county. No
assessed value, no market estimate, no AVM. This was the original ask and it
cannot be satisfied by this vendor at any price.

**Substitute, in use today:** who holds the deed. Whether the lead's name is on
it, how many properties they own, and whether a **trust or an entity** holds
it — the last being a strong signal that estate or entity planning has already
happened.

**Resolution path, unbuilt:** ATTOM or Estated sell AVM data by address, and
the addresses are already in hand. County assessor records are free and
authoritative but per-county. Decide once the 🏠 button has run over real
volume and the property-ownership rate is known.

### 4.4 Billing and errors

| Status | Meaning | Billed |
|---|---|---|
| 200 | Success — **including zero results** | Yes |
| 400 | Bad parameter. `state_code` rejects full state names | No |
| 403 | Invalid key | No |
| 404 | No matching record by id — **also a wrong path** | No |
| 429 | Rate limited | No |

`state_code` accepts two letters only. Lead lists carry "New York" as often as
"NY", so resolve it and drop it when unresolvable rather than sending a 400.

---

## 5. Identity resolution — a name is not an identifier

New section. The most important lesson of the build, and the one most likely to
cause real harm if forgotten.

A search for `name=Daniel Treacy` returns namesakes nationwide:

| Record | Age | Lives in | match_score |
|---|---|---|---|
| Daniel Ryan Treacy | 30 | Kansas City, MO | 90 |
| Daniel T Timothy Treacy | 43 | Portland, OR | **94** |

The highest-scoring result is a realtor in Oregon. Taking the top match would
have attached his age, home address and email addresses to a New York lead —
silently, and presented as confirmed public-record fact. A surname check does
not help: they are all genuinely named Treacy.

**The rules, as implemented:**

1. **Match on a phone number first.** A phone number identifies a person. A
   name does not.
2. **Name search is a fallback**, and only with geographic corroboration. A
   record whose home state contradicts the lead's is **refused**, with the
   reason surfaced, not attached.
3. **Reverse phone ranks by phone confidence, not name confidence.** The search
   returns everyone associated with a number — current holder, prior holders,
   household. Ranking by `match_score` answers "whose name matches best", which
   is a different question from "whose number is this".
4. **Show provenance.** The UI states what the match was made on and its score,
   so a name-only match reads as something to confirm rather than as fact.
5. **An empty field beats a wrong one.** For a FINRA-registered rep, attaching
   a stranger's home address to a client record is the worse outcome.

---

## 6. Scoring model

Replaced since v2.0. Five signals, weights totalling 80.

| | Signal | Weight |
|---|---|---|
| **A** | Over 59.5 years old, **or** graduated college before 1990 | 25 |
| **R** | In role under 60 months **and** holds another role marked Present | 5 |
| **T** | C / VP / Director / Partner / Owner / President / Founder | 20 |
| **E** | 10+ years at previous companies at a senior level | 20 |
| **C** | Mobile **and** email on file | 10 |

Tier A at 60, tier B at 40. Excluded states (CT, MA) short-circuit to X.

**Age** prefers the confirmed figure from enrichment, falling back to
graduation year. **Prior experience** is Years of Experience minus Years at
Current Employer, derived from graduation year or first work year when the
column is absent — and it counts only alongside a senior title, because the
data carries no prior job *titles*. That inference is a known limitation, not
an oversight.

**Settings carry a `modelVersion`.** Saved settings override defaults on load,
so without a version bump a stored config pins an old model in place forever
and a new one silently never applies. A bump clears the scoring keys and
preserves templates, org details, advisors and pricing.

---

## 7. Data model

Firestore, Native mode, `(default)` database.

| Collection | Key | Holds |
|---|---|---|
| `sessions` | session id (cookie value) | OAuth token caches, 8-hour expiry |
| `lead_state` | signed-in email address | settings + leads, one doc per user |

Leads carry, beyond v2.0's list: `years_experience`, `years_at_employer`,
`first_job_year`, `concurrent_roles`, `personal_email`, and the enrichment
block — confirmed `age`, `dob`, home address, `owns_home`, `owner_type`,
`properties_owned`, `mobiles[]`, `emails[]`, `matched_by`, `match_score`.
**Migrating without these silently disables the A and E signals.**

`enrichment_status` and `phone_validated` are **terminal** flags, never reset.
`enriched_at` is displayed as a passive staleness indicator only.

### 7.1 Credential handling — the outstanding gap

Session documents hold OAuth refresh tokens. Firestore encrypts at rest with
Google-managed keys, so they are not plaintext on disk, but **anyone with read
access to the database can use them.**

v2.0 §7.2's KMS envelope encryption — generate a DEK, encrypt the token blob,
store ciphertext plus the wrapped DEK — is the fix and is **not built**. Until
it is, treat Firestore read access as equivalent to access to the connected
Google and Microsoft accounts, and keep the IAM role list short.

This is the last open item in Phase 0.

---

## 8. Compliance

### 8.1 Archiving — unchanged, still unanswered

Ask Equitable compliance one narrow question: *"If I send client email
programmatically via Microsoft Graph from my firm mailbox, is it captured by
the firm's existing journaling?"* Yes → keep the lightweight audit log and skip
WORM storage. No → the app becomes the 17a-4 system of record.

Obligations in play: SEC **Rule 17a-4**, FINRA **3110**, FINRA **2210**. Keep
draft-first send regardless — cheap insurance against rework.

### 8.2 FCRA

Identity data is **not** an FCRA consumer report and must not drive eligibility
decisions. Gate the reminder at the enrichment action, server-side.

### 8.3 TCPA — the gate lost its data source

v2.0 routed high-risk leads to email-only using Trestle's Real Contact
litigator flag. **Whitepages Pro exposes no such flag.** The automated routing
described in v2.0 cannot be built as written.

Two honest options: find another litigator/DNC source, or make it a manual
checklist step and stop describing it as automated. Do not leave a gate in the
document that no data supports.

What *does* exist, and matters more than expected: phone verification reveals
when a number belongs to someone else entirely. See §11.

### 8.4 ZoomInfo ToS

Non-transferable. No distributing, sublicensing or reselling; no commercial
service bureau use. The single-tenant own-seat model sits comfortably inside
this.

---

## 9. Contact data — what to enrich with next

Ordered by value per unit of effort.

**Already paid for, currently unread.** `relatives[]`, `historic_addresses[]`,
`owned_properties[]`, and scored `emails[]` are in every response. Relatives
find the spouse who is often the actual decision-maker; address history shows
mobility. Zero marginal cost.

**Free and public.** SEC EDGAR **Form 4** filings — if a lead is an officer or
director at a public company, their equity holdings are public record. This is
the only source on the list that yields genuinely *confirmed* net worth rather
than a proxy. FEC contribution filings correlate with disposable income and
double as employer verification.

**Paid, and the real gap.** ATTOM or Estated for property valuation; deed and
mortgage records for purchase price and equity. The qualification model gates
on net worth and every current input is inferred from job titles — one real
source would do more for grade accuracy than any weight tuning.

---

## 10. LinkedIn and other sites — compliant primitives only

v2.0 §9 stands unchanged and is the section most likely to be argued with, so
its reasoning is worth restating: **hiQ v. LinkedIn** established that scraping
public pages likely does not violate the CFAA, and LinkedIn then **won on
breach of contract** — a December 2022 consent judgment imposing $500,000, a
permanent injunction and destruction of scraped data. **LinkedIn v. Proxycurl**
ended with Proxycurl shut down in July 2025 and an injunction reaching *its
customers*. No federal computer crime ≠ legal.

**Build:** Sign In with LinkedIn (OIDC) · a "View on LinkedIn" deep-link from
the profile URL ZoomInfo already returns · Sales Navigator handoff to your own
licensed seat.

**Do not build:** any scraper, any purchase of scraped data, any people search.

**This extends to real-estate sites.** Scraping Zillow or Redfin for home
values has the same legal shape, Zillow's Zestimate API was retired in 2021,
and parsing a dollar figure out of HTML fails silently — producing a wrong
number feeding a net-worth gate. The compliant pattern is identical to
LinkedIn's: **deep-link and let the advisor read it in their own browser**, or
buy licensed AVM data.

Any LinkedIn or social **messaging** is a business communication under §8.1 and
must be archived.

---

## 11. Data quality — ZoomInfo mobiles

New section, from production observation.

Multiple ZoomInfo mobile numbers came back owned by someone else entirely —
different names, different people — and one was independently confirmed against
the consumer Whitepages site. This is the vendor's data, not a bug in the
integration.

Three consequences:

1. **Funnel math needs a haircut.** §5.4's contact-rate assumption treats every
   number as reaching the lead. A meaningful share do not reach anyone
   relevant.
2. **Phone verification stops being optional.** It is the only thing standing
   between the call list and a wrong number.
3. **The TCPA exposure is personal.** Dialing an unverified mobile that belongs
   to a stranger is the fact pattern the rules exist for, and the registrations
   at risk are the advisor's. Worth deciding whether a verified mismatch should
   *suppress* the call action outright rather than merely flag it.

An owner mismatch at the **same address** is a different thing entirely —
usually a spouse, and often the better prospect for a retirement conversation.
Worth capturing deliberately; not worth auto-creating leads from arbitrary
strangers who never opted into anything.

---

## 11a. ZoomInfo search and enrichment — what this subscription actually allows

Written from live API responses on 2026-08-20, not from the vendor's docs. Three
findings, each of which cost a wasted attempt.

### `jobTitleList` entries combine with AND — use Boolean OR inside one entry

**Corrected.** The original finding here was half right and its recommendation
was wrong. The wrong half was acted on, so it is kept visible rather than quietly
replaced.

Array *entries* do combine with AND. A query for eleven senior titles returned
**zero results** — no person holds all eleven — and a two-entry query for
`["Chairman", "Chief Executive Officer"]` returned only people whose single title
string contains both, e.g. Wells Fargo's "Chairman & Chief Executive Officer".
This fails **silently**: an over-broad list reads as "nobody matches your
criteria" rather than as an error, inviting the wrong conclusion about market size.

The recommendation drawn from that — *one search per title, unioned client-side* —
was wrong. ZoomInfo's Boolean rules explain why: keywords **inside one filter
chip** are ANDed, **separate chips** are ORed. The array is one chip. The union is
expressed with an `OR` operator *inside a single string value*:

    jobTitleList: ["Chairman OR Founder OR Partner OR Managing Director"]

Measured against the parts: `Chairman` alone 40,639, `Founder` alone 1,318,501,
the `OR` of the two 1,353,762 — the union less the 5,378 people holding both. At
production filter settings one `OR` call returned 354,118 against 352,373 summed
over six separate searches. **Six calls collapse into one.**

Double quotes are rejected (`Must only contain letters and spaces`), so phrases
cannot be quoted for exactness — see `exactJobTitle` below for that.

Title matching is also **substring, not exact**. `"Chief Financial Officer"`
matched an *Executive Assistant To* a CFO. `excludeJobTitleList` is therefore not
optional — and it needs a local backstop regex as well, since "PA To the
Chairman" survives an `"Assistant"` exclusion and "HR Business Partner" survives
anything aimed at ownership partners.

### `yearsOfExperience` is unavailable in both directions

- As a **search filter** (`yearsOfExperienceList`): rejected,
  `Disallowed field 'yearsofexperience'`.
- As an **enrichment return field**: also rejected — *and inconsistently*. In one
  batch of ten, eight contacts hard-failed on the disallowed field while two
  succeeded with it downgraded to a warning. Partial failure of a batch is a
  normal outcome, not a transport error; the caller must reconcile per contact.

### `education` carries no graduation year

Enrichment returns school and degree, never a year. Combined with the absence of
age and date of birth, **ZoomInfo cannot supply this model's primary age
signal at all** (over 59.5, or graduated before 1990).

The only proxy available is the earliest `fromDate` in `employmentHistory`, and
it is a *lower bound* — the history is truncated to the most recent few roles, so
career length is systematically understated and age with it.

The consequence for the pipeline is structural: **ZoomInfo can source and rank a
list, but Whitepages decides tier.** Any plan that assumes a ZoomInfo pull alone
yields Tier A leads is wrong before it starts.

### Enrichment is capped independently of search

Search is free and effectively unlimited at this tier. Enrichment returned
`Limit exceeded` — for a *single* contact, not just a batch — after two
successful records. Search volume tells you nothing about how many contacts you
can actually enrich, so **enrichment budget is the binding constraint on any
list-building plan** and should be checked before a list is selected, not after.

---

## 11b. Scoops — the job-change signal we were inferring all along

Tested live 2026-08-20. `search_scoops` is free, like all search, and returns
something the contact endpoints do not: **a dated, sourced event**.

A single result carries the person's ZoomInfo ID, an exact publication date, a
link to the press release behind it, and a plain-English description naming both
employers — *"has left the organization to join X as Y"*. Filtered to senior US
executives from February 2026, there were **21,811** of them.

That sentence is the orphaned 401(k). §5's model reaches the same conclusion by
inference, from `positionStartDate` — a field one coverage test found 0%
populated. Scoops supply it as fact with a citation.

### The filters the contact search does not have

`search_scoops` accepts `locationSearchType: "Person"`, so location can be
scoped to where the *person* sits rather than the company HQ. `search_contacts_v2`
has no such parameter, which is why a New-York-filtered contact pull returned
people at Al Madar Holding, the University of Buenos Aires and AustralianSuper.
It also accepts `excludedRegions`, `managementLevels` and `jobTitle`.

Scoop types worth watching, from the live enum: `Executive Move`, `Left Company`,
`New Hire`, `Promotion`, `Lateral Move` — and `Exit Investment`, which is a
founder liquidity event rather than a rollover, but is money in motion all the
same.

### personIdList is the credit-free hop

The scoop returns `contacts[].id`. Feeding those IDs to `search_contacts_v2` via
`personIdList` (max 50) returns the full contact record — title, employer,
accuracy score, `hasEmail` / `hasMobilePhone`, both DNC flags — for **zero
credits**. A record checked this way had already refreshed to the person's *new*
employer the same day the scoop published.

This inverts the economics of §11a. Enrichment is the binding constraint, so the
rule is: discover and qualify for free, and spend a credit only to reach someone
already known to qualify.

    free    search_scoops
    free    personIdList -> title, employer, contact flags, DNC
    free    app scoring
    free    Whitepages -> age, home address
    CREDIT  enrich_contacts, Tier A survivors only

### Intent is a different business, not a bigger list

Two relevant topics exist — `401k Retirement Plan` and `Retirement Planning` —
and 2,255 US companies scored ≥70 on them. But both sit under ZoomInfo's
*Human Resources → Compensation & Benefits* category. These are **employers
evaluating their own retirement plan**, not individuals contemplating a rollover.

That is a corporate plan-sponsor prospect: different buyer, larger ticket, and a
source of rollovers for years afterwards. It should be a separate pipeline. Mixed
into the rollover list it would corrupt every tier count in the app.

### Lookalikes are persona-matching, not wealth-matching

`find_similar_contacts` works, but ranks on job persona only — title, department,
industry, revenue band, headcount. Three results came back with identical scores
and identical profile briefs. It knows nothing about age, tenure or life stage,
which is where this model lives, so it adds little over a title search.

---

## 11d. Per-user ZoomInfo — one seat per advisor, not one shared login

Every ZoomInfo call the app has made so far has run through a single connector
authenticating as one account. That is fine for a prototype and wrong for a
product: it bills one seat for everyone's searches, attributes nobody's work to
them, and hands every user of the app the credit balance of whoever wired it up.
The connector we have been testing against authenticates as an Equitable
address, not as the person using the app — a test account, but the shape of the
problem is the shape it would have in production.

So the app now carries an OAuth flow of its own for ZoomInfo, alongside — not
instead of — sign-in with Google or Microsoft. You sign in to use the app, then
connect your ZoomInfo seat to it. Searches and enrichment spend *your* credits.

### Standard app, Authorization Code — the fact that decided it

ZoomInfo's DevPortal distinguishes **Standard** apps (one org, self-serve) from
**Partner** apps (many customer orgs, ZoomInfo review required). The temptation
was to assume per-user attribution needs Partner status. It does not: a Standard
app may use either OAuth flow, and Authorization Code exists precisely so that
requests can be attributed to an individual user. One firm equipping its own
advisors is a Standard app, self-serve, today.

PKCE is sent regardless. A Standard app is permitted to use it and a Partner app
is required to, so the same flow survives a later decision to sell the tool to
other firms without a rewrite. The cost of building it in now is about six lines.

### What is not verified, and why the endpoints are env vars

`ZI_AUTH_URL`, `ZI_TOKEN_URL` and `ZI_API_BASE` **have not been exercised
against a live ZoomInfo tenant.** Outbound requests to `zoominfo.com` are
blocked from the build environment — every probe returned 403 at the proxy — so
the real authorize and token hostnames are guesses from documentation, which
§12 records as an unreliable source in this codebase specifically. Rather than
bake a guess into code, all four are read from the environment: when the
DevPortal shows the real values, they are a variable change, not a deploy.

Our own half of the flow *is* tested, against a stub that validates PKCE, client
credentials and redirect URI the way a real server would: the challenge really
is `sha256(verifier)`, a forged `state` is rejected, an expired token refreshes
rather than re-prompting, and a second user on the same server cannot reach the
first user's seat.

Two §12 rules were followed deliberately rather than rediscovered:
`/api/zi/search` is **a passthrough, not a parser**, because no live response has
been seen; and `/api/zi-debug` exists **from the first commit** rather than after
two wrong parsers, which is what it cost with WhitePages.

### Connecting requires being signed in

A ZoomInfo token is never attached to an anonymous session — hitting the connect
URL while signed out redirects to sign-in first. This is the same leak that was
closed for lead lists when storage was namespaced per account, and worse here,
because the thing leaking is a billable seat.

**Still true, and still the blocker:** DevPortal access requires an API
entitlement on the subscription. No amount of correct code substitutes for that,
and it remains open question #1.

---

## 11e. The search matters more than the model

A real export settled a question the app had been guessing at. 87 Boeing contacts,
run through the live scorer:

**All 87 Tier C. Top score 30 out of 80. Median 10.**

| Signal | Worth | Hit |
|---|---|---|
| A Age | 25 | 0 |
| R Recent move + second role | 5 | 0 |
| T Decision-maker level | 20 | 9 |
| E Prior senior experience | 20 | 0 |
| C Email + mobile | 10 | 47 |

Tier B needs 40. With A and E structurally at zero the ceiling is 35, so **no
lead in that file could clear Tier B by arithmetic**, whoever they were. The
empty tiers were never a judgement about the people.

### One credit per exported record changes where the work belongs

The credit model is per exported record. That reframes everything: **93 of the
180 leads in the live list were held out for having no mobile — roughly 93
credits spent on people the app then refused to call.** In the Boeing file all 87
had mobiles but 40 had no email, so signal C died on nearly half.

Advanced Search has a **Contact Info** filter that requires business email *and*
mobile with AND logic. Applying it costs nothing and makes every exported record
satisfy signal C. The Excluded bucket becomes near-empty not because the scoring
got kinder but because we stopped paying for records that were always going to
fail it. Filtering before export is the only real control on spend.

### Management Level beats our keyword matching

Signal T matched 9 of 87 on a file full of "Manager, Electrical Engineering".
ZoomInfo's own **Management Level** classification is "based on responsibility,
not just words in the job title" — strictly better than a regex over title text,
and available both as a search filter and an export column. The export that
produced these numbers did not include the column at all. The app already maps
and scores it, so adding it to the export is free accuracy.

### What the export does not contain

No graduation year, no years of experience. `Highest Level of Education` exports
as a **category** — Graduate, Undergraduate, PhD — not a year, so it cannot proxy
age. There is a `College/Degree` **search filter**, which proves ZoomInfo holds
education data, but nothing establishes that a *date* is exportable.

That leaves signals A and E — 45 of the 80 points — unreachable from ZoomInfo
alone. One tempting shortcut does not work: deriving career length from Job Start
Date makes signal E score zero by construction, because E is total years *minus*
current tenure and that subtraction cancels.

So confirmed age has to come from WhitePages enrichment, or the model has to be
re-weighted around what is knowable. **That decision is deliberately not taken
here** — it is a business judgement about who gets called first, and it should be
made after a ten-record test export settles whether any education date exists.

### The list and the model disagreed about what a good lead is

Twenty-five of the 87 had 30+ years at one employer; nine had 40+. On the
rollover thesis — orphaned 401(k), retirement, consolidation — a Boeing lifer
approaching retirement is a better prospect than a VP who moved last year. The
model scored them 10, because it uses *title* as the wealth proxy.

Neither side is wrong. The scoring model encodes a wealthy-decision-maker ICP;
that pull encoded a company. Until the search is written to match the model, the
tiers will keep reporting a mismatch as if it were a quality problem.

### Also worth knowing

- **Records Under Management**: anything already exported can be re-pulled or
  re-enriched free for a year, so refreshing the existing list costs nothing.
- **Enhance** charges only for records it successfully updates — the credit-
  efficient way to fill missing mobiles on a list already paid for.
- **Views are not credits.** Revealing contact details on screen spends a view
  even when nothing is exported.
- Tagging is free.

---

## 11f. SEC EDGAR — the one automated source that is permitted, not tolerated

§10 rules out scrapers, and §11e showed the age signal is worth 45 of the 80
available points and is unreachable from ZoomInfo. Those two facts point at the
same question: is there anywhere age can be read automatically *without*
breaching somebody's terms?

There is, for one segment. **Regulation S-K Item 401 obliges a proxy statement
(DEF 14A) to list the names, ages and positions of directors and executive
officers.** Age is not something to be inferred for these people — it is a
required public disclosure, filed annually, in a machine-readable archive.

And the SEC **permits automated access on stated terms**: a descriptive
User-Agent carrying a contact address, and a ceiling of 10 requests per second.
That is a categorically different position from LinkedIn or ZoomInfo, where
automated extraction breaches the terms of use. Here the operator is invited,
subject to conditions.

Both conditions are enforced in code rather than assumed. `EDGAR_USER_AGENT` has
**no default** — unset, the endpoint refuses rather than sending an invented one,
because a bad User-Agent is how a firm gets its whole IP range blocked. Requests
are serialised through a lock and spaced to 8/second, under the ceiling rather
than at it.

### What it does not cover, stated plainly

Section 16 officers and directors at SEC filers. That is roughly the C-suite and
the board. It answers for **nobody else** — not a private-company owner, not a
long-tenured engineer at a public company. Against the Boeing list from §11e,
which is mostly managers and engineers, most rows will come back empty.

So this is not a fix for signal A. It is a free, exact answer for precisely the
segment the ICP was built around — the one currently returning zero Tier A leads.

### Claude reads the filing; a regex would not survive

Proxy statements are laid out by dozens of filing agents and no structural
assumption holds across them. A regex aimed at a table cell would match the wrong
cell silently — the WhitePages failure mode, at larger scale. The markup is
stripped and the flattened text goes to Claude under a strict contract: report
only an age printed for this person, never estimate, never infer from career
length, never carry an age across from a similar name, prefer "not found" to a
guess. The answer is then range-checked, because a wrong age scores worse than no
age.

**The lead detail shows the sentence the age came from and links the filing.**
That follows §5's rule — attach the right person, or nobody — and makes the
advisor the last check rather than the app's confidence.

### Ambiguity refuses

Stripping legal suffixes to make "The Boeing Company" match "Boeing" also
collapses "Acme Industrial Corp" and "Acme Industrial Holdings" onto one key. The
first implementation kept whichever arrived first, which would have returned the
wrong company and therefore the wrong person's age — silently. A test caught it.
Colliding names now return nothing, and the full legal name is matched first so
that precision still wins.

### Unverified, and why the seams are where they are

**No live EDGAR response has ever been seen from the environment this was written
in** — the egress gateway answers 403 to CONNECT for all three SEC hosts. The
URLs and JSON shapes come from documentation, which §12 records as unreliable in
this codebase specifically. Hence: all four hosts are environment variables, and
`/api/edgar-debug` ships in the first commit rather than after two wrong parsers.

Our own half is tested against a stub — 28 backend checks and 21 UI checks
covering the User-Agent, the rate limit, ambiguous companies, and every way an
age can fail to be real.

### Deferred

**Form 4 insider holdings** — the dollar value of stock an officer holds, a real
wealth signal and already Phase 3 on the roadmap. It needs a separate pipeline
(ownership XML, matching the person's own CIK) and was left out rather than
half-built alongside this.

---

## 11g. The MCP server is a different door from the API

The DevPortal entitlement never arrived, and §11d's OAuth work is stranded behind
it. That looked like the end of programmatic ZoomInfo access. It is not: **the
REST API and the MCP server are separate doors, and only the first needs the
entitlement.**

Anthropic's Messages API can hold a connection to a remote MCP server and make
the calls itself. The app asks Claude, Claude calls ZoomInfo carrying the user's
own token, and the app never speaks ZoomInfo's protocol. The seat is still the
user's, the credits are still theirs, and no DevPortal app exists anywhere in the
picture.

### The bridge had been broken, not merely limited

`callClaude()` sent `mcp_servers` alone. Both halves are mandatory — the server
must also be referenced by an `mcp_toolset` entry in `tools`, under the
`mcp-client-2025-11-20` beta — and omitting the toolset is *"rejected as a
validation error"*. So the in-Claude path was failing outright, and the message it
showed on failure ("only works inside Claude") pointed at the wrong cause. It also
pinned `claude-sonnet-4-6`.

The lesson is the older one from §12 restated: this was written against a
remembered API shape rather than the current contract, and the misleading error
message meant it read as an environment limitation for weeks.

### Where the credential lives, and where it must not

The token goes in the **session document**, which KMS covers, alongside the Google
and Microsoft refresh tokens. It is explicitly kept out of `state.settings`,
because everything there is written to `localStorage` and PUT to the lead-state
document — a credential in a synced settings blob would be a credential in plain
text in the browser. A test asserts it reaches neither.

### Unverified, and honestly so

`mcp.zoominfo.com` is unreachable from here (403 at the egress gateway), so **no
live MCP response has been seen**. What is asserted is our half of the contract:
both request halves present, the beta flag sent, the token scoped per user, and
failures raised rather than returned as empty lists. `/api/zi/mcp-debug` asks
Claude to list the ZoomInfo tools it can reach — one request settles whether the
token works.

The remaining unknown is **where a user obtains an MCP token**. If ZoomInfo
exposes one, pasting it is enough. If their server uses OAuth, §11d's flow can be
repointed at it — tested machinery, changed endpoints — but that was not built
blind against a server this environment cannot reach.

---

## 12. Working practice

Two rules earned the hard way, both worth keeping.

**Get a live response before writing a parser.** Vendor documentation was wrong
twice in one session — the vendor's identity, and the existence of
`/v2/phone` — and each error cost a deploy and a round of confusion. A single
real response sample would have prevented both.

**Keep a probe endpoint.** `GET /api/wp-debug` reports the exact URL called, the
status code and the untouched response body. It is what finally ended the
guessing, and it cost twenty lines. Sign-in gated, and it reports the key's
length rather than the key.

A corollary for anyone, human or model, working on this: **do not claim an
external system is verified from inside a sandboxed environment.** Egress
proxies forge TLS certificates and block hosts, so a check that appears to
succeed may prove nothing. The user's browser is ground truth.

---

## 13. Roadmap

### Phase 0 — Foundations · **nearly complete**
- ✅ Firestore for sessions and lead state
- ✅ HTTPS enforcement and HSTS on the custom domain
- ✅ Whitepages Pro integration, working and verified in production
- ❌ **KMS envelope encryption for per-user tokens** — the one item left
- ~~Cloud NAT static IP~~ — dropped, no allowlist to satisfy

### Phase 1 — ZoomInfo + grid actions · ~2.5–4 weeks
- Register the Standard App; confirm entitlement (~10 minutes, unstarted)
- OAuth Authorization Code + PKCE, Data scopes only
- Contact search/enrich with `locationSearchType: "Person"`
- Multi-select, job engine, SSE decoupled from execution, two-phase
  estimate → confirm → execute, hard per-job caps

### Phase 2 — Outreach hardening · ~2–3.5 weeks
- Audit log; WORM store only if journaling does not cover it (§8.1)
- FCRA / DNC / TCPA gates at the outreach action, server-side
- Decide whether a verified owner mismatch blocks the call action (§11)

### Phase 3 — Enrichment depth · ~1.5–2 weeks
- Read the fields already paid for: relatives, address history, properties
- SEC EDGAR Form 4 matching
- Household-contact detection; property deep-links
- Price ATTOM or Estated against observed property-ownership rates

### Phase 4 — Hardening · ongoing
- Read `X-RateLimit-*` rather than fixed backoff
- Credit-spend monitoring and alerting
- `min-instances=1` if cold starts hurt

---

## 14. Open questions

| # | Question | Owner | Blocks |
|---|---|---|---|
| 1 | Does the ZoomInfo seat carry API entitlement? | Register a Standard App | Phase 1, §11d |
| 2 | Does Equitable journaling capture Graph-sent mail? | Equitable compliance | Phase 2 scope |
| 3a | Will Equitable IT register the app? | Equitable IT | Microsoft sign-in |
| 4 | What replaces the TCPA litigator flag? | Vendor research | §8.3 |
| 5 | Buy property valuation data, or live without it? | Business decision | §4.3, §9 |
| 6 | Is any education date exportable from ZoomInfo? | 10-record test export | §11e — decides whether the model needs re-weighting |

**Resolved since v2.0:** ~~Which tenant hosts M365?~~ (§15) ·
~~Trestle configuration~~ (wrong vendor entirely) ·
~~IP allowlist~~ (none) · ~~home value source~~ (does not exist here) ·
~~session persistence~~ (Firestore, shipped) · ~~custom domain and TLS~~
(shipped).

**Standing risks:** vendor pricing changes, so re-check the estimator's
constants periodically. ZoomInfo contact data decays and is demonstrably wrong
for some mobiles today. Do not design around SNAP; it is closed.

---

## 15. Microsoft sign-in — there is no FPA tenant to register in

Tenant discovery settles what was open question #3, and not in the direction the
setup doc assumed:

| Domain | Tenant |
|---|---|
| `financialplannersofamerica.com` | none — `AADSTS90002: Tenant not found` |
| `equitable.com` | `0ed45188-c605-4511-8b80-3a5831be1abc` |

`SETUP-microsoft.md` opened with "sign in as admin" and "you need a Microsoft
365 admin account". There is no directory for the FPA domain to be an admin of.
Mail for it is handled outside Microsoft entirely, which is why Google sign-in
works and Microsoft has nothing to attach to. The instructions were not merely
incomplete; they described a console that does not exist for us.

The only real tenant is Equitable's, and there the account is a user, not an
admin. So Microsoft sign-in is **not an engineering task at all** — the code has
been finished and verified for some time. It is a request to another firm's IT
department, and it will live or die on their security review.

That review turns on one distinction worth stating plainly in the request:
these are **delegated** Graph permissions, not application permissions. The app
acts only as the person signed in, on a token that person's own sign-in
produced. It has no tenant-wide mailbox access and cannot touch anyone who has
not signed into it. Mail leaves via `/me/sendMail`, so it lands in the sender's
Sent Items and is journalled exactly as Outlook-sent mail is — which is also the
best available answer to open question #2, though only Equitable compliance can
confirm it.

### The alternative, if the users are not Equitable's

A multi-tenant registration (`MS_TENANT_ID=common`) lets advisors at any firm
sign in with their own work account, at the price of each firm's admin
consenting. It needs **no code change** — `MS_AUTHORITY` is built from
`MS_TENANT_ID`, so `common` is a variable, not a branch. Worth remembering
before anyone assumes a multi-firm future requires a rewrite.


## 16. Money in motion — invert the pipeline, start from the event

Everything before this section takes a list of people and asks whether any of
them has money moving. Section 6's scoring model is that question made
arithmetic, and section 11e observed that the search matters more than the
model. This is the end of that thought: **the search should not be for people at
all.**

### The Boeing list proved the point

87 real contacts, imported and scored. Tier A was not merely empty — it was
*arithmetically unreachable*. Signals A (age) and E (prior experience) were
structurally zero for the whole file, capping every lead at 35 against a Tier B
threshold of 40. No amount of enrichment on that list would have produced a
Tier A lead, because the list was assembled by employer and title, and neither
of those is evidence that money is moving.

The inference we were trying to make — *this person is 58 and a director, so
perhaps they have a rollover* — is a guess dressed as a score.

### The inversion

Find the **event** that moves retirement money, then find the people it moves.

Two free public sources, joined on employer name:

- **WARN notices.** The federal WARN Act obliges employers of 100+ to give 60
  days' written notice of a plant closing or mass layoff, and states publish
  those notices. Employer, location, headcount, effective date. Forward-looking
  by construction: the notice precedes the separation, and a 401(k) becomes
  rollable when employment ends.
- **Form 5500.** Every employer retirement plan files annually with the DOL.
  Total participants and total plan assets, in a bulk download.

Plan assets ÷ participants = average balance. Average balance × separated
workers = **dollars in motion**, at a named employer, on a known date. That is
the ranking, and it is evidence rather than inference.

The product is not a lead. It is a *reason to build a lead list*, with a
deadline. The existing machinery — ZoomInfo, Claude, the CSV importer, the
scoring model — still does the people. It just no longer has to guess why.

### Unmatched events are kept, flagged, and never priced

When Form 5500 has no row for a WARN employer, the event stays in the list with
`plan_matched: false` and a null balance, rendered as an em-dash and a badge.

Two alternatives were rejected. **Dropping it** throws away a dated separation of
several hundred people because a government CSV spells the employer differently
— the event is real whether or not the join succeeded. **Estimating a balance**
from a national average would put a fabricated number in the one column the
entire feature ranks on; a ranking that cannot be trusted is worse than no
ranking.

The same reasoning governs the matching itself. Names are normalised —
case, punctuation and corporate suffixes stripped, initialisms rejoined — but
deliberately not fuzzy-matched. Loose matching attaches the wrong company's
plan assets to a layoff, and a confidently wrong $40M is more damaging than an
honest dash. This is the same rule section 11f settled for EDGAR, where
`_norm_company` was changed to refuse on collision rather than silently keep the
first candidate.

### No live response has ever been seen from either source

This must be stated plainly because it bounds how much the column mapping can be
trusted. `dol.gov`, `data.gov`, `askebsa.dol.gov` and the state labor sites all
return 000/403 through this environment's egress proxy — an organisation policy
denial, and `/root/.ccr/README.md` is explicit that the response is to report the
blocked host rather than route around it.

So the WARN and Form 5500 column aliases were written from published field
documentation (the DOL layout specifies header-row field names, `_CNT` integers,
`_AMT` two-decimal amounts, mm/dd/yyyy dates, double-quote qualifier) and are
verified only against fixtures built to match that documentation. The parsers
themselves are well covered — 50 checks — but a passing parser test says nothing
about whether New Jersey calls its headcount column what we expect.

The design response is to make the gap visible and cheap to close rather than to
pretend it is not there:

- every URL is an environment variable, so nothing is hardcoded to a URL that
  may not exist
- the app fetches at run time from Cloud Run, which has ordinary egress
- `/api/sources/probe` reports, per feed, the rows read, the columns matched,
  and — the point of the endpoint — the required fields it **could not** match

One request against the real feeds turns the guess into a fact, and each miss it
reports is a one-line addition to an alias list. That is the intended first step
after deploy, and `SETUP-prospecting.md` leads with it.

### Limits worth recording

- **Only mass separations.** An individual retiring at 59½ files no WARN notice.
  Those still depend on the age signals — EDGAR for public-company officers, or
  a graduation year on import.
- **Subsidiary/parent mismatch.** The WARN filer is often a subsidiary while the
  plan sponsor is the parent. Accepted as a miss, per the no-fuzzy-matching rule.
- **Stale assets.** Form 5500 is annual with a long filing lag. The average
  balance is an order of magnitude, not a quote.
