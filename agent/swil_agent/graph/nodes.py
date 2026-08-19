"""The cycle's nodes: `CycleState` in, a PARTIAL `CycleState` out.

Each node adapts the graph's single threaded value to the step functions
`act/round.py` and `dream/round.py` already expose, and does nothing else.
That rule is the whole point of the split (ruling R4): `run_act` / `run_dream`
and the graph run ONE implementation of every decision, so the CLI path and
the durable path cannot drift into two behaviours. A line of logic that lives
here and nowhere else is a line the CLI does not execute -- and the reverse,
a guard left in `run_act`'s body, is a guard the graph does not get. Both
have already happened once each in this migration; both were caught by the
step-level tests, not by the oracles.

**Dependencies do not live in `CycleState`.** The state is CHECKPOINTED --
msgpack, SQLite -- so it carries only values that can survive a process
restart: the persona, the plan, the verdict. An `httpx` client, a subprocess
runner and a live `sqlite3.Connection` cannot. So the collaborators arrive
through `CycleDeps`, bound into each node by a factory (`make_login_node`
and friends) at graph-assembly time, and the node itself keeps the plain
`(state) -> partial` shape LangGraph wants.

**Node -> step map.** §5.4's topology names nine nodes; Tasks 5 and 6
extracted twelve steps. Three nodes therefore call more than one step, and
each grouping is a behavioural constraint rather than a tidying:

  * `login` -> `login_step`, `sync_backend_step`, `context_step`. Bash's own
    order: probe, then the `agentBackend` PATCH (`auto-run.sh:473-494`,
    after login and before any context is built), then the read-side
    assembly. Putting the sync in any later node drops it entirely on every
    early-return path -- measured in Task 5's review, with the whole suite
    green, on the field that is the drift experiment's independent variable.
  * `plan` -> `plan_step`.
  * `guardrail` -> `guardrail_step`. PURE -- no I/O at all, which is why
    §5.4 gives it no retry policy.
  * `execute` -> `execute_step`, `finalize_step`. §5.4's topology has no
    `finalize` node, and the smart mark-read is gated on `landed > 0` from
    the tally `execute_step` has just produced.
  * `dream` -> `cooldown_step`, `dream_step`. The cooldown gate must decide
    BEFORE `dream_step` consumes the one-shot echo flag.
  * `gate` -> `gate_step`; `write` -> `write_step`; `snapshot` ->
    `snapshot_step`.
  * `logout` -> nothing. §7.4 removed the `active` file, so no session
    artefact is left to clear; what remains is §7.6's terminal record.

**Where the guards are, and why none of them are here.** `dry_run` is
threaded into `sync_backend_step`, `execute_step` and `finalize_step`;
`verdict` into `write_step`; `written` into `snapshot_step`. Every one of
those steps guards INTERNALLY, so a mis-wired edge writes nothing rather
than writing the wrong thing. A node that branched above the step instead
would move the decision back out of the step, and both write guards could
then be deleted with every oracle green -- the path where a rejected
candidate overwrites `personality.md`.

**The deadline.** LangGraph refuses `timeout=` on a sync node at `compile()`
time, and the async form returns control while ORPHANING the subprocess
(both measured; spec §5.4 as corrected). So a node making several bounded
calls is bounded in aggregate by an explicit deadline computed at node entry
-- `dream` is that node.

One correction to the plan's description of it, recorded rather than quietly
worked around: the plan (and §5.4's table) attributes "candidate + 3x
distill" to the `dream` node. In the shipped code the three distill calls are
made inside `gate_step` -> `evaluate_candidate` -> `_aspect_similarities`,
i.e. in the `gate` node. The `dream` node makes exactly ONE bounded LLM call
(the rewrite candidate), and its deadline bounds the prompt-assembly reads
plus that call. A deadline on the `gate` node could only be checked before
`evaluate_candidate` is entered -- never BETWEEN the distill calls -- without
changing `dream/gate.py`, so none is claimed here.
"""

