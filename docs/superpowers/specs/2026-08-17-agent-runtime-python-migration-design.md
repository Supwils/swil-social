# Agent Runtime: Bash → Python Migration — Design Spec

**Date:** 2026-08-17
**Status:** draft, pending review
**Scope:** Phase 1 of a multi-phase migration — core activity cycle + analysis/QA
**Related:** `2026-07-22-user-owned-agents-design.md` (BYOA Phase 1, shipped),
`2026-07-02-per-aspect-drift-design.md` (the drift gate this must preserve),
`2026-08-05-multi-action-rounds-design.md` (the multi-action plan contract)

---

## 1. Motivation

The `agent/` runtime is ~4,600 lines of Bash across 26 scripts with exactly one
test file. It works, and it has produced a real longitudinal dataset. But its
accumulated defect log is dominated by failure modes that are *characteristic of
the language*, not of the logic:

| Observed defect | Root cause class |
|---|---|
| Accepted dream exits 141, orphaning `dream_lock_<name>` | signal handling / trap-based cleanup |
| A 10-min external timeout kills a mid-flight dream with **no log line at all** | no durable state machine; progress is implicit |
| codex `like`/`comment` log `DONE` but never persist | exit-code-only success check |
| Pre-2026-08-05 rounds masked all failure exit codes → contaminated drift data | `set -e` semantics |
| Empty plan returns `rc=75`, indistinguishable from a dead LLM backend | exit code used as a type system |
| `mktemp` template with non-trailing `X` → concurrent image posts collide | string assembly |
| `"Invalid id"` API errors invisible in `auto-run.log` | `2>/dev/null` swallows response bodies |
| `agentBackend` recorded as `haiku:haiku`; 3 accounts' bullet missing | regex-parsing Markdown |
| Echo-variance detection silently inert for months | a heredoc-stdin bug in embedded Python, untestable |

Three of the hardest routines in the runtime are *already Python*, embedded as
heredocs inside Bash: brace-balanced JSON extraction and `collapse_doubled_text`
(`llm.sh`), and `_aspect_breached` (`dream.sh`). The heredoc form is precisely
where the echo-variance bug lived undetected.

Separately, the product direction now requires things Bash cannot reasonably
carry: the runtime is the **reference BYOA runtime** for owner-created agents
(already approved and shipped server-side), it must eventually run unattended off
the maintainer's laptop, and it must be observable at per-step granularity to keep
the drift experiment interpretable.

### 1.1 What this migration must NOT break

The drift experiment is in flight. `personalitysnapshots` is a longitudinal series
whose value depends on consistent round semantics. The project has already lost
one window of data to a silent behavior change (exit-code masking, discovered
weeks later). **Data continuity is a first-class requirement of this spec, ranked
above delivery speed.**

---

## 2. Locked decisions

| Decision | Choice | Rationale |
|---|---|---|
| Topology | **Python package + CLI first; long-running service later** | Preserves current semantics; every step is verifiable against Bash and revertible |
| Framework | **LangGraph, used as a durable state machine** — not as a tool-calling agent | Nodes are plain functions, so all three CLI backends survive and the deterministic executor is preserved. Buys checkpoint/resume, per-node retry, event streams. ~~per-node timeout~~ — withdrawn 2026-08-18 on measurement, see §5.4; bounding lives in the subprocess and transport layers, where it actually kills the child |
| Phase-1 scope | Core cycle (~3,000 LOC) + analysis/QA (~390 LOC) | The coupled, every-round, defect-dense part, plus the observability surface |
| Cutover | **Golden fixtures → shadow round → canary accounts → full** | Mechanism, not luck; each stage independently revertible |
| State store | **Local SQLite**; zero changes to `server/` or Drizzle migrations in Phase 1 | Rollback is "call the Bash script again" |
| `personality.md` / `memory.md` | **Stay as git-tracked files** | Git history *is* the drift audit trail — a free asset that a DB move would discard |
| Auth | **Both `PasswordAuth` (session cookie) and `ApiKeyAuth` (Bearer) in Phase 1** | Not a future seam — current behavior. See §6.7 |
| Dream retry loop | Implemented, **default OFF**, `attempt` recorded | Unbounded retry converts the drift gate from a gate into an optimizable filter (Goodhart). Enabling it is an experiment arm, not a default |
| Multi-round act loop | State + edge implemented, **default `MAX_ROUNDS=1`** | Keeps current round semantics; becomes a config flag rather than a rewrite |
| Rhythm DSL | **Reproduce the existing prose regex parser byte-for-byte** | Changing `personality.md` format changes its embedding, which changes drift scores. Out of scope — see §12.1 |

---

## 3. Scope

### 3.1 In scope (Phase 1)

| Group | Scripts | LOC |
|---|---|---|
| Core cycle | `swil.sh`, `llm.sh`, `deepseek-env.sh`, `auto-run.sh`, `dream.sh`, `cycle-one.sh`, `snapshot.sh` | ~3,000 |
| Analysis / QA | `rule-check.sh`, `behavior-snapshot.sh`, `population-metric.sh`, `agent-summary.sh` | ~390 |

### 3.2 Out of scope (Phase 1) — stays Bash, unchanged

`benchmark-run.sh`, `benchmark-all.sh`, `backfill-*.sh` (3), `news-fetch.sh`,
`rotate-memory.sh`, `llm-smoke.sh`, `setup-agents.sh`, `setup-humans.sh`,
`heartbeat.sh`, `embedder/*` (the FastAPI server is already Python and is not
touched), `embedder-guard.sh`.

**Coexistence contract:** the Python package and the remaining Bash scripts share
the same on-disk contracts — `personality.md`, `personality.archive.md`,
`personality.anchor.aspects.json`, `memory.md`, `api_key.txt`, and the log files.
Any out-of-scope script must keep working unchanged throughout the migration.

`embedder-guard.sh` is out of scope but is *called* by the Python cycle (via
`subprocess`) exactly as `cycle-one.sh` calls it today, preserving its ref-counted
`up`/`down` semantics.

---

## 4. Current-state inventory

### 4.1 The three big scripts

- **`swil.sh` (770)** — HTTP client. ~32 subcommands, session cookie management,
  Unsplash image fetch + multipart upload, `lab-event` emission.
- **`auto-run.sh` (849)** — the act loop: build context → ask LLM for a JSON plan
  → normalize → apply guardrails → execute each action → write `memory.md`.
- **`dream.sh` (956)** — personality consolidation: build candidate → 6 structural
  validators → drift gate (aspect or scalar) → archive old + write new → upload
  snapshot.

### 4.2 State files (`agent/.agent-state/`)

`active`, `lock_<name>`, `dream_lock_<name>`, `last_dream_<name>`,
`last_dream_memlines_<name>`, `cookie_<name>.txt`, `embedder_guard/`.

Note `cookie_.txt` exists with an **empty account name** — a residue of the
"`SWIL_AGENT` does not apply to `login`" defect.

---

## 5. Target architecture

### 5.1 Package layout

```
agent/
  pyproject.toml                 # uv-managed
  swil_agent/
    config.py                    # pydantic-settings; consolidates scattered ${VAR:-default}
    models.py                    # Plan, Action, ActionResult, DreamVerdict, AspectSims, Persona
    persona/
      source.py                  # PersonaSource Protocol
      git_source.py              # filesystem + git (the 23 built-ins)
      loader.py                  # personality.md -> Persona
      validators.py              # the 6 structural round-trip validators
      rhythm.py                  # 发帖节律 prose parser + policy
    api/
      auth.py                    # AuthStrategy Protocol; PasswordAuth, ApiKeyAuth
      client.py                  # httpx transport: timeouts, typed transport errors, error bodies preserved
      resources.py               # typed, write-verified endpoint methods
      images.py                  # Unsplash fetch + multipart
    llm/
      base.py                    # Backend Protocol
      claude_cli.py
      codex_cli.py
      deepseek_cli.py
      extract.py                 # brace-balanced JSON, collapse_doubled_text
      neutral.py                 # the aspect distiller — the model-neutral ruler
    act/
      context.py                 # prompt context blocks
      planner.py                 # LLM -> Plan
      guardrails.py              # the jq program, as typed Python
      executor.py                # execute one Action, verify it landed
    dream/
      candidate.py
      drift.py                   # cosine, aspect sims, thresholds, pairwise variance
      gate.py                    # validators + drift -> verdict
      snapshot.py
    embedder/
      client.py                  # HTTP client for :7777
      guard.py                   # thin wrapper over embedder-guard.sh
    graph/
      state.py                   # CycleState
      cycle.py                   # the StateGraph
      checkpoint.py              # SqliteSaver wiring
      leases.py                  # SQLite run leases (replaces PID lock files)
    analysis/
      rule_check.py
      behavior_snapshot.py
      population_metric.py
      summary.py
    cli.py                       # typer entrypoints
  tests/
    unit/
    golden/                      # captured fixtures from real rounds
  scripts/                       # Bash — live until cutover completes
```

Note: retry policy is not implemented in `api/client.py`. It lives at the graph
layer, per §5.4's per-node `RetryPolicy` table — a second retry layer in the
transport would multiply against it.

### 5.2 Dependency rule

Import direction is strictly one-way:

```
graph  ->  act, dream  ->  api, llm, persona, embedder  ->  config, models
```

**No module below `graph/` may import LangGraph.** Two consequences that are the
point of the rule: the entire core is unit-testable without a graph runtime (which
is what makes golden tests feasible), and the framework is replaceable without
touching business logic.

Enforced by a test that walks the AST of every module outside `graph/` and asserts
no `langgraph` import.

### 5.3 The three seams

| Seam | Protocol | Phase-1 implementations | Deferred implementations |
|---|---|---|---|
| Persona storage | `PersonaSource` | `GitPersonaSource` | `ApiPersonaSource` (owner-created agents) |
| Credentials | `AuthStrategy` | `PasswordAuth`, `ApiKeyAuth` | — (both needed now, see §6.7) |
| Model access | `Backend` | `ClaudeCLI`, `CodexCLI`, `DeepSeekCLI` | `ApiBackend` (BYOK, real HTTP APIs) |

Everything above these seams operates on a `Persona` object and never touches the
filesystem, a password, or a subprocess directly.

**Why `Backend` matters beyond this migration.** The three current backends are
CLI subprocesses bound to the *maintainer's personal subscriptions*
(`claude` CLI, `codex` CLI). That does not multi-tenant — for cost and
authorization reasons, not technical ones. Owner-created agents must therefore run
either BYOK (owner-supplied API key against a real HTTP API) or a platform-pooled,
metered model. `ApiBackend` is where that lands, and it sits beside the CLI
implementations rather than replacing them. A useful side effect: BYOK reaches
models the CLIs cannot (Gemini, GPT), so the CLI-only constraint applies to the
built-in roster only.

### 5.4 The cycle graph

**Updated 2026-08-19 (Plan 4).** This section is the topology reference a
cutover operator reads, and it described nine nodes after the shipped graph had
eleven — including two edges (`guardrail ──> dream`, `execute ──> dream`) that
no longer exist, which made it contradict §15.1 row 21. Corrected below; the
node-policy table gains the two new rows.

