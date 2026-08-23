"""Money-in-motion signals for leads already on a list.

The rest of the app finds people. This watches the ones already found, and says
when something happens that makes their retirement money movable.

Four kinds of event, ordered by how reliable they are:

1. **Turning 59½.** The only one that can be known before it happens, with
   certainty, for free. It is a date, not a search: given a birth date it is
   arithmetic, and given an inferred age it is arithmetic with an error bar.
   Nothing else in prospecting is this clean.
2. **Their employer files a WARN notice.** A dated mass separation at the
   company they work for. Free, public, and 60 days ahead of the event.
3. **Their employer files an 8-K reporting an officer departure.** Item 5.02
   is a required disclosure. Free, public, and same-day.
4. **Tenure crossing the in-service threshold.** Arithmetic again.

Everything here is computed from data the app already holds plus free public
feeds. No signal is invented: each one carries what it was derived from, and a
signal derived from an inferred age says so.
"""
import hashlib
import re
import time
from typing import Optional

SELL_AGE = 59.5
DAY = 86400.0

# How far ahead a birthday is worth surfacing. Ninety days is roughly a
# quarter's planning horizon: long enough to build a relationship before the
# money is movable, short enough that the list is not padded with 2029.
AGE_HORIZON_DAYS = 90

_SUFFIXES = ("incorporated", "corporation", "company", "holdings", "group",
             "enterprises", "industries", "international", "worldwide",
             "inc", "corp", "co", "llc", "lp", "llp", "plc", "ltd", "limited",
             "usa", "us", "the")


def norm_company(s: str) -> str:
    """Company names for comparison. 'The Boeing Company, Inc.' -> 'boeing'.

    Deliberately identical in behaviour to prospecting.norm_company: a WARN
    event matched to an employer here and priced there must agree on what
    counts as the same company, or the two halves disagree about one lead.
    """
    words = re.sub(r"[^a-z0-9&]+", " ", (s or "").lower()).split()
    merged, run = [], []
    for w in words:
        if len(w) == 1:
            run.append(w)
            continue
        if run:
            merged.append("".join(run))
            run = []
        merged.append(w)
    if run:
        merged.append("".join(run))
    kept = [w for w in merged if w not in _SUFFIXES]
    return " ".join(kept or merged)


def _sig_id(lead_id: str, kind: str, token: str) -> str:
    """Stable across runs, so 'new since you last looked' means something."""
    raw = f"{lead_id}|{kind}|{token}"
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]


def _num(v) -> Optional[float]:
    try:
        f = float(re.sub(r"[^0-9.\-]", "", str(v)))
        return f if f == f else None
    except (TypeError, ValueError):
        return None


def _age_now(lead: dict) -> tuple:
    """(age, basis, confirmed) using the same precedence the UI shows."""
    edgar = (lead.get("edgar") or {})
    if _num(edgar.get("age")):
        return _num(edgar["age"]), f"SEC filing {edgar.get('asOf') or ''}".strip(), True
    hd = (lead.get("hd") or {})
    if _num(hd.get("age")):
        return _num(hd["age"]), "public record", True
    # Inferred, exactly as the app infers it elsewhere: start of working life
    # plus an assumed start age. Marked unconfirmed so the signal can say so.
    now_year = time.gmtime().tm_year
    stated = _num(lead.get("yearsExperience"))
    grad = _num(lead.get("gradYear"))
    first = _num(lead.get("firstJobYear"))
    if stated and stated > 0:
        return stated + 22, f"{stated:.0f} yrs experience + 22", False
    starts = [y for y in (grad, first) if y and 1900 < y <= now_year]
    if starts:
        y = min(starts)
        return (now_year - y) + 22, f"started {y:.0f} + 22", False
    return None, "", False


def age_signal(lead: dict, now: float = None) -> Optional[dict]:
    """Approaching, or newly past, the in-service distribution age."""
    now = now or time.time()
    age, basis, confirmed = _age_now(lead)
    if age is None:
        return None
    years_to = SELL_AGE - age
    days_to = years_to * 365.25
    if days_to > AGE_HORIZON_DAYS:
        return None
    # Someone who passed 59½ years ago is not an event; they are a standing
    # fact the badge already shows. Only the recent crossing is news.
    if days_to < -365:
        return None
    when = "reached" if days_to <= 0 else "approaching"
    token = f"{int(age * 2)}"          # half-year buckets: fires once per crossing
    return {
        "id": _sig_id(lead.get("id") or "", "age", token),
        "lead_id": lead.get("id"),
        "kind": "age",
        "urgency": 1 if days_to <= 0 else 2,
        "days": int(round(days_to)),
        "confirmed": confirmed,
        "headline": (f"Past 59½ — an in-service distribution is available now"
                     if days_to <= 0 else
                     f"Turns 59½ in about {max(1, int(round(days_to)))} days"),
        "detail": f"Age {age:.0f} ({basis})" + ("" if confirmed else " — inferred, worth confirming"),
        "source": "age on file",
    }


