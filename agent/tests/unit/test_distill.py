"""Behavioural coverage for the neutral aspect distiller and the anchor cache
(`dream/distill.py`, task 9).

Two invariants this file exists to guard, both cheap to break and expensive
once broken (see `dream/distill.py`'s module docstring):

1. The JSON key is `topic`, SINGULAR, even though the distiller prompt's own
   instructions say `TOPICS`. `test_distill_rejects_the_plural_topics_key`
   is the guard against someone "fixing" that mismatch.
2. The anchor cache key derivation (`sha256(anchor_text):v{N}`) must match
   Bash's exactly, or the first Python round silently re-distills all 23 real
   accounts. `test_the_real_zenith_cache_loads_without_redistilling` pins it
   against `zenith_anchor_aspects.json`, a byte-for-byte copy of zenith's
   real, live `personality.anchor.aspects.json` -- captured into a fixture
   here (the same pattern `test_drift.py` uses for `echo_vectors_zenith.json`)
   because the real file itself is gitignored
   (`agent/agents/*/personality.anchor.aspects.json`, a regenerable cache)
   and would not exist in a fresh CI checkout.
"""

from __future__ import annotations

import hashlib
import json
import shutil
from pathlib import Path
from typing import Any

import pytest

from swil_agent.dream.distill import (
    DISTILL_SYSTEM_PROMPT,
    AspectCards,
    AspectVectors,
    anchor_aspects,
    anchor_cache_key,
    distill_cards,
)

from ._runners import FakeEmbedder, ScriptedRunner

# `agent/` itself -- tests/unit/test_distill.py -> parents[0]=unit,
# [1]=tests, [2]=agent. Same convention `test_drift.py`'s `AGENT_ROOT` uses.
AGENT_ROOT = Path(__file__).resolve().parents[2]

# Real bge-m3 vectors (1024-dim each), captured from zenith's actual, live
# `personality.anchor.aspects.json` -- see this file's module docstring and
# `zenith_anchor_aspects.json` (committed next to this file). Not fabricated:
# every float here came out of the real local embedder daemon.
_ZENITH_FIXTURE: dict[str, Any] = json.loads(
    (Path(__file__).parent / "zenith_anchor_aspects.json").read_text(encoding="utf-8")
)
THREE_VECTORS = AspectVectors.model_validate(_ZENITH_FIXTURE["vectors"])


def _write_cache(
    directory: Path,
    *,
    anchor_text: str,
    vectors: AspectVectors,
    prompt_version: str = "2",
) -> None:
    """Test setup: builds a minimal account directory -- `personality.md`
    containing exactly `anchor_text` (so `resolve_anchor_text`, and therefore
    the key `anchor_aspects` computes fresh, resolves to precisely this
    string) plus a pre-populated `personality.anchor.aspects.json` keyed to
    match, in the real on-disk `{key, cards, vectors}` shape (contract 04
    §3). `cards` content is never read on a cache HIT, so it's a placeholder
    here, not asserted on by any test."""
    (directory / "personality.md").write_text(anchor_text, encoding="utf-8")
    key = anchor_cache_key(anchor_text, prompt_version=prompt_version)
    payload = {
        "key": key,
        "cards": {
            "values": "unused-on-cache-hit",
            "style": "unused-on-cache-hit",
            "topic": "unused-on-cache-hit",
        },
        "vectors": {
            "values": vectors.values,
            "style": vectors.style,
            "topic": vectors.topic,
        },
    }
    (directory / "personality.anchor.aspects.json").write_text(
        json.dumps(payload, ensure_ascii=False), encoding="utf-8"
    )


# ── distill_cards ────────────────────────────────────────────────────────


def test_distill_parses_the_singular_topic_key() -> None:
    runner = ScriptedRunner(['{"values":"a","style":"b","topic":"c"}'])
    cards = distill_cards(runner, "persona text", model="haiku")
    assert cards == AspectCards(values="a", style="b", topic="c")


def test_distill_rejects_the_plural_topics_key() -> None:
    # Guard against someone "fixing" the prompt's TOPICS/topic mismatch to
    # be consistent -- that would break every downstream consumer that reads
    # the singular `topic` key (contract 04 §3). All 3 attempts see the wrong
    # key, so distill_cards must give up, not silently accept it.
    runner = ScriptedRunner(['{"values":"a","style":"b","topics":"c"}'] * 3)
    assert distill_cards(runner, "persona text", model="haiku") is None
    assert runner.call_count == 3


def test_distill_extracts_json_embedded_in_prose() -> None:
    runner = ScriptedRunner(['sure!\n{"values":"a","style":"b","topic":"c"}\nhope that helps'])
    assert distill_cards(runner, "t", model="haiku") is not None


