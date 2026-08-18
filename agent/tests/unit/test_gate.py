"""Behavioural coverage for the dream gate (`dream/gate.py`, task 11).

`evaluate_candidate` composes three already-tested pieces (`persona.validators
.validate_candidate`, `dream.drift`'s cosine math, `dream.distill`'s aspect
distiller/embedder) into one accept/reject `DreamVerdict`. This file does not
re-test those pieces' own internals -- see `test_validators.py`,
`test_drift.py`, `test_distill.py` -- it tests the COMPOSITION: the fixed
order (structural checks first, hard rejects, independent of DRIFT_MODE), the
three `DRIFT_MODE` behaviours, and the two distinct fail-open paths (contract
`04` §5, `agent/scripts/dream.sh:668-826`, read directly).

Vectors below are deliberately 1-dimensional (`[0.95]`, `[0.10]`, ...) --
`cosine_sim`'s dot product over a 1-element list IS the value itself, so a
fixture can pin an EXACT similarity without hand-normalising a real
multi-dimensional embedding. `test_drift.py` uses the same trick
(`cosine_sim([1.0 + 1e-9], [1.0 + 1e-9])`).

Every scenario below that reaches the drift gate first writes
`<tmp_path>/personality.md` -- `evaluate_candidate` calls
`resolve_anchor_text(directory)` UNCONDITIONALLY (even in scalar mode, even
on a structurally-valid no-op candidate), so a directory with nothing on
disk would raise `FileNotFoundError` before the gate could decide anything.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

import pytest

from swil_agent.config import Settings, load_settings
from swil_agent.dream.distill import anchor_cache_key
from swil_agent.dream.gate import evaluate_candidate
from swil_agent.models import AspectSims, AspectVectors

from ._runners import FakeEmbedder, RecordingRunner, ScriptedRunner

ORIGINAL = """# 测试

## 身份
- **Username:** tester
- **Display Name:** 测试
- **Headline:** AI Agent
- **Bio:** 一句话
- **Follow Topics:** alpha,beta,gamma

- **AI Backend:** claude

## 性格
一些文字

