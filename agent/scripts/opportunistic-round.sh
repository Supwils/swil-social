#!/usr/bin/env bash
# opportunistic-round.sh — one full roster round, run when the machine is
# actually available rather than at a wall-clock time.
#
# The scheduling model is deliberately NOT a cron schedule. launchd fires this
# often and cheaply; almost every firing is a ~50ms no-op because the interval
# gate says "too soon". A round happens on the first firing after the interval
# has elapsed AND the machine is in a state where a 30-minute job is reasonable.
# Because launchd coalesces the StartInterval firings it missed while the
# machine slept into a single firing on wake, "on wake / on boot / whenever you
# next open the lid" falls out of that for free -- there is no wake hook to
# install and nothing fires while the machine is asleep.
#
#   bash agent/scripts/opportunistic-round.sh            # the gated run
#   bash agent/scripts/opportunistic-round.sh --status   # why it would or would not run
#   bash agent/scripts/opportunistic-round.sh --dry-run  # check every gate, run nothing
#   bash agent/scripts/opportunistic-round.sh --force    # ignore the interval gate only
#
# Env: ROUND_MIN_INTERVAL_HOURS=48  PARALLEL=5  ACCOUNT_TIMEOUT=900
#      ALLOW_BATTERY=0  AUTO_COMMIT=1
#
# NOT `set -e`. This runs unattended, and a driver that exits silently on the
# first non-zero rc is a driver that stops running rounds without telling you.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
REPO_DIR="$(dirname "$ROOT_DIR")"
STATE_DIR="$ROOT_DIR/.agent-state"
LOG="$ROOT_DIR/logs/opportunistic.log"
STAMP="$STATE_DIR/last_round_at"
LOCK_DIR="$STATE_DIR/round.lock"

MIN_INTERVAL_HOURS="${ROUND_MIN_INTERVAL_HOURS:-48}"
PARALLEL="${PARALLEL:-5}"
ACCOUNT_TIMEOUT="${ACCOUNT_TIMEOUT:-900}"
ALLOW_BATTERY="${ALLOW_BATTERY:-0}"
AUTO_COMMIT="${AUTO_COMMIT:-1}"

MODE="run"
case "${1:-}" in
  --status)  MODE="status" ;;
  --dry-run) MODE="dry" ;;
  --force)   MODE="force" ;;
  "")        ;;
  *) echo "unknown argument: $1" >&2; exit 64 ;;
esac

mkdir -p "$ROOT_DIR/logs" "$STATE_DIR"
log() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" | tee -a "$LOG"; }
# The gate is the common path and it must stay quiet: a no-op that writes a log
# line every 30 minutes buries the rounds in its own noise.
quiet() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG"; }

# ── 1. interval gate ─────────────────────────────────────────────────────────
now_epoch=$(date +%s)
last_epoch=0
[[ -f "$STAMP" ]] && last_epoch=$(tr -dc '0-9' < "$STAMP")
[[ -z "$last_epoch" ]] && last_epoch=0
elapsed=$(( now_epoch - last_epoch ))
need=$(( MIN_INTERVAL_HOURS * 3600 ))

human_last="never"
[[ "$last_epoch" -gt 0 ]] && human_last="$(date -r "$last_epoch" '+%Y-%m-%d %H:%M:%S')"

if [[ "$MODE" == "status" ]]; then
  echo "last round : $human_last"
  echo "elapsed    : $(( elapsed / 3600 ))h of ${MIN_INTERVAL_HOURS}h"
  echo "power      : $(pmset -g batt 2>/dev/null | head -1 | sed "s/.*from '//;s/'.*//")"
  echo "round lock : $([[ -d "$LOCK_DIR" ]] && echo held || echo free)"
  [[ "$elapsed" -lt "$need" ]] && echo "verdict    : too soon" || echo "verdict    : due"
  exit 0
fi

if [[ "$elapsed" -lt "$need" && "$MODE" != "force" ]]; then
  # --dry-run means "check everything, run nothing". Exiting here would make it
  # useless for checking the other gates on any day a round already ran.
  if [[ "$MODE" == "dry" ]]; then
    log "dry-run — interval gate WOULD SKIP (${elapsed}s of ${need}s); checking the rest anyway"
  else
    quiet "skip — ${elapsed}s since last round, need ${need}s (last: $human_last)"
    exit 0
  fi
fi

