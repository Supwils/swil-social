"""Tests for the individual STEPS of `swil_agent.act.round` (Plan 3 Task 5).

`test_act_round.py` is the oracle for the composition: it drives `run_act`
end to end and must pass unchanged across any regrouping of the steps. This
file is the complement, and it exists because the oracle cannot see two
classes of defect:

  * **A step called directly.** Task 7's graph nodes call `login_step`,
    `execute_step`, `finalize_step` and friends themselves. A guard that
    lives in `run_act`'s body instead of in the step protects the CLI path
    and nothing else -- most sharply for `dry_run`, since Stage 3's shadow
    round drives 23 live accounts and `execute_step` performs 100% of a
    round's writes.
  * **A boundary that moved.** Three of the step boundaries were derived by
    hand from `auto-run.sh`, and a mutation that moves any of them back
    passes all 902 tests of the pre-existing suite. Each is pinned below
    with the mutation it kills named in the docstring; Task 7 re-touches
    exactly these boundaries.

Ordering is observed through a `Resources` double that records every call on
a shared trace, not through a `recorder=` parameter on the production
functions (the same convention `test_dream_round.py` follows, ruling R8).
"""

from __future__ import annotations

import json
import logging
import random
from contextlib import nullcontext
from datetime import datetime
from pathlib import Path
from typing import Any

import pytest

from swil_agent.act.round import (
    context_step,
    execute_step,
    finalize_step,
    guardrail_step,
    login_step,
    plan_step,
    run_act,
    sync_backend_step,
)
from swil_agent.locks import FileLock, act_lock_path
from swil_agent.models import Action, ActOutcome, Persona, Plan, RhythmPolicy

from ._runners import FakeResources, SilentBackend, StubBackend

NOW = datetime(2026, 8, 17, 10, 0, 0)
TODAY = "2026-08-17"


def _persona(
    tmp_path: Path,
    *,
    backend: str = "claude",
    rhythm_text: str = "",
    username: str = "zenith",
    dir_name: str = "zenith",
    board: str | None = None,
    model: str | None = None,
    read: str | None = None,
) -> Persona:
    """`board` (the POSTING target) and `read` (the INPUT pool) are separate
    parameters and default apart -- `read=None` is the state 22 of the 23
    roster accounts are in, and a helper that set both from one argument
    could not tell an implementation reading the right bullet from one
    reading the wrong one (Phase B task 3)."""
    directory = tmp_path / "agents" / dir_name
    directory.mkdir(parents=True, exist_ok=True)
    return Persona(
        username=username,
        directory=directory,
        backend=backend,
        model=model,
        rhythm_text=rhythm_text,
        board=board,
        read=read,
        raw="PERSONA",
    )


