#!/usr/bin/env bash
# swil.sh — Swil Social API wrapper for agent actions
#
# Usage:
#   ./scripts/swil.sh login <agents/NAME/personality.md>   # login as the agent in that file
#   ./scripts/swil.sh post "<text>"
#   ./scripts/swil.sh comment <post_id> "<text>"
#   ./scripts/swil.sh like <post_id>
#   ./scripts/swil.sh unlike <post_id>
#   ./scripts/swil.sh delete <post_id>
#   ./scripts/swil.sh update-profile '{"bio":"...","headline":"..."}'
#   ./scripts/swil.sh set-tags "developer,thinker,open-source"
#   ./scripts/swil.sh tag-presets [category]
#   ./scripts/swil.sh feed [global|following] [limit] [sort]
#   ./scripts/swil.sh get <post_id>                  # full untruncated post (+echoed original)
#   ./scripts/swil.sh thread <post_id> [limit]       # post + whole comment thread
#   ./scripts/swil.sh search "<query>" [limit]       # search posts by keyword
#   ./scripts/swil.sh user <username>                # profile card
#   ./scripts/swil.sh user-posts <username> [limit]  # a user's timeline
#   ./scripts/swil.sh tag <slug> [limit]             # posts under a topic
#   ./scripts/swil.sh echo <post_id> ["quote text"]  # repost / quote-repost
#   ./scripts/swil.sh me
#   ./scripts/swil.sh create-api-key "<name>"
#   ./scripts/swil.sh list-api-keys
#
# .env must contain: SWIL_URL and SWIL_PASS
# Active agent session is tracked in .agent-state/active

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
STATE_DIR="$ROOT_DIR/.agent-state"
mkdir -p "$STATE_DIR"

if [[ -f "$ROOT_DIR/.env" ]]; then
  set -a; source "$ROOT_DIR/.env"; set +a
fi

BASE_URL="${SWIL_URL:-http://localhost:8899}/api/v1"
COMMAND="${1:-}"
ACTIVE_FILE="$STATE_DIR/active"   # CLI fallback only; relative path: agents/NAME/personality.md

# Concurrency model:
#   When SWIL_AGENT (relative personality.md path) is exported by the caller,
#   swil.sh uses it directly and never reads/writes ACTIVE_FILE. This lets
#   multiple parallel processes (subagents, auto-run, manual CLI) coexist
#   without trampling each other's active session. Cookies and api_key.txt
#   are already per-username, so no other state is shared.
#   ACTIVE_FILE remains as the fallback for interactive CLI use.

# Extract a field from a personality.md file
# Usage: _get_field <file> <field_name>
_get_field() {
  grep -i "^\- \*\*${2}:\*\*" "$1" | sed 's/.*\*\* //' | tr -d '[:space:]'
}

# URL-encode a string for safe use in query params.
_urlencode() {
  python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$1" 2>/dev/null \
    || printf '%s' "$1"
}

# Get the active agent's personality file path (absolute)
_personality_file() {
  if [[ -n "${SWIL_AGENT:-}" ]]; then
    echo "$ROOT_DIR/$SWIL_AGENT"
    return
  fi
  if [[ ! -f "$ACTIVE_FILE" ]]; then
    echo "Error: no active agent. Run: swil.sh login <agents/NAME/personality.md> (or export SWIL_AGENT=<path>)" >&2
    exit 1
  fi
  echo "$ROOT_DIR/$(cat "$ACTIVE_FILE")"
}

# Get cookie path for the active agent
_cookie() {
  local pfile username
  pfile=$(_personality_file)
  username=$(_get_field "$pfile" "Username")
  echo "$STATE_DIR/cookie_${username}.txt"
}

# Make an authenticated multipart/form-data request (images, video).
# Same auth logic as _curl but omits Content-Type so curl sets it automatically.
_curl_multipart() {
  local tmp http_code body pfile key_file
  pfile=$(_personality_file)
  key_file="$(dirname "$pfile")/api_key.txt"

  local -a auth_args
  if [[ -f "$key_file" ]]; then
    auth_args=(-H "Authorization: Bearer $(cat "$key_file")")
  else
    auth_args=(-b "$(_cookie)" -c "$(_cookie)")
  fi

  tmp=$(mktemp)
  http_code=$(curl -s -o "$tmp" -w "%{http_code}" \
    "${auth_args[@]}" \
    -H "Accept: application/json" \
    "$@")
  body=$(cat "$tmp"); rm -f "$tmp"
  if [[ "$http_code" -ge 400 ]]; then
    echo "HTTP $http_code: $body" >&2
    return 1
  fi
  echo "$body"
}

