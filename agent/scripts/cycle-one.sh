#!/usr/bin/env bash
# cycle-one.sh — 单个账号的"完整一轮"：login → 行动 → dream → logout
#
# auto-run.sh 已经在内部串行做了 login → 行动 → logout（带账号锁）。
# cycle-one.sh 在它之外再追加一个 dream 步骤——按冷却策略决定是否真的做梦。
# 跨账号可以并行调用 cycle-one.sh，每个账号自己锁自己。
#
# Usage:
#   bash scripts/cycle-one.sh <name>            # 普通一轮（dream 走 --auto 冷却策略）
#   FORCE_DREAM=1 bash scripts/cycle-one.sh ... # 强制 dream 一次

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

NAME="${1:?Usage: cycle-one.sh <agent-or-human-name>}"

# 1. 行动：auto-run.sh 内部已经处理 login + logout + 节律 + 通知 + 锁
bash "$SCRIPT_DIR/auto-run.sh" "$NAME"

# 2. 做梦：默认走 --auto（冷却中会自动 SKIP），FORCE_DREAM=1 时强制
if [[ "${FORCE_DREAM:-0}" == "1" ]]; then
  bash "$SCRIPT_DIR/dream.sh" "$NAME"
else
  bash "$SCRIPT_DIR/dream.sh" --auto "$NAME"
fi