from __future__ import annotations

import logging
import random
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Final

from swil_agent.act.round import (
    context_step,
    execute_step,
    finalize_step,
    guardrail_step,
    login_step,
    plan_step,
    sync_backend_step,
)
from swil_agent.api.resources import Resources
from swil_agent.config import Settings
from swil_agent.dream.candidate import DreamState
from swil_agent.dream.distill import Embedder
from swil_agent.dream.round import (
    cooldown_step,
    dream_step,
    gate_step,
    snapshot_step,
    write_step,
)
from swil_agent.graph.state import CycleState
from swil_agent.llm.base import Backend, Runner
from swil_agent.models import ActOutcome, Persona
from swil_agent.persona.source import PersonaSource

logger = logging.getLogger(__name__)

# The dream node's own FAIL line is a DREAM-PHASE record and must land in
# `agent/logs/dream.log`, not `auto-run.log` -- the two files are different
# destinations (`auto-run.sh:34` vs `dream.sh:40`) and the `cycle` command
# routes a record to one or the other by the LOGGER THAT EMITTED IT
# (`cli.py`'s `_DREAM_LOG_SOURCES`). This module is the one place that emits
# both phases: the deadline FAIL below is the dream's, and the logout record
# is the cycle's own terminal line, which belongs with the act log where
# Bash's `=== auto-run complete ===` lives. A single module logger cannot
# express that, so the dream-phase one is named as a child -- inheriting this
# module's level and handlers, so `caplog.at_level(..., logger=
# "swil_agent.graph.nodes")` still sees it.
dream_logger = logging.getLogger(f"{__name__}.dream")

NodeFn = Callable[[CycleState], CycleState]

# The `dream` node's aggregate budget. One rewrite call capped at
# `SubprocessRunner`'s 300s, plus the group-memory / echo-flag reads that
# build its prompt -- 600s is that with room, not a limit anyone should hit.
# Overridable per cycle via `CycleDeps.dream_deadline_seconds`.
DREAM_DEADLINE_SECONDS: Final = 600.0

_DEADLINE_REASON: Final = "dream deadline exceeded before the rewrite call"

# What a shadow round records instead of dreaming. `run_cycle` routes a dry
# cycle straight from the act phase to logout, so this reason is normally
# unreachable -- it exists so that a mis-drawn edge produces a legible
# "nothing happened" state rather than a real dream.
_DRY_RUN_REASON: Final = "dry run: the dream phase is skipped entirely"


class NodeStateError(RuntimeError):
    """A node was entered without a value an earlier node was supposed to
    have produced -- i.e. the graph is mis-wired.

    Loud on purpose. Every one of these has a silent alternative that looks
    like a normal quiet round: planning against a blank `ActContext()`
    (no feed, no notifications, no memory), or recording `memlines=0` and
    doubling the account's dream rate from the next round on.
    """


def agent_dir_name(persona: Persona) -> str:
    """The account's identity everywhere in this runtime: the persona
    DIRECTORY name, never the `Username` bullet.

    Bash derives it with `basename "$agent_dir"` (`auto-run.sh:407`) and
    builds `.agent-state/lock_${agent_name}` from it; `dream.sh:460` does the
    same. The two fields diverge on this roster (CLAUDE.md's "stray
    agents/<name> dir shadows a humans/ account"), and the failure is silent
    in both directions -- a lease keyed on the username locks a path nobody
    else looks at, and a log line keyed on it names an account the operator
    cannot find. Named as a function so the lease wiring (Task 8) has one
    obvious call site to share with the nodes rather than re-deriving it.
    """
    return persona.directory.name


