# WhitePages phone verification and household enrichment

Two per-lead buttons.

**📞? Verify** checks a phone number and shows:

- whether the number is **valid**
- **line type** (Mobile / Landline / VoIP …) — mobile shows green
- **carrier**
- whether the number's **owner matches the lead's name** (or who it belongs to)

**🏠 Enrich** looks the person up by name and shows:

- **home city and state** — where they live, not where the company is
- **estimated home value** — the strongest net-worth proxy available here
- **how many mobile numbers** are on file, and what they are

Both write into the CSV export comments. Enrich also backfills empty street,
city, zip and mobile fields on the lead, so a lead with no mobile number can
gain one.

## Which API you have

Two incompatible flavours of this API exist, and the key you hold works with
exactly one of them:

| Flavour | Base URL | Paths | Header |
|---|---|---|---|
| **Whitepages Pro** (default) | `https://api.whitepages.com` | `/v2/phone`, `/v2/person`, `/v2/property` | `X-Api-Key` |
| **Trestle** | `https://api.trestleiq.com` | `/3.1/phone`, … | `x-api-key` |

The app defaults to Whitepages Pro and infers the paths from the base URL, so
setting `WHITEPAGES_BASE_URL` to the Trestle host switches the whole dialect.

## Setup

1. Get your API key from your account dashboard (Pro keys arrive by email
   after signing up for a trial).
2. Cloud Run → your service → **Edit & deploy new revision → Variables & Secrets**:

| Variable | Value |
|---|---|
| `WHITEPAGES_API_KEY` | your API key |
| `WHITEPAGES_BASE_URL` | *(optional)* defaults to `https://api.whitepages.com` |
| `WHITEPAGES_PHONE_PATH` | *(optional)* override, e.g. `/v2/phone` |
| `WHITEPAGES_PERSON_PATH` | *(optional)* override |
| `WHITEPAGES_PROPERTY_PATH` | *(optional)* override |

3. Deploy. Both buttons appear once you sign in.

## Troubleshooting

The app now reports the upstream status code and the exact URL it called, so a
failed lookup tells you which of these it is:

- **403** — the key is wrong, or has extra whitespace. The message says so.
- **404** — treated as "no record found" and shown as such. If *every* lookup
  returns it, the path is wrong for your account; set the `*_PATH` overrides.
- **Anything else** — the error text comes straight through from the API.

## Notes

- **Each click costs one Reverse Phone lookup** on your plan — that's why the
  endpoint requires sign-in (visitors to the URL can't spend your credits) and
  verification is per-lead rather than automatic for the whole CSV.
- The lookup uses Trestle's Reverse Phone API (`/3.1/phone`, `x-api-key` header).
- Compliance: this data is non-FCRA. Fine for deciding whether/how to contact a
  lead; it must not be used for credit, insurance, or employment eligibility
  decisions.
