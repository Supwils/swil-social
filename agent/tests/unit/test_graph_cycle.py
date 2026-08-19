"""The assembled cycle graph (Plan 3 Task 8, spec §5.4).

`graph/nodes.py` is nine adapters; this is the wiring BETWEEN them, plus the
two things that wrap the whole run -- the lease and the checkpointer. So what
these tests can see, and no earlier suite can, is:

  * **Which nodes a round actually visits.** The node tests drive one node at
    a time; only here can an edge route a rejected dream around `write_step`
    (deleting the constitution layer with every node test green), or route an
    offline probe into `plan` and spend an LLM call on an unreachable
    platform.
  * **The retry policies.** A `timeout=` reintroduced on any node either
    breaks `compile()` or resurrects the orphan-subprocess class; a
    `retry_on` widened to bare `Exception` re-runs `execute_step` from the
    top after a 404, and `execute_step` is not idempotent -- every action
    that already landed lands again.
  * **The loops.** Loops 2 and 3 are OFF by default. A graph that loops by
    default doubles every account's LLM spend, and nothing in the node layer
    can tell.
  * **The lease and its heartbeat.** The lease keyed on the wrong name locks
    a path no Bash round reads, and an unbeaten lease is reclaimed at 1800s
    by a Bash round while this cycle still holds it -- both invisible unless
    the test looks at the actual lock path and the actual row.

**Discriminability, applied to the two databases.** `deps.agent_root` is a
SUBdirectory of `tmp_path` here, and the lease DB and the checkpoint DB live
in sibling directories OUTSIDE it. Rooting either at `agent_root` -- which is
where `graph/checkpoint.py` tells a caller to put it, and where `RunLease`'s
lock files genuinely do live -- would make an injected database identical to
one the code could have built for itself, and the injection would be
untestable (standing constraint §4, the collaborator corollary).
"""

from __future__ import annotations

import random
import sqlite3
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Final

import httpx
import pytest

from swil_agent.act import round as act_round
from swil_agent.api.client import ApiError, TransportError
from swil_agent.config import Settings
from swil_agent.graph import nodes as nodes_module
from swil_agent.graph.checkpoint import open_checkpointer
from swil_agent.graph.cycle import (
    DREAM,
    EXECUTE,
    GATE,
    GUARDRAIL,
    LOGIN,
    LOGOUT,
    PLAN,
    SNAPSHOT,
    WRITE,
    CycleConfig,
    build_cycle,
    run_cycle,
)
from swil_agent.graph.leases import LEASE_TTL_SECONDS, RunLease
from swil_agent.graph.nodes import CycleDeps
from swil_agent.graph.state import CycleState
from swil_agent.llm.base import CompletionRequest
from swil_agent.locks import act_lock_path, dream_lock_path
from swil_agent.models import ActOutcome, Persona

from ._runners import (
    FakeEmbedder,
    FakePersonaSource,
    FakeResources,
    FakeState,
    RecordingRunner,
)

NOW = datetime(2026, 8, 17, 10, 0, 0)
# Deliberately a different instant from `NOW` -- see test_graph_nodes.py.
CAPTURED_AT = datetime(2026, 8, 17, 2, 0, 0, tzinfo=UTC)

# Directory name and `Username` bullet differ on purpose everywhere in this
# file: the lease, the lock file and every log line take the DIRECTORY name
# (`auto-run.sh:407`'s `basename`), and a fixture where the two coincide
# cannot tell a correct lease path from one that locks a file nobody reads.
DIR_NAME = "zenith_dir"
USERNAME = "zenith"

PERSONALITY = """# 测试

## 身份
- **Username:** zenith
- **Display Name:** 测试
- **Headline:** AI Agent
- **Bio:** 一句话
- **Follow Topics:** alpha,beta,gamma

- **AI Backend:** claude

## 发帖节律
- 每次触发有 60% 概率选择 post
"""

# Every step `graph/nodes.py` calls, in the order a complete cycle calls them.
# Spying on these module globals is how this file observes WHICH nodes ran:
# `nodes.py` binds each name into its own globals at import, so the module
# under test resolves the spy (standing constraint §6).
_ACT_STEPS = (
    "login_step",
    "sync_backend_step",
    "context_step",
    "plan_step",
    "guardrail_step",
    "execute_step",
    "finalize_step",
)
_DREAM_STEPS = (
    "cooldown_step",
    "dream_step",
    "gate_step",
    "write_step",
    "snapshot_step",
)


def _valid_candidate(bio: str = "改写过的一句话") -> str:
    return PERSONALITY.replace("一句话", bio)


def _rejected_candidate() -> str:
    """Fails the structural `Username` validator, so the gate rejects it with
    no embedder or distiller involvement."""
    return PERSONALITY.replace("- **Username:** zenith", "- **Username:** someone_else")


class ScriptedBackend:
    """Answers each `complete` call from a script, in order.

    A whole cycle spends up to three backend calls on ONE backend object:
    the plan, the dream's rewrite candidate, and the accepted dream's diff
    narrative. `TwoCallBackend` splits only the last two, so it cannot drive
    a cycle that plans first.
    """

    name = "scripted"

    def __init__(self, *responses: str) -> None:
        self._responses = list(responses)
        self.calls: list[CompletionRequest] = []

    def complete(self, req: CompletionRequest) -> str:
        self.calls.append(req)
        index = len(self.calls) - 1
        if index < len(self._responses):
            return self._responses[index]
        return self._responses[-1] if self._responses else ""


def _account(root: Path, *, dir_name: str = DIR_NAME) -> Path:
    directory = root / "agents" / dir_name
    directory.mkdir(parents=True, exist_ok=True)
    directory.joinpath("personality.md").write_text(PERSONALITY, encoding="utf-8")
    directory.joinpath("memory.md").write_text("2026-08-01 | act | did a thing\n", encoding="utf-8")
    return directory


def _persona(root: Path, *, dir_name: str = DIR_NAME, username: str = USERNAME) -> Persona:
    return Persona(
        username=username,
        directory=_account(root, dir_name=dir_name),
        backend="claude",
        model=None,
        rhythm_text="",
        raw=PERSONALITY,
    )


def _agent_root(tmp_path: Path) -> Path:
    """`agent_root` is a SUBdirectory of `tmp_path`, so a lease or checkpoint
    database placed in a sibling directory is provably not one the code
    derived from `agent_root` itself."""
    root = tmp_path / "agent_root"
    root.mkdir(parents=True, exist_ok=True)
    return root


