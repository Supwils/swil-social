"""Run leases -- a SQLite row that still holds the Bash-visible lock file.

Spec §7.3 says `lock_<name>` / `dream_lock_<name>` "become a row in SQLite
with a uniqueness constraint and a heartbeat timestamp". Read literally --
the row *replaces* the file -- that would silently destroy mutual exclusion
during migration stages 3 and 4, the exact window in which Bash and Python
run the same 23-account roster. A Bash round reads `.agent-state/lock_<name>`
and nothing else; it cannot see a SQLite row. Two runtimes, two disjoint
notions of "held", one account posting twice.

So a lease holds BOTH:

- the **file lock** (`swil_agent.locks.FileLock`, same paths, same 1800s
  staleness rule as auto-run.sh:406-433 and dream.sh:460-471) -- this is what
  makes exclusion *cross-runtime*;
- the **row** -- this is what makes a lease *expire*, and what carries the
  identity (`run_id`, `pid`) that a bare lock file cannot.

The file half is dropped at stage 5, when Bash no longer runs. Until then
removing it is not a simplification, it is a regression.

**What actually kills the orphan-lock class.** Time-based expiry alone buys
nothing over the file it accompanies: Bash already reclaims at the same 1800s
(auto-run.sh:423, dream.sh:464), so a dead run still costs the account up to
30 minutes of SKIPped rounds. The row carries the holder's **pid**, and a
lease whose pid is no longer alive is reclaimable *immediately*. That is the
difference between "we added SQLite" and "we killed the class of defect that
an accepted dream exiting 141 after `snapshot uploaded` used to create". Time
expiry stays as the backstop for a reused pid.

Pid liveness is only meaningful on the host that wrote the row. This runtime
is single-host by construction (the lease DB is a local SQLite file, and
SQLite over a network filesystem is unsound for other reasons), so no host
column is carried. If the DB ever becomes shared, `_pid_alive` must gain one.

Ordering is load-bearing: **file lock first, row second**. The file lock is
the cross-runtime authority, so the exclusion decision is made before any
claim is published; and if the row fails, the file lock is released. The
reverse order publishes a Python-side claim while the account still reads as
free to Bash, and any slip in its rollback strands a lock file -- invisible
to SQLite, and enough to make every later Bash round SKIP that account until
the staleness window runs out.

Release is **identity-scoped**, not key-scoped. A holder whose lease was
legitimately reclaimed while it was still running must not, on the way out,
delete the *successor's* row or unlink the successor's lock file -- which is
what a `WHERE (tenant, agent, kind)` delete and an unconditional unlink would
do, leaving the live successor holding neither half and nothing to tell it so.
Every write past acquisition therefore carries `run_id`, and the file is only
unlinked while its inode is still the one this lease created.

A busy lease raises `LeaseBusy` immediately. There is deliberately no retry
loop: Bash logs `SKIP <name> -- locked` and moves on (auto-run.sh:424), and
waiting instead would change round scheduling.

**Concurrency on the SQLite file itself** (spec §15.1 row 23). Stage 3's
`--dry-run` shadow round never opened `run_leases.sqlite` -- a dry run takes
no lease -- so it never exercised what stage 4 does: 3-5 Python cycles, each
its own connection, sharing one file. `open_lease_db` sets `journal_mode=WAL`
and `busy_timeout` on that connection, once, at open, so a second writer
waits instead of raising `database is locked` on the spot. `heartbeat()`
still treats a locked database as a recoverable miss, not a reason to end the
cycle -- but logs it, because a heartbeat that fails silently and a heartbeat
that stops running are indistinguishable to Bash, which reclaims this lease's
file half after `LEASE_TTL_SECONDS` either way.
"""

from __future__ import annotations

import contextlib
import logging
import os
import sqlite3
import time
from collections.abc import Callable
from pathlib import Path
from types import TracebackType
from typing import Final, Literal

from swil_agent.locks import FileLock, LockBusy, act_lock_path, dream_lock_path

logger = logging.getLogger(__name__)

# The same 1800s Bash reclaims at (auto-run.sh:423, dream.sh:464), and the
# same window `locks.STALE_AFTER_SECONDS` applies to the file half. The two
# halves of one lease must expire at the same instant -- any gap between them
# is a window in which one runtime reclaims what the other still considers
# held. `test_the_ttl_matches_the_bash_staleness_window` pins the equality.
LEASE_TTL_SECONDS: Final = 1800.0

# This module owns the FILENAME, not the directory -- the same split
# `graph/checkpoint.py` makes for `CHECKPOINT_DB_NAME`, so both stay trivially
# testable against a `tmp_path` while the composition root (`cli.py`) decides
# they live next to `lock_<name>` under `agent/.agent-state/`.
LEASE_DB_NAME: Final = "run_leases.sqlite"

