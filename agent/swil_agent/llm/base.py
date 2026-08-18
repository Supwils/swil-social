"""Backend dispatch for LLM calls.

All three current backends are CLI subprocesses, not HTTP APIs — `codex` has no
API at all. `Runner` is the seam that makes them testable: production uses
`SubprocessRunner`, tests inject a fake.

An `ApiBackend` for BYOK (owner-supplied keys against real HTTP APIs) will sit
beside these implementations; it is Plan 2+ and deliberately absent here.

Ports `agent/scripts/llm.sh:80-124` (`_llm_raw`, `llm_text`, `llm_json`).
"""

from __future__ import annotations

import os
import re
import subprocess
import tempfile
from pathlib import Path
from typing import Protocol

from pydantic import BaseModel

from swil_agent.config import Settings
from swil_agent.llm.extract import collapse_doubled_text, extract_json_object

DEEPSEEK_BASE_URL = "https://api.deepseek.com/anthropic"
DEEPSEEK_DEFAULT_MODEL = "deepseek-v4-flash"
DEFAULT_TIMEOUT = 300.0


class BackendUnavailableError(RuntimeError):
    """The backend produced no output, or could not be constructed at all.

    Distinct from a bad/garbled response, which is the caller's problem.
    """


class BackendBinaryMissingError(RuntimeError):
    """argv[0] is not on PATH -- the CLI this backend shells out to is not
    installed on this machine.

    DELIBERATELY NOT a subclass of `BackendUnavailableError`, and that is the
    whole point of it existing. Every "the LLM said nothing" call site --
    `act/planner.py`'s `plan_round`, `dream/round.py`'s `_generate_candidate`
    and `_diff_narrative`, `dream/distill.py`'s `distill_cards` -- catches
    `BackendUnavailableError` and degrades to `None`/`""`, exactly as Bash's
    `llm_text` returns empty for a dead model. That degradation is right for
    a model that answered with nothing and WRONG for a binary that does not
    exist: it turns "codex is not installed" into "codex had nothing to say",
    which is how a whole round can silently drop every account on one backend
    with no loud error (CLAUDE.md's own DeepSeek-key note, and the "no
    response from codex" incidents).

    As a sibling type it passes straight through all of those handlers to the
    composition root, which is the only layer that knows the account name and
    the remedy -- `cli.py`'s `_backend_setup_guard` turns it into an
    `AccountSetupError` and exits 75 with both.
    """


class CompletionRequest(BaseModel):
    system: str
    user: str
    model: str | None = None


class Runner(Protocol):
    def run(
        self,
        argv: list[str],
        stdin: str | None = None,
        env: dict[str, str] | None = None,
        timeout: float = DEFAULT_TIMEOUT,
    ) -> str: ...


class SubprocessRunner:
    """The real `Runner`.

    `env` entries with an empty string value are treated as "strip this key
    from the merged environment" rather than "set it to empty". Python's
    subprocess `env=` has no way to express `unset FOO` the way a POSIX shell
    does — a backend that needs to guarantee a var is absent (see
    `DeepSeekCLIBackend`, which must not let an inherited real Anthropic key
    leak into a DeepSeek-endpoint call) has no other lever to pull.
    """

    def run(
        self,
        argv: list[str],
        stdin: str | None = None,
        env: dict[str, str] | None = None,
        timeout: float = DEFAULT_TIMEOUT,
    ) -> str:
        merged = dict(os.environ)
        for key, value in (env or {}).items():
            if value:
                merged[key] = value
            else:
                merged.pop(key, None)
        try:
            completed = subprocess.run(
                argv,
                input=stdin,
                capture_output=True,
                text=True,
                timeout=timeout,
                env=merged,
                check=False,
            )
        except subprocess.TimeoutExpired:
            return ""
        except FileNotFoundError as exc:
            # `subprocess.run` raises `FileNotFoundError` when argv[0] itself
            # is not on PATH. Left raw it escapes as the SAME exception type
            # "this account directory does not exist" uses, and `cli.py`'s
            # `act` reported a missing `claude`/`codex` binary as exit 66,
            # "no such account" -- pointing whoever is debugging at the
            # roster instead of at PATH. This project has already lost real
            # time to "no response from codex" incidents (CLAUDE.md); an
            # exit code naming the wrong thing makes the next one worse.
            #
            # Re-raised as `BackendBinaryMissingError` -- see that class for
            # why it is NOT a `BackendUnavailableError`. Deliberately not
            # `return ""` either: an empty string is indistinguishable from a
            # dead LLM and would cost the same diagnosis.
            raise BackendBinaryMissingError(f"executable not found on PATH: {argv[0]!r}") from exc
        return completed.stdout


class Backend(Protocol):
    name: str

    def complete(self, req: CompletionRequest) -> str: ...


class _ClaudeStyleBackend:
    """`claude -p` with the user prompt on stdin."""

    name = "claude"

    def __init__(self, runner: Runner, *, default_model: str | None = None) -> None:
        self._runner = runner
        self._default_model = default_model

    def _env(self) -> dict[str, str] | None:
        return None

    def complete(self, req: CompletionRequest) -> str:
        model = req.model or self._default_model
        argv = ["claude", "-p"]
        if model:
            argv += ["--model", model]
        argv += ["--system-prompt", req.system, "--output-format", "text"]
        raw = self._runner.run(argv, stdin=req.user, env=self._env())
        if not raw:
            raise BackendUnavailableError(f"{self.name} produced no output")
        return raw


