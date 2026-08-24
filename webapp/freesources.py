"""Free public records about a person, from sources with real APIs.

"Use free resources better" has a constraint the paid sources don't: every
free source that knows a lot about a person (the people-search sites) forbids
scraping in its terms, and harvest.py's deny list already refuses them. What
is left is the data the government publishes because the law says it must:

- **FEC individual contributions.** Anyone who gives a campaign more than
  $200 is itemised: name, city, state, ZIP, and — because the form requires
  it — employer and occupation, self-reported at the moment of the gift.
  Free JSON API. As prospecting data it is three things at once: an address
  a person used as *home*, an employer confirmation dated to the gift, and a
  discretionary-money signal.
- **SEC insider filings (Forms 3/4/5).** Every officer, director and 10%
  holder of a public company files them. A person who appears here holds
  equity compensation — concentrated stock is the classic rollover-adjacent
  conversation. Free, keyless, needs only the User-Agent the app already
  sends to EDGAR.

Both parsers here were written without a live response in front of them: the
build environment's egress proxy blocks both hosts, though the deployed app
reaches EDGAR daily. That is the exact condition under which this app has
been wrong five times (ADR §12, §25), so the same defences apply — every
reader takes a list of plausible key spellings, absence is a value, and
main.py exposes a census endpoint so one production response settles what
the documentation could not.
"""
import re
from typing import Optional

from webapp.signals import norm_company

# The JSON API's names first, the bulk-file names second — the wiki documents
# the latter and the API serves the former, and a response will carry one set.
_F = {
    "name":       ("contributor_name", "contbr_nm"),
    "first":      ("contributor_first_name",),
    "last":       ("contributor_last_name",),
    "city":       ("contributor_city", "contbr_city"),
    "state":      ("contributor_state", "contbr_st"),
    "zip":        ("contributor_zip", "contbr_zip"),
    "employer":   ("contributor_employer", "contbr_employer"),
    "occupation": ("contributor_occupation", "contbr_occupation"),
    "amount":     ("contribution_receipt_amount", "contb_receipt_amt"),
    "date":       ("contribution_receipt_date", "contb_receipt_dt"),
}


def _first(d: dict, keys) -> Optional[object]:
    for k in keys:
        v = d.get(k)
        if v not in (None, ""):
            return v
    return None


def _amount(v) -> Optional[float]:
    try:
        f = float(re.sub(r"[^0-9.\-]", "", str(v)))
        return f if f == f else None
    except (TypeError, ValueError):
        return None


def _day(v) -> str:
    """YYYY-MM-DD out of whatever date spelling arrives, or ""."""
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})", str(v or ""))
    return m.group(0) if m else ""


def fec_rows(payload) -> list:
    """Normalised contribution rows out of a schedule_a response."""
    if not isinstance(payload, dict):
        return []
    results = payload.get("results")
    if not isinstance(results, list):
        return []
    out = []
    for r in results:
        if not isinstance(r, dict):
            continue
        committee = r.get("committee") if isinstance(r.get("committee"), dict) else {}
        out.append({
            "name": str(_first(r, _F["name"]) or ""),
            "city": str(_first(r, _F["city"]) or "").title(),
            "state": str(_first(r, _F["state"]) or "").upper()[:2],
            "zip": str(_first(r, _F["zip"]) or "")[:5],
            "employer": str(_first(r, _F["employer"]) or ""),
            "occupation": str(_first(r, _F["occupation"]) or ""),
            "amount": _amount(_first(r, _F["amount"])),
            "date": _day(_first(r, _F["date"])),
            "committee": str((committee.get("name") if committee else "") or ""),
        })
    return out


def match_rows(rows: list, last_name: str, first_name: str = "") -> list:
    """Only rows that are plausibly this person.

    The search endpoint matches loosely, and a donation by a different person
    with a similar name, attributed to a lead, is the Portland-realtor failure
    all over again — worse here, because a dollar figure looks looked-up. The
    surname must appear in the contributor name; a first name, when we have
    one, must match at least by initial (FEC names arrive as "LAST, FIRST" as
    often as "First Last", so the test is presence, not position).

    Deliberately NOT filtered by the lead's state: the lead row usually holds
    the employer's address, and people donate from home. Where the donations
    come from is evidence to show, not a reason to discard them.
    """
    ln = (last_name or "").strip().lower()
    fn = (first_name or "").strip().lower()
    if not ln:
        return []
    out = []
    for r in rows:
        nm = r["name"].lower()
        if ln not in nm:
            continue
        if fn and fn not in nm and not re.search(r"\b" + re.escape(fn[0]) + r"\b|\b" + re.escape(fn[:3]), nm):
            continue
        out.append(r)
    return out


def _ranked(pairs: dict) -> list:
    """[{value, n, last}] most-recent-last-seen first, then most seen."""
    out = [{"value": k, "n": v["n"], "last": v["last"]} for k, v in pairs.items()]
    out.sort(key=lambda x: (x["last"], x["n"]), reverse=True)
    return out


