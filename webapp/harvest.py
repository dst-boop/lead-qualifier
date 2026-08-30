"""Fetching public web pages, on terms the publisher has actually granted.

"Legally accessible" is not a property of a page; it is a property of a
relationship with the site. Three things decide it, and this module encodes all
three rather than leaving them to the caller's judgement:

**robots.txt.** The published, machine-readable statement of what a site permits
automated clients to fetch. Honouring it is the difference between a client and
a trespasser, and it costs one cached request per host.

**Identity.** A descriptive User-Agent naming the firm and a contact address, so
the site can see who is asking and complain to a human rather than a black hole.
This follows the SEC's stated terms, which the app already meets for EDGAR, and
generalises it: identify yourself everywhere, not only where you are told to.

**Rate.** One request per host at a time, with a floor on the interval between
them. A polite client is indistinguishable from a browser at these rates.

On top of that, a denylist. Some sites prohibit automated access in their terms
regardless of what robots.txt says — LinkedIn most relevantly, since it is where
this kind of research usually starts. Their robots.txt would not stop us; their
terms do. Encoding it here means the refusal is a property of the tool rather
than a matter of who is using it.

What this module does NOT do: crawl. It fetches a URL a person named, once.
There is no frontier, no link-following and no discovery. That is a deliberate
limit -- the difference between reading a page you were pointed at and operating
a robot over someone else's site.

read_site() reads several pages of one company site and does not change that.
It tries a fixed list of conventional paths on the single host it was given;
it never parses a page for links, never queues what it finds and never
recurses, so the set of URLs it can request is knowable before it runs. Every
one of them still goes through fetch(), and so through robots.txt, the terms
denylist and the rate limit.
"""
import asyncio
import re
import time
from typing import Optional
from urllib.parse import urlparse
from urllib.robotparser import RobotFileParser

# Sites whose terms of service prohibit automated access, whatever robots.txt
# says. Not a judgement about the data — a statement about the agreement.
DENY_HOSTS = (
    "linkedin.com", "lnkd.in",
    "facebook.com", "instagram.com", "threads.net",
    "x.com", "twitter.com",
    "glassdoor.com", "indeed.com", "ziprecruiter.com",
    "zoominfo.com",            # we have an account; the API is the front door
    "spokeo.com", "beenverified.com", "whitepages.com", "truepeoplesearch.com",
)

MAX_BYTES = 2_000_000
TIMEOUT = 20.0
MIN_INTERVAL = 1.0            # seconds between requests to one host

_robots: dict = {}
_last_hit: dict = {}
_locks: dict = {}


def host_of(url: str) -> str:
    """The hostname alone, for matching against the denylist."""
    try:
        return (urlparse(url).hostname or "").lower()
    except ValueError:
        return ""


def origin_of(url: str) -> str:
    """scheme://host:port — what robots.txt is actually published under.

    Not the hostname: robots.txt lives at the origin, so dropping the port
    sends the request to the wrong server (or nowhere), and the failure looks
    like "this host has no robots.txt" rather than "we asked the wrong door".
    It is also the right cache and rate-limit key, since two ports on one host
    are two different sites.
    """
    u = urlparse(url)
    return f"{(u.scheme or 'https').lower()}://{(u.netloc or '').lower()}"


def is_denied(url: str) -> Optional[str]:
    """A reason string when the tool refuses outright, else None."""
    h = host_of(url)
    if not h:
        return "That is not a URL I can read."
    scheme = (urlparse(url).scheme or "").lower()
    if scheme not in ("http", "https"):
        return "Only http and https addresses can be fetched."
    for bad in DENY_HOSTS:
        if h == bad or h.endswith("." + bad):
            return (f"{bad} prohibits automated access in its terms of service, "
                    f"so this app will not fetch from it. Open the page yourself "
                    f"and paste what matters.")
    # A hostname that resolves inside the network is not public data.
    if (h in ("localhost", "127.0.0.1", "0.0.0.0", "::1")
            or h.endswith(".local") or h.endswith(".internal")
            or re.match(r"^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)", h)
            or re.match(r"^\[?(::1|fc|fd)", h)):
        return "That address is not on the public internet."
    return None


