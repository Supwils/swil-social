"""Compose the whole act path into one function (design spec §7, contract
`01` §1 + `02` §3-§5): health probe -> lock -> context -> rhythm -> plan ->
guardrails -> execute -> tally.

This is the piece that replaces `auto-run.sh`'s exit-code contract
(`return 66/75`, `rc=0`) with `ActOutcome`, a typed six-value enum. The
mapping from "what happened this round" to "does the account still get a
dream" is spelled out on `ActResult.grants_dream` (`models.py`) and is the
actual deliverable here -- see the outcome-mapping table in
`tests/unit/test_act_round.py`.

Composed as plain calls into `build_context` / `decide_rhythm` /
`plan_round` / `apply_guardrails` / `execute_action` -- every one of those
functions is independently public and independently tested (Tasks 1-6).
`run_act` adds no logic of its own beyond sequencing them, deciding which
`ActOutcome` the sequence landed on, and writing `memory.md` lines for what
executed. This matters for Plan 3: a LangGraph node can call any of those
same step functions directly as its body, and get identical behavior to
this module's non-graph orchestration, without a second copy of the act
path living in the graph layer.
"""

from __future__ import annotations

import logging
import random
import re
from collections.abc import Callable
from contextlib import AbstractContextManager, nullcontext
from datetime import datetime
from pathlib import Path
from typing import Any, Final

from swil_agent.act.context import build_context
from swil_agent.act.executor import execute_action
from swil_agent.act.guardrails import apply_guardrails
from swil_agent.act.planner import plan_round
from swil_agent.api.client import ApiError
from swil_agent.api.dto import LabEvent
from swil_agent.api.resources import Resources
from swil_agent.llm.base import Backend
from swil_agent.llm.extract import collapse_doubled_text
from swil_agent.locks import FileLock, act_lock_path
from swil_agent.models import Action, ActionResult, ActOutcome, ActResult, Persona
from swil_agent.persona.rhythm import decide_rhythm

logger = logging.getLogger(__name__)

_MEMORY_PREVIEW_CAP = 80
_WHITESPACE_RUN = re.compile(r" {2,}")

# The exact `detail` string `act/executor.py`'s `_execute_comment` sets on the
# parent-unusable-retry-succeeded path. Duplicated here (not imported) because
# it is a private literal inside that module's function body, not a name --
# see `_memory_note`'s docstring for what this sentinel is for and the test
# that would catch the two strings drifting apart.
_PARENT_UNUSABLE_DETAIL = "parent unusable — posted top-level"


def allowed_for(persona: Persona) -> list[str]:
    """The backend allow-list handed to `apply_guardrails` (contract `02`
    §1.1, design spec §6.8).

    Only `codex` is restricted, to `post`/`nothing`: its `comment` and
    `like` writes are a confirmed silent-fail path (CLAUDE.md, "Codex
    action silent-fail" / "Codex CLI... 2xx with no persisted row"), so
    until that is fixed server-side, a codex account may only post or do
    nothing. Kept as a named function rather than an inline literal so
    lifting the restriction later is a one-line change with a test to
    match, not a hunt through `run_act`'s body.
    """
    return ["post", "nothing"] if persona.backend == "codex" else []


def _memory_field(raw: str | None) -> str:
    """Whitespace-clean one field for a memory.md note, WITHOUT the
    doubled-text collapse (contract `02` §4.2, cross-cutting facts).

    Mirrors `tr -d '\\n' | sed 's/  */ /g'` then `.strip()`, exactly like
    `act/executor.py`'s private `_clean` applies to the copy of the field it
    sends to the API -- reproduced here rather than imported because the
    memory line is built from the ORIGINAL `Action` the guardrails approved,
    independently of whatever the executor already did with its own copy of
    the same field on the way to the wire.
    """
    text = (raw or "").replace("\n", "")
    return _WHITESPACE_RUN.sub(" ", text).strip()


