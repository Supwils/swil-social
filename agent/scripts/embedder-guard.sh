#!/usr/bin/env bash
# embedder-guard.sh — ref-counted lifecycle guard for the local embedder daemon.
#
# Ensures the bge-m3 embedder (port 7777) is up while any caller needs it, and
# stops it when the LAST caller releases — but ONLY if we were the ones who
# started it. An already-running / launchd-managed embedder is treated as
# "external" and is never killed.
#
# Usage:
#   embedder-guard.sh up      # ensure running, bump refcount   (idempotent)
#   embedder-guard.sh down    # drop refcount, stop if last AND we started it
#   embedder-guard.sh status  # print count / owner / health
#
# Concurrency-safe via an atomic mkdir spinlock; the refcount is file-based so
# it survives across the parallel cycle-one.sh processes of a full round: the
# first `up` boots the daemon, the last `down` shuts it down.
#
# Opt out entirely with EMBEDDER_AUTOSTART=0 (up/down become no-ops).

# NOTE: deliberately no `-e` — a guard must never abort its caller.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
STATE_DIR="$ROOT_DIR/.agent-state"
LOG_DIR="$ROOT_DIR/logs"
EMBEDDER_DIR="$SCRIPT_DIR/embedder"
EMBEDDER_URL="${EMBEDDER_URL:-http://127.0.0.1:7777}"
AUTOSTART="${EMBEDDER_AUTOSTART:-1}"
START_TIMEOUT="${EMBEDDER_START_TIMEOUT:-90}"   # seconds to wait for health

GUARD_DIR="$STATE_DIR/embedder_guard"
LOCKDIR="$STATE_DIR/embedder_guard.lock"
COUNT_FILE="$GUARD_DIR/count"
OWNER_FILE="$GUARD_DIR/owner"   # "self" (we started it) | "external" (already up)
PID_FILE="$GUARD_DIR/pid"
LOG_FILE="$LOG_DIR/embedder.log"

mkdir -p "$GUARD_DIR" "$LOG_DIR"

_log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] embedder-guard: $*" | tee -a "$LOG_FILE" >&2; }

_healthy() { curl -s -m 3 "$EMBEDDER_URL/health" 2>/dev/null | grep -q '"ok":true'; }

_mtime() { stat -f %m "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null || echo 0; }

# Atomic spinlock via mkdir. Steals a lock older than 300s (holder crashed);
# 300s > START_TIMEOUT so a slow daemon boot never triggers a false steal.
_lock() {
  while ! mkdir "$LOCKDIR" 2>/dev/null; do
    local age=$(( $(date +%s) - $(_mtime "$LOCKDIR") ))
    if (( age > 300 )); then
      _log "WARN stealing stale guard lock (age ${age}s)"
      rm -rf "$LOCKDIR"
      continue
    fi
    sleep 0.1
  done
}
_unlock() { rmdir "$LOCKDIR" 2>/dev/null || true; }

_read_count() {
  local c=0
  [[ -f "$COUNT_FILE" ]] && c=$(cat "$COUNT_FILE" 2>/dev/null)
  [[ "$c" =~ ^[0-9]+$ ]] || c=0
  echo "$c"
}

# Boot the daemon in the background and block until /health is green.
# Returns 0 only if it became healthy; records the PID we spawned.
_start_embedder() {
  if [[ ! -x "$EMBEDDER_DIR/.venv/bin/uvicorn" ]]; then
    _log "WARN venv missing ($EMBEDDER_DIR/.venv) — cannot autostart; run embedder/setup.sh"
    return 1
  fi
  # start.sh does `exec uvicorn …`, so $! ends up being the uvicorn PID itself.
  nohup bash "$EMBEDDER_DIR/start.sh" >>"$LOG_FILE" 2>&1 &
  local pid=$!
  echo "$pid" > "$PID_FILE"
  _log "starting embedder (pid $pid), waiting up to ${START_TIMEOUT}s for health…"
  local waited=0
  while (( waited < START_TIMEOUT )); do
    if _healthy; then _log "embedder healthy after ${waited}s"; return 0; fi
    if ! kill -0 "$pid" 2>/dev/null; then _log "WARN embedder process $pid exited during startup"; return 1; fi
    sleep 2
    waited=$(( waited + 2 ))
  done
  _log "WARN embedder not healthy within ${START_TIMEOUT}s"
  return 1
}

_stop_embedder() {
  [[ -f "$PID_FILE" ]] || return 0
  local pid; pid=$(cat "$PID_FILE" 2>/dev/null)
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    _log "stopped embedder we started (pid $pid)"
  fi
  rm -f "$PID_FILE"
}

cmd_up() {
  [[ "$AUTOSTART" == "1" ]] || return 0
  _lock
  local count; count=$(_read_count)
  if (( count == 0 )); then
    if _healthy; then
      echo external > "$OWNER_FILE"
      _log "embedder already running (external) — lifecycle left untouched"
    elif _start_embedder; then
      echo self > "$OWNER_FILE"
    else
      # fail-open: don't claim ownership, don't block the caller's dream step
      echo external > "$OWNER_FILE"
      _log "WARN autostart failed — proceeding without embedder (drift check fail-opens)"
    fi
  fi
  count=$(( count + 1 ))
  echo "$count" > "$COUNT_FILE"
  _unlock
  return 0
}

cmd_down() {
  [[ "$AUTOSTART" == "1" ]] || return 0
  _lock
  local count; count=$(_read_count)
  count=$(( count - 1 )); (( count < 0 )) && count=0
  echo "$count" > "$COUNT_FILE"
  if (( count == 0 )); then
    local owner=external
    [[ -f "$OWNER_FILE" ]] && owner=$(cat "$OWNER_FILE" 2>/dev/null)
    [[ "$owner" == "self" ]] && _stop_embedder
    rm -f "$OWNER_FILE"
  fi
  _unlock
  return 0
}

cmd_status() {
  local count owner health
  count=$(_read_count)
  owner=external; [[ -f "$OWNER_FILE" ]] && owner=$(cat "$OWNER_FILE" 2>/dev/null)
  if _healthy; then health=up; else health=down; fi
  echo "count=$count owner=$owner health=$health url=$EMBEDDER_URL"
}

case "${1:-}" in
  up|acquire|ensure) cmd_up ;;
  down|release|stop)  cmd_down ;;
  status)             cmd_status ;;
  *) echo "Usage: embedder-guard.sh {up|down|status}" >&2; exit 64 ;;
esac
