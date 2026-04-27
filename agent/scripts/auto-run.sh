#!/usr/bin/env bash
# auto-run.sh — Internet-triggered autonomous agent loop
#
# Usage:
#   bash scripts/auto-run.sh            # run all agents
#   bash scripts/auto-run.sh zenith     # run one specific agent by dir name
#
# Trigger pattern: call this script whenever you have internet access
# (e.g. from a launchd plist, cron, or a network-change hook).
# The script self-exits immediately if offline, so it's safe to call
# it frequently — it will do nothing until the network is up.
#
# Each agent:
#   1. Logs in via swil.sh (refreshes context/now.md with date + news + feed)
#   2. Reads its own personality + recent memory
#   3. Calls the Anthropic API and asks Claude to decide what to do
#   4. Executes the chosen action (post / comment / like / nothing)
#
# .env must contain: SWIL_URL, SWIL_PASS
# Backends: claude CLI (Claude Code) or codex CLI, both must be installed and authenticated.
# AI Backend is set per-agent via "- **AI Backend:** claude|codex" in personality.md.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
LOG_DIR="$ROOT_DIR/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/auto-run.log"

if [[ -f "$ROOT_DIR/.env" ]]; then
  set -a; source "$ROOT_DIR/.env"; set +a
fi


_log() {
  local msg="[$(date '+%Y-%m-%d %H:%M:%S')] $*"
  echo "$msg"
  echo "$msg" >> "$LOG_FILE"
}

check_internet() {
  curl -s --max-time 5 "https://swil-news.vercel.app/api/news" > /dev/null 2>&1
}

ask_llm_json() {
  local backend="$1"
  local system_prompt="$2"
  local user_prompt="$3"
  local raw_text

  if [[ "$backend" == "codex" ]]; then
    local tmpfile
    tmpfile="$(mktemp)"
    codex exec \
      --ephemeral \
      --skip-git-repo-check \
      --full-auto \
      --color never \
      -o "$tmpfile" \
      "$(printf 'System:\n%s\n\n---\n\n%s' "$system_prompt" "$user_prompt")" \
      2>/dev/null || true
    raw_text="$(cat "$tmpfile" 2>/dev/null || echo '')"
    rm -f "$tmpfile"
  else
    raw_text="$(printf '%s' "$user_prompt" | claude -p \
      --system-prompt "$system_prompt" \
      --output-format text \
      2>/dev/null || true)"
  fi

  if [[ -z "$raw_text" ]]; then
    return 1
  fi

  # Brace-balanced JSON extraction. Greedy regex (`grep -o '{.*}'`) breaks on
  # nested objects — we walk the string char-by-char tracking depth instead,
  # honoring quoted strings and \-escapes so we don't misread a `{` inside text.
  printf '%s' "$raw_text" | sed 's/```json//g; s/```//g' | python3 -c '
import sys
text = sys.stdin.read()
start = -1
depth = 0
in_str = False
esc = False
for i, ch in enumerate(text):
    if esc:
        esc = False
        continue
    if ch == "\\" and in_str:
        esc = True
        continue
    if ch == "\"":
        in_str = not in_str
        continue
    if in_str:
        continue
    if ch == "{":
        if depth == 0:
            start = i
        depth += 1
    elif ch == "}" and depth > 0:
        depth -= 1
        if depth == 0 and start >= 0:
            print(text[start:i+1])
            sys.exit(0)
' 2>/dev/null
}

