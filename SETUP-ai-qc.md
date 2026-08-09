# AI quality control (Claude)

Adds an **AI quality control** button to the toolbar. It sends the leads in
your list to Claude, which grades each one against the firm's qualification
rule and returns:

- an **A / B / C / X grade** (shown as an `AI·A` chip next to the tier score)
- **gate evidence** — which of the five qualification paths hold, and why
- a **first-call verification checklist** — the specific facts a junior
  advisor must confirm on the call before the lead counts as qualified

The grade, gates and checklist all flow into the CSV export, so they land in
the CRM with the lead.

## The rule Claude grades against

Base requirement: **age 25–75** (estimated from graduation year + 22, or
career length when grad year is missing). Then at least one gate must hold:

| Gate | Meaning |
|---|---|
| `NW` | Net worth over $2,000,000 |
| `YHE` | Young high earner — under 45 with income over $250,000 |
| `401K` | Orphaned 401(k) over $250,000 (job change in the last 1–5 years after a long prior tenure) |
| `WL` | Under 70 and holds whole life insurance (never inferred — only if the record says so) |
| `INT` | Actively seeking financial help with over $250,000 investable |

Each gate comes back as **CONFIRMED** (the record says so), **INFERRED**
(strong proxy: seniority, tenure, company size), **UNKNOWN** (no signal), or
**FAIL** (evidence contradicts it).

Grading: **A** = age passes and either two-plus gates at inferred-or-better or
one confirmed gate, and not a job hopper. **B** = age passes with exactly one
inferred gate. **C** = age passes but everything is unknown, or a job hopper
with otherwise decent signals. **X** = age fails.

## Setup

1. Get an API key at [console.anthropic.com](https://console.anthropic.com) →
   **API Keys**. Put a small amount of credit on the account.
2. Cloud Run → your service → **Edit & deploy new revision → Variables & Secrets**:

| Variable | Value |
|---|---|
| `ANTHROPIC_API_KEY` | your key (starts with `sk-ant-`) |
| `CLAUDE_MODEL` | *(optional)* defaults to `claude-opus-5` |

3. Deploy. The **AI quality control** button appears once you sign in.

## Notes

- **Each pass costs money.** Leads go up in batches of 10, and the endpoint
  requires sign-in so visitors to the URL can't spend your credits.
- Re-running QC on the same list re-grades it — grades are not cached between
  passes, so run it once after an import rather than on every page load.
- Claude only sees the fields the grader needs (name, title, level, company,
  state, grad year, job start date, employee count, your notes) — not phone
  numbers or email addresses.
- The output is an underwriting *opinion* built from professional-profile
  proxies, not verified financial data. That's exactly why every graded lead
  carries a first-call checklist: the advisor confirms the facts on the phone.
