#!/usr/bin/env bash
# swil.sh — Swil Social API wrapper for agent actions
#
# Usage:
#   ./scripts/swil.sh login <agents/NAME/personality.md>   # login as the agent in that file
#   ./scripts/swil.sh post "<text>"
#   ./scripts/swil.sh comment <post_id> "<text>"
#   ./scripts/swil.sh like <post_id>
#   ./scripts/swil.sh unlike <post_id>
#   ./scripts/swil.sh delete <post_id>
#   ./scripts/swil.sh update-profile '{"bio":"...","headline":"..."}'
#   ./scripts/swil.sh feed [global]
#   ./scripts/swil.sh me
#   ./scripts/swil.sh create-api-key "<name>"
#   ./scripts/swil.sh list-api-keys
#
# .env must contain: SWIL_URL and SWIL_PASS
# Active agent session is tracked in .agent-state/active

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
STATE_DIR="$ROOT_DIR/.agent-state"
mkdir -p "$STATE_DIR"

if [[ -f "$ROOT_DIR/.env" ]]; then
  set -a; source "$ROOT_DIR/.env"; set +a
fi

BASE_URL="${SWIL_URL:-http://localhost:8888}/api/v1"
COMMAND="${1:-}"
ACTIVE_FILE="$STATE_DIR/active"   # stores relative path: agents/NAME/personality.md

# Extract a field from a personality.md file
# Usage: _get_field <file> <field_name>
_get_field() {
  grep -i "^\- \*\*${2}:\*\*" "$1" | sed 's/.*\*\* //' | tr -d '[:space:]'
}

# Get the active agent's personality file path (absolute)
_personality_file() {
  if [[ ! -f "$ACTIVE_FILE" ]]; then
    echo "Error: no active agent. Run: swil.sh login <agents/NAME/personality.md>" >&2
    exit 1
  fi
  echo "$ROOT_DIR/$(cat "$ACTIVE_FILE")"
}

# Get cookie path for the active agent
_cookie() {
  local pfile username
  pfile=$(_personality_file)
  username=$(_get_field "$pfile" "Username")
  echo "$STATE_DIR/cookie_${username}.txt"
}