def test_distill_rejects_a_blank_aspect_value() -> None:
    runner = ScriptedRunner(['{"values":"a","style":"   ","topic":"c"}'] * 3)
    assert distill_cards(runner, "t", model="haiku") is None


def test_distill_rejects_malformed_json_inside_braces() -> None:
    """Distinct failure mode from 'no {...} at all' below: a `{...}` span is
    found, but its contents aren't valid JSON, so `json.loads` itself raises."""
    runner = ScriptedRunner(["{not valid json}"] * 3)
    assert distill_cards(runner, "t", model="haiku") is None


def test_distill_retries_three_times_then_gives_up() -> None:
    runner = ScriptedRunner(["garbage", "garbage", '{"values":"a","style":"b","topic":"c"}'])
    assert distill_cards(runner, "t", model="haiku") is not None
    assert runner.call_count == 3


def test_distill_makes_no_fourth_attempt() -> None:
    runner = ScriptedRunner(["garbage"] * 5)
    assert distill_cards(runner, "t", model="haiku") is None
    assert runner.call_count == 3


def test_distill_stops_early_on_first_attempt_success() -> None:
    """Pins 'stops early on success', distinct from 'gives up after three'
    above -- a queue of exactly ONE scripted response means an implementation
    that kept looping after a successful parse (e.g. always calling exactly
    `attempts` times regardless of outcome) would over-call ScriptedRunner
    and raise, not silently pass."""
    runner = ScriptedRunner(['{"values":"a","style":"b","topic":"c"}'])
    cards = distill_cards(runner, "t", model="haiku")
    assert cards is not None
    assert runner.call_count == 1


def test_distill_consumes_an_attempt_when_the_neutral_ruler_is_unavailable() -> None:
    """R3: `distill_neutral` RAISES `BackendUnavailableError` on empty output
    (a dead CLI, bad auth, …) rather than returning "". The retry loop must
    catch it PER ATTEMPT so a dead distiller consumes one of its three tries
    instead of the exception escaping the loop entirely. `ScriptedRunner`
    returning "" makes `distill_neutral` raise (see `llm/neutral.py`); a
    second, good attempt then succeeds."""
    runner = ScriptedRunner(["", '{"values":"a","style":"b","topic":"c"}'])
    cards = distill_cards(runner, "t", model="haiku")
    assert cards is not None
    assert runner.call_count == 2


def test_distill_returns_none_not_an_exception_when_every_attempt_is_unavailable() -> None:
    """The other half of R3: after all attempts are exhausted with the ruler
    unavailable every time, `distill_cards` returns `None` -- it must NOT let
    `BackendUnavailableError` propagate, because the gate's fail-open path
    depends on `None` reaching it, not on catching an exception itself."""
    runner = ScriptedRunner(["", "", ""])
    assert distill_cards(runner, "t", model="haiku") is None


def test_distill_cards_sends_the_verbatim_system_prompt_and_boxed_user_text() -> None:
    """The system prompt text IS `ASPECT_PROMPT_VERSION=2`'s identity
    (contract 04 §3) -- changing a single character here without bumping
    that version would silently mix cards distilled under two different
    prompt wordings into one similarity series. The user prompt's boxed
    `【人物设定】\\n` wrapper matches `dream.sh:268`'s
    `printf '【人物设定】\\n%s' "$text"` exactly."""
    runner = ScriptedRunner(['{"values":"a","style":"b","topic":"c"}'])
    distill_cards(runner, "persona text", model="haiku")
    call = runner.calls[0]
    assert call.argv[call.argv.index("--system-prompt") + 1] == DISTILL_SYSTEM_PROMPT
    assert call.stdin == "【人物设定】\npersona text"


# ── anchor_cache_key ─────────────────────────────────────────────────────


def test_cache_key_is_sha256_of_the_anchor_plus_the_prompt_version() -> None:
    # ruff (UP012) prefers the `b"..."` spelling over `"...".encode()` for a
    # plain-ASCII literal; semantically identical to the brief's literal form.
    expected = hashlib.sha256(b"anchor").hexdigest() + ":v2"
    assert anchor_cache_key("anchor", prompt_version="2") == expected


# ── anchor_aspects: cache read/write ─────────────────────────────────────


def test_a_matching_cache_key_skips_the_distiller_entirely(tmp_path: Path) -> None:
    _write_cache(tmp_path, anchor_text="A", vectors=THREE_VECTORS)
    runner = ScriptedRunner([])  # any call raises -- proves the distiller was never touched
    result = anchor_aspects(
        tmp_path, runner=runner, embedder=None, model="haiku", prompt_version="2"
    )
    assert result == THREE_VECTORS


