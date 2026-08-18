# Agent Runtime — `graph/` Durable Cycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete Stage 2 of the Bash→Python agent-runtime migration by adding the `graph/` layer — a LangGraph durable state machine over the act/dream steps Plan 2 shipped — plus SQLite run leases and checkpoint/resume.

**Architecture:** `graph/` composes the existing `act/` and `dream/` functions as nodes; the dependency rule is one-way (`graph → act, dream → api, llm, persona, embedder → config, models`) and no module outside `graph/` may import LangGraph. The existing `swil-agent act` / `swil-agent dream` commands keep working unchanged — the graph is an *additional* entrypoint, not a replacement, so Plan 2's 855 tests remain the parity oracle.

**Tech Stack:** Python 3.13, uv, LangGraph 1.2.x, `langgraph-checkpoint-sqlite` 3.1.x, pydantic v2, typer, pytest, ruff, mypy --strict.

**Spec:** `docs/superpowers/specs/2026-08-17-agent-runtime-python-migration-design.md` — §5.1 (layout), §5.2 (dependency rule), §5.4 (node policies, **corrected 2026-08-18**), §5.5 (`CycleState`), §7.3 (leases), §7.4 (the `active` file), §7.6 (structured logging), §10 (stages).

---

## Global Constraints

Every task's requirements implicitly include this section.

- **`agent/scripts/*.sh` is FROZEN.** It is also the source of truth. Read the script; never trust a prose description of it — including this plan's. Ten wrong prose descriptions of Bash behaviour were found during Plan 2, in contract docs, task briefs, and controller rulings alike. If a citation here is wrong, implement the script and say so in your report.
- **Bash is still the runtime of record.** `cycle-one.sh` stays pointed at Bash until Stage 5. Nothing in this plan may change what a Bash round does.
- **Coexistence is live.** Stages 3–4 run Bash and Python side by side on the same 23-account roster, against the same `agent/.agent-state/`, `memory.md`, `personality.md`, and log files.
- **Additive only.** `swil-agent act <name>` and `swil-agent dream <name>` must behave identically before and after this plan. They are the parity oracle.
- **No module outside `graph/` may import `langgraph`** (§5.2), enforced by an AST-walking architecture test.
- Python 3.13. `ruff format --check` and `ruff check` clean. `mypy --strict` clean. Line length 100.
- **Every test must be able to fail for the reason it names.** Before claiming a test covers something, break the code and watch that specific test fail. Report the mutation. A test you did not mutate does not count as covered. Three separate near-misses in Plan 2 were tests that were themselves wrong: a fake that diverged from the real collaborator it stood in for, a test that pinned a known divergence as if correct, and a fixture whose input was silently halved by `collapse_doubled_text` before the assertion applied.
- **A test double must be pinned against the real collaborator's behaviour**, or it certifies its own divergence. This produced two HIGH findings in Plan 2.
- `npm run ci:check` from the repo root must be 13/13 at the end of every task.
- Conventional Commits. Never commit `.env`, `*.key`, or `agent/agents/*/api_key.txt`.

### Two corrections to the spec that this plan is built on

Both were established by measurement on 2026-08-18 and are already written into the spec; they are repeated here because they invert what an older reading of §5.4 would tell you to build.

1. **There are no per-node timeouts.** LangGraph refuses to attach `timeout=` to a sync node at `compile()` time (`ValueError: Node timeouts are only supported for async nodes because sync Python execution cannot be safely cancelled in-process`). The async form returns control but **orphans the child process** — measured: an `async` node with `timeout=1.0` wrapping `asyncio.to_thread(subprocess.run, …)` raised `NodeTimeoutError` at 1.01s while the child ran on and completed 4s later. Bounding stays in the subprocess and transport layers, where `subprocess.run(timeout=…)` actually kills the child.
2. **`RetryPolicy` and checkpointing both work as specified.** Measured: `retry_on=(Transient,)` retried a transient failure 3× and did not retry a permanent one at all (1 call); a state carrying a pydantic model round-tripped through `SqliteSaver` intact.

