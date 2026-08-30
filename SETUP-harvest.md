# Free enrichment, and reading a public page

Two things that cost nothing.

## Pricing every employer — free

**Enrich → Price the employers.** Every distinct employer on your list is looked
up in the Department of Labor's Form 5500 file, and each matched lead gets a
chip: **~$658,333 avg**.

That is the employer's whole retirement plan — total assets over total
participants. It puts a dollar figure on a lead whose only other data is a job
title, and it costs no credits, because the file was already being fetched to
price WARN employers.

**It is not this person's balance,** and the chip is written so that survives a
hurried reading: the `~`, the word `avg`, and a tooltip that names the plan, how
many participants it averages over, the plan year, and says outright that it is
an order of magnitude rather than a quote. Form 5500 is annual with a long
filing lag.

One lookup per **employer**, not per lead: forty people at four companies is one
request. An employer with no match gets **no chip** — never a zero.

Needs `FORM5500_URL` (see `SETUP-prospecting.md`). Without it the button says so
rather than returning nothing.

## Reading a public page

`POST /api/harvest` with a URL returns that page as text — a company leadership
page, a licensing register, a conference bio, an obituary.

### What makes it legal, and where that lives

"Legally accessible" is not a property of a page. It is a property of your
relationship with the site. Three things decide it, and all three are encoded in
`webapp/harvest.py` rather than left to whoever is using it:

**robots.txt is honoured.** It is the published, machine-readable statement of
what a site permits automated clients to fetch. A path it disallows is not
fetched, and the refusal says so. If robots.txt cannot be read at all, the
answer is **no** — an unreachable rulebook is not permission.

**Requests identify themselves.** `HARVEST_USER_AGENT` names your firm and a
contact address, and there is **no default**: without it the endpoint refuses.
Fetching a page without saying who is asking is exactly what this app will not
do. Same rule the SEC states explicitly and this app already meets for EDGAR,
applied everywhere rather than only where demanded.

```
HARVEST_USER_AGENT="Financial Planners of America LeadQualifier dst@financialplannersofamerica.com"
```

**One request at a time per site, at least a second apart.** At that rate a
polite client is indistinguishable from a person with a browser.

### What it refuses outright

Some sites prohibit automated access in their **terms**, whatever robots.txt
says. Their robots.txt would not stop us; their agreement does.

`linkedin.com` · `facebook.com` · `instagram.com` · `x.com` / `twitter.com` ·
`glassdoor.com` · `indeed.com` · `ziprecruiter.com` · `spokeo.com` ·
`beenverified.com` · `truepeoplesearch.com` · `zoominfo.com`

LinkedIn matters most, because it is where this kind of research usually starts.
The refusal names the site and suggests the alternative: open it yourself and
paste what matters. Encoding it in the tool means it is a property of the app
rather than a matter of who is using it that day.

ZoomInfo is on the list for a different reason — there is an account, and the
API is the front door.

Also refused: anything that is not `http`/`https`, and any address that resolves
inside the network — `localhost`, private ranges, `169.254.169.254`. A cloud
metadata endpoint is not public data.

### What it deliberately does not do

**It does not crawl.** It fetches the URL you named, once, and follows nothing.
There is no frontier, no link discovery, no recursion. That is the difference
between reading a page you were pointed at and operating a robot over someone
else's site, and it is a limit in the code rather than a habit of the caller.

## Reading a whole company site

`POST /api/harvest/site` with `{"website": "acme.com"}` reads the pages of one
company's own site that tend to say who runs it and how long it has run.

**This is still not crawling, and the distinction is the point.** A crawler
discovers: it parses a page, pulls out the links and follows them, so what it
ends up fetching is decided by the site rather than by you. This does none of
that. It tries a fixed list of conventional paths — `/about`, `/about-us`,
`/our-team`, `/team`, `/leadership`, `/our-story`, `/history`, `/management` —
on the one host you named, in that order, and stops. Nothing is parsed for
links, nothing is queued, nothing recurses. The complete set of URLs it can
ever request is knowable before it runs: it is that list.

Every one of those requests goes through the same `fetch()` as the single-page
route, so robots.txt, the terms denylist, the private-address refusal and the
one-request-per-second-per-host rate all apply unchanged. A site whose
robots.txt disallows `/team` simply yields nothing for `/team`.

### Why this exists

`SETUP-edgar.md` gets an exact age, free, for Section 16 officers and directors
— and for nobody else. A list of local business owners is mostly **private**
companies, which file no proxy statement, so the free age signal is missing for
exactly the leads it would matter most for.

A firm's own About page routinely states what no vendor sells: *"serving Long
Island since 1987"*, *"founded by Frank Delgado"*, *"over 35 years in the
trade"*. For an owner-operator that is the career-length evidence the scoring
model otherwise has to do without.

### What comes back

With `ANTHROPIC_API_KEY` set, the pages are read and returned as findings:
owners and their titles, year founded, years in business, any age printed for a
named person, and a career start year.

**Every value carries the sentence it came from, and a value without one is
dropped before it reaches you.** The prompt asks for a quote behind each; the
server enforces it, because a model ignoring that instruction once would
otherwise put an unsourced age on screen looking exactly like a sourced one.
Ages outside 18–100 and years outside 1800–now are discarded the same way.

Without the key, the endpoint returns the page text and says it was not read.

### Nothing lands on a lead by itself

Findings come back for a person to accept or discard. Nothing is written onto a
lead automatically — `docs/ADR.md` §17 on why a derived value that arrives
looking like an observed one is worse than a blank. *"Founded 1987"* is
evidence about a company; that its president is 60 is an inference, and the two
should not end up in the same column by accident.

### What it costs in time

Eight paths at one request per second is roughly eight seconds per company, and
the rate limit is per host, so unrelated companies do not queue behind each
other. A few hundred sites is a background job, not a click — budget minutes,
and note that most sites answer on the first or second path.

### Errors say which rule stopped you

| `rule` | Meaning |
|---|---|
| `terms` | That site's terms prohibit automated access, or it is not a public address |
| `robots` | That host's robots.txt disallows this path, or could not be read |
| `type` | It is a PDF or an image, not a page |
| `status` | The server returned a non-200 |
| `network` | It could not be reached |

## Sources worth pointing it at

Public, checkable, and outside anyone's scraping prohibition:

- **Company leadership and investor-relations pages** — names, titles, often ages
- **SEC filings** — already wired directly; see `SETUP-edgar.md`
- **State professional licensing registers** — insurance, legal, medical, CPA
- **Court and county records** where published on the open web
- **University alumni notes, conference bios, association directories**
- **Local news, retirement and obituary notices**

Whatever comes back is text for a person to read, or to hand to the AI quality
check. Nothing from a fetched page is written onto a lead automatically —
`docs/ADR.md` §17 covers why a derived value that arrives looking like an
observed one is worse than a blank.
