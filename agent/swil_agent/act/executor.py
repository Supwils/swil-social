"""Execute one approved action and verify it actually landed.

Ports `execute_action` (contract `02` §2, source `auto-run.sh:156-310`) plus
the `_lab_event`/`emit_lab_event` call sites for the `cycle`/`act` events it
fires (contract `02` §5.3). `swil.sh` is the second half of the round: it is
what auto-run.sh actually shells out to for every write, and where it and the
contract doc disagree this module follows the script (see the per-kind
docstrings below for the two places that happened).

**Write verification is the whole point of this module** (design spec §7.2).
Bash decided success from an exit code alone and never parsed the response —
that is exactly how codex's `comment` and `like` came to log `DONE` while
persisting nothing (`likes.controller.ts`/`comments.controller.ts` 2xx, no
row). Every `Resources` write method already raises `WriteNotVerifiedError`
on a 2xx with no provable created/changed state (Task 1); this module's job
is to never swallow that into a false "landed". A caught `ApiError` or
`WriteNotVerifiedError` always yields `landed=False` and a `detail` string
that preserves the response body — `2>/dev/null` is why `"Invalid id"`
errors are invisible in today's `auto-run.log` (spec §7.6); `ApiError`'s own
`__str__` already carries `status` and `body[:300]` (`api/client.py`), so
reusing it unmodified is the fix, not a new formatter.

Two Bash rules are preserved deliberately, not just left as historical
trivia:

  * **`follow` always counts as landed**, regardless of the HTTP outcome
    (contract `02` §2.4) — `auto-run.sh:250-252` returns 0 on both branches
    ("Deliberately 0 either way: 'already following' is the common outcome
    and is not a failed round"). This is the one action kind whose REAL
    failure is invisible in a round's `landed/attempted` tally: a genuinely
    broken follow path looks identical to a healthy one here.

    An earlier version of this paragraph added that `Resources.follow`
    "already absorbs a 409 `CONFLICT` as a no-op success". **That is no
    longer true and its removal is the point** (ruling R20): the swallow was
    itself the defect. It sent the common "already following" case down the
    SUCCESS branch — a `DONE` log line, a `success` lab event, and a
    `memory.md` line — where Bash emits `WARN`, a `warn` event, and no
    memory line at all, because `swil.sh` runs under `set -euo pipefail` and
    `_curl` returns 1 for any status >= 400 (swil.sh:132-135). Every non-2xx
    now reaches the `except` branch below. Spelled out rather than deleted
    because this sentence, left standing as context for three review rounds,
    is what made the defect read as intentional.
  * **This module's own DM lab event never carries the message body**
    (contract `02` §2.6) — the `cycle/act/success` event it files sends only
    `"→@{username}"`.

    **That is NOT the same as "DM bodies stay out of the observation
    layer", and an earlier version of this paragraph said exactly that.**
    A second, independent event exists: `act/round.py`'s `_write_memory_line`
    fires `memory/memory/success` for every memory line, porting
    `swil.sh`'s `_remember` (swil.sh:184-203), and its `summary` is the
    WHOLE note — which for a dm is `dm | to=<user> conversationId=<id> |
    <first 80 chars of the body>` (swil.sh:711). So the first 80 characters
    of a DM body DO reach `POST /agents/{username}/events`, in this runtime
    and in Bash alike.

    Bash carries the same wrong claim in its own comment at
    `swil.sh:708-710` ("carries the recipient but never the body — private
    conversations stay off the observation layer by design"). It is true of
    `auto-run.sh`'s event and false of `_remember`'s, three lines below it.
    `agent/scripts/` is frozen, so that comment stays as it is — noted here
    so nobody "corrects" this Python comment back to match a Bash comment
    that is itself wrong.

    The behaviour is deliberate parity, not a leak introduced by the port:
    both runtimes send the same two events with the same bodies. Whether the
    80-char preview SHOULD be in the events table is a product question for
    whoever owns `/lab`, not something this port may quietly change.

`collapse_doubled_text` (contract `02`, "cross-cutting facts") applies to
`post.text`, `comment.text`, `echo.text`, and `dm.text` — never to
`imageTopic`, never to usernames.
"""

from __future__ import annotations

