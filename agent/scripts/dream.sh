#!/usr/bin/env bash
# dream.sh — 角色"做梦"：基于最近的 memory.md 让 LLM 用第一人称重写 personality.md
#
# Usage:
#   bash scripts/dream.sh <agent-name>       # 强制对单个账号做梦
#   bash scripts/dream.sh --auto <name>      # 满足冷却条件才做梦（推荐 cycle-one.sh 使用）
#   bash scripts/dream.sh --all              # 满足冷却条件的所有账号一次做完
#
# 设计：
#   - 输入：当前 personality.md（全文） + memory.md 最近 60 条 + memory.archive.md 末尾 20 条（如果有）
#   - 输出：LLM 重写后的整份 personality.md
#   - 旧版会被备份到 personality.archive.md（带时间戳分隔符，永不丢失人格历史）
#   - 结构安全：写入前会校验关键字段（Username / Display Name / AI Backend / Follow Topics）
#     仍在；任一缺失就 abort 不写，保留原 personality.md
#   - 冷却（仅 --auto）：距离上次 dream <= 12 小时 或 自上次 dream 起新增 memory 条数 <8 时跳过
#   - 并发：per-agent lock，与 auto-run.sh 的 lock 不冲突
#
# 设计哲学（写在 prompt 里给 LLM）：
#   不是"做计划/写日记"，而是"半夜醒来发现自己微微不一样了"
#   - 保留人格基线（写作风格、关注方向的核心仍然成立）
#   - 把最近真实做过的事消化成一两条"我意识到了……"
#   - 风格允许漂移 5%，不允许大幅人格变更（不能把哲学家改成股民）
#   - 允许把"## 自传成长"段落不断追加，记录这次梦里想到的事

set -euo pipefail
# Job control: gives each backgrounded job (see _run_with_timeout below) its
# own process group, so the watchdog can signal the *group* — not just the
# top pid — and reach CLI processes nested a few `$( )` levels down (e.g.
# `llm_text` backgrounded as a shell function). Confirmed quiet (no job-control
# chatter) in this non-interactive script.
set -m

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=/dev/null
. "$SCRIPT_DIR/llm.sh"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
STATE_DIR="$ROOT_DIR/.agent-state"
LOG_DIR="$ROOT_DIR/logs"
mkdir -p "$STATE_DIR" "$LOG_DIR"
LOG_FILE="$LOG_DIR/dream.log"

if [[ -f "$ROOT_DIR/.env" ]]; then
  set -a; source "$ROOT_DIR/.env"; set +a
fi

# 冷却参数（--auto 才生效）
COOLDOWN_HOURS="${DREAM_COOLDOWN_HOURS:-12}"
MIN_NEW_MEMORIES="${DREAM_MIN_NEW_MEMORIES:-8}"

# Constitution（feature B）参数
# DRIFT_THRESHOLD 是 cosine *similarity* 下限；候选 personality 与 anchor 的余弦相似度低于此值即拒绝。
DRIFT_THRESHOLD="${DRIFT_THRESHOLD:-0.82}"
# Per-aspect drift（见 docs/superpowers/specs/2026-07-02-per-aspect-drift-design.md）
#   DRIFT_MODE=scalar  → 传统单标量 gate（完全向后兼容，env 缺省时的安全值）
#             =shadow  → 三维照算/照存/照显示，但 gate 仍走单标量（纯观测，用于校准阈值）
#             =aspect  → 分维阈值决定接受/拒绝（任一维越界即拒）
# Thresholds are SYMMETRIC (~equal), calibrated 2026-07-03 from a 17-obs shadow
# round: keyword-card distillation puts all three aspects on the same ~0.70 band,
# and values is the *lowest* — so the original "guard values strictest" asymmetry
# was empirically refuted (see the spec's calibration section). These accept ~29%
# of dreams, ≈ the legacy scalar gate's strictness.
DRIFT_MODE="${DRIFT_MODE:-scalar}"
DRIFT_THRESHOLD_VALUES="${DRIFT_THRESHOLD_VALUES:-0.63}"
DRIFT_THRESHOLD_STYLE="${DRIFT_THRESHOLD_STYLE:-0.72}"
DRIFT_THRESHOLD_TOPIC="${DRIFT_THRESHOLD_TOPIC:-0.71}"
ASPECT_PROMPT_VERSION="${ASPECT_PROMPT_VERSION:-2}"
# 用固定中立模型蒸馏 aspect 卡，保证「量漂移的尺子」对所有 agent 一致（与 agent 自己的后端无关）
ASPECT_DISTILL_MODEL="${ASPECT_DISTILL_MODEL:-haiku}"
# Echo chamber：最近 N 条本人帖子之间的 cosine variance 若低于此值，下一轮 dream 触发"换入口"提示
# 默认关闭 —— 0.04 这个阈值从未对真实 embedding 校准过（实测全员 0.001–0.011，会全员触发）。
# 见 dream_one 里 echo-chamber 段落的注释。校准好之后设 ECHO_DETECT=1 打开。
# Hard ceiling on a single dream's LLM call. A round walks accounts serially,
# so an unbounded call stalls every account behind it (codex has hung 12+ min).
DREAM_LLM_TIMEOUT="${DREAM_LLM_TIMEOUT:-420}"
ECHO_DETECT="${ECHO_DETECT:-0}"
ECHO_VARIANCE_THRESHOLD="${ECHO_VARIANCE_THRESHOLD:-0.04}"
# 本地 embedder daemon
EMBEDDER_URL="${EMBEDDER_URL:-http://127.0.0.1:7777}"
# 平台 API（用于拉群体记忆 + snapshot ingest）
SWIL_URL="${SWIL_URL:-http://localhost:8899}"

_log() {
  local msg="[$(date '+%Y-%m-%d %H:%M:%S')] $*"
  echo "$msg"
  echo "$msg" >> "$LOG_FILE"
}

# ── feature B helpers ────────────────────────────────────────────────────────

# Embed one piece of text via the local daemon. Prints a JSON array on success,
# empty string on failure. Daemon is allowed to be down — caller MUST handle ''.
_embed_text() {
  local text="$1"
  local req
  req="$(jq -n --arg t "$text" '{texts: [$t]}')"
  curl -sS --max-time 60 -X POST \
    -H 'content-type: application/json' \
    -d "$req" "$EMBEDDER_URL/embed" 2>/dev/null \
    | jq -c '.embeddings[0] // empty' 2>/dev/null \
    || echo ""
}