def _memory_text(raw: str | None) -> str:
    """`_memory_field` plus the doubled-text collapse -- for the fields
    `act/executor.py`'s module docstring names as eligible for it:
    `post.text`, `comment.text`, `echo.text`, `dm.text`. NEVER `imageTopic`
    or a username (fix round 1, task-7 review item 3: an earlier version of
    this module ran `image_topic` through this same collapsing function,
    which could make the `[img:...]` memory-line tag disagree with the
    topic string actually used to fetch the image -- a byte-compatibility
    break in shared on-disk state that only fires on an exact-duplicate
    topic string >= 40 chars, which is why it went unnoticed at first.
    `_memory_field` above is the non-collapsing variant now used for
    `image_topic`. `test_memory_note_collapses_...` pins this against the
    exact shape the brief specifies; a divergence between this and
    `executor._clean` would show up as the two modules' tests disagreeing
    on the same input, not as a shared import silently drifting.
    """
    return collapse_doubled_text(_memory_field(raw))


def _memory_username(raw: str | None) -> str:
    """`tr -d '@[:space:]'` -- mirrors `act/executor.py`'s private
    `_clean_username`, for the same reason `_memory_text` mirrors `_clean`."""
    return re.sub(r"[@\s]", "", raw or "")


def _memory_note(action: Action, result: ActionResult) -> str | None:
    """The per-kind note text `swil.sh`'s `_remember()` would append
    (contract `02` §4.2), or `None` when no memory.md line should be
    written at all.

    Gated on `result.call_succeeded`, NOT on `result.landed` (ruling R19):
    every one of `_remember`'s real call sites only fires on a write that
    actually happened (contract `02` §4.1) -- `post`/`comment`/`echo`/`dm`
    gated on a non-empty server-assigned id, `like`/`follow` unconditionally
    *after* their curl call did not already abort the case under `set -e`.
    "Did not already abort" is precisely what `call_succeeded` means, and for
    every kind but one it equals `landed`.

    `follow` is that one kind, and gating on `landed` got it wrong. Bash keeps
    the two decisions on two different levels: `auto-run.sh:243-252` returns 0
    on BOTH branches ("Deliberately 0 either way: 'already following' is the
    common outcome and is not a failed round"), so a 409 still counts as
    landed -- but one level down, `swil.sh`'s own `follow` case
    (swil.sh:679-683) never reaches `_remember` on that 409, because `_curl`
    returns 1 for any status >= 400 (swil.sh:132-135) and `set -euo pipefail`
    aborts the case at the failing pipeline. So Bash writes
    `follow | @<user>` only on a genuine NEW follow, and "already following"
    -- the common outcome -- records nothing.

    This is not cosmetic: `memory.md` is the dream's input AND the unit
    `DREAM_MIN_NEW_MEMORIES=8` counts, so a spurious line per repeat-follow
    both shifts what every later dream reads and makes dreams fire earlier
    than Bash would.

    The gate here is only half the fix, and on its own it was inert (ruling
    R20). `call_succeeded` is `False` only on `_execute_follow`'s EXCEPT
    branch, and `Resources.follow` used to swallow the 409 before it could
    get there -- so the common "already following" outcome still took the
    success path and still wrote its line. That swallow is gone; the 409 now
    propagates like every other write failure, which is what makes this gate
    reachable at all. Driven end-to-end over a real 409 in
    `test_an_already_following_409_warns_and_writes_no_memory_line`, not
    through a fake whose `follow()` re-raises whatever it is handed.

    `nothing` never gets a line (contract `02` §4.1: "auto-run.sh's
    `nothing` case never calls swil.sh").
    """
    if not result.call_succeeded or action.kind == "nothing":
        return None

    if action.kind == "post":
        text = _memory_text(action.text)
        # image_topic never goes through the doubled-text collapse (fix
        # round 1, item 3) -- _memory_field, not _memory_text.
        topic = _memory_field(action.image_topic)
        img_tag = f"[img:{topic}] " if topic else ""
        return f"post | id={result.resource_id} | {img_tag}{text[:_MEMORY_PREVIEW_CAP]}"
    elif action.kind == "comment":
        text = _memory_text(action.text)
        # The retry-succeeded-top-level path (contract 02 §2.2) writes NO
        # parentId at all: swil.sh's own retry call passes no 4th argument,
        # so its `_remember` never sees one either. `result.detail` is the
        # only signal left, after the fact, that this was that path.
        parent_tag = ""
        if action.parent_id and result.detail != _PARENT_UNUSABLE_DETAIL:
            parent_tag = f" parentId={action.parent_id}"
        return (
            f"comment | postId={action.post_id} commentId={result.resource_id}"
            f"{parent_tag} | {text[:_MEMORY_PREVIEW_CAP]}"
        )
    elif action.kind == "like":
        return f"like | postId={action.post_id}"
    elif action.kind == "follow":
        return f"follow | @{_memory_username(action.username)}"
    elif action.kind == "echo":
        text = _memory_text(action.text)
        quote_tag = f" | {text[:_MEMORY_PREVIEW_CAP]}" if text else ""
        return f"echo | id={result.resource_id} echoOf={action.post_id}{quote_tag}"
    elif action.kind == "dm":
        # Byte-matches swil.sh:711's `_remember "dm | to=$RECIPIENT
        # conversationId=$CONV_ID | ${TEXT:0:80}"`. Fix round 1, item 4:
        # an earlier version of this branch substituted `messageId=` here
        # because `Resources.send_dm` used to return only the message id --
        # `send_dm` now returns `(conversation_id, message_id)` (Task 1/6
        # widened, see resources.py/executor.py) and `ActionResult` carries
        # the conversation id in its own dedicated field, so this is a real
        # byte-for-byte match now, not a documented substitute.
        text = _memory_text(action.text)
        username = _memory_username(action.username)
        return (
            f"dm | to={username} conversationId={result.conversation_id} | "
            f"{text[:_MEMORY_PREVIEW_CAP]}"
        )
    else:
        # ActionKind is a closed 7-member Literal and `nothing` is handled by
        # the early return above, so every remaining member is covered by a
        # branch above -- this is unreachable for a validly constructed
        # Action, exactly like the equivalent branch in
        # act/executor.py:execute_action.
        raise AssertionError(  # pragma: no cover
            f"unhandled action kind for memory note: {action.kind!r}"
        )