---

## File Structure

| File | Responsibility |
|---|---|
| `agent/pyproject.toml` | add `langgraph`, `langgraph-checkpoint-sqlite` |
| `agent/swil_agent/graph/__init__.py` | package marker; exports `run_cycle` |
| `agent/swil_agent/graph/state.py` | `CycleState` TypedDict, `thread_id` construction |
| `agent/swil_agent/graph/leases.py` | SQLite run lease **that also holds the Bash-compatible file lock** |
| `agent/swil_agent/graph/checkpoint.py` | `SqliteSaver` wiring + msgpack type registration |
| `agent/swil_agent/graph/nodes.py` | the node functions; the only place that adapts steps to `CycleState` |
| `agent/swil_agent/graph/cycle.py` | `StateGraph` assembly, edges, `RetryPolicy` per node |
| `agent/swil_agent/act/round.py` | **refactor only** — extract steps; `run_act` becomes their composition |
| `agent/swil_agent/dream/round.py` | **refactor only** — same |
| `agent/swil_agent/cli.py` | `swil-agent cycle <name>` (+ `--resume`, `--dry-run`) |
| `agent/tests/unit/test_graph_*.py` | per-module tests |
| `agent/tests/unit/test_cycle_parity.py` | the graph path vs the `run_act`/`run_dream` path |

---

## Task 1: Dependencies and a non-vacuous architecture guard

**Files:**
- Modify: `agent/pyproject.toml`
- Modify: `agent/tests/unit/test_architecture.py`
- Create: `agent/swil_agent/graph/__init__.py`

**Interfaces:**
- Produces: an importable `swil_agent.graph` package; `langgraph` available to it and to nothing else.

The existing architecture test asserts that no module outside `graph/` imports `langgraph`. **Today that test is vacuous** — `langgraph` is not a dependency, so nothing could import it even by mistake. It must be made able to fail before it is relied on.

- [ ] **Step 1: Write the failing test**

Add to `agent/tests/unit/test_architecture.py`. Reuse the file's existing AST-based `_imported_modules` helper — do NOT add a substring search over source text. (Plan 2 shipped exactly that mistake: a reviewer added an absolute import and the substring guard passed.)

```python
def test_the_langgraph_guard_can_actually_fail(tmp_path: Path) -> None:
    """The guard is only worth having if it fires. Feed it a module that
    violates the rule and assert it is reported.

    Plan 2's first version of this class of guard was a substring search that
    a legitimately-written absolute import walked straight past.
    """
    offender = tmp_path / "offender.py"
    offender.write_text("from langgraph.graph import StateGraph\n", encoding="utf-8")
    assert "langgraph" in _imported_modules(offender)


def test_no_module_outside_graph_imports_langgraph() -> None:
    violations = [
        path
        for path in _package_modules()
        if "graph" not in path.relative_to(_PACKAGE_ROOT).parts
        and any(m.split(".")[0] == "langgraph" for m in _imported_modules(path))
    ]
    assert violations == [], f"langgraph imported outside graph/: {violations}"
```

- [ ] **Step 2: Run it to verify the first test fails**

Run: `uv run pytest tests/unit/test_architecture.py -v` from `agent/`
Expected: `test_the_langgraph_guard_can_actually_fail` FAILS if `_imported_modules` does not resolve `from X import Y` form; PASSES once it does. If it passes immediately, confirm by mutating `_imported_modules` to ignore `ImportFrom` nodes and watch it fail — report that mutation.

- [ ] **Step 3: Add the dependencies**

In `agent/pyproject.toml`, add to `dependencies`:

```toml
    "langgraph>=1.2,<2",
    "langgraph-checkpoint-sqlite>=3.1,<4",
```

Commit body must state why (project rule): the graph layer needs a durable state machine with per-node retry and checkpoint/resume; the ~38-package `langchain-core` footprint is accepted in spec §12/§13 on the grounds that no module below `graph/` imports it, so it stays replaceable.