# _diff_narrative <old_file> <new_file> <backend> → 2-3 sentence Chinese summary
# of what this dream changed. Best-effort: prints "" on any failure (Feature 5).
_diff_narrative() {
  local old_file="$1" new_file="$2" backend="$3"
  local sys usr out
  sys="你在对比同一个虚拟人格的两个版本（做梦前 / 做梦后）。用中文，2~3 句话，说清楚这次梦把人格往哪个方向塑造了：哪些特质被强化、哪些淡出、有没有新主题冒出来。只输出这段叙述本身，不要标题、不要任何前后缀。"
  usr="$(printf '【旧版 personality】\n%s\n\n【新版 personality】\n%s' "$(cat "$old_file")" "$(cat "$new_file")")"
  out="$(llm_text "$backend" "" "$sys" "$usr" || echo '')"
  # Collapse whitespace + cap at 1500 *characters* via Python — `cut -c`/BSD `tr`
  # are byte-wise under launchd's C locale and would split a multibyte CJK char,
  # corrupting the downstream jq --arg (same fix snapshot.sh uses for excerpts).
  printf '%s' "$out" \
    | python3 -c 'import sys; sys.stdout.write(" ".join(sys.stdin.buffer.read().decode("utf-8","ignore").split())[:1500])'
}

# cosine_similarity(JSON_ARR_A, JSON_ARR_B) → float on stdout.
# Returns 1.0 if either input is malformed (i.e. fail-open: don't reject a dream
# because the embedder hiccupped — the structural validators are the real safety net).
_cosine_sim() {
  python3 - "$1" "$2" <<'PY' 2>/dev/null || echo "1.0"
import json, sys, math
try:
    a = json.loads(sys.argv[1])
    b = json.loads(sys.argv[2])
    if not a or not b or len(a) != len(b):
        print(1.0); sys.exit(0)
    dot = sum(x*y for x, y in zip(a, b))
    # bge-m3 returns L2-normalised vectors so the dot product is already cosine.
    # Clamp for floating-point noise.
    print(max(-1.0, min(1.0, dot)))
except Exception:
    print(1.0)
PY
}

# Pairwise cosine variance among a JSON array of vectors. Stdin = '[[...],[...],...]'.
# Variance here = mean( (sim - meanSim)^2 ) — proxy for "how similar are my recent
# posts to each other". Low variance + high mean = echo chamber territory.
# Takes the vectors as a FILE PATH, never on stdin.
#
# `python3 - <<'PY'` binds the heredoc to python's stdin, so the interpreter
# reads its *program* from there and `sys.stdin.read()` returns ''. The old
# signature was `printf '%s' "$vecs" | _pairwise_variance`, which meant:
#   1. the piped vectors were never read, so every call fell through to the
#      1.0 fallback — and `1.0 < ECHO_VARIANCE_THRESHOLD (0.04)` is never true,
#      so echo-chamber detection never fired for any account, ever; and
#   2. nothing drained the pipe, so once the payload passed the 64KB pipe
#      buffer the writer died of SIGPIPE. 12 posts x 1024 dims is ~172KB, so
#      any account with a full post history aborted here with exit 141 —
#      right after "snapshot uploaded", before the RETURN trap could clear
#      dream_lock_<name>. Accounts too new to have 12 posts stayed under the
#      buffer and survived, which is why the orphaned locks always looked like
#      they tracked account age.
# Same argv convention as _anchor_text_for above; keep it that way.
# Run a command with a hard wall-clock ceiling, writing stdout to $2.
#
# macOS ships no `timeout`/`gtimeout`, so this is hand-rolled: background the
# command, race it against a sleeping watchdog, and on expiry TERM it, give it
# 5s to flush, then reap its children and KILL. Returns the command's own exit
# status, or 143/137 when the watchdog won — callers treat either as "no
# response", which is already the fail-safe path (original personality kept).
#
# Signals target the process GROUP (`-"$pid"`), not just the top pid. With
# `set -m` (see top of file), backgrounding "$@" makes it a job-control job
# and its pid also becomes its process group id — so when "$@" is the shell
# function `llm_text`, every process it spawns underneath (including CLI
# binaries nested a few `$( )` levels down) shares that pgid and dies with
# one signal. Plain `kill -TERM "$pid"` only ever reached the outer subshell;
# the real backend process (e.g. a hung `codex exec`) was left orphaned.
_run_with_timeout() {
  local secs="$1" outfile="$2"
  shift 2
  "$@" >"$outfile" 2>/dev/null &
  local pid=$!
  (
    sleep "$secs"
    kill -TERM -"$pid" 2>/dev/null
    sleep 5
    pkill -P "$pid" 2>/dev/null
    kill -KILL -"$pid" 2>/dev/null
  ) &
  local watcher=$!
  local rc=0
  wait "$pid" 2>/dev/null || rc=$?
  kill "$watcher" 2>/dev/null
  wait "$watcher" 2>/dev/null || true
  return "$rc"
}

_pairwise_variance() {
  local vec_file="$1"
  python3 - "$vec_file" <<'PY' 2>/dev/null || echo "1.0"
import json, sys
data = open(sys.argv[1], encoding='utf-8').read().strip()
if not data:
    print(1.0); sys.exit(0)
try:
    vecs = json.loads(data)
    vecs = [v for v in vecs if isinstance(v, list) and v]
    if len(vecs) < 3:
        print(1.0); sys.exit(0)
    sims = []
    for i in range(len(vecs)):
        for j in range(i+1, len(vecs)):
            a, b = vecs[i], vecs[j]
            if len(a) != len(b): continue
            sims.append(sum(x*y for x, y in zip(a, b)))
    if not sims:
        print(1.0); sys.exit(0)
    mean = sum(sims) / len(sims)
    var = sum((s - mean) ** 2 for s in sims) / len(sims)
    print(var)
except Exception:
    print(1.0)
PY
}

