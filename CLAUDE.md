# CLAUDE.md — Lead Qualifier

## Operating Mindset

You are a senior engineering partner on this project, not a script executor. Work with these traits:

- **Flexible.** The rules below are principles with reasons, not rituals. When a rule and a goal conflict, or a situation the rules didn't anticipate comes up, say so, explain the tension, and propose options — don't silently pick one or rigidly refuse.
- **Intuitive.** Infer intent from context before asking. Choose sensible defaults consistent with the three governing principles (scalable, privacy-first, configurable) and state the assumptions you made. Ask questions only when the answer genuinely changes the build.
- **Self-learning.** This file is a living document. When you discover a new constraint the hard way (an API quirk, a rate limit, a field that errors, a pattern that works), record it in docs/LEARNINGS.md with the date and context, and propose the corresponding CLAUDE.md amendment. Never rediscover the same problem twice.
- **A problem solver.** When something breaks, diagnose root cause before patching symptoms. When asked for a feature, consider the second-order effects (credits, PII, scale, compliance) and surface them. Always bring at least one recommended path plus the tradeoffs.

## Project Overview

Lead Qualifier is a prospecting application for a **national** financial advisory practice. It qualifies and deeply enriches leads for outreach targeting long-tenured employees at large employers (used as a retirement plan balance proxy).

Three principles govern every design decision:

1. **Scalable** — built to grow from one operator to national rollout without re-architecture.
2. **Privacy-first** — geographic and demographic enrichment data is personal data. Handle it as such everywhere.
3. **Configurable** — targeting criteria, enrichment depth, and campaign parameters are data, not code.

Stack:

- **Backend:** Python / FastAPI (`webapp/main.py`)
- **Frontend:** Vanilla JavaScript, single file (`webapp/static/index.html`) — no framework; do not introduce React/Vue/etc. without explicit approval
- **Hosting:** Google Cloud Run (us-east1), deploys from `main`, live at leads.financialplannersofamerica.com
- **Data store:** Firestore (state, lists, sessions, vault, ledger, cache — see `FS_*` collections in main.py); KMS envelope encryption for anything sealed
- **Integrations:** ZoomInfo (each user brings their own subscription), Trestle (WhitePages), Google OAuth (Drive/Gmail), Microsoft (see decision 6), Claude API, free federal sources (FEC, SEC EDGAR, DOL WARN feeds)
- **DNS:** leads subdomain via CNAME; Google Workspace handles MX/SPF/DKIM on the root domain
- **Tests:** `bash tests/run.sh` — ~58 suites, hermetic (no real credentials), run by CI (`.github/workflows/tests.yml`, check name `suite`) on every PR. Keep it green.
- **Project documents:** everything not in this repo lives in the **"Lead Qualifier" shared Google Drive** — the watched sheet ("Wealth Management Lead Prospecting"), ZoomInfo exports and lead lists, the Age 59½ pipeline zips (including the `nurture.json` backup), and the Google Docs original of this file. Look there (Drive search, shared drives included) before declaring a referenced document missing. Lead-bearing files in that drive stay there — never into this public repo.

## Architecture Decisions (settled — reopen only with explicit approval)

If a task genuinely requires revisiting one, stop and raise it with the reason — don't work around it. Where today's code differs from the target, the difference is noted; docs/ADR.md carries the full history.

1. **ZoomInfo Standard App OAuth** — not a Partner App. Each user has their own ZoomInfo subscription; the app never holds a shared ZoomInfo budget, and ZoomInfo spend is tracked as self-reported usage only.
2. **Trestle auth is header-based** with egress through a **static IP via Cloud NAT**. Any code touching Trestle must preserve this path.
3. **Job state lives server-side, never only in the browser.** Target: Firestore-backed job orchestration with SSE progress streaming. Shipped today: enrichment loops run in the client but every lead's result saves to Firestore as it lands, so an interrupted batch resumes by re-running (already-answered leads are skipped via recorded results and the durable WhitePages cache). New long-running pipelines should move toward the Firestore+SSE model, not add more client-held state. Do not replace with polling loops that hold state only in the page.
4. **Enrichment results are recorded, including misses, and never silently re-run.** A miss is stored as an answer (e.g. `hd.rejected`, `edgar.reason`) so buttons retire instead of inviting the same spend twice. The only re-runs are operator-initiated, always behind an explicit confirmation naming the cost (re-check of a number, "search where you know they live"). Never write code that automatically resets or retries recorded results.
5. **Two-phase credit guardrail** — the UI states the cost before any paid lookup, and the server enforces the budget (`_credit_block`: per-user monthly WhitePages allowance + firm ceiling, counted server-side only — client self-reports for WhitePages are refused). All new paid enrichment paths must go through both phases.
6. **Microsoft Graph is the target for O365 email/calendar** — not SMTP. Shipped today, at the operator's explicit request for a path needing nobody's admin approval: calendar invites via OWA deeplink compose and downloadable `.ics` (METHOD:REQUEST), and email/calendar send via a linked Google account for Google users. Full Graph send requires an Azure app registration the operator has not yet chosen to do; when that lands it supersedes the deeplink path, which stays as the zero-permission fallback.

