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
    """One executed action's outcome.

    `conversation_id` (fix round 1, task-7 review item 4) is populated only
    for a landed `dm`: `resource_id` stays the created MESSAGE id, matching
    every other kind's "id of the thing I created" convention, so this is a
    second, dm-only field rather than overloading `resource_id` or `detail`
    (the latter is already a free-text failure/note channel matched by
    shape elsewhere -- see `act/round.py`'s `_PARENT_UNUSABLE_DETAIL`
    sentinel). It lets `act/round.py`'s memory-line writer record
    `conversationId=...` the way `swil.sh:711`'s `_remember` does, instead
    of the `messageId=` substitute this task shipped with initially.
    """

    action: Action
    landed: bool
    resource_id: str | None = None
    detail: str | None = None
    conversation_id: str | None = None


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


class AspectThresholds(BaseModel):
    """Per-aspect drift gate lower bounds -- a candidate whose similarity to
    the anchor falls STRICTLY BELOW its own threshold breaches that aspect.

    Calibrated 2026-07-03 against real distilled-card data (see
    `docs/superpowers/specs/2026-07-02-per-aspect-drift-design.md`). The
    original design hypothesis was that `values` should be guarded strictest;
    a shadow round refuted it -- keyword-distilled cards put all three
    aspects on roughly the same ~0.70 band, and `values` came out the
    *lowest* (least stable) of the three, not the highest. The thresholds
    are therefore symmetric-ish by measurement, not asymmetric by design --
    do not "fix" them back toward a values-strictest shape.
    """

    values: float = 0.63
    style: float = 0.72
    topic: float = 0.71


class AspectCards(BaseModel):
    """Three keyword cards distilled from a personality document (task 9,
    `dream/distill.py`'s `distill_cards`) -- the model-neutral ruler's raw
    output before embedding.

    Field names are `values` / `style` / `topic` -- SINGULAR `topic`, even
    though the distiller prompt's own instructions say `TOPICS` (plural). That
    mismatch is deliberate and baked into `dream.sh`'s prompt text itself
    (contract `04` §3); every consumer -- `_anchor_aspects`, the gate,
    `_aspect_breached`, `snapshot.sh`'s payload -- reads the singular key, so
    "fixing" it to `topics` here would silently break the JSON contract the
    whole per-aspect drift system depends on.
    """

    values: str
    style: str
    topic: str


class AspectVectors(BaseModel):
    """The embedded form of `AspectCards` -- one bge-m3 vector (1024-dim) per
    aspect, cached alongside the cards in `<dir>/personality.anchor.aspects.json`
    (task 9, `dream/distill.py`'s `anchor_aspects`). Compared against a
    candidate's own `AspectVectors` via `dream/drift.py`'s `cosine_sim`, one
    aspect at a time, to produce an `AspectSims`.
    """

    values: list[float]
    style: list[float]
    topic: list[float]


class DreamVerdict(BaseModel):
    accepted: bool
    reason: str
    breached: list[str] = Field(default_factory=list)
    sims: AspectSims | None = None
    attempt: int = 1


class CooldownDecision(BaseModel):
    """The outcome of `dream.check_cooldown` (task 10, `dream/candidate.py`;
    contract `03` §1.3).

    `reason` holds only the message BODY -- e.g. `"cooldown (1h < 12h, +4 new
    memories)"` or `"cooldown override: +8 new memories since last dream"` --
    never the `"SKIP $name — "` / plain log-line prefix Bash prepends
    (`dream.sh:504`/`507`); a caller logging this decision adds that prefix
    itself, the same way `render_dream_prompt`'s output is prefix-free text
    a caller writes into its own log line.

    `reason` stays `""` for every SILENT proceed path (force mode, first-ever
    dream, or an elapsed cooldown) -- Bash logs nothing for those three cases
    either (contract `03` §1.3: "cooldown elapsed → proceed silently, no log
    line").
    """

    proceed: bool
    reason: str = ""
    override: bool = False


class DreamResult(BaseModel):
    """The outcome of one `run_dream` round (`dream/round.py`, task 12).

    `proceeded` distinguishes a cooldown SKIP (`proceeded=False`, only
    `reason` populated -- `check_cooldown` never asked the LLM for anything)
    from an attempt that actually ran the dream-rewrite call (`proceeded=
    True`), matching Bash's SKIP vs FAIL/DONE split (contract `03` §1.4).
    `accepted` is the single flag that answers "did personality.md actually
    change": true only once the full archive/write/marker/memory sequence
    has run. A structural or drift rejection is `proceeded=True,
    accepted=False`, with `reason` and (for a drift-side rejection)
    `verdict` explaining why -- `verdict` stays `None` on a structural
    failure, since `evaluate_candidate` is never reached in that case
    (`evaluate_candidate` itself returns a `DreamVerdict` for both a
    structural AND a drift rejection, but a structural one is caught
    earlier by `run_dream`, before `evaluate_candidate` is even called --
    see that module's ordering note).

    `recorded_memlines` is the exact value written to
    `last_dream_memlines_<name>` -- populated only when `accepted=True`,
    and always the memory.md line count taken BEFORE the "personality
    consolidated" housekeeping line was appended (contract `03` §4 steps
    4-5; see `dream.candidate.FilesystemDreamState.record_dream`'s
    docstring for why that ordering is deliberate).

    `snapshot_ok` / `snapshot_reason` describe the LAST step (contract `03`
    §4.9): a snapshot failure never flips `accepted` back to `False` -- the
    personality write has already committed by the time the snapshot is
    attempted. `snapshot_reason` is the upload failure's own message, never
    a hardcoded guess (see `dream/round.py`'s module docstring for the
    2026-07-31 incident this preserves).
    """

    proceeded: bool
    accepted: bool = False
    reason: str = ""
    verdict: DreamVerdict | None = None
    narrative: str = ""
    recorded_memlines: int | None = None
    snapshot_ok: bool = False
    snapshot_reason: str | None = None


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


class ActResult(BaseModel):
    """The outcome of one `run_act` round (`act/round.py`, task 7).

    `plan` and `context` are included even though task-7-brief.md's own
    step-1 code sketch omitted them from this class body -- the SAME
    brief's "Produces" line, one paragraph above that sketch, lists them
    explicitly as part of what `run_act` produces, and without a `plan`
    field `dry_run` mode (design spec §9.4) would have nothing to return:
    the whole point of a shadow round is inspecting what plan and veto list
    guardrails WOULD have produced, without executing anything. Treating
    the interface summary as authoritative and the code sketch as an
    incomplete transcription of it -- recorded in task-7-report.md.
    """

    outcome: ActOutcome
    results: list[ActionResult] = Field(default_factory=list)
    vetoed: list[VetoedAction] = Field(default_factory=list)
    plan: Plan | None = None
    context: ActContext | None = None
    rhythm: RhythmDecision | None = None
    attempted: int = 0
    landed: int = 0

    @property
    def grants_dream(self) -> bool:
        """Whether this round's outcome permits a dream afterwards.

        Design spec §7.1: only a dead backend or an unreachable platform denies
        the account its dream. A rhythm-vetoed or deliberately-empty plan is the
        agent correctly choosing not to act, and Bash's rc=75 conflated all four
        -- which is how an empty plan came to cost a personality evolution.
        """
        return self.outcome not in (ActOutcome.BACKEND_UNAVAILABLE, ActOutcome.OFFLINE)
