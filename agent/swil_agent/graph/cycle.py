"""The cycle graph: the nine nodes of spec §5.4 wired together, plus the two
things that wrap a whole run -- the lease and the checkpointer.

```
login → plan → guardrail → execute → dream → gate → write → snapshot → logout
          │        │                   ↑        │
          │        └ (veto / empty) ───┘        └ (reject) → keep original ──┘
          └ (offline / dead backend) ────────────────────────────────→ logout
```

Plus two loops, both **default OFF** (`CycleConfig`): loop 3 sends `execute`
back to `login` for another act round (`max_rounds`), loop 2 sends a rejected
`gate` back to `dream` for one more candidate (`max_dream_attempts`). They are
built rather than omitted so enabling one is a config change instead of a
topology change -- but a graph that loops by DEFAULT doubles every account's
LLM spend, so both defaults are 1 and
`test_the_default_configuration_takes_neither_loop` is what keeps them there.

**Where the business logic is not.** Every decision this module makes about
*whether* something may happen is delegated: "does this outcome still grant a
dream" is `ActResult.grants_dream` (design spec §7.1), constructed here rather
than reimplemented, so the graph and the CLI cannot answer it differently.
What is left is routing.

**The rejected dream is NOT routed around the write.** `gate → write →
snapshot` is unconditional (outside loop 2), because `write_step` and
`snapshot_step` guard INTERNALLY on `verdict.accepted` and `written`. §5.4's
"(reject) → keep original → snapshot" IS that path: `write_step` under a
rejecting verdict keeps the original. Branching here instead would move the
constitution layer's decision into an edge, where deleting the guard costs
nothing and defeating the gate costs one mis-drawn arrow (standing constraint
§5; the same reasoning `run_dream` records for itself).

**No node declares a `timeout=`.** Measured 2026-08-18 (spec §5.4 as
corrected): `compile()` raises `ValueError: Node timeouts are only supported
for async nodes because sync Python execution cannot be safely cancelled
in-process`, and the async form returns control while ORPHANING the child
process -- trading an orphan lock for an orphan subprocess. Bounding lives in
the subprocess and transport layers, where `subprocess.run(timeout=)` actually
kills the child. `test_no_node_declares_a_timeout` fails the build if one
comes back.

**Deps arrive through the runtime context, not through `CycleState`.** The
state is checkpointed (msgpack/SQLite) and an `httpx` client cannot survive
that; the context is per-invocation and is never serialised (verified against
langgraph 1.2.11 -- the checkpoint's metadata carries `parents`/`source`/`step`
and nothing from the context). That is also what lets `build_cycle()` take no
deps at all, so the graph's shape can be compiled and inspected without a
roster.

**One `CycleDeps` per act round, not one per cycle.** `CycleDeps` is frozen and
its `memory_text` / `context_now` / `feed_context` are snapshots taken before
the round. Loop 3 therefore resolves deps through `CycleContext.deps_for_round`
on every node entry, keyed on `round_index`: round 2 gets REBUILT deps, or it
would plan against round 1's `memory.md` and the rhythm gate would let the
account post again over its own ceiling. `run_cycle` refuses `max_rounds > 1`
against a single frozen `CycleDeps` rather than letting that happen quietly.

**The lease wraps the whole cycle, and both halves of it.** A cycle acts AND
dreams, and Bash locks those separately (`lock_<name>`, auto-run.sh:407;
`dream_lock_<name>`, dream.sh:460), so both leases are held for the whole run
-- a `dream.sh` that only checked its own lock would otherwise rewrite
`personality.md` under a cycle that is dreaming. It is held by this function
and not by a node: a context manager cannot span nodes, and `login_step`'s own
lock is deliberately discarded by the login node for exactly that reason.

**`heartbeat()` is called from here, between nodes.** `run_cycle` drives the
graph with `stream(stream_mode="values")` rather than `invoke`, and beats both
leases after every superstep -- so each beat immediately precedes the next
node's execution and the 1800s staleness window restarts at that node's start.
Without any caller, a cycle running longer than `LEASE_TTL_SECONDS` has its
lock file reclaimed by the next Bash round WHILE STILL HOLDING IT, and both
runtimes act on the same account. The residual gap is a SINGLE node that
outruns the window on its own: the `gate` node's cold-cache worst case is
~6x 300s = ~1800s (spec §15.1 row 15). Beating from inside a node would
require the node layer to know about leases, which is the coupling §5.4's
split exists to avoid; a background thread would beat during a long node but
would write to the lease's `sqlite3.Connection` from a second thread. Recorded
rather than solved here.
"""

