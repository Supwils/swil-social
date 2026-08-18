"""Compose the whole dream path: cooldown, candidate generation, the gate,
and -- when accepted -- the write sequence that archives the old
personality, writes the new one, updates the cooldown markers, and uploads
a snapshot.

Source of truth is `agent/scripts/dream.sh` (read directly; see `dream/
candidate.py`'s and `dream/gate.py`'s module docstrings for why the contract
docs alone are not trusted here) and `agent/scripts/snapshot.sh` for
`build_snapshot_payload` -- both read line-by-line while writing this module,
not assumed from the contract doc's transcription.

WRITE ORDERING IS THE CONTRACT (contract `03` §4, `dream.sh:828-882`), and it
is the reason this function exists rather than being three separately
callable pieces:

  1. diff narrative                 -- computed FIRST, using `original` and
                                        `candidate` as the two in-memory
                                        strings they already are at this
                                        point (equivalently: while
                                        personality.md on disk still holds
                                        the OLD text)
  2. archive prepend                -- `persona_source.archive_and_write`
  3. personality.md write              bundles this pair into ONE call, in
                                        that internal order (temp-file swap;
                                        see `persona/source.py`)
  4. `last_dream_<name>` marker      -- `state.record_dream` bundles this
  5. `last_dream_memlines_<name>`       pair into ONE call, in that internal
     marker                             order (`dream/candidate.py`'s
                                        `FilesystemDreamState.record_dream`)
  6. memory.md append                -- AFTER step 5, so the housekeeping
                                        line self-counts toward the NEXT
                                        round's cooldown-override tally
                                        (deliberate; do not reorder --
                                        contract `03` §1.3/§4)
  7. snapshot upload                 -- after personality.md is already
                                        live; a failure here is a WARN and
                                        does NOT roll back the write already
                                        committed in steps 2-3

Two collaborators each bundle two of Bash's seven numbered steps into one
call because they already carry their own correctness invariant about the
pair's internal order (an atomic temp-file swap; two related on-disk
markers) -- see their own docstrings. `run_dream`'s job is the ordering
BETWEEN those bundles, not within them, and guarding the whole sequence with
`FileLock(dream_lock_path(...))` so a held lock raises `LockBusy` OUT of this
function (ruling R6) rather than being folded into `DreamResult` -- the
lock's release-on-exception behaviour (a plain `with` block) is what stops
the accepted-dream orphan lock: under Bash, every accepted dream exits 141
right after "snapshot uploaded" (a SIGPIPE inside the echo-chamber detector,
see CLAUDE.md), and because that happens AFTER the `trap ... RETURN EXIT`
line already ran, the lock is still released there -- but a Python exception
anywhere in this sequence, before this function returns, releases the lock
the same way a normal return does, which is the actual fix for that class of
defect once this runtime is live.

Lab-event posting (`_post_agent_event` calls in dream.sh -- 15 call sites
across the dream path) IS implemented, via `_emit` below: `dream/dream`
started/fail/warn/success and `snapshot/snapshot` success/warn, matching
Bash's own summary strings exactly (fix round 1, item 1 -- an initial
version of this module deferred this, reasoning that the seven-step WRITE
ordering contract has no lab-event step in it; the coordinator's counter was
that Python's act path already emits 5 events through `act/executor.py`,
so a silent dream path is an inconsistency within this one plan, not a
deferral, and spec §10 stage 4's cutover criterion -- "every canary dream
terminates with a recorded verdict" -- is written against `/lab`, not a
local log line). `_emit` never lets an events outage change what this
function returns -- see its own docstring -- mirroring `Resources.lab_event`
's existing `except ApiError: return` guarantee with a second, broader net.

Two lab-event details this module does NOT attempt: Bash's per-check
summary/reason SPLIT for structural failures (six different validators, each
putting the dynamic part in a different one of `summary`/`reason` --
`persona/validators.py`'s `ValidationFailure.detail` already gives one
combined string, which every reject event's `summary` carries whole rather
than being pulled apart again here), and the two `echo_flag` events
(`echo/cleared`, `echo/flagged`) -- the first is unreachable without the
second, which is the write side of echo-chamber detection this module does
not implement (see below).

Deliberately NOT implemented here, consistent with CLAUDE.md's own framing
of the feature as "OFF by default" and uncalibrated:

  * Echo-chamber DETECTION -- the write side of contract `03` §4.10
    (embedding an account's last 12 posts, computing pairwise variance,
    writing a NEW `echo_flag_<name>`). `settings.echo_detect` defaults to
    `False` and must not become `True` in this plan (its threshold is
    uncalibrated: measured variance 0.001-0.011 against a shipped 0.04
    would flag every account on every dream, confounding the topic aspect
    of the in-flight drift experiment). Since the feature is inert by
    construction whenever it stays off, and no test in this task's brief
    exercises it, this module wires only the unconditional READ-and-consume
    side (`dream.candidate.read_echo_hint`, called every dream regardless
    of `ECHO_DETECT` -- Bash's own read is not gated either, only the
    write/detection block at the bottom of `dream_one` is). Implementing
    the write side is left to whichever later task actually calibrates
    `ECHO_VARIANCE_THRESHOLD`, so turning it on is a one-place change
    instead of an already-half-built feature nobody remembers is there.
  * `EmbedderGuard.up()`/`.down()` and the "probe `EmbedderClient.health()`
    once per ROUND, not once per dream" ruling (forward requirement to
    tasks 12 AND 13, `progress.md`). Reading `dream.sh` directly confirms
    it never calls `embedder-guard.sh` itself -- `cycle-one.sh` brackets
    ONE ACCOUNT'S act+dream pair with `up`/`down`, and a full ROUND is many
    `cycle-one.sh` processes sharing that ref-counted guard, so "once per
    round" can only mean "once across many `run_dream` calls for different
    accounts", i.e. a concern that belongs to whatever composes multiple
    calls to this function (task 13's CLI), never to a single one of them.
    Nothing here calls the guard or probes embedder health.
"""

