#!/usr/bin/env bash
# snapshot.sh — embed the current personality.md and POST it to the server.
#
# Usage:
#   bash scripts/snapshot.sh <agent-name>             # snapshot current personality.md
#   bash scripts/snapshot.sh <agent-name> --anchor    # mark as anchor
#   TEXT_OVERRIDE=/path snapshot.sh <name>            # embed an arbitrary file
#                                                       (used by backfill for archived blocks)
#   CAPTURED_AT_OVERRIDE='2026-04-22T18:30:00Z' …     # override timestamp
#   ARCHIVE_PATH_OVERRIDE='agents/x/p.archive.md#3' … # override archivePath
#   EXCERPT_OVERRIDE='first 200 chars…'               # override excerpt
#
# Called automatically by dream.sh on a successful dream; also invoked
# repeatedly by backfill-snapshots.sh.
#
# Env: SWIL_URL (defaults to http://localhost:8899), EMBEDDER_URL (defaults to
# http://127.0.0.1:7777). The agent's API key is read from
# agents/<name>/api_key.txt (or humans/<name>/api_key.txt).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

if [[ -f "$ROOT_DIR/.env" ]]; then
  set -a; source "$ROOT_DIR/.env"; set +a
fi

NAME="${1:?Usage: snapshot.sh <agent-name> [--anchor]}"
TYPE="dream"
if [[ "${2:-}" == "--anchor" ]]; then
  TYPE="anchor"
fi

BASE_URL="${SWIL_URL:-http://localhost:8899}/api/v1"
EMBEDDER_URL="${EMBEDDER_URL:-http://127.0.0.1:7777}"

# Find dir
DIR=""
for base in agents humans; do
  if [[ -d "$ROOT_DIR/$base/$NAME" ]]; then
    DIR="$ROOT_DIR/$base/$NAME"
    break
  fi
done
if [[ -z "$DIR" ]]; then
  echo "snapshot: agent '$NAME' not found in agents/ or humans/" >&2
  exit 1
fi

PFILE="$DIR/personality.md"
KEY_FILE="$DIR/api_key.txt"
TEXT_FILE="${TEXT_OVERRIDE:-$PFILE}"

# Platform username is taken from personality.md (Username field), not the
# directory name — agent dir 'sketch' is actually @diannaokun on the platform.
USERNAME="$(grep -i '^\- \*\*Username:\*\*' "$PFILE" | sed 's/.*\*\* //' | tr -d '[:space:]' | head -1)"
if [[ -z "$USERNAME" ]]; then
  echo "snapshot: could not read Username from $PFILE" >&2
  exit 1
fi

if [[ ! -f "$TEXT_FILE" ]]; then
  echo "snapshot: $TEXT_FILE missing" >&2
  exit 1
fi
if [[ ! -f "$KEY_FILE" ]]; then
  echo "snapshot: no api_key.txt for $NAME — run swil.sh create-api-key first" >&2
  exit 1
fi

TEXT="$(cat "$TEXT_FILE")"
if [[ -z "$TEXT" ]]; then
  echo "snapshot: $TEXT_FILE is empty" >&2
  exit 1
fi

# sha256
if command -v shasum >/dev/null 2>&1; then
  HASH="$(printf '%s' "$TEXT" | shasum -a 256 | awk '{print $1}')"
else
  HASH="$(printf '%s' "$TEXT" | sha256sum | awk '{print $1}')"
fi

# Embedding via local daemon
EMBED_REQ="$(jq -n --arg t "$TEXT" '{texts: [$t]}')"
EMBED_RESP="$(curl -sS --max-time 60 -X POST \
  -H 'content-type: application/json' \
  -d "$EMBED_REQ" "$EMBEDDER_URL/embed")"

if ! echo "$EMBED_RESP" | jq -e '.embeddings[0] | length > 0' >/dev/null 2>&1; then
  echo "snapshot: embedder did not return a valid vector: $EMBED_RESP" >&2
  exit 1
fi

EMBEDDING_JSON="$(echo "$EMBED_RESP" | jq -c '.embeddings[0]')"

# Character-based 280 truncation. `head -c 280` cuts at byte 280, which lands
# mid-way through a multibyte (e.g. 3-byte CJK) character and leaves a stray
# byte; BSD `tr` then errors "Illegal byte sequence" under a UTF-8 locale and,
# with set -e, aborts the whole snapshot. Decode as UTF-8 (ignoring any stray
# bytes), swap newlines for spaces, and slice the first 280 *characters* so the
# excerpt is always valid UTF-8 for the downstream `jq --arg`.
EXCERPT="${EXCERPT_OVERRIDE:-$(printf '%s' "$TEXT" | python3 -c 'import sys; sys.stdout.write(sys.stdin.buffer.read().decode("utf-8","ignore").replace("\n"," ")[:280])')}"
ARCHIVE_PATH="${ARCHIVE_PATH_OVERRIDE:-$(printf '%s/personality.md' "$(realpath --relative-to="$ROOT_DIR" "$DIR" 2>/dev/null || echo "$DIR")")}"
CAPTURED_AT="${CAPTURED_AT_OVERRIDE:-$(date -u '+%Y-%m-%dT%H:%M:%SZ')}"

BODY="$(jq -n \
  --arg hash "$HASH" \
  --arg type "$TYPE" \
  --arg captured "$CAPTURED_AT" \
  --arg archive "$ARCHIVE_PATH" \
  --arg excerpt "$EXCERPT" \
  --argjson emb "$EMBEDDING_JSON" \
  '{
    contentHash: $hash,
    snapshotType: $type,
    capturedAt: $captured,
    archivePath: $archive,
    excerpt: $excerpt,
    embedding: $emb
  }')"

post_snapshot_event() {
  local outcome="$1" summary="$2" metrics="${3:-{}}"
  if ! printf '%s' "$metrics" | jq -e 'type == "object"' >/dev/null 2>&1; then
    metrics="{}"
  fi
  local event_body
  event_body="$(jq -n \
    --arg summary "$summary" \
    --arg outcome "$outcome" \
    --argjson metrics "$metrics" \
    '{
      type: "snapshot",
      phase: "snapshot",
      outcome: $outcome,
      summary: $summary,
      metrics: $metrics
    }')"
  curl -sS --max-time 8 -X POST \
    -H 'content-type: application/json' \
    -H "Authorization: Bearer $(cat "$KEY_FILE")" \
    -d "$event_body" \
    "$BASE_URL/agents/$USERNAME/events" >/dev/null 2>&1 || true
}

RESP="$(curl -sS --max-time 30 -X POST \
  -H 'content-type: application/json' \
  -H "Authorization: Bearer $(cat "$KEY_FILE")" \
  -d "$BODY" \
  "$BASE_URL/agents/$USERNAME/snapshots")"

if echo "$RESP" | jq -e '.data.id' >/dev/null 2>&1; then
  ID="$(echo "$RESP" | jq -r '.data.id')"
  DA="$(echo "$RESP" | jq -r '.data.driftFromAnchor')"
  DP="$(echo "$RESP" | jq -r '.data.driftFromPrev')"
  post_snapshot_event "success" "snapshot uploaded" "$(jq -n --argjson anchor "$DA" --argjson prev "$DP" '{driftFromAnchor: $anchor, driftFromPrev: $prev}')"
  echo "snapshot: ok id=$ID type=$TYPE driftAnchor=$DA driftPrev=$DP"
else
  post_snapshot_event "warn" "snapshot rejected by server"
  echo "snapshot: server rejected — $RESP" >&2
  exit 1
fi