from __future__ import annotations

import contextlib
import sqlite3
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Final, Protocol, cast

from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.graph import END, START, StateGraph
from langgraph.runtime import Runtime

# `RunnableConfig` is re-exported by `langgraph.types` at runtime but is not in
# its `__all__`, and `mypy --strict` implies `--no-implicit-reexport`. Importing
# it from `langchain_core.runnables`, where it actually lives, would put an
# UNDECLARED transitive dependency in this package's import list. Same shape as
# the `eff_request_host` ignore in `api/client.py`.
from langgraph.types import RetryPolicy, RunnableConfig  # type: ignore[attr-defined]

from swil_agent.api.client import TransportError
from swil_agent.graph.leases import LeaseKind, RunLease
from swil_agent.graph.nodes import (
    CycleDeps,
    NodeFn,
    agent_dir_name,
    make_dream_node,
    make_execute_node,
    make_gate_node,
    make_guardrail_node,
    make_login_node,
    make_logout_node,
    make_plan_node,
    make_snapshot_node,
    make_write_node,
)
from swil_agent.graph.state import BUILTIN_TENANT, CycleState, thread_id
from swil_agent.models import ActResult, Persona

# Node names, spelled once. They are also the `CycleState` thread's public
# vocabulary: a checkpoint records which node it stopped at, and `--resume`
# (task 9) reads that name back.
LOGIN: Final = "login"
PLAN: Final = "plan"
GUARDRAIL: Final = "guardrail"
EXECUTE: Final = "execute"
DREAM: Final = "dream"
GATE: Final = "gate"
WRITE: Final = "write"
SNAPSHOT: Final = "snapshot"
LOGOUT: Final = "logout"

# Spec §5.4's node table, as corrected. Read as ATTEMPTS, which is what
# `RetryPolicy` takes -- see this module's report for the one row where the
# brief's literal `max_attempts=1` and its own two required tests disagree
# (`execute`: a policy that never retries makes both "a transient failure IS
# retried" and "widening `retry_on` must be detectable" unsatisfiable).
#
# `guardrail` is PURE (no I/O at all) so it gets none. `write` and `logout`
# are absent from §5.4's table, and `write` sharply so: re-running it archives
# and rewrites `personality.md` a second time.
#
# ── Why NO node keeps the library's default `retry_on` ──────────────────────
#
# Measured against langgraph 1.2.11 (`langgraph._internal._retry`):
# `default_retry_on` answers **False for every `RuntimeError`**, and `ApiError`
# -- hence `TransportError`, which subclasses it -- IS a `RuntimeError`. So a
# bare `RetryPolicy(max_attempts=2)` retries NONE of this codebase's typed
# failures and retries exactly one thing: an unwrapped third-party leak such
# as `httpx.CookieConflict` (spec §15.3 row 17), which is deterministic and
# gains nothing from a second attempt. Every default-predicate policy in this
# module was therefore decorative for the case it was written for.
#
# Each policy below now names what that node may actually survive. Two of them
# name `TransportError` for two DIFFERENT safety arguments; one names nothing
# at all, because nothing transient can reach it. In all three cases a
# permanent `ApiError` (404/403/400) is excluded BY TYPE, which is §5.4's
# "permanent failures are not retried" -- `TransportError` always carries
# `status=0`, so no permanent status can be inside the retried set.
#
# **What can actually reach a node boundary today (measured, 2026-08-18).**
# `ApiError` is the universal wrapper and nearly every step catches it:
# `sync_backend_step` and every block of `build_context` (`except ApiError`),
# `execute_action` (`_WriteFailure = (ApiError, WriteNotVerifiedError)`),
# `_resolve_board_id`, `snapshot_step`, and `Resources.lab_event` /
# `mark_notifications_read`, which never raise at all. `EmbedderClient` wraps
# `httpx.HTTPError` into `EmbedderUnavailable`; `SubprocessRunner` turns a
# timeout into `""` and a missing binary into `BackendBinaryMissingError`. So
# NO `TransportError` reaches any node boundary in the shipped composition.
# The tuples below are the contract for what a future narrowing of one of
# those catches may safely let escape -- not a live retry (standing constraint
# §7: the equivalence is conditional, and this is the condition).

