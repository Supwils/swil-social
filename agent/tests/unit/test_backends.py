import os
import sys
import threading
from pathlib import Path

import pytest

from swil_agent.config import Settings
from swil_agent.llm.base import (
    BackendUnavailableError,
    CompletionRequest,
    SubprocessRunner,
    build_backend,
)
from tests.unit._runners import RecordingRunner


def _settings() -> Settings:
    return Settings(swil_url="https://example.test")


def test_claude_puts_user_prompt_on_stdin() -> None:
    runner = RecordingRunner("hello")
    backend = build_backend("claude", runner, _settings())
    out = backend.complete(CompletionRequest(system="SYS", user="USR", model="haiku"))
    assert out == "hello"
    call = runner.calls[0]
    assert call.stdin == "USR"
    argv = call.argv
    assert isinstance(argv, list)
    assert argv[:2] == ["claude", "-p"]
    assert "--model" in argv and "haiku" in argv
    assert "--system-prompt" in argv and "SYS" in argv


def test_claude_omits_model_flag_when_model_is_none() -> None:
    runner = RecordingRunner("hello")
    build_backend("claude", runner, _settings()).complete(
        CompletionRequest(system="S", user="U", model=None)
    )
    argv = runner.calls[0].argv
    assert isinstance(argv, list)
    assert "--model" not in argv


def test_codex_uses_exec_and_reads_an_output_file(tmp_path: Path) -> None:
    class CodexRunner(RecordingRunner):
        def run(
            self,
            argv: list[str],
            stdin: str | None = None,
            env: dict[str, str] | None = None,
            timeout: float = 300.0,
        ) -> str:
            super().run(argv, stdin, env, timeout)
            out_index = argv.index("-o") + 1
            Path(argv[out_index]).write_text("codex said this", encoding="utf-8")
            return ""

    runner = CodexRunner()
    out = build_backend("codex", runner, _settings()).complete(
        CompletionRequest(system="SYS", user="USR", model=None)
    )
    assert out == "codex said this"
    argv = runner.calls[0].argv
    assert isinstance(argv, list)
    assert argv[:2] == ["codex", "exec"]
    for flag in ("--ephemeral", "--skip-git-repo-check", "--full-auto", "--color", "-o"):
        assert flag in argv
    prompt = argv[-1]
    assert prompt.startswith("System:\nSYS")
    assert prompt.endswith("USR")


def test_codex_concurrent_calls_never_collide_on_the_same_output_file() -> None:
    """Regression guard: `swil.sh`'s mktemp template had its X's in the wrong
    (non-trailing) position, so concurrent image posts collided on one fixed
    filename and one call's output silently clobbered the other's.

    Genuinely concurrent (real OS threads, synchronized on a barrier so they
    enter `complete()` — and therefore `tempfile.NamedTemporaryFile` — at
    essentially the same instant), not five sequential calls: a sequential
    loop can never observe a collision even against the old buggy fixed-name
    template, so it would not have caught the original bug."""
    n = 8
    barrier = threading.Barrier(n)
    seen_paths: list[str] = []
    paths_lock = threading.Lock()

    class ConcurrentCodexRunner(RecordingRunner):
        def run(
            self,
            argv: list[str],
            stdin: str | None = None,
            env: dict[str, str] | None = None,
            timeout: float = 300.0,
        ) -> str:
            out_path = argv[argv.index("-o") + 1]
            with paths_lock:
                seen_paths.append(out_path)
            Path(out_path).write_text(f"result-for-{out_path}", encoding="utf-8")
            return ""

    backend = build_backend("codex", ConcurrentCodexRunner(), _settings())
    results: list[str] = [""] * n
    errors: list[BaseException] = []

    def worker(i: int) -> None:
        barrier.wait()  # force all n threads into complete() at (near) the same instant
        try:
            results[i] = backend.complete(CompletionRequest(system="S", user="U", model=None))
        except Exception as exc:  # surfaced via `errors` below, never swallowed
            errors.append(exc)

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(n)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert not errors
    assert len(seen_paths) == n
    assert len(seen_paths) == len(set(seen_paths)), "two concurrent codex calls collided on a path"
    assert len(results) == len(set(results)), "a call read back another call's output"


def test_deepseek_defaults_the_model_and_sets_env() -> None:
    """The deepseek key is injected directly here rather than read from
    `~/.claude/.deepseek-key`, so this test has no dependency on the machine
    it runs on — see `build_backend`'s `deepseek_api_key` parameter."""
    runner = RecordingRunner("ds")
    build_backend("deepseek", runner, _settings(), deepseek_api_key="test-deepseek-key").complete(
        CompletionRequest(system="S", user="U", model=None)
    )
    call = runner.calls[0]
    argv = call.argv
    env = call.env
    assert isinstance(argv, list)
    assert isinstance(env, dict)
    assert "deepseek-v4-flash" in argv
    assert env.get("ANTHROPIC_BASE_URL") == "https://api.deepseek.com/anthropic"
    assert env.get("ANTHROPIC_AUTH_TOKEN") == "test-deepseek-key"


def test_deepseek_strips_any_inherited_anthropic_api_key() -> None:
    """`ANTHROPIC_API_KEY` takes precedence over `ANTHROPIC_AUTH_TOKEN` in the
    claude CLI's own resolution (see `deepseek-env.sh`'s comment). If a
    developer's shell exports their real Anthropic key, it must not leak into
    a DeepSeek-endpoint call and silently authenticate with the wrong
    provider's credential."""
    runner = RecordingRunner("ds")
    build_backend("deepseek", runner, _settings(), deepseek_api_key="k").complete(
        CompletionRequest(system="S", user="U", model=None)
    )
    env = runner.calls[0].env
    assert isinstance(env, dict)
    assert env.get("ANTHROPIC_API_KEY") == ""