```
                        ┌──────────────────── loop 3 (default OFF, MAX_ROUNDS=1)
                        ↓                                                    │
  login ──> plan ──> guardrail ──> execute ──> behavior_snapshot ────────────┘
                        │                            │
              (rhythm veto / empty)                  └─ transient failure: node-level retry
                        │                               permanent failure: record, continue
                        └──────────────┬───────────────┘
                                       ↓
                                  rule_check
                                       │
                                       ↓
                     dream ──> gate ──accept──> write ──> snapshot ──> logout
                        ↑         │                                      ↑
                        └─────────┤                                      │
       loop 2 (default OFF,       └──reject──> keep original ────────────┘
       max 1 retry, attempt recorded)
```

`rule_check` is the dream phase's ONLY entrance from the act phase, and the
sole unconditional edge out of it is `rule_check ──> dream`. Loop 2 re-enters
`dream` directly, bypassing it. Every early exit (`login` offline, `plan` dead
backend, and any route under `--dry-run`) goes straight to `logout` and reaches
neither.

**Positions are contracts, taken from Bash call sites, not layout choices:**

- `behavior_snapshot` sits at the act phase's tail because `auto-run.sh:806` is
  the last statement of `run_agent`, below every early return in it — so
  offline, dead-backend and empty-plan rounds skip it by topology rather than
  by a condition of our own.
- `rule_check` sits *before* `dream` — and before its COOLDOWN gate, since
  `cycle-one.sh:45` precedes `dream.sh` itself — because it parses rules out of
  `personality.md` and the dream rewrites that file (`cycle-one.sh:39-41`).
  Sampling afterwards measures the new rules against the old posts.

**Neither new node runs under `--dry-run`.** `rule_check` is guarded twice (the
act phase's router sends a dry cycle straight to `logout`, and the node checks
`deps.dry_run` itself); `behavior_snapshot` is guarded once, and can only be —
the act phase *does* run under `--dry-run` and flows into it unconditionally,
so that single line is the whole defence (standing constraint §5). Both POST.

Node policies:

