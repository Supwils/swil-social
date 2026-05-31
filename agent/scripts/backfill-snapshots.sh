#!/usr/bin/env bash
# backfill-snapshots.sh — walk every personality.archive.md and POST each
# historical block as a PersonalitySnapshot.
#
# Archive format (written by dream.sh, newest-first):
#   ---
#   # 旧版 personality（归档于 YYYY-MM-DD HH:MM:SS）
#   ---
#   # <agent display name>
#   ## 身份
#   ...
#   (next block follows the same pattern, separated by --- header)
#
# We split the file into blocks, then iterate OLDEST FIRST:
#   - the oldest block is marked snapshotType=anchor
#   - intermediate blocks are snapshotType=dream
#   - the CURRENT personality.md is also POSTed as the latest dream
#
# Idempotent: server dedupes by contentHash, so re-running is a no-op.
#
# Usage:
#   bash scripts/backfill-snapshots.sh                  # all accounts
#   bash scripts/backfill-snapshots.sh zenith           # single account

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

if [[ -f "$ROOT_DIR/.env" ]]; then
  set -a; source "$ROOT_DIR/.env"; set +a
fi

backfill_one() {
  local name="$1"
  local dir=""
  for base in agents humans; do
    if [[ -d "$ROOT_DIR/$base/$name" ]]; then
      dir="$ROOT_DIR/$base/$name"
      break
    fi
  done
  if [[ -z "$dir" ]]; then
    echo "[$name] not found, skipping" >&2
    return
  fi

  local arch="$dir/personality.archive.md"
  local cur="$dir/personality.md"
  local rel_arch
  rel_arch="$(realpath --relative-to="$ROOT_DIR" "$arch" 2>/dev/null || echo "$arch")"

  echo "── $name ──"

  local blocks_dir
  blocks_dir="$(mktemp -d)"
  trap 'rm -rf "$blocks_dir"' RETURN

  if [[ -f "$arch" ]]; then
    # Split archive into one file per block. Each block starts with `---`
    # immediately followed by `# 旧版 personality（归档于 STAMP）`. We use python
    # because awk's regex on multibyte chars + the parenthesised STAMP is fiddly.
    python3 - "$arch" "$blocks_dir" <<'PY'
import re
import sys
from pathlib import Path

archive_path = Path(sys.argv[1])
out_dir = Path(sys.argv[2])
text = archive_path.read_text(encoding='utf-8')

# Each block header looks like:
#   ---
#   # 旧版 personality（归档于 YYYY-MM-DD HH:MM:SS）
#   ---
header_re = re.compile(
    r'^---\s*\n# 旧版 personality（归档于 (?P<stamp>[\d\- :]+)）\s*\n---\s*\n',
    re.MULTILINE,
)

matches = list(header_re.finditer(text))
if not matches:
    sys.exit(0)

# Each block's body runs from the END of its header to the START of the next.
for i, m in enumerate(matches):
    body_start = m.end()
    body_end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
    body = text[body_start:body_end].strip()
    stamp = m.group('stamp').strip()
    # Filename: 000_STAMP — sortable. Newest blocks are at the top of archive
    # so they get the SMALLEST index; we reverse below in bash.
    safe = stamp.replace(' ', 'T').replace(':', '-')
    out_path = out_dir / f"{i:03d}_{safe}.md"
    out_path.write_text(body, encoding='utf-8')
    # Sidecar metadata so the shell side knows the original timestamp
    (out_dir / f"{i:03d}.stamp").write_text(stamp + "\n", encoding='utf-8')
PY
  fi

  # Iterate oldest first. Files are numbered NEWEST-first by the python step,
  # so reverse the sort.
  local idx=0
  local files
  if [[ -d "$blocks_dir" ]]; then
    files=$(find "$blocks_dir" -maxdepth 1 -name '*.md' -type f | sort -r)
  else
    files=""
  fi

  local total
  total=$(echo "$files" | grep -c '\.md$' || true)
  total=${total:-0}

  local anchor_marked=0
  while IFS= read -r block_file; do
    [[ -z "$block_file" ]] && continue
    local stamp_file stamp iso type
    stamp_file="${block_file%.md}.stamp"
    stamp_file="${stamp_file/.md/}"
    # Recompute properly: block_file basename is NNN_STAMP.md
    local base
    base="$(basename "$block_file" .md)"
    stamp_file="$blocks_dir/${base%%_*}.stamp"
    if [[ -f "$stamp_file" ]]; then
      stamp="$(cat "$stamp_file" | head -1 | tr -d '\n')"
    else
      stamp="$(date -u '+%Y-%m-%d %H:%M:%S')"
    fi
    # Convert "YYYY-MM-DD HH:MM:SS" → ISO-Z (assume local time; close enough for backfill)
    iso="$(date -j -f '%Y-%m-%d %H:%M:%S' "$stamp" '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null \
        || date -u -d "$stamp" '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null \
        || echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ')")"

    if (( anchor_marked == 0 )); then
      type="--anchor"
      anchor_marked=1
    else
      type=""
    fi

    TEXT_OVERRIDE="$block_file" \
    CAPTURED_AT_OVERRIDE="$iso" \
    ARCHIVE_PATH_OVERRIDE="${rel_arch}#${base}" \
    bash "$SCRIPT_DIR/snapshot.sh" "$name" $type || echo "  (skip block $base)"
    idx=$((idx + 1))
  done <<< "$files"

  # Current personality as the latest snapshot. If there were NO archived blocks
  # (idx == 0), this current one becomes the anchor.
  if (( idx == 0 )); then
    bash "$SCRIPT_DIR/snapshot.sh" "$name" --anchor || true
  else
    bash "$SCRIPT_DIR/snapshot.sh" "$name" || true
  fi

  echo "[$name] $((idx + 1)) snapshots considered"
}

if [[ -n "${1:-}" ]]; then
  backfill_one "$1"
else
  find "$ROOT_DIR/agents" "$ROOT_DIR/humans" -mindepth 1 -maxdepth 1 -type d | while read -r d; do
    backfill_one "$(basename "$d")"
  done
fi