# `_remember`'s own whitelist (swil.sh:196). A note whose leading verb is not
# one of these emits `action=""` -- which `LabEvent.to_wire` then OMITS from
# the body entirely, so `/lab` records the event with no action facet rather
# than with a made-up one. `echo` and `dm` are deliberately ABSENT: Bash's
# whitelist does not contain them either, so their memory events carry no
# action. Transcribed verbatim; do not "complete" it.
_MEMORY_EVENT_ACTIONS: Final = frozenset(
    {"post", "comment", "like", "follow", "unfollow", "delete", "nothing"}
)

# `grep -Eo '(id|postId|commentId)=[a-f0-9]{24}' | head -1 | cut -d= -f2`
# (swil.sh:194). Case-sensitive and unanchored, exactly as `grep -E` is: the
# `conversationId=` in a `dm` note does NOT match (`Id` != `id`), so a dm's
# memory event carries no targetId -- checked against the real note shapes,
# not assumed.
_MEMORY_TARGET_RE: Final = re.compile(r"(?:id|postId|commentId)=([a-f0-9]{24})")


def _flatten_note(note: str) -> str:
    r"""`_remember`'s own normalisation of its argument (swil.sh:189-190):
    `tr '\n' ' '` then `sed 's/[[:space:]]\+/ /g; s/^ //; s/ $//'`.

    A RAW docstring on purpose: both of those are shell escapes, and in a
    normal docstring `\n` becomes a real newline and `\+` raises a
    SyntaxWarning -- i.e. the transcription stops being a transcription.

    Applied ONCE, to the value that feeds both the memory.md line and the
    lab event's `summary`, because Bash derives both from the same `$note`
    variable. Every component `_memory_note` assembles is already cleaned by
    `_memory_text`, so in practice this is a no-op today -- it exists so the
    two consumers cannot drift apart if a future note shape is not.
    """
    return re.sub(r"\s+", " ", note.replace("\n", " ")).strip(" ")


