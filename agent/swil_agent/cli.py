"""CLI entrypoints, argument-compatible with the Bash scripts where they overlap.

Exit codes are deliberately the Bash ones (66 = no such account, 75 = no
action ran) so `cycle-one.sh` and the heartbeat can invoke either runtime
during the canary without knowing which they got. `ActOutcome`/`DreamResult`
are the internal representation; the process exit code is the external
contract (task-13-brief.md).

Mapping, by command:

  * `act`  -- `ActResult.grants_dream` (design spec §7.1) IS the exit-code
    decision: `True` (landed, partial, vetoed-empty, planner-empty -- every
    outcome except a dead backend or an unreachable platform) exits 0,
    `False` exits 75. This is deliberate and NOT a byte-for-byte replay of
    Bash's own rc=75, which also fires on a rhythm-vetoed or deliberately
    empty plan (`auto-run.sh`'s own comment: "节律否决" is one of the
    non-zero causes) -- that conflation is exactly the bug `grants_dream`
    exists to fix (CLAUDE.md, "Empty plan counts as failure"). A caller that
    branches on this exit code to decide whether to run `dream` next
    (mirroring `cycle-one.sh`'s own `if auto-run.sh; then dream.sh; fi`)
    gets the CORRECTED decision, which is the point of shipping the fix at
    all.
  * `dream` -- `DreamResult.proceeded` is the exit-code decision:
    `False` (a cooldown SKIP -- the LLM was never even called) exits 75,
    matching "no action ran"; `True` (the dream ran to a verdict, whether
    accepted, structurally rejected, or drift-rejected) exits 0, matching
    "something ran". `dream.sh` itself has no consumer of its own exit code
    (`cycle-one.sh` calls it unconditionally, without an `if`), so this
    mapping is this module's own decision, chosen to mirror `act`'s
    "attempted vs never-attempted" shape rather than invent a third scheme.
  * Everything else -- ANY exception, not an enumerated list of them --
    also exits 75, via ONE broad guard wrapping composition-plus-run in each
    command (fix round 2, task-13-report.md). The invariant is "no setup
    failure may leave the 0/66/75 contract", not "these particular
    exceptions": `cycle-one.sh` and the heartbeat branch on those three
    codes, and a raw traceback/exit 1 is a fourth code neither knows how to
    read. `_skip_for_exception` draws exactly one distinction inside that
    guard, because collapsing it away would be worse than the bug it fixes:

      - `AccountSetupError` (raised only by this module's own composition
        helpers, at the exact point each one knows both the cause and the
        remedy: `_resources_for` for no credentials or a failed
        `PasswordAuth.login()`, `_backend_for` for a dead backend key,
        `_load_persona_or_raise_setup_error` for a personality.md that
        exists but won't parse) and `LockBusy` are KNOWN, remediable setup
        problems -- not bugs. Their own message (already a complete "cause
        -- remedy" sentence) becomes the SKIP line verbatim.
      - Anything else is, by definition, NOT one of those -- a genuine
        programming error. Logged as `UNEXPECTED <ExceptionType>: <message>`
        (never disguised as a setup problem someone could fix by running
        `create-api-key`) with its traceback at DEBUG, so it is recoverable
        by whoever is looking without being the operator's primary output.

This module is the ONLY composition root in the package: the one place
allowed to import every layer (`api/`, `llm/`, `embedder/`, `persona/`,
`act/`, `dream/`) at once and wire concrete collaborators together from a
`Settings` instance and an account name. Every module below it stays
unit-testable in isolation because none of them constructs its own
collaborators -- see `act/round.py`'s and `dream/round.py`'s own module
docstrings for the same argument from their side of the seam.

The small `_..._for(...)` builder functions below exist so CLI tests can
replace exactly one layer at a time (e.g. monkeypatch `_resources_for` to
return a `FakeResources()` double) without needing to fake Typer's argument
parsing or reach into `swil_agent.api`/`swil_agent.llm` internals from the
test module. `tests/unit/test_cli.py` monkeypatches every network- and
subprocess-facing one of these for its `CliRunner` tests, and calls several
of them directly (over `httpx.MockTransport`) so they are not *only* ever
exercised through a monkeypatched stand-in for themselves.
"""