from __future__ import annotations

import hashlib
import logging
from datetime import datetime
from pathlib import Path
from typing import Any, Final

from swil_agent.api.client import ApiError
from swil_agent.api.dto import LabEvent
from swil_agent.api.resources import Resources, WriteNotVerifiedError
from swil_agent.config import Settings
from swil_agent.dream.candidate import (
    DreamState,
    check_cooldown,
    clean_candidate,
    group_memory_digest,
    read_echo_hint,
    render_dream_prompt,
)
from swil_agent.dream.distill import Embedder
from swil_agent.dream.gate import evaluate_candidate
from swil_agent.embedder.client import EmbedderUnavailable
from swil_agent.llm.base import (
    Backend,
    BackendUnavailableError,
    CompletionRequest,
    Runner,
    complete_text,
)
from swil_agent.locks import FileLock, dream_lock_path
from swil_agent.models import DreamResult, DreamVerdict, Persona
from swil_agent.persona.source import PersonaSource

logger = logging.getLogger(__name__)

_ARCHIVE_TAIL_LINES: Final = 20
_RECENT_MEMORY_LINES: Final = 60
_NARRATIVE_MAX_CHARS: Final = 1500
_GROUP_MEMORY_LIMIT: Final = 30
_EXCERPT_MAX_CHARS: Final = 280

# `dream.sh:105-115`'s `_diff_narrative` system prompt, verbatim (single
# static string across every call, like `candidate.py`'s
# `DREAM_SYSTEM_PROMPT`).
_DIFF_NARRATIVE_SYSTEM_PROMPT: Final = (
    "你在对比同一个虚拟人格的两个版本（做梦前 / 做梦后）。用中文，2~3 句话，"
    "说清楚这次梦把人格往哪个方向塑造了：哪些特质被强化、哪些淡出、有没有新主题冒出来。"
    "只输出这段叙述本身，不要标题、不要任何前后缀。"
)

