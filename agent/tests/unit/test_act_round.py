"""Tests for `swil_agent.act.round` (design spec §7, contract `01` §1 +
`02` §3-§5) -- the six-outcome composition of the whole act path.

The outcome-mapping table (`test_outcome_mapping`) is the deliverable: every
row is set up so a plausible one-line mutation of `run_act` would produce a
DIFFERENT outcome, not merely a different code path to the same one -- see
each scenario's inline comment for the specific mutation it pins.
"""

from __future__ import annotations

import json
import logging
import random
from collections.abc import Callable
from datetime import datetime
from pathlib import Path

import pytest

from swil_agent.act.round import allowed_for, run_act
from swil_agent.api.client import ApiError
from swil_agent.llm.base import Backend
from swil_agent.locks import LockBusy, act_lock_path
from swil_agent.models import Action, ActOutcome, ActResult, Persona

from ._runners import ExplodingBackend, FakeResources, SilentBackend, StubBackend

NOW = datetime(2026, 8, 17, 10, 0, 0)


def _persona(
    tmp_path: Path,
    *,
    backend: str = "claude",
    rhythm_text: str = "",
    username: str = "zenith",
    dir_name: str = "zenith",
    board: str | None = None,
) -> Persona:
    """`username` and `dir_name` default to the same string, matching every
    existing call site, but can be set apart on purpose (fix round 1, item
    2) -- Bash's `agent_name` is `basename "$agent_dir"`, NOT the `Username`
    bullet, and a fixture where the two always match can never catch a slip
    that uses one where the other belongs."""
    directory = tmp_path / "agents" / dir_name
    directory.mkdir(parents=True, exist_ok=True)
    return Persona(
        username=username,
        directory=directory,
        backend=backend,
        rhythm_text=rhythm_text,
        board=board,
        raw="PERSONA",
    )


def _plan_json(actions: list[Action]) -> str:
    wire: list[dict[str, str]] = []
    for a in actions:
        obj: dict[str, str] = {"action": a.kind}
        if a.text is not None:
            obj["text"] = a.text
        if a.post_id is not None:
            obj["postId"] = a.post_id
        if a.parent_id is not None:
            obj["parentId"] = a.parent_id
        if a.username is not None:
            obj["username"] = a.username
        if a.image_topic is not None:
            obj["imageTopic"] = a.image_topic
        wire.append(obj)
    return json.dumps({"plan": wire})


def _run(
    tmp_path: Path,
    *,
    persona: Persona | None = None,
    resources: FakeResources | None = None,
    backend: Backend | None = None,
    memory_text: str = "",
    health_check: Callable[[], bool] | None = None,
    dry_run: bool = False,
    rng: random.Random | None = None,
    access_key: str | None = None,
) -> ActResult:
    return run_act(
        persona=persona or _persona(tmp_path),
        resources=resources if resources is not None else FakeResources(),
        backend=backend or StubBackend('{"plan":[{"action":"nothing"}]}'),
        memory_text=memory_text,
        agent_root=tmp_path,
        now=NOW,
        rng=rng or random.Random(0),
        health_check=health_check or (lambda: True),
        dry_run=dry_run,
        access_key=access_key,
    )


# ── allowed_for (contract 02 §1.1, spec §6.8) ───────────────────────────────


def test_allowed_for_restricts_codex_to_post_and_nothing(tmp_path: Path) -> None:
    assert allowed_for(_persona(tmp_path, backend="codex")) == ["post", "nothing"]


def test_allowed_for_is_unrestricted_for_claude(tmp_path: Path) -> None:
    assert allowed_for(_persona(tmp_path, backend="claude")) == []


# ── the outcome-mapping table (the deliverable) ─────────────────────────────


