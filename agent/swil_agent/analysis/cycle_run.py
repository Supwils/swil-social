"""The cycle_run card -- one ledger row per finished cycle (spec §4).

Per-action `cycle` events already fire from the executor. This module builds
the rollup `/lab` will read as runtime health: `metrics.kind == "cycle_run"`
on the existing `cycle` type (no migration). Missing-sampler warn events are
the audit rows; the card copies the flags. Both are fail-loud on the ledger
and fail-soft on the round outcome.

This package must not import `graph/` (architecture test). The builder is
pure: it takes scalars and a verdict and returns a `LabEvent`.
"""

from __future__ import annotations

from typing import Final, Literal

from swil_agent.api.dto import LabEvent
from swil_agent.models import ActOutcome, ActResult, DreamVerdict

CYCLE_RUN_KIND: Final = "cycle_run"

CYCLE_RUN_METRIC_KEYS: Final = frozenset(
    {
        "kind",
        "attempted",
        "landed",
        "actOutcome",
        "grantsDream",
        "dreamAccepted",
        "gateStatus",
        "missingBehaviorSnapshot",
        "missingRuleCheck",
        "durationMs",
        "backend",
        "model",
    }
)

GateStatus = Literal["checked", "fail_open", "struct_reject", "drift_reject", "accepted", "skipped"]

MISSING_SAMPLER_BEHAVIOR: Final = "behavior_snapshot"
MISSING_SAMPLER_RULE: Final = "rule_check"

# `dream/gate.py`'s `_ASPECT_FALLBACK_NOTE` prefix. Duplicated rather than
# imported: `analysis/` and `dream/` are peers (spec §5.2) and this string is
# the 2026-08-13 incident's own log line, pinned by tests on both sides.
_ASPECT_FALLBACK_PREFIX: Final = "aspect distill/embed failed"


def is_fail_open(verdict: DreamVerdict) -> bool:
    """True when the constitution layer did not actually gate this accept.

    Two paths, both of which still write today: the scalar embedder was
    unreachable (`DreamVerdict.embedder_unreachable`), or aspect
    distill/embed failed and the scalar fallback accepted. A reject is never
    fail-open -- structural validators remain the hard floor.
    """
    if not verdict.accepted:
        return False
    return verdict.embedder_unreachable or verdict.reason.startswith(_ASPECT_FALLBACK_PREFIX)


def derive_gate_status(
    verdict: DreamVerdict | None,
    *,
    proceeded: bool,
    written: bool,
) -> GateStatus:
    """Terminal gateStatus for the cycle_run card (spec §4)."""
    if not proceeded or verdict is None:
        return "skipped"
    if not verdict.accepted:
        if verdict.scalar_sim is None and verdict.sims is None:
            return "struct_reject"
        return "drift_reject"
    if is_fail_open(verdict) and written:
        return "fail_open"
    if written:
        return "accepted"
    return "checked"


def build_missing_sampler_event(*, sampler: str) -> LabEvent:
    """Audit row for one sampler that raised or returned empty.

    Deliberately has no `metrics.kind`. Readers MUST ignore events without
    `kind=cycle_run` when building the runtime strip; this row is the
    per-sampler trail, not the rollup.
    """
    return LabEvent(
        type="cycle",
        phase="act",
        outcome="warn",
        summary=f"missingSampler {sampler}",
        metrics={"missingSampler": sampler},
    )


def _card_outcome(
    *,
    act_outcome: ActOutcome | None,
    missing_behavior_snapshot: bool,
    missing_rule_check: bool,
    gate_status: GateStatus,
) -> str:
    """Spec §4 mapping, in listed order: fail, then warn, then skip, else success."""
    if act_outcome in (ActOutcome.OFFLINE, ActOutcome.BACKEND_UNAVAILABLE):
        return "fail"
    if missing_behavior_snapshot or missing_rule_check or gate_status == "fail_open":
        return "warn"
    if act_outcome in (ActOutcome.PLANNER_EMPTY, ActOutcome.VETOED_EMPTY):
        return "skip"
    return "success"


def build_cycle_run_event(
    *,
    username: str,
    attempted: int,
    landed: int,
    act_outcome: ActOutcome | None,
    grants_dream: bool,
    dream_accepted: bool | None,
    gate_status: GateStatus,
    missing_behavior_snapshot: bool,
    missing_rule_check: bool,
    duration_ms: int,
    backend: str,
    model: str,
) -> LabEvent:
    """One cycle_run card. Metric keys match spec §4 exactly -- no aliases."""
    act_label = act_outcome.value if act_outcome is not None else "unknown"
    return LabEvent(
        type="cycle",
        phase="act",
        outcome=_card_outcome(
            act_outcome=act_outcome,
            missing_behavior_snapshot=missing_behavior_snapshot,
            missing_rule_check=missing_rule_check,
            gate_status=gate_status,
        ),
        summary=f"cycle_run {username} {act_label}",
        metrics={
            "kind": CYCLE_RUN_KIND,
            "attempted": attempted,
            "landed": landed,
            "actOutcome": act_label,
            "grantsDream": grants_dream,
            "dreamAccepted": dream_accepted,
            "gateStatus": gate_status,
            "missingBehaviorSnapshot": missing_behavior_snapshot,
            "missingRuleCheck": missing_rule_check,
            "durationMs": duration_ms,
            "backend": backend,
            "model": model,
        },
    )


def grants_dream_for(act_outcome: ActOutcome | None) -> bool:
    """`ActResult.grants_dream`, with an undecided outcome denying nothing."""
    if act_outcome is None:
        return True
    return ActResult(outcome=act_outcome).grants_dream