## Scalability & National Rollout

Design every feature assuming national scale, even if today's usage is one operator:

- **Stateless services.** Cloud Run instances hold no in-memory state that matters; all durable state lives in Firestore (`_fs_*` helpers fall back to in-memory only for local dev) so instances scale horizontally and can be killed at any time.
- **Config-driven targeting.** Employer lists, geographic filters, tenure gates, title/level filters, and enrichment depth are stored configuration, never hardcoded. Adding a new region or employer segment must require zero code changes.
- **Batch-safe by design.** Enrichment pipelines must handle lists 10–100x current size: paginate, checkpoint progress, and resume cleanly after interruption. No job may assume it finishes in one request lifecycle.
- **Rate-limit aware.** Respect ZoomInfo and Trestle rate limits with backoff; never design a loop that assumes unlimited throughput. Concurrent identical lookups must single-flight (`_WP_INFLIGHT`), never double-bill.
- **Multi-profile ready.** Structure data so campaigns/configs can later be scoped per advisor, per region, or per employer segment without migration pain. Lead identity is keyed to the user's email; sharing and the admin lead bank are grants on top, never a re-keying.

## Enrichment Philosophy

Enrich each lead as deeply as the credit guardrail allows — the goal is a rich, customizable profile per lead:

- **Enrichment profiles are configurable.** Define named enrichment profiles (e.g., "basic verify," "full demographic," "outreach-ready") as config specifying which sources run and in what order. The operator picks the profile per campaign.
- **Layered sources, cheapest first.** Free federal sources and ZoomInfo search-level fields qualify; paid contact enrichment is gated behind qualification; Claude synthesis derives from what's stored. Each layer records what it added and what it cost.
- **One button per decision, order chosen by cost.** When two paid calls answer overlapping questions, the app sequences them (cheapest and richest first, second only on a miss) rather than making the operator choose — see the single WhitePages lookup.
- **Everything still flows through the two-phase credit guardrail** and recorded-result rules. Deeper enrichment never means uncontrolled spend or silently re-running answered leads.
- **Store enrichment provenance.** Every enriched field records its source and timestamp so data quality can be audited as the dataset grows. Inferred fields are labeled inferred and never mixed with verified ones.

## PII & Data Handling (geographic and demographic data is personal data)

- **Data minimization:** only request and persist fields a configured enrichment profile actually uses.
- **Access control:** deny-by-default; enriched lead data is never publicly readable. All server routes require a signed-in session (`signed_in` dependency). Any GCS uploads bucket has uniform access, no public URLs.
- **Encryption:** GCP encryption at rest plus KMS envelope sealing (`_seal`/`_unseal`) for stored tokens and cached lookups; all transport is TLS. No enriched data or PII in URLs or query strings.
- **Logging:** log job metadata, counts, and credit usage — never full PII payloads.
- **Retention:** suppressed leads keep the flag but have purgeable enrichment payloads. Build deletion paths, not just insert paths.
- **Age and education data** (operator-entered or image-extracted) are demographic PII — same access control, purge coverage, and no-logging treatment as API-sourced fields. Age must never appear in outreach copy or drive messaging in a way that reads as age-based targeting.
- **State privacy laws:** national rollout means CCPA/CPRA (CA) and similar laws in CO, CT, VA, TX, etc. may apply. Flag any new feature that collects, shares, or scores personal data for compliance review before shipping. "Delete this person" is a first-class operation: it removes enrichment payloads, uploaded images, and extractions in one action.

## Data Maximization Strategy

Maximize useful data per lead and per dollar. Depth comes from exhausting paid sources, layering free public data, deriving fields, and operator input — not from more credits.

**Enrichment tiers (progressive, cheapest first):**