import logging
import re
from typing import Protocol

import httpx
from pydantic import BaseModel

from swil_agent.api.client import ApiError
from swil_agent.api.dto import LabEvent
from swil_agent.api.images import ImageFetchError, fetch_unsplash_image
from swil_agent.api.resources import Resources, WriteNotVerifiedError
from swil_agent.llm.extract import collapse_doubled_text
from swil_agent.models import Action, ActionResult

logger = logging.getLogger(__name__)

_SUMMARY_CAP = 200
_LOG_PREVIEW_CAP = 60
_QUOTE_PREVIEW_CAP = 40
_LAB_TYPE = "cycle"
_LAB_PHASE = "act"

# The two exception types a write can raise that must both be treated as
# "did not land" — a transport/HTTP failure (`ApiError`, which
# `TransportError` also is-a) and a 2xx response with no provable created
# state (`WriteNotVerifiedError`). Named once so every `except` clause below
# stays in lockstep; the write-verification test would catch either half
# drifting out of sync with the other.
_WriteFailure = (ApiError, WriteNotVerifiedError)


class ImageFetcher(Protocol):
    """Structurally matches `fetch_unsplash_image`'s real signature
    (`api/images.py`), not the brief's guessed one — the brief assumed a
    single-argument `topic -> (filename, bytes)` callable, but the actual
    function additionally requires `access_key` (Unsplash's `Client-ID`
    credential; an empty string routes straight to the Picsum fallback, see
    `images.py`'s `_fetch_unsplash`) and accepts an optional `transport` for
    test injection. A `Protocol` shaped to the guessed signature would
    reject `fetch_unsplash_image` itself as the default value under
    `mypy --strict`.
    """

    def __call__(
        self,
        topic: str,
        access_key: str,
        transport: httpx.BaseTransport | None = None,
    ) -> tuple[str, bytes]: ...


class ExecutionOutcome(BaseModel):
    """Everything one executed action produces: the `ActionResult` a round
    tally cares about, the `auto-run.log`-shaped line a caller may want to
    print (contract `02` §5.2), and the exact `LabEvent` this module already
    emits via `Resources.lab_event` (contract `02` §5.3) — exposed here too
    so a future caller (a round-level orchestrator) can reconstruct or
    re-log the same line without recomputing it from `ActionResult` alone.
    """

    result: ActionResult
    log_line: str
    lab_event: LabEvent


def _clean(raw: str | None) -> str:
    """Newlines deleted (not replaced — `tr -d '\\n'`, not `tr '\\n' ' '`),
    runs of spaces collapsed to one, then trimmed.

    The trailing `.strip()` is a deliberate departure from a literal replay
    of `auto-run.sh`'s `tr -d '\\n' | sed 's/  */ /g'`: that pipeline never
    strips a single leading/trailing space, so bash's own "empty text" skip
    (`[[ -z "$text" ]]`) does NOT fire on a whitespace-only string like
    `"   "` — collapsed to a single residual `" "`, which is non-empty by
    bash's own test, so bash would actually make the network call and let
    the server 400 on it. This task's own brief pins `Action(kind="post",
    text="   ")` as a local SKIP with no `Resources` call at all
    (`resources.calls == []`), which only `.strip()`-based emptiness can
    satisfy. Treating "SKIP without ever hitting the network" as the
    intended behavior on whitespace-only text.
    """
    text = (raw or "").replace("\n", "")
    text = re.sub(r" {2,}", " ", text)
    return text.strip()


def _clean_username(raw: str | None) -> str:
    """`tr -d '@[:space:]'` (auto-run.sh follow/dm cases): every `@` and
    every whitespace character removed, anywhere in the string — not just
    a leading `@` or surrounding trim.
    """
    return re.sub(r"[@\s]", "", raw or "")


def _error_detail(exc: ApiError | WriteNotVerifiedError) -> str:
    """The response body, preserved into the log (design spec §7.6).

    `ApiError.__str__` already renders `"HTTP {status}: {body[:300]}"`
    (`api/client.py`) — including `TransportError`, an `ApiError` subclass
    for the "never got a response at all" case — so returning it unmodified
    already fixes the `2>/dev/null` blind spot. `WriteNotVerifiedError` gets
    an explicit "not verified" prefix so a 2xx-with-no-id failure reads as a
    distinct failure class from a genuine 4xx/5xx wherever `detail` surfaces
    (log line, `/lab`, a human skimming `auto-run.log`'s Python equivalent).
    """
    if isinstance(exc, WriteNotVerifiedError):
        return f"write not verified: {exc}"
    return str(exc)