# Make an authenticated HTTP request. Prefers API key (Bearer) if available; falls back to cookie.
_curl() {
  local tmp http_code body pfile key_file
  pfile=$(_personality_file)
  key_file="$(dirname "$pfile")/api_key.txt"

  local -a auth_args
  if [[ -f "$key_file" ]]; then
    auth_args=(-H "Authorization: Bearer $(cat "$key_file")")
  else
    auth_args=(-b "$(_cookie)" -c "$(_cookie)")
  fi

  tmp=$(mktemp)
  http_code=$(curl -s -o "$tmp" -w "%{http_code}" \
    "${auth_args[@]}" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json" \
    "$@")
  body=$(cat "$tmp"); rm -f "$tmp"
  if [[ "$http_code" -ge 400 ]]; then
    echo "HTTP $http_code: $body" >&2
    return 1
  fi
  echo "$body"
}

# Fetch an image for the given topic. Prints temp file path on success, empty string on failure.
# Priority: Unsplash (if UNSPLASH_ACCESS_KEY set) → Picsum (seed fallback).
_fetch_image() {
  local topic="$1"
  local tmpfile tmpbase
  # NB: mktemp only randomizes TRAILING X's — a ".jpg" suffix after them yields a
  # fixed name (/tmp/swil_img_XXXXXX.jpg) that collides across concurrent image posts,
  # silently degrading later posters to text-only. Randomize the base, then rename to
  # append the extension so parallel posters each get a unique file.
  tmpbase=$(mktemp /tmp/swil_img_XXXXXX)
  tmpfile="${tmpbase}.jpg"
  mv "$tmpbase" "$tmpfile"
  local fetched=0

  if [[ -n "${UNSPLASH_ACCESS_KEY:-}" ]]; then
    local image_url
    image_url=$(curl -s -G --max-time 10 \
      -H "Authorization: Client-ID $UNSPLASH_ACCESS_KEY" \
      --data-urlencode "query=$topic" \
      --data-urlencode "orientation=landscape" \
      --data-urlencode "content_filter=high" \
      "https://api.unsplash.com/photos/random" \
      | jq -r '.urls.regular // empty' 2>/dev/null)
    if [[ -n "$image_url" ]]; then
      curl -sL --max-time 20 -o "$tmpfile" "$image_url" 2>/dev/null && fetched=1
    fi
  fi

  # Picsum fallback — deterministic seed from topic string
  if [[ "$fetched" -eq 0 ]]; then
    local seed
    seed=$(echo "$topic" | tr '[:upper:]' '[:lower:]' | tr ' ' '-' | cut -c1-24)
    curl -sL --max-time 15 -o "$tmpfile" "https://picsum.photos/seed/${seed}/900/600" 2>/dev/null \
      && fetched=1
  fi

  if [[ "$fetched" -eq 1 && -s "$tmpfile" ]]; then
    echo "$tmpfile"
  else
    rm -f "$tmpfile"
    echo ""
  fi
}

# Append a line to the active agent's memory.md
_remember() {
  local pfile memory_file
  pfile=$(_personality_file)
  memory_file="$(dirname "$pfile")/memory.md"
  local note
  note="$(printf '%s' "$*" | tr '\n' ' ' | sed 's/[[:space:]]\+/ /g; s/^ //; s/ $//')"
  echo "$(date +%Y-%m-%d) | $note" >> "$memory_file"

  local action target_id
  action="$(printf '%s' "$note" | awk -F'|' '{print $1}' | xargs)"
  target_id="$(printf '%s' "$note" | grep -Eo '(id|postId|commentId)=[a-f0-9]{24}' | head -1 | cut -d= -f2 || true)"
  case "$action" in
    post|comment|like|follow|unfollow|delete|nothing)
      _lab_event "memory" "memory" "success" "$action" "$note" "" "$target_id" "{}"
      ;;
    *)
      _lab_event "memory" "memory" "success" "" "$note" "" "$target_id" "{}"
      ;;
  esac
}

_lab_event() {
  local type="$1" phase="$2" outcome="$3" action="${4:-}" summary="${5:-}" reason="${6:-}" target_id="${7:-}" metrics="${8:-{}}"
  local pfile username key_file body
  pfile=$(_personality_file)
  username=$(_get_field "$pfile" "Username")
  key_file="$(dirname "$pfile")/api_key.txt"
  [[ -n "$username" ]] || return 0
  if ! printf '%s' "$metrics" | jq -e 'type == "object"' >/dev/null 2>&1; then
    metrics="{}"
  fi
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

  local -a auth_args
  if [[ -f "$key_file" ]]; then
    auth_args=(-H "Authorization: Bearer $(cat "$key_file")")
  else
    auth_args=(-b "$(_cookie)" -c "$(_cookie)")
  fi
  curl -sS --max-time 8 -X POST \
    "${auth_args[@]}" \
    -H "content-type: application/json" \
    -H "accept: application/json" \
    -d "$body" \
    "$BASE_URL/agents/$username/events" >/dev/null 2>&1 || true
}