# Milliseconds `sqlite3`'s busy handler waits before raising `OperationalError`
# on a locked database, rather than raising immediately (SQLite's own C-level
# default). Stage 4 puts 3-5 Python cycles' `heartbeat()` calls on the same
# `run_leases.sqlite` -- Bash never opens this file, but the Python side alone
# is enough concurrent writers that "raise instantly" turns an ordinary
# lock-step collision into a lost round. Spec §15.1 row 23 names 5000; that
# value is deliberately NOT used here -- `sqlite3.connect()`'s own `timeout`
# parameter defaults to 5.0s and is *already* wired to this exact pragma
# (confirmed: a bare `sqlite3.connect(path)` reports `PRAGMA busy_timeout`
# as 5000 with no code in this module involved), so setting 5000 explicitly
# would be indistinguishable from not setting it at all -- a mutation
# deleting the pragma call would leave every test green. 8000 is chosen
# instead: still short enough that a stuck peer does not stall a heartbeat
# for minutes, and far enough from stdlib's own default that "this line
# runs" is provable rather than assumed.
_BUSY_TIMEOUT_MS: Final = 8000

LeaseKind = Literal["act", "dream"]

# `kind` is part of the identity because Bash locks act and dream separately.
# Collapsing them onto (tenant, agent) would serialise a dream behind an
# unrelated act -- a behaviour change, not a simplification.
_LOCK_PATH: Final[dict[str, Callable[[Path, str], Path]]] = {
    "act": act_lock_path,
    "dream": dream_lock_path,
}

_SCHEMA: Final = """CREATE TABLE IF NOT EXISTS run_leases (
    tenant TEXT NOT NULL,
    agent TEXT NOT NULL,
    kind TEXT NOT NULL,
    run_id TEXT NOT NULL,
    pid INTEGER NOT NULL,
    acquired_at REAL NOT NULL,
    heartbeat_at REAL NOT NULL,
    PRIMARY KEY (tenant, agent, kind)
)"""

# One spelling of each predicate, reused by every statement that needs it.
# `_OWNED_WHERE` is `_KEY_WHERE` plus the holder's identity: acquisition
# competes on the key, but every later write must prove it is still the
# holder, or a reclaimed-but-still-running lease clobbers its successor.
_KEY_WHERE: Final = "tenant = ? AND agent = ? AND kind = ?"
_OWNED_WHERE: Final = f"{_KEY_WHERE} AND run_id = ?"

_INSERT: Final = (
    "INSERT INTO run_leases "
    "(tenant, agent, kind, run_id, pid, acquired_at, heartbeat_at) "
    "VALUES (?, ?, ?, ?, ?, ?, ?)"
)
_DELETE_OWNED: Final = f"DELETE FROM run_leases WHERE {_OWNED_WHERE}"
_TOUCH: Final = f"UPDATE run_leases SET heartbeat_at = ? WHERE {_OWNED_WHERE}"
_SELECT: Final = "SELECT tenant, agent, kind, run_id, pid, heartbeat_at FROM run_leases"
_SELECT_ONE: Final = f"{_SELECT} WHERE {_KEY_WHERE}"


class LeaseBusy(RuntimeError):  # noqa: N818 -- mandated name, see task-3-brief.md interfaces
    """Another run holds this account's lease. The caller SKIPs, as Bash does."""

    def __init__(self, tenant: str, agent: str, kind: str, reason: str) -> None:
        super().__init__(f"{tenant}:{agent} {kind} lease busy ({reason})")
        self.tenant = tenant
        self.agent = agent
        self.kind = kind
        self.reason = reason


def _pid_alive(pid: int) -> bool:
    """Is `pid` a live process on this host?

    `os.kill(pid, 0)` sends no signal but runs the same permission and
    existence checks, which is the standard liveness probe. Two traps:

    - `PermissionError` means the process **exists** and belongs to another
      user. It is emphatically not "dead" -- reading it as dead would steal a
      live lease. Every non-`ProcessLookupError` `OSError` is answered
      "alive" for the same reason: the conservative failure is to leave a
      lease alone and let the time-based TTL handle it.
    - `pid <= 0` is not a probe at all: `os.kill(0, 0)` signals this
      process's entire group and a negative pid signals another group.
      Answered "alive" so a corrupt row can never be turned into a
      group-wide signal.
    """
    if pid <= 0:
        return True
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except OSError:
        return True
    return True