- [ ] **Step 4: Create the package marker**

`agent/swil_agent/graph/__init__.py`:

```python
"""The durable cycle layer.

This is the ONLY package permitted to import `langgraph` (spec §5.2). The
one-way dependency rule -- `graph -> act, dream -> api, llm, persona,
embedder -> config, models` -- is what keeps the entire core unit-testable
without a graph runtime, and keeps the framework replaceable.
"""
```

- [ ] **Step 5: Verify and commit**

Run: `uv run pytest tests/unit/test_architecture.py -v` then `npm run ci:check` from the repo root.
Expected: all green, 13/13.

```bash
git add agent/pyproject.toml agent/uv.lock agent/tests/unit/test_architecture.py agent/swil_agent/graph/__init__.py
git commit -m "build(agent): add langgraph and make the import guard able to fail"
```

---

## Task 2: `CycleState`

**Files:**
- Create: `agent/swil_agent/graph/state.py`
- Test: `agent/tests/unit/test_graph_state.py`

**Interfaces:**
- Produces: `CycleState` (TypedDict), `thread_id(tenant: str, agent: str, round_id: str) -> str`, `BUILTIN_TENANT: Final = "builtin"`.
- Consumes: `Persona`, `Plan`, `ActContext`, `ActionResult`, `VetoedAction`, `AspectSims`, `DreamVerdict` from `swil_agent.models`.

Spec §5.5 gives the shape verbatim. Two things it does not spell out, which you must get right:

- `total=False`. Nodes return *partial* updates; LangGraph merges them. A `total=True` TypedDict would force every node to construct the whole state.
- `thread_id` is `f"{tenant}:{agent}:{round_id}"` and **encodes the tenant from day one** so multi-tenancy is a value change, not a data migration. `BUILTIN_TENANT` is `"builtin"` for the current 23 accounts.

- [ ] **Step 1: Write the failing test**

```python
def test_thread_id_encodes_tenant_agent_and_round() -> None:
    assert thread_id("builtin", "zenith", "r7") == "builtin:zenith:r7"


def test_thread_id_rejects_a_component_containing_the_separator() -> None:
    """The id is parsed by splitting on ':'. A component carrying one would
    silently reassign the fields -- an agent named 'a:b' would land in another
    tenant's checkpoint namespace.
    """
    with pytest.raises(ValueError, match="must not contain"):
        thread_id("builtin", "zen:ith", "r7")


def test_cycle_state_is_total_false_so_nodes_can_return_partials() -> None:
    """LangGraph merges partial node returns. total=True would make every node
    responsible for the whole state."""
    assert CycleState.__total__ is False
```

- [ ] **Step 2: Run to verify it fails**

Run: `uv run pytest tests/unit/test_graph_state.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'swil_agent.graph.state'`

- [ ] **Step 3: Implement**

