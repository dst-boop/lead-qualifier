# Age 59½ Lead Pipeline

Headless nightly pipeline: SOURCE (GTM CLI, free) → QUALIFY (5-signal rubric + hard gates) → NURTURE (under-59.5 tracked with maturity dates, auto-promoted) → DELIVER (ranked CSV + JSON + manifest). Runs on Railway cron — no Claude session, no browser, no work-computer involvement.

## Run modes

```bash
node pipeline.js                                    # nightly: search + score, ZERO credits
ENRICH_APPROVED=true ENRICH_LIMIT=50 node pipeline.js   # manual: enrich Tier-A only, capped
DRY_RUN=true node pipeline.js                       # fixtures, no GTM CLI needed
```

The credit gate is structural: enrichment code path is unreachable without `ENRICH_APPROVED=true`, and only targets Tier-A records lacking CONFIRMED age, capped at `max_enrich_per_run_when_approved` (config).

## Routing rules

| Route | Condition |
|---|---|
| SELL | age ≥ 59.5, all gates pass |
| NURTURE | 55 ≤ age < 59.5 — tracked in `data/nurture.json`, promoted to SELL 90 days before maturity (`maturity_date = DOB + 59.5y`, or estimated from inferred age) |
| HOLD_UNKNOWN_AGE | passes gates but `age_basis = UNKNOWN` — enrichment/LinkedIn-verify candidates |
| DISQUALIFIED | any hard-gate failure (location, seniority, age floor <55, assets <$250k) |

Hard gates: US person-location · senior title (current or prior) · age ≥ 55 or retired · inferred assets ≥ $250k · DNC scrub.

## Railway deployment

1. New Railway service from this repo; add a **volume** mounted at `/app/data` (nurture store must persist across runs).
2. Install GTM CLI in the build (add to `package.json` postinstall or Dockerfile once install command is confirmed from gtm.ai docs).
3. Auth: **service account** credentials as Railway env vars (user sign-in OAuth won't survive unattended cron). Per ZoomInfo docs, register the app in Developer Portal / API-MCP tab.
4. Cron schedule: `0 6 * * *` (6am UTC nightly).
5. Outputs land in `out/` — wire a final step to POST `*_sell.json` into the lead-qualifier server's import endpoint, or push to a bucket.

## Before any lead is sellable

- **DNC**: `src/deliver.js → dncScrub()` is a stub. Every row ships `dnc_status: UNSCRUBBED` and the manifest flags it. Wire a DNC vendor (federal + NY) before delivery. FINRA 3230 / TCPA apply.
- **Whitepages Pro** (Stage 2): plug into the enrich path for CONFIRMED age + household data. Non-FCRA — non-credit decisioning only.
- Data-status discipline: every age and asset figure carries CONFIRMED / INFERRED / UNKNOWN.

## Open v3 decisions (config-gated, non-blocking)

`config/icp.json → routing` holds three nulls: `sell_nurture_before_maturity`, `delivery_exclusivity`, `bad_data_replacement_guarantee`. The manifest reports them as undecided; set them when resolved and the delivery module picks them up.