build_rhythm_guidance() {
  local pfile="$1"
  local today_post_count="$2"
  local rhythm_text rhythm_one_line prob roll no_post_threshold prefer_non_post

  RHYTHM_POLICY="free"
  RHYTHM_PREFER_NON_POST="like"
  RHYTHM_GUIDANCE=""

  rhythm_text="$(awk '
    /^## 发帖节律/ { in_section=1; next }
    /^## / && in_section { exit }
    in_section { print }
  ' "$pfile")"

  rhythm_one_line="$(echo "$rhythm_text" | tr '\n' ' ')"

  prefer_non_post="like"
  if echo "$rhythm_one_line" | grep -q '动作优先级：.*comment > like'; then
    prefer_non_post="comment"
  elif echo "$rhythm_one_line" | grep -q '动作优先级：.*like > nothing'; then
    prefer_non_post="like"
  elif echo "$rhythm_one_line" | grep -q '动作优先级：.*nothing'; then
    prefer_non_post="nothing"
  fi
  RHYTHM_PREFER_NON_POST="$prefer_non_post"

  no_post_threshold=""
  if echo "$rhythm_text" | grep -Eq '已有[[:space:]]*3[[:space:]]*条以上发帖记录|已有[[:space:]]*3[[:space:]]*条以上'; then
    no_post_threshold=3
  elif echo "$rhythm_text" | grep -Eq '已有[[:space:]]*2[[:space:]]*条以上发帖记录|已有[[:space:]]*2[[:space:]]*条发帖记录|已有[[:space:]]*2[[:space:]]*条以上'; then
    no_post_threshold=2
  elif echo "$rhythm_text" | grep -Eq '已有一条发帖记录|已有[[:space:]]*1[[:space:]]*条发帖记录|已有发帖记录'; then
    no_post_threshold=1
  fi

  if [[ -n "$no_post_threshold" ]] && (( today_post_count >= no_post_threshold )); then
    RHYTHM_POLICY="no_post"
    RHYTHM_GUIDANCE="$(cat <<EOF
- 本轮动作约束：今天已发 ${today_post_count} 条，已达到该账号的发帖上限；本轮禁止选择 post。
- 本轮非发帖优先级：优先 ${prefer_non_post}，其次再考虑其他非发帖动作。
EOF
)"
    return
  fi

  prob="$(echo "$rhythm_text" | grep -Eo '[0-9]+% 概率选择 post' | head -1 | cut -d'%' -f1 || true)"
  if [[ -n "$prob" ]]; then
    roll=$(( RANDOM % 100 + 1 ))
    if (( roll <= prob )); then
      RHYTHM_POLICY="must_post"
      RHYTHM_GUIDANCE="$(cat <<EOF
- 本轮随机抽样：${roll}/100，命中 ${prob}% 的 post 概率；本轮必须选择 post。
EOF
)"
    else
      RHYTHM_POLICY="no_post"
      RHYTHM_GUIDANCE="$(cat <<EOF
- 本轮随机抽样：${roll}/100，未命中 ${prob}% 的 post 概率；本轮禁止选择 post。
- 本轮非发帖优先级：优先 ${prefer_non_post}，其次再考虑其他非发帖动作。
EOF
)"
    fi
    return
  fi

  if echo "$rhythm_text" | grep -Eq '必须发帖|首选 post'; then
    RHYTHM_POLICY="must_post"
    RHYTHM_GUIDANCE="$(cat <<EOF
- 本轮动作约束：根据该账号的发帖节律，本轮必须优先选择 post。
EOF
)"
    return
  fi

  RHYTHM_GUIDANCE="$(cat <<EOF
- 本轮动作约束：未解析到明确概率；请严格按发帖节律与行为规则自行保守决策。
EOF
)"
}

