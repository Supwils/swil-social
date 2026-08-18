"""Drift math: cosine similarity, per-aspect breach, pairwise variance, and
anchor resolution.

These four pieces were Python already -- embedded as heredocs inside
`dream.sh` (`_cosine_sim`, `_aspect_breached`, `_pairwise_variance`,
`_anchor_text_for`) -- which is precisely why one of them went undetected
for months: `_pairwise_variance`'s original call signature piped its input
on stdin into a script invoked as `python3 - <<'PY'`, which binds the
heredoc ITSELF to python's stdin, so `sys.stdin.read()` inside the script
always returned `''`. Every call silently fell through to the `1.0`
fallback, and `1.0 < ECHO_VARIANCE_THRESHOLD (0.04)` is never true, so
echo-chamber detection never fired for any account, ever -- and nothing
could catch it, because nothing could import and call a Bash heredoc
without a shell.

This module has no I/O beyond one file read (`resolve_anchor_text`, for the
pinned-anchor / archive / current-personality lookup). No `httpx`, no
`subprocess`, no imports from `api/` or `llm/` -- enforced by
`tests/unit/test_architecture.py::test_drift_module_does_no_io_beyond_reading_anchor_files`.
That constraint is the whole point: a module a test can import and call with
no daemon and no network is what makes this class of bug findable at all.

Values here (thresholds, fail-open constants, the archive header format) are
transcribed verbatim from `agent/scripts/dream.sh`, read directly rather
than from the contract docs -- this plan's README states that where the two
disagree, the script wins.
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from pathlib import Path
from typing import Final

from swil_agent.models import AspectSims, AspectThresholds

ARCHIVE_HEADER_RE: Final = re.compile(
    r"^---\s*\n# 旧版 personality（归档于 [\d\- :]+）\s*\n---\s*\n", re.MULTILINE
)
"""Matches one archive block header, byte-for-byte, in lockstep with
`persona/source.py`'s `ARCHIVE_HEADER` -- that module WRITES the header this
regex parses, and the two must never drift apart. `[\\d\\- :]+` covers the
`%Y-%m-%d %H:%M:%S` timestamp `source.py` formats into the `{stamp}` slot
(digits, hyphens, a space, colons)."""


def cosine_sim(a: Sequence[float], b: Sequence[float]) -> float:
    """Cosine similarity of two bge-m3 vectors.

    A plain dot product is correct here because the embedder returns
    L2-normalised vectors (`normalize_embeddings=True`, contract 04 §1).

    FAILS OPEN TO 1.0 on empty or mismatched-length input, matching
    `dream.sh:118-136`. That means this function can never itself cause a
    rejection -- and it can never distinguish "genuinely identical" from
    "computation failed" either. Callers must check their vectors are
    non-empty BEFORE calling, which is what `dream/gate.py` (Task 11) does;
    trusting the return value alone would silently treat a broken embed
    as a perfect match.
    """
    if not a or not b or len(a) != len(b):
        return 1.0
    dot = sum(x * y for x, y in zip(a, b, strict=True))
    return max(-1.0, min(1.0, dot))


def aspect_breaches(sims: AspectSims, thresholds: AspectThresholds) -> list[str]:
    """Aspect names whose similarity fell STRICTLY below their own threshold.

    Strictly `<`, not `<=`: a similarity exactly equal to its threshold is
    not a breach (`dream.sh:343-356`, `_aspect_breached`). An off-by-one
    here would silently change the acceptance rate of the whole roster.
    """
    breached: list[str] = []
    if sims.values < thresholds.values:
        breached.append("values")
    if sims.style < thresholds.style:
        breached.append("style")
    if sims.topic < thresholds.topic:
        breached.append("topic")
    return breached


def pairwise_variance(vectors: Sequence[Sequence[float]]) -> float:
    """Variance of all pairwise cosine similarities among recent post vectors.

    Low variance + high mean = "this account keeps saying the same thing"
    (echo-chamber signal).

    FAILS OPEN TO 1.0 with fewer than 3 usable vectors, matching
    `dream.sh:192-218`. A high "variance" value never trips the low-variance
    echo check (`variance < ECHO_VARIANCE_THRESHOLD`), so failure reads as
    "not an echo chamber" and never produces a false positive. This exact
    fallback is what hid the original defect: the heredoc form received its
    input on stdin while the heredoc itself WAS stdin, so the function saw
    "" every call and returned 1.0 for months without a single log line
    saying so -- see the module docstring.
    """
    usable = [list(v) for v in vectors if v]
    if len(usable) < 3:
        return 1.0
    sims = [
        sum(x * y for x, y in zip(a, b, strict=True))
        for i, a in enumerate(usable)
        for b in usable[i + 1 :]
        if len(a) == len(b)
    ]
    if not sims:
        return 1.0
    mean = sum(sims) / len(sims)
    return sum((s - mean) ** 2 for s in sims) / len(sims)


def resolve_anchor_text(directory: Path) -> str:
    """The text this account's drift is measured against (contract 04 §2).

    Priority:
      1. `<directory>/personality.anchor.md` -- an explicit pin, if present.
      2. The OLDEST block of `<directory>/personality.archive.md`, if that
         file exists.
      3. The current `<directory>/personality.md` -- the first-dream case,
         where drift is scored against itself.

    The archive is NEWEST-FIRST -- every accepted dream prepends its block
    (`persona/source.py`'s `archive_and_write`, `dream.sh:834-847`) -- so the
    oldest version is whatever follows the LAST header match in the file.
    Using the FIRST match would anchor every account to its most recent
    dream and make drift read as ~1.0 forever; this is proven against real
    roster data in `test_the_real_zenith_archive_resolves_to_its_oldest_block`,
    not just a synthetic fixture.

    `ARCHIVE_HEADER_RE` must stay in lockstep with `ARCHIVE_HEADER` in
    `persona/source.py`: that module writes what this reads.
    """
    pinned = directory / "personality.anchor.md"
    if pinned.exists():
        return pinned.read_text(encoding="utf-8")

    archive = directory / "personality.archive.md"
    if archive.exists():
        text = archive.read_text(encoding="utf-8")
        matches = list(ARCHIVE_HEADER_RE.finditer(text))
        return text[matches[-1].end() :].strip() if matches else text.strip()

    return (directory / "personality.md").read_text(encoding="utf-8")
