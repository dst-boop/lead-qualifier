"""Money-in-motion discovery from public event data.

The rest of this app scores a list somebody else built. This module finds the
events that create the list.

Two federal sources carry the whole idea:

  WARN notices   employers must give 60 days' notice of a mass layoff. Every
                 state publishes them: employer, location, headcount, date.
  Form 5500      every employer retirement plan files one annually with the DOL.
                 Public and bulk-downloadable: plan assets and participant count.

Joined, they answer a question no vendor sells: *how many dollars of 401(k) are
about to come loose at a named employer, on a known date.* Both are free, and
both are published deliberately rather than merely reachable.

Nothing here is hard-coded to one state's column names. Feeds are declared in
FEEDS (override with WARN_FEEDS), and columns are matched the way the CSV
importer matches them — by normalised header, refusing to guess.
"""
from __future__ import annotations

import csv
import io
import re
import zipfile
from datetime import date, datetime
from typing import Iterable, Optional

# ---------------------------------------------------------------- normalising

# Listed without punctuation because punctuation is stripped first — otherwise
# "A.B.C. Co." and "ABC Co" normalise differently and never join.
_SUFFIXES = ("incorporated", "corporation", "company", "holdings", "group",
             "enterprises", "industries", "international", "worldwide",
             "inc", "corp", "co", "llc", "lp", "llp", "plc", "ltd", "limited",
             "usa", "us", "the")


def norm_company(s: str) -> str:
    """Company names for comparison. 'The Boeing Company, Inc.' -> 'boeing'."""
    words = re.sub(r"[^a-z0-9&]+", " ", (s or "").lower()).split()
    # Stripping the dots out of "J.P. Morgan" leaves "j p morgan", which would
    # never join to "JP Morgan" from the other source. Runs of single characters
    # are an initialism; put them back together.
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
    # A name made entirely of suffix words ("The Company") keeps its words rather
    # than becoming empty, which would join it to every other empty key.
    return " ".join(kept or merged)


# A county is written a dozen ways across feeds and inside one feed: "Nassau",
# "Nassau County", "NASSAU CO.", "Suffolk Parish". Compare on the bare name.
_COUNTY_WORDS = ("county", "counties", "co", "parish", "borough", "boro")


def norm_county(s: str) -> str:
    """County names for comparison. 'Nassau County' -> 'nassau'."""
    words = re.sub(r"[^a-z0-9]+", " ", (s or "").lower()).split()
    while words and words[-1] in _COUNTY_WORDS:
        words.pop()
    # "Prince George's" and "St. Lawrence" survive; a name that is only the word
    # "county" keeps it rather than becoming empty and matching everything.
    return " ".join(words) if words else " ".join(
        re.sub(r"[^a-z0-9]+", " ", (s or "").lower()).split())


def norm_header(h: str) -> str:
    return " ".join(re.sub(r"[^a-z0-9]+", " ", (h or "").lower()).split())


def pick_column(headers: list[str], aliases: Iterable[str]) -> Optional[int]:
    """Index of the first header matching an alias, exact before partial.

    Same two-pass, no-double-claim shape as the CSV importer, and for the same
    reason: a loose match on one column silently steals another's data.
    """
    low = [norm_header(h) for h in headers]
    want = [norm_header(a) for a in aliases]
    for a in want:
        if a in low:
            return low.index(a)
    for a in want:
        for i, h in enumerate(low):
            if a and (h.startswith(a + " ") or h.endswith(" " + a) or (" " + a + " ") in (" " + h + " ")):
                return i
    return None


def to_int(v) -> Optional[int]:
    m = re.search(r"-?\d[\d,]*", str(v or ""))
    if not m:
        return None
    try:
        return int(m.group(0).replace(",", ""))
    except ValueError:
        return None


def to_money(v) -> Optional[float]:
    m = re.search(r"-?\d[\d,]*(\.\d+)?", str(v or ""))
    if not m:
        return None
    try:
        return float(m.group(0).replace(",", ""))
    except ValueError:
        return None


