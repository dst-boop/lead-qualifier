"""Nationwide WARN, by wrapping the scraper that already solves it.

The app reads WARN from `WARN_FEEDS`: a list of URLs, each a CSV or JSON file
for one state. That works, and it does not scale to the country, for one
reason -- `webapp/prospecting.py` parses CSV and JSON and nothing else, while a
large share of states publish WARN as an HTML table or a PDF. No amount of
configuration reaches those states.

`warn-scraper`, from Big Local News at Stanford, has a per-state module for
each of them and writes every one out as CSV. This runs it and publishes the
result, so the app keeps reading plain CSV over HTTP and the messy part lives
where it is already maintained by people who watch those sites for a living.

Deliberately NOT normalised across states. Each state's file keeps that state's
own column names, because `prospecting.py` matches columns by alias per feed --
that is what the alias table is for, and collapsing forty schemas into one here
would mean maintaining a second mapping that could silently disagree with it.

Usage:

    python -m tools.warn_sync --out data/warn \\
        --base-url https://raw.githubusercontent.com/OWNER/REPO/warn-data/

Writes one CSV per jurisdiction into --out, plus warn_feeds.json holding the
value to set as WARN_FEEDS.
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
import traceback
from pathlib import Path
from typing import Iterable, Optional

# Jurisdictions warn-scraper ships a module for. Read from the installed
# package rather than hard-coded, so a release that adds a state is picked up
# by upgrading the dependency instead of editing this list.
def available_states(package=None) -> list:
    """Two-letter codes warn-scraper can scrape, upper-case and sorted."""
    if package is None:
        import warn as package
    d = Path(package.__file__).parent / "scrapers"
    return sorted(p.stem.upper() for p in d.glob("*.py")
                  if not p.stem.startswith("__"))


def select_states(requested: str, available: Iterable[str]) -> list:
    """Resolve --states into codes, keeping only ones that can be scraped."""
    available = list(available)
    if not requested or requested.strip().lower() in ("all", "*"):
        return available
    have = set(available)
    out, unknown = [], []
    for raw in requested.split(","):
        code = raw.strip().upper()
        if not code:
            continue
        (out if code in have else unknown).append(code)
    if unknown:
        raise SystemExit(
            f"warn-scraper has no module for: {', '.join(unknown)}. "
            f"Available: {' '.join(available)}")
    return out


def feed_entry(state: str, base_url: str) -> dict:
    """One WARN_FEEDS entry, in the shape webapp/main.py expects."""
    return {"id": state.lower(), "state": state,
            "format": "csv", "url": base_url.rstrip("/") + f"/{state.lower()}.csv"}


def sync(states: list, out_dir: Path, base_url: str, *, runner=None,
         cache_dir: Optional[Path] = None) -> dict:
    """Scrape each state, writing <out_dir>/<state>.csv. Never raises for one state.

    A state whose site was redesigned yesterday is the normal case, not the
    exceptional one: forty sites means something is broken most weeks. One
    failure must cost that state's file and nothing else, so the run is
    reported per state and the exit code reflects the whole rather than the
    first thing that went wrong.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    if runner is None:
        from warn import Runner
        runner = Runner(data_dir=out_dir / "_raw",
                        cache_dir=cache_dir or (out_dir / "_cache"))

    ok, failed = [], {}
    for state in states:
        try:
            path = Path(runner.scrape(state.lower()))
            if not path.exists():
                raise FileNotFoundError(f"scraper reported {path}, which is not there")
            target = out_dir / f"{state.lower()}.csv"
            if path.resolve() != target.resolve():
                shutil.copyfile(path, target)
            if target.stat().st_size == 0:
                raise ValueError("scraper produced an empty file")
            ok.append(state)
        except Exception as e:                       # noqa: BLE001 - see docstring
            failed[state] = f"{type(e).__name__}: {str(e)[:200]}"

    feeds = [feed_entry(s, base_url) for s in ok]
    (out_dir / "warn_feeds.json").write_text(json.dumps(feeds), encoding="utf-8")
    return {"ok": ok, "failed": failed, "feeds": feeds, "out_dir": str(out_dir)}


def report(result: dict, available: list) -> str:
    ok, failed = result["ok"], result["failed"]
    lines = [f"scraped {len(ok)} of {len(ok) + len(failed)} jurisdictions"]
    if failed:
        lines.append("")
        lines.append("failed, and left alone rather than retried into a ban:")
        for state, why in sorted(failed.items()):
            lines.append(f"  {state}  {why}")
    missing = sorted(set(ALL_STATES) - set(available))
    if missing:
        lines.append("")
        lines.append("no scraper exists for these, so they are not covered at all:")
        lines.append("  " + " ".join(missing))
    lines.append("")
    lines.append(f"wrote {len(result['feeds'])} feeds to {result['out_dir']}/warn_feeds.json")
    return "\n".join(lines)


ALL_STATES = (
    "AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS "
    "MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV "
    "WI WY"
).split()


def main(argv=None) -> int:
    p = argparse.ArgumentParser(
        prog="warn_sync",
        description="Scrape WARN notices for every covered state and emit WARN_FEEDS.")
    p.add_argument("--out", default="data/warn", help="directory for the CSVs")
    p.add_argument("--states", default="all",
                   help="comma-separated codes, or 'all' (default)")
    p.add_argument("--base-url", default="",
                   help="public URL the CSVs will be served from; used to build WARN_FEEDS")
    p.add_argument("--list", action="store_true",
                   help="print the jurisdictions warn-scraper covers, and exit")
    args = p.parse_args(argv)

    try:
        available = available_states()
    except ImportError:
        print("warn-scraper is not installed. pip install warn-scraper", file=sys.stderr)
        return 2

    if args.list:
        print(f"{len(available)} jurisdictions: {' '.join(available)}")
        missing = sorted(set(ALL_STATES) - set(available))
        print(f"{len(missing)} states with no scraper: {' '.join(missing)}")
        return 0

    if not args.base_url:
        print("--base-url is required to build WARN_FEEDS; pass the public URL the "
              "CSVs will be served from.", file=sys.stderr)
        return 2

    states = select_states(args.states, available)
    try:
        result = sync(states, Path(args.out), args.base_url)
    except Exception:
        traceback.print_exc()
        return 1

    print(report(result, available))
    # Some states failing is the expected steady state, so it is not an error.
    # Every state failing means the run itself is broken -- a bad network, a
    # dependency change -- and that should stop a schedule rather than quietly
    # publish nothing.
    return 1 if not result["ok"] else 0


if __name__ == "__main__":
    sys.exit(main())