def test_deepseek_reads_the_key_from_home_when_nothing_is_injected(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Production default: no injected key ⇒ resolve `~/.claude/.deepseek-key`.
    Redirects HOME to an isolated tmp dir so this never touches the real
    machine's key file."""
    monkeypatch.setenv("HOME", str(tmp_path))
    key_dir = tmp_path / ".claude"
    key_dir.mkdir()
    (key_dir / ".deepseek-key").write_text("  from-disk-key  \n", encoding="utf-8")

    runner = RecordingRunner("ds")
    build_backend("deepseek", runner, _settings()).complete(
        CompletionRequest(system="S", user="U", model=None)
    )
    env = runner.calls[0].env
    assert isinstance(env, dict)
    assert env.get("ANTHROPIC_AUTH_TOKEN") == "from-disk-key"


def test_deepseek_raises_when_key_file_is_missing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))
    with pytest.raises(BackendUnavailableError):
        build_backend("deepseek", RecordingRunner("ds"), _settings())


def test_deepseek_raises_when_key_file_on_disk_is_empty(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Distinct from "file missing" (no `.deepseek-key` at all) and "injected
    empty" (caller explicitly passed `""`): here the file exists but contains
    only whitespace, which must still count as no usable key."""
    monkeypatch.setenv("HOME", str(tmp_path))
    key_dir = tmp_path / ".claude"
    key_dir.mkdir()
    (key_dir / ".deepseek-key").write_text("   \n\t  \n", encoding="utf-8")
    with pytest.raises(BackendUnavailableError):
        build_backend("deepseek", RecordingRunner("ds"), _settings())


def test_deepseek_raises_when_injected_key_is_empty() -> None:
    with pytest.raises(BackendUnavailableError):
        build_backend("deepseek", RecordingRunner("ds"), _settings(), deepseek_api_key="")


def test_deepseek_key_strips_all_whitespace_not_just_ends(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Matches `deepseek-env.sh`'s `tr -d '[:space:]'`, which removes
    whitespace anywhere in the file, not just leading/trailing. `.strip()`
    alone would leave an internal newline or space in the key untouched and
    silently hand the CLI a broken token."""
    monkeypatch.setenv("HOME", str(tmp_path))
    key_dir = tmp_path / ".claude"
    key_dir.mkdir()
    (key_dir / ".deepseek-key").write_text("abc \n def\tghi\n", encoding="utf-8")
    runner = RecordingRunner("ds")
    build_backend("deepseek", runner, _settings()).complete(
        CompletionRequest(system="S", user="U", model=None)
    )
    env = runner.calls[0].env
    assert isinstance(env, dict)
    assert env.get("ANTHROPIC_AUTH_TOKEN") == "abcdefghi"


def test_empty_output_raises_backend_unavailable() -> None:
    backend = build_backend("claude", RecordingRunner(""), _settings())
    with pytest.raises(BackendUnavailableError):
        backend.complete(CompletionRequest(system="S", user="U", model=None))


def test_unknown_backend_name_falls_back_to_claude() -> None:
    """mangniu records `AI Backend: haiku`. Bash's `case` default branch runs the
    claude path, so an unknown name must NOT raise."""
    runner = RecordingRunner("ok")
    backend = build_backend("haiku", runner, _settings())
    backend.complete(CompletionRequest(system="S", user="U", model="haiku"))
    argv = runner.calls[0].argv
    assert isinstance(argv, list)
    assert argv[0] == "claude"


def test_subprocess_runner_env_empty_string_deletes_inherited_variable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`DeepSeekCLIBackend._env()` relies on `SubprocessRunner` treating an
    empty-string env override as "delete this key from the child's
    environment", not "set it to empty" — the only lever Python's subprocess
    `env=` gives us to reproduce `deepseek-env.sh`'s `unset ANTHROPIC_API_KEY`.

    `RecordingRunner`-based tests (e.g. `test_deepseek_strips_any_inherited_...`)
    only prove the backend HANDS `SubprocessRunner` the `""` sentinel — they
    never exercise the merge itself. If `SubprocessRunner.run()` regressed to
    `merged[key] = value`, that other test would still pass while a real
    inherited `ANTHROPIC_API_KEY` silently hijacked every DeepSeek call. This
    test drives an actual child process to prove the merge, not just the
    sentinel being passed."""
    monkeypatch.setenv("SWIL_TEST_STRIP_ME", "leaked-real-key")
    runner = SubprocessRunner()
    out = runner.run(
        [
            sys.executable,
            "-c",
            "import os; print('PRESENT' if 'SWIL_TEST_STRIP_ME' in os.environ else 'ABSENT')",
        ],
        env={"SWIL_TEST_STRIP_ME": ""},
    )
    assert out.strip() == "ABSENT"
    # The parent test process's own environment must be untouched by the merge.
    assert os.environ["SWIL_TEST_STRIP_ME"] == "leaked-real-key"


def test_subprocess_runner_env_normal_override_is_visible_to_child(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Companion to the deletion test above: a normal, non-empty override
    must still reach the child — proving the empty-string sentinel is a
    special case, not evidence that `env=` overrides are broken wholesale."""
    monkeypatch.delenv("SWIL_TEST_OVERRIDE_ME", raising=False)
    runner = SubprocessRunner()
    out = runner.run(
        [
            sys.executable,
            "-c",
            "import os; print(os.environ.get('SWIL_TEST_OVERRIDE_ME', 'MISSING'))",
        ],
        env={"SWIL_TEST_OVERRIDE_ME": "override-value"},
    )
    assert out.strip() == "override-value"
    assert "SWIL_TEST_OVERRIDE_ME" not in os.environ
