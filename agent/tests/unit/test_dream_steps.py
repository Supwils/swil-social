"""Tests for the individual STEPS of `swil_agent.dream.round` (Plan 3 Task 6).

`test_dream_round.py` is the oracle for the composition: it drives
`run_dream` end to end and must pass unchanged across any regrouping of the
steps. This file is the complement, and it exists because the oracle cannot
see two classes of defect:

  * **A step called directly.** Tasks 7-8 drive these functions from
    LangGraph nodes. A guard or a log line that lives in `run_dream`'s body
    instead of in the step protects the CLI path and nothing else -- most
    sharply for the accept guard, since `write_step` is where a rejected
    candidate would overwrite `personality.md` and defeat the constitution
    layer with the whole suite still green.
  * **A boundary that moved.** The step boundaries were derived by hand
    from `dream.sh`, and a mutation that moves one of them back passes all
    926 tests of the pre-existing suite. Each is pinned below with the
    mutation it kills named in the docstring; Task 7 re-touches exactly
    these boundaries.

Ordering is observed through fakes threading one shared `order` list (the
same convention `test_dream_round.py` follows, ruling R8), never through a
`recorder=` parameter on the production functions.
"""

from __future__ import annotations

import hashlib
import logging
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest

from swil_agent.api.resources import WriteNotVerifiedError
from swil_agent.config import Settings
from swil_agent.dream import round as round_module
from swil_agent.dream.round import (
    WriteStep,
    cooldown_step,
    dream_step,
    gate_step,
    run_dream,
    snapshot_step,
    write_step,
)
from swil_agent.models import DreamVerdict, Persona
from swil_agent.persona.source import GitPersonaSource

from ._runners import (
    FakeEmbedder,
    FakePersonaSource,
    FakeResources,
    FakeState,
    RecordingRunner,
    SilentBackend,
    TwoCallBackend,
)

NOW = datetime(2026, 8, 17, 10, 0, 0)
CAPTURED_AT = datetime(2026, 8, 17, 10, 0, 0, tzinfo=UTC)

