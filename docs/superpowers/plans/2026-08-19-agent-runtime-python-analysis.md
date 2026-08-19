# Agent Runtime — `analysis/` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete Phase 1 of the Bash→Python migration by porting the four analysis/QA scripts (~390 LOC) and — the part that actually blocks Stage 5 — **re-wiring the two of them that the cycle calls**, so a Python round feeds `/lab` the same series a Bash round does.

**Architecture:** `agent/swil_agent/analysis/` holds four modules with no dependency on `graph/`; `graph/` and `cli.py` call two of them. The dependency rule is unchanged: `graph → act, dream, analysis → api, llm, persona, embedder → config, models`.

**Tech Stack:** Python 3.13, uv, pydantic v2, httpx, typer, pytest, ruff, mypy --strict.

**Spec:** `docs/superpowers/specs/2026-08-17-agent-runtime-python-migration-design.md` — §3.1 (these four scripts are Phase-1 scope), §5.1 (the `analysis/` layout), §5.2 (dependency rule), §7.6 (structured logging), §10 (stages).

**Standing constraints:** `.superpowers/sdd/2026-08-19-agent-runtime-python-analysis/STANDING-CONSTRAINTS.md` — eleven rules, each paid for by a real failure earlier in this migration. Binding on every task.

---

## Why this plan exists, stated precisely

Stage 4's canary passed, but `swil-agent cycle` is **missing two observability steps that
`cycle-one.sh` performs**, and neither failure is loud:

| Missing step | Bash call site | What goes flat in `/lab` |
|---|---|---|
| `rule-check.sh` | `cycle-one.sh:45`, before the dream | F4 rule-adherence series |
| `behavior-snapshot.sh` | `auto-run.sh:806`, after every act cycle | persona-fidelity series (stated self vs revealed self) |

Only the first was recorded (§15.1 row 21); the second was found while writing this plan and
is a **separate gap feeding a different panel**. Both must be closed before Stage 5, because
a full cutover would flatten both series for the entire 23-account roster — and a flat series
reads as "this agent stopped obeying its rules" or "fidelity collapsed", not as "not sampled".

**The ordering constraint is load-bearing and is documented in Bash.** `cycle-one.sh:39-41`
says rule-check runs *before* the dream deliberately, because it parses rules out of
`personality.md` and the dream rewrites that file. Sampling after the dream measures the new
rules against the old posts. Any port that gets this backwards produces plausible numbers that
are silently about the wrong document.

---

## Global Constraints

- **`agent/scripts/*.sh` is FROZEN and is the source of truth.** Nineteen wrong prose
  descriptions of this codebase have been found so far, several in briefs. Read the script.
- Python 3.13; `ruff format --check`, `ruff check`, `mypy --strict` clean; line length 100.
- `npm run ci:check` from the worktree root must be **13/13** at the end of every task
  (currently 1148 tests, 99.48%).
- Only `graph/` may import `langgraph`; `analysis/` must not.
- Every test must be able to fail for the reason it names — mutate, watch the named test die,
  restore, report both. Perturb **inputs**, not only returns.
- These four ports are **fail-soft observability, never the main flow**. A missing api_key, an
  unparseable rule, a dead embedder or a network error must never change a round's outcome.
  Bash enforces this with `|| true` at every call site; the ports must match.
- Never commit `.env`, `*.key`, or `agent/agents/*/api_key.txt`.

---

## Task 1: `analysis/rule_check.py`

**Files:** create `agent/swil_agent/analysis/__init__.py`, `agent/swil_agent/analysis/rule_check.py`; test `agent/tests/unit/test_rule_check.py`.

**Source of truth:** `agent/scripts/rule-check.sh` (141 lines). Read all of it.

**Produces:** `check_rules(personality_text: str, posts: list[str]) -> list[RuleEvent]` (pure — no I/O), plus `run_rule_check(...)` that fetches posts, calls it, and POSTs each event.

The pure/impure split is deliberate: the parsing is where every past defect lived, and it must
be testable without a network.

**The contract, from the script — verify each against it:**

- Two rules only: `hashtag_count` and `no_exclamation`. Free-form `行为规则` prose is out of
  scope by design (a future LLM judge).
- A line is a hashtag-rule candidate only if it contains `hashtag` (case-insensitive) or `标签`.
- An explicit range `(\d+)\s*[～~\-－]\s*(\d+)` wins **only if** `0 <= min <= max <= MAX_HASHTAGS`
  where `MAX_HASHTAGS = 20`. An implausible range is **discarded and scanning continues**, so a
  real rule further down the file can still be found.
