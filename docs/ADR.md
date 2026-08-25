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

## 17. A research tool's output, measured

Section 11e argued the search matters more than the model. Here is that claim
tested against a real run, because the numbers are more useful than the
argument.

Do Browser was given a prospecting brief — the ICP, the six business lines, and
the instruction to "provide enough information for the app to accurately sort
and enhance the leads." It returned a Google Sheet: **155 people, all distinct,
22 columns, no duplicates, no junk rows.** As a piece of automation it worked.

### What the app can read from it

Four columns of 22: Full Name, Current Title, Current Company, LinkedIn URL.

There is no email, no phone, no mobile, no job start date, no graduation year,
no years of experience, and no confirmed age. Run through the importer and
scored, **every one of the 155 lands in Excluded with 20 points out of 80** —
signal T and nothing else. The mobile gate holds all of them out of a tier
regardless. The file cannot be worked: there is no way to contact anyone on it.

### Most of the remaining columns are the job title, restated

The sheet carries `Est. Age Range`, `Est. Annual Income`, `Est. Assets`,
`401(k) Rollover Opportunity`, `Lead Category`, `Life Event Signal`, `Money in
Motion Indicator`, `Lead Score (1-100)` and `Priority`. Cross-tabulated:

- **Age.** Three distinct values across 155 people. 90 are `55–64`. Every
  contact holding a "president" or "chief" title is `55–64` without exception.
  The age is the seniority of the title, relabelled.
- **The score.** The five derived fields collapse to **11 distinct combinations**
  across 155 people, and the score is a pure function of them — not one bucket
  carries two different scores. A "1–100 lead score" that takes 11 values
  carries under 3.5 bits, all of it recomputable from the title string. 98 of
  155 are "🔴 Hot".
- **Money in Motion.** Defined as a job change in the last six months, evidenced
  by the profile listing a previous role. It is not applied consistently even
  against its own rule: 31 people who *do* have a previous company are marked
  "No signal". `Years at Current Role`, the column that would make the claim
  checkable, is empty for all 155.

None of this is dishonesty on the tool's part. It was asked for age, income and
assets; those facts are not on the pages it was reading; it produced the best
available proxy and labelled it `Est.`. The brief never said a blank was
acceptable, so it never left one.

### Two changes, both narrow

**A column that announces itself as an estimate is never auto-mapped.** Headers
matching a leading estimate qualifier (`est`, `estimated`, `approx`, `assumed`,
`inferred`, `predicted`, …) are claimed before the matching passes run, so no
field can reach them, and the mapper says why rather than dropping them
silently. Mapped to age, `Est. Age Range` would be worth 25 points — 31% of the
total — awarded for a value derived from the job title that the score already
counts under signal T. The column stays selectable by hand: overriding is the
user's call, but the auto-mapper will not make it for them.

This also protects the `Age` column on the unmerged `claude/wealth-fields`
branch, where `Est. Age Range` would otherwise be a live partial match.

**The app now generates the prompt.** `researchPrompt()` is built from
`TEMPLATE_COLS` and the live ICP settings, for exactly the reason the CSV
template is built from `FIELDS`: a prompt naming columns the importer does not
read is worse than no prompt. It carries the schema verbatim, the ICP as
configured, an explicit instruction to leave a cell blank rather than estimate
it, a specific prohibition on inferring age from seniority, and a list of
sources where the facts are actually recorded — proxy statements, licensing
registers, alumni notes, WARN notices — rather than one profile site.

The generated prompt is not a fix for the sheet already built. It is what makes
the next run importable.

### The general rule

**A derived column is not data.** It costs nothing to produce, so it is produced
in bulk, and it arrives looking exactly like the observed fact it stands in for.
The only defence is the one applied here and in §16: refuse to consume it, keep
the blank, and say why the blank is there.

## 18. Two campaigns, one scorer

Everything up to here assumes one thesis: the money moves because the person
left an employer. Section 16 pushed that as far as it goes by starting from the
separation event itself. **SCS is the opposite lead**, and it is worth writing
down why it could not simply be a second saved search.

Structured Capital Strategies targets someone who *never* left. Twenty or thirty
years of contributions at one employer, and — past 59½ — the ability to take an
**in-service distribution** without resigning. No job change, no WARN notice, no
separation date. The event is a birthday.

### The two campaigns want opposite things from the same field

Rollover asks ZoomInfo for `positionStartDateMin` — started *after* this date.
SCS asks for `positionStartDateMax` — started *before* it. Same field, inverted.
And the tenure number that makes a Rollover lead good (short: they just moved)
is what makes an SCS lead bad.

That inversion cannot live in a saved-search description, because it has to
reach the scorer as well as the search. A list built under SCS rules and scored
under Rollover rules produces a coherent-looking ranking that is exactly
backwards. So `campaign` is a setting the scorer reads, and it is **stamped on
each lead at import** — a mixed list scores each half on its own terms, and
moving the switch does not silently rescore work already done.

### Signal E is dropped rather than reinterpreted

The 80-point budget is unchanged. A (age), T (level) and C (contact) are
identical. R becomes **V**: tenure at the current employer, 20 points at 18
years and 25 at 30. E — years at *previous* companies — is dropped entirely.

