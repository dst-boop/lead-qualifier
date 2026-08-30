"""The nationwide WARN runner, with the scraper stubbed.

Forty state websites are not reachable from a test, and would not be worth
hitting if they were. What is worth testing is the part this module actually
owns: that one broken state costs that state's file and nothing else, that a
file that came back empty is treated as a failure rather than published as an
empty feed, and that the WARN_FEEDS it emits is the shape webapp/main.py
reads. The scraping itself belongs to warn-scraper and is tested there.
"""
import json, os, shutil, sys, tempfile
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tools import warn_sync as W

fail = 0
TOTAL = [0]


def ck(name, cond, detail=""):
    global fail
    TOTAL[0] += 1
    print(("ok   " if cond else "FAIL ") + name + ("  " + str(detail) if detail else ""))
    if not cond:
        fail += 1


ROW = ("Company,City,State,Employees,Layoff Date\n"
       "Cordova Industrial Group,Hicksville,NY,412,06/30/2026\n")


class StubRunner:
    """Stands in for warn.Runner: writes a CSV where the real one would.

    `broken` states raise, `blank` states produce a zero-byte file, and
    `vanish` states report a path they never wrote -- the three ways a real
    scraper fails that the caller has to survive.
    """

    def __init__(self, root, broken=(), blank=(), vanish=()):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.broken, self.blank, self.vanish = set(broken), set(blank), set(vanish)
        self.calls = []

    def scrape(self, state):
        self.calls.append(state)
        if state in self.broken:
            raise RuntimeError("site returned 503")
        p = self.root / f"{state}.csv"
        if state in self.vanish:
            return p                      # never written
        p.write_text("" if state in self.blank else ROW, encoding="utf-8")
        return p


tmp = Path(tempfile.mkdtemp(prefix="warn-sync-test-"))
BASE = "https://raw.githubusercontent.com/acme/lead-qualifier/warn-data"

# --- what warn-scraper covers -------------------------------------------------
# available_states() reads the installed package's scrapers directory, so the
# test supplies a fake package rather than asserting against a version number
# that will change under it.
pkg_dir = tmp / "fakewarn"
(pkg_dir / "scrapers").mkdir(parents=True)
(pkg_dir / "__init__.py").write_text("", encoding="utf-8")
for f in ("ny.py", "nj.py", "ct.py", "dc.py", "__init__.py", "notes.txt"):
    (pkg_dir / "scrapers" / f).write_text("", encoding="utf-8")
fake_pkg = SimpleNamespace(__file__=str(pkg_dir / "__init__.py"))

avail = W.available_states(fake_pkg)
ck("states come from the installed package, upper-cased and sorted",
   avail == ["CT", "DC", "NJ", "NY"], avail)
ck("  ...dunder and non-python files are not states", "NOTES" not in avail, avail)

ck("'all' selects everything covered", W.select_states("all", avail) == avail)
ck("empty selects everything covered", W.select_states("", avail) == avail)
ck("a list selects and upper-cases", W.select_states("ny, nj", avail) == ["NY", "NJ"])
try:
    W.select_states("NY,MA", avail)
    ck("an uncovered state is refused rather than silently dropped", False)
except SystemExit as e:
    ck("an uncovered state is refused rather than silently dropped", True)
    ck("  ...and the message names it and what is available",
       "MA" in str(e) and "NY" in str(e), str(e))

# --- one bad state does not take the run down ---------------------------------
out = tmp / "out"
runner = StubRunner(tmp / "raw", broken=["ct"], blank=["dc"], vanish=["nj"])
res = W.sync(["NY", "NJ", "CT", "DC"], out, BASE, runner=runner)

ck("every state is attempted, not just the ones before the first failure",
   runner.calls == ["ny", "nj", "ct", "dc"], runner.calls)
ck("the good state is published", res["ok"] == ["NY"], res)
ck("a scraper that raised is recorded, not swallowed",
   "RuntimeError" in res["failed"].get("CT", ""), res["failed"])
ck("a file that never appeared is a failure",
   "FileNotFoundError" in res["failed"].get("NJ", ""), res["failed"])
ck("an empty file is a failure, not an empty feed",
   "ValueError" in res["failed"].get("DC", ""), res["failed"])
ck("  ...so no feed points at it",
   [f["state"] for f in res["feeds"]] == ["NY"], res["feeds"])
ck("the surviving CSV is written under the state's code",
   (out / "ny.csv").read_text(encoding="utf-8") == ROW)

# --- the feeds file is what the app reads -------------------------------------
written = json.loads((out / "warn_feeds.json").read_text(encoding="utf-8"))
ck("warn_feeds.json holds the feed list", written == res["feeds"], written)
entry = written[0]
ck("a feed entry has the keys main.py reads",
   set(entry) == {"id", "state", "format", "url"}, entry)
ck("  ...id is the lower-case code", entry["id"] == "ny", entry)
ck("  ...format is csv, which prospecting.py can parse", entry["format"] == "csv")
ck("  ...and the URL is the published file",
   entry["url"] == BASE + "/ny.csv", entry["url"])
ck("a base URL with a trailing slash does not double it",
   W.feed_entry("NY", BASE + "/")["url"] == BASE + "/ny.csv")

# --- an all-clear run ---------------------------------------------------------
out2 = tmp / "out2"
res2 = W.sync(["NY", "NJ"], out2, BASE, runner=StubRunner(tmp / "raw2"))
ck("with nothing broken every state publishes",
   res2["ok"] == ["NY", "NJ"] and res2["failed"] == {}, res2)
ck("  ...and every state gets a feed", len(res2["feeds"]) == 2, res2["feeds"])

# --- a scraper that already wrote into the output directory -------------------
# warn-scraper is configured with data_dir=out/_raw, so its path can land under
# the output tree; copying a file onto itself would truncate it.
out3 = tmp / "out3"
out3.mkdir()
res3 = W.sync(["NY"], out3, BASE, runner=StubRunner(out3))
ck("a scraper writing straight to the target does not truncate it",
   (out3 / "ny.csv").read_text(encoding="utf-8") == ROW, res3)

# --- what the operator is told ------------------------------------------------
text = W.report(res, avail)
lines = text.splitlines()
uncovered = set(lines[lines.index(
    "no scraper exists for these, so they are not covered at all:") + 1].split())
ck("the report leads with the count", text.startswith("scraped 1 of 4"), lines[0])
ck("failed states are named with their reason", "CT" in text and "503" in text)
ck("states with no scraper at all are called out separately",
   {"MA", "WY"} <= uncovered, sorted(uncovered)[:5])
ck("  ...and a state that IS covered but failed today is not called uncovered",
   not uncovered & set(avail), sorted(uncovered & set(avail)))
ck("the report says where the feeds went", "warn_feeds.json" in text)

# --- the CLI ------------------------------------------------------------------
ck("every state is in ALL_STATES", len(W.ALL_STATES) == 50, len(W.ALL_STATES))
ck("  ...with no duplicates", len(set(W.ALL_STATES)) == 50)
ck("--base-url is required, because a feed without one points nowhere",
   W.main(["--out", str(tmp / "cli"), "--base-url", ""]) == 2)

shutil.rmtree(tmp, ignore_errors=True)

print()
print(f"FAILURES {fail} of {TOTAL[0]}" if fail else f"all {TOTAL[0]} checks passed")
sys.exit(1 if fail else 0)
