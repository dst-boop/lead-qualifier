# One-time Microsoft 365 setup (about 10 minutes)

This registers the Lead Qualifier with your Microsoft 365 tenant so the team can
sign in with their work accounts and send email / calendar invites as themselves.
You need a Microsoft 365 admin account.

## 1. Register the app

1. Go to https://entra.microsoft.com (sign in as admin).
2. **Identity → Applications → App registrations → New registration**.
3. Name: `FPA Lead Qualifier`.
4. Supported account types: **Accounts in this organizational directory only**.
5. Redirect URI: platform **Web**, value:
   `https://YOUR-APP-DOMAIN/auth/callback`
   (add `http://localhost:8000/auth/callback` too if you want local testing).
6. Click **Register**.

## 2. Copy the IDs

On the app's **Overview** page copy:
- **Application (client) ID** → this is `MS_CLIENT_ID`
- **Directory (tenant) ID** → this is `MS_TENANT_ID`

## 3. Create a client secret

1. **Certificates & secrets → New client secret** (e.g. 24-month expiry).
2. Copy the secret **Value** immediately (shown once) → this is `MS_CLIENT_SECRET`.

## 4. Grant permissions

1. **API permissions → Add a permission → Microsoft Graph → Delegated permissions**.
2. Add: `User.Read`, `Mail.Send`, `Calendars.ReadWrite`.
3. Click **Grant admin consent for <your org>** so users aren't prompted individually.

## 5. Configure the app host

Set these environment variables wherever the app is deployed:

| Variable | Value |
|---|---|
| `MS_CLIENT_ID` | from step 2 |
| `MS_TENANT_ID` | from step 2 |
| `MS_CLIENT_SECRET` | from step 3 |
| `APP_BASE_URL` | the app's public URL, e.g. `https://leads.financialplannersofamerica.com` |

## Run locally

```bash
pip install -r requirements.txt
export MS_CLIENT_ID=... MS_TENANT_ID=... MS_CLIENT_SECRET=... APP_BASE_URL=http://localhost:8000
uvicorn webapp.main:app --reload
```

Open http://localhost:8000 — click **Sign in with Microsoft**, upload a CSV, and
use the ✉ Email / 📅 Invite buttons on any lead that has an email address.

Notes:
- Mail is sent via Microsoft Graph `/me/sendMail` and lands in your Sent Items.
- Calendar invites are created on your calendar with the lead as a required
  attendee; Microsoft emails them the invitation automatically.
- Sessions are held in memory: a restart signs everyone out (fine for a small
  team; move to a shared session store if the app ever runs multiple replicas).
