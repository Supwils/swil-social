import os
import time
from pathlib import Path

import pytest

from swil_agent.locks import (
    STALE_AFTER_SECONDS,
    FileLock,
    LockBusy,
    act_lock_path,
    dream_lock_path,
)


def test_lock_creates_the_file_and_removes_it_on_exit(tmp_path: Path) -> None:
    path = tmp_path / "lock_zenith"
    with FileLock(path):
        assert path.exists()
    assert not path.exists()


def test_lock_writes_the_current_pid_into_the_file(tmp_path: Path) -> None:
    """Bash writes `echo "$$" > "$lock_file"` (auto-run.sh:411-433) -- the
    lock file's content isn't just a marker, it's a diagnostic (who is
    holding this?). A Python round must write the same thing, not an
    arbitrary placeholder, or an operator reading a stale lock's contents
    during an incident gets nothing useful. `echo` appends a trailing
    newline, so the byte-for-byte match requires one too (finding 2,
    fix round 1) -- a bare `str(os.getpid())` with no `\\n` would read
    correctly but not match Bash's own output byte-for-byte."""
    path = tmp_path / "lock_zenith"
    with FileLock(path):
        assert path.read_text(encoding="utf-8") == f"{os.getpid()}\n"


def test_lock_raises_when_a_fresh_lock_is_held(tmp_path: Path) -> None:
    path = tmp_path / "lock_zenith"
    path.write_text("999999", encoding="utf-8")
    with pytest.raises(LockBusy), FileLock(path):
        pass
    # A busy lock must not be touched by the failed acquire attempt.
    assert path.read_text(encoding="utf-8") == "999999"


def test_lock_reclaims_a_stale_lock(tmp_path: Path) -> None:
    path = tmp_path / "lock_zenith"
    path.write_text("999999", encoding="utf-8")
    old = time.time() - (STALE_AFTER_SECONDS + 60)
    os.utime(path, (old, old))
    with FileLock(path):
        assert path.exists()
    assert not path.exists()


def test_lock_releases_on_an_exception(tmp_path: Path) -> None:
    path = tmp_path / "lock_zenith"
    with pytest.raises(RuntimeError), FileLock(path):
        raise RuntimeError("boom")
    assert not path.exists()


def test_lock_busy_reports_the_age_in_seconds(tmp_path: Path) -> None:
    path = tmp_path / "lock_zenith"
    path.write_text("999999", encoding="utf-8")
    old = time.time() - 120
    os.utime(path, (old, old))
    with pytest.raises(LockBusy) as exc_info, FileLock(path):
        pass
    assert exc_info.value.path == path
    # allow a couple seconds of test-runtime slack either side of 120
    assert 118 <= exc_info.value.age_seconds <= 122


def test_lock_creates_parent_directories(tmp_path: Path) -> None:
    path = tmp_path / "nested" / "dir" / "lock_zenith"
    with FileLock(path):
        assert path.exists()
    assert not path.exists()


def test_lock_can_be_reacquired_after_a_clean_release(tmp_path: Path) -> None:
    path = tmp_path / "lock_zenith"
    with FileLock(path):
        pass
    with FileLock(path):
        assert path.exists()
    assert not path.exists()


def test_act_lock_path_matches_the_bash_convention(tmp_path: Path) -> None:
    assert act_lock_path(tmp_path, "zenith") == tmp_path / ".agent-state" / "lock_zenith"


def test_dream_lock_path_matches_the_bash_convention(tmp_path: Path) -> None:
    assert dream_lock_path(tmp_path, "zenith") == tmp_path / ".agent-state" / "dream_lock_zenith"


def test_lock_busy_message_includes_the_file_name(tmp_path: Path) -> None:
    path = tmp_path / "lock_zenith"
    path.write_text("1", encoding="utf-8")
    old = time.time() - 5
    os.utime(path, (old, old))
    with pytest.raises(LockBusy) as exc_info, FileLock(path):
        pass
    assert "lock_zenith" in str(exc_info.value)


def test_lock_treats_a_stat_failure_as_age_zero_and_raises_busy(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`_try_create` failed (the file exists), and then the mtime probe
    itself fails (e.g. a concurrent unlink mid-race). Bash's fallback for a
    failed `stat` is age=0 (auto-run.sh comment: `stat -f %m ... || echo 0`)
    -- age 0 is always "fresh", so this must raise LockBusy, never silently
    treat an unreadable lock as free."""
    path = tmp_path / "lock_zenith"
    path.write_text("999999", encoding="utf-8")

    real_stat = Path.stat

    def _boom(self: Path, *args: object, **kwargs: object) -> os.stat_result:
        if self == path:
            raise OSError("stat failed")
        return real_stat(self, *args, **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(Path, "stat", _boom)
    with pytest.raises(LockBusy) as exc_info, FileLock(path):
        pass
    assert exc_info.value.age_seconds == 0


def test_lock_raises_when_the_stale_reclaim_retry_also_loses(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The stale-reclaim path is unlink-then-retry-create -- if a second
    racing process recreates the file between the unlink and our retry, the
    retry's create-exclusive fails too. That must surface as LockBusy, not
    a silent double-acquire of the same account."""
    path = tmp_path / "lock_zenith"
    path.write_text("999999", encoding="utf-8")
    old = time.time() - (STALE_AFTER_SECONDS + 60)
    os.utime(path, (old, old))

    lock = FileLock(path)
    monkeypatch.setattr(lock, "_try_create", lambda: False)
    with pytest.raises(LockBusy):
        lock.acquire()
    # The stale file was still unlinked on the way to the failed retry.
    assert not path.exists()