_DATE_FORMATS = ("%Y-%m-%d", "%m/%d/%Y", "%m/%d/%y", "%d-%b-%Y", "%B %d, %Y",
                 "%b %d, %Y", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M:%S.%f")


def to_date(v) -> Optional[str]:
    """ISO date, or None. States format these every way imaginable."""
    t = str(v or "").strip()
    if not t:
        return None
    t = t.split("T")[0] if re.match(r"^\d{4}-\d{2}-\d{2}T", t) else t
    for fmt in _DATE_FORMATS:
        try:
            return datetime.strptime(t, fmt).date().isoformat()
        except ValueError:
            continue
    m = re.search(r"(\d{4})-(\d{2})-(\d{2})", t)
    return f"{m.group(1)}-{m.group(2)}-{m.group(3)}" if m else None


# ---------------------------------------------------------------- WARN feeds
# Column names differ by state, so each feed declares nothing but a URL and a
# format; the columns are matched by alias. A state that renames a column keeps
# working, and one that cannot be matched reports which field failed rather than
# importing blanks.

WARN_ALIASES = {
    "employer": ["company", "employer", "company name", "employer name",
                 "business name", "organization", "name of company"],
    "city": ["city", "location", "city name", "site city"],
    "state": ["state", "st", "state code"],
    "county": ["county", "region", "area"],
    "workers": ["number of employees affected", "employees affected", "affected employees",
                "number affected", "workers affected", "number of workers",
                "employees", "workers", "total employees", "impacted workers"],
    "effective_date": ["layoff date", "effective date", "separation date",
                       "layoff begin date", "closing date", "date of layoff",
                       "effective layoff date", "planned starting date"],
    "notice_date": ["notice date", "received date", "date received", "warn date",
                    "date of notice", "notice received"],
    "reason": ["reason", "closure or layoff", "type", "notice type", "layoff type"],
}

# Feeds default to nothing: a wrong guessed URL that silently 404s is worse than
# an empty list, and the deployment can point these anywhere.
FEEDS: list[dict] = []


# Columns to try for the effective date, in order, when the first one does not
# yield a date. New York files "Layoff Date" as prose — "Separations will occur
# on May 12, 2021 or during the 14-day period beginning on that date" — and puts
# the actual date in "Closing Date". A null effective date is not a cosmetic
# loss: it is the field the whole sixty-days-early premise rests on.
DATE_FALLBACKS = ["closing date", "layoff date", "effective date", "separation date",
                  "last day of work", "planned starting date", "date of layoff"]

# An employer cell that carries the address with it. NY writes
# "Acitrezza, LLC (Agata & Valentina store) 64 University Place New York, NY 10003",
# and normalising that produces a key no Form 5500 sponsor will ever match, so
# the WARN half and the plan half silently stop joining.
_ADDR_CUT = re.compile(
    r"\s+\d{1,6}[A-Za-z]?\s+(?=[A-Z0-9])"        # " 64 University Place"
    r"|\s+(?:P\.?O\.?\s*Box|One|Two|Three)\s+\d*\s*[A-Z]"
    r"|\s{2,}"                                     # runs of space, often a line break
    r"|\n", re.I)


def company_from_cell(cell: str) -> str:
    """The company name out of a cell that may have an address glued to it.

    Conservative: it only cuts where a street address plainly begins, and if
    that would leave nothing it keeps the original. A name that is merely long
    is left alone — over-trimming would break the join in the other direction.
    """
    t = (cell or "").strip()
    if not t:
        return ""
    m = _ADDR_CUT.search(t)
    head = t[:m.start()].strip(" ,;-") if m else t
    return head if len(head) >= 3 else t


_PROSE_DATE = re.compile(
    r"\b(\d{1,2}/\d{1,2}/\d{2,4}|[A-Z][a-z]+\s+\d{1,2},\s*\d{4})\b")


def date_from_prose(text: str) -> tuple:
    """(date, note) from a sentence, but only when it names exactly one date.

    New York's date columns are often prose: "A total of 198 employees that were
    furloughed on 3/22/2020 have been permanently separated effective 2/11/2021",
    or "postponed from 1/29/2021 - 2/12/2021 to 3/17/2021 - 3/31/2021". The first
    has one meaning; the second has four dates and no rule picks the right one
    without guessing.

    So: one date, use it. More than one, refuse and hand the sentence back for a
    person to read. A wrong effective date is not a smaller version of a missing
    one — it drives a countdown on a real call, and the advisor has no way to
    tell it was invented.
    """
    t = (text or "").strip()
    if not t:
        return None, ""
    found = []
    for m in _PROSE_DATE.findall(t):
        d = to_date(m)
        if d and d not in found:
            found.append(d)
    if len(found) == 1:
        return found[0], ""
    return None, (t[:300] if found else "")


def parse_warn_csv(text: str, default_state: str = "") -> dict:
    """WARN rows out of a CSV, plus what the matcher did with the columns."""
    rows = list(csv.reader(io.StringIO(text)))
    if len(rows) < 2:
        return {"events": [], "headers": rows[0] if rows else [], "mapped": {}, "unmapped": []}
    headers = [h.strip() for h in rows[0]]
    idx = {k: pick_column(headers, al) for k, al in WARN_ALIASES.items()}
    events, unmapped = [], [k for k, v in idx.items() if v is None]

    def cell(row, key):
        i = idx.get(key)
        return row[i].strip() if i is not None and i < len(row) else ""

    # Every column that might carry a usable date, in preference order, so a
    # prose "Layoff Date" can defer to a real "Closing Date".
    date_cols = [i for i in (pick_column(headers, [a]) for a in DATE_FALLBACKS)
                 if i is not None]
    if idx.get("effective_date") is not None:
        date_cols = [idx["effective_date"]] + [i for i in date_cols if i != idx["effective_date"]]

    for row in rows[1:]:
        if not any(c.strip() for c in row):
            continue
        raw = cell(row, "employer")
        if not raw:
            continue
        eff, note = None, ""
        for i in date_cols:
            if i < len(row):
                eff = to_date(row[i].strip())
                if eff:
                    break
        if not eff:
            # Nothing parsed as a date, so try reading it out of the sentence.
            for i in date_cols:
                if i < len(row):
                    eff, note = date_from_prose(row[i])
                    if eff or note:
                        break
        employer = company_from_cell(raw)
        events.append({
            "employer": employer,
            # The original is kept: it carries the address, which is the only
            # location this file gives when there is no city column.
            "employer_raw": raw if raw != employer else "",
            "employer_key": norm_company(employer),
            "city": cell(row, "city"),
            "state": cell(row, "state") or default_state,
            "county": cell(row, "county"),
            "workers": to_int(cell(row, "workers")),
            "effective_date": eff,
            # What the filing said when no single date could be read out of it.
            # Shown rather than dropped: a human can read "postponed to March".
            "date_note": note,
            "notice_date": to_date(cell(row, "notice_date")),
            "reason": cell(row, "reason"),
        })
    return {"events": events, "headers": headers,
            "mapped": {k: (headers[v] if v is not None else None) for k, v in idx.items()},
            "unmapped": unmapped}


def parse_warn_json(records: list, default_state: str = "") -> dict:
    """Socrata-style JSON — a list of flat objects. Same alias matching."""
    if not records:
        return {"events": [], "headers": [], "mapped": {}, "unmapped": list(WARN_ALIASES)}
    headers = list(records[0].keys())
    idx = {k: pick_column(headers, al) for k, al in WARN_ALIASES.items()}
    names = {k: (headers[v] if v is not None else None) for k, v in idx.items()}
    events = []
    for rec in records:
        employer = str(rec.get(names["employer"]) or "").strip() if names["employer"] else ""
        if not employer:
            continue
        g = lambda k: str(rec.get(names[k]) or "").strip() if names.get(k) else ""
        events.append({
            "employer": employer,
            "employer_key": norm_company(employer),
            "city": g("city"), "state": g("state") or default_state, "county": g("county"),
            "workers": to_int(g("workers")),
            "effective_date": to_date(g("effective_date")),
            "notice_date": to_date(g("notice_date")),
            "reason": g("reason"),
        })
    return {"events": events, "headers": headers, "mapped": names,
            "unmapped": [k for k, v in names.items() if v is None]}


# ---------------------------------------------------------------- Form 5500

# Verified against the DOL's own published layout for f_5500_2025_latest
# (field positions in brackets). Seven of these were already right; the eighth
# was not there to be right about.
#
# **f_5500 carries no assets.** It has participant counts and nothing else
# numeric about money. Plan assets are on Schedule H (plans with 100+
# participants) and Schedule I (smaller ones), which are separate files joined
# on ACK_ID. Without that join, every employer comes back with a headcount and
# no average balance, and dollars-in-motion cannot be computed at all — the
# feature looks configured and silently produces nothing.
PLAN_ALIASES = {
    "ein": ["spons dfe ein", "ein", "sponsor ein", "spons ein"],
    "name": ["sponsor dfe name", "spons dfe name", "sponsor name", "plan sponsor name",
             "spons name", "sponsor"],
    "plan_name": ["plan name", "plan name 1", "type plan name"],
    "state": ["spons dfe mail us state", "sponsor state", "spons state", "state",
              "spons dfe loc us state"],
    "participants": ["tot partcp boy cnt", "tot active partcp cnt", "total participants",
                     "tot partcp cnt", "participants"],
    # Present on Schedule H/I, not on f_5500. Left here because a deployment
    # may point FORM5500_URL at a pre-joined file of its own.
    "assets": ["tot assets eoy amt", "total assets", "tot assets amt",
               "tot assets boy amt", "net assets eoy amt",
               "small tot assets eoy amt"],
    # The key both schedules join back on.
    "ack_id": ["ack id"],
    "plan_year": ["form tax prd", "plan year begin date", "form plan year begin date"],
    "plan_type": ["type pension bnft code", "type welfare bnft code", "pension code"],
}


def parse_5500_csv(text: str, states: Optional[set] = None, limit: int = 0) -> dict:
    """Index Form 5500 sponsors by normalised name.

    Filtered to the states the practice covers, because the national file is
    over a million rows and almost none of them are reachable prospects.
    """
    reader = csv.reader(io.StringIO(text))
    try:
        headers = [h.strip() for h in next(reader)]
    except StopIteration:
        return {"plans": {}, "headers": [], "mapped": {}, "unmapped": list(PLAN_ALIASES), "rows": 0}
    idx = {k: pick_column(headers, al) for k, al in PLAN_ALIASES.items()}
    names = {k: (headers[v] if v is not None else None) for k, v in idx.items()}

    def cell(row, key):
        i = idx.get(key)
        return row[i].strip() if i is not None and i < len(row) else ""

    plans, seen, n = {}, 0, 0
    for row in reader:
        n += 1
        if limit and n > limit:
            break
        sponsor = cell(row, "name")
        if not sponsor:
            continue
        st = cell(row, "state").upper()
        if states and st and st not in states:
            continue
        key = norm_company(sponsor)
        assets = to_money(cell(row, "assets"))
        participants = to_int(cell(row, "participants"))
        prev = plans.get(key)
        # One sponsor can file several plans. Keep the largest — it is the one
        # a rollover would come from, and summing would double-count.
        if prev and (prev.get("assets") or 0) >= (assets or 0):
            continue
        plans[key] = {
            "sponsor": sponsor, "ein": cell(row, "ein"), "state": st,
            "ack_id": cell(row, "ack_id"),
            "plan_name": cell(row, "plan_name"),
            "assets": assets, "participants": participants,
            "avg_balance": round(assets / participants) if assets and participants else None,
            "plan_year": cell(row, "plan_year"),
        }
        seen += 1
    return {"plans": plans, "headers": headers, "mapped": names,
            "unmapped": [k for k, v in names.items() if v is None], "rows": n, "kept": seen}


SCHEDULE_ASSET_ALIASES = ["tot assets eoy amt", "small tot assets eoy amt",
                          "total assets eoy", "net assets eoy amt",
                          "tot assets boy amt", "small tot assets boy amt"]


def parse_schedule_assets(text: str) -> dict:
    """{ACK_ID: assets} out of a Schedule H or Schedule I file.

    Both schedules are per-filing, keyed by the same ACK_ID as the parent
    5500. Schedule H names the column TOT_ASSETS_EOY_AMT and Schedule I
    prefixes it SMALL_; either is accepted, and end-of-year is preferred over
    beginning-of-year because it is the balance the plan is leaving with.
    """
    reader = csv.reader(io.StringIO(text))
    try:
        headers = [h.strip() for h in next(reader)]
    except StopIteration:
        return {"assets": {}, "column": None, "rows": 0, "kept": 0}
    ack = pick_column(headers, ["ack id"])
    col = None
    for alias in SCHEDULE_ASSET_ALIASES:      # in preference order, not header order
        col = pick_column(headers, [alias])
        if col is not None:
            break
    if ack is None or col is None:
        return {"assets": {}, "column": headers[col] if col is not None else None,
                "ack_column": headers[ack] if ack is not None else None,
                "rows": 0, "kept": 0,
                "note": "Schedule file has no ACK_ID or no assets column."}
    out, n = {}, 0
    for row in reader:
        n += 1
        if ack >= len(row) or col >= len(row):
            continue
        key = row[ack].strip()
        amt = to_money(row[col].strip())
        if not key or amt is None:
            continue
        # One filing can appear more than once across amended rows; the largest
        # is the one that matches the plan as filed.
        if key not in out or amt > out[key]:
            out[key] = amt
    return {"assets": out, "column": headers[col], "ack_column": headers[ack],
            "rows": n, "kept": len(out)}


def attach_assets(plans: dict, assets_by_ack: dict) -> dict:
    """Fill in assets and avg_balance on plans that had neither.

    Returns a small report rather than nothing, because "how many sponsors got
    a number" is the question a probe is actually asking.
    """
    filled = 0
    for p in plans.values():
        if p.get("assets"):
            continue
        amt = assets_by_ack.get(p.get("ack_id") or "")
        if amt is None:
            continue
        p["assets"] = amt
        pc = p.get("participants")
        p["avg_balance"] = round(amt / pc) if pc else None
        filled += 1
    return {"filled": filled, "sponsors": len(plans)}


def unzip_first_csv(blob: bytes, name_contains: str = "") -> str:
    """The DOL ships zipped CSVs; pull out the one that matters."""
    with zipfile.ZipFile(io.BytesIO(blob)) as z:
        names = [n for n in z.namelist() if n.lower().endswith(".csv")]
        if name_contains:
            preferred = [n for n in names if name_contains.lower() in n.lower()]
            names = preferred or names
        if not names:
            raise ValueError("no CSV inside the archive: " + ", ".join(z.namelist()[:5]))
        with z.open(names[0]) as f:
            return f.read().decode("utf-8", errors="replace")


# ---------------------------------------------------------------- the join

# ------------------------------------------------------------------- warmth
# An opportunity ranked only by dollars is a list of strangers. The same list
# ranked by what you already have inside each employer is a list of doors, some
# of which are already open. Nothing here is new data: it is the lead list the
# advisor already has, turned sideways and asked a different question — not
# "does this person have money moving" but "at this event, who do I know".

# Lead status -> how warm a way in it represents. The vocabulary is the one the
# UI already offers; anything unrecognised counts as a name on file.
_STATUS_WARMTH = {
    "set": "set",                 # a meeting is booked — you are already inside
    "call back": "engaged",       # a live conversation, and they asked you back
    "called": "engaged",          # a live conversation
    "new": "known",               # a name and a number, not a stranger company
}

# Skipped when judging warmth, for the same reason signals.py skips them: a
# person who has said no is not a way in. They are still counted and reported,
# because "everyone I know here has an advisor" is worth seeing before you
# spend a week on the employer.
DECLINED_STATUSES = ("not interested", "has advisor")

WARMTH_RANK = {"set": 3, "engaged": 2, "known": 1, "cold": 0}


def lead_name(lead: dict) -> str:
    return " ".join(x for x in ((lead.get("firstName") or "").strip(),
                                (lead.get("lastName") or "").strip()) if x)


def index_leads_by_employer(leads: Iterable[dict]) -> dict:
    """Leads grouped by the same normalised employer key the WARN join uses."""
    by: dict = {}
    for lead in leads or []:
        key = norm_company(lead.get("employer") or "")
        if key:
            by.setdefault(key, []).append(lead)
    return by


def annotate_warmth(opps: list[dict], leads: Iterable[dict]) -> list[dict]:
    """Mark each opportunity with the warmest way in you already have.

    Warmth is decided by the best status among the leads you hold at that
    employer: a booked meeting beats a live conversation beats a name on file
    beats nothing. `cold` is the honest label for an employer where you know
    no one — it is not a failure, it is the reason to work the others first.
    """
    by_employer = index_leads_by_employer(leads)
    for opp in opps:
        key = norm_company(opp.get("employer") or "")
        matches = by_employer.get(key, [])

        counts: dict = {}
        declined = 0
        best, best_rank = "cold", 0
        best_lead = None
        for lead in matches:
            status = (lead.get("status") or "New").strip()
            counts[status] = counts.get(status, 0) + 1
            if status.lower() in DECLINED_STATUSES:
                declined += 1
                continue
            warmth = _STATUS_WARMTH.get(status.lower(), "known")
            rank = WARMTH_RANK[warmth]
            if rank > best_rank:
                best, best_rank, best_lead = warmth, rank, lead

        opp["warmth"] = best
        opp["warmth_rank"] = best_rank
        opp["known_leads"] = len(matches) - declined
        opp["declined_leads"] = declined
        opp["lead_statuses"] = counts
        opp["warmest_lead"] = ({"id": best_lead.get("id"), "name": lead_name(best_lead),
                                "status": best_lead.get("status") or "New"}
                               if best_lead else None)
    return opps


def sort_opportunities(opps: list[dict], by: str = "dollars") -> list[dict]:
    """Order the list. `dollars` is the default the app has always used.

    `warmth` puts the doors you can already walk through first and keeps
    dollars as the tie-break, which is the ordering that actually reduces cold
    calling: a $30M event where a meeting is booked outranks a $40M event at a
    company where you know no one.
    """
    if by == "warmth":
        opps.sort(key=lambda r: (r.get("warmth_rank") or 0,
                                 r.get("dollars_in_motion") or 0,
                                 r.get("workers") or 0), reverse=True)
    else:
        opps.sort(key=lambda r: (r.get("dollars_in_motion") or 0,
                                 r.get("workers") or 0), reverse=True)
    return opps


def build_opportunities(events: list[dict], plans: dict, *,
                        min_workers: int = 0, states: Optional[set] = None,
                        counties: Optional[set] = None,
                        today: Optional[date] = None) -> list[dict]:
    """WARN events joined to plan data, ranked by dollars likely in motion.

    A layoff with no plan match is still an opportunity — it is a dated
    separation event at a named employer — so it is kept and marked, rather than
    dropped for failing a join it never had to pass.

    `counties` narrows inside a state, which is the only way to work a metro:
    New York publishes no city or state column at all, only county, so for that
    feed this is the sole geographic filter there is. Pass bare names —
    {"nassau", "suffolk"} — they are normalised on both sides.

    Both geographic filters keep an event whose own field is blank, matching how
    `states` already behaves. A feed that omits the column should not silently
    empty the list; the row arrives and the reader can see it.
    """
    today = today or date.today()
    out = []
    for e in events:
        if states and e.get("state") and e["state"].upper() not in states:
            continue
        if counties and e.get("county") and norm_county(e["county"]) not in counties:
            continue
        if min_workers and (e.get("workers") or 0) < min_workers:
            continue
        plan = plans.get(e["employer_key"])
        workers = e.get("workers") or 0
        avg = (plan or {}).get("avg_balance")
        # Deliberately the plan-wide average, not a guess about who was let go.
        # It is an order of magnitude, and it is labelled as one.
        dollars = round(avg * workers) if avg and workers else None
        eff = e.get("effective_date")
        days = None
        if eff:
            try:
                days = (date.fromisoformat(eff) - today).days
            except ValueError:
                days = None
        out.append({
            **e,
            "plan_matched": bool(plan),
            "ein": (plan or {}).get("ein", ""),
            "plan_name": (plan or {}).get("plan_name", ""),
            "plan_assets": (plan or {}).get("assets"),
            "plan_participants": (plan or {}).get("participants"),
            "avg_balance": avg,
            "dollars_in_motion": dollars,
            "days_until": days,
            "id": f"{e['employer_key']}|{e.get('state','')}|{eff or e.get('notice_date') or ''}",
        })
    # Biggest money first; a dated event with no plan match sorts on headcount.
    out.sort(key=lambda r: (r["dollars_in_motion"] or 0, r.get("workers") or 0), reverse=True)
    return out