def _outcome(
    action: Action,
    *,
    landed: bool,
    resource_id: str | None,
    detail: str | None,
    log_line: str,
    lab_outcome: str,
    lab_summary: str,
    lab_reason: str | None = None,
    lab_target_id: str | None = None,
    conversation_id: str | None = None,
    call_succeeded: bool | None = None,
) -> ExecutionOutcome:
    # `call_succeeded` DERIVES from `landed` unless a branch says otherwise,
    # so the two cannot drift apart by accident: the only caller that passes
    # it explicitly is `_execute_follow`'s failure branch, the single place
    # Bash itself distinguishes them (ruling R19; see `ActionResult`).
    result = ActionResult(
        action=action,
        landed=landed,
        resource_id=resource_id,
        detail=detail,
        conversation_id=conversation_id,
        call_succeeded=landed if call_succeeded is None else call_succeeded,
    )
    event = LabEvent(
        type=_LAB_TYPE,
        phase=_LAB_PHASE,
        outcome=lab_outcome,
        action=action.kind,
        summary=lab_summary,
        reason=lab_reason,
        target_id=lab_target_id,
    )
    return ExecutionOutcome(result=result, log_line=log_line, lab_event=event)


def _skip(
    action: Action, *, agent_name: str, field_detail: str, lab_summary: str
) -> ExecutionOutcome:
    """Every per-kind field-validation skip (contract `02` §2, "the SKIP is
    per-action rather than for the whole plan" — §1.4). No `Resources` call
    is ever reached on this path; `resources.calls == []` is the test
    assertion that carries that weight.
    """
    return _outcome(
        action,
        landed=False,
        resource_id=None,
        detail=f"{action.kind} — {field_detail}",
        log_line=f"SKIP {agent_name} {action.kind} — {field_detail}",
        lab_outcome="skip",
        lab_summary=lab_summary,
    )


def _execute_post(
    resources: Resources,
    action: Action,
    *,
    agent_name: str,
    images: ImageFetcher,
    access_key: str,
    board_id: str | None,
) -> ExecutionOutcome:
    text = _clean(action.text)
    if not text:
        return _skip(
            action,
            agent_name=agent_name,
            field_detail="empty text",
            lab_summary="post skipped: empty text",
        )
    text = collapse_doubled_text(text)

    # imageTopic gets the same whitespace cleanup as text but NEVER
    # collapse_doubled_text — contract 02's cross-cutting facts, pinned by
    # test_image_topic_is_not_collapsed.
    image_topic = _clean(action.image_topic)
    image: tuple[str, bytes] | None = None
    image_detail: str | None = None
    if image_topic:
        try:
            image = images(image_topic, access_key)
        except ImageFetchError as exc:
            # Bash degrades silently here (empty IMGFILE -> the non-multipart
            # branch, no error surfaced) -- contract 02 §2.1. This module
            # keeps the degrade-to-text-only behavior but says so in detail,
            # instead of staying silent about it.
            image_detail = f"image fetch failed, posted text-only: {exc}"

    try:
        post_id = resources.create_post(text, board_id=board_id, image=image)
    except _WriteFailure as exc:
        return _outcome(
            action,
            landed=False,
            resource_id=None,
            detail=_error_detail(exc),
            log_line=f"WARN {agent_name} post failed",
            lab_outcome="warn",
            lab_summary="post request failed",
        )

    img_tag = f" [img:{image_topic}]" if image_topic else ""
    return _outcome(
        action,
        landed=True,
        resource_id=post_id,
        detail=image_detail,
        log_line=f"DONE {agent_name} posted{img_tag}: {text[:_LOG_PREVIEW_CAP]}…",
        lab_outcome="success",
        lab_summary=text[:_SUMMARY_CAP],
    )


