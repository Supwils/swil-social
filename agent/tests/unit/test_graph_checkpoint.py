"""Checkpoint wiring (task 4, spec §5.5): registered pydantic types survive a
`SqliteSaver` round trip, including under `LANGGRAPH_STRICT_MSGPACK`.

See `swil_agent/graph/checkpoint.py`'s module docstring for what "registered"
buys and one measured wrinkle (`Action`) it does not change -- that wrinkle
is why `_full_state` below carries every OTHER type directly as a field
value (never nested only inside another model), so any one of THOSE
registrations, removed, corrupts a distinct field this suite catches.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import get_args, get_origin, get_type_hints

import pytest
from langgraph.checkpoint.serde import _msgpack as lg_msgpack
from langgraph.graph import END, START, StateGraph
from pydantic import BaseModel

from swil_agent.graph.checkpoint import (
    CHECKPOINT_DB_NAME,
    REGISTERED_TYPES,
    open_checkpointer,
)
from swil_agent.graph.state import CycleState
from swil_agent.models import (
    ActContext,
    Action,
    ActionResult,
    AspectSims,
    DreamVerdict,
    Persona,
    Plan,
    VetoedAction,
)


def _persona(tmp_path: Path) -> Persona:
    return Persona(username="zenith", directory=tmp_path / "agents" / "zenith")


def _full_state(tmp_path: Path) -> CycleState:
    """One value for every field that is itself directly registered -- i.e.
    every reachable model except `Action` (see the module docstring above).
    A mutation dropping any ONE of these seven registrations corrupts a
    distinct field, and the per-field loop in the strict test below names
    which.
    """
    aspect_sims = AspectSims(values=0.7, style=0.8, topic=0.75)
    return {
        "tenant": "builtin",
        "agent": "zenith",
        "persona": _persona(tmp_path),
        "thread_id": "builtin:zenith:round-1",
        "context": ActContext(context_now="ctx", contacts=["a", "b"]),
        "plan": Plan(actions=[Action(kind="post", text="hello")]),
        "vetoed": [VetoedAction(action=Action(kind="comment", text="no"), reason="rhythm")],
        "results": [
            ActionResult(action=Action(kind="post", text="hi"), landed=True, resource_id="123")
        ],
        "round_index": 1,
        "aspect_sims": aspect_sims,
        "verdict": DreamVerdict(accepted=True, reason="ok", sims=aspect_sims),
        "dream_attempt": 1,
    }


def _one_node_graph(saver: object) -> object:
    builder = StateGraph(CycleState)
    builder.add_node("noop", lambda state: {})
    builder.add_edge(START, "noop")
    builder.add_edge("noop", END)
    return builder.compile(checkpointer=saver)  # type: ignore[arg-type]


def test_a_state_carrying_a_persona_round_trips(tmp_path: Path) -> None:
    saver = open_checkpointer(tmp_path / CHECKPOINT_DB_NAME)
    graph = _one_node_graph(saver)
    persona = _persona(tmp_path)
    config = {"configurable": {"thread_id": "builtin:zenith:round-1"}}
    graph.invoke({"agent": "zenith", "persona": persona}, config)  # type: ignore[attr-defined]
    snapshot = graph.get_state(config)  # type: ignore[attr-defined]
    assert snapshot.values["persona"] == persona


def test_registration_is_strict_enough_to_survive_strict_msgpack(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The deprecation warning says a future version will refuse unregistered
    types. Run the round trip under `LANGGRAPH_STRICT_MSGPACK=true` so this
    suite fails NOW rather than on the upgrade that turns it on.

    `setenv` alone is not load-bearing here, and that is worth recording
    rather than silently "fixing": `langgraph.checkpoint.serde._msgpack.
    STRICT_MSGPACK_ENABLED` is read once at import time, long before this
    test's `monkeypatch.setenv` runs, and `open_checkpointer` never consults
    it anyway -- it always passes an explicit `allowed_msgpack_modules`,
    bypassing the sentinel-default branch that constant governs entirely.
    Verified directly: a deliberately naive pre-registration implementation
    (a fresh `JsonPlusSerializer()` with no allowlist) still round-trips
    happily, warning but not blocking, under `setenv` alone; the same naive
    implementation genuinely blocks the unregistered type, and fails this
    assertion, once `STRICT_MSGPACK_ENABLED` is patched directly via
    `monkeypatch.setattr`. Both are set: `setattr` is what makes this test
    able to fail for the reason it names, `setenv` is kept for fidelity with
    how an operator would actually flip this in production.
    """
    monkeypatch.setenv("LANGGRAPH_STRICT_MSGPACK", "true")
    monkeypatch.setattr(lg_msgpack, "STRICT_MSGPACK_ENABLED", True)
    saver = open_checkpointer(tmp_path / CHECKPOINT_DB_NAME)
    graph = _one_node_graph(saver)
    state = _full_state(tmp_path)
    config = {"configurable": {"thread_id": state["thread_id"]}}
    graph.invoke(state, config)  # type: ignore[attr-defined]
    snapshot = graph.get_state(config)  # type: ignore[attr-defined]
    for key, expected in state.items():
        assert snapshot.values[key] == expected, key


def test_no_deprecation_warning_is_emitted(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """The brief's own sketch names `recwarn`, pytest's `warnings.warn`
    capture fixture. Measured: the unregistered-type notice is emitted
    through `logging.Logger.warning` (`jsonplus.py`'s `_warn_once`), never
    `warnings.warn` -- `recwarn.list` stays empty even for a genuinely
    unregistered type, so it cannot fail for the reason this test names.
    `caplog` is the fixture that can actually observe the message.
    """
    saver = open_checkpointer(tmp_path / CHECKPOINT_DB_NAME)
    graph = _one_node_graph(saver)
    persona = _persona(tmp_path)
    config = {"configurable": {"thread_id": "builtin:zenith:round-1"}}
    with caplog.at_level(logging.WARNING):
        graph.invoke({"agent": "zenith", "persona": persona}, config)  # type: ignore[attr-defined]
        graph.get_state(config)  # type: ignore[attr-defined]
    assert not any("unregistered type" in record.message for record in caplog.records)


def _independent_walk(hints: object) -> set[type[BaseModel]]:
    """A second, hand-written traversal of `CycleState`'s resolved type
    hints -- deliberately NOT a call to `checkpoint._discover_registered_
    types` -- so a bug in that function's own recursion (e.g. unwrapping only
    `CycleState`'s direct fields and never walking a found model's own
    fields, which is exactly what would silently drop `Action`) shows up as
    a mismatch here instead of trivially agreeing with itself.
    """
    found: set[type[BaseModel]] = set()
    stack = list(hints)  # type: ignore[arg-type]
    while stack:
        hint = stack.pop()
        origin = get_origin(hint)
        if origin is not None:
            stack.extend(get_args(hint))
            continue
        if isinstance(hint, type) and issubclass(hint, BaseModel) and hint not in found:
            found.add(hint)
            stack.extend(get_type_hints(hint).values())
    return found


def test_the_derived_registration_covers_every_model_reachable_from_cycle_state() -> None:
    expected = _independent_walk(get_type_hints(CycleState).values())
    assert expected == {
        Persona,
        ActContext,
        Plan,
        Action,
        VetoedAction,
        ActionResult,
        AspectSims,
        DreamVerdict,
    }
    assert expected == REGISTERED_TYPES