def _lock(host: str) -> asyncio.Lock:
    if host not in _locks:
        _locks[host] = asyncio.Lock()
    return _locks[host]


async def robots_allows(client, url: str, agent: str) -> tuple:
    """(allowed, why). A host with no robots.txt allows everything, by convention."""
    h = origin_of(url)
    rp = _robots.get(h)
    if rp is None:
        rp = RobotFileParser()
        try:
            r = await client.get(h + "/robots.txt", timeout=10.0,
                                 headers={"User-Agent": agent},
                                 follow_redirects=True)
            if r.status_code == 200 and len(r.content) < 512_000:
                rp.parse(r.text.splitlines())
            else:
                # 404 or anything unreadable means no restrictions published.
                rp.parse([])
        except Exception:
            # Unreachable robots.txt is not permission. Refusing here is the
            # conservative reading and costs only the pages of a broken host.
            _robots[h] = False
            return False, "Could not read robots.txt for that host, so it was not fetched."
        _robots[h] = rp
    if rp is False:
        return False, "Could not read robots.txt for that host, so it was not fetched."
    try:
        ok = rp.can_fetch(agent, url)
    except Exception:
        ok = True
    return (True, "") if ok else (False, "That host's robots.txt asks automated clients not to fetch this page.")


def strip_html(html: str) -> str:
    out = re.sub(r"(?is)<(script|style|noscript|svg).*?</\1>", " ", html)
    out = re.sub(r"(?is)<br\s*/?>|</(p|div|li|tr|h[1-6])>", "\n", out)
    out = re.sub(r"(?s)<[^>]+>", " ", out)
    for a, b in (("&nbsp;", " "), ("&amp;", "&"), ("&lt;", "<"), ("&gt;", ">"),
                 ("&#39;", "'"), ("&quot;", '"'), ("&#160;", " ")):
        out = out.replace(a, b)
    out = re.sub(r"[ \t]+", " ", out)
    return re.sub(r"\n{3,}", "\n\n", out).strip()


async def fetch(client, url: str, agent: str) -> dict:
    """One page, or a refusal that says which rule stopped it."""
    why = is_denied(url)
    if why:
        return {"ok": False, "reason": why, "rule": "terms"}
    h = origin_of(url)
    async with _lock(h):
        allowed, note = await robots_allows(client, url, agent)
        if not allowed:
            return {"ok": False, "reason": note, "rule": "robots"}
        wait = MIN_INTERVAL - (time.monotonic() - _last_hit.get(h, 0))
        if wait > 0:
            await asyncio.sleep(wait)
        try:
            r = await client.get(url, timeout=TIMEOUT, follow_redirects=True,
                                 headers={"User-Agent": agent,
                                          "Accept": "text/html,text/plain,*/*"})
        except Exception as e:
            return {"ok": False, "reason": f"{type(e).__name__} fetching that page.",
                    "rule": "network"}
        finally:
            _last_hit[h] = time.monotonic()
    if r.status_code != 200:
        return {"ok": False, "reason": f"That page returned {r.status_code}.",
                "rule": "status", "status": r.status_code}
    ctype = (r.headers.get("content-type") or "").lower()
    if not any(t in ctype for t in ("text/html", "text/plain", "application/xhtml")):
        return {"ok": False, "reason": f"That is a {ctype.split(';')[0] or 'binary'} file, not a page.",
                "rule": "type"}
    body = r.content[:MAX_BYTES]
    text = strip_html(body.decode(r.encoding or "utf-8", "replace"))
    return {"ok": True, "url": str(r.url), "title": _title(body), "text": text,
            "chars": len(text), "truncated": len(r.content) > MAX_BYTES}


# ---------------------------------------------------------------- whole site