from __future__ import annotations

import logging
import random
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Final

import httpx
import typer

from swil_agent import __version__
from swil_agent.act.round import run_act
from swil_agent.api.auth import PasswordAuth, resolve_auth
from swil_agent.api.client import ApiClient
from swil_agent.api.resources import Resources
from swil_agent.config import Settings, load_settings
from swil_agent.dream.candidate import DreamState, FilesystemDreamState
from swil_agent.dream.round import run_dream
from swil_agent.embedder.client import EmbedderClient, EmbedderUnavailable
from swil_agent.embedder.guard import EmbedderGuard
from swil_agent.llm.base import (
    Backend,
    BackendBinaryMissingError,
    BackendUnavailableError,
    Runner,
    SubprocessRunner,
    build_backend,
)
from swil_agent.locks import LockBusy
from swil_agent.models import ActResult, DreamResult, Persona
from swil_agent.persona.source import GitPersonaSource, PersonaSource

logger = logging.getLogger(__name__)

EXIT_OK = 0
EXIT_NO_SUCH_ACCOUNT = 66
EXIT_NO_ACTION = 75

_HEALTH_TIMEOUT = 10.0

_EMBEDDER_DOWN_AFTER_GUARD_UP = (
    "embedder unreachable after guard up -- the drift gate is OFF for every "
    "dream this invocation runs (embedder_url=%s); each will fail open with "
    "its own quieter per-dream WARN. A live embedder, not a scattered WARN "
    "trail, is what actually gates a round -- this is the 2026-08-13 "
    "embedder-OOM incident's signature."
)


class AccountSetupError(RuntimeError):
    """A KNOWN, remediable account/environment misconfiguration.

    Raised ONLY by this module's own composition helpers (never by anything
    below them) at the exact point one of them discovers the cause -- which
    is also the only point that can produce a good remedy, since only the
    helper that failed knows what it was trying to do. Every message is
    already a complete "cause -- remedy" sentence, so `act`/`dream`'s outer
    guard can print it verbatim as the SKIP line.

    This is the single type that guard classifies as "not a bug" (alongside
    `LockBusy`, which predates this type and keeps its own more detailed
    message) -- see `_skip_for_exception` and the module docstring's mapping
    section for why a curated type beats enumerating library exceptions one
    except-clause at a time.
    """


app = typer.Typer(add_completion=False, help="Swil Social agent runtime")


@app.callback()
def _main() -> None:
    """Runs before every command. `force=False` (the default): a no-op if a
    handler is already configured -- e.g. by pytest's own logging capture --
    so tests never get a second, duplicate stream of output."""
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")


_ROUND_LOG_FORMAT: Final = "[%(asctime)s] %(message)s"
_ROUND_LOG_DATE_FORMAT: Final = "%Y-%m-%d %H:%M:%S"
_round_log_handler: logging.FileHandler | None = None


ACT_LOG_FILENAME: Final = "auto-run.log"
DREAM_LOG_FILENAME: Final = "dream.log"