def test_a_bumped_prompt_version_invalidates_the_cache(tmp_path: Path) -> None:
    _write_cache(tmp_path, anchor_text="A", vectors=THREE_VECTORS, prompt_version="2")
    runner = ScriptedRunner(['{"values":"a","style":"b","topic":"c"}'])
    embedder = FakeEmbedder(THREE_VECTORS)
    anchor_aspects(tmp_path, runner=runner, embedder=embedder, model="haiku", prompt_version="3")
    assert runner.call_count == 1


def test_a_partial_embed_failure_writes_no_cache(tmp_path: Path) -> None:
    (tmp_path / "personality.md").write_text("persona text", encoding="utf-8")
    runner = ScriptedRunner(['{"values":"a","style":"b","topic":"c"}'])
    embedder = FakeEmbedder(fail_on_call=2)  # fails on the `style` embed
    result = anchor_aspects(
        tmp_path, runner=runner, embedder=embedder, model="haiku", prompt_version="2"
    )
    assert result is None
    assert not (tmp_path / "personality.anchor.aspects.json").exists()


def test_a_totally_failed_distill_never_reaches_the_embedder(tmp_path: Path) -> None:
    """If the distiller gives up after all 3 attempts, `anchor_aspects` returns
    `None` immediately -- it must not go on to call the embedder at all (there
    are no cards to embed). Using a `FakeEmbedder` that fails on its very
    first call, rather than one stocked with real vectors, is what actually
    proves the embedder was never reached: a stocked fake would return a
    plausible vector on any stray call and mask that bug."""
    (tmp_path / "personality.md").write_text("persona text", encoding="utf-8")
    runner = ScriptedRunner(["garbage"] * 3)
    embedder = FakeEmbedder(fail_on_call=1)
    result = anchor_aspects(
        tmp_path, runner=runner, embedder=embedder, model="haiku", prompt_version="2"
    )
    assert result is None
    assert embedder.call_count == 0


def test_a_cache_with_a_matching_key_but_no_vectors_field_is_treated_as_a_miss(
    tmp_path: Path,
) -> None:
    (tmp_path / "personality.md").write_text("persona text", encoding="utf-8")
    key = anchor_cache_key("persona text", prompt_version="2")
    payload = {"key": key, "cards": {}}  # no "vectors" key at all
    (tmp_path / "personality.anchor.aspects.json").write_text(json.dumps(payload), encoding="utf-8")
    runner = ScriptedRunner(['{"values":"a","style":"b","topic":"c"}'])
    embedder = FakeEmbedder(THREE_VECTORS)
    result = anchor_aspects(
        tmp_path, runner=runner, embedder=embedder, model="haiku", prompt_version="2"
    )
    assert result == THREE_VECTORS


def test_a_best_effort_cache_write_failure_does_not_crash_the_dream(tmp_path: Path) -> None:
    """`dream.sh:339`'s `|| true`: a disk-write failure on the cache is
    silently swallowed. Forced here by making the cache path itself a
    directory, so `Path.write_text` raises `IsADirectoryError` (an `OSError`
    subclass) -- `anchor_aspects` must still return the freshly computed
    vectors, not propagate the write failure and fail the dream over it."""
    (tmp_path / "personality.md").write_text("persona text", encoding="utf-8")
    (tmp_path / "personality.anchor.aspects.json").mkdir()
    runner = ScriptedRunner(['{"values":"a","style":"b","topic":"c"}'])
    embedder = FakeEmbedder(THREE_VECTORS)
    result = anchor_aspects(
        tmp_path, runner=runner, embedder=embedder, model="haiku", prompt_version="2"
    )
    assert result == THREE_VECTORS


def test_a_full_cache_miss_writes_the_cache_with_all_three_vectors(tmp_path: Path) -> None:
    (tmp_path / "personality.md").write_text("persona text", encoding="utf-8")
    runner = ScriptedRunner(['{"values":"a","style":"b","topic":"c"}'])
    embedder = FakeEmbedder(THREE_VECTORS)
    result = anchor_aspects(
        tmp_path, runner=runner, embedder=embedder, model="haiku", prompt_version="2"
    )
    assert result == THREE_VECTORS

    cache_file = tmp_path / "personality.anchor.aspects.json"
    assert cache_file.exists()
    written = json.loads(cache_file.read_text(encoding="utf-8"))
    assert written["key"] == anchor_cache_key("persona text", prompt_version="2")
    assert written["cards"] == {"values": "a", "style": "b", "topic": "c"}
    assert written["vectors"]["values"] == THREE_VECTORS.values
    assert written["vectors"]["style"] == THREE_VECTORS.style
    assert written["vectors"]["topic"] == THREE_VECTORS.topic


