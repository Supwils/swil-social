#!/usr/bin/env bash
# population-metric.sh — record one population-cohesion sample (persona + behavior
# cohesion across the whole lab population). The server computes the metric from
# the latest snapshots; this script just triggers and timestamps it. Intended to
# run daily via launchd so the /lab homogenization trend has history.
#
# Usage:
#   bash scripts/population-metric.sh [agent-name]   # any account's api_key works
#
# Env: SWIL_URL (default http://localhost:8899). Uses the given account's
# api_key.txt for auth (defaults to the first account that has one).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

if [[ -f "$ROOT_DIR/.env" ]]; then
  set -a; source "$ROOT_DIR/.env"; set +a
fi

BASE_URL="${SWIL_URL:-http://localhost:8899}/api/v1"

# Resolve an account + its api_key + platform username.
find_key() {
  local name="$1"
  for base in agents humans; do
    if [[ -f "$ROOT_DIR/$base/$name/api_key.txt" ]]; then
      echo "$ROOT_DIR/$base/$name"
      return 0
    fi
  done
  return 1
}

DIR=""
if [[ $# -ge 1 ]]; then
  DIR="$(find_key "$1" || true)"
else
  # First account with an api_key.txt.
  for base in agents humans; do
    for d in "$ROOT_DIR/$base"/*/; do
      [[ -f "${d}api_key.txt" ]] && DIR="${d%/}" && break 2
    done
  done
fi

if [[ -z "$DIR" ]]; then
  echo "population-metric: no account with api_key.txt found" >&2
  exit 1
fi

USERNAME="$(grep -i '^\- \*\*Username:\*\*' "$DIR/personality.md" | sed 's/.*\*\* //' | tr -d '[:space:]' | head -1)"
KEY="$(cat "$DIR/api_key.txt")"

# The population-metric route is mounted at /agents/population-metric (global,
# not per-username); any lab account's api_key authorises it.
RESP="$(curl -sS --max-time 30 -X POST \
  -H 'content-type: application/json' \
  -H "Authorization: Bearer $KEY" \
  "$BASE_URL/agents/population-metric" 2>/dev/null || echo '')"

if echo "$RESP" | jq -e '.data.capturedAt' >/dev/null 2>&1; then
  PC="$(echo "$RESP" | jq -r '.data.personaCohesion')"
  BC="$(echo "$RESP" | jq -r '.data.behaviorCohesion')"
  N="$(echo "$RESP" | jq -r '.data.n')"
  echo "population-metric: ok personaCohesion=$PC behaviorCohesion=$BC n=$N"
else
  echo "population-metric: server rejected — $RESP" >&2
  exit 1
fi