def _execute_comment(resources: Resources, action: Action, *, agent_name: str) -> ExecutionOutcome:
    post_id = (action.post_id or "").strip()
    text = collapse_doubled_text(_clean(action.text))
    if not post_id or not text:
        return _skip(
            action,
            agent_name=agent_name,
            field_detail="missing postId or text",
            lab_summary="comment skipped: missing postId or text",
        )
    parent_id = (action.parent_id or "").strip() or None

    try:
        comment_id = resources.create_comment(post_id, text, parent_id)
    except _WriteFailure as exc:
        primary_error = exc
    else:
        reply_tag = f" (reply to {parent_id})" if parent_id else ""
        return _outcome(
            action,
            landed=True,
            resource_id=comment_id,
            detail=None,
            log_line=f"DONE {agent_name} commented on {post_id}{reply_tag}",
            lab_outcome="success",
            lab_summary=text[:_SUMMARY_CAP],
            lab_target_id=post_id,
        )

    # Parent-ID fallback (contract 02 §2.2, spec §6.6): a reply is scoped to
    # its post server-side, so a mismatched (postId, parentId) pair 404s
    # "Parent comment not found" -- the model reads parentId out of the
    # notification list and postId out of the feed, so a stale pairing is a
    # routine miss, not a malformed decision, and the failed call created
    # nothing. Retry ONLY fires when parent_id was actually set: a plain
    # top-level comment failure has nothing left to fall back to.
    if parent_id:
        try:
            comment_id = resources.create_comment(post_id, text, None)
        except _WriteFailure as retry_error:
            return _outcome(
                action,
                landed=False,
                resource_id=None,
                detail=_error_detail(retry_error),
                log_line=f"WARN {agent_name} comment failed",
                lab_outcome="warn",
                lab_summary="comment request failed",
                lab_target_id=post_id,
            )
        return _outcome(
            action,
            landed=True,
            resource_id=comment_id,
            detail="parent unusable — posted top-level",
            log_line=(
                f"DONE {agent_name} commented on {post_id} "
                f"(parent {parent_id} unusable — posted top-level)"
            ),
            lab_outcome="success",
            lab_summary=text[:_SUMMARY_CAP],
            lab_target_id=post_id,
        )

    return _outcome(
        action,
        landed=False,
        resource_id=None,
        detail=_error_detail(primary_error),
        log_line=f"WARN {agent_name} comment failed",
        lab_outcome="warn",
        lab_summary="comment request failed",
        lab_target_id=post_id,
    )


def _execute_like(resources: Resources, action: Action, *, agent_name: str) -> ExecutionOutcome:
    post_id = (action.post_id or "").strip()
    if not post_id:
        return _skip(
            action,
            agent_name=agent_name,
            field_detail="missing postId",
            lab_summary="like skipped: missing postId",
        )
    try:
        resources.like_post(post_id)
    except _WriteFailure as exc:
        return _outcome(
            action,
            landed=False,
            resource_id=None,
            detail=_error_detail(exc),
            log_line=f"WARN {agent_name} like failed",
            lab_outcome="warn",
            lab_summary="like request failed",
            lab_target_id=post_id,
        )
    return _outcome(
        action,
        landed=True,
        resource_id=None,
        detail=None,
        log_line=f"DONE {agent_name} liked {post_id}",
        lab_outcome="success",
        lab_summary="liked post",
        lab_target_id=post_id,
    )