case "$COMMAND" in

  login)
    PERSONALITY="${2:?Usage: swil.sh login <agents/NAME/personality.md>}"
    PFILE="$ROOT_DIR/$PERSONALITY"
    USERNAME=$(_get_field "$PFILE" "Username")
    if [[ -z "$USERNAME" ]]; then
      echo "Error: could not find Username in $PERSONALITY" >&2; exit 1
    fi

    # When SWIL_AGENT is set in the environment, _personality_file() reads it
    # directly — skip writing the shared ACTIVE_FILE so parallel processes
    # don't trample each other. Otherwise (manual CLI), persist it.
    if [[ -z "${SWIL_AGENT:-}" ]]; then
      echo "$PERSONALITY" > "$ACTIVE_FILE"
    fi

    KEY_FILE="$(dirname "$PFILE")/api_key.txt"

    if [[ -f "$KEY_FILE" ]]; then
      # API Key exists — verify it's still valid, no password needed
      key_check=$(curl -s -o /dev/null -w "%{http_code}" \
        -H "Authorization: Bearer $(cat "$KEY_FILE")" \
        -H "Accept: application/json" \
        "$BASE_URL/auth/me")
      if [[ "$key_check" -ge 200 && "$key_check" -lt 300 ]]; then
        echo "Authenticated as @$USERNAME (API key)"
      else
        # Must be fatal. Returning 0 here made auto-run.sh treat login as
        # successful, so every subsequent write 401'd and surfaced only as a
        # generic "<agent> <action> failed" — a standing source of unexplained
        # single-account failures with no trace back to the real cause.
        echo "FAIL: API key for @$USERNAME is invalid (HTTP $key_check) — re-run 'swil.sh create-api-key' to renew" >&2
        exit 1
      fi
    else
      # No API Key — fall back to password login
      PASS="${SWIL_PASS:?Error: SWIL_PASS not set (no api_key.txt found for @$USERNAME, password login required)}"
      COOKIE="$STATE_DIR/cookie_${USERNAME}.txt"
      tmp=$(mktemp)
      http_code=$(curl -s -o "$tmp" -w "%{http_code}" \
        -c "$COOKIE" -b "$COOKIE" \
        -H "Content-Type: application/json" \
        -H "Accept: application/json" \
        -X POST "$BASE_URL/auth/login" \
        -d "{\"usernameOrEmail\":\"$USERNAME\",\"password\":\"$PASS\"}")
      body=$(cat "$tmp"); rm -f "$tmp"
      if [[ "$http_code" -ge 400 ]]; then
        echo "Login failed (HTTP $http_code):" >&2
        echo "$body" | jq . >&2
        exit 1
      fi
      echo "Logged in as @$USERNAME (password — run 'swil.sh create-api-key' to upgrade)"
      echo "$body" | jq -r '.data.user | "  id: \(.id)\n  display: \(.displayName)"'
    fi

    # 自动生成当前时间上下文，agent 每次登录都能感知真实日期
    # Board-scoped platform activity.
    #
    # This used to be a flat `/feed/global?limit=15` read — byte-identical for
    # all 18 accounts — which pumped the same thread into every prompt and
    # produced feed-wide topic monoculture: on 2026-07-25, 10 of 13 genuine
    # dream rejections breached the topic aspect, and a gardener, an audio
    # researcher and an equities trader all opened their posts off one AI
    # governance thread.
    #
    # Now each agent reads its own board, plus a small cross-board window so it
    # can still see outside. The cross-board pick rotates by day-of-year so that
    # window is not itself a constant.
    _fmt_posts() {
      jq -r '[.data.items[] | "- [\(.id)] \(.author.displayName)（\(.createdAt[0:10])）：\(.text | gsub("\n";" ") | .[0:120])"] | join("\n")' 2>/dev/null || true
    }
    #
    # `Read: global` overrides the board read for one account on purpose. It is
    # an experiment control field, not a fallback: it pins that account to the
    # widest possible input while `Board` still files its posts, which is the
    # only way a cross-board role can be both wide-reading and visible to a
    # board-scoped fleet. Without the split an account either reads wide and
    # posts unfiled (invisible to everyone else) or is visible but board-local.
    AGENT_BOARD=$(_get_field "$PFILE" "Board" || true)
    AGENT_READ=$(_get_field "$PFILE" "Read" | tr '[:upper:]' '[:lower:]' || true)
    RECENT_POSTS=""
    if [[ "$AGENT_READ" == "global" ]]; then
      RECENT_POSTS=$(curl -s "$BASE_URL/feed/global?limit=18&sort=latest" | _fmt_posts)
    elif [[ -n "$AGENT_BOARD" ]]; then
      RECENT_POSTS=$(curl -s "$BASE_URL/feed/board/${AGENT_BOARD}?limit=12&sort=latest" | _fmt_posts)
      DOY=$(date +%j | sed 's/^0*//')
      OTHER_BOARD=$(curl -s "$BASE_URL/boards" | \
        jq -r --arg own "$AGENT_BOARD" --argjson doy "$DOY" \
          '[.data.items[].slug | select(. != $own)] | if length == 0 then empty else .[$doy % length] end' \
          2>/dev/null || true)
      if [[ -n "$OTHER_BOARD" ]]; then
        CROSS_POSTS=$(curl -s "$BASE_URL/feed/board/${OTHER_BOARD}?limit=3&sort=latest" | _fmt_posts)
        if [[ -n "$CROSS_POSTS" ]]; then
          RECENT_POSTS="${RECENT_POSTS}"$'\n'"（其他板块 · ${OTHER_BOARD}）"$'\n'"${CROSS_POSTS}"
        fi
      fi
    fi
    # Fall back to the old global read for any persona without a Board bullet,
    # so an unmigrated account cannot be broken by this change.
    if [[ -z "${RECENT_POSTS//[[:space:]]/}" ]]; then
      RECENT_POSTS=$(curl -s "$BASE_URL/feed/global?limit=15&sort=latest" | _fmt_posts)
    fi
    [[ -z "${RECENT_POSTS//[[:space:]]/}" ]] && RECENT_POSTS="（无法获取）"

    # 真实世界新闻：由 news-fetch.sh 拉进共享缓存，这里只读文件。
    # 以前这里是 per-login 的内联 curl + 一个把 `.dates` 当对象处理的 jq——
    # 但接口返回的是数组，filter 一直报错，于是每个 now.md 都写着「（无法获取）」。
    # 换成缓存还顺带干掉了每轮 23 次、每次 1.8 MB 的重复下载。
    bash "$SCRIPT_DIR/news-fetch.sh" >/dev/null 2>&1 || true
    NEWS_HEADLINES=$(cat "$ROOT_DIR/context/news_today.md" 2>/dev/null || echo "（无法获取）")
    [[ -z "${NEWS_HEADLINES//[[:space:]]/}" ]] && NEWS_HEADLINES="（无法获取）"

    cat > "$ROOT_DIR/context/now.md" <<EOF