# `login` = probe -> `sync_backend_step` -> `context_step`. The ONE node in
# the cycle that is wholly idempotent: a read-only probe, a PATCH that writes
# the same constant `agentBackend` value every round, and reads. So a retry
# here cannot duplicate anything.
#
# The probe is NOT what this retries, and cannot be: `_health_check` returns a
# `bool` and swallows `httpx.HTTPError` itself, so a flaky probe yields
# `online=False` -> `ActOutcome.OFFLINE`, a legitimate round outcome, not an
# exception. Retrying it would also diverge from Bash, which probes exactly
# once per round in Main (`auto-run.sh:833-840`) for the whole roster.
LOGIN_RETRY: Final = RetryPolicy(max_attempts=2, retry_on=(TransportError,))

# `plan` gets NO retry, and that is the measured answer rather than an
# omission. This node makes no HTTP call at all -- its one call is an LLM
# SUBPROCESS, and every subprocess failure is already normalised below it:
# `subprocess.TimeoutExpired` -> `""` -> `BackendUnavailableError` ->
# `plan_round` returns `None` -> `ActOutcome.BACKEND_UNAVAILABLE` (a round
# outcome, not an exception). The one thing that does escape,
# `BackendBinaryMissingError`, is permanent -- a `claude`/`codex` absent from
# PATH is not fixed by trying again -- and a retry would simply pay for a
# second LLM call before failing the same way.
PLAN_RETRY: Final = RetryPolicy(max_attempts=1)

# NOT the library default, and narrowly on purpose: `execute_step` walks the
# surviving actions IN ORDER and posts each one, so it is not idempotent --
# a retry after a mid-loop failure re-posts everything that already landed.
# `TransportError` is the one failure that never reached the server
# (`status=0`), so nothing can have landed before it.
#
# What makes even that safe today is that it is UNREACHABLE from inside the
# loop: `execute_action` catches `(ApiError, WriteNotVerifiedError)` around
# every write, `_resolve_board_id` catches `ApiError`, and
# `Resources.lab_event` never raises -- so a transport failure while executing
# an action becomes a `landed=False` `ActionResult` instead of reaching this
# boundary (pinned by `test_a_transport_failure_mid_loop_is_absorbed_...`).
# What CAN reach it after N actions have landed is an `OSError` from the
# `memory.md` append, and this narrow tuple is what stops that from
# re-executing the N (pinned by `test_a_failure_after_an_action_landed_...`).
# If a future change lets a transport failure escape mid-loop, this policy
# becomes a duplicate-post generator and must be narrowed to a per-action
# retry instead.
EXECUTE_RETRY: Final = RetryPolicy(max_attempts=2, retry_on=(TransportError,))
DREAM_RETRY: Final = RetryPolicy(max_attempts=1)
GATE_RETRY: Final = RetryPolicy(max_attempts=1)

# `snapshot` is fail-soft and must never block the cycle -- and it already is,
# INSIDE the step: `snapshot_step` catches `(EmbedderUnavailable,
# WriteNotVerifiedError, ApiError)` and returns `ok=False` with the failure's
# own message. So this policy cannot make the step fail soft; what it does is
# scope the one failure a future narrowing of that catch could let escape.
# `TransportError` is retry-safe HERE for a reason the other nodes do not
# have: the server dedupes snapshots by `contentHash`, so an upload that may
# or may not have landed (which is exactly what `status=0` means) cannot
# produce a duplicate row on a second attempt. `EmbedderUnavailable` is
# deliberately NOT in the tuple -- a daemon that is down stays down for the
# round, and the step already fails open on it.
SNAPSHOT_RETRY: Final = RetryPolicy(max_attempts=2, retry_on=(TransportError,))

# Both loops OFF. `max_rounds=1` is one act round; `max_dream_attempts=1` is
# one dream, i.e. no retry. Two is the ceiling §5.4 allows for the dream
# ("max 1 retry"); more is refused rather than silently tripling the spend.
DEFAULT_MAX_ROUNDS: Final = 1
DEFAULT_MAX_DREAM_ATTEMPTS: Final = 1
MAX_DREAM_ATTEMPTS_CEILING: Final = 2

