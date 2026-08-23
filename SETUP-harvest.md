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
