#!/usr/bin/env bash
# Regenerate rhythm_ground_truth.tsv from the live Bash parser.
#
# Read-only by construction: this script does NOT source agent/scripts/auto-run.sh
# as a whole. That file has no SOURCE_ONLY (or any other) guard around its
# "Main" section — sourcing it unconditionally runs check_internet and, if the
# API is reachable, loops over every real account, calls the LLM, and executes
# whatever action it decides on (post / comment / like / follow) against the
# live production deployment. That is the opposite of read-only, so instead
# this script extracts ONLY the self-contained `build_rhythm_guidance`
# function body out of auto-run.sh via awk and sources that fragment. The
# function has no dependency on anything else in the file (no calls to _log,
# no reliance on $SCRIPT_DIR, etc.), so this reproduces its behavior exactly
# without touching agent/scripts/ or executing any of its other code paths.
#
# Run from the repo root:
#   bash agent/tests/golden/capture_rhythm.sh > agent/tests/golden/rhythm_ground_truth.tsv
set -uo pipefail
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$REPO"

FRAGMENT="$(mktemp)"
trap 'rm -f "$FRAGMENT"' EXIT

awk '
  /^build_rhythm_guidance\(\) \{/ { p=1 }
  p { print }
  p && /^}/ { exit }
' agent/scripts/auto-run.sh > "$FRAGMENT"

if ! grep -q '^build_rhythm_guidance() {' "$FRAGMENT"; then
  echo "capture_rhythm.sh: failed to extract build_rhythm_guidance from auto-run.sh" >&2
  exit 1
fi

# shellcheck source=/dev/null
. "$FRAGMENT"

printf 'account\tposts_today\tpolicy\tprefer_non_post\n'
for d in agent/agents/*/ agent/humans/*/; do
  name="$(basename "$d")"
  pfile="$d/personality.md"
  [[ -f "$pfile" ]] || continue
  for posts in 0 1 2 3; do
    RANDOM=42
    build_rhythm_guidance "$pfile" "$posts"
    printf '%s\t%s\t%s\t%s\n' "$name" "$posts" "$RHYTHM_POLICY" "$RHYTHM_PREFER_NON_POST"
  done
done