def summarize_fec(rows: list, lead_employer: str = "") -> dict:
    """What the matched donations say, with nothing invented.

    Employers and occupations are self-reported at the moment of each gift and
    are kept with their dates, because the point is the timeline: an employer
    on a 2018 gift and a different one on a 2025 gift is a job change the list
    may not know about — and a job change is money in motion.
    """
    if not rows:
        return {}
    total = sum(r["amount"] for r in rows if r["amount"])
    dates = sorted(d for d in (r["date"] for r in rows) if d)
    employers, occupations, places = {}, {}, {}
    for r in rows:
        for field, bucket in (("employer", employers), ("occupation", occupations)):
            v = r[field].strip()
            if not v or v.lower() in ("none", "n/a", "not employed", "retired",
                                      "information requested"):
                # "Retired" is the exception worth keeping — see below.
                if v.strip().lower() == "retired":
                    bucket.setdefault("RETIRED", {"n": 0, "last": ""})
                    bucket["RETIRED"]["n"] += 1
                    bucket["RETIRED"]["last"] = max(bucket["RETIRED"]["last"], r["date"])
                continue
            key = v.upper()
            bucket.setdefault(key, {"n": 0, "last": ""})
            bucket[key]["n"] += 1
            bucket[key]["last"] = max(bucket[key]["last"], r["date"])
        if r["city"] and r["state"]:
            key = f"{r['city']}, {r['state']}"
            places.setdefault(key, {"n": 0, "last": ""})
            places[key]["n"] += 1
            places[key]["last"] = max(places[key]["last"], r["date"])
    want = norm_company(lead_employer or "")
    employer_match = None
    if want and employers:
        employer_match = any(norm_company(e) == want for e in employers
                             if e != "RETIRED")
    biggest = max((r["amount"] for r in rows if r["amount"]), default=None)
    return {
        "count": len(rows),
        "total": round(total, 2),
        "biggest": biggest,
        "first": dates[0] if dates else "",
        "latest": dates[-1] if dates else "",
        "employers": _ranked(employers),
        "occupations": _ranked(occupations),
        "places": _ranked(places),
        # None when the lead has no employer or no donation named one — a
        # comparison that never ran is not a mismatch.
        "employer_match": employer_match,
        # A gift reported as "retired" is its own signal: the person told a
        # federal form they are retired, dated. For a rollover conversation
        # that is not a disqualifier, it is the event having already happened.
        "says_retired": "RETIRED" in employers,
    }


def efts_hits(payload) -> list:
    """Filing hits out of an EDGAR full-text-search response.

    The response is Elasticsearch-shaped: hits.hits[]._source. The _source
    field names come from the FTS FAQ and observed client libraries, read
    defensively like everything else in this file.
    """
    if not isinstance(payload, dict):
        return []
    hits = payload.get("hits")
    if isinstance(hits, dict):
        hits = hits.get("hits")
    if not isinstance(hits, list):
        return []
    out = []
    for h in hits:
        if not isinstance(h, dict):
            continue
        src = h.get("_source") if isinstance(h.get("_source"), dict) else h
        names = src.get("display_names")
        if isinstance(names, str):
            names = [names]
        names = [n for n in (names or []) if isinstance(n, str)]
        form = str(_first(src, ("root_form", "root_forms", "file_type", "form")) or "")
        if isinstance(src.get("root_forms"), list) and src["root_forms"]:
            form = str(src["root_forms"][0])
        ciks = src.get("ciks")
        cik = str(ciks[0]) if isinstance(ciks, list) and ciks else str(src.get("cik") or "")
        adsh = str(_first(src, ("adsh", "accession_no", "accession_number")) or
                   str(h.get("_id") or "").split(":")[0])
        out.append({
            "form": form,
            "date": _day(_first(src, ("file_date", "filed", "filing_date"))),
            "names": names,
            "cik": cik.lstrip("0") or cik,
            "adsh": adsh,
        })
    return out


def match_filings(hits: list, last_name: str, first_name: str = "") -> list:
    """Filings whose named parties plausibly include this person.

    An insider filing names both the company and the reporting person in
    display_names. Requiring the surname there — not merely in the matched
    text — keeps "the lead's name appeared in some 8-K's prose" out of a list
    labelled insider filings.
    """
    ln = (last_name or "").strip().lower()
    fn = (first_name or "").strip().lower()
    if not ln:
        return []
    out = []
    for h in hits:
        joined = " | ".join(h["names"]).lower()
        if ln not in joined:
            continue
        if fn and fn[:3] not in joined:
            continue
        person = next((n for n in h["names"] if ln in n.lower()), "")
        company = next((n for n in h["names"] if ln not in n.lower()), "")
        url = ""
        if h["cik"] and h["adsh"]:
            plain = h["adsh"].replace("-", "")
            url = (f"https://www.sec.gov/Archives/edgar/data/"
                   f"{h['cik']}/{plain}/{h['adsh']}-index.htm")
        out.append({"form": h["form"], "date": h["date"], "person": person,
                    "company": company, "url": url})
    return out