def _lease_db(tmp_path: Path) -> sqlite3.Connection:
    path = tmp_path / "injected_leases" / "leases.sqlite"
    path.parent.mkdir(parents=True, exist_ok=True)
    return sqlite3.connect(str(path), check_same_thread=False)


def _plan_json(action: str = "post", text: str = "你好世界") -> str:
    return f'{{"plan":[{{"action":"{action}","text":"{text}"}}]}}'


def _deps(tmp_path: Path, **overrides: Any) -> CycleDeps:
    """`CycleDeps` with every collaborator a harmless double, every moment
    frozen, and a backend scripted for a full accepted cycle."""
    defaults: dict[str, Any] = {
        "resources": FakeResources(),
        "backend": ScriptedBackend(_plan_json(), _valid_candidate(), "叙述"),
        "persona_source": FakePersonaSource(),
        "runner": RecordingRunner(),
        "embedder": FakeEmbedder(vectors=[[1.0], [1.0]]),
        "dream_state": FakeState(),
        "settings": Settings(drift_mode="scalar"),
        "agent_root": _agent_root(tmp_path),
        "health_check": lambda: True,
        "memory_text": "",
        "rng": random.Random(0),
        "now": NOW,
        "captured_at": CAPTURED_AT,
    }
    defaults.update(overrides)
    return CycleDeps(**defaults)


