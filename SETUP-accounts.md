# Accounts for anyone

Signing in no longer requires a Google or Microsoft login. **Sign in / create
an account** takes any email address and a password (10+ characters — a short
phrase beats a complex word). The account's email is the identity: it is the
key lead lists are stored under and the name shares are granted to.

Google and Microsoft become **attachments**, linked from the account bar
after sign-in, for the things only they can do:

| Linked account | Enables |
|---|---|
| Google address | Gmail sending (with send-as aliases), Google Calendar invites, Drive sheet sync |
| Outlook address | Outlook sending, Outlook calendar invites |
| Employer calendar | Invites from a corporate mailbox — calendar-only consent, no mail permission |

Linking never changes who you are: a password account that links a Gmail
address keeps its own email as the identity, and its lists stay exactly where
they were. The sender pickers then offer each linked address for the jobs it
can do.

A password account with nothing linked can still do everything that costs no
provider: import and score leads, enrich, sweep public records, watch
signals, export. Sending email or invites asks you to link an account first,
by name.

## Honest gaps, stated rather than papered over

- **No verification email is sent at signup** — the server has no mailbox of
  its own to send from. An unverified account only gets its own empty
  workspace, so the risk is impersonation in *shares*; close this before
  inviting strangers to share lists with people they haven't met.
- **No password reset yet**, for the same reason (there is no channel to send
  the reset link through). An admin can delete the account document in the
  `accounts` Firestore collection, after which the email can re-register.
- Passwords are hashed with scrypt (standard library, interactive-login
  parameters) and never stored or logged in the clear.

## The Google OAuth app must be public for this to matter

If the Google Cloud OAuth consent screen is set to **Internal**, only
financialplannersofamerica.com users can link Google at all. For an app open
to anyone: User Type **External**, status **In production** (Publish app).
Google will require verification for the sensitive Gmail/Drive scopes before
outside users stop seeing the unverified-app warning — that is a Google
review process, worth starting early. This is the trade against the earlier
advice in SETUP-google.md: Internal fixes the 7-day token expiry *for a
firm-internal app*; a public app takes the External + published route
instead, which fixes the expiry too once published.
