"""Parity: the graph path and the direct path produce the same effects.

This is the test that makes the whole migration safe. For a fixed persona and
a fixed set of fake collaborators, `run_cycle` and the `run_act` + `run_dream`
pair must do the SAME THINGS -- the same API calls in the same order, the same
`memory.md` bytes, the same log lines, the same lab events, the same files on
disk, the same outcome.

**Asserted on recorded effects, not on return values.** Plan 2's three most
expensive defects were all invisible in the return value: a missing mark-read,
an absent `agentBackend` sync, a lab event that was never emitted. A parity
test that compared `ActResult`s would have passed through every one of them.
So every scenario here runs BOTH paths against two identical, freshly-seeded
roster directories and compares:

  * the ordered collaborator trace -- every `Resources` call, reads included,
    with the arguments that distinguish it;
  * `memory.md`'s bytes and its line count;
  * every `swil_agent` log record (logger name, level and rendered message,
    with the tmp root normalised out);
  * every lab event, in order;
  * a content hash of the WHOLE roster tree afterwards -- which is what
    catches `personality.md`, `personality.archive.md` and the two cooldown
    markers without anyone having to remember to assert on them;
  * the act outcome, the landed/attempted tally, and the dream's
    proceeded/written/reason triple.

**Two divergences are expected and are asserted to be the only ones:**

  * spec §15.1 **row 17** -- the cycle holds BOTH Bash-visible lock files for
    its whole duration, where `run_act` holds `lock_<name>` only during the
    act and `run_dream` holds `dream_lock_<name>` only during the dream.
    Observed at a probe INSIDE the round, not at the end: both paths finish
    with no lock files at all, so nothing about the end state can tell them
    apart.
  * spec §15.1 **row 19** (added by this task) -- the graph path emits §7.6's
    `logout` record, which has no equivalent in the direct path at all, and
    raises `LeaseBusy` where the direct path raises `LockBusy`.
  * spec §15.1 **row 21** (Plan 4) -- the graph path runs `analysis`'s two
    observability samplers, `behavior_snapshot` after the act phase and
    `rule_check` before the dream. The direct path runs neither: `run_act`
    and `run_dream` are frozen, and Bash makes both calls from the
    COMPOSITION (`auto-run.sh:806` inside `run_agent`, `cycle-one.sh:45`
    between the two scripts), which on the direct path is `cli.py`'s two
    separate commands. Asserted as a divergence by
    `test_the_graph_path_also_samples_rules_and_behaviour`. **Every scenario
    in this file, that one included, uses a KEY-LESS roster** -- so both
    samplers take their `no api_key.txt` skip path, and the whole divergence
    is one log line each with nothing on the wire. (An earlier draft of this
    paragraph claimed that test drives a keyed roster. It does not, and never
    did; the keyed version lives in `test_cycle_analysis_steps.py`. Corrected
    after review, and recorded rather than silently reworded, because a
    docstring that overstates what a test covers is the same failure class as
    a test that names a behaviour it cannot detect -- §15.4.)
  * spec §4 (2026-08-21 loop engine) -- the graph path emits one `cycle_run`
    card at logout (and a `missingSampler` warn if a sampler failed). The
    direct path is `run_act` + `run_dream`, not a cycle, so it has no card.
    Filtered by payload (`metrics.kind == cycle_run` / `missingSampler`),
    not by a blanket "graph emitted an extra event" rule. Positive pin:
    `test_cycle_run.py`.

Two corrections to the brief that produced this file, recorded rather than
absorbed (standing constraint §1 -- the source wins):

  * the brief names §15.1 rows 17-18 as "the dream gating" and "both locks".
    Read directly, **row 17 is the both-locks difference and row 18 is the
    lease heartbeat's per-node bound**; the dream-gating decision is §7.1 and
    has no §15 row at all.
  * that dream-gating difference could not show up here in any case. It is a
    Python-vs-BASH difference (`cycle-one.sh` skips the dream on any non-zero
    rc). Both paths compared here are Python and both consult
    `ActResult.grants_dream`, so they agree -- which
    `test_the_dream_gate_is_grants_dream_on_both_paths` asserts explicitly, so
    the agreement is pinned rather than merely absent.

One difference that is NOT a code divergence and is therefore held constant
rather than asserted: `cli.py`'s `act` and `dream` are two processes taking a
fresh `datetime.now()` each, while a cycle freezes one `now` for both phases.
Every scenario below passes the SAME `now`/`captured_at` to both paths, so
what is compared is the two implementations rather than two clocks.
"""

from __future__ import annotations

import hashlib
import logging
import random
import sqlite3
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest

