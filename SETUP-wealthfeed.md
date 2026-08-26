# WealthFeed

WealthFeed sells money-in-motion events. It has **no public API and no Zapier
app** — its outbound paths are partner CRM syncs (Wealthbox, Redtail) and CSV
export from a prospecting list. So the integration is an import lane, and it
is a first-class one.

## The flow

1. In WealthFeed, build a prospect list and **export it as CSV**.
2. Here: **Import a file** (or Paste a list). The mapper auto-recognises
   WealthFeed's columns — event, event date, estimated net worth and income —
   alongside the ordinary name/phone/employer columns. Anything it misses,
   point at once; the mapping is remembered.
3. What lights up:
   - **⚡ chip** on each row with an event, the vendor's words verbatim in
     the tooltip, and "verify on the call" — because it is a report, not an
     observation.
   - **Money-in-motion panel**: every imported event appears as a signal,
     dated ones ranked above undated, anything older than a year dropped.
   - **CSV export**: the event and its date ride along in the comments, so
     the CRM sees what WealthFeed said.

## Two deliberate refusals

**No taxonomy mapping.** The event text passes through verbatim. This app has
been wrong five times parsing schemas it had not seen; a mapping table for a
vendor's event names would be the sixth. An event we did not anticipate
surfaces as itself instead of vanishing because it failed to match a list
written before it existed.

**Estimates stay labelled.** WealthFeed's net worth and income are estimates,
so they land in fields named "as reported" and touch nothing the app treats
as a fact — no score input, no age arithmetic. (The import mapper's
derived-column embargo has exactly one door for them: a column that declares
itself an estimate may land in a field that declares the same.)

## Making the mapping exact

The aliases were written from WealthFeed's public vocabulary, not from a real
export — the condition this repo distrusts on principle. The one-line fix, as
always: **paste the header row of your actual WealthFeed export into the
chat**, and the aliases get pinned to it. Until then, any unrecognised column
is one click in the mapper, and the mapping is remembered per file shape.