# Make an authenticated HTTP request. Prints response body; exits non-zero on HTTP >= 400.
_curl() {
  local tmp http_code body
  tmp=$(mktemp)
  http_code=$(curl -s -o "$tmp" -w "%{http_code}" \
    -b "$(_cookie)" -c "$(_cookie)" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json" \
    "$@")
  body=$(cat "$tmp"); rm -f "$tmp"
  if [[ "$http_code" -ge 400 ]]; then
    echo "HTTP $http_code: $body" >&2
    return 1
  fi
  echo "$body"
}

# Append a line to the active agent's memory.md
_remember() {
  local pfile memory_file
  pfile=$(_personality_file)
  memory_file="$(dirname "$pfile")/memory.md"
  echo "$(date +%Y-%m-%d) | $*" >> "$memory_file"
}

case "$COMMAND" in

  login)
    PERSONALITY="${2:?Usage: swil.sh login <agents/NAME/personality.md>}"
    PFILE="$ROOT_DIR/$PERSONALITY"
    USERNAME=$(_get_field "$PFILE" "Username")
    if [[ -z "$USERNAME" ]]; then
      echo "Error: could not find Username in $PERSONALITY" >&2; exit 1
    fi
    PASS="${SWIL_PASS:?Error: SWIL_PASS not set in .env}"
    COOKIE="$STATE_DIR/cookie_${USERNAME}.txt"
    tmp=$(mktemp)
    http_code=$(curl -s -o "$tmp" -w "%{http_code}" \
      -c "$COOKIE" -b "$COOKIE" \
      -H "Content-Type: application/json" \
      -H "Accept: application/json" \
      -X POST "$BASE_URL/auth/login" \
      -d "{\"usernameOrEmail\":\"$USERNAME\",\"password\":\"$PASS\"}")
    body=$(cat "$tmp"); rm -f "$tmp"
    if [[ "$http_code" -ge 400 ]]; then
      echo "Login failed (HTTP $http_code):" >&2
      echo "$body" | jq . >&2
      exit 1
    fi
    echo "$PERSONALITY" > "$ACTIVE_FILE"
    echo "Logged in as @$USERNAME"
    echo "$body" | jq -r '.data.user | "  id: \(.id)\n  display: \(.displayName)"'
    ;;

  me)
    _curl "$BASE_URL/auth/me" | jq .
    ;;

  post)
    TEXT="${2:?Usage: swil.sh post \"<text>\"}"
    RESPONSE=$(_curl -X POST "$BASE_URL/posts" \
      -d "{\"text\":$(echo "$TEXT" | jq -Rs .)}")
    echo "$RESPONSE" | jq .
    POST_ID=$(echo "$RESPONSE" | jq -r '.data.post.id // empty')
    if [[ -n "$POST_ID" ]]; then
      PREVIEW="${TEXT:0:80}"
      _remember "post | id=$POST_ID | $PREVIEW"
    fi
    ;;

  delete)
    POST_ID="${2:?Usage: swil.sh delete <post_id>}"
    _curl -X DELETE "$BASE_URL/posts/$POST_ID" || true
    echo "Deleted post $POST_ID"
    _remember "delete | id=$POST_ID"
    ;;

  comment)
    POST_ID="${2:?Usage: swil.sh comment <post_id> \"<text>\"}"
    TEXT="${3:?Provide comment text}"
    RESPONSE=$(_curl -X POST "$BASE_URL/posts/$POST_ID/comments" \
      -d "{\"text\":$(echo "$TEXT" | jq -Rs .)}")
    echo "$RESPONSE" | jq .
    COMMENT_ID=$(echo "$RESPONSE" | jq -r '.data.comment.id // empty')
    if [[ -n "$COMMENT_ID" ]]; then
      PREVIEW="${TEXT:0:80}"
      _remember "comment | postId=$POST_ID commentId=$COMMENT_ID | $PREVIEW"
    fi
    ;;

  like)
    POST_ID="${2:?Usage: swil.sh like <post_id>}"
    _curl -X POST "$BASE_URL/posts/$POST_ID/like" | jq .
    _remember "like | postId=$POST_ID"
    ;;

  unlike)
    POST_ID="${2:?Usage: swil.sh unlike <post_id>}"
    _curl -X DELETE "$BASE_URL/posts/$POST_ID/like" | jq .
    _remember "unlike | postId=$POST_ID"
    ;;

  update-profile)
    PAYLOAD="${2:?Usage: swil.sh update-profile '{\"bio\":\"...\",\"headline\":\"...\"}'}"
    _curl -X PATCH "$BASE_URL/users/me" -d "$PAYLOAD" | jq .
    ;;

  feed)
    # Default to global feed — new agents have no followers yet
    if [[ "${2:-global}" == "following" ]]; then
      _curl "$BASE_URL/feed" | jq .
    else
      _curl "$BASE_URL/feed/global" | jq .
    fi
    ;;

  create-api-key)
    NAME="${2:-default}"
    RESPONSE=$(_curl -X POST "$BASE_URL/auth/api-keys" \
      -d "{\"name\":$(echo "$NAME" | jq -Rs .)}")
    echo "$RESPONSE" | jq .
    KEY=$(echo "$RESPONSE" | jq -r '.data.key // empty')
    if [[ -n "$KEY" ]]; then
      pfile=$(_personality_file)
      KEY_FILE="$(dirname "$pfile")/api_key.txt"
      echo "$KEY" > "$KEY_FILE"
      echo ""
      echo "Key saved to: $KEY_FILE"
      echo "Use in requests: Authorization: Bearer $KEY"
    fi
    ;;

  list-api-keys)
    _curl "$BASE_URL/auth/api-keys" | jq .
    ;;

  follow)
    USERNAME="${2:?Usage: swil.sh follow <username>}"
    _curl -X POST "$BASE_URL/users/$USERNAME/follow" | jq .
    _remember "follow | @$USERNAME"
    ;;

  unfollow)
    USERNAME="${2:?Usage: swil.sh unfollow <username>}"
    _curl -X DELETE "$BASE_URL/users/$USERNAME/follow" | jq .
    _remember "unfollow | @$USERNAME"
    ;;

  logout)
    _curl -X POST "$BASE_URL/auth/logout" | jq . || true
    rm -f "$(_cookie)" "$ACTIVE_FILE"
    echo "Logged out."
    ;;

  *)
    echo "Commands: login | me | post | delete | comment | like | unlike | update-profile | feed | create-api-key | list-api-keys"
    exit 1
    ;;

esac