def open_lease_db(path: str) -> sqlite3.Connection:
    """Open a connection to the lease database, tuned for the concurrency
    stage 4 introduces: `journal_mode=WAL` and `busy_timeout` set on the
    connection, once, here.

    Before this, `sqlite3.connect` was called with every other setting left
    at SQLite's own defaults: rollback journal, and a busy timeout of zero --
    meaning a second writer that finds the database locked raises
    `sqlite3.OperationalError` immediately rather than waiting for the first
    writer to finish its transaction. `ensure_schema` runs on every
    `RunLease.__enter__` and every `sweep_expired` call -- setting pragmas
    there would mean re-issuing them on every one of those, which is `PRAGMA
    busy_timeout` for the connection either way but is exactly the "scattered
    across call sites" shape this function exists to avoid: one caller
    reconnecting with a different timeout would have no single place that
    still describes what the connection's settings actually are. Applying it
    once, at the point the connection is opened, means the pragmas are a
    property of the connection for its entire lifetime, not of any particular
    call that happens to run first.

    A `:memory:` connection (dry runs, most of this module's own tests)
    cannot use WAL -- SQLite pins an in-memory database to `MEMORY` journal
    mode regardless of what is requested, silently, which is fine: nothing
    else can open a second connection to the same private `:memory:`
    database, so there is no contention for WAL to help with there anyway.
    `busy_timeout` still applies (and is harmless) on that path.
    """
    db = sqlite3.connect(path)
    db.execute("PRAGMA journal_mode=WAL")
    db.execute(f"PRAGMA busy_timeout={_BUSY_TIMEOUT_MS}")
    return db


def ensure_schema(db: sqlite3.Connection) -> None:
    """Idempotent; every entry point calls it so no caller has to remember."""
    db.execute(_SCHEMA)
    db.commit()


def _reclaim(db: sqlite3.Connection, now: float, key: tuple[str, str, str] | None = None) -> int:
    """Delete every reclaimable lease (optionally only one key's); return the count.

    Reclaimable means **either** the holder's pid is gone -- immediate, and
    the whole reason the row exists -- **or** the heartbeat has aged past the
    TTL, which is the backstop for a pid that was reused by an unrelated
    process. Deletes are identity-scoped on `run_id` so a row that was
    replaced between the SELECT and the DELETE is left alone.
    """
    sql, params = (_SELECT, ()) if key is None else (_SELECT_ONE, key)
    rows = db.execute(sql, params).fetchall()
    dead = [
        (tenant, agent, kind, run_id)
        for tenant, agent, kind, run_id, pid, heartbeat_at in rows
        if not _pid_alive(int(pid)) or heartbeat_at <= now - LEASE_TTL_SECONDS
    ]
    for owned_key in dead:
        db.execute(_DELETE_OWNED, owned_key)
    db.commit()
    return len(dead)


def sweep_expired(db: sqlite3.Connection, now: float) -> int:
    """Delete every reclaimable lease; return the count.

    A convenience for startup and for observability. Correctness does not
    depend on anyone calling it -- `RunLease.__enter__` reclaims its own key,
    the same way auto-run.sh:427 reclaims its own stale lock. Requiring an
    external sweep would have made the row a *new* orphan class, strictly
    worse than the lock file it accompanies.
    """
    ensure_schema(db)
    return _reclaim(db, now)


