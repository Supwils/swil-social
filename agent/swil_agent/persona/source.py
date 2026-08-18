"""Where a persona is stored.

`GitPersonaSource` keeps the built-in roster on disk under git: personality.md,
personality.archive.md and memory.md. The git history IS the drift audit trail,
which is why these stay files rather than moving into the database.

`ApiPersonaSource` — for owner-created agents whose personas live server-side —
implements the same Protocol and is Plan 2+. Callers above this seam receive a
Persona and must never touch the filesystem directly.
"""

from __future__ import annotations

import os
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Protocol

from swil_agent.models import Persona
from swil_agent.persona.loader import load_persona, resolve_agent_dir

ARCHIVE_HEADER = "---\n# 旧版 personality（归档于 {stamp}）\n---\n"
_STAMP_FORMAT = "%Y-%m-%d %H:%M:%S"


def _atomic_write(path: Path, content: str) -> None:
    """Write `content` to `path` without ever truncating a live file in place.

    `dream.sh` writes both the archive and the new `personality.md` via a
    temp-file-then-`mv`, which is atomic. Plain `Path.write_text()` opens the
    target with truncation *before* writing a single byte, so a process that
    dies mid-write leaves a corrupted (empty or partial) file behind -- and
    for these files there is no other copy to restore from. This reproduces
    the Bash behaviour: write to a fresh sibling file in the SAME directory
    (a rename across filesystems would not be atomic), then swap it onto
    `path` with `os.replace`, which is atomic on POSIX and overwrites an
    existing target in one step. `path` itself is never opened for writing,
    so it cannot end up truncated. If anything raises before the swap, the
    temp file is removed so a crash cannot leave `.tmp` litter beside a live
    persona.
    """
    fd, tmp_name = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    os.close(fd)
    tmp_path = Path(tmp_name)
    try:
        tmp_path.write_text(content, encoding="utf-8")
        os.replace(tmp_path, path)
    except BaseException:
        tmp_path.unlink(missing_ok=True)
        raise


class PersonaSource(Protocol):
    def load(self, name: str) -> Persona: ...
    def archive_and_write(self, name: str, candidate: str, when: datetime) -> None: ...
    def read_memory(self, name: str) -> str: ...
    def append_memory(self, name: str, line: str) -> None: ...


class GitPersonaSource:
    def __init__(self, agent_root: Path) -> None:
        self._agent_root = agent_root

    def _dir(self, name: str) -> Path:
        return resolve_agent_dir(self._agent_root, name)

    def load(self, name: str) -> Persona:
        return load_persona(self._dir(name))

    def archive_and_write(self, name: str, candidate: str, when: datetime) -> None:
        directory = self._dir(name)
        personality = directory / "personality.md"
        archive = directory / "personality.archive.md"

        old = personality.read_text(encoding="utf-8")
        header = ARCHIVE_HEADER.format(stamp=when.strftime(_STAMP_FORMAT))
        previous = archive.read_text(encoding="utf-8") if archive.is_file() else ""
        # Prepend: newest first, so the archive reads reverse-chronologically.
        # Archive the OLD content before personality.md is ever touched, so a
        # failure here leaves personality.md completely untouched too.
        _atomic_write(archive, header + old + "\n" + previous)

        _atomic_write(personality, candidate)

    def read_memory(self, name: str) -> str:
        path = self._dir(name) / "memory.md"
        return path.read_text(encoding="utf-8") if path.is_file() else ""

    def append_memory(self, name: str, line: str) -> None:
        path = self._dir(name) / "memory.md"
        with path.open("a", encoding="utf-8") as handle:
            handle.write(line.rstrip("\n") + "\n")