# `dream.sh:66`'s `ASPECT_PROMPT_VERSION` default, duplicated here rather
# than imported from `dream/gate.py`'s private `_ASPECT_PROMPT_VERSION` --
# the same call `test_gate.py` itself makes ("pinned here as a literal ...
# rather than importing a private name"). This copy feeds only the snapshot
# payload's informational `aspectDrift.promptVersion` field; it plays no
# part in any cache-key match (that match is entirely internal to
# `dream/gate.py` and `dream/distill.py`), so a future bump only needs
# updating in the two places that already duplicate it today.
#
# An `int`, NOT the `str` `dream/gate.py`'s same-named constant is. The two
# copies feed different consumers and the types are load-bearing on both
# sides, which is why unifying them would be the wrong fix:
#   * HERE the value crosses the wire into `aspectDrift.promptVersion`,
#     which `server/src/modules/agents/agents.schemas.ts`'s
#     `aspectDriftIngest` declares as `z.number().int().nonnegative()` with
#     NO `.coerce`. A JSON string fails that validation and the server
#     rejects the WHOLE snapshot ingest -- i.e. every accepted Python dream
#     silently loses its personality snapshot, the exact failure mode
#     already in this project's history ("create-api-key before the first
#     dream or the personality snapshot silently never lands"). Bash sends
#     a JSON number: `dream.sh:769` uses `jq -n --argjson pv`, not `--arg`.
#   * In `dream/gate.py` the value is STRING-CONCATENATED into the anchor
#     aspect cache key (`sha256(anchor):v{N}`, `dream.sh:318`). Changing its
#     type there would be harmless in Python but is exactly the kind of edit
#     that invites a format change, and a changed key invalidates all 23
#     real warm `personality.anchor.aspects.json` files at once (~69 extra
#     `claude` calls to rebuild). It stays a `str` for that reason.
_ASPECT_PROMPT_VERSION: Final = 2

# dream.sh:805's OWN lab-event summary for that same case -- a DIFFERENT,
# past-tense string from its `_log` line one line above (dream.sh:804 uses
# "skipping"; the event uses "skipped"). Both are transcribed verbatim from
# the script, not assumed to be the same string.
_EMBEDDER_UNREACHABLE_EVENT_SUMMARY: Final = "embedder unreachable, skipped drift check"


def _emit(resources: Resources, username: str, event: LabEvent) -> None:
    """Best-effort observability write -- mirrors `Resources.lab_event`'s
    own guarantee (it already swallows `ApiError` internally, matching
    dream.sh's own unconditional `|| true` at the end of
    `_post_agent_event`, dream.sh:422) with a second, broader safety net
    here: NOTHING this module does in response to a lab event may change
    what `run_dream` returns, even if `resources` is a test double (or a
    future implementation) whose `lab_event` does not honour that guarantee
    on its own -- fix round 1, item 1's explicit proof requirement.
    """
    try:
        resources.lab_event(username, event)
    except Exception:
        logger.debug(
            "lab event failed for %s (%s/%s/%s): outcome unaffected",
            username,
            event.type,
            event.phase,
            event.outcome,
        )


