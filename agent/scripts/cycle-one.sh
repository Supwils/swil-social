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

# 0. Embedder 生命周期：确保 dream 步骤有向量服务可用。
#    ref-counted，跨并行 cycle-one 安全：第一个 up 启动、最后一个 down 停掉，
#    且只停我们自己启动的（已在跑的/launchd 托管的不碰）。EMBEDDER_AUTOSTART=0 可禁用。
GUARD="$SCRIPT_DIR/embedder-guard.sh"
bash "$GUARD" up || true
trap 'bash "$GUARD" down || true' EXIT

# 1. 行动：auto-run.sh 内部已经处理 login + logout + 节律 + 通知 + 锁
#    退出码契约（见 auto-run.sh 主流程注释）：
#      0  = 执行了动作（含主动「什么都不做」）
#      非 0 = 本轮没有任何动作落地（离线 / 被锁 / 登录失败 / LLM 无响应 / 节律否决）
#
#    动作没落地却继续做梦，等于让 LLM 在「没有本轮新记忆」的状态下重写人格——
#    必然漂移超标，于是往 personality_snapshots 里注入一条根本没发生过的漂移。
#    2026-07-25 那一轮 16 次拒绝里有 3 次是这么来的（sketch 是干净对照：
#    act 被跳过时 values=0.526/topic=0.565 被拒，act 补跑后重做 0.653/0.726 通过）。
if bash "$SCRIPT_DIR/auto-run.sh" "$NAME"; then
  # 2. 规则遵从度采样：把「这个账号有没有遵守它自己写下的、可机械判定的规则」
  #    记成一条 rule_check 事件，/lab 的 F4 面板从这里取数。
  #
  #    放在 dream 之前是有意的：rule-check.sh 从 personality.md 里解析规则，
  #    而 dream 会重写 personality.md。先采样，量到的才是「产出本轮这些帖子时
  #    真正生效的那份规则」；放在 dream 之后会拿新规则去量旧帖子。
  #
  #    fail-soft：没有可解析规则、没有 api_key、网络失败都不该影响本轮的成败，
  #    所以吞掉非零退出——这是观测层，不是主流程。
  bash "$SCRIPT_DIR/rule-check.sh" "$NAME" || true

  # 3. 做梦：默认走 --auto（冷却中会自动 SKIP），FORCE_DREAM=1 时强制
  if [[ "${FORCE_DREAM:-0}" == "1" ]]; then
    bash "$SCRIPT_DIR/dream.sh" "$NAME"
  else
    bash "$SCRIPT_DIR/dream.sh" --auto "$NAME"
  fi
else
  rc=$?
  # NOTE: always brace-delimit ${rc} here. A bare `$rc` immediately followed by a
  # full-width character (）， etc.) makes bash swallow part of that multibyte
  # character into the variable name and abort under `set -u`.
  echo "cycle-one: act did not land for ${NAME} (rc=${rc}) — skipping dream" >&2
  echo "  未刷新记忆的 dream 会产生并未发生的漂移，污染 /lab 数据" >&2
  exit "${rc}"
fi