def tenure_signal(lead: dict, min_years: float = 18.0, now: float = None) -> Optional[dict]:
    """Long enough at one employer for the balance to be worth a call."""
    now = now or time.time()
    yrs = _num(lead.get("yearsAtEmployer"))
    if yrs is None:
        start = lead.get("jobStartDate") or ""
        m = re.match(r"^(\d{4})", str(start))
        if not m:
            return None
        yrs = (now - time.mktime((int(m.group(1)), 1, 1, 0, 0, 0, 0, 1, 0))) / (DAY * 365.25)
    if yrs is None or yrs < min_years or yrs > 50:
        return None
    # Only the crossing year is news; a 30-year veteran is not a new event
    # every time the page loads.
    if yrs - min_years > 1.0:
        return None
    return {
        "id": _sig_id(lead.get("id") or "", "tenure", f"{int(min_years)}"),
        "lead_id": lead.get("id"),
        "kind": "tenure",
        "urgency": 3,
        "days": 0,
        "confirmed": True,
        "headline": f"Just passed {min_years:.0f} years at {lead.get('employer') or 'their employer'}",
        "detail": f"{yrs:.0f} years of contributions in one plan",
        "source": "position start date",
    }


def warn_signal(lead: dict, by_employer: dict, now: float = None) -> Optional[dict]:
    """Their employer has filed a mass-separation notice."""
    key = norm_company(lead.get("employer") or "")
    if not key:
        return None
    ev = by_employer.get(key)
    if not ev:
        return None
    return {
        "id": _sig_id(lead.get("id") or "", "warn", ev.get("id") or key),
        "lead_id": lead.get("id"),
        "kind": "warn",
        "urgency": 0,
        "days": ev.get("days_until"),
        "confirmed": True,
        "headline": f"{lead.get('employer')} filed a WARN notice"
                    + (f" — {ev['workers']} people" if ev.get("workers") else ""),
        "detail": (f"Effective {ev.get('effective_date') or 'shortly'}"
                   + (f", {ev.get('city')}, {ev.get('state')}" if ev.get("city") else "")
                   + (f". Plan average {int(ev['avg_balance']):,} per head."
                      if ev.get("avg_balance") else "")),
        "source": "state WARN notice",
    }


# Titles that could plausibly be the subject of an item 5.02. The filing
# concerns one named officer, so firing it at everyone who works there is a
# false positive — and a watchlist that cries wolf is one nobody reads.
_OFFICER_WORDS = ("chief", "ceo", "cfo", "coo", "cio", "cto", "cmo", "president",
                  "executive vice", "evp", "senior vice", "svp", "general counsel",
                  "treasurer", "controller", "director of the board", "board member",
                  "chairman", "chair")


def _is_officer(lead: dict) -> bool:
    txt = f"{lead.get('title') or ''} {lead.get('mgmtLevel') or ''}".lower()
    return any(w in txt for w in _OFFICER_WORDS)


def filing_signal(lead: dict, by_employer: dict) -> Optional[dict]:
    """Their employer filed an 8-K reporting an officer departure (item 5.02).

    Fires two ways, and never as a blanket employer event. If the filing names
    the lead, this is the strongest signal the app can produce: a dated,
    legally required disclosure that this specific person's employment is
    ending. Otherwise it is offered to officers of that company as something
    that *may* concern them, and to nobody else — an item 5.02 is about one
    named person, so a manager two levels down learns nothing from it.
    """
    key = norm_company(lead.get("employer") or "")
    if not key:
        return None
    f = by_employer.get(key)
    if not f:
        return None
    summary = (f.get("summary") or "")
    last = (lead.get("lastName") or "").strip()
    named = bool(last) and len(last) > 2 and re.search(
        r"\b" + re.escape(last) + r"\b", summary, re.I) is not None
    if not named and not _is_officer(lead):
        return None
    return {
        "id": _sig_id(lead.get("id") or "", "filing", f.get("accession") or ""),
        "lead_id": lead.get("id"),
        "kind": "filing",
        "urgency": 0 if named else 2,
        "days": f.get("days_ago"),
        "confirmed": named,
        "headline": (f"Named in an 8-K officer departure at {lead.get('employer')}"
                     if named else
                     f"{lead.get('employer')} filed an 8-K on an officer departure"),
        "detail": (summary or "Item 5.02 — departure or election of directors and "
                   "principal officers")[:300]
                  + ("" if named else " — may or may not concern this lead"),
        "source": f.get("url") or "SEC EDGAR",
    }


def build_signals(leads: list, warn_by_employer: dict = None,
                  filings_by_employer: dict = None, min_tenure: float = 18.0,
                  now: float = None, seen: set = None) -> list:
    """Every signal across a list, most urgent first.

    A lead already marked Not Interested or Has Advisor is skipped: an event
    about someone who has said no is not an opportunity, and a queue that
    includes them stops being read.
    """
    now = now or time.time()
    seen = seen or set()
    warn_by_employer = warn_by_employer or {}
    filings_by_employer = filings_by_employer or {}
    out = []
    for L in leads:
        if (L.get("status") or "") in ("Not Interested", "Has Advisor"):
            continue
        for s in (age_signal(L, now),
                  warn_signal(L, warn_by_employer, now),
                  filing_signal(L, filings_by_employer),
                  tenure_signal(L, min_tenure, now)):
            if not s:
                continue
            s["name"] = f"{L.get('firstName') or ''} {L.get('lastName') or ''}".strip()
            s["employer"] = L.get("employer") or ""
            s["tier"] = L.get("tier") or ""
            s["new"] = s["id"] not in seen
            out.append(s)
    out.sort(key=lambda s: (s["urgency"], not s["new"], s.get("days") if s.get("days") is not None else 9999))
    return out


def index_warn(events: list) -> dict:
    """WARN opportunities keyed by normalised employer, soonest first."""
    by = {}
    for e in events or []:
        key = norm_company(e.get("employer") or "")
        if not key:
            continue
        cur = by.get(key)
        if cur is None or (e.get("days_until") is not None
                           and (cur.get("days_until") is None
                                or e["days_until"] < cur["days_until"])):
            by[key] = e
    return by