Dropping it is the point. E asks how much career happened somewhere else, and on
the best possible SCS lead the honest answer is "none, that's why I'm calling
them". Keeping it would have penalised precisely the leads the campaign exists
to find. Rolling its weight into V keeps the totals comparable, so `tierA` and
`tierB` did not need retuning and a mixed list sorts sensibly.

### The suspect-tenure threshold, and what set it

ZoomInfo sometimes returns a company founding date or a 1900 placeholder as a
position start. Unflagged, a 126-year tenure sorts to the top of the call list.

The flag exists. What matters is where it sits: **50 years**. It was lower, and
it flagged a real 46-year run at Boeing — the strongest lead on that list — as
bad data. A validity check that discards the best record is worse than no check.
The lesson generalises: a plausibility bound tuned on the typical case will cut
the tail, and in prospecting the tail is the product.

### Inferred age is allowed in, through a separate door

SCS needs an age and ZoomInfo has no age field, so age is worked out from the
start of working life: graduation year, first work year, or stated experience,
plus an assumed start age of 22. That is an inference, and §17 had just finished
arguing that a derived column is not data.

Both things are true, and the resolution is the door it comes through:

- `leadAge()` returns **observed** ages only — a proxy statement, a public
  record — and is what `scoreLead` reads. An inference cannot fire signal A as
  confirmed.
- `leadAgeAny()` includes the inference and is what the badge, the row and the
  export read, always accompanied by `ageBasis()` naming what it came from
  (`graduated 1984 + 22`).

The distinction §17 drew was never "no inferences". It was **no inference
wearing the clothes of an observation**. An inferred age with its basis visible
on every row is a working hypothesis. The same number in a column called
`Est. Age Range` is a fabrication. The difference is entirely in whether the
consumer can tell.

### A credit cap is a wait, not a failure

Enrichment never requests `yearsOfExperience` — the field that exhausted the
account once — and the request list is asserted in tests so it cannot creep
back. When the limit is spent anyway, the affected leads keep their ZoomInfo
person IDs, take a `retryBlocked` flag, and surface as a counted button in the
header. Before this, a capped batch disappeared into a status line and the leads
looked enriched-and-empty, which is the failure mode that costs the most: not an
error, but a silent hole in a list you believe is complete.

## 19. Four stages, and a sheet that reads itself

The app had eleven equal-weight buttons across the top and no statement of what
it was for. Every capability added since §11 arrived as another button, which is
what happens when the layout has no opinion. The stated priorities are:

1. Source leads
2. Enrich leads
3. Qualify leads
4. Track leads

That is a pipeline, and the screen now says so: four cards, in that order, each
showing how many leads are waiting in it and offering only the actions that move
them on. Everything else — settings, coverage, backups, template, recipe — went
behind a single **More** menu. A row of eleven equal-weight buttons is a menu
with extra steps and none of the affordances.

The counts are the point. "6 prospects, 0 waiting to enrich, 2 worth working, 1
meeting set" answers *what should I do now* without opening anything.

### Sourcing had to become automatic to count as sourcing

The research tool appends rows to a named Google Sheet on its own schedule. What
the app previously required of that arrangement: open a picker, search Drive by
name, pick the file, review a 28-row column mapper, press import. Five
deliberate actions to receive work that had already been done.

So the sheet is read **on load**, mapped by the same `guessColumns` any CSV goes
through, and new rows are added. No picker, no dialog, no button. The advisor
opens the app and the leads are there.

The name is a constant (`Wealth Management Lead Prospecting`, overridable via
`DRIVE_LEADS_FILE`) precisely so nobody has to go looking. A configurable thing
nobody configures is a default with extra steps.

### Dedupe on four identities, because email is usually absent

Re-reading is the normal case, not an edge case: the sheet grows and every check
re-reads rows already imported. The old importer keyed on `contactId|email`,
which is right for a ZoomInfo export and useless for a research tool's output —
§17 measured that output and found **no email column at all**. Every row would
have re-imported on every check.

`dedupeKeys()` now emits up to four keys per lead — contact ID, email, LinkedIn
URL (normalised for trailing slashes and query strings), and name-plus-employer
— and a match on any one is enough. The URL is what actually carries these
rows; the others are for the exports that have them.

### Saying what was ignored, because nobody saw the mapper

The manual importer shows its work in the mapping screen. The automatic path has
no screen, so the same information moves into one line under the Source stage:
how many were added, how many were already there, whether the sheet lacks a
phone or email column, and how many self-declared estimate columns were
excluded.

Silence would have been the easy choice and the wrong one. A sheet with no phone
column produces a list where every lead is Excluded, and without that line it
looks like a scoring problem rather than a missing column.

### The JSON importer is removed

It was added one commit earlier and it was the wrong feature. It existed because
a batch of leads had been produced in a conversation and needed a way in; the
right answer to that is the sheet, which is where the conversation should be
writing in the first place. Asking a financial advisor to paste a JSON array is
not a workflow, and a second import path with its own key-aliasing logic is a
second place for the two to drift apart.

### An excluded lead no longer heads the call list