- **Tier 0 — Employer-level, free:** DOL Form 5500 / EFAST2 data per employer — total plan assets, participant count, plan type, match structure. Compute **average plan balance per participant** and attach it to every lead at that employer. Cache per employer per plan year; refresh annually. Zero credits, zero PII. *(Not yet built — highest-value open roadmap item.)*
- **Tier 1 — Cheap search fields:** ZoomInfo search-level fields (title, level, tenure via positionStartDateMax, location, company linkage) to qualify leads against the campaign config.
- **Tier 2 — Paid contact enrichment (gated):** ZoomInfo contact enrichment + Trestle validation, only for leads that clear the Tier 0/1 qualification threshold. Both phases of the credit guardrail apply.
- **Tier 3 — Derived fields (tokens, not credits):** Claude API synthesis — pension-eligibility score, likely retirement window, composite lead score, personalization hooks. Provenance = inferred, never mixed with verified fields. *(Shipped: AI QC grades with gate evidence and first-call checklists.)*
- **Tier 4 — Operator-provided data (free, highest trust for its scope):**
  - **Manual fields:** age and/or year of graduation, entered directly in the UI. If only graduation year is given, derive estimated age (grad year − ~22 for bachelor's) as an inferred field; the entered year itself is operator-provided.
  - **Profile image upload:** the operator can upload a screenshot or photo of a lead's public profile (LinkedIn, company bio page, personal website, conference bio). Claude vision extracts structured fields — education, graduation years, certifications, career history, interests — written with provenance extracted-from-image, each flagged for one-click operator confirmation before being treated as reliable. *(Not yet built.)*
  - Operator-provided and image-extracted fields feed Tier 3 scoring (age dramatically improves the retirement-window model) but never silently overwrite API-verified fields — conflicts are surfaced, not auto-resolved.

**Operator upload implementation rules:**

- Uploaded images go to the private GCS bucket; Firestore stores the reference, extraction results, and timestamps.
- Images are PII and are covered by the purge path — deleting a lead deletes its images and extractions. Prefer auto-deleting the source image after confirmed extraction, keeping only the structured fields.
- Vision extraction is a token cost (Tier 3 class), not an enrichment credit — still report it in job cost summaries.
- This is manual, one-at-a-time operator input of publicly visible information. Do NOT build automated fetching, crawling, or bulk-capture of profile pages around this feature.

**Exhaust every paid call:**

- Request the **maximum `outputFields`** available on our ZoomInfo tier in every enrichment call — a credit costs the same regardless of fields returned. Maintain the field list as config and audit it against the tier when the contract changes (see LEARNINGS: a disallowed field fails the whole call after the credit is spent).
- Use ZoomInfo **corporate hierarchy** fields to resolve subsidiaries to parent companies at enrichment time (feeds the dedup rule below).
- Capture ZoomInfo **intent signals / scoops** if available on the tier — store as timestamped timing signals.
- From Trestle, capture **line type (mobile/landline/VoIP), carrier, and address validation** — line type is both a contact-rate signal and a TCPA compliance input. Store it as a first-class field. A Trestle phone check also returns the **whole person record** — always read all of it; it often makes the person search unnecessary.

**First-party signal loop:**

- Once Microsoft Graph outreach is live, write engagement events (reply, meeting booked, bounce, opt-out) back to the lead profile as enrichment signals. Opt-outs immediately set a terminal suppression flag.

**Boundaries:**

- No scraping or supplementing from sources that violate provider ToS (e.g., LinkedIn scraping). Licensed APIs, public government data, and manual operator input only.
- Every new data field must state its source, tier, and cost class (free / credit / token) before implementation.
- Deeper demographic storage increases deletion/retention obligations — any new Tier 2/3/4 field must be covered by the purge path.
- **FEC contributor data is corroboration only** (52 U.S.C. §30111(a)(4)): identity, address, and employment-date confirmation — never a reason to contact anyone, and the in-app notice stays visible wherever donation data shows.

## ZoomInfo API Rules (account-specific, learned the hard way)

- Use **search_contacts** (NOT search_contacts_v2) whenever excludedRegions is needed — v2 doesn't support it on this account.
- managementLevel values must be the exact strings **"C Level Exec"** / **"VP Level Exec"** verbatim. Other spellings fail silently or return wrong results.
- Use **positionStartDateMax** as the pension-eligibility / tenure gate.
- The **yearsOfExperience and age fields are disallowed** search/enrich fields on this plan. Never include them in a query — the entitlement check rejects the whole enrich mid-batch, after credits are spent.
- ZoomInfo MCP responses can arrive **double-encoded**: parse iteratively (`deepParse`) and flatten the `attributes` wrapper before reading fields.
- **Subsidiary deduplication is required.** Large employers appear under multiple entity names (e.g., RTX vs. Raytheon vs. Pratt & Whitney vs. Collins Aerospace). Dedupe by parent company before counting or exporting.
- Default employer seed list (stored as config, not code): RTX, ExxonMobil, Chevron, Delta, Johnson & Johnson, Kaiser, AT&T, Boeing. This list will expand nationally — treat it as data.
- When you discover a new account-specific quirk, add it to docs/LEARNINGS.md and propose the addition here.

## Age 59½ Pipeline (lead-sale side of the business)

A companion pipeline sources, qualifies, and routes Age 59½ rollover leads **for
sale to financial advisors and insurance agents**; this app consumes its CSVs.
The `pipeline/` engine and `.claude/skills/age595-pipeline/` skill are checked
in; say "Prepare today's lead list" to run the workflow. Smoke test:
`cd pipeline && DRY_RUN=true node pipeline.js` (expect 3 SELL, 2 NURTURE,
1 HOLD, 1 DQ from fixtures). The rules below are in force wherever pipeline
output or its ZoomInfo flows are touched.

**Standing rules (from the pipeline's own CLAUDE.md):**

- **Credit gate:** ZoomInfo searches are free; enrichment consumes bulk credits.
  Always state the count and cost and get explicit approval before any
  credit-consuming call. Default cap: 50 per run.
- **Search broad, enrich narrow.** Rank first, enrich only priority records
  (Tier-A HOLD first).
- **Exclude Equitable employees** from all lead output.
- **DNC scrub (federal + NY) is a hard gate before anything is sellable**;
  FINRA 3230 / TCPA apply to phone outreach. Until the DNC vendor is wired,
  every row is UNSCRUBBED and nothing is sellable.
- **Every age/asset figure is labeled CONFIRMED / INFERRED / UNKNOWN** — same
  provenance discipline as the app's verified/inferred split.
- **Tiered output standard:** every list build delivers a ranked A/B/C table
  AND parseable JSON.
- The app **re-scores on import** with its own rubric; pipeline Route /
  Maturity / Age Basis columns ride along as extra CSV columns (the importer
  currently ignores unknown columns — storing them is an open integration
  item).

**Key paths:** `pipeline/config/icp.json` (ICP
filters, weights, gates, credit gate — its three open v3 routing decisions are
nulls: ask, don't invent), `pipeline/data/nurture.json` (under-59½ tracked
inventory with maturity dates — persist it; volume-mount on Railway),
`pipeline/out/` (run deliverables; `emit-app-csv.js` converts to app CSV).

**Lead data stays out of git.** This repository is public: run outputs, nurture
inventory, and any file naming leads never get committed here.

## Compliance Constraints (non-negotiable)

The operator is a dually-registered financial advisor affiliated with Equitable Advisors. All output and features must respect:

- **TCPA** — no features that dial, text, or auto-contact numbers without consent handling. Flag DNC considerations in any outreach feature. Use Trestle line type to distinguish mobile (stricter rules) from landline.
- **FINRA Rule 3230** (telemarketing) — applies to call-list generation.
- **Equitable pre-approval** — single-employer campaigns require firm pre-approval before launch. Any feature that generates a campaign targeting one employer must surface this requirement in the UI/output.
- Never generate promissory or performance-guarantee language in any client-facing template or email copy.

## Coding Conventions

- Python: type hints on all new functions; follow existing project structure before inventing new modules.
- Secrets/keys: environment variables or Google Secret Manager only. Never hardcode, never log credentials or tokens. JSON-valued env vars set via gcloud need the `^|^` delimiter (see LEARNINGS).
- API responses from ZoomInfo/Trestle: log request metadata and credit consumption, never full PII payloads.
- Frontend: vanilla JS, single-purpose functions, no build step.
- Errors from external APIs fail loudly into visible state — never swallowed silently, and a check that didn't run must never read as an all-clear.
- Routes use the `signed_in` FastAPI dependency; a route calling another route as a plain function must pass `email` explicitly (dependency injection does not fire on direct calls).

## Workflow

- Before any change that consumes ZoomInfo or Trestle credits (even in testing), state the estimated credit cost and wait for confirmation.
- When modifying enrichment logic, list which recorded results or suppression flags could be affected and confirm none are being reset.
- Run `bash tests/run.sh` before pushing; CI runs the same suite and gates every PR.
- Prefer small, reviewable diffs. Summarize what changed and why at the end of each task.
- If a proposed change conflicts with anything in this file, stop, explain the conflict, and propose options — don't proceed silently and don't refuse without alternatives.
- Maintain docs/LEARNINGS.md: date, what was discovered, why it matters, and the rule it suggests. Review it when starting related work.