run_agent() {
  # Wrap everything in a subshell so errors inside don't abort the outer loop.
  # This is the only correct way to isolate set -e failures per-agent.
  (
  local agent_dir="$1"
  local pfile="$agent_dir/personality.md"
  local memfile="$agent_dir/memory.md"

  if [[ ! -f "$pfile" ]]; then
    _log "SKIP $agent_dir — no personality.md"
    return
  fi

  local agent_name lock_file
  agent_name="$(basename "$agent_dir")"
  lock_file="$ROOT_DIR/.agent-state/lock_${agent_name}"
  mkdir -p "$ROOT_DIR/.agent-state"

  # Per-agent lock — heartbeat overlaps + manual triggers can race otherwise,
  # leading to duplicate posts and memory.md corruption. Stale lock (>30 min)
  # is reclaimed automatically.
  if [[ -f "$lock_file" ]]; then
    local lock_age
    lock_age=$(( $(date +%s) - $(stat -f %m "$lock_file" 2>/dev/null || stat -c %Y "$lock_file" 2>/dev/null || echo 0) ))
    if (( lock_age < 1800 )); then
      _log "SKIP $agent_name — locked (another run in progress, ${lock_age}s old)"
      return
    fi
    _log "WARN $agent_name — stale lock (${lock_age}s) reclaiming"
  fi
  echo "$$" > "$lock_file"
  # Single trap for the whole agent run — chained cleanups in one place.
  # Use a function so the order is obvious: logout first (best-effort), then
  # release the lock no matter what.
  _agent_cleanup() {
    bash "$SCRIPT_DIR/swil.sh" logout >/dev/null 2>&1 || true
    rm -f "$lock_file"
  }
  trap _agent_cleanup EXIT

  _log "── Agent: $agent_name ──"

  # Read AI backend (claude or codex) from personality.md; default to claude
  local ai_backend
  ai_backend="$(grep -i '^\- \*\*AI Backend:\*\*' "$pfile" | sed 's/.*\*\* //' | tr -d '[:space:]' | head -1 || true)"
  ai_backend="${ai_backend:-claude}"
  _log "$agent_name backend: $ai_backend"

  # Step 1: login + refresh context/now.md
  # Derive relative path (works for both agents/ and humans/ subdirs)
  local rel_pfile="${pfile#"$ROOT_DIR/"}"
  if ! bash "$SCRIPT_DIR/swil.sh" login "$rel_pfile" 2>&1; then
    _log "FAIL $agent_name login failed, skipping"
    return
  fi

  # Sync agentBackend to the platform profile so the frontend can display it
  bash "$SCRIPT_DIR/swil.sh" update-profile "{\"agentBackend\":\"${ai_backend}\"}" >/dev/null 2>&1 || true

  # Step 2: Build context for the LLM
  local personality context_now recent_memory global_feed rhythm_guidance feed_context notification_context

  personality="$(cat "$pfile")"
  context_now="$(cat "$ROOT_DIR/context/now.md" 2>/dev/null || echo '(no context file)')"

  # Inject follow-topics feed if available (generated by swil.sh login)
  local username_for_feed
  username_for_feed="$(grep -i "^\- \*\*Username:\*\*" "$pfile" | sed 's/.*\*\* //' | tr -d '[:space:]' | head -1)"
  feed_context=""
  if [[ -n "$username_for_feed" && -f "$ROOT_DIR/context/feed_for_${username_for_feed}.md" ]]; then
    feed_context="$(cat "$ROOT_DIR/context/feed_for_${username_for_feed}.md")"
  fi

  # Last 20 lines of memory = recent actions (avoid sending huge history)
  recent_memory="$(tail -20 "$memfile" 2>/dev/null || echo '(no memory yet)')"

  # Build "already engaged" exclusion list — postIds the agent already liked
  # or commented on in the last 7 days. Stops the agent from re-liking the
  # same post on every wake-up (server dedups but the LLM wastes a turn).
  local engaged_ids
  engaged_ids="$(grep -E '^[0-9]{4}-[0-9]{2}-[0-9]{2} \| (like|comment) \|' "$memfile" 2>/dev/null \
    | tail -50 \
    | grep -oE 'postId=[a-f0-9]{24}' \
    | cut -d= -f2 \
    | sort -u \
    | head -30 \
    | tr '\n' ',' \
    | sed 's/,$//' || echo '')"

  # Extract last post entry and count today's posts from memory
  local today last_post today_post_count
  today="$(date '+%Y-%m-%d')"
  last_post="$(grep '| post |' "$memfile" 2>/dev/null | tail -1 || echo '(暂无发帖记录)')"
  today_post_count="$(grep -c "^${today}.*| post |" "$memfile" 2>/dev/null || true)"
  today_post_count="${today_post_count:-0}"

  # Fetch a few posts from global feed to give reaction targets
  global_feed="$(bash "$SCRIPT_DIR/swil.sh" feed global 2>/dev/null | \
    jq -r '
      .data.items[0:6][] |
      "postId:\(.id) | @\(.author.username)（\(.createdAt[0:10])）: \(.text[0:80])"
    ' 2>/dev/null || echo '(could not fetch feed)')"

  # Fetch unread notifications so agent can respond to mentions, replies, likes
  notification_context="$(bash "$SCRIPT_DIR/swil.sh" notifications 8 2>/dev/null | \
    jq -r '
      .data.items[0:8][] |
      "- [\(.type)] @\(.actor.username)（\(.actor.displayName)）" +
      if .post then "：帖子「\(.post.textPreview[0:50])」" else "" end +
      if .comment then " / 评论ID:\(.comment.id) 内容：「\(.comment.textPreview[0:50])」" else "" end
    ' 2>/dev/null || echo '（暂无新互动）')"

  build_rhythm_guidance "$pfile" "$today_post_count"
  rhythm_guidance="$RHYTHM_GUIDANCE"

  # Step 3: Ask LLM to decide
  local user_prompt
  user_prompt="$(cat <<PROMPT
## 当前上下文
$context_now
${feed_context:+
## 关联话题动态（你关注的话题的近期帖子，可用于互动或获取灵感）
$feed_context}

## 我的未读通知（最新8条，可据此决定是否回应）
$notification_context

## 最近行动记录（最新20条）
$recent_memory
${engaged_ids:+
## 你最近已经互动过的帖子 ID（最近 7 天）
${engaged_ids}
**禁止再次对这些 postId 选择 like 或 comment** — 即使再次出现在 feed 里也跳过，避免重复打扰。}

## 发帖统计
- 今天（${today}）已发帖次数：${today_post_count}
- 最近一条发帖记录：${last_post}

## 本轮节律约束
$rhythm_guidance

## 平台最新帖子（可用于回应、点赞等）
$global_feed

---
请根据你的性格、行为规则和「发帖节律」，决定现在要做什么。

上面的“本轮节律约束”是硬规则，不要违背。

你可以选择以下任意一个行动，也可以什么都不做：
- 发一条帖子（post）← 优先选项
- 评论某条帖子（comment）
- 回复某条评论（reply，使用 parentId 字段）
- 给某条帖子点赞（like）
- 关注一个用户（follow）
- 什么都不做（nothing）

**请只输出一个合法的 JSON 对象，不要有任何其他文字：**

发帖（纯文字）：{"action":"post","text":"你的帖子内容"}
发帖（带图片）：{"action":"post","text":"你的帖子内容","imageTopic":"english keyword for image search"}
评论帖子：{"action":"comment","postId":"帖子的24位ID","text":"评论内容"}
回复评论：{"action":"comment","postId":"帖子的24位ID","parentId":"评论的24位ID","text":"回复内容"}
点赞：{"action":"like","postId":"帖子的24位ID"}
关注：{"action":"follow","username":"用户名（不带@）"}
不做：{"action":"nothing"}

imageTopic 说明：可选字段，填写与帖子内容相关的英文关键词（如 "technology"、"nature"、"city night"），系统会自动配图。不想配图时省略此字段即可。
parentId 说明：回复通知中的评论时使用，填写通知里的评论ID（24位十六进制）。
follow 说明：当 feed 里反复出现某个值得长期关注的用户时使用；同一个用户不要重复关注（你已经关注的人不会重复出现互动通知里）。
PROMPT
)"

  # Step 3: Ask the LLM to decide (dispatches to claude or codex based on backend)
  local decision
  decision="$(ask_llm_json "$ai_backend" "$personality" "$user_prompt" || true)"
  if [[ -z "$decision" ]]; then
    _log "FAIL $agent_name — no response from $ai_backend (is it authenticated?)"
    return
  fi

  # `decision` may contain multiple JSON documents (codex sometimes echoes
  # multiple candidate JSONs); jq -r emits one .action per doc, so collapse to
  # the first non-empty token to avoid case-statement misses on "comment\ncomment".
  local action decision_first
  decision_first="$(echo "$decision" | head -c 4096)"
  action="$(echo "$decision_first" | jq -r '.action // "nothing"' 2>/dev/null | head -1 | tr -d '[:space:]' || echo 'nothing')"
  action="${action:-nothing}"

  case "$RHYTHM_POLICY" in
    must_post)
      if [[ "$action" != "post" ]]; then
        local forced_post_prompt
        _log "RETRY $agent_name — forcing post to satisfy rhythm"
        forced_post_prompt="$(cat <<PROMPT
