#!/usr/bin/env bash
# rule-check.sh — check whether an agent's recent posts obey the agent's OWN
# stated, machine-checkable writing rules (hashtag count, no-exclamation), and
# emit a `rule_check` lab event per rule with the adherence rate.
#
# Only deterministically-parseable rules are checked; free-form `行为规则` prose
# is left for a future LLM judge. Fail-soft: no posts / no parseable rules ⇒
# exits 0 without emitting.
#
# Usage:
#   bash scripts/rule-check.sh <agent-name>
#
# Env: SWIL_URL (default http://localhost:8899). Uses <dir>/api_key.txt.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

if [[ -f "$ROOT_DIR/.env" ]]; then
  set -a; source "$ROOT_DIR/.env"; set +a
fi

NAME="${1:?Usage: rule-check.sh <agent-name>}"
LIMIT="${RULE_CHECK_POST_LIMIT:-12}"
BASE_URL="${SWIL_URL:-http://localhost:8899}/api/v1"

DIR=""
for base in agents humans; do
  [[ -d "$ROOT_DIR/$base/$NAME" ]] && DIR="$ROOT_DIR/$base/$NAME" && break
done
[[ -z "$DIR" ]] && { echo "rule-check: '$NAME' not found" >&2; exit 1; }

PFILE="$DIR/personality.md"
KEY_FILE="$DIR/api_key.txt"
USERNAME="$(grep -i '^\- \*\*Username:\*\*' "$PFILE" | sed 's/.*\*\* //' | tr -d '[:space:]' | head -1)"
[[ -z "$USERNAME" ]] && { echo "rule-check: no Username in $PFILE" >&2; exit 1; }
[[ ! -f "$KEY_FILE" ]] && { echo "rule-check: no api_key.txt for $NAME — skipping" >&2; exit 0; }
KEY="$(cat "$KEY_FILE")"

POSTS_RESP="$(curl -sS --max-time 20 \
  -H "Authorization: Bearer $KEY" -H 'Accept: application/json' \
  "$BASE_URL/users/$USERNAME/posts?limit=$LIMIT" 2>/dev/null || echo '')"

# Parse rules + score posts in Python (CJK range parsing is painful in bash).
EVENTS_JSON="$(POSTS_JSON="$POSTS_RESP" python3 - "$PFILE" <<'PY'
import json, os, re, sys

pfile = sys.argv[1]
text = open(pfile, encoding="utf-8").read()

posts_raw = os.environ.get("POSTS_JSON", "") or "{}"
try:
    items = (json.loads(posts_raw).get("data") or {}).get("items") or []
except Exception:
    items = []
posts = []
for it in items:
    t = it.get("originalText") or it.get("text") or ""
    if t.strip():
        posts.append(t)

events = []
total = len(posts)

def emit(rule, passes, checked, detail):
    if checked == 0:
        return
    rate = round(passes / checked, 4)
    pct = round(rate * 100)
    events.append({
        "type": "rule_check",
        "phase": "rule",
        "outcome": "success" if rate >= 0.8 else "flagged",
        "summary": f"{detail}: {passes}/{checked} posts adherent ({pct}%)",
        "metrics": {"rule": rule, "passRate": rate, "checked": checked},
    })

# --- hashtag count rule ---
# An explicit range (e.g. "2～4 个") anywhere wins; otherwise fall back to the
# first looser statement ("至少 2", "必带", "偶尔用一个").
hashtag_min = hashtag_max = None
fallback = None
for line in text.splitlines():
    low = line.lower()
    if "hashtag" not in low and "标签" not in line:
        continue
    m = re.search(r"(\d+)\s*[～~\-－]\s*(\d+)", line)
    if m:
        hashtag_min, hashtag_max = int(m.group(1)), int(m.group(2))
        break
    if fallback is None:
        m = re.search(r"至少\s*(\d+)", line)
        if m:
            fallback = (int(m.group(1)), 99)
        elif re.search(r"不用\s*hashtag|不用标签|偶尔用一个|不带\s*hashtag", line):
            fallback = (0, 1)
        elif re.search(r"每帖必带|必须用\s*hashtag", low) or "必带 hashtag" in low:
            fallback = (1, 99)
if hashtag_min is None and fallback is not None:
    hashtag_min, hashtag_max = fallback

if hashtag_min is not None and total:
    tag_re = re.compile(r"[#＃][0-9A-Za-z_一-鿿]+")
    passes = sum(1 for p in posts if hashtag_min <= len(tag_re.findall(p)) <= hashtag_max)
    hi = "" if hashtag_max >= 99 else f"-{hashtag_max}"
    emit("hashtag_count", passes, total, f"hashtag count {hashtag_min}{hi}")

# --- no-exclamation rule ---
if re.search(r"(不用|不喜欢|绝不用|永远不用|不使用)[^。\n]{0,8}感叹号", text):
    passes = sum(1 for p in posts if "!" not in p and "！" not in p)
    emit("no_exclamation", passes, total, "no exclamation mark")

print(json.dumps(events, ensure_ascii=False))
PY
)"

COUNT="$(printf '%s' "$EVENTS_JSON" | jq 'length' 2>/dev/null || echo 0)"
if [[ "$COUNT" == "0" || -z "$COUNT" ]]; then
  echo "rule-check: $NAME — no parseable rules or no posts; nothing to check"
  exit 0
fi

printf '%s' "$EVENTS_JSON" | jq -c '.[]' | while IFS= read -r ev; do
  curl -sS --max-time 10 -X POST \
    -H 'content-type: application/json' \
    -H "Authorization: Bearer $KEY" \
    -d "$ev" \
    "$BASE_URL/agents/$USERNAME/events" >/dev/null 2>&1 || true
  echo "rule-check: $(printf '%s' "$ev" | jq -r '.summary')"
done