def _memory_event(note: str) -> LabEvent:
    """The SECOND lab event `_remember` fires for every memory line
    (swil.sh:192-202), independent of the `cycle/act/*` event
    `act/executor.py` already emits per action.

    So one successful `post` produces TWO POSTs to
    `/agents/{username}/events` -- `cycle/act/success` from `auto-run.sh`'s
    `emit_lab_event`, and `memory/memory/success` from `swil.sh`'s
    `_remember`. Python emitted only the first, for every write action kind,
    which halved what `/lab`'s memory surfaces saw. Captured in contract
    `02` §372 and then lost between the contract and the plan: no task
    covered it, no ruling decided it, no §15 row recorded it (ruling R21).

    Field placement is `_lab_event`'s positional signature (swil.sh:206):
    `type, phase, outcome, action, summary, reason, target_id, metrics`.
    `_remember` passes `""` for `reason` and `"{}"` for `metrics`, and the
    summary is the WHOLE flattened note -- uncapped, unlike the act events'
    200-char cap.

    (An earlier version of this docstring warned that `auto-run.sh`'s
    `emit_lab_event` wrapper used a DIFFERENT positional order. It does not:
    `swil.sh:667-676` forwards `TYPE PHASE OUTCOME ACTION SUMMARY REASON
    TARGET_ID METRICS` straight through in that same order. The warning was
    fictional and is removed rather than left as a trap for the next reader.)
    """
    verb = note.split("|", 1)[0].strip()
    match = _MEMORY_TARGET_RE.search(note)
    return LabEvent(
        type="memory",
        phase="memory",
        outcome="success",
        action=verb if verb in _MEMORY_EVENT_ACTIONS else None,
        summary=note,
        reason=None,
        target_id=match.group(1) if match else None,
    )


def _write_memory_line(
    directory: Path,
    action: Action,
    result: ActionResult,
    *,
    now: datetime,
    resources: Resources,
    username: str,
) -> None:
    """Append one line to `<directory>/memory.md` AND fire the
    `memory/memory/success` lab event, matching `_remember()`
    (swil.sh:184-203) in both halves and in that ORDER.

    The on-disk line is byte-for-byte `_remember`'s (contract `02` §4.2):
    `<YYYY-MM-DD> | <note>`. `directory` is `persona.directory` -- the same
    folder `resolve_agent_dir` returns and Bash calls `agent_dir` -- so this
    reads and writes the identical file a live Bash round would.

    ORDER IS THE CONTRACT: the file append (swil.sh:190) happens BEFORE the
    event (swil.sh:197/200), so an events outage still leaves the memory
    line on disk -- and memory.md, not `/lab`, is what the next dream reads.
    The event itself cannot fail the round in either runtime: Bash ends
    `_lab_event`'s curl with `|| true` (swil.sh:246) and
    `Resources.lab_event` documents the same guarantee ("this never
    raises"). No extra try/except is added here on purpose -- one would
    imply this module distrusts that contract, and would also hide a fake
    that breaks it.

    Real file I/O, performed directly rather than behind an injected seam:
    `FileLock` (Task 2) already established this module family's precedent
    of touching the filesystem for Bash-compatible on-disk state, and
    `memory.md` is exactly that. `username` is the `Username` bullet (whom
    the event is filed under), NOT the directory name -- the same
    distinction `execute_action` already draws.
    """
    note = _memory_note(action, result)
    if note is None:
        return
    note = _flatten_note(note)
    line = f"{now.strftime('%Y-%m-%d')} | {note}\n"
    with (directory / "memory.md").open("a", encoding="utf-8") as handle:
        handle.write(line)
    resources.lab_event(username, _memory_event(note))


_BACKEND_SYNC_ERROR_CAP: Final = 160


def _agent_backend_value(persona: Persona) -> str:
    """`"${ai_backend}${ai_model:+:$ai_model}"` (`auto-run.sh:492`) --
    `<backend>` alone when the persona declares no `Model:` bullet,
    `<backend>:<model>` when it does.

    `${ai_model:+...}` expands only for a NON-EMPTY model, so an empty
    string suffixes nothing and never produces a trailing colon; `Persona
    .model` is `None` (not `""`) in that case, hence the truthiness test.
    Bash also has an `ai_backend="${ai_backend:-claude}"` default;
    `Persona.backend` already defaults to `"claude"` in `models.py`.
    """
    return f"{persona.backend}:{persona.model}" if persona.model else persona.backend


