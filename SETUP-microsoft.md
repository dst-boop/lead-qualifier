# Microsoft 365 sign-in — this is a request to Equitable IT, not a setup you can do

Sign in with Microsoft lets an advisor use their work account and send email and
calendar invites as themselves, through Microsoft Graph.

**You cannot register this app yourself.** Two facts settle it:

| Domain | Tenant |
|---|---|
| `financialplannersofamerica.com` | **none** — `AADSTS90002: Tenant not found` |
| `equitable.com` | `0ed45188-c605-4511-8b80-3a5831be1abc` |

There is no Entra directory for the FPA domain to be an administrator of — mail
for it is handled outside Microsoft, which is why Google sign-in works and
Microsoft has nothing to attach to. The tenant that matters is Equitable's, and
in it you are a user, not an admin.

So this page is not a checklist you work through. It is **what to ask Equitable
IT for, and what to do with what they send back.**

If the advisors who need this are not on Equitable email, this is the wrong
page — a multi-tenant registration (`MS_TENANT_ID=common`) is a different setup,
and the app supports it with no code change since the authority is built from
that variable.

## What to ask them for

Send this to whoever handles Entra app registrations. Everything they need to
answer a security review is in it.

> **Request: register an internal Entra app for a lead-qualification tool**
>
> I run a lead-qualification web app for my practice and would like Equitable
> advisors to be able to sign in with their Equitable account rather than a
> separate password, and to send prospect emails and calendar invites as
> themselves.
>
> - **App name:** FPA Lead Qualifier
> - **Account types:** single tenant — accounts in this organizational directory
>   only
> - **Platform:** Web
> - **Redirect URI:** `https://leads.financialplannersofamerica.com/auth/callback`
> - **Delegated Microsoft Graph permissions:** `User.Read`, `Mail.Send`,
>   `Calendars.ReadWrite`
> - **Hosting:** Google Cloud Run, us-east1, TLS terminated by Google
>
> **These are delegated permissions, not application permissions.** The app can
> only ever act as the person signed in, using a token that person's own sign-in
> produced. It has no tenant-wide mailbox access and cannot read or send for
> anyone who has not signed into it.
>
> Mail goes out through `/me/sendMail`, so it lands in the sender's Sent Items
> and is captured by normal retention and journaling exactly as Outlook-sent mail
> is. Calendar invites are created on the sender's own calendar.
>
> Admin consent for the three delegated scopes would avoid prompting each
> advisor individually.
>
> **What I need back:** the Application (client) ID and a client secret value.
> The Directory (tenant) ID I already have. The secret has an expiry — please
> tell me what you set it to so I can request a rotation before it lapses.

## What to do with the answer

Cloud Run → the service → **Edit & deploy new revision → Variables & Secrets**:

| Variable | Value |
|---|---|
| `MS_CLIENT_ID` | Application (client) ID from IT |
| `MS_CLIENT_SECRET` | the secret **value** (not its ID) |
| `MS_TENANT_ID` | `0ed45188-c605-4511-8b80-3a5831be1abc` |
| `APP_BASE_URL` | `https://leads.financialplannersofamerica.com` |

Deploy. **Sign in with Microsoft** appears on its own — the UI offers only the
providers the deployment has credentials for, so until all three are set nothing
about Microsoft is shown, and nothing is broken by their absence.

The redirect URI must match `APP_BASE_URL` + `/auth/callback` character for
character. If IT registers a different one, the sign-in fails at the redirect
with a `AADSTS50011` mismatch error naming both URIs, which makes it obvious.

## Run locally

Local testing needs its own redirect URI registered
(`http://localhost:8000/auth/callback`) — worth asking for in the same request
if you want it, since going back for a second change costs another round trip.

```bash
pip install -r requirements.txt
export MS_CLIENT_ID=... MS_TENANT_ID=... MS_CLIENT_SECRET=... APP_BASE_URL=http://localhost:8000
python -m webapp
```

## Notes

- Mail is sent via Microsoft Graph `/me/sendMail` and lands in your Sent Items.
- Calendar invites are created on your calendar with the lead as a required
  attendee; Microsoft emails them the invitation automatically.
- Sessions live in Firestore, encrypted with Cloud KMS when `KMS_KEY_NAME` is
  set (see SETUP-firestore.md). The tokens Equitable issues are stored there, so
  that variable matters more once this is live.
- The client secret expires. Whatever expiry IT chooses, put a reminder in the
  calendar a month before — an expired secret takes Microsoft sign-in down with
  a token-endpoint error, while Google sign-in keeps working, which makes for a
  confusing morning.

## Employer mailboxes: connect the calendar without asking for mail

**Add an employer calendar** (in the account bar, next to "Add an Outlook
address") connects a Microsoft account with `/auth/login?mode=calendar`,
which requests only `User.Read` and `Calendars.ReadWrite` — **no Mail.Send**.

Why this exists, verbatim from a working example: Magic List connects to
corporate tenants — Equitable's included, proven by a live connection — with
calendar scopes only. Two facts make that the right footprint:

1. **Invites don't need mail permission.** Creating an event with attendees
   makes Exchange dispatch the invitation itself, from the mailbox, through
   the firm's normal transport — so it is journaled and archived like any
   other outbound message. The meeting request the lead receives is
   indistinguishable from one sent from Outlook.
2. **Mail.Send is the scope corporate tenants refuse.** The narrow ask is
   what actually gets approved by user-level consent, with no admin involved.

A calendar-only connection shows in the sender pickers as *"invites only"*:
it appears in the invite dialog, stays out of the email dialog, and an API
call that tries to mail from it anyway is refused with the way forward named
(a Gmail send-as alias of the same address covers the email half).

The example requested `Calendars.ReadWrite.Shared` too; adding an attendee
needs only `Calendars.ReadWrite`, so this app deliberately asks for less.
Its authorize URL also carried no `state` parameter — ours does, plus PKCE,
both supplied by MSAL. Borrow the scope set, not the CSRF hole.