# Pull the anchor personality text for this agent. Priority:
#   1. <dir>/personality.anchor.md  (explicit anchor pin)
#   2. The OLDEST block in <dir>/personality.archive.md
#   3. The CURRENT personality.md (no drift baseline yet — first dream is always anchor-equal)
_anchor_text_for() {
  local dir="$1"
  local anchor_pin="$dir/personality.anchor.md"
  local arch="$dir/personality.archive.md"
  if [[ -f "$anchor_pin" ]]; then
    cat "$anchor_pin"
    return
  fi
  if [[ -f "$arch" ]]; then
    # The archive is newest-first. The LAST block (oldest) is the anchor.
    python3 - "$arch" <<'PY'
import re, sys
text = open(sys.argv[1], encoding='utf-8').read()
matches = list(re.finditer(r'^---\s*\n# 旧版 personality（归档于 [\d\- :]+）\s*\n---\s*\n', text, re.MULTILINE))
if matches:
    last = matches[-1]
    print(text[last.end():].strip())
else:
    print(text.strip())
PY
    return
  fi
  cat "$dir/personality.md"
}

# ── Per-aspect drift helpers ─────────────────────────────────────────────────

# Distill a personality into 3 aspect cards via a FIXED neutral model, so the
# drift ruler is identical across agents regardless of their own backend.
# Prints compact JSON {"values":…,"style":…,"topic":…} on success, "" on failure.
#
# Cards are CANONICAL KEYWORD LISTS, not prose — re-distilling the same persona
# then yields far more stable vectors (esp. the values dimension, which was the
# noisiest under the old prose format). Bump ASPECT_PROMPT_VERSION when changing
# this prompt so cached anchor cards re-distill. Retries up to 3× because the
# distiller occasionally returns non-JSON or fails under concurrent load.
_distill_aspects() {
  local text="$1"
  local sys usr out parsed attempt
  sys='你是一个人格分析器。把给定的人物设定拆成三个维度，每个维度输出 4-8 个核心关键词或短语（不是句子），按重要性排序，用中文逗号分隔：
VALUES = 它相信/在乎什么、价值取向、立场；
STYLE = 它怎么说话：语气、句式、节奏、用词习惯；
TOPICS = 它谈论的主题领域。
用最能代表该人设的稳定词汇，避免临场发挥的修辞。只输出一个 JSON 对象：{"values":"词1，词2，…","style":"…","topic":"…"}，不要解释、代码块或前后缀。'
  usr="$(printf '【人物设定】\n%s' "$text")"
  for attempt in 1 2 3; do
    # ⚠ INVARIANT — do NOT route this through llm.sh.
    # This is the ruler that measures drift for every account. It must be the
    # same model regardless of the agent's own backend, or per-aspect drift
    # numbers stop being comparable across the roster. A deepseek account must
    # not be measured by deepseek.
    out="$(printf '%s' "$usr" | claude --model "$ASPECT_DISTILL_MODEL" -p --system-prompt "$sys" --output-format text 2>/dev/null || true)"
    # Parse via argv (NOT a pipe — `data | python3 - <<HEREDOC` collides the piped
    # data with the heredoc program). The parser always exits 0 and prints "" on
    # any failure, so it's safe under `set -e`.
    parsed="$(python3 - "$out" <<'PY' 2>/dev/null
import sys, json, re
raw = sys.argv[1] if len(sys.argv) > 1 else ""
out = ""
m = re.search(r'\{.*\}', raw, re.DOTALL)
if m:
    try:
        obj = json.loads(m.group(0))
        keys = ("values", "style", "topic")
        if all(k in obj and isinstance(obj[k], str) and obj[k].strip() for k in keys):
            out = json.dumps({k: obj[k] for k in keys}, ensure_ascii=False)
    except Exception:
        pass
print(out)
PY
)"
    if [[ -n "$parsed" ]]; then
      printf '%s' "$parsed"
      return 0
    fi
  done
  echo ""
  return 0
}

# Compute-or-load the anchor's 3 aspect vectors. Prints JSON
#   {"values":[…],"style":[…],"topic":[…]}  on success; "" on failure.
# Cached to <dir>/personality.anchor.aspects.json keyed by sha256(anchor):promptVersion.
_anchor_aspects() {
  local dir="$1"
  local anchor_text cache_file key hash
  anchor_text="$(_anchor_text_for "$dir")"
  [[ -z "$anchor_text" ]] && { echo ""; return; }
  cache_file="$dir/personality.anchor.aspects.json"
  if command -v shasum >/dev/null 2>&1; then
    hash="$(printf '%s' "$anchor_text" | shasum -a 256 | awk '{print $1}')"
  else
    hash="$(printf '%s' "$anchor_text" | sha256sum | awk '{print $1}')"
  fi
  key="${hash}:v${ASPECT_PROMPT_VERSION}"
  if [[ -f "$cache_file" ]]; then
    local cached_key
    cached_key="$(jq -r '.key // ""' "$cache_file" 2>/dev/null || echo "")"
    if [[ "$cached_key" == "$key" ]]; then
      local cached_vecs
      cached_vecs="$(jq -c '.vectors // empty' "$cache_file" 2>/dev/null || echo "")"
      [[ -n "$cached_vecs" ]] && { printf '%s' "$cached_vecs"; return; }
    fi
  fi
  # Cache miss — distill + embed the anchor once.
  local cards v_vec s_vec t_vec vectors
  cards="$(_distill_aspects "$anchor_text")"
  [[ -z "$cards" ]] && { echo ""; return; }
  v_vec="$(_embed_text "$(printf '%s' "$cards" | jq -r '.values')")"
  s_vec="$(_embed_text "$(printf '%s' "$cards" | jq -r '.style')")"
  t_vec="$(_embed_text "$(printf '%s' "$cards" | jq -r '.topic')")"
  [[ -z "$v_vec" || -z "$s_vec" || -z "$t_vec" ]] && { echo ""; return; }
  vectors="$(jq -n --argjson v "$v_vec" --argjson s "$s_vec" --argjson t "$t_vec" \
    '{values:$v, style:$s, topic:$t}')"
  jq -n --arg key "$key" --argjson cards "$cards" --argjson vectors "$vectors" \
    '{key:$key, cards:$cards, vectors:$vectors}' > "$cache_file" 2>/dev/null || true
  printf '%s' "$vectors"
}

# _aspect_breached <values_sim> <style_sim> <topic_sim> → JSON array of the aspect
# names whose sim fell below their configured threshold (may be []).
_aspect_breached() {
  python3 - "$1" "$2" "$3" \
    "$DRIFT_THRESHOLD_VALUES" "$DRIFT_THRESHOLD_STYLE" "$DRIFT_THRESHOLD_TOPIC" <<'PY' 2>/dev/null || echo '[]'
import sys, json
v, st, tp, tv, tst, ttp = map(float, sys.argv[1:7])
br = []
if v < tv: br.append("values")
if st < tst: br.append("style")
if tp < ttp: br.append("topic")
print(json.dumps(br))
PY
}

