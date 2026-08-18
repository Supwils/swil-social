"""`CycleState` -- the value the graph threads through every node (spec §5.5)."""

from __future__ import annotations

from typing import Final, TypedDict

from swil_agent.models import (
    ActContext,
    ActionResult,
    AspectSims,
    DreamVerdict,
    Persona,
    Plan,
    VetoedAction,
)

BUILTIN_TENANT: Final = "builtin"
_SEPARATOR: Final = ":"


def thread_id(tenant: str, agent: str, round_id: str) -> str:
    """`f"{tenant}:{agent}:{round_id}"` -- the checkpoint namespace key.

    The tenant is encoded from day one so multi-tenancy is a value change
    rather than a data migration (spec §5.5). Each component is validated
    against the separator: the id is parsed by splitting on `":"`, so a
    component containing one would silently reassign the fields -- an agent
    named `"a:b"` would land in another tenant's checkpoint namespace.
    """
    for label, value in (("tenant", tenant), ("agent", agent), ("round_id", round_id)):
        if _SEPARATOR in value:
            raise ValueError(f"{label} must not contain {_SEPARATOR!r}: {value!r}")
    return _SEPARATOR.join((tenant, agent, round_id))


class CycleState(TypedDict, total=False):
    """The value LangGraph threads through every node of the cycle graph.

    `total=False`: nodes return *partial* updates and LangGraph merges them
    into the running state. A `total=True` TypedDict would force every node
    to construct and return the whole state on every invocation.
    """

    # identity
    tenant: str
    agent: str
    persona: Persona
    thread_id: str
    run_id: str

    # act
    context: ActContext | None
    plan: Plan | None
    vetoed: list[VetoedAction]
    results: list[ActionResult]
    round_index: int

    # dream
    candidate: str | None
    validator_failures: list[str]
    aspect_sims: AspectSims | None
    verdict: DreamVerdict | None
    dream_attempt: int