Default sort was score, so a 75-point lead with no mobile sat above a callable
65. That bucket is deliberately valuable — one enrichment turns it back into a
Tier A, per §11 — but it is not a call, and it was occupying the first thing the
advisor looks at every morning. Tier X now sorts last regardless of score, and
the tier chips remain one click away.

## 20. Several lists per user, and several addresses to send from

### One document per list, not one per user

Leads were stored as a single array on `lead_state/{email}`. An advisor runs
more than one campaign at a time — a rollover pull, an SCS pull, the people who
came off one employer's WARN notice — and they should not see each other.

The obvious change is to add a `listId` to each lead and keep one array. That is
wrong for a reason worth recording: Firestore documents cap at 1MB, the importer
caps at 5,000 rows, and putting four campaigns in one document means the fourth
import fails because of the first three. Instead each list is its own document,
keyed `email__listId`, with an index of names and counts on the state document.

That also makes opening the app cheap. The index is a few hundred bytes; only
the list actually being opened is read.

Isolation comes from the key being derived server-side from the signed-in email
and never accepted from the browser. Two users can both hold a list called
`default`; neither can address the other's. §12's rule — a lead list belongs to
one account — is unchanged, and `lists-test.py` asserts it directly.

### Migration leaves the original in place

On first read, an existing single list becomes a list named "My leads" and the
leads are copied into their own document. **The original array is not deleted.**
Nothing writes to it again, so if this migration is wrong the original is still
there to read. Deleting it would save a few kilobytes and remove the only copy
of the thing being migrated.

The client also falls back to the old `/api/state` endpoint when the list index
is unavailable. An older deployment or a transient error should degrade to the
previous behaviour, not to browser-only storage that looks like data loss.

### Settings are per user, lists are per list

Weights, ICP, templates and org details moved to `PUT /api/settings` and live
once. The alternative — settings per list — sounds flexible and means changing a
scoring weight silently leaves three other lists scored on the old model.

### Which address the mail goes out as

The session could already hold Google and Microsoft tokens at once; nothing
exposed that. `_active_token` picked one by `session["provider"]` and every send
went out as whichever account had signed in last.

`GET /api/senders` now enumerates what this session can actually send as: the
Google primary, any **verified** Gmail send-as alias, and the Microsoft mailbox.
Unverified aliases are excluded because Gmail refuses them at send time —
offering one produces a failure at the worst moment rather than at the menu.

Both `/api/send-email` and `/api/create-event` take a `sender` id. For a Gmail
alias the `From` header is set; for a primary address it is left alone and the
provider fills it in. A calendar invite has no alias to set — it is owned by the
calendar it is created on, so choosing a sender chooses whose calendar it lands
on and therefore what the attendee sees.

**An unknown sender id is a 400, never a fallback.** The tempting behaviour is
to shrug and send from the default. Sending from the wrong address is a mistake
only the recipient notices, and by then it has already happened.

The picker is hidden when only one address is available. A dropdown with a
single option asks the user to confirm a choice they do not have.

### A scope was added, and old sessions will not have it

Listing aliases needs `gmail.settings.basic`. Accounts that signed in before
this shipped do not have it, so the call 403s — handled as "primary only"
rather than as an error, with the fix (sign out and back in) documented. Adding
a scope silently breaks nothing but silently gains nothing either; it has to be
said out loud somewhere, and `SETUP-lists-and-senders.md` says it.

### An unrelated label bug found while testing

Both send buttons read "Open draft in Outlook" and "Create Outlook invite"
regardless of sign-in state, while the code behind them sent immediately when
signed in. The modal text was correct and the button contradicted it. Fixed to
"Send now" / "Send invite" when signed in. Worth recording only because no test
caught it and no test could have: every assertion was about behaviour, and the
defect was entirely in what the button claimed that behaviour was.

## 21. Callbacks, sharing, and a leaderboard that is not made of leads

Magic List Maker was named as the feature set to match. Comparing it against
what was here, four things were genuinely missing — a callback reminder, list
sharing, a leaderboard, and contests — and the rest (statuses, notes, an
activity log, one-click invites, a template engine) already existed.

### The callback is the one that mattered

"Call me back Thursday" is the commonest outcome of a call. The app had a status
called Call Back and nowhere to put the date, so it lived in someone's head.

A reminder nobody is shown is worse than no reminder, so a due callback surfaces
in three places at once: a counted button in the Track stage, a red line on the
row carrying what to pick up on, and a filter. It also **sorts to the top of the
call list, ahead of higher scores** — the same reasoning as §19's excluded-last
rule, taken one step further. The default sort answers *who do I call now*, and
a promise made to a person beats a score computed about one.

It stops surfacing when the meeting is set, or when the lead is marked Not
Interested or Has Advisor. A reminder about someone who has already said no is
noise, and noise is how a queue stops being read.

### Sharing: one list, one named colleague

§12 established that a lead list belongs to one account, and sharing is the
first deliberate hole in that. It is kept narrow: a share names one colleague
and one list, and nothing else on the account travels with it.

The mechanism is a reverse index (`lead_shares/{recipient}`), because Firestore
cannot answer "which of everyone's lists name me" without one. A shared list is
addressed `owner@firm.com~listid`, which lets both kinds live in one switcher
without their ids colliding — `default` is a plausible id for two different
people's first list, and §20 relies on exactly that being safe.

