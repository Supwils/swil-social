"""Tests for `swil_agent.dream.drift`: cosine similarity, per-aspect breach
detection, pairwise variance, and anchor resolution.

These three math routines lived as Python heredocs inside `dream.sh` --
`_cosine_sim`, `_aspect_breached`, `_pairwise_variance` -- which is exactly
why `_pairwise_variance` was silently broken for months: its heredoc form
received the vectors on stdin while the heredoc itself WAS python's stdin,
so `sys.stdin.read()` always returned `''` and the function fell through to
its `1.0` fallback on every single call. `1.0 < ECHO_VARIANCE_THRESHOLD
(0.04)` is never true, so echo-chamber detection never fired for any
account, ever, and nothing could catch it because nothing could import and
call the function without a shell. This module makes that class of bug
findable: no HTTP, no subprocess, importable and callable from a plain
`pytest` run.

Values below (thresholds, fail-open constants, the header regex) are
transcribed verbatim from `agent/scripts/dream.sh` -- read directly, not
from the contract docs, per this plan's README precedence rule ("where
these documents disagree with the scripts, the scripts win"). Cross-checked
line-for-line against `dream.sh:118-136` (`_cosine_sim`), `dream.sh:192-218`
(`_pairwise_variance`), `dream.sh:343-356` (`_aspect_breached`), and
`dream.sh:220-247` (`_anchor_text_for`) during implementation; no
discrepancy found between the brief and the script for this task's scope.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from swil_agent.dream.drift import (
    ARCHIVE_HEADER_RE,
    aspect_breaches,
    canonical_document_text,
    cosine_sim,
    pairwise_variance,
    resolve_anchor_text,
)
from swil_agent.models import AspectSims, AspectThresholds
from swil_agent.persona.source import ARCHIVE_HEADER

DEFAULT_THRESHOLDS = AspectThresholds()

AGENT_ROOT = Path(__file__).resolve().parents[2]
FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"


def load_fixture(name: str) -> list[list[float]]:
    """Load a JSON array of embedding vectors committed next to this test
    file (see the comment on `test_variance_of_real_roster_data_is_far_below_the_shipped_threshold`
    below for how `echo_vectors_zenith.json` was captured)."""
    data: list[list[float]] = json.loads((Path(__file__).parent / name).read_text("utf-8"))
    return data


def _mean_pairwise_cosine(vectors: list[list[float]]) -> float:
    """Mean cosine similarity over every unordered pair in `vectors`, via the
    module's own `cosine_sim` (so this also exercises `cosine_sim` on real
    data, not just synthetic 2-D examples). Used only by the calibration
    test below as a sanity check that a fixture is genuine embeddings rather
    than noise -- `pairwise_variance` itself never needs a mean on its own,
    only the variance of the same pairwise similarities."""
    sims = [cosine_sim(a, b) for i, a in enumerate(vectors) for b in vectors[i + 1 :]]
    return sum(sims) / len(sims)


def _archive(newer: str, older: str) -> str:
    """Build a two-block archive file using the SAME header format
    `persona/source.py`'s `ARCHIVE_HEADER` writes (imported above, not
    hand-copied), so this fixture cannot drift out of lockstep with the
    module that produces real archive files. `newer` is prepended -- i.e.
    it is the block a naive "first match wins" implementation would return
    -- and `older` is what a correct "last match wins" implementation must
    return instead.
    """
    newer_block = ARCHIVE_HEADER.format(stamp="2026-08-10 09:00:00") + newer + "\n"
    older_block = ARCHIVE_HEADER.format(stamp="2026-01-01 00:00:00") + older + "\n"
    return newer_block + older_block


# ── cosine_sim ───────────────────────────────────────────────────────────


def test_cosine_of_identical_unit_vectors_is_one() -> None:
    assert cosine_sim([1.0, 0.0], [1.0, 0.0]) == pytest.approx(1.0)


def test_cosine_of_orthogonal_vectors_is_zero() -> None:
    assert cosine_sim([1.0, 0.0], [0.0, 1.0]) == pytest.approx(0.0)


def test_cosine_clamps_floating_point_overshoot() -> None:
    assert cosine_sim([1.0 + 1e-9], [1.0 + 1e-9]) <= 1.0


@pytest.mark.parametrize(("a", "b"), [([], [1.0]), ([1.0], []), ([1.0], [1.0, 2.0])])
def test_cosine_fails_open_to_one(a: list[float], b: list[float]) -> None:
    # What this fail-open costs: 1.0 can never itself cause a rejection, and
    # it can never distinguish "genuinely identical" from "computation
    # failed" -- callers (dream/gate.py, Task 11) must check their vectors
    # are non-empty BEFORE calling this, rather than trusting the number it
    # returns. The two tests above (identical / orthogonal) are what
    # protects this test from passing against a `return 1.0`-always stub:
    # they'd fail immediately if cosine_sim ignored its input.
    assert cosine_sim(a, b) == 1.0


# ── aspect_breaches ──────────────────────────────────────────────────────


def test_no_breach_when_every_aspect_is_at_or_above_threshold() -> None:
    sims = AspectSims(values=0.63, style=0.72, topic=0.71)
    assert aspect_breaches(sims, DEFAULT_THRESHOLDS) == []


def test_equal_to_the_threshold_is_not_a_breach() -> None:
    # Mutation this pins: changing `<` to `<=` in aspect_breaches would flag
    # "values" here (0.63 == 0.63), breaking this test.
    sims = AspectSims(values=0.63, style=0.99, topic=0.99)
    assert aspect_breaches(sims, DEFAULT_THRESHOLDS) == []


def test_each_aspect_breaches_independently() -> None:
    sims = AspectSims(values=0.10, style=0.99, topic=0.10)
    assert aspect_breaches(sims, DEFAULT_THRESHOLDS) == ["values", "topic"]


def test_all_three_aspects_can_breach_simultaneously() -> None:
    # The test above deliberately keeps style un-breached to prove
    # independence; this one exercises the style branch on its own so the
    # "style" append line isn't left dark by every other test in this file.
    sims = AspectSims(values=0.10, style=0.10, topic=0.10)
    assert aspect_breaches(sims, DEFAULT_THRESHOLDS) == ["values", "style", "topic"]


# ── pairwise_variance ────────────────────────────────────────────────────


def test_variance_needs_at_least_three_vectors() -> None:
    assert pairwise_variance([[1.0, 0.0], [0.0, 1.0]]) == 1.0
    assert pairwise_variance([]) == 1.0


def test_variance_of_identical_vectors_is_zero() -> None:
    # Mutation this pins: a `return 1.0` unconditional stub would fail this
    # (1.0 != approx(0.0)), proving the success path is actually exercised
    # and not just the fail-open constant.
    assert pairwise_variance([[1.0, 0.0]] * 4) == pytest.approx(0.0)


def test_variance_skips_mismatched_lengths_rather_than_failing() -> None:
    vectors = [[1.0, 0.0], [0.0, 1.0], [1.0, 0.0], [1.0]]
    assert pairwise_variance(vectors) == pytest.approx(pairwise_variance(vectors[:3]))


def test_variance_falls_back_to_one_when_no_pair_shares_a_length() -> None:
    # A distinct fail-open path from "fewer than 3 vectors": 3 usable
    # vectors, but every pairwise length differs, so no dot product is ever
    # computed and `sims` ends up empty.
    vectors = [[1.0], [1.0, 0.0], [1.0, 0.0, 0.0]]
    assert pairwise_variance(vectors) == 1.0


def test_variance_of_real_roster_data_is_far_below_the_shipped_threshold() -> None:
    # The calibration question the heredoc bug made unanswerable for months.
    # Measured roster-wide range is 0.001-0.011 against a shipped threshold of
    # 0.04, which is why ECHO_DETECT stays off: enabling it as-is flags every
    # account on every dream.
    #
    # `echo_vectors_zenith.json` (committed next to this file) holds 12 REAL
    # bge-m3 vectors: zenith's own local embedder daemon (BAAI/bge-m3, MPS,
    # port 7777) was booted for this task and used to embed 12 real "post"
    # excerpts pulled from `agent/agents/zenith/memory.md`'s `| post |`
    # lines (each truncated to 80 chars, matching how memory.md itself
    # records them).
    vectors = load_fixture("echo_vectors_zenith.json")

    # Upper bound -- answers the calibration question itself: measured
    # variance over these 12 real vectors is ~0.00703, inside the documented
    # 0.001-0.011 range and nowhere near a coincidental floating-point equal
    # to any fail-open constant, so this genuinely exercises the real
    # formula rather than accidentally passing via the <3-vectors fallback.
    assert pairwise_variance(vectors) < 0.04

    # Lower bound -- proves the fixture IS real, topically-related
    # embeddings, not fabricated/random data that would also clear the
    # upper bound. Random unit vectors in 1024 dimensions have pairwise
    # cosine similarity clustered near 0 with variance ~1/1024 ~ 0.001 --
    # i.e. random noise passes the `< 0.04` check above too, so that
    # assertion ALONE cannot tell genuine embeddings apart from invented
    # numbers. Measured mean pairwise similarity here is ~0.563 (range
    # 0.41-0.83) -- the signature of topically-related real text, which
    # random vectors cannot produce. 0.3 leaves comfortable margin below
    # that measurement without being brittle to a future re-capture of this
    # fixture from a different 12 posts.
    assert _mean_pairwise_cosine(vectors) > 0.3


# ── resolve_anchor_text ──────────────────────────────────────────────────


def test_pinned_anchor_file_wins(tmp_path: Path) -> None:
    (tmp_path / "personality.anchor.md").write_text("PINNED", encoding="utf-8")
    (tmp_path / "personality.archive.md").write_text(_archive("OLD", "OLDER"), encoding="utf-8")
    (tmp_path / "personality.md").write_text("CURRENT", encoding="utf-8")
    assert resolve_anchor_text(tmp_path) == "PINNED"


def test_oldest_archive_block_is_the_last_one_in_the_file(tmp_path: Path) -> None:
    (tmp_path / "personality.archive.md").write_text(_archive("NEWER", "OLDEST"), encoding="utf-8")
    (tmp_path / "personality.md").write_text("CURRENT", encoding="utf-8")
    assert resolve_anchor_text(tmp_path) == "OLDEST"


def test_a_headerless_archive_returns_the_whole_file(tmp_path: Path) -> None:
    (tmp_path / "personality.archive.md").write_text("LEGACY BLOB", encoding="utf-8")
    assert resolve_anchor_text(tmp_path) == "LEGACY BLOB"


def test_no_archive_falls_back_to_the_current_personality(tmp_path: Path) -> None:
    (tmp_path / "personality.md").write_text("CURRENT", encoding="utf-8")
    assert resolve_anchor_text(tmp_path) == "CURRENT"


def test_pinned_anchor_keeps_leading_whitespace_but_drops_trailing_newlines(
    tmp_path: Path,
) -> None:
    """`dream.sh:228`'s pinned branch is `cat "$anchor_pin"` inside a
    `$( )` command substitution (dream.sh:310), which strips ONLY trailing
    newlines -- leading whitespace and trailing spaces survive. `.strip()`
    would eat both ends; this pins `.rstrip("\n")` instead."""
    (tmp_path / "personality.anchor.md").write_text("  PINNED \n\n\n", encoding="utf-8")
    assert resolve_anchor_text(tmp_path) == "  PINNED "


def test_personality_fallback_keeps_leading_whitespace_but_drops_trailing_newlines(
    tmp_path: Path,
) -> None:
    """Branch 3 (`cat "$dir/personality.md"`, dream.sh:246) has the same
    shape as branch 1, and neither has the archive branch's inline
    `print(...strip())`."""
    (tmp_path / "personality.md").write_text("  CURRENT \n\n", encoding="utf-8")
    assert resolve_anchor_text(tmp_path) == "  CURRENT "


# The sha256 a live Bash round computes for `quant`'s pinned anchor:
#
#   anchor_text="$(cat agent/agents/quant/personality.anchor.md)"
#   printf '%s' "$anchor_text" | shasum -a 256
#   -> a72c37529742f4544f3585593a99da504446d8d6f630d2abb3b8201176e6085c
#
# Independently corroborated by that account's WARM on-disk aspect cache,
# `agent/agents/quant/personality.anchor.aspects.json`, whose `"key"` field
# reads `a72c...085c:v2` -- written by Bash itself on a real dream. That
# file is gitignored (it holds 3x1024 floats), so the value is pinned here
# as a literal rather than read back from a path this worktree does not
# have.
_QUANT_ANCHOR_BASH_SHA256 = "a72c37529742f4544f3585593a99da504446d8d6f630d2abb3b8201176e6085c"
# What `read_text()` alone produced before the fix -- kept so the test can
# assert the two are genuinely different bytes, i.e. that it is capable of
# failing.
_QUANT_ANCHOR_RAW_SHA256 = "ebd2f119095ae0900aed365e0fe75f221a2f65439866c5c0349c04db37c73e69"


def test_pinned_anchor_of_a_real_account_hashes_to_the_bash_value(tmp_path: Path) -> None:
    """The pinned branch, on REAL content, against the sha256 Bash produces.

    Content is `tests/fixtures/quant_personality.anchor.md`, a committed
    byte-copy of `agent/agents/quant/personality.anchor.md` (the roster's
    only `personality.anchor.md`) -- copied in rather than read from the
    live roster so this pin cannot be invalidated by ordinary roster churn,
    and copied in rather than synthesised so it carries the real file's
    trailing newline and CJK body.

    Why it matters: this string is sha256'd into the anchor aspect cache key
    (`dream/distill.py`'s `anchor_cache_key`). One extra trailing `\n` and
    Python's key never equals the key Bash wrote, so the warm cache misses
    permanently and BOTH runtimes re-distill the anchor on every dream (~3
    `claude` calls + 3 embeds each). `quant` is precisely the account that
    can least afford it -- it already fails the topic aspect 7 rounds in 8.
    """
    (tmp_path / "personality.anchor.md").write_bytes(
        (FIXTURES / "quant_personality.anchor.md").read_bytes()
    )
    resolved = resolve_anchor_text(tmp_path)
    assert hashlib.sha256(resolved.encode()).hexdigest() == _QUANT_ANCHOR_BASH_SHA256
    # The fixture really does end in a newline, so a raw read is a DIFFERENT
    # hash -- without this the assertion above could pass vacuously on a
    # file that happened to have none.
    raw = (FIXTURES / "quant_personality.anchor.md").read_text(encoding="utf-8")
    assert hashlib.sha256(raw.encode()).hexdigest() == _QUANT_ANCHOR_RAW_SHA256


def test_the_real_zenith_archive_resolves_to_its_oldest_block() -> None:
    # Real-roster proof that "last match" (not "first match") is correct:
    # `agent/agents/zenith/personality.archive.md` has 19 archive headers.
    # Using the FIRST match would anchor zenith to its most recent dream
    # and make drift read as ~1.0 forever -- the exact failure mode this
    # test exists to catch. Resolved via Path(__file__) rather than a
    # cwd-relative literal, since tests run via `cd agent && uv run
    # pytest`, matching the AGENT_ROOT convention every other golden test
    # in this suite already uses (see tests/golden/test_persona_loader.py).
    text = resolve_anchor_text(AGENT_ROOT / "agents" / "zenith")
    assert text.startswith("# ")
    assert "旧版 personality" not in text


# ── ARCHIVE_HEADER_RE stays in lockstep with persona/source.py ───────────


def test_archive_header_re_matches_what_source_py_writes() -> None:
    written = ARCHIVE_HEADER.format(stamp="2026-08-17 12:00:00")
    assert ARCHIVE_HEADER_RE.match(written) is not None


# ── canonical_document_text ─────────────────────────────────────────────


def test_canonical_document_text_strips_only_trailing_newlines() -> None:
    """It is `$( )`'s rule, and the ONE normalisation every personality
    document goes through before it is embedded (`dream/gate.py` compares
    the anchor, the current document and the candidate, and two of the
    three routinely ARE the same document).

    Each of the four assertions below kills a different plausible
    substitution: `.strip()` (would eat the leading newline and the
    trailing space), `.rstrip()` (would eat the trailing space), `.strip("\n")`
    (would eat the leading newline), and doing nothing at all.
    """
    assert canonical_document_text("# doc\n\n\n") == "# doc"
    assert canonical_document_text("\n# doc") == "\n# doc"
    assert canonical_document_text("# doc  ") == "# doc  "
    assert canonical_document_text("# doc") == "# doc"


def test_a_pinned_anchor_is_canonicalised_the_same_way(tmp_path: Path) -> None:
    """`resolve_anchor_text` and the gate's current-document read must apply
    the SAME rule, or a first-ever dream's two identical documents hash to
    two different cache keys and the account pays for an extra embed --
    and, worse, `anchor_sim` and `step_sim` stop being comparable to each
    other for a reason that has nothing to do with the account.

    Mutation this kills: `resolve_anchor_text`'s pinned branch reverting to
    a bare `.read_text()` or to `.strip()`.
    """
    (tmp_path / "personality.anchor.md").write_text("# pinned\n\n", encoding="utf-8")
    assert resolve_anchor_text(tmp_path) == canonical_document_text("# pinned\n\n")
    assert resolve_anchor_text(tmp_path) == "# pinned"