@dataclass(frozen=True)
class CycleDeps:
    """Everything a node needs that `CycleState` cannot carry.

    Frozen and built ONCE per cycle by the composition root, mirroring what
    `cli.py` already hands `run_act` / `run_dream`: the same clients, the
    same frozen `now`, the same `context_now` / `feed_context` / `memory_text`
    strings read from disk before the round starts.

    Two consequences of "once per cycle" that Task 8 owns rather than this
    module:

      * `now` / `captured_at` are frozen for the whole cycle, where the CLI
        takes a fresh `datetime.now()` for its act command and another for
        its dream command. Within one cycle that is a difference of minutes
        in an archive stamp, and it keeps the graph path byte-comparable
        against the direct path for the parity oracle.
      * `memory_text`, `context_now` and `feed_context` are snapshots. If
        loop 3 (multi-round, `MAX_ROUNDS=1` by default, i.e. OFF) is ever
        turned on, round 2 must be given REBUILT deps -- reusing round 1's
        `memory_text` would hide round 1's own posts from
        `ActContext.today_post_count`, and the rhythm gate would let the
        account post again over its ceiling.
    """

    resources: Resources
    backend: Backend
    persona_source: PersonaSource
    runner: Runner
    embedder: Embedder
    dream_state: DreamState
    settings: Settings
    agent_root: Path
    health_check: Callable[[], bool]
    memory_text: str
    context_now: str = "(no context file)"
    feed_context: str = ""
    budget: int = 5
    access_key: str | None = None
    dry_run: bool = False
    auto: bool = False
    rng: random.Random = field(default_factory=random.Random)
    now: datetime = field(default_factory=datetime.now)
    captured_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    dream_deadline_seconds: float = DREAM_DEADLINE_SECONDS
    monotonic: Callable[[], float] = time.monotonic


def _require[T](value: T | None, *, key: str, node: str) -> T:
    if value is None:
        raise NodeStateError(f"the {node} node was entered without {key!r} in CycleState")
    return value


def make_login_node(deps: CycleDeps) -> NodeFn:
    """`login_step` -> `sync_backend_step` -> `context_step`.

    The probe comes first and an offline probe returns immediately: Bash's
    `check_internet` runs once in Main, before any per-account work, so an
    offline round PATCHes nothing and reads nothing.

    `login_step`'s lock is deliberately NOT entered. A node cannot hold a
    context manager across nodes -- it is not serializable checkpoint state
    -- so the graph path takes a `RunLease` around the whole cycle
    (`graph/leases.py`, ruling R2) and uses this step for the probe alone.
    Entering it here would create `.agent-state/lock_<name>` and release it
    one node later, which during stages 3-4 is enough to make a concurrent
    Bash round SKIP the account entirely.
    """

    def login(state: CycleState) -> CycleState:
        persona = state["persona"]
        # `agent_root` and `dry_run` are EQUIVALENT MUTANTS here, and only
        # here: inside `login_step` both feed the lock CHOICE alone
        # (`FileLock(act_lock_path(agent_root, name))` vs `nullcontext()`),
        # and this node discards `step.lock`. So substituting either changes
        # nothing observable and no test can kill it -- do not "fix" that by
        # inventing an assertion. They stop being equivalent the moment a
        # caller stops discarding the lock, which is exactly what Task 8's
        # `RunLease` wiring does when it takes the same paths; the pins for
        # both then live with the lease, not here.
        step = login_step(
            persona=persona,
            agent_root=deps.agent_root,
            health_check=deps.health_check,
            dry_run=deps.dry_run,
        )
        if not step.online:
            return {"agent": step.agent_name, "outcome": ActOutcome.OFFLINE}

        sync_backend_step(
            resources=deps.resources,
            persona=persona,
            agent_name=step.agent_name,
            dry_run=deps.dry_run,
        )
        context, rhythm = context_step(
            resources=deps.resources,
            persona=persona,
            memory_text=deps.memory_text,
            now=deps.now,
            rng=deps.rng,
            budget=deps.budget,
            context_now=deps.context_now,
            feed_context=deps.feed_context,
        )
        return {"agent": step.agent_name, "context": context, "rhythm": rhythm}

    return login