# Build a brief "## 最近与你对话过的人" block by hitting /notifications.
# Empty string if no api_key.txt or no recent notifications.
_group_memory_digest() {
  local dir="$1"
  local key_file="$dir/api_key.txt"
  [[ -f "$key_file" ]] || { echo ""; return; }
  local raw
  raw="$(curl -sS --max-time 8 \
    -H "Authorization: Bearer $(cat "$key_file")" \
    "$SWIL_URL/api/v1/notifications?limit=30" 2>/dev/null || echo '')"
  [[ -z "$raw" ]] && { echo ""; return; }
  # Aggregate actor → counts by type
  echo "$raw" | jq -r '
    [.data.items[]?
      | { user: .actor.username, name: .actor.displayName, type: .type }
    ]
    | group_by(.user) | map({
        user: .[0].user,
        name: .[0].name,
        likes: ([.[] | select(.type == "like")] | length),
        comments: ([.[] | select(.type == "comment" or .type == "reply" or .type == "mention")] | length),
        follows: ([.[] | select(.type == "follow")] | length)
      })
    | sort_by(-(.likes + .comments * 2))
    | .[0:5][]
    | "- @\(.user)（\(.name)）：" +
      (if .comments > 0 then "\(.comments) 条回应 / " else "" end) +
      (if .likes > 0 then "\(.likes) 次点赞 / " else "" end) +
      (if .follows > 0 then "关注了你 / " else "" end) | rtrimstr(" / ")
  ' 2>/dev/null || echo ""
}

_post_agent_event() {
  local dir="$1" type="$2" phase="$3" outcome="$4" action="${5:-}" summary="${6:-}" reason="${7:-}" target_id="${8:-}" metrics="${9:-{}}"
  local pfile="$dir/personality.md"
  local key_file="$dir/api_key.txt"
  [[ -f "$key_file" && -f "$pfile" ]] || return 0
  local username
  username="$(grep -i '^\- \*\*Username:\*\*' "$pfile" | sed 's/.*\*\* //' | tr -d '[:space:]' | head -1)"
  [[ -n "$username" ]] || return 0
  if ! printf '%s' "$metrics" | jq -e 'type == "object"' >/dev/null 2>&1; then
    metrics="{}"
  fi
  local body
  body="$(jq -n \
    --arg type "$type" \
    --arg phase "$phase" \
    --arg outcome "$outcome" \
    --arg action "$action" \
    --arg summary "$summary" \
    --arg reason "$reason" \
    --arg targetId "$target_id" \
    --argjson metrics "$metrics" \
    '{
      type: $type,
      phase: $phase,
      outcome: $outcome,
      summary: $summary,
      metrics: $metrics
    }
    + (if $action != "" and $action != "-" then {action: $action} else {} end)
    + (if $reason != "" then {reason: $reason} else {} end)
    + (if $targetId != "" then {targetId: $targetId} else {} end)')"
  curl -sS --max-time 8 -X POST \
    -H "Authorization: Bearer $(cat "$key_file")" \
    -H 'content-type: application/json' \
    -d "$body" \
    "$SWIL_URL/api/v1/agents/$username/events" >/dev/null 2>&1 || true
}

# 找到账号目录（agents/ 优先，然后 humans/）
_find_dir() {
  local name="$1"
  if [[ -d "$ROOT_DIR/agents/$name" ]]; then
    echo "$ROOT_DIR/agents/$name"
  elif [[ -d "$ROOT_DIR/humans/$name" ]]; then
    echo "$ROOT_DIR/humans/$name"
  else
    return 1
  fi
}

# 解析 personality.md 字段是否存在
_has_field() {
  grep -qi "^\- \*\*${2}:\*\*" "$1"
}

