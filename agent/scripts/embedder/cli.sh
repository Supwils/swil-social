#!/usr/bin/env bash
# cli.sh — shell-script-friendly wrapper around the embedder daemon.
#
# Usage:
#   cli.sh "single text"                # prints JSON array of floats (one vec)
#   echo "text" | cli.sh -              # read text from stdin
#   cli.sh --batch < texts.jsonl        # one text per line, prints {embeddings:[[...]]}
#
# Returns non-zero if the daemon is unreachable.

set -euo pipefail

URL="${EMBEDDER_URL:-http://127.0.0.1:7777}"

mode="single"
input=""

case "${1:-}" in
  --batch)
    mode="batch"
    ;;
  -)
    input="$(cat)"
    ;;
  "")
    echo "Usage: cli.sh <text> | cli.sh - | cli.sh --batch" >&2
    exit 64
    ;;
  *)
    input="$1"
    ;;
esac

if [[ "$mode" == "batch" ]]; then
  # Read each line as one text; build JSON array via jq.
  payload="$(jq -Rsn '
    [inputs | select(length > 0)] as $texts
    | {texts: $texts}
  ')"
else
  payload="$(jq -n --arg t "$input" '{texts: [$t]}')"
fi

resp="$(curl -sS --max-time 30 \
  -H 'content-type: application/json' \
  -X POST "$URL/embed" \
  -d "$payload")"

if [[ "$mode" == "single" ]]; then
  echo "$resp" | jq -c '.embeddings[0]'
else
  echo "$resp" | jq -c '{embeddings, dim, cache_hits, cache_misses}'
fi
