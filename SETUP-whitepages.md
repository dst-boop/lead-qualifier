# WhitePages / Trestle phone verification

Adds a **📞 Verify** button to every lead with a phone number. One click checks
the number against WhitePages data (now operated as **Trestle**,
https://trestleiq.com) and shows:

- whether the number is **valid**
- **line type** (Mobile / Landline / VoIP …) — mobile shows green
- **carrier**
- whether the number's **owner matches the lead's name** (or who it actually belongs to)

Results are added to the CSV export as `phone_valid`, `phone_line_type`, and
`phone_owner` columns.

## Setup

1. Get your API key from your Trestle / WhitePages Pro account dashboard.
2. Cloud Run → your service → **Edit & deploy new revision → Variables & Secrets**:

| Variable | Value |
|---|---|
| `WHITEPAGES_API_KEY` | your API key |
| `WHITEPAGES_BASE_URL` | *(optional)* defaults to `https://api.trestleiq.com` |

3. Deploy. The Verify buttons work immediately.

## Notes

- **Each click costs one Reverse Phone lookup** on your plan — that's why the
  endpoint requires sign-in (visitors to the URL can't spend your credits) and
  verification is per-lead rather than automatic for the whole CSV.
- The lookup uses Trestle's Reverse Phone API (`/3.1/phone`, `x-api-key` header).
- Compliance: this data is non-FCRA. Fine for deciding whether/how to contact a
  lead; it must not be used for credit, insurance, or employment eligibility
  decisions.