def _scenario(name: str, tmp_path: Path) -> ActResult:
    post_id = "p" * 24

    if name == "all_actions_land":
        # Mutation this pins: remove the `like_raises` absence (i.e. inject
        # a failure) and this becomes LANDED_PARTIAL, not LANDED_ALL.
        backend = StubBackend(f'{{"plan":[{{"action":"like","postId":"{post_id}"}}]}}')
        return _run(tmp_path, backend=backend, resources=FakeResources())

    if name == "some_actions_fail":
        # Two actions of DIFFERENT kinds so guardrails' dedupe/caps don't
        # collapse them: follow always lands (executor.py's deliberate
        # design), like is forced to fail. Mutation this pins: remove
        # `like_raises` and landed becomes 2/2 -> LANDED_ALL instead.
        backend = StubBackend(
            '{"plan":[{"action":"follow","username":"vex"},'
            f'{{"action":"like","postId":"{post_id}"}}]}}'
        )
        resources = FakeResources(like_raises=ApiError(500, "boom", None))
        return _run(tmp_path, backend=backend, resources=resources)

    if name == "guardrails_empty_the_plan":
        # Rhythm ceiling=1 reached (one post already logged today) forces
        # policy=NO_POST; the model's only action is `post`, so guardrails
        # drop it to empty WITH a non-empty vetoed list. Mutation this
        # pins: if guardrails did not veto (e.g. the ceiling text were
        # absent), the post would survive -> LANDED_ALL, not VETOED_EMPTY.
        persona = _persona(tmp_path, rhythm_text="已有一条发帖记录时本轮不再发帖。")
        backend = StubBackend('{"plan":[{"action":"post","text":"hello"}]}')
        memory_text = f"2026-08-17 | post | id={'a' * 24} | earlier\n"
        return _run(tmp_path, persona=persona, backend=backend, memory_text=memory_text)

    if name == "model_chose_nothing":
        # A lone `nothing` survives guardrails untouched (stage 2 only
        # strips `nothing` mixed with other actions) with an EMPTY vetoed
        # list -- the mirror-image setup of guardrails_empty_the_plan,
        # proving PLANNER_EMPTY and VETOED_EMPTY are pinned by different
        # scenarios, not the same one asserting two different labels.
        backend = StubBackend('{"plan":[{"action":"nothing"}]}')
        return _run(tmp_path, backend=backend)

    if name == "planner_returned_empty_plan":
        # The SECOND route to PLANNER_EMPTY (fix round 1, item 1): the
        # backend's own JSON is `{"plan":[]}` -- `normalize_plan` yields
        # `Plan(actions=[])`, so `guarded.actions == []` AND
        # `guarded.vetoed == []` with NOTHING for guardrails to have
        # removed, because there was never anything in the plan to begin
        # with. This is `round.py`'s `if not guarded.actions:` branch, NOT
        # the solo-`[nothing]` branch `model_chose_nothing` exercises --
        # the two reach `PLANNER_EMPTY` through different code paths, and
        # this scenario was previously untested: flipping
        # `ActOutcome.VETOED_EMPTY if guarded.vetoed else
        # ActOutcome.PLANNER_EMPTY` to always return `VETOED_EMPTY` failed
        # no test before this scenario existed. Mutation this pins: that
        # exact flip.
        backend = StubBackend('{"plan":[]}')
        return _run(tmp_path, backend=backend)

    if name == "backend_silent":
        # Mutation this pins: swap SilentBackend for a StubBackend that
        # returns real JSON and this becomes a landed/vetoed outcome, not
        # BACKEND_UNAVAILABLE.
        return _run(tmp_path, backend=SilentBackend())

    if name == "platform_unreachable":
        # Mutation this pins: flip health_check to `lambda: True` and this
        # falls through to whatever the (never-reached) plan/guardrails
        # would have produced instead of OFFLINE.
        return _run(tmp_path, health_check=lambda: False)

    if name == "every_action_fails":
        # Mutation this pins: remove `like_raises` and landed becomes 1/1
        # -> LANDED_ALL, not LANDED_PARTIAL.
        backend = StubBackend(f'{{"plan":[{{"action":"like","postId":"{post_id}"}}]}}')
        resources = FakeResources(like_raises=ApiError(500, "boom", None))
        return _run(tmp_path, backend=backend, resources=resources)

    raise AssertionError(f"unknown scenario: {name!r}")


