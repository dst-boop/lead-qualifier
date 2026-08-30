# LEARNINGS

Constraints discovered the hard way. Format: date · what was discovered · why it
matters · the rule it suggests. Newest first. When one of these earns a place in
CLAUDE.md, propose the amendment there — this file keeps the evidence.
Fuller narratives live in docs/ADR.md; the section numbers below point there.

## 2026-08 · gcloud shreds JSON env vars on commas

Setting `WARN_FEEDS` with `gcloud run services update --set-env-vars` (or
`--update-env-vars`) split the JSON value at every comma, storing a fragment
that failed to parse — and the app read "invalid JSON" as "unset" until a
diagnostic distinguished them. **Rule:** any JSON-valued env var set via gcloud
uses the delimiter prefix: `--update-env-vars '^|^KEY=[{...}]'`. And a config
error must report itself as an error, never blend into "not configured".
(ADR §37, §39)

## 2026-08 · A Trestle phone check returns the whole person record

The Phone Intel response carries date of birth, aliases, every line and email —
the app billed a second Find Person call for data it had already paid for and
thrown away. **Rule:** read every field of every paid response (`applyRecord`),
and sequence overlapping paid calls cheapest-first with the second running only
on a miss — never make the operator choose the order. (ADR §33, §39)

## 2026-08 · Trestle Find Person can bill 1–2 credits

Asking for property ownership in the same call adds a second billed lookup.
**Rule:** `want_property` defaults off; the deed is its own deliberate button,
and cost labels say "1-2 lookups" only when that is true.

## 2026-08 · Trestle rejects malformed phones without billing

An obviously invalid number (e.g. "555") is refused by the API, unbilled.
**Rule:** validate before sending and tell the operator sooner — a rejected
query is free either way, so the app should fail it client-side with the reason.

## 2026-08 · Identical concurrent lookups double-bill

Two clicks (or a sweep racing a click) on the same lead fired two identical
Trestle calls; both missed the cache, both were billed. **Rule:** single-flight
every paid lookup key (`_WP_INFLIGHT`): the second caller awaits the first
answer; a failure re-raises to waiters and is never cached as an answer.
(ADR §38)

## 2026-08 · ZoomInfo entitlement rejects yearsOfExperience — after the spend

Adding `yearsOfExperience` to enrich outputFields looked like a one-line win;
the account's entitlement check rejected it and failed the whole enrich
mid-batch, after credits were consumed. **Rule:** never add an outputField
without confirming it against the account tier; keep the field list as config
and a test guard on the enrich call. (ADR §18)

## 2026-08 · SEC EDGAR: proxy statements are a free age source — with namesakes

DEF 14A filings print ages for officers and directors, free and repeatable.
But surname matching alone attaches a namesake's age. **Rule:** require
surname + first-name evidence (`roster_match`); an ambiguous match is a
refusal, not a guess. Send a declared User-Agent; cache per employer (7 days).
(ADR §34)

## 2026-08 · FEC data is legally restricted

52 U.S.C. §30111(a)(4) forbids commercial use or solicitation from FEC
contributor data. **Rule:** corroboration only — identity, address, employment
dates — and the notice stays visible wherever donation data is shown. The
donation city is where they told a federal form they live, which usually beats
the list's employer address.

## 2026-08 · Dependency injection doesn't fire on direct calls

Converting routes to the `signed_in` FastAPI dependency silently broke every
internal site where one route called another as a plain function — the callee
received the DI sentinel instead of an email. **Rule:** internal calls pass
`email` explicitly; the test suite pins the four known call sites. (ADR §36)

## 2026-08 · A progress counter must count one unit

The free sweep summed leads-needing-public-records with employers-needing-proxy
reads into one denominator ("8/926" on a 400-lead list). **Rule:** label the
phase and count only that phase's unit. (ADR §39)

## 2026-08 · Pre-stamp sessions leaked the firm budget

Sessions created before identity stamping had an empty identity, and the
per-user allowance check handed them the whole firm pool. **Rule:** every
spender resolves to a named identity or the shared "unattributed" bucket —
never to the firm ceiling; spend is counted server-side only, client
self-reports refused. (ADR §35–36)