from swil_agent.act.round import run_act
from swil_agent.api.client import ApiError
from swil_agent.api.dto import LabEvent
from swil_agent.config import Settings
from swil_agent.dream.candidate import FilesystemDreamState
from swil_agent.dream.round import run_dream
from swil_agent.graph.cycle import run_cycle
from swil_agent.graph.nodes import CycleDeps
from swil_agent.locks import act_lock_path, dream_lock_path
from swil_agent.models import ActOutcome, Persona
from swil_agent.persona.source import GitPersonaSource

from ._runners import FakeEmbedder, FakeResources, RecordingRunner, ScriptedBackend

NOW = datetime(2026, 8, 17, 10, 0, 0)
CAPTURED_AT = datetime(2026, 8, 17, 2, 0, 0, tzinfo=UTC)
SEED = 7

# Directory name and `Username` bullet differ on purpose, everywhere: the lock
# path, the log lines and the memory file are keyed on the DIRECTORY, the lab
# events and the snapshot on the `Username` BULLET. A fixture where the two
# coincide cannot tell a path that swapped them from one that did not.
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
- 自由发挥，看心情
"""

INITIAL_MEMORY = "2026-08-01 | act | did a thing\n"

POST_A = "a" * 24
POST_B = "b" * 24


def _valid_candidate() -> str:
    return PERSONALITY.replace("一句话", "改写过的一句话")


def _rejected_candidate() -> str:
    """Fails the structural `Username` validator, so the gate rejects before
    the embedder or the distiller is involved."""
    return PERSONALITY.replace("- **Username:** zenith", "- **Username:** someone_else")


def _plan(*actions: str) -> str:
    return '{"plan":[' + ",".join(actions) + "]}"


_POST = '{"action":"post","text":"你好世界"}'
_LIKE_A = f'{{"action":"like","postId":"{POST_A}"}}'
_LIKE_B = f'{{"action":"like","postId":"{POST_B}"}}'
_FOLLOW = '{"action":"follow","username":"someone"}'
_COMMENT = f'{{"action":"comment","postId":"{POST_A}","text":"回一句"}}'
_NOTHING = '{"action":"nothing"}'


# ── the effect trace ───────────────────────────────────────────────────────


class TracingResources(FakeResources):
    """`FakeResources`, plus an ORDERED trace of every call -- reads included.

    `FakeResources.calls` records writes only (several existing tests assert
    it is exactly empty to prove a plan never reached the executor), and a
    round's read order is exactly as much a part of its behaviour: Bash's
    `_remember` fires the memory lab event for action N BEFORE action N+1's
    write goes out, and collecting results first would reorder the wire calls
    while leaving every return value identical.
    """

    def __init__(self, trace: list[str], *, events_down: bool = False, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self._trace = trace
        self._events_down = events_down

    def _note(self, text: str) -> None:
        self._trace.append(text)

    def feed_global(self, limit: int, sort: str) -> list[dict[str, Any]]:
        self._note(f"feed_global limit={limit} sort={sort}")
        return super().feed_global(limit, sort)

    def notifications(self, limit: int, unread_only: bool = True) -> list[dict[str, Any]]:
        self._note(f"notifications limit={limit} unread_only={unread_only}")
        return super().notifications(limit, unread_only)

    def get_post(self, post_id: str) -> dict[str, Any]:
        self._note(f"get_post {post_id}")
        return super().get_post(post_id)

    def get_comments(self, post_id: str, limit: int = 6) -> list[dict[str, Any]]:
        self._note(f"get_comments {post_id} limit={limit}")
        return super().get_comments(post_id, limit)

    def contacts(self) -> list[str]:
        self._note("contacts")
        return super().contacts()

    def conversations(self, limit: int = 6) -> list[dict[str, Any]]:
        self._note(f"conversations limit={limit}")
        return super().conversations(limit)

    def get_boards(self) -> dict[str, str]:
        self._note("get_boards")
        return super().get_boards()

    def update_profile(self, patch: dict[str, Any]) -> None:
        self._note(f"update_profile {sorted(patch.items())}")
        super().update_profile(patch)

    def mark_notifications_read(self, ids: list[str] | None = None) -> None:
        self._note(f"mark_notifications_read {ids}")
        super().mark_notifications_read(ids)

    def create_post(
        self,
        text: str,
        board_id: str | None = None,
        image: tuple[str, bytes] | None = None,
        echo_of: str | None = None,
    ) -> str:
        self._note(
            f"create_post text={text!r} board={board_id} echo_of={echo_of} "
            f"image={None if image is None else image[0]}"
        )
        return super().create_post(text, board_id, image, echo_of)

    def create_comment(self, post_id: str, text: str, parent_id: str | None = None) -> str:
        self._note(f"create_comment post={post_id} parent={parent_id} text={text!r}")
        return super().create_comment(post_id, text, parent_id)

    def like_post(self, post_id: str) -> None:
        self._note(f"like_post {post_id}")
        super().like_post(post_id)

    def follow(self, username: str) -> None:
        self._note(f"follow {username}")
        super().follow(username)

    def send_dm(self, username: str, text: str) -> tuple[str, str]:
        self._note(f"send_dm to={username} text={text!r}")
        return super().send_dm(username, text)

    def lab_event(self, username: str, event: LabEvent) -> None:
        """`events_down` models the REAL outage shape, which is not an
        exception: `Resources.lab_event` catches `ApiError` itself and returns
        ("this never raises", contract `02` §5.3, Bash's `|| true`). Driving
        `_runners.FakeResources(lab_event_raises=...)` here instead aborts
        `execute_action` mid-round on BOTH paths -- a state production cannot
        reach, and one that says nothing about parity.
        """
        # The WHOLE wire body, not just type/phase/outcome: `summary`,
        # `reason`, `action`, `targetId` and `metrics` are the fields `/lab`
        # actually reads, and a path that got one of them wrong would produce
        # an identical three-part label.
        self._note(f"lab_event {username} {sorted(event.to_wire().items())}")
        if self._events_down:
            return
        super().lab_event(username, event)

    def create_snapshot(self, username: str, payload: dict[str, Any]) -> str:
        """The WHOLE payload, minus the embedding's floats.

        A digest of `contentHash` alone cannot see `diffNarrative` going
        missing -- the hash is of the candidate text, which is unchanged --
        and that is exactly Plan 2's "a lab event never emitted" class: a
        field silently absent from a body whose identity fields still match.
        `embedding` is reduced to its length so the trace stays readable; its
        CONTENT is compared separately, through `FakeEmbedder.embedded`, which
        records what was asked rather than what was answered.
        """
        body = sorted((key, value) for key, value in payload.items() if key != "embedding")
        self._note(f"create_snapshot {username} {body} emb_len={len(payload['embedding'])}")
        return super().create_snapshot(username, payload)


@dataclass
class Effects:
    """Everything one run of one path did that anybody can observe."""

    calls: list[str] = field(default_factory=list)
    log: list[str] = field(default_factory=list)
    lab_events: list[str] = field(default_factory=list)
    memory: str = ""
    tree: dict[str, str] = field(default_factory=dict)
    backend_prompts: list[str] = field(default_factory=list)
    embedded: list[list[str]] = field(default_factory=list)
    outcome: str = ""
    tally: tuple[int, int] = (0, 0)
    dream: tuple[bool, bool, str] = (False, False, "")
    locks_during_act: list[str] = field(default_factory=list)


def _tree(root: Path) -> dict[str, str]:
    """Content hash of every file under `root`, keyed by relative path.

    A whole-tree hash rather than a list of the files this test happens to
    think about: `personality.md`, `personality.archive.md`, `memory.md`,
    `last_dream_<name>` and `last_dream_memlines_<name>` are all written by
    the dream path, and the one nobody remembers to assert on is the one that
    silently diverges. Lock files are transient and gone by the end -- they
    are observed separately, DURING the round.
    """
    hashes: dict[str, str] = {}
    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue
        rel = path.relative_to(root).as_posix()
        if rel.startswith(".agent-state/") and ("lock_" in rel or rel.endswith(".sqlite")):
            continue
        hashes[rel] = hashlib.sha256(path.read_bytes()).hexdigest()
    return hashes


def _normalise(text: str, root: Path) -> str:
    """Two runs live under two different tmp directories, and `dream/gate.py`
    logs the persona DIRECTORY into its structural-failure line. Without this
    every rejected-dream scenario would "diverge" on the tmp path alone."""
    return text.replace(str(root), "<root>")


# ── the two paths ──────────────────────────────────────────────────────────


@dataclass
class Scenario:
    """One round, described once and run down both paths."""

    name: str
    plan: str = _plan(_POST)
    candidate: str = ""
    narrative: str = "叙述"
    dry_run: bool = False
    auto: bool = False
    online: bool = True
    plan_is_none: bool = False
    resource_kwargs: dict[str, Any] = field(default_factory=dict)
    events_down: bool = False
    embedder_fails: bool = False
    notifications: list[dict[str, Any]] = field(default_factory=list)
    seed_last_dream_hours_ago: float | None = None
    board: str | None = None
    boards: dict[str, str] = field(default_factory=dict)

    def responses(self) -> tuple[str, ...]:
        return (self.plan, self.candidate or _valid_candidate(), self.narrative)


def _seed_roster(root: Path) -> Path:
    directory = root / "agents" / DIR_NAME
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "personality.md").write_text(PERSONALITY, encoding="utf-8")
    (directory / "memory.md").write_text(INITIAL_MEMORY, encoding="utf-8")
    (root / "context").mkdir(parents=True, exist_ok=True)
    (root / "context" / "now.md").write_text("今天的新闻\n", encoding="utf-8")
    (root / "context" / f"feed_for_{USERNAME}.md").write_text("关注流\n", encoding="utf-8")
    return directory


def _persona(root: Path, scenario: Scenario) -> Persona:
    return Persona(
        username=USERNAME,
        directory=_seed_roster(root),
        backend="claude",
        model=None,
        rhythm_text="",
        raw=PERSONALITY,
        board=scenario.board,
    )


@dataclass
class Collaborators:
    """One fresh set per path -- shared instances would let the second run see
    the first one's call counters, scripted-response cursor and dedupe
    state."""

    resources: TracingResources
    backend: ScriptedBackend
    embedder: FakeEmbedder
    runner: RecordingRunner
    source: GitPersonaSource
    state: FilesystemDreamState
    settings: Settings
    trace: list[str]
    locks_seen: list[str]


def _collaborators(root: Path, scenario: Scenario) -> Collaborators:
    trace: list[str] = []
    resources = TracingResources(
        trace, events_down=scenario.events_down, **scenario.resource_kwargs
    )
    resources.notification_items = list(scenario.notifications)
    resources.board_lookup = dict(scenario.boards)
    embedder = (
        FakeEmbedder(fail_always=True)
        if scenario.embedder_fails
        else FakeEmbedder(vectors=[[1.0], [1.0]])
    )
    if scenario.seed_last_dream_hours_ago is not None:
        state_dir = root / ".agent-state"
        state_dir.mkdir(parents=True, exist_ok=True)
        at = int(NOW.timestamp() - scenario.seed_last_dream_hours_ago * 3600)
        (state_dir / f"last_dream_{DIR_NAME}").write_text(str(at), encoding="utf-8")
        (state_dir / f"last_dream_memlines_{DIR_NAME}").write_text(
            str(INITIAL_MEMORY.count("\n")), encoding="utf-8"
        )
    return Collaborators(
        resources=resources,
        backend=ScriptedBackend(*scenario.responses()),
        embedder=embedder,
        runner=RecordingRunner(),
        source=GitPersonaSource(root),
        state=FilesystemDreamState(root / ".agent-state"),
        settings=Settings(agent_root=root, drift_mode="scalar"),
        trace=trace,
        locks_seen=[],
    )


def _lock_probe(root: Path, seen: list[str], *, online: bool) -> Callable[[], bool]:
    """A `health_check` that records the Bash-visible lock files at the moment
    the round's FIRST step runs.

    Both paths end with no lock files at all, so an end-state assertion cannot
    tell "held for the whole cycle" from "held only during the act" -- which
    is exactly spec §15.1 row 18's divergence.
    """

    def probe() -> bool:
        seen.extend(sorted(path.name for path in (root / ".agent-state").glob("*lock_*")))
        return online

    return probe


def _deps(root: Path, scenario: Scenario, collab: Collaborators) -> CycleDeps:
    return CycleDeps(
        resources=collab.resources,
        backend=collab.backend,
        persona_source=collab.source,
        runner=collab.runner,
        embedder=collab.embedder,
        dream_state=collab.state,
        settings=collab.settings,
        agent_root=root,
        health_check=_lock_probe(root, collab.locks_seen, online=scenario.online),
        memory_text=collab.source.read_memory(DIR_NAME),
        context_now=(root / "context" / "now.md").read_text(encoding="utf-8"),
        feed_context=(root / "context" / f"feed_for_{USERNAME}.md").read_text(encoding="utf-8"),
        budget=5,
        access_key="KEY",
        dry_run=scenario.dry_run,
        auto=scenario.auto,
        rng=random.Random(SEED),
        now=NOW,
        captured_at=CAPTURED_AT,
    )


def _collect(
    root: Path,
    collab: Collaborators,
    records: list[logging.LogRecord],
    *,
    outcome: str,
    tally: tuple[int, int],
    dream: tuple[bool, bool, str],
) -> Effects:
    return Effects(
        calls=list(collab.trace),
        log=[
            f"{record.name} {record.levelname} {_normalise(record.getMessage(), root)}"
            for record in records
        ],
        lab_events=[
            str(sorted(_normalise(str(item), root) for item in event.to_wire().items()))
            for event in collab.resources.lab_events
        ],
        memory=(root / "agents" / DIR_NAME / "memory.md").read_text(encoding="utf-8"),
        tree=_tree(root),
        backend_prompts=[_normalise(call.user, root) for call in collab.backend.calls],
        embedded=[list(batch) for batch in collab.embedder.embedded],
        outcome=outcome,
        tally=tally,
        dream=dream,
        locks_during_act=list(collab.locks_seen),
    )


def _run_graph(root: Path, scenario: Scenario, records: list[logging.LogRecord]) -> Effects:
    collab = _collaborators(root, scenario)
    persona = _persona(root, scenario)
    lease_db = sqlite3.connect(":memory:")
    try:
        final = run_cycle(
            persona=persona,
            deps=_deps(root, scenario, collab),
            lease_db=lease_db,
            round_id="parity",
            run_id="graph-run",
        )
    finally:
        lease_db.close()
    outcome = final.get("outcome")
    return _collect(
        root,
        collab,
        records,
        outcome=outcome.value if outcome is not None else "",
        tally=(final.get("landed", 0), final.get("attempted", 0)),
        dream=(
            final.get("proceeded", False),
            final.get("written", False),
            _dream_reason(final.get("dream_reason"), final.get("verdict")),
        ),
    )


def _dream_reason(reason: str | None, verdict: Any) -> str:
    return reason or (verdict.reason if verdict is not None else "")


def _run_direct(root: Path, scenario: Scenario, records: list[logging.LogRecord]) -> Effects:
    """`run_act`, then `run_dream` -- the composition `cli.py`'s two commands
    make between them.

    The dream is gated on `ActResult.grants_dream`, which is what `act`'s exit
    code IS and what `cycle-one.sh` branches on. It is also skipped for a dry
    run, because `swil-agent dream` has no `--dry-run` at all: the honest
    direct-path equivalent of a shadow cycle is an act-only round.
    """
    collab = _collaborators(root, scenario)
    persona = _persona(root, scenario)
    result = run_act(
        persona=persona,
        resources=collab.resources,
        backend=collab.backend,
        memory_text=collab.source.read_memory(DIR_NAME),
        agent_root=root,
        now=NOW,
        rng=random.Random(SEED),
        health_check=_lock_probe(root, collab.locks_seen, online=scenario.online),
        budget=5,
        context_now=(root / "context" / "now.md").read_text(encoding="utf-8"),
        feed_context=(root / "context" / f"feed_for_{USERNAME}.md").read_text(encoding="utf-8"),
        dry_run=scenario.dry_run,
        access_key="KEY",
        # `cli.py`'s `act` command passes both (Phase B task 2), and this
        # function's contract is "the composition cli.py's two commands make
        # between them". Omitting them here would not expose a divergence --
        # it would MANUFACTURE one, since the act-path self-similarity sample
        # lives in `execute_step`, which both paths call.
        embedder=collab.embedder,
        similarity_window=collab.settings.act_similarity_window,
        # Same reason, one task later (Phase B task 3): `cli.py`'s `act`
        # command passes it, so omitting it here would make the direct path
        # roll against the module default while the graph path rolled against
        # `Settings` -- a divergence this file would then report as real.
        cross_read_prob=collab.settings.cross_read_prob,
    )
    proceeded, written, reason = False, False, ""
    if result.grants_dream and not scenario.dry_run:
        dreamt = run_dream(
            persona=persona,
            persona_source=collab.source,
            resources=collab.resources,
            backend=collab.backend,
            runner=collab.runner,
            embedder=collab.embedder,
            state=collab.state,
            settings=collab.settings,
            agent_root=root,
            now=NOW,
            captured_at=CAPTURED_AT,
            auto=scenario.auto,
        )
        proceeded, written, reason = dreamt.proceeded, dreamt.accepted, dreamt.reason
    return _collect(
        root,
        collab,
        records,
        outcome=result.outcome.value,
        tally=(result.landed, result.attempted),
        dream=(proceeded, written, reason),
    )


# `graph/nodes.py` emits §7.6's logout record, which the direct path has no
# equivalent for at all -- it is the ONE log line a cycle produces that
# `run_act` + `run_dream` cannot.
_GRAPH_ONLY_LOG_PREFIX = "swil_agent.graph.nodes INFO logout"

# Spec §15.1 row 21, closed by Plan 4: the cycle runs `analysis`'s
# observability samplers (`behavior_snapshot` after the act phase,
# `rule_check` before the dream, `population_metric` at the tail) and the
# direct path runs none of them, because `run_act` and `run_dream` are frozen
# ports of `auto-run.sh`'s act path and `dream.sh` -- the first two calls live
# in `auto-run.sh:806` and `cycle-one.sh:45`, i.e. in the composition, which on
# the direct path is the CLI. The third has no Bash call site at ALL: nothing
# invoked `population-metric.sh`, which is why the homogenization trend held
# three points in four months (measured 2026-08-20).
#
# Filtered by LOGGER NAME rather than by message, and that is what keeps this
# from being the blanket filter the logout line was deliberately not given: no
# record from `swil_agent.analysis.*` can reach the direct path at all, so
# every line this removes is one the divergence accounts for by construction.
# `test_the_graph_path_also_samples_rules_and_behaviour` pins the positive
# claim (the samplers really do run, and really do not on the direct path);
# the exact-one-logout assertion below is unchanged, so a duplicated act line
# is still caught by count.
_ANALYSIS_LOG_PREFIX = "swil_agent.analysis."


def _both(
    tmp_path: Path, scenario: Scenario, caplog: pytest.LogCaptureFixture
) -> tuple[Effects, Effects]:
    """Run the scenario down each path, against its own freshly-seeded roster.

    Two roots rather than one reset directory: the comparison includes a
    whole-tree hash, and a reset that missed one file would silently make the
    second path start from the first path's output.

    `caplog.records` is passed LIVE, not copied: it is read inside `_collect`,
    after the run. Copying it at the call would capture the empty list from
    before the round and make every log comparison trivially equal.
    """
    collected: list[Effects] = []
    for label, runner_fn in (("graph", _run_graph), ("direct", _run_direct)):
        root = tmp_path / label
        root.mkdir(parents=True, exist_ok=True)
        _seed_roster(root)
        caplog.clear()
        with caplog.at_level(logging.INFO, logger="swil_agent"):
            collected.append(runner_fn(root, scenario, caplog.records))
    return collected[0], collected[1]


def _is_cycle_ledger(encoded: str) -> bool:
    """The cycle_run card and missingSampler audit rows are graph-only."""
    return "'kind': 'cycle_run'" in encoded or "missingSampler" in encoded


def _assert_parity(graph: Effects, direct: Effects, scenario: Scenario) -> None:
    """Field by field, so a divergence names itself instead of printing two
    opaque dataclasses."""
    graph_calls = [call for call in graph.calls if not _is_cycle_ledger(call)]
    assert graph_calls == direct.calls, f"{scenario.name}: collaborator call order diverged"
    graph_events = [event for event in graph.lab_events if not _is_cycle_ledger(event)]
    assert graph_events == direct.lab_events, f"{scenario.name}: lab events diverged"
    # The card is attempted even when the events endpoint is down -- the
    # collaborator trace records the call; `lab_events` only keeps what
    # landed. A dry run must attempt nothing.
    ledger_calls = [call for call in graph.calls if _is_cycle_ledger(call)]
    if scenario.dry_run:
        assert ledger_calls == [], f"{scenario.name}: a dry run posted a cycle_run card"
    else:
        assert any("'kind': 'cycle_run'" in call for call in ledger_calls), (
            f"{scenario.name}: expected a cycle_run card on the graph path"
        )
    assert graph.memory == direct.memory, f"{scenario.name}: memory.md bytes diverged"
    assert graph.tree == direct.tree, f"{scenario.name}: the roster tree diverged"
    assert graph.backend_prompts == direct.backend_prompts, f"{scenario.name}: prompts diverged"
    assert graph.embedded == direct.embedded, f"{scenario.name}: what was embedded diverged"
    assert graph.outcome == direct.outcome, f"{scenario.name}: outcome diverged"
    assert graph.tally == direct.tally, f"{scenario.name}: landed/attempted diverged"
    assert graph.dream == direct.dream, f"{scenario.name}: the dream's result diverged"

    # The two expected log differences (§7.6 and §15.1 row 21), removed rather
    # than ignored: a blanket "ignore extra graph lines" filter would hide a
    # real one. The logout line is still counted EXACTLY, since it is the one
    # a duplicated act line could hide behind.
    without_logout = [line for line in graph.log if not line.startswith(_GRAPH_ONLY_LOG_PREFIX)]
    assert len(without_logout) == len(graph.log) - 1, (
        f"{scenario.name}: expected exactly one logout line"
    )
    graph_log = [line for line in without_logout if not line.startswith(_ANALYSIS_LOG_PREFIX)]
    assert graph_log == direct.log, f"{scenario.name}: log lines diverged"


SCENARIOS = [
    Scenario(name="a normal post, accepted dream"),
    Scenario(name="a rhythm-vetoed empty plan", plan=_plan()),
    Scenario(name="a solo nothing plan", plan=_plan(_NOTHING)),
    Scenario(name="a rejected dream", candidate=_rejected_candidate()),
    Scenario(name="an empty rewrite", candidate=""),
    Scenario(name="an unreachable embedder", embedder_fails=True),
    Scenario(name="a dry run", dry_run=True),
    Scenario(name="an offline probe", online=False),
    Scenario(
        name="a cooldown skip",
        auto=True,
        seed_last_dream_hours_ago=1,
    ),
    Scenario(name="a multi-action round", plan=_plan(_POST, _LIKE_A, _FOLLOW)),
    Scenario(
        name="a comment round that marks notifications read",
        plan=_plan(_COMMENT),
        notifications=[
            {"id": "n1", "type": "comment", "post": {"id": POST_A}},
            {"id": "n2", "type": "like", "post": {"id": POST_B}},
        ],
    ),
    Scenario(
        name="a round where every action fails",
        plan=_plan(_LIKE_A, _LIKE_B),
        resource_kwargs={"like_raises": ApiError(500, "boom", None)},
    ),
    Scenario(
        name="a partially landed round",
        plan=_plan(_POST, _LIKE_A),
        resource_kwargs={"like_raises": ApiError(500, "boom", None)},
    ),
    Scenario(
        name="an agentBackend sync that 403s",
        resource_kwargs={"update_profile_raises": ApiError(403, "forbidden", None)},
    ),
    Scenario(
        name="a snapshot upload that fails",
        resource_kwargs={"snapshot_raises": ApiError(502, "bad gateway", None)},
    ),
    Scenario(name="a lab-event outage", events_down=True),
    Scenario(name="a post filed to a board", board="tech", boards={"tech": "board-1"}),
    Scenario(name="a post whose board cannot be resolved", board="tech"),
]


@pytest.mark.parametrize("scenario", SCENARIOS, ids=lambda s: s.name)
def test_the_graph_path_and_the_direct_path_have_the_same_effects(
    tmp_path: Path, caplog: pytest.LogCaptureFixture, scenario: Scenario
) -> None:
    graph, direct = _both(tmp_path, scenario, caplog)
    _assert_parity(graph, direct, scenario)


def test_a_dead_backend_stops_both_paths_at_the_same_point(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """`plan_round` returns `None` when the backend produced nothing at all,
    which is one of the only two outcomes that deny the account its dream.

    Driven by a backend whose FIRST response is unparseable rather than by
    monkeypatching `plan_step`, so both paths reach the same `None` through
    the same code -- a monkeypatch on the module global would be seen by the
    graph path (which resolves it at call time) and not by `run_act`.
    """
    scenario = Scenario(name="a dead backend", plan="not json at all")
    graph, direct = _both(tmp_path, scenario, caplog)
    assert graph.outcome == ActOutcome.BACKEND_UNAVAILABLE.value
    _assert_parity(graph, direct, scenario)


# ── the known divergences, asserted to BE the divergences ──────────────────


def test_the_cycle_holds_both_locks_where_the_direct_path_holds_one(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """Spec §15.1 row 17, pinned rather than described.

    A cycle acts AND dreams in one process and `dream.sh` checks only
    `dream_lock_<name>`, so a cycle that took only the act lease would let a
    concurrent Bash `dream.sh` rewrite `personality.md` underneath its own
    dream. The cost is real and is the point of recording it: during a
    Python cycle's dream phase the ACT lock is still held, where the direct
    path's would already be free.

    Observed DURING the round -- both paths end with no lock files at all, so
    nothing about the end state can tell them apart.
    """
    scenario = Scenario(name="lock scope")
    graph, direct = _both(tmp_path, scenario, caplog)

    assert graph.locks_during_act == [f"dream_lock_{DIR_NAME}", f"lock_{DIR_NAME}"]
    assert direct.locks_during_act == []

    for root in (tmp_path / "graph", tmp_path / "direct"):
        assert not act_lock_path(root, DIR_NAME).exists()
        assert not dream_lock_path(root, DIR_NAME).exists()


def test_the_graph_path_adds_exactly_one_log_line_of_its_own(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """§7.6's terminal record: the only line that says a cycle reached its end
    rather than dying somewhere in the middle. The direct path has no
    equivalent -- `cycle-one.sh` ends by returning an exit code, not by
    logging.

    Asserted by LENGTH rather than by set difference: a graph path that logged
    an act line twice would produce a duplicate that `line not in direct.log`
    cannot see, so the count is what discriminates. The arithmetic names the
    two accounted-for differences explicitly -- ONE logout record (§7.6) plus
    the THREE `analysis` sampler lines (§15.1 row 21, plus the
    population-cohesion tail) -- rather than being loosened to an inequality,
    so a fourth, unexplained line still fails here.
    `_assert_parity` makes the same checks for every scenario; this one also
    reads the logout line's contents.
    """
    scenario = Scenario(name="logout record")
    graph, direct = _both(tmp_path, scenario, caplog)

    logout_lines = [line for line in graph.log if line.startswith(_GRAPH_ONLY_LOG_PREFIX)]
    sampler_lines = [line for line in graph.log if line.startswith(_ANALYSIS_LOG_PREFIX)]
    assert len(logout_lines) == 1
    assert len(sampler_lines) == 3
    assert len(graph.log) == len(direct.log) + 1 + 3
    assert DIR_NAME in logout_lines[0]
    assert "run_id=graph-run" in logout_lines[0]
    assert "outcome=landed_all" in logout_lines[0]


def test_the_graph_path_also_samples_rules_and_behaviour(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """Spec §15.1 row 21, closed by Plan 4 and pinned here as a divergence.

    `cycle-one.sh:45` runs `rule-check.sh` between `auto-run.sh` and
    `dream.sh`, and `auto-run.sh:806` runs `behavior-snapshot.sh` at the end
    of each act round. Both calls live in the COMPOSITION, and on the direct
    path the composition is `cli.py`'s two separate commands -- so the graph
    path samples and `run_act` + `run_dream` do not. `population_metric` is
    the same divergence with no Bash antecedent at all.

    Asserted as EXACTLY three extra lines in a known order, and as zero
    `swil_agent.analysis` records on the direct path. The order is the
    contract: the behaviour snapshot is the act phase's tail, the rule check
    the dream phase's head -- so the rule check must also precede every
    dream-phase record, which is the ordering `cycle-one.sh:39-41` exists to
    state -- and the population sample is the cycle's tail, so it must come
    LAST of the three. (The first two take their `no api_key.txt` skip path
    here: this roster is key-less, exactly like the other scenarios, so their
    divergence is one log line each and nothing on the wire. The population
    sample needs no key -- the route is global and `FakeResources` answers it
    -- so its line is a real success. `test_cycle_analysis_steps.py` drives
    the keyed version.)
    """
    scenario = Scenario(name="analysis samplers")
    graph, direct = _both(tmp_path, scenario, caplog)

    assert [line for line in direct.log if line.startswith(_ANALYSIS_LOG_PREFIX)] == []

    sampled = [line for line in graph.log if line.startswith(_ANALYSIS_LOG_PREFIX)]
    assert len(sampled) == 3, sampled
    assert sampled[0].startswith("swil_agent.analysis.behavior_snapshot")
    assert sampled[1].startswith("swil_agent.analysis.rule_check")
    assert sampled[2].startswith("swil_agent.analysis.population_metric")
    assert DIR_NAME in sampled[0] and DIR_NAME in sampled[1]
    # ...and NOT in the third: the population sample is a reading of the whole
    # population that this account's round merely triggered. A line naming the
    # account would invite exactly the misreading `record_population_metric`'s
    # own docstring warns about -- that picking an account picks a SUBJECT.
    assert DIR_NAME not in sampled[2]

    first_dream_record = next(
        index for index, line in enumerate(graph.log) if line.startswith("swil_agent.dream")
    )
    assert graph.log.index(sampled[1]) < first_dream_record
    _assert_parity(graph, direct, scenario)


def test_the_dream_gate_is_grants_dream_on_both_paths(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """The dream-gating difference (design spec §7.1) is a Python-vs-BASH
    divergence, not a graph-vs-direct one, and this is what says so.

    `cycle-one.sh` skips the dream on ANY non-zero `auto-run.sh` exit --
    including a rhythm veto and an empty plan, the conflation §7.1 exists to
    fix. Both Python paths consult `ActResult.grants_dream` instead, so an
    empty plan still dreams on BOTH of them: the divergence is against the
    scripts, and it must not quietly become a divergence between the two
    Python paths as well.
    """
    scenario = Scenario(name="an empty plan still dreams", plan=_plan())
    graph, direct = _both(tmp_path, scenario, caplog)

    assert graph.outcome == ActOutcome.PLANNER_EMPTY.value
    assert graph.dream[0] is True, "the graph path skipped a dream an empty plan is entitled to"
    assert direct.dream[0] is True
    _assert_parity(graph, direct, scenario)
