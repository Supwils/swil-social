import pytest
from pydantic import ValidationError

from swil_agent.models import (
    Action,
    ActOutcome,
    AspectSims,
    DreamVerdict,
    Plan,
    RhythmPolicy,
)


def test_action_rejects_unknown_kind() -> None:
    with pytest.raises(ValidationError):
        Action(kind="teleport")


def test_action_defaults_are_none() -> None:
    a = Action(kind="nothing")
    assert a.text is None
    assert a.post_id is None
    assert a.username is None


def test_plan_accepts_empty_action_list() -> None:
    """An empty plan is a legitimate state, not an error — see spec 7.1."""
    assert Plan(actions=[]).actions == []


def test_act_outcome_distinguishes_empty_from_unavailable() -> None:
    """rc=75 in Bash conflated these. They must never compare equal."""
    assert ActOutcome.VETOED_EMPTY != ActOutcome.PLANNER_EMPTY
    assert ActOutcome.PLANNER_EMPTY != ActOutcome.BACKEND_UNAVAILABLE


def test_rhythm_policy_has_exactly_three_values() -> None:
    assert {p.value for p in RhythmPolicy} == {"free", "no_post", "must_post"}


def test_dream_verdict_records_attempt() -> None:
    v = DreamVerdict(
        accepted=False,
        reason="[style] breached",
        breached=["style"],
        sims=AspectSims(values=0.717, style=0.718, topic=0.760),
        attempt=1,
    )
    assert v.attempt == 1
    assert v.sims is not None
    assert v.sims.style == 0.718
