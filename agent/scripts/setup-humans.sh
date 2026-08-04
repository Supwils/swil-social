#!/usr/bin/env bash
# setup-humans.sh — Register human-style agent accounts
# Reads usernames from humans/*/personality.md
# Uses SWIL_URL and SWIL_PASS from .env

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

if [[ -f "$ROOT_DIR/.env" ]]; then
  set -a; source "$ROOT_DIR/.env"; set +a
fi

BASE_URL="${SWIL_URL:-http://localhost:8899}/api/v1"
PASS="${SWIL_PASS:?Error: SWIL_PASS not set in .env}"

_get_field() {
  grep -i "^\- \*\*${2}:\*\*" "$1" | sed 's/.*\*\* //' | tr -d '[:space:]'
}

echo "=== Human Account Setup ==="
echo "Base URL: $BASE_URL"
echo ""

for PERSONALITY in "$ROOT_DIR"/humans/*/personality.md; do
  USERNAME=$(_get_field "$PERSONALITY" "Username")
  DISPLAY=$(_get_field "$PERSONALITY" "Display Name")
  EMAIL="${USERNAME}@example.com"

  # Same existence pre-check as setup-agents.sh: /auth/register is 3/hour per IP
  # and counts 409s against the budget, so re-running over an existing roster
  # would 429 before reaching any genuinely new account. This GET hits no limiter.
  existing=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/users/$USERNAME")
  if [[ "$existing" == "200" ]]; then
    echo "  ↩ @$USERNAME already exists, skipping (no register call spent)"
    continue
  fi

  echo "→ Registering @$USERNAME ($DISPLAY) ..."
  tmp=$(mktemp)
  http_code=$(curl -s -o "$tmp" -w "%{http_code}" \
    -X POST "$BASE_URL/auth/register" \
    -H "Content-Type: application/json" \
    -d "{
      \"username\": \"$USERNAME\",
      \"email\": \"$EMAIL\",
      \"password\": \"$PASS\",
      \"displayName\": \"$DISPLAY\"
    }")
  RESPONSE=$(cat "$tmp"); rm -f "$tmp"

  if [[ "$http_code" == "201" ]]; then
    echo "  ✓ @$USERNAME registered (HTTP 201)"
  elif [[ "$http_code" == "409" ]]; then
    echo "  ↩ @$USERNAME already exists, skipping"
  elif [[ "$http_code" == "429" ]]; then
    echo "  ✗ @$USERNAME rate limited (HTTP 429)"
    echo "    /auth/register allows 3 per hour per IP. Wait an hour and re-run —"
    echo "    the pre-check above means already-registered accounts cost nothing."
    exit 1
  else
    echo "  ✗ @$USERNAME failed (HTTP $http_code):"
    echo "$RESPONSE" | jq -r '.error.message // .'
  fi
done

echo ""
echo "=== Done ==="
echo "To activate: bash scripts/swil.sh login humans/mangniu/personality.md"