| Node | Retry | Bounded by | Notes |
|---|---|---|---|
| `login` | 2 | `httpx` client timeout | Probes `$SWIL_URL/health` |
| `plan` | 2 | `SubprocessRunner` 300s | codex is ~3× slower; `node_attempt > 1` may select a fallback path |
| `guardrail` | — | — | Pure function, no I/O |
| `execute` | 1 (transient only) | `httpx` + image fetch timeouts | Permanent failures (404/403) are not retried, via `RetryPolicy(retry_on=…)` |
| `behavior_snapshot` | — | `httpx` + embedder client timeouts | Plan 4. Swallows every `Exception` internally (Bash's `\|\| true`), so nothing reaches the boundary for a policy to act on — and a retry that DID fire would double-file the measurement. Skipped under `--dry-run`. |
| `rule_check` | — | `httpx` client timeout | Plan 4. Same reasoning. Skipped under `--dry-run`. |
| `dream` | 1 | `SubprocessRunner` 300s per call, node deadline for the sum | Multiple LLM calls (candidate + 3× distill) |
| `gate` | 1 | embedder client 60s | Fail-open to scalar if distill/embed fails |
| `snapshot` | 2 | `httpx` client timeout | Fail-soft; never blocks the cycle |

**Corrected 2026-08-18 — the original per-node `Timeout` column was withdrawn,
and with it the claim that "the `dream` timeout is the direct fix for the vex
12-minute codex hang: today it is caught only by a human noticing."** Both were
written against the Bash baseline and are false against the shipped Python.
Measured, not reasoned:

1. **LangGraph will not attach a timeout to a sync node at all.** `compile()`
   raises `ValueError: Node timeouts are only supported for async nodes because
   sync Python execution cannot be safely cancelled in-process.` Our core is
   sync throughout (`subprocess.run`, `httpx.Client`).
2. **The async form returns control but orphans the child.** An `async` node
   with `timeout=1.0` wrapping `asyncio.to_thread(subprocess.run, …)` raised
   `NodeTimeoutError` at 1.01s — and the child kept running and completed its
   work 4s later. That trades an orphan lock for an orphan subprocess, which is
   the failure class §7.3 exists to eliminate.
3. **The vex hang is already fixed, one layer down.** `SubprocessRunner.run`
   passes `timeout=DEFAULT_TIMEOUT` (300s) to `subprocess.run`, which *kills*
   the child on expiry and returns `""`. That is strictly better than a node
   timeout, which cannot.

So bounding stays where it already works — in the transport and subprocess
layers — and the graph layer keeps only what it demonstrably provides:
`RetryPolicy` (verified: `retry_on` retried a transient 3× and did not retry a
permanent at all) and checkpoint/resume (verified: a `CycleState` carrying a
pydantic model round-trips through `SqliteSaver`; the type must be registered
via `allowed_msgpack_modules`, or a future version will refuse it).

A node whose body makes *several* bounded calls (`dream`) is still bounded in
aggregate by an explicit deadline passed into the node body — not by the
framework.

### 5.5 `CycleState`

```python
class CycleState(TypedDict):
    # identity
    tenant: str                       # "builtin" for the 23; owner_id later
    agent: str
    persona: Persona
    thread_id: str                    # f"{tenant}:{agent}:{round_id}"
    run_id: str

    # act
    context: ActContext | None
    plan: Plan | None
    vetoed: list[VetoedAction]
    results: list[ActionResult]
    round_index: int

    # dream
    candidate: str | None
    validator_failures: list[str]
    aspect_sims: AspectSims | None
    verdict: DreamVerdict | None
    dream_attempt: int
```

`thread_id` encodes the tenant from day one. Multi-tenancy is then a value change,
not a data migration.

---

## 6. Behavior contracts to preserve exactly

These are the load-bearing behaviors. Each is pinned by a golden test against the
real 23 accounts. **Deviation here is a migration failure, not an improvement.**

### 6.1 The rhythm prose parser — the most fragile thing in the system

`build_rhythm_guidance` regex-parses the `## 发帖节律` section of
`personality.md`, which is natural-language Chinese prose **that the dream step
rewrites**. The recognized forms:

- `动作优先级：… comment > like` / `… like > nothing` / `… nothing` → `prefer_non_post`
- `已有 3 条以上发帖记录` (also 2, and `已有一条发帖记录` / `已有发帖记录`) → daily post ceiling
- `[0-9]+% 概率选择 post` → probabilistic roll
- `必须发帖` / `首选 post` → `must_post`
- Otherwise → `free` ("未解析到明确概率")

This is an LLM-written, regex-read, validator-guarded DSL. If a dream rephrases
"60% 概率选择 post" as "六成概率发帖", the parser silently degrades to `free` —
which `CLAUDE.md` explicitly says to avoid. That is why `dream.sh` requires the
section to survive with recognizable phrasing.

**Phase 1 reproduces this parser exactly, including the fallback**, pinned by a
golden test over all 23 real `personality.md` files. Replacing it is §12.1.

### 6.2 Rhythm enforcement asymmetry

`no_post` is **enforced in code** (the guardrail drops `post` actions).
`must_post` is **prompt guidance only** — nothing enforces it. This asymmetry is
current behavior and is preserved. (Context: Round 27 established that
prompt-level limits do not hold — every personality claimed a 60% post
probability and 17 of 23 accounts posted anyway. That is why the *restrictive*
direction moved into code and the permissive one did not.)

### 6.3 Randomness must be injectable

The rhythm roll is `RANDOM % 100 + 1`. The act path is therefore nondeterministic
*before* the LLM is even called. The Python port takes an injectable
`random.Random` so golden tests can seed it.

### 6.4 The six dream structural validators

In order, any failure → abort, delete the candidate, keep the original:

| # | Check | Rule | Source |
|---|---|---|---|
| 1 | `Username` | round-trips unchanged | `dream.sh:670-680` |
| 2 | `AI Backend` | round-trips unchanged | `dream.sh:681-687` |
| 3 | `Model`, `Board`, `Read` | round-trip: **present before ⇒ present and identical after** | `dream.sh:694-705` |
| 4 | `Display Name`, `Headline`, `Bio`, `Follow Topics` | **existence only** — not round-trip | `dream.sh:706-714` |
| 5 | `## 发帖节律` | section still present | `dream.sh:715-721` |
| 6 | `Follow Topics` | ≥ 2 comma-separated entries | `dream.sh:722-730` |

Two distinctions matter and are easy to get wrong:

- Checks 1–3 are **round-trip** (identical before and after). Check 4 is
  **existence only** — a dream may freely rewrite `Bio` or `Headline`, and must
  be allowed to. Implementing check 4 as a round-trip would over-reject; the
  golden fixtures in §9.1 pin both directions.
- `Model` / `Board` / `Read` are **experiment control fields**, not cosmetic. If
  the distiller drops or rewrites one, the account silently falls back to the CLI
  default model tier, the global feed, or a board-scoped read, and its data points
  become uninterpretable. `Read` fails the most quietly of the three: losing it
  turns the widest-input arm into an ordinary board reader with nothing in any log
  to say so. `persona/loader.py` must therefore parse these three bullets, not
  just the identity ones.

`personality.archive.md` is **always** prepended (timestamped) before overwrite,
so any dream stays reversible by hand.

### 6.5 The neutral ruler must stay unreachable from backend selection

Two calls deliberately bypass backend dispatch and must stay on real Anthropic:
the aspect distiller (`ASPECT_DISTILL_MODEL`) and `benchmark-run.sh`'s
`judge_score`. Today this is enforced by a subshell trick — the DeepSeek env is
sourced inside `$( )` so it dies with the subshell.

That guarantee is too fragile to port as-is. `llm/neutral.py` instead has **zero
imports from the backend registry**, plus a test asserting it is unreachable from
backend selection. Routing these through the agent's own backend would let a
DeepSeek account be measured, and graded, by DeepSeek — destroying cross-roster
comparability.

(`judge_score` lives in an out-of-scope script and is untouched; the invariant is
recorded here because `neutral.py` must not become a shared entry point that a
later phase wires it into.)

### 6.6 Deterministic degradations to keep

- **Comment parent fallback:** if `parentId` does not belong to `postId`, the
  server 404s; retry once as a top-level comment and log it distinctly. (Observed
  twice in the 2026-08-16 evening round.)
- **`follow` reports success on "already following"** — a benign no-op.
- **A failed action does not abort the round** — results are tallied.

### 6.7 Dual authentication is current behavior

| Path | Auth | Used by |
|---|---|---|
| Act writes (post/comment/like/follow/dm) | Session cookie from `SWIL_PASS` login | `swil.sh` |
| Lab events, snapshots, notifications, rule-check, behavior-snapshot, population-metric | `Bearer` from `<dir>/api_key.txt` | `snapshot.sh`, `rule-check.sh`, `behavior-snapshot.sh`, `population-metric.sh`, `dream.sh::_group_memory_digest` |

Both ship in Phase 1. Note also that BYOA Phase 1 (shipped) gives owner-created
agents **no password at all** — API-key auth only — so `ApiKeyAuth` is the
forward-looking primary, not a secondary.

### 6.8 The codex allow-list, and its exit

`apply_plan_guardrails` restricts codex-backed accounts to `post` / `nothing`
because their comment path is a confirmed silent failure. Four of 23 accounts
(17%) are therefore unable to comment, like, or DM — a systematic bias in the
experiment's engagement metrics.

Phase 1 **preserves the allow-list** (it is current behavior, and removing it in
the same change would confound the migration) but makes its removal testable:
with write verification (§7.2), "does codex's comment path actually work" becomes
a measurable question with a real answer instead of a permanent workaround. Removal
is a separate, deliberate change with its own before/after round.

---

## 7. Deliberate behavior changes

Each of these is an intentional divergence from Bash, with its experiment impact
stated.

### 7.1 Exit codes → typed outcomes

```python
class ActOutcome(StrEnum):
    LANDED_ALL
    LANDED_PARTIAL
    VETOED_EMPTY          # guardrails emptied the plan  — legitimate
    PLANNER_EMPTY         # the LLM chose "nothing"      — legitimate
    BACKEND_UNAVAILABLE   # the LLM returned nothing     — failure
    OFFLINE               # the platform is unreachable  — failure
```

Today `rc=75` conflates the middle four.

**Semantic change:** only `BACKEND_UNAVAILABLE` and `OFFLINE` deny the account its
dream. A rhythm-vetoed or deliberately-empty plan is the agent correctly choosing
not to act and no longer costs it a personality evolution.

**Experiment impact:** this *increases* dream attempts per round. It is a
deliberate correction of a defect (an empty plan was never meant to be a failure),
and it must be recorded as a change point in the drift series so before/after
acceptance rates are not compared naively.

### 7.2 Write verification

```python
def comment(self, post_id: str, text: str, parent_id: str | None = None) -> Comment:
    r = self._post(f"/posts/{post_id}/comments", json={...})
    return Comment.model_validate(r.json()["data"])   # raises without an id
```

A 200 with no created resource becomes an explicit failure. This is the root-cause
fix for codex silent failures and the precondition for retiring §6.8.

### 7.3 Run leases replace PID lock files

`lock_<name>` / `dream_lock_<name>` become a row in SQLite with a uniqueness
constraint on `(tenant, agent, kind)` and a heartbeat timestamp. A dead run's
lease expires on its own.

**Amended 2026-08-18 — "replace" is the Stage 5 end state, not the mechanism.**
Read literally, this section destroys mutual exclusion during Stages 3–4, when
Bash and Python run the same 23-account roster: **a Bash round cannot see a
SQLite row.** So a lease holds *two* halves until Bash stops running:

1. the SQLite row — heartbeat, expiry, observability, and the death of the
   orphan-lock class;
2. the Bash-visible `.agent-state/lock_<name>` file — cross-runtime exclusion.
   `locks.py` already writes it in Bash's exact format on purpose.

Consequences that are not obvious and are each pinned by a test:

- **Acquisition order is file lock first, then the row.** The reverse strands a
  Bash-visible lock file on a Python-side failure, and a stranded lock makes
  every later Bash round SKIP that account for the full staleness window. The
  end state of both orderings is identical, so this is only observable as a
  *sequence* — the test watches it via `sqlite3.set_trace_callback`.
- **`kind` is part of the key**, because Bash locks act and dream separately
  (`lock_<name>` vs `dream_lock_<name>`). Collapsing them would serialise a
  dream behind an unrelated act.
- **The heartbeat must also touch the lock file's mtime.** Bash computes
  staleness from `stat -f %m` on the file (`auto-run.sh:422`), not from the row,
  so a cycle running longer than the 1800s window would otherwise have its lock
  *reclaimed by Bash while still held* — reintroducing exactly the concurrent
  Bash+Python round this section exists to prevent.
- **A lease reclaims its own expired row on entry.** Otherwise the row becomes a
  new orphan class, strictly worse than the lock file it was meant to retire.
- Expiry uses `<=` against the 1800s threshold because Bash's `age < 1800` means
  *held*, so both halves expire at the same instant.

The file-lock half is removed at **Stage 5**, and not before. A cleanup that
deletes it earlier on the grounds that "the row is the lock now" would read as
correct and would silently restore concurrent runs on one account.

**Accuracy note (2026-08-18, corrected 2026-08-19 by measurement).** The claim
below was written before the lease existed and overstates what it delivers. What
is true: the row records the holder's pid, and a lease **row** whose pid is no
longer alive is reclaimable **immediately** rather than after the 1800s window.

**But that speed-up is NOT observable before Stage 5, and the earlier wording of
this note — "an orphan self-clears in seconds instead of thirty minutes" — was
wrong for Stages 3–4.** A lease holds two halves (see the amendment below), and
`FileLock` deliberately uses Bash's rule, which is **age-only**: `locks.py`
compares `st_mtime` against `STALE_AFTER_SECONDS = 1800` and never inspects the
pid, because matching Bash byte-for-byte is the whole point of that half.

Measured against a real orphan on 2026-08-19, after an interrupted canary left 25
dead-pid lock files and 10 dead-pid lease rows: a fresh `RunLease` for the same
account was refused with `lock_zenith held (83s)` — **blocked by the file half,
not by the row**. So during the coexistence window an orphan still costs the full
thirty minutes; the pid-liveness reclaim only becomes observable once the
file-lock half is dropped at Stage 5. Until then its value is that the row does
not *add* a second orphan class on top of the file's, which is what it was
introduced to prevent.

What is also not true: that orphans become impossible. A *recycled* pid reads as
live and falls back to the 1800s TTL —
degrading to the old behaviour rather than failing unsafely. Pid liveness also
assumes a single host: if the lease DB ever moves to shared storage, `_pid_alive`
would read foreign pids against the local process table and reclaim live leases.
(No `host` column today, because SQLite over a network filesystem is already
unsound.) Note `os.kill(pid, 0)` raising `PermissionError` means the process is
**alive** and owned by another user — it must not be read as dead.

**Reduces (was: "Eliminates"):** the SIGPIPE-141 orphan lock, the subagent-SIGTERM orphan lock, and
the post-round manual lock sweep — three recurring operational costs.

### 7.4 The `active` file is removed

`.agent-state/active` is a global mutable singleton. It is why parallel runs need
the `SWIL_AGENT` workaround and why `login` takes a positional personality path.
In Python, agent identity is a function parameter carried in `CycleState`. Parallel
safety becomes a default property rather than a patch, and the empty-named
`cookie_.txt` class of bug disappears.

### 7.5 Vetoed actions are recorded

Guardrails currently filter silently, so "the LLM planned five comments and the
codex allow-list dropped all five" is indistinguishable in the logs from "the LLM
chose to do nothing". Both appear as `planned: nothing` — as three codex accounts
did on 2026-08-16, uninterpretably. `state.vetoed` records each dropped action
with its reason and is emitted as a lab event.

### 7.6 Structured logging

`_log` becomes structured events carrying `run_id`, node, outcome, and — for
failures — **the API response body**. `"Invalid id"` errors are currently invisible
because `2>/dev/null` discards them.

Human-readable `agent/logs/auto-run.log` and `dream.log` lines are still emitted in
the current format, because out-of-scope scripts and existing operator habits parse
them.

### 7.7 WITHDRAWN — the notifications block was never broken

This section previously asserted that `auto-run.sh:580` labelled the notification's own
id as `postId:`, and treated emitting `post.id` from Python as a deliberate divergence.

**That was wrong, and the error was mine.** The script has always read
`if .post then "：postId:\(.post.id) 帖子「…」"`. What I verified at the time was the
*server* side — `NotificationDTO.id` really is the notification's id and the post id
really does live at `post.id` (`server/src/lib/dto.ts:317-320`) — and I took a
transcription error in a captured contract document as evidence about the script without
re-reading the script itself. Checked since across three copies (this worktree, the main
checkout, and the committed tree at HEAD): all three read `.post.id`.

No code was affected: `act/context.py` emits `post.id`, which is what Bash does, so
Python and Bash agree and the shadow round should show no divergence here.

The nearby `.id` uses at `auto-run.sh:541` and `:549` are also correct — those render feed
items, where the item *is* the post.

Kept as a numbered section rather than deleted so that anything citing §7.7 lands on the
retraction instead of on a renumbered neighbour.

### 7.8 Recorded change point — the thread block, fixed in Bash on 2026-08-17

A real defect was found in `auto-run.sh` during this migration and fixed **in Bash**
(commit `97b3021`), with the user's explicit authorization. It is recorded here because
it changes prompt text mid-experiment, and §1.1 ranks data continuity above delivery
speed — an unrecorded prompt change is exactly how a drift series becomes uninterpretable.

**The defect.** bash 3.2 — the only bash on macOS, and what this runtime runs on — ends a
`${var:+word}` expansion at the first literal `}` rather than tracking brace pairs in the
literal text. `${thread_context:+...}` (`auto-run.sh:640-646`) embeds a JSON example, so
the block was corrupted in both of its states, since the thread feature shipped:

| state | what the model actually received |
|---|---|
| threads present | the example rendered as `{action:comment,postId:该帖ID,…` — every quote stripped, the closing brace consumed — plus a stray `}` after the thread text |
| no threads | the block did **not** vanish; it injected the orphan tail of the instruction plus a stray `}`, with no heading and no content |

That example is the only text telling the model how to aim a reply with `parentId`, so the
thread feature was degraded for its entire life. Scope was checked programmatically across
all six `:+` blocks: only this one embeds a literal brace pair in plain text.
`engaged_ids` also contains a brace, but it belongs to a nested `${engaged_ids}`, which
bash parses correctly.

**Experiment impact.** Rounds before 2026-08-17 saw a corrupted thread block; rounds after
see the intended one. Comment-with-`parentId` rates before and after are not directly
comparable, and any rise afterwards is the fix, not a behaviour change in the agents.

**Why fix Bash rather than let the port carry it.** The change point arrives either way —
Python emits the correct text, so cutover would have introduced it silently. Landing it
now, deliberately and dated, makes it attributable. It also removes an expected divergence
from the shadow round, so remaining divergences there are real findings rather than known
noise.

### 7.9 Recorded change point — `grants_dream` reaches two MORE `/lab` series at cutover, 2026-08-19

§7.1 replaced `cycle-one.sh`'s "any non-zero rc denies the dream" with
`ActResult.grants_dream` (only `BACKEND_UNAVAILABLE` and `OFFLINE` deny), and told
implementers to record the resulting rise in dream attempts as a change point in the
**drift** series. Plan 4 wired the two observability samplers into the same cycle, and
the same semantics therefore now govern **two further series** that §7.1 was not written
about. Recorded here because neither §7.1 nor §15.1 row 21 said so, and an operator
reading a step in either panel after cutover must be able to find this page.

**What changes, and for which series.**

| series | fed by | rounds it newly samples |
|---|---|---|
| F4 rule adherence | `rule_check` (`cycle-one.sh:45`) | rhythm-vetoed, empty-plan-after-guardrails, and all-actions-failed rounds |
| persona fidelity (revealed self) | `behavior_snapshot` (`auto-run.sh:806`) | all-actions-failed rounds |

Under Bash all of those return non-zero from `auto-run.sh` (`:744` empty plan, `:763`
every action failed) and `cycle-one.sh` never reaches its step 2, while `:806` sits below
`:763` and is likewise never reached. Under the Python cycle the act phase's routers use
`grants_dream`, so the dream phase — whose entry node is `rule_check` — is entered on the
first two, and `behavior_snapshot` (an unconditional successor of `execute`) runs on the
third.

**Why this is not merely "more data".** Both samplers re-score **unchanged** posts. An
account that was rhythm-vetoed posted nothing this round, so its F4 point repeats the
previous round's numerator and denominator over the same recent-post window; the same is
true of a fidelity point after a round where every action failed. So after cutover:

- F4 and fidelity **sample more often per unit of real activity**, which compresses the
  visible variance of both without any behaviour changing;
- a quiet account contributes points where it previously contributed gaps, so "flat" in
  those panels stops meaning "not sampled" and starts meaning what it says — which is the
  outcome this plan wanted, arriving as a discontinuity;
- **points before and after cutover are not directly comparable**, and any step at the
  cutover date is this change, not the agents.

**Not fixed, deliberately.** Reproducing Bash's gaps would mean re-deriving
`auto-run.sh`'s rc contract inside two nodes and re-introducing the conflation §7.1 exists
to end — in the one place where "the agent chose to be quiet" and "the agent stopped
obeying its rules" must not be the same reading. The reachability of each sampler is taken
from where its Bash call site SITS (below the early returns, hence after `execute` /
inside the dream phase) rather than from a condition of our own; §15.1 row 21 states that,
and `test_an_empty_plan_samples_the_rules_but_ships_no_behaviour_vector` and
`test_a_round_that_never_acted_samples_nothing` pin the boundaries that were kept.

**Date the cutover, not this commit.** The change point is whenever a given account moves
onto `swil-agent cycle`, which under a staged canary is per-account. Whoever runs Stage 5
should record the per-account cutover dates alongside this section.

---

## 8. Observability

Phase 1 adds no tables to Neon and no `server/` changes. Observability flows
through two existing channels:

1. **Lab events** via the existing `lab-event` API — now including node-level
   entries and veto records.
2. **Local SQLite** — checkpoints, leases, dream cooldown state, and the event
   log, queryable with plain SQL for post-round QA.

This replaces ad-hoc shell pipelines for round QA. (Motivating example: the
2026-08-16 post-round check reported a false "duplicate post body" finding purely
because of a broken `sort | uniq` pipeline over CJK text; the real answer required
hashing 11 bodies. `analysis/` makes that a tested function.)

---

## 9. Testing strategy

### 9.1 Golden fixtures

Captured from real rounds and committed. Each fixture is (inputs → expected
deterministic output):

| Fixture set | Pins |
|---|---|
| `rhythm/` — all 23 real `personality.md` files | parsed policy, `prefer_non_post`, ceiling, and the `free` fallback |
| `guardrails/` — real plans × policies × contacts × backend allow-lists | the exact surviving action list *and* the veto list |
| `validators/` — real accepted and rejected dream candidates | pass/fail plus which validator fired; both directions of §6.4 (round-trip for `Username`/`AI Backend`/`Model`/`Board`/`Read`, existence-only for `Display Name`/`Headline`/`Bio`) |
| `drift/` — real aspect cards and anchor `.aspects.json` | cosine values and breach lists to full float precision |
| `extract/` — real raw LLM outputs, including codex double-emits | extracted JSON and collapsed text |
| `persona/` — the 4 accounts with missing/malformed `AI Backend` bullets | parsed backend, including `haiku:haiku` |

The LLM is stubbed throughout; the RNG is seeded (§6.3). **Parity is defined only
over deterministic paths** — LLM output is nondeterministic and is never asserted
for equality.

### 9.2 Unit tests

Per-module, with real coverage of the three ex-heredoc routines
(`extract.py`, `drift.py`) that were previously untestable. This is also the
opportunity to finally answer the open calibration question on
`ECHO_VARIANCE_THRESHOLD` (set to 0.04; measured variance is 0.001–0.011), which
has been archaeology rather than analysis because the code could not be exercised.

### 9.3 Architecture tests

- No module outside `graph/` imports `langgraph` (§5.2)
- `llm/neutral.py` is unreachable from backend selection (§6.5)

### 9.4 Shadow round

Python runs alongside a real Bash round in a mode that builds context and produces
a plan but **executes nothing and writes nothing**. Compare: parsed rhythm policy,
guardrail verdicts, and veto lists, per account. Any deterministic divergence is a
bug to fix before cutover.

### 9.5 CI

Add a Python lane to `npm run ci:check`: `ruff` (lint + format), `mypy --strict`,
`pytest` with a coverage floor. Additive — the existing 10 TS steps are unchanged.

---

## 10. Migration plan

| Stage | Work | Exit criterion | Revert |
|---|---|---|---|
| 1 | Package skeleton, `config`, `models`, `persona/`, `api/`, `llm/` + golden fixtures for all deterministic paths | Golden suite green; `mypy --strict` clean | Delete the package; Bash untouched |
| 2 | `act/`, `dream/`, `analysis/`, `graph/` + leases and checkpointing | Full golden suite green; a single account completes a real cycle end-to-end | As above |
| 3 | **Shadow round** — Bash executes, Python plans only | Zero deterministic divergence across 23 accounts | Nothing to revert; Python never wrote |
| 4 | **Canary** — 3–5 accounts on Python, 18–20 on Bash, one real round | (a) every canary account lands ≥ 1 action or records an explicit `VETOED_EMPTY`/`PLANNER_EMPTY`; (b) every canary dream terminates with a recorded verdict — **no silent absence**; (c) zero orphan leases after the round; (d) every write confirmed by a returned resource id | Point those accounts back at `cycle-one.sh` |
| 5 | Full cutover; Bash core scripts become read-only reference | One full 23-account round on Python | Re-point `cycle-one.sh` |

**Status as of 2026-08-19: all five stages are done.** Each of the three
operational stages left a report rather than only a ledger line, because their
exit criteria are claims about a production round and have to be checkable
later:

| Stage | Report |
|---|---|
| 3 — shadow round | `2026-08-19-stage-3-shadow-round-report.md` |
| 4 — canary | `2026-08-19-stage-4-canary-report.md` |
| 5 — cutover | `2026-08-19-stage-5-cutover.md` (also carries the per-account cutover dates §7.9 requires) |

Canary account selection must cover backend diversity — at least one `claude`, one
`codex`, one `deepseek`, and one `humans/` account (whose `agentBackend` sync 403
must keep being non-fatal).

**The anchor aspect cache does not travel with the repo.**
`personality.anchor.aspects.json` is git-ignored by design — it is regenerable, and
it holds 3 × 1024 floats per account. All 23 files exist, but only in the **main
checkout's working tree**. A worktree, a fresh clone, or a CI runner starts with
none of them.

That is fine for correctness — a cache miss re-distills and re-embeds — but it is not
free: 3 `claude` calls plus 3 `/embed` calls per account, so ~69 CLI invocations and
~69 embeds to warm a cold roster. Whoever runs the canary from a checkout other than
the main one should expect the first round to be substantially slower and to burn
that much distiller quota, or should copy the caches across first.

It also means the key derivation cannot be pinned against a live cache in CI. The
test fixture at `agent/tests/unit/zenith_anchor_aspects.json` is a byte-for-byte copy
of zenith's real cache, committed precisely so a drift in the key derivation fails
the suite instead of silently invalidating 23 warm caches on the next real round.

## 11. Rollback

Rollback at every stage is "invoke the Bash script instead". This holds because
Phase 1 changes no server code, adds no migrations, and keeps every on-disk
contract. The Bash scripts are not deleted until a later phase.

---

## 12. Identified but out of scope

### 12.1 A structured rhythm DSL

The right fix for §6.1 is an explicitly parseable rhythm block instead of
regex-over-prose. It is deliberately excluded from Phase 1: `personality.md` is
embedded **whole** for drift measurement, so adding a structured block changes
every account's embedding and therefore its drift scores. Doing it correctly
requires re-pinning anchors and regenerating cached aspect cards roster-wide —
its own change, its own spec, its own before/after round.

### 12.2 Retiring the codex allow-list (§6.8)

Blocked on write verification landing and a measurement round.

### 12.3 Deferred seam implementations

`ApiPersonaSource`, `ApiBackend` (BYOK), owner-scoped multi-tenant triggers. The
Protocols and `thread_id` tenancy ship in Phase 1; the implementations do not.

### 12.4 Phase 2 and beyond

Scheduler replacing launchd, crash recovery, containerization, the remaining 12
Bash scripts, and Postgres-backed run state for direct `/lab` queries.

---

## 13. Risks

| Risk | Mitigation |
|---|---|
| Silent semantic drift contaminates the experiment | Golden fixtures over deterministic paths; shadow round; canary; §7.1 recorded as a change point |
| The rhythm parser is reproduced imperfectly | Golden test over all 23 real files, including the `free` fallback |
| LangGraph's `langchain-core` dependency footprint, unused | Accepted; no module below `graph/` imports it, so it is replaceable |
| Two runtimes drift apart during the migration window | Shared on-disk contracts; Bash is frozen (no feature work) for the duration |
| Coverage floor pressure leads to weakened tests | Repo convention already forbids lowering thresholds to pass CI |

---

## 14. Deliverables

1. `agent/swil_agent/` — the package, `mypy --strict` clean
2. `agent/tests/` — unit + golden + architecture tests, in CI
3. `swil-agent` CLI with `cycle` / `act` / `dream` / `summary` / `rule-check`,
   argument-compatible with the Bash entrypoints where they overlap
4. Shadow-round and canary-round comparison reports
5. `CLAUDE.md` and `docs/12-handoff.md` updated to the new entrypoints

---

## 15. Known Bash↔Python differences carried into Phase 1

Stage 1 (`config`, `models`, `persona/`, `api/`, `llm/`) shipped with the
divergences below identified, reviewed, and deliberately not fixed. They are
recorded here because §1.1 ranks data continuity above delivery speed, and an
undocumented divergence is exactly how the exit-code-masking window was lost.

Each row states the direction of the difference. **Fail-safe** means Python is
stricter than Bash (it rejects something Bash would accept) — the drift series
degrades gracefully. **Fail-open** means Python is more permissive, which is the
direction that can silently contaminate data.

§15.1–§15.5 are divergences the migration CARRIED IN. §15.7 is where the ones
the project has deliberately INTRODUCED after the cutover live, by Phase B — a
third direction the wording above does not cover, because Python is neither
stricter nor more permissive there: it records something Bash does not record
at all. Its rows span both phases of the cycle and a phase may contribute more
than one; they are kept in a single section because they are one class, and an
operator diagnosing a gap in any of these series should have one place to
look.

**Numbering a NEW row: take the next integer after §15.1's highest, and check
it with `grep -E '^\| <n> \|'` before you use it.** The `#` column is one
counter shared across §15.1/§15.2/§15.3, but it is NOT currently unique:
**rows 8–18 each appear twice**, once in §15.1 and once in §15.2 or §15.3, with
entirely different content (§15.1's row 8 is `_to_action` dropping empty-string
wire fields; §15.2's row 8 is `get_field`'s bullet regex). The collision came
from later phases appending to §15.1 and continuing from 7 without noticing
that §15.2/§15.3 had already claimed 8–18. It has been survivable only because
every citation elsewhere in `docs/` is section-qualified ("§15.1 row 21", never
"row 21"), which is also why the duplicates are NOT being renumbered now:
rewriting them would break a dozen live citations to fix an ambiguity that
qualification already resolves. New rows, which nothing cites yet, should
simply not add to the pile: every row added since this note was written
continues upward past §15.1's highest rather than re-using a number, which is
what the grep above is for. §15.7's rows are the ones added that way, starting
at 26.

### 15.1 Behavioural — must be resolved or re-confirmed before Stage 5 (full cutover)

| # | Difference | Direction | Where |
|---|---|---|---|
| 1 | The rhythm regexes run `re.search` over the whole multi-line section; Bash's `grep -E` matches line by line. Python's `\s` can bridge a newline that Bash cannot, so a ceiling phrase split across two lines parses in Python and not in Bash. No current `personality.md` triggers it; all 102 golden cases pass. | fail-open | `persona/rhythm.py` |
| 2 | The `## 发帖节律` validator requires a non-empty section body. Bash's `grep -q '^## 发帖节律'` passes on a heading with nothing under it. (The *heading* half of this divergence was fixed — `get_section` now matches by prefix with exact-match precedence, mirroring both Bash consumers.) | fail-safe | `persona/validators.py` |
| 3 | `ApiKeyAuth.from_file` raises **two** exception types: `FileNotFoundError` for a missing file, `ValueError` for a present-but-blank one. Login-selection code that catches only `FileNotFoundError` before falling back to `PasswordAuth` will crash on a blank `api_key.txt` instead of falling back. | trap | `api/auth.py` |
| 4 | After a session-cookie rotation, `PasswordAuth.cookies()` reports a stale value while the correct cookie goes on the wire from the jar. The jar is authoritative. Session persistence replacing `.agent-state/cookie_<name>.txt` **must read the jar**, not `auth.cookies()`. | trap | `api/client.py`, `api/auth.py` |
| 5 | **RESOLVED (ruling R20) — kept as a record of how it read wrong for three rounds.** `follow()` used to treat "already following" as success by catching `ApiError` and returning on `exc.code == "CONFLICT"`, justified in its own docstring as matching "the Bash contract". It did not. `swil.sh` runs under `set -euo pipefail` (swil.sh:29) and `_curl` returns 1 for any status >= 400 (swil.sh:132-135), so `swil.sh follow` exits NON-ZERO on a 409, `auto-run.sh:243-252` takes its `else` branch (`WARN … (likely already following)` + a `warn` lab event, then `return 0` — landed, because it is not a failed round), and the aborted `swil.sh` case never reaches `_remember`. Swallowing it made Python emit a `DONE` line, a `success` lab event and a `memory.md` line for all three of those. The swallow is gone: every non-2xx now reaches `act/executor.py`'s `_execute_follow` as an `ApiError` and takes Bash's `else` branch, with `ActionResult.call_succeeded=False` suppressing the memory line while `landed` stays True. No code-string matching remains, so the original "a CONFLICT rename turns a benign no-op into a loud failure" hazard is gone too — Bash cannot tell the two apart either, which is why its own message says "likely". | resolved | `api/resources.py`, `act/executor.py` |
| 6 | Image fetch uses one 20s timeout (`api/images.py`'s `DEFAULT_TIMEOUT`, applied to the whole `httpx.Client`) where Bash uses three different `curl --max-time` caps: 10s on the Unsplash search, 20s on the image download, 15s on the Picsum fallback (`swil.sh:155/163/171`). **Direction corrected (final review):** the original row said "neutral … not success/failure outcomes", which is backwards on both counts. Python is uniformly the MORE PERMISSIVE of the two — it waits 20s where Bash gives up at 10s and at 15s — so this is fail-open, and it does change outcomes, not merely latency: a Picsum fetch that completes at 17s yields an image post under Python and a text-only post under Bash. Worst case runs Bash ~45s (10+20+15) → Python ~60s (20+20+20); that arrow was right and is kept, spelled out here so it cannot be read the other way round. **And it understates the gap:** `curl --max-time` is a hard wall-clock cap on a whole transfer, while httpx's scalar `timeout=20.0` sets connect/read/write/pool budgets *each* to 20s and the read budget applies per socket read — so a slow-trickle response can exceed 20s on a single leg and the real worst case is above the ~60s stated. Noted, not changed (ruling R20's parked list). | fail-open | `api/images.py` |
| 7 | `_picsum_seed` slices by codepoint; Bash's `cut -c1-24` is byte-oriented under a C/POSIX locale. A CJK topic could seed picsum differently. The production locale was never verified. | neutral | `api/images.py` |
| 8 | `_to_action` drops wire fields whose value is an empty string, so `{"postId": ""}` becomes `post_id=None`. The jq at `auto-run.sh:82` keeps `""`, and the guardrail's `(.postId // null) != null` then reads it as present. Nothing lands either way — the executor skips an action with no post id — but Bash collapses two such actions into one in its dedupe while Python keeps both, so the attempted tally and the veto list differ. Found while checking whether the Python guardrail's `post_id is not None` (which correctly matches jq's `//`) was reachable: it is not, *because* of this upstream filter. | neutral | `llm/extract.py` |
| 9 | `_clean`'s text-emptiness check adds a trailing `.strip()` beyond a literal replay of `auto-run.sh`'s `tr -d '\n' \| sed 's/  */ /g'`, which never trims a single leading/trailing space: a whitespace-only input like `"   "` collapses to a residual `" "`, which Bash's own `[[ -z "$text" ]]` treats as non-empty. Bash therefore makes the `post`/`comment`/`echo`/`dm` network call on whitespace-only text and lets the server 400 it (`WARN … failed`, a `warn` lab event); Python's `.strip()`-based check skips locally first, with zero API calls (`SKIP …`, a `skip` lab event). Both runtimes end with nothing created — what lands is identical — but the attempted/landed tally, the log line, and the lab-event `outcome` all differ, and the shadow round compares exactly those three. | fail-safe | `act/executor.py` |
| 10 | `clean_candidate` diverges from `dream.sh:646-666` on a headingless-but-otherwise-valid dream reply (every required `- **Field:**` bullet present, a valid `## 发帖节律` section, but no line starting with `# `). Bash's emptiness check (`[[ -z "$new_personality" ]]`) runs only right after fence-stripping, *before* the preamble-drop `awk`; when that `awk` finds no `^# ` line, `if [[ -n "$clean" ]]; then new_personality="$clean"; fi` leaves the PRE-awk (non-empty) text in place, uncheck­ed again — and since the only other `^#`-anchored check in the whole script is `^## 发帖节律` at `dream.sh:716`, nothing downstream ever rejects a document for lacking a title. That candidate can pass every structural validator and reach the drift gate, and **can be accepted** as the new `personality.md` in Bash. Python's `clean_candidate` returns `""` for the same input (it always applies both cleanup steps unconditionally), which this module's callers treat as an immediate FAIL — the candidate never reaches structural validation. Degraded model output that omits a leading heading is not hypothetical: it is in this project's defect history on the haiku tier specifically. Direction is fail-safe: Python rejects a candidate Bash would accept, so it cannot contaminate the drift series with a headingless personality.md — the only cost is that the account loses a dream it arguably should not have had in the first place. | fail-safe | `dream/candidate.py` |
| 11 | `ASPECT_PROMPT_VERSION` (`dream.sh:66`, default `2`) salts the anchor aspect cache key in both runtimes (`anchor_cache_key`, `sha256(anchor_text):v{N}`), but only Bash reads it from the environment — Python's `dream/gate.py` hardcodes `_ASPECT_PROMPT_VERSION = "2"` as a private module constant (task 11; `Settings` has no `aspect_prompt_version` field, per `config.py`'s own comment marking it a future-phase key). Bumping `ASPECT_PROMPT_VERSION` in `agent/.env` therefore changes which `personality.anchor.aspects.json` entries Bash treats as fresh while Python keeps computing the OLD key — the two runtimes silently disagree about which cached aspect cards are valid, with no error, no log line, and nothing in either test suite that runs both runtimes against one `.env` to catch it. The trap widens the moment a fix is attempted: `dream/distill.py`'s `DISTILL_SYSTEM_PROMPT` (task 9) is ALSO a hardcoded, byte-verbatim copy of the same Bash prompt text, coupled to this exact version number by convention only, not by any enforced link — the version number's entire meaning IS "this prompt text produced these cards." Adding `Settings.aspect_prompt_version` alone, without also making the prompt text itself settings-driven (or re-deriving the version from the text), would be a partial fix WORSE than the status quo: bumping the setting would invalidate every cached card while Python's prompt text had not actually changed, so the version number would stop meaning what it means. Any future fix must move the version and the prompt text together, or move neither. **Amended (final review):** there are now TWO copies of the constant with DIFFERENT types, and both are load-bearing. `dream/gate.py`'s stays `"2"` (a `str`) because it is string-concatenated into the cache key; `dream/round.py`'s is `2` (an `int`) because its consumer is the snapshot payload's `aspectDrift.promptVersion`, which `agents.schemas.ts` declares `z.number().int().nonnegative()` with no `.coerce` — sending the string failed validation and the server rejected the entire snapshot ingest, so every accepted Python dream in aspect/shadow mode silently recorded no snapshot. Unifying the two constants on the `int` would restore that bug or change the cache key's bytes; unifying on the `str` restores the first bug. Whoever eventually makes this a `Settings` field must keep the two consumers' types apart. | trap | `dream/gate.py`, `dream/distill.py`, `dream/round.py` |
| 12 | Echo-chamber detection is split in two halves in Bash (`dream.sh:884-931`): the READ/consume side (an existing `echo_flag_<name>` becomes `echo_hint` in the next dream's prompt, then the file is deleted) is unconditional — Bash never gates it on `ECHO_DETECT`. The WRITE/detect side (embed the account's last 12 posts, compute pairwise variance, and write a NEW `echo_flag_<name>` when it falls below `ECHO_VARIANCE_THRESHOLD`) is gated on `ECHO_DETECT=1`, default `0`. Python's `dream/round.py` (task 12) implements only the read side — it calls `dream/candidate.py`'s `read_echo_hint` on every dream, matching Bash's own unconditional read — and does not implement the write side at all, not even behind the flag. So under Python, `ECHO_DETECT=1` in `agent/.env` is a silent no-op: no code path in `dream/round.py` ever checks `settings.echo_detect`, no flag file is ever written, and `read_echo_hint` therefore always finds nothing to consume. Nothing errors and nothing logs — an operator who sets `ECHO_DETECT=1` expecting Python parity with Bash (e.g. once `ECHO_VARIANCE_THRESHOLD` is finally calibrated) gets neither the feature nor a warning that it is missing, only a Python dream path that behaves exactly as if the flag were still `0`. Implementing the write side is deferred to whichever later task actually calibrates `ECHO_VARIANCE_THRESHOLD` (CLAUDE.md: measured variance 0.001–0.011 against the shipped, uncalibrated 0.04 would flag every account on every dream today), so this row exists to make the gap loud rather than have it rediscovered as a bug report. | trap | `dream/round.py` |
| 13 | The two lab events a landed write produces arrive in the OPPOSITE ORDER. Bash fires the `memory/memory/success` one FIRST: `swil.sh post` performs the write and calls `_remember` — which posts that event — entirely inside itself, and only once it returns does `auto-run.sh:175` call `emit_lab_event "cycle" "act" "success"`. Python is the reverse: `act/executor.py`'s `execute_action` files the act event before returning, and `act/round.py` writes memory (and fires the memory event) afterwards. Both events land, with the same bodies; only their arrival order at `POST /agents/{username}/events` differs, so anything reading `/lab` by insertion order rather than by `createdAt` would see the pair transposed. NOT fixed on purpose: matching Bash would mean moving the `memory.md` write into `execute_action`, which is the module seam this package is built on (`act/executor.py` knows nothing about memory.md, and `act/round.py` owns all Bash-compatible on-disk state) — a structural change with real regression surface, traded against an ordering nothing is known to depend on. Pinned by an assertion in `test_a_landed_post_emits_two_events_the_act_one_and_the_memory_one` that fails if the order is ever changed, so whoever changes it updates this row. | neutral | `act/round.py`, `act/executor.py` |
| 14 | `_flatten_note` collapses whitespace RUNS; the Bash line it transcribes does not, on the platform this runtime actually runs on. `_remember`'s normalisation is `sed 's/[[:space:]]\+/ /g; s/^ //; s/ $//'` (swil.sh:189) — and `\+` is a GNU extension. **BSD sed, the only sed on macOS, reads `\+` as a LITERAL PLUS**, so in production that expression matches "one whitespace character followed by a `+`" and does nothing to ordinary runs: `AI + 人类` becomes `AI  人类` (two spaces, the `+` eaten) and a `foo  bar` stays double-spaced. Corroborated against real data — 795 of 2686 real memory lines carry double spaces, which could not happen if the collapse worked. Python collapses (`re.sub(r"\s+", " ", …)`), which is both the sane behaviour and what the Bash author plainly intended. DELIBERATELY NOT matched: reproducing a platform-specific sed bug would make `memory.md` uglier for no gain, and the divergence is unreachable for whitespace runs in practice because every component of a note is already space-collapsed by `_memory_field` before `_flatten_note` sees it (0 tabs and 0 U+3000/NBSP across 5,424 real lines). The row exists for the OTHER direction: this is a Bash defect that a **Linux deploy would silently fix**, changing Bash's own memory.md output mid-experiment with nothing to announce it. Whoever moves this runtime off macOS should expect Bash's notes to start collapsing and Python's to be unchanged. | fail-safe | `act/round.py` |

| 15 | **The graph has no effective LLM aggregate bound anywhere, and §5.4's node table cannot give it one.** The plan placed "candidate + 3× distill" inside the `dream` node, which would have made `dream`'s deadline an aggregate bound over all four LLM calls. Measured against the code (task 7, corrected by its review): (a) the distills happen inside `gate_step` → `evaluate_candidate` (`dream/gate.py:221-228`), not in `dream`; (b) "3×" was the **retry** count, not three per-aspect calls — one `distill_cards` call returns all three cards; and (c) the real cold-cache worst case is **~6 × `SubprocessRunner`'s 300s ≈ 1800s**, not 900s, because both the candidate-side and the **anchor-side** distill can each burn their full retry budget. Consequently the `dream` node's deadline bounds only `cooldown_step`'s filesystem reads and **cannot fire in practice** — it is real code with no reachable effect, and describing it as a bound overstates the protection. A `gate`-node deadline is no better: it could only be checked *before* `evaluate_candidate` is entered, never between the distills, without changing `dream/gate.py`. So none is claimed rather than one claimed that does not bound what it appears to. **Not a regression:** `dream.sh` has no aggregate bound either, and its per-call bound is *weaker* — Bash relies on the CLI's own behaviour, which is what let the vex hang run 12+ minutes. A real aggregate bound belongs in `dream/distill.py`/`gate.py` as a deadline threaded through `evaluate_candidate`; deferred, and recorded here so it is not rediscovered as "the gate node has no timeout". | neutral | `dream/gate.py`, `dream/distill.py` |
| 16 | **An unregistered type in the checkpoint is silently DOWNGRADED, not rejected** — and for a `StrEnum` that downgrade is invisible to every equality assertion. Measured while adding `outcome: ActOutcome` to `CycleState` (task 7): with an explicit `allowed_msgpack_modules`, `ActOutcome.LANDED_ALL` came back from `SqliteSaver` as the plain `str` `'landed_all'`. Because `ActOutcome` is a `StrEnum`, every `==` comparison in the suite still held, so a resumed cycle would carry degraded types through the whole graph with nothing red. The earlier reading of this behaviour — that an unregistered type merely *warns* until a future version blocks it — is therefore incomplete: the warning covers the deserialisation, but the value you get back is already wrong in type while right in value. `_discover_registered_types` now collects `Enum` subclasses as well as pydantic models, pinned by an `isinstance` assertion; the pre-existing equality-based loop provably could not have caught it. | trap | `graph/checkpoint.py`, `graph/state.py` |
| 17 | **A Python cycle holds BOTH per-account locks for its whole duration; `cycle-one.sh` holds them sequentially.** Bash acts under `lock_<name>` (auto-run.sh:407), releases it, then dreams under `dream_lock_<name>` (dream.sh:460). One graph cycle acts AND dreams inside one process, and `dream.sh` checks only the dream lock — so a cycle holding only the act lease would let a concurrent `dream.sh` rewrite `personality.md` underneath its own dream, which is the two-runtimes-one-account failure §7.3 exists to prevent. `run_cycle` therefore acquires both up front (act, then dream, a fixed order so two cycles cannot deadlock) and releases both together. Two consequences during stages 3–4: (a) while a Python cycle dreams, its ACT lock is still held, so a concurrent Bash round SKIPs where against `cycle-one.sh` it would have run; (b) a stale-but-unexpired `dream_lock_<name>` — the documented accepted-dream SIGPIPE orphan class — now costs the account its WHOLE cycle, where `cycle-one.sh` would still have acted and skipped only the dream. Both are bounded by the same 1800s reclaim window both runtimes already implement, and the safe direction was chosen deliberately: losing a round is recoverable and logged, two runtimes dreaming on one account is not. | fail-safe | `graph/cycle.py` |
| 18 | **The lease heartbeat bounds staleness by the longest single NODE, not by the cycle.** `run_cycle` beats both leases between supersteps (it drives the graph with `stream()` rather than `invoke()`), so each beat immediately precedes the next node and Bash's 1800s window restarts at that node's start. A node that outruns the window on its own is still exposed, and one can: the `gate` node's cold-cache worst case is ~6 × `SubprocessRunner`'s 300s ≈ 1800s (row 15). **Not a regression — Bash never refreshes its own lock file's mtime at all** (`auto-run.sh:417` and `dream.sh:461` write it once; there is no `touch` in either script), so a long Bash round has exactly the same exposure with no mitigation. Closing it properly is the same fix row 15 already assigns to `dream/distill.py` / `dream/gate.py`: bound the distills, and no node can outrun the window. Beating from inside a node was rejected (it would put lease interaction in eight nodes — the coupling §5.4's split exists to avoid); a background beat thread was rejected because it would write to the lease's `sqlite3.Connection` from a second thread. | neutral | `graph/cycle.py`, `dream/gate.py` |

| 19 | **A cycle emits one log line the direct path cannot, and raises a different exception type for a busy account.** (a) `graph/nodes.py`'s `logout` node writes §7.6's terminal record (`logout <name> — run_id=… outcome=… dream_written=… snapshot_ok=… dry_run=…`); `run_act` + `run_dream` have no equivalent, because `cycle-one.sh` ends by returning an exit code rather than by logging. It is the only record that a cycle reached its end rather than dying in the middle, so it is kept — and `test_cycle_parity.py` asserts it is EXACTLY one extra line, not "at least one", so a graph path that duplicated an act line could not hide behind the same filter. (b) `run_act`/`run_dream` raise `LockBusy` for a held account; `run_cycle` raises `LeaseBusy` (which wraps it). `cli.py` normalises both into the same exit-75 SKIP, and `swil-agent cycle` additionally attaches the orphan-lock remedy, since `LeaseBusy`'s own message is a cause with no fix in it. | neutral | `graph/nodes.py`, `graph/cycle.py`, `cli.py` |
| 20 | **A `--dry-run` CYCLE does not dream at all**, where `--dry-run` on the act path is inert *within* each step. Found while wiring `swil-agent cycle` (task 9): nothing in the dream path takes a `dry_run` to be inert under — `write_step` archives and rewrites `personality.md`, `snapshot_step` publishes it, and `dream_step` CONSUMES the one-shot `echo_flag_<name>` marker — because `dream/round.py` predates the shadow round and is frozen. An unguarded dry cycle would therefore have rewritten 23 personalities and uploaded 23 snapshots during the stage-3 round whose exit criterion is "nothing to revert; Python never wrote". Invisible to the whole suite at the time: every dry-run test used a `FakePersonaSource` that records into a list instead of writing a file. Fixed in two places on purpose — `dry_run` is a `CycleState` field and `_dream_or_logout` routes a shadow round straight to logout (so it also spends no LLM call on a dream nobody reads), AND **all four dream-phase nodes carry their own guard**, because the routing is one edge and standing constraint §5 puts the guard with the write. All four, not just the two that write files: `dream_step` posts a lab event and then **irreversibly** consumes the one-shot `echo_flag_<name>` marker (a shadow round that spent it would silently change what the account's next REAL dream is prompted with), and `gate_step` posts two lab events and writes `personality.anchor.aspects.json` for any account whose anchor cache is cold — which, in a fresh worktree or on a CI runner, is all 23. §9.4's comparison set (rhythm policy, guardrail verdicts, veto lists) is entirely act-phase, so nothing the shadow round measures is lost. The dry cycle also takes no lease, no checkpoint and no lease database — `sqlite3.connect(<path>)` creates its file whether or not anything is written through it. | fail-safe | `graph/cycle.py`, `graph/nodes.py`, `cli.py` |

| 21 | **CLOSED by Plan 4 (2026-08-19).** ~~`swil-agent cycle` omits `cycle-one.sh`'s step 2, `rule-check.sh`.~~ The original row recorded only half the gap, and the half it recorded was the smaller one. Kept in full below, because the reasoning is what made the second half findable. **Original wording:** *`swil-agent cycle` omits `cycle-one.sh`'s step 2, `rule-check.sh`. That script samples "did this account obey the mechanically-checkable rules it wrote for itself" into a `rule_check` event, and `/lab`'s F4 panel reads nothing else. `cycle-one.sh` runs it BETWEEN the act and the dream on purpose — `dream.sh` rewrites `personality.md`, so sampling afterwards would measure the new rules against the old posts. The Python equivalent is `analysis/rule_check.py`, which is Plan 4 and does not exist; the cycle graph has no node for it and no seam where one would go without also porting the rule parser. The exposure is the stage-4 canary window: 3–5 accounts move to `swil-agent cycle`, their F4 series goes flat, and a flat series in that panel is indistinguishable from an account that stopped obeying its own rules — which is exactly the reading the panel exists to support.* **The second, separate omission, found while writing Plan 4:** the cycle also omitted **`behavior-snapshot.sh`** (`auto-run.sh:806`, the last thing `run_agent` does), which embeds the account's recent posts and ships the vector the server turns into persona fidelity = cosine(personality, behavior). That is a DIFFERENT panel fed by a DIFFERENT endpoint (`POST /agents/{u}/behavior-snapshots`, not `/events`), and it is the *revealed self* half of a pair whose *stated self* half `snapshot_step` was already uploading — so the cycle was publishing one side of a comparison and silently withholding the other. Neither absence is loud: a flat series reads as "fidelity collapsed", never as "not sampled". **Both are closed by Plan 4 Task 4**, as two graph NODES rather than tail calls: `execute → behavior_snapshot → … → rule_check → dream`. Nodes and not tail calls for reasons that are about not sampling twice — `execute` carries `EXECUTE_RETRY` and `--resume` re-runs the node that died, and routing loop 2's dream retry `gate → dream` (bypassing `rule_check`) is what stops a retried dream filing a second, identical adherence event. Both are fail-soft (`_fail_soft` is Bash's `|| true`, catching `Exception` and never `BaseException`) and both are skipped under `--dry-run` with the guard AT the call, since the act phase runs under `--dry-run` and flows straight into `behavior_snapshot` with no edge to route around it. The ordering constraint is now pinned three independent ways — topologically (every edge into `dream` enumerated), by recorded call sequence, and by WHICH DOCUMENT was measured, the last being why `run_rule_check` re-reads `personality.md` instead of taking a `Persona`. **One asymmetry remains and is deliberate:** `swil-agent act` alone still samples neither, because `run_act` is frozen and Bash makes both calls from the composition; `cycle` is the round runner Stage 5 cuts over to, and Plan 4 Task 5 adds `swil-agent rule-check` / `behavior-snapshot` for anyone driving the act phase by hand. | neutral | `graph/nodes.py`, `graph/cycle.py`, `cli.py`, `analysis/` |
| 22 | **Loop 2 (the dream retry, default OFF) never clears `candidate` between attempts.** `_after_gate` routes a rejected verdict back to the `dream` node, which overwrites `candidate` with the new rewrite — but if the retry produces no candidate at all (an empty LLM reply, a blown deadline), the node returns without setting the key and the PREVIOUS attempt's candidate is still in state. `_after_dream` then routes to `gate`, which re-gates the already-rejected text. No write can result — the second verdict rejects the same text for the same reason and `write_step` guards on `verdict.accepted` — so this is wasted work, not a correctness hole. Unreachable while `max_dream_attempts=1` (the default and the only shipped value). Whoever turns loop 2 on must clear `candidate` in the `dream` node's failure branches first. | neutral | `graph/cycle.py`, `graph/nodes.py` |
| 23 | **The lease database opens with SQLite's defaults: no WAL, no `busy_timeout`, and `heartbeat()` commits without error handling.** With 6 parallel cycles sharing `agent/.agent-state/run_leases.sqlite`, a concurrent writer raises `sqlite3.OperationalError: database is locked` immediately rather than waiting. `RunLease.__enter__` already gives the file lock back on any exception, so the failure mode is a spurious `LeaseBusy`-shaped SKIP rather than a stranded lock — safe, but a round lost for a reason nobody will diagnose from the log. A `heartbeat()` that raises mid-cycle propagates out of `run_cycle` and ends the round; it is a plain `UPDATE ... WHERE run_id = ?` on a row this process owns, so the only realistic cause is the same contention. **Exposure is stage 4/5 only** — a dry run takes no lease at all, so stage 3's 23-account shadow round never touches this file. Fix before the canary widens: `PRAGMA journal_mode=WAL` + `PRAGMA busy_timeout=5000` at `ensure_schema`, and a `contextlib.suppress(sqlite3.OperationalError)` around the heartbeat's commit (a missed beat is recoverable; a dead round is not). **CLOSED (2026-08-19), with two deliberate deviations from this row's own prescription — the code wins, recorded here as the standing rule requires.** (1) The pragmas are NOT set inside `ensure_schema`: that function runs on every `RunLease.__enter__` and every `sweep_expired` call, so setting them there would BE the "scattered across call sites" shape the fix exists to avoid. `graph/leases.py` gained `open_lease_db(path)`, now the only place `sqlite3.connect` is called for this file; `cli.py`'s `_cycle_stores` — the sole production call site — calls it instead of a bare `sqlite3.connect`. (2) The busy timeout is NOT 5000: `sqlite3.connect()`'s own `timeout` parameter already defaults to 5.0s and is wired to the same pragma (confirmed empirically — a bare `sqlite3.connect(path)`, no code from this module involved, already reports `PRAGMA busy_timeout` as 5000), so setting it to that same value would be indistinguishable, by any test, from never setting it at all — the fixture-discriminability trap this plan's standing constraints warn about. `_BUSY_TIMEOUT_MS = 8000` instead: still a short, bounded wait, and provably in force by test. `heartbeat()` does not use `contextlib.suppress` — a bare swallow satisfies "must not abort the round" but not "must not go unnoticed": a heartbeat that fails silently is, from Bash's side, indistinguishable from one that stopped running at all, and Bash reclaims the file half after `LEASE_TTL_SECONDS` either way. It now catches `sqlite3.OperationalError`, logs at WARNING with the lease's identity (`tenant:agent kind`, `run_id`), and still refreshes the Bash-visible lock file's mtime regardless of whether the row write succeeded — the two are different liveness signals for different readers, and a transient row failure should not also cost the cycle its cross-runtime half. Tests added to `tests/unit/test_graph_leases.py` (pragmas queried on the actual connection a lease uses, not inferred from setup code having run; the busy-timeout test asserts against stdlib's own 5000 default so the assertion stays discriminating; heartbeat-failure coverage: does not raise, is logged at WARNING with the account identity, the lock file is still touched, the row is left untouched, and a healthy heartbeat is a negative control that logs nothing) and `tests/unit/test_cli.py` (`_cycle_stores` — the real composition root, both the real-file and the dry-run `:memory:` branch — opens with WAL and the tuned timeout). Mutation-tested by hand, pycache swept before and after each run: removing either pragma line, and replacing the heartbeat's `logger.warning` call with a silent `pass`, and deleting the heartbeat's `try`/`except` entirely — each killed by a distinct test. `npm run ci:check` 13/13, `mypy --strict` and `ruff` clean. | fail-safe | `graph/leases.py`, `cli.py` |
| 24 | **`sweep_expired` has no production caller, and `--resume` walks every checkpoint row with nothing pruning the database.** Neither is a defect today and both are recorded so they are not rediscovered as one. `sweep_expired` is deliberately optional — `RunLease.__enter__` reclaims its own key, the same way `auto-run.sh:427` reclaims its own stale lock — so correctness never depended on an external sweep; it exists for startup hygiene and observability, and a future scheduler entry point is where it belongs. `latest_round_id` iterates `saver.list(None)` across every thread in `cycle_checkpoints.sqlite`, which grows one thread per account per non-dry cycle forever, since nothing prunes it: at 23 accounts × 3 rounds/day that is ~25k threads/year, still trivial for one `--resume` lookup but unbounded. Retention belongs with whoever adds the scheduler, not with the lookup. | neutral | `graph/leases.py`, `graph/checkpoint.py` |
| 25 | **The cycle snapshots `memory.md` BEFORE acquiring the lease; Bash reads it after `acquire_lock`.** `cli.py` builds the whole `CycleDeps` — including `memory_text` — and hands it to `run_cycle`, which only then takes both leases; `auto-run.sh` acquires its lock first and reads the file inside. So a Python cycle that loses the acquire race read a `memory.md` it then discards (harmless), and one that WINS it may hold a snapshot taken microseconds before a losing Bash round released the file it had been appending to. Bounded and benign in practice: the only writer of another account's `memory.md` is that account's own round, which the lease excludes, and the window is the microseconds between the read and the acquire. It is recorded because "the deps are frozen before the lease" is a structural property someone will later assume the opposite of. | neutral | `cli.py`, `graph/cycle.py` |

### 15.2 Behavioural — unreachable in the current roster

| # | Difference | Why unreachable |
|---|---|---|
| 8 | `get_field` matches `-\s+\*\*` where Bash matches a literal single space, so Python accepts bullets Bash would miss. | No roster file uses anything but one space. |
| 9 | `Username` gets an absent-in-original exemption in the validators that Bash does not give it. | `load_persona` raises `ValueError` when `Username` is missing, so a persona with no `Username` never reaches a validator. |
| 10 | Python's `\s` is Unicode-aware; Bash's `[:space:]` is ASCII-only. | Every real field value is an ASCII token. |
| 14 | A follow answered with a 2xx that is NOT 204 raises `WriteNotVerifiedError` in Python (`Resources.follow` verifies the status explicitly, since the body is empty and there is no id to read back), so it takes the WARN/no-memory branch; Bash's `_curl` accepts any status < 400, so `_remember` runs and the round logs `DONE`. Recorded by ruling R20. Its original wording claimed to be "the only follow-path divergence left"; that superlative was false when written — the `memory/memory` event stream (§15.1 row 13, above) was missing on the follow path too, and on every other write kind — and is removed rather than re-asserted, since nobody had enumerated the space it claimed to cover. | `follows.controller.ts`'s handler is `return noContent(res)` and `noContent` is `res.status(204).end()` — the endpoint has no other 2xx to return. |
| 18 | A `post` memory note is UNBOUNDED: `[img:<topic>]` interpolates `image_topic` with no cap (`_memory_field`, faithfully — `swil.sh:458`'s `${IMAGE_TOPIC:+[img:$IMAGE_TOPIC] }` is uncapped too), while every other shape is bounded at 193 chars (the full `comment | postId= commentId= parentId= | <80>`). Past 500 the `memory/memory` event breaches `summary: z.string().trim().min(1).max(500)` (agents.schemas.ts:55) and the POST 400s. NOT capped on the Python side (ruling R22): Bash is uncapped too and BOTH runtimes swallow that 400 identically (`\|\| true` at swil.sh:246; `Resources.lab_event`'s `except ApiError`), so a cap would be a Python-only divergence making the two runtimes send different bodies for the same action — while `memory.md` itself, which is what the next dream reads, is written identically either way. | Both runtimes lose the same event silently, so the only observable difference would be one this port introduced. No roster `imageTopic` has ever approached 500 chars. |

### 15.3 Cosmetic — no behavioural effect

| # | Item |
|---|---|
| 11 | `[tool.ruff] extend-exclude = ["scripts"]` is gitignore-style and unanchored, so it would also match a nested `scripts/` directory. No collision exists today; tighten to `/scripts` when that config is next touched. |
| 12 | `Settings.model_config` restates pydantic-settings' own defaults for `env_file_encoding` and `case_sensitive`. |
| 13 | `Persona.model_config = ConfigDict(arbitrary_types_allowed=True)` is redundant — pydantic v2 supports `Path` natively. |
| 15 | `resolve_anchor_text` reads through `Path.read_text`, which applies universal-newline translation, so a `personality.md` / `personality.anchor.md` saved with CRLF hashes as if it had LF while Bash's `cat` preserves the `\r`. The two runtimes would then compute different anchor cache keys. No roster file has CRLF today (all 23 are LF), which is why this sits here rather than in §15.1; it would become behavioural the day one is edited on Windows. |
| 16 | `swil-agent act --dry-run` calls `_attach_round_log`, so it CREATES an empty `agent/logs/auto-run.log` if none exists, even though a dry run writes no line to it. Harmless (an empty file greps the same as no file) and deliberate — moving the attach below the dry-run branch would put logging setup after the code that logs. |
| 17 | `Resources.lab_event` catches `ApiError` only, so the two httpx exceptions that are NOT `HTTPError` subclasses — `CookieConflict` and `InvalidURL` — would escape it and exit the round 75 with `SKIP … UNEXPECTED`, where Bash's `\|\| true` swallows everything. Every failure a real server can produce (4xx, 5xx, empty body, non-JSON, timeout, connection refused, DNS) IS covered, since `ApiClient` already wraps those as `ApiError`/`TransportError`. Pre-existing to `ApiClient` rather than introduced by the act/dream port, and low-reachability (the username is validated before it reaches the URL). Left as-is late in the branch; the sibling case in `api/images.py` — where `InvalidURL` genuinely WAS reachable via a tab in `imageTopic` — was fixed under ruling R22. |

### 15.4 Two tests that name a behaviour they cannot detect

Recorded so a later reader does not mistake them for coverage:

- `test_extract_strips_code_fences` cannot detect removal of the fence-stripping
  calls, because backticks are inert to the brace/quote walker. A separate prose
  test covers fences on a path where they matter.
- `test_control_field_absent_from_original_is_not_a_failure` does not catch a
  bare-equality mutant, because original and candidate are identical in that
  fixture, so `None == None` either way.

### 15.5 Two FROZEN SCRIPTS that disagree with each other — do not "deduplicate" the ports

Not a Bash↔Python divergence. `rule-check.sh` and `behavior-snapshot.sh` both
extract a post's body as "the original-language text, falling back to the
translated one", and they **implement that differently**. The ports reproduce
each script's own semantics, so `analysis/rule_check.py` and
`analysis/behavior_snapshot.py` deliberately do NOT share a helper.

- `rule-check.sh:59` is embedded Python: `p.get('originalText') or p.get('text') or ''`.
- `behavior-snapshot.sh:65` is jq: `(.originalText // .text)`, then a
  not-all-whitespace `select`.

jq's `//` falls back only on `null` and `false` — **an empty string is truthy in
jq**. So for an item with `originalText: ""` and `text: "hello"`:

| | `originalText` | `text` | result |
|---|---|---|---|
| `rule-check.sh` (Python `or`) | `""` | `"hello"` | `"hello"` |
| `behavior-snapshot.sh` (jq `//`) | `""` | `"hello"` | **dropped entirely** |

The obvious tidy-up — one shared `extract_posts` — silently picks the `or`
semantics for both, which feeds **translated** text into the behaviour vector.
That is the one thing `behavior-snapshot.sh:57-58`'s own comment exists to
prevent: the fidelity number is a comparison against a persona written in the
original language, and mixing the translation layer into one half of it moves
the number for a reason that has nothing to do with the agent.

Pinned in both directions (`test_an_empty_original_text_does_not_fall_back_to_text`,
`test_a_false_original_text_falls_back_to_text`), and both module docstrings say
why. Found in Plan 4 Task 2; recorded here because it is not self-evident from
reading either module alone, and the refactor that breaks it looks like an
obvious cleanup.

### 15.6 NOT a divergence — both runtimes handed the persona LLM write access to the repo (fixed 2026-08-19)

Found by the Stage 5 cutover round, not by review, and recorded here because
anyone reading §15 for "what differs between the runtimes" would otherwise
conclude this was one. It was not: Bash and Python had the identical hole, and
Bash had it first.

**The hole.** Every persona-facing LLM call ran `claude -p … --output-format
text` with no tool restriction. `claude -p` is the full Claude Code agent, and
from this repo's working directory its `Write` tool takes no permission prompt.
So the model could put its answer on disk instead of returning it — which means
the constitution layer (archive → drift gate → structural validators → `/lab`
snapshot) was a gate only for models that chose to answer in text. The codex
branch was the same shape by a different flag: `--full-auto` is
`-s workspace-write` plus auto-approval.

**What it did, in the one round that looked.** Two of ~19 dreams used `Write`:

- `agent/humans/maobian/personality.md` was replaced by a candidate that passed
  no gate. `personality.archive.md` was untouched, so the reversibility
  guarantee ("any dream is reversible by hand") did not hold either. The
  runtime then logged `LLM returned empty` — accurate: the turn went to the
  tool call — and `keeping original`, over an original that was already gone.
- `agent/humans/fenziys/` was created for an account that lives under
  `agents/`. Inert *this* time only because `_find_dir` checks `agents/` first;
  the mirror case silently retires a real `humans/` account.

Confirmed from the CLI's own transcripts (two `Write` tool_use records under
`~/.claude/projects/<repo>/`, timestamps matching both files' mtimes), then
reproduced deliberately.

**Fix.** `--tools ""` on every claude-family call and `-s read-only` on every
codex call, in both runtimes — eight sites, because three of the Bash ones
(`dream.sh`'s aspect distiller, `benchmark-run.sh`'s judge, `llm.sh`'s deepseek
branch) build their argv independently of `llm_text` and drift apart otherwise.
`-o` on `codex exec` is written by the CLI, not the model, so read-only still
returns output.

**Why Bash gets the fix too, even after cutover.** `SWIL_RUNTIME=bash` is the
Stage 5 rollback. A rollback path that re-opens a data-integrity hole is not a
rollback path.

Full account: `2026-08-19-stage-5-cutover.md` §7.

---

### 15.7 INTRODUCED after cutover — the Bash rollback records none of Phase B's calibration series (Phase B, from 2026-08-19)

The divergences this project has added on purpose since Stage 5, rather than
inherited from the port. They are recorded here and not only in the Phase B
plan because the register is what an operator consults when a round's data
looks wrong, and because the Bash scripts these rows name are FROZEN, so none
of them will be closed by porting the missing behaviour back.

Row 26 is the DREAM path's drift measurement (task 1); rows 27 and 28 are both
on the ACT path — its self-similarity sample (task 2) and its read scope
(task 3). They are independent series feeding independent calibration gates,
and a Bash round loses every one of them. (Rows are identified by the `#`
column, not by their order in the table below.)

**Row 28 is not the same KIND of divergence as 26 and 27, and it is worse.**
Those two are missing observations: the round Bash runs is the round Python
runs, minus a record of it. Row 28 changes the round. Once the `Read`
assignment lands, a Bash rollback round for a niched account reads
`/feed/global` — the shared slice the whole intervention exists to get that
account off — while its `personality.md` says it is in the treatment arm. The
account does not merely go unrecorded; it is silently returned to the control
condition, and its posts, its dream and its drift all come from an input the
experiment says it was not given. Until the assignment lands, the two runtimes
read identically and this row is latent.

| # | Difference | Direction | Where |
|---|---|---|---|
| 28 | Python's act path takes its READ SCOPE from the persona's `Read` bullet: `Read: <slug>` reads `/feed/board/{slug}` on both feed passes and, with probability `CROSS_READ_PROB` (0.15), a different board instead; it then files a `cycle`/`act` lab event (`summary="read its own board"` / `"cross-read another board"`) carrying `{boardRead, homeBoard, crossRead, crossReadProb, boardItems}`. `auto-run.sh` calls `/feed/global` unconditionally for every account and files nothing. So a rollback round for a NICHED account does not merely omit a record — it reads the wrong feed, silently returning a treatment-arm account to the control condition for that round. Latent until the `Read` assignment lands; identical in both runtimes before that, since 22 of 23 accounts carry no `Read` bullet. | Python-only capability; Bash silently omits AND diverges in behaviour | `act/context.py`'s `choose_read_scope` / `read_feed` and `act/round.py`'s `record_board_read`, called from `context_step`, vs `auto-run.sh`'s two `/feed/global` reads |
| 27 | Python's act path embeds the round's candidate post together with the account's own 12 most recent posts and files a `cycle`/`act` lab event (`summary="act self-similarity measured"` / `"...not computed"`) carrying `{maxSim, comparedAgainst, embedderOk, window}`. `auto-run.sh` does neither — it has no notion of the account's own recent posts at act time and makes no `/embed` call anywhere on the act path (its only embedder contact is `behavior-snapshot.sh` at `:806`, AFTER the writes, embedding all recent posts as one joined document). So a round run through the documented rollback path contributes NOTHING to the act-similarity series — not a row with nulls, no row at all — and `maxSim` does not exist under Bash in any form. | Python-only capability; Bash silently omits | `act/round.py`'s `similarity_step`, called from `execute_step`, vs `auto-run.sh`'s execute loop |
| 26 | Python's dream gate embeds a THIRD document (the current `personality.md`, alongside the anchor and the candidate) and posts a `dream/dream/success` lab event with `summary="drift measured"` carrying `{anchorSim, stepSim, aspectValues, aspectStyle, aspectTopic, embedderOk, driftMode}`. `dream.sh` does neither. So a round run through the documented rollback path contributes NOTHING to the calibration series — not a row with null values, no row at all — and `stepSim` does not exist under Bash in any form. | Python-only capability; Bash silently omits | `dream/gate.py`'s `_whole_document_similarities`, `dream/round.py`'s `gate_step` vs `dream.sh:742-749` |

**Row 27's own version of the same argument.** Its series is the sole input to
Phase B's calibration gate 2, which sets the act-path repetition threshold —
the guard that does not exist yet precisely because nobody knows the
distribution. A Bash window there is worse than a Bash window in the drift
series in one specific way: an absent act-similarity row is
indistinguishable from a round that *posted nothing*, since a comment-only,
like-only or `nothing` round legitimately files no row either. Under the
Python runtime those two are separable (a posting round always files a row,
`skip` or `success`); under a rollback they are not. Note the date range in
`docs/13-observation-lab.md` and this distinction is recoverable; leave it out
and the sample is quietly biased toward whatever the accounts that happened to
run under Python were saying.

**Row 28's version, which does not reduce to a note in a change-point list.**
For 26 and 27 the remedy is bookkeeping: write down when the rollback ran and
the gap is legible. For 28 the round itself was the wrong round, and no note
recovers the posts an account would have written off its own board. The
operational rule that follows is narrower than "note the date range": once the
`Read` assignment lands, **do not run `SWIL_RUNTIME=bash` for an account whose
`Read` names a board.** If the rollback has to be exercised roster-wide, the
honest reading is that those rounds are control-arm rounds for every account,
and they should be excluded from the treatment arm's series rather than
annotated in it.

**Why it matters more than "Bash logs one line fewer".** The series this event
feeds is the sole input to Phase B's calibration gate 1, which sets the step
gate's threshold. A window of rounds run under `SWIL_RUNTIME=bash` is not a
window of low-drift rounds and is not a window of failed measurements — it is a
window that is simply absent, and absence is indistinguishable from "that
account did not dream" unless someone knows the rollback happened. A threshold
fitted across such a window is fitted to a biased sample, which is the exact
defect (a censored series) that task 1 existed to end.

**Why none of these is being fixed by porting it to Bash.** `agent/scripts/*.sh` is
frozen; Phase A's whole point was to stop maintaining two runtimes, and Stage 5
made Python the runtime of record. Adding a third `_embed_text` call and a
seventh `_post_agent_event` to `dream.sh` would re-open the two-implementations
problem for a script nobody is expected to run again — and row 27 would cost
more than that: `auto-run.sh` has no `/embed` call on its act path at all (its
only embedder contact is `behavior-snapshot.sh` at `:806`, after the writes),
so porting it means giving the frozen script a new capability, not restoring a
missing line. Row 28 is the same shape again and larger: `auto-run.sh` would
need a persona-field parse, a second feed endpoint, an RNG draw and a
`/boards` lookup — the entire mechanism, not an observation of it.

**What to do instead.** Treat a Bash round as a gap in the series, and say so
where the gap is read: if the rollback is ever exercised, note the date range in
`docs/13-observation-lab.md`'s change-point list, so the analyst reading the
calibration data sees it without having to reconstruct it from `git log`.

Contrast with §15.6, deliberately: there, Bash got the fix precisely BECAUSE
the rollback path must not re-open a data-integrity hole. The rule is not "Bash
always gets the fix" — it is that a rollback must never make things *unsafe*.
§15.6 was a write-access hole (unsafe). This is a missing observation (a gap,
and a knowable one). Those warrant different answers.
