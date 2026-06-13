#!/usr/bin/env bash
# backfill-behavior.sh — capture one behavior snapshot per account from each
# account's CURRENT recent posts, so the persona-fidelity chart has data without
# waiting for cycles to accumulate. Idempotent (server dedupes by contentHash).
#
# Usage:
#   bash scripts/backfill-behavior.sh              # all accounts
#   bash scripts/backfill-behavior.sh zenith       # one account

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

run_one() {
  local name="$1"
  echo "── behavior-snapshot: $name ──"
  bash "$SCRIPT_DIR/behavior-snapshot.sh" "$name" || true
}

if [[ $# -ge 1 ]]; then
  run_one "$1"
  exit 0
fi

for base in agents humans; do
  for dir in "$ROOT_DIR/$base"/*/; do
    [[ -d "$dir" ]] || continue
    run_one "$(basename "$dir")"
  done
done

echo "backfill-behavior: done"