def _execute_follow(resources: Resources, action: Action, *, agent_name: str) -> ExecutionOutcome:
    username = _clean_username(action.username)
    if not username:
        return _skip(
            action,
            agent_name=agent_name,
            field_detail="missing username",
            lab_summary="follow skipped: missing username",
        )
    try:
        resources.follow(username)
    except _WriteFailure as exc:
        # Deliberately STILL landed=True (contract 02 §2.4): `auto-run.sh
        # :250-252` returns 0 on both branches, because "already following"
        # is the common outcome and is not a failed round.
        #
        # This branch sees the WHOLE failure space, including that common
        # 409: `Resources.follow` no longer swallows CONFLICT (ruling R20 --
        # while it did, the swallow sent the common case down the success
        # path instead, with a DONE line, a `success` lab event and a
        # memory.md line Bash never writes).
        #
        # Cost, recorded here rather than left implicit: this is the one
        # action kind whose REAL failure never shows up in a round's
        # landed/attempted tally, so a genuinely broken follow path looks
        # identical to a healthy one from the outside. The log line, the lab
        # event and the absent memory line are where it IS visible.
        return _outcome(
            action,
            landed=True,
            # ... but the swil.sh call itself did NOT succeed, so no
            # memory.md line (rulings R19 + R20). `swil.sh`'s `follow` case
            # is `_curl … | jq .` followed by `_remember` (swil.sh:679-683),
            # and the failing `_curl` aborts the case under `set -euo
            # pipefail` before `_remember` ever runs. This is the ONLY thing
            # that differs from the success branch besides the log line and
            # the lab outcome -- `landed` is True either way (see the except
            # clause above).
            call_succeeded=False,
            resource_id=None,
            detail=f"likely already following: {_error_detail(exc)}",
            log_line=f"WARN {agent_name} follow @{username} failed (likely already following)",
            lab_outcome="warn",
            lab_summary="follow request failed",
            lab_reason=username,
        )
    return _outcome(
        action,
        landed=True,
        resource_id=None,
        detail=None,
        log_line=f"DONE {agent_name} followed @{username}",
        lab_outcome="success",
        lab_summary=f"followed @{username}",
    )


def _execute_echo(resources: Resources, action: Action, *, agent_name: str) -> ExecutionOutcome:
    post_id = (action.post_id or "").strip()
    if not post_id:
        return _skip(
            action,
            agent_name=agent_name,
            field_detail="missing postId",
            lab_summary="echo skipped: missing postId",
        )
    # Quote text is optional (a plain repost) -- only postId gates the skip.
    text = collapse_doubled_text(_clean(action.text))
    try:
        echo_id = resources.create_post(text, echo_of=post_id)
    except _WriteFailure as exc:
        return _outcome(
            action,
            landed=False,
            resource_id=None,
            detail=_error_detail(exc),
            log_line=f"WARN {agent_name} echo failed",
            lab_outcome="warn",
            lab_summary="echo request failed",
            lab_target_id=post_id,
        )
    quote_tag = f" (quote: {text[:_QUOTE_PREVIEW_CAP]})" if text else ""
    return _outcome(
        action,
        landed=True,
        resource_id=echo_id,
        detail=None,
        log_line=f"DONE {agent_name} echoed {post_id}{quote_tag}",
        lab_outcome="success",
        lab_summary=text[:_SUMMARY_CAP],
        lab_target_id=post_id,
    )


def _execute_dm(resources: Resources, action: Action, *, agent_name: str) -> ExecutionOutcome:
    username = _clean_username(action.username)
    text = collapse_doubled_text(_clean(action.text))
    if not username or not text:
        return _skip(
            action,
            agent_name=agent_name,
            field_detail="missing username or text",
            lab_summary="dm skipped: missing username or text",
        )
    try:
        conversation_id, message_id = resources.send_dm(username, text)
    except _WriteFailure as exc:
        return _outcome(
            action,
            landed=False,
            resource_id=None,
            detail=_error_detail(exc),
            log_line=f"WARN {agent_name} dm to @{username} failed",
            lab_outcome="warn",
            lab_summary="dm request failed",
            lab_reason=username,
        )
    # Recipient only, never the body (contract 02 §2.6) -- private
    # conversations stay out of the observation layer by design. A local
    # memory-line preview is Bash's other half of this asymmetry; ported
    # memory.md writing is a Phase 2 concern, out of scope here.
    return _outcome(
        action,
        landed=True,
        resource_id=message_id,
        detail=None,
        log_line=f"DONE {agent_name} dm → @{username}",
        lab_outcome="success",
        lab_summary=f"→@{username}",
        conversation_id=conversation_id,
    )


def _execute_nothing(action: Action, *, agent_name: str) -> ExecutionOutcome:
    return _outcome(
        action,
        landed=True,
        resource_id=None,
        detail=None,
        log_line=f"DONE {agent_name} — chose to do nothing",
        lab_outcome="success",
        lab_summary="chose to do nothing",
    )