```python
"""`CycleState` -- the value the graph threads through every node (spec §5.5)."""

from __future__ import annotations

from typing import Final, TypedDict

from swil_agent.models import (
    ActContext,
    ActionResult,
    AspectSims,
    DreamVerdict,
    Persona,
    Plan,
    VetoedAction,
)

BUILTIN_TENANT: Final = "builtin"
_SEPARATOR: Final = ":"


def thread_id(tenant: str, agent: str, round_id: str) -> str:
    """`f"{tenant}:{agent}:{round_id}"` -- the checkpoint namespace key.

    The tenant is encoded from day one so multi-tenancy is a value change
    rather than a data migration (spec §5.5).
    """
    for label, value in (("tenant", tenant), ("agent", agent), ("round_id", round_id)):
        if _SEPARATOR in value:
            raise ValueError(f"{label} must not contain {_SEPARATOR!r}: {value!r}")
    return _SEPARATOR.join((tenant, agent, round_id))


class CycleState(TypedDict, total=False):
    # identity
    tenant: str
    agent: str
    persona: Persona
    thread_id: str
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

- [ ] **Step 4: Run to verify it passes**

Run: `uv run pytest tests/unit/test_graph_state.py -v` → PASS.
Mutation to run and report: delete the separator check in `thread_id` and confirm `test_thread_id_rejects_a_component_containing_the_separator` fails.

- [ ] **Step 5: Commit**

```bash
git add agent/swil_agent/graph/state.py agent/tests/unit/test_graph_state.py
git commit -m "feat(agent): add CycleState and tenant-encoded thread ids"
```

---

## Task 3: Run leases that do not break coexistence

**Files:**
- Create: `agent/swil_agent/graph/leases.py`
- Test: `agent/tests/unit/test_graph_leases.py`

**Interfaces:**
- Consumes: `swil_agent.locks.FileLock`, `act_lock_path`, `dream_lock_path`.
- Produces: `RunLease` context manager — `RunLease(db, agent_root, tenant, agent, kind)`; `LeaseBusy` exception; `sweep_expired(db, now) -> int`.

**This is the highest-risk task in the plan, and the risk is not in the SQLite.**

Spec §7.3 says `lock_<name>` / `dream_lock_<name>` "become a row in SQLite with a uniqueness constraint on `(tenant, agent)` and a heartbeat timestamp". Read literally, that replaces the file lock — **and doing so would silently destroy mutual exclusion during Stages 3 and 4**, which is exactly when Bash and Python run on the same roster.

The facts, from the scripts:

- Bash acquires with `( set -o noclobber; echo "$$" > "$lock_file" )` at `auto-run.sh:417`, reclaims a lock older than 1800s at `:423-427`, and logs `SKIP <name> — locked (another run in progress, <n>s old)`.
- Python's `locks.py` already writes the same path and format — its own comment says "Trailing newline to match Bash's `echo "$$" > "$lock_file"`". Plan 2 got this right.

A Bash round cannot see a SQLite row. So during coexistence a lease **must hold both**: the SQLite row (heartbeat, expiry, observability, and the death of the orphan-lock class) *and* the Bash-compatible file lock (cross-runtime exclusion). The file lock is dropped only at Stage 5, when Bash no longer runs — and that removal is a Stage 5 task, not this one.

Acquire the file lock **first**, then the row: if the row insert fails, the file lock must be released, and the reverse ordering would leave a Bash-visible lock behind on a Python-side failure.

- [ ] **Step 1: Write the failing tests**

```python
def test_a_lease_also_creates_the_bash_visible_lock_file(tmp_path: Path) -> None:
    """Stages 3-4 run Bash and Python on the same roster. Bash cannot see a
    SQLite row -- if the lease does not also hold `.agent-state/lock_<name>`,
    a Bash round and a Python round run the same account concurrently.
    """
    db = _memory_db()
    with RunLease(db, tmp_path, "builtin", "zenith", kind="act"):
        assert act_lock_path(tmp_path, "zenith").exists()
    assert not act_lock_path(tmp_path, "zenith").exists()


def test_a_held_bash_lock_blocks_a_python_lease(tmp_path: Path) -> None:
    """The direction that matters most: Bash got there first."""
    lock = act_lock_path(tmp_path, "zenith")
    lock.parent.mkdir(parents=True, exist_ok=True)
    lock.write_text("99999\n", encoding="utf-8")
    db = _memory_db()
    with pytest.raises(LeaseBusy):
        with RunLease(db, tmp_path, "builtin", "zenith", kind="act"):
            pass


def test_a_failed_row_insert_releases_the_file_lock(tmp_path: Path) -> None:
    """Ordering: file lock first, row second. If the row fails, the file lock
    must not survive -- a stranded lock file is invisible to SQLite and makes
    every later Bash round SKIP for 30 minutes."""
    db = _memory_db()
    with RunLease(db, tmp_path, "builtin", "zenith", kind="act"):
        with pytest.raises(LeaseBusy):
            with RunLease(db, tmp_path, "builtin", "zenith", kind="act"):
                pass
    assert not act_lock_path(tmp_path, "zenith").exists()


