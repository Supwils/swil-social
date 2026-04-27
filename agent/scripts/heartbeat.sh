#!/usr/bin/env bash
# heartbeat.sh — 随机心跳驱动器
#
# 作用：模拟真实用户行为，以随机间隔触发 auto-run.sh。
# 每次唤醒后随机挑 1-3 个账号运行，而不是全量执行，让节律更自然。
#
# 通常由 launchd 保活（见 com.swil.heartbeat.plist），不需要手动启动。
# 手动启动（调试用）：
#   bash scripts/heartbeat.sh
# 查看运行日志：
#   tail -f logs/heartbeat.log

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
LOG_DIR="$ROOT_DIR/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/heartbeat.log"

_log() {
  local msg="[$(date '+%Y-%m-%d %H:%M:%S')] $*"
  echo "$msg"
  echo "$msg" >> "$LOG_FILE"
}

# 随机休眠区间（秒）
MIN_SLEEP=1200   # 20 分钟
MAX_SLEEP=5400   # 90 分钟

# 每次唤醒随机运行的账号数量区间
MIN_ACCOUNTS=1
MAX_ACCOUNTS=3

_log "=== heartbeat started (pid $$) ==="

while true; do
  # 随机决定本轮运行多少个账号
  COUNT=$(( MIN_ACCOUNTS + RANDOM % (MAX_ACCOUNTS - MIN_ACCOUNTS + 1) ))

  # 从所有 agents/ 和 humans/ 目录里随机挑 COUNT 个（兼容 bash 3.2）
  while IFS= read -r dir; do
    account="$(basename "$dir")"
    _log "→ running: $account"
    bash "$SCRIPT_DIR/auto-run.sh" "$account" || true
    sleep 5   # 账号间的小间隔，避免 API rate limit
  done < <(
    find "$ROOT_DIR/agents" "$ROOT_DIR/humans" \
      -mindepth 1 -maxdepth 1 -type d \
      | awk 'BEGIN { srand() } { print rand() "\t" $0 }' \
      | sort -k1,1n \
      | cut -f2- \
      | head -"$COUNT"
  )

  # 随机等待下一轮
  SLEEP_SEC=$(( MIN_SLEEP + RANDOM % (MAX_SLEEP - MIN_SLEEP + 1) ))
  SLEEP_MIN=$(( SLEEP_SEC / 60 ))
  _log "next run in ~${SLEEP_MIN}m (at $(date -v+${SLEEP_SEC}S '+%H:%M' 2>/dev/null || date '+%H:%M'))"
  sleep "$SLEEP_SEC"
done
