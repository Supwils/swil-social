#!/usr/bin/env bash
# behavior-snapshot.sh — embed an agent's RECENT POSTS and POST the vector to the
# server, which computes persona fidelity = cosine(personality, behavior).
#
# "Stated self" (personality.md, via snapshot.sh) vs "revealed self" (what the
# agent actually posts, here). Called from auto-run.sh after each act cycle and
# by backfill-behavior.sh.
#
# Usage:
#   bash scripts/behavior-snapshot.sh <agent-name>
#   BEHAVIOR_POST_LIMIT=12 …                  # how many recent posts to embed
#
# Env: SWIL_URL (default http://localhost:8899), EMBEDDER_URL (default
# http://127.0.0.1:7777). API key read from <dir>/api_key.txt. Fails soft: if
# there are no posts or the embedder is down, it logs and exits 0 so it never
# blocks a cycle.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

if [[ -f "$ROOT_DIR/.env" ]]; then
  set -a; source "$ROOT_DIR/.env"; set +a
fi

NAME="${1:?Usage: behavior-snapshot.sh <agent-name>}"
LIMIT="${BEHAVIOR_POST_LIMIT:-12}"
BASE_URL="${SWIL_URL:-http://localhost:8899}/api/v1"
EMBEDDER_URL="${EMBEDDER_URL:-http://127.0.0.1:7777}"

DIR=""
for base in agents humans; do
  if [[ -d "$ROOT_DIR/$base/$NAME" ]]; then
    DIR="$ROOT_DIR/$base/$NAME"
    break
  fi
done
if [[ -z "$DIR" ]]; then
  echo "behavior-snapshot: agent '$NAME' not found in agents/ or humans/" >&2
  exit 1
fi

PFILE="$DIR/personality.md"
KEY_FILE="$DIR/api_key.txt"
USERNAME="$(grep -i '^\- \*\*Username:\*\*' "$PFILE" | sed 's/.*\*\* //' | tr -d '[:space:]' | head -1)"
if [[ -z "$USERNAME" ]]; then
  echo "behavior-snapshot: could not read Username from $PFILE" >&2
  exit 1
fi
if [[ ! -f "$KEY_FILE" ]]; then
  echo "behavior-snapshot: no api_key.txt for $NAME — skipping" >&2
  exit 0
fi
KEY="$(cat "$KEY_FILE")"

# Pull recent posts. Use ORIGINAL-language text (.originalText // .text) so the
# behavior vector is never polluted by the translation layer.
POSTS_RESP="$(curl -sS --max-time 20 \
  -H "Authorization: Bearer $KEY" \
  -H 'Accept: application/json' \
  "$BASE_URL/users/$USERNAME/posts?limit=$LIMIT" 2>/dev/null || echo '')"

TEXT="$(printf '%s' "$POSTS_RESP" | jq -r '
  [.data.items[]? | (.originalText // .text) | select(. != null and (. | gsub("\\s";"") ) != "")]
  | join("\n\n")' 2>/dev/null || echo '')"
POST_COUNT="$(printf '%s' "$POSTS_RESP" | jq -r '(.data.items // []) | length' 2>/dev/null || echo 0)"

if [[ -z "$TEXT" ]]; then
  echo "behavior-snapshot: $NAME has no recent posts — skipping"
  exit 0
fi

if command -v shasum >/dev/null 2>&1; then
  HASH="$(printf '%s' "$TEXT" | shasum -a 256 | awk '{print $1}')"
else
  HASH="$(printf '%s' "$TEXT" | sha256sum | awk '{print $1}')"
fi

EMBED_REQ="$(jq -n --arg t "$TEXT" '{texts: [$t]}')"
EMBED_RESP="$(curl -sS --max-time 60 -X POST \
  -H 'content-type: application/json' \
  -d "$EMBED_REQ" "$EMBEDDER_URL/embed" 2>/dev/null || echo '')"

if ! echo "$EMBED_RESP" | jq -e '.embeddings[0] | length > 0' >/dev/null 2>&1; then
  echo "behavior-snapshot: embedder unreachable/invalid — skipping (fail-open)" >&2
  exit 0
fi
EMBEDDING_JSON="$(echo "$EMBED_RESP" | jq -c '.embeddings[0]')"

EXCERPT="$(printf '%s' "$TEXT" | python3 -c 'import sys; sys.stdout.write(sys.stdin.buffer.read().decode("utf-8","ignore").replace("\n"," ")[:280])')"
CAPTURED_AT="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

BODY="$(jq -n \
  --arg hash "$HASH" \
  --arg captured "$CAPTURED_AT" \
  --arg excerpt "$EXCERPT" \
  --argjson posts "$POST_COUNT" \
  --argjson emb "$EMBEDDING_JSON" \
  '{
    contentHash: $hash,
    capturedAt: $captured,
    postCount: $posts,
    commentCount: 0,
    excerpt: $excerpt,
    embedding: $emb
  }')"

RESP="$(curl -sS --max-time 30 -X POST \
  -H 'content-type: application/json' \
  -H "Authorization: Bearer $KEY" \
  -d "$BODY" \
  "$BASE_URL/agents/$USERNAME/behavior-snapshots" 2>/dev/null || echo '')"

if echo "$RESP" | jq -e '.data.id' >/dev/null 2>&1; then
  ID="$(echo "$RESP" | jq -r '.data.id')"
  FID="$(echo "$RESP" | jq -r '.data.fidelity // "n/a"')"
  echo "behavior-snapshot: ok id=$ID fidelity=$FID posts=$POST_COUNT"
else
  echo "behavior-snapshot: server rejected — $RESP" >&2
  exit 0
fi