def _attach_round_log(settings: Settings, filename: str) -> logging.Handler | None:
    """Mirror every `swil_agent` log record into `agent/logs/<filename>`, in
    the Bash runtime's `_log` format.

    **The filename is PER COMMAND, and getting it wrong is silent.** The two
    scripts write to two different files and always have:
    `auto-run.sh:31-34` sets `LOG_FILE="$LOG_DIR/auto-run.log"`, while
    `dream.sh:36-40` sets `LOG_FILE="$LOG_DIR/dream.log"` -- both live, both
    written on the same day in the main checkout (auto-run.log 1.0MB,
    dream.log 234KB). An earlier version of this function hardcoded
    `auto-run.log` for BOTH commands (ruling R20), so Python dreams appended
    dream verdicts into the act log while `dream.log` stayed empty: anyone
    grepping `dream.log` for a Python round's verdict found nothing, and
    anyone counting act lines in `auto-run.log` counted dream lines too.
    Hence `ACT_LOG_FILENAME`/`DREAM_LOG_FILENAME` as named constants passed
    explicitly, rather than a default this function could quietly apply to
    the wrong caller.

    `_log` itself (auto-run.sh:41-45, byte-identical in dream.sh) is
    `msg="[$(date '+%Y-%m-%d %H:%M:%S')] $*"`, echoed to stdout AND appended
    to `$LOG_FILE`, with `LOG_DIR="$ROOT_DIR/logs"` and `ROOT_DIR` = `agent/`
    (both scripts `mkdir -p` it). Same path, same timestamp format, same
    append semantics, and the formatter carries NO level name -- so a Python
    round's line is byte-comparable with the Bash one that a straggler
    reconciliation or a post-run QA pass greps for. Without this, 17 computed
    `ExecutionOutcome.log_line` values went nowhere and a Python round left
    both files untouched, which reads exactly like a round that never ran.

    `basicConfig`'s stderr stream is untouched and keeps its
    `%(levelname)s %(message)s` shape. The one cosmetic difference from Bash
    is that its second copy goes to stdout, not stderr.

    Attached to the `swil_agent` logger, NOT the root: the root would also
    capture `httpx`'s own INFO-level "HTTP Request: ..." line for every API
    call, which `auto-run.log` has never contained.

    At most ONE round-log handler exists at a time. Re-attaching the same
    path is a no-op (a `CliRunner`-driven test invokes the app many times in
    one process, and a second handler would double every line); attaching a
    DIFFERENT path -- including the other command's -- closes and replaces
    the old one rather than accumulating open files across a session.

    Returns the handler, or `None` if the file could not be opened -- a
    round must not die because a log file could not be opened.
    """
    global _round_log_handler
    path = settings.agent_root / "logs" / filename
    package_logger = logging.getLogger("swil_agent")
    if _round_log_handler is not None:
        if _round_log_handler.baseFilename == str(path):
            return _round_log_handler
        package_logger.removeHandler(_round_log_handler)
        _round_log_handler.close()
        _round_log_handler = None
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        handler = logging.FileHandler(path, mode="a", encoding="utf-8")
    except OSError as exc:
        logger.warning("could not open %s for the round log: %s", path, exc)
        return None
    handler.setFormatter(logging.Formatter(_ROUND_LOG_FORMAT, datefmt=_ROUND_LOG_DATE_FORMAT))
    # Level on the HANDLER, never on the logger: `_skip_for_exception` logs
    # its traceback at DEBUG, and raising the LOGGER's level would discard
    # that record before any handler (including pytest's caplog) saw it.
    # Bash's `auto-run.log` has no debug tier, so the file takes INFO and up.
    handler.setLevel(logging.INFO)
    package_logger.addHandler(handler)
    _round_log_handler = handler
    return handler


# ── composition helpers (the seams CLI tests monkeypatch or call directly) ─


def _persona_source_for(settings: Settings) -> PersonaSource:
    return GitPersonaSource(settings.agent_root)


def _resources_for(
    persona: Persona, settings: Settings, *, transport: httpx.BaseTransport | None = None
) -> Resources:
    """`resolve_auth` picks Bearer (`api_key.txt`) over the `SWIL_PASS`
    session-cookie fallback (`api/auth.py`, contract `02` §2.9). The Bearer
    path needs nothing further -- `ApiKeyAuth.headers()` is ready to use the
    moment it is constructed. The cookie path does: `PasswordAuth.cookies()`
    is empty until `login()` runs (its own docstring), so without an
    explicit login here every read/write over that fallback would 401
    silently into whatever degrade path the caller has, and a real account
    that only has `SWIL_PASS` (no `api_key.txt` yet) would never actually
    authenticate. `transport` is an injection seam for tests
    (`httpx.MockTransport`); production callers never pass it.
    """
    try:
        auth = resolve_auth(
            persona.directory, username=persona.username, password=settings.swil_pass
        )
    except ValueError as exc:
        raise AccountSetupError(_auth_setup_remedy(persona, settings)) from exc

    client = ApiClient(settings.swil_url, auth, transport=transport)
    if isinstance(auth, PasswordAuth):
        try:
            auth.login(client)
        except RuntimeError as exc:
            # Scoped to ONLY this one call, not the whole function body --
            # `PasswordAuth.login` raises `ApiError`/`TransportError` (both
            # `RuntimeError` subclasses, api/client.py) on a failed HTTP
            # request, or a bare `RuntimeError("login succeeded but no sid
            # cookie was returned")` on a 2xx with no cookie -- both are the
            # SAME known failure shape ("this account's SWIL_PASS did not
            # authenticate"), never a bug in this module.
            raise AccountSetupError(
                f"login failed for {persona.username} via SWIL_PASS: {exc} -- "
                "check SWIL_PASS in agent/.env (wrong password, an expired "
                "session config, or the platform was unreachable)"
            ) from exc
    return Resources(client)