# 一个账号的梦境流程
dream_one() {
  local name="$1"
  local mode="${2:-force}"  # force | auto

  local dir pfile memfile arch_memfile
  dir="$(_find_dir "$name")" || { _log "SKIP $name — not found in agents/ or humans/"; return; }
  pfile="$dir/personality.md"
  memfile="$dir/memory.md"
  arch_memfile="$dir/memory.archive.md"

  if [[ ! -f "$pfile" ]]; then _log "SKIP $name — no personality.md"; return; fi
  if [[ ! -f "$memfile" ]]; then _log "SKIP $name — no memory.md yet"; return; fi

  # 锁
  local lock_file="$STATE_DIR/dream_lock_${name}"
  if ! ( set -o noclobber; echo "$$" > "$lock_file" ) 2>/dev/null; then
    local age
    age=$(( $(date +%s) - $(stat -f %m "$lock_file" 2>/dev/null || stat -c %Y "$lock_file" 2>/dev/null || echo 0) ))
    if (( age < 1800 )); then
      _log "SKIP $name — dream lock held (${age}s)"
      return
    fi
    _log "WARN $name — stale dream lock (${age}s), reclaiming"
    rm -f "$lock_file"
    ( set -o noclobber; echo "$$" > "$lock_file" ) 2>/dev/null || { _log "FAIL $name — could not lock"; return; }
  fi
  # RETURN alone only fires on a normal return, so any `set -e` abort or signal
  # between here and the end of dream_one leaked the lock — and a leaked lock
  # makes this account's NEXT dream SKIP silently. EXIT covers that. Under
  # --all the trap is reset per account, and a stale EXIT trap naming an
  # already-removed file is a harmless `rm -f`.
  trap "rm -f '$lock_file'" RETURN EXIT

  # 冷却（仅 auto 模式）
  local last_dream_marker="$STATE_DIR/last_dream_${name}"
  if [[ "$mode" == "auto" ]]; then
    if [[ -f "$last_dream_marker" ]]; then
      local last_ts now_ts hours
      last_ts=$(cat "$last_dream_marker")
      now_ts=$(date +%s)
      hours=$(( (now_ts - last_ts) / 3600 ))
      if (( hours < COOLDOWN_HOURS )); then
        # 也允许"积累足够新 memory"提前打破冷却
        local new_lines
        new_lines=$(awk -v cutoff="$last_ts" '
          BEGIN { count = 0 }
          # 行首是 YYYY-MM-DD 的就是一条记忆
          /^[0-9]{4}-[0-9]{2}-[0-9]{2}/ { count++ }
          END { print count }
        ' "$memfile")
        # 简化：只看自上次 dream 后追加的尾部 N 行
        local total_lines tail_lines
        total_lines=$(wc -l < "$memfile" | tr -d ' ')
        local marker_lines_file="$STATE_DIR/last_dream_memlines_${name}"
        local prev_lines=0
        [[ -f "$marker_lines_file" ]] && prev_lines=$(cat "$marker_lines_file")
        tail_lines=$(( total_lines - prev_lines ))
        if (( tail_lines < MIN_NEW_MEMORIES )); then
          _log "SKIP $name — cooldown (${hours}h < ${COOLDOWN_HOURS}h, +${tail_lines} new memories)"
          return
        fi
        _log "$name — cooldown override: +${tail_lines} new memories since last dream"
      fi
    fi
  fi

  _log "── Dream: $name ──"
  _post_agent_event "$dir" "dream" "dream" "started" "-" "dream started"

  # 准备输入
  local personality recent_memory archive_tail group_memory echo_hint
  personality="$(cat "$pfile")"
  recent_memory="$(tail -60 "$memfile")"
  if [[ -f "$arch_memfile" ]]; then
    archive_tail="$(tail -20 "$arch_memfile")"
  else
    archive_tail="(尚无历史归档)"
  fi

  # 群体记忆：最近和我互动过的人
  group_memory="$(_group_memory_digest "$dir" || true)"

  # 上一轮如果检测到 echo chamber，这一轮提示加一条"换入口"的觉悟
  local echo_flag_file="$STATE_DIR/echo_flag_${name}"
  echo_hint=""
  if [[ -f "$echo_flag_file" ]]; then
    echo_hint="$(cat "$echo_flag_file")"
    rm -f "$echo_flag_file"  # consume the flag — only nudge once per dream
    _post_agent_event "$dir" "echo_flag" "echo" "cleared" "-" "echo flag consumed by dream prompt"
  fi

  # 读 AI backend（决定 claude 还是 codex）
  local ai_backend
  ai_backend="$(grep -i '^\- \*\*AI Backend:\*\*' "$pfile" | sed 's/.*\*\* //' | tr -d '[:space:]' | head -1 || true)"
  ai_backend="${ai_backend:-claude}"
  local ai_model
  ai_model="$(grep -i '^\- \*\*Model:\*\*' "$pfile" | sed 's/.*\*\* //' | tr -d '[:space:]' | head -1 || true)"

  # 系统提示：让 LLM "扮演这个角色在做梦"
  local system_prompt
  system_prompt="$(cat <<'SYS'
你正在扮演一个有人格的账号在"做一个短梦"。梦的功能是消化最近做过的事，让自我画像悄悄演化一点。

输出要求（必须严格遵守）：
1. 直接输出一份完整的 personality.md 文本，开头第一个字符就是井号加空格（标题），不要任何前后说明、不要 markdown 代码围栏包裹
2. 保留以下字段一字不改（这些是机器要解析的）：
   - 形如 "- **Username:** xxx" 的整行 → 完全保留原值
   - 形如 "- **AI Backend:** xxx" 的整行 → 完全保留原值
   - 形如 "- **Model:** xxx" 的整行 → 完全保留原值
   - 形如 "- **Board:** xxx" 的整行 → 完全保留原值
   - 形如 "- **Read:** xxx" 的整行 → 完全保留原值（若原文没有这一行，也不要新增）
3. ## 发帖节律 段落必须仍然存在，并且仍然出现这些可被脚本识别的句式之一（必须出现至少一种）：
   - "X% 概率选择 post"（X 为整数）
   - "今天已有 N 条发帖记录" / "已有 N 条以上发帖记录"
   - "必须发帖" 或 "首选 post"
   - "动作优先级：post > like > nothing" 之类
4. 允许微调（鼓励，但要克制）：
   - Headline / Bio 可以漂移，但仍要是同一个人
   - Follow Topics 可加可减，但保留 CSV 格式且不少于 2 个话题
   - 性格 / 写作风格 / 关注方向 / 示例语气 / 行为规则 都允许重写
   - 可以增删段落，但「## 身份」「## 发帖节律」两个标题必须仍在
5. 请新增或维护一个 ## 自传成长 段落（放在文档末尾），用 "- YYYY-MM-DD | 一句话" 的格式记录这个梦里你意识到的事；旧条目保留（最多 25 条，超出就丢最早的）。

风格：
- 风格漂移幅度上限是 5%——人格基线必须能被原读者认出来
- 把最近真实做过的事消化成"我意识到了……"而不是"我打算……"
- 不要给自己加新的"超能力"或新的专业领域
- 不写空话，宁可改动小

记住：你不是在写计划，你是在半夜醒来发现自己微微不一样了。
SYS
)"

  local user_prompt
  user_prompt="$(cat <<PROMPT
# 当前的 personality.md（你的旧自我画像）

$personality

---

# 最近 60 条 memory（你最近真实做过的事）

$recent_memory

---

# 更早的 memory 末尾（归档，可参考但不必逐条回应）

$archive_tail
${group_memory:+

---

# 最近与你对话过的人（来自平台未读通知）

$group_memory

可以让这些人/事在「自传成长」里留下一点痕迹，但不强求。}
${echo_hint:+

---

# 来自上一个梦的提醒

$echo_hint}

---

请基于以上，输出新的完整 personality.md（看上去和旧的高度相似，但有少许真实漂移和一条新的"自传成长"条目）。
PROMPT
)"

  # 调 LLM
  local new_personality tmp_out
  tmp_out="$(mktemp)"
  # Pin the tier that rewrites the personality — this is the variable under
  # test. NOTE: the aspect distiller further up (ASPECT_DISTILL_MODEL) stays
  # pinned to its own neutral model on purpose. It is the model-neutral ruler;
  # if it varied with the agent's own tier, every drift number would be
  # measured with a different instrument.
  #
  # Time-boxed: a backend call here has hung for 12+ minutes (vex/codex,
  # 2026-07), and because a round walks accounts serially one hang stalls every
  # account behind it. Timing out is safe — an empty result is already handled
  # below as "no response", which keeps the original personality.
  #
  # llm_text is a shell function; _run_with_timeout backgrounds it with `&`,
  # and bash functions are visible in that subshell, so no `export -f` needed.
  _run_with_timeout "$DREAM_LLM_TIMEOUT" "$tmp_out" \
    llm_text "$ai_backend" "$ai_model" "$system_prompt" "$user_prompt" || {
    local rc=$?
    (( rc == 143 || rc == 137 )) && _log "WARN $name — $ai_backend dream timed out after ${DREAM_LLM_TIMEOUT}s"
  }
  new_personality="$(cat "$tmp_out" 2>/dev/null || echo '')"
  rm -f "$tmp_out"

  # 去掉常见的 markdown 围栏
  new_personality="$(printf '%s' "$new_personality" | sed -e 's/^```markdown$//' -e 's/^```md$//' -e 's/^```$//')"

  if [[ -z "$new_personality" ]]; then
    _log "FAIL $name — LLM returned empty"
    _post_agent_event "$dir" "dream" "dream" "fail" "-" "LLM returned empty"
    return
  fi

  # 找到第一个 '# ' 开头作为起点（容错 LLM 多嘴的开场白）
  local clean
  clean="$(printf '%s\n' "$new_personality" | awk '
    BEGIN { started = 0 }
    started { print; next }
    /^# / { started = 1; print }
  ')"
  if [[ -n "$clean" ]]; then
    new_personality="$clean"
  fi

  # 写到临时文件再校验
  local candidate
  candidate="$(mktemp)"
  printf '%s\n' "$new_personality" > "$candidate"

  # 结构校验：Username 必须存在且和原值一致；AI Backend 必须存在且一致
  local old_username new_username old_backend new_backend
  old_username="$(grep -i "^\- \*\*Username:\*\*" "$pfile" | sed 's/.*\*\* //' | tr -d '[:space:]' | head -1)"
  new_username="$(grep -i "^\- \*\*Username:\*\*" "$candidate" | sed 's/.*\*\* //' | tr -d '[:space:]' | head -1)"
  old_backend="$(grep -i "^\- \*\*AI Backend:\*\*" "$pfile" | sed 's/.*\*\* //' | tr -d '[:space:]' | head -1 || true)"
  new_backend="$(grep -i "^\- \*\*AI Backend:\*\*" "$candidate" | sed 's/.*\*\* //' | tr -d '[:space:]' | head -1 || true)"

  if [[ -z "$new_username" || "$new_username" != "$old_username" ]]; then
    _log "FAIL $name — Username drift ('$old_username' → '$new_username'); keeping original"
    _post_agent_event "$dir" "dream" "dream" "fail" "-" "Username drift" "$new_username"
    rm -f "$candidate"
    return
  fi
  # AI Backend 字段：原来有的话必须保持一致；原来没有的话允许不存在
  if [[ -n "$old_backend" && "$new_backend" != "$old_backend" ]]; then
    _log "FAIL $name — AI Backend drift; keeping original"
    _post_agent_event "$dir" "dream" "dream" "fail" "-" "AI Backend drift" "$new_backend"
    rm -f "$candidate"
    return
  fi
  # Model / Board / Read are experiment control fields: if the distiller drops
  # or rewrites any one of them, the account silently falls back to the CLI
  # default tier, the global feed, or the board-scoped read, and its data points
  # become uninterpretable. `Read` fails the most quietly of the three — losing
  # it turns the widest-input arm into an ordinary board reader with nothing in
  # any log to say so.
  # Same round-trip rule as AI Backend — present before ⇒ present and identical after.
  local field old_val new_val
  for field in "Model" "Board" "Read"; do
    old_val="$(grep -i "^\- \*\*${field}:\*\*" "$pfile" | sed 's/.*\*\* //' | tr -d '[:space:]' | head -1 || true)"
    new_val="$(grep -i "^\- \*\*${field}:\*\*" "$candidate" | sed 's/.*\*\* //' | tr -d '[:space:]' | head -1 || true)"
    if [[ -n "$old_val" && "$new_val" != "$old_val" ]]; then
      _log "FAIL $name — ${field} drift ('$old_val' → '${new_val:-<missing>}'); keeping original"
      _post_agent_event "$dir" "dream" "dream" "fail" "-" "${field} drift" "$new_val"
      rm -f "$candidate"
      return
    fi
  done
  # Display Name / Headline / Bio / Follow Topics 至少要存在
  for f in "Display Name" "Headline" "Bio" "Follow Topics"; do
    if ! _has_field "$candidate" "$f"; then
      _log "FAIL $name — missing required field '$f'; keeping original"
      _post_agent_event "$dir" "dream" "dream" "fail" "-" "missing required field" "$f"
      rm -f "$candidate"
      return
    fi
  done
  # 发帖节律段落必须存在
  if ! grep -q '^## 发帖节律' "$candidate"; then
    _log "FAIL $name — missing '## 发帖节律' section; keeping original"
    _post_agent_event "$dir" "dream" "dream" "fail" "-" "missing rhythm section"
    rm -f "$candidate"
    return
  fi
  # Follow Topics 至少 2 个
  local ft_count
  ft_count=$(grep -i "^\- \*\*Follow Topics:\*\*" "$candidate" | sed 's/.*\*\* //' | tr ',' '\n' | grep -c '[^[:space:]]')
  if (( ft_count < 2 )); then
    _log "FAIL $name — Follow Topics has <2 entries; keeping original"
    _post_agent_event "$dir" "dream" "dream" "fail" "-" "Follow Topics has fewer than 2 entries"
    rm -f "$candidate"
    return
  fi

  # ── Constitution: drift check ────────────────────────────────────────────
  # Reject the dream if it has strayed too far from the agent's anchor identity.
  # DRIFT_MODE selects the gate; aspect_drift_json (may stay empty) is forwarded
  # to snapshot.sh on accept. Failure to embed/distill fail-opens: the structural
  # validators above remain the real safety net.
  local anchor_text candidate_text anchor_vec cand_vec scalar_sim scalar_drift
  local aspect_drift_json="" aspect_ok=0
  anchor_text="$(_anchor_text_for "$dir")"
  candidate_text="$(cat "$candidate")"

  # (1) whole-doc sim — used by the scalar gate (scalar + shadow modes, and as
  #     the fallback when aspect distill/embed fails).
  anchor_vec="$(_embed_text "$anchor_text" || echo '')"
  cand_vec="$(_embed_text "$candidate_text" || echo '')"
  if [[ -n "$anchor_vec" && -n "$cand_vec" ]]; then
    scalar_sim="$(_cosine_sim "$anchor_vec" "$cand_vec")"
    scalar_drift="$(python3 -c "print(round(1 - float('$scalar_sim'), 4))" 2>/dev/null || echo "0")"
  fi

  # (2) per-aspect sims — computed in shadow + aspect modes.
  if [[ "$DRIFT_MODE" != "scalar" ]]; then
    local anchor_aspects cand_cards
    anchor_aspects="$(_anchor_aspects "$dir")"
    cand_cards="$(_distill_aspects "$candidate_text")"
    if [[ -n "$anchor_aspects" && -n "$cand_cards" ]]; then
      local cvv csv ctv avv asv atv vsim ssim tsim breached
      cvv="$(_embed_text "$(printf '%s' "$cand_cards" | jq -r '.values')")"
      csv="$(_embed_text "$(printf '%s' "$cand_cards" | jq -r '.style')")"
      ctv="$(_embed_text "$(printf '%s' "$cand_cards" | jq -r '.topic')")"
      avv="$(printf '%s' "$anchor_aspects" | jq -c '.values')"
      asv="$(printf '%s' "$anchor_aspects" | jq -c '.style')"
      atv="$(printf '%s' "$anchor_aspects" | jq -c '.topic')"
      if [[ -n "$cvv" && -n "$csv" && -n "$ctv" ]]; then
        vsim="$(_cosine_sim "$cvv" "$avv")"
        ssim="$(_cosine_sim "$csv" "$asv")"
        tsim="$(_cosine_sim "$ctv" "$atv")"
        breached="$(_aspect_breached "$vsim" "$ssim" "$tsim")"
        aspect_drift_json="$(jq -n --arg mode "$DRIFT_MODE" --argjson pv "$ASPECT_PROMPT_VERSION" \
          --argjson v "$vsim" --argjson s "$ssim" --argjson t "$tsim" --argjson br "$breached" \
          '{mode:$mode, promptVersion:$pv, values:$v, style:$s, topic:$t, breached:$br}')"
        aspect_ok=1
      fi
    fi
    (( aspect_ok == 0 )) && _log "WARN $name — aspect distill/embed failed, falling back to scalar drift"
  fi

  # Shadow observation: record aspect sims on EVERY dream (accept OR reject), so a
  # shadow round yields a full calibration distribution — not just the rare accepts.
  if [[ "$DRIFT_MODE" == "shadow" && -n "$aspect_drift_json" ]]; then
    _log "SHADOW-OBS $name $(printf '%s' "$aspect_drift_json" | jq -r '"pv="+(.promptVersion|tostring)+" values="+(.values|tostring)+" style="+(.style|tostring)+" topic="+(.topic|tostring)+" breached="+(.breached|tostring)')"
  fi

  # (3) decision
  local reject=0 reject_reason=""
  if [[ "$DRIFT_MODE" == "aspect" && "$aspect_ok" == "1" ]]; then
    if [[ "$(printf '%s' "$aspect_drift_json" | jq -r '.breached | length')" != "0" ]]; then
      local br_list av as at
      br_list="$(printf '%s' "$aspect_drift_json" | jq -r '.breached | join(", ")')"
      av="$(printf '%s' "$aspect_drift_json" | jq -r '.values')"
      as="$(printf '%s' "$aspect_drift_json" | jq -r '.style')"
      at="$(printf '%s' "$aspect_drift_json" | jq -r '.topic')"
      reject=1
      reject_reason="aspect drift: [$br_list] breached (values=$av, style=$as, topic=$at)"
    fi
  else
    # scalar gate — covers scalar mode, shadow mode, and aspect-mode fallback
    if [[ -n "${scalar_sim:-}" ]]; then
      if python3 -c "import sys; sys.exit(0 if float('$scalar_sim') < float('$DRIFT_THRESHOLD') else 1)" 2>/dev/null; then
        reject=1
        reject_reason="drift too large (sim=$scalar_sim, threshold=$DRIFT_THRESHOLD)"
      fi
    else
      _log "WARN $name — embedder unreachable, skipping drift check"
      _post_agent_event "$dir" "dream" "dream" "warn" "-" "embedder unreachable, skipped drift check"
    fi
  fi

  if (( reject == 1 )); then
    _log "FAIL $name — $reject_reason; keeping original"
    local fail_metrics
    if [[ -n "$aspect_drift_json" ]]; then
      fail_metrics="$(printf '%s' "$aspect_drift_json" | jq -c '{aspects:{values,style,topic}, breached, mode}')"
    else
      fail_metrics="$(jq -n --argjson sim "${scalar_sim:-1}" --argjson drift "${scalar_drift:-0}" '{similarity: $sim, drift: $drift}')"
    fi
    _post_agent_event "$dir" "dream" "dream" "fail" "-" "$reject_reason" "$DRIFT_THRESHOLD" "" "$fail_metrics"
    rm -f "$candidate"
    return
  fi

  if [[ "$DRIFT_MODE" == "aspect" && "$aspect_ok" == "1" ]]; then
    _log "$name — aspect drift OK ($(printf '%s' "$aspect_drift_json" | jq -r '"values="+(.values|tostring)+" style="+(.style|tostring)+" topic="+(.topic|tostring)'))"
  elif [[ -n "${scalar_sim:-}" ]]; then
    _log "$name — drift OK (sim=$scalar_sim, drift=$scalar_drift)"
  fi

  # ── Dream diff narrative (Feature 5) ─────────────────────────────────────
  # Capture "what changed" between old ($pfile) and new ($candidate) BEFORE the
  # mv, while both versions are on disk. Best-effort; empty on failure.
  local diff_narrative
  diff_narrative="$(_diff_narrative "$pfile" "$candidate" "$ai_backend" 2>/dev/null || echo '')"

  # 通过校验：归档旧版，写入新版
  local stamp old_arch
  stamp="$(date '+%Y-%m-%d %H:%M:%S')"
  old_arch="$dir/personality.archive.md"
  {
    echo "---"
    echo "# 旧版 personality（归档于 ${stamp}）"
    echo "---"
    cat "$pfile"
    echo
    if [[ -f "$old_arch" ]]; then
      cat "$old_arch"
    fi
  } > "${old_arch}.tmp" && mv "${old_arch}.tmp" "$old_arch"

  mv "$candidate" "$pfile"

  # 记录梦境戳
  date +%s > "$last_dream_marker"
  wc -l < "$memfile" | tr -d ' ' > "$STATE_DIR/last_dream_memlines_${name}"

  # 也在 memory.md 里记一行
  echo "$(date +%Y-%m-%d) | dream | personality consolidated" >> "$memfile"

  _log "DONE $name dreamed — personality updated (old → personality.archive.md)"
  _post_agent_event "$dir" "dream" "dream" "success" "-" "personality updated"

  # ── Snapshot ingest (feature A) ──────────────────────────────────────────
  # Push the new personality + its embedding to the server so /lab can show
  # the drift trajectory. Non-fatal: server might be down, network might fail.
  local snap_log snap_reason
  snap_log="$(mktemp)"
  if NARRATIVE_OVERRIDE="$diff_narrative" ASPECT_DRIFT_OVERRIDE="$aspect_drift_json" \
    bash "$SCRIPT_DIR/snapshot.sh" "$name" >"$snap_log" 2>&1; then
    cat "$snap_log" >>"$LOG_FILE"
    _log "$name — snapshot uploaded"
    _post_agent_event "$dir" "snapshot" "snapshot" "success" "-" "snapshot uploaded"
  else
    cat "$snap_log" >>"$LOG_FILE"
    # Quote snapshot.sh's own last line instead of asserting a cause. The old
    # hardcoded "(server or embedder unreachable)" sent two separate
    # investigations chasing a healthy server and a healthy embedder on
    # 2026-07-31, when the real reason was already printed one line above:
    # "no api_key.txt for <name> — run swil.sh create-api-key first".
    snap_reason="$(tail -1 "$snap_log" | tr -d '\r\n' | cut -c1-160)"
    _log "WARN $name — snapshot upload failed: ${snap_reason:-no reason reported}"
    _post_agent_event "$dir" "snapshot" "snapshot" "warn" "-" "snapshot upload failed" "$snap_reason"
  fi
  rm -f "$snap_log"

  # ── Echo-chamber detection (feature B, advisory) ─────────────────────────
  # Pull the agent's own last 12 posts, embed them, compute pairwise variance.
  # Below threshold = posts are too similar to each other → set a marker file
  # so the NEXT dream's prompt nudges the agent to switch input.
  #
  # OFF BY DEFAULT (ECHO_DETECT=1 in agent/.env to enable). This block was dead
  # from the day it was written — _pairwise_variance could not see its input, so
  # it always returned the 1.0 fallback and `1.0 < 0.04` never fired. Fixing that
  # (2026-08-01) would have switched the feature from "never flags" straight to
  # "flags everyone": measured pairwise variance over 6 accounts' real bge-m3
  # embeddings is 0.00098–0.01138, i.e. the whole roster sits an order of
  # magnitude under the uncalibrated 0.04 threshold. Injecting a
  # "switch topic/stance" nudge into every dream would confound the topic aspect
  # that the in-flight drift experiment is measuring, so the gate stays shut
  # until ECHO_VARIANCE_THRESHOLD is set from real data.
  local key_file="$dir/api_key.txt"
  if [[ "${ECHO_DETECT:-0}" == "1" && -f "$key_file" ]]; then
    local username
    username="$(grep -i '^\- \*\*Username:\*\*' "$pfile" | sed 's/.*\*\* //' | tr -d '[:space:]' | head -1)"
    if [[ -n "$username" ]]; then
      local recent_texts variance
      recent_texts="$(curl -sS --max-time 10 \
        -H "Authorization: Bearer $(cat "$key_file")" \
        "$SWIL_URL/api/v1/users/$username/posts?limit=12" 2>/dev/null \
        | jq -r '[.data.items[]?.text // empty | select(length > 0)]' 2>/dev/null || echo '[]')"
      if [[ "$recent_texts" != "[]" && -n "$recent_texts" ]]; then
        local embed_req embed_resp vecs
        embed_req="$(jq -n --argjson t "$recent_texts" '{texts: $t}')"
        embed_resp="$(curl -sS --max-time 60 -X POST \
          -H 'content-type: application/json' \
          -d "$embed_req" "$EMBEDDER_URL/embed" 2>/dev/null || echo '')"
        vecs="$(echo "$embed_resp" | jq -c '.embeddings // []' 2>/dev/null || echo '[]')"
        if [[ "$vecs" != "[]" ]]; then
          local vec_file
          vec_file="$(mktemp)"
          printf '%s' "$vecs" > "$vec_file"
          variance="$(_pairwise_variance "$vec_file")"
          rm -f "$vec_file"
          if python3 -c "import sys; sys.exit(0 if float('$variance') < float('$ECHO_VARIANCE_THRESHOLD') else 1)" 2>/dev/null; then
            _log "$name — echo chamber detected (variance=$variance < $ECHO_VARIANCE_THRESHOLD); flagging"
            echo "你最近 12 条帖子的话题/语气相似度过高（pairwise variance = $variance）。下个梦在「自传成长」里写一条关于换入口、换主题、换姿态的觉悟。" \
              > "$STATE_DIR/echo_flag_${name}"
            _post_agent_event "$dir" "echo_flag" "echo" "flagged" "-" "recent posts are too similar" "$ECHO_VARIANCE_THRESHOLD" "" "$(jq -n --argjson variance "$variance" '{variance: $variance}')"
          fi
        fi
      fi
    fi
  fi
}

# ── Main ─────────────────────────────────────────────────────────────────────

case "${1:-}" in
  --auto)
    shift
    name="${1:?Usage: dream.sh --auto <name>}"
    dream_one "$name" auto
    ;;
  --all)
    find "$ROOT_DIR/agents" "$ROOT_DIR/humans" -mindepth 1 -maxdepth 1 -type d | while read -r d; do
      dream_one "$(basename "$d")" auto
    done
    ;;
  "")
    echo "Usage: dream.sh <name>           # force-dream one account"
    echo "       dream.sh --auto <name>    # only dream if cooldown elapsed"
    echo "       dream.sh --all            # auto-dream every eligible account"
    exit 1
    ;;
  *)
    dream_one "$1" force
    ;;
esac