def make_plan_node(deps: CycleDeps) -> NodeFn:
    """`plan_step`. `None` back means the backend produced nothing at all,
    which is one of the only two outcomes that deny the account its dream --
    so the label is set here rather than inferred downstream from a missing
    plan (an empty plan and an absent one are different rounds)."""

    def plan(state: CycleState) -> CycleState:
        planned = plan_step(
            backend=deps.backend,
            persona=state["persona"],
            context=_require(state.get("context"), key="context", node="plan"),
            rhythm=_require(state.get("rhythm"), key="rhythm", node="plan"),
        )
        if planned is None:
            return {"plan": None, "outcome": ActOutcome.BACKEND_UNAVAILABLE}
        return {"plan": planned}

    return plan


def make_guardrail_node(deps: CycleDeps) -> NodeFn:
    """`guardrail_step`. PURE: it reads `deps.budget` and nothing else off
    `deps`, so this node performs no I/O of any kind -- which is why §5.4
    gives it no retry policy and why a test asserts it cannot even touch
    `Resources`.

    `actions` (the survivors) is a separate field from `plan` (the model's
    original proposal) on purpose: `ActResult` reports both, and §7.5 exists
    because "guardrails dropped all five" and "the model proposed nothing"
    were indistinguishable.
    """

    def guardrail(state: CycleState) -> CycleState:
        guarded = guardrail_step(
            plan=_require(state.get("plan"), key="plan", node="guardrail"),
            persona=state["persona"],
            rhythm=_require(state.get("rhythm"), key="rhythm", node="guardrail"),
            context=_require(state.get("context"), key="context", node="guardrail"),
            budget=deps.budget,
        )
        update: CycleState = {
            "actions": guarded.actions,
            "vetoed": guarded.vetoed,
            "solo_nothing": guarded.solo_nothing,
        }
        if guarded.empty_outcome is not None:
            update["outcome"] = guarded.empty_outcome
        return update

    return guardrail


def make_execute_node(deps: CycleDeps) -> NodeFn:
    """`execute_step` -> `finalize_step`, both threaded `dry_run`.

    An empty `actions` list returns an empty partial instead of running the
    steps. That mirrors `run_act`'s item 7 -- an empty plan is an early
    return, not a step -- and in the graph the equivalent is an edge that
    routes around this node. This is the belt to that braces: entered by
    mistake, the node must not run `finalize_step` and convert the
    `VETOED_EMPTY` the guardrail node just decided into `LANDED_PARTIAL`
    plus Bash's FAIL line. A solo `nothing` is NOT this case -- it is a
    surviving action and still executes.
    """

    def execute(state: CycleState) -> CycleState:
        actions = state.get("actions") or []
        if not actions:
            return {}

        persona = state["persona"]
        agent_name = agent_dir_name(persona)
        results, attempted, landed = execute_step(
            resources=deps.resources,
            persona=persona,
            actions=actions,
            agent_name=agent_name,
            now=deps.now,
            access_key=deps.access_key,
            dry_run=deps.dry_run,
        )
        outcome = finalize_step(
            resources=deps.resources,
            actions=actions,
            agent_name=agent_name,
            attempted=attempted,
            landed=landed,
            solo_nothing=state.get("solo_nothing", False),
            dry_run=deps.dry_run,
        )
        return {
            "results": results,
            "attempted": attempted,
            "landed": landed,
            "outcome": outcome,
        }

    return execute


