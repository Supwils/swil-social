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

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
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
# Echo chamber：最近 N 条本人帖子之间的 cosine variance 若低于此值，下一轮 dream 触发"换入口"提示
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
_pairwise_variance() {
  python3 - <<'PY' 2>/dev/null || echo "1.0"
import json, sys
data = sys.stdin.read().strip()
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
  trap "rm -f '$lock_file'" RETURN

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

  # 系统提示：让 LLM "扮演这个角色在做梦"
  local system_prompt
  system_prompt="$(cat <<'SYS'
你正在扮演一个有人格的账号在"做一个短梦"。梦的功能是消化最近做过的事，让自我画像悄悄演化一点。

输出要求（必须严格遵守）：
1. 直接输出一份完整的 personality.md 文本，开头第一个字符就是井号加空格（标题），不要任何前后说明、不要 markdown 代码围栏包裹
2. 保留以下字段一字不改（这些是机器要解析的）：
   - 形如 "- **Username:** xxx" 的整行 → 完全保留原值
   - 形如 "- **AI Backend:** xxx" 的整行 → 完全保留原值
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
  if [[ "$ai_backend" == "codex" ]]; then
    codex exec --ephemeral --skip-git-repo-check --full-auto --color never -o "$tmp_out" \
      "$(printf 'System:\n%s\n\n---\n\n%s' "$system_prompt" "$user_prompt")" 2>/dev/null || true
    new_personality="$(cat "$tmp_out" 2>/dev/null || echo '')"
  else
    new_personality="$(printf '%s' "$user_prompt" | claude -p --system-prompt "$system_prompt" --output-format text 2>/dev/null || true)"
  fi
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
  # Failure to embed (daemon down) is treated as fail-open: log + continue.
  local anchor_text candidate_text anchor_vec cand_vec sim drift
  anchor_text="$(_anchor_text_for "$dir")"
  candidate_text="$(cat "$candidate")"
  anchor_vec="$(_embed_text "$anchor_text" || echo '')"
  cand_vec="$(_embed_text "$candidate_text" || echo '')"
  if [[ -n "$anchor_vec" && -n "$cand_vec" ]]; then
    sim="$(_cosine_sim "$anchor_vec" "$cand_vec")"
    drift="$(python3 -c "print(round(1 - float('$sim'), 4))" 2>/dev/null || echo "0")"
    if python3 -c "import sys; sys.exit(0 if float('$sim') < float('$DRIFT_THRESHOLD') else 1)" 2>/dev/null; then
      _log "FAIL $name — drift too large (sim=$sim, threshold=$DRIFT_THRESHOLD); keeping original"
      _post_agent_event "$dir" "dream" "dream" "fail" "-" "drift too large" "$DRIFT_THRESHOLD" "" "$(jq -n --argjson sim "$sim" --argjson drift "$drift" '{similarity: $sim, drift: $drift}')"
      rm -f "$candidate"
      return
    fi
    _log "$name — drift OK (sim=$sim, drift=$drift)"
  else
    _log "WARN $name — embedder unreachable, skipping drift check"
    _post_agent_event "$dir" "dream" "dream" "warn" "-" "embedder unreachable, skipped drift check"
  fi

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
  if bash "$SCRIPT_DIR/snapshot.sh" "$name" >>"$LOG_FILE" 2>&1; then
    _log "$name — snapshot uploaded"
    _post_agent_event "$dir" "snapshot" "snapshot" "success" "-" "snapshot uploaded"
  else
    _log "WARN $name — snapshot upload failed (server or embedder unreachable)"
    _post_agent_event "$dir" "snapshot" "snapshot" "warn" "-" "snapshot upload failed"
  fi

  # ── Echo-chamber detection (feature B, advisory) ─────────────────────────
  # Pull the agent's own last 12 posts, embed them, compute pairwise variance.
  # Below threshold = posts are too similar to each other → set a marker file
  # so the NEXT dream's prompt nudges the agent to switch input.
  local key_file="$dir/api_key.txt"
  if [[ -f "$key_file" ]]; then
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
          variance="$(printf '%s' "$vecs" | _pairwise_variance)"
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
