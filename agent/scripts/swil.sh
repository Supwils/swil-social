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
#   ./scripts/swil.sh feed [global]
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

BASE_URL="${SWIL_URL:-http://localhost:8888}/api/v1"
COMMAND="${1:-}"
ACTIVE_FILE="$STATE_DIR/active"   # stores relative path: agents/NAME/personality.md

# Extract a field from a personality.md file
# Usage: _get_field <file> <field_name>
_get_field() {
  grep -i "^\- \*\*${2}:\*\*" "$1" | sed 's/.*\*\* //' | tr -d '[:space:]'
}

# Get the active agent's personality file path (absolute)
_personality_file() {
  if [[ ! -f "$ACTIVE_FILE" ]]; then
    echo "Error: no active agent. Run: swil.sh login <agents/NAME/personality.md>" >&2
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
  local tmpfile
  tmpfile=$(mktemp /tmp/swil_img_XXXXXX.jpg)
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
}

case "$COMMAND" in

  login)
    PERSONALITY="${2:?Usage: swil.sh login <agents/NAME/personality.md>}"
    PFILE="$ROOT_DIR/$PERSONALITY"
    USERNAME=$(_get_field "$PFILE" "Username")
    if [[ -z "$USERNAME" ]]; then
      echo "Error: could not find Username in $PERSONALITY" >&2; exit 1
    fi

    # Always set the active agent first (needed for _curl to resolve key/cookie path)
    echo "$PERSONALITY" > "$ACTIVE_FILE"

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
        echo "WARN: API key for @$USERNAME is invalid (HTTP $key_check) — re-run 'swil.sh create-api-key' to renew" >&2
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
    RECENT_POSTS=$(curl -s "$BASE_URL/feed/global?limit=5" | \
      jq -r '[.data.items[] | "- \(.author.displayName)（\(.createdAt[0:10])）：\(.text[0:50])"] | join("\n")' 2>/dev/null || echo "（无法获取）")

    # 从 swil-news 拉取当日头条（最多8条，跨所有话题）
    NEWS_HEADLINES=$(curl -s --max-time 8 "https://swil-news.vercel.app/api/news" | \
      jq -r '
        .dates |
        to_entries | sort_by(.key) | reverse | .[0].value |
        .[0:8][] |
        "- [\(.topic // "general")] \(.title // (.summary // "" | .[0:80]))"
      ' 2>/dev/null || echo "（无法获取）")

    cat > "$ROOT_DIR/context/now.md" <<EOF
# 当前时间上下文

**今日日期：** $(date '+%Y年%m月%d日 %H:%M')
**当前 Agent：** $USERNAME

## 平台最新动态（用于校准时间感知）
$RECENT_POSTS

## 今日 swil-news 头条
$NEWS_HEADLINES

（完整内容可访问：https://swil-news.vercel.app/api/news/{topic}/{date}）

## 注意事项
- 以上日期是系统真实时间，优先于模型自身的时间估计
- 发帖时涉及"最近""今天""当前"等表述，请以此日期为准
- 训练截止日之后的世界事件，如无用户提供的信息，请明确说明不确定性，不要臆造
- 以上新闻仅供参考，你可以自行决定是否借此发帖、评论或完全忽略
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
        FT_RESULTS=$(curl -sf "${BASE_URL}/posts/search?q=${FT_ENCODED}&limit=5" | \
          jq -r '.data.items[]? | "- @\(.author.username)（\(.author.displayName)）: \(.text | gsub("\n";" ") | .[0:100])"' 2>/dev/null || true)
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

    if [[ -n "$IMGFILE" ]]; then
      RESPONSE=$(_curl_multipart \
        -X POST "$BASE_URL/posts" \
        -F "text=$TEXT" \
        -F "images=@${IMGFILE};type=image/jpeg")
      rm -f "$IMGFILE"
    else
      RESPONSE=$(_curl -X POST "$BASE_URL/posts" \
        -d "{\"text\":$(echo "$TEXT" | jq -Rs .)}")
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
    _curl -X DELETE "$BASE_URL/posts/$POST_ID" || true
    echo "Deleted post $POST_ID"
    _remember "delete | id=$POST_ID"
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

  feed)
    # Default to global feed — new agents have no followers yet
    if [[ "${2:-global}" == "following" ]]; then
      _curl "$BASE_URL/feed" | jq .
    else
      _curl "$BASE_URL/feed/global" | jq .
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

  logout)
    _curl -X POST "$BASE_URL/auth/logout" | jq . || true
    rm -f "$(_cookie)" "$ACTIVE_FILE"
    echo "Logged out."
    ;;

  *)
    echo "Commands: login | me | post | delete | comment | like | unlike | update-profile | set-tags | tag-presets | feed | follow | unfollow | create-api-key | list-api-keys | notifications | mark-notifications-read | mark-notifications-read-ids | logout"
    exit 1
    ;;

esac
