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
import sqlite3
from collections.abc import Iterator
from contextlib import ExitStack, closing, contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Final, Protocol

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
from swil_agent.graph.checkpoint import (
    CHECKPOINT_DB_NAME,
    Checkpointer,
    checkpointer_at,
    latest_round_id,
)
from swil_agent.graph.cycle import run_cycle
from swil_agent.graph.leases import LEASE_DB_NAME, LeaseBusy
from swil_agent.graph.nodes import CycleDeps, agent_dir_name
from swil_agent.graph.state import BUILTIN_TENANT, CycleState
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

# This module's DREAM-PHASE channel. Only the round-level embedder-down ERROR
# uses it, and it exists so that record lands in `dream.log` from `cycle` as
# well as from `dream` -- under `dream` the whole invocation goes to that file
# anyway, and a probe that changed file depending on which command ran it is
# the kind of inconsistency nobody notices until they grep for it. See
# `_DREAM_LOG_SOURCES`.
dream_logger = logging.getLogger(f"{__name__}.dream")

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
_round_log_handlers: list[logging.Handler] = []
_round_log_key: tuple[tuple[str, tuple[str, ...] | None], ...] = ()


ACT_LOG_FILENAME: Final = "auto-run.log"
DREAM_LOG_FILENAME: Final = "dream.log"

# Which loggers emit DREAM-phase records. Used ONLY by `cycle`, which is the
# one command that produces both phases in a single process and therefore
# needs the two files' contents decided per record rather than per command.
#
# `act` and `dream` still attach one unfiltered handler each -- a `dream`
# invocation emits only dream-phase records, an `act` invocation only
# act-phase ones, so filtering there would be machinery with no failure mode
# to prevent.
#
# Matching is by dotted-prefix, so `swil_agent.graph.nodes.dream` (the dream
# node's deadline FAIL) routes to `dream.log` while its parent
# `swil_agent.graph.nodes` (the cycle's own logout record) does not.
# `swil_agent.cli.dream` is this module's own dream-phase channel -- the
# round-level embedder-down ERROR, which `swil-agent dream` already writes to
# `dream.log` and which must not change file just because the same probe ran
# inside a cycle.
_DREAM_LOG_SOURCES: Final[tuple[str, ...]] = (
    "swil_agent.dream",
    "swil_agent.embedder",
    "swil_agent.graph.nodes.dream",
    "swil_agent.cli.dream",
)


