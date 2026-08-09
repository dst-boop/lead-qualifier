# Firestore — sessions and saved lists

Without this, the app keeps sessions in the container's memory and your lead
list in the browser. Both are lost the moment Cloud Run recycles the container
or starts a second one — which it does on its own schedule, with no warning.
Signing in and being signed out again a minute later is this, not a bug in the
sign-in code.

With Firestore:

- **Sign-in survives** container restarts and scaling to more than one instance.
- **Your lead list follows your account**, not your browser. Sign in from a
  different machine and it's there.
- The browser copy is still written on every save, so the list is readable
  offline and survives signing out.

## Setup — about two minutes

1. Cloud Console → **Firestore** → **Create database**.
2. Choose **Native mode** (not Datastore mode).
3. Pick a location — **nam5 (United States)** or the region nearest `us-east1`.
   This cannot be changed later.
4. Start in **production mode**. The app talks to Firestore with the service
   account's credentials, not from the browser, so the security rules never
   apply to it and locked-down rules are correct.

That's it. No environment variable is needed: the app picks up the project and
credentials from the Cloud Run runtime automatically.

## Permissions

The Cloud Run service account needs **Cloud Datastore User**
(`roles/datastore.user`). The default compute service account usually has it
via the project's Editor role. If reads fail, that's the first thing to check —
IAM → find the service account shown on the Cloud Run service → add the role.

## Confirming it worked

Sign in and look at the bar under the header. It reads **"synced to your
account"** when Firestore is live. If Firestore isn't reachable the app keeps
working on the browser copy and the bar says **"local only"** with the reason.

`GET /api/me` also reports it directly as `"storage": "firestore"` or
`"storage": "memory"`.

## Collections

| Collection | Key | Holds |
|---|---|---|
| `sessions` | session id (cookie value) | OAuth token caches, 8-hour expiry |
| `lead_state` | signed-in email address | settings + leads, one document per user |

Set `FIRESTORE_SESSIONS_COLLECTION` / `FIRESTORE_STATE_COLLECTION` to rename
them, or `USE_FIRESTORE=0` to force memory mode.

## Migration

Nothing to do. The first time you sign in with a list already in your browser,
it is copied up to your account and the bar says **"browser list moved to your
account"**. If a list already exists on the account, that one wins and the
browser copy is left alone.

## Note on token storage

Session documents hold OAuth refresh tokens. Firestore encrypts everything at
rest with Google-managed keys, so they are not sitting in plaintext on disk —
but anyone with read access to the database can read them.

The architecture calls for KMS envelope encryption on top, so that a Firestore
reader alone can't use the tokens. **That is not built yet.** Until it is,
treat Firestore read access as equivalent to access to the connected Google
and Microsoft accounts, and keep the IAM role list short.
