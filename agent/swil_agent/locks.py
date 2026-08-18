"""Bash-compatible per-account lock files under `agent/.agent-state/`.

These are a COEXISTENCE measure, not the destination. The design spec §7.3
replaces them with SQLite run leases in Plan 3, which is what actually fixes
the orphan-lock class of defect (a dead run's lease expires; a dead run's
lock file does not). Until then Python must use the same paths and the same
1800s staleness rule as auto-run.sh:411-433 and dream.sh:461-470, or a Python
round and a Bash round can hold the same account at the same time.
"""

from __future__ import annotations

import os
import time
from pathlib import Path
from types import TracebackType

STALE_AFTER_SECONDS = 1800


class LockBusy(RuntimeError):  # noqa: N818 -- mandated name, see task-2-brief.md interfaces
    """Another run holds this lock and it is not stale yet."""

    def __init__(self, path: Path, age_seconds: int) -> None:
        super().__init__(f"{path.name} held ({age_seconds}s)")
        self.path = path
        self.age_seconds = age_seconds


def act_lock_path(agent_root: Path, name: str) -> Path:
    return agent_root / ".agent-state" / f"lock_{name}"


def dream_lock_path(agent_root: Path, name: str) -> Path:
    return agent_root / ".agent-state" / f"dream_lock_{name}"


class FileLock:
    def __init__(self, path: Path, *, stale_after: int = STALE_AFTER_SECONDS) -> None:
        self._path = path
        self._stale_after = stale_after
        self._held = False

    def _try_create(self) -> bool:
        try:
            fd = os.open(self._path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
        except FileExistsError:
            return False
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            # Trailing newline to match Bash's `echo "$$" > "$lock_file"`
            # (auto-run.sh:417, dream.sh:461) byte-for-byte -- lock semantics
            # here are purely mtime-based so this changes no behavior, but a
            # Python-held lock's contents should read identically to a
            # Bash-held one for anyone inspecting it during an incident.
            handle.write(f"{os.getpid()}\n")
        return True

    def acquire(self) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        if self._try_create():
            self._held = True
            return
        try:
            age = int(time.time() - self._path.stat().st_mtime)
        except OSError:
            age = 0
        if age < self._stale_after:
            raise LockBusy(self._path, age)
        self._path.unlink(missing_ok=True)
        if not self._try_create():
            raise LockBusy(self._path, age)
        self._held = True

    def release(self) -> None:
        if self._held:
            self._path.unlink(missing_ok=True)
            self._held = False

    def __enter__(self) -> FileLock:
        self.acquire()
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        self.release()