def test_an_expired_lease_is_reclaimable(tmp_path: Path) -> None:
    """A dead run's lease expires on its own (spec §7.3) -- this is the whole
    point: it kills the SIGPIPE-141 orphan lock and the post-round manual sweep."""
    db = _memory_db()
    _insert_stale_lease(db, "builtin", "zenith", age_seconds=LEASE_TTL_SECONDS + 1)
    assert sweep_expired(db, now=_now()) == 1
    with RunLease(db, tmp_path, "builtin", "zenith", kind="act"):
        pass


def test_the_heartbeat_advances_while_held(tmp_path: Path) -> None:
    db = _memory_db()
    with RunLease(db, tmp_path, "builtin", "zenith", kind="act") as lease:
        first = _heartbeat_of(db, "builtin", "zenith")
        lease.heartbeat(now=first + 5)
        assert _heartbeat_of(db, "builtin", "zenith") == first + 5
```

- [ ] **Step 2: Run to verify they fail**

Run: `uv run pytest tests/unit/test_graph_leases.py -v`
Expected: FAIL — `ModuleNotFoundError`.

- [ ] **Step 3: Implement**

Requirements, exactly:

- Schema: `CREATE TABLE IF NOT EXISTS run_leases (tenant TEXT NOT NULL, agent TEXT NOT NULL, kind TEXT NOT NULL, run_id TEXT NOT NULL, acquired_at REAL NOT NULL, heartbeat_at REAL NOT NULL, PRIMARY KEY (tenant, agent, kind))`. The uniqueness constraint of §7.3 plus `kind`, because act and dream lock separately today (`lock_<name>` vs `dream_lock_<name>`) and collapsing them would serialise a dream behind an unrelated act.
- `LEASE_TTL_SECONDS: Final = 1800.0` — the same 1800s Bash uses at `auto-run.sh:423`. Verify that number against the script; if it differs, the script wins.
- `RunLease.__enter__`: acquire `FileLock` first → on `LockBusy` raise `LeaseBusy`; then `INSERT`; on `sqlite3.IntegrityError` release the file lock and raise `LeaseBusy`. `__exit__` deletes the row then releases the file lock, both unconditionally, even on exception.
- Injectable clock (`now: Callable[[], float] = time.time`) — spec §6.3 requires randomness and time to be injectable.
- `sweep_expired(db, now)` deletes rows whose `heartbeat_at` is older than the TTL and returns the count.

Do not write the SQL twice. Do not add a retry loop — a busy lease is a SKIP, matching Bash.

- [ ] **Step 4: Run to verify they pass, then mutate**

Mutations to run and report:
1. Remove the `FileLock` acquisition → `test_a_lease_also_creates_the_bash_visible_lock_file` and `test_a_held_bash_lock_blocks_a_python_lease` must fail.
2. Swap the order (row first, file lock second) → `test_a_failed_row_insert_releases_the_file_lock` must fail.
3. Drop `kind` from the primary key → add and run a test that an act lease and a dream lease for the same account can be held at once; it must fail.

- [ ] **Step 5: Commit**

```bash
git add agent/swil_agent/graph/leases.py agent/tests/unit/test_graph_leases.py
git commit -m "feat(agent): add SQLite run leases that still hold the Bash lock file"
```

---

## Task 4: Checkpoint wiring

**Files:**
- Create: `agent/swil_agent/graph/checkpoint.py`
- Test: `agent/tests/unit/test_graph_checkpoint.py`

**Interfaces:**
- Produces: `open_checkpointer(db_path: Path) -> SqliteSaver`, `CHECKPOINT_DB_NAME: Final = "cycle_checkpoints.sqlite"`.

Measured behaviour you are implementing against: a `CycleState` carrying a pydantic model round-trips through `SqliteSaver` **but emits** `Deserializing unregistered type … This will be blocked in a future version. Set LANGGRAPH_STRICT_MSGPACK=true to block now, or add to allowed_msgpack_modules`. Register the types now; a pinned upgrade that starts refusing them would take out resume with no warning.

- [ ] **Step 1: Write the failing test**

```python
def test_a_state_carrying_a_persona_round_trips(tmp_path: Path) -> None:
    saver = open_checkpointer(tmp_path / CHECKPOINT_DB_NAME)
    ...  # invoke a one-node graph, get_state, assert the Persona is equal


