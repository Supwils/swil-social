"""The dream gate: structural validators plus the drift gate, composed into
one accept/reject verdict for a candidate `personality.md` rewrite.

Source of truth is `agent/scripts/dream.sh:668-826` (`dream_one`'s
structural-check block, then its Constitution/drift-check block), read
directly rather than from contract `04`'s §5 transcription alone -- this
plan's README documents that the contract docs have already been caught
transcribing `dream.sh` wrong more than once. §5 was cross-checked
line-for-line against the script while writing this module and no
discrepancy was found for this task's scope; the script remains what every
message and branch below is pinned to.

ORDER IS THE CONTRACT (contract `03` §1.4, `04` §5). The six structural
checks (`persona/validators.py`'s `validate_candidate`, a port of
`dream.sh:668-730`) are hard rejects that run FIRST and do not depend on
`DRIFT_MODE`, the embedder, or the distiller. Only a structurally valid
candidate is worth embedding -- so `evaluate_candidate` never wraps itself
in one outer try/except: doing that would let a down embedder mask a
candidate with a mangled `Username` bullet reaching disk, which is exactly
the invariant CLAUDE.md calls out as non-negotiable.

Every drift-side failure FAILS OPEN, and each is a DISTINCT, LOGGED (WARN)
decision, never a silent pass:

  aspect distill/embed failed  -> fall back to the scalar gate
  scalar embed itself failed   -> skip the drift check entirely, accept

There is no third silent path: `resolve_anchor_text` always returns
something (falling back to the current `personality.md` on a first dream
with no archive yet, `dream/drift.py`'s own docstring), so "no anchor" is
never a failure mode the gate has to account for.

`DRIFT_MODE` default -- Python deliberately does NOT match the script:
`dream.sh:62` defaults to `"scalar"` when the env var is unset. `Settings
.drift_mode` (config.py) defaults to `"aspect"` instead, because the live
`agent/.env` sets `DRIFT_MODE=aspect` and `load_settings` reads that file --
that is the value the in-flight per-aspect-drift experiment has been
running the whole roster under since 2026-07-03 (see `models.py`'s
`AspectThresholds` docstring for the calibration date). Baking in the
DEPLOYED value, not the script's own unset-env fallback, is what
`test_gate.py::test_load_settings_default_matches_the_deployed_drift_mode`
pins against the real `agent/.env`, so a future edit to that file breaks a
test instead of silently changing the gate every account's dreams run
under.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Final, NamedTuple

from swil_agent.config import Settings
from swil_agent.dream.distill import Embedder, anchor_aspects, distill_cards
from swil_agent.dream.drift import (
    aspect_breaches,
    canonical_document_text,
    cosine_sim,
    resolve_anchor_text,
)
from swil_agent.embedder.client import EmbedderUnavailable
from swil_agent.llm.base import Runner
from swil_agent.models import (
    AspectCards,
    AspectSims,
    AspectThresholds,
    AspectVectors,
    DreamVerdict,
    DriftMeasurement,
)
from swil_agent.persona.validators import validate_candidate

logger = logging.getLogger(__name__)

# `ASPECT_PROMPT_VERSION`'s default (`dream.sh:66`) -- not (yet) a `Settings`
# field; config.py's own comment marks it as a key expected to become a real
# field in a later phase, currently just passed through via `extra="ignore"`.
# Hardcoded here at the script's default (also the live `agent/.env`'s
# explicit value) because the anchor cache key derivation
# (`dream/distill.py`'s `anchor_cache_key`) must match Bash's exactly -- a
# mismatch here would invalidate all 23 real on-disk anchor caches at once,
# the same hazard `distill.py`'s own module docstring warns about.
#
# A `str` on purpose: it is STRING-CONCATENATED into the cache key
# (`anchor_cache_key` -> `sha256(anchor):v2`, `dream.sh:318`), and a real
# warm cache on disk carries exactly those bytes
# (`agent/agents/quant/personality.anchor.aspects.json`'s
# `"key": "a72c...085c:v2"`). `dream/round.py`'s same-named constant is an
# `int` because its consumer is the snapshot payload's numeric
# `aspectDrift.promptVersion` field; see the comment there for why the two
# copies deliberately do not share a type.
_ASPECT_PROMPT_VERSION: Final = "2"

_ASPECT_FALLBACK_NOTE: Final = "aspect distill/embed failed, falling back to scalar drift"
_EMBEDDER_UNREACHABLE_NOTE: Final = "embedder unreachable, skipping drift check"


class GateOutcome(NamedTuple):
    """What the gate DECIDED and what it MEASURED, as two independent
    values (Phase B task 1).

    They are deliberately not folded into one another. `DreamVerdict` is the
    gate's working state -- the fields it needs to explain and act on its
    own decision -- and it is shaped by which mode was in force.
    `DriftMeasurement` is the RECORD, identical in shape on every path,
    including the structural-failure path where no similarity exists at all.
    Attaching the record to the verdict would tie "was this recorded" to
    "was there a verdict to attach it to", which is exactly the coupling
    that produced the censored series in the first place.

    `measurement.anchor_sim` and `verdict.scalar_sim` are the SAME quantity,
    computed once and carried in both places. That is not a redundancy to
    tidy up later: `scalar_sim`'s consumer is `dream/round.py`'s
    `_drift_fail_metrics`, which must keep emitting the shape it emits
    today, while `anchor_sim`'s consumer is the calibration series, which
    must keep its shape stable across whatever the gate does next.

    The SAME type is returned by `evaluate_candidate` and by `dream/round.py`
    's `gate_step`, rather than each layer declaring its own identically
    shaped pair -- two copies of a shape are two things that can drift.
    """

    verdict: DreamVerdict
    measurement: DriftMeasurement


class _DocumentVectors:
    """One embed per DISTINCT document text, for the life of one gate call.

    The gate embeds three documents -- anchor, current `personality.md`, and
    candidate -- and two of them are frequently the SAME document: on an
    account's first-ever dream `resolve_anchor_text` falls through to the
    current `personality.md` (see its docstring's branch 3), so the anchor
    IS the current document. Asking the daemon to embed identical bytes
    twice is waste in the deployed case and, on a cold laptop, a second
    chance to fail.

    A FAILED embed is cached as a failure, not retried. Once the daemon has
    refused this exact text, asking again inside the same gate call cannot
    produce a different answer, and retrying would make the number of
    attempts depend on how many of the three documents happen to coincide.

    Keyed on the exact string, so the CALLER decides what "the same
    document" means. Both documents read off disk reach here through
    `canonical_document_text` (`dream/drift.py`), which is what makes the
    first-dream coincidence an actual key match rather than two strings
    differing by a trailing newline. The CANDIDATE is passed as given: it
    arrives from `dream/candidate.py`'s `clean_candidate`, whose closing
    `.rstrip("\\n")` has already applied the same rule, and re-cleaning a
    caller's input here would couple this module to how that one happens
    to finish today.
    """

    def __init__(self, embedder: Embedder) -> None:
        self._embedder = embedder
        self._cache: dict[str, list[float] | None] = {}

    def get(self, text: str) -> list[float] | None:
        if text in self._cache:
            return self._cache[text]
        vector = _try_embed(self._embedder, text)
        self._cache[text] = vector
        return vector


def evaluate_candidate(
    original: str,
    candidate: str,
    *,
    directory: Path,
    embedder: Embedder,
    runner: Runner,
    settings: Settings,
) -> GateOutcome:
    """Structural validators, then the drift gate. See the module docstring
    for the ordering contract and the fail-open paths this implements.

    Returns the verdict AND the measurement, on EVERY path (Phase B task 1,
    spec §8.1). The structural-failure path returns before a single embed
    is attempted, so its measurement carries `None` for all three
    similarities -- a recorded "not computed", not a zero, and not an
    absent row. See `GateOutcome` for why the two are separate values and
    `models.DriftMeasurement` for what each field means.

    The returned `DreamVerdict.scalar_sim` (fix round 2, task 12) is
    whatever the anchor similarity came out as -- `None` only when that
    embed pair itself could not be computed, `float` otherwise, regardless
    of which mode ultimately decided accept/reject. A structural failure
    returns before any similarity is computed, so it always carries
    `scalar_sim=None` via the field's own default.

    NOTHING BELOW CHANGES WHAT IS DECIDED. `step_sim` is measured and
    recorded here and gates nothing; the accept/reject branches are the
    ones this function already had. Turning the step size into a decision
    is a later task, deliberately after the measurement has run long enough
    to calibrate a threshold against real rounds rather than against a
    guess (the `ECHO_VARIANCE_THRESHOLD=0.04`-against-a-measured-0.001
    lesson, CLAUDE.md).
    """
    failure = validate_candidate(original, candidate)
    if failure is not None:
        logger.warning("structural validation failed for %s: %s", directory, failure.detail)
        return GateOutcome(
            verdict=DreamVerdict(accepted=False, reason=failure.detail),
            # Not `None`, and not an early return that skips the record: the
            # censored-series defect this task fixes is precisely that the
            # dreams which never reached the drift check left no data point,
            # so the recorded distribution described the survivors.
            measurement=DriftMeasurement(mode=settings.drift_mode),
        )

    anchor_text = resolve_anchor_text(directory)
    # The CURRENT document is `original` -- the text the dream prompt was
    # built from -- never a fresh read of `personality.md`, for the same
    # reason `dream/round.py`'s `gate_step` passes `persona.raw` in the
    # first place: a concurrent Bash round may already have swapped the file
    # on disk, and the step size has to be measured against the document
    # this candidate was actually written from.
    current_text = canonical_document_text(original)

    # (1) Whole-doc similarities -- always attempted, independent of
    # DRIFT_MODE: the anchor one is the gate itself in scalar/shadow modes
    # and the aspect-mode fallback (contract 04 §5; dream.sh:742-749); the
    # step one gates nothing yet and is measured for the record.
    scalar_sim, step_sim, embedder_ok = _whole_document_similarities(
        embedder, anchor_text=anchor_text, current_text=current_text, candidate_text=candidate
    )

    # (2) Per-aspect similarities -- only outside scalar mode (dream.sh:752).
    sims: AspectSims | None = None
    breached: list[str] = []
    aspect_note = ""
    if settings.drift_mode != "scalar":
        sims = _aspect_similarities(
            directory, candidate, runner=runner, embedder=embedder, settings=settings
        )
        if sims is None:
            aspect_note = _ASPECT_FALLBACK_NOTE
            logger.warning("%s -- %s", directory, aspect_note)
        else:
            thresholds = AspectThresholds(
                values=settings.drift_threshold_values,
                style=settings.drift_threshold_style,
                topic=settings.drift_threshold_topic,
            )
            breached = aspect_breaches(sims, thresholds)
            if settings.drift_mode == "shadow":
                # Contract 04 §5 step 3: fires regardless of the eventual
                # accept/reject decision below, so calibration data
                # accumulates from rejected dreams too, not just survivors.
                logger.info(
                    "SHADOW-OBS %s pv=%s values=%.4f style=%.4f topic=%.4f breached=%s",
                    directory,
                    _ASPECT_PROMPT_VERSION,
                    sims.values,
                    sims.style,
                    sims.topic,
                    breached,
                )

    embedder_unreachable = False
    if settings.drift_mode == "aspect" and sims is not None:
        accepted = not breached
        base_reason = _aspect_reason(sims, breached, accepted=accepted)
    else:
        # Scalar mode, shadow mode, or aspect mode with a failed aspect
        # computation (dream.sh:796-807) -- the scalar gate decides.
        accepted, base_reason = _scalar_decision(scalar_sim, settings.drift_threshold, directory)
        # dream.sh:797-807: the WARN log and the `warn` lab event fire on
        # exactly this condition -- the scalar branch was taken AND
        # `scalar_sim` is empty, i.e. the gate fail-opened with nothing
        # measured. Carried as a typed flag rather than left for a caller to
        # infer from `reason`, because `reason` is a COMPOSED string here
        # (`f"{aspect_note}; {base_reason}"`) and in the deployed
        # `DRIFT_MODE=aspect` a non-empty `aspect_note` is the common case:
        # any `reason == <note>` test in a caller silently stops matching
        # exactly when the aspect pipeline is also degraded, which is when
        # an operator most needs to be told the constitution layer is off.
        embedder_unreachable = scalar_sim is None

    reason = f"{aspect_note}; {base_reason}" if aspect_note else base_reason
    return GateOutcome(
        verdict=DreamVerdict(
            accepted=accepted,
            reason=reason,
            breached=breached,
            sims=sims,
            scalar_sim=scalar_sim,
            embedder_unreachable=embedder_unreachable,
        ),
        measurement=DriftMeasurement(
            mode=settings.drift_mode,
            anchor_sim=scalar_sim,
            step_sim=step_sim,
            aspects=sims,
            embedder_ok=embedder_ok,
        ),
    )


def _whole_document_similarities(
    embedder: Embedder, *, anchor_text: str, current_text: str, candidate_text: str
) -> tuple[float | None, float | None, bool]:
    """`(anchor_sim, step_sim, embedder_ok)` -- POSITION and STEP SIZE, from
    the same candidate vector so the two can be read against each other.

    Every embed is attempted, mirroring `dream.sh:744-745`'s two
    unconditional `_embed_text` calls -- a failure on one does not skip the
    others -- and identical texts cost one call between them
    (`_DocumentVectors`).

    THE TWO SIMILARITIES FAIL INDEPENDENTLY, and that is load-bearing:
    `anchor_sim` is what the scalar gate decides on, so it must go `None`
    on exactly the condition it went `None` on before this function existed
    (its own two embeds failed) and on no other. Folding the third embed
    into one all-or-nothing check would let a failure to embed the CURRENT
    document -- a document the gate did not read at all until Phase B --
    silently fail-open the gate. That would be a change in what is decided,
    made by a task whose whole contract is that it changes only what is
    recorded.

    `None` means "could not be computed", never "identical": `cosine_sim`
    fails open to `1.0` on an empty vector, which is the silent pass this
    module exists not to have (module docstring, and `dream/drift.py`'s
    `cosine_sim` docstring).
    """
    vectors = _DocumentVectors(embedder)
    anchor_vec = vectors.get(anchor_text)
    candidate_vec = vectors.get(candidate_text)
    current_vec = vectors.get(current_text)

    anchor_sim = (
        None
        if anchor_vec is None or candidate_vec is None
        else cosine_sim(anchor_vec, candidate_vec)
    )
    step_sim = (
        None
        if current_vec is None or candidate_vec is None
        else cosine_sim(current_vec, candidate_vec)
    )
    embedder_ok = anchor_vec is not None and candidate_vec is not None and current_vec is not None
    return anchor_sim, step_sim, embedder_ok


def _try_embed(embedder: Embedder, text: str) -> list[float] | None:
    try:
        return embedder.embed([text])[0]
    except EmbedderUnavailable:
        return None


def _aspect_similarities(
    directory: Path,
    candidate_text: str,
    *,
    runner: Runner,
    embedder: Embedder,
    settings: Settings,
) -> AspectSims | None:
    """`aspect_ok` in `dream.sh` terms: both `_anchor_aspects` and
    `_distill_aspects` are computed UNCONDITIONALLY, neither short-circuiting
    the other (`dream.sh:753-755`) -- a broken anchor cache and a dead
    distiller are each independently observable in the runner/embedder call
    counts a test asserts on. Only once both cards are in hand are the
    candidate's three embeds attempted."""
    anchor_vectors = anchor_aspects(
        directory,
        runner=runner,
        embedder=embedder,
        model=settings.aspect_distill_model,
        prompt_version=_ASPECT_PROMPT_VERSION,
    )
    candidate_cards = distill_cards(runner, candidate_text, model=settings.aspect_distill_model)
    if anchor_vectors is None or candidate_cards is None:
        return None

    candidate_vectors = _embed_candidate_cards(candidate_cards, embedder)
    if candidate_vectors is None:
        return None

    return AspectSims(
        values=cosine_sim(candidate_vectors.values, anchor_vectors.values),
        style=cosine_sim(candidate_vectors.style, anchor_vectors.style),
        topic=cosine_sim(candidate_vectors.topic, anchor_vectors.topic),
    )


def _embed_candidate_cards(cards: AspectCards, embedder: Embedder) -> AspectVectors | None:
    """Three individual `/embed` calls, `values, style, topic` order --
    matching `dream.sh:758-760` (and mirroring `dream/distill.py`'s private
    `_embed_cards`, which does the equivalent job for the ANCHOR side inside
    `anchor_aspects`). Any failure aborts before the remaining calls; there
    is no partial result."""
    try:
        values = embedder.embed([cards.values])[0]
        style = embedder.embed([cards.style])[0]
        topic = embedder.embed([cards.topic])[0]
    except EmbedderUnavailable:
        return None
    return AspectVectors(values=values, style=style, topic=topic)


def _aspect_reason(sims: AspectSims, breached: list[str], *, accepted: bool) -> str:
    """Matches `dream.sh:794` (reject) and `dream.sh:823` (accept) verbatim,
    including the reject/accept formatting asymmetry already present in the
    script: the accept line has no commas between the three aspects, the
    reject line does."""
    if accepted:
        return (
            f"aspect drift OK (values={sims.values:.4f} "
            f"style={sims.style:.4f} topic={sims.topic:.4f})"
        )
    return (
        f"aspect drift: [{', '.join(breached)}] breached "
        f"(values={sims.values:.4f}, style={sims.style:.4f}, topic={sims.topic:.4f})"
    )


def _scalar_decision(
    scalar_sim: float | None, threshold: float, directory: Path
) -> tuple[bool, str]:
    """Matches `dream.sh:798-806` (decision) and `dream.sh:801`/`825`
    (reject/accept reason text)."""
    if scalar_sim is None:
        logger.warning("%s -- %s", directory, _EMBEDDER_UNREACHABLE_NOTE)
        return True, _EMBEDDER_UNREACHABLE_NOTE
    drift = round(1 - scalar_sim, 4)
    if scalar_sim < threshold:
        return False, f"drift too large (sim={scalar_sim:.4f}, threshold={threshold:.2f})"
    return True, f"drift OK (sim={scalar_sim:.4f}, drift={drift:.4f})"