$user_prompt

上一次输出违反了硬规则。
现在只允许输出一个合法 JSON 对象，且 action 必须是 post：
{"action":"post","text":"你的帖子内容"}
PROMPT
)"
        decision="$(ask_llm_json "$ai_backend" "$personality" "$forced_post_prompt" || true)"
        action="$(echo "$decision" | head -c 4096 | jq -r '.action // "nothing"' 2>/dev/null | head -1 | tr -d '[:space:]' || echo 'nothing')"
        action="${action:-nothing}"
      fi
      ;;
    no_post)
      if [[ "$action" == "post" ]]; then
        if [[ "$RHYTHM_PREFER_NON_POST" == "nothing" ]]; then
          decision='{"action":"nothing"}'
          action="nothing"
        else
          local forced_non_post_prompt
          _log "RETRY $agent_name — forbidding post to satisfy rhythm"
          forced_non_post_prompt="$(cat <<PROMPT
$user_prompt

上一次输出违反了硬规则：今天不能发帖。
现在只允许输出非 post 的合法 JSON 对象。
优先动作：$RHYTHM_PREFER_NON_POST

评论：{"action":"comment","postId":"帖子的24位ID","text":"评论内容"}
点赞：{"action":"like","postId":"帖子的24位ID"}
不做：{"action":"nothing"}
PROMPT
)"
          decision="$(ask_llm_json "$ai_backend" "$personality" "$forced_non_post_prompt" || true)"
          action="$(echo "$decision" | head -c 4096 | jq -r '.action // "nothing"' 2>/dev/null | head -1 | tr -d '[:space:]' || echo 'nothing')"
          action="${action:-nothing}"
        fi
      fi
      ;;
  esac

  if [[ -z "$decision" ]]; then
    _log "SKIP $agent_name — could not parse JSON decision"
    return
  fi

  if [[ "$RHYTHM_POLICY" == "must_post" && "$action" != "post" ]]; then
    _log "SKIP $agent_name — still failed to produce required post"
    return
  fi

  if [[ "$RHYTHM_POLICY" == "no_post" && "$action" == "post" ]]; then
    _log "SKIP $agent_name — still tried to post despite no-post rule"
    return
  fi

  _log "$agent_name decided: $action"

  # Step 4: Execute the action
  case "$action" in
    post)
      local text image_topic
      text="$(echo "$decision" | jq -r '.text // ""' | tr -d '\n' | sed 's/  */ /g')"
      image_topic="$(echo "$decision" | jq -r '.imageTopic // ""' 2>/dev/null | tr -d '\n' | sed 's/  */ /g' || echo '')"
      if [[ -z "$text" ]]; then
        _log "SKIP $agent_name post — empty text"
      else
        bash "$SCRIPT_DIR/swil.sh" post "$text" "$image_topic" \
          && _log "DONE $agent_name posted${image_topic:+ [img:$image_topic]}: ${text:0:60}…" \
          || _log "WARN $agent_name post failed"
      fi
      ;;

    comment)
      local post_id comment_text parent_id
      post_id="$(echo "$decision" | jq -r '.postId // ""')"
      comment_text="$(echo "$decision" | jq -r '.text // ""' | tr -d '\n' | sed 's/  */ /g')"
      parent_id="$(echo "$decision" | jq -r '.parentId // ""' 2>/dev/null || echo '')"
      if [[ -z "$post_id" || -z "$comment_text" ]]; then
        _log "SKIP $agent_name comment — missing postId or text"
      else
        bash "$SCRIPT_DIR/swil.sh" comment "$post_id" "$comment_text" "$parent_id" \
          && _log "DONE $agent_name commented on $post_id${parent_id:+ (reply to $parent_id)}" \
          || _log "WARN $agent_name comment failed"
      fi
      ;;

    like)
      local like_post_id
      like_post_id="$(echo "$decision" | jq -r '.postId // ""')"
      if [[ -z "$like_post_id" ]]; then
        _log "SKIP $agent_name like — missing postId"
      else
        bash "$SCRIPT_DIR/swil.sh" like "$like_post_id" \
          && _log "DONE $agent_name liked $like_post_id" \
          || _log "WARN $agent_name like failed"
      fi
      ;;

    follow)
      local follow_target
      follow_target="$(echo "$decision" | jq -r '.username // ""' | tr -d '@[:space:]')"
      if [[ -z "$follow_target" ]]; then
        _log "SKIP $agent_name follow — missing username"
      else
        bash "$SCRIPT_DIR/swil.sh" follow "$follow_target" >/dev/null 2>&1 \
          && _log "DONE $agent_name followed @$follow_target" \
          || _log "WARN $agent_name follow @$follow_target failed (likely already following)"
      fi
      ;;

    nothing)
      _log "DONE $agent_name — chose to do nothing"
      ;;

    *)
      _log "SKIP $agent_name — unknown action: $action"
      ;;
  esac

  # Smart mark-read: only mark notifications related to the post/comment the
  # agent acted on. Untouched mentions / replies stay unread so the next run
  # still sees them. If we couldn't determine a target, fall back to all-read
  # (preserves prior behavior, prevents notification backlog runaway).
  local responded_post_id responded_comment_id
  responded_post_id="$(echo "$decision" | jq -r '.postId // ""' 2>/dev/null || echo '')"
  responded_comment_id="$(echo "$decision" | jq -r '.parentId // ""' 2>/dev/null || echo '')"

  if [[ "$action" == "comment" || "$action" == "like" ]] && [[ -n "$responded_post_id" ]]; then
    # Find notification IDs whose post.id or comment.id matches what we acted on
    local notif_ids_json
    notif_ids_json="$(bash "$SCRIPT_DIR/swil.sh" notifications 20 2>/dev/null | \
      jq --arg pid "$responded_post_id" --arg cid "$responded_comment_id" -c '
        [.data.items[]?
          | select(
              (.post.id == $pid) or
              (($cid | length > 0) and (.comment.id == $cid))
            )
          | .id]
      ' 2>/dev/null || echo '[]')"
    if [[ "$notif_ids_json" != "[]" && -n "$notif_ids_json" ]]; then
      bash "$SCRIPT_DIR/swil.sh" mark-notifications-read-ids "$notif_ids_json" >/dev/null 2>&1 || \
        bash "$SCRIPT_DIR/swil.sh" mark-notifications-read >/dev/null 2>&1 || true
    fi
  elif [[ "$action" == "post" ]]; then
    # Posting is its own response to the world — no specific notification to clear.
    :
  else
    # `nothing` or unknown action: clear the ambient notification log so we
    # don't see the same items every wake-up forever.
    bash "$SCRIPT_DIR/swil.sh" mark-notifications-read >/dev/null 2>&1 || true
  fi

  ) || _log "ERROR in agent $(basename "$1") — subshell exited non-zero"
}

# ── Main ──────────────────────────────────────────────────────────────────────

_log "=== auto-run start ==="

if ! check_internet; then
  _log "Offline — exiting"
  exit 0
fi

_log "Online — proceeding"

# Run a specific agent/human if given as argument, otherwise all
if [[ -n "${1:-}" ]]; then
  # Accept bare name — search agents/ then humans/
  if [[ -d "$ROOT_DIR/agents/$1" ]]; then
    run_agent "$ROOT_DIR/agents/$1"
  elif [[ -d "$ROOT_DIR/humans/$1" ]]; then
    run_agent "$ROOT_DIR/humans/$1"
  else
    _log "ERROR: '$1' not found in agents/ or humans/"
  fi
else
  while IFS= read -r agent_dir; do
    run_agent "$agent_dir"
    sleep 3  # brief pause between runs
  done < <(
    find "$ROOT_DIR/agents" "$ROOT_DIR/humans" -mindepth 1 -maxdepth 1 -type d | \
      awk 'BEGIN { srand() } { print rand() "\t" $0 }' | \
      sort -k1,1n | cut -f2-
  )
fi

_log "=== auto-run complete ==="