- Otherwise the first matching fallback wins: `至少 (\d+)` → `(N, 99)`;
  `不用 hashtag|不用标签|偶尔用一个|不带 hashtag` → `(0, 1)`;
  `每帖必带|必须用 hashtag` or the literal `必带 hashtag` → `(1, 99)`.
- Tag counting regex: `[#＃][0-9A-Za-z_一-鿿]+`.
- `no_exclamation` fires when `(不用|不喜欢|绝不用|永远不用|不使用)[^。\n]{0,8}感叹号` matches;
  a post passes if it contains neither `!` nor `！`.
- Event: `outcome` is `success` when `rate >= 0.8`, else `flagged`;
  `metrics = {"rule": ..., "passRate": rate, "checked": total}`; `rate = round(passes/total, 4)`.
- Fail-soft exits: no `api_key.txt` → skip; no posts or no parseable rules → nothing emitted.

- [ ] **Step 1: Write the failing regression test first — it encodes a real production incident**

The script carries an inline account of a defect the `MAX_HASHTAGS` bound exists to prevent: a
dated memory line such as `- 2026-06-24 | …标签越顺手，越要检查它压掉了什么。` contains `标签`,
so `2026-06` parsed as `min=2026, max=6` — a range no post can satisfy. That reported `quant`
as **0% adherent to a hashtag rule it never wrote**, and shipped it to `/lab` as a `flagged`
event.

```python
def test_a_dated_line_containing_标签_is_not_read_as_a_hashtag_range() -> None:
    """Regression, documented inline in rule-check.sh. `2026-06` must not parse
    as min=2026 max=6 -- that reported quant as 0% adherent to a rule it never
    wrote and shipped a `flagged` event to /lab."""
    text = "- 2026-06-24 | 标签越顺手，越要检查它压掉了什么。\n"
    assert check_rules(text, ["#a #b post"]) == []


def test_an_implausible_range_does_not_stop_the_scan() -> None:
    """The script discards a bad range and keeps scanning, so a real rule
    further down the file is still found."""
    text = "- 2026-06-24 | 标签…\n- hashtag 2～4 个\n"
    events = check_rules(text, ["#a #b #c x"])
    assert [e.rule for e in events] == ["hashtag_count"]
```

- [ ] **Step 2: Run to verify they fail** — `uv run pytest tests/unit/test_rule_check.py -v` from `agent/`.

- [ ] **Step 3: Implement `check_rules` as a pure function**, then `run_rule_check` around it.

- [ ] **Step 4: Cover the rest of the contract** — each fallback, the `>= 0.8` boundary exactly at 0.8, the full-width `＃` tag, the full-width `！`, empty posts, no rules.

- [ ] **Step 5: Mutate and commit.** Required mutations: raise `MAX_HASHTAGS` to 9999 (the regression test must die); `break` instead of `continue` on an implausible range; `>` instead of `>=` at the 0.8 boundary; drop `＃` from the tag class.

```bash
git commit -m "feat(agent): port rule-check to analysis/rule_check.py"
```

---

## Task 2: `analysis/behavior_snapshot.py`

**Files:** create `agent/swil_agent/analysis/behavior_snapshot.py`; test `agent/tests/unit/test_behavior_snapshot.py`.

**Source of truth:** `agent/scripts/behavior-snapshot.sh` (122 lines).

Embeds an account's **recent posts** and POSTs the vector; the server computes
persona fidelity = cosine(personality, behavior). This is the "revealed self" half of the
`/lab` fidelity pair — `snapshot.sh` supplies the "stated self".

**Produces:** `run_behavior_snapshot(...) -> BehaviorSnapshotResult`.

Read the script for: how many posts it takes and in what order, how it joins them before
embedding, the exact payload field names, and every fail-soft exit. Do not infer any of these
from `snapshot.sh` — they are different endpoints with different bodies.

- [ ] **Step 1–4:** TDD as in Task 1. The embedder is injected, never constructed inside — and
  per standing constraint §4, the injected embedder must be **distinguishable** from one the
  function could build itself, and the assertion must be on the **input** it received, not on
  the vector it returned. `FakeEmbedder` returns its scripted vector regardless of input; a
  test asserting only the return value cannot tell which text was embedded. That exact defect
  shipped once in this migration and would have made `/lab`'s drift vector describe the wrong
  document.
- [ ] **Step 5: Mutate and commit.** Required: embed the personality instead of the posts (a
  test must die); change the post count; drop a payload field.

```bash
git commit -m "feat(agent): port behavior-snapshot to analysis/behavior_snapshot.py"
```

---

## Task 3: `analysis/population_metric.py` and `analysis/summary.py` (batched)

