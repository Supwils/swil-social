"""What a dream RECORDS about its own drift, as opposed to what it decides
with it (Phase B task 1; spec §8.1).

Every other dream-side test file in this suite is about a VERDICT.  This one
is about the `DriftMeasurement` that now comes back alongside it, and about
the lab event that carries it off the machine -- the calibration series a
later task's step gate will have its threshold fitted to.  Keeping it in its
own file is deliberate: `test_dream_round.py` is this plan's frozen oracle
(zero behaviour change means its diff stays empty), and `test_gate.py` /
`test_dream_steps.py` are about decisions.

THE CENSORED SERIES, in one paragraph, because every test below is a
consequence of it.  Until now a dream contributed a data point only by being
ACCEPTED -- the numbers existed to produce a verdict, and only an accepted
dream left a `personalitysnapshots` row.  So the recorded distribution of
drift described the population the gate had already allowed through: its own
survivors.  A threshold fitted to that is fitted to its own output.  The fix
is that the measurement is an output in its own right, produced on every
path, including the structural-failure path that returns before a single
embed is attempted -- and that "not computed" is recorded as `None` rather
than smuggled in as `0.0`, which would be a fabricated "maximally drifted"
sample.

WHY THE EMBEDDER DOUBLE HERE IS TEXT-KEYED, AND NOT `FakeEmbedder`.
`_runners.FakeEmbedder` answers by CALL INDEX: it hands back its Nth scripted
vector whatever text it was asked to embed.  That is fine for pinning an
exact similarity, and it is what the gate's decision tests use -- but it
makes "which document did you embed?" unobservable, which is precisely the
property `step_sim` turns on.  Standing constraint §4: a fixture must make
the pinned value distinguishable from every value the code could plausibly
have passed instead.  `TextKeyedEmbedder` below answers by TEXT and RAISES on
a document it was never given, so embedding the wrong one is a loud failure
rather than a plausible-looking number.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

import pytest

from swil_agent.api.dto import LabEvent
from swil_agent.config import Settings
from swil_agent.dream.distill import anchor_cache_key
from swil_agent.dream.gate import evaluate_candidate
from swil_agent.dream.round import gate_step
from swil_agent.embedder.client import EmbedderUnavailable
from swil_agent.models import AspectSims, Persona

from ._runners import FakeEmbedder, FakeResources, RecordingRunner, ScriptedRunner

# ── three DISTINCT documents ────────────────────────────────────────────────
#
# The identity bullets (`Username`, `AI Backend`) round-trip across all three,
# because the structural validators reject a candidate that changes either and
# a rejected-for-the-wrong-reason fixture proves nothing about drift.
# Everything else differs, so "which document was embedded" is answerable.


def _document(bio: str, body: str) -> str:
    return f"""# 测试

## 身份
- **Username:** zenith
- **Display Name:** 测试
- **Headline:** AI Agent
- **Bio:** {bio}
- **Follow Topics:** alpha,beta,gamma

- **AI Backend:** claude

## 性格
{body}