# LangGraph's own default. Every extra round costs 4 supersteps and every
# extra dream attempt 2, so the derived limit only ever exceeds this for
# configurations that turn a loop on.
_DEFAULT_RECURSION_LIMIT: Final = 25

# `%Y%m%dT%H%M%S` and not `isoformat()`: `thread_id` splits on `":"`, and an
# ISO timestamp carries two of them.
_ROUND_ID_FORMAT: Final = "%Y%m%dT%H%M%S"

# Both halves of what Bash locks, in a fixed order so two cycles racing for
# the same account cannot deadlock against each other.
_LEASE_KINDS: Final[tuple[LeaseKind, ...]] = ("act", "dream")


@dataclass(frozen=True)
class CycleConfig:
    """The two loop bounds. Validated at construction, because every invalid
    value here is an expensive one -- an unbounded act loop is an unbounded
    number of posts, and an unbounded dream loop is an unbounded number of
    LLM calls."""

    max_rounds: int = DEFAULT_MAX_ROUNDS
    max_dream_attempts: int = DEFAULT_MAX_DREAM_ATTEMPTS

    def __post_init__(self) -> None:
        if self.max_rounds < 1:
            raise ValueError("max_rounds must be at least one act round")
        if self.max_dream_attempts < 1:
            raise ValueError("max_dream_attempts must be at least one dream attempt")
        if self.max_dream_attempts > MAX_DREAM_ATTEMPTS_CEILING:
            raise ValueError(
                "spec §5.4 allows at most one dream retry, i.e. "
                f"max_dream_attempts <= {MAX_DREAM_ATTEMPTS_CEILING}"
            )


DepsProvider = Callable[[int], CycleDeps]


@dataclass(frozen=True)
class CycleContext:
    """LangGraph's per-invocation runtime context: everything a node needs
    that `CycleState` cannot carry across a checkpoint.

    `deps_for_round` is called with the number of act rounds ALREADY
    COMPLETED, so round 1 sees `0`. The dream phase resolves after the last
    act round and therefore asks for index `max_rounds`; a provider must
    tolerate that (the built-in constant provider ignores the index, and a
    real factory should clamp).
    """

    deps_for_round: DepsProvider


CycleGraph = StateGraph[CycleState, CycleContext, CycleState, CycleState]
_Router = Callable[[CycleState], str]


class _CycleNode(Protocol):
    """The shape LangGraph's own `_NodeWithRuntime` protocol demands:
    `runtime` is KEYWORD-ONLY there. A positional second parameter is
    accepted at runtime and rejected by the `add_node` overloads under
    `mypy --strict`, which is a confusing way to find out."""

    def __call__(self, state: CycleState, *, runtime: Runtime[CycleContext]) -> CycleState: ...


def _grants_dream(state: CycleState) -> bool:
    """Design spec §7.1, via its ONE implementation.

    `ActResult.grants_dream` is constructed rather than reimplemented so the
    graph cannot answer differently from `run_act`'s caller: only
    `BACKEND_UNAVAILABLE` and `OFFLINE` deny the account its dream. An
    outcome that has not been decided yet (the act phase is still running)
    denies nothing.

    NOTE this is a deliberate, spec'd divergence from `cycle-one.sh`, which
    skips the dream on ANY non-zero `auto-run.sh` exit -- including a rhythm
    veto and an empty plan. §7.1 calls that conflation the reason "an empty
    plan came to cost a personality evolution", and `finalize_step` already
    records the same change point on the `landed == 0` branch.
    """
    outcome = state.get("outcome")
    if outcome is None:
        return True
    return ActResult(outcome=outcome).grants_dream


def _dream_or_logout(state: CycleState) -> str:
    """The ONE place the act phase can enter the dream, so the ONE place a
    shadow round has to be stopped.

    Design spec §9.4: a dry run "builds context and produces a plan but
    executes nothing and **writes nothing**". `run_act`'s `dry_run` is
    threaded into the three act steps that write, but the dream path has no
    equivalent -- `write_step` archives and rewrites `personality.md` and
    `snapshot_step` publishes it, and neither takes a `dry_run` parameter to
    be inert under (`dream/round.py` predates the shadow round and is frozen).
    An unguarded dry cycle would therefore have rewritten 23 personalities and
    uploaded 23 snapshots during the stage-3 round whose entire premise is
    that Python never wrote.

    Skipping the whole phase rather than only its two write steps is also what
    §9.4 compares: rhythm policy, guardrail verdicts and veto lists are all
    act-phase artefacts, and a dream nobody reads still costs one paid LLM
    call per account. The write nodes carry their own `dry_run` guard as well
    (`graph/nodes.py`), so this edge is the cheap path and not the only
    defence -- standing constraint §5.
    """
    if state.get("dry_run", False):
        return LOGOUT
    return DREAM if _grants_dream(state) else LOGOUT


