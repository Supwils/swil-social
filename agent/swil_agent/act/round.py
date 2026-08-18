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
from datetime import datetime
from pathlib import Path

from swil_agent.act.context import build_context
from swil_agent.act.executor import execute_action
from swil_agent.act.guardrails import apply_guardrails
from swil_agent.act.planner import plan_round
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


def _memory_text(raw: str | None) -> str:
    """Whitespace-clean + doubled-text-collapse one field for a memory.md
    note (contract `02` §4.2, cross-cutting facts).

    Mirrors `tr -d '\\n' | sed 's/  */ /g'` then `.strip()`, exactly like
    `act/executor.py`'s private `_clean` applies to the copy of the text it
    sends to the API -- reproduced here rather than imported because the
    memory line is built from the ORIGINAL `Action` the guardrails approved,
    independently of whatever the executor already did with its own copy of
    the same field on the way to the wire. `test_memory_note_collapses_...`
    pins this against the exact shape the brief specifies; a divergence
    between this and `executor._clean` would show up as the two modules'
    tests disagreeing on the same input, not as a shared import silently
    drifting.
    """
    text = (raw or "").replace("\n", "")
    text = _WHITESPACE_RUN.sub(" ", text).strip()
    return collapse_doubled_text(text)


def _memory_username(raw: str | None) -> str:
    """`tr -d '@[:space:]'` -- mirrors `act/executor.py`'s private
    `_clean_username`, for the same reason `_memory_text` mirrors `_clean`."""
    return re.sub(r"[@\s]", "", raw or "")


def _memory_note(action: Action, result: ActionResult) -> str | None:
    """The per-kind note text `swil.sh`'s `_remember()` would append
    (contract `02` §4.2), or `None` when no memory.md line should be
    written at all.

    Gated on `result.landed` -- every one of `_remember`'s real call sites
    only fires on a write that actually happened (contract `02` §4.1):
    `post`/`comment`/`echo`/`dm` gated on a non-empty server-assigned id,
    `like`/`follow` unconditionally *after* their curl call did not already
    abort the case under `set -e`. `landed` is this module's equivalent of
    "did not already abort" for every kind except `follow` -- see the
    module docstring's DIVERGENCE note in `run_act` for the one case where
    that equivalence is not exact.

    `nothing` never gets a line (contract `02` §4.1: "auto-run.sh's
    `nothing` case never calls swil.sh").
    """
    if not result.landed or action.kind == "nothing":
        return None

    if action.kind == "post":
        text = _memory_text(action.text)
        topic = _memory_text(action.image_topic)
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
        # DIVERGENCE (documented in task-7-report.md): Bash's dm memory line
        # records `conversationId=$CONV_ID`, but `Resources.send_dm` (Task 1)
        # returns only the created MESSAGE id -- the conversation id it
        # resolved along the way never survives past that call, so this
        # layer never has it either. Widening `send_dm`'s return contract to
        # carry it is out of this task's scope; `messageId=` is substituted
        # as the nearest identifier actually available, rather than
        # fabricating a conversation id this module never had.
        text = _memory_text(action.text)
        username = _memory_username(action.username)
        return f"dm | to={username} messageId={result.resource_id} | {text[:_MEMORY_PREVIEW_CAP]}"
    else:
        # ActionKind is a closed 7-member Literal and `nothing` is handled by
        # the early return above, so every remaining member is covered by a
        # branch above -- this is unreachable for a validly constructed
        # Action, exactly like the equivalent branch in
        # act/executor.py:execute_action.
        raise AssertionError(  # pragma: no cover
            f"unhandled action kind for memory note: {action.kind!r}"
        )


def _write_memory_line(
    directory: Path, action: Action, result: ActionResult, *, now: datetime
) -> None:
    """Append one line to `<directory>/memory.md`, matching `_remember()`'s
    on-disk format byte for byte (contract `02` §4.2): `<YYYY-MM-DD> |
    <note>`. `directory` is `persona.directory` -- the same folder
    `resolve_agent_dir` returns and Bash calls `agent_dir` -- so this reads
    and writes the identical file a live Bash round would.

    Real file I/O, performed directly rather than behind an injected seam:
    `FileLock` (Task 2) already established this module family's precedent
    of touching the filesystem for Bash-compatible on-disk state, and
    `memory.md` is exactly that.
    """
    note = _memory_note(action, result)
    if note is None:
        return
    line = f"{now.strftime('%Y-%m-%d')} | {note}\n"
    with (directory / "memory.md").open("a", encoding="utf-8") as handle:
        handle.write(line)


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
        throughout -- for the lock path AND as `execute_action`'s
        `agent_name` -- to stay faithful to what Bash actually keys on.
      * `board_id` and the Unsplash `access_key` are left at `execute_action`'s
        own defaults (unfiled post, empty key -> Picsum fallback):
        `run_act`'s brief-specified signature carries neither a persona's
        `Board` bullet resolution nor a settings object to source an
        Unsplash key from. `act/executor.py`'s own docstring anticipates
        board resolution belonging to "whichever caller assembles the
        round" -- flagged here as a known, deliberate gap for a follow-up
        task, not a silent omission.
    """
    if not health_check():
        return ActResult(outcome=ActOutcome.OFFLINE)

    agent_name = persona.directory.name
    with FileLock(act_lock_path(agent_root, agent_name)):
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

        results: list[ActionResult] = []
        landed = 0
        for action in guarded.actions:
            result = execute_action(
                resources,
                action,
                agent_name=agent_name,
                username=persona.username,
            )
            results.append(result)
            if result.landed:
                landed += 1
            _write_memory_line(persona.directory, action, result, now=now)

        attempted = len(guarded.actions)
        if is_solo_nothing:
            outcome = ActOutcome.PLANNER_EMPTY
        elif landed == 0:
            logger.warning(
                "FAIL %s — all %d planned actions failed; dream will be skipped",
                persona.username,
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
