# Paid lookups: two allowances, and how the app protects them

The app spends from two pools you pay for. Everything else it does — the
public record, SEC filings, proxy-statement ages, scoring, calling, export —
costs nothing and is not counted here.

| Pool | Default allowance | Env var | What spends it |
|---|---|---|---|
| ZoomInfo | 2,000 / month | `ZOOMINFO_MONTHLY_CREDITS` | Enrich (stage 2), the per-row **Enrich** button |
| WhitePages | 1,000 / month | `WHITEPAGES_MONTHLY_CREDITS` | 📞? verify, 📞+ re-check, 🏠 household |

Set either to your real plan on Cloud Run. They are defaults, not detections —
neither vendor publishes a remaining-balance endpoint that is itself free to
call, and asking how much you have spent should not spend any.

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
   enriched and only charges the month for the ones outside that window. The
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

The ZoomInfo number is reported by the app after each run rather than counted
at the server. Two of the three routes to ZoomInfo (the in-Claude route and the
connector route) run through your own Claude account and never touch this
server, so it cannot see them. The count is therefore honest about what this
app spent; your ZoomInfo dashboard remains the authority on the account.