class TracingResources(FakeResources):
    """`FakeResources` plus an ordered, cross-method call trace.

    `FakeResources` records each call KIND in its own list (`calls`,
    `profile_patches`, `marked_read`, `lab_events`), which answers "did this
    happen" but never "did it happen before that". Every mutation this file
    kills is a reordering, so the trace is the instrument -- entries are
    coarse strings, since what is under test is sequence, not payload.

    `lock_path`, if given, makes every `update_profile` call record whether
    the account's lock file existed at that instant -- the only way to
    observe from outside that the `agentBackend` sync happened INSIDE the
    lock, since the lock is a file whose existence is the whole signal.
    """

    def __init__(self, *, lock_path: Path | None = None, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self.trace: list[str] = []
        self.lock_path = lock_path
        self.lock_held_during_patch: list[bool] = []

    def update_profile(self, patch: dict[str, Any]) -> None:
        self.trace.append("update_profile")
        if self.lock_path is not None:
            self.lock_held_during_patch.append(self.lock_path.exists())
        super().update_profile(patch)

    def feed_global(self, limit: int, sort: str) -> list[dict[str, Any]]:
        self.trace.append(f"feed_global:{sort}")
        return super().feed_global(limit, sort)

    def notifications(self, limit: int, unread_only: bool = True) -> list[dict[str, Any]]:
        self.trace.append("notifications")
        return super().notifications(limit, unread_only)

    def contacts(self) -> list[str]:
        self.trace.append("contacts")
        return super().contacts()

    def conversations(self, limit: int = 6) -> list[dict[str, Any]]:
        self.trace.append("conversations")
        return super().conversations(limit)

    def get_boards(self) -> dict[str, str]:
        self.trace.append("get_boards")
        return super().get_boards()

    def like_post(self, post_id: str) -> None:
        self.trace.append(f"like_post:{post_id}")
        super().like_post(post_id)

    def create_post(
        self,
        text: str,
        board_id: str | None = None,
        image: tuple[str, bytes] | None = None,
        echo_of: str | None = None,
    ) -> str:
        self.trace.append("create_post")
        return super().create_post(text, board_id, image, echo_of)

    def mark_notifications_read(self, ids: list[str] | None = None) -> None:
        self.trace.append("mark_notifications_read")
        super().mark_notifications_read(ids)

    def lab_event(self, username: str, event: Any) -> None:
        self.trace.append(f"lab_event:{event.type}/{event.phase}")
        super().lab_event(username, event)


def _plan_json(*actions: dict[str, str]) -> str:
    return json.dumps({"plan": list(actions)})


def _run(
    tmp_path: Path,
    *,
    persona: Persona | None = None,
    resources: FakeResources | None = None,
    backend: Any = None,
    memory_text: str = "",
    dry_run: bool = False,
    cross_read_prob: float | None = None,
) -> Any:
    return run_act(
        persona=persona or _persona(tmp_path),
        resources=resources if resources is not None else FakeResources(),
        backend=backend or StubBackend('{"plan":[{"action":"nothing"}]}'),
        memory_text=memory_text,
        agent_root=tmp_path,
        now=NOW,
        rng=random.Random(0),
        health_check=lambda: True,
        dry_run=dry_run,
        **({} if cross_read_prob is None else {"cross_read_prob": cross_read_prob}),
    )


# ── login_step ──────────────────────────────────────────────────────────────


def test_login_step_offline_hands_back_no_real_lock(tmp_path: Path) -> None:
    """An offline probe must yield a lock that CANNOT touch the filesystem.

    `run_act` cannot catch this on its own -- it returns `OFFLINE` before it
    ever enters `login.lock`, and `FileLock.__init__` writes nothing -- so
    the hazard lands on the second caller: a Task 7 node doing `with
    login.lock:` without branching on `online` would create
    `.agent-state/lock_<name>`. During Stages 3-4 a concurrent Bash round
    then hits `SKIP ... -- locked` and loses BOTH its act and its dream.

    Mutation this kills: returning `FileLock(act_lock_path(...))` on the
    offline branch (or hoisting the lock choice above the probe).
    """
    step = login_step(
        persona=_persona(tmp_path),
        agent_root=tmp_path,
        health_check=lambda: False,
    )

    assert step.online is False
    assert isinstance(step.lock, nullcontext)
    assert not isinstance(step.lock, FileLock)
    with step.lock:
        pass
    assert not act_lock_path(tmp_path, "zenith").exists()


def test_login_step_online_locks_under_the_directory_name_not_the_username(
    tmp_path: Path,
) -> None:
    """Bash's `agent_name` is `basename "$agent_dir"` (`auto-run.sh:437`),
    never the `Username` bullet -- the two diverge in the documented "stray
    agents/<name> dir shadows a humans/ account" case, and a lock computed
    from the wrong one voids cross-runtime exclusion with the suite green."""
    persona = _persona(tmp_path, username="zenith", dir_name="zenith_dir")

    step = login_step(persona=persona, agent_root=tmp_path, health_check=lambda: True)

    assert step.online is True
    assert step.agent_name == "zenith_dir"
    assert isinstance(step.lock, FileLock)
    with step.lock:
        assert act_lock_path(tmp_path, "zenith_dir").exists()
        assert not act_lock_path(tmp_path, "zenith").exists()
    assert not act_lock_path(tmp_path, "zenith_dir").exists()


def test_login_step_dry_run_takes_no_lock(tmp_path: Path) -> None:
    """F4: a dry run acquires NOTHING, so the documented "safe inspection
    command" cannot cost a live Bash round its lock."""
    step = login_step(
        persona=_persona(tmp_path),
        agent_root=tmp_path,
        health_check=lambda: True,
        dry_run=True,
    )

    assert step.online is True
    assert isinstance(step.lock, nullcontext)
    with step.lock:
        pass
    assert not act_lock_path(tmp_path, "zenith").exists()


# ── sync_backend_step (M1/M3: the boundary my brief got wrong) ──────────────


def test_sync_backend_step_writes_the_backend_and_model_tier(tmp_path: Path) -> None:
    resources = FakeResources()

    sync_backend_step(
        resources=resources,
        persona=_persona(tmp_path, backend="claude", model="sonnet"),
        agent_name="zenith",
    )

    assert resources.profile_patches == [{"agentBackend": "claude:sonnet"}]


def test_sync_backend_step_is_inert_under_dry_run(tmp_path: Path) -> None:
    """The guard travels with the step, not with whichever caller remembers
    it -- this is a PATCH against a live account."""
    resources = FakeResources()

    sync_backend_step(
        resources=resources,
        persona=_persona(tmp_path),
        agent_name="zenith",
        dry_run=True,
    )

    assert resources.profile_patches == []


@pytest.mark.parametrize(
    ("backend", "expected_outcome"),
    [
        (SilentBackend(), ActOutcome.BACKEND_UNAVAILABLE),
        (StubBackend('{"plan":[]}'), ActOutcome.PLANNER_EMPTY),
    ],
)
def test_the_backend_sync_still_happens_on_a_round_that_returns_early(
    tmp_path: Path, backend: Any, expected_outcome: ActOutcome
) -> None:
    """M1 (the brief's own instruction: defer the sync to `finalize_step`).

    Deferring it drops the PATCH ENTIRELY on every early-return path --
    backend-unavailable, planner-empty, vetoed-empty -- and the whole
    902-test suite stays green. `agentBackend` is the drift experiment's
    independent variable and empty-plan rounds are common on this roster, so
    the field would have gone stale on exactly the accounts under study.
    """
    resources = FakeResources()

    result = _run(tmp_path, resources=resources, backend=backend)

    assert result.outcome is expected_outcome
    assert resources.profile_patches == [{"agentBackend": "claude"}]


def test_the_backend_sync_still_happens_on_a_vetoed_empty_round(tmp_path: Path) -> None:
    """M1, third early-return path: a DM to someone not in contacts is
    stripped by the contacts guardrail. Codex is no longer allow-listed
    (loop-engine spec §7); the veto still has to fire the backend sync."""
    resources = FakeResources()
    persona = _persona(tmp_path, backend="codex")
    backend = StubBackend(_plan_json({"action": "dm", "username": "vex", "text": "hi"}))

    result = _run(tmp_path, persona=persona, resources=resources, backend=backend)

    assert result.outcome is ActOutcome.VETOED_EMPTY
    assert resources.profile_patches == [{"agentBackend": "codex"}]


def test_the_backend_sync_precedes_every_other_call_of_the_round(tmp_path: Path) -> None:
    """M1's other half: relocating the sync past the round's reads/writes.

    Bash PATCHes at `auto-run.sh:473-494`, before any context is built, so
    the sync is the FIRST call a round makes. A round that syncs at the end
    reports a backend the round did not run under if it dies mid-way.
    """
    resources = TracingResources()
    backend = StubBackend(_plan_json({"action": "like", "postId": "a" * 24}))

    _run(tmp_path, resources=resources, backend=backend)

    assert resources.trace[0] == "update_profile"
    assert "update_profile" not in resources.trace[1:]


def test_the_backend_sync_happens_while_the_account_lock_is_held(tmp_path: Path) -> None:
    """M3: hoisting the sync above `with login.lock:`.

    Silent in a single process and invisible to every assertion about WHAT
    was patched -- but the PATCH would then race a concurrent Bash round for
    the same account's profile, which is the entire reason Bash does it
    after `acquire_lock`.
    """
    resources = TracingResources(lock_path=act_lock_path(tmp_path, "zenith"))

    _run(tmp_path, resources=resources)

    assert resources.lock_held_during_patch == [True]


def test_a_dry_run_syncs_nothing_and_never_creates_the_lock(tmp_path: Path) -> None:
    resources = TracingResources(lock_path=act_lock_path(tmp_path, "zenith"))

    _run(tmp_path, resources=resources, dry_run=True)

    assert resources.profile_patches == []
    assert resources.lock_held_during_patch == []
    assert not act_lock_path(tmp_path, "zenith").exists()


# ── context_step ────────────────────────────────────────────────────────────


def test_context_step_feeds_the_rhythm_the_count_it_just_computed(tmp_path: Path) -> None:
    """The two calls are one step because `decide_rhythm`'s `posts_today` is
    `ctx.today_post_count`. Mutation this kills: passing a re-derived or
    zero count -- the ceiling below is 1, so a round with one post already
    on record must come back `NO_POST`, and any other count returns `FREE`.
    """
    persona = _persona(tmp_path, rhythm_text="已有一条发帖记录时不要再发帖")
    memory = f"{TODAY} | post | id=abc | hello\n"

    step = context_step(
        resources=FakeResources(),
        persona=persona,
        memory_text=memory,
        now=NOW,
        rng=random.Random(0),
    )

    assert step.context.today_post_count == 1
    assert step.rhythm.policy is RhythmPolicy.NO_POST
    assert step.rhythm.post_ceiling == 1


# ── context_step: the board-read lab event (Phase B task 3, spec §8.3) ──────
#
# The EMISSION is pinned here rather than in `test_act_context.py` because it
# is a `context_step` responsibility: `build_context` chooses and records the
# scope and writes nothing, and this step is the seam both callers pass
# through (`run_act` and `graph/nodes.py`'s login node) and the first point in
# the read path that knows `dry_run`.

_HOME = "living"
# `random.Random(0).random()` is 0.8444 -- above the shipping 0.15, so these
# rounds stay on the home board unless a test raises the probability.
_HOME_SEED = 0


def _boarded(resources: FakeResources) -> FakeResources:
    resources.board_lookup = {slug: f"id-{slug}" for slug in (_HOME, "market", "perception")}
    resources.board_feeds[_HOME] = [{"id": "a" * 24, "text": "home post"}]
    resources.board_feeds["market"] = [{"id": "b" * 24, "text": "market post"}]
    resources.board_feeds["perception"] = [{"id": "c" * 24, "text": "perception post"}]
    return resources


def _board_rows(resources: FakeResources) -> list[Any]:
    return [e for e in resources.lab_events if "boardRead" in e.metrics]


class _RhythmRecordingRandom(random.Random):
    """Records WHICH generator method was called, in call order.

    `choose_read_scope` draws with `.random()` and `decide_rhythm` with
    `.randint()` (`rhythm.py:74`), so the two consumers are distinguishable
    by method alone -- no need to reason about how many values each took.
    """

    def __init__(self, seed: int) -> None:
        super().__init__(seed)
        self.order: list[str] = []

    def random(self) -> float:
        self.order.append("random")
        return super().random()

    def randint(self, a: int, b: int) -> int:  # type: ignore[override]
        self.order.append("randint")
        return super().randint(a, b)


def _context(resources: FakeResources, persona: Persona, **kwargs: Any) -> Any:
    rng = kwargs.pop("rng_override", None) or random.Random(kwargs.pop("seed", _HOME_SEED))
    return context_step(
        resources=resources,
        persona=persona,
        memory_text="",
        now=NOW,
        rng=rng,
        **kwargs,
    )


def test_a_niche_accounts_round_files_one_board_read_row(tmp_path: Path) -> None:
    """`type=cycle` / `phase=act` -- the act path's own pair and the pair
    `agentEventIngest`'s two zod enums accept for this phase. `action` stays
    unset so the row never mixes with `act/executor.py`'s real per-action
    rows when filtering by it: nothing was acted on, this records an INPUT."""
    resources = _boarded(FakeResources())

    _context(resources, _persona(tmp_path, read=_HOME))

    rows = _board_rows(resources)
    assert len(rows) == 1
    assert (rows[0].type, rows[0].phase, rows[0].outcome) == ("cycle", "act", "success")
    assert rows[0].action is None
    assert rows[0].summary == "read its own board"
    assert rows[0].metrics["boardRead"] == _HOME
    assert rows[0].metrics["homeBoard"] == _HOME
    assert rows[0].metrics["crossRead"] is False


def test_a_cross_read_row_names_the_board_that_was_actually_read(tmp_path: Path) -> None:
    """The row is the ONLY record that a round left its niche. A row that
    named the home board on a cross-read would make the intervention
    unmeasurable while looking entirely healthy."""
    resources = _boarded(FakeResources())

    step = _context(resources, _persona(tmp_path, read=_HOME), cross_read_prob=1.0)

    row = _board_rows(resources)[0]
    assert row.summary == "cross-read another board"
    assert row.metrics["crossRead"] is True
    assert row.metrics["boardRead"] != _HOME
    assert row.metrics["boardRead"] == step.context.board_read
    # The only record of WHICH niche this round left. `boardRead` names the
    # away board, and recovering the home one otherwise means joining against
    # an assignment that lives in a file a dream can rewrite.
    assert row.metrics["homeBoard"] == _HOME
    assert [slug for slug, _, _ in resources.feed_board_calls] == [step.context.board_read] * 2


def test_an_account_with_no_read_bullet_files_no_board_read_row(tmp_path: Path) -> None:
    """22 of 23 accounts. Their board is a constant of the assignment table,
    not a per-round observation, and 23 rows a round restating it would be 23
    rows a round of no information."""
    resources = _boarded(FakeResources())

    _context(resources, _persona(tmp_path))

    assert _board_rows(resources) == []


def test_read_global_files_no_board_read_row_either(tmp_path: Path) -> None:
    """`Read: global` is the widest-input ARM, not a niche -- it must behave
    exactly like the absent bullet, or adding the bullet to the one account
    that carries it would have changed that account's data."""
    resources = _boarded(FakeResources())

    _context(resources, _persona(tmp_path, read="global"))

    assert _board_rows(resources) == []


def test_a_dry_run_files_no_board_read_row(tmp_path: Path) -> None:
    """The row is a WRITE, and Stage 3's shadow round drives 23 live accounts
    (standing constraint §9). The read itself still happens -- a shadow round
    that planned against a different feed from the real one would be shadowing
    nothing."""
    resources = _boarded(FakeResources())

    step = _context(resources, _persona(tmp_path, read=_HOME), dry_run=True)

    assert _board_rows(resources) == []
    assert resources.feed_board_calls == [(_HOME, 40, "recommended"), (_HOME, 18, "latest")]
    assert step.context.board_read == _HOME


def test_the_board_read_rows_metrics_are_flat_scalars(tmp_path: Path) -> None:
    """`agentEventIngest.metrics` is a `z.record` of string/number/boolean/
    null (`agents.schemas.ts:59`); a nested object or a list fails that union
    and makes zod 400 the WHOLE event, silently in both runtimes. That defect
    ran unnoticed for six weeks on the dream side."""
    resources = _boarded(FakeResources())

    _context(resources, _persona(tmp_path, read=_HOME))

    metrics = _board_rows(resources)[0].metrics
    assert set(metrics) == {
        "boardRead",
        "homeBoard",
        "crossRead",
        "crossReadProb",
        "boardItems",
    }
    assert all(v is None or isinstance(v, str | int | float | bool) for v in metrics.values())
    assert metrics["boardItems"] == 1


def test_the_row_records_the_probability_the_round_actually_rolled_against(
    tmp_path: Path,
) -> None:
    """Without it a run of home reads cannot be told apart from an operator
    having turned the probability down, and "did cross-reads fire at the rate
    we set?" is unanswerable from the series itself. 0.42 is neither the
    module default (0.15) nor either extreme."""
    resources = _boarded(FakeResources())

    _context(resources, _persona(tmp_path, read=_HOME), cross_read_prob=0.42)

    assert _board_rows(resources)[0].metrics["crossReadProb"] == 0.42


def test_a_failed_board_read_is_a_warn_row_with_null_items(tmp_path: Path) -> None:
    """`boardItems: null` is "the fetch failed"; `0` is "the board is empty".
    A thin board starving an account and an outage must not look alike."""
    resources = _boarded(FakeResources())
    resources.fail(f"feed_board_{_HOME}")

    _context(resources, _persona(tmp_path, read=_HOME))

    row = _board_rows(resources)[0]
    assert row.outcome == "warn"
    assert row.metrics["boardItems"] is None
    assert row.metrics["boardRead"] == _HOME


def test_an_empty_board_is_a_success_row_with_zero_items(tmp_path: Path) -> None:
    resources = _boarded(FakeResources())
    resources.board_feeds[_HOME] = []

    _context(resources, _persona(tmp_path, read=_HOME))

    row = _board_rows(resources)[0]
    assert row.outcome == "success"
    assert row.metrics["boardItems"] == 0


def test_a_cross_read_into_a_board_slugged_global_still_files_its_row(
    tmp_path: Path,
) -> None:
    """The niche gate asks "does this ACCOUNT have a niche", which is
    `ctx.home_board` -- not `ctx.board_read`, which is where this ROUND ended
    up.

    Mutation this kills: `ctx.board_read == GLOBAL_READ_SCOPE` in place of
    `ctx.home_board == GLOBAL_READ_SCOPE`. The two agree on every ordinary
    round, which is why this scenario has to be built deliberately: `slug` is
    `z.string().min(1).max(64)` on the server with no reserved-word check
    (`feed.routes.ts`, `boards` schema), so a board slugged `global` is
    creatable, and a niched account can cross-read into it. Under the mutation
    that account's row silently disappears -- the one round where knowing what
    it read matters most.

    Note the collision this exposes and does NOT resolve: `Read: global`
    always means the global feed, so an account could never be niched TO such
    a board. `global` is a reserved keyword for the read scope; the board
    namespace does not know that.
    """
    resources = _boarded(FakeResources())
    resources.board_lookup = {_HOME: "id-living", "global": "id-global"}
    resources.board_feeds["global"] = [{"id": "g" * 24, "text": "from the global board"}]

    step = _context(resources, _persona(tmp_path, read=_HOME), cross_read_prob=1.0)

    assert step.context.board_read == "global"
    assert step.context.home_board == _HOME
    row = _board_rows(resources)[0]
    assert row.metrics["boardRead"] == "global"
    assert row.metrics["homeBoard"] == _HOME
    assert row.metrics["crossRead"] is True


def test_the_board_read_row_is_filed_under_the_username_not_the_folder(
    tmp_path: Path,
) -> None:
    """`quant`/`shujupai`, `sketch`/`diannaokun`, `vex`/`weijian` and
    `zenith`/`xuansi` have a folder name that is not their `Username`, and
    `/agents/{username}/events` is keyed by the second. A fixture whose two
    names matched would make the slip invisible."""
    resources = _boarded(FakeResources())

    _context(
        resources,
        _persona(tmp_path, read=_HOME, username="shujupai", dir_name="quant"),
    )

    assert resources.lab_event_usernames == ["shujupai"]


def test_the_cross_read_roll_draws_before_the_rhythm_does(tmp_path: Path) -> None:
    """Both draws come from the SAME injected generator and the order between
    them is fixed: `build_context` rolls, then `decide_rhythm` draws.

    This is why `choose_read_scope` returns for a global account BEFORE
    rolling -- an unconditional draw there would shift every existing
    account's rhythm decision for a given seed the day one account gained a
    `Read` bullet. The rhythm text below carries a probability rule, so
    `decide_rhythm` genuinely draws (`rhythm.py:74`); with a plain rhythm it
    draws nothing and this test would pass vacuously.
    """
    rhythm_text = "- 每次触发有 60% 概率选择 post"

    niche = _RhythmRecordingRandom(_HOME_SEED)
    _context(
        _boarded(FakeResources()),
        _persona(tmp_path, read=_HOME, rhythm_text=rhythm_text),
        rng_override=niche,
    )

    plain = _RhythmRecordingRandom(_HOME_SEED)
    _context(
        _boarded(FakeResources()),
        _persona(tmp_path, dir_name="global-account", rhythm_text=rhythm_text),
        rng_override=plain,
    )

    # Only the PREFIX is pinned: overriding `random()` on a `random.Random`
    # subclass makes CPython route `randint` through `random()` too
    # (`Random.__init_subclass__`), so each `randint` appends a trailing
    # `random` of its own. That is this fixture's artefact, not the code's.
    assert niche.order[:2] == ["random", "randint"]
    assert plain.order[0] == "randint"


def test_run_act_threads_its_dry_run_into_the_board_read_row(tmp_path: Path) -> None:
    """The guard lives in `record_board_read`, but `run_act` still has to HAND
    it the flag. Mutation this kills: `dry_run=False` (or an omitted argument)
    on `run_act`'s `context_step` call.

    `test_act_round.py`'s `test_dry_run_never_calls_the_api_or_writes_memory`
    asserts `lab_events == []` and cannot catch this: its persona carries no
    `Read` bullet, so no row would be filed either way. That is standing
    constraint §4 in miniature -- the assertion names the right thing and the
    fixture makes it undetectable.
    """
    resources = _boarded(FakeResources())
    persona = _persona(tmp_path, read=_HOME)

    _run(tmp_path, persona=persona, resources=resources, dry_run=True)
    assert _board_rows(resources) == []

    _run(tmp_path, persona=persona, resources=resources)
    assert len(_board_rows(resources)) == 1


def test_run_act_threads_its_cross_read_probability_into_the_roll(tmp_path: Path) -> None:
    """Mutation this kills: dropping `cross_read_prob=cross_read_prob` from
    `run_act`'s `context_step` call, so `swil-agent act --seed` silently rolls
    against 0.15 whatever the operator configured -- including `0`."""
    resources = _boarded(FakeResources())

    _run(
        tmp_path,
        persona=_persona(tmp_path, read=_HOME),
        resources=resources,
        cross_read_prob=1.0,
    )

    row = _board_rows(resources)[0]
    assert row.metrics["crossRead"] is True
    assert row.metrics["crossReadProb"] == 1.0


# ── plan_step ───────────────────────────────────────────────────────────────


def test_plan_step_sends_the_rhythms_guidance_not_another_of_its_fields(
    tmp_path: Path,
) -> None:
    """`RhythmDecision` carries three strings and the planner wants exactly
    one of them. Handing it `prefer_non_post` typechecks, runs, and silently
    changes every prompt the roster sees -- so the choice is made in one
    place and pinned here."""
    persona = _persona(tmp_path, rhythm_text="已有一条发帖记录时不要再发帖")
    ctx_step = context_step(
        resources=FakeResources(),
        persona=persona,
        memory_text=f"{TODAY} | post | id=abc | hello\n",
        now=NOW,
        rng=random.Random(0),
    )
    backend = StubBackend('{"plan":[{"action":"nothing"}]}')

    plan = plan_step(
        backend=backend,
        persona=persona,
        context=ctx_step.context,
        rhythm=ctx_step.rhythm,
    )

    assert plan is not None
    assert backend.last is not None
    assert ctx_step.rhythm.guidance in backend.last.user
    assert ctx_step.rhythm.prefer_non_post != ctx_step.rhythm.guidance


def test_plan_step_returns_none_when_the_backend_produces_nothing(tmp_path: Path) -> None:
    persona = _persona(tmp_path)
    ctx_step = context_step(
        resources=FakeResources(),
        persona=persona,
        memory_text="",
        now=NOW,
        rng=random.Random(0),
    )

    plan = plan_step(
        backend=SilentBackend(),
        persona=persona,
        context=ctx_step.context,
        rhythm=ctx_step.rhythm,
    )

    assert plan is None


# ── guardrail_step ──────────────────────────────────────────────────────────


def test_guardrail_step_performs_no_api_calls(tmp_path: Path) -> None:
    """Task 7 requires the `guardrail` node to be pure. The contacts list it
    filters dms against comes from the context the planner was SHOWN, never
    a fresh read -- a re-read could return a different set and veto a dm the
    plan was entitled to make."""
    resources = TracingResources()
    persona = _persona(tmp_path)
    ctx_step = context_step(
        resources=resources,
        persona=persona,
        memory_text="",
        now=NOW,
        rng=random.Random(0),
    )
    resources.trace.clear()
    plan = Plan(actions=[Action(kind="like", post_id="a" * 24)])

    step = guardrail_step(
        plan=plan, persona=persona, rhythm=ctx_step.rhythm, context=ctx_step.context
    )

    assert resources.trace == []
    assert step.empty_outcome is None
    assert step.solo_nothing is False
    assert [a.kind for a in step.actions] == ["like"]


def test_guardrail_step_labels_a_dropped_plan_vetoed_and_an_absent_one_empty(
    tmp_path: Path,
) -> None:
    """The one distinction Bash cannot make: it logs both as `planned:
    nothing`, which is what left three codex accounts uninterpretable on
    2026-08-16. Codex is no longer allow-listed (loop-engine spec §7); a
    DM to someone not in contacts is the veto that still empties a plan."""
    persona = _persona(tmp_path, backend="codex")
    ctx_step = context_step(
        resources=FakeResources(),
        persona=persona,
        memory_text="",
        now=NOW,
        rng=random.Random(0),
    )

    dropped = guardrail_step(
        plan=Plan(actions=[Action(kind="dm", username="vex", text="hi")]),
        persona=persona,
        rhythm=ctx_step.rhythm,
        context=ctx_step.context,
    )
    absent = guardrail_step(
        plan=Plan(actions=[]),
        persona=persona,
        rhythm=ctx_step.rhythm,
        context=ctx_step.context,
    )

    assert dropped.empty_outcome is ActOutcome.VETOED_EMPTY
    assert dropped.vetoed != []
    assert absent.empty_outcome is ActOutcome.PLANNER_EMPTY
    assert absent.vetoed == []


def test_guardrail_step_flags_a_surviving_lone_nothing(tmp_path: Path) -> None:
    """`solo_nothing` is not an `empty_outcome`: the action survives and is
    still executed, so its lab event and log line fire the way Bash's do."""
    persona = _persona(tmp_path)
    ctx_step = context_step(
        resources=FakeResources(),
        persona=persona,
        memory_text="",
        now=NOW,
        rng=random.Random(0),
    )

    step = guardrail_step(
        plan=Plan(actions=[Action(kind="nothing")]),
        persona=persona,
        rhythm=ctx_step.rhythm,
        context=ctx_step.context,
    )

    assert step.empty_outcome is None
    assert step.solo_nothing is True
    assert [a.kind for a in step.actions] == ["nothing"]


# ── execute_step ────────────────────────────────────────────────────────────


def test_execute_step_writes_each_actions_memory_line_before_the_next_write(
    tmp_path: Path,
) -> None:
    """M2: batching the memory writes after the execute loop.

    Bash's `_remember` runs inside `swil.sh`'s own per-action case, so action
    N's `memory/memory/success` event is POSTed before action N+1's write
    goes out. Batching reorders every memory event to the end of the round
    and changes what survives a crash mid-round -- and the whole
    pre-existing suite stays green, because the return value is identical.
    """
    resources = TracingResources()
    persona = _persona(tmp_path)
    actions = [
        Action(kind="like", post_id="a" * 24),
        Action(kind="like", post_id="b" * 24),
    ]

    step = execute_step(
        resources=resources,
        persona=persona,
        actions=actions,
        agent_name="zenith",
        now=NOW,
    )

    assert step.landed == 2
    first_memory_event = resources.trace.index("lab_event:memory/memory")
    second_write = resources.trace.index(f"like_post:{'b' * 24}")
    assert first_memory_event < second_write, resources.trace
    assert (persona.directory / "memory.md").read_text(encoding="utf-8").count("\n") == 2


def test_execute_step_is_inert_under_dry_run(tmp_path: Path) -> None:
    """The step that performs 100% of a round's writes must honour the flag
    ITSELF. Stage 3 is a `--dry-run` shadow round over 23 live accounts: a
    caller that threaded `dry_run` into every step that accepted one, and
    found this one did not, would post for real.
    """
    resources = TracingResources()
    persona = _persona(tmp_path, board="tech")
    resources.board_lookup = {"tech": "board-1"}

    step = execute_step(
        resources=resources,
        persona=persona,
        actions=[Action(kind="post", text="hello")],
        agent_name="zenith",
        now=NOW,
        dry_run=True,
    )

    assert step == ([], 0, 0)
    assert resources.trace == []
    assert resources.get_boards_calls == 0
    assert not (persona.directory / "memory.md").exists()


def test_execute_step_resolves_the_board_once_for_the_whole_round(tmp_path: Path) -> None:
    resources = TracingResources()
    persona = _persona(tmp_path, board="tech")
    resources.board_lookup = {"tech": "board-1"}

    execute_step(
        resources=resources,
        persona=persona,
        actions=[Action(kind="post", text="hello")],
        agent_name="zenith",
        now=NOW,
    )

    assert resources.get_boards_calls == 1
    assert resources.created_posts[0].board_id == "board-1"


# ── finalize_step ───────────────────────────────────────────────────────────


def test_finalize_step_is_inert_under_dry_run(tmp_path: Path) -> None:
    """Mark-read is a WRITE, and one that mutates what the next REAL round
    sees. The dry label is returned directly rather than falling through to
    the normal classification, which would log Bash's FAIL line at every
    shadow round (a dry run's `landed` is always 0)."""
    resources = TracingResources()

    outcome = finalize_step(
        resources=resources,
        actions=[Action(kind="nothing")],
        agent_name="zenith",
        attempted=0,
        landed=0,
        solo_nothing=False,
        dry_run=True,
    )

    assert outcome is ActOutcome.LANDED_ALL
    assert resources.trace == []
    assert resources.marked_read == []


def test_a_dry_run_of_a_real_plan_is_landed_all_and_logs_no_fail_line(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """The end-to-end half of the guard above, and a gap the oracle leaves
    open: no existing test asserts the OUTCOME of a dry run whose plan has a
    real (non-`nothing`) surviving action. Without `finalize_step`'s guard
    the round reports `LANDED_PARTIAL` and writes
    `FAIL zenith -- all 0 planned actions failed` to `auto-run.log`'s Python
    equivalent, at every account of every shadow round."""
    backend = StubBackend(_plan_json({"action": "like", "postId": "a" * 24}))

    with caplog.at_level(logging.WARNING, logger="swil_agent.act.round"):
        result = _run(tmp_path, backend=backend, dry_run=True)

    assert result.outcome is ActOutcome.LANDED_ALL
    assert result.attempted == 0
    assert caplog.text == ""


def test_finalize_step_marks_nothing_when_nothing_landed(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """Bash's mark-read block sits after its `landed == 0` return, so those
    notifications must survive to the next round -- and the FAIL line is
    keyed on the DIRECTORY name."""
    resources = TracingResources()

    with caplog.at_level(logging.WARNING, logger="swil_agent.act.round"):
        outcome = finalize_step(
            resources=resources,
            actions=[Action(kind="like", post_id="a" * 24)],
            agent_name="zenith_dir",
            attempted=1,
            landed=0,
            solo_nothing=False,
        )

    assert outcome is ActOutcome.LANDED_PARTIAL
    assert resources.trace == []
    assert "FAIL zenith_dir" in caplog.text


def test_finalize_step_marks_read_when_something_landed(tmp_path: Path) -> None:
    resources = TracingResources()

    outcome = finalize_step(
        resources=resources,
        actions=[Action(kind="nothing")],
        agent_name="zenith",
        attempted=1,
        landed=1,
        solo_nothing=True,
    )

    assert outcome is ActOutcome.PLANNER_EMPTY
    assert resources.marked_read == [None]
