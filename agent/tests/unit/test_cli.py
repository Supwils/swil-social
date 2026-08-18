"""Tests for `swil_agent.cli` (task 13) -- the `swil-agent` entrypoints that
compose every layer built by Tasks 1-12 into `act`/`dream`/`version`
commands.

`cli.py` is the ONLY composition root in the package (module docstring), so
these tests exercise it two ways:

  * through `typer.testing.CliRunner`, with every network/subprocess-facing
    builder (`_resources_for`, `_backend_for`, `_embedder_for`, `_guard_for`,
    `_health_check`) monkeypatched to an in-memory fake -- a CLI test must
    never dial a real socket or spawn a real `claude`/`codex`/`bash` process;
  * directly, for the builder helpers themselves (`_resources_for` with a
    real `ApiClient` over `httpx.MockTransport`, `_health_check` the same
    way, `_probe_embedder` against a fake `EmbedderClient`), so the
    composition helpers are not only ever exercised through a monkeypatched
    substitute of themselves.

No test in this file ever calls the real `load_settings()` against
`agent/.env` -- that file is deliberately absent from this worktree (see
CLAUDE.md's "Manual deploys only" / the task-13 brief), and every test here
builds its own `Settings(agent_root=tmp_path, ...)` instead.
"""

from __future__ import annotations

import logging
import re
import time
from pathlib import Path

import httpx
import pytest
from typer.testing import CliRunner

from swil_agent import cli
from swil_agent.api.auth import PasswordAuth
from swil_agent.config import Settings
from swil_agent.embedder.client import EmbedderClient, EmbedderUnavailable
from swil_agent.embedder.guard import EmbedderGuard
from swil_agent.llm.base import (
    BackendBinaryMissingError,
    BackendUnavailableError,
    SubprocessRunner,
)
from swil_agent.locks import act_lock_path
from swil_agent.models import Persona
from swil_agent.persona.source import GitPersonaSource

from ._runners import FakeResources, StubBackend, TwoCallBackend

runner = CliRunner()

ZENITH_PERSONALITY = """# 测试用人格

## 身份
- **Username:** zenith
- **Display Name:** 测试
- **Headline:** AI Agent
- **Bio:** 一句话简介
- **Follow Topics:** alpha,beta

- **AI Backend:** claude

## 发帖节律
- 自由发挥，看心情
"""

_PROBABILISTIC_RHYTHM = ZENITH_PERSONALITY.replace(
    "- 自由发挥，看心情", "- 每次触发有 60% 概率选择 post"
)

_INITIAL_MEMORY = "2026-08-01 | act | did a thing\n"

_POST_PLAN = '{"plan":[{"action":"post","text":"hello from zenith"}]}'
_EMPTY_PLAN = '{"plan":[]}'


def _valid_dream_candidate() -> str:
    return ZENITH_PERSONALITY.replace("一句话简介", "改写后的简介")


def _bad_username_dream_candidate() -> str:
    return ZENITH_PERSONALITY.replace("- **Username:** zenith", "- **Username:** someone_else")


def _write_zenith(tmp_path: Path, *, personality: str = ZENITH_PERSONALITY) -> Path:
    directory = tmp_path / "agents" / "zenith"
    directory.mkdir(parents=True)
    (directory / "personality.md").write_text(personality, encoding="utf-8")
    (directory / "memory.md").write_text(_INITIAL_MEMORY, encoding="utf-8")
    return directory


class _FakeEmbedderClient:
    """A minimal `EmbedderClient` double: `.embed()` for the `Embedder`
    protocol `run_dream` needs, `.health()` for the R10 probe -- the real
    `EmbedderClient` is the only production type that carries both, so this
    stands in for the whole thing rather than composing two separate fakes.
    """

    def __init__(self, *, healthy: bool = True) -> None:
        self.healthy = healthy
        self.health_calls = 0

    def health(self) -> dict[str, object]:
        self.health_calls += 1
        if not self.healthy:
            raise EmbedderUnavailable("embedder down (test)")
        return {"ok": True}

    def embed(self, texts: list[str]) -> list[list[float]]:
        return [[1.0] for _ in texts]


class _FakeGuard:
    """A no-op `EmbedderGuard` double -- the real one shells out to
    `bash embedder-guard.sh up/down`, which a unit test must never do."""

    def __init__(self) -> None:
        self.up_calls = 0
        self.down_calls = 0

    def up(self) -> None:
        self.up_calls += 1

    def down(self) -> None:
        self.down_calls += 1


def _memory_unchanged(tmp_agent: Path) -> bool:
    path = tmp_agent / "agents" / "zenith" / "memory.md"
    return path.read_text(encoding="utf-8") == _INITIAL_MEMORY


def _hold_lock(tmp_agent: Path, name: str) -> None:
    """A FRESH lock file (mtime "now") -- FileLock treats it as actively
    held, not stale, so `run_act` must raise `LockBusy` rather than steal
    it."""
    path = act_lock_path(tmp_agent, name)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("999999\n", encoding="utf-8")


def _set_last_dream(tmp_agent: Path, name: str, *, hours_ago: float) -> None:
    """Writes the two on-disk cooldown markers `FilesystemDreamState` reads
    (`dream/candidate.py`'s `check_cooldown`), with a memlines snapshot
    matching the CURRENT memory.md so the delta is 0 -- well under
    `DREAM_MIN_NEW_MEMORIES` (8), so the cooldown-override path never
    fires and the account stays blocked."""
    state_dir = tmp_agent / ".agent-state"
    state_dir.mkdir(parents=True, exist_ok=True)
    at = int(time.time() - hours_ago * 3600)
    (state_dir / f"last_dream_{name}").write_text(str(at), encoding="utf-8")
    memory_path = tmp_agent / "agents" / name / "memory.md"
    memlines = memory_path.read_text(encoding="utf-8").count("\n")
    (state_dir / f"last_dream_memlines_{name}").write_text(str(memlines), encoding="utf-8")


