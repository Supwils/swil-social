"""The daily activity dashboard, read by a human.

Port of `agent/scripts/agent-summary.sh` (frozen; that script, not any prose
about it, is the contract). LOCAL ONLY -- there is no API call anywhere in
this module, and there is none in the script either. It reads each account's
`memory.md` and prints posts / comments / likes / follows for one date, the
latest line, and the total line count (the rotation-candidate signal).

It reads `memory.md`, NOT `auto-run.log`; a brief in an earlier plan claimed
the opposite and was wrong.

CLAUDE.md documents `bash agent/scripts/agent-summary.sh` as an everyday
command and its output is read by eye, so the layout is reproduced column for
column rather than improved -- see `render_summary`.

`run_summary` returns the text instead of printing it: the CLI owns stdout,
the same split every other entry point in this package uses, and it is what
lets the whole layout be asserted in a test without capturing a stream.
"""

from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Final

from pydantic import BaseModel, ConfigDict

MEMORY_FILENAME: Final = "memory.md"

# `for base in agents humans` (agent-summary.sh:25). Cohort order is the
# output order and agents come first.
COHORTS: Final = ("agents", "humans")

# The four `grep -c` lines (agent-summary.sh:35-38), in column order.
ACTION_KINDS: Final = ("post", "comment", "like", "follow")

# `cut -c1-60` (:44). CHARACTERS, not bytes: BSD `cut -c` is codepoint-based
# in a UTF-8 locale, and these lines are CJK-heavy, so a byte slice would
# show a fifth of the text and could split a character.
LATEST_MAX_CHARS: Final = 60

# `${latest:-(empty)}` (:47) -- a memory.md whose last line is blank.
EMPTY_LATEST: Final = "(empty)"

_HEADER: Final = ("ACCOUNT", "POST", "CMNT", "LIKE", "FOLL", "TOTAL", "LATEST")
_RULES: Final = (
    "──────────────",
    "─────",
    "─────",
    "─────",
    "─────",
    "─────",
    "──────────",
)

TIP_LINE: Final = "Tip: bash scripts/rotate-memory.sh — archives memory.md when total > 500"


class AccountActivity(BaseModel):
    """One row of the dashboard.

    `latest` is the raw (already truncated) last line -- empty stays empty
    here, and `render_summary` is the only place it becomes `(empty)`, so
    the data and its presentation do not have to agree about what a blank
    memory.md means.
    """

    model_config = ConfigDict(frozen=True)

    name: str
    posts: int
    comments: int
    likes: int
    follows: int
    total: int
    latest: str


def memory_lines(text: str) -> list[str]:
    """The lines `grep` and `tail` would see.

    `split("\\n")` with the trailing empty element dropped, NOT
    `str.splitlines()`: splitlines also breaks on `\\r`, `\\v`, `\\f` and
    U+2028, and strips a `\\r` before a `\\n`. `grep` and `tail` break on
    `\\n` alone and leave a CR at the end of the line, where it is part of
    what `cut -c1-60` then measures.

    A file not ending in a newline still has a final line (`tail -1` prints
    it), which is why only ONE trailing empty is dropped.
    """
    lines = text.split("\n")
    if lines and lines[-1] == "":
        lines.pop()
    return lines


def count_action(lines: list[str], date: str, action: str) -> int:
    """`grep -c "^${DATE}.*| post |"` (agent-summary.sh:35-38).

    In a POSIX BRE `|` is a literal pipe, so the pattern is: the line starts
    with `date`, and the literal `| post |` appears somewhere at or after
    that prefix. `.*` matching greedily then backtracking is exactly "there
    exists such a position", which is what `in` says.

    DIVERGENCE, deliberate: `date` is interpolated into a regex by Bash, so
    a caller passing `2026.08.19` would get `.` as a wildcard there. It is
    treated as a literal string here -- an argument that names a day is
    data, not a pattern, and no caller has ever passed one that is not
    `YYYY-MM-DD`.
    """
    marker = f"| {action} |"
    return sum(1 for line in lines if line.startswith(date) and marker in line[len(date) :])


