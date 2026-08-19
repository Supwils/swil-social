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

# ── Stage 5 cutover (2026-08-19) ──────────────────────────────────────────────
# The Python runtime is now the default for a full cycle. Everything below this
# block is the Bash path, kept verbatim as the rollback and as the reference
# implementation the port was verified against.
#
#   SWIL_RUNTIME=bash bash scripts/cycle-one.sh <name>   # roll back one call
#
# Rolling back for good is `git revert` of this commit: no other file changed.
#
# `--auto` is passed unless FORCE_DREAM=1, because that is what the Bash path
# below does (`dream.sh --auto`). `swil-agent cycle` defaults `--auto` OFF, so
# omitting it here would silently dream more often than Bash ever did — the one
# flag difference a cutover can get wrong without any error.
#
# The Python cycle brackets the embedder guard itself (`guard.up()` /
# `finally: guard.down()` in cli.py), so this returns before the guard block
# below rather than nesting a second ref-count around it.
#
# Known behaviour change, deliberate and recorded: spec §7.1 replaces "any
# non-zero rc denies the dream" with `ActResult.grants_dream`, so a
# rhythm-vetoed or empty-plan round now keeps its dream where the Bash path
# below skips it (see the rc contract comment further down, which argues the
# other side and cites the 2026-07-25 evidence). §7.9 records the same
# semantics reaching the F4 and fidelity series. Both change points need the
# per-account cutover date in docs/superpowers/specs/2026-08-19-stage-5-cutover.md
# to be readable later.
if [[ "${SWIL_RUNTIME:-python}" == "python" ]]; then
  # rc is captured explicitly rather than left to `set -e`, so the exit status
  # is propagated by one visible statement instead of by a shell option — the
  # three codes callers branch on (0 / 66 / 75) are the contract here.
  rc=0
  if [[ "${FORCE_DREAM:-0}" == "1" ]]; then
    uv run --project "$ROOT_DIR" swil-agent cycle "$NAME" || rc=$?
  else
    uv run --project "$ROOT_DIR" swil-agent cycle "$NAME" --auto || rc=$?
  fi
  exit "${rc}"
fi
# ── end cutover block; the Bash path follows unchanged ────────────────────────

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