def _trace_steps(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """Record every step call `graph/nodes.py` makes, in order."""
    trace: list[str] = []

    def install(step: str) -> None:
        real = getattr(nodes_module, step)

        def spy(_step: str = step, _real: Any = real, **kwargs: Any) -> Any:
            trace.append(_step)
            return _real(**kwargs)

        monkeypatch.setattr(nodes_module, step, spy)

    for step in (*_ACT_STEPS, *_DREAM_STEPS):
        install(step)
    return trace


_CLOCK_BASE = 1_000_000.0


def _counting_clock(start: float = _CLOCK_BASE) -> Callable[[], float]:
    """A lease clock that advances one second per read, so two heartbeats can
    never coincide. `time.time()` at real speed writes the same float twice
    inside one fast graph run, which would make "the lease was beaten between
    nodes" pass whether or not it was."""
    ticks = iter(range(10_000))

    def clock() -> float:
        return start + next(ticks)

    return clock


def _rows(db: sqlite3.Connection) -> list[tuple[Any, ...]]:
    """Every live lease row, or `[]` when the table does not exist yet -- a
    dry run never calls `ensure_schema`, and "no table" is the strongest
    possible form of "no lease was taken"."""
    try:
        return list(db.execute("SELECT tenant, agent, kind, run_id, heartbeat_at FROM run_leases"))
    except sqlite3.OperationalError:
        return []


def _run(
    tmp_path: Path,
    *,
    persona: Persona | None = None,
    deps: CycleDeps | Callable[[int], CycleDeps] | None = None,
    db: sqlite3.Connection | None = None,
    **kwargs: Any,
) -> CycleState:
    return run_cycle(
        persona=persona if persona is not None else _persona(_agent_root(tmp_path)),
        deps=deps if deps is not None else _deps(tmp_path),
        lease_db=db if db is not None else _lease_db(tmp_path),
        **kwargs,
    )


# ── structure and node policies ─────────────────────────────────────────────


def test_no_node_declares_a_timeout() -> None:
    """LangGraph refuses `timeout=` on a sync node at `compile()` time, and
    the async form orphans the child process (measured 2026-08-18, spec
    §5.4). A `timeout=` reintroduced here would either break the build or
    silently resurrect the orphan-subprocess class.

    Both halves are asserted: `compile()` is the one a mutation actually
    trips (`ValueError: Node timeouts are only supported for async nodes`),
    and the explicit `timeout is None` sweep says out loud what the build is
    protecting, for a future langgraph that stops raising.
    """
    graph = build_cycle()
    for name, spec in graph.nodes.items():
        assert spec.timeout is None, f"node {name} declares a timeout"
    graph.compile()  # must not raise


def test_the_topology_matches_the_spec(tmp_path: Path) -> None:
    """§5.4's nine nodes and the edges between them, read back off the
    compiled graph. A route deleted or re-pointed shows up here before any
    behavioural test has to reproduce the round that would have taken it."""
    drawn = build_cycle().compile().get_graph()
    assert {node.id for node in drawn.nodes.values()} == {
        "__start__",
        "__end__",
        LOGIN,
        PLAN,
        GUARDRAIL,
        EXECUTE,
        DREAM,
        GATE,
        WRITE,
        SNAPSHOT,
        LOGOUT,
    }
    edges = {(edge.source, edge.target) for edge in drawn.edges}
    for source, target in (
        ("__start__", LOGIN),
        (LOGIN, PLAN),
        (LOGIN, LOGOUT),
        (PLAN, GUARDRAIL),
        (PLAN, LOGOUT),
        (GUARDRAIL, EXECUTE),
        (GUARDRAIL, DREAM),
        (EXECUTE, DREAM),
        (EXECUTE, LOGIN),
        (DREAM, GATE),
        (DREAM, LOGOUT),
        (GATE, WRITE),
        (GATE, DREAM),
        (WRITE, SNAPSHOT),
        (SNAPSHOT, LOGOUT),
        (LOGOUT, "__end__"),
    ):
        assert (source, target) in edges, f"missing edge {source} -> {target}"


def test_the_retry_policies_match_the_corrected_node_table() -> None:
    """Spec §5.4 as corrected. `guardrail` is PURE -- it performs no I/O at
    all, so a retry policy on it would be a claim about a failure mode it
    does not have; `write` is absent from the table for a sharper reason,
    since re-running it would archive and rewrite `personality.md` twice.

    `plan` is ONE attempt, which is a deviation from the table's literal "2"
    and the measured answer rather than an omission: the node makes no HTTP
    call at all, every subprocess failure is normalised below it into `None`
    (-> `BACKEND_UNAVAILABLE`), and the one exception that does escape it is
    permanent. A second attempt would only pay for a second LLM call before
    failing identically -- see `test_the_plan_node_is_attempted_exactly_once`.
    """
    nodes = build_cycle().compile().nodes
    attempts = {
        LOGIN: 2,
        PLAN: 1,
        EXECUTE: 2,
        DREAM: 1,
        GATE: 1,
        SNAPSHOT: 2,
    }
    for name, expected in attempts.items():
        policies = nodes[name].retry_policy
        assert policies is not None, f"{name} has no retry policy"
        assert [policy.max_attempts for policy in policies] == [expected]
    for name in (GUARDRAIL, WRITE, LOGOUT):
        assert nodes[name].retry_policy is None, f"{name} must carry no retry policy"


def test_every_retrying_node_names_what_it_retries() -> None:
    """No node keeps the library's default predicate.

    Measured: `default_retry_on` answers False for every `RuntimeError`, and
    `ApiError` -- hence `TransportError` -- IS one, so a default policy
    retries none of this codebase's typed failures and exactly one thing we
    never wanted retried (an unwrapped third-party leak). Every node that can
    retry at all therefore names its own tuple; the three that cannot retry
    carry `max_attempts=1`, where `retry_on` is never consulted.
    """
    nodes = build_cycle().compile().nodes
    for name in (LOGIN, EXECUTE, SNAPSHOT):
        policies = nodes[name].retry_policy
        assert policies is not None
        assert policies[0].retry_on == (TransportError,), f"{name} kept the default predicate"
    for name in (PLAN, DREAM, GATE):
        policies = nodes[name].retry_policy
        assert policies is not None
        assert policies[0].max_attempts == 1, f"{name} must not retry at all"


def test_the_default_predicate_is_why_none_of_these_nodes_use_it() -> None:
    """The measurement itself, pinned rather than described.

    `langgraph.types.default_retry_on` is the predicate a bare
    `RetryPolicy(max_attempts=2)` uses. It answers **False** for every
    `RuntimeError`, which is what `ApiError` and `TransportError` both are --
    so three nodes carried a retry that could not fire for any failure this
    package raises, and could fire only for an unwrapped `httpx` leak. If a
    future langgraph changes this predicate, this test says so out loud
    rather than leaving four hand-written tuples looking unmotivated.
    """
    from langgraph.types import default_retry_on

    assert issubclass(TransportError, ApiError)
    assert issubclass(ApiError, RuntimeError)
    assert default_retry_on(ApiError(503, "unavailable", None)) is False
    assert default_retry_on(TransportError(httpx.ConnectError("refused"))) is False
    # ...and the one class it DOES retry, which is §15.3 row 17's exact shape.
    assert default_retry_on(httpx.CookieConflict("two cookies")) is True


def test_a_permanent_execute_failure_is_not_retried(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """§5.4: "Permanent failures (404/403) are not retried."

    `execute_step` is NOT idempotent -- it walks the surviving actions in
    order and posts each one -- so a retry after a 404 re-posts everything
    that already landed. That is the whole reason `retry_on` is narrowed.
    """
    calls: list[str] = []

    def explode(**_kwargs: Any) -> Any:
        calls.append("execute")
        raise ApiError(404, "no such post", None)

    monkeypatch.setattr(nodes_module, "execute_step", explode)
    with pytest.raises(ApiError):
        _run(tmp_path)
    assert calls == ["execute"]


def test_a_transient_execute_failure_is_retried(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The other half: a request that never reached the server at all
    (`TransportError`, `status=0`) is worth one more attempt."""
    calls: list[str] = []

    def explode(**_kwargs: Any) -> Any:
        calls.append("execute")
        raise TransportError(httpx.ConnectError("refused"))

    monkeypatch.setattr(nodes_module, "execute_step", explode)
    with pytest.raises(TransportError):
        _run(tmp_path)
    assert len(calls) > 1


def test_a_permanent_api_error_is_not_retried_at_the_login_node(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """§5.4: permanent failures are not retried. `login`'s tuple names
    `TransportError` alone, so a 503 (and a 404, and a 403) is attempted once
    -- excluded BY TYPE rather than by inspecting `.status`, since
    `TransportError` always carries `status=0`.

    Kills "widen `login`'s `retry_on` to bare `Exception`".
    """
    calls: list[str] = []

    def explode(**_kwargs: Any) -> Any:
        calls.append("login")
        raise ApiError(503, "unavailable", None)

    monkeypatch.setattr(nodes_module, "login_step", explode)
    with pytest.raises(ApiError):
        _run(tmp_path)
    assert calls == ["login"]


def test_a_transient_login_failure_is_retried(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The other half of `login`'s policy, and what makes its `retry_on`
    observable at all: `login` is the one wholly idempotent node in the cycle
    (a read-only probe, a PATCH of a constant value, and reads), so a request
    that never reached the server is worth one more attempt.

    Kills `max_attempts=1` on `login`.
    """
    calls: list[str] = []

    def explode(**_kwargs: Any) -> Any:
        calls.append("login")
        raise TransportError(httpx.ConnectError("refused"))

    monkeypatch.setattr(nodes_module, "login_step", explode)
    with pytest.raises(TransportError):
        _run(tmp_path)
    assert len(calls) > 1


def test_the_plan_node_is_attempted_exactly_once(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`plan` makes no HTTP call: its one call is an LLM SUBPROCESS, and every
    subprocess failure is already normalised below it (`TimeoutExpired` ->
    `""` -> `BackendUnavailableError` -> `plan_round` returns `None` ->
    `BACKEND_UNAVAILABLE`). The one exception that escapes,
    `BackendBinaryMissingError`, is permanent. So a retry here can only pay
    for a second LLM call before failing identically.

    Raised here as `httpx.CookieConflict` on purpose: that is the ONE class
    the library default WOULD have retried, so this test discriminates
    `max_attempts=1` from the default policy the node used to carry -- an
    `ApiError` would pass under both.
    """
    calls: list[str] = []

    def explode(**_kwargs: Any) -> Any:
        calls.append("plan")
        raise httpx.CookieConflict("two cookies named sid")

    monkeypatch.setattr(nodes_module, "plan_step", explode)
    with pytest.raises(httpx.CookieConflict):
        _run(tmp_path)
    assert calls == ["plan"]


def test_a_permanent_api_error_is_not_retried_at_the_snapshot_node(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`snapshot` is already fail-soft INSIDE the step -- it catches
    `(EmbedderUnavailable, WriteNotVerifiedError, ApiError)` and returns
    `ok=False`. Its policy therefore only scopes what a future narrowing of
    that catch could let escape, and a permanent server refusal is not in it.

    Kills "widen `snapshot`'s `retry_on` to bare `Exception`".
    """
    calls: list[str] = []

    def explode(**_kwargs: Any) -> Any:
        calls.append("snapshot")
        raise ApiError(403, "forbidden", None)

    monkeypatch.setattr(nodes_module, "snapshot_step", explode)
    with pytest.raises(ApiError):
        _run(tmp_path)
    assert calls == ["snapshot"]


def test_a_transient_snapshot_failure_is_retried(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Retry-safe HERE for a reason no other node has: the server dedupes
    snapshots by `contentHash`, so an upload that may or may not have landed
    (exactly what `status=0` means) cannot produce a duplicate row on a second
    attempt.

    Kills `max_attempts=1` on `snapshot`.
    """
    calls: list[str] = []

    def explode(**_kwargs: Any) -> Any:
        calls.append("snapshot")
        raise TransportError(httpx.ConnectError("refused"))

    monkeypatch.setattr(nodes_module, "snapshot_step", explode)
    with pytest.raises(TransportError):
        _run(tmp_path)
    assert len(calls) > 1


# ── `execute` is not idempotent: the property, and the condition ────────────

_POST_A: Final = "a" * 24
_POST_B: Final = "b" * 24
_TWO_LIKES: Final = (
    f'{{"plan":[{{"action":"like","postId":"{_POST_A}"}},'
    f'{{"action":"like","postId":"{_POST_B}"}}]}}'
)


def test_a_failure_after_an_action_landed_does_not_re_execute_it(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """THE property `execute`'s narrow `retry_on` exists for.

    `execute_step` walks the surviving actions in order and is NOT
    idempotent: a node-level retry re-runs it from the top, and every action
    that already landed lands again. So whatever reaches this node's boundary
    after N actions have landed must not be retried.

    The failure injected here is the realistic one: an `OSError` from the
    `memory.md` append (`open(...).write()` -- a full disk, a bad
    permission), which is the ONLY thing `execute_step` can raise after an
    action has landed. Every API failure is absorbed one layer down (see the
    sibling test), so a `TransportError` cannot get here at all.

    Kills "widen `execute`'s `retry_on` to bare `Exception`" (and to
    `(OSError,)`): under either, the retry re-likes post A and
    `resources.liked` reads `[A, B, A, B]`.
    """
    root = _agent_root(tmp_path)
    persona = _persona(root)
    resources = FakeResources()
    real_write = act_round._write_memory_line

    def failing_write(directory: Path, action: Any, result: Any, **kwargs: Any) -> None:
        if action.post_id == _POST_B:
            raise OSError("No space left on device")
        real_write(directory, action, result, **kwargs)

    monkeypatch.setattr(act_round, "_write_memory_line", failing_write)
    backend = ScriptedBackend(_TWO_LIKES, _valid_candidate(), "叙述")
    with pytest.raises(OSError, match="No space left"):
        _run(tmp_path, persona=persona, deps=_deps(tmp_path, backend=backend, resources=resources))

    assert resources.liked == [_POST_A, _POST_B]


def test_a_transport_failure_mid_loop_is_absorbed_and_never_reaches_the_boundary(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The CONDITION under which `retry_on=(TransportError,)` is safe on a
    non-idempotent node (standing constraint §7), written down as a test
    rather than as a comment.

    `execute_action` catches `(ApiError, WriteNotVerifiedError)` around every
    write and `TransportError` subclasses `ApiError`, so a transport failure
    while executing an action becomes a `landed=False` `ActionResult` -- the
    round continues and the node is entered exactly once. The moment that
    stops being true, this policy becomes a duplicate-post generator.
    """
    root = _agent_root(tmp_path)
    resources = FakeResources(like_raises=TransportError(httpx.ConnectError("refused")))
    backend = ScriptedBackend(_TWO_LIKES, _valid_candidate(), "叙述")
    trace = _trace_steps(monkeypatch)
    final = _run(
        tmp_path,
        persona=_persona(root),
        deps=_deps(tmp_path, backend=backend, resources=resources),
    )
    assert trace.count("execute_step") == 1
    assert final["landed"] == 0
    assert final["attempted"] == 2
    assert final["outcome"] is ActOutcome.LANDED_PARTIAL


# ── the loops, both OFF by default ──────────────────────────────────────────


def test_the_default_configuration_takes_neither_loop(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`MAX_ROUNDS=1` and dream retry OFF are the defaults; a graph that
    loops by default doubles every account's LLM spend.

    The dream is REJECTED here on purpose -- that is the state loop 2 tests,
    so a default that had it on would be visible as a second `dream_step`.
    """
    backend = ScriptedBackend(_plan_json(), _rejected_candidate(), "叙述")
    trace = _trace_steps(monkeypatch)
    _run(tmp_path, deps=_deps(tmp_path, backend=backend))
    assert trace.count("login_step") == 1
    assert trace.count("plan_step") == 1
    assert trace.count("execute_step") == 1
    assert trace.count("dream_step") == 1
    assert trace.count("gate_step") == 1


def test_loop_three_reruns_the_act_phase_against_rebuilt_deps(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Loop 3, enabled. Round 2 must be planned against REBUILT deps: reusing
    round 1's `memory_text` hides round 1's own posts from
    `ActContext.today_post_count`, and the rhythm gate would let the account
    post again over its ceiling.

    The two rounds' deps carry different `memory_text`, so a graph that
    resolved deps once and reused them shows up as round 2 planning against
    round 1's memory.
    """
    root = _agent_root(tmp_path)
    persona = _persona(root)
    # Round 2's deps carry a DIFFERENT `now` as well, so the one read
    # `run_cycle` makes for itself -- `provider(0)`, for the round id and the
    # dry-run flag -- is distinguishable from a read of any later round's.
    per_round = {
        0: _deps(tmp_path, memory_text="round-one-memory"),
        1: _deps(tmp_path, memory_text="round-two-memory", now=NOW + timedelta(hours=3)),
    }
    seen: list[str] = []
    real_context = nodes_module.context_step

    def spy(**kwargs: Any) -> Any:
        seen.append(str(kwargs["memory_text"]))
        return real_context(**kwargs)

    monkeypatch.setattr(nodes_module, "context_step", spy)
    final = _run(
        tmp_path,
        persona=persona,
        deps=lambda index: per_round[min(index, 1)],
        config=CycleConfig(max_rounds=2),
    )
    assert seen == ["round-one-memory", "round-two-memory"]
    assert final["thread_id"] == f"builtin:{DIR_NAME}:{NOW.strftime('%Y%m%dT%H%M%S')}"


def test_loop_three_refuses_to_run_against_frozen_deps(tmp_path: Path) -> None:
    """`CycleDeps` is frozen for the whole cycle, so enabling loop 3 with a
    single instance would silently plan round 2 against round 1's snapshot of
    `memory.md`, `context/now.md` and the follow-topic feed. Refused at the
    call rather than left to be discovered as an over-ceiling post."""
    with pytest.raises(ValueError, match="rebuilt"):
        _run(tmp_path, config=CycleConfig(max_rounds=2))


def test_loop_two_retries_a_rejected_dream_once_and_then_writes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Loop 2, enabled: a rejected candidate earns exactly one more attempt,
    and the retry's own verdict is final whichever way it goes."""
    backend = ScriptedBackend(_plan_json(), _rejected_candidate(), _rejected_candidate(), "叙述")
    trace = _trace_steps(monkeypatch)
    _run(
        tmp_path,
        deps=_deps(tmp_path, backend=backend),
        config=CycleConfig(max_dream_attempts=2),
    )
    assert trace.count("dream_step") == 2
    assert trace.count("gate_step") == 2
    assert trace.count("write_step") == 1


def test_loop_two_does_not_retry_a_dream_that_was_accepted(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The retry is keyed on the REJECTION, not on the attempt count -- an
    accepted dream with budget left over must not be dreamt again."""
    trace = _trace_steps(monkeypatch)
    _run(tmp_path, config=CycleConfig(max_dream_attempts=2))
    assert trace.count("dream_step") == 1
    assert trace.count("write_step") == 1


def test_the_dream_retry_ceiling_is_one_retry() -> None:
    """Spec §5.4: "loop 2 (default OFF, max 1 retry)". Two attempts is the
    ceiling; a config asking for more is refused rather than quietly
    tripling an account's dream spend."""
    with pytest.raises(ValueError, match="retry"):
        CycleConfig(max_dream_attempts=3)
    with pytest.raises(ValueError, match="at least one"):
        CycleConfig(max_dream_attempts=0)


def test_a_cycle_must_run_at_least_one_round() -> None:
    with pytest.raises(ValueError, match="at least one"):
        CycleConfig(max_rounds=0)


# ── routing ─────────────────────────────────────────────────────────────────


def test_an_offline_probe_stops_before_the_planner(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`ActResult.grants_dream`: `OFFLINE` is one of the two outcomes that
    deny the account its dream. Routing it into `plan` would spend an LLM
    call on a platform the round already knows is unreachable."""
    trace = _trace_steps(monkeypatch)
    final = _run(tmp_path, deps=_deps(tmp_path, health_check=lambda: False))
    assert final["outcome"] is ActOutcome.OFFLINE
    assert trace == ["login_step"]


def test_a_dead_backend_stops_before_the_guardrail(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`BACKEND_UNAVAILABLE` is the other one. No plan means nothing to
    guard, nothing to execute, and (§7.1) no dream."""

    class Silent:
        name = "silent"

        def complete(self, req: CompletionRequest) -> str:
            raise RuntimeError("never called for a plan")

    trace = _trace_steps(monkeypatch)

    def no_plan(**_kwargs: Any) -> Any:
        return None

    monkeypatch.setattr(nodes_module, "plan_step", no_plan)
    final = _run(tmp_path)
    assert final["outcome"] is ActOutcome.BACKEND_UNAVAILABLE
    assert "guardrail_step" not in trace
    assert "cooldown_step" not in trace


def test_an_empty_plan_skips_execute_but_still_dreams(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """§5.4's "(rhythm veto / empty)" edge, and design spec §7.1's whole
    point: a deliberately empty round is the agent choosing not to act, and
    Bash's rc=75 cost it a personality evolution for it.

    `execute_step` must not run -- entered on an empty list `finalize_step`
    turns the guardrail's `VETOED_EMPTY` into `LANDED_PARTIAL` and logs
    Bash's FAIL line.

    `round_index` is what discriminates the EDGE from the node's own guard.
    The execute node returns `{}` for an empty action list without calling
    either step (Task 7's belt to this braces), so a router that sent every
    round through `execute` would produce an identical trace and an identical
    outcome -- and differ only in having counted an act round that never
    executed. Two mutations (route to `execute` unconditionally; route on
    `plan` rather than on the post-guardrail survivors) survived the trace
    assertions alone.
    """
    backend = ScriptedBackend('{"plan":[]}', _valid_candidate(), "叙述")
    trace = _trace_steps(monkeypatch)
    final = _run(tmp_path, deps=_deps(tmp_path, backend=backend))
    assert final["outcome"] is ActOutcome.PLANNER_EMPTY
    assert "execute_step" not in trace
    assert "finalize_step" not in trace
    assert trace.count("dream_step") == 1
    assert final["round_index"] == 0


def test_a_rejected_dream_still_reaches_write_and_snapshot(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The gate's rejection is NOT an edge that routes around the write.
    `verdict` and `written` are THREADED into the two steps that write, and
    each guards internally -- so deleting a guard turns red, where a graph
    that branched instead could lose both guards with every test green.

    "keep original" in §5.4's diagram IS `write_step` under a rejecting
    verdict.
    """
    backend = ScriptedBackend(_plan_json(), _rejected_candidate(), "叙述")
    source = FakePersonaSource()
    trace = _trace_steps(monkeypatch)
    final = _run(tmp_path, deps=_deps(tmp_path, backend=backend, persona_source=source))
    assert trace.count("write_step") == 1
    assert trace.count("snapshot_step") == 1
    assert final["written"] is False
    assert source.archived == []


def test_a_dream_that_produced_no_candidate_skips_the_gate(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A cooldown SKIP, an empty rewrite and a blown deadline all leave
    `candidate` unset. The gate node `_require`s it, so an unconditional
    edge would turn every one of those quiet rounds into a `NodeStateError`."""
    state = FakeState()
    state.record_dream(DIR_NAME, at=int(NOW.timestamp()) - 3600, memlines=0)
    trace = _trace_steps(monkeypatch)
    final = _run(tmp_path, deps=_deps(tmp_path, dream_state=state, auto=True))
    assert final["proceeded"] is False
    assert "gate_step" not in trace
    assert "write_step" not in trace


def test_a_full_cycle_runs_every_step_in_the_order_the_scripts_do(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """login → plan → guardrail → execute → dream → gate → write → snapshot
    → logout, expanded to the twelve steps the nine nodes call.

    Asserted on EFFECTS as well as on the trace: the post reached the API,
    the `memory.md` line landed in this persona's own directory, and every
    lab event was filed under the `Username` bullet -- which is the half of
    the identity that is NOT the directory name, and the only way to tell
    that the persona the caller passed is the persona the nodes ran.
    """
    root = _agent_root(tmp_path)
    persona = _persona(root)
    resources = FakeResources()
    trace = _trace_steps(monkeypatch)
    final = _run(tmp_path, persona=persona, deps=_deps(tmp_path, resources=resources))
    assert [post.text for post in resources.created_posts] == ["你好世界"]
    assert "你好世界" in (persona.directory / "memory.md").read_text(encoding="utf-8")
    assert {username for username, _ in resources.snapshots} == {USERNAME}
    assert trace == [
        "login_step",
        "sync_backend_step",
        "context_step",
        "plan_step",
        "guardrail_step",
        "execute_step",
        "finalize_step",
        "cooldown_step",
        "dream_step",
        "gate_step",
        "write_step",
        "snapshot_step",
    ]
    assert final["outcome"] is ActOutcome.LANDED_ALL
    assert final["written"] is True


def test_an_empty_rewrite_skips_the_gate_although_the_dream_proceeded(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The OTHER no-candidate shape, and the one that separates "did this
    account dream at all" from "did the dream produce anything": the cooldown
    let it through, the backend returned nothing, and `candidate` is still
    unset. Routing on `proceeded` instead of on the candidate passes the
    cooldown test and dies here with a `NodeStateError` out of the gate."""
    backend = ScriptedBackend(_plan_json(), "")
    trace = _trace_steps(monkeypatch)
    final = _run(tmp_path, deps=_deps(tmp_path, backend=backend))
    assert final["proceeded"] is True
    assert final.get("candidate") is None
    assert "gate_step" not in trace
    assert "write_step" not in trace


def test_a_many_round_configuration_does_not_hit_the_recursion_limit(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """LangGraph's default recursion limit is 25 supersteps, and one act round
    costs four. A five-round cycle needs more than the default, so the limit
    has to be DERIVED from the config -- otherwise the first operator to turn
    loop 3 up meets a `GraphRecursionError` with nothing explaining it."""
    per_round = {index: _deps(tmp_path) for index in range(5)}
    # Index 5 is the DREAM phase's deps -- resolved after the last act round,
    # exactly as `CycleContext.deps_for_round` documents -- so its backend is
    # scripted for the rewrite, not for a plan.
    per_round[5] = _deps(tmp_path, backend=ScriptedBackend(_valid_candidate(), "叙述"))
    trace = _trace_steps(monkeypatch)
    final = _run(
        tmp_path,
        deps=lambda index: per_round[index],
        config=CycleConfig(max_rounds=5),
    )
    assert trace.count("login_step") == 5
    assert trace.count("execute_step") == 5
    assert final["round_index"] == 5
    assert final["written"] is True


def test_the_final_state_is_the_whole_cycles_state(tmp_path: Path) -> None:
    """`run_cycle` returns the accumulated `CycleState`, not the last node's
    partial -- the logout node returns `{}`, so a caller reading the last
    update alone would get nothing at all."""
    final = _run(tmp_path, run_id="run-abc", round_id="r1")
    assert final["agent"] == DIR_NAME
    assert final["run_id"] == "run-abc"
    assert final["thread_id"] == f"builtin:{DIR_NAME}:r1"
    assert final["outcome"] is ActOutcome.LANDED_ALL
    assert final["verdict"] is not None
    assert final["snapshot_ok"] is True


# ── the lease that wraps the whole cycle ────────────────────────────────────


class _Probe:
    """A `health_check` that answers True and records what the world looked
    like at the moment the FIRST node ran -- i.e. with the lease held."""

    def __init__(self, db: sqlite3.Connection, root: Path) -> None:
        self._db = db
        self._root = root
        self.rows: list[tuple[Any, ...]] = []
        self.lock_files: list[str] = []

    def __call__(self) -> bool:
        self.rows = _rows(self._db)
        self.lock_files = sorted(
            path.name for path in (self._root / ".agent-state").glob("*lock_*")
        )
        return True


def test_the_cycle_holds_both_bash_visible_lock_files_while_it_runs(
    tmp_path: Path,
) -> None:
    """Stages 3-4 run Bash and Python over the same 23 accounts. Bash reads
    `.agent-state/lock_<name>` (auto-run.sh:407) and
    `.agent-state/dream_lock_<name>` (dream.sh:460) and nothing else -- a
    cycle that acts AND dreams must hold both, or a concurrent `dream.sh`
    rewrites `personality.md` underneath this one."""
    db = _lease_db(tmp_path)
    root = _agent_root(tmp_path)
    probe = _Probe(db, root)
    _run(tmp_path, persona=_persona(root), deps=_deps(tmp_path, health_check=probe), db=db)
    assert probe.lock_files == [f"dream_lock_{DIR_NAME}", f"lock_{DIR_NAME}"]
    assert {(row[2], row[1]) for row in probe.rows} == {("act", DIR_NAME), ("dream", DIR_NAME)}


def test_the_lease_is_keyed_on_the_directory_name_not_the_username(
    tmp_path: Path,
) -> None:
    """`auto-run.sh:407` derives the lock name with `basename "$agent_dir"`,
    and folder name and `Username` bullet diverge on this roster. A lease
    built from the username computes a DIFFERENT lock path than the Bash
    round it is meant to exclude -- with every test still green, because
    both runtimes would simply be locking files nobody else looks at."""
    db = _lease_db(tmp_path)
    root = _agent_root(tmp_path)
    probe = _Probe(db, root)
    _run(tmp_path, persona=_persona(root), deps=_deps(tmp_path, health_check=probe), db=db)
    assert act_lock_path(root, DIR_NAME).name in probe.lock_files
    assert act_lock_path(root, USERNAME).name not in probe.lock_files
    assert {row[1] for row in probe.rows} == {DIR_NAME}


def test_both_leases_are_released_when_the_cycle_ends(tmp_path: Path) -> None:
    """The orphan-lock class: an accepted dream that exits without running
    its cleanup leaves `dream_lock_<name>` behind and every later round
    SKIPs the account for 30 minutes."""
    db = _lease_db(tmp_path)
    root = _agent_root(tmp_path)
    _run(tmp_path, persona=_persona(root), deps=_deps(tmp_path), db=db)
    assert _rows(db) == []
    assert not act_lock_path(root, DIR_NAME).exists()
    assert not dream_lock_path(root, DIR_NAME).exists()


def test_a_cycle_that_dies_mid_round_still_releases_both_leases(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Same property, on the path that actually produced the orphans."""
    db = _lease_db(tmp_path)
    root = _agent_root(tmp_path)

    def explode(**_kwargs: Any) -> Any:
        raise RuntimeError("boom")

    monkeypatch.setattr(nodes_module, "gate_step", explode)
    with pytest.raises(RuntimeError):
        _run(tmp_path, persona=_persona(root), deps=_deps(tmp_path), db=db)
    assert _rows(db) == []
    assert not act_lock_path(root, DIR_NAME).exists()
    assert not dream_lock_path(root, DIR_NAME).exists()


def test_a_busy_lease_stops_the_cycle_before_any_node_runs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Bash logs `SKIP <name> — locked` and moves on; the lease raises
    `LeaseBusy` for the CLI to turn into the same SKIP. Nothing may run
    first -- a plan built and then discarded is a paid LLM call."""
    from swil_agent.graph.leases import LeaseBusy

    db = _lease_db(tmp_path)
    root = _agent_root(tmp_path)
    trace = _trace_steps(monkeypatch)
    with (
        RunLease(_lease_db(tmp_path), root, "builtin", DIR_NAME, "act", run_id="other"),
        pytest.raises(LeaseBusy),
    ):
        _run(tmp_path, persona=_persona(root), deps=_deps(tmp_path), db=db)
    assert trace == []


def test_a_dry_run_takes_no_lease_at_all(tmp_path: Path) -> None:
    """F4, applied where the graph's lock actually is: a dry run executes
    nothing and writes nothing, so it needs no mutual exclusion -- and taking
    the lock makes the documented safe-inspection command cost a concurrent
    real Bash round its whole turn."""
    db = _lease_db(tmp_path)
    root = _agent_root(tmp_path)
    probe = _Probe(db, root)
    _run(
        tmp_path,
        persona=_persona(root),
        deps=_deps(tmp_path, health_check=probe, dry_run=True),
        db=db,
    )
    assert probe.lock_files == []
    assert probe.rows == []


def test_a_dry_run_never_reaches_the_dream_phase(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Design spec §9.4: a shadow round "builds context and produces a plan
    but executes nothing and **writes nothing**".

    The dream phase has no `dry_run` to be inert under -- `write_step`
    archives and rewrites `personality.md`, `snapshot_step` publishes it, and
    `dream_step` CONSUMES the one-shot `echo_flag_<name>` marker -- so a dry
    cycle that entered it would have rewritten 23 personalities and uploaded
    23 snapshots during the round whose whole premise is that Python never
    wrote. Nothing in the suite could see this before: every dry-run test used
    a `FakePersonaSource`, so the writes went to a list instead of to disk.

    Asserted on EFFECTS and on SPEND: no archive, no snapshot, no cooldown
    marker read -- and exactly ONE backend call, the plan. A version that
    merely skipped the two write steps would still pay for a dream per
    account.
    """
    root = _agent_root(tmp_path)
    source = FakePersonaSource()
    resources = FakeResources()
    backend = ScriptedBackend(_plan_json(), _valid_candidate(), "叙述")
    trace = _trace_steps(monkeypatch)
    final = _run(
        tmp_path,
        persona=_persona(root),
        deps=_deps(
            tmp_path,
            dry_run=True,
            persona_source=source,
            resources=resources,
            backend=backend,
        ),
    )
    assert trace == list(_ACT_STEPS)
    assert not any(step in trace for step in _DREAM_STEPS)
    assert len(backend.calls) == 1
    assert source.archived == []
    assert source.appended == []
    assert resources.snapshots == []
    assert final.get("written") is None
    assert final["dry_run"] is True


def test_a_dry_run_still_plans_and_still_applies_the_guardrails(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The other half: §9.4's comparison set is the rhythm policy, the
    guardrail verdicts and the veto lists, so a dry run that stopped BEFORE
    the planner would make the shadow round measure nothing at all.

    `_dream_or_logout` is the only router that consults `dry_run`;
    `_continue_or_logout` (login -> plan, plan -> guardrail) must not.
    """
    root = _agent_root(tmp_path)
    resources = FakeResources()
    trace = _trace_steps(monkeypatch)
    final = _run(
        tmp_path,
        persona=_persona(root),
        deps=_deps(tmp_path, dry_run=True, resources=resources),
    )
    assert "plan_step" in trace
    assert "guardrail_step" in trace
    assert final["rhythm"] is not None
    assert final["plan"] is not None
    assert [action.kind for action in final["actions"]] == ["post"]
    # ...and the two steps that WRITE still ran, still inert -- `dry_run` is
    # threaded INTO them rather than short-circuited above them, exactly as
    # `run_act` does it, so a caller that is not `run_act` cannot get a "dry"
    # round that posts (standing constraint §5).
    assert "execute_step" in trace
    assert "sync_backend_step" in trace
    assert resources.created_posts == []
    assert resources.profile_patches == []
    assert final["attempted"] == 0


def test_the_lease_row_lands_in_the_injected_database(tmp_path: Path) -> None:
    """The lease DB is INJECTED, not derived from `agent_root` -- which is
    exactly where a node could have built one for itself. Placing it outside
    `agent_root` is what makes the injection observable at all."""
    db = _lease_db(tmp_path)
    root = _agent_root(tmp_path)
    probe = _Probe(db, root)
    _run(tmp_path, persona=_persona(root), deps=_deps(tmp_path, health_check=probe), db=db)
    assert probe.rows != []
    assert list((root / ".agent-state").glob("*.sqlite")) == []


def test_both_leases_are_beaten_between_nodes(tmp_path: Path) -> None:
    """Without a heartbeat, a cycle running past `LEASE_TTL_SECONDS` has its
    lock file reclaimed by the next Bash round WHILE IT IS STILL HELD, and
    both runtimes act on the same account.

    Observed as an effect, per lease KIND: each row's `heartbeat_at` at the
    plan node is strictly later than at the login node, which can only happen
    if a beat fired between the two. Per kind rather than in aggregate,
    because beating only the act lease leaves the dream lock exactly as
    reclaimable as an unbeaten one -- and a `max()` over both rows cannot
    tell.

    The clock is INJECTED and lives at 1_000_000.0, a domain no real
    `time.time()` reaches (~1.7e9). A version that ignored `lease_clock` and
    used the wall clock would still produce strictly increasing stamps at
    microsecond resolution, so "increasing" alone would not discriminate.
    """
    db = _lease_db(tmp_path)
    root = _agent_root(tmp_path)
    seen: list[dict[str, float]] = []

    def stamps() -> dict[str, float]:
        return {str(row[2]): float(row[4]) for row in _rows(db)}

    def at_login() -> bool:
        seen.append(stamps())
        return True

    class WatchingBackend(ScriptedBackend):
        def complete(self, req: CompletionRequest) -> str:
            seen.append(stamps())
            return super().complete(req)

    backend = WatchingBackend(_plan_json(), _valid_candidate(), "叙述")
    _run(
        tmp_path,
        persona=_persona(root),
        deps=_deps(tmp_path, health_check=at_login, backend=backend),
        db=db,
        lease_clock=_counting_clock(),
    )
    assert len(seen) >= 2
    at_login_stamps, at_plan_stamps = seen[0], seen[1]
    assert sorted(at_login_stamps) == ["act", "dream"]
    for kind in ("act", "dream"):
        assert at_plan_stamps[kind] > at_login_stamps[kind], f"{kind} lease was never beaten"
        assert _CLOCK_BASE <= at_login_stamps[kind] < _CLOCK_BASE + 10_000

    # The beat is worth having only because Bash reclaims at this exact
    # window; `RunLease` and `auto-run.sh:423` share the number.
    assert LEASE_TTL_SECONDS == 1800.0


# ── the checkpointer ────────────────────────────────────────────────────────


def test_resuming_without_a_checkpointer_is_refused_at_the_call(tmp_path: Path) -> None:
    """`resume=True` streams `None`, which only means "continue" when there is
    a checkpoint to continue FROM. Without a checkpointer langgraph would
    raise `EmptyInputError: Received no input for __start__` from deep inside
    `stream()` -- a confusing way to learn that the caller forgot an argument,
    and one the CLI would report as `UNEXPECTED`."""
    with pytest.raises(ValueError, match="checkpointer"):
        _run(tmp_path, resume=True)


def test_the_checkpointer_is_the_injected_one(tmp_path: Path) -> None:
    """Same discriminability problem as the lease DB, and the same fix: the
    checkpoint database lives outside `agent_root`, so a graph compiled
    without the injected saver (or with one it built itself) leaves the
    injected file with no rows for this thread."""
    db_path = tmp_path / "injected_checkpoints" / "cycle.sqlite"
    saver = open_checkpointer(db_path)
    root = _agent_root(tmp_path)
    _run(
        tmp_path,
        persona=_persona(root),
        deps=_deps(tmp_path),
        checkpointer=saver,
        round_id="r7",
        run_id="run-7",
    )
    stored = saver.get({"configurable": {"thread_id": f"builtin:{DIR_NAME}:r7"}})
    assert stored is not None
    assert list((root / ".agent-state").glob("*.sqlite")) == []


def test_a_checkpointed_cycle_keeps_its_types(tmp_path: Path) -> None:
    """§15.1 row 16: an unregistered type comes back DOWNGRADED, not
    rejected. `open_checkpointer` is the registration, and this is the pin
    that the cycle actually goes through it."""
    saver = open_checkpointer(tmp_path / "injected_checkpoints" / "cycle.sqlite")
    root = _agent_root(tmp_path)
    _run(
        tmp_path,
        persona=_persona(root),
        deps=_deps(tmp_path),
        checkpointer=saver,
        round_id="r8",
    )
    stored = saver.get({"configurable": {"thread_id": f"builtin:{DIR_NAME}:r8"}})
    assert stored is not None
    assert isinstance(stored["channel_values"]["outcome"], ActOutcome)
    assert isinstance(stored["channel_values"]["persona"], Persona)


def test_the_round_id_defaults_to_the_cycles_own_frozen_moment(tmp_path: Path) -> None:
    """`deps.now` is the cycle's moment; a fresh `datetime.now()` here would
    make a resumed thread id unreproducible, which is what `--resume` reads."""
    final = _run(tmp_path)
    assert final["thread_id"] == f"builtin:{DIR_NAME}:{NOW.strftime('%Y%m%dT%H%M%S')}"


def test_the_run_id_reaches_the_lease_row(tmp_path: Path) -> None:
    """`RunLease` releases identity-scoped on `run_id`: a holder whose lease
    was reclaimed while still running must not delete its successor's row.
    That only works if the cycle's own run id is what goes in."""
    db = _lease_db(tmp_path)
    root = _agent_root(tmp_path)
    probe = _Probe(db, root)
    _run(
        tmp_path,
        persona=_persona(root),
        deps=_deps(tmp_path, health_check=probe),
        db=db,
        run_id="run-xyz",
    )
    assert {row[3] for row in probe.rows} == {"run-xyz"}


def test_the_tenant_reaches_both_the_thread_id_and_the_lease(tmp_path: Path) -> None:
    """Multi-tenancy is a value change, not a migration (§5.5) -- which only
    holds if the tenant is threaded rather than defaulted at each use."""
    db = _lease_db(tmp_path)
    root = _agent_root(tmp_path)
    probe = _Probe(db, root)
    final = _run(
        tmp_path,
        persona=_persona(root),
        deps=_deps(tmp_path, health_check=probe),
        db=db,
        tenant="acme",
        round_id="r2",
    )
    assert final["thread_id"] == f"acme:{DIR_NAME}:r2"
    assert final["tenant"] == "acme"
    assert {row[0] for row in probe.rows} == {"acme"}
