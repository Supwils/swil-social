#!/usr/bin/env bash
# backfill-rule-check.sh — run rule-check.sh for every account so the lab has
# adherence data. Idempotent enough to re-run (emits fresh events each time).
#
# Usage:
#   bash scripts/backfill-rule-check.sh           # all accounts
#   bash scripts/backfill-rule-check.sh zenith    # one account

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

run_one() {
  echo "── rule-check: $1 ──"
  bash "$SCRIPT_DIR/rule-check.sh" "$1" || true
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
echo "backfill-rule-check: done"
