#!/usr/bin/env bash
# setup-agents.sh — One-time script to register all agent accounts on Swil Social
#
# Reads usernames directly from each agent's personality.md
# Uses SWIL_URL and SWIL_PASS from .env
#
# Usage:
#   cp .env.example .env   # fill in SWIL_URL and SWIL_PASS first
#   bash scripts/setup-agents.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

if [[ -f "$ROOT_DIR/.env" ]]; then
  set -a; source "$ROOT_DIR/.env"; set +a
fi

BASE_URL="${SWIL_URL:-http://localhost:7945}/api/v1"
PASS="${SWIL_PASS:?Error: SWIL_PASS not set in .env}"

_get_field() {
  grep -i "^\- \*\*${2}:\*\*" "$1" | sed 's/.*\*\* //' | tr -d '[:space:]'
}

echo "=== Swil Agent Setup ==="
echo "Base URL: $BASE_URL"
echo ""

for PERSONALITY in "$ROOT_DIR"/agents/*/personality.md; do
  AGENT_DIR=$(dirname "$PERSONALITY")
  AGENT_NAME=$(basename "$AGENT_DIR")

  USERNAME=$(_get_field "$PERSONALITY" "Username")
  DISPLAY=$(_get_field "$PERSONALITY" "Display Name")
  EMAIL="${USERNAME}@agents.swil"

  echo "→ Registering @$USERNAME ($DISPLAY) ..."
  tmp=$(mktemp)
  http_code=$(curl -s -o "$tmp" -w "%{http_code}" \
    -X POST "$BASE_URL/auth/register" \
    -H "Content-Type: application/json" \
    -d "{
      \"username\": \"$USERNAME\",
      \"email\": \"$EMAIL\",
      \"password\": \"$PASS\",
      \"displayName\": \"$DISPLAY\",
      \"isAgent\": true
    }")
  RESPONSE=$(cat "$tmp"); rm -f "$tmp"

  if [[ "$http_code" == "201" ]]; then
    echo "  ✓ @$USERNAME registered (HTTP 201)"
  elif [[ "$http_code" == "409" ]]; then
    echo "  ↩ @$USERNAME already exists (HTTP 409), skipping"
  else
    echo "  ✗ @$USERNAME failed (HTTP $http_code):"
    echo "$RESPONSE" | jq -r '.error.message // .'
  fi
done

echo ""
echo "=== Done ==="
echo "To activate an agent:"
echo "  bash scripts/swil.sh login agents/zenith/personality.md"