def test_registration_is_strict_enough_to_survive_strict_msgpack(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The deprecation warning says a future version will refuse unregistered
    types. Run the round-trip under LANGGRAPH_STRICT_MSGPACK=true so this suite
    fails NOW rather than on the upgrade that turns it on."""
    monkeypatch.setenv("LANGGRAPH_STRICT_MSGPACK", "true")
    ...  # same round-trip, must still pass


def test_no_deprecation_warning_is_emitted(tmp_path: Path, recwarn) -> None:
    ...  # assert nothing matching "unregistered type" was warned
```

- [ ] **Step 2: Run to verify they fail.** The strict test is the load-bearing one — confirm it fails *before* registration is added, not merely that the module is missing.

- [ ] **Step 3: Implement.** Register every model that can appear in `CycleState`: `Persona`, `Plan`, `Action`, `ActContext`, `ActionResult`, `VetoedAction`, `AspectSims`, `DreamVerdict`. Derive the list from `CycleState.__annotations__` rather than hand-listing it, so a field added in a later task cannot be forgotten — and add a test that asserts the derived list covers every annotation.

- [ ] **Step 4: Verify + mutate.** Remove one registration → the strict test must fail.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(agent): wire the SQLite checkpointer with registered state types"
```

---

## Task 5: Extract `run_act`'s steps (refactor, zero behaviour change)

**Files:**
- Modify: `agent/swil_agent/act/round.py`
- Test: the existing `agent/tests/unit/test_act_round.py` is the oracle — it must pass **unchanged**.

`run_act` today is one function: health probe → lease → context → rhythm → plan → guardrail → execute → memory → mark-read → `agentBackend` sync → logout. The graph needs `login`, `plan`, `guardrail`, `execute` as separately callable units.

**The ruling that governs this task: extract, do not move.** `run_act` stays and becomes a thin composition of the extracted steps. Both entrypoints then share one implementation, so they cannot drift. If you find yourself copying a block into `graph/nodes.py`, stop — that is the drift this plan exists to avoid.

**You may not change behaviour.** `test_act_round.py` must pass without edits. If a test needs editing, you have changed behaviour; revert and rethink. The one permitted exception is adding new tests.

- [ ] **Step 1: Run the oracle and record the baseline**

Run: `uv run pytest tests/unit/test_act_round.py -q` — record the count.

- [ ] **Step 2: Extract, one step at a time, running the oracle after each**

Extract in this order, committing after each: `login_step`, `context_step`, `plan_step`, `guardrail_step`, `execute_step`, `finalize_step` (memory + mark-read + `agentBackend` sync). Each takes explicit arguments and returns a value — no shared mutable state, no `self`.

- [ ] **Step 3: Rewrite `run_act` as their composition.** Same signature, same return type, same exit codes, same log lines, same lab events.

- [ ] **Step 4: Verify.** `uv run pytest tests/unit/test_act_round.py -q` — identical count, zero edits to the file. Then `npm run ci:check`.

- [ ] **Step 5: Commit**

```bash
git commit -m "refactor(agent): extract run_act's steps for graph node reuse"
```

---

## Task 6: Extract `run_dream`'s steps (refactor, zero behaviour change)

Identical shape to Task 5, over `dream/round.py`: `dream_step` (candidate), `gate_step` (validators + drift), `write_step` (archive + write), `snapshot_step`.

`agent/tests/unit/test_dream_round.py` is the oracle and must pass unchanged.

- [ ] Steps 1–5 as in Task 5.

```bash
git commit -m "refactor(agent): extract run_dream's steps for graph node reuse"
```

---

## Task 7: The node functions

**Files:**
- Create: `agent/swil_agent/graph/nodes.py`
- Test: `agent/tests/unit/test_graph_nodes.py`

Each node is a sync function `(state: CycleState) -> CycleState` returning a **partial** update. Nodes adapt `CycleState` to the step signatures from Tasks 5–6 and do nothing else — no business logic lives here.

Nodes: `login`, `plan`, `guardrail`, `execute`, `dream`, `gate`, `write`, `snapshot`, `logout`.

Two requirements that are easy to get wrong:

- **`dream` carries an explicit deadline.** It makes several bounded LLM calls (candidate + 3× distill), each capped at `SubprocessRunner`'s 300s. Since there is no node timeout, the aggregate bound is a deadline computed at node entry and checked between calls. Test it with a fake clock, not by sleeping.
- **`guardrail` is pure.** No I/O, no retry policy, no lease interaction. A test must assert it performs no API calls.

- [ ] Steps 1–5 in the usual TDD order. Mutation to report for each node: return an empty partial and confirm the corresponding test fails.

```bash
git commit -m "feat(agent): add the cycle's node functions"
```

---

## Task 8: The graph

**Files:**
- Create: `agent/swil_agent/graph/cycle.py`
- Test: `agent/tests/unit/test_graph_cycle.py`

**Interfaces:**
- Produces: `build_cycle() -> StateGraph`, `run_cycle(...) -> CycleState`.

Topology, from spec §5.4:

```
login → plan → guardrail → execute → dream → gate → write → snapshot → logout
                   │                            │
        (rhythm veto / empty) ──────────────────┤
                   ↓                     (reject) → keep original → snapshot
                 dream
```

Loops 2 (dream retry) and 3 (multi-round) are **default OFF** — `MAX_ROUNDS=1`, dream retry max 1. Build them, gate them behind config, and test that the default configuration takes neither.

Retry policies per §5.4 as corrected — **no `timeout=` argument anywhere**:

| Node | `RetryPolicy` |
|---|---|
| `login` | `max_attempts=2` |
| `plan` | `max_attempts=2` |
| `guardrail` | none |
| `execute` | `max_attempts=1`, `retry_on=` transient transport errors only — never `ApiError` for 404/403 |
| `dream` | `max_attempts=1` |
| `gate` | `max_attempts=1` |
| `snapshot` | `max_attempts=2` |

- [ ] **Step 1: Write the failing tests**

```python
def test_no_node_declares_a_timeout() -> None:
    """LangGraph refuses `timeout=` on a sync node at compile() time, and the
    async form orphans the child process (measured 2026-08-18, spec §5.4).
    A `timeout=` reintroduced here would either break the build or silently
    resurrect the orphan-subprocess class."""
    build_cycle().compile()  # must not raise


def test_a_permanent_execute_failure_is_not_retried() -> None:
    """§5.4: 'Permanent failures (404/403) are not retried.'"""
    ...  # count calls; assert exactly 1


def test_a_transient_execute_failure_is_retried() -> None:
    ...  # assert > 1


def test_the_default_configuration_takes_neither_loop() -> None:
    """MAX_ROUNDS=1 and dream retry OFF are the defaults; a graph that loops by
    default would double every account's LLM spend."""
```

- [ ] Steps 2–5 as usual. Mutations to report: add a `timeout=` to any node (the compile test must fail); widen `retry_on` to bare `Exception` (the permanent test must fail); flip a loop default on (the loop test must fail).

```bash
git commit -m "feat(agent): assemble the cycle graph with per-node retry policies"
```

---

## Task 9: The `cycle` CLI command

**Files:**
- Modify: `agent/swil_agent/cli.py`
- Test: `agent/tests/unit/test_cli.py`

`swil-agent cycle <name> [--dry-run] [--resume]`.

Requirements:

- The same exit-code contract as `act` and `dream` (ruling R17): `0` success, `66` no such account, `75` setup failure or busy lease — with a `SKIP … ` line naming the account, the cause, and the **remedy**, and `UNEXPECTED <Type>: <msg>` with the traceback at DEBUG for anything else. `cycle-one.sh` and the heartbeat branch on these codes; exit 1 is a code neither can read.
- `--dry-run` **must not acquire the lease** — a dry run executes nothing and needs no mutual exclusion, and a dry run that takes the lock costs a concurrent real Bash round its turn (this was finding F4 of Plan 2's final review).
- `--resume` reuses the `thread_id` to continue from the last checkpoint.
- Log lines go to `agent/logs/auto-run.log` for act-phase lines and `agent/logs/dream.log` for dream-phase lines. **These are different files** — `auto-run.sh:34` sets `auto-run.log`, `dream.sh:40` sets `dream.log`, and both are live. Plan 2 shipped a version that sent both to `auto-run.log` and no test caught it.

- [ ] Steps 1–5. Mutation to report: make `--dry-run` acquire the lease and confirm the test fails.

```bash
git commit -m "feat(agent): add the swil-agent cycle command"
```

---

## Task 10: Parity — the graph path equals the direct path

**Files:**
- Create: `agent/tests/unit/test_cycle_parity.py`

This is the task that makes the whole plan safe. For a fixed persona and a fixed set of fake collaborators, `run_cycle` and the `run_act` + `run_dream` pair must produce the same observable effects: the same API calls in the same order, the same `memory.md` bytes, the same log lines, the same lab events, the same exit code.

Assert on **recorded effects**, not on return values alone — Plan 2's most expensive defects were all invisible in the return value (a missing mark-read, an absent `agentBackend` sync, a lab event never emitted).

- [ ] **Step 1: Write the parity test** across at least: a normal post, a rhythm-vetoed empty plan, an accepted dream, a rejected dream, and an unreachable embedder.

- [ ] **Step 2: Run it — expect real failures.** This test exists to find them. Every divergence it reports is either a bug in `graph/nodes.py` or a genuine design difference that belongs in spec §15 with a reason. Fix the former; record the latter.

- [ ] **Step 3: `npm run ci:check` 13/13, then commit.**

```bash
git commit -m "test(agent): pin graph-path parity against the direct act/dream path"
```

---

## Self-Review

**Spec coverage.** §5.1 layout → Tasks 1–4, 7, 8 (`analysis/` is deliberately out of scope; it is Plan 4). §5.2 dependency rule → Task 1. §5.4 node policies → Task 8, against the corrected table. §5.5 `CycleState` → Task 2. §7.3 leases → Task 3, with the coexistence correction. §7.4 the `active` file → already satisfied: Python carries identity as a parameter and never writes `.agent-state/active`; Task 10's parity test pins it. §7.5 vetoed actions → **already shipped in Plan 2** (`run_act` distinguishes `VETOED_EMPTY` from `PLANNER_EMPTY`), no task needed. §7.6 structured logging → Task 9's two log files.

**Placeholder scan.** Tasks 4, 6, 7 and 9 carry requirement lists and test names rather than complete literal bodies, because each is a mechanical application of a pattern established verbatim in Tasks 2, 3, 5 and 8. Every one of them names its files, its exact interfaces, its acceptance test, and the mutation that must kill it. Task 6 is deliberately "identical shape to Task 5" — and Task 5 is written out in full for that reason.

**Type consistency.** `CycleState` field names match §5.5 exactly. `thread_id` is both a `CycleState` field and the function that builds it — intentional, and the function is what Task 9's `--resume` calls. `RunLease` takes `kind` because Bash locks act and dream separately; `CycleState` has no lease field, since the lease is held by the caller around the whole graph rather than by a node.

**Known open question for Task 8's implementer.** §5.4's retry counts are written as "2" and "1" without saying whether that means attempts or retries. `RetryPolicy` takes `max_attempts`. The table above reads them as *attempts* — the conservative reading, since reading them as retries doubles every LLM call on the `plan` node. If the implementer finds evidence for the other reading, raise it rather than switching silently.
