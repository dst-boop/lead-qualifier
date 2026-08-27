#!/usr/bin/env bash
# Run every regression suite against a local server and return a real exit code.
#
# The suites drive the actual page in Chromium rather than importing functions,
# because the app is one HTML file with no module boundary — the only honest way
# to test scoreLead is to load the page and call it.
set -uo pipefail
cd "$(dirname "$0")"
ROOT="$(cd .. && pwd)"
PORT="${PORT:-8099}"
BASE="http://127.0.0.1:$PORT"

# Reuse a server if one is already up; otherwise start one and clean it up.
STARTED=""
if ! curl -sf -o /dev/null --noproxy '*' --max-time 3 "$BASE/"; then
  echo "starting server on $PORT"
  (cd "$ROOT" && APP_BASE_URL="$BASE" PORT="$PORT" python3 -m webapp >/tmp/lq-test-server.log 2>&1) &
  STARTED=$!
  for _ in $(seq 1 20); do
    curl -sf -o /dev/null --noproxy '*' --max-time 2 "$BASE/" && break
    sleep 0.5
  done
  curl -sf -o /dev/null --noproxy '*' --max-time 2 "$BASE/" || {
    echo "server never came up; see /tmp/lq-test-server.log"; tail -20 /tmp/lq-test-server.log; exit 1; }
fi
cleanup(){ [ -n "$STARTED" ] && kill "$STARTED" 2>/dev/null; }
trap cleanup EXIT

# Suites that assert and exit non-zero. These are the regression guard.
SUITES="score-test.js mobile-test.js isolation-test.js zi-ui-test.js automap-test.js recipe-test.js edgar-ui-test.js zi-mcp-ui-test.js opps-ui-test.js research-prompt-test.js scs-test.js pipeline-test.js lists-ui-test.js track-ui-test.js signals-ui-test.js plans-ui-test.js intl-build-test.js wealthfeed-test.js wp-record-ui-test.js recheck-test.js free-ui-test.js free-sweep-test.js export-columns-test.js upgrade-test.js hh-test.js v3-test.js age-search-test.js admin-ui-test.js"
FAILED=""
for s in $SUITES; do
  printf '%-20s ' "$s"
  if out=$(node "$s" 2>&1); then
    echo "$(echo "$out" | tail -1)"
  else
    echo "FAILED"
    echo "$out" | sed 's/^/    /'
    FAILED="$FAILED $s"
  fi
done

# Backend suites run from the repo root, each against its own stub server.
for s in zi-oauth-test.py edgar-test.py zi-mcp-test.py prospecting-test.py opportunities-test.py lists-test.py senders-test.py team-test.py signals-test.py signals-api-test.py harvest-test.py plan-assets-test.py cache-test.py wp-record-test.py signals-coverage-test.py google-consent-test.py accounts-test.py wp-credits-test.py free-sources-test.py free-debug-test.py edgar-roster-test.py credits-test.py admin-test.py; do
  printf '%-20s ' "$s"
  if out=$(cd "$ROOT" && python3 "tests/$s" 2>&1); then
    echo "$(echo "$out" | tail -1)"
  else
    echo "FAILED"; echo "$out" | tail -20 | sed 's/^/    /'; FAILED="$FAILED $s"
  fi
done

echo
if [ -n "$FAILED" ]; then echo "FAILING:$FAILED"; exit 1; fi
echo "all suites pass"