## 发帖节律
- 每次触发有 60% 概率选择 post
"""

# The anchor cache key derivation ("2") must match gate.py's private
# `_ASPECT_PROMPT_VERSION` constant -- pinned here as a literal, same as
# `test_distill.py` does throughout, rather than importing a private name.
_PROMPT_VERSION = "2"


def _candidate_with_changed_username() -> str:
    return ORIGINAL.replace("- **Username:** tester", "- **Username:** someone_else")


def _candidate_missing_rhythm_section() -> str:
    return ORIGINAL.replace("## 发帖节律\n- 每次触发有 60% 概率选择 post\n", "")


def _write_anchor(directory: Path, text: str = ORIGINAL) -> None:
    (directory / "personality.md").write_text(text, encoding="utf-8")


def _write_anchor_cache(directory: Path, *, anchor_text: str, vectors: AspectVectors) -> None:
    """Pre-seeds a HIT for `dream.distill.anchor_aspects`, same on-disk shape
    `test_distill.py`'s `_write_cache` builds -- so a test can control the
    ANCHOR's aspect vectors without spending any embedder/runner call on
    them, leaving the embedder's call sequence free for the CANDIDATE side
    (and, before that, the two scalar-similarity calls `evaluate_candidate`
    always makes first).

    Keys on `anchor_text.rstrip("\n")`, not `anchor_text`: this directory
    has no `personality.anchor.md` and no archive, so `resolve_anchor_text`
    takes its third branch and mirrors `dream.sh`'s
    `anchor_text="$(cat "$dir/personality.md")"` -- `$( )` strips the
    trailing newline. Keying on the unstripped text seeds a cache MISS while
    LOOKING like a HIT, which shows up only as an unexplained extra
    runner/embedder call several asserts later."""
    _write_anchor(directory, anchor_text)
    key = anchor_cache_key(anchor_text.rstrip("\n"), prompt_version=_PROMPT_VERSION)
    payload = {
        "key": key,
        "cards": {"values": "unused-on-cache-hit", "style": "unused-on-cache-hit", "topic": "x"},
        "vectors": {"values": vectors.values, "style": vectors.style, "topic": vectors.topic},
    }
    (directory / "personality.anchor.aspects.json").write_text(
        json.dumps(payload, ensure_ascii=False), encoding="utf-8"
    )


_ANCHOR_ASPECTS_ALL_ONE = AspectVectors(values=[1.0], style=[1.0], topic=[1.0])
_VALID_CARDS_JSON = '{"values":"a","style":"b","topic":"c"}'


# ── Step 1: structural precedence ───────────────────────────────────────


def test_a_structural_failure_short_circuits_before_any_embedding(tmp_path: Path) -> None:
    """Mutation this catches: dropping the early `return` after a structural
    failure (or wrapping the whole function in one try/except) would let
    execution reach the drift gate and call the embedder at least once."""
    embedder = FakeEmbedder(fail_always=True)  # any call raises
    verdict = evaluate_candidate(
        ORIGINAL,
        _candidate_with_changed_username(),
        directory=tmp_path,
        embedder=embedder,
        runner=ScriptedRunner([]),  # any call raises
        settings=Settings(),
    )
    assert verdict.accepted is False
    # `validate_candidate`'s own detail carries the old->new diff
    # (`test_validators.py` already pins that shape); the gate is not
    # expected to throw that information away, only to surface it verbatim.
    assert verdict.reason.startswith("Username drift")
    assert embedder.call_count == 0


def test_a_structural_failure_reports_the_failing_check_not_a_generic_message(
    tmp_path: Path,
) -> None:
    """A distinct structural failure (missing rhythm section) must produce a
    distinct reason -- proves the gate forwards `ValidationFailure.detail`
    rather than a single canned rejection string for every structural check."""
    verdict = evaluate_candidate(
        ORIGINAL,
        _candidate_missing_rhythm_section(),
        directory=tmp_path,
        embedder=FakeEmbedder(fail_always=True),
        runner=ScriptedRunner([]),
        settings=Settings(),
    )
    assert verdict.accepted is False
    assert "发帖节律" in verdict.reason


# ── Step 2: DRIFT_MODE behaviour ────────────────────────────────────────


def test_scalar_mode_never_computes_aspects(tmp_path: Path) -> None:
    _write_anchor(tmp_path)
    embedder = FakeEmbedder([[1.0], [1.0]])
    runner = ScriptedRunner([])  # any distill call raises -- must never be reached
    verdict = evaluate_candidate(
        ORIGINAL,
        ORIGINAL,
        directory=tmp_path,
        embedder=embedder,
        runner=runner,
        settings=Settings(drift_mode="scalar"),
    )
    assert verdict.sims is None
    assert verdict.breached == []


def test_shadow_mode_computes_aspects_but_gates_on_the_scalar(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """The discriminating case: aspect sims ALL breach, but the scalar sim
    (0.95) is comfortably above the 0.82 default threshold. If the gate were
    accidentally deciding on the aspect result (the `aspect`-mode behaviour)
    instead of the scalar one, this would reject -- shadow mode must still
    accept."""
    _write_anchor_cache(tmp_path, anchor_text=ORIGINAL, vectors=_ANCHOR_ASPECTS_ALL_ONE)
    embedder = FakeEmbedder(
        [
            [1.0],  # scalar: anchor text
            [0.95],  # scalar: candidate text -> sim 0.95, above the 0.82 gate
            [0.10],  # candidate "values" card -> breaches (threshold 0.63)
            [0.10],  # candidate "style" card -> breaches (threshold 0.72)
            [0.10],  # candidate "topic" card -> breaches (threshold 0.71)
        ]
    )
    runner = RecordingRunner(_VALID_CARDS_JSON)
    with caplog.at_level(logging.INFO, logger="swil_agent.dream.gate"):
        verdict = evaluate_candidate(
            ORIGINAL,
            ORIGINAL,
            directory=tmp_path,
            embedder=embedder,
            runner=runner,
            settings=Settings(drift_mode="shadow"),
        )
    assert verdict.accepted is True
    assert verdict.sims == AspectSims(values=0.10, style=0.10, topic=0.10)
    # Contract 04 §5 step 3: the SHADOW-OBS line fires regardless of the
    # eventual accept/reject outcome, so calibration data accumulates from
    # rejected dreams too -- this dream's aspect sims all breached, yet it
    # was accepted (by the scalar gate), and the line must still be there.
    assert "SHADOW-OBS" in caplog.text


def test_shadow_mode_logs_shadow_obs_even_when_the_scalar_gate_rejects(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """Contract 04 §5 step 3's whole point: a shadow round's SHADOW-OBS line
    must fire on REJECTED dreams too, not just the ones that happen to pass,
    or calibration data would only ever describe the surviving population.
    The sibling test above only ever exercises the ACCEPTED case (scalar sim
    0.95); this pins the scalar sim BELOW threshold so the dream is
    rejected, and asserts the log line is there anyway -- with the aspect
    sims all HIGH (no breach) this time, so the only thing driving the
    rejection is the scalar gate, not a coincidental aspect breach. A gate
    that only logged SHADOW-OBS inside (or after) the accept branch -- e.g.
    conditioned on `scalar_sim >= settings.drift_threshold` -- would pass
    every other test in this file yet fail this one."""
    _write_anchor_cache(tmp_path, anchor_text=ORIGINAL, vectors=_ANCHOR_ASPECTS_ALL_ONE)
    embedder = FakeEmbedder(
        [
            [1.0],  # scalar: anchor text
            [0.10],  # scalar: candidate text -> sim 0.10, well below 0.82 -> reject
            [0.99],  # candidate "values" card -> fine (unused -- scalar decides)
            [0.99],  # candidate "style" card -> fine
            [0.99],  # candidate "topic" card -> fine
        ]
    )
    runner = RecordingRunner(_VALID_CARDS_JSON)
    with caplog.at_level(logging.INFO, logger="swil_agent.dream.gate"):
        verdict = evaluate_candidate(
            ORIGINAL,
            ORIGINAL,
            directory=tmp_path,
            embedder=embedder,
            runner=runner,
            settings=Settings(drift_mode="shadow"),
        )
    assert verdict.accepted is False
    assert "SHADOW-OBS" in caplog.text


def test_aspect_mode_rejects_on_a_single_breach(tmp_path: Path) -> None:
    _write_anchor_cache(tmp_path, anchor_text=ORIGINAL, vectors=_ANCHOR_ASPECTS_ALL_ONE)
    embedder = FakeEmbedder(
        [
            [1.0],  # scalar: anchor text (unused -- aspect mode decides)
            [1.0],  # scalar: candidate text
            [0.99],  # candidate "values" card -> fine (threshold 0.63)
            [0.10],  # candidate "style" card -> breaches (threshold 0.72)
            [0.99],  # candidate "topic" card -> fine (threshold 0.71)
        ]
    )
    runner = RecordingRunner(_VALID_CARDS_JSON)
    verdict = evaluate_candidate(
        ORIGINAL,
        ORIGINAL,
        directory=tmp_path,
        embedder=embedder,
        runner=runner,
        settings=Settings(drift_mode="aspect"),
    )
    assert verdict.accepted is False
    assert verdict.breached == ["style"]


def test_aspect_mode_accepts_when_nothing_breaches(tmp_path: Path) -> None:
    _write_anchor_cache(tmp_path, anchor_text=ORIGINAL, vectors=_ANCHOR_ASPECTS_ALL_ONE)
    embedder = FakeEmbedder([[1.0], [1.0], [0.99], [0.99], [0.99]])
    runner = RecordingRunner(_VALID_CARDS_JSON)
    verdict = evaluate_candidate(
        ORIGINAL,
        ORIGINAL,
        directory=tmp_path,
        embedder=embedder,
        runner=runner,
        settings=Settings(drift_mode="aspect"),
    )
    assert verdict.accepted is True
    assert verdict.breached == []


# ── Step 3: fail-open paths ──────────────────────────────────────────────


def test_a_failed_distill_falls_back_to_the_scalar_gate(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    _write_anchor_cache(tmp_path, anchor_text=ORIGINAL, vectors=_ANCHOR_ASPECTS_ALL_ONE)
    # Scalar-only vectors: the candidate's distill exhausts all 3 attempts on
    # garbage below, so aspect computation never reaches an embed call at all.
    embedder = FakeEmbedder([[1.0], [0.95]])
    runner = ScriptedRunner(["garbage"] * 3)
    with caplog.at_level(logging.WARNING, logger="swil_agent.dream.gate"):
        verdict = evaluate_candidate(
            ORIGINAL,
            ORIGINAL,
            directory=tmp_path,
            embedder=embedder,
            runner=runner,
            settings=Settings(drift_mode="aspect"),
        )
    assert verdict.accepted is True
    assert "falling back to scalar drift" in verdict.reason
    assert "falling back to scalar drift" in caplog.text
    assert runner.call_count == 3


def test_an_unreachable_embedder_skips_the_drift_check_entirely(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    _write_anchor(tmp_path)  # no cache -- forces a real (failing) attempt
    embedder = FakeEmbedder(fail_always=True)  # every embed call raises
    runner = RecordingRunner(_VALID_CARDS_JSON)  # distiller itself is fine
    with caplog.at_level(logging.WARNING, logger="swil_agent.dream.gate"):
        verdict = evaluate_candidate(
            ORIGINAL,
            ORIGINAL,
            directory=tmp_path,
            embedder=embedder,
            runner=runner,
            settings=Settings(),  # default: aspect
        )
    assert verdict.accepted is True
    assert "embedder unreachable" in verdict.reason
    assert "embedder unreachable" in caplog.text


def test_an_unreachable_embedder_still_enforces_the_structural_validators(
    tmp_path: Path,
) -> None:
    """The invariant CLAUDE.md states plainly: when the embedder is down the
    drift gate fails open, but the structural validators remain the hard
    floor. A port that wrapped the whole gate in one try/except would lose
    this and let a malformed personality.md onto disk during an outage."""
    verdict = evaluate_candidate(
        ORIGINAL,
        _candidate_missing_rhythm_section(),
        directory=tmp_path,
        embedder=FakeEmbedder(fail_always=True),
        runner=RecordingRunner(_VALID_CARDS_JSON),
        settings=Settings(),
    )
    assert verdict.accepted is False


def test_a_partial_candidate_embed_failure_falls_back_to_the_scalar_gate(
    tmp_path: Path,
) -> None:
    """Distinct failure point from `test_a_failed_distill_falls_back_to_the_
    scalar_gate` above: the candidate's cards distill FINE, but embedding
    one of them fails partway (`_embed_candidate_cards`'s own fail-open,
    mirroring `dream/distill.py`'s `_embed_cards` for the anchor side). Same
    externally-observable outcome (fall back to scalar), different internal
    branch -- this is what exercises it instead of leaving it dark."""
    _write_anchor_cache(tmp_path, anchor_text=ORIGINAL, vectors=_ANCHOR_ASPECTS_ALL_ONE)
    embedder = FakeEmbedder(
        [[1.0], [0.95]],  # only the two scalar calls succeed
        fail_on_call=3,  # the candidate's "values" card embed
    )
    runner = RecordingRunner(_VALID_CARDS_JSON)
    verdict = evaluate_candidate(
        ORIGINAL,
        ORIGINAL,
        directory=tmp_path,
        embedder=embedder,
        runner=runner,
        settings=Settings(drift_mode="aspect"),
    )
    assert verdict.accepted is True
    assert "falling back to scalar drift" in verdict.reason
    assert "drift OK" in verdict.reason


def test_scalar_gate_rejects_when_similarity_is_below_threshold(tmp_path: Path) -> None:
    """The other half of the scalar decision -- every other test in this file
    either accepts via the scalar gate or fails open before reaching it; this
    is what proves `scalar_sim < threshold` actually rejects, not just that
    the accept branch works."""
    _write_anchor(tmp_path)
    embedder = FakeEmbedder([[1.0], [0.10]])  # sim 0.10, well below 0.82
    verdict = evaluate_candidate(
        ORIGINAL,
        ORIGINAL,
        directory=tmp_path,
        embedder=embedder,
        runner=ScriptedRunner([]),  # scalar mode -- never touched
        settings=Settings(drift_mode="scalar"),
    )
    assert verdict.accepted is False
    assert "drift too large" in verdict.reason


# ── DRIFT_MODE default: Python deliberately diverges from dream.sh:62 ────


def test_load_settings_default_matches_the_deployed_drift_mode() -> None:
    """`dream.sh:62` defaults to `scalar` when `DRIFT_MODE` is unset in the
    environment. `Settings.drift_mode`'s field default is `aspect` instead,
    matching the live `agent/.env` (`DRIFT_MODE=aspect`) -- the value the
    in-flight per-aspect-drift experiment has been running the whole roster
    under since 2026-07-03, not the script's own bare fallback.

    `load_settings()` with no argument reads the REAL `agent/.env` (this is
    deliberately not a `tmp_path` fixture): if that file is present, this
    pins its actual content; if it is absent (e.g. a fresh CI checkout,
    since the file is gitignored), `load_settings` falls through to the
    field default, which is the same value -- so this assertion holds
    either way, and only a genuine content OR default drift can break it.
    """
    assert load_settings().drift_mode == "aspect"
