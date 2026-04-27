#!/usr/bin/env bash
# rotate-memory.sh — keep agent memory.md from growing unbounded
#
# When memory.md exceeds THRESHOLD lines, archive the oldest 80% to
# memory.archive.md (chronologically prepended) and keep only the most recent
# 20% in memory.md. Idempotent and safe to run on cron / pre-commit.
#
# Usage:
#   bash scripts/rotate-memory.sh           # rotate every agent + human
#   bash scripts/rotate-memory.sh liushang  # rotate one specifically

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

THRESHOLD=500   # rotate when memory.md exceeds this many lines
KEEP_RATIO=20   # keep the most recent N% of lines in memory.md after rotation

rotate_one() {
  local memfile="$1"
  if [[ ! -f "$memfile" ]]; then return; fi

  local total
  total=$(wc -l < "$memfile" | tr -d ' ')
  if (( total < THRESHOLD )); then
    return
  fi

  local archive="${memfile%/*}/memory.archive.md"
  local keep_lines=$(( total * KEEP_RATIO / 100 ))
  local archive_lines=$(( total - keep_lines ))

  # Prepend the oldest archive_lines to memory.archive.md (newest archived
  # entries first across rotations — easier to scan).
  local tmp_archive tmp_new
  tmp_archive="$(mktemp)"
  tmp_new="$(mktemp)"

  head -n "$archive_lines" "$memfile" > "$tmp_archive"
  tail -n "$keep_lines" "$memfile" > "$tmp_new"

  if [[ -f "$archive" ]]; then
    cat "$tmp_archive" "$archive" > "${archive}.tmp" && mv "${archive}.tmp" "$archive"
  else
    mv "$tmp_archive" "$archive"
  fi
  rm -f "$tmp_archive"
  mv "$tmp_new" "$memfile"

  local agent
  agent="$(basename "$(dirname "$memfile")")"
  echo "rotated $agent: $total → $keep_lines lines (archived $archive_lines)"
}

if [[ -n "${1:-}" ]]; then
  for base in agents humans; do
    candidate="$ROOT_DIR/$base/$1/memory.md"
    if [[ -f "$candidate" ]]; then
      rotate_one "$candidate"
      exit 0
    fi
  done
  echo "no agent or human named '$1' found" >&2
  exit 1
fi

# All agents + humans
find "$ROOT_DIR/agents" "$ROOT_DIR/humans" -mindepth 2 -maxdepth 2 -name memory.md -type f | \
  while read -r mf; do
    rotate_one "$mf"
  done