Every read and write re-checks access server-side rather than trusting the id in
the URL. An editor may write; a viewer is refused with an explanation rather
than a silent no-op; someone the list was never shared with gets 403 and cannot
tell a private list from a nonexistent one.

Two revocation paths exist and both are legitimate: the owner withdraws access,
and the recipient walks away from a list they did not ask for. Deleting a list
revokes it from everyone, or their switcher keeps offering a list that is gone.

### The leaderboard is counters, not leads

The obvious implementation aggregates everyone's lead documents. It is wrong
twice: drawing one table would mean reading every lead in the firm, and it would
expose lists that were never shared. So each advisor writes four integers a day
— calls, emails, invites, meetings — to `advisor_stats/{email}__{day}`. A
counter document leaks a number where a lead document leaks a prospect.

The client sends **totals for the day, not increments**, so a replay, a double
click or a reopened tab cannot inflate a score. That is a one-word difference in
the API and the difference between a leaderboard people trust and one they
don't.

**Points are deliberately lopsided**: a call or an email is 1, an invite 3, a
meeting 10. A contest scored on raw dials is won by whoever dials numbers they
never meant to talk to. The scoring rule is the incentive, and getting it wrong
would make the feature actively harmful rather than merely useless.

A contest is the same code with a start date, an end and a chosen field. Nothing
about scoring is duplicated.

### Team membership by email domain

A firm is a domain. That rule needs no invitations, no admin screen and no
onboarding, and it is right for the only deployment that exists. Sharing
relationships extend it to advisors at other firms. `TEAM_BY_DOMAIN=0` turns the
domain half off for a deployment where that assumption fails.

### Two small corrections made along the way

`cbLabel` measured whole days by rounding the difference between a timestamp and
today's midnight, so a callback due at 5pm two days ago read "yesterday".
Comparing calendar days fixes it. Worth recording because the test that caught
it was checking the *text*, not the arithmetic — the bug was in what the row
said, and only an assertion on the sentence would have found it.

The 🏠 button's tooltip promised "home value", which this API has never
returned (§4). Now it names what actually comes back.

## 22. Watching the leads you already have

§16 inverted the pipeline to start from an event. This applies the same idea to
a list that already exists: rather than asking *who should I find*, ask *which
of these people has something happening*.

### Four detectors, ranked by how much they can be trusted

**Turning 59½ is the only money-in-motion event that can be known before it
happens, with certainty, for free.** It is a date, not a search — everything
else in this project has been an inference dressed carefully enough to be
useful, and this one is arithmetic. That is worth stating plainly because it
inverts the usual cost/confidence ordering: the cheapest signal here is also the
most reliable.

WARN and 8-K are exact but external. Tenure is arithmetic again.

### The 8-K nearly shipped as a false positive

Item 5.02 is a four-business-day disclosure of an officer departure, and the
first implementation fired it at every lead whose employer had filed one. A test
fixture caught it: a 41-year-old logistics manager at Boeing was being told that
Boeing's money was in motion because Boeing's CFO retired. He learns nothing
from that.

The rule now has two doors. If the filing text **names the lead**, it is the
strongest signal the app can produce — a dated, legally required disclosure that
this specific person's employment is ending. Otherwise it is offered only to
officers of that company, hedged, at lower urgency. Everyone else is not told.

WARN is deliberately the opposite: shown to every lead at that employer, because
a mass separation genuinely affects the whole workforce. The two are not
inconsistent — one names a person, the other names a population.

The general rule this settles: **a signal must be about the lead, not merely
near them.** A watchlist that cries wolf is not read by the second week, and an
unread watchlist is worse than none because it is believed to be working.

### Seen-state is per advisor

"New since you last looked" is what makes a watchlist survive daily use, and it
has to be per person: two advisors sharing a list each track their own, or the
first to open it silences the second. The store is bounded at 4,000 ids,
newest-last — an advisor working a list for a year should not accumulate an
unbounded document of ids they will never see again.

### Cost shape was designed before the feature

One EDGAR round-trip per **distinct employer**, capped at 25. A list of forty
people at four companies costs four lookups, not forty. Written that way from
the start because the per-lead version is the obvious one and is 10× the
requests against a rate-limited government API.

### Unattended email is deliberately not built

The panel sends a digest on demand, from the advisor's own connected account,
while they are present.

A morning email that arrives without opening the app is possible — Google
refresh tokens are stored KMS-wrapped and are valid offline, so a scheduled job
could mint a token and send as the user. It is a small change and it is left
undone on purpose: it means **the server sending mail as a person who is not
there**. That is a decision for the account owner, not an implementation detail
to slip into a feature about reminders.

### A note on what "free" bought

Every source here is public and free: state WARN filings, the SEC submissions
index, and arithmetic on a date. Between this and §16, the app now has an
event-driven prospecting engine and an event-driven watchlist, and the only
paid dependency in either is the enrichment that turns a name into a phone
number.

## 23. Free enrichment, and what "legally accessible" is a property of

Two things were asked for together: leverage every free data source, and build
the scraping tool that had been agreed months earlier and never written. They
turn out to be one decision and one piece of engineering.

