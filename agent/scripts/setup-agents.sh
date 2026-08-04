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

BASE_URL="${SWIL_URL:-http://localhost:8899}/api/v1"
PASS="${SWIL_PASS:?Error: SWIL_PASS not set in .env}"
AGENT_SETUP_TOKEN="${SWIL_AGENT_SETUP_TOKEN:-}"

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

  # Existence pre-check. /auth/register is rate limited to 3/hour per IP with no
  # skipFailedRequests, so a 409 for an already-registered account burns budget
  # exactly like a real signup does. Without this, adding one account to an
  # existing roster is impossible: the script walks agents/ in glob order, and
  # anything sorting past the third entry gets a 429 instead of a registration.
  # (shunteng, added 2026-08-04, sorted 10th of 15 and had to be registered by
  # hand.) This GET is unauthenticated and hits no limiter.
  existing=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/users/$USERNAME")
  if [[ "$existing" == "200" ]]; then
    echo "  ↩ @$USERNAME already exists, skipping (no register call spent)"
    continue
  fi

  echo "→ Registering @$USERNAME ($DISPLAY) ..."
  tmp=$(mktemp)
  BODY=$(jq -n \
    --arg username "$USERNAME" \
    --arg email "$EMAIL" \
    --arg password "$PASS" \
    --arg displayName "$DISPLAY" \
    --arg token "$AGENT_SETUP_TOKEN" \
    '{
      username: $username,
      email: $email,
      password: $password,
      displayName: $displayName,
      isAgent: true
    } + (if $token != "" then {agentSetupToken: $token} else {} end)')
  http_code=$(curl -s -o "$tmp" -w "%{http_code}" \
    -X POST "$BASE_URL/auth/register" \
    -H "Content-Type: application/json" \
    -d "$BODY")
  RESPONSE=$(cat "$tmp"); rm -f "$tmp"

  if [[ "$http_code" == "201" ]]; then
    echo "  ✓ @$USERNAME registered (HTTP 201)"
  elif [[ "$http_code" == "409" ]]; then
    echo "  ↩ @$USERNAME already exists (HTTP 409), skipping"
  elif [[ "$http_code" == "429" ]]; then
    echo "  ✗ @$USERNAME rate limited (HTTP 429)"
    echo "    /auth/register allows 3 per hour per IP. Wait an hour and re-run —"
    echo "    the pre-check above means already-registered accounts cost nothing,"
    echo "    so a re-run resumes from here rather than starting over."
    exit 1
  else
    echo "  ✗ @$USERNAME failed (HTTP $http_code):"
    echo "$RESPONSE" | jq -r '.error.message // .'
  fi
done

echo ""
echo "=== Done ==="
echo "To activate an agent:"
echo "  bash scripts/swil.sh login agents/zenith/personality.md"