def _auth_setup_remedy(persona: Persona, settings: Settings) -> str:
    """The message for `resolve_auth`'s `ValueError` (no usable
    `api_key.txt` -- missing OR present-but-blank, `api/auth.py`'s own
    `resolve_auth` already catches both shapes of that before falling
    through -- AND no `SWIL_PASS`), named so the CLI's SKIP line sends
    whoever reads it to the fix rather than to a stack trace.

    `swil.sh create-api-key`'s account selector is `SWIL_AGENT=<relative
    personality path>`, NOT a positional argument -- its own
    `"${2:-default}"` is a label for the created key, not the account
    (confirmed by reading `_personality_file` in `swil.sh` directly, not
    assumed from the usage banner alone).
    """
    rel = persona.directory.relative_to(settings.agent_root)
    return (
        f"no api_key.txt and no SWIL_PASS for {persona.username} ({rel}) -- "
        f"run `SWIL_AGENT={rel}/personality.md agent/scripts/swil.sh create-api-key`, "
        "or set SWIL_PASS in agent/.env"
    )


def _backend_setup_remedy(persona: Persona, exc: Exception) -> str:
    """The message for a `BackendUnavailableError`, wherever it was raised.

    Two call sites, deliberately sharing one wording: `_backend_for` (the
    backend could not be CONSTRUCTED -- a `deepseek` account with no or
    empty `~/.claude/.deepseek-key`) and `_backend_setup_guard` (the backend
    could not be RUN -- `SubprocessRunner` re-raises a missing `claude`/
    `codex` binary as this same type). Both are the same operator-facing
    problem, "this account's backend is not usable on this machine", and
    both want the same remedy.
    """
    return (
        f"backend unavailable for {persona.username} "
        f"(backend={persona.backend!r}): {exc} -- for deepseek, place the "
        "key at ~/.claude/.deepseek-key (one line, chmod 600, no "
        "surrounding whitespace); other backends need the matching CLI "
        "(claude/codex) on PATH and authenticated"
    )


def _backend_for(persona: Persona, settings: Settings) -> Backend:
    """Wraps `build_backend`'s `BackendUnavailableError` (`llm/base.py` --
    raised for a `deepseek` account with no or empty
    `~/.claude/.deepseek-key`) into `AccountSetupError`: a dead backend key
    is a known, remediable setup problem, not a bug, and a missing
    `~/.claude/.deepseek-key` silently dropping every DeepSeek account from
    a round is already in this project's operational history (CLAUDE.md).
    """
    try:
        return build_backend(persona.backend, SubprocessRunner(), settings)
    except BackendUnavailableError as exc:
        raise AccountSetupError(_backend_setup_remedy(persona, exc)) from exc


@contextmanager
def _backend_setup_guard(persona: Persona) -> Iterator[None]:
    """Turn a `BackendUnavailableError` raised DURING the round into the same
    `AccountSetupError` `_backend_for` raises when construction fails.

    Needed because a missing backend binary is not discoverable at
    construction time: `build_backend` only picks a class, and the CLI is not
    invoked until the first `complete()` call, deep inside `run_act`/
    `run_dream`. `SubprocessRunner` re-raises `subprocess`'s
    `FileNotFoundError` as `BackendBinaryMissingError` -- a SIBLING of
    `BackendUnavailableError`, so it survives every "the LLM said nothing"
    handler between there and here -- precisely so this guard can attach the
    account name and the remedy at the composition root, keeping ruling R17's
    invariant that `AccountSetupError` is raised only by this module, at the
    point that knows both the cause and the fix.

    `BackendUnavailableError` is caught here too, for the narrow window where
    one escapes a step that does not degrade on it.

    Scoped to the round call alone, not the whole command body, for the same
    reason `_resources_for`'s `RuntimeError` catch is scoped to `login()`:
    a wider bracket would start swallowing exceptions this guard has no
    business classifying.
    """
    try:
        yield
    except (BackendBinaryMissingError, BackendUnavailableError) as exc:
        raise AccountSetupError(_backend_setup_remedy(persona, exc)) from exc


