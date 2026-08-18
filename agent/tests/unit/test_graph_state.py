"""`CycleState` and `thread_id` (task 2, spec §5.5)."""

import pytest

from swil_agent.graph.state import CycleState, thread_id


def test_thread_id_encodes_tenant_agent_and_round() -> None:
    assert thread_id("builtin", "zenith", "r7") == "builtin:zenith:r7"


def test_thread_id_rejects_a_component_containing_the_separator() -> None:
    """The id is parsed by splitting on ':'. A component carrying one would
    silently reassign the fields -- an agent named 'a:b' would land in another
    tenant's checkpoint namespace.
    """
    with pytest.raises(ValueError, match="must not contain"):
        thread_id("builtin", "zen:ith", "r7")


def test_cycle_state_is_total_false_so_nodes_can_return_partials() -> None:
    """LangGraph merges partial node returns. total=True would make every node
    responsible for the whole state."""
    assert CycleState.__total__ is False