def _drift_fail_metrics(verdict: DreamVerdict, settings: Settings) -> dict[str, Any]:
    """The `fail_metrics` payload `dream.sh:811-816` attaches to a drift
    REJECTION's lab event -- `{aspects, breached, mode}` when the gate
    produced per-aspect similarities (Bash's own
    `if [[ -n "$aspect_drift_json" ]]` branch, which fires whenever the
    aspect computation succeeded, regardless of which mode ultimately
    decided), else `{similarity, drift}` built from `verdict.scalar_sim` --
    a TYPED field on `DreamVerdict` (fix round 2, task 12), not text pulled
    back out of `reason` by pattern-matching. An earlier version of this
    function regex-matched the number out of `dream/gate.py`'s
    `_scalar_decision` reason string; that coupling meant a harmless-looking
    reword of that message (e.g. `sim=` -> `similarity=`) would silently
    empty this function's output with no test failure anywhere -- a lab
    event missing its numbers looks identical to one that was never going
    to have any. `scalar_sim` closes that gap: `gate.py` populates it
    whenever the scalar embed pair succeeded, on BOTH the accept and reject
    paths, and leaves it `None` -- not `0.0` -- when the embedder could not
    be reached, so this function tells "no value" apart from "value 0.0" by
    construction rather than by regex-match-or-not.

    A STRUCTURAL failure's `verdict.sims` AND `verdict.scalar_sim` are both
    `None` (`dream/gate.py` returns immediately after `validate_candidate`
    fails, before ever computing a similarity) -- so both branches fall
    through to `{}` for a structural failure without this function needing
    to know which kind of failure it is looking at, matching Bash's own "no
    metrics" behaviour for those six checks.
    """
    if verdict.sims is not None:
        return {
            "aspects": {
                "values": verdict.sims.values,
                "style": verdict.sims.style,
                "topic": verdict.sims.topic,
            },
            "breached": verdict.breached,
            "mode": settings.drift_mode,
        }
    if verdict.scalar_sim is None:
        return {}
    return {"similarity": verdict.scalar_sim, "drift": round(1 - verdict.scalar_sim, 4)}


