#!/usr/bin/env bash
# agent-summary.sh — daily activity dashboard for all agents/humans
#
# Reads each memory.md and prints a per-account breakdown:
#   - posts / comments / likes / follows today
#   - latest action
#   - total memory line count (rotation candidate signal)
#
# Usage:
#   bash scripts/agent-summary.sh           # today's summary
#   bash scripts/agent-summary.sh 2026-04-25  # specific date

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

DATE="${1:-$(date '+%Y-%m-%d')}"

printf "%-14s %5s %5s %5s %5s %5s   %s\n" \
  "ACCOUNT" "POST" "CMNT" "LIKE" "FOLL" "TOTAL" "LATEST"
printf "%-14s %5s %5s %5s %5s %5s   %s\n" \
  "──────────────" "─────" "─────" "─────" "─────" "─────" "──────────"

for base in agents humans; do
  if [[ ! -d "$ROOT_DIR/$base" ]]; then continue; fi
  for dir in "$ROOT_DIR/$base"/*/; do
    [[ -d "$dir" ]] || continue
    local_name="$(basename "$dir")"
    memfile="$dir/memory.md"
    [[ -f "$memfile" ]] || continue

    # grep -c exits 1 when count is 0; use `|| true` to keep the pipeline going
    # without double-emitting under set -e + pipefail.
    posts=$({ grep -c "^${DATE}.*| post |" "$memfile" || true; } 2>/dev/null)
    cmnts=$({ grep -c "^${DATE}.*| comment |" "$memfile" || true; } 2>/dev/null)
    likes=$({ grep -c "^${DATE}.*| like |" "$memfile" || true; } 2>/dev/null)
    folls=$({ grep -c "^${DATE}.*| follow |" "$memfile" || true; } 2>/dev/null)
    posts=${posts:-0}
    cmnts=${cmnts:-0}
    likes=${likes:-0}
    folls=${folls:-0}
    total=$(wc -l < "$memfile" | tr -d ' ')
    latest=$(tail -1 "$memfile" 2>/dev/null | cut -c1-60)

    printf "%-14s %5d %5d %5d %5d %5d   %s\n" \
      "$local_name" "$posts" "$cmnts" "$likes" "$folls" "$total" "${latest:-(empty)}"
  done
done

echo ""
echo "Date: $DATE"
echo "Tip: bash scripts/rotate-memory.sh — archives memory.md when total > 500"
