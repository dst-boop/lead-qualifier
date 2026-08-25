# One-time Google setup (send email & invites from a Gmail / Google account)

This lets the Lead Qualifier send email and calendar invites from a Google
account instead of (or in addition to) Microsoft 365 — so outreach doesn't
have to come from the financialplannersofamerica.com domain. No billing
account is required for this part.

## 1. Create the OAuth app

1. Go to https://console.cloud.google.com (sign in with the Google account you'll send from).
2. Create/select a project (e.g. `lead-qualifier`).
3. **APIs & Services → Enabled APIs & services → + Enable APIs**: enable
   **Gmail API**, **Google Calendar API** and **Google Drive API**.
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

## 3. Pull from Drive

Export a lead list from ZoomInfo into Drive and the app reads it directly —
no download, no upload. Click **Pull from Drive**, and it lists spreadsheets
matching the name (default `401(k) Rollover Leads`), newest first. Google
Sheets, `.xlsx` and `.csv` all work; the file goes straight into the same
column mapper as a manual import.

Set `DRIVE_LEADS_FILE` to change the default name it looks for.

### The scope, and why it is this one

Drive access uses **`drive.readonly`** — the app can read any file in the
signed-in account's Drive, though it only ever searches by filename and never
lists everything.

`drive.file` would be narrower, limiting access to files picked through
Google's own dialog. It is not used because that dialog runs **in the browser
with the access token**, and this app deliberately keeps every third-party
token server-side. Trading that boundary for a narrower scope is the wrong
trade in a tool holding client prospect data.

If read access to the whole Drive is more than you want, the mitigation is a
separate Google account that holds only the exports, connected in place of a
personal one.

### Re-consent

Adding Drive changes the permissions the app asks for, so **sign out and sign
back in once** after deploying. Until then Drive calls return a clear message
saying exactly that rather than failing obscurely — an existing session simply
does not carry the new permission.

## Notes

- **Pull from Drive** appears only when signed in with Google; Microsoft
  sign-in does not grant Drive access.
- Email goes out via the Gmail API from the signed-in account and appears in
  its Sent folder. Calendar invites are created on that account's primary
  calendar with `sendUpdates=all`, so Google emails the lead the invitation.
- Personal Gmail has daily sending limits (~500/day) and cold outreach from
  @gmail.com can look less professional than a custom domain. For volume
  outreach, consider a Google Workspace mailbox on a dedicated domain.
- While the OAuth consent screen is in "Testing" mode, refresh tokens expire
  after 7 days — publish the app in the consent screen settings for
  long-lived sign-ins.


## If the consent screen keeps coming back

Two different causes produce the same screen, and they need different fixes.

**The app kept asking (fixed in code).** Sign-in decides whether to request
consent, and the first version of that decision looked for a saved token in
the browser session — which a fresh sign-in never has. Refresh tokens now
live in a `token_vault` Firestore collection keyed by the person
(`google:email`), sealed with the same KMS envelope as sessions, so the
consent you gave last month is found from any browser. You should see the
consent screen exactly twice in the app's life: your first ever sign-in, and
after a revocation.

**Google kept expiring the grant (fixed in the Cloud Console).** If the OAuth
consent screen's publishing status is **Testing**, Google expires every
refresh token after 7 days — the app then genuinely needs re-consent weekly,
and no code can change that. Fix it once:

1. Google Cloud Console → **APIs & Services → OAuth consent screen**
2. If **User Type** is *External* and everyone who signs in is
   @financialplannersofamerica.com, switch to (or recreate as) **Internal** —
   no verification, no 7-day expiry, done.
3. If External is genuinely needed (users outside the Workspace), press
   **Publish app** so status reads *In production*. Google will list the
   sensitive scopes for verification; until verified, outside users see an
   unverified-app warning, but tokens stop expiring weekly.

Internal is the right answer for a firm-internal tool, and it is one click.