### The free source that was already paid for

`FORM5500_URL` was fetched to price WARN employers (§16). The same file prices
*any* employer — assets over participants is an average balance — and doing so
puts a dollar figure on a lead whose only other data is a job title. The
marginal cost is zero: one request, one parse, already happening.

The number is a plain average across an entire plan, and the whole value of it
depends on that surviving contact with a hurried advisor. So the chip reads
`~$658,333 avg`, with the tilde and the word doing work, and the tooltip names
the plan, the participant count it averages over, the plan year, and says
outright that it is not this person's balance. An unmatched employer gets **no
chip** rather than a zero — §17's rule again.

One lookup per employer, not per lead.

### "Legally accessible" is a property of a relationship, not of a page

This is the load-bearing idea in `webapp/harvest.py`. Whether data may be
fetched is not decided by whether it is visible; it is decided by the terms
under which the publisher offers it. Three of those are machine-readable or
close to it, and all three are encoded in the module rather than left to the
caller's judgement:

- **robots.txt** — the published statement of what automated clients may fetch.
  Honoured, cached per origin. **If it cannot be read, the answer is no.** An
  unreachable rulebook is not permission, and the conservative reading costs
  only the pages of a broken host.
- **Identity** — `HARVEST_USER_AGENT` has no default and the endpoint refuses
  without it. The SEC states this requirement explicitly and §11f already met
  it there; the generalisation is to identify yourself everywhere, not only
  where you are told to.
- **Rate** — one request per origin at a time, a second apart minimum.

Then a denylist for sites whose *terms* prohibit automated access regardless of
robots.txt. LinkedIn is the one that matters, because it is where this kind of
research starts and its robots.txt would not stop us — the agreement does. The
refusal names the site and offers the alternative. Putting it in the tool makes
it a property of the app rather than of whoever is using it that day.

### It fetches; it does not crawl

One URL, named by a person, once. No frontier, no link-following, no recursion.
That is the difference between reading a page you were pointed at and operating
a robot over someone else's site, and it is enforced by the absence of code
rather than by restraint.

### A bug the tests found, worth recording

`robots.txt` was being fetched from the *hostname* rather than the origin, so
the port was dropped. Any site on a non-standard port therefore failed to
answer, and the failure surfaced as "this host has no robots.txt" — which under
the old logic would have meant *allowed*. A permission check that fails open
when it cannot reach the rules is the worst possible failure mode, and it was
one line: `urlparse().hostname` where `netloc` was meant.

The same test file then caught its own version of the mistake: a check named
"an unreadable robots.txt means no" was passing because the URL tripped the
private-address guard first and never reached the robots path at all. Both are
the same lesson — a passing assertion proves something passed, not that it
proved what its name says.

## 24. The Form 5500 file contains no money

The advisor put the DOL files in his own Drive, which surfaced two things at
once — and the second is the more important.

### Seven aliases right, one absent

The download included `f_5500_2025_latest_layout.txt`, the DOL's own field
layout. Checked against it, seven of the eight `PLAN_ALIASES` were correct:
`SPONSOR_DFE_NAME`, `SPONS_DFE_MAIL_US_STATE`, `PLAN_NAME`, `SPONS_DFE_EIN`,
`TOT_PARTCP_BOY_CNT`, `FORM_TAX_PRD`, `TYPE_PENSION_BNFT_CODE`.

The eighth was not wrong. It was **absent**. The file has 140 fields and none of
them is money — participant counts and nothing else numeric about the plan.

Assets are on **Schedule H** (100+ participants, `TOT_ASSETS_EOY_AMT`) and
**Schedule I** (smaller, `SMALL_TOT_ASSETS_EOY_AMT`), separate files joined on
`ACK_ID`. §16 built the entire dollars-in-motion ranking on assets ÷
participants; without the join, the numerator does not exist. Every employer
would have shown a headcount and no balance, the ranking would have had nothing
to rank on, and the app would have looked configured while producing nothing.