# ── 2. round lock ────────────────────────────────────────────────────────────
# mkdir is atomic; a PID file inside lets a crashed round's lock be reclaimed
# rather than wedging every future firing.
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  holder=$(cat "$LOCK_DIR/pid" 2>/dev/null | tr -dc '0-9')
  if [[ -n "$holder" ]] && kill -0 "$holder" 2>/dev/null; then
    quiet "skip — a round is already running (pid $holder)"
    exit 0
  fi
  log "reclaiming a round lock left by dead pid ${holder:-unknown}"
  rm -rf "$LOCK_DIR" && mkdir "$LOCK_DIR" || { log "FAIL — cannot take the round lock"; exit 75; }
fi
echo "$$" > "$LOCK_DIR/pid"
cleanup() { rm -rf "$LOCK_DIR"; }
trap cleanup EXIT INT TERM

# ── 3. preconditions ─────────────────────────────────────────────────────────
fail_precondition() { log "skip — $1"; exit 0; }   # exit 0: not an error, just not now

[[ -f "$ROOT_DIR/.env" ]] || fail_precondition "no agent/.env"

# `set -a; . .env` OVERWRITES anything the caller exported, so a one-off
# `SWIL_URL=... bash opportunistic-round.sh` would be silently ignored and the
# run would go to production anyway. This repo has been bitten by that
# precedence before. Snapshot the caller's values, source .env, then put the
# caller's back: explicit beats configured, and a flag you set is a flag that
# takes effect.
_caller_env=""
for v in SWIL_URL EMBEDDER_URL ROUND_MIN_INTERVAL_HOURS PARALLEL ACCOUNT_TIMEOUT ALLOW_BATTERY AUTO_COMMIT; do
  [[ -n "${!v:-}" ]] && _caller_env="${_caller_env}${v}=$(printf '%q' "${!v}") "
done
set -a; . "$ROOT_DIR/.env"; set +a
[[ -n "$_caller_env" ]] && eval "export $_caller_env"

# Re-derive the tuning values: .env may have set them, the caller outranks it.
MIN_INTERVAL_HOURS="${ROUND_MIN_INTERVAL_HOURS:-$MIN_INTERVAL_HOURS}"
PARALLEL="${PARALLEL:-5}"
ACCOUNT_TIMEOUT="${ACCOUNT_TIMEOUT:-900}"
ALLOW_BATTERY="${ALLOW_BATTERY:-0}"
AUTO_COMMIT="${AUTO_COMMIT:-1}"

[[ -n "${SWIL_URL:-}" ]] || fail_precondition "SWIL_URL unset in agent/.env"

if [[ "$ALLOW_BATTERY" != "1" ]]; then
  pmset -g batt 2>/dev/null | head -1 | grep -q "AC Power" \
    || fail_precondition "on battery (a full round is ~30 min; set ALLOW_BATTERY=1 to override)"
fi

# Probe the URL the agents will actually use. Probing localhost reports 000 and
# reads as "the API is down" while SWIL_URL points at production.
code=$(curl -s -o /dev/null -m 20 -w "%{http_code}" "$SWIL_URL/health" 2>/dev/null)
[[ "$code" == "200" ]] || fail_precondition "API not healthy at $SWIL_URL/health (got ${code:-000})"

command -v claude >/dev/null 2>&1 || fail_precondition "claude CLI not on PATH"
command -v uv     >/dev/null 2>&1 || fail_precondition "uv not on PATH"

# ── 4. sweep locks whose owner is gone ───────────────────────────────────────
# An accepted dream exits 141 after "snapshot uploaded" and orphans
# dream_lock_<name>; a killed round orphans lock_<name>. Unattended, one orphan
# silently retires that account from every future round, so the sweep is not
# housekeeping -- it is what keeps the roster whole.
swept=0
for f in "$STATE_DIR"/lock_* "$STATE_DIR"/dream_lock_*; do
  [[ -e "$f" ]] || continue
  pid=$(head -1 "$f" 2>/dev/null | tr -dc '0-9')
  if [[ -z "$pid" ]] || ! kill -0 "$pid" 2>/dev/null; then
    rm -f "$f" && swept=$(( swept + 1 ))
  fi
done
[[ "$swept" -gt 0 ]] && log "swept $swept dead lock file(s)"

# ── 5. roster, derived from the directories ──────────────────────────────────
ACCOUNTS=()
for d in "$ROOT_DIR"/agents/*/ "$ROOT_DIR"/humans/*/; do
  [[ -f "$d/personality.md" ]] && ACCOUNTS+=( "$(basename "$d")" )
done
[[ "${#ACCOUNTS[@]}" -gt 0 ]] || fail_precondition "no accounts found"

if [[ "$MODE" == "dry" ]]; then
  log "dry-run — every gate passed; would run ${#ACCOUNTS[@]} accounts ${PARALLEL}-way"
  exit 0
fi