class ClaudeCLIBackend(_ClaudeStyleBackend):
    name = "claude"


class DeepSeekCLIBackend(_ClaudeStyleBackend):
    """Same CLI, different endpoint.

    The env is applied to this process only — it must never leak to the
    neutral ruler (see `llm/neutral.py`). Mirrors `deepseek-env.sh`: it also
    explicitly strips `ANTHROPIC_API_KEY`, because that variable takes
    precedence over `ANTHROPIC_AUTH_TOKEN` in the claude CLI's auth
    resolution — if a developer's shell has their own real Anthropic key
    exported, leaving it in place would silently make this "DeepSeek" call
    authenticate with the wrong credential against the wrong provider.
    """

    name = "deepseek"

    def __init__(self, runner: Runner, api_key: str) -> None:
        super().__init__(runner, default_model=DEEPSEEK_DEFAULT_MODEL)
        self._api_key = api_key

    def _env(self) -> dict[str, str]:
        return {
            "ANTHROPIC_BASE_URL": DEEPSEEK_BASE_URL,
            "ANTHROPIC_AUTH_TOKEN": self._api_key,
            "ANTHROPIC_API_KEY": "",  # strip any inherited real Anthropic key
            "ANTHROPIC_MODEL": DEEPSEEK_DEFAULT_MODEL,
            "CLAUDE_CODE_EFFORT_LEVEL": "medium",
        }


class CodexCLIBackend:
    """`codex exec` writes to a file; stdout is progress noise."""

    name = "codex"

    def __init__(self, runner: Runner) -> None:
        self._runner = runner

    def complete(self, req: CompletionRequest) -> str:
        prompt = f"System:\n{req.system}\n\n---\n\n{req.user}"
        # Trailing X's so mktemp-style uniqueness actually applies: the Bash
        # `swil.sh` template put its X's in the wrong (non-trailing) position,
        # so concurrent image posts collided on a fixed name and one silently
        # clobbered the other's output. NamedTemporaryFile always generates a
        # unique name per call, so that class of bug cannot recur here.
        with tempfile.NamedTemporaryFile(
            prefix="swil_codex_", suffix=".txt", delete=False
        ) as handle:
            out_path = Path(handle.name)
        try:
            self._runner.run(
                [
                    "codex",
                    "exec",
                    "--ephemeral",
                    "--skip-git-repo-check",
                    "--full-auto",
                    "--color",
                    "never",
                    "-o",
                    str(out_path),
                    prompt,
                ]
            )
            raw = out_path.read_text(encoding="utf-8") if out_path.exists() else ""
        finally:
            out_path.unlink(missing_ok=True)
        if not raw:
            raise BackendUnavailableError("codex produced no output")
        return raw


def _default_deepseek_key() -> str:
    """Production key source: `~/.claude/.deepseek-key`, one line, chmod 600.

    Mirrors `deepseek-env.sh`'s own read — including `tr -d '[:space:]'`,
    which strips ALL whitespace (leading, trailing, AND internal, e.g. a
    stray newline or space pasted into the middle of the key), not just the
    ends. `.strip()` alone would leave an internal newline in place and
    silently hand the CLI a broken token. Kept separate from
    `build_backend`'s `deepseek_api_key` parameter so tests never have to
    touch a real home directory — see that parameter's docstring.
    """
    path = Path.home() / ".claude" / ".deepseek-key"
    if not path.is_file():
        raise BackendUnavailableError(f"deepseek key not found at {path}")
    return re.sub(r"\s+", "", path.read_text(encoding="utf-8"))


def build_backend(
    name: str,
    runner: Runner,
    settings: Settings,
    *,
    deepseek_api_key: str | None = None,
) -> Backend:
    """Map a personality's `AI Backend` bullet to a backend.

    Unknown names fall back to the claude path, matching the `*)` default
    branch in `llm.sh`. `mangniu` records `haiku`, which must not raise.

    `deepseek_api_key` is an injection seam, not a production concern: leave
    it unset and the real key is read from `~/.claude/.deepseek-key` (via
    `_default_deepseek_key`), exactly like the Bash runtime. It exists so
    `test_backends.py` can supply a fixed string instead of depending on a
    file outside the repository — without it, the deepseek tests would pass
    locally (if the developer happens to have the file) and fail in CI (which
    never will). A missing/empty key — injected or read from disk — still
    raises `BackendUnavailableError` rather than building a backend that
    would silently authenticate with nothing.
    """
    _ = settings  # no per-backend settings yet; kept for interface stability
    if name == "codex":
        return CodexCLIBackend(runner)
    if name == "deepseek":
        api_key = deepseek_api_key if deepseek_api_key is not None else _default_deepseek_key()
        if not api_key:
            raise BackendUnavailableError("deepseek api key is empty")
        return DeepSeekCLIBackend(runner, api_key)
    return ClaudeCLIBackend(runner)


def complete_text(backend: Backend, req: CompletionRequest) -> str:
    """`llm_text`: collapse codex's occasional double emit."""
    return collapse_doubled_text(backend.complete(req))


def complete_json(backend: Backend, req: CompletionRequest) -> str | None:
    """`llm_json`: extract from the RAW body, with no collapse pass.

    The asymmetry with `complete_text` is deliberate and matches `llm.sh`.
    """
    return extract_json_object(backend.complete(req))