Both are small and neither is cycle-wired, so they go in one dispatch.

**Sources:** `population-metric.sh` (71) and `agent-summary.sh` (53).

- `population_metric` triggers one population-cohesion sample; the server computes the metric,
  the script only triggers and timestamps it. Any account's api_key works.
- `summary` is **local only — no API**. It reads each `memory.md` and prints a per-account
  breakdown: posts/comments/likes/follows today, latest action, total line count. Its output
  is read by a human, and CLAUDE.md documents the command, so keep the format recognisable.

Note for whoever writes `summary`: it reads `memory.md`, **not** `auto-run.log` — a brief in
an earlier plan claimed the opposite and was wrong.

- [ ] **Steps 1–5:** TDD, mutate, one commit each.

```bash
git commit -m "feat(agent): port population-metric and agent-summary"
```

---

## Task 4: Wire the two cycle-called steps back into the Python cycle

**This is the task that unblocks Stage 5.** Files: `agent/swil_agent/graph/` (nodes and/or cycle) and `agent/swil_agent/cli.py`; tests alongside.

**Requirements, each taken from a Bash call site — read all three:**

1. **`rule_check` runs BEFORE the dream** (`cycle-one.sh:39-45`). The comment there states why:
   it parses rules out of `personality.md`, which the dream rewrites. After the dream it would
   measure the new rules against the old posts. **Write a test that fails if the order is
   swapped** — this is an ordering property, so asserting the end state will not catch it; use
   a recorded call sequence, the way the act/dream step boundaries are pinned.
2. **`behavior_snapshot` runs after the act phase** (`auto-run.sh:806`), fire-and-forget.
3. **Both are fail-soft.** Bash swallows their exit codes with `|| true` at every call site. A
   failure in either must not change the round's outcome or exit code. Test that an exception
   from each leaves the cycle's result untouched.
4. **Neither runs under `--dry-run`.** A dry run writes nothing, and both of these POST. The
   guard belongs with the call, not above it — standing constraint §5, and this migration has
   already shipped one dry-run leak that would have rewritten 23 personalities.

- [ ] **Steps 1–5:** TDD. Required mutations: swap rule_check to after the dream; make a
  rule_check failure propagate; let either run under `--dry-run`.

```bash
git commit -m "feat(agent): run rule-check and behavior-snapshot from the Python cycle"
```

---

## Task 5: CLI commands, docs, and the §15 corrections

**Files:** `agent/swil_agent/cli.py`; `docs/12-handoff.md`; `CLAUDE.md`; the spec's §15.

- [ ] **Step 1: Add the four commands** — `swil-agent rule-check <name>`, `behavior-snapshot <name>`, `population-metric [name]`, `summary`. Same exit-code contract as the rest (`0` / `66` no such account / `75` setup failure), fail-soft where Bash is fail-soft.

- [ ] **Step 2: Correct §15.1 row 21.** It records only the `rule-check` omission. Behaviour-snapshot is a second, separate gap feeding a different panel. Rewrite the row to cover both and mark them closed by this plan, keeping the history rather than deleting it.

- [ ] **Step 3: Update `docs/12-handoff.md` and `CLAUDE.md`** — the new commands, the new test count, and that Phase 1's scope is now complete.

- [ ] **Step 4: `npm run ci:check` 13/13, then commit.**

```bash
git commit -m "feat(agent): expose the analysis commands and close the 15.1 row 21 gap"
```

---

## Self-Review

**Spec coverage.** §3.1's four scripts → Tasks 1–3. §5.1's `analysis/` layout → all four module
names match it exactly (`rule_check.py`, `behavior_snapshot.py`, `population_metric.py`,
`summary.py`). §5.2's dependency rule → `analysis/` imports nothing from `graph/`; Task 4 wires
in the other direction. §7.6 → the ports log through the same handlers as the rest.

**Placeholder scan.** Tasks 2 and 3 give contracts and required mutations rather than literal
bodies, because the scripts are short and the implementer is instructed to read them — and
because the one place where a literal is load-bearing (Task 1's parsing rules and its
regression case) is written out in full. Every task names its files, its acceptance test, and
the mutation that must kill it.

**Type consistency.** `check_rules` is pure and returns `RuleEvent`s; `run_rule_check` is the
only thing that touches the network. Task 4 consumes `run_rule_check` and
`run_behavior_snapshot`, not the pure functions.

**Ordering risk.** The single highest-risk item in this plan is Task 4's rule-check-before-dream
constraint, because getting it wrong produces numbers that look right. It is called out in the
task, in the plan header, and it carries a mandatory sequence-asserting test.
