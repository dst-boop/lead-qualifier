# Lists, and which address the mail goes out as

## Named lead lists

An advisor runs more than one campaign at a time, and the lists should not see
each other. The button at the top left of the header is the switcher: it shows
the open list, and clicking it lists the rest with their lead counts.

| Action | What it does |
|---|---|
| Click a list | Opens it. The list you were on is saved first. |
| New empty list | Starts a fresh list and opens it. |
| Duplicate this list | Copies every lead into a new list under a new name. |
| Rename this list | Renaming is free — it changes nothing else. |
| Delete this list | Permanent, and refused if it is your only list. |

The list you had open is remembered per account, so reopening the app lands you
where you left off rather than on whichever list sorts first.

### Where the data lives

**In our system.** Each list is its own Firestore document, keyed
`email__listId` in the `lead_lists` collection. Settings — your ICP, weights,
templates, org details — live once per user on the `lead_state` document, not
per list, so changing a weight rescores every list you own.

One document per list rather than one per user is deliberate. A five-thousand-row
import cannot push the other lists towards Firestore's per-document limit, and
opening the app reads a short index of names and counts rather than every lead
you own across every campaign.

A list is reachable only by the account that owns it. The key is derived from
the signed-in email server-side and never accepted from the browser, so two
users can both have a list called `default` and neither can address the other's.

### Existing lists migrate on their own

The first time you open the app after this ships, whatever was in your single
list becomes a list named **My leads**. The original array is left untouched on
the state document rather than deleted, so if the migration is wrong the
original is still there to read.

### If the list index is unavailable

The client falls back to the old single-list endpoint rather than dropping to
browser-only storage. An older deployment or a transient error should not look
like your leads have gone missing.

## Sending from the address of your choice

### Connecting a second account

Sign in with Google or Microsoft as usual, then use **Add an Outlook address** /
**Add a Google address** in the bar under the header. This *links* the second
account rather than replacing the first — both sets of tokens sit on the same
session, which is what makes the picker possible.

### Choosing per message

The **Send from** dropdown appears in both the email and the calendar-invite
dialogs whenever more than one address is available. One address hides the
dropdown entirely: a menu with a single option only asks you to confirm a choice
you do not have.

Your last choice is remembered and preselected next time.

What is on offer:

- **Your Google address** — the account you signed in with.
- **Gmail send-as aliases** — a work alias or shared team address Gmail has
  verified for that account. Unverified aliases are left out, because Gmail
  would refuse them at send time.
- **Your Microsoft address** — the mailbox on the Outlook account, if linked.

### What actually happens

**Email** goes out through Gmail or Microsoft Graph on that account's own token,
so it lands in that account's Sent items and is journalled exactly as mail typed
there would be. For an alias, the `From` header is set to the alias; for a
primary address it is left alone and the provider fills it in.

**A calendar invite** is owned by the calendar it is created on, so there is no
alias to set — picking a sender picks whose calendar it lands on, and therefore
what address the attendee sees.

**An address you have not connected is refused,** with the address named in the
error. It is never silently swapped for one you have: sending from the wrong
address is the kind of mistake only the recipient notices.

### Aliases need one extra permission

Listing send-as addresses uses the `gmail.settings.basic` scope, which is
read-only and settings-only — it cannot change them. It was added after some
accounts signed in, so **if you do not see your aliases, sign out and back in**.
Until then the picker shows the primary address, which is the previous
behaviour.

## Reference

| Endpoint | |
|---|---|
| `GET /api/lists` | Index of names and counts, plus your settings |
| `POST /api/lists` | Create; `copy_from` duplicates an existing list |
| `GET /api/lists/{id}` | One list's leads |
| `PUT /api/lists/{id}` | Save one list's leads |
| `PATCH /api/lists/{id}` | Rename |
| `DELETE /api/lists/{id}` | Delete; refused on the last remaining list |
| `PUT /api/settings` | Settings, which belong to the user not the list |
| `GET /api/senders` | Addresses this session can send as |

`FIRESTORE_LISTS_COLLECTION` overrides the collection name (default
`lead_lists`).
