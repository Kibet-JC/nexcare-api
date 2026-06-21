#!/usr/bin/env bash
# Post-deploy smoke test: confirm a running NexCare API answers its health probe.
#
# Usage:  scripts/smoke-test.sh https://nexcare-api.up.railway.app
#         scripts/smoke-test.sh http://localhost:3000
#
# Curls <base-url>/api/v1/health and asserts HTTP 200 with a JSON body whose
# "status" is "ok". Exits 0 on success, non-zero otherwise — suitable for use as
# a deploy gate in CI or a manual post-deploy check.
set -euo pipefail

BASE_URL="${1:-}"
if [ -z "$BASE_URL" ]; then
  echo "usage: $0 <base-url>" >&2
  echo "  e.g. $0 https://nexcare-api.up.railway.app" >&2
  exit 2
fi

# Strip a trailing slash so we don't build a //api/v1/health URL.
BASE_URL="${BASE_URL%/}"
HEALTH_URL="${BASE_URL}/api/v1/health"

echo "smoke: GET ${HEALTH_URL}"

# Capture the body and the HTTP status in one request. The status is appended on
# its own trailing line via -w so we can split it from the JSON body.
RESPONSE="$(curl -fsS --max-time 15 -w $'\n%{http_code}' "$HEALTH_URL" 2>/dev/null)" || {
  echo "smoke: FAIL — request to ${HEALTH_URL} did not complete" >&2
  exit 1
}

HTTP_CODE="$(printf '%s' "$RESPONSE" | tail -n1)"
BODY="$(printf '%s' "$RESPONSE" | sed '$d')"

if [ "$HTTP_CODE" != "200" ]; then
  echo "smoke: FAIL — expected HTTP 200, got ${HTTP_CODE}" >&2
  echo "  body: ${BODY}" >&2
  exit 1
fi

# Assert the JSON status field is "ok". Matched with a tolerant regex so the
# check needs no jq dependency on the runner.
if ! printf '%s' "$BODY" | grep -Eq '"status"[[:space:]]*:[[:space:]]*"ok"'; then
  echo "smoke: FAIL — health body did not report status \"ok\"" >&2
  echo "  body: ${BODY}" >&2
  exit 1
fi

echo "smoke: OK — ${HEALTH_URL} returned 200 with status \"ok\""