def make_dream_node(deps: CycleDeps) -> NodeFn:
    """`cooldown_step` -> `dream_step`, under an explicit deadline.

    The two steps are one node because the order between them is a
    correctness property, not a layout choice: `dream_step` CONSUMES the
    `echo_flag_<name>` marker ("only nudge once per dream",
    `dream.sh:533`), so it must not run for an account the cooldown gate
    would have SKIPped.

    The deadline is computed at entry and checked before the rewrite call --
    the one call in this node that can cost 300s. Exceeding it degrades to
    the same shape as an empty rewrite (proceeded, no candidate, a reason),
    rather than raising: a cycle that has already acted should still reach
    its logout record, and a candidate that was never generated cannot be
    written or snapshotted either way.

    `dry_run` is checked HERE as well as on the edge that routes a shadow
    round to logout, and this node needs it MORE than the write nodes do, not
    less: `dream_step` posts a `dream/dream/started` lab event and then
    CONSUMES the `echo_flag_<name>` marker -- deleting it. That consumption is
    IRREVERSIBLE. A shadow round that spent an account's one-shot echo nudge
    would silently change what its next real dream is prompted with, and
    nothing downstream could tell. The returned shape is `cooldown_step`'s own
    "did not proceed" pair, so no consumer sees a new third state.
    """

    def dream(state: CycleState) -> CycleState:
        if deps.dry_run:
            return {"proceeded": False, "dream_reason": _DRY_RUN_REASON}
        persona = state["persona"]
        deadline = deps.monotonic() + deps.dream_deadline_seconds

        cooldown = cooldown_step(
            persona=persona,
            persona_source=deps.persona_source,
            state=deps.dream_state,
            settings=deps.settings,
            now=deps.now,
            auto=deps.auto,
        )
        if not cooldown.proceed:
            return {"proceeded": False, "dream_reason": cooldown.reason}

        update: CycleState = {"proceeded": True, "memory_lines": cooldown.memory_lines}
        if deps.monotonic() >= deadline:
            dream_logger.warning("FAIL %s — %s", agent_dir_name(persona), _DEADLINE_REASON)
            update["dream_reason"] = _DEADLINE_REASON
            return update

        dreamt = dream_step(
            persona=persona,
            resources=deps.resources,
            backend=deps.backend,
            agent_root=deps.agent_root,
            memory_text=cooldown.memory_text,
        )
        if dreamt.failure_reason is not None:
            update["dream_reason"] = dreamt.failure_reason
            return update
        update["candidate"] = dreamt.candidate
        return update

    return dream


def make_gate_node(deps: CycleDeps) -> NodeFn:
    """`gate_step` -- the constitution layer. `aspect_sims` is re-projected
    off the verdict rather than recomputed, so the graph carries no second
    copy of the drift maths.

    `dry_run` completes the set: `gate_step` posts two lab events and, in the
    deployed `DRIFT_MODE=aspect`, writes `personality.anchor.aspects.json` for
    any account whose anchor cache is cold. An empty partial is the right
    return because nothing downstream needs a verdict on this path -- the
    write and snapshot nodes check `dry_run` before they `_require` one, and a
    dry cycle is routed away from the dream phase before reaching either.
    """

    def gate(state: CycleState) -> CycleState:
        if deps.dry_run:
            return {}
        verdict = gate_step(
            persona=state["persona"],
            candidate_text=_require(state.get("candidate"), key="candidate", node="gate"),
            resources=deps.resources,
            embedder=deps.embedder,
            runner=deps.runner,
            settings=deps.settings,
        )
        return {"verdict": verdict, "aspect_sims": verdict.sims}

    return gate


def make_write_node(deps: CycleDeps) -> NodeFn:
    """`write_step`, with the verdict THREADED IN rather than branched on.

    The step's own `verdict.accepted` guard is what stops a rejected
    candidate becoming the account's personality; skipping the call here
    would move that decision into the graph's edges, where deleting the
    guard costs nothing and defeating the constitution layer costs one
    mis-drawn arrow.

    `memory_lines` is required, never defaulted: the count is written into
    `last_dream_memlines_<name>` and a 0 there makes the NEXT round's
    cooldown override fire on any memory at all.

    `dry_run` is checked HERE and not only on the edge that routes a shadow
    round straight to logout (`graph/cycle.py`'s `_dream_or_logout`), because
    this function performs 100% of the dream's writes and `write_step` -- in
    the frozen `dream/round.py`, which predates the shadow round -- takes no
    `dry_run` to be inert under. Standing constraint §5: the guard belongs
    with the write, so that defeating it costs more than one mis-drawn arrow.
    The `WriteStep` shape returned is `write_step`'s own "nothing was written"
    pair, so every consumer downstream sees a rejected-dream-shaped round
    rather than a new third state.
    """

    def write(state: CycleState) -> CycleState:
        if deps.dry_run:
            return {"written": False, "narrative": ""}
        step = write_step(
            persona=state["persona"],
            persona_source=deps.persona_source,
            state=deps.dream_state,
            resources=deps.resources,
            backend=deps.backend,
            verdict=_require(state.get("verdict"), key="verdict", node="write"),
            candidate_text=_require(state.get("candidate"), key="candidate", node="write"),
            memory_lines=_require(state.get("memory_lines"), key="memory_lines", node="write"),
            now=deps.now,
        )
        return {"written": step.written, "narrative": step.narrative}

    return write