def _sync_agent_backend(resources: Resources, persona: Persona, agent_name: str) -> None:
    """PATCH the account profile with `{"agentBackend": ...}` every act round
    (`auto-run.sh:473-494`).

    `agentBackend` is the drift experiment's INDEPENDENT VARIABLE, so a
    runtime that stops refreshing it lets the field go stale for the whole
    roster mid-experiment. `Resources.update_profile` existed for exactly
    this call and had no callers.

    Non-fatal by design, and LOGGED rather than swallowed: Bash's own
    comment records that a bare `|| true` with stderr to /dev/null is what
    hid a 403 on every `humans/` round for months (2026-08-05). The WARN
    line and its 160-char truncation are Bash's
    (`WARN $agent_name — agentBackend sync failed: ${backend_sync_err:0:160}`).

    Runs for `humans/` accounts too. `agentBackend` IS recorded for them --
    it is only withheld from the PUBLIC DTOs, which is a server concern
    (`publicAgentBackend` in `server/src/lib/dto.ts`); skipping the sync
    here would silently drop 8 of 23 accounts from the experiment.
    """
    try:
        resources.update_profile({"agentBackend": _agent_backend_value(persona)})
    except ApiError as exc:
        logger.warning(
            "WARN %s — agentBackend sync failed: %s",
            agent_name,
            str(exc)[:_BACKEND_SYNC_ERROR_CAP],
        )


_MARK_READ_NOTIFICATION_LIMIT: Final = 20
_RESPONSE_NOTIFICATION_TYPES: Final = frozenset({"mention", "comment", "reply"})


def _comment_targets(actions: list[Action]) -> list[tuple[str, str]]:
    """`auto-run.sh:782-783`'s `comment_targets` jq, as `(post_id, parent_id)`
    pairs -- one per `comment` action in the (post-guardrail) plan, with
    `.postId // ""` / `.parentId // ""` becoming `""` for an absent field.

    Plan-aware on purpose: a round may contain several comments and Bash
    collects every one of them, marking the whole set in a single call.
    """
    return [
        ((action.post_id or ""), (action.parent_id or ""))
        for action in actions
        if action.kind == "comment"
    ]


def _responded_notification_ids(
    notifications: list[dict[str, Any]], targets: list[tuple[str, str]]
) -> list[str]:
    """`auto-run.sh:785-798`'s selection jq, matched clause for clause.

    A notification is selected when ANY target matches it:

      * the target has a `parentId` (this comment was a REPLY) -- match only
        the notification whose own `comment.id` IS that parent. Nothing else.
      * the target has no `parentId` (a TOP-LEVEL comment) -- match
        notifications on that `post.id` whose `type` is one of
        mention/comment/reply.

    The asymmetry is Bash's own, and the comment above it says why: matching
    on any notification sharing a `postId` would clear "someone commented on
    X" merely because the agent liked something else involving X, losing
    that context for the NEXT round. `like`/`follow`/`echo`/`dm` contribute
    no targets at all and so can never clear anything.

    jq's `null.id` is `null` rather than an error, so a notification with no
    `comment`/`post` object simply fails to match; the `isinstance` guards
    here reproduce that rather than raising.
    """
    selected: list[str] = []
    for item in notifications:
        notif_id = item.get("id")
        if not isinstance(notif_id, str) or not notif_id:
            continue
        comment = item.get("comment")
        comment_id = comment.get("id") if isinstance(comment, dict) else None
        post = item.get("post")
        post_id = post.get("id") if isinstance(post, dict) else None
        notif_type = item.get("type")
        for target_post_id, target_parent_id in targets:
            if target_parent_id:
                matched = comment_id == target_parent_id
            else:
                matched = post_id == target_post_id and notif_type in _RESPONSE_NOTIFICATION_TYPES
            if matched:
                selected.append(notif_id)
                break
    return selected


def _mark_notifications_read(resources: Resources, actions: list[Action]) -> None:
    """Bash's "smart mark-read" block (`auto-run.sh:768-803`), ported whole.

    Without it the same notifications come back unread every round and the
    agent posts duplicate replies to the same comment -- user-visible on the
    live site, which is why this is not deferrable observability polish.

    Two mutually exclusive branches, in Bash's own order:

      1. a plan that is ONLY `nothing` -> mark EVERYTHING read, so an idle
         agent is not stuck rereading the same 8 items forever. Bash's test
         is `[.[].action] | unique | join(",") == "nothing"`, i.e. EVERY
         action is `nothing` -- not "exactly one action, and it is nothing".
      2. otherwise, if the plan contains any `comment` -> re-read the 20 most
         recent unread notifications and mark only those the agent
         semantically responded to.

    A plan with no comments and no `nothing` (e.g. a lone `like`) marks
    NOTHING -- there is no third branch in Bash and there is none here.

    Fire-and-forget in both directions, matching Bash's `2>/dev/null ||
    echo '[]'` around the read and `|| true` around the write: a failed
    notifications read degrades to "mark nothing this round", and the write
    itself never raises (`Resources.mark_notifications_read`). This runs
    after the actions have already landed; nothing it does may turn a
    successful round into a failed one.
    """
    if actions and all(action.kind == "nothing" for action in actions):
        resources.mark_notifications_read()
        return

    targets = _comment_targets(actions)
    if not targets:
        return
    try:
        notifications = resources.notifications(limit=_MARK_READ_NOTIFICATION_LIMIT)
    except ApiError:
        return
    resources.mark_notifications_read(_responded_notification_ids(notifications, targets))