def _runner_for(settings: Settings) -> Runner:
    _ = settings  # no per-runner settings today; kept for interface stability
    return SubprocessRunner()


def _embedder_for(
    settings: Settings, *, transport: httpx.BaseTransport | None = None
) -> EmbedderClient:
    return EmbedderClient(settings.embedder_url, transport=transport)


def _guard_for(settings: Settings) -> EmbedderGuard:
    return EmbedderGuard(settings.agent_root, runner=SubprocessRunner())


def _state_for(settings: Settings) -> DreamState:
    return FilesystemDreamState(settings.agent_root / ".agent-state")


def _health_check(settings: Settings, *, transport: httpx.BaseTransport | None = None) -> bool:
    """A raw, UNPREFIXED GET to `${SWIL_URL}/health` -- `ApiClient` always
    prefixes `/api/v1` (api/client.py), so this stays outside it entirely
    rather than mixing a bare-URL HTTP concern into that module. Mirrors
    `run_act`'s own module docstring, which makes the identical call for the
    identical reason: nothing else in this package performs this one raw
    request.
    """
    try:
        with httpx.Client(transport=transport, timeout=_HEALTH_TIMEOUT) as client:
            response = client.get(f"{settings.swil_url}/health")
    except httpx.HTTPError:
        return False
    return response.status_code == 200


def _read_text_or(path: Path, default: str) -> str:
    return path.read_text(encoding="utf-8") if path.is_file() else default


def _context_now_for(settings: Settings) -> str:
    """`context/now.md` -- written by `swil.sh login`, which stays Bash in
    Phase 1 (`act/context.py`'s own `build_context` docstring). This
    function only reads it, matching `auto-run.sh:500`'s own
    `cat ... || echo '(no context file)'` fallback."""
    return _read_text_or(settings.agent_root / "context" / "now.md", "(no context file)")


def _feed_context_for(settings: Settings, username: str) -> str:
    """`context/feed_for_<Username bullet>.md` -- keyed by the persona's
    `Username` bullet, NOT its directory name (`auto-run.sh:504`'s own
    `username_for_feed` is parsed straight from the `Username:` bullet)."""
    return _read_text_or(settings.agent_root / "context" / f"feed_for_{username}.md", "")


def _probe_embedder(embedder: EmbedderClient, settings: Settings) -> None:
    """R10 (progress.md, forwarded from Tasks 2 and 12): `EmbedderGuard.up()`
    cannot fail loudly -- `embedder-guard.sh` always exits 0 by design (its
    own comment: "a guard must never abort its caller"). Left unchecked, a
    dead daemon surfaces only as a per-dream WARN inside
    `evaluate_candidate`'s fail-open path (`dream/gate.py`), which reads
    identically whether ONE dream's embed call happened to fail or the
    embedder has been down for the whole round -- exactly the 2026-08-13
    embedder-OOM incident's signature: a scattered WARN trail with nothing
    to show the gate was off entirely.

    This probe runs exactly once per CLI invocation of `dream` (right after
    `guard.up()`, before any account-specific work), at ERROR -- the loud,
    round-level signal the per-dream WARN deliberately is not.
    """
    try:
        embedder.health()
    except EmbedderUnavailable:
        logger.error(_EMBEDDER_DOWN_AFTER_GUARD_UP, settings.embedder_url)


def _do_dream(
    persona: Persona, persona_source: PersonaSource, settings: Settings, *, auto: bool
) -> DreamResult:
    embedder = _embedder_for(settings)
    _probe_embedder(embedder, settings)

    return run_dream(
        persona=persona,
        persona_source=persona_source,
        resources=_resources_for(persona, settings),
        backend=_backend_for(persona, settings),
        runner=_runner_for(settings),
        embedder=embedder,
        state=_state_for(settings),
        settings=settings,
        agent_root=settings.agent_root,
        now=datetime.now(),
        captured_at=datetime.now(UTC),
        auto=auto,
    )