def _continue_or_logout(next_node: str) -> _Router:
    """The act phase's two early exits (`login` offline, `plan` empty). Both
    ask the same question, so it is spelled once."""

    def route(state: CycleState) -> str:
        return next_node if _grants_dream(state) else LOGOUT

    return route


def _after_guardrail(state: CycleState) -> str:
    """§5.4's "(rhythm veto / empty)" edge.

    An empty survivor list routes AROUND `execute` -- `run_act`'s item 7 is an
    early return, and in a graph the equivalent is this edge. Entered anyway,
    `finalize_step` would turn the `VETOED_EMPTY` the guardrail node just
    decided into `LANDED_PARTIAL` and log Bash's FAIL line. A solo `nothing`
    is NOT this case: it is a surviving action and still executes.
    """
    if state.get("actions"):
        return EXECUTE
    return _dream_or_logout(state)


def _after_execute(config: CycleConfig) -> _Router:
    """Loop 3. `round_index` counts act rounds COMPLETED (the execute node
    increments it), so it doubles as the index of the deps the next round
    needs."""

    def route(state: CycleState) -> str:
        if state.get("round_index", 0) < config.max_rounds:
            return LOGIN
        return _dream_or_logout(state)

    return route


def _after_dream(state: CycleState) -> str:
    """A cooldown SKIP, an empty rewrite and a blown deadline all leave
    `candidate` unset, and the gate node `_require`s it -- an unconditional
    edge would turn every quiet round into a `NodeStateError`."""
    return GATE if state.get("candidate") else LOGOUT


def _after_gate(config: CycleConfig) -> _Router:
    """Loop 2, and ONLY loop 2. A rejection that has no retry budget left
    still goes to `write` -- see the module docstring on why the reject path
    is not an edge around it."""

    def route(state: CycleState) -> str:
        verdict = state.get("verdict")
        rejected = verdict is not None and not verdict.accepted
        if rejected and state.get("dream_attempt", 0) < config.max_dream_attempts:
            return DREAM
        return WRITE

    return route


def _deps_of(runtime: Runtime[CycleContext], state: CycleState) -> CycleDeps:
    return runtime.context.deps_for_round(state.get("round_index", 0))


def _bind(factory: Callable[[CycleDeps], NodeFn]) -> _CycleNode:
    """Adapt a `make_*_node` factory to a node that resolves its deps at CALL
    time from the runtime context.

    Binding at assembly time instead would freeze one `CycleDeps` into the
    compiled graph, which is correct for a single-round cycle and silently
    wrong for loop 3 -- round 2 would plan against round 1's `memory_text`.
    """

    def node(state: CycleState, *, runtime: Runtime[CycleContext]) -> CycleState:
        return factory(_deps_of(runtime, state))(state)

    return node


def _execute_node(state: CycleState, *, runtime: Runtime[CycleContext]) -> CycleState:
    """`execute`, plus loop 3's counter.

    The increment lives here rather than in a router because a LangGraph
    conditional edge returns a destination and cannot write state, and rather
    than in `graph/nodes.py` because "how many rounds has this cycle run" is
    the graph's question, not the node's.
    """
    update = make_execute_node(_deps_of(runtime, state))(state)
    update["round_index"] = state.get("round_index", 0) + 1
    return update


def _dream_node(state: CycleState, *, runtime: Runtime[CycleContext]) -> CycleState:
    """`dream`, plus loop 2's counter -- §5.4's "attempt recorded"."""
    update = make_dream_node(_deps_of(runtime, state))(state)
    update["dream_attempt"] = state.get("dream_attempt", 0) + 1
    return update


