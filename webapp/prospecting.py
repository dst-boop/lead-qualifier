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

    for row in rows[1:]:
        if not any(c.strip() for c in row):
            continue
        employer = cell(row, "employer")
        if not employer:
            continue
        events.append({
            "employer": employer,
            "employer_key": norm_company(employer),
            "city": cell(row, "city"),
            "state": cell(row, "state") or default_state,
            "county": cell(row, "county"),
            "workers": to_int(cell(row, "workers")),
            "effective_date": to_date(cell(row, "effective_date")),
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

PLAN_ALIASES = {
    "ein": ["spons dfe ein", "ein", "sponsor ein", "spons ein"],
    "name": ["sponsor dfe name", "spons dfe name", "sponsor name", "plan sponsor name",
             "spons name", "sponsor"],
    "plan_name": ["plan name", "plan name 1", "type plan name"],
    "state": ["spons dfe mail us state", "sponsor state", "spons state", "state",
              "spons dfe loc us state"],
    "participants": ["tot partcp boy cnt", "tot active partcp cnt", "total participants",
                     "tot partcp cnt", "participants"],
    "assets": ["tot assets eoy amt", "total assets", "tot assets amt",
               "tot assets boy amt", "net assets eoy amt"],
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
            "plan_name": cell(row, "plan_name"),
            "assets": assets, "participants": participants,
            "avg_balance": round(assets / participants) if assets and participants else None,
            "plan_year": cell(row, "plan_year"),
        }
        seen += 1
    return {"plans": plans, "headers": headers, "mapped": names,
            "unmapped": [k for k, v in names.items() if v is None], "rows": n, "kept": seen}


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

def build_opportunities(events: list[dict], plans: dict, *,
                        min_workers: int = 0, states: Optional[set] = None,
                        today: Optional[date] = None) -> list[dict]:
    """WARN events joined to plan data, ranked by dollars likely in motion.

    A layoff with no plan match is still an opportunity — it is a dated
    separation event at a named employer — so it is kept and marked, rather than
    dropped for failing a join it never had to pass.
    """
    today = today or date.today()
    out = []
    for e in events:
        if states and e.get("state") and e["state"].upper() not in states:
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
