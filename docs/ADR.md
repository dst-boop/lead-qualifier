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
| 1 | Does the ZoomInfo seat carry API entitlement? | Register a Standard App | Phase 1 |
| 2 | Does Equitable journaling capture Graph-sent mail? | Equitable compliance | Phase 2 scope |
| 3 | Is the M365 tenant Equitable-managed? | Equitable IT | Phase 2 |
| 4 | What replaces the TCPA litigator flag? | Vendor research | §8.3 |
| 5 | Buy property valuation data, or live without it? | Business decision | §4.3, §9 |

**Resolved since v2.0:** ~~Trestle configuration~~ (wrong vendor entirely) ·
~~IP allowlist~~ (none) · ~~home value source~~ (does not exist here) ·
~~session persistence~~ (Firestore, shipped) · ~~custom domain and TLS~~
(shipped).

**Standing risks:** vendor pricing changes, so re-check the estimator's
constants periodically. ZoomInfo contact data decays and is demonstrably wrong
for some mobiles today. Do not design around SNAP; it is closed.