ORIGINAL = """# 测试

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


def _valid_candidate(bio: str = "改写过的一句话") -> str:
    return ORIGINAL.replace("一句话", bio)


def _write_account(
    tmp_path: Path,
    *,
    dir_name: str = "zenith",
    memory_text: str = "2026-08-01 | act | did a thing\n",
) -> Path:
    directory = tmp_path / "agents" / dir_name
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "personality.md").write_text(ORIGINAL, encoding="utf-8")
    (directory / "memory.md").write_text(memory_text, encoding="utf-8")
    return directory


def _persona(directory: Path, *, username: str = "zenith", model: str | None = None) -> Persona:
    return Persona(
        username=username,
        directory=directory,
        backend="claude",
        model=model,
        rhythm_text="60% 概率选择 post",
        raw=ORIGINAL,
    )


class TracingResources(FakeResources):
    """`FakeResources` plus an ordered, cross-method call trace.

    `FakeResources` records each call KIND in its own list (`calls`,
    `lab_events`, `snapshots`), which answers "did this happen" but never
    "did it happen before that". Several mutations this file kills are
    reorderings, so the trace is the instrument -- entries are coarse
    strings, since what is under test is sequence, not payload.
    """

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self.trace: list[str] = []
        self.event_usernames: list[str] = []

    def notifications(self, limit: int, unread_only: bool = True) -> list[dict[str, Any]]:
        self.trace.append(f"notifications:{limit}:{unread_only}")
        return super().notifications(limit, unread_only)

    def create_snapshot(self, username: str, payload: dict[str, Any]) -> str:
        self.trace.append("create_snapshot")
        return super().create_snapshot(username, payload)

    def lab_event(self, username: str, event: Any) -> None:
        self.trace.append(f"lab_event:{event.type}/{event.outcome}")
        self.event_usernames.append(username)
        super().lab_event(username, event)


class NarrativeBackend:
    """A `Backend` double for calling `write_step` DIRECTLY.

    `TwoCallBackend` (which the oracle uses) tags only its SECOND call as
    the diff narrative, because a full `run_dream` spends the first on the
    rewrite candidate. A direct `write_step` call makes the narrative call
    FIRST, so ordering it on the shared list needs a fake that tags every
    call.
    """

    name = "narrative"

    def __init__(self, *, order: list[str] | None = None, response: str = "叙述") -> None:
        self._order = order
        self._response = response
        self.calls: list[Any] = []

    def complete(self, req: Any) -> str:
        if self._order is not None:
            self._order.append("diff_narrative")
        self.calls.append(req)
        return self._response


def _memory_source(name: str, text: str) -> FakePersonaSource:
    source = FakePersonaSource()
    source.memory[name] = text
    return source


# ── cooldown_step ───────────────────────────────────────────────────────────


def test_cooldown_step_counts_the_memory_it_read_and_hands_both_back(tmp_path: Path) -> None:
    """The count and the text come from ONE read, and both leave the step.

    Mutation this kills: dropping `memory_text`/`memory_lines` from the
    return value and letting a downstream node re-read `memory.md` for
    itself. `write_step` records `memory_lines` into
    `last_dream_memlines_<name>` AFTER appending its own housekeeping line,
    so a second read there records 101 where Bash records 100 -- and the
    next round's cooldown-override tally is permanently off by one.
    """
    memory_text = "\n".join(f"2026-08-01 | act | thing {i}" for i in range(100)) + "\n"
    directory = _write_account(tmp_path, memory_text=memory_text)

    step = cooldown_step(
        persona=_persona(directory),
        persona_source=_memory_source("zenith", memory_text),
        state=FakeState(),
        settings=Settings(),
        now=NOW,
    )

    assert step.proceed is True
    assert step.memory_lines == 100
    assert step.memory_text == memory_text


def test_cooldown_step_keys_the_markers_on_the_directory_not_the_username(
    tmp_path: Path,
) -> None:
    """Bash's `$name` is the account DIRECTORY (`_find_dir`'s argument), and
    `last_dream_<name>` is keyed on it -- never on the `Username` bullet.
    The two diverge in the documented "stray agents/<name> dir shadows a
    humans/ account" case.

    Mutation this kills: passing `persona.username` into `check_cooldown`
    (or into `persona_source.read_memory`), which reads a marker that does
    not exist and dreams straight through a live cooldown.
    """
    directory = _write_account(tmp_path, dir_name="zenith_dir")
    persona = _persona(directory, username="zenith")
    state = FakeState()
    state.set_last_dream(hours_ago=1, memlines=0, name="zenith_dir")
    source = _memory_source("zenith_dir", "one line\n")

    step = cooldown_step(
        persona=persona,
        persona_source=source,
        state=state,
        settings=Settings(),
        now=NOW,
        auto=True,
    )

    assert step.proceed is False
    assert "cooldown" in step.reason


def test_cooldown_step_logs_the_skip_itself(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """The SKIP line is the ONLY record that a round happened and declined.

    Mutation this kills: leaving the log call in the composition, so a
    graph node that branches on `proceed` produces an account that is
    simply absent from the log -- indistinguishable from one that was never
    scheduled.
    """
    directory = _write_account(tmp_path)
    state = FakeState()
    state.set_last_dream(hours_ago=1, memlines=100, name="zenith")

    with caplog.at_level(logging.INFO, logger="swil_agent.dream.round"):
        step = cooldown_step(
            persona=_persona(directory),
            persona_source=_memory_source("zenith", "one line\n"),
            state=state,
            settings=Settings(),
            now=NOW,
            auto=True,
        )

    assert step.proceed is False
    assert "SKIP zenith" in caplog.text


def test_cooldown_step_logs_an_override_but_still_proceeds(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """The other half: breaking the 12h floor early is a decision worth a
    line of its own (`dream.sh:507`), and it is the step's to write."""
    memory_text = "\n".join(f"2026-08-01 | act | thing {i}" for i in range(20)) + "\n"
    directory = _write_account(tmp_path, memory_text=memory_text)
    state = FakeState()
    state.set_last_dream(hours_ago=1, memlines=0, name="zenith")

    with caplog.at_level(logging.INFO, logger="swil_agent.dream.round"):
        step = cooldown_step(
            persona=_persona(directory),
            persona_source=_memory_source("zenith", memory_text),
            state=state,
            settings=Settings(),
            now=NOW,
            auto=True,
        )

    assert step.proceed is True
    assert "cooldown override" in caplog.text


def test_cooldown_step_in_force_mode_never_consults_the_markers(tmp_path: Path) -> None:
    """`auto=False` is Bash's "force" mode: `dream.sh:481`'s whole cooldown
    block is inside `if [[ "$mode" == "auto" ]]`, so a forced dream proceeds
    even with a marker minutes old."""
    directory = _write_account(tmp_path)
    state = FakeState()
    state.set_last_dream(hours_ago=0, memlines=100, name="zenith")

    step = cooldown_step(
        persona=_persona(directory),
        persona_source=_memory_source("zenith", "one line\n"),
        state=state,
        settings=Settings(),
        now=NOW,
    )

    assert step.proceed is True
    assert step.reason == ""


