"""The model-neutral ruler.

The aspect distiller measures drift. It must never route through the agent's
own backend: a DeepSeek account measured by DeepSeek is not comparable to a
Claude account measured by Claude, and the whole cross-roster drift series
depends on one ruler.

Bash enforced this by sourcing the DeepSeek env inside a `$( )` subshell so it
died with the subshell. Here it is TWO independent mechanisms, not one:
  * Import isolation — this module imports neither the concrete backends nor
    the backend-selection function in `llm/base.py`, and
    `tests/unit/test_architecture.py` asserts that.
  * Environment isolation — `distill_neutral` explicitly clears
    `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, and `ANTHROPIC_MODEL` from
    the child process's environment on every call (see `_ISOLATION_ENV`
    below). This exists because `SubprocessRunner.run` builds its child
    environment as `merged = dict(os.environ)` when given `env=None` — it
    inherits EVERYTHING from the parent process, not nothing. So passing
    `env=None` here (an earlier version of this function did exactly that,
    under the claim "no env override is passed, so nothing can redirect
    this") would NOT have been isolation: a parent-set
    `ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic` — exactly what
    the DeepSeek CLI backend (see `llm/base.py`) sets for its own
    subprocess, and something a developer's shell could equally well
    export — reaches the child unchanged and silently redirects the ruler
    at DeepSeek's endpoint.

    (Deliberately not naming that backend's class here: this module is
    architecture-tested to contain no reference — in code OR prose — to any
    concrete backend class; see `tests/unit/test_architecture.py`.)
"""

from __future__ import annotations

from swil_agent.llm.base import (
    DEFAULT_TIMEOUT,
    BackendUnavailableError,
    CompletionRequest,
    Runner,
)
from swil_agent.llm.extract import collapse_doubled_text

# Empty-string values delete the key from the child's environment (see
# SubprocessRunner.run's env-merge semantics) rather than setting it to
# empty — this is the only lever available to guarantee a var is ABSENT.
# These three are exactly the keys the DeepSeek CLI backend sets for its
# own subprocess, so clearing them here is what actually makes the ruler
# immune to a DeepSeek (or any other) redirect reaching it via the
# ambient environment.
_ISOLATION_ENV: dict[str, str] = {
    "ANTHROPIC_BASE_URL": "",
    "ANTHROPIC_AUTH_TOKEN": "",
    "ANTHROPIC_MODEL": "",
}


def distill_neutral(req: CompletionRequest, runner: Runner, model: str) -> str:
    """Run one completion on real Anthropic via the claude CLI, fixed model.

    Clears `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, and
    `ANTHROPIC_MODEL` from the child's environment on every call (see
    `_ISOLATION_ENV` and the module docstring) — so nothing in the ambient
    environment, including a real, parent-set DeepSeek redirect, can send
    this call to another endpoint. There is no code path here through which
    a DeepSeek or Codex account could end up measuring its own drift.
    """
    argv = [
        "claude",
        "-p",
        # No tools: the ruler must not be able to touch the thing it measures.
        # See `llm/base.py`'s `--tools ""` comment for the incident.
        "--tools",
        "",
        "--model",
        model,
        "--system-prompt",
        req.system,
        "--output-format",
        "text",
    ]
    raw = runner.run(argv, stdin=req.user, env=_ISOLATION_ENV, timeout=DEFAULT_TIMEOUT)
    if not raw:
        raise BackendUnavailableError(f"neutral ruler ({model}) produced no output")
    return collapse_doubled_text(raw)