@pytest.mark.parametrize(
    ("scenario", "expected", "grants_dream"),
    [
        ("all_actions_land", ActOutcome.LANDED_ALL, True),
        ("some_actions_fail", ActOutcome.LANDED_PARTIAL, True),
        ("guardrails_empty_the_plan", ActOutcome.VETOED_EMPTY, True),
        ("model_chose_nothing", ActOutcome.PLANNER_EMPTY, True),
        ("planner_returned_empty_plan", ActOutcome.PLANNER_EMPTY, True),
        ("backend_silent", ActOutcome.BACKEND_UNAVAILABLE, False),
        ("platform_unreachable", ActOutcome.OFFLINE, False),
        # Bash treats "every planned action failed" as rc=75 and skips the
        # dream (contract 02 §3.2: dreaming on unrefreshed memory
        # manufactures drift that never happened). Design spec §7.1 is
        # explicit that only BACKEND_UNAVAILABLE/OFFLINE deny the dream, so
        # under the typed outcomes this is LANDED_PARTIAL with landed == 0,
        # and the dream proceeds -- see test_every_action_failing_... below
        # for the accompanying FAIL-level log line and the landed==0 record.
        ("every_action_fails", ActOutcome.LANDED_PARTIAL, True),
    ],
)
def test_outcome_mapping(
    scenario: str, expected: ActOutcome, grants_dream: bool, tmp_path: Path
) -> None:
    result = _scenario(scenario, tmp_path)
    assert result.outcome is expected
    assert result.grants_dream is grants_dream


def test_two_planner_empty_routes_have_different_vetoed_shapes(tmp_path: Path) -> None:
    """The deliverable's missing cell (fix round 1, item 1): both
    `model_chose_nothing` and `planner_returned_empty_plan` land on
    `PLANNER_EMPTY`, but they reach it through genuinely different guardrail
    outputs -- a solo `[nothing]` that SURVIVED guardrails (non-empty
    `guarded.actions`, `is_solo_nothing` override) vs. an empty plan that
    guardrails never touched at all (`guarded.actions == []`,
    `guarded.vetoed == []`). Both must have an empty `vetoed` list -- that
    is what distinguishes PLANNER_EMPTY from VETOED_EMPTY -- but they are
    not the same code path, which is why flipping `round.py`'s
    `VETOED_EMPTY if guarded.vetoed else PLANNER_EMPTY` ternary only shows
    up if BOTH routes are tested."""
    empty_plan_result = _scenario("planner_returned_empty_plan", tmp_path)
    solo_nothing_result = _scenario("model_chose_nothing", tmp_path)
    assert empty_plan_result.outcome is ActOutcome.PLANNER_EMPTY
    assert solo_nothing_result.outcome is ActOutcome.PLANNER_EMPTY
    assert empty_plan_result.vetoed == []
    assert solo_nothing_result.vetoed == []
    # The shape difference the two routes actually take: the empty-plan
    # route never reaches execute_action (nothing to execute), the
    # solo-nothing route does (for lab-event/log parity -- see
    # test_solo_nothing_still_executes_for_lab_event_parity).
    assert empty_plan_result.results == []
    assert len(solo_nothing_result.results) == 1


