# Callbacks, sharing, and the team board

## Callbacks

"Call me back Thursday" is the commonest outcome of a call, and until now the
date lived in someone's head.

Click **⏰** on any row. Pick a date and time, and write down what to pick up on
— *"reviewing the old Boeing 401(k) with his wife first"* is the sentence that
makes the next call work.

What happens then:

- The lead moves off **New** to **Call Back**.
- Until it falls due it shows in Track as *"n callbacks scheduled"*.
- The moment it falls due, **Due now** appears in the Track card, the row turns
  red, and **the lead sorts to the top of the call list** — ahead of higher
  scores. A promise beats a score.
- Setting the meeting takes it out of the queue. So do *Not interested* and
  *Has advisor* — a reminder about someone who has already said no is noise.

The **Callbacks due** filter in the toolbar shows just those, and **Due now**
turns it on in one click.

## Sharing a list

**More → Share this list.** Enter a colleague's email and choose whether they
can edit or only view.

They see it in their own list switcher, marked *"shared by dst@…"*, alongside
their own lists. Only that one list travels — nothing else on your account.

| | Owner | Editor | Viewer |
|---|---|---|---|
| Read the leads | ✓ | ✓ | ✓ |
| Add, edit, score | ✓ | ✓ | |
| See who else it is shared with | ✓ | | |
| Share it on | ✓ | | |
| Rename | ✓ | | |
| Delete | ✓ | | |
| Remove their own access | | ✓ | ✓ |

A recipient can always walk away from a list they did not ask for — that is the
**Leave this shared list** entry where the owner sees Delete. Deleting a list
revokes it from everyone it was shared with, so nobody is left with a switcher
entry pointing at nothing.

There is no firm-wide pool, and no way to enumerate lists that have not been
shared with you. Access is checked server-side on every read and every write.

## The team board

**Team**, in the header.

### Leaderboard

Calls, emails, invites and meetings per advisor over today, 7 days or 30 days.

**Points are deliberately lopsided:** a call or an email is 1, an invite 3, a
meeting set 10. A leaderboard that scored raw dials would be won by whoever
dials numbers they never meant to talk to, which is worse than having no
leaderboard.

### Contests

Name it, list the colleagues to go up against, pick what it is scored on
(points, calls, emails, invites or meetings) and how many days it runs.
Everyone in it sees the same scoreboard. Whoever started it can end it.

### Who counts as a teammate

Everyone at your email domain, plus anyone you are in a sharing relationship
with. Domain is the rule a single firm actually wants and needs no
administering; sharing covers the cases it misses, like an advisor at another
firm you work a list with. `TEAM_BY_DOMAIN=0` turns off the domain half and
leaves only sharing.

### What is actually stored

Four integers per advisor per day — calls, emails, invites, meetings — in
`advisor_stats`. Not leads.

Deriving the leaderboard from everyone's lead documents would mean reading every
lead in the firm to draw one table, and it would expose lists that were never
shared. A counter document leaks a number where a lead document leaks a
prospect.

The client sends **totals for the day, not increments**, so a replay or a double
click cannot inflate anyone's score.

## Reference

| Endpoint | |
|---|---|
| `GET /api/lists/{id}/shares` | Who a list is shared with (owner only) |
| `POST /api/lists/{id}/shares` | `{email, role}` — role is `editor` or `viewer` |
| `DELETE /api/lists/{id}/shares/{email}` | Owner revokes, or a recipient leaves |
| `PUT /api/stats` | Today's four counters for the signed-in advisor |
| `GET /api/leaderboard?days=N` | The team, ranked |
| `GET /api/battles` | Contests you are in, with live scores |
| `POST /api/battles` | `{name, opponents[], metric, days}` |
| `DELETE /api/battles/{id}` | End one (creator only) |

A shared list is addressed as `owner@firm.com~listid`; your own are a bare id.

| Variable | |
|---|---|
| `TEAM_BY_DOMAIN` | `0` to stop treating an email domain as a team. Default on. |
| `FIRESTORE_SHARED_COLLECTION` | Reverse index of lists shared *with* you. Default `lead_shares`. |
| `FIRESTORE_STATS_COLLECTION` | Daily counters. Default `advisor_stats`. |
| `FIRESTORE_BATTLES_COLLECTION` | Contests. Default `battles`. |
