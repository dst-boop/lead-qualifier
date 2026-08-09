# One-time Google setup (send email & invites from a Gmail / Google account)

This lets the Lead Qualifier send email and calendar invites from a Google
account instead of (or in addition to) Microsoft 365 — so outreach doesn't
have to come from the financialplannersofamerica.com domain. No billing
account is required for this part.

## 1. Create the OAuth app

1. Go to https://console.cloud.google.com (sign in with the Google account you'll send from).
2. Create/select a project (e.g. `lead-qualifier`).
3. **APIs & Services → Enabled APIs & services → + Enable APIs**: enable
   **Gmail API** and **Google Calendar API**.
4. **APIs & Services → OAuth consent screen**:
   - User type: **External** (unless the sending account is on Google Workspace — then **Internal**)
   - App name `FPA Lead Qualifier`, your email for the contact fields → Save
   - If External: under **Test users**, add the Gmail address(es) that will sign in.
5. **APIs & Services → Credentials → + Create credentials → OAuth client ID**:
   - Application type: **Web application**
   - Authorized redirect URI: `https://YOUR-APP-DOMAIN/auth/google/callback`
     (add `http://localhost:8000/auth/google/callback` for local testing)
6. Copy the **Client ID** and **Client secret**.

## 2. Configure the app host

| Variable | Value |
|---|---|
| `GOOGLE_CLIENT_ID` | from step 6 |
| `GOOGLE_CLIENT_SECRET` | from step 6 |
| `APP_BASE_URL` | the app's public URL |

Microsoft variables (`MS_*`) are optional — configure one provider or both;
the sign-in bar only shows the providers that are configured.

## Notes

- Email goes out via the Gmail API from the signed-in account and appears in
  its Sent folder. Calendar invites are created on that account's primary
  calendar with `sendUpdates=all`, so Google emails the lead the invitation.
- Personal Gmail has daily sending limits (~500/day) and cold outreach from
  @gmail.com can look less professional than a custom domain. For volume
  outreach, consider a Google Workspace mailbox on a dedicated domain.
- While the OAuth consent screen is in "Testing" mode, refresh tokens expire
  after 7 days — publish the app in the consent screen settings for
  long-lived sign-ins.