def test_every_action_failing_logs_fail_and_records_landed_zero(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    post_id = "p" * 24
    backend = StubBackend(f'{{"plan":[{{"action":"like","postId":"{post_id}"}}]}}')
    resources = FakeResources(like_raises=ApiError(500, "boom", None))
    with caplog.at_level(logging.WARNING, logger="swil_agent.act.round"):
        result = _run(tmp_path, backend=backend, resources=resources)
    assert result.landed == 0
    assert result.attempted == 1
    assert "FAIL zenith — all 1 planned actions failed; dream will be skipped" in caplog.text


def test_fail_log_uses_the_directory_name_not_the_username(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """Fix round 1, item 2: Bash's own FAIL line (`auto-run.sh:763`) is
    keyed on `$agent_name` (`basename "$agent_dir"`), not the `Username`
    bullet -- an earlier version of this log call passed `persona.username`
    instead, a slip the default `_persona()` fixture could never catch
    because it always sets `username` and `dir_name` to the same string.
    This test sets them apart on purpose: `directory.name` must appear in
    the log line, and the (deliberately different) `username` must not."""
    persona = _persona(tmp_path, username="not-the-directory-name", dir_name="zenith")
    post_id = "p" * 24
    backend = StubBackend(f'{{"plan":[{{"action":"like","postId":"{post_id}"}}]}}')
    resources = FakeResources(like_raises=ApiError(500, "boom", None))
    with caplog.at_level(logging.WARNING, logger="swil_agent.act.round"):
        _run(tmp_path, persona=persona, backend=backend, resources=resources)
    assert "FAIL zenith — all 1 planned actions failed" in caplog.text
    assert "not-the-directory-name" not in caplog.text


def test_backend_unavailable_is_not_the_same_as_planner_empty(tmp_path: Path) -> None:
    """A silent backend (plan_round returns None) must never collapse into
    the same bucket as a model that explicitly chose `nothing` -- spec §7.1
    names this distinction as the whole point of the outcome type."""
    backend_result = _scenario("backend_silent", tmp_path)
    nothing_result = _scenario("model_chose_nothing", tmp_path)
    assert backend_result.outcome is not nothing_result.outcome


# ── health probe ordering (contract 01 §1) ──────────────────────────────────


def test_offline_health_check_never_touches_the_lock(tmp_path: Path) -> None:
    calls: list[str] = []

    def _health() -> bool:
        calls.append("health")
        return False

    result = _run(tmp_path, health_check=_health)
    assert result.outcome is ActOutcome.OFFLINE
    assert calls == ["health"]
    assert not act_lock_path(tmp_path, "zenith").exists()


# ── lock behavior (ruling R6: LockBusy propagates, is not an ActOutcome) ───


def test_run_act_raises_lock_busy_when_the_account_lock_is_held(tmp_path: Path) -> None:
    lock = act_lock_path(tmp_path, "zenith")
    lock.parent.mkdir(parents=True, exist_ok=True)
    lock.write_text("1", encoding="utf-8")
    with pytest.raises(LockBusy):
        _run(tmp_path)
    # Someone else's lock, untouched by the failed acquire attempt.
    assert lock.read_text(encoding="utf-8") == "1"


def test_run_act_releases_the_lock_even_when_a_step_raises(tmp_path: Path) -> None:
    """The brief's own sketch of this test injects a `planner=` keyword
    `run_act` does not accept (task-7-brief.md step 3) -- `plan_round` is a
    plain call this function makes, not a parameter it takes. The
    equivalent real failure mode is a backend whose `.complete()` raises
    something OTHER than `BackendUnavailableError`: `plan_round` only
    catches that one exception type, so anything else propagates through it
    and through `run_act` unchanged, exercising the exact "mid-round step
    raises" scenario the brief intended without inventing a parameter that
    does not exist."""
    with pytest.raises(RuntimeError, match="exploding backend"):
        _run(tmp_path, backend=ExplodingBackend())
    assert not act_lock_path(tmp_path, "zenith").exists()


# ── dry_run inertness (design spec §9.4) ────────────────────────────────────


def test_dry_run_never_calls_the_api_or_writes_memory(tmp_path: Path) -> None:
    persona = _persona(tmp_path)
    post_id = "p" * 24
    backend = StubBackend(f'{{"plan":[{{"action":"like","postId":"{post_id}"}}]}}')
    resources = FakeResources()

    result = _run(tmp_path, persona=persona, backend=backend, resources=resources, dry_run=True)

    # Absence of effects, not merely a returned value: no write call was
    # ever recorded, and memory.md was never even created.
    assert resources.calls == []
    assert resources.lab_events == []
    assert not (persona.directory / "memory.md").exists()
    assert result.results == []
    assert result.attempted == 0
    assert result.landed == 0


def test_dry_run_still_returns_the_plan_and_vetoes(tmp_path: Path) -> None:
    """The whole point of dry_run: inspect what WOULD have executed."""
    post_id = "p" * 24
    backend = StubBackend(f'{{"plan":[{{"action":"like","postId":"{post_id}"}}]}}')
    result = _run(tmp_path, backend=backend, dry_run=True)
    assert result.plan is not None
    assert [a.kind for a in result.plan.actions] == ["like"]
    assert result.vetoed == []


def test_dry_run_reports_vetoed_empty_when_guardrails_would_have_dropped_everything(
    tmp_path: Path,
) -> None:
    persona = _persona(tmp_path, rhythm_text="已有一条发帖记录时本轮不再发帖。")
    backend = StubBackend('{"plan":[{"action":"post","text":"hello"}]}')
    memory_text = f"2026-08-17 | post | id={'a' * 24} | earlier\n"
    result = _run(tmp_path, persona=persona, backend=backend, memory_text=memory_text, dry_run=True)
    assert result.outcome is ActOutcome.VETOED_EMPTY
    assert len(result.vetoed) == 1


def test_dry_run_classifies_a_solo_nothing_plan_as_planner_empty(tmp_path: Path) -> None:
    """The plan-shape classification (empty vs. solo-`nothing`) applies
    identically whether or not `dry_run` is set -- it never depends on
    execution, so dry_run must not accidentally report LANDED_ALL here."""
    backend = StubBackend('{"plan":[{"action":"nothing"}]}')
    result = _run(tmp_path, backend=backend, dry_run=True)
    assert result.outcome is ActOutcome.PLANNER_EMPTY


# ── memory.md line shapes (contract 02 §4.2) ────────────────────────────────


def _run_and_collect_memory(
    tmp_path: Path, actions: list[Action], *, resources: FakeResources | None = None
) -> list[str]:
    persona = _persona(tmp_path)
    backend = StubBackend(_plan_json(actions))
    _run(tmp_path, persona=persona, backend=backend, resources=resources or FakeResources())
    memory_file = persona.directory / "memory.md"
    if not memory_file.exists():
        return []
    return memory_file.read_text(encoding="utf-8").splitlines()


def test_memory_lines_match_the_bash_shapes(tmp_path: Path) -> None:
    # The exact resource id from task-7-brief.md, quoted verbatim.
    lines = _run_and_collect_memory(
        tmp_path,
        [
            Action(kind="post", text="hello"),
            Action(kind="like", post_id="p" * 24),
            Action(kind="follow", username="vex"),
            Action(kind="nothing"),
        ],
        resources=FakeResources(post_id="newpost0000000000000000"),
    )
    assert lines == [
        "2026-08-17 | post | id=newpost0000000000000000 | hello",
        "2026-08-17 | like | postId=" + "p" * 24,
        "2026-08-17 | follow | @vex",
    ]


def test_memory_note_collapses_internal_whitespace(tmp_path: Path) -> None:
    lines = _run_and_collect_memory(tmp_path, [Action(kind="post", text="a\n\n  b")])
    assert lines[0].endswith("| a b")


def test_memory_line_for_post_includes_the_image_tag(tmp_path: Path) -> None:
    lines = _run_and_collect_memory(
        tmp_path, [Action(kind="post", text="look", image_topic="city night")]
    )
    assert lines == ["2026-08-17 | post | id=post-1 | [img:city night] look"]


def test_memory_line_image_tag_is_never_doubled_text_collapsed(tmp_path: Path) -> None:
    """Fix round 1, item 3: `executor.py`'s module docstring is explicit
    that `collapse_doubled_text` applies to `post.text`/`comment.text`/
    `echo.text`/`dm.text` and NEVER to `imageTopic` -- an earlier version of
    `round.py`'s `_memory_note` ran `image_topic` through the same
    collapsing function it used for `text`, which could make the
    `[img:...]` memory-line tag disagree with the topic string actually
    used to fetch the image. This exact literal (`"citynight" * 6`, >= 40
    chars and an exact self-duplicate) is the one `test_executor.py`'s own
    `test_image_topic_is_not_collapsed` uses to prove the same rule at the
    executor layer; reused here so the two layers are pinned by an
    identical input, not merely similarly-worded assertions."""
    topic = "citynight" * 6
    lines = _run_and_collect_memory(tmp_path, [Action(kind="post", text="x", image_topic=topic)])
    assert lines == [f"2026-08-17 | post | id=post-1 | [img:{topic}] x"]


def test_memory_line_for_comment_includes_parent_id_on_a_real_reply(tmp_path: Path) -> None:
    post_id = "p" * 24
    parent_id = "c" * 24
    lines = _run_and_collect_memory(
        tmp_path,
        [Action(kind="comment", post_id=post_id, parent_id=parent_id, text="reply text")],
    )
    assert lines == [
        f"2026-08-17 | comment | postId={post_id} commentId=comment-1 "
        f"parentId={parent_id} | reply text"
    ]


def test_memory_line_for_comment_omits_parent_id_after_the_fallback_retry(tmp_path: Path) -> None:
    """When the parent comment is unusable, `execute_action` retries
    top-level and its own `ActionResult.detail` records that fallback
    (`"parent unusable — posted top-level"`) -- the memory line must match
    what swil.sh's own retry call would have written (no parentId), not
    what the model originally asked for."""
    post_id = "p" * 24
    parent_id = "c" * 24
    resources = FakeResources(fail_first_comment=True)
    persona = _persona(tmp_path)
    backend = StubBackend(
        _plan_json([Action(kind="comment", post_id=post_id, parent_id=parent_id, text="hi")])
    )
    _run(tmp_path, persona=persona, backend=backend, resources=resources)
    lines = (persona.directory / "memory.md").read_text(encoding="utf-8").splitlines()
    assert lines == [f"2026-08-17 | comment | postId={post_id} commentId=comment-2 | hi"]


def test_memory_line_for_echo_includes_the_quote(tmp_path: Path) -> None:
    post_id = "p" * 24
    lines = _run_and_collect_memory(
        tmp_path, [Action(kind="echo", post_id=post_id, text="nice take")]
    )
    assert lines == [f"2026-08-17 | echo | id=post-1 echoOf={post_id} | nice take"]


def test_memory_line_for_echo_without_a_quote_has_no_trailing_tag(tmp_path: Path) -> None:
    post_id = "p" * 24
    lines = _run_and_collect_memory(tmp_path, [Action(kind="echo", post_id=post_id)])
    assert lines == [f"2026-08-17 | echo | id=post-1 echoOf={post_id}"]


def test_memory_line_for_dm_matches_swil_sh_711_byte_for_byte(tmp_path: Path) -> None:
    """Fix round 1, item 4: `swil.sh:711`'s own `_remember` call is
    `_remember "dm | to=$RECIPIENT conversationId=$CONV_ID | ${TEXT:0:80}"`.
    `Resources.send_dm` now returns `(conversation_id, message_id)`
    (resources.py/executor.py, this same fix round) and `ActionResult`
    carries the conversation id in its own field, so this line now
    byte-matches the Bash shape instead of the earlier `messageId=`
    substitute.

    `vex` must be pre-populated as a contact or guardrails' stage 4 (DM
    recipient must be in `ctx.contacts`) drops the action before it ever
    reaches execution -- see `test_a_dm_outside_contacts_is_vetoed_not_executed`."""
    resources = FakeResources()
    resources.contacts_result = ["vex"]
    lines = _run_and_collect_memory(
        tmp_path, [Action(kind="dm", username="vex", text="hey")], resources=resources
    )
    assert lines == ["2026-08-17 | dm | to=vex conversationId=conv-1 | hey"]


def test_a_dm_outside_contacts_is_vetoed_not_executed(tmp_path: Path) -> None:
    """Companion to the test above: WITHOUT the contacts population, the
    same dm plan is silently dropped by guardrails, not executed and
    memory-lined -- proving the contacts population above is load-bearing,
    not incidental setup."""
    lines = _run_and_collect_memory(tmp_path, [Action(kind="dm", username="vex", text="hey")])
    assert lines == []


def test_nothing_writes_no_memory_line_even_when_it_is_the_whole_plan(tmp_path: Path) -> None:
    lines = _run_and_collect_memory(tmp_path, [Action(kind="nothing")])
    assert lines == []


def test_a_failed_action_writes_no_memory_line(tmp_path: Path) -> None:
    post_id = "p" * 24
    persona = _persona(tmp_path)
    backend = StubBackend(_plan_json([Action(kind="like", post_id=post_id)]))
    resources = FakeResources(like_raises=ApiError(500, "boom", None))
    _run(tmp_path, persona=persona, backend=backend, resources=resources)
    assert not (persona.directory / "memory.md").exists()


def test_empty_plan_after_guardrails_executes_nothing_at_all(tmp_path: Path) -> None:
    """VETOED_EMPTY/PLANNER_EMPTY (an empty guarded action list) must never
    reach `execute_action` -- there is nothing to execute, so no write call,
    no lab event, and no memory line of any kind should appear."""
    persona = _persona(tmp_path, rhythm_text="已有一条发帖记录时本轮不再发帖。")
    backend = StubBackend('{"plan":[{"action":"post","text":"hello"}]}')
    memory_text = f"2026-08-17 | post | id={'a' * 24} | earlier\n"
    resources = FakeResources()
    result = _run(
        tmp_path, persona=persona, backend=backend, memory_text=memory_text, resources=resources
    )
    assert result.outcome is ActOutcome.VETOED_EMPTY
    assert resources.calls == []
    assert not (persona.directory / "memory.md").exists()


def test_solo_nothing_still_executes_for_lab_event_parity(tmp_path: Path) -> None:
    """A lone `nothing` is classified PLANNER_EMPTY, but Bash's own
    `execute_action` still calls through for it (DONE log + lab event) --
    this module reproduces that rather than short-circuiting before
    execution the way the empty-plan case does."""
    backend = StubBackend('{"plan":[{"action":"nothing"}]}')
    resources = FakeResources()
    result = _run(tmp_path, backend=backend, resources=resources)
    assert result.outcome is ActOutcome.PLANNER_EMPTY
    assert len(result.results) == 1
    assert result.results[0].landed is True
    assert len(resources.lab_events) == 1


# ── ActResult.context / .plan population per outcome ────────────────────────


def test_context_and_plan_are_populated_on_a_normal_round(tmp_path: Path) -> None:
    backend = StubBackend('{"plan":[{"action":"nothing"}]}')
    result = _run(tmp_path, backend=backend)
    assert result.context is not None
    assert result.plan is not None


def test_backend_unavailable_still_carries_context_but_no_plan(tmp_path: Path) -> None:
    result = _run(tmp_path, backend=SilentBackend())
    assert result.context is not None
    assert result.plan is None


def test_offline_carries_neither_context_nor_plan(tmp_path: Path) -> None:
    result = _run(tmp_path, health_check=lambda: False)
    assert result.context is None
    assert result.plan is None


# ── board resolution (fix round 1, item 5) ──────────────────────────────────


def test_board_id_is_resolved_from_persona_board_and_threaded_into_the_post(
    tmp_path: Path,
) -> None:
    persona = _persona(tmp_path, board="tech")
    resources = FakeResources()
    resources.board_lookup = {"tech": "board-1"}
    backend = StubBackend('{"plan":[{"action":"post","text":"hello"}]}')
    _run(tmp_path, persona=persona, backend=backend, resources=resources)
    assert resources.created_posts[0].board_id == "board-1"
    assert resources.get_boards_calls == 1


def test_no_board_bullet_never_calls_get_boards(tmp_path: Path) -> None:
    """Mutation this pins: dropping the `if persona.board:` guard would make
    every round -- even one with no `Board:` bullet at all -- pay a network
    call for nothing, matching Bash's own `if [[ -n "$POST_BOARD" ]]`."""
    persona = _persona(tmp_path, board=None)
    resources = FakeResources()
    backend = StubBackend('{"plan":[{"action":"post","text":"hello"}]}')
    _run(tmp_path, persona=persona, backend=backend, resources=resources)
    assert resources.get_boards_calls == 0
    assert resources.created_posts[0].board_id is None


def test_board_resolution_failure_degrades_to_an_unfiled_post(tmp_path: Path) -> None:
    """Matches swil.sh's own comment: "degrades to an unfiled post if the
    endpoint is unavailable ... never blocks" -- a failed GET /boards must
    not cost the round its post."""
    persona = _persona(tmp_path, board="tech")
    resources = FakeResources()
    resources.fail("get_boards")
    backend = StubBackend('{"plan":[{"action":"post","text":"hello"}]}')
    result = _run(tmp_path, persona=persona, backend=backend, resources=resources)
    assert result.outcome is ActOutcome.LANDED_ALL
    assert resources.created_posts[0].board_id is None


def test_board_lookup_miss_also_degrades_to_an_unfiled_post(tmp_path: Path) -> None:
    """`persona.board` names a slug `get_boards()` doesn't have -- a plain
    dict miss, not an `ApiError` -- must degrade the same way as an outright
    failed lookup, not raise a `KeyError` out of `run_act`."""
    persona = _persona(tmp_path, board="nonexistent-slug")
    resources = FakeResources()
    resources.board_lookup = {"tech": "board-1"}
    backend = StubBackend('{"plan":[{"action":"post","text":"hello"}]}')
    _run(tmp_path, persona=persona, backend=backend, resources=resources)
    assert resources.created_posts[0].board_id is None


def test_board_resolution_is_skipped_when_the_plan_ends_up_empty(tmp_path: Path) -> None:
    """Board resolution happens after the empty-plan/dry_run early returns
    (round.py), so a round that never reaches execution never pays the
    network call either -- proven directly, not just implied by "once per
    round"."""
    persona = _persona(tmp_path, board="tech", rhythm_text="已有一条发帖记录时本轮不再发帖。")
    backend = StubBackend('{"plan":[{"action":"post","text":"hello"}]}')
    memory_text = f"2026-08-17 | post | id={'a' * 24} | earlier\n"
    resources = FakeResources()
    result = _run(
        tmp_path, persona=persona, backend=backend, memory_text=memory_text, resources=resources
    )
    assert result.outcome is ActOutcome.VETOED_EMPTY
    assert resources.get_boards_calls == 0


# ── unsplash access_key (fix round 1, item 6) ───────────────────────────────


def test_access_key_is_threaded_into_execute_action(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`run_act` does not resolve its own Unsplash credential -- it is a
    plain, caller-supplied parameter (ruling, fix round 1 item 6). Spied at
    the `execute_action` call site (patching the name `round.py` imported
    it under) since `FakeResources` has no visibility into `access_key`
    itself -- that argument only ever reaches a real `ImageFetcher`, which
    this round never exercises (no `imageTopic` in the plan below)."""
    import swil_agent.act.round as round_module

    captured: dict[str, object] = {}
    original = round_module.execute_action

    def _spy(resources: object, action: object, **kwargs: object) -> object:
        captured.update(kwargs)
        return original(resources, action, **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(round_module, "execute_action", _spy)
    backend = StubBackend('{"plan":[{"action":"nothing"}]}')
    _run(tmp_path, backend=backend, access_key="unsplash-test-key")
    assert captured["access_key"] == "unsplash-test-key"


def test_access_key_defaults_to_empty_string_not_none(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`execute_action`'s own default is `access_key: str = ""` (routes
    straight to the Picsum fallback) -- `run_act`'s `access_key or ""` must
    never let a bare `None` reach it, which would be a `str | None` where
    `execute_action`'s signature demands `str`."""
    import swil_agent.act.round as round_module

    captured: dict[str, object] = {}
    original = round_module.execute_action

    def _spy(resources: object, action: object, **kwargs: object) -> object:
        captured.update(kwargs)
        return original(resources, action, **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(round_module, "execute_action", _spy)
    backend = StubBackend('{"plan":[{"action":"nothing"}]}')
    _run(tmp_path, backend=backend)  # access_key left at its default (None)
    assert captured["access_key"] == ""