# ── dream_step ──────────────────────────────────────────────────────────────


def test_dream_step_announces_the_dream_before_it_reads_anything(tmp_path: Path) -> None:
    """`dream.sh:513` posts `dream/dream/started` immediately after the
    cooldown gate and BEFORE the group-memory `GET /notifications`.

    Mutation this kills: hoisting the emit into the composition (or
    deferring it until after the candidate comes back). Either leaves the
    started event owned by whoever remembers it -- and `/lab`'s stage-4
    cutover criterion is "every canary dream terminates with a recorded
    verdict", which needs the opening event as much as the closing one. The
    oracle cannot see this: it only asserts the event exists somewhere in a
    `run_dream` round.
    """
    directory = _write_account(tmp_path)
    resources = TracingResources()

    step = dream_step(
        persona=_persona(directory),
        resources=resources,
        backend=TwoCallBackend(candidate_response=_valid_candidate()),
        agent_root=tmp_path,
        memory_text="one line\n",
    )

    assert step.failure_reason is None
    assert resources.trace == ["lab_event:dream/started", "notifications:30:False"]


def test_dream_step_reports_an_empty_backend_itself(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """A backend that produced nothing is a TERMINAL state for the dream,
    and both of its records -- the FAIL log line and the `dream/dream/fail`
    lab event -- belong to the step that made the call.

    Mutation this kills: returning an empty candidate and leaving the log +
    emit to the caller. The oracle stays green (the composition would still
    do it), while a Task 7 node that routes an empty candidate straight to
    END produces a dream with a `started` event and no verdict at all.
    """
    directory = _write_account(tmp_path)
    resources = TracingResources()

    with caplog.at_level(logging.WARNING, logger="swil_agent.dream.round"):
        step = dream_step(
            persona=_persona(directory),
            resources=resources,
            backend=SilentBackend(),
            agent_root=tmp_path,
            memory_text="one line\n",
        )

    assert step.candidate == ""
    assert step.failure_reason == "LLM returned empty"
    assert "FAIL zenith — LLM returned empty" in caplog.text
    fail_events = [e for e in resources.lab_events if e.outcome == "fail"]
    assert len(fail_events) == 1
    assert fail_events[0].summary == "LLM returned empty"


def test_dream_step_prompts_from_the_memory_it_was_given_not_a_fresh_read(
    tmp_path: Path,
) -> None:
    """The round reads `memory.md` once, in `cooldown_step`, and the text
    the model is shown must be that same read.

    Mutation this kills: `dream_step` re-reading `persona.directory /
    "memory.md"` for itself. Invisible in production (both reads usually
    return the same bytes) and invisible to the oracle -- but it decouples
    the prompt from the line count that decided the cooldown and that will
    be written to `last_dream_memlines_<name>`, so the marker would no
    longer describe the memory the dream was actually built from.
    """
    directory = _write_account(tmp_path, memory_text="ON DISK, STALE\n")
    backend = TwoCallBackend(candidate_response=_valid_candidate())

    dream_step(
        persona=_persona(directory),
        resources=FakeResources(),
        backend=backend,
        agent_root=tmp_path,
        memory_text="PASSED IN, CURRENT\n",
    )

    assert "PASSED IN, CURRENT" in backend.calls[0].user
    assert "ON DISK, STALE" not in backend.calls[0].user


def test_dream_step_consumes_the_echo_flag_from_the_shared_state_dir(tmp_path: Path) -> None:
    """`read_echo_hint` DELETES the marker ("only nudge once per dream",
    `dream.sh:533`), which makes this step non-re-runnable and is why the
    consume lives with the prompt it feeds rather than in a node of its own.

    Mutation this kills: resolving the flag under `persona.directory`
    instead of `<agent_root>/.agent-state` -- Bash keeps it in the SHARED
    state dir alongside the locks and the dream markers, so a per-account
    path would read a flag nothing ever writes and silently stop nudging.
    """
    directory = _write_account(tmp_path)
    state_dir = tmp_path / ".agent-state"
    state_dir.mkdir(parents=True)
    flag = state_dir / "echo_flag_zenith"
    flag.write_text("换个话题试试", encoding="utf-8")
    backend = TwoCallBackend(candidate_response=_valid_candidate())

    dream_step(
        persona=_persona(directory),
        resources=FakeResources(),
        backend=backend,
        agent_root=tmp_path,
        memory_text="one line\n",
    )

    assert not flag.exists()
    assert "换个话题试试" in backend.calls[0].user


# ── gate_step ───────────────────────────────────────────────────────────────


def _gate(
    directory: Path,
    candidate: str,
    *,
    resources: FakeResources,
    embedder: FakeEmbedder | None = None,
    settings: Settings | None = None,
) -> Any:
    """Returns `gate_step`'s VERDICT half only. The measurement half and the
    calibration event it posts are exercised in `test_drift_measurement.py`,
    which is where every assertion about what a dream RECORDS lives; the
    tests below are about what the step DECIDES and logs."""
    return gate_step(
        persona=_persona(directory),
        candidate_text=candidate,
        resources=resources,
        embedder=embedder if embedder is not None else FakeEmbedder(vectors=[[1.0], [1.0]]),
        runner=RecordingRunner(),
        settings=settings if settings is not None else Settings(drift_mode="scalar"),
    ).verdict


def test_gate_step_owns_the_rejection_log_and_event(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """A rejection's only external records are the FAIL line and the
    `dream/dream/fail` event carrying `_drift_fail_metrics`.

    Mutation this kills: returning the verdict and leaving both to the
    caller. The oracle stays green (the composition would still emit), but
    a Task 7 gate node routing a rejected verdict to END would produce a
    dream with a `started` event and no verdict -- the exact hole spec §10
    stage 4's cutover criterion is written against.
    """
    directory = _write_account(tmp_path)
    resources = TracingResources()
    bad = ORIGINAL.replace("- **Username:** zenith", "- **Username:** someone_else")

    with caplog.at_level(logging.WARNING, logger="swil_agent.dream.round"):
        verdict = _gate(directory, bad, resources=resources)

    assert verdict.accepted is False
    assert "FAIL zenith — " in caplog.text
    assert "keeping original" in caplog.text
    fail_events = [e for e in resources.lab_events if e.outcome == "fail"]
    assert len(fail_events) == 1
    assert "Username drift" in fail_events[0].summary
    assert fail_events[0].metrics == {}


def test_gate_step_warns_when_it_fail_opened(tmp_path: Path) -> None:
    """An unreachable embedder accepts the dream UNGATED, and the WARN event
    is the only signal that the constitution layer did not run.

    Mutation this kills: hoisting the warn into the caller, or deciding it
    from `verdict.reason`'s text rather than the typed
    `embedder_unreachable` flag (`dream/gate.py` composes that string, so
    in the deployed aspect mode the text carries a prefix).
    """
    directory = _write_account(tmp_path)
    resources = TracingResources()

    verdict = _gate(
        directory,
        _valid_candidate(),
        resources=resources,
        embedder=FakeEmbedder(fail_always=True),
    )

    assert verdict.accepted is True
    assert verdict.embedder_unreachable is True
    warn = [e for e in resources.lab_events if e.outcome == "warn"]
    assert len(warn) == 1
    assert warn[0].summary == "embedder unreachable, skipped drift check"


def test_gate_step_compares_against_the_persona_it_was_given_not_the_file(
    tmp_path: Path,
) -> None:
    """The ORIGINAL side of every structural validator is `persona.raw` --
    the text the prompt was built from -- never a fresh read of
    `personality.md`.

    Mutation this kills: `evaluate_candidate((directory / "personality.md")
    .read_text(), ...)`. Here the file on disk carries a DIFFERENT
    `Username` bullet, as it would mid-flight if a concurrent Bash round had
    already swapped it: re-reading turns a valid candidate into a bogus
    "Username drift" rejection, and the account stops dreaming with a
    reason that names a field nobody changed.
    """
    directory = _write_account(tmp_path)
    (directory / "personality.md").write_text(
        ORIGINAL.replace("- **Username:** zenith", "- **Username:** someone_else"),
        encoding="utf-8",
    )
    resources = TracingResources()

    verdict = _gate(directory, _valid_candidate(), resources=resources)

    assert verdict.accepted is True
    # No rejection and no fail-open warning -- the only event a clean accept
    # posts here is the calibration measurement, which `gate_step` posts on
    # every path and which says nothing about the verdict.
    assert [e.outcome for e in resources.lab_events if e.outcome != "success"] == []
    assert [e.summary for e in resources.lab_events] == ["drift measured"]


def test_gate_step_writes_nothing_of_the_accounts(tmp_path: Path) -> None:
    """Task 7 needs the gate node to be safe to run before any write node
    exists: a verdict -- accept OR reject -- changes no file and uploads no
    snapshot. The candidate lives in memory here, unlike Bash's temp file."""
    directory = _write_account(tmp_path)
    before_personality = (directory / "personality.md").read_text(encoding="utf-8")
    before_memory = (directory / "memory.md").read_text(encoding="utf-8")
    resources = TracingResources()

    verdict = _gate(directory, _valid_candidate(), resources=resources)

    assert verdict.accepted is True
    assert (directory / "personality.md").read_text(encoding="utf-8") == before_personality
    assert (directory / "memory.md").read_text(encoding="utf-8") == before_memory
    assert not (directory / "personality.archive.md").exists()
    assert resources.calls == []


# ── write_step ──────────────────────────────────────────────────────────────


def _accepted() -> DreamVerdict:
    return DreamVerdict(accepted=True, reason="drift OK (sim=1.0)", scalar_sim=1.0)


def _rejected() -> DreamVerdict:
    return DreamVerdict(accepted=False, reason="drift too large (sim=0.1)", scalar_sim=0.1)


def test_write_step_refuses_a_rejected_verdict(tmp_path: Path) -> None:
    """The guard that keeps the constitution layer meaningful.

    `write_step` is the ONE place a rejected candidate could become the
    account's personality, and by the time anyone noticed,
    `personality.archive.md` would already have been prepended and the old
    text would be recoverable only by hand. The guard lives here, not only
    in `run_dream`'s body, because Task 7 wires a graph edge out of the gate
    node -- an unconditional one reaches this function with a rejected
    verdict.

    Mutation this kills: dropping the `verdict.accepted` check (it also
    reddens the ORACLE, via `test_a_rejected_dream_touches_nothing` and the
    two drift-rejection event tests -- `run_dream` threads the verdict in
    rather than branching above the step, so the guard is load-bearing, not
    defensive).
    """
    directory = _write_account(tmp_path)
    before_personality = (directory / "personality.md").read_text(encoding="utf-8")
    before_memory = (directory / "memory.md").read_text(encoding="utf-8")
    resources = TracingResources()
    state = FakeState()
    backend = TwoCallBackend(candidate_response="unused")

    step = write_step(
        persona=_persona(directory),
        persona_source=GitPersonaSource(tmp_path),
        state=state,
        resources=resources,
        backend=backend,
        verdict=_rejected(),
        candidate_text=_valid_candidate(),
        memory_lines=1,
        now=NOW,
    )

    assert step == (False, "")
    assert (directory / "personality.md").read_text(encoding="utf-8") == before_personality
    assert (directory / "memory.md").read_text(encoding="utf-8") == before_memory
    assert not (directory / "personality.archive.md").exists()
    assert state.last_dream_ts("zenith") is None
    assert resources.trace == []
    # Not even the best-effort diff narrative: a rejected dream must cost no
    # LLM call at all.
    assert backend.calls == []


def test_write_step_performs_bashs_six_writes_in_order(tmp_path: Path) -> None:
    """The write-ordering contract, asserted against the step directly.

    The oracle pins this for `run_dream`; this pins it for the second
    caller, so a Task 7 node that split the narrative or the memory append
    into a neighbouring node is caught here instead of by a personality
    archive that no longer contains what it claims.
    """
    directory = _write_account(tmp_path)
    order: list[str] = []
    persona_source = FakePersonaSource(order=order)
    state = FakeState(order=order)
    resources = FakeResources(order=order)
    backend = NarrativeBackend(order=order)

    step = write_step(
        persona=_persona(directory),
        persona_source=persona_source,
        state=state,
        resources=resources,
        backend=backend,
        verdict=_accepted(),
        candidate_text=_valid_candidate(),
        memory_lines=7,
        now=NOW,
    )

    assert step.written is True
    assert order == [
        "diff_narrative",
        "archive_prepend",
        "personality_write",
        "marker_last_dream",
        "marker_memlines",
        "memory_append",
    ]
    assert [(e.outcome, e.summary) for e in resources.lab_events] == [
        ("success", "personality updated")
    ]


def test_write_step_records_the_count_it_was_given_not_one_it_re_reads(
    tmp_path: Path,
) -> None:
    """`last_dream_memlines_<name>` must describe `memory.md` as
    `cooldown_step` read it -- BEFORE this dream's own housekeeping line.

    Mutation this kills: re-reading `memory.md` inside the step to derive
    the count. The parameter and the file deliberately DISAGREE here (42 vs
    100), so a re-read is caught wherever it is placed -- before the append
    (100) or after it (101). The oracle only catches the second: it drives
    a round where the two agree until the append happens. A count taken
    from the wrong read leaves every subsequent cooldown-override tally off
    by one, silently, and invisible to any assertion about WHAT was
    written.
    """
    memory_text = "\n".join(f"2026-08-01 | act | thing {i}" for i in range(100)) + "\n"
    directory = _write_account(tmp_path, memory_text=memory_text)
    state = FakeState()

    write_step(
        persona=_persona(directory),
        persona_source=GitPersonaSource(tmp_path),
        state=state,
        resources=FakeResources(),
        backend=TwoCallBackend(candidate_response="unused"),
        verdict=_accepted(),
        candidate_text=_valid_candidate(),
        memory_lines=42,
        now=NOW,
    )

    assert state.last_dream_memlines("zenith") == 42
    assert (directory / "memory.md").read_text(encoding="utf-8").count("\n") == 101


def test_write_step_writes_under_the_directory_but_reports_under_the_username(
    tmp_path: Path,
) -> None:
    """Every FILE this step touches is keyed on the account directory; the
    lab event is keyed on the `Username` bullet, because that is what the
    server resolves an event to. The two diverge in the documented "stray
    agents/<name> dir shadows a humans/ account" case, and swapping them
    writes one account's dream into another's markers."""
    directory = _write_account(tmp_path, dir_name="zenith_dir")
    persona_source = FakePersonaSource()
    state = FakeState()
    resources = TracingResources()

    write_step(
        persona=_persona(directory, username="zenith"),
        persona_source=persona_source,
        state=state,
        resources=resources,
        backend=TwoCallBackend(candidate_response="unused"),
        verdict=_accepted(),
        candidate_text=_valid_candidate(),
        memory_lines=3,
        now=NOW,
    )

    assert [name for name, _, _ in persona_source.archived] == ["zenith_dir"]
    assert [name for name, _ in persona_source.appended] == ["zenith_dir"]
    assert state.last_dream_ts("zenith_dir") is not None
    assert state.last_dream_ts("zenith") is None
    assert resources.event_usernames == ["zenith"]


# ── snapshot_step ───────────────────────────────────────────────────────────


def _snapshot(
    directory: Path,
    tmp_path: Path,
    *,
    resources: FakeResources,
    written: bool = True,
    narrative: str = "这次梦把风格调沉稳了一点。",
    embedder: FakeEmbedder | None = None,
) -> Any:
    return snapshot_step(
        persona=_persona(directory),
        resources=resources,
        embedder=embedder if embedder is not None else FakeEmbedder(vectors=[[0.5]]),
        settings=Settings(drift_mode="scalar"),
        verdict=_accepted(),
        candidate_text=_valid_candidate(),
        narrative=narrative,
        agent_root=tmp_path,
        captured_at=CAPTURED_AT,
        written=written,
    )


def test_snapshot_step_uploads_nothing_when_no_write_happened(tmp_path: Path) -> None:
    """A snapshot is a CLAIM about what `personality.md` now says.

    Mutation this kills: dropping the `written` guard (it also reddens the
    ORACLE's `test_a_rejected_dream_touches_nothing` -- `run_dream` threads
    the flag in rather than branching above the step). Uploading for a
    rejected candidate puts a `personalitysnapshots` row -- with an
    embedding -- behind a document the account never ran under, and `/lab`'s
    drift trajectory is the in-flight experiment's primary readout.
    """
    directory = _write_account(tmp_path)
    resources = TracingResources()
    embedder = FakeEmbedder(fail_always=True)  # any call at all would raise

    step = _snapshot(directory, tmp_path, resources=resources, written=False, embedder=embedder)

    assert step == (False, None)
    assert resources.trace == []
    assert resources.snapshots == []


def test_snapshot_step_forwards_the_narrative_it_was_handed(tmp_path: Path) -> None:
    """`diffNarrative` is computed by `write_step` (before the swap) and
    consumed here, two steps apart -- the one value that has to survive the
    hand-off between them.

    Mutation this kills: building the payload with `narrative=""` (or
    dropping the parameter). Nothing else in the suite notices: the field is
    OPTIONAL in the payload, so its absence is a valid snapshot, and
    `DreamResult.narrative` still reports the text that never shipped. In a
    graph the same defect is one unthreaded `CycleState` field.
    """
    directory = _write_account(tmp_path)
    resources = TracingResources()

    step = _snapshot(directory, tmp_path, resources=resources, narrative="梦把语气放软了")

    assert step.ok is True
    _, payload = resources.snapshots[0]
    assert payload["diffNarrative"] == "梦把语气放软了"


def test_snapshot_step_describes_the_candidate_not_the_old_personality(
    tmp_path: Path,
) -> None:
    """The snapshot's hash, excerpt and EMBEDDING are all of the text that
    just landed.

    Mutation this kills: `embed([persona.raw])` -- the old text, which this
    step also has in hand. `/lab`'s drift vector would then describe the
    version being REPLACED while `contentHash` still looked correct, so
    every drift number computed from that row measures the wrong document
    and nothing anywhere looks wrong.

    Asserted on the embedder's INPUT, not on the vector it returns:
    `FakeEmbedder` answers its scripted vector whatever it is asked, so an
    assertion of the form `payload["embedding"] == [0.25]` cannot detect
    this mutation at all (task-6 review, item 2). `embedded` is that fake's
    record of what it was handed.
    """
    directory = _write_account(tmp_path)
    resources = TracingResources()
    embedder = FakeEmbedder(vectors=[[0.25]])
    candidate = _valid_candidate()

    _snapshot(directory, tmp_path, resources=resources, embedder=embedder)

    assert embedder.embedded == [[candidate]]
    assert ORIGINAL not in [text for batch in embedder.embedded for text in batch]
    _, payload = resources.snapshots[0]
    assert payload["contentHash"] == hashlib.sha256(candidate.encode()).hexdigest()
    assert payload["contentHash"] != hashlib.sha256(ORIGINAL.encode()).hexdigest()
    assert payload["embedding"] == [0.25]
    assert payload["archivePath"] == "agents/zenith/personality.md"


def test_snapshot_step_turns_a_server_refusal_into_a_warn_with_its_own_reason(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """Contract `03` §4.9: never a rollback, never a raise, and never a
    guessed cause -- the 2026-07-31 incident cost two investigations chasing
    a healthy server while "no api_key.txt" was already in the message."""
    directory = _write_account(tmp_path)
    resources = TracingResources(snapshot_raises=WriteNotVerifiedError("no api_key.txt"))

    with caplog.at_level(logging.WARNING, logger="swil_agent.dream.round"):
        step = _snapshot(directory, tmp_path, resources=resources)

    assert step.ok is False
    assert step.reason is not None and "no api_key.txt" in step.reason
    assert "WARN zenith — snapshot upload failed" in caplog.text
    warn = [e for e in resources.lab_events if e.type == "snapshot" and e.outcome == "warn"]
    assert len(warn) == 1
    assert warn[0].reason == "no api_key.txt"


def test_snapshot_step_survives_an_embedder_outage_too(tmp_path: Path) -> None:
    """The OTHER failure mode (contract `03` §5's 6-7): the embedder, not
    the server. It must not escape as an exception -- `personality.md` has
    already been swapped by the time this runs."""
    directory = _write_account(tmp_path)
    resources = TracingResources()

    step = _snapshot(
        directory, tmp_path, resources=resources, embedder=FakeEmbedder(fail_always=True)
    )

    assert step.ok is False
    assert step.reason is not None
    assert resources.snapshots == []


# ── the composition's own shape (task-6 review, items 1, 3 and 4) ───────────
#
# `run_dream` does NOT early-return on a rejected verdict: it threads
# `verdict` into `write_step` and `written` into `snapshot_step` and branches
# on what comes back, which is what makes those two guards load-bearing (the
# oracle reddens when either is deleted). That property is CONTINGENT on this
# shape -- restore the early return and both guards can be removed with the
# oracle still green. So the shape itself is pinned here.


def _run_dream(
    tmp_path: Path,
    directory: Path,
    *,
    resources: FakeResources,
    backend: Any = None,
    embedder: FakeEmbedder | None = None,
) -> Any:
    return run_dream(
        persona=_persona(directory),
        persona_source=GitPersonaSource(tmp_path),
        resources=resources,
        backend=backend
        if backend is not None
        else TwoCallBackend(candidate_response=_valid_candidate()),
        runner=RecordingRunner(),
        embedder=embedder if embedder is not None else FakeEmbedder(vectors=[[1.0], [1.0], [0.5]]),
        state=FakeState(),
        settings=Settings(drift_mode="scalar"),
        agent_root=tmp_path,
        now=NOW,
        captured_at=CAPTURED_AT,
    )


def test_write_step_returns_the_narrative_it_just_generated(tmp_path: Path) -> None:
    """The PRODUCER end of the diff narrative.

    Mutation this kills: `return WriteStep(written=True, narrative="")`.
    That strips `diffNarrative` from every uploaded snapshot and empties
    `DreamResult.narrative`, and it passes the whole suite when only
    `snapshot_step`'s parameter is pinned -- the consumer cannot witness
    what the producer failed to make. Also pins the two texts the narrative
    call compares, and its literal empty model argument (`dream.sh:832`
    passes `""`, never `$ai_model`).
    """
    directory = _write_account(tmp_path)
    candidate = _valid_candidate()
    backend = NarrativeBackend(response="梦把语气放软了")

    step = write_step(
        persona=_persona(directory),
        persona_source=FakePersonaSource(),
        state=FakeState(),
        resources=FakeResources(),
        backend=backend,
        verdict=_accepted(),
        candidate_text=candidate,
        memory_lines=3,
        now=NOW,
    )

    assert step.narrative == "梦把语气放软了"
    assert len(backend.calls) == 1
    assert ORIGINAL in backend.calls[0].user
    assert candidate in backend.calls[0].user
    assert backend.calls[0].model is None


def test_the_diff_narrative_survives_the_hand_off_from_write_to_snapshot(
    tmp_path: Path,
) -> None:
    """The whole chain, end to end: generated in `write_step` (before the
    swap), carried across the step boundary, and uploaded by
    `snapshot_step`.

    Kills the producer mutation AND the consumer mutation at once, which is
    the level Task 7 will actually break it at -- one unthreaded
    `CycleState` field between the write node and the snapshot node, with
    every other assertion in the suite still true.
    """
    directory = _write_account(tmp_path)
    resources = TracingResources()
    backend = TwoCallBackend(
        candidate_response=_valid_candidate(), narrative_response="梦把语气放软了"
    )

    result = _run_dream(tmp_path, directory, resources=resources, backend=backend)

    assert result.accepted is True
    assert result.narrative == "梦把语气放软了"
    _, payload = resources.snapshots[0]
    assert payload["diffNarrative"] == "梦把语气放软了"


def test_run_dream_reaches_both_write_steps_even_on_a_rejected_dream(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The composition shape the guards' load-bearingness depends on.

    Mutation this kills: restoring the natural `if not verdict.accepted:
    return ...` above `write_step`. It changes no behaviour on its own --
    which is why all 948 tests pass with it applied -- but it moves the
    decision back out of the steps, and with it applied BOTH write guards
    can then be deleted with the 36-test oracle fully green. That is the
    path where a rejected candidate overwrites `personality.md`.

    Asserting the VALUES threaded in, not merely that the calls happened:
    `verdict.accepted is False` and `written is False` are what each step's
    guard reads.
    """
    directory = _write_account(tmp_path)
    resources = TracingResources()
    real_write = round_module.write_step
    real_snapshot = round_module.snapshot_step
    seen: dict[str, Any] = {}

    def spy_write(**kwargs: Any) -> Any:
        seen["write"] = kwargs
        return real_write(**kwargs)

    def spy_snapshot(**kwargs: Any) -> Any:
        seen["snapshot"] = kwargs
        return real_snapshot(**kwargs)

    monkeypatch.setattr(round_module, "write_step", spy_write)
    monkeypatch.setattr(round_module, "snapshot_step", spy_snapshot)

    result = _run_dream(
        tmp_path,
        directory,
        resources=resources,
        backend=TwoCallBackend(
            candidate_response=ORIGINAL.replace(
                "- **Username:** zenith", "- **Username:** someone_else"
            )
        ),
    )

    assert result.accepted is False
    assert seen["write"]["verdict"].accepted is False
    assert seen["snapshot"]["written"] is False
    assert resources.snapshots == []
    assert not (directory / "personality.archive.md").exists()


def test_the_snapshot_follows_the_write_not_the_verdict(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An ACCEPTED verdict whose write did not happen must publish nothing
    and must not be reported as an accepted dream.

    Today `written == verdict.accepted` always, so
    `snapshot_step(written=verdict.accepted)` and `if not verdict.accepted:`
    both survive every other test. They stop being equivalent the moment an
    accepted-but-not-written path exists -- a failed archive swap, a graph
    node that skips the write, a future "propose only" mode -- and the
    snapshot would then describe a `personality.md` that still holds the old
    text. The stub below manufactures exactly that state, so both
    substitutions die here.
    """
    directory = _write_account(tmp_path)
    resources = TracingResources()

    def stub_write(**kwargs: Any) -> WriteStep:
        assert kwargs["verdict"].accepted is True  # the verdict really did accept
        return WriteStep(written=False, narrative="")

    monkeypatch.setattr(round_module, "write_step", stub_write)

    result = _run_dream(tmp_path, directory, resources=resources)

    assert result.accepted is False
    assert resources.snapshots == []
    # The dream phase's own two events and nothing from the snapshot phase.
    assert [(e.type, e.summary) for e in resources.lab_events] == [
        ("dream", "dream started"),
        ("dream", "drift measured"),
    ]