def build_cycle(config: CycleConfig | None = None) -> CycleGraph:
    """Assemble the cycle graph. Takes no deps: they arrive per invocation
    through `CycleContext`, so the shape can be compiled and inspected
    without a roster (and `build_cycle().compile()` is the test that a
    `timeout=` has not come back).

    The returned graph is UNcompiled, per the interface §5.4 specifies --
    `run_cycle` compiles it with whatever checkpointer the caller supplies.
    """
    cfg = config or CycleConfig()
    graph: CycleGraph = StateGraph(CycleState, context_schema=CycleContext)

    graph.add_node(LOGIN, _bind(make_login_node), retry_policy=LOGIN_RETRY)
    graph.add_node(PLAN, _bind(make_plan_node), retry_policy=PLAN_RETRY)
    graph.add_node(GUARDRAIL, _bind(make_guardrail_node))
    graph.add_node(EXECUTE, _execute_node, retry_policy=EXECUTE_RETRY)
    graph.add_node(DREAM, _dream_node, retry_policy=DREAM_RETRY)
    graph.add_node(GATE, _bind(make_gate_node), retry_policy=GATE_RETRY)
    graph.add_node(WRITE, _bind(make_write_node))
    graph.add_node(SNAPSHOT, _bind(make_snapshot_node), retry_policy=SNAPSHOT_RETRY)
    graph.add_node(LOGOUT, _bind(make_logout_node))

    graph.add_edge(START, LOGIN)
    graph.add_conditional_edges(LOGIN, _continue_or_logout(PLAN), [PLAN, LOGOUT])
    graph.add_conditional_edges(PLAN, _continue_or_logout(GUARDRAIL), [GUARDRAIL, LOGOUT])
    graph.add_conditional_edges(GUARDRAIL, _after_guardrail, [EXECUTE, DREAM, LOGOUT])
    graph.add_conditional_edges(EXECUTE, _after_execute(cfg), [LOGIN, DREAM, LOGOUT])
    graph.add_conditional_edges(DREAM, _after_dream, [GATE, LOGOUT])
    graph.add_conditional_edges(GATE, _after_gate(cfg), [DREAM, WRITE])
    graph.add_edge(WRITE, SNAPSHOT)
    graph.add_edge(SNAPSHOT, LOGOUT)
    graph.add_edge(LOGOUT, END)
    return graph


def _recursion_limit(config: CycleConfig) -> int:
    """Four supersteps per act round, two per dream attempt, plus the write /
    snapshot / logout tail and START. Only exceeds LangGraph's own default
    for a configuration that turns a loop on -- but a `GraphRecursionError`
    on the round that finally enables loop 3 would be a confusing way to
    learn that."""
    needed = 4 * config.max_rounds + 2 * config.max_dream_attempts + 6
    return max(_DEFAULT_RECURSION_LIMIT, needed)


def _deps_provider(deps: CycleDeps | DepsProvider, config: CycleConfig) -> DepsProvider:
    """A single frozen `CycleDeps` is only sound for a single act round.

    `memory_text`, `context_now` and `feed_context` are snapshots taken before
    the cycle starts. Reusing them for round 2 hides round 1's own posts from
    `ActContext.today_post_count`, and the rhythm gate then lets the account
    post again over its ceiling -- a real over-posting round, invisible in
    every unit test, which is why this is refused at the call instead of
    documented.
    """
    if isinstance(deps, CycleDeps):
        if config.max_rounds > 1:
            raise ValueError(
                "max_rounds > 1 needs deps rebuilt per round: pass a "
                "Callable[[int], CycleDeps], not a single frozen CycleDeps "
                "(round 2 would plan against round 1's memory_text)"
            )
        frozen = deps
        return lambda _round_index: frozen
    return deps


