"""The page fetcher, and what it refuses.

Most of this suite is refusals, because that is what the module is for. Fetching
a page is four lines of httpx; deciding whether you are allowed to is the part
worth writing down and the part worth testing.
"""
import asyncio, os, sys, threading, time

os.environ["NO_PROXY"] = os.environ["no_proxy"] = "127.0.0.1,localhost"
for k in ("HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"):
    os.environ.pop(k, None)
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import httpx
import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, PlainTextResponse, Response

from webapp import harvest as H

PORT = 8747
BASE = f"http://127.0.0.1:{PORT}"
HITS = []

app = FastAPI()


@app.get("/robots.txt")
async def robots():
    HITS.append("robots")
    return PlainTextResponse("User-agent: *\nDisallow: /private/\n")


@app.get("/leadership")
async def leadership():
    HITS.append("leadership")
    return HTMLResponse("<html><head><title>Leadership — Cordova</title></head><body>"
                        "<script>var x=1</script><style>p{}</style>"
                        "<h1>Leadership</h1><p>Ellen Whitfield, 61, Chief Executive Officer</p>"
                        "<p>Ray Okonjo, 58, Chief Financial Officer</p></body></html>")


@app.get("/private/secret")
async def secret():
    HITS.append("secret")
    return HTMLResponse("<p>should never be read</p>")


@app.get("/about")
async def about():
    HITS.append("about")
    return HTMLResponse("<html><head><title>About Cordova</title></head><body>"
                        "<p>Cordova Industrial has served Long Island since 1987. "
                        "Founded by Frank Delgado, still president today.</p></body></html>")


@app.get("/our-team")
async def our_team():
    HITS.append("our-team")
    return HTMLResponse("<html><head><title>Our Team</title></head><body>"
                        "<p>Frank Delgado, President. Marie Okonjo, Operations.</p>"
                        "</body></html>")


@app.get("/private/secret2")
async def secret2():
    HITS.append("secret2")
    return HTMLResponse("<p>should never be read</p>")


@app.get("/missing")
async def missing():
    return HTMLResponse("<p>gone</p>", status_code=404)


@app.get("/binary")
async def binary():
    return Response(b"%PDF-1.4 ...", media_type="application/pdf")


threading.Thread(target=lambda: uvicorn.run(app, host="127.0.0.1", port=PORT,
                                            log_level="error"), daemon=True).start()
for _ in range(60):
    try:
        if httpx.get(BASE + "/robots.txt", timeout=1).status_code == 200:
            break
    except Exception:
        time.sleep(0.1)
HITS.clear()

AGENT = "FinancialPlannersOfAmerica LeadQualifier dst@example.com"
n = bad = 0


def ck(name, cond, d=""):
    global n, bad
    n += 1
    print(("ok   " if cond else "FAIL ") + name + ("  " + str(d) if d else ""))
    if not cond:
        bad += 1


# --- refusals that need no network -------------------------------------------
for host in ("https://www.linkedin.com/in/someone", "https://linkedin.com/x",
             "https://www.facebook.com/x", "https://x.com/x", "https://twitter.com/x",
             "https://www.glassdoor.com/x", "https://www.indeed.com/x",
             "https://www.zoominfo.com/p/x", "https://www.spokeo.com/x"):
    why = H.is_denied(host)
    ck(f"refuses {H.host_of(host)}", bool(why), why)
ck("  ...saying it is the terms, not the data",
   "terms of service" in (H.is_denied("https://www.linkedin.com/in/x") or ""))
ck("  ...and suggesting what to do instead",
   "paste what matters" in (H.is_denied("https://www.linkedin.com/in/x") or ""))

ck("a subdomain of a denied host is denied too",
   bool(H.is_denied("https://business.linkedin.com/x")))
ck("a host merely containing the name is not",
   H.is_denied("https://linkedin.com.example.org/x") is None,
   H.is_denied("https://linkedin.com.example.org/x"))

for bad_url in ("http://localhost/x", "http://127.0.0.1:8099/api/me",
                "http://192.168.1.5/x", "http://10.0.0.1/x", "http://169.254.169.254/latest/meta-data",
                "http://thing.internal/x"):
    ck(f"refuses the private address {bad_url.split('/')[2]}", bool(H.is_denied(bad_url)))
ck("  ...calling it not public", "public internet" in (H.is_denied("http://10.0.0.1/x") or ""))

ck("refuses a file:// url", bool(H.is_denied("file:///etc/passwd")))
ck("refuses a data: url", bool(H.is_denied("data:text/html,<p>x")))
ck("refuses nonsense", bool(H.is_denied("not a url")))
ck("allows an ordinary company page", H.is_denied("https://www.boeing.com/company/leadership") is None)

# --- site_root: a "Website" column is not a column of URLs ---------------------
for raw, want in (("acme.com", "https://acme.com"),
                  ("www.acme.com", "https://www.acme.com"),
                  ("https://acme.com/about?x=1", "https://acme.com"),
                  ("HTTP://ACME.COM", "http://acme.com")):
    ck(f"site_root({raw!r})", H.site_root(raw) == want, H.site_root(raw))
for junk in ("", "   ", "n/a", "5165551234", "not a url", "localhost"):
    ck(f"site_root refuses {junk!r}", H.site_root(junk) is None, H.site_root(junk))

ck("the paths actually tried include the leadership page",
   "/leadership" in H.SITE_PATHS[:H.MAX_SITE_TRIES], H.SITE_PATHS[:H.MAX_SITE_TRIES])
ck("  ...and the list is finite and knowable before it runs",
   len(H.SITE_PATHS) < 20 and all(p.startswith("/") for p in H.SITE_PATHS))