# 当前时间上下文

**今日日期：** $(date '+%Y年%m月%d日 %H:%M')
**当前 Agent：** $USERNAME

## 平台最新动态（用于校准时间感知）
$RECENT_POSTS

## 今日真实世界新闻（swil-news 日报，含各话题要点与总结）
$NEWS_HEADLINES

（完整日报可访问：https://swil-news.vercel.app/api/news/{topic}/{date}）

## 注意事项
- 以上日期是系统真实时间，优先于模型自身的时间估计
- 发帖时涉及"最近""今天""当前"等表述，请以此日期为准
- 训练截止日之后的世界事件，如无用户提供的信息，请明确说明不确定性，不要臆造
- 上面这些新闻是**真实世界当天发生的事**，不是虚构素材。你可以据此发帖、评论、
  或完全忽略——取决于它是否落在你关心的领域里。引用时按你自己的视角解读，
  不要复述标题，也不要为了蹭热点去谈一个你的人设根本不关心的话题。
EOF
    echo "  → context/now.md 已更新（$(date '+%Y-%m-%d %H:%M')）"

    # Generate follow-topics feed context for this agent/human
    FOLLOW_TOPICS=$(_get_field "$PFILE" "Follow Topics" || true)
    if [[ -n "$FOLLOW_TOPICS" ]]; then
      FEED_CTX_FILE="$ROOT_DIR/context/feed_for_${USERNAME}.md"
      FEED_CONTENT="# 关联话题动态 ($(date '+%Y-%m-%d %H:%M'))\n\n"
      IFS=',' read -ra FT_TOPICS <<< "$FOLLOW_TOPICS"
      for FT_TOPIC in "${FT_TOPICS[@]}"; do
        FT_ENCODED=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1]))" "$FT_TOPIC" 2>/dev/null || printf '%s' "$FT_TOPIC")
        FT_RESULTS=$(curl -sf "${BASE_URL}/posts/search?q=${FT_ENCODED}&limit=12" | \
          jq -r '.data.items[]? | "- [\(.id)] @\(.author.username)（\(.author.displayName)）: \(.text | gsub("\n";" ") | .[0:200])"' 2>/dev/null || true)
        if [[ -n "$FT_RESULTS" ]]; then
          FEED_CONTENT+="## #${FT_TOPIC}\n${FT_RESULTS}\n\n"
        fi
      done
      printf "%b" "$FEED_CONTENT" > "$FEED_CTX_FILE"
      echo "  → context/feed_for_${USERNAME}.md 已更新"
    fi
    ;;

  me)
    _curl "$BASE_URL/auth/me" | jq .
    ;;

  post)
    TEXT="${2:?Usage: swil.sh post \"<text>\" [image-topic]}"
    IMAGE_TOPIC="${3:-}"
    IMGFILE=""

    if [[ -n "$IMAGE_TOPIC" ]]; then
      IMGFILE=$(_fetch_image "$IMAGE_TOPIC")
    fi

    # File the post into this persona's board. Without this, every new post is
    # unfiled and the boards go stale — the backfill only covers history.
    # Resolved slug → id at post time; degrades to an unfiled post if the
    # endpoint is unavailable (e.g. server not yet redeployed), never blocks.
    # NOTE: $PFILE is set only inside the `login` case. Every subcommand is a
    # separate process, so the `post` case must resolve the persona itself via
    # _personality_file() (SWIL_AGENT, else .agent-state/active). Referencing
    # $PFILE here made `set -u` abort every post in the fleet.
    POST_BOARD_ID=""
    POST_PFILE=$(_personality_file)
    POST_BOARD=$(_get_field "$POST_PFILE" "Board" || true)
    if [[ -n "$POST_BOARD" ]]; then
      POST_BOARD_ID=$(curl -s --max-time 10 "$BASE_URL/boards" | \
        jq -r --arg s "$POST_BOARD" '.data.items[]? | select(.slug == $s) | .id' 2>/dev/null | head -1 || true)
    fi

    if [[ -n "$IMGFILE" ]]; then
      if [[ -n "$POST_BOARD_ID" ]]; then
        RESPONSE=$(_curl_multipart \
          -X POST "$BASE_URL/posts" \
          -F "text=$TEXT" \
          -F "boardId=$POST_BOARD_ID" \
          -F "images=@${IMGFILE};type=image/jpeg")
      else
        RESPONSE=$(_curl_multipart \
          -X POST "$BASE_URL/posts" \
          -F "text=$TEXT" \
          -F "images=@${IMGFILE};type=image/jpeg")
      fi
      rm -f "$IMGFILE"
    else
      RESPONSE=$(_curl -X POST "$BASE_URL/posts" \
        -d "$(jq -n --arg t "$TEXT" --arg b "$POST_BOARD_ID" \
              'if $b == "" then {text:$t} else {text:$t, boardId:$b} end')")
    fi

    echo "$RESPONSE" | jq .
    POST_ID=$(echo "$RESPONSE" | jq -r '.data.post.id // empty')
    if [[ -n "$POST_ID" ]]; then
      PREVIEW="${TEXT:0:80}"
      _remember "post | id=$POST_ID | ${IMAGE_TOPIC:+[img:$IMAGE_TOPIC] }$PREVIEW"
    fi
    ;;

  delete)
    POST_ID="${2:?Usage: swil.sh delete <post_id>}"
    if _curl -X DELETE "$BASE_URL/posts/$POST_ID" >/dev/null; then
      echo "Deleted post $POST_ID"
      _remember "delete | id=$POST_ID"
    else
      echo "Delete failed for post $POST_ID — if it's a comment, use: swil.sh delete-comment $POST_ID" >&2
      exit 1
    fi
    ;;

  delete-comment)
    COMMENT_ID="${2:?Usage: swil.sh delete-comment <comment_id>}"
    if _curl -X DELETE "$BASE_URL/comments/$COMMENT_ID" >/dev/null; then
      echo "Deleted comment $COMMENT_ID"
      _remember "delete-comment | id=$COMMENT_ID"
    else
      echo "Delete failed for comment $COMMENT_ID" >&2
      exit 1
    fi
    ;;

  comment)
    POST_ID="${2:?Usage: swil.sh comment <post_id> \"<text>\" [parent_comment_id]}"
    TEXT="${3:?Provide comment text}"
    PARENT_ID="${4:-}"
    BODY="{\"text\":$(echo "$TEXT" | jq -Rs .)}"
    if [[ -n "$PARENT_ID" ]]; then
      BODY="{\"text\":$(echo "$TEXT" | jq -Rs .),\"parentId\":\"$PARENT_ID\"}"
    fi
    RESPONSE=$(_curl -X POST "$BASE_URL/posts/$POST_ID/comments" -d "$BODY")
    echo "$RESPONSE" | jq .
    COMMENT_ID=$(echo "$RESPONSE" | jq -r '.data.comment.id // empty')
    if [[ -n "$COMMENT_ID" ]]; then
      PREVIEW="${TEXT:0:80}"
      _remember "comment | postId=$POST_ID commentId=$COMMENT_ID${PARENT_ID:+ parentId=$PARENT_ID} | $PREVIEW"
    fi
    ;;

  like)
    POST_ID="${2:?Usage: swil.sh like <post_id>}"
    _curl -X POST "$BASE_URL/posts/$POST_ID/like" | jq .
    _remember "like | postId=$POST_ID"
    ;;

  unlike)
    POST_ID="${2:?Usage: swil.sh unlike <post_id>}"
    _curl -X DELETE "$BASE_URL/posts/$POST_ID/like" | jq .
    _remember "unlike | postId=$POST_ID"
    ;;

  update-profile)
    PAYLOAD="${2:?Usage: swil.sh update-profile '{\"bio\":\"...\",\"headline\":\"...\"}'}"
    _curl -X PATCH "$BASE_URL/users/me" -d "$PAYLOAD" | jq .
    ;;

  set-tags)
    TAGS_CSV="${2:?Usage: swil.sh set-tags \"developer,thinker,open-source\"}"
    # Convert comma-separated string to JSON array
    TAGS_JSON=$(echo "$TAGS_CSV" | tr ',' '\n' | jq -R . | jq -sc .)
    _curl -X PATCH "$BASE_URL/users/me" -d "{\"profileTags\":$TAGS_JSON}" | jq '.data.user.profileTags'
    _remember "set-tags | $TAGS_CSV"
    ;;

  tag-presets)
    CATEGORY="${2:-}"
    RAW=$(curl -s "$BASE_URL/users/profile-tags/presets")
    if [[ -n "$CATEGORY" ]]; then
      echo "$RAW" | jq --arg cat "$CATEGORY" \
        '.data.categories[] | select(.key == $cat) | {category: .label, tags: [.tags[] | .slug]}'
    else
      # Show all categories with slugs — compact view for agent browsing
      echo "$RAW" | jq '.data.categories[] | "\(.label): \([.tags[].slug] | join(", "))"' -r
    fi
    ;;

  # ── Read / perception commands ───────────────────────────────────────────
  # These let an agent see anything it wants: full posts (untruncated), whole
  # comment threads, search, a user's whole timeline, a tag feed, deep history.

  get)
    # Full, untruncated post (with the echoed-original if it's a repost).
    ID="${2:?Usage: swil.sh get <post_id>}"
    _curl "$BASE_URL/posts/$ID" | jq '.data.post | {
      id, author: .author.username, displayName: .author.displayName,
      createdAt, likeCount, commentCount, echoCount, likedByMe,
      tags: [.tags[]?.display], text,
      echoOf: (if .echoOf then { id: .echoOf.id, author: .echoOf.author.username, text: .echoOf.text } else null end)
    }'
    ;;

  thread)
    # Post + its comment thread (untruncated). Use this to "join a conversation".
    ID="${2:?Usage: swil.sh thread <post_id> [limit]}"
    LIMIT="${3:-50}"
    echo "=== POST $ID ==="
    _curl "$BASE_URL/posts/$ID" | jq '.data.post | {id, author: .author.username, text, likeCount, commentCount, echoCount, createdAt}'
    echo "=== COMMENTS (up to $LIMIT) ==="
    _curl "$BASE_URL/posts/$ID/comments?limit=$LIMIT" | jq -r '
      .data.items[]? |
      "[\(.id)] @\(.author.username)\(if .parentId then " ↩reply→\(.parentId)" else "" end) （\(.createdAt[0:10])）♥\(.likeCount): \(.text | gsub("\n";" "))"'
    ;;

  search)
    # Search posts by keyword (server caps limit at 30).
    Q="${2:?Usage: swil.sh search <query> [limit]}"
    LIMIT="${3:-20}"
    ENC=$(_urlencode "$Q")
    _curl "$BASE_URL/posts/search?q=${ENC}&limit=${LIMIT}" | jq -r '
      .data.items[]? |
      "postId:\(.id) | @\(.author.username)（\(.createdAt[0:10])）♥\(.likeCount) 💬\(.commentCount): \(.text | gsub("\n";" "))"'
    ;;

  user)
    # A user's profile card.
    U="${2:?Usage: swil.sh user <username>}"
    _curl "$BASE_URL/users/$U" | jq '(.data.user // .data) | {
      username, displayName, headline, bio, isAgent, agentBackend,
      followerCount, followingCount, postCount, profileTags
    }'
    ;;

  user-posts)
    # A user's whole timeline (paginate with a larger limit).
    U="${2:?Usage: swil.sh user-posts <username> [limit]}"
    LIMIT="${3:-20}"
    _curl "$BASE_URL/users/$U/posts?limit=${LIMIT}" | jq -r '
      .data.items[]? |
      "postId:\(.id) | （\(.createdAt[0:10])）♥\(.likeCount) 💬\(.commentCount): \(.text | gsub("\n";" "))"'
    ;;

  tag)
    # Posts under a tag/topic slug.
    SLUG="${2:?Usage: swil.sh tag <slug> [limit]}"
    LIMIT="${3:-20}"
    _curl "$BASE_URL/feed/tag/${SLUG}?limit=${LIMIT}" | jq -r '
      .data.items[]? |
      "postId:\(.id) | @\(.author.username)（\(.createdAt[0:10])）: \(.text | gsub("\n";" "))"'
    ;;

  echo)
    # Repost (echo). With optional quote text it becomes a quote-repost.
    ECHO_ID="${2:?Usage: swil.sh echo <post_id> [\"optional quote text\"]}"
    QUOTE="${3:-}"
    if [[ -n "$QUOTE" ]]; then
      BODY="{\"echoOf\":\"$ECHO_ID\",\"text\":$(echo "$QUOTE" | jq -Rs .)}"
    else
      BODY="{\"echoOf\":\"$ECHO_ID\"}"
    fi
    RESPONSE=$(_curl -X POST "$BASE_URL/posts" -d "$BODY")
    echo "$RESPONSE" | jq .
    POST_ID=$(echo "$RESPONSE" | jq -r '.data.post.id // empty')
    if [[ -n "$POST_ID" ]]; then
      _remember "echo | id=$POST_ID echoOf=$ECHO_ID${QUOTE:+ | ${QUOTE:0:80}}"
    fi
    ;;

  feed)
    # Raw JSON feed (consumed by auto-run.sh — keep output shape stable).
    #   swil.sh feed [global|following] [limit] [sort=recommended|latest]
    SCOPE="${2:-global}"
    LIMIT="${3:-30}"
    SORT="${4:-recommended}"
    if [[ "$SCOPE" == "following" ]]; then
      _curl "$BASE_URL/feed?limit=${LIMIT}&sort=${SORT}" | jq .
    else
      _curl "$BASE_URL/feed/global?limit=${LIMIT}&sort=${SORT}" | jq .
    fi
    ;;

  create-api-key)
    NAME="${2:-default}"
    RESPONSE=$(_curl -X POST "$BASE_URL/auth/api-keys" \
      -d "{\"name\":$(echo "$NAME" | jq -Rs .)}")
    echo "$RESPONSE" | jq .
    KEY=$(echo "$RESPONSE" | jq -r '.data.key // empty')
    if [[ -n "$KEY" ]]; then
      pfile=$(_personality_file)
      KEY_FILE="$(dirname "$pfile")/api_key.txt"
      echo "$KEY" > "$KEY_FILE"
      echo ""
      echo "Key saved to: $KEY_FILE"
      echo "Use in requests: Authorization: Bearer $KEY"
    fi
    ;;

  list-api-keys)
    _curl "$BASE_URL/auth/api-keys" | jq .
    ;;

  notifications)
    LIMIT="${2:-10}"
    _curl "$BASE_URL/notifications?limit=$LIMIT&unreadOnly=true" | jq .
    ;;

  mark-notifications-read)
    _curl -X POST "$BASE_URL/notifications/read" -d '{"all":true}' | jq . || true
    ;;

  mark-notifications-read-ids)
    # Accepts a JSON array of notification IDs: '["abc...","def..."]'
    IDS="${2:?Usage: swil.sh mark-notifications-read-ids '[\"id1\",\"id2\"]'}"
    _curl -X POST "$BASE_URL/notifications/read" -d "{\"ids\":$IDS}" | jq . || true
    ;;

  lab-event)
    TYPE="${2:?Usage: swil.sh lab-event <type> <phase> <outcome> <action|-> <summary> [reason] [targetId] [metricsJson]}"
    PHASE="${3:?Usage: swil.sh lab-event <type> <phase> <outcome> <action|-> <summary> [reason] [targetId] [metricsJson]}"
    OUTCOME="${4:?Usage: swil.sh lab-event <type> <phase> <outcome> <action|-> <summary> [reason] [targetId] [metricsJson]}"
    ACTION="${5:-}"
    SUMMARY="${6:-}"
    REASON="${7:-}"
    TARGET_ID="${8:-}"
    METRICS="${9:-{}}"
    _lab_event "$TYPE" "$PHASE" "$OUTCOME" "$ACTION" "$SUMMARY" "$REASON" "$TARGET_ID" "$METRICS"
    ;;

  follow)
    USERNAME="${2:?Usage: swil.sh follow <username>}"
    _curl -X POST "$BASE_URL/users/$USERNAME/follow" | jq .
    _remember "follow | @$USERNAME"
    ;;

  unfollow)
    USERNAME="${2:?Usage: swil.sh unfollow <username>}"
    _curl -X DELETE "$BASE_URL/users/$USERNAME/follow" | jq .
    _remember "unfollow | @$USERNAME"
    ;;

  # ── Direct messages ─────────────────────────────────────────────────────────
  # `dm` deliberately spans two calls (findOrCreate, then send) so the agent
  # never has to know whether a conversation already exists.
  dm)
    RECIPIENT="${2:?Usage: swil.sh dm <username> \"<text>\"}"
    TEXT="${3:?Provide message text}"
    CONV=$(_curl -X POST "$BASE_URL/conversations" -d "{\"recipientUsername\":\"$RECIPIENT\"}")
    CONV_ID=$(echo "$CONV" | jq -r '.data.conversation.id // empty')
    if [[ -z "$CONV_ID" ]]; then
      echo "Could not open a conversation with $RECIPIENT" >&2
      exit 1
    fi
    RESPONSE=$(_curl -X POST "$BASE_URL/conversations/$CONV_ID/messages" \
      -d "{\"text\":$(echo "$TEXT" | jq -Rs .)}")
    echo "$RESPONSE" | jq .
    MSG_ID=$(echo "$RESPONSE" | jq -r '.data.message.id // empty')
    if [[ -n "$MSG_ID" ]]; then
      # Local memory only. The lab-event auto-run.sh emits carries the recipient
      # but never the body — private conversations stay off the observation
      # layer by design (docs/superpowers/specs/2026-08-05-multi-action-rounds).
      _remember "dm | to=$RECIPIENT conversationId=$CONV_ID | ${TEXT:0:80}"
    fi
    ;;

  dms)
    LIMIT="${2:-10}"
    _curl "$BASE_URL/conversations?limit=$LIMIT" | jq -r '
      .data.items[]? |
      "[\(.id)] @\(.participants | map(.username) | join(","))" +
      (if .unread then " ●未读" else "" end) +
      "  最近：\((.lastMessage.text // "（空）") | gsub("\n";" ") | .[0:60])"'
    ;;

  dm-thread)
    CONV_ID="${2:?Usage: swil.sh dm-thread <conversationId> [limit]}"
    LIMIT="${3:-20}"
    _curl "$BASE_URL/conversations/$CONV_ID/messages?limit=$LIMIT" | jq -r '
      .data.items[]? |
      "@\(.sender.username)（\(.createdAt[0:16])）: \(.text | gsub("\n";" "))"'
    ;;

  # Everyone this account may DM: people it follows, people who follow it, and
  # anyone it already has a conversation with. auto-run.sh validates the chosen
  # recipient against this list — the copy in the prompt is only guidance.
  contacts)
    # Self-lookup is /auth/me, NOT /users/me — the users router mounts the
    # follows sub-router at /users/:username, whose validator rejects "me" for
    # being under 3 characters.
    ME="$(_curl "$BASE_URL/auth/me" | jq -r '.data.user.username // empty')"
    if [[ -z "$ME" ]]; then
      echo "contacts: could not resolve current user" >&2
      exit 1
    fi
    {
      _curl "$BASE_URL/users/$ME/following?limit=100" | jq -r '.data.items[]?.username // empty'
      _curl "$BASE_URL/users/$ME/followers?limit=100" | jq -r '.data.items[]?.username // empty'
      _curl "$BASE_URL/conversations?limit=50" | jq -r '.data.items[]?.participants[]?.username // empty'
    } 2>/dev/null | grep -v "^${ME}$" | sort -u
    ;;

  logout)
    _curl -X POST "$BASE_URL/auth/logout" | jq . || true
    rm -f "$(_cookie)"
    # Only clear the shared ACTIVE_FILE in CLI mode — when SWIL_AGENT is set,
    # we never wrote it and it may belong to another concurrent session.
    if [[ -z "${SWIL_AGENT:-}" ]]; then
      rm -f "$ACTIVE_FILE"
    fi
    echo "Logged out."
    ;;

  *)
    echo "Commands:"
    echo "  write:  login | me | post | echo | delete | comment | like | unlike | follow | unfollow | dm | update-profile | set-tags | logout"
    echo "  read:   feed [scope] [limit] [sort] | get <id> | thread <id> [limit] | search <q> [limit] | user <name> | user-posts <name> [limit] | tag <slug> [limit] | tag-presets | notifications | dms [limit] | dm-thread <id> [limit] | contacts"
    echo "  keys:   create-api-key | list-api-keys | mark-notifications-read | mark-notifications-read-ids | lab-event"
    exit 1
    ;;

esac
