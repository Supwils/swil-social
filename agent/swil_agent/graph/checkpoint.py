"""SQLite checkpointer wiring: `CycleState` round-trips through LangGraph's
`SqliteSaver`, with every pydantic model reachable from it registered against
the msgpack serializer's allowlist.

Why registration is needed (measured behaviour, not speculation): a
`SqliteSaver` built with the library's own default serializer round-trips a
`CycleState` carrying a `Persona` today, but logs `Deserializing unregistered
type ... This will be blocked in a future version. Set
LANGGRAPH_STRICT_MSGPACK=true to block now, or add to allowed_msgpack_modules
to allow explicitly.` A pinned-version bump that flips that default to strict
would take resume out with no warning -- the whole point of persisting
`CycleState` is that a crashed cycle can restart from its last checkpoint,
and that path would go dark silently. Registering the types now, instead of
waiting for the upgrade to force the issue, is what this module does.

Where the DB file lives: `agent/.agent-state/`, the same directory Task 3's
`RunLease` / `FileLock` use for `lock_<name>` / `dream_lock_<name>` and that
`FilesystemDreamState` (`cli.py:382`) uses for its own state -- one directory
for every piece of "the Python runtime's local, per-account state" rather
than a new top-level directory per feature. `leases.py` itself takes a bare
`sqlite3.Connection` and does not choose a path (that call sits with a
future wiring task); the same is true here -- `open_checkpointer` takes a
full `db_path` rather than hardcoding one, so a caller is expected to pass
`settings.agent_root / ".agent-state" / CHECKPOINT_DB_NAME`, matching the
`FilesystemDreamState` pattern above. This module only owns the filename
(`CHECKPOINT_DB_NAME`), not the directory, so it stays trivially testable
against `tmp_path`.

The list of registered types is DERIVED from `CycleState`'s resolved type
hints, not hand-written: a hand-written list silently misses a field added
by a later task, and that is exactly the failure mode this module exists to
prevent. `typing.get_type_hints(CycleState)` is required rather than
`CycleState.__annotations__` -- with `from __future__ import annotations` in
`state.py`, `__annotations__` holds unresolved `ForwardRef`s
(`ForwardRef('Persona', module='swil_agent.graph.state')`), not classes.

Derivation walks two levels of nesting, not one: `CycleState`'s own fields
(`Persona`, `ActContext | None`, `Plan | None`, `list[VetoedAction]`,
`list[ActionResult]`, `AspectSims | None`, `DreamVerdict | None`, plus the
plain-value fields) are unwrapped first, then EVERY pydantic model found
that way has its own resolved fields unwrapped too, and so on until nothing
new turns up. That second level is what finds `Action` -- it is not a
`CycleState` annotation itself, only reachable through `Plan.actions`,
`VetoedAction.action`, and `ActionResult.action`. A single-level unwrap over
`CycleState` alone would miss it silently;
`test_the_derived_registration_covers_every_model_reachable_from_cycle_state`
(in the test module) pins the full closure so that regression cannot land
quietly.

One measured wrinkle, not obvious from the interface: `Action` never
independently reaches the msgpack allowlist check at runtime. The
serializer's pydantic-v2 branch calls `obj.model_dump()` before encoding,
which flattens `Plan.actions` / `VetoedAction.action` / `ActionResult.action`
into plain dicts BEFORE the ext-hook ever asks "is this type registered?" --
reconstruction of the nested `Action` happens through `Plan(**kwargs)`'s own
pydantic validation, not a second allowlist check. Verified directly:
round-tripping a `Plan` and a `VetoedAction` through a `JsonPlusSerializer`
allowlisted for `Plan`/`VetoedAction` but explicitly NOT `Action` reconstructs
both correctly. Registering `Action` anyway is still correct -- it costs
nothing, and a future langgraph version (or `Action` ever becoming a direct
`CycleState` field) could change that -- but it means removing `Action`'s
registration specifically will not fail either round-trip test below. The
task report documents this rather than implying otherwise.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Final, get_args, get_origin, get_type_hints

from langgraph.checkpoint.serde.jsonplus import JsonPlusSerializer
from langgraph.checkpoint.sqlite import SqliteSaver
from pydantic import BaseModel

from swil_agent.graph.state import CycleState

CHECKPOINT_DB_NAME: Final = "cycle_checkpoints.sqlite"


def _unwrap(hint: object) -> set[type]:
    """Recursively unwrap a type hint down to the bare classes inside it.

    Handles every generic shape `CycleState` and the models it carries
    actually use -- `X | None` (a `types.UnionType`), `list[X]` -- and
    anything else `typing.get_origin`/`get_args` can decompose, by recursing
    on each argument until an origin-less (bare) value is reached. A literal
    value (one arm of `Literal["post", ...]`, say) is not a class, so it is
    dropped rather than raising.
    """
    origin = get_origin(hint)
    if origin is None:
        return {hint} if isinstance(hint, type) else set()
    found: set[type] = set()
    for arg in get_args(hint):
        found |= _unwrap(arg)
    return found


def _discover_registered_types() -> frozenset[type[BaseModel]]:
    """Every pydantic model reachable from `CycleState`, transitively.

    Level 1: unwrap each of `CycleState`'s own resolved type hints. Level 2+:
    for every pydantic model that surfaces, unwrap ITS OWN resolved type
    hints too, and repeat until nothing new is found. This is what makes
    `Action` reachable (see the module docstring) and what makes a field
    added by a later task impossible to silently miss: if it is annotated on
    `CycleState` -- directly, inside a generic, or nested inside a model
    already reachable from `CycleState` -- this function finds it.
    """
    found: set[type[BaseModel]] = set()
    queue: list[type] = []
    for hint in get_type_hints(CycleState).values():
        queue.extend(_unwrap(hint))
    while queue:
        candidate = queue.pop()
        if not (isinstance(candidate, type) and issubclass(candidate, BaseModel)):
            continue
        if candidate in found:
            continue
        found.add(candidate)
        for hint in get_type_hints(candidate).values():
            queue.extend(_unwrap(hint))
    return frozenset(found)


REGISTERED_TYPES: Final[frozenset[type[BaseModel]]] = _discover_registered_types()


def open_checkpointer(db_path: Path) -> SqliteSaver:
    """Open a `SqliteSaver` at `db_path`, with every `REGISTERED_TYPES` model
    allowlisted against the msgpack serializer.

    Passing `allowed_msgpack_modules=list(REGISTERED_TYPES)` explicitly --
    rather than leaving the serializer on its library default -- sidesteps
    the `LANGGRAPH_STRICT_MSGPACK` environment variable's sentinel branch
    entirely: an explicit allowlist behaves identically whether or not that
    variable is set, because it is only consulted when no
    `allowed_msgpack_modules` argument is supplied at all. That is the
    property `test_registration_is_strict_enough_to_survive_strict_msgpack`
    pins, and it is what makes this registration survive a future version
    that flips the *default* -- this module never relies on the default.

    The database file (and its parent directory) is created if it does not
    already exist. `SqliteSaver.setup()` is called immediately so the schema
    exists as soon as this function returns, rather than lazily on the first
    `get`/`put` call.

    Callers own the returned `SqliteSaver`'s connection lifetime -- this
    function does not wrap it in a context manager, matching the interface
    this task specifies (`open_checkpointer(db_path: Path) -> SqliteSaver`,
    not a context-manager factory).
    """
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path), check_same_thread=False)
    serde = JsonPlusSerializer(allowed_msgpack_modules=list(REGISTERED_TYPES))
    saver = SqliteSaver(conn, serde=serde)
    saver.setup()
    return saver