This is the third silent failure found in three encounters with real data
(§17 on estimated columns, §23's robots.txt origin bug, this). The pattern is
consistent: the code was written from documentation, the documentation was
about the right subject, and the thing that was wrong was an assumption too
basic to be stated anywhere — *that a file about retirement plans mentions how
much money is in them*.

`priced` is now reported by the probe alongside `rows_read`, because "how many
sponsors ended up with a number" is the question that was being answered
implicitly and wrongly.

### Schedule H first, Schedule I filling gaps

`attach_assets` never overwrites a value that is already there, so a file that
arrives pre-joined is left alone, and a large plan keeps its large-plan figure
rather than being overwritten by a small-plan row. Amended filings keep the
larger figure for the same reason §16 keeps the largest plan per sponsor.

A sponsor with no schedule row stays **unpriced** — null, not zero. §17's rule,
in the one place where a zero would be quietly catastrophic: it would rank a
real employer last rather than marking it unknown.

### Sources can live in the user's Drive

`FORM5500_URL`, `FORM5500_SCHEDULE_URLS` and WARN feed URLs now accept a Drive
share link, a bare file id, or `drive:<id>`, fetched with the signed-in user's
own credentials.

This is usually the better arrangement, and not only for convenience. The DOL
publishes behind a path that changes each year and returns a zip; a file in Drive is
stable, unzipped once by hand, and owned by the person who will notice when it
goes stale. The app already had read-only Drive access for the prospecting
sheet, so the marginal cost was a URL parser and a token pass-through.

A Microsoft-only session asking for a Drive source gets an explicit message
rather than an empty result, because "no data" and "no credentials" are
different problems and only one of them is the user's to fix.

## 25. The lookup was always buying more than it read

Dan looked Janet Melter up by reverse phone on the WhitePages consumer site and
came back with her mobile number confirmed, her **month and year of birth**, her
work, her other names, alternate phones, several email addresses and eleven
addresses. The app's own reverse-phone lookup — the same query against the same
company — was reporting three things: a line type, an owner's name, and an
address.

The gap was not a missing integration. It was a comment. `verify_phone` said:

> The Pro API answers a reverse-phone query with person records, so there is no
> carrier or prepaid flag to report

The first half of that sentence is a genuine finding from live data, recorded in
§12: there is no `/v2/phone`, reverse phone is a mode of person search. The
second half is a conclusion drawn from it that nobody checked. A person record
is *more* than a phone record, not less. The lookup was returning the whole
person the entire time and the handler was reading three fields off it and
dropping the rest — then the Enrich button spent a second credit fetching the
same record again.

This is the fifth entry in the pattern §12 opened, and the first where the false
belief was written down *in this repository*, in a comment, by us. The four
before it came from reading documentation about real data. This one came from
reasoning about a real finding one step too far, and then writing the conclusion
somewhere it would be read as established.

### One reader, both buttons

`_person_facts()` reads a person record. Enrich calls it. Verify calls it. Verify
now returns the record under `record`, and the front end folds it in through
`applyRecord()`, so pressing the phone check fills the household panel at no
extra cost and Enrich is a second lookup only when the first found nothing.

### Every new field is optional, and absence is a value

The Pro and Trestle dialects name things differently and accounts differ in what
they are entitled to, so each reader takes a list of plausible keys and returns
nothing when none is present. `_flag()` returns `None`, not `False`, when a
record says nothing about a flag — the difference matters most on `do_not_call`,
where "not stated" read as "not on the list" is a fine rather than a bad call.
A spam score of zero is shown as zero; a record silent about spam shows nothing.

A record with none of the new fields must produce exactly the behaviour the app
had before, and the tests assert that directly rather than by implication.

### The date of birth is the whole point

Everything else here is useful. The date of birth is different in kind.

Every other age in this app is an integer as of a filing date (§18), a
household record's round number, or a graduation year plus twenty-two (§21).
A month and a year give the **exact month a lead reaches 59½**, and 59½ is the
entire question the SCS campaign turns on. "Age 59" means somewhere in a
twelve-month band. "Born Aug 1970" means February 2030.

So it outranks everything, including the SEC proxy statement: a proxy prints an
integer as of a filing date, a birth record prints the month it happened.

### It carries no day, and the app says so

The record gives a month, not a date. Three consequences, all of them the same
rule as §17:

- **The age reported is the one certainly reached.** In the birthday month the
  day decides and nobody here knows it, so the app reports the lower of the two
  possible ages. It can be a month behind. It is never ahead.
- **The 59½ answer is a month.** `halfMonth()` returns a month index and the UI
  prints "Feb 2030". Printing a day would be inventing one.
- **In that month itself the badge says "59½ this month", not "59½ ✓"**, and
  both the badge tooltip and the signal detail say the day is not on file and to
  confirm it on the call. A green tick in the one month where eligibility turns
  on an unknown day would be the app asserting something it does not know.

### Two smaller things the record settled

A **married name** is the same person. The surname test looked only at the
primary name, so a record filed under a maiden name read as a wrong number and
the lead was flagged undialable. Aliases now count, and the check reports which
alias matched.

A **different employer** on the record is surfaced rather than quietly shown
beside the list's version. Which of the two is current decides whether there is
a plan to roll over at all, so it is a question for a person, not a field to
overwrite.

### Closing the loop instead of guessing again

None of the above was written against a live response — there is no key in this
environment and the egress proxy does not reach the API. Given §12's history
that is the exact condition under which this repository has been wrong five
times, so `/api/wp-debug` now returns a **field census**: every path in the
response, its type, and a truncated sample, plus what `_person_facts()` made of
it. "Does my key return a date of birth" is now one line to read instead of four
thousand characters of JSON.

The readers are written to find the field under any of its plausible names and
to stay silent otherwise, so the census is confirmation rather than the thing
that makes the code work — but it is what turns the next surprise into a
five-minute fix rather than a sixth entry in this section.

## 26. A zero-result 200 costs the same as a hit

This section was first written against the integration guide's wording —
"successful (2xx) and client-error (4xx) responses are billed" — and concluded
that a malformed request was a charge for being told no. **That was wrong**, and
the per-endpoint response-code table says so plainly:

| Status | Billable |
|---|---|
| 200 OK | **yes** |
| 404 by id | **yes** |
| 400, 403 | no |
| 429, 5xx | no |

The correction matters because it moves the expensive mistake. A malformed
query is free. What costs money is the **well-formed query that was never going
to identify anybody** — and a 200 carrying an empty `results` array is billed
exactly like one carrying the person. "No such person" is a purchase.

So the validator stays, but its justification changes: it buys a failure in a
hundredth of a second with a reason the user can act on, instead of a round
trip and a reason they cannot. That is worth having. It is not a saving.

The two things that actually save money are §26's real content: never ask a
question that cannot identify anyone, and never ask the same question twice.

### The validator, for clarity rather than credits

`wp_validate()` checks every parameter against the documented constraint and
raises before anything is sent — phone pattern, five-digit ZIP, the state-code
enum, ages inside 18–65, pages inside 1–10, and the two pairs the API
explicitly rejects when combined (`name` with `first_name`/`last_name`,
`strict_match` with `include_fuzzy_matching`). Empty values are dropped rather
than sent, because an empty `state_code` is a 400, not a wildcard.

The refusal names the offending value, because a user who cannot see what was
wrong cannot fix it, and a silent refusal is indistinguishable from a bug.

### Two things share the 429

Ordinary throttling clears in seconds. A usage cap does not clear until the
billing period resets, and it arrives with `error: "usage_cap_exceeded"` plus
`used`, `limit` and `reset_at`. Telling someone to "try again shortly" when
their allowance is gone until the first of the month is useless advice, so the
two are now reported differently and the cap message carries the date.

### The cache is a bill, not a speedup

`_WP_CACHE` keys on the exact validated query. The app was already fast enough;
this exists because a person's record does not change between two clicks and
the second click was buying it again.

Two details matter more than the cache itself:

- **A miss is cached.** "No such person" was paid for and will not change.
  Leaving it uncached meant every unmatched lead was re-bought on every press —
  and unmatched leads are exactly the ones a user presses repeatedly.
- **One spelling per question.** `verify_phone` and `enrich` each built their
  own reverse-phone query by hand, so the cache saw two spellings of one
  question and stored both. `_wp_phone()` is now the only door.

### The ladder, and why email is on it

Person search is one endpoint; phone, email, address and name are the same call
with different parameters. They are not equally good at identifying a person,
so Enrich climbs in order and stops at the first answer:

**phone → email → first+last with a location**

Email is the rung that matters. Not every lead has a mobile, and until now such
a lead fell straight to a name search — the query that returned the Portland
realtor in §14. Nobody shares an email address, so it identifies nearly as well
as a number does.

A name with no city, state or ZIP is refused without spending anything. It is
the query most likely to return a stranger, and the app has attributed one to a
lead before.

### Nothing is bought speculatively

The property lookup ran automatically inside Enrich, so every press that found
an address bought a second call whether or not anyone wanted the deed. It is
now its own button that names its price. Enrich answers "who is this person" in
one call; the deed is a different question and is asked separately.

### Counting rather than estimating

`/api/wp-spend` reports billed calls, cache hits and pre-flight refusals, each
incremented at the point the call is made or avoided.

It deliberately does not call the account-usage endpoint. That endpoint is
billed like any other data call, and an app that spends a credit to tell you
how many credits you have spent is not solving the problem it was asked to.

## 27. Free sources answer the question the list gets wrong

"Why can't we find this information? He's from Knoxville, TN."

Two failures hid inside that report, and only one of them was about data.

**The lookup searched the wrong place with the right guard.** The lead row
carries the employer's address — nearly every sourced list does — so the
WhitePages search ran against the company's city, found the real person at
home in Tennessee, and §14's namesake guard did exactly what it was built to
do: refused to attach a record from a state the lead's row doesn't match.
Right guard, wrong input. And the user, who knew the correct city, had
nowhere in the app to say so.

So the second half of the fix is the small one: a failed home lookup now
offers **"Know where they live? Search there"**, and a record found that way
carries the basis `you supplied it` forever — a location typed by a person is
a weaker provenance than one observed in data, and §17 says the difference
must stay visible.

### The two free sources worth having

Every free source that knows a lot about a person forbids scraping in its
terms, and harvest.py already refuses them. What remains is what the law
requires to be published, with real APIs:

- **FEC individual contributions.** Itemised above $200: name, **home** city
  and ZIP, employer and occupation — self-reported, per gift, dated. As a
  timeline it is the exact field the list gets wrong (where they live), an
  employer confirmation with a date on it, and occasionally the single word
  "retired", which for this app is the event itself.
- **SEC insider filings (Forms 3/4/5).** A person who appears there holds
  equity compensation. Free, keyless, rides the same rate-limited EDGAR
  client the app already has.

County records (assessor, deeds) were considered and deliberately left as
links rather than integrations: three thousand counties, no common API, and
§23 already establishes that "legally accessible" is a property of the
publisher's terms, checked per fetch — a per-county scraping farm fails that
test before it fails any technical one.

### The FEC restriction, stated rather than discovered

Federal law (52 U.S.C. §30111(a)(4)) forbids the **sale or use** of FEC
contributor information for commercial purposes or to solicit contributions.
A prospecting app is commercial. That sits in tension with using donations to
decide whom to call, and the tension is not resolvable by this repository —
so it is stated in the panel itself, in the setup doc, and here, rather than
left for someone to find. The defensible use is corroboration: confirming
that a person already sourced elsewhere lives where the user thinks, held the
job the list claims, on the dates it claims. The insider-filing half carries
no such restriction.

The pattern this repeats: §23 refused to fetch pages whose publishers forbid
it, even though fetching would work. Here the fetch is explicitly public and
the *use* is what the law constrains. Same rule, one layer up.

### Blind parsers, sixth time armed

Neither parser had a live response to be written against — the build
environment's proxy blocks both hosts, though production reaches EDGAR every
day. Five entries in this document (§12, §18, §24, §25) exist because that
condition breeds silent failure. The defences are now standard: every reader
takes both documented key spellings, absence is a value everywhere, a
namesake filter mirrors `_best_person`'s surname rule, and `/api/free-debug`
returns the same field census `/api/wp-debug` does — one call from
production settles what documentation cannot.

### §27 addendum: the census came back, and the parser held

Dan ran `/api/free-debug?source=fec` against production the same day §27
shipped. First time in this repository's history that a parser written blind
met its live response and was simply right: every field it read is where it
looked, and the plain-date spelling it guessed at is the one served.

The census also showed three fields worth reading that the documentation
hunt had not surfaced, now captured: `contributor_street_1` (shown as
identity confirmation, labelled "not for mailing" — §27's use restriction
does not loosen for a more precise field), `contributor_aggregate_ytd`, and
`sub_id`, which matters because `amendment_indicator = A` rows re-report the
same transaction — a gift counted twice would overstate a dollar figure, the
one mistake this panel must never make. `entity_type`/`is_individual` now
exclude committees and companies from what is presented as a person's
giving; a record silent about its type is kept, as always.

The lesson §12 has been building toward, stated once: the census endpoint is
what turned five past schema surprises from shipped bugs into this — a
same-day diff between what was guessed and what is true, applied while the
guess was still warm.

## 28. The employer calendar, learned from a competitor's authorize URL

Dan shared an analysis of Magic List's page source. The load-bearing line was
its Microsoft authorize URL: multi-tenant `/common`, and a scope list with
**no Mail.Send** — `offline_access openid Calendars.Read[.Shared]
Calendars.ReadWrite[.Shared] User.Read`. And the connected-account card
showed `daniel.treacy@equitable.com`, working.

That is an empirical answer to a question this app could not answer from
documentation: **does Equitable's tenant permit user-level consent for a
third-party app?** Yes — for that scope set. The narrowness is not a
limitation, it is the mechanism: Mail.Send is the scope corporate tenants
refuse, and invites never needed it, because an event created with attendees
is dispatched by Exchange itself, from the mailbox, through the firm's
transport — journaled like any outbound mail. That also closes this
document's open question about compliance capture of Graph-initiated mail.

So `/auth/login?mode=calendar` requests `User.Read` + `Calendars.ReadWrite`
and nothing else, the session records the mode, and the app is honest about
the asymmetry it creates: the sender list marks the account "invites only",
the email dialog does not offer it, and a mail attempt through the API is
refused naming the Gmail-alias route that covers the email half. §20 already
put the two halves on different rails — Gmail aliases for From, calendars
for invites — and this entry is that split reaching its natural conclusion:
each rail asks its provider for exactly what that rail needs.

Two things deliberately not copied from the example: `.Shared` scopes
(adding an attendee needs only ReadWrite; a narrower footprint consents more
easily and reads better in a tenant review), and the absence of a `state`
parameter in its authorize URL (MSAL supplies state and PKCE here; the CSRF
hole is theirs to keep).

## 29. The account is the identity; providers are attachments

"This app needs to be accessible and usable by ANYone, not just me and
financialplannersofamerica."

Until now, signing in WAS a Google or Microsoft grant — identity and sending
capability arrived welded together. §28 loosened the weld on the sending
side (an employer calendar as a second attachment); this entry cuts it: an
account is an email and a password, any email, and Google/Microsoft are
things an account links, not things it is.

The one decision with teeth is the identity key. `_signed_in_email` is what
lead lists are stored under, and for a password account it returns the
account email **even after a Google address is linked** — linking a sender
that silently re-keyed someone's leads would be indistinguishable from the
app deleting them. The test asserts exactly that sequence: create list, link
Google, list still there.

Everything downstream follows from the split being honest:

- OAuth callbacks no longer overwrite `provider` on a password session —
  linking is attachment, not conversion.
- `_active_token` treats a password session as signed in, handing back a
  linked provider token when one exists and a bare identity when not; the
  few callers that truly need a provider token already say so in their own
  words ("link a Google or Microsoft account", named in the refusal).
- Sign-in failures use one message for both wrong-password and no-account —
  which half was wrong is precisely what an enumerating attacker asks.
- scrypt from the standard library; no new dependency for the first
  password this codebase has ever stored.

Stated gaps, not papered over: no verification mail and no password reset,
both because the server owns no mailbox to send from. The risk unverified
accounts carry is impersonation in shares, so it must close before strangers
share lists. And the Google OAuth app must go External + published for
"anyone" to include Google-linking — §SETUP-accounts has the trade against
the Internal advice that fixed the consent nag for a firm-internal app.
