"""Wire-format DTOs for the API boundary.

Unlike `models.py` (snake_case, domain-shaped, wire-format-agnostic by
contract — see that module's docstring), types here exist *only* to be
serialized onto the wire and therefore own the snake_case -> camelCase
conversion themselves. They carry no domain meaning of their own; nothing
outside `api/` should ever need to construct or inspect one.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class LabEvent(BaseModel):
    """One row for POST /agents/{username}/events.

    `action`, `reason` and `target_id` are omitted from the wire body when
    empty, and `action` is additionally omitted when it is the placeholder
    "-" — matching swil.sh's `_lab_event` jq (contract 02 §5.3). Emitting
    them as empty strings would change what the /lab surfaces count.
    """

    type: str
    phase: str
    outcome: str
    summary: str
    action: str | None = None
    reason: str | None = None
    target_id: str | None = None
    metrics: dict[str, Any] = Field(default_factory=dict)

    def to_wire(self) -> dict[str, Any]:
        body: dict[str, Any] = {
            "type": self.type,
            "phase": self.phase,
            "outcome": self.outcome,
            "summary": self.summary,
            "metrics": self.metrics,
        }
        if self.action and self.action != "-":
            body["action"] = self.action
        if self.reason:
            body["reason"] = self.reason
        if self.target_id:
            body["targetId"] = self.target_id
        return body