def test_a_freshly_written_cache_is_read_back_as_a_hit(tmp_path: Path) -> None:
    """Round-trip: what `anchor_aspects` just wrote on a miss must be exactly
    what it reads back as a hit on the very next call -- proves the write and
    read paths agree on shape, not just that each works in isolation."""
    (tmp_path / "personality.md").write_text("persona text", encoding="utf-8")
    runner = ScriptedRunner(['{"values":"a","style":"b","topic":"c"}'])
    embedder = FakeEmbedder(THREE_VECTORS)
    first = anchor_aspects(
        tmp_path, runner=runner, embedder=embedder, model="haiku", prompt_version="2"
    )

    dead_runner = ScriptedRunner([])  # any call raises -- must not be reached on a hit
    second = anchor_aspects(
        tmp_path, runner=dead_runner, embedder=None, model="haiku", prompt_version="2"
    )
    assert second == first == THREE_VECTORS


def test_a_corrupt_cache_file_is_treated_as_a_miss_not_a_crash(tmp_path: Path) -> None:
    (tmp_path / "personality.md").write_text("persona text", encoding="utf-8")
    (tmp_path / "personality.anchor.aspects.json").write_text("not json{{{", encoding="utf-8")
    runner = ScriptedRunner(['{"values":"a","style":"b","topic":"c"}'])
    embedder = FakeEmbedder(THREE_VECTORS)
    result = anchor_aspects(
        tmp_path, runner=runner, embedder=embedder, model="haiku", prompt_version="2"
    )
    assert result == THREE_VECTORS
    assert runner.call_count == 1


def test_a_cache_with_a_matching_key_but_malformed_vectors_is_treated_as_a_miss(
    tmp_path: Path,
) -> None:
    (tmp_path / "personality.md").write_text("persona text", encoding="utf-8")
    key = anchor_cache_key("persona text", prompt_version="2")
    payload = {"key": key, "cards": {}, "vectors": {"values": [0.1]}}  # missing style/topic
    (tmp_path / "personality.anchor.aspects.json").write_text(json.dumps(payload), encoding="utf-8")
    runner = ScriptedRunner(['{"values":"a","style":"b","topic":"c"}'])
    embedder = FakeEmbedder(THREE_VECTORS)
    result = anchor_aspects(
        tmp_path, runner=runner, embedder=embedder, model="haiku", prompt_version="2"
    )
    assert result == THREE_VECTORS


def test_anchor_aspects_requires_an_embedder_on_a_cache_miss(tmp_path: Path) -> None:
    """`embedder=None` only makes sense for a proven cache HIT (see the
    ScriptedRunner-with-an-empty-queue tests above) -- a genuine miss has
    nowhere to send the three `/embed` calls. Documents the deliberate choice
    to raise here rather than silently returning `None`, which would be
    indistinguishable from 'the distiller failed'."""
    (tmp_path / "personality.md").write_text("persona text", encoding="utf-8")
    runner = ScriptedRunner(['{"values":"a","style":"b","topic":"c"}'])
    with pytest.raises(ValueError, match="embedder"):
        anchor_aspects(tmp_path, runner=runner, embedder=None, model="haiku", prompt_version="2")


def test_the_real_zenith_cache_loads_without_redistilling(tmp_path: Path) -> None:
    """The real proof that Python's key derivation matches Bash's.

    `personality.archive.md` IS git-tracked, so it's copied straight from the
    real `agent/agents/zenith/` directory. `personality.anchor.aspects.json`
    is NOT tracked (it's a regenerable cache, `.gitignore`d) so it would not
    exist in a fresh checkout -- `zenith_anchor_aspects.json`, committed next
    to this test, is a byte-for-byte capture of zenith's real, live file,
    reproduced here in an isolated `tmp_path` alongside the archive it was
    actually computed from.

    If Python's key derivation drifted from Bash's, the freshly computed key
    would not match `.key` in the captured cache, this would fall through to
    the write path, and the empty-queue `ScriptedRunner` would raise --
    not silently re-distill and return a plausible-looking result.
    """
    shutil.copyfile(
        AGENT_ROOT / "agents" / "zenith" / "personality.archive.md",
        tmp_path / "personality.archive.md",
    )
    shutil.copyfile(
        Path(__file__).parent / "zenith_anchor_aspects.json",
        tmp_path / "personality.anchor.aspects.json",
    )
    runner = ScriptedRunner([])  # any call raises
    result = anchor_aspects(
        tmp_path, runner=runner, embedder=None, model="haiku", prompt_version="2"
    )
    assert result is not None
    assert len(result.values) == 1024
    assert len(result.style) == 1024
    assert len(result.topic) == 1024
