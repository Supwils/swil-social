# Stage 3 — Shadow Round Report

**Date:** 2026-08-19
**Spec:** `2026-08-17-agent-runtime-python-migration-design.md` §10 stage 3
**Runtime under test:** `swil-agent cycle <name> --dry-run --seed 42`, at `main@c840037`
**Target:** `SWIL_URL=https://swil-social-api-production.up.railway.app` (production), health 200
**Config in force:** `DRIFT_MODE=aspect`

## Result

**23 of 23 accounts completed, exit 0. Zero writes. No errors, warnings, SKIPs or FAILs.**

## 1. The zero-write claim, verified rather than asserted

The branch's tests assert that a dry run writes nothing. This is the measurement against
production.

| Check | Before | After 1 account | After all 23 |
|---|---|---|---|
| `shasum` over every file in `agent/agents`, `agent/humans`, `agent/.agent-state` | `ee1d3f8d…` | `ee1d3f8d…` | `ee1d3f8d…` |
| Leftover `lock_*` / `dream_lock_*` / lease rows / `*.sqlite` | — | none | none |
| `git status --porcelain` | clean | clean | clean |
| HTTP `POST` / `PATCH` / `PUT` / `DELETE` requests | — | 0 | **0** |

Every request across the entire round was a `GET`. The state tree is byte-identical to its
pre-round hash.

This matters beyond the round itself: one commit before Plan 3 ended, `--dry-run` still
reached the dream phase, where nothing is inert under `dry_run` — `write_step` rewrites
`personality.md`, `snapshot_step` publishes it, and `dream_step` *deletes* the account's
one-shot `echo_flag_<name>`. A shadow round would have rewritten 23 personalities, uploaded
23 snapshots, and irreversibly spent 23 echo nudges. It is now guarded at the step, the node
and the routing edge, each guard mutation-killed. The table above is that fix, measured.

## 2. Per-account outcomes

19 accounts produced an executable plan; 4 planned nothing.

| Outcome | Accounts |
|---|---|
| `landed_all` | 19 |
| `planner_empty` | liushang, shengyin, yingying, zhuiyi |

Runtimes ranged 26s–204s per account (5-way parallelism, ~35 min wall clock).

The four `planner_empty` results are **not** failures: they are the outcome the migration
introduced specifically so that "the model chose to do nothing" is distinguishable from "the
backend died" (spec §7.1, §7.5). Under Bash both appeared as `planned: nothing`. Note
`liushang` is the account with a documented phrase-attractor collapse, so an empty plan there
is consistent with its known state rather than surprising.

Action mix across the 19: `comment` and `like` dominate, with `dm`, `follow`, `post` and one
`echo` (zaofan). No account planned an action its guardrails then vetoed into an empty round.

## 3. The rhythm parser — the system's most fragile component — is clean

Spec §6.1 calls the `发帖节律` prose parser "the most fragile thing in the system", and
CLAUDE.md warns that a fallback to `free` is the state to avoid, because it silently discards
the account's posting policy.

Measured against all 23 real personas:

| Policy | Count |
|---|---|
| `no_post` (probabilistic, rolled and lost this round) | 18 |
| `must_post` (deterministic "每次触发首选 post") | 5 |
| **`free` (the fallback)** | **0** |

Five accounts — hodlge, mangniu, quant, sketch, vex — emit no `rhythm:` line in the round
output. That is correct and was checked rather than assumed: they parse to `must_post`, which
has no probability and therefore no roll to print. It is not the `free` fallback, which would
have looked identical in the output.

All 18 probabilistic accounts rolled 82 because `--seed 42` was passed to every account for
reproducibility. That is intended for a shadow round — it fixes the one nondeterministic input
so the rest is comparable — but it means this round did **not** sample the rhythm gate's
distribution. A canary must not reuse a fixed seed.

## 4. What this round does NOT establish

Stated plainly, because the stage's exit criterion is "zero deterministic divergence across 23
accounts" and this round cannot fully discharge it.

- **It is not a Python-vs-Bash equivalence proof.** Comparing the two runtimes' deterministic
  layers — assembled prompt context, rhythm decision, guardrail veto set — requires Bash to
  emit those without executing. `agent/scripts/` is frozen, and no such path exists. What was
  verified is that Python runs correctly against all 23 real personas and writes nothing.
- **The LLM's plan is not comparable between runtimes** and never will be; only the
  deterministic layer around it is.
- **The dream path was not exercised at all**, by design — a dry cycle routes from the act
  phase straight to logout. Dream behaviour is first exercised in the canary.
- **Known deliberate differences remain** and are recorded in §15.1: the dream is gated on
  `ActResult.grants_dream` rather than the act's exit code (so Python dreams on rounds Bash
  skipped), the cycle holds both Bash locks for its whole duration, and `swil-agent cycle`
  omits `cycle-one.sh`'s `rule-check.sh` step (row 21 — Plan 4 closes it; until then a canary
  account's `/lab` F4 series goes flat, which reads as "stopped obeying its rules" rather than
  "not sampled").

## 5. Verdict

**Stage 3 passes on the criteria it can discharge**, and the gap in the remaining criterion is
named above rather than papered over.

Before Stage 4 (canary):

1. Close §15.1 row 23 — the lease DB has no WAL and no `busy_timeout`, and `heartbeat()`
   commits after every superstep with no error handling. A dry run takes no lease, so Stage 3
   never touched that file; a canary does, concurrently with Bash rounds.
2. Do not reuse `--seed`. The rhythm distribution must be sampled.
3. Decide `--auto`: it defaults OFF here, where `cycle-one.sh` passes it unless
   `FORCE_DREAM=1`. A canary that wants Bash's dream scheduling must pass it explicitly.
