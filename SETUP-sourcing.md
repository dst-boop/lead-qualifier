# Sourcing — the sheet reads itself

The app is organised around the four things the job actually consists of, in
order:

| | Stage | What it means |
|---|---|---|
| **1** | **Source** | Where prospects come from |
| **2** | **Enrich** | Fill in what is missing before anyone calls |
| **3** | **Qualify** | Scored and tiered against your ICP |
| **4** | **Track** | Worked, and what came of it |

Each stage shows how many leads are waiting in it and offers only the actions
that move them on. Everything else — settings, coverage, backups, the CSV
template — lives behind **More**, because a row of eleven equal-weight buttons
is a menu with extra steps.

## The automatic part

Point your research tool at a Google Sheet named exactly:

```
Wealth Management Lead Prospecting
```

That is the whole setup. The app looks for that sheet in your Drive **every
time you open it**, maps its columns, and adds anyone new. No file picker, no
column dialog, no import button.

The tool appends rows on its own schedule; you open the app and they are there.
**Check my sheet** does the same thing on demand.

### Nothing is ever overwritten

A row already on your list is skipped. The sheet growing is the only thing that
changes anything, so re-reading it is always safe.

Matching is on four identities, any one of which is enough: ZoomInfo contact ID,
email address, LinkedIn URL, or name plus employer. **The URL matters most** — a
research tool's output frequently has no email at all, and matching on email
alone would re-add those people on every single check.

### It tells you what it did

The Source stage prints one line after every check: how many were added, how
many were already there, and — the part that would otherwise be invisible —
**whether the sheet is missing a phone or an email column**, because those leads
cannot be called until they are enriched.

Columns that announce themselves as estimates (`Est. Age Range` and the like)
are counted and excluded rather than silently dropped. See `docs/ADR.md` §17 for
why a guessed age is worse than a blank one.

### Renaming the sheet

Set `DRIVE_LEADS_FILE` on the Cloud Run service to read a different name. To
pull from a one-off file instead, **More → Pick a different sheet** opens the
old picker, which also accepts a pasted Drive link.

## The other three sources

**Find employers** — WARN notices matched to Form 5500 plan assets, ranked by
dollars in motion. See `SETUP-prospecting.md`. Hidden until `WARN_FEEDS` is set.

**Search ZoomInfo** — opens the build panel. Two campaigns: Rollover (recent job
change) and SCS (long tenure, 59½, in-service). See `SETUP-scs.md`.

**Import a file / Paste a list** — a CSV or a spreadsheet, with the column
mapper. Use these for a one-off; the sheet is the standing arrangement.

## What changed, and what went away

**The JSON importer is gone.** Nobody should have to paste JSON into a
prospecting app. Everything it did now happens through the sheet.

**Excluded leads sort last.** A 75-point lead with no mobile is genuinely
valuable — that is why the bucket exists — but it is not a call, and it no
longer occupies the top of the call list.

**Statuses are clickable.** The chips in Track filter the table; clicking one
again clears the filter.
