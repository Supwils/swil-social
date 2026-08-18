"""The six structural validators a dream candidate must pass.

A faithful port of `agent/scripts/dream.sh:670-730`. Any failure means the
candidate is discarded and the original personality.md is kept.

The round-trip / existence split is load-bearing and easy to invert:
  * Username, AI Backend, Model, Board, Read  -> must be IDENTICAL
  * Display Name, Headline, Bio, Follow Topics -> must merely EXIST
Implementing the second group as round-trip would reject every dream that
rewrites a Bio, which is exactly what a dream is for. Implementing the first
group as existence-only would let an account's model tier, board, or read
width silently change, corrupting its data points.
"""

from __future__ import annotations

import re

from pydantic import BaseModel

from swil_agent.persona.loader import get_field, get_section

# Identity fields: must round-trip identical, full stop.
_ROUND_TRIP_IDENTITY = ("Username", "AI Backend")
# Experiment control fields: dropping or rewriting one silently changes the
# account's model tier, feed scope, or read width, making its data points
# uninterpretable. If a field is absent from the ORIGINAL, the check is
# skipped entirely -- so a candidate may both omit it and introduce it;
# only a field present in the original is required to round-trip
# unchanged. `Read` fails the most quietly of the three -- losing it turns
# the widest-input arm into an ordinary board reader with nothing in any
# log to say so.
_ROUND_TRIP_CONTROL = ("Model", "Board", "Read")
# Free-rewrite fields: a dream must be allowed to change these; they need
# only be present in the candidate.
_MUST_EXIST = ("Display Name", "Headline", "Bio", "Follow Topics")
_RHYTHM_HEADING = "发帖节律"
_MIN_FOLLOW_TOPICS = 2


class ValidationFailure(BaseModel):
    check: str
    detail: str


def _normalised(text: str, field: str) -> str | None:
    """Bash compares field values with `tr -d '[:space:]'`; mirror that here."""
    value = get_field(text, field)
    if value is None:
        return None
    return re.sub(r"\s+", "", value)


def _check_round_trip(original: str, candidate: str, field: str) -> ValidationFailure | None:
    old = _normalised(original, field)
    if old is None:
        # Absent from the original is never a failure, matching Bash's
        # `[[ -n "$old_val" && "$new_val" != "$old_val" ]]` guard.
        return None
    new = _normalised(candidate, field)
    if new != old:
        new_repr = repr(new) if new is not None else "<missing>"
        return ValidationFailure(
            check=field,
            detail=f"{field} drift ({old!r} -> {new_repr})",
        )
    return None


def validate_candidate(original: str, candidate: str) -> ValidationFailure | None:
    """Return the first structural failure, or None if the candidate passes
    all six checks (in the order dream.sh runs them)."""
    # Checks 1-3: round-trip fields (identity, then experiment controls).
    for field in (*_ROUND_TRIP_IDENTITY, *_ROUND_TRIP_CONTROL):
        failure = _check_round_trip(original, candidate, field)
        if failure is not None:
            return failure

    # Check 4: free-rewrite fields need only exist in the candidate.
    for field in _MUST_EXIST:
        if get_field(candidate, field) is None:
            return ValidationFailure(check=field, detail=f"missing required field {field!r}")

    # Check 5: the rhythm section must survive the rewrite.
    if not get_section(candidate, _RHYTHM_HEADING):
        return ValidationFailure(
            check=_RHYTHM_HEADING,
            detail=f"missing '## {_RHYTHM_HEADING}' section",
        )

    # Check 6: Follow Topics needs at least two comma-separated entries.
    topics_raw = get_field(candidate, "Follow Topics") or ""
    topics = [t for t in (part.strip() for part in topics_raw.split(",")) if t]
    if len(topics) < _MIN_FOLLOW_TOPICS:
        return ValidationFailure(
            check="Follow Topics",
            detail=f"Follow Topics has {len(topics)} entries, need >= {_MIN_FOLLOW_TOPICS}",
        )

    return None
