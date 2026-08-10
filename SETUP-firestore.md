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

## Encrypting the stored tokens

Session documents hold OAuth refresh tokens. Firestore encrypts everything at
rest with Google-managed keys, so nothing is plaintext on disk — but anyone
who can *read the database* can read those tokens and use them.

Setting `KMS_KEY_NAME` puts a second lock on. Each write generates a random
data key, encrypts the session with it, and stores the payload alongside a
KMS-wrapped copy of the data key. Reading requires KMS decrypt permission, so
database read access on its own yields nothing usable.

**This is optional.** Leave `KMS_KEY_NAME` unset and behaviour is unchanged.

### Setup — about three minutes

1. Cloud Console → **Security → Key Management** → **Create key ring**.
   Name it `lead-qualifier`, location **us-east1** (match the service).
2. **Create key** inside it. Name it `sessions`, purpose
   **Symmetric encrypt/decrypt**, rotation every 90 days is fine.
3. Copy the key's **Resource name** — it looks like:

   ```
   projects/YOUR-PROJECT/locations/us-east1/keyRings/lead-qualifier/cryptoKeys/sessions
   ```

4. Grant the Cloud Run service account **Cloud KMS CryptoKey
   Encrypter/Decrypter** (`roles/cloudkms.cryptoKeyEncrypterDecrypter`) on that
   key. Do it on the key itself, not project-wide.
5. Cloud Run → **Edit & deploy new revision → Variables & Secrets** → set
   `KMS_KEY_NAME` to the resource name. Deploy.

`GET /api/me` then reports `"encryption": "kms"` instead of
`"google-managed"`.

### What happens to existing sessions

They keep working. Documents written before the key existed are stored under a
`data` field and are still read; new writes use the encrypted form. Everyone is
migrated within one session lifetime, with no cutover.

### If the key becomes unreachable

Sealed sessions cannot be read and everyone is signed out — they sign back in
and carry on. Saved lead lists are unaffected. Encryption failures fall back to
writing unwrapped rather than losing the session, so a KMS outage degrades
instead of breaking.

**Do not destroy or disable the key** while sessions reference it, and keep the
IAM grant on it narrow — it is the thing standing between database read access
and the connected Google and Microsoft accounts.
