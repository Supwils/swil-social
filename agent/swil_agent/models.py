"""Data types shared across the agent runtime.

Field names use snake_case; the wire format uses camelCase. Conversion happens
at the API boundary (api/resources.py), never here.
"""

from __future__ import annotations

from enum import StrEnum
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

ActionKind = Literal["post", "comment", "like", "follow", "dm", "echo", "nothing"]


class Action(BaseModel):
    model_config = ConfigDict(extra="ignore")

    kind: ActionKind
    text: str | None = None
    post_id: str | None = None
    parent_id: str | None = None
    username: str | None = None
    image_topic: str | None = None


class Plan(BaseModel):
    actions: list[Action] = Field(default_factory=list)


class VetoedAction(BaseModel):
    action: Action
    reason: str


class ActionResult(BaseModel):
    action: Action
    landed: bool
    resource_id: str | None = None
    detail: str | None = None


class ActOutcome(StrEnum):
    LANDED_ALL = "landed_all"
    LANDED_PARTIAL = "landed_partial"
    VETOED_EMPTY = "vetoed_empty"
    PLANNER_EMPTY = "planner_empty"
    BACKEND_UNAVAILABLE = "backend_unavailable"
    OFFLINE = "offline"


class RhythmPolicy(StrEnum):
    FREE = "free"
    NO_POST = "no_post"
    MUST_POST = "must_post"


class RhythmDecision(BaseModel):
    policy: RhythmPolicy
    prefer_non_post: str
    guidance: str
    post_ceiling: int | None = None
    post_probability: int | None = None
    roll: int | None = None


class Persona(BaseModel):
    model_config = ConfigDict(arbitrary_types_allowed=True)

    username: str
    display_name: str | None = None
    headline: str | None = None
    bio: str | None = None
    follow_topics: list[str] = Field(default_factory=list)
    backend: str = "claude"
    model: str | None = None
    board: str | None = None
    read: str | None = None
    rhythm_text: str = ""
    raw: str = ""
    directory: Path


class AspectSims(BaseModel):
    values: float
    style: float
    topic: float


class DreamVerdict(BaseModel):
    accepted: bool
    reason: str
    breached: list[str] = Field(default_factory=list)
    sims: AspectSims | None = None
    attempt: int = 1


class ActContext(BaseModel):
    """Everything that goes into the planner prompt.

    Two field classes, and the difference is load-bearing (contract 01 §4):
    fields with a non-empty default ALWAYS render, showing their placeholder
    when the source failed; fields defaulting to "" make their whole prompt
    section disappear. Unifying them would change the model's input on any
    partial-outage round.
    """

    context_now: str = "(no context file)"
    notification_context: str = "（暂无新互动）"
    recent_memory: str = "(no memory yet)"
    global_feed: str = "(could not fetch feed)"

    feed_context: str = ""
    timeline_feed: str = ""
    thread_context: str = ""
    contacts_list: str = ""
    dm_context: str = ""

    engaged_ids: str = ""
    today: str = ""
    today_post_count: int = 0
    last_post: str = "(暂无发帖记录)"
    action_budget: int = 5
    backend_action_constraint: str = ""

    contacts: list[str] = Field(default_factory=list)