def build_snapshot_payload(
    *,
    text: str,
    directory: Path,
    agent_root: Path,
    embedding: list[float],
    captured_at: datetime,
    narrative: str = "",
    aspect_drift: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """`snapshot.sh`'s own POST body (contract `03` §5, `snapshot.sh:127-145`).

    `excerpt` slices `text` by CHARACTER, not byte: Python string slicing is
    already codepoint-based, which is exactly what dodges the bug
    `snapshot.sh`'s own comment documents -- its first attempt used
    `head -c 280`, which split a multibyte CJK character and crashed the
    downstream `jq --arg` under `set -e`.

    `captured_at` must already be a UTC-valued datetime (the caller decides
    what moment this represents -- production passes `datetime.now(UTC)`);
    this function does not convert, only formats, matching `date -u
    '+%Y-%m-%dT%H:%M:%SZ'`.

    `archivePath` is computed relative to `agent_root`, matching
    `realpath --relative-to="$ROOT_DIR" "$DIR"` + `/personality.md`
    (`snapshot.sh:115`) -- no filesystem access, since neither `directory`
    nor `agent_root` need to exist on disk for this to be well-defined.
    """
    payload: dict[str, Any] = {
        "contentHash": hashlib.sha256(text.encode()).hexdigest(),
        "snapshotType": "dream",
        "capturedAt": captured_at.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "archivePath": (directory / "personality.md").relative_to(agent_root).as_posix(),
        "excerpt": text.replace("\n", " ")[:_EXCERPT_MAX_CHARS],
        "embedding": list(embedding),
    }
    if narrative:
        payload["diffNarrative"] = narrative
    if aspect_drift is not None:
        payload["aspectDrift"] = aspect_drift
    return payload


def _generate_candidate(
    backend: Backend, system_prompt: str, user_prompt: str, model: str | None
) -> str:
    """The dream-rewrite LLM call itself (contract `03` §3): one attempt, no
    retry (unlike the aspect distiller's three-attempt loop in
    `dream/distill.py`). A `BackendUnavailableError` -- raised by every
    concrete `Backend` when its underlying process produced nothing,
    including on a timeout that left the output file empty
    (`dream.sh:635-639`'s watchdog falls through to the same "empty output"
    check rather than returning early) -- degrades to `""` here, which
    `clean_candidate` then carries through to the same `FAIL ... LLM
    returned empty` outcome Bash logs at `dream.sh:646-650`.
    """
    try:
        return complete_text(
            backend, CompletionRequest(system=system_prompt, user=user_prompt, model=model)
        )
    except BackendUnavailableError:
        return ""


def _diff_narrative(old_text: str, new_text: str, backend: Backend) -> str:
    """Contract `03` §4.1 (`dream.sh:105-115`, `_diff_narrative`): a
    best-effort 2-3 sentence Chinese summary of what this dream changed,
    generated by the SAME backend the account dreams under -- but with
    `model=None`, NOT the persona's own `ai_model`. `_diff_narrative`'s own
    call is `llm_text "$backend" "" "$sys" "$usr"`, a LITERAL empty model
    argument -- verified by reading the script directly, not assumed from
    the contract doc, which does not call this detail out at all.

    A failure here never aborts the dream (Bash's own `|| echo ''`), so this
    catches only `BackendUnavailableError` and returns `""` rather than
    letting a broken backend propagate out of what is explicitly a
    best-effort step -- consistent with how `dream/gate.py`'s `_try_embed`
    scopes its own catch narrowly rather than swallowing everything.
    """
    user_prompt = f"【旧版 personality】\n{old_text}\n\n【新版 personality】\n{new_text}"
    try:
        raw = complete_text(
            backend,
            CompletionRequest(system=_DIFF_NARRATIVE_SYSTEM_PROMPT, user=user_prompt, model=None),
        )
    except BackendUnavailableError:
        return ""
    return " ".join(raw.split())[:_NARRATIVE_MAX_CHARS]


def _group_memory(resources: Resources, name: str) -> str:
    """Contract `03` §2.2: `_group_memory_digest` degrades to `""` on any
    HTTP failure (`dream.sh:368`'s `|| echo ''`). Bash also guards on
    `api_key.txt` existing before making the call at all -- an artifact of
    Bash's own per-call curl authentication with no equivalent here:
    `resources` is already the account's authenticated client (composed by
    the caller), so there is nothing further to check.

    `limit=30, unread_only=False` matches dream.sh's own raw
    `GET .../notifications?limit=30` call (no `unreadOnly` parameter at
    all) -- a DIFFERENT call site from `swil.sh`'s own notification read
    (`Resources.notifications`'s default `unread_only=True`, contract `01`
    §2j, used by `act/context.py`'s `build_context`).
    """
    try:
        notifications = resources.notifications(limit=_GROUP_MEMORY_LIMIT, unread_only=False)
    except ApiError:
        notifications = []
    return group_memory_digest(notifications)


def _read_memory_archive_tail(directory: Path) -> str:
    """`tail -20 memory.archive.md`, or `""` if that file does not exist --
    `render_dream_prompt` itself substitutes the "(尚无历史归档)" literal for
    an empty `archive_tail` (`dream/candidate.py`), so this function need
    not know about that placeholder at all.
    """
    path = directory / "memory.archive.md"
    if not path.is_file():
        return ""
    lines = path.read_text(encoding="utf-8").splitlines()
    return "\n".join(lines[-_ARCHIVE_TAIL_LINES:])


def _aspect_drift_payload(verdict: DreamVerdict, settings: Settings) -> dict[str, Any] | None:
    """The `aspectDrift` block `dream.sh:816-818` builds and forwards to
    `snapshot.sh` via `ASPECT_DRIFT_OVERRIDE` -- `None` (which
    `build_snapshot_payload` then omits entirely) whenever the gate never
    produced per-aspect similarities, matching Bash's own empty
    `aspect_drift_json` default (scalar mode, or aspect/shadow mode with a
    failed distill/embed -- `dream/gate.py`'s `evaluate_candidate` already
    leaves `DreamVerdict.sims` as `None` in exactly those cases).
    """
    if verdict.sims is None:
        return None
    return {
        "mode": settings.drift_mode,
        "promptVersion": _ASPECT_PROMPT_VERSION,
        "values": verdict.sims.values,
        "style": verdict.sims.style,
        "topic": verdict.sims.topic,
        "breached": verdict.breached,
    }


def run_dream(
    *,
    persona: Persona,
    persona_source: PersonaSource,
    resources: Resources,
    backend: Backend,
    runner: Runner,
    embedder: Embedder,
    state: DreamState,
    settings: Settings,
    agent_root: Path,
    now: datetime,
    captured_at: datetime,
    auto: bool = False,
) -> DreamResult:
    """One dream round: cooldown -> candidate -> gate -> (on accept) the
    seven-step write sequence, with lab events posted at each terminal
    (and one non-terminal: the embedder-unreachable WARN) point along the
    way via `_emit`. See the module docstring for the ordering contract and
    the two pieces (echo-chamber detection's write side, embedder-guard
    probing) deliberately left to a later task.

    Account/file resolution (`dir` not found, no `personality.md`, no
    `memory.md` -- contract `03` §1.2) is NOT this function's job:
    `persona: Persona` arriving here already implies a successful
    `load_persona`, mirroring `run_act`'s own `persona: Persona` parameter
    (task 7, `act/round.py`). The caller (the CLI, task 13) is where "no
    such account" becomes an exit code.

    `now` is a naive local wall-clock moment, matching the convention
    `GitPersonaSource.archive_and_write`'s own `when: datetime` parameter
    already established (`test_persona_source.py` drives it with plain
    `datetime(...)` literals, no tzinfo) -- it feeds the archive stamp, the
    memory.md date line, and (via `int(now.timestamp())`) the epoch marker,
    exactly the three things Bash's own (local-time) `date` calls feed.
    `captured_at` is the SEPARATE UTC moment the snapshot's `capturedAt`
    field needs -- Bash reads these from two independent `date`/`date -u`
    invocations too, so two independently-suppliable parameters here is
    more faithful than deriving one from the other via an environment-
    dependent timezone conversion.
    """
    name = persona.directory.name
    with FileLock(dream_lock_path(agent_root, name)):
        state_dir = agent_root / ".agent-state"
        memory_text = persona_source.read_memory(name)
        memory_lines = memory_text.count("\n")

        cooldown = check_cooldown(
            state,
            name,
            auto=auto,
            memory_lines=memory_lines,
            now=int(now.timestamp()),
            cooldown_hours=settings.dream_cooldown_hours,
            min_new_memories=settings.dream_min_new_memories,
        )
        if not cooldown.proceed:
            logger.info("SKIP %s — %s", name, cooldown.reason)
            return DreamResult(proceeded=False, reason=cooldown.reason)
        if cooldown.reason:
            logger.info("%s — %s", name, cooldown.reason)

        _emit(
            resources,
            persona.username,
            LabEvent(type="dream", phase="dream", outcome="started", summary="dream started"),
        )

        recent_memory = "\n".join(memory_text.splitlines()[-_RECENT_MEMORY_LINES:])
        archive_tail = _read_memory_archive_tail(persona.directory)
        group_memory = _group_memory(resources, name)
        echo_hint = read_echo_hint(state_dir, name)

        system_prompt, user_prompt = render_dream_prompt(
            persona_text=persona.raw,
            recent_memory=recent_memory,
            archive_tail=archive_tail,
            group_memory=group_memory,
            echo_hint=echo_hint,
        )

        raw = _generate_candidate(backend, system_prompt, user_prompt, persona.model)
        candidate_text = clean_candidate(raw)
        if not candidate_text:
            logger.warning("FAIL %s — LLM returned empty", name)
            _emit(
                resources,
                persona.username,
                LabEvent(type="dream", phase="dream", outcome="fail", summary="LLM returned empty"),
            )
            return DreamResult(proceeded=True, reason="LLM returned empty")

        verdict = evaluate_candidate(
            persona.raw,
            candidate_text,
            directory=persona.directory,
            embedder=embedder,
            runner=runner,
            settings=settings,
        )
        # `DreamVerdict.embedder_unreachable`, NOT a comparison against
        # `verdict.reason`. `dream/gate.py` COMPOSES that string
        # (`f"{aspect_note}; {base_reason}"`), and in the deployed
        # `DRIFT_MODE=aspect` a non-empty `aspect_note` is routine -- so an
        # `==` here silently stopped matching in exactly the case that
        # matters most: the aspect pipeline degraded AND the embedder gone,
        # i.e. the dream landing completely ungated with no WARN to say so.
        # Bash fires this event on the condition itself (dream.sh:804-805),
        # not on the text of its own log line.
        if verdict.accepted and verdict.embedder_unreachable:
            _emit(
                resources,
                persona.username,
                LabEvent(
                    type="dream",
                    phase="dream",
                    outcome="warn",
                    summary=_EMBEDDER_UNREACHABLE_EVENT_SUMMARY,
                ),
            )

        if not verdict.accepted:
            logger.warning("FAIL %s — %s; keeping original", name, verdict.reason)
            _emit(
                resources,
                persona.username,
                LabEvent(
                    type="dream",
                    phase="dream",
                    outcome="fail",
                    summary=verdict.reason,
                    metrics=_drift_fail_metrics(verdict, settings),
                ),
            )
            return DreamResult(proceeded=True, reason=verdict.reason, verdict=verdict)

        # ── Accept sequence -- write ordering is the contract (module docstring) ──
        narrative = _diff_narrative(persona.raw, candidate_text, backend)  # 1
        persona_source.archive_and_write(name, candidate_text, now)  # 2 + 3
        state.record_dream(name, at=int(now.timestamp()), memlines=memory_lines)  # 4 + 5
        persona_source.append_memory(
            name, f"{now:%Y-%m-%d} | dream | personality consolidated"
        )  # 6
        logger.info("DONE %s dreamed — personality updated (old → personality.archive.md)", name)
        _emit(
            resources,
            persona.username,
            LabEvent(type="dream", phase="dream", outcome="success", summary="personality updated"),
        )

        snapshot_ok = True
        snapshot_reason: str | None = None
        try:
            vector = embedder.embed([candidate_text])[0]
            payload = build_snapshot_payload(
                text=candidate_text,
                directory=persona.directory,
                agent_root=agent_root,
                embedding=vector,
                captured_at=captured_at,
                narrative=narrative,
                aspect_drift=_aspect_drift_payload(verdict, settings),
            )
            resources.create_snapshot(persona.username, payload)  # 7
        except (EmbedderUnavailable, WriteNotVerifiedError, ApiError) as exc:
            snapshot_ok = False
            snapshot_reason = str(exc)
            logger.warning("WARN %s — snapshot upload failed: %s", name, snapshot_reason)
            _emit(
                resources,
                persona.username,
                LabEvent(
                    type="snapshot",
                    phase="snapshot",
                    outcome="warn",
                    summary="snapshot upload failed",
                    reason=snapshot_reason,
                ),
            )
        else:
            logger.info("%s — snapshot uploaded", name)
            _emit(
                resources,
                persona.username,
                LabEvent(
                    type="snapshot",
                    phase="snapshot",
                    outcome="success",
                    summary="snapshot uploaded",
                ),
            )

        # Echo-chamber DETECTION stops here -- see the module docstring's
        # "deliberately NOT implemented" note. The read/consume side
        # (`read_echo_hint`) already ran above, unconditionally.

        return DreamResult(
            proceeded=True,
            accepted=True,
            reason=verdict.reason,
            verdict=verdict,
            narrative=narrative,
            recorded_memlines=memory_lines,
            snapshot_ok=snapshot_ok,
            snapshot_reason=snapshot_reason,
        )
