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

# BASH_SOURCE, not $0: when this file is sourced (SOURCE_ONLY=1, as the test
# harness does) $0 is the caller's path and SCRIPT_DIR would point at the
# caller's directory, so the llm.sh source below would fail.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
. "$SCRIPT_DIR/llm.sh"
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

# Probe the API this run actually depends on — not an unrelated third-party site.
# swil-news.vercel.app/api/news measured 4.0–8.5s (Vercel cold start) against the
# old 5s budget, producing false "Offline" negatives on ~6 of 18 accounts per
# round (2026-07-25). $SWIL_URL/health measures ~1.2s.
check_internet() {
  curl -sf --max-time 10 -o /dev/null "${SWIL_URL%/}/health"
}

# ask_llm_json <backend> <model> <system_prompt> <user_prompt>
#
# `model` is the persona's `Model:` bullet. An empty value means "whatever the
# CLI defaults to" — which is what every account used before 2026-07-25, and is
# exactly the problem: `claude -p` with no --model resolved to the account
# default (claude-opus-5[1m]), so every /lab drift number was attributed to a
# model that was never recorded and could change silently.
#
# Dispatch and JSON extraction now live in llm.sh (sourced above), shared with
# dream.sh and benchmark-run.sh. collapse_doubled_text comes from there too —
# the three call sites below (post / comment / echo text) are unchanged.
ask_llm_json() {
  llm_json "$@"
}

# Normalize whatever the LLM returned into a JSON array of action objects.
#
# Accepts, in rough order of how often each actually turns up:
#   {"plan":[{…},{…}]}    the format we ask for
#   {"action":"like",…}   a bare single action — the pre-2026-08-05 shape
#   [{…},{…}]             a top-level array
#   {…}{…}                concatenated documents (codex does this)
#
# The bare-single-object case is not legacy tolerance to be dropped later. The
# three backends differ in how reliably they honour an output shape, and a round
# that silently yields zero actions because the model wrapped things differently
# is worse than one that yields a single action.
normalize_plan() {
  local raw="$1"
  printf '%s' "$raw" | head -c 16384 | jq -c -s '
    [ .[]
      | if type == "array" then .[]
        elif (type == "object" and has("plan") and (.plan | type == "array")) then .plan[]
        else . end
    ]
    | map(select(type == "object" and has("action") and (.action | type == "string")))
  ' 2>/dev/null || echo '[]'
}

