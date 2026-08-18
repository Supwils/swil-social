#!/usr/bin/env bash
# Pure-function tests for the plan pipeline. No network, no LLM, no state.
#
# Run: bash agent/scripts/tests/plan.test.sh
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# auto-run.sh defines its helpers and stops when SOURCE_ONLY=1.
SOURCE_ONLY=1 . "$SCRIPT_DIR/auto-run.sh"

pass=0
fail=0
check() {
  local name="$1" want="$2" got="$3"
  if [[ "$got" == "$want" ]]; then
    pass=$((pass + 1))
    echo "  ok   $name"
  else
    fail=$((fail + 1))
    echo "  FAIL $name"
    echo "       want: $want"
    echo "       got:  $got"
  fi
}

echo "normalize_plan:"
check "plan array" '2' \
  "$(normalize_plan '{"plan":[{"action":"post","text":"a"},{"action":"like","postId":"x"}]}' | jq 'length')"
check "bare single object" '1' \
  "$(normalize_plan '{"action":"like","postId":"x"}' | jq 'length')"
check "top-level array" '1' \
  "$(normalize_plan '[{"action":"post","text":"a"}]' | jq 'length')"
check "concatenated docs" '2' \
  "$(normalize_plan '{"action":"post","text":"a"}{"action":"like","postId":"x"}' | jq 'length')"
check "garbage" '0' "$(normalize_plan 'not json at all' | jq 'length')"
check "empty plan" '0' "$(normalize_plan '{"plan":[]}' | jq 'length')"
check "drops entries with no action" '1' \
  "$(normalize_plan '{"plan":[{"action":"like","postId":"x"},{"text":"orphan"}]}' | jq 'length')"

echo
echo "apply_plan_guardrails:"
CONTACTS=$'xianying\nzenith'

check "budget truncates to 5" '5' \
  "$(apply_plan_guardrails '[{"action":"like","postId":"1"},{"action":"like","postId":"2"},{"action":"like","postId":"3"},{"action":"like","postId":"4"},{"action":"like","postId":"5"},{"action":"like","postId":"6"}]' free 5 "$CONTACTS" | jq 'length')"

check "at most one post" '1' \
  "$(apply_plan_guardrails '[{"action":"post","text":"a"},{"action":"post","text":"b"}]' free 5 "$CONTACTS" | jq '[.[]|select(.action=="post")]|length')"

check "at most one echo" '1' \
  "$(apply_plan_guardrails '[{"action":"echo","postId":"1"},{"action":"echo","postId":"2"}]' free 5 "$CONTACTS" | jq '[.[]|select(.action=="echo")]|length')"

check "post and echo coexist" '2' \
  "$(apply_plan_guardrails '[{"action":"post","text":"a"},{"action":"echo","postId":"1"}]' free 5 "$CONTACTS" | jq 'length')"

check "no_post strips posts" '0' \
  "$(apply_plan_guardrails '[{"action":"post","text":"a"},{"action":"like","postId":"1"}]' no_post 5 "$CONTACTS" | jq '[.[]|select(.action=="post")]|length')"

check "no_post keeps the rest" '1' \
  "$(apply_plan_guardrails '[{"action":"post","text":"a"},{"action":"like","postId":"1"}]' no_post 5 "$CONTACTS" | jq 'length')"

check "off-list dm dropped" '0' \
  "$(apply_plan_guardrails '[{"action":"dm","username":"stranger","text":"hi"}]' free 5 "$CONTACTS" | jq 'length')"

check "on-list dm kept" '1' \
  "$(apply_plan_guardrails '[{"action":"dm","username":"xianying","text":"hi"}]' free 5 "$CONTACTS" | jq 'length')"

check "nothing dropped when mixed" '1' \
  "$(apply_plan_guardrails '[{"action":"nothing"},{"action":"like","postId":"1"}]' free 5 "$CONTACTS" | jq 'length')"

check "nothing survives alone" '1' \
  "$(apply_plan_guardrails '[{"action":"nothing"}]' free 5 "$CONTACTS" | jq 'length')"

check "same postId same verb deduped" '1' \
  "$(apply_plan_guardrails '[{"action":"like","postId":"1"},{"action":"like","postId":"1"}]' free 5 "$CONTACTS" | jq 'length')"

check "same postId different verb kept" '2' \
  "$(apply_plan_guardrails '[{"action":"like","postId":"1"},{"action":"comment","postId":"1","text":"x"}]' free 5 "$CONTACTS" | jq 'length')"

check "codex allow-list strips interactions" '1' \
  "$(apply_plan_guardrails '[{"action":"post","text":"a"},{"action":"like","postId":"1"},{"action":"comment","postId":"2","text":"x"}]' free 5 "$CONTACTS" "post,nothing" | jq 'length')"

check "codex allow-list keeps the post" 'post' \
  "$(apply_plan_guardrails '[{"action":"like","postId":"1"},{"action":"post","text":"a"}]' free 5 "$CONTACTS" "post,nothing" | jq -r '.[0].action')"

check "empty allow-list means everything" '3' \
  "$(apply_plan_guardrails '[{"action":"post","text":"a"},{"action":"like","postId":"1"},{"action":"comment","postId":"2","text":"x"}]' free 5 "$CONTACTS" "" | jq 'length')"

check "empty plan stays empty" '0' \
  "$(apply_plan_guardrails '[]' free 5 "$CONTACTS" | jq 'length')"

echo
echo "passed=$pass failed=$fail"
[[ "$fail" -eq 0 ]]
