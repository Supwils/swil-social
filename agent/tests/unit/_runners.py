"""Shared `Runner`-protocol test doubles.

Single home for these so `test_backends.py`, `test_embedder.py`, and any later
task's tests (act/dream) import the same fakes instead of each hand-rolling
one. Both classes conform structurally to `swil_agent.llm.base.Runner`.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class RunnerCall:
    """One recorded invocation of `Runner.run`."""

    argv: list[str]
    stdin: str | None
    env: dict[str, str] | None
    timeout: float


class RecordingRunner:
    """Records every call and always returns the same fixed string."""

    def __init__(self, output: str = "ok") -> None:
        self.output = output
        self.calls: list[RunnerCall] = []

    def run(
        self,
        argv: list[str],
        stdin: str | None = None,
        env: dict[str, str] | None = None,
        timeout: float = 300.0,
    ) -> str:
        self.calls.append(RunnerCall(argv=list(argv), stdin=stdin, env=env, timeout=timeout))
        return self.output


class ScriptedRunner:
    """Returns queued responses in call order.

    Raises `RuntimeError` if called more times than it has scripted
    responses -- a test that over-calls this fake is exercising a path the
    test author did not account for, and a silent extra "ok" would mask that.
    """

    def __init__(self, responses: list[str]) -> None:
        self._responses = list(responses)
        self.calls: list[RunnerCall] = []
        self.call_count = 0

    def run(
        self,
        argv: list[str],
        stdin: str | None = None,
        env: dict[str, str] | None = None,
        timeout: float = 300.0,
    ) -> str:
        self.calls.append(RunnerCall(argv=list(argv), stdin=stdin, env=env, timeout=timeout))
        if self.call_count >= len(self._responses):
            raise RuntimeError(
                f"ScriptedRunner called {self.call_count + 1} time(s) but only "
                f"{len(self._responses)} response(s) were scripted"
            )
        response = self._responses[self.call_count]
        self.call_count += 1
        return response