def execute_action(
    resources: Resources,
    action: Action,
    *,
    agent_name: str,
    username: str,
    images: ImageFetcher = fetch_unsplash_image,
    access_key: str = "",
    board_id: str | None = None,
) -> ActionResult:
    """Execute one planned action and report whether it actually landed.

    Success is decided by a RETURNED RESOURCE ID (or, for `like`/`follow`, a
    verified state change), never by the absence of an exception (design
    spec §7.2) -- the root-cause fix for the codex silent failures: bash's
    `swil.sh` subcommands checked only their own exit code, so a 2xx with no
    created row logged `DONE` and the round tallied a landing that never
    happened. Every `Resources` write already raises on that shape (Task
    1); this function's only job is to never catch that exception and treat
    it as success anyway.

    A failed action never aborts the round -- the caller tallies results
    (contract `02` §3.1); this function always returns a value, never
    raises for an ordinary write failure.

    `agent_name` feeds the log line and the follow-failure lab reason;
    `username` is who the lab event is filed under
    (`POST /agents/{username}/events`, contract `02` §5.3) -- unrelated to
    which account authenticated the underlying write, which `resources`
    already carries baked into its `ApiClient`.

    `images`/`access_key`/`board_id` are extension points the brief's own
    `execute_action` sketch omitted despite requiring them for the `post`
    kind's `create_post(text, board_id=..., image=...)` call and this
    module's `ImageFetcher` Protocol: `images` defaults to the real
    `fetch_unsplash_image` (R5 — tests inject a fake), `access_key` defaults
    to `""` (routes straight to the Picsum fallback, matching bash's own
    `[[ -n "${UNSPLASH_ACCESS_KEY:-}" ]]` skip), and `board_id` defaults to
    `None` (unfiled post) since neither `Action` nor this function's brief
    signature carries a persona's `Board` bullet -- that resolution belongs
    to whichever caller assembles the round (not yet ported), not to a
    single action's executor.
    """
    if action.kind == "post":
        outcome = _execute_post(
            resources,
            action,
            agent_name=agent_name,
            images=images,
            access_key=access_key,
            board_id=board_id,
        )
    elif action.kind == "comment":
        outcome = _execute_comment(resources, action, agent_name=agent_name)
    elif action.kind == "like":
        outcome = _execute_like(resources, action, agent_name=agent_name)
    elif action.kind == "follow":
        outcome = _execute_follow(resources, action, agent_name=agent_name)
    elif action.kind == "echo":
        outcome = _execute_echo(resources, action, agent_name=agent_name)
    elif action.kind == "dm":
        outcome = _execute_dm(resources, action, agent_name=agent_name)
    elif action.kind == "nothing":
        outcome = _execute_nothing(action, agent_name=agent_name)
    else:
        # `action.kind` is `ActionKind`, a closed 7-member Literal, and
        # `Action` validates it at construction time (Task 1's models.py) --
        # unlike bash, which reads a free-form string off decision JSON and
        # has a real "unknown action" branch (contract 02 §2.8). There is no
        # runtime path into this `else` for a Python-constructed `Action`;
        # it exists so mypy sees every branch return and so this function
        # never silently mishandles a future ActionKind addition -- it
        # raises loudly here instead of falling through to unhandled state.
        raise AssertionError(f"unhandled action kind: {action.kind!r}")  # pragma: no cover

    # `log_line` is the whole reason it is computed: it is `_log`'s exact
    # text (`auto-run.sh`'s per-action DONE/WARN/SKIP lines), and until this
    # call all 17 of them were built and dropped on the floor. `agent/logs/
    # auto-run.log` is what straggler reconciliation and post-run QA grep
    # after a round; a Python round that never wrote a line there is
    # indistinguishable from a round that never happened.
    #
    # Level from the lab outcome rather than by re-parsing the line's own
    # DONE/WARN/SKIP prefix -- same fact, already typed. The FILE handler
    # renders `[ts] <message>` with no level (Bash's `_log` format exactly,
    # see `cli.py`); the level only shapes the stderr stream.
    logger.log(
        logging.INFO if outcome.lab_event.outcome == "success" else logging.WARNING,
        "%s",
        outcome.log_line,
    )
    resources.lab_event(username, outcome.lab_event)
    return outcome.result