## 发帖节律
- 每次触发有 60% 概率选择 post
"""


# The account's ORIGIN -- pinned on disk as `personality.anchor.md`, so
# `resolve_anchor_text` takes its FIRST branch and never reads
# `personality.md` at all.
ANCHOR = _document("最初的一句话", "最初的性格描述")
# The document that is live RIGHT NOW: what `persona.raw` holds, and what this
# dream is a step away from.
CURRENT = _document("现在的一句话", "现在的性格描述，和最初已经差得很远")
# What the dream proposes.
CANDIDATE = _document("提议的一句话", "提议的性格描述")

# A FOURTH document, written to `personality.md`, which nothing in a pinned
# account should ever read.  `TextKeyedEmbedder` has no vector for it, so an
# implementation that re-reads the file instead of using `original` fails
# loudly instead of returning a plausible number.
ON_DISK_DECOY = _document("磁盘上的一句话", "磁盘上的性格描述")

# 1-dimensional vectors: `cosine_sim` is a plain dot product over
# L2-normalised vectors, so over one dimension the product IS the similarity
# and a fixture can pin an exact value without hand-normalising a real
# embedding.  Same trick as `test_gate.py` / `test_drift.py`.
#
# CHOSEN SO THE CANDIDATE SITS NEAR THE ANCHOR AND FAR FROM THE CURRENT
# DOCUMENT.  This is the whole point of the fixture: an implementation that
# wires the anchor similarity into `step_sim` -- which would make the step
# gate a second position gate, measuring nothing new -- reports 0.99 where
# 0.099 is owed.  A fixture where the two documents are close would make that
# bug pass.
_ANCHOR_VECTOR = [1.0]
_CURRENT_VECTOR = [0.10]
_CANDIDATE_VECTOR = [0.99]
_EXPECTED_ANCHOR_SIM = 0.99  # anchor · candidate
_EXPECTED_STEP_SIM = 0.099  # current · candidate


class TextKeyedEmbedder:
    """An `Embedder` double that answers by TEXT, and refuses anything else.

    `vectors` maps an exact document string to the vector it embeds to.  A
    text that is not in the map is not "some other embedding" -- it is a bug
    in the code under test, so this raises `AssertionError` naming the
    document, rather than handing back a placeholder that would let an
    implementation embed the wrong file and still produce a float.

    `unavailable` is the set of texts the daemon refuses, so an outage can be
    scoped to one document (the current one, say) instead of being
    all-or-nothing -- which is what makes the independent failure of
    `anchor_sim` and `step_sim` testable.
    """

    def __init__(
        self, vectors: dict[str, list[float]], *, unavailable: set[str] | None = None
    ) -> None:
        self._vectors = dict(vectors)
        self._unavailable = set(unavailable or ())
        self.embedded: list[str] = []

    def embed(self, texts: list[str]) -> list[list[float]]:
        text = texts[0]
        self.embedded.append(text)
        if text in self._unavailable:
            raise EmbedderUnavailable("fake embedder refusing this document")
        if text not in self._vectors:
            raise AssertionError(
                f"embedded an unregistered document ({len(text)} chars): {text[:60]!r}"
            )
        return [self._vectors[text]]


def _pinned_account(tmp_path: Path) -> Path:
    """An account whose anchor is PINNED, so the anchor and the current
    document are genuinely different documents.

    Without the pin, `resolve_anchor_text` falls through to
    `personality.md` and the anchor IS the current document -- which makes
    `anchor_sim` and `step_sim` equal by construction and every assertion
    about telling them apart vacuous.
    """
    directory = tmp_path / "agents" / "zenith"
    directory.mkdir(parents=True)
    (directory / "personality.anchor.md").write_text(ANCHOR, encoding="utf-8")
    (directory / "personality.md").write_text(ON_DISK_DECOY, encoding="utf-8")
    return directory


def _embedder(**kwargs: Any) -> TextKeyedEmbedder:
    return TextKeyedEmbedder(
        {
            ANCHOR.rstrip("\n"): _ANCHOR_VECTOR,
            CURRENT.rstrip("\n"): _CURRENT_VECTOR,
            CANDIDATE: _CANDIDATE_VECTOR,
        },
        **kwargs,
    )


def _seed_anchor_aspect_cache(directory: Path) -> None:
    """Pre-seed a HIT for `dream.distill.anchor_aspects`, so the runner is
    spent only on the CANDIDATE's distill and the anchor's three aspect
    vectors are known exactly.  Same on-disk shape `test_gate.py`'s own
    `_write_anchor_cache` builds; keyed on the CANONICAL anchor text, since
    that is what `resolve_anchor_text` returns."""
    payload = {
        # `ANCHOR.rstrip("\n")` written out rather than routed through
        # `canonical_document_text`: the rule is re-derived here, so mutating
        # that function breaks the cache HIT (an over-called runner) instead
        # of moving both sides of the comparison together and hiding itself.
        "key": anchor_cache_key(ANCHOR.rstrip("\n"), prompt_version="2"),
        "cards": {"values": "a", "style": "b", "topic": "c"},
        "vectors": {"values": [1.0], "style": [1.0], "topic": [1.0]},
    }
    (directory / "personality.anchor.aspects.json").write_text(
        json.dumps(payload, ensure_ascii=False), encoding="utf-8"
    )


def _persona(directory: Path) -> Persona:
    return Persona(
        username="zenith",
        directory=directory,
        backend="claude",
        rhythm_text="60% 概率选择 post",
        raw=CURRENT,
    )


def _drift_events(resources: FakeResources) -> list[LabEvent]:
    return [e for e in resources.lab_events if e.summary == "drift measured"]


# ── the three named tests ───────────────────────────────────────────────────


def test_a_structurally_rejected_dream_still_reports_a_measurement(tmp_path: Path) -> None:
    """The censored-series problem (spec 8.1) is only fixed if EVERY dream
    contributes a data point -- including the ones that never reach the gate.

    A `Username` rewrite is rejected before a single embed is attempted, so
    this is the path with the strongest pull toward returning nothing at all:
    there is no similarity to report.  There is still a ROUND to report, and
    a row that says "this dream was rejected structurally, nothing was
    measured" is the difference between a distribution over all dreams and a
    distribution over the ones the gate liked.

    Mutation this kills: returning `None` for the measurement on the
    structural-failure path (brief step 5).
    """
    directory = _pinned_account(tmp_path)
    embedder = _embedder()
    bad = CANDIDATE.replace("- **Username:** zenith", "- **Username:** someone_else")

    outcome = evaluate_candidate(
        CURRENT,
        bad,
        directory=directory,
        embedder=embedder,
        runner=ScriptedRunner([]),  # any distill call raises
        settings=Settings(drift_mode="aspect"),
    )

    assert outcome.verdict.accepted is False
    assert outcome.measurement is not None
    # Nothing was measured, and that is recorded as "not computed" -- never
    # as 0.0, which would read as a maximally drifted dream.
    assert outcome.measurement.anchor_sim is None
    assert outcome.measurement.step_sim is None
    assert outcome.measurement.aspects is None
    # The mode is still known on this path, so the row is interpretable
    # without the deploy history.
    assert outcome.measurement.mode == "aspect"
    # No embed was attempted, so no embedder outage was observed. `False`
    # here would mean "the daemon was down", which is a different fact from
    # "we never asked" and would inflate any count of real outages.
    assert outcome.measurement.embedder_ok is True
    assert embedder.embedded == []


def test_step_sim_compares_the_candidate_to_the_current_document_not_the_anchor(
    tmp_path: Path,
) -> None:
    """Feed a candidate that is near the anchor but far from the current
    version.  A test that only checks 'a float came back' passes with
    anchor_sim wired into step_sim by mistake -- which is exactly the bug
    that would make the step gate a second position gate.

    The two numbers are an order of magnitude apart here (0.99 vs 0.099), so
    the mutation cannot be absorbed by a tolerance.

    Mutation this kills: `step_sim=scalar_sim` (brief step 5); also
    embedding a fresh read of `personality.md` instead of `original`, which
    `TextKeyedEmbedder` turns into an `AssertionError` naming the decoy.
    """
    directory = _pinned_account(tmp_path)
    embedder = _embedder()

    outcome = evaluate_candidate(
        CURRENT,
        CANDIDATE,
        directory=directory,
        embedder=embedder,
        runner=ScriptedRunner([]),
        settings=Settings(drift_mode="scalar"),
    )

    measurement = outcome.measurement
    assert measurement.anchor_sim == pytest.approx(_EXPECTED_ANCHOR_SIM)
    assert measurement.step_sim == pytest.approx(_EXPECTED_STEP_SIM)
    # Stated as a relation as well as as two values: the step is what makes
    # this measurement more than the position gate already recorded.
    assert measurement.step_sim != pytest.approx(measurement.anchor_sim)
    # Both documents really were embedded, and the one on disk was not.
    assert set(embedder.embedded) == {
        ANCHOR.rstrip("\n"),
        CURRENT.rstrip("\n"),
        CANDIDATE,
    }


def test_an_unreachable_embedder_yields_a_measurement_with_embedder_ok_false(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """Fail-open: no exception, no round abort, and the calibration data is
    marked as missing rather than silently recorded as zero.

    Mutation this kills: hardcoding `embedder_ok=True`, or defaulting an
    uncomputed similarity to `0.0`.
    """
    directory = _pinned_account(tmp_path)
    # Every document refused -- a whole-daemon outage, not one bad call.
    embedder = _embedder(
        unavailable={ANCHOR.rstrip("\n"), CURRENT.rstrip("\n"), CANDIDATE},
    )

    with caplog.at_level(logging.WARNING, logger="swil_agent.dream.gate"):
        outcome = evaluate_candidate(
            CURRENT,
            CANDIDATE,
            directory=directory,
            embedder=embedder,
            runner=ScriptedRunner([]),
            settings=Settings(drift_mode="scalar"),
        )

    # The round continues: the gate fails open, exactly as it did before the
    # measurement existed.
    assert outcome.verdict.accepted is True
    assert "embedder unreachable" in outcome.verdict.reason
    assert outcome.measurement.embedder_ok is False
    assert outcome.measurement.anchor_sim is None
    assert outcome.measurement.step_sim is None
    assert "embedder unreachable" in caplog.text
    # It really did try, and gave up on each document exactly once.
    assert len(embedder.embedded) == 3


# ── the two similarities fail independently ─────────────────────────────────


def test_only_the_current_document_failing_to_embed_leaves_the_gate_untouched(
    tmp_path: Path,
) -> None:
    """The one way this task could change what is DECIDED, closed.

    `step_sim` needs a document the gate never read before Phase B.  If its
    embed were folded into the same all-or-nothing check as the anchor's,
    a daemon that choked on that one document would empty `scalar_sim` and
    fail-open the gate -- an accept that today's runtime would have gated,
    produced by a task whose contract is that it changes nothing.

    So: refuse ONLY the current document.  The anchor similarity, the
    verdict, and the fail-open flag must all be exactly what they are when
    the daemon is healthy; only `step_sim` and `embedder_ok` change.
    """
    directory = _pinned_account(tmp_path)
    embedder = _embedder(unavailable={CURRENT.rstrip("\n")})

    outcome = evaluate_candidate(
        CURRENT,
        CANDIDATE,
        directory=directory,
        embedder=embedder,
        runner=ScriptedRunner([]),
        settings=Settings(drift_mode="scalar"),
    )

    assert outcome.verdict.accepted is True
    assert outcome.verdict.scalar_sim == pytest.approx(_EXPECTED_ANCHOR_SIM)
    assert outcome.verdict.embedder_unreachable is False
    assert "drift OK" in outcome.verdict.reason
    assert outcome.measurement.anchor_sim == pytest.approx(_EXPECTED_ANCHOR_SIM)
    assert outcome.measurement.step_sim is None
    assert outcome.measurement.embedder_ok is False


def test_only_the_anchor_failing_to_embed_still_measures_the_step(tmp_path: Path) -> None:
    """The mirror image, and the reason the two are separate fields at all:
    a dream whose position cannot be measured still moved the account by a
    measurable amount, and that step belongs in the series.
    """
    directory = _pinned_account(tmp_path)
    embedder = _embedder(unavailable={ANCHOR.rstrip("\n")})

    outcome = evaluate_candidate(
        CURRENT,
        CANDIDATE,
        directory=directory,
        embedder=embedder,
        runner=ScriptedRunner([]),
        settings=Settings(drift_mode="scalar"),
    )

    assert outcome.measurement.anchor_sim is None
    assert outcome.measurement.step_sim == pytest.approx(_EXPECTED_STEP_SIM)
    assert outcome.measurement.embedder_ok is False
    # And the gate still fail-opens on the anchor's absence, unchanged.
    assert outcome.verdict.accepted is True
    assert outcome.verdict.embedder_unreachable is True


# ── one embed per distinct document ─────────────────────────────────────────


def test_a_first_ever_dream_embeds_its_one_document_once(tmp_path: Path) -> None:
    """An account with no archive and no pin anchors against its own
    `personality.md` (`resolve_anchor_text` branch 3), so the anchor and the
    current document ARE the same document.  It is embedded once, and both
    similarities come out equal because they are the same comparison -- not
    because anything was wired to anything.

    This is also what keeps the deployed embed sequence unchanged for such
    an account: the gate asks the daemon for two documents, exactly as it
    did before `step_sim` existed.
    """
    directory = tmp_path / "agents" / "zenith"
    directory.mkdir(parents=True)
    (directory / "personality.md").write_text(CURRENT, encoding="utf-8")
    embedder = _embedder()

    outcome = evaluate_candidate(
        CURRENT,
        CANDIDATE,
        directory=directory,
        embedder=embedder,
        runner=ScriptedRunner([]),
        settings=Settings(drift_mode="scalar"),
    )

    assert embedder.embedded == [CURRENT.rstrip("\n"), CANDIDATE]
    assert outcome.measurement.anchor_sim == pytest.approx(_EXPECTED_STEP_SIM)
    assert outcome.measurement.step_sim == pytest.approx(_EXPECTED_STEP_SIM)


def test_a_document_the_daemon_already_refused_is_not_asked_for_twice(
    tmp_path: Path,
) -> None:
    """The failure half of the one-embed-per-document rule.

    Same first-ever-dream shape as above (anchor IS the current document),
    but the daemon refuses that document.  It must be asked ONCE.  Caching
    only the successes looks harmless -- the numbers come out identical --
    but it makes the number of attempts depend on whether two of the three
    documents happen to coincide, so an outage costs a different number of
    round-trips for an account that has dreamed before than for one that
    has not.  Asking again inside one gate call also cannot produce a
    different answer.

    This is the one mutation the first batch of this task's mutation run
    left alive (`if vector is not None: self._cache[text] = vector`), found
    because nothing else in the suite observes the attempt COUNT under a
    failure.
    """
    directory = tmp_path / "agents" / "zenith"
    directory.mkdir(parents=True)
    (directory / "personality.md").write_text(CURRENT, encoding="utf-8")
    embedder = _embedder(unavailable={CURRENT.rstrip("\n")})

    outcome = evaluate_candidate(
        CURRENT,
        CANDIDATE,
        directory=directory,
        embedder=embedder,
        runner=ScriptedRunner([]),
        settings=Settings(drift_mode="scalar"),
    )

    assert embedder.embedded == [CURRENT.rstrip("\n"), CANDIDATE]
    assert outcome.measurement.anchor_sim is None
    assert outcome.measurement.step_sim is None
    assert outcome.measurement.embedder_ok is False


# ── aspects ride along ──────────────────────────────────────────────────────


def test_the_measurement_carries_the_aspect_similarities_the_gate_computed(
    tmp_path: Path,
) -> None:
    """The per-aspect numbers are part of the record, not only part of the
    aspect gate's own decision -- and a REJECTED dream is exactly the round
    whose aspect numbers the calibration needs, since it is the tail the
    old series threw away.
    """
    directory = _pinned_account(tmp_path)
    _seed_anchor_aspect_cache(directory)
    # `FakeEmbedder` (call-indexed) is the right double HERE: the aspect
    # cards are three synthetic strings whose identity is not the property
    # under test, and their similarities have to be pinned exactly.
    embedder = FakeEmbedder(
        [
            [1.0],  # anchor document
            [0.99],  # candidate document
            [0.10],  # current document
            [0.99],  # candidate "values" card -> fine (threshold 0.63)
            [0.10],  # candidate "style" card -> breaches (threshold 0.72)
            [0.99],  # candidate "topic" card -> fine (threshold 0.71)
        ]
    )

    outcome = evaluate_candidate(
        CURRENT,
        CANDIDATE,
        directory=directory,
        embedder=embedder,
        runner=RecordingRunner('{"values":"a","style":"b","topic":"c"}'),
        settings=Settings(drift_mode="aspect"),
    )

    assert outcome.verdict.accepted is False  # style breached
    assert outcome.measurement.aspects == AspectSims(values=0.99, style=0.10, topic=0.99)
    # ... and the whole-doc pair is recorded on the rejected round too.
    assert outcome.measurement.anchor_sim == pytest.approx(_EXPECTED_ANCHOR_SIM)
    assert outcome.measurement.step_sim == pytest.approx(_EXPECTED_STEP_SIM)


# ── the lab event: what actually leaves the machine ─────────────────────────


def test_gate_step_posts_the_measurement_as_a_lab_event(tmp_path: Path) -> None:
    """The measurement only becomes calibration data if it reaches the
    server.  Asserting on the recorded API call, not on a return value:
    Plan 2's most expensive defects were all invisible in return values.
    """
    directory = _pinned_account(tmp_path)
    resources = FakeResources()

    gate_step(
        persona=_persona(directory),
        candidate_text=CANDIDATE,
        resources=resources,
        embedder=_embedder(),
        runner=ScriptedRunner([]),
        settings=Settings(drift_mode="scalar"),
    )

    events = _drift_events(resources)
    assert len(events) == 1
    event = events[0]
    assert (event.type, event.phase, event.outcome) == ("dream", "dream", "success")
    assert event.metrics == {
        "anchorSim": pytest.approx(_EXPECTED_ANCHOR_SIM),
        "stepSim": pytest.approx(_EXPECTED_STEP_SIM),
        "aspectValues": None,
        "aspectStyle": None,
        "aspectTopic": None,
        "embedderOk": True,
        "driftMode": "scalar",
    }


def test_the_event_is_posted_on_the_structural_path_too(tmp_path: Path) -> None:
    """The censoring, at the layer that actually ships the data: a dream
    that never reached an embed must still leave a row, with its
    similarities recorded as JSON `null`.

    Mutation this kills: emitting the event only when a similarity exists
    (`if measurement.anchor_sim is not None`), which looks tidy and
    re-censors the series at exactly the tail that matters.
    """
    directory = _pinned_account(tmp_path)
    resources = FakeResources()
    bad = CANDIDATE.replace("- **Username:** zenith", "- **Username:** someone_else")

    gate_step(
        persona=_persona(directory),
        candidate_text=bad,
        resources=resources,
        embedder=_embedder(),
        runner=ScriptedRunner([]),
        settings=Settings(drift_mode="scalar"),
    )

    events = _drift_events(resources)
    assert len(events) == 1
    assert events[0].metrics["anchorSim"] is None
    assert events[0].metrics["stepSim"] is None
    assert events[0].metrics["embedderOk"] is True
    # The rejection event is still posted, and still carries its own
    # (empty, for a structural failure) metrics -- the measurement event is
    # an addition, not a replacement.
    assert [e.outcome for e in resources.lab_events] == ["success", "fail"]


def test_the_metrics_payload_is_flat_and_wire_legal(tmp_path: Path) -> None:
    """`agentEventIngest.metrics` is
    `z.record(z.union([z.string(), z.number(), z.boolean(), z.null()]))`
    (`server/src/modules/agents/agents.schemas.ts:59`) -- verified by
    running that schema, not by reading a description of it.  A nested
    object or a list fails the union and zod rejects the WHOLE event, so a
    payload that nests its aspect similarities does not land partially: it
    does not land at all.

    Mutation this kills: `{"aspects": {...}}` instead of three flat keys.
    """
    directory = _pinned_account(tmp_path)
    _seed_anchor_aspect_cache(directory)
    resources = FakeResources()

    gate_step(
        persona=_persona(directory),
        candidate_text=CANDIDATE,
        resources=resources,
        # Three DISTINCT aspect similarities (0.90 / 0.80 / 0.75), all above
        # their own thresholds so nothing breaches. Equal values here would
        # let `aspectStyle: aspects.values` -- a one-word slip between three
        # adjacent same-typed fields -- pass every assertion below.
        embedder=FakeEmbedder([[1.0], [0.99], [0.10], [0.90], [0.80], [0.75]]),
        runner=RecordingRunner('{"values":"a","style":"b","topic":"c"}'),
        settings=Settings(drift_mode="aspect"),
    )

    metrics = _drift_events(resources)[0].metrics
    assert metrics["aspectValues"] == pytest.approx(0.90)
    assert metrics["aspectStyle"] == pytest.approx(0.80)
    assert metrics["aspectTopic"] == pytest.approx(0.75)
    assert metrics["driftMode"] == "aspect"
    for key, value in metrics.items():
        assert isinstance(value, str | float | int | bool | type(None)), (
            f"metrics[{key!r}] is {type(value).__name__}, which agentEventIngest rejects"
        )


def test_the_event_reports_a_dead_embedder_as_embedder_ok_false(tmp_path: Path) -> None:
    """The `embedderOk` key has to come from the measurement, not from a
    literal `True` that happens to be right on the healthy path -- otherwise
    the calibration sample silently claims every missing number was measured
    against a working daemon.
    """
    directory = _pinned_account(tmp_path)
    resources = FakeResources()

    gate_step(
        persona=_persona(directory),
        candidate_text=CANDIDATE,
        resources=resources,
        embedder=_embedder(
            unavailable={ANCHOR.rstrip("\n"), CURRENT.rstrip("\n"), CANDIDATE},
        ),
        runner=ScriptedRunner([]),
        settings=Settings(drift_mode="scalar"),
    )

    metrics = _drift_events(resources)[0].metrics
    assert metrics["embedderOk"] is False
    assert metrics["anchorSim"] is None
    assert metrics["stepSim"] is None


def test_an_events_outage_does_not_change_the_gates_outcome(tmp_path: Path) -> None:
    """The measurement is observability, and observability may never decide
    anything.  Mutation this kills: calling `resources.lab_event` directly
    instead of through `_emit`.
    """
    directory = _pinned_account(tmp_path)
    resources = FakeResources(lab_event_raises=RuntimeError("events service down"))

    outcome = gate_step(
        persona=_persona(directory),
        candidate_text=CANDIDATE,
        resources=resources,
        embedder=_embedder(),
        runner=ScriptedRunner([]),
        settings=Settings(drift_mode="scalar"),
    )

    assert outcome.verdict.accepted is True
    assert outcome.measurement.step_sim == pytest.approx(_EXPECTED_STEP_SIM)
