"""Golden tests for `apply_guardrails` (contract `02` §1.2) — the jq program's
six stages, run in order, reproduced as typed Python.

Each case name pins one rule; see the module docstring of
`swil_agent/act/guardrails.py` for the stage list and, in particular, the
comment on stage 3 explaining why `no_post_after_nothing_strip_yields_empty`
must stay exactly where it is. `apply_guardrails` operates on already-typed
`Plan`/`Action` objects (validated upstream by `normalize_plan`), so unlike
the jq program there is no "malformed JSON degrades to []" fallback to test
here — that concern belongs to `swil_agent.llm.extract.normalize_plan`,
which already owns it.
"""

import json
from pathlib import Path
from typing import Any

import pytest

from swil_agent.act.guardrails import apply_guardrails
from swil_agent.models import Action, Plan, RhythmPolicy

CASES = json.loads((Path(__file__).parent / "guardrail_cases.json").read_text("utf-8"))


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_guardrail_case(case: dict[str, Any]) -> None:
    result = apply_guardrails(
        Plan(actions=[Action.model_validate(a) for a in case["plan"]]),
        policy=RhythmPolicy(case["policy"]),
        budget=case["budget"],
        contacts=case["contacts"],
        allowed=case["allowed"],
    )
    assert [a.model_dump(exclude_none=True) for a in result.actions] == case["expected_actions"]
    assert [[v.action.kind, v.reason] for v in result.vetoed] == case["expected_vetoed"]