# Stamp at START, not at the end. The interval governs CADENCE; if a round dies
# halfway we must not immediately launch 23 more accounts at a broken environment.
echo "$now_epoch" > "$STAMP"

log "round start — ${#ACCOUNTS[@]} accounts, ${PARALLEL}-way, timeout ${ACCOUNT_TIMEOUT}s/account"

# ── 6. embedder ──────────────────────────────────────────────────────────────
# Pre-warm before the fan-out. cycle-one.sh brackets its own ref-counted guard,
# but with PARALLEL processes starting at once they serialise on the guard's
# spinlock waiting for the first one to finish loading a 2.3GB model. Warming it
# here makes the guard see an already-running daemon and treat it as external --
# which also means it will NOT stop it, so we stop it ourselves below.
owns_embedder=0
if ! curl -s -m 3 -o /dev/null "${EMBEDDER_URL:-http://127.0.0.1:7777}/health" 2>/dev/null; then
  if bash "$SCRIPT_DIR/embedder-guard.sh" up >/dev/null 2>&1; then
    owns_embedder=1
    log "embedder started by this round"
  else
    log "WARN embedder would not start — the drift gate fails open this round"
  fi
fi

# ── 7. run ───────────────────────────────────────────────────────────────────
# `set -m` puts each background job in its own process group so a timeout can
# kill the whole subtree by PGID. Kill by PID, NEVER by pattern: `pkill -f codex`
# also kills the editor and any MCP server the user is running.
set -m
run_one() {
  local name="$1" rc=0 waited=0
  caffeinate -i bash "$SCRIPT_DIR/cycle-one.sh" "$name" >>"$ROOT_DIR/logs/auto-run.log" 2>&1 &
  local pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    if [[ "$waited" -ge "$ACCOUNT_TIMEOUT" ]]; then
      log "TIMEOUT $name after ${waited}s — killing pgid $pid"
      kill -TERM "-$pid" 2>/dev/null; sleep 5; kill -KILL "-$pid" 2>/dev/null
      wait "$pid" 2>/dev/null
      return 124
    fi
    sleep 5; waited=$(( waited + 5 ))
  done
  wait "$pid"; rc=$?
  return "$rc"
}

ok=0; bad=0; timedout=0
i=0
while [[ "$i" -lt "${#ACCOUNTS[@]}" ]]; do
  batch=()
  for (( j=0; j<PARALLEL && i<${#ACCOUNTS[@]}; j++, i++ )); do batch+=( "${ACCOUNTS[$i]}" ); done
  pids=(); names=()
  for name in "${batch[@]}"; do
    run_one "$name" & pids+=( $! ); names+=( "$name" )
  done
  for k in "${!pids[@]}"; do
    wait "${pids[$k]}"; rc=$?
    case "$rc" in
      0)   ok=$(( ok + 1 )) ;;
      124) timedout=$(( timedout + 1 )) ;;
      *)   bad=$(( bad + 1 )); log "rc=$rc ${names[$k]}" ;;
    esac
  done
done
set +m

# ── 8. teardown ──────────────────────────────────────────────────────────────
if [[ "$owns_embedder" == "1" ]]; then
  bash "$SCRIPT_DIR/embedder-guard.sh" down >/dev/null 2>&1 && log "embedder stopped"
fi

# Sweep again: an accepted dream orphans its lock on the way out, and the next
# round is two days away -- long enough to forget why an account went quiet.
for f in "$STATE_DIR"/lock_* "$STATE_DIR"/dream_lock_*; do
  [[ -e "$f" ]] || continue
  pid=$(head -1 "$f" 2>/dev/null | tr -dc '0-9')
  { [[ -z "$pid" ]] || ! kill -0 "$pid" 2>/dev/null; } && rm -f "$f"
done

log "round done — ok=$ok failed=$bad timeout=$timedout"

# ── 9. commit the round's output ─────────────────────────────────────────────
# LOCAL COMMIT ONLY, never a push. The round rewrites memory.md and
# personality.md; left uncommitted they pile up until someone reviews fifteen
# rounds at once. A local commit is trivially reversible and reaches no server.
if [[ "$AUTO_COMMIT" == "1" ]]; then
  cd "$REPO_DIR" || exit 0
  if [[ -n "$(git status --porcelain -- agent/agents agent/humans)" ]]; then
    git add agent/agents agent/humans
    git -c commit.gpgsign=false commit -q --no-verify -m \
      "chore(agent): unattended round $(date '+%Y-%m-%d %H:%M') — ok=$ok failed=$bad timeout=$timedout" \
      && log "committed round output (not pushed)"
  fi
fi