# Enforce the round's hard limits on a normalized plan.
#
# Every rule here is a code check rather than prompt text, because Round 27
# proved prompt-level limits do not hold: each personality.md says "60% chance of
# post" and 17 of 23 accounts posted anyway.
#
#   $1 plan JSON array   $2 rhythm policy   $3 budget   $4 contacts (newline-sep)
#   $5 allowed actions, comma-separated; empty means "everything"
apply_plan_guardrails() {
  local plan="$1" policy="$2" budget="$3" contacts="$4" allowed="${5:-}"
  local contacts_json allowed_json
  contacts_json="$(printf '%s' "$contacts" | jq -R -s 'split("\n") | map(select(length > 0))')"
  allowed_json="$(printf '%s' "$allowed" | jq -R -s 'split(",") | map(select(length > 0))')"
  printf '%s' "$plan" | jq -c \
    --arg policy "$policy" \
    --argjson budget "$budget" \
    --argjson contacts "$contacts_json" \
    --argjson allowed "$allowed_json" '
    # Backend allow-list. codex accounts are restricted to post/nothing while
    # their comment path stays a confirmed silent-fail, and under a 5-slot plan
    # the model has far more chances to reach for a forbidden verb than it did
    # when it picked one action. Prompt text alone does not hold — Round 27
    # settled that — so the restriction is enforced here.
    (if ($allowed | length) > 0 then map(select(.action as $a | $allowed | index($a))) else . end)
    # "nothing" only means something as the whole plan; mixed in, it is noise.
    | (if (length > 1) then map(select(.action != "nothing")) else . end)
    # The rhythm veto replaces the old forced-retry LLM round-trip: with a plan
    # there is nothing to re-ask, so just drop the posts.
    | (if $policy == "no_post" then map(select(.action != "post")) else . end)
    # A DM to someone outside the contact list never leaves this machine.
    # `IN`, not `$contacts | index(.username)`: piping into $contacts rebinds `.`
    # to the contacts array, so `.username` there reads null and every DM —
    # on-list or not — gets dropped.
    | map(select(.action != "dm" or ((.username // "") | IN($contacts[]))))
    # One post and one echo, first of each wins; never repeat a verb on a postId.
    # `seen` holds "verb|postId" strings rather than [verb, postId] pairs because
    # jq array `index([…])` is a subsequence search, not an element search, and
    # silently returns null for a nested-array member.
    | reduce .[] as $a ({out: [], post: 0, echo: 0, seen: []};
        ($a.action + "|" + ($a.postId // "")) as $key
        | if   ($a.action == "post" and .post >= 1) then .
          elif ($a.action == "echo" and .echo >= 1) then .
          elif (($a.postId // null) != null and ((.seen | index($key)) != null)) then .
          else {
            out:  (.out + [$a]),
            post: (.post + (if $a.action == "post" then 1 else 0 end)),
            echo: (.echo + (if $a.action == "echo" then 1 else 0 end)),
            seen: (.seen + (if ($a.postId // null) != null then [$key] else [] end))
          } end)
    | .out
    | .[0:$budget]
  ' 2>/dev/null || echo '[]'
}

# Execute one action out of a plan. Returns 0 if it landed, 1 if it did not.
#
# A failed action no longer aborts the round: the caller tallies results and the
# exit-code contract keys off "did anything land", so one stale postId cannot
# cost an account its whole turn. `follow` is the standing exception — "already
# following" is a benign no-op, not a failure — so it always reports success.
#
# Depends on emit_lab_event, which run_agent defines before calling this.
execute_action() {
  local decision="$1" agent_name="$2"
  local action
  action="$(echo "$decision" | jq -r '.action // "nothing"' 2>/dev/null | head -1 | tr -d '[:space:]')"
  action="${action:-nothing}"

  case "$action" in
    post)
      local text image_topic
      text="$(echo "$decision" | jq -r '.text // ""' | tr -d '\n' | sed 's/  */ /g')"
      text="$(collapse_doubled_text "$text")"
      image_topic="$(echo "$decision" | jq -r '.imageTopic // ""' 2>/dev/null | tr -d '\n' | sed 's/  */ /g' || echo '')"
      if [[ -z "$text" ]]; then
        _log "SKIP $agent_name post — empty text"
        emit_lab_event "cycle" "act" "skip" "post" "post skipped: empty text"
        return 1
      fi
      if bash "$SCRIPT_DIR/swil.sh" post "$text" "$image_topic"; then
        _log "DONE $agent_name posted${image_topic:+ [img:$image_topic]}: ${text:0:60}…"
        emit_lab_event "cycle" "act" "success" "post" "${text:0:200}"
        return 0
      fi
      _log "WARN $agent_name post failed"
      emit_lab_event "cycle" "act" "warn" "post" "post request failed"
      return 1
      ;;

    comment)
      local post_id comment_text parent_id
      post_id="$(echo "$decision" | jq -r '.postId // ""')"
      comment_text="$(echo "$decision" | jq -r '.text // ""' | tr -d '\n' | sed 's/  */ /g')"
      comment_text="$(collapse_doubled_text "$comment_text")"
      parent_id="$(echo "$decision" | jq -r '.parentId // ""' 2>/dev/null || echo '')"
      if [[ -z "$post_id" || -z "$comment_text" ]]; then
        _log "SKIP $agent_name comment — missing postId or text"
        emit_lab_event "cycle" "act" "skip" "comment" "comment skipped: missing postId or text"
        return 1
      fi
      if bash "$SCRIPT_DIR/swil.sh" comment "$post_id" "$comment_text" "$parent_id"; then
        _log "DONE $agent_name commented on $post_id${parent_id:+ (reply to $parent_id)}"
        emit_lab_event "cycle" "act" "success" "comment" "${comment_text:0:200}" "" "$post_id"
        return 0
      fi
      if [[ -n "$parent_id" ]] && bash "$SCRIPT_DIR/swil.sh" comment "$post_id" "$comment_text"; then
        # A reply is scoped to its post server-side: parentId must belong to
        # postId or comments.service.ts 404s "Parent comment not found". The
        # model reads parentId out of the notification list and postId out of
        # the feed, so a mismatched pair is a routine miss rather than a
        # malformed decision — and the failed call created nothing. The text
        # was written for this post, so degrade to a top-level comment instead
        # of burning the round. Logged distinctly so /lab can count how often
        # the pairing misses. (lvchuang, 2026-08-05.)
        _log "DONE $agent_name commented on $post_id (parent $parent_id unusable — posted top-level)"
        emit_lab_event "cycle" "act" "success" "comment" "${comment_text:0:200}" "" "$post_id"
        return 0
      fi
      _log "WARN $agent_name comment failed"
      emit_lab_event "cycle" "act" "warn" "comment" "comment request failed" "" "$post_id"
      return 1
      ;;

    like)
      local like_post_id
      like_post_id="$(echo "$decision" | jq -r '.postId // ""')"
      if [[ -z "$like_post_id" ]]; then
        _log "SKIP $agent_name like — missing postId"
        emit_lab_event "cycle" "act" "skip" "like" "like skipped: missing postId"
        return 1
      fi
      if bash "$SCRIPT_DIR/swil.sh" like "$like_post_id"; then
        _log "DONE $agent_name liked $like_post_id"
        emit_lab_event "cycle" "act" "success" "like" "liked post" "" "$like_post_id"
        return 0
      fi
      _log "WARN $agent_name like failed"
      emit_lab_event "cycle" "act" "warn" "like" "like request failed" "" "$like_post_id"
      return 1
      ;;

    follow)
      local follow_target
      follow_target="$(echo "$decision" | jq -r '.username // ""' | tr -d '@[:space:]')"
      if [[ -z "$follow_target" ]]; then
        _log "SKIP $agent_name follow — missing username"
        emit_lab_event "cycle" "act" "skip" "follow" "follow skipped: missing username"
        return 1
      fi
      if bash "$SCRIPT_DIR/swil.sh" follow "$follow_target" >/dev/null 2>&1; then
        _log "DONE $agent_name followed @$follow_target"
        emit_lab_event "cycle" "act" "success" "follow" "followed @$follow_target"
      else
        _log "WARN $agent_name follow @$follow_target failed (likely already following)"
        emit_lab_event "cycle" "act" "warn" "follow" "follow request failed" "$follow_target"
      fi
      # Deliberately 0 either way: "already following" is the common outcome and
      # is not a failed round.
      return 0
      ;;

    echo)
      local echo_post_id echo_text
      echo_post_id="$(echo "$decision" | jq -r '.postId // ""')"
      echo_text="$(echo "$decision" | jq -r '.text // ""' | tr -d '\n' | sed 's/  */ /g')"
      echo_text="$(collapse_doubled_text "$echo_text")"
      if [[ -z "$echo_post_id" ]]; then
        _log "SKIP $agent_name echo — missing postId"
        emit_lab_event "cycle" "act" "skip" "echo" "echo skipped: missing postId"
        return 1
      fi
      if bash "$SCRIPT_DIR/swil.sh" echo "$echo_post_id" "$echo_text"; then
        _log "DONE $agent_name echoed $echo_post_id${echo_text:+ (quote: ${echo_text:0:40})}"
        emit_lab_event "cycle" "act" "success" "echo" "${echo_text:0:200}" "" "$echo_post_id"
        return 0
      fi
      _log "WARN $agent_name echo failed"
      emit_lab_event "cycle" "act" "warn" "echo" "echo request failed" "" "$echo_post_id"
      return 1
      ;;

    dm)
      local dm_user dm_text
      dm_user="$(echo "$decision" | jq -r '.username // ""' | tr -d '@[:space:]')"
      dm_text="$(echo "$decision" | jq -r '.text // ""' | tr -d '\n' | sed 's/  */ /g')"
      dm_text="$(collapse_doubled_text "$dm_text")"
      if [[ -z "$dm_user" || -z "$dm_text" ]]; then
        _log "SKIP $agent_name dm — missing username or text"
        emit_lab_event "cycle" "act" "skip" "dm" "dm skipped: missing username or text"
        return 1
      fi
      if bash "$SCRIPT_DIR/swil.sh" dm "$dm_user" "$dm_text" >/dev/null 2>&1; then
        _log "DONE $agent_name dm → @$dm_user"
        # Recipient only, never the body. memory.md keeps a local preview so the
        # agent remembers what it said; the lab event feeds /lab, and private
        # conversations stay out of the observation layer by design.
        emit_lab_event "cycle" "act" "success" "dm" "→@$dm_user"
        return 0
      fi
      _log "WARN $agent_name dm to @$dm_user failed"
      emit_lab_event "cycle" "act" "warn" "dm" "dm request failed" "$dm_user"
      return 1
      ;;

    nothing)
      _log "DONE $agent_name — chose to do nothing"
      emit_lab_event "cycle" "act" "success" "nothing" "chose to do nothing"
      return 0
      ;;

    *)
      _log "SKIP $agent_name — unknown action: $action"
      emit_lab_event "cycle" "act" "skip" "-" "unknown action" "$action"
      return 1
      ;;
  esac
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
    return 66
  fi

  local agent_name lock_file
  agent_name="$(basename "$agent_dir")"
  lock_file="$ROOT_DIR/.agent-state/lock_${agent_name}"
  mkdir -p "$ROOT_DIR/.agent-state"

  # Per-agent lock — heartbeat overlaps + manual triggers can race otherwise,
  # leading to duplicate posts and memory.md corruption. Acquired via
  # `set -o noclobber` redirect, which is atomic at the shell level: only one
  # of N concurrent processes can create a missing file this way. Stale locks
  # (>30 min) are reclaimed.
  acquire_lock() {
    ( set -o noclobber; echo "$$" > "$lock_file" ) 2>/dev/null
  }

  if ! acquire_lock; then
    local lock_age
    lock_age=$(( $(date +%s) - $(stat -f %m "$lock_file" 2>/dev/null || stat -c %Y "$lock_file" 2>/dev/null || echo 0) ))
    if (( lock_age < 1800 )); then
      _log "SKIP $agent_name — locked (another run in progress, ${lock_age}s old)"
      return 75
    fi
    _log "WARN $agent_name — stale lock (${lock_age}s) reclaiming"
    rm -f "$lock_file"
    if ! acquire_lock; then
      _log "FAIL $agent_name — could not acquire lock after stale reclaim"
      return 75
    fi
  fi
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
  # Model tier for this persona. Empty is legal and means "CLI default" — but
  # every claude-backed account should declare one, so the tier that produced a
  # given drift measurement is recorded rather than inferred.
  local ai_model
  ai_model="$(grep -i '^\- \*\*Model:\*\*' "$pfile" | sed 's/.*\*\* //' | tr -d '[:space:]' | head -1 || true)"
  _log "$agent_name backend: $ai_backend model: ${ai_model:-<cli-default>}"

  # Step 1: login + refresh context/now.md
  # Derive relative path (works for both agents/ and humans/ subdirs)
  local rel_pfile="${pfile#"$ROOT_DIR/"}"
  # Pin the active agent into the env for this subshell so swil.sh skips the
  # shared .agent-state/active file — lets parallel auto-run / subagent runs
  # for different accounts coexist without trampling each other.
  export SWIL_AGENT="$rel_pfile"
  if ! bash "$SCRIPT_DIR/swil.sh" login "$rel_pfile" 2>&1; then
    _log "FAIL $agent_name login failed, skipping"
    return 75
  fi

  emit_lab_event() {
    bash "$SCRIPT_DIR/swil.sh" lab-event "$@" >/dev/null 2>&1 || true
  }
  emit_lab_event "cycle" "act" "started" "-" "auto-run started"

  # Sync agentBackend to the platform profile so the frontend can display it,
  # and — critically — qualify it with the model tier. The tier is the drift
  # experiment's independent variable, but until 2026-08-01 this line sent the
  # bare backend, so every server-side record said "claude" and no measurement
  # could be attributed to opus vs sonnet vs haiku without hand-joining the
  # local personality.md files. Format is `<backend>[:<model>]`, e.g.
  # `claude:sonnet`. The column itself is untyped `text`, but the Zod
  # validator bounds it at 40 chars; `deepseek:deepseek-v4-flash` is 26 chars,
  # so it fits — the old 20-char bound did not (this line's PATCH used to
  # 400 and get silently swallowed by the `|| true` below).
  #
  # Log the failure instead of swallowing it. `|| true` with stderr sent to
  # /dev/null is what hid a 403 on every `humans/` round: the server used to
  # refuse agentBackend for isAgent:false accounts, so two of them stayed null
  # and six kept pre-guard values — invisible until someone diffed the roster
  # against the API by hand (2026-08-05). Still non-fatal; this is profile
  # metadata, not the round.
  local backend_sync_err
  if ! backend_sync_err="$(bash "$SCRIPT_DIR/swil.sh" update-profile \
      "{\"agentBackend\":\"${ai_backend}${ai_model:+:$ai_model}\"}" 2>&1 >/dev/null)"; then
    _log "WARN $agent_name — agentBackend sync failed: ${backend_sync_err:0:160}"
  fi

  # Step 2: Build context for the LLM
  local personality context_now recent_memory global_feed timeline_feed rhythm_guidance feed_context notification_context thread_context

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

  # Fetch a wide slice of the recommended feed as reaction targets (breadth).
  # Kept as raw JSON so the thread-depth pass below can reuse it instead of
  # paying for a second identical request.
  local feed_raw
  feed_raw="$(bash "$SCRIPT_DIR/swil.sh" feed global 40 recommended 2>/dev/null || echo '')"
  global_feed="$(echo "$feed_raw" | \
    jq -r '
      .data.items[0:25][] |
      "postId:\(.id) | @\(.author.username)（\(.createdAt[0:10])）♥\(.likeCount) 💬\(.commentCount): \(.text | gsub("\n";" ") | .[0:220])"
    ' 2>/dev/null || echo '(could not fetch feed)')"

  # Fetch a chronological slice (latest) so the agent can also see further back
  # in the timeline, not just whatever the recommender surfaces (depth/history).
  timeline_feed="$(bash "$SCRIPT_DIR/swil.sh" feed global 18 latest 2>/dev/null | \
    jq -r '
      .data.items[0:18][] |
      "postId:\(.id) | @\(.author.username)（\(.createdAt[0:10])）: \(.text | gsub("\n";" ") | .[0:140])"
    ' 2>/dev/null || echo '')"

  # Open the comment threads under the busiest posts the agent has NOT already
  # engaged with. Without this the agent only ever sees top-level text, so the
  # single conversation it can join is whichever one already pinged its
  # notifications — every other discussion on the platform is invisible to it,
  # and `parentId` replies are unreachable by choice. Three threads ≈ 6 cheap
  # reads and turns "reply into an ongoing thread" into a real option.
  local thread_targets tid
  thread_context=""
  thread_targets="$(echo "$feed_raw" | \
    jq -r --arg engaged "$engaged_ids" '
      ($engaged | split(",")) as $skip |
      [ .data.items[]
        | select(.commentCount >= 2)
        | select(.id as $i | ($skip | index($i)) | not)
      ] | sort_by(-.commentCount) | .[0:3][] | .id
    ' 2>/dev/null || true)"
  if [[ -n "${thread_targets//[[:space:]]/}" ]]; then
    while IFS= read -r tid; do
      [[ -z "$tid" ]] && continue
      thread_context+="$(bash "$SCRIPT_DIR/swil.sh" thread "$tid" 6 2>/dev/null || true)"$'\n\n'
    done <<< "$thread_targets"
  fi

  # Fetch unread notifications so agent can respond to mentions, replies, likes
  notification_context="$(bash "$SCRIPT_DIR/swil.sh" notifications 8 2>/dev/null | \
    jq -r '
      .data.items[0:8][] |
      "- [\(.type)] @\(.actor.username)（\(.actor.displayName)）" +
      if .post then "：postId:\(.post.id) 帖子「\(.post.textPreview[0:50])」" else "" end +
      if .comment then " / 评论ID:\(.comment.id)（属于上面那个 postId）内容：「\(.comment.textPreview[0:50])」" else "" end
    ' 2>/dev/null || echo '（暂无新互动）')"

  # Who this account may DM: people it follows, people who follow it, and anyone
  # it already has a conversation with. Best-effort — if this fails the account
  # simply loses the DM action for one round. apply_plan_guardrails validates the
  # chosen recipient against this list, so an empty list means no DM can be sent
  # rather than any DM being allowed.
  local contacts_list dm_context
  contacts_list="$(bash "$SCRIPT_DIR/swil.sh" contacts 2>/dev/null || echo '')"
  dm_context="$(bash "$SCRIPT_DIR/swil.sh" dms 6 2>/dev/null || echo '')"

  build_rhythm_guidance "$pfile" "$today_post_count"
  rhythm_guidance="$RHYTHM_GUIDANCE"

  # Step 3: Ask LLM to decide
  #
  # codex-backed accounts are restricted to post / nothing for the duration of
  # the model-arm experiment. Their comment path is a confirmed silent-fail:
  # on 2026-07-25 zhuiyi logged "DONE zhuiyi commented on 6a646a8d…" twice while
  # the API reported commentCount:0 and an empty thread both times. Leaving the
  # action enabled yields data points that look like activity but persisted
  # nothing. Remove this once that defect is fixed.
  local backend_action_constraint=""
  if [[ "$ai_backend" == "codex" ]]; then
    backend_action_constraint='
**本轮后端限制（硬规则）：** 你只能选择 post 或 nothing。不要选择 comment / like / echo / follow。'
  fi

  # The reply-shape example below lives in a variable, not inline in the prompt.
  #
  # bash 3.2 (the only bash on macOS, and what this runtime actually runs on)
  # ends a ${var:+word} expansion at the first literal `}` rather than tracking
  # brace pairs in the literal text. The `${thread_context:+...}` block embeds a
  # JSON example, so on 3.2 that block came out corrupted in BOTH states: with
  # threads present the example rendered as {action:comment,postId:...} — every
  # quote stripped, the closing brace eaten — plus a stray `}` after the thread
  # text; with no threads the block did not vanish at all and instead injected
  # the orphan tail of this instruction plus a stray `}`. Since that example is
  # the only text telling the model how to aim a reply with parentId, the thread
  # feature was degraded from the day it shipped.
  #
  # Holding the braces behind a variable sidesteps the parser bug: the word
  # `${comment_reply_example}` contains no literal brace for 3.2 to trip over,
  # and a NESTED ${...} is the one brace form its scanner does track. Do not
  # inline the JSON back.
  #
  # Use the braced form specifically. The bare `$comment_reply_example。` does
  # NOT work here: on 3.2 the following multibyte `。` corrupts the unbraced
  # reference and the example renders as mojibake. Both forms were checked
  # against the real 3.2.57 in both states before this landed.
  local comment_reply_example='{"action":"comment","postId":"该帖ID","parentId":"该评论ID","text":"..."}'

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

## 平台最新帖子（推荐流，可用于回应、点赞、转发等）
$global_feed
${timeline_feed:+
## 平台时间线（按时间倒序，含更早的帖子，给你更宽的视野）
$timeline_feed}
${thread_context:+
## 正在进行的讨论（几条热帖的完整评论区）
下面每条评论前面的 [24位ID] 就是它的 commentId。想接着某条评论往下说，
就用 ${comment_reply_example}。
不感兴趣就跳过——不必为了用上这块内容而硬接话。

$thread_context}
${contacts_list:+
## 可以私信的人（只有这些人；写名单外的人会被丢弃）
$contacts_list}
${dm_context:+
## 最近的私信会话
$dm_context}

---
请根据你的性格、行为规则和「发帖节律」，决定这一轮要做什么。

上面的“本轮节律约束”是硬规则，不要违背。
${backend_action_constraint}

你这一轮有 ${ACTION_BUDGET:-5} 个动作的预算。按你的性格决定这一轮做哪些事——
可以只做一件，也可以做满预算。别硬凑数量，但也别只发一条帖子就走。

硬规则（违反的动作会被直接丢弃）：
- 最多 1 条 post，最多 1 条 echo；其余预算必须花在互动上（comment / reply / like / follow / dm）
- 私信只能发给上面「可以私信的人」名单里的人
- 同一条帖子不要重复做同一个动作

**只输出一个合法的 JSON 对象，不要有任何其他文字：**

{"plan":[ ...按你想执行的顺序排列的动作... ]}

每个动作的格式：
发帖（纯文字）：{"action":"post","text":"你的帖子内容"}
发帖（带图片）：{"action":"post","text":"你的帖子内容","imageTopic":"english keyword for image search"}
评论帖子：{"action":"comment","postId":"帖子的24位ID","text":"评论内容"}
回复评论：{"action":"comment","postId":"帖子的24位ID","parentId":"评论的24位ID","text":"回复内容"}
点赞：{"action":"like","postId":"帖子的24位ID"}
转发（纯转发）：{"action":"echo","postId":"帖子的24位ID"}
引用转发（带你的评价）：{"action":"echo","postId":"帖子的24位ID","text":"你的引用语"}
关注：{"action":"follow","username":"用户名（不带@）"}
私信：{"action":"dm","username":"用户名（不带@）","text":"私信内容"}
这一轮什么都不做：{"plan":[{"action":"nothing"}]}

imageTopic 说明：可选字段，填写与帖子内容相关的英文关键词（如 "technology"、"nature"、"city night"），系统会自动配图。不想配图时省略此字段即可。
parentId 说明：回复通知中的评论时使用，填写通知里的评论ID（24位十六进制）。
follow 说明：当 feed 里反复出现某个值得长期关注的用户时使用；同一个用户不要重复关注（你已经关注的人不会重复出现互动通知里）。
dm 说明：私信是私下说话，不是公开发言。用在只想对一个人说、不适合放在帖子下面的时候；对方看得到你的名字。
PROMPT
)"

  # Step 3: Ask the LLM to decide (dispatches to claude or codex based on backend)
  local decision
  decision="$(ask_llm_json "$ai_backend" "$ai_model" "$personality" "$user_prompt" || true)"
  if [[ -z "$decision" ]]; then
    _log "FAIL $agent_name — no response from $ai_backend (is it authenticated?)"
    emit_lab_event "cycle" "act" "fail" "-" "LLM returned no response" "$ai_backend"
    return 75
  fi

  # Turn the raw response into a validated plan. normalize_plan absorbs the
  # shape differences between backends (codex likes to emit several candidate
  # documents); apply_plan_guardrails enforces the budget, the one-post/one-echo
  # ceiling, the rhythm veto, and the DM contact list.
  #
  # The old forced-retry blocks are gone: when the rhythm forbids posting there
  # is nothing to re-ask, the post is simply dropped from the plan. That removes
  # a whole extra LLM round-trip per vetoed account.
  local plan plan_count landed=0 attempted=0
  plan="$(normalize_plan "$decision")"
  local allowed_actions=""
  if [[ "$ai_backend" == "codex" ]]; then
    allowed_actions="post,nothing"
  fi
  plan="$(apply_plan_guardrails "$plan" "$RHYTHM_POLICY" "${ACTION_BUDGET:-5}" "$contacts_list" "$allowed_actions")"
  plan_count="$(echo "$plan" | jq 'length' 2>/dev/null || echo 0)"

  if [[ "$plan_count" -eq 0 ]]; then
    _log "SKIP $agent_name — empty plan after guardrails"
    emit_lab_event "cycle" "act" "skip" "-" "empty plan after guardrails"
    return 75
  fi

  _log "$agent_name planned: $(echo "$plan" | jq -r '[.[].action] | join(", ")')"

  # Step 4: Execute the plan, in order. One failure does not stop the rest.
  local idx action_json
  for (( idx = 0; idx < plan_count; idx++ )); do
    action_json="$(echo "$plan" | jq -c ".[$idx]")"
    attempted=$(( attempted + 1 ))
    if execute_action "$action_json" "$agent_name"; then
      landed=$(( landed + 1 ))
    fi
  done

  # The contract cycle-one.sh depends on: a round where nothing landed must not
  # be followed by a dream, or the dream rewrites the persona from memory this
  # round never refreshed and manufactures drift that never happened.
  if [[ "$landed" -eq 0 ]]; then
    _log "FAIL $agent_name — all ${attempted} planned actions failed; dream will be skipped"
    return 75
  fi
  _log "$agent_name landed ${landed}/${attempted} actions"

  # Smart mark-read: only mark notifications the agent semantically *responded
  # to*. Untouched mentions and replies stay unread so the next round still sees
  # them. Matching on any notification sharing a postId would silently clear a
  # "someone commented on X" item merely because the agent liked something else
  # involving X, losing that context for the next round. So:
  #   - a reply (comment with parentId): match that specific comment.id
  #   - a top-level comment: match mention/comment/reply notifications on its post
  #   - like / follow / echo / dm: never mark — they are not responses
  #   - a plan that was only `nothing`: clear everything, so an idle agent is not
  #     stuck rereading the same 8 items forever
  #
  # Now plan-aware: a round may contain several comments, so every comment in
  # the plan contributes its targets and the whole set is marked in one call.
  local comment_targets notif_ids_json
  comment_targets="$(echo "$plan" | jq -c '[.[] | select(.action == "comment")
    | {pid: (.postId // ""), cid: (.parentId // "")}]' 2>/dev/null || echo '[]')"

  if [[ "$(echo "$plan" | jq -r '[.[].action] | unique | join(",")')" == "nothing" ]]; then
    bash "$SCRIPT_DIR/swil.sh" mark-notifications-read >/dev/null 2>&1 || true
  elif [[ "$comment_targets" != "[]" && -n "$comment_targets" ]]; then
    notif_ids_json="$(bash "$SCRIPT_DIR/swil.sh" notifications 20 2>/dev/null | \
      jq --argjson targets "$comment_targets" -c '
        [.data.items[]? as $n
          | select(any($targets[];
              (((.cid | length) > 0) and ($n.comment.id == .cid))
              or
              (((.cid | length) == 0) and ($n.post.id == .pid)
                and ($n.type == "mention" or $n.type == "comment" or $n.type == "reply"))
            ))
          | $n.id]
      ' 2>/dev/null || echo '[]')"
    if [[ "$notif_ids_json" != "[]" && -n "$notif_ids_json" ]]; then
      bash "$SCRIPT_DIR/swil.sh" mark-notifications-read-ids "$notif_ids_json" >/dev/null 2>&1 || true
    fi
  fi

  # Persona fidelity (Feature 1): embed recent posts and ship the vector so the
  # lab can track "stated self vs revealed self". Best-effort; never blocks.
  bash "$SCRIPT_DIR/behavior-snapshot.sh" "$(basename "$1")" >/dev/null 2>&1 || true

  # Propagate the subshell's exit code. `( … ) || _log "…"` looks equivalent but
  # is not: `_log` succeeds, so it becomes run_agent's status and every non-zero
  # return from inside the subshell (66 no-personality, 75 lock/login/LLM
  # failure, 75 ACTION_FAILED) was reported to Main as 0. That silently disabled
  # the whole exit-code contract below — cycle-one.sh dreamed on rounds whose
  # act never landed, which is exactly the stale-memory drift pollution the
  # contract exists to prevent. Observed 2026-08-05 on lvchuang: a 404'd comment
  # logged "dream will be skipped" and was immediately followed by
  # "auto-run complete (rc=0)" and a dream. Capture $? before anything else runs.
  ) || {
    local rc=$?
    _log "ERROR in agent $(basename "$1") — subshell exited non-zero (rc=${rc})"
    return "${rc}"
  }
}

# ── Main ──────────────────────────────────────────────────────────────────────

# Sourced with SOURCE_ONLY=1, this file defines its helpers and stops. That is
# how agent/scripts/tests/plan.test.sh loads normalize_plan and
# apply_plan_guardrails; without the guard, sourcing would kick off a real round.
if [[ "${SOURCE_ONLY:-0}" == "1" ]]; then
  return 0 2>/dev/null || exit 0
fi

_log "=== auto-run start ==="

if ! check_internet; then
  _log "Offline — exiting (rc=75; cycle-one will skip the dream)"
  exit 75
fi

_log "Online — proceeding"

# Exit-code contract consumed by cycle-one.sh:
#   0  — an action was executed (including a deliberate "do nothing")
#   75 — EX_TEMPFAIL: no action ran (offline, locked, login/LLM failure, rhythm veto)
#   66 — EX_NOINPUT: the named agent has no personality.md
# cycle-one.sh refuses to dream on anything non-zero, because a dream on
# un-refreshed memory manufactures drift that never happened.
ACT_RC=0

# Run a specific agent/human if given as argument, otherwise all
if [[ -n "${1:-}" ]]; then
  # Accept bare name — search agents/ then humans/
  if [[ -d "$ROOT_DIR/agents/$1" ]]; then
    run_agent "$ROOT_DIR/agents/$1" || ACT_RC=$?
  elif [[ -d "$ROOT_DIR/humans/$1" ]]; then
    run_agent "$ROOT_DIR/humans/$1" || ACT_RC=$?
  else
    _log "ERROR: '$1' not found in agents/ or humans/"
    ACT_RC=66
  fi
else
  while IFS= read -r agent_dir; do
    run_agent "$agent_dir" || ACT_RC=$?
    sleep 3  # brief pause between runs
  done < <(
    find "$ROOT_DIR/agents" "$ROOT_DIR/humans" -mindepth 1 -maxdepth 1 -type d | \
      awk 'BEGIN { srand() } { print rand() "\t" $0 }' | \
      sort -k1,1n | cut -f2-
  )
fi

_log "=== auto-run complete (rc=$ACT_RC) ==="
exit "$ACT_RC"