# Reading one company's site still is not crawling, and the difference is worth
# stating precisely because it is the whole basis on which this is defensible.
# A crawler discovers: it parses a page, extracts links, and follows them, so
# what it eventually fetches is decided by the site rather than by you. This
# does none of that. It tries a fixed list of conventional paths on the one host
# you named, in a fixed order, and stops. Nothing is parsed for links, nothing
# is queued, nothing recurses, and the set of URLs it can ever request is
# knowable before it runs -- it is this list.
#
# Every request still goes through fetch(), so robots.txt, the terms denylist,
# the private-address refusal and the one-per-second-per-host rate all apply
# unchanged. A site that disallows /about simply yields nothing for /about.
# Ordered by how often the page both exists and says who runs the place, not
# alphabetically: only the first MAX_SITE_TRIES are ever attempted, so a
# valuable path sitting past that cut is a path that never runs.
SITE_PATHS = (
    "/about", "/about-us", "/our-team", "/team", "/leadership",
    "/our-story", "/history", "/management",
    "/staff", "/who-we-are", "/company", "/about.html", "/our-history",
    "/meet-the-team", "/",
)

MAX_SITE_PAGES = 4          # how many pages that actually return text to keep
MAX_SITE_TRIES = 8          # how many paths to attempt before giving up


def site_root(website: str) -> Optional[str]:
    """Normalise whatever is in a 'Website' column into scheme://host.

    Vendor exports carry these as bare domains as often as URLs, and a bare
    domain parsed as a URL has no hostname at all -- it lands in the path -- so
    a missing scheme has to be supplied before anything else can be decided
    about it.
    """
    raw = (website or "").strip()
    if not raw:
        return None
    if "://" not in raw:
        raw = "https://" + raw.lstrip("/")
    try:
        u = urlparse(raw)
        host = u.hostname or ""
    except ValueError:
        return None
    # A "website" column holds plenty that is not one -- "n/a", a phone number,
    # a company name with a space in it. Requiring a dot and rejecting
    # whitespace turns those into None here rather than a doomed request later.
    if not host or " " in host or "." not in host:
        return None
    return f"{(u.scheme or 'https').lower()}://{u.netloc.lower()}"


async def read_site(client, website: str, agent: str, *,
                    paths=SITE_PATHS, max_pages: int = MAX_SITE_PAGES,
                    max_tries: int = MAX_SITE_TRIES) -> dict:
    """The pages of one company site that carry who-runs-it information.

    Returns every page that came back, plus a refusal note for the ones that
    did not, so a site that yielded nothing can be told apart from a site that
    refused -- "robots.txt disallows /team" and "there is no /team" are
    different facts about a lead, and only one is worth retrying.
    """
    root = site_root(website)
    if not root:
        return {"ok": False, "reason": "That is not a website address.",
                "rule": "terms", "pages": [], "tried": []}

    denied = is_denied(root)
    if denied:
        return {"ok": False, "reason": denied, "rule": "terms",
                "pages": [], "tried": []}

    pages, tried = [], []
    for path in paths[:max_tries]:
        if len(pages) >= max_pages:
            break
        url = root + path
        got = await fetch(client, url, agent)
        if got.get("ok"):
            # A site that answers 200 for everything -- a soft-404 SPA -- would
            # otherwise return the same shell four times over.
            if any(p["text"] == got["text"] for p in pages):
                tried.append({"url": url, "rule": "duplicate",
                              "reason": "Same page as one already read."})
                continue
            pages.append({"url": got["url"], "title": got.get("title", ""),
                          "text": got["text"], "chars": got.get("chars", 0)})
        else:
            tried.append({"url": url, "rule": got.get("rule", ""),
                          "reason": got.get("reason", "")})
            # A host that refuses on terms, or whose robots.txt cannot be read,
            # refuses identically for every other path. Asking eight times is
            # the behaviour the rate limit exists to prevent.
            if got.get("rule") in ("terms", "robots") and not pages:
                break

    return {"ok": bool(pages), "root": root, "pages": pages, "tried": tried,
            "reason": "" if pages else "No readable page found on that site."}


def _title(body: bytes) -> str:
    m = re.search(rb"(?is)<title[^>]*>(.*?)</title>", body[:200_000])
    return strip_html(m.group(1).decode("utf-8", "replace"))[:200] if m else ""