def make_snapshot_node(deps: CycleDeps) -> NodeFn:
    """`snapshot_step`, with `written` threaded in for the same reason the
    verdict is threaded into the write node.

    `narrative` comes off the state -- produced by the write node while
    `personality.md` still held the old text -- and defaults to `""`, which
    is what a rejected round legitimately carries. That default is exactly
    why the hand-off needs its own test: an unthreaded field is
    indistinguishable from an honest empty one, and every uploaded snapshot
    would silently lose `diffNarrative`.

    `dry_run` is checked here for the same reason as in the write node above:
    a snapshot is a PUBLISHED claim about this account's personality, and
    `snapshot_step` has no `dry_run` parameter. Belt to `_dream_or_logout`'s
    braces; the returned pair is `snapshot_step`'s own "no snapshot was owed"
    shape.
    """

    def snapshot(state: CycleState) -> CycleState:
        if deps.dry_run:
            return {"snapshot_ok": False, "snapshot_reason": None}
        # `verdict` here is read ONLY for the `aspectDrift` block
        # (`_aspect_drift_payload` -> `verdict.sims` / `verdict.breached`);
        # `snapshot_step` never consults `verdict.accepted`, because the gate
        # on publishing is `written`, not the verdict. A mutant that swaps in
        # a verdict differing only in `accepted` is therefore EQUIVALENT --
        # deliberately, since keying the upload off the verdict instead of
        # the write is the defect `test_the_snapshot_follows_the_write_not_
        # the_verdict` exists to prevent.
        step = snapshot_step(
            persona=state["persona"],
            resources=deps.resources,
            embedder=deps.embedder,
            settings=deps.settings,
            verdict=_require(state.get("verdict"), key="verdict", node="snapshot"),
            candidate_text=_require(state.get("candidate"), key="candidate", node="snapshot"),
            narrative=state.get("narrative", ""),
            agent_root=deps.agent_root,
            captured_at=deps.captured_at,
            written=state.get("written", False),
        )
        return {"snapshot_ok": step.ok, "snapshot_reason": step.reason}

    return snapshot


def make_logout_node(deps: CycleDeps) -> NodeFn:
    """The cycle's terminal record.

    There is no session to tear down: §7.4 removed `.agent-state/active`
    (agent identity is a value in `CycleState`, which is what makes parallel
    runs safe by construction rather than by the `SWIL_AGENT` workaround),
    and the lease that holds the Bash-visible lock file wraps the WHOLE
    cycle -- releasing anything here would hand a live successor a lock it
    does not hold, which is the ABA hole `RunLease` closed one layer down.

    So what is left is §7.6's structured line: `run_id`, the account, the
    act outcome and what the dream did. It is the only record that a cycle
    reached its end rather than dying somewhere in the middle.
    """

    def logout(state: CycleState) -> CycleState:
        logger.info(
            "logout %s — run_id=%s outcome=%s dream_written=%s snapshot_ok=%s dry_run=%s",
            agent_dir_name(state["persona"]),
            state.get("run_id", ""),
            state.get("outcome"),
            state.get("written", False),
            state.get("snapshot_ok", False),
            deps.dry_run,
        )
        return {}

    return logout