def summarise_account(name: str, memory_text: str, date: str) -> AccountActivity:
    """One account's row.

    `total` is `wc -l`, i.e. the number of NEWLINES -- deliberately not
    `len(memory_lines(...))`. The two differ by one for a file with no
    trailing newline, and this number is compared against 500 by
    `rotate-memory.sh`.
    """
    lines = memory_lines(memory_text)
    counts = [count_action(lines, date, action) for action in ACTION_KINDS]
    return AccountActivity(
        name=name,
        posts=counts[0],
        comments=counts[1],
        likes=counts[2],
        follows=counts[3],
        total=memory_text.count("\n"),
        latest=(lines[-1] if lines else "")[:LATEST_MAX_CHARS],
    )


def collect_activity(agent_root: Path, date: str) -> list[AccountActivity]:
    """Every account with a `memory.md`, agents before humans, each cohort
    sorted.

    Bash's `*/` glob expands in sorted order and every account directory is
    ASCII, so `sorted()` reproduces it. A missing cohort directory is
    skipped (`[[ ! -d ... ]] && continue`, :26) and so is an account with no
    `memory.md` (:31) -- a brand-new account that has never acted has no row
    at all rather than a row of zeros.

    `errors="replace"` rather than a hard decode: `grep` and `wc` are
    byte-oriented and never fail on one bad byte, and a dashboard that
    raises on a single corrupt account is worse than one that shows a
    replacement character in its `LATEST` column.

    Dropping `if p.is_dir()` is an EQUIVALENT mutant today (standing
    constraint §7): the next test is `(p / "memory.md").is_file()`, which is
    False for every non-directory, so a stray `agents/README.md` is skipped
    either way. The filter stays because it is what bash's `*/` glob means,
    and the equivalence expires the moment anything reads `p.name` or writes
    a row before that inner test.
    """
    rows: list[AccountActivity] = []
    for cohort in COHORTS:
        base = agent_root / cohort
        if not base.is_dir():
            continue
        for directory in sorted(p for p in base.iterdir() if p.is_dir()):
            memory = directory / MEMORY_FILENAME
            if not memory.is_file():
                continue
            text = memory.read_text(encoding="utf-8", errors="replace")
            rows.append(summarise_account(directory.name, text, date))
    return rows


def render_summary(rows: list[AccountActivity], date: str) -> str:
    """The dashboard as text, ending in a newline.

    `%-14s %5s %5s %5s %5s %5s   %s` (agent-summary.sh:20-23, :46) -- note
    the THREE spaces before the last column and one everywhere else.

    Bash's `printf` pads by BYTES and Python's format spec pads by
    CHARACTERS. The rule row is unaffected: `──────────────` is 14
    characters (42 bytes) and each `─────` is 5 (15 bytes), so both are
    already at or over their field width and neither implementation pads
    them. Account names are ASCII, where the two measures agree. The
    `LATEST` column has no width at all.
    """
    lines = [
        _row(*_HEADER),
        _row(*_RULES),
    ]
    for row in rows:
        lines.append(
            _row(
                row.name,
                str(row.posts),
                str(row.comments),
                str(row.likes),
                str(row.follows),
                str(row.total),
                row.latest or EMPTY_LATEST,
            )
        )
    lines.extend(["", f"Date: {date}", TIP_LINE])
    return "\n".join(lines) + "\n"


def _row(
    account: str, posts: str, comments: str, likes: str, follows: str, total: str, latest: str
) -> str:
    return f"{account:<14} {posts:>5} {comments:>5} {likes:>5} {follows:>5} {total:>5}   {latest}"


def local_today(now: datetime) -> str:
    """`$(date '+%Y-%m-%d')` (agent-summary.sh:18) -- LOCAL time, not UTC.

    Takes `now` rather than reading the clock so the default is decided by
    the caller and is pinnable in a test; `run_summary` requires an explicit
    `date` for the same reason.
    """
    return now.strftime("%Y-%m-%d")


def run_summary(agent_root: Path, *, date: str) -> str:
    """Read every `memory.md` under `agent_root` and render the dashboard."""
    return render_summary(collect_activity(agent_root, date), date)