# ── reporting ────────────────────────────────────────────────────────────


def _describe_plan(result: ActResult) -> str:
    if result.plan is None or not result.plan.actions:
        return "(nothing)"
    return ", ".join(action.kind for action in result.plan.actions)


def _report_act_result(name: str, result: ActResult, *, dry_run: bool) -> None:
    if dry_run:
        typer.echo(
            f"[dry-run] {name}: outcome={result.outcome.value} -- "
            f"would execute: {_describe_plan(result)}"
        )
    else:
        typer.echo(
            f"{name}: outcome={result.outcome.value} landed={result.landed}/{result.attempted}"
        )
    if result.rhythm is not None and result.rhythm.roll is not None:
        typer.echo(
            f"  rhythm: policy={result.rhythm.policy.value} roll={result.rhythm.roll}"
            f"/{result.rhythm.post_probability}"
        )
    for vetoed in result.vetoed:
        typer.echo(f"  vetoed: {vetoed.action.kind} -- {vetoed.reason}")


def _report_dream_result(name: str, result: DreamResult) -> None:
    if not result.proceeded:
        typer.echo(f"SKIP {name} -- {result.reason}")
    elif result.accepted:
        typer.echo(f"{name}: dream accepted -- personality updated ({result.reason})")
    else:
        typer.echo(f"{name}: dream rejected -- {result.reason}")


def _load_persona_or_raise_setup_error(persona_source: PersonaSource, name: str) -> Persona:
    """`persona_source.load(name)`, converting a malformed-but-PRESENT
    persona's `ValueError` (`persona/loader.py`'s `load_persona` -- e.g. no
    `- **Username:**` bullet) into `AccountSetupError`.

    Deliberately does NOT catch `FileNotFoundError`: that means "no such
    account" (exit 66), a different question from "this account exists but
    its personality.md won't parse" (exit 75, a setup problem) -- letting it
    propagate keeps both commands' own `except FileNotFoundError` the one
    place that distinction is made.
    """
    try:
        return persona_source.load(name)
    except ValueError as exc:
        raise AccountSetupError(
            f"{name}: personality.md exists but could not be parsed ({exc}) "
            "-- fix the account's `- **Username:** ...` bullet (and check "
            "every other `- **Field:**` line) in personality.md"
        ) from exc


_KNOWN_SETUP_FAILURES: tuple[type[Exception], ...] = (AccountSetupError, LockBusy)


def _skip_for_exception(name: str, exc: Exception) -> None:
    """The one classification point every reachable exception in `act`/
    `dream` funnels through once it escapes composition-plus-run (fix round
    2, task-13-report.md): prints the SKIP line and lets the caller decide
    the exit code (always 75 here; this function never raises).

    `AccountSetupError` and `LockBusy` are the two KNOWN, non-buggy shapes
    -- their own `str()` is already a complete message (cause and, for
    `AccountSetupError`, a concrete remedy) and is used verbatim. Anything
    else is NOT one of those, by construction: a genuine bug, logged in a
    visibly DIFFERENT form (`UNEXPECTED <Type>: <message>`) so it can never
    be misread as "this account just needs fixing" -- collapsing that
    distinction away is the exact trade `set -e` made in Bash and the
    reason exit-code masking went unnoticed for months. The traceback goes
    to the DEBUG log (recoverable, not the operator's primary output),
    never to the SKIP line itself.
    """
    if isinstance(exc, _KNOWN_SETUP_FAILURES):
        typer.echo(f"SKIP {name} -- {exc}")
    else:
        logger.debug("unexpected failure for %s", name, exc_info=exc)
        typer.echo(f"SKIP {name} -- UNEXPECTED {type(exc).__name__}: {exc}")


# ── commands ─────────────────────────────────────────────────────────────