def run_cycle(
    *,
    persona: Persona,
    deps: CycleDeps | DepsProvider,
    lease_db: sqlite3.Connection,
    checkpointer: BaseCheckpointSaver[Any] | None = None,
    config: CycleConfig | None = None,
    tenant: str = BUILTIN_TENANT,
    round_id: str | None = None,
    run_id: str | None = None,
    resume: bool = False,
    lease_clock: Callable[[], float] = time.time,
) -> CycleState:
    """Run one full cycle for one account and return its final `CycleState`.

    Holds BOTH of Bash's per-account locks (`lock_<name>` and
    `dream_lock_<name>`) for the whole run, beats them between nodes, and
    releases both however the cycle ends -- normal return, exception,
    `SystemExit(141)`. A busy lease raises `LeaseBusy` before any node runs,
    with no LLM call spent; the caller SKIPs, as Bash does.

    `dry_run` (read off the round-0 deps) takes NO lease: a dry run executes
    nothing and writes nothing, so it needs no mutual exclusion -- and taking
    the lock would cost a concurrent real Bash round its whole turn, which is
    the same F4 rule `login_step` already applies to its own lock.

    Identity: the lease, the log lines and `CycleState["agent"]` all use the
    persona DIRECTORY name (`agent_dir_name`), never the `Username` bullet --
    `auto-run.sh:407` derives it with `basename`, and the two diverge on this
    roster. `round_id` defaults to `deps.now` formatted, so a resumed thread
    id is reproducible from the same moment; `run_id` defaults to a fresh
    uuid, because `RunLease`'s release is identity-scoped and a successor must
    never be mistakable for the holder it replaced.

    `resume=True` streams **`None`** instead of the seed state, which is what
    actually continues an interrupted run: measured against langgraph 1.2.11,
    a graph that died inside node `b` resumes at `b` and does NOT re-run `a`,
    while streaming the seed state again would re-apply it as an update
    (resetting `round_index` to 0, among other things) before continuing. It
    requires a `checkpointer` -- there is nothing to continue from without one
    -- and the caller must supply the ORIGINAL `round_id`, because the thread
    id is the checkpoint's only key and the default derives it from
    `deps.now`, which is a different moment in the resuming process.

    Two consequences of resuming worth knowing: a thread whose previous run
    completed runs no nodes at all and returns its stored final state, and a
    thread that was never checkpointed raises langgraph's `EmptyInputError`.
    """
    cfg = config or CycleConfig()
    if resume and checkpointer is None:
        raise ValueError("resume=True needs a checkpointer: there is nothing to continue from")
    provider = _deps_provider(deps, cfg)
    first = provider(0)
    name = agent_dir_name(persona)
    round_key = round_id if round_id is not None else first.now.strftime(_ROUND_ID_FORMAT)
    run_key = run_id if run_id is not None else uuid.uuid4().hex
    thread = thread_id(tenant, name, round_key)

    # EQUIVALENT MUTANT, conditionally (standing constraint §7): `"agent"`
    # here can be swapped for `persona.username` and no test can tell, because
    # the `login` node returns `{"agent": step.agent_name}` on BOTH its
    # branches and always runs first, so the seed is always overwritten before
    # anything reads it. It stops being equivalent the moment a node other
    # than `login` becomes the entry point, or `login` stops reporting the
    # name on one of its branches -- and the seeded value is what a checkpoint
    # written before `login` completes would carry. It is the DIRECTORY name
    # for the same reason everything else here is.
    state: CycleState = {
        "tenant": tenant,
        "agent": name,
        "persona": persona,
        "thread_id": thread,
        "run_id": run_key,
        "round_index": 0,
        # Read off the ROUND-0 deps, the same instance `_acquire` asks about
        # the lease. A provider that flipped `dry_run` between rounds would be
        # a contradiction in terms, and the routers need one answer.
        "dry_run": first.dry_run,
    }
    # `None` on a resume: see this function's docstring. The seed is still
    # BUILT on that path, because it is also this function's return value if
    # the resumed thread has nothing left to run.
    stream_input = None if resume else state
    app = build_cycle(cfg).compile(checkpointer=checkpointer)
    run_config: RunnableConfig = {
        "configurable": {"thread_id": thread},
        "recursion_limit": _recursion_limit(cfg),
    }
    context = CycleContext(deps_for_round=provider)

    with contextlib.ExitStack() as stack:
        leases = _acquire(stack, lease_db, first, tenant, name, run_key, lease_clock)
        for chunk in app.stream(
            stream_input, config=run_config, context=context, stream_mode="values"
        ):
            state = cast(CycleState, chunk)
            for lease in leases:
                # Between nodes, so every beat immediately precedes the next
                # node's execution and Bash's 1800s staleness window restarts
                # at that node's start.
                lease.heartbeat()
    return state


def _acquire(
    stack: contextlib.ExitStack,
    db: sqlite3.Connection,
    deps: CycleDeps,
    tenant: str,
    name: str,
    run_key: str,
    clock: Callable[[], float],
) -> list[RunLease]:
    if deps.dry_run:
        return []
    return [
        stack.enter_context(
            RunLease(db, deps.agent_root, tenant, name, kind, run_id=run_key, now=clock)
        )
        for kind in _LEASE_KINDS
    ]
