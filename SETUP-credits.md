# Paid lookups: what the app pays for, and what you bring

Two paid sources, and they work on opposite models. Everything else the app
does — the public record, SEC filings, proxy-statement ages, scoring, calling,
export — costs nothing and is not counted here.

| Source | Who pays | Ceiling |
|---|---|---|
| WhitePages | The app, from one firm key | **100 lookups per user per month**, inside a firm-wide pool |
| ZoomInfo | **You, from your own subscription** | Yours. The app holds no ZoomInfo seat |

## ZoomInfo: every user brings their own subscription

The app never holds a ZoomInfo seat. Enrichment runs through **your** account,
by one of two routes — a ZoomInfo MCP token saved under ICP settings, or your
own Claude account with the ZoomInfo connector enabled. Both spend your credits
against your own contract, and neither is possible without a subscription of
your own.

That is why the app shows **usage** rather than a balance for ZoomInfo: it can
tell you how many credits it spent on your behalf this month, for reconciling
against your own dashboard, but it has no pool to draw down and no business
inventing a ceiling. Your ZoomInfo dashboard is the authority on what is left.

Without a subscription connected, the enrich button says so and does nothing —
it does not fall back to anything, because there is nothing to fall back to.
See [SETUP-zoominfo.md](SETUP-zoominfo.md).

## WhitePages: 100 lookups each, from a shared key

The app holds one WhitePages key and pays that bill, so there is an allowance,
and it is per person: **`WHITEPAGES_USER_CREDITS` (100)** each per calendar
month, inside the account-wide **`WHITEPAGES_MONTHLY_CREDITS` (1000)**.

Both ceilings are real and they fail differently, which is why the app says
which one stopped you:

- **Your own hundred is gone** → it comes back on the first of the month.
- **The firm's pool is gone** while you still have your own left → waiting will
  not help; an admin has to raise the limit or buy more.

Ten advisors at a hundred each exactly fills a thousand. An eleventh advisor
will hit the firm's ceiling with personal allowance to spare, and the app will
say so rather than telling them to wait for a reset that will not fix it.

## Where to see what is left

**More → Data coverage** shows both pools, what is spent this month, and when
they reset (the first of the next month, UTC). The Enrich stage also carries
the ZoomInfo number, and the confirm dialog tells you what a run will cost
before it runs.

## The four rules that keep the bill down

1. **Nothing pays twice for the same question.** A WhitePages answer is
   remembered for 30 days (`WHITEPAGES_CACHE_SECONDS`), including the answer
   "no record found" — which is the most wasteful lookup to repeat. The cache
   is stored in Firestore, so it survives the server restarting; before that it
   was in memory only and emptied every time traffic paused.
2. **ZoomInfo re-enriches free for a year.** The app stamps when a contact was
   enriched and only counts the ones outside that window as billable. The
   confirm dialog separates them: "About 28 credits, and 12 free".
3. **The allowance is checked before the vendor is called.** When a pool is
   spent, the lookup is refused here with the reset date, not sent and billed.
   A cached answer still works — it costs nothing.
4. **Only one button spends at list scale, and it asks first.** WhitePages is
   never swept across a list; it stays a per-lead press with the count in front
   of you.

## Spending them strategically

Sort by tier and work down. Tier A leads are the ones where a confirmed mobile
changes what you do next, so they are where a credit buys the most. The free
button (**Enrich all (free)**) is worth pressing first on any new list: it
costs nothing, and what it finds — an SEC insider, a self-reported retirement,
a proxy-statement age — often re-ranks the list before you spend anything.

## A note on ZoomInfo counting

The ZoomInfo usage number is reported by the app after each run rather than
counted at the server. Two of the three routes (the in-Claude route and the
connector route) go through your own Claude account and never touch this
server, so it cannot see them. The count is honest about what this app did on
your subscription; your ZoomInfo dashboard remains the authority on the account.

WhitePages is the other way round and deliberately so: the server spends it at
one choke point and counts it there. The app refuses a client-reported
WhitePages number, because that is a number it can count correctly itself.