@app.command()
def act(
    name: str,
    dry_run: bool = typer.Option(False, "--dry-run", help="Plan only; execute and write nothing."),
    budget: int = typer.Option(5, "--budget"),
    seed: int | None = typer.Option(
        None, "--seed", help="Seed the rhythm roll for reproducibility."
    ),
) -> None:
    """Python port of `auto-run.sh`'s act path, for one account.

    `--dry-run` is the shadow-round mode (design spec §9.4): it builds
    context and produces a plan but executes nothing, writes nothing, and --
    since it needs no mutual exclusion -- takes no account lock either, so it
    can never make a concurrent real round lose the race and SKIP. See
    `act/round.py`'s `run_act` for exactly where that inertness is enforced.
    This command adds no writes of its own on that path either.

    Two `try` blocks, not one, so exit 66 can only ever mean "this account
    directory does not exist" (fix wave, F5). Folding them together let ANY
    `FileNotFoundError` raised during the round -- most importantly
    `subprocess`'s, for a `claude`/`codex` binary missing from PATH -- be
    reported as "no such account", sending whoever is debugging to the roster
    instead of to PATH. `dream` has always had this shape; `act` now matches
    it.
    """
    settings = load_settings()
    _attach_round_log(settings, ACT_LOG_FILENAME)
    persona_source = _persona_source_for(settings)
    try:
        persona = _load_persona_or_raise_setup_error(persona_source, name)
    except FileNotFoundError as exc:
        typer.echo(f"no such account: {name}", err=True)
        raise typer.Exit(EXIT_NO_SUCH_ACCOUNT) from exc
    except Exception as exc:
        _skip_for_exception(name, exc)
        raise typer.Exit(EXIT_NO_ACTION) from exc

    try:
        with _backend_setup_guard(persona):
            result = run_act(
                persona=persona,
                resources=_resources_for(persona, settings),
                backend=_backend_for(persona, settings),
                memory_text=persona_source.read_memory(name),
                agent_root=settings.agent_root,
                now=datetime.now(),
                rng=random.Random(seed),
                health_check=lambda: _health_check(settings),
                budget=budget,
                context_now=_context_now_for(settings),
                feed_context=_feed_context_for(settings, persona.username),
                dry_run=dry_run,
                access_key=settings.unsplash_access_key,
            )
    except Exception as exc:
        _skip_for_exception(name, exc)
        raise typer.Exit(EXIT_NO_ACTION) from exc

    _report_act_result(name, result, dry_run=dry_run)
    raise typer.Exit(EXIT_OK if result.grants_dream else EXIT_NO_ACTION)


@app.command()
def dream(
    name: str,
    auto: bool = typer.Option(False, "--auto", help="Honour the 12h cooldown."),
) -> None:
    """Python port of `dream.sh`, for one account.

    Brackets the embedder daemon the way `cycle-one.sh` does for a real
    round (`up` before, `down` after) -- `act/round.py` never touches the
    embedder at all (`dream/round.py`'s own module docstring establishes
    this: the guard bracket belongs at the caller composing multiple
    accounts' dreams, i.e. here, not inside a single `run_dream` call), so
    only this command needs the guard.
    """
    settings = load_settings()
    _attach_round_log(settings, DREAM_LOG_FILENAME)
    persona_source = _persona_source_for(settings)
    try:
        persona = _load_persona_or_raise_setup_error(persona_source, name)
    except FileNotFoundError as exc:
        typer.echo(f"no such account: {name}", err=True)
        raise typer.Exit(EXIT_NO_SUCH_ACCOUNT) from exc
    except Exception as exc:
        _skip_for_exception(name, exc)
        raise typer.Exit(EXIT_NO_ACTION) from exc

    guard = _guard_for(settings)
    try:
        guard.up()
        with _backend_setup_guard(persona):
            result = _do_dream(persona, persona_source, settings, auto=auto)
    except Exception as exc:
        _skip_for_exception(name, exc)
        raise typer.Exit(EXIT_NO_ACTION) from exc
    finally:
        guard.down()

    _report_dream_result(name, result)
    raise typer.Exit(EXIT_OK if result.proceeded else EXIT_NO_ACTION)


@app.command()
def version() -> None:
    """Print the installed `swil-agent` package version."""
    typer.echo(f"swil-agent {__version__}")