async def main():
    global n, bad
    # The private-address guard blocks the loopback stub, which is exactly
    # right in shipped code and makes the fetch mechanics untestable. Rather
    # than weakening the guard with a flag nothing in the app would set, the
    # refusals above exercise the real is_denied() and the mechanics below run
    # against a wrapper that waves through this one test host. The denylist is
    # re-checked through fetch() afterwards to prove the wrapper did not
    # disable it.
    real_denied = H.is_denied
    H.is_denied = lambda url: None if url.startswith(BASE) else real_denied(url)
    async with httpx.AsyncClient() as cx:
        got = await H.fetch(cx, BASE + "/leadership", AGENT)
        ck("a permitted page is fetched", got.get("ok") is True, got.get("reason"))
        ck("  ...robots.txt was read first", "robots" in HITS, HITS)
        ck("  ...the title comes back", got.get("title") == "Leadership — Cordova", got.get("title"))
        ck("  ...script and style are stripped",
           "var x=1" not in got["text"] and "p{}" not in got["text"], got["text"][:80])
        ck("  ...and the text survives",
           "Ellen Whitfield, 61, Chief Executive Officer" in got["text"], got["text"][:120])

        HITS.clear()
        blocked = await H.fetch(cx, BASE + "/private/secret", AGENT)
        ck("a path robots.txt disallows is refused", blocked.get("ok") is False, blocked)
        ck("  ...naming robots.txt as the reason", blocked.get("rule") == "robots", blocked.get("rule"))
        ck("  ...and the page was never requested", "secret" not in HITS, HITS)

        ck("robots.txt is cached, not refetched per page", HITS.count("robots") == 0, HITS)

        m = await H.fetch(cx, BASE + "/missing", AGENT)
        ck("a 404 is reported as a 404", m.get("ok") is False and m.get("status") == 404, m)
        b2 = await H.fetch(cx, BASE + "/binary", AGENT)
        ck("a PDF is refused as not-a-page", b2.get("ok") is False and b2.get("rule") == "type", b2)

        d = await H.fetch(cx, "https://www.linkedin.com/in/x", AGENT)
        ck("the denylist is enforced in fetch, not only in the check",
           d.get("ok") is False and d.get("rule") == "terms", d.get("rule"))

        # rate limiting
        H._last_hit.clear()
        t0 = time.monotonic()
        await H.fetch(cx, BASE + "/leadership", AGENT)
        await H.fetch(cx, BASE + "/leadership", AGENT)
        ck("two hits on one host are spaced out",
           time.monotonic() - t0 >= H.MIN_INTERVAL, f"{time.monotonic()-t0:.2f}s")

        # A host whose robots.txt cannot be read. It has to be a public-looking
        # address, or the private-address guard answers first and the robots
        # path is never reached — which is how this check passed for the wrong
        # reason the first time it was written.
        H._robots.clear()
        unreachable = await H.fetch(cx, "https://no-such-host.invalid/x", AGENT)
        ck("an unreadable robots.txt means no, not yes",
           unreachable.get("ok") is False, unreachable)
        ck("  ...and it is the robots rule that refused, not the address guard",
           unreachable.get("rule") == "robots", unreachable.get("rule"))

    # --- read_site: several pages of one site, still not a crawl -------------
    async with httpx.AsyncClient() as cx:
        H._last_hit.clear()
        HITS.clear()
        site = await H.read_site(cx, BASE, AGENT, max_pages=2, max_tries=6)
        ck("a company site yields pages", site.get("ok") is True, site.get("reason"))
        urls = [p["url"] for p in site["pages"]]
        ck("  ...the about page among them", any(u.endswith("/about") for u in urls), urls)
        ck("  ...stopping at max_pages", len(site["pages"]) == 2, urls)
        ck("  ...and reporting the paths that came back empty",
           any(t["rule"] == "status" for t in site["tried"]), site["tried"])

        ck("no link on any page was followed",
           all(any(u.endswith(p) for p in H.SITE_PATHS) for u in urls), urls)
        ck("  ...and nothing outside the named host was requested",
           all(u.startswith(BASE) for u in urls), urls)

        HITS.clear()
        H._last_hit.clear()
        blocked = await H.read_site(cx, BASE, AGENT,
                                    paths=("/private/secret2",), max_tries=1)
        ck("robots.txt still refuses inside read_site", blocked.get("ok") is False, blocked)
        ck("  ...and that page was never requested", "secret2" not in HITS, HITS)

        denied = await H.read_site(cx, "https://www.linkedin.com", AGENT)
        ck("the terms denylist still refuses a whole site",
           denied.get("ok") is False and denied.get("rule") == "terms", denied.get("rule"))
        ck("  ...before any request is made", denied["tried"] == [], denied["tried"])

        junk = await H.read_site(cx, "n/a", AGENT)
        ck("a junk website value is refused, not requested",
           junk.get("ok") is False and junk["tried"] == [], junk)

        H._last_hit.clear()
        dupe = await H.read_site(cx, BASE, AGENT,
                                 paths=("/about", "/about", "/our-team"), max_tries=3)
        ck("the same page twice is kept once",
           len(dupe["pages"]) == 2, [p["url"] for p in dupe["pages"]])
        ck("  ...and the repeat is reported as a duplicate",
           any(t["rule"] == "duplicate" for t in dupe["tried"]), dupe["tried"])

    print()
    print(f"FAILURES {bad} of {n}" if bad else f"all {n} checks passed")
    sys.exit(1 if bad else 0)


asyncio.run(main())