@pytest.fixture
def tmp_agent(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """A one-account roster (`zenith`) under `tmp_path`, wired so `act`/
    `dream` never touch a real network, subprocess, or `agent/.env`.

    Every builder monkeypatch below can be overridden again inside an
    individual test (the `monkeypatch` fixture is shared, so a later
    `setattr` for the same name simply wins for that test).
    """
    _write_zenith(tmp_path)
    settings = Settings(agent_root=tmp_path)

    monkeypatch.setattr(cli, "load_settings", lambda: settings)
    monkeypatch.setattr(cli, "_resources_for", lambda persona, settings: FakeResources())
    monkeypatch.setattr(cli, "_backend_for", lambda persona, settings: StubBackend(_POST_PLAN))
    monkeypatch.setattr(cli, "_embedder_for", lambda settings: _FakeEmbedderClient())
    monkeypatch.setattr(cli, "_guard_for", lambda settings: _FakeGuard())
    monkeypatch.setattr(cli, "_health_check", lambda settings: True)
    return tmp_path


# ── act ──────────────────────────────────────────────────────────────────


def test_act_dry_run_executes_nothing_and_writes_nothing(tmp_agent: Path) -> None:
    result = runner.invoke(cli.app, ["act", "zenith", "--dry-run"])
    assert result.exit_code == 0
    assert "would execute" in result.stdout
    assert _memory_unchanged(tmp_agent)


def test_act_reports_the_outcome_name(tmp_agent: Path) -> None:
    result = runner.invoke(cli.app, ["act", "zenith", "--dry-run"])
    assert "planner_empty" in result.stdout or "landed" in result.stdout


def test_an_unknown_account_exits_66(tmp_agent: Path) -> None:
    result = runner.invoke(cli.app, ["act", "nosuchagent"])
    assert result.exit_code == 66


def test_a_held_lock_exits_75(tmp_agent: Path) -> None:
    _hold_lock(tmp_agent, "zenith")
    result = runner.invoke(cli.app, ["act", "zenith"])
    assert result.exit_code == 75


def test_a_real_act_run_lands_the_plan_and_exits_0(tmp_agent: Path) -> None:
    """Not `--dry-run`: the fake `Resources.create_post` really "lands", so
    the outcome is `landed_all` and a memory.md line IS appended -- the
    positive-path sibling of the dry-run inertness test above, proving
    `--dry-run`'s inertness is a real branch and not just the only path this
    suite exercises."""
    result = runner.invoke(cli.app, ["act", "zenith"])
    assert result.exit_code == 0
    assert "landed_all" in result.stdout
    assert not _memory_unchanged(tmp_agent)


def test_act_dry_run_with_an_empty_plan_reports_nothing_and_planner_empty(
    tmp_agent: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(cli, "_backend_for", lambda persona, settings: StubBackend(_EMPTY_PLAN))
    result = runner.invoke(cli.app, ["act", "zenith", "--dry-run"])
    assert result.exit_code == 0
    assert "(nothing)" in result.stdout
    assert "planner_empty" in result.stdout


def test_act_reports_vetoed_actions(tmp_agent: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A `codex` account may only `post`/`nothing` (contract `02` §1.1,
    `act/round.py`'s `allowed_for`) -- a `comment` is stripped by the
    guardrail allow-list stage and lands in `result.vetoed`, exercising the
    CLI's veto-reporting line."""
    directory = tmp_agent / "agents" / "zenith"
    personality = (directory / "personality.md").read_text(encoding="utf-8")
    (directory / "personality.md").write_text(
        personality.replace("- **AI Backend:** claude", "- **AI Backend:** codex"),
        encoding="utf-8",
    )
    comment_plan = f'{{"plan":[{{"action":"comment","postId":"{"p" * 24}","text":"hi"}}]}}'
    monkeypatch.setattr(cli, "_backend_for", lambda persona, settings: StubBackend(comment_plan))

    result = runner.invoke(cli.app, ["act", "zenith", "--dry-run"])
    assert "vetoed" in result.stdout


def test_act_with_no_credentials_skips_with_the_remedy_and_exits_75(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """No `api_key.txt` at all and no `SWIL_PASS` -- `resolve_auth` raises
    `ValueError`, which used to escape `act` as a raw traceback and exit 1,
    a code neither `cycle-one.sh` nor the heartbeat knows how to interpret.
    `_resources_for` runs for REAL here (unlike every other test in this
    file, which monkeypatches it away) -- this test exists specifically to
    prove the exception this function can actually raise is caught, not a
    stand-in's."""
    _write_zenith(tmp_path)  # no api_key.txt written
    settings = Settings(agent_root=tmp_path, swil_url="https://example.test")
    monkeypatch.setattr(cli, "load_settings", lambda: settings)

    result = runner.invoke(cli.app, ["act", "zenith"])

    assert result.exit_code == 75
    assert "zenith" in result.stdout
    assert "create-api-key" in result.stdout
    assert "SWIL_PASS" in result.stdout
    assert "Traceback" not in result.stdout
    assert result.exception is None or isinstance(result.exception, SystemExit)


def test_act_with_a_blank_api_key_file_skips_with_the_remedy_and_exits_75(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The other half of spec §15.1 row 3: a PRESENT but blank `api_key.txt`
    raises `ValueError` from `ApiKeyAuth.from_file`, not `FileNotFoundError`
    -- `resolve_auth` already catches both shapes correctly (api/auth.py),
    so this must reach the exact same SKIP/exit-75 path as the missing-file
    case above, not a different, uncaught one."""
    directory = _write_zenith(tmp_path)
    (directory / "api_key.txt").write_text("   \n", encoding="utf-8")
    settings = Settings(agent_root=tmp_path, swil_url="https://example.test")
    monkeypatch.setattr(cli, "load_settings", lambda: settings)

    result = runner.invoke(cli.app, ["act", "zenith"])

    assert result.exit_code == 75
    assert "zenith" in result.stdout
    assert "create-api-key" in result.stdout
    assert "Traceback" not in result.stdout


class _FailingPasswordAuth(PasswordAuth):
    """A `PasswordAuth` whose `login()` fails deterministically, with no
    network involved -- `isinstance(auth, PasswordAuth)` is a real subclass
    check inside `_resources_for`, so this is the only way to force that
    branch's `login()` call to raise without a `transport=` seam (the full
    `CliRunner` path never threads one through)."""

    def login(self, client: object) -> None:
        raise RuntimeError("login succeeded but no sid cookie was returned")


def test_act_with_an_unparseable_persona_skips_with_the_remedy_and_exits_75(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`load_persona` raises `ValueError` (not `FileNotFoundError`) for a
    personality.md that EXISTS but has no `- **Username:**` bullet
    (persona/loader.py). That is a different failure than "no such
    account" -- the file is right there -- so it must land on exit 75 with
    a remedy naming the bullet, not exit 66 or a raw traceback."""
    directory = tmp_path / "agents" / "zenith"
    directory.mkdir(parents=True)
    (directory / "personality.md").write_text("# no bullets here at all\n", encoding="utf-8")
    (directory / "memory.md").write_text("", encoding="utf-8")
    settings = Settings(agent_root=tmp_path)
    monkeypatch.setattr(cli, "load_settings", lambda: settings)

    result = runner.invoke(cli.app, ["act", "zenith"])

    assert result.exit_code == 75
    assert "zenith" in result.stdout
    assert "Username" in result.stdout
    assert "Traceback" not in result.stdout


def test_act_with_a_dead_deepseek_key_skips_with_the_remedy_and_exits_75(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`_backend_for` runs for REAL here -- only `build_backend` (the
    function it calls internally) is faked, deterministically, to raise the
    exact `BackendUnavailableError` a missing `~/.claude/.deepseek-key`
    produces in production, without this test ever touching that real file
    (whose presence/absence would otherwise make the test machine-
    dependent)."""
    directory = _write_zenith(tmp_path)
    (directory / "personality.md").write_text(
        ZENITH_PERSONALITY.replace("- **AI Backend:** claude", "- **AI Backend:** deepseek"),
        encoding="utf-8",
    )
    settings = Settings(agent_root=tmp_path)
    monkeypatch.setattr(cli, "load_settings", lambda: settings)
    monkeypatch.setattr(cli, "_resources_for", lambda persona, settings: FakeResources())
    monkeypatch.setattr(cli, "_health_check", lambda settings: True)

    def _dead_key(
        name: str, runner: object, settings: Settings, *, deepseek_api_key: str | None = None
    ) -> object:
        raise BackendUnavailableError("deepseek key not found at /fake/.claude/.deepseek-key")

    monkeypatch.setattr(cli, "build_backend", _dead_key)

    result = runner.invoke(cli.app, ["act", "zenith"])

    assert result.exit_code == 75
    assert "zenith" in result.stdout
    assert ".deepseek-key" in result.stdout
    assert "Traceback" not in result.stdout


def test_act_with_a_failed_login_skips_with_the_remedy_and_exits_75(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The `SWIL_PASS`-fallback sibling of the credentials tests above: this
    account HAS a working fallback (`SWIL_PASS` is set), but the login
    itself fails -- the coordinator's ranking of this as the most likely of
    the three escape paths to fire in real use, since it can trip on every
    invocation of a `SWIL_PASS` account, not only once at setup."""
    _write_zenith(tmp_path)
    settings = Settings(agent_root=tmp_path, swil_url="https://example.test", swil_pass="wrongpass")
    monkeypatch.setattr(cli, "load_settings", lambda: settings)
    monkeypatch.setattr(cli, "_health_check", lambda settings: True)
    monkeypatch.setattr(
        cli,
        "resolve_auth",
        lambda directory, *, username, password: _FailingPasswordAuth(username, password),
    )

    result = runner.invoke(cli.app, ["act", "zenith"])

    assert result.exit_code == 75
    assert "zenith" in result.stdout
    assert "SWIL_PASS" in result.stdout
    assert "Traceback" not in result.stdout


class _InjectedBugError(Exception):
    """A stand-in for a genuine programming error -- deliberately NOT an
    `AccountSetupError` or `LockBusy`, so it cannot be misclassified as a
    known setup failure. Injected directly into the composition root
    (`_resources_for`), per the coordinator's instruction, rather than by
    contriving a real dependency to break."""


def test_act_an_unexpected_composition_failure_exits_75_and_logs_unexpected(
    tmp_agent: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    def _boom(persona: Persona, settings: Settings) -> FakeResources:
        raise _InjectedBugError("boom -- not a setup failure")

    monkeypatch.setattr(cli, "_resources_for", _boom)

    with caplog.at_level("DEBUG"):
        result = runner.invoke(cli.app, ["act", "zenith"])

    assert result.exit_code == 75
    assert "UNEXPECTED _InjectedBugError" in result.stdout
    assert "boom -- not a setup failure" in result.stdout
    assert "Traceback" not in result.stdout
    debug_records = [r for r in caplog.records if r.levelname == "DEBUG"]
    assert len(debug_records) == 1
    assert debug_records[0].exc_info is not None
    assert debug_records[0].exc_info[0] is _InjectedBugError


def test_act_seed_makes_the_rhythm_roll_reproducible(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`--seed` exists so the rhythm roll (a `random.Random` draw made
    before the LLM is ever called, `persona/rhythm.py`) is reproducible --
    without it, the shadow round could not compare Python's rhythm verdict
    against Bash's on a probabilistic account. Two invocations with the
    SAME seed against a persona whose rhythm section has a real "N% 概率选择
    post" clause must report the identical rhythm decision both times."""
    _write_zenith(tmp_path, personality=_PROBABILISTIC_RHYTHM)
    settings = Settings(agent_root=tmp_path)
    monkeypatch.setattr(cli, "load_settings", lambda: settings)
    monkeypatch.setattr(cli, "_resources_for", lambda persona, settings: FakeResources())
    monkeypatch.setattr(cli, "_backend_for", lambda persona, settings: StubBackend(_POST_PLAN))
    monkeypatch.setattr(cli, "_health_check", lambda settings: True)

    first = runner.invoke(cli.app, ["act", "zenith", "--dry-run", "--seed", "7"])
    second = runner.invoke(cli.app, ["act", "zenith", "--dry-run", "--seed", "7"])

    assert first.exit_code == 0
    assert first.stdout == second.stdout


# ── dream ────────────────────────────────────────────────────────────────


def test_dream_honours_auto_cooldown(tmp_agent: Path) -> None:
    _set_last_dream(tmp_agent, "zenith", hours_ago=1)
    result = runner.invoke(cli.app, ["dream", "zenith", "--auto"])
    assert "cooldown" in result.stdout
    assert result.exit_code == 75


def test_dream_an_unknown_account_exits_66(tmp_agent: Path) -> None:
    result = runner.invoke(cli.app, ["dream", "nosuchagent"])
    assert result.exit_code == 66


def test_dream_a_held_lock_exits_75(tmp_agent: Path) -> None:
    from swil_agent.locks import dream_lock_path

    path = dream_lock_path(tmp_agent, "zenith")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("999999\n", encoding="utf-8")

    result = runner.invoke(cli.app, ["dream", "zenith"])
    assert result.exit_code == 75


def test_dream_with_no_credentials_skips_with_the_remedy_and_exits_75(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`dream`'s sibling of the `act` credentials test above: `_resources_for`
    is built inside `_do_dream`, reached only after `_embedder_for`/
    `_guard_for` -- those two are faked here (never the point of this test)
    so the only real thing running is auth resolution against a REAL,
    credential-less `tmp_path` roster. The guard must still bracket cleanly
    (`up()` then `down()`, exactly once each) even on this failure path."""
    _write_zenith(tmp_path)  # no api_key.txt written
    settings = Settings(agent_root=tmp_path, swil_url="https://example.test")
    guard = _FakeGuard()
    monkeypatch.setattr(cli, "load_settings", lambda: settings)
    monkeypatch.setattr(cli, "_embedder_for", lambda settings: _FakeEmbedderClient())
    monkeypatch.setattr(cli, "_guard_for", lambda settings: guard)

    result = runner.invoke(cli.app, ["dream", "zenith"])

    assert result.exit_code == 75
    assert "zenith" in result.stdout
    assert "create-api-key" in result.stdout
    assert "SWIL_PASS" in result.stdout
    assert "Traceback" not in result.stdout
    assert guard.up_calls == 1
    assert guard.down_calls == 1


def test_dream_with_a_blank_api_key_file_skips_with_the_remedy_and_exits_75(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The blank-file half of spec §15.1 row 3, for `dream` -- see the `act`
    sibling test above for why both shapes need their own coverage."""
    directory = _write_zenith(tmp_path)
    (directory / "api_key.txt").write_text("   \n", encoding="utf-8")
    settings = Settings(agent_root=tmp_path, swil_url="https://example.test")
    monkeypatch.setattr(cli, "load_settings", lambda: settings)
    monkeypatch.setattr(cli, "_embedder_for", lambda settings: _FakeEmbedderClient())
    monkeypatch.setattr(cli, "_guard_for", lambda settings: _FakeGuard())

    result = runner.invoke(cli.app, ["dream", "zenith"])

    assert result.exit_code == 75
    assert "zenith" in result.stdout
    assert "create-api-key" in result.stdout
    assert "Traceback" not in result.stdout


def test_dream_with_an_unparseable_persona_skips_with_the_remedy_and_exits_75(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`dream`'s sibling of the `act` unparseable-persona test -- this one
    also proves the embedder guard is never started at all when persona
    loading fails, since that failure is caught in `dream`'s FIRST try
    block, before `guard.up()` is ever reached."""
    directory = tmp_path / "agents" / "zenith"
    directory.mkdir(parents=True)
    (directory / "personality.md").write_text("# no bullets here at all\n", encoding="utf-8")
    (directory / "memory.md").write_text("", encoding="utf-8")
    settings = Settings(agent_root=tmp_path)
    guard = _FakeGuard()
    monkeypatch.setattr(cli, "load_settings", lambda: settings)
    monkeypatch.setattr(cli, "_guard_for", lambda settings: guard)

    result = runner.invoke(cli.app, ["dream", "zenith"])

    assert result.exit_code == 75
    assert "zenith" in result.stdout
    assert "Username" in result.stdout
    assert "Traceback" not in result.stdout
    assert guard.up_calls == 0
    assert guard.down_calls == 0


def test_dream_an_unexpected_composition_failure_exits_75_logs_unexpected_and_stops_the_guard(
    tmp_agent: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """The `dream` sibling of the `act` UNEXPECTED test -- this one also
    proves the SECOND try block's `finally: guard.down()` still runs on an
    unexpected exception, not only on the known ones the other guard-bracket
    test exercises."""
    guard = _FakeGuard()
    monkeypatch.setattr(cli, "_guard_for", lambda settings: guard)

    def _boom(settings: Settings) -> EmbedderClient:
        raise _InjectedBugError("boom -- not a setup failure")

    monkeypatch.setattr(cli, "_embedder_for", _boom)

    with caplog.at_level("DEBUG"):
        result = runner.invoke(cli.app, ["dream", "zenith"])

    assert result.exit_code == 75
    assert "UNEXPECTED _InjectedBugError" in result.stdout
    assert "Traceback" not in result.stdout
    assert guard.up_calls == 1
    assert guard.down_calls == 1


def test_dream_guard_brackets_the_whole_call_up_then_down(
    tmp_agent: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """R10 (progress.md task 2/12 forward requirement): the CLI, not
    `run_dream`, owns the embedder guard bracket -- `run_dream`'s own
    docstring documents this explicitly. Proves `up()` runs before `down()`
    and both run exactly once for a single `dream` invocation."""
    guard = _FakeGuard()
    monkeypatch.setattr(cli, "_guard_for", lambda settings: guard)

    _set_last_dream(tmp_agent, "zenith", hours_ago=1)  # cheapest path: cooldown SKIP
    runner.invoke(cli.app, ["dream", "zenith", "--auto"])

    assert guard.up_calls == 1
    assert guard.down_calls == 1


def test_dream_logs_loudly_once_when_embedder_is_down_after_guard_up(
    tmp_agent: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """R10: `EmbedderGuard.up()` cannot fail loudly (`embedder-guard.sh`
    always exits 0), so a dead embedder must be surfaced by an explicit
    post-`up()` health probe, logged at ERROR -- once per CLI invocation,
    not once per dream (that per-dream granularity is `evaluate_candidate`'s
    own WARN, which is deliberately a different, quieter signal). Blocking
    the account on cooldown keeps this test from needing a working
    backend/runner -- the probe fires before the cooldown check either way."""
    monkeypatch.setattr(cli, "_embedder_for", lambda settings: _FakeEmbedderClient(healthy=False))
    _set_last_dream(tmp_agent, "zenith", hours_ago=1)

    with caplog.at_level("ERROR"):
        runner.invoke(cli.app, ["dream", "zenith", "--auto"])

    errors = [r for r in caplog.records if r.levelname == "ERROR"]
    assert len(errors) == 1
    assert "embedder" in errors[0].getMessage().lower()


def test_dream_force_mode_accepts_and_reports_acceptance(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Force mode (no `--auto`) always proceeds past cooldown -- a real,
    end-to-end accepted dream, not just the cooldown-SKIP path the other
    dream tests use to stay cheap. `drift_mode="scalar"` keeps this test
    from needing a working aspect-distiller runner: the fake embedder
    returns the SAME vector for every text, so the scalar cosine similarity
    is 1.0, comfortably above the 0.82 accept threshold."""
    _write_zenith(tmp_path)
    settings = Settings(agent_root=tmp_path, drift_mode="scalar")
    monkeypatch.setattr(cli, "load_settings", lambda: settings)
    monkeypatch.setattr(cli, "_resources_for", lambda persona, settings: FakeResources())
    monkeypatch.setattr(
        cli,
        "_backend_for",
        lambda persona, settings: TwoCallBackend(candidate_response=_valid_dream_candidate()),
    )
    monkeypatch.setattr(cli, "_embedder_for", lambda settings: _FakeEmbedderClient())
    monkeypatch.setattr(cli, "_guard_for", lambda settings: _FakeGuard())

    result = runner.invoke(cli.app, ["dream", "zenith"])
    assert result.exit_code == 0
    assert "dream accepted" in result.stdout


def test_dream_force_mode_rejects_a_structurally_bad_candidate(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`proceeded=True, accepted=False` -- the LLM ran and produced a
    verdict, it just was not accepted (a mangled `Username` bullet fails
    `persona/validators.py`'s structural check before the drift gate is
    ever reached). Exit code is still 0 ("something ran"), matching `act`'s
    own "attempted, whether it landed or not" shape."""
    _write_zenith(tmp_path)
    settings = Settings(agent_root=tmp_path, drift_mode="scalar")
    monkeypatch.setattr(cli, "load_settings", lambda: settings)
    monkeypatch.setattr(cli, "_resources_for", lambda persona, settings: FakeResources())
    monkeypatch.setattr(
        cli,
        "_backend_for",
        lambda persona, settings: TwoCallBackend(
            candidate_response=_bad_username_dream_candidate()
        ),
    )
    monkeypatch.setattr(cli, "_embedder_for", lambda settings: _FakeEmbedderClient())
    monkeypatch.setattr(cli, "_guard_for", lambda settings: _FakeGuard())

    result = runner.invoke(cli.app, ["dream", "zenith"])
    assert result.exit_code == 0
    assert "dream rejected" in result.stdout


def test_dream_does_not_log_when_embedder_is_healthy(
    tmp_agent: Path, caplog: pytest.LogCaptureFixture
) -> None:
    _set_last_dream(tmp_agent, "zenith", hours_ago=1)
    with caplog.at_level("ERROR"):
        runner.invoke(cli.app, ["dream", "zenith", "--auto"])
    assert [r for r in caplog.records if r.levelname == "ERROR"] == []


# ── version ──────────────────────────────────────────────────────────────


def test_version_prints_the_package_version() -> None:
    from swil_agent import __version__

    result = runner.invoke(cli.app, ["version"])
    assert result.exit_code == 0
    assert __version__ in result.stdout


# ── composition helpers, exercised directly (not only via a monkeypatch) ──


def test_resources_for_prefers_the_api_key_and_never_logs_in(tmp_path: Path) -> None:
    from swil_agent.persona.loader import load_persona

    directory = _write_zenith(tmp_path)
    (directory / "api_key.txt").write_text("secret-key\n", encoding="utf-8")
    persona = load_persona(directory)
    settings = Settings(agent_root=tmp_path, swil_url="https://example.test")

    seen_paths: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen_paths.append(request.url.path)
        raise AssertionError(f"unexpected request to {request.url.path}")

    resources = cli._resources_for(persona, settings, transport=httpx.MockTransport(handler))
    assert seen_paths == []  # no login call for a bearer-token account
    assert resources is not None


def test_resources_for_logs_in_when_falling_back_to_password_auth(tmp_path: Path) -> None:
    from swil_agent.persona.loader import load_persona

    directory = _write_zenith(tmp_path)  # no api_key.txt written
    persona = load_persona(directory)
    settings = Settings(agent_root=tmp_path, swil_url="https://example.test", swil_pass="hunter2")

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/v1/auth/login"
        return httpx.Response(200, json={"data": {}}, headers={"set-cookie": "sid=abc123; Path=/"})

    cli._resources_for(persona, settings, transport=httpx.MockTransport(handler))


def test_health_check_true_on_200(tmp_path: Path) -> None:
    settings = Settings(agent_root=tmp_path, swil_url="https://example.test")

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/health"
        return httpx.Response(200)

    assert cli._health_check(settings, transport=httpx.MockTransport(handler)) is True


def test_health_check_false_on_non_200(tmp_path: Path) -> None:
    settings = Settings(agent_root=tmp_path, swil_url="https://example.test")

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503)

    assert cli._health_check(settings, transport=httpx.MockTransport(handler)) is False


def test_health_check_false_on_transport_error(tmp_path: Path) -> None:
    settings = Settings(agent_root=tmp_path, swil_url="https://example.test")

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=request)

    assert cli._health_check(settings, transport=httpx.MockTransport(handler)) is False


def test_context_now_and_feed_context_fall_back_when_absent(tmp_path: Path) -> None:
    settings = Settings(agent_root=tmp_path)
    assert cli._context_now_for(settings) == "(no context file)"
    assert cli._feed_context_for(settings, "zenith") == ""


def test_context_now_reads_the_login_written_file(tmp_path: Path) -> None:
    (tmp_path / "context").mkdir()
    (tmp_path / "context" / "now.md").write_text("today's news\n", encoding="utf-8")
    settings = Settings(agent_root=tmp_path)
    assert cli._context_now_for(settings) == "today's news\n"


def test_persona_source_for_returns_a_working_git_persona_source(tmp_path: Path) -> None:
    _write_zenith(tmp_path)
    settings = Settings(agent_root=tmp_path)
    source = cli._persona_source_for(settings)
    assert isinstance(source, GitPersonaSource)
    assert source.load("zenith").username == "zenith"


def test_backend_for_builds_the_claude_backend_for_a_claude_persona(tmp_path: Path) -> None:
    settings = Settings(agent_root=tmp_path)
    persona = Persona(username="zenith", directory=tmp_path, backend="claude", raw="")
    backend = cli._backend_for(persona, settings)
    assert backend.name == "claude"


def test_embedder_for_builds_a_real_embedder_client(tmp_path: Path) -> None:
    settings = Settings(agent_root=tmp_path, embedder_url="http://127.0.0.1:7777")
    embedder = cli._embedder_for(settings)
    assert isinstance(embedder, EmbedderClient)


def test_guard_for_builds_a_real_embedder_guard(tmp_path: Path) -> None:
    settings = Settings(agent_root=tmp_path)
    guard = cli._guard_for(settings)
    assert isinstance(guard, EmbedderGuard)


# ── F6: agent/logs/auto-run.log (auto-run.sh's `_log`) ────────────────────


_ROUND_LOG_LINE_RE = re.compile(r"^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] (?P<body>.+)$")


def _round_log_lines(agent_root: Path, filename: str = "auto-run.log") -> list[str]:
    """Lines of ONE of the two round logs. `filename` is explicit and has a
    default only because most callers here are act-path tests; the two files
    are genuinely different destinations (`auto-run.sh:34` vs
    `dream.sh:40`), never two names for one."""
    path = agent_root / "logs" / filename
    if not path.is_file():
        return []
    return [line for line in path.read_text(encoding="utf-8").splitlines() if line]


@pytest.fixture
def round_log_level(caplog: pytest.LogCaptureFixture) -> None:
    """Restore the level a REAL `swil-agent` process runs at.

    `_main`'s `logging.basicConfig(level=INFO)` passes `force=False`, so in a
    real process (no handlers configured yet) it sets the root level to INFO
    and the round log sees INFO records. Under pytest the logging plugin has
    already installed root handlers, so that `basicConfig` is a no-op and the
    root level stays at WARNING -- an artefact of the harness, not of the
    code. Setting it here makes these tests observe production behaviour;
    it is deliberately NOT done by pinning a level onto the `swil_agent`
    logger in `cli.py`, which would leak across tests and swallow the DEBUG
    traceback `_skip_for_exception` relies on.
    """
    caplog.set_level(logging.INFO)


def test_act_writes_the_executor_log_line_into_auto_run_log(
    tmp_agent: Path, round_log_level: None
) -> None:
    """The 17 `ExecutionOutcome.log_line` values were computed and dropped:
    nothing in the package logged them and nothing wrote a file at all, so a
    Python round left `agent/logs/auto-run.log` untouched -- which reads
    exactly like a round that never happened to the straggler-reconciliation
    and post-run-QA greps every round of this project ends with.

    Mutation this catches, either half: deleting `execute_action`'s
    `logger.log(...)` call, or deleting `_attach_round_log(settings)` from
    the `act` command.
    """
    result = runner.invoke(cli.app, ["act", "zenith"])
    assert result.exit_code == 0

    bodies = [
        m.group("body")
        for line in _round_log_lines(tmp_agent)
        if (m := _ROUND_LOG_LINE_RE.match(line))
    ]
    assert any(b.startswith("DONE zenith posted") for b in bodies), bodies


def test_the_round_log_line_is_in_bash_s_format(tmp_agent: Path, round_log_level: None) -> None:
    """`_log`'s format is `[%Y-%m-%d %H:%M:%S] <message>` -- a bracketed
    timestamp and then the message, with NO level name. Mutation this
    catches: reusing `basicConfig`'s `"%(levelname)s %(message)s"` for the
    file handler, which prefixes every line with `INFO`/`WARNING` and breaks
    a `grep '^\\[.*\\] DONE'` that has worked against this file for months.
    """
    runner.invoke(cli.app, ["act", "zenith"])
    lines = _round_log_lines(tmp_agent)
    assert lines, "no round log written at all"
    for line in lines:
        assert _ROUND_LOG_LINE_RE.match(line), line
        assert not line.startswith("INFO")
        body = _ROUND_LOG_LINE_RE.match(line).group("body")  # type: ignore[union-attr]
        assert not body.startswith(("INFO ", "WARNING ", "DEBUG "))


def test_the_round_log_appends_across_invocations_without_duplicating(
    tmp_agent: Path, round_log_level: None
) -> None:
    """Bash appends (`>>`), so a second round adds to the file rather than
    truncating it. And `_attach_round_log` must stay idempotent: a second
    handler on the same logger would write every line of the SECOND round
    twice, which would silently inflate every count anyone greps out of this
    file. Mutation this catches: dropping the `baseFilename` short-circuit.
    """
    runner.invoke(cli.app, ["act", "zenith"])
    first = _round_log_lines(tmp_agent)
    runner.invoke(cli.app, ["act", "zenith"])
    second = _round_log_lines(tmp_agent)

    assert second[: len(first)] == first  # appended, not truncated
    added = second[len(first) :]
    assert len(added) == len(first)  # exactly one more round's worth, not two


def test_a_dry_run_writes_no_executor_lines(tmp_agent: Path, round_log_level: None) -> None:
    """`--dry-run` executes nothing, so there is no DONE/WARN/SKIP line to
    write. It may still open the file (harmless); what it must not do is
    claim an action landed."""
    runner.invoke(cli.app, ["act", "zenith", "--dry-run"])
    assert not any("DONE zenith posted" in line for line in _round_log_lines(tmp_agent))


# ── F5: a missing backend BINARY is a setup failure (75), never 66 ────────


class _MissingBinaryBackend:
    """A `Backend` whose `complete()` fails the way a real one does when its
    CLI is absent from PATH.

    `SubprocessRunner.run` re-raises `subprocess`'s own `FileNotFoundError`
    as `BackendBinaryMissingError` (`llm/base.py`), so this reproduces what
    `run_act`/`run_dream` actually see -- rather than a hand-written
    `FileNotFoundError`, which would only test the guard's shape and not the
    translation the fix depends on. The translation itself is pinned
    separately by
    `test_subprocess_runner_reports_a_missing_binary_as_its_own_type`.
    """

    name = "codex"

    def complete(self, req: object) -> str:
        raise BackendBinaryMissingError("executable not found on PATH: 'codex'")


def test_act_a_missing_backend_binary_exits_75_with_a_remedy(tmp_agent: Path) -> None:
    """It used to exit 66, "no such account", because `act` wrapped the whole
    round in one `except FileNotFoundError` and `subprocess` raises exactly
    that type for a missing argv[0]. This project has already burned real
    time on "no response from codex" incidents; an exit code naming the
    roster instead of PATH makes the next one worse.

    Mutation this catches, either half: reverting `act` to a single `try`
    with a round-wide `except FileNotFoundError`, or removing
    `SubprocessRunner`'s re-raise so a raw `FileNotFoundError` escapes again.
    """
    monkeypatch_backend = _MissingBinaryBackend()
    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(cli, "_backend_for", lambda persona, settings: monkeypatch_backend)
        result = runner.invoke(cli.app, ["act", "zenith"])

    assert result.exit_code == 75
    assert "SKIP zenith" in result.stdout
    assert "executable not found on PATH: 'codex'" in result.stdout
    # A REMEDY, not just a cause -- `AccountSetupError`'s whole contract.
    assert "on PATH and authenticated" in result.stdout
    # And never misclassified as a bug.
    assert "UNEXPECTED" not in result.stdout


def test_dream_a_missing_backend_binary_exits_75_with_a_remedy(tmp_agent: Path) -> None:
    """Same guard on the dream path, where the failure previously read as
    `UNEXPECTED FileNotFoundError` -- exit 75 already, but rendered as a
    programming error rather than a fixable setup problem.

    Mutation this catches: making `BackendBinaryMissingError` a SUBCLASS of
    `BackendUnavailableError`. `dream/round.py`'s `_generate_candidate`
    catches that type and degrades to `""`, so the missing binary would be
    reported as "LLM returned empty" and the command would exit 0 -- the
    "whole round silently drops every account on one backend" shape
    CLAUDE.md already records."""
    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(cli, "_backend_for", lambda persona, settings: _MissingBinaryBackend())
        result = runner.invoke(cli.app, ["dream", "zenith"])

    assert result.exit_code == 75
    assert "executable not found on PATH: 'codex'" in result.stdout
    assert "on PATH and authenticated" in result.stdout
    assert "UNEXPECTED" not in result.stdout


def test_a_genuinely_absent_account_still_exits_66(tmp_agent: Path) -> None:
    """The other side of the F5 change: 66 must keep meaning exactly one
    thing. Mutation this catches: deleting `act`'s first `except
    FileNotFoundError`, which would fold "no such account" into the generic
    75 guard and lose the distinction entirely."""
    result = runner.invoke(cli.app, ["act", "does-not-exist"])
    assert result.exit_code == 66
    assert "no such account: does-not-exist" in result.output


def test_subprocess_runner_reports_a_missing_binary_as_its_own_type() -> None:
    """The translation itself, at the layer that performs it, against a
    genuinely absent binary. `return ""` would have been the tempting
    alternative and is worse: an empty string is indistinguishable from a
    dead LLM, so the diagnosis cost is unchanged."""
    with pytest.raises(BackendBinaryMissingError, match="executable not found on PATH"):
        SubprocessRunner().run(["swil-agent-no-such-binary-xyz"])


# ── R20: the two round logs are two different files ───────────────────────


def test_a_dream_writes_dream_log_and_leaves_auto_run_log_alone(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, round_log_level: None
) -> None:
    """`dream.sh:36-40` sets `LOG_FILE="$LOG_DIR/dream.log"`;
    `auto-run.sh:31-34` sets `LOG_FILE="$LOG_DIR/auto-run.log"`. Two live
    files -- both present and written on the same day in the main checkout
    (auto-run.log 1.0MB, dream.log 234KB) -- not two names for one.

    `_attach_round_log` hardcoded `auto-run.log` for BOTH commands, so Python
    dreams appended dream verdicts into the act log while `dream.log` stayed
    empty. Nothing caught it: deleting the `dream` command's
    `_attach_round_log` call broke ZERO tests, because the only assertions
    that existed were act-path ones.

    Mutations this catches, all three:
      * passing `ACT_LOG_FILENAME` from `dream` (the original defect) --
        `dream.log` is then empty and `auto-run.log` holds the dream line;
      * deleting `dream`'s `_attach_round_log` call entirely -- `dream.log`
        is never created;
      * swapping the two constants' values.
    """
    _write_zenith(tmp_path)
    settings = Settings(agent_root=tmp_path, drift_mode="scalar")
    monkeypatch.setattr(cli, "load_settings", lambda: settings)
    monkeypatch.setattr(cli, "_resources_for", lambda persona, settings: FakeResources())
    monkeypatch.setattr(
        cli,
        "_backend_for",
        lambda persona, settings: TwoCallBackend(candidate_response=_valid_dream_candidate()),
    )
    monkeypatch.setattr(cli, "_embedder_for", lambda settings: _FakeEmbedderClient())
    monkeypatch.setattr(cli, "_guard_for", lambda settings: _FakeGuard())

    result = runner.invoke(cli.app, ["dream", "zenith"])
    assert result.exit_code == 0

    dream_lines = _round_log_lines(tmp_path, "dream.log")
    assert any("dreamed" in line for line in dream_lines), dream_lines
    for line in dream_lines:
        assert _ROUND_LOG_LINE_RE.match(line), line
    # The act log must not exist at all -- a dream never appends to it.
    assert _round_log_lines(tmp_path, "auto-run.log") == []


def test_an_act_writes_auto_run_log_and_leaves_dream_log_alone(
    tmp_agent: Path, round_log_level: None
) -> None:
    """The mirror assertion, so the pair pins the mapping in BOTH directions:
    swapping `ACT_LOG_FILENAME` and `DREAM_LOG_FILENAME` breaks this one as
    well as the dream one, where either test alone would let a swap through
    if the other command were never exercised."""
    result = runner.invoke(cli.app, ["act", "zenith"])
    assert result.exit_code == 0

    assert any("DONE zenith posted" in line for line in _round_log_lines(tmp_agent))
    assert _round_log_lines(tmp_agent, "dream.log") == []


def test_the_two_log_filenames_are_the_ones_the_scripts_use() -> None:
    """Pinned as literals against the scripts, so a rename shows up here
    rather than as a silently-empty file someone greps months later."""
    assert cli.ACT_LOG_FILENAME == "auto-run.log"
    assert cli.DREAM_LOG_FILENAME == "dream.log"
