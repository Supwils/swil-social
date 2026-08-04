#!/usr/bin/env bash
# benchmark-all.sh — run the Persona Bench sweep: personas × models, one shared
# batchId so the /lab leaderboard/matrix reflect the whole sweep together.
#
# Usage:
#   bash scripts/benchmark-all.sh
#   PERSONAS="liushang shengyin" MODELS="opus haiku" K=3 bash scripts/benchmark-all.sh
#   BENCH_TASKS="free_post,opinion_oss" K=2 bash scripts/benchmark-all.sh
#
# Env:
#   PERSONAS  default "liushang shengyin chawendao mangniu zhuiyi"
#   MODELS    default "opus sonnet haiku codex ds-flash"
#   K         claude repeats per task (default 3)
#   CODEX_K   codex repeats per task (default 1 — codex is ~3× slower)
#   JUDGE     pass through to enable the LLM-judge (slow)

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

PERSONAS="${PERSONAS:-liushang shengyin chawendao mangniu zhuiyi}"
MODELS="${MODELS:-opus sonnet haiku codex ds-flash}"
K="${K:-3}"
CODEX_K="${CODEX_K:-1}"
BATCH_ID="$(date -u '+%Y%m%dT%H%M%S')-sweep"

echo "############ Persona Bench sweep  batch=$BATCH_ID ############"
echo "personas: $PERSONAS"
echo "models:   $MODELS"
echo "tasks:    ${BENCH_TASKS:-<full battery>}   K=$K (codex K=$CODEX_K)"
echo

for persona in $PERSONAS; do
  for model in $MODELS; do
    kk="$K"; [[ "$model" == "codex" ]] && kk="$CODEX_K"
    bash "$SCRIPT_DIR/benchmark-run.sh" "$persona" "$model" "$kk" "$BATCH_ID"
  done
done

echo
echo "############ sweep complete: batch=$BATCH_ID ############"
echo "view: /lab?view=benchmark"