class RunLease:
    """Context manager holding one account's run lease for the duration of a cycle.

    Both halves are released on `__exit__` unconditionally -- normal return,
    `Exception`, `KeyboardInterrupt`, `SystemExit(141)`. That is the whole
    point: the orphan locks this replaces came from a path that exited
    without running its cleanup.
    """

    def __init__(
        self,
        db: sqlite3.Connection,
        agent_root: Path,
        tenant: str,
        agent_dir_name: str,
        kind: LeaseKind,
        *,
        run_id: str | None = None,
        now: Callable[[], float] = time.time,
    ) -> None:
        """`agent_dir_name` is the **persona directory name**, not the username.

        auto-run.sh:407 derives the lock name with `basename "$agent_dir"` and
        builds `.agent-state/lock_${agent_name}` from it (:408); dream.sh:460
        does the same with the name it was invoked with, which `_find_dir`
        resolves as a directory under `agents/` or `humans/`. Folder name and
        registered username diverge for several accounts on this roster, and a
        lease built from the username computes a *different* lock path than
        the Bash round it is meant to exclude -- with every test still green,
        because both runtimes would simply be locking files no one else looks
        at. Pass `Path(persona_dir).name`.
        """
        if kind not in _LOCK_PATH:
            # There is no Bash lock file for a third kind, so a typo would run
            # with no cross-runtime exclusion at all rather than failing loudly.
            raise ValueError(f"unknown lease kind: {kind!r}")
        self._db = db
        self._key = (tenant, agent_dir_name, kind)
        # Defaults to the pid for the same reason Bash writes `$$` into the
        # lock file: with no run id supplied, "who holds this" should still
        # be answerable. The graph passes `CycleState["run_id"]`.
        self._run_id = f"pid-{os.getpid()}" if run_id is None else run_id
        self._owned_key = (*self._key, self._run_id)
        self._pid = os.getpid()
        self._now = now
        self._lock_path = _LOCK_PATH[kind](agent_root, agent_dir_name)
        self._lock = FileLock(self._lock_path)
        self._lock_inode: int | None = None

    def _holds_lock_file(self) -> bool:
        """Is the file at the lock path still the one this lease created?

        Inode rather than pid, because a reclaim is unlink-then-create
        (auto-run.sh:428-429, dream.sh:469-470) and the replacement gets a new
        inode even when the reclaiming process happens to share our pid.
        """
        if self._lock_inode is None:
            return False
        try:
            return self._lock_path.stat().st_ino == self._lock_inode
        except OSError:
            return False

    def __enter__(self) -> RunLease:
        try:
            self._lock.acquire()
        except LockBusy as exc:
            # Bash (or another Python run) got there first. No row is written,
            # so nothing has to be rolled back.
            raise LeaseBusy(*self._key, str(exc)) from exc
        with contextlib.suppress(OSError):
            self._lock_inode = self._lock_path.stat().st_ino
        try:
            ensure_schema(self._db)
            now = self._now()
            _reclaim(self._db, now, self._key)
            self._db.execute(_INSERT, (*self._key, self._run_id, self._pid, now, now))
            self._db.commit()
        except Exception as exc:
            # Every failure past this point -- conflict, `database is locked`,
            # a closed connection -- must give the file lock back. Catching
            # only IntegrityError is what strands a lock file.
            self._release_lock_file()
            if isinstance(exc, sqlite3.IntegrityError):
                raise LeaseBusy(*self._key, "lease row already held") from exc
            raise
        return self

    def heartbeat(self, *, now: float | None = None) -> None:
        """Mark the lease alive: advance the row, and refresh the lock file's mtime.

        Both, because the two runtimes read different things. Bash's staleness
        test is the file's mtime (auto-run.sh:422, dream.sh:463), so a long
        cycle that only heartbeat the row would have its lock file reclaimed
        out from under it by the next Bash round -- the double-run the file
        half exists to prevent. The file is touched with the real wall clock
        rather than `now`, because `FileLock` compares against `time.time()`;
        an injected test clock written into the mtime would read as decades
        stale.

        Both writes are identity-scoped. A lease that was legitimately
        reclaimed while still running updates zero rows and touches nothing,
        rather than extending its successor's claim on its behalf.

        The row write is best-effort. `run_cycle` calls this between every
        graph superstep with no guard of its own (spec §15.1 row 23), so a
        `sqlite3.OperationalError` here -- realistically `database is locked`,
        stage 4's 3-5 concurrent Python cycles sharing `run_leases.sqlite`
        with `busy_timeout` already exhausted -- would otherwise propagate out
        of `run_cycle` and end the round over a single missed beat. That is
        the wrong failure mode: a missed beat is recoverable (the next node's
        heartbeat tries again), a dead round is not. But it is not swallowed
        silently either -- a heartbeat that keeps failing is functionally
        identical, from Bash's side, to a process that stopped heartbeating
        for real, and Bash reclaims this lease's file half after
        `LEASE_TTL_SECONDS` regardless of why the row went stale. Logged at
        WARNING, so an operator sees a struggling lease well before that
        1800s clock runs out and a second runtime starts acting on the same
        account -- not after. The lock file below is still touched
        regardless of whether the row write succeeded: it is the
        Bash-visible half of this same beat and does not depend on SQLite.
        """
        stamp = self._now() if now is None else now
        try:
            self._db.execute(_TOUCH, (stamp, *self._owned_key))
            self._db.commit()
        except sqlite3.OperationalError as exc:
            logger.warning(
                "lease heartbeat failed for %s:%s %s (run_id=%s): %s -- row not refreshed",
                *self._key,
                self._run_id,
                exc,
            )
        if self._holds_lock_file():
            # Gone means someone swept `.agent-state/` by hand mid-round; the
            # row is still the liveness record, so do not kill the cycle.
            with contextlib.suppress(OSError):
                os.utime(self._lock_path, None)

    def _release_lock_file(self) -> None:
        """Unlink the lock file only while it is still the one we created.

        `FileLock.release()` unlinks whatever is at the path. If this lease
        was reclaimed as stale and a successor recreated the file, that unlink
        would leave a live successor holding no lock at all -- and Bash would
        then be free to start a second round on the same account.
        """
        if self._lock_inode is None or self._holds_lock_file():
            self._lock.release()

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        try:
            self._db.execute(_DELETE_OWNED, self._owned_key)
            self._db.commit()
        finally:
            # `finally`, so a dead database on the way out cannot strand the
            # Bash-visible lock. The row expires on its own after the TTL;
            # the lock file would not.
            self._release_lock_file()
