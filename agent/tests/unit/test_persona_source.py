"""Tests for the PersonaSource seam.

Every test builds its own `tmp_path` roster — `archive_and_write` overwrites a
live `personality.md`, and the real `agent/agents/*` / `agent/humans/*` trees
hold the drift experiment's only copy of some in-flight persona edits. None of
these tests may point at a real account.

Note on the task-12 brief: its Step 1 lists six tests (through
`test_unknown_account_raises`) while its Step 4 says "Expected: 7 passed" —
those two numbers disagree with each other and with the actual test count.
Flagged during fix round 1 rather than silently reconciled; the two tests
added below (atomic-write durability) make the current count eight, which
doesn't resolve the original mismatch, it just supersedes it.
"""

from datetime import datetime
from pathlib import Path

import pytest

from swil_agent.persona.source import GitPersonaSource

PERSONALITY = """# 测试

## 身份
- **Username:** tester
- **Display Name:** 测试
- **Headline:** AI Agent
- **Bio:** 一句话
- **Follow Topics:** alpha,beta

- **AI Backend:** claude

## 发帖节律
- 每次触发有 60% 概率选择 post
"""


@pytest.fixture
def agent_root(tmp_path: Path) -> Path:
    d = tmp_path / "agents" / "tester"
    d.mkdir(parents=True)
    (d / "personality.md").write_text(PERSONALITY, encoding="utf-8")
    return tmp_path


def test_load_returns_a_persona(agent_root: Path) -> None:
    persona = GitPersonaSource(agent_root).load("tester")
    assert persona.username == "tester"
    assert persona.backend == "claude"


def test_archive_and_write_replaces_personality(agent_root: Path) -> None:
    source = GitPersonaSource(agent_root)
    new_text = PERSONALITY.replace("一句话", "改写过的一句话")
    source.archive_and_write("tester", new_text, datetime(2026, 8, 17, 2, 30, 0))
    current = (agent_root / "agents" / "tester" / "personality.md").read_text(encoding="utf-8")
    assert "改写过的一句话" in current


def test_archive_prepends_the_old_version_with_a_timestamp(agent_root: Path) -> None:
    source = GitPersonaSource(agent_root)
    source.archive_and_write("tester", "NEW-1", datetime(2026, 8, 17, 2, 30, 0))
    archive = (agent_root / "agents" / "tester" / "personality.archive.md").read_text(
        encoding="utf-8"
    )
    assert "归档于 2026-08-17 02:30:00" in archive
    assert "一句话" in archive, "the ORIGINAL must be archived, not the candidate"
    assert "NEW-1" not in archive


def test_second_archive_goes_on_top(agent_root: Path) -> None:
    """Newest first — dream.sh prepends. Reading the archive top-down must give
    reverse-chronological order."""
    source = GitPersonaSource(agent_root)
    source.archive_and_write("tester", "NEW-1", datetime(2026, 8, 17, 1, 0, 0))
    source.archive_and_write("tester", "NEW-2", datetime(2026, 8, 17, 2, 0, 0))
    archive = (agent_root / "agents" / "tester" / "personality.archive.md").read_text(
        encoding="utf-8"
    )
    assert archive.index("归档于 2026-08-17 02:00:00") < archive.index("归档于 2026-08-17 01:00:00")


def test_memory_append_and_read_roundtrip(agent_root: Path) -> None:
    source = GitPersonaSource(agent_root)
    assert source.read_memory("tester") == ""
    source.append_memory("tester", "first line")
    source.append_memory("tester", "second line")
    assert source.read_memory("tester").splitlines() == ["first line", "second line"]


def test_unknown_account_raises(agent_root: Path) -> None:
    with pytest.raises(FileNotFoundError):
        GitPersonaSource(agent_root).load("no_such_account")


def test_archive_and_write_leaves_no_temp_files(agent_root: Path) -> None:
    """`archive_and_write` swaps in its results via a temp-file-then-`os.replace`
    for durability (fix round 1). The temp file must never survive a
    successful call — list the directory rather than checking a single
    expected path, so an unexpected leftover of any name is caught."""
    source = GitPersonaSource(agent_root)
    source.archive_and_write("tester", "NEW-1", datetime(2026, 8, 17, 2, 30, 0))
    directory = agent_root / "agents" / "tester"
    names = {p.name for p in directory.iterdir()}
    assert names == {"personality.md", "personality.archive.md"}


def test_write_failure_leaves_the_original_personality_intact(
    agent_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A crash mid-write must never leave `personality.md` truncated -- these
    files have no other copy to restore from.

    Simulate the crash by making the write of the CANDIDATE content perform a
    real, observable partial write (reproducing exactly what an interrupted
    `open("w")` + `write()` leaves behind) and then raise, at whichever path
    `archive_and_write` actually performs that write on. Under the atomic
    implementation that path is a throwaway temp file, so `personality.md`
    itself is never opened for writing and survives untouched. The same
    monkeypatch, unmodified, is reused in the mutation proof against a
    reverted plain-`write_text()` implementation, where the write target IS
    `personality.md` directly -- there the corruption is real and this
    assertion fails, which is what proves the test discriminates.
    """
    source = GitPersonaSource(agent_root)
    personality_path = agent_root / "agents" / "tester" / "personality.md"
    original = personality_path.read_text(encoding="utf-8")
    candidate = "CORRUPT-CANDIDATE"

    real_write_text = Path.write_text

    def flaky_write_text(self: Path, data: str, encoding: str | None = None) -> int:
        if data == candidate:
            with self.open("w", encoding=encoding or "utf-8") as handle:
                handle.write(data[: len(data) // 2])  # a real, observable partial write
            raise OSError("simulated crash mid-write")
        return real_write_text(self, data, encoding=encoding)

    monkeypatch.setattr(Path, "write_text", flaky_write_text)

    with pytest.raises(OSError):
        source.archive_and_write("tester", candidate, datetime(2026, 8, 17, 3, 0, 0))

    assert personality_path.read_text(encoding="utf-8") == original

    leftovers = [
        p.name
        for p in personality_path.parent.iterdir()
        if p.name not in {"personality.md", "personality.archive.md"}
    ]
    assert leftovers == [], f"temp file left behind: {leftovers}"
