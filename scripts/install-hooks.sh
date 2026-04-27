#!/usr/bin/env bash
# install-hooks.sh — symlinks the version-controlled git hooks in
# scripts/git-hooks/ into .git/hooks/. Run once after cloning the repo.
#
# Idempotent — safe to re-run; reinstalls (clobbers) existing hooks.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/scripts/git-hooks"
DEST="$ROOT/.git/hooks"

if [[ ! -d "$ROOT/.git" ]]; then
  echo "Error: not a git repo (no .git/ at $ROOT)" >&2
  exit 1
fi

mkdir -p "$DEST"

for hook in "$SRC"/*; do
  name="$(basename "$hook")"
  chmod +x "$hook"
  ln -sf "$hook" "$DEST/$name"
  echo "  ✓ installed $name → $hook"
done

echo "Done. Hooks active. Bypass any single hook with --no-verify."
