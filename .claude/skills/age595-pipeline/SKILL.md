---
name: age595-pipeline
description: Source, qualify, and route Age 59½ rollover leads end-to-end. Use when the user says "prepare today's lead list", "run the 59.5 pipeline", "build rollover leads", "source leads", "check the nurture queue", or asks to generate sellable leads for the lead-gen business. Searches ZoomInfo (free), scores through the five-signal rubric, routes SELL / NURTURE / HOLD, tracks under-59.5 leads to maturity, and emits CSVs that auto-map into the Lead Qualifier app import.
---

# Age 59½ Lead Pipeline

Generates qualified rollover leads: senior execs (55–65 or retired) who changed jobs 12–48 months ago — the orphaned-401(k) window — with inferred rollover assets ≥ $250K. Leads under 59.5 are NURTURE-tracked with maturity dates and auto-promoted.

## Non-negotiable rules

1. **Credit gate.** Searches are free and unlimited. `enrich_contacts`, `account_research`, `contact_research` consume bulk credits. NEVER call a credit-consuming tool without telling the user the record count and getting explicit approval in this conversation. Cap any approved batch at `config/icp.json → credit_gate.max_enrich_per_run_when_approved`.
2. **Enum precision.** `managementLevelList` must be exactly `"C Level Exec"` / `"VP Level Exec"`. Wrong strings silently return garbage.
3. **Exclusions.** Never include Equitable employees (companyName contains "equitable").
4. **Disallowed fields.** `yearsOfExperience` and age are not searchable on this plan — do not pass them; the search will 400. Age comes only from enrichment (grad year, job history) or manual LinkedIn verify.
5. **DNC.** No lead is sellable until DNC-scrubbed (federal + NY). Output marks everything UNSCRUBBED until the vendor is wired in `pipeline/src/deliver.js → dncScrub()`.
6. **Data status.** Every age and asset figure carries CONFIRMED / INFERRED / UNKNOWN. Never present inferred data as confirmed.

## Workflow: "Prepare today's lead list"

**Step 1 — Source (free).** Use ZoomInfo MCP `search_contacts` per slice:
- `managementLevelList`: one of `["C Level Exec"]` or `["VP Level Exec"]`
- `positionStartDateMin` = today − 48 months, `positionStartDateMax` = today − 12 months
- `employeeRangeMinimum`: 250, `requiredFieldsList`: ["phone"], `pageSize`: 100, `sort`: "-contactAccuracyScore"
- Geography: `country` "United States" for national; `zipCode` + `zipCodeRadiusMiles` for territory slices (note: radius applies to company address on this MCP — person-location confirmed at enrichment)
- Responses may be double-encoded (`deepParse` iteratively) and nest contacts under `attributes` (flatten first)

**Step 2 — Dump + score (free).** Write results as pipe-delimited lines `id|first|last|title|company|hasDirectPhone|hasMobilePhone` to `pipeline/runs/<runId>_raw.txt`, then:
```bash
cd pipeline && node score-live.js runs/<runId>_raw.txt <runId>
```
Outputs land in `pipeline/out/`: `_sell`, `_nurture`, `_hold_unknown_age`, `_disqualified` (CSV + JSON) plus `_manifest.json`.

**Step 3 — Credit gate decision.** Report the funnel (counts, tiers, phone quality). If the user approves enrichment: enrich Tier-A HOLD records first (batches of 10 via `enrich_contacts`), merge grad year / job history / DOB into the records, re-run scoring. Enriched records route SELL (≥59.5), NURTURE (55–59.5, `maturity_date` computed), or DQ (<55).

**Step 4 — Nurture.** `node pipeline.js` handles `track()` + `promoteMatured()` automatically; the nurture store is `pipeline/data/nurture.json` (persist this file — it is the business's future inventory). Report the maturity pipeline by quarter.

**Step 5 — Deliver to the app.**
```bash
node emit-app-csv.js out/<runId>_sell.json out/<runId>_sell_app.csv
```
Headers auto-map in the Lead Qualifier app's CSV import (ZoomInfo Contact ID, Job Start Date, Graduation Year, Person State, etc.). The app re-scores on import with its own R/T/M/S/A/C/H rubric. Hand the user the file path(s).

## Workflow: "Check the nurture queue"
Run `node -e "console.log(require('./pipeline/src/nurture.js').pipelineByQuarter())"` and report leads maturing per quarter, plus any promoted this run.

## Open config decisions (do not invent answers)
`config/icp.json → routing` has three nulls pending Dan's v3 decisions: `sell_nurture_before_maturity`, `delivery_exclusivity`, `bad_data_replacement_guarantee`. If output depends on one, ask.