def run_act(
    *,
    persona: Persona,
    resources: Resources,
    backend: Backend,
    memory_text: str,
    agent_root: Path,
    now: datetime,
    rng: random.Random,
    health_check: Callable[[], bool],
    budget: int = 5,
    context_now: str = "(no context file)",
    feed_context: str = "",
    dry_run: bool = False,
    access_key: str | None = None,
) -> ActResult:
    """One act round: context -> rhythm -> plan -> guardrails -> execute.

    Sequence (contract `01` §1, `02` §3-§5):

      1. Probe `health_check()` first, before anything else -- Bash's
         `check_internet` runs once in Main, before any per-account work,
         and a failure there means no round is even attempted for anyone.
         Injected rather than performed here: this module owns no HTTP
         mechanics for the raw (non-`/api/v1`-prefixed) `${SWIL_URL}/health`
         endpoint -- see the run_act docstring's "known decisions" note
         below and task-7-report.md for why. A failure yields
         `ActOutcome.OFFLINE` with nothing else populated.
      2. Acquire `FileLock(act_lock_path(agent_root, persona.directory.name))`.
         Ruling R6 (task-7-brief.md): a held lock raises `LockBusy` OUT of
         this function -- it is not folded into any `ActOutcome`, because
         "there was no round at all" is a different question from "what did
         this round decide", and `ActOutcome` only ever answers the second
         one. The caller (a later task's CLI) catches `LockBusy` and treats
         it as a SKIP.
      3. `build_context` -- read-side prompt assembly, degrading per-block.
      4. `decide_rhythm` -- the day's post-budget/probability gate.
      5. `plan_round` -- ask the backend. `None` means the backend produced
         nothing at all -> `ActOutcome.BACKEND_UNAVAILABLE`.
      6. `apply_guardrails` -- backend allow-list, rhythm veto, dm contacts,
         one-post/one-echo + dedupe, budget cap.
      7. An EMPTY action list after guardrails is `VETOED_EMPTY` when
         `guarded.vetoed` is non-empty (guardrails actually dropped
         something) and `PLANNER_EMPTY` when it is not (the model proposed
         nothing to begin with). Bash logs both as `planned: nothing`,
         indistinguishable -- design spec §7.5, and the proximate cause of
         three codex accounts landing in an uninterpretable state on
         2026-08-16. Nothing is executed either way; this classification
         does not depend on `dry_run`, since there is nothing to execute
         regardless.
      8. A SURVIVING plan whose only action is `nothing` is also
         `PLANNER_EMPTY` -- the model explicitly chose to be quiet, the same
         category as "proposed nothing", just via a different route through
         guardrails (a lone `nothing` is never dropped by stage 2, which
         only strips `nothing` when mixed with other actions). It is still
         executed (so its lab event and log line fire, matching Bash), but
         the outcome label is `PLANNER_EMPTY`, not the landed/attempted
         formula's `LANDED_ALL`.
      9. `dry_run` stops here, before any execution: it returns `plan` and
         `guarded.vetoed` with `results`/`attempted`/`landed` at their zero
         defaults. This is the shadow-round mode (design spec §9.4) the
         cutover depends on being genuinely inert -- no API writes, no
         memory.md lines, no lab events. For a plan that survives guardrails
         with real (non-`nothing`) actions, dry_run cannot know whether they
         would have landed without executing them, so the outcome is
         `ActOutcome.LANDED_ALL` -- a label, not a prediction: `results == []`
         and `attempted == 0` are the fields a caller must check to know
         nothing actually ran; see `test_dry_run_never_calls_the_api_or_writes_memory`.
      10. Otherwise, execute every surviving action in order via
          `execute_action`, tally `landed`/`attempted`, and append a
          memory.md line per landed action (`nothing` never gets one).
      11. `landed == attempted` (with `attempted > 0`) -> `LANDED_ALL`.
          Otherwise -> `LANDED_PARTIAL`, INCLUDING when `landed == 0`.

          Ruling (task-7-brief.md): Bash treats "every planned action
          failed" as rc=75 and skips the dream, reasoning that dreaming on
          unrefreshed memory manufactures drift that never happened
          (contract `02` §3.2). Design spec §7.1 is explicit that only
          `BACKEND_UNAVAILABLE` and `OFFLINE` deny the dream, so this
          function follows the spec: `landed == 0` is recorded on the
          result (`ActResult.landed == 0`, `ActResult.grants_dream is
          True`) and logged at WARNING ("FAIL") level with BASH'S ORIGINAL
          WORDING, so an operator grepping `auto-run.log`'s Python
          equivalent sees the same line even though the underlying decision
          -- whether the dream proceeds -- has changed. That increase in
          dream attempts is a deliberate correction; it must be recorded as
          a change point in the drift series, not silently absorbed.

    Two things this function decides that the brief left open, recorded here
    and in task-7-report.md:

      * `health_check: Callable[[], bool]` is a required, injected
        parameter, not a Settings-driven default. No Python code anywhere in
        this package yet performs a raw (unprefixed) HTTP GET to
        `${SWIL_URL}/health` -- `ApiClient` always prefixes `/api/v1`, and
        adding that mechanics here would mix an HTTP concern into a function
        whose job is sequencing. The CLI (a later task) supplies the real
        probe; tests supply a fixed callable.
      * The lock/agent-name Bash calls `agent_name` is `basename "$agent_dir"`
        (`auto-run.sh:437`), NOT the persona's `Username` bullet -- the two
        usually match but are not the same field (see CLAUDE.md's "Stray
        agents/<name> dir shadows a humans/ account" note for a case where
        they diverge). This function uses `persona.directory.name`
        throughout -- for the lock path, as `execute_action`'s `agent_name`,
        AND as the identifier in the `landed == 0` FAIL log line (fix round
        1, item 2: an earlier version of that one log call passed
        `persona.username` instead, inconsistent with every other use of
        `agent_name` in this function).
      * `board_id` is resolved HERE, once per round, from `persona.board`
        via `Resources.get_boards()` -- not injected as a parameter (fix
        round 1, item 5). Unlike `health_check`, which needed injection
        because nothing else in this package performs that raw unprefixed
        HTTP GET, board lookup is a plain `Resources` read this function
        already has everything it needs to make: `get_boards()` already
        exists (Task 1) and `Persona.board` is already populated (persona
        loader). Bash re-resolves on every `post` call (`swil.sh:426-432`),
        but guardrails cap a round at one post, so resolving once per round,
        after the empty-plan/dry_run early returns (i.e. only when there is
        something left to execute), is behaviourally equivalent and cheaper.
        Guarded on `persona.board` being truthy, exactly like Bash's own
        `if [[ -n "$POST_BOARD" ]]`, so a persona with no `Board:` bullet
        never pays the network call. A failed lookup (`ApiError`) degrades
        to `None` -- an unfiled post -- matching Bash's own "degrades to an
        unfiled post if the endpoint is unavailable, never blocks" comment.
      * `access_key: str | None = None` (fix round 1, item 6) is a plain
        `run_act` parameter, NOT resolved internally from `Settings`. Unlike
        board resolution above (a plain `Resources` read, of the same kind
        this function already performs several of), an Unsplash access key
        is a credential, and credentials come from the composition root --
        consistent with how
        auth is already handled elsewhere in this package (`ApiClient`
        takes a pre-built `AuthStrategy`, not a settings object it resolves
        one from itself). Threaded straight into `execute_action`'s own
        `access_key` parameter as `access_key or ""`, matching that
        function's existing default.
    """
    if not health_check():
        return ActResult(outcome=ActOutcome.OFFLINE)

    agent_name = persona.directory.name
    # F4: a dry run acquires NOTHING. `dry_run` executes no action, writes no
    # memory line and PATCHes no profile, so it needs no mutual exclusion --
    # and taking the lock made the documented "safe inspection command"
    # actively unsafe: a dry run launched while a real Bash round held the
    # lock cost that account its whole round (`auto-run.sh`'s own
    # `acquire_lock` failure path returns 75 and the account is skipped).
    # `nullcontext` rather than a second "shared" lock mode: there is no
    # resource to share access TO.
    lock: AbstractContextManager[object] = (
        nullcontext() if dry_run else FileLock(act_lock_path(agent_root, agent_name))
    )
    with lock:
        # F8: `agentBackend` profile sync -- `auto-run.sh:473-494`, in Bash's
        # own position in the sequence (after login, before any context is
        # built), not deferred to the end of the round. Skipped on `dry_run`
        # for the same reason the lock is: this is a WRITE.
        if not dry_run:
            _sync_agent_backend(resources, persona, agent_name)

        ctx = build_context(
            resources,
            persona,
            memory_text=memory_text,
            now=now,
            budget=budget,
            context_now=context_now,
            feed_context=feed_context,
        )
        rhythm = decide_rhythm(persona.rhythm_text, ctx.today_post_count, rng)

        plan = plan_round(backend, persona, ctx, rhythm_guidance=rhythm.guidance)
        if plan is None:
            return ActResult(outcome=ActOutcome.BACKEND_UNAVAILABLE, rhythm=rhythm, context=ctx)

        guarded = apply_guardrails(
            plan,
            policy=rhythm.policy,
            budget=budget,
            contacts=ctx.contacts,
            allowed=allowed_for(persona),
        )

        if not guarded.actions:
            outcome = ActOutcome.VETOED_EMPTY if guarded.vetoed else ActOutcome.PLANNER_EMPTY
            return ActResult(
                outcome=outcome,
                vetoed=guarded.vetoed,
                rhythm=rhythm,
                plan=plan,
                context=ctx,
            )

        is_solo_nothing = len(guarded.actions) == 1 and guarded.actions[0].kind == "nothing"

        if dry_run:
            outcome = ActOutcome.PLANNER_EMPTY if is_solo_nothing else ActOutcome.LANDED_ALL
            return ActResult(
                outcome=outcome,
                vetoed=guarded.vetoed,
                rhythm=rhythm,
                plan=plan,
                context=ctx,
            )

        # Board resolution (fix round 1, item 5): once per round, only when
        # there is something left to execute (guardrails already confirmed
        # that above) and only when the persona declares a Board bullet at
        # all -- see the docstring's "known decisions" section.
        board_id: str | None = None
        if persona.board:
            try:
                board_id = resources.get_boards().get(persona.board)
            except ApiError:
                board_id = None  # degrades to an unfiled post, matching swil.sh

        results: list[ActionResult] = []
        landed = 0
        for action in guarded.actions:
            result = execute_action(
                resources,
                action,
                agent_name=agent_name,
                username=persona.username,
                access_key=access_key or "",
                board_id=board_id,
            )
            results.append(result)
            if result.landed:
                landed += 1
            _write_memory_line(
                persona.directory,
                action,
                result,
                now=now,
                resources=resources,
                username=persona.username,
            )

        attempted = len(guarded.actions)
        if landed > 0:
            # F3: Bash's smart mark-read (`auto-run.sh:768-803`) sits AFTER
            # the `landed == 0` early return (`auto-run.sh:762-765`), so a
            # round where nothing landed marks nothing -- those
            # notifications must survive to the next round. `landed > 0`
            # reproduces that placement without an early return of our own,
            # since this function still has an `ActOutcome` to decide.
            _mark_notifications_read(resources, guarded.actions)

        if is_solo_nothing:
            outcome = ActOutcome.PLANNER_EMPTY
        elif landed == 0:
            # `agent_name` here (fix round 1, item 2), matching Bash's own
            # `$agent_name` in this exact log line (auto-run.sh:763) --
            # NOT `persona.username`, which an earlier version of this line
            # used inconsistently with every other identifier in this
            # function.
            logger.warning(
                "FAIL %s — all %d planned actions failed; dream will be skipped",
                agent_name,
                attempted,
            )
            outcome = ActOutcome.LANDED_PARTIAL
        elif landed == attempted:
            outcome = ActOutcome.LANDED_ALL
        else:
            outcome = ActOutcome.LANDED_PARTIAL

        return ActResult(
            outcome=outcome,
            results=results,
            vetoed=guarded.vetoed,
            rhythm=rhythm,
            plan=plan,
            context=ctx,
            attempted=attempted,
            landed=landed,
        )