class _PhaseFilter(logging.Filter):
    """Keep (or drop) records emitted by one phase's loggers.

    One class, two instances, one source list: `keep=True` for `dream.log`
    and `keep=False` for `auto-run.log`. Two independent lists would be two
    things to keep in sync, and a record matching neither would silently land
    in no file at all -- which reads exactly like a round that never ran.
    """

    def __init__(self, sources: tuple[str, ...], *, keep: bool) -> None:
        super().__init__()
        self._sources = sources
        self._keep = keep

    def filter(self, record: logging.LogRecord) -> bool:
        matched = any(
            record.name == source or record.name.startswith(f"{source}.")
            for source in self._sources
        )
        return matched is self._keep


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

    At most ONE round-log ATTACHMENT exists at a time (one handler for
    `act`/`dream`, two for `cycle`). Re-attaching the same one is a no-op (a
    `CliRunner`-driven test invokes the app many times in one process, and a
    second handler would double every line); attaching a DIFFERENT one --
    including the other command's -- closes and replaces the previous
    attachment rather than accumulating open files across a session.

    Returns the handler, or `None` if the file could not be opened -- a
    round must not die because a log file could not be opened.
    """
    handlers = _attach_round_logs(settings, ((filename, None),))
    return handlers[0] if handlers else None


def _attach_cycle_logs(settings: Settings) -> list[logging.Handler]:
    """`cycle`'s TWO round logs, split by phase.

    A cycle acts AND dreams inside one process, so "which file does this line
    belong in" cannot be answered per command the way it is for `act` and
    `dream` -- it has to be answered per RECORD. `_DREAM_LOG_SOURCES` is that
    answer, and the two filters are complementary halves of one list so no
    record can fall through into neither file.

    The failure this prevents is silent in exactly the way ruling R20's was:
    a cycle that sent both phases to `auto-run.log` leaves `dream.log` empty,
    and every straggler-reconciliation grep for a dream verdict comes back
    with nothing while the act log's line counts are quietly inflated.
    """
    return _attach_round_logs(
        settings,
        (
            (ACT_LOG_FILENAME, None),
            (DREAM_LOG_FILENAME, _DREAM_LOG_SOURCES),
        ),
    )


def _attach_round_logs(
    settings: Settings, specs: tuple[tuple[str, tuple[str, ...] | None], ...]
) -> list[logging.Handler]:
    """Install exactly the round-log handlers `specs` describes, replacing
    whatever was installed before.

    Each spec is `(filename, dream_sources)`. `dream_sources=None` means "no
    filter, take every `swil_agent` record" -- what `act` and `dream` use.
    A non-`None` value installs the DREAM half of the split on that file and
    the ACT half (its complement) on every other file in the same
    attachment, which is how one list drives both filters.

    The key includes the resolved paths AND the source tuples, so switching
    between `act`'s single unfiltered `auto-run.log` and `cycle`'s filtered
    pair is detected as a different attachment even though both include a
    handler on the same path.
    """
    global _round_log_handlers, _round_log_key
    package_logger = logging.getLogger("swil_agent")
    key = tuple((str(settings.agent_root / "logs" / name), sources) for name, sources in specs)
    if key == _round_log_key:
        return _round_log_handlers

    for existing in _round_log_handlers:
        package_logger.removeHandler(existing)
        existing.close()
    _round_log_handlers = []
    _round_log_key = ()

    installed: list[logging.Handler] = []
    dream_sources = next((sources for _, sources in specs if sources is not None), None)
    for filename, sources in specs:
        path = settings.agent_root / "logs" / filename
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            handler = logging.FileHandler(path, mode="a", encoding="utf-8")
        except OSError as exc:
            logger.warning("could not open %s for the round log: %s", path, exc)
            continue
        handler.setFormatter(logging.Formatter(_ROUND_LOG_FORMAT, datefmt=_ROUND_LOG_DATE_FORMAT))
        # Level on the HANDLER, never on the logger: `_skip_for_exception`
        # logs its traceback at DEBUG, and raising the LOGGER's level would
        # discard that record before any handler (including pytest's caplog)
        # saw it. Bash's `auto-run.log` has no debug tier, so the file takes
        # INFO and up.
        handler.setLevel(logging.INFO)
        if dream_sources is not None:
            handler.addFilter(_PhaseFilter(dream_sources, keep=sources is not None))
        package_logger.addHandler(handler)
        installed.append(handler)
    _round_log_handlers = installed
    # Only remember the attachment if EVERY file opened. A partial (or empty)
    # install must stay retryable, matching the previous single-handler
    # behaviour where a failed open left the module global at `None`.
    _round_log_key = key if len(installed) == len(specs) else ()
    return installed


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


class _Guard(Protocol):
    """The two calls a command makes on the embedder daemon's lifecycle.

    Named as a Protocol so `cycle` can hold either the real `EmbedderGuard` or
    the dry-run no-op below in ONE variable, and keep `guard.up()` /
    `finally: guard.down()` unconditional. A `if not dry_run: guard.up()` pair
    with a matching `finally` is the shape that eventually leaks a started
    daemon on some third branch.
    """

    def up(self) -> None: ...

    def down(self) -> None: ...


class _DryRunGuard:
    """The embedder guard a shadow round gets: nothing at all.

    A dry cycle is routed away from the dream phase entirely, so it reaches no
    `gate` node and needs no vectors. Running the real guard is not merely
    redundant -- `embedder-guard.sh` writes `.agent-state/embedder_guard/*`
    and `logs/embedder.log`, and boots the bge-m3 daemon (up to 150s of
    startup) if nothing is serving. Spec §10 stage 3's exit criterion is
    "nothing to revert; Python never wrote".
    """

    def up(self) -> None:
        return

    def down(self) -> None:
        return


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
        dream_logger.error(_EMBEDDER_DOWN_AFTER_GUARD_UP, settings.embedder_url)


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


# ── the cycle's own composition seams ────────────────────────────────────


@dataclass
class _CycleStores:
    """The two databases a cycle needs, and the one thing they have in common:
    a dry run gets neither on disk."""

    lease_db: sqlite3.Connection
    checkpointer: Checkpointer | None


@contextmanager
def _cycle_stores(settings: Settings, *, dry_run: bool) -> Iterator[_CycleStores]:
    """Open (and always close) the lease and checkpoint databases.

    Both live in `agent/.agent-state/`, next to `lock_<name>` and the dream
    cooldown markers -- one directory for the Python runtime's local
    per-account state, matching `_state_for` above. The two modules own their
    FILENAMES (`LEASE_DB_NAME`, `CHECKPOINT_DB_NAME`) and this composition
    root owns the directory.

    **A dry run gets an in-memory lease DB and no checkpointer at all.**
    `run_cycle` already takes no lease when `deps.dry_run` is set, so the
    connection is never used -- but `sqlite3.connect(<path>)` CREATES the file
    regardless, and a shadow round that leaves two new databases in
    `.agent-state/` has written to disk during the round whose exit criterion
    is "nothing to revert; Python never wrote" (spec §10 stage 3). Resuming a
    shadow round is meaningless for the same reason there is nothing to
    resume from.
    """
    with ExitStack() as stack:
        target = ":memory:"
        if not dry_run:
            # `sqlite3.connect` does not create missing parents -- it raises
            # `OperationalError: unable to open database file`, which reads as
            # a bug rather than as "this account has never had local state".
            # `open_checkpointer` already mkdirs its own; this is the same
            # directory, and the lease DB is opened first.
            lease_path = _lease_db_path(settings)
            lease_path.parent.mkdir(parents=True, exist_ok=True)
            target = str(lease_path)
        lease_db = stack.enter_context(closing(sqlite3.connect(target)))
        checkpointer = (
            None if dry_run else stack.enter_context(checkpointer_at(_checkpoint_db_path(settings)))
        )
        yield _CycleStores(lease_db=lease_db, checkpointer=checkpointer)


def _lease_db_path(settings: Settings) -> Path:
    return settings.agent_root / ".agent-state" / LEASE_DB_NAME


def _checkpoint_db_path(settings: Settings) -> Path:
    return settings.agent_root / ".agent-state" / CHECKPOINT_DB_NAME


@contextmanager
def _lease_busy_guard(name: str) -> Iterator[None]:
    """Turn `LeaseBusy` into an `AccountSetupError` carrying a REMEDY.

    `LeaseBusy`'s own message is a cause ("... act lease busy (lock_zenith
    held (12s))") and ruling R17 wants the SKIP line to name the remedy too.
    It has one, and this project has already needed it: an accepted Bash dream
    exits 141 after "snapshot uploaded" and orphans `dream_lock_<name>`, so
    "another run holds it" and "a dead run left it behind" look identical
    until someone checks the pid inside the file (CLAUDE.md, "Accepted-dream
    SIGPIPE orphan lock"). Bash itself only logs `SKIP <name> — locked` and
    moves on, which is why those orphans went unnoticed for whole rounds.
    """

    try:
        yield
    except LeaseBusy as exc:
        raise AccountSetupError(
            f"{name}: {exc} -- another run holds this account. Wait for it, or "
            f"if it is an orphan (`cat agent/.agent-state/*lock_{name}` names a "
            "pid that is no longer alive) remove that lock file; leases older "
            "than 1800s are reclaimed automatically"
        ) from exc


def _cycle_deps_for(
    persona: Persona,
    persona_source: PersonaSource,
    settings: Settings,
    *,
    dry_run: bool,
    auto: bool,
    budget: int,
    seed: int | None,
) -> CycleDeps:
    """Everything the nine nodes need, built once per cycle.

    Deliberately the SAME collaborators, read from the same places, that
    `act` hands `run_act` and `dream` hands `run_dream` -- that is what makes
    the parity oracle (`test_cycle_parity.py`) a comparison of the two paths
    rather than of two compositions.

    One real difference, recorded on `CycleDeps` itself: `now` and
    `captured_at` are frozen ONCE here, where `act` and `dream` are two
    processes taking a fresh `datetime.now()` each. Within one cycle that is
    minutes in an archive stamp.

    `_probe_embedder` runs here for the same reason `_do_dream` runs it: once
    per invocation, right after `guard.up()`, before any account work --
    `EmbedderGuard.up()` cannot fail loudly (R10). **Except under `dry_run`**:
    a shadow round never reaches the gate, so the drift check it would warn
    about was never going to happen. Probing anyway emits one ERROR per
    account -- 23 "the drift gate is OFF for every dream this invocation runs"
    lines into `dream.log`, for dreams that do not run, in the very log stage 3
    is read from.
    """
    embedder = _embedder_for(settings)
    if not dry_run:
        _probe_embedder(embedder, settings)
    return CycleDeps(
        resources=_resources_for(persona, settings),
        backend=_backend_for(persona, settings),
        persona_source=persona_source,
        runner=_runner_for(settings),
        embedder=embedder,
        dream_state=_state_for(settings),
        settings=settings,
        agent_root=settings.agent_root,
        health_check=lambda: _health_check(settings),
        memory_text=persona_source.read_memory(agent_dir_name(persona)),
        context_now=_context_now_for(settings),
        feed_context=_feed_context_for(settings, persona.username),
        budget=budget,
        access_key=settings.unsplash_access_key,
        dry_run=dry_run,
        auto=auto,
        rng=random.Random(seed),
        now=datetime.now(),
        captured_at=datetime.now(UTC),
    )


def _resume_round_id(stores: _CycleStores, agent: str) -> str:
    """The round id `--resume` continues, read back out of the checkpoint
    database.

    Recomputing it from the clock (`run_cycle`'s own default) would build a
    DIFFERENT `thread_id` and silently start a brand-new cycle instead of
    continuing the interrupted one -- the failure mode where `--resume`
    appears to work and quietly re-runs the act phase, re-posting whatever
    already landed.
    """
    if stores.checkpointer is None:
        raise AccountSetupError(
            f"{agent}: --resume and --dry-run are mutually exclusive -- a shadow "
            "round writes no checkpoint, so there is nothing to continue from"
        )
    found = latest_round_id(stores.checkpointer, BUILTIN_TENANT, agent)
    if found is None:
        raise AccountSetupError(
            f"{agent}: no checkpointed cycle to resume -- run "
            f"`swil-agent cycle {agent}` (without --resume) first, or check that "
            f"{_checkpoint_db_path_hint()} still exists"
        )
    return found


def _checkpoint_db_path_hint() -> str:
    return f"agent/.agent-state/{CHECKPOINT_DB_NAME}"


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


def _act_result_of(state: CycleState) -> ActResult | None:
    """Project the act half of a final `CycleState` back onto `ActResult`.

    Projected rather than re-formatted so `cycle` and `act` print the same
    line for the same round: `_report_act_result` is the ONE renderer, and a
    second copy of that format is a second thing to keep in step with
    whatever a shadow-round comparison greps for.

    `None` when the cycle never reached an outcome at all -- a resumed thread
    with nothing left to run, say -- because `ActResult.outcome` is required
    and inventing one would report a round that did not happen.
    """
    outcome = state.get("outcome")
    if outcome is None:
        return None
    return ActResult(
        outcome=outcome,
        results=state.get("results", []),
        vetoed=state.get("vetoed", []),
        plan=state.get("plan"),
        context=state.get("context"),
        rhythm=state.get("rhythm"),
        attempted=state.get("attempted", 0),
        landed=state.get("landed", 0),
    )


def _dream_result_of(state: CycleState) -> DreamResult:
    """The dream half, same idea.

    `accepted` is `written` -- the flag that answers "did `personality.md`
    actually change" -- never `verdict.accepted`, which is a claim about the
    gate and not about the file (`dream/round.py`'s `WriteStep`). The reason
    prefers `dream_reason` (a cooldown SKIP, an empty rewrite, a blown
    deadline: the reasons a dream never reached the gate) and falls back to
    the verdict's, which is the only place a REJECTION's reason lives.

    `narrative` and `snapshot_reason` are projected for completeness and have
    NO reader: `_report_dream_result` prints neither. That is deliberate and
    is recorded rather than pinned — the load-bearing hand-off those fields
    belong to is `write` -> `snapshot` INSIDE the graph, which
    `test_graph_nodes.py` already pins at both ends (a dropped `narrative`
    empties `diffNarrative` on every uploaded snapshot). A test asserting
    that this projection copies a field nothing reads would defend the copy,
    not the property; if a future reporter starts printing the narrative, its
    own test is what should pin it.
    """
    verdict = state.get("verdict")
    reason = state.get("dream_reason") or (verdict.reason if verdict is not None else "")
    return DreamResult(
        proceeded=state.get("proceeded", False),
        accepted=state.get("written", False),
        reason=reason,
        verdict=verdict,
        narrative=state.get("narrative", ""),
        snapshot_ok=state.get("snapshot_ok", False),
        snapshot_reason=state.get("snapshot_reason"),
    )


def _cycle_granted_dream(state: CycleState) -> bool:
    """The cycle's 0-vs-75 decision, taken through `ActResult.grants_dream`
    -- design spec §7.1's ONE implementation, the same one `act` exits on and
    the same one `graph/cycle.py` routes on. Three copies of that rule is how
    the CLI and the graph come to disagree about whether a round counted.

    An outcome that was never decided is not a failure: `run_cycle` returns
    the accumulated state, and a resumed thread with nothing left to run
    carries whatever the interrupted run had already recorded.
    """
    outcome = state.get("outcome")
    if outcome is None:
        return True
    return ActResult(outcome=outcome).grants_dream


def _report_cycle_result(name: str, state: CycleState, *, dry_run: bool) -> None:
    """Both halves, in the order they happened, through the two renderers
    `act` and `dream` already use.

    The dream line is printed only when the dream phase actually ran --
    `proceeded` is absent entirely for an offline round, a dead backend, and
    a dry run, and printing `SKIP <name> -- ` with an empty reason for those
    would make three quite different rounds read identically.
    """
    act_result = _act_result_of(state)
    if act_result is not None:
        _report_act_result(name, act_result, dry_run=dry_run)
    if "proceeded" in state:
        _report_dream_result(name, _dream_result_of(state))


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
def cycle(
    name: str,
    dry_run: bool = typer.Option(False, "--dry-run", help="Plan only; execute and write nothing."),
    resume: bool = typer.Option(
        False, "--resume", help="Continue this account's last checkpointed cycle."
    ),
    auto: bool = typer.Option(False, "--auto", help="Honour the 12h dream cooldown."),
    budget: int = typer.Option(5, "--budget"),
    seed: int | None = typer.Option(
        None, "--seed", help="Seed the rhythm roll for reproducibility."
    ),
) -> None:
    """Python port of `cycle-one.sh`: login -> act -> dream -> logout, for one
    account, as ONE LangGraph run.

    Exit codes are `act`'s and `dream`'s (ruling R17), because `cycle-one.sh`
    and the heartbeat branch on exactly those three: `0` the cycle ran, `66`
    no such account, `75` a setup failure or a busy lease. `0` vs `75` is
    `ActResult.grants_dream` over the final state's outcome -- the same
    decision `act` exits on and the same one `cycle-one.sh` propagates when it
    forwards `auto-run.sh`'s rc.

    **`--auto` defaults to OFF, which is NOT `cycle-one.sh`'s default.** That
    script calls `dream.sh --auto "$NAME"` unless `FORCE_DREAM=1`, so a
    canary invocation that wants Bash's scheduling must pass `--auto` here
    too. The flag is spelled and defaulted exactly like `swil-agent dream`'s,
    so the CLI has one meaning for `--auto` rather than two; the difference is
    stated here instead of being absorbed silently.

    **`--dry-run` takes NO lease and NO checkpoint.** A shadow round executes
    nothing and writes nothing, so it needs no mutual exclusion -- and taking
    the lock costs a concurrent real Bash round its whole turn (F4). It also
    does not dream: `write_step`/`snapshot_step` have no `dry_run` to be inert
    under, so `graph/cycle.py` routes a dry cycle from the act phase straight
    to logout (design spec §9.4, "executes nothing and writes nothing").

    **`--resume`** continues the last checkpointed cycle for this account,
    reusing its `thread_id`. The round id is read back out of the checkpoint
    database (`latest_round_id`) rather than recomputed from the clock, which
    would produce a different thread and silently start a fresh cycle.
    """
    settings = load_settings()
    _attach_cycle_logs(settings)
    persona_source = _persona_source_for(settings)
    try:
        persona = _load_persona_or_raise_setup_error(persona_source, name)
    except FileNotFoundError as exc:
        typer.echo(f"no such account: {name}", err=True)
        raise typer.Exit(EXIT_NO_SUCH_ACCOUNT) from exc
    except Exception as exc:
        _skip_for_exception(name, exc)
        raise typer.Exit(EXIT_NO_ACTION) from exc

    # A shadow round never reaches the `gate` node, so it needs no embedder --
    # and starting one is not free: `EmbedderGuard.up()` writes
    # `.agent-state/embedder_guard/*` and `logs/embedder.log`, and can `nohup`
    # the bge-m3 daemon for up to 150s. `_dry_run_guard` is the no-op that
    # keeps `guard.up()`/`guard.down()` unconditional in the control flow (the
    # `finally` below must not have to know which kind it holds).
    guard: _Guard = _DryRunGuard() if dry_run else _guard_for(settings)
    try:
        guard.up()
        with (
            _cycle_stores(settings, dry_run=dry_run) as stores,
            _backend_setup_guard(persona),
            _lease_busy_guard(name),
        ):
            final = run_cycle(
                persona=persona,
                deps=_cycle_deps_for(
                    persona,
                    persona_source,
                    settings,
                    dry_run=dry_run,
                    auto=auto,
                    budget=budget,
                    seed=seed,
                ),
                lease_db=stores.lease_db,
                checkpointer=stores.checkpointer,
                round_id=(_resume_round_id(stores, agent_dir_name(persona)) if resume else None),
                resume=resume,
            )
    except Exception as exc:
        _skip_for_exception(name, exc)
        raise typer.Exit(EXIT_NO_ACTION) from exc
    finally:
        guard.down()

    _report_cycle_result(name, final, dry_run=dry_run)
    raise typer.Exit(EXIT_OK if _cycle_granted_dream(final) else EXIT_NO_ACTION)


@app.command()
def version() -> None:
    """Print the installed `swil-agent` package version."""
    typer.echo(f"swil-agent {__version__}")
