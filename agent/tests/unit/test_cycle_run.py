"""cycle_run card + missing-sample events (spec §4).

The cycle already posts per-action `cycle` events. This file pins the ONE
row `/lab` will use as the round rollup: `metrics.kind == "cycle_run"`, the
exact key set, the outcome mapping, and the fail-loud half of the sampler
contract -- a raising sampler still returns the graph to logout and does
not change the round's act outcome, but it leaves a `missingSampler` warn
row AND a card with the matching flag.
"""

from __future__ import annotations

import logging
import random
import sqlite3
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest

from swil_agent.analysis.cycle_run import (
    CYCLE_RUN_KIND,
    CYCLE_RUN_METRIC_KEYS,
    build_cycle_run_event,
    build_missing_sampler_event,
    derive_gate_status,
    grants_dream_for,
    is_fail_open,
)
from swil_agent.config import Settings
from swil_agent.dream.candidate import FilesystemDreamState
from swil_agent.graph import nodes as nodes_module
from swil_agent.graph.cycle import run_cycle
from swil_agent.graph.nodes import (
    CycleDeps,
    make_behavior_snapshot_node,
    make_logout_node,
    make_rule_check_node,
)
from swil_agent.models import ActOutcome, DreamVerdict, Persona
from swil_agent.persona.source import GitPersonaSource

from ._runners import FakeEmbedder, FakeResources, RecordingRunner, ScriptedBackend, SilentBackend

NOW = datetime(2026, 8, 21, 10, 0, 0)
CAPTURED_AT = datetime(2026, 8, 21, 2, 0, 0, tzinfo=UTC)
DIR_NAME = "zenith_dir"
USERNAME = "zenith"

PERSONALITY = """# 测试

## 身份
- **Username:** zenith
- **Display Name:** 测试
- **Headline:** AI Agent
- **Bio:** 一句话
- **Follow Topics:** alpha,beta,gamma

- **AI Backend:** claude

## 发帖节律
- 自由发挥，看心情
"""

CANDIDATE = PERSONALITY.replace("一句话", "改写过的一句话")
INITIAL_MEMORY = "2026-08-01 | act | did a thing\n"


def _card(**overrides: Any) -> dict[str, Any]:
    kwargs: dict[str, Any] = {
        "username": USERNAME,
        "attempted": 1,
        "landed": 1,
        "act_outcome": ActOutcome.LANDED_ALL,
        "grants_dream": True,
        "dream_accepted": True,
        "gate_status": "accepted",
        "missing_behavior_snapshot": False,
        "missing_rule_check": False,
        "duration_ms": 1200,
        "backend": "claude",
        "model": "opus",
    }
    kwargs.update(overrides)
    return build_cycle_run_event(**kwargs).to_wire()


def _verdict(**overrides: Any) -> DreamVerdict:
    kwargs: dict[str, Any] = {"accepted": True, "reason": "drift OK (sim=0.9000, drift=0.1000)"}
    kwargs.update(overrides)
    return DreamVerdict(**kwargs)


# ── builder: spec §4 shape ──────────────────────────────────────────────────


def test_the_card_discriminates_on_metrics_kind_cycle_run() -> None:
    wire = _card()
    assert wire["type"] == "cycle"
    assert wire["phase"] == "act"
    assert wire["metrics"]["kind"] == CYCLE_RUN_KIND == "cycle_run"


def test_the_card_summary_is_cycle_run_username_act_outcome() -> None:
    """Spec §4: `summary: "cycle_run <username> <actOutcome>"`."""
    assert _card()["summary"] == "cycle_run zenith landed_all"
    assert _card(act_outcome=ActOutcome.OFFLINE)["summary"] == "cycle_run zenith offline"


def test_the_card_metrics_use_the_spec_keys_and_no_aliases() -> None:
    metrics = _card()["metrics"]
    assert set(metrics) == CYCLE_RUN_METRIC_KEYS
    assert set(metrics) == {
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


def test_the_card_metrics_are_flat_scalars() -> None:
    """`agentEventIngest.metrics` is a z.record of string/number/boolean/null.
    A nested value 400s the WHOLE event."""
    metrics = _card(dream_accepted=None)["metrics"]
    for key, value in metrics.items():
        assert isinstance(value, str | float | int | bool | type(None)), key


def test_dream_accepted_is_null_when_the_dream_did_not_run() -> None:
    assert _card(dream_accepted=None)["metrics"]["dreamAccepted"] is None


# ── builder: spec §4 outcome mapping ────────────────────────────────────────


def test_offline_and_dead_backend_are_fail() -> None:
    assert _card(act_outcome=ActOutcome.OFFLINE, grants_dream=False)["outcome"] == "fail"
    assert (
        _card(act_outcome=ActOutcome.BACKEND_UNAVAILABLE, grants_dream=False)["outcome"] == "fail"
    )


def test_a_missing_sampler_is_warn_even_when_the_act_landed() -> None:
    assert _card(missing_behavior_snapshot=True)["outcome"] == "warn"
    assert _card(missing_rule_check=True)["outcome"] == "warn"


def test_fail_open_is_warn_even_when_the_act_landed() -> None:
    assert _card(gate_status="fail_open")["outcome"] == "warn"


def test_offline_fail_outranks_a_missing_sampler() -> None:
    """Spec §4 lists OFFLINE/BACKEND_UNAVAILABLE before the warn clause."""
    wire = _card(
        act_outcome=ActOutcome.OFFLINE,
        grants_dream=False,
        missing_behavior_snapshot=True,
    )
    assert wire["outcome"] == "fail"


def test_empty_plan_and_rhythm_veto_are_skip() -> None:
    assert _card(act_outcome=ActOutcome.PLANNER_EMPTY, landed=0, attempted=0)["outcome"] == "skip"
    assert _card(act_outcome=ActOutcome.VETOED_EMPTY, landed=0, attempted=0)["outcome"] == "skip"


def test_a_missing_sampler_on_an_empty_plan_is_warn_not_skip() -> None:
    """Warn outranks skip: a quiet round whose rule check raised is not health."""
    wire = _card(act_outcome=ActOutcome.PLANNER_EMPTY, missing_rule_check=True)
    assert wire["outcome"] == "warn"


def test_a_clean_landed_round_is_success() -> None:
    assert _card()["outcome"] == "success"
    partial = _card(act_outcome=ActOutcome.LANDED_PARTIAL, landed=1, attempted=2)
    assert partial["outcome"] == "success"


# ── derive_gate_status ──────────────────────────────────────────────────────


def test_gate_status_skipped_when_the_dream_did_not_run() -> None:
    assert derive_gate_status(None, proceeded=False, written=False) == "skipped"
    assert derive_gate_status(None, proceeded=True, written=False) == "skipped"


def test_gate_status_fail_open_when_the_embedder_was_unreachable_and_the_dream_wrote() -> None:
    verdict = _verdict(
        embedder_unreachable=True,
        reason="embedder unreachable, skipping drift check",
    )
    assert derive_gate_status(verdict, proceeded=True, written=True) == "fail_open"


def test_gate_status_fail_open_when_aspect_distill_failed_and_the_dream_wrote() -> None:
    """2026-08-13 incident class: aspect distill/embed failed, scalar accepted."""
    verdict = _verdict(
        reason=(
            "aspect distill/embed failed, falling back to scalar drift; "
            "drift OK (sim=0.9000, drift=0.1000)"
        )
    )
    assert derive_gate_status(verdict, proceeded=True, written=True) == "fail_open"


def test_gate_status_struct_reject() -> None:
    verdict = _verdict(accepted=False, reason="Username drift: zenith -> other")
    assert derive_gate_status(verdict, proceeded=True, written=False) == "struct_reject"


def test_gate_status_drift_reject() -> None:
    verdict = _verdict(accepted=False, reason="drift too large", scalar_sim=0.5)
    assert derive_gate_status(verdict, proceeded=True, written=False) == "drift_reject"


def test_gate_status_accepted_after_a_real_check() -> None:
    assert derive_gate_status(_verdict(), proceeded=True, written=True) == "accepted"


def test_gate_status_checked_when_the_gate_accepted_but_nothing_was_written() -> None:
    assert derive_gate_status(_verdict(), proceeded=True, written=False) == "checked"


def test_a_reject_is_never_fail_open() -> None:
    assert is_fail_open(_verdict(accepted=False, reason="Username drift")) is False


def test_an_undecided_act_outcome_still_grants_a_dream() -> None:
    assert grants_dream_for(None) is True
    assert grants_dream_for(ActOutcome.LANDED_ALL) is True
    assert grants_dream_for(ActOutcome.OFFLINE) is False


# ── missingSampler event ────────────────────────────────────────────────────


def test_a_missing_sampler_event_is_a_cycle_warn_without_the_cycle_run_kind() -> None:
    """Two writes on purpose: this is the audit row; the card is the rollup.
    Readers MUST ignore events without kind=cycle_run when building the strip.
    """
    wire = build_missing_sampler_event(sampler="behavior_snapshot").to_wire()
    assert wire["type"] == "cycle"
    assert wire["phase"] == "act"
    assert wire["outcome"] == "warn"
    assert wire["metrics"] == {"missingSampler": "behavior_snapshot"}
    assert "kind" not in wire["metrics"]


# ── graph: raising sampler is fail-soft on outcome, fail-loud on the ledger ─


def _account(root: Path) -> Path:
    directory = root / "agents" / DIR_NAME
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "personality.md").write_text(PERSONALITY, encoding="utf-8")
    (directory / "memory.md").write_text(INITIAL_MEMORY, encoding="utf-8")
    (directory / "api_key.txt").write_text("k-secret\n", encoding="utf-8")
    return directory


def _persona(root: Path, **kwargs: Any) -> Persona:
    defaults: dict[str, Any] = {
        "username": USERNAME,
        "directory": _account(root),
        "backend": "claude",
        "model": "opus",
        "rhythm_text": "",
        "raw": PERSONALITY,
    }
    defaults.update(kwargs)
    return Persona(**defaults)


def _deps(root: Path, **overrides: Any) -> CycleDeps:
    defaults: dict[str, Any] = {
        "resources": FakeResources(),
        "backend": ScriptedBackend(
            '{"plan":[{"action":"post","text":"你好世界"}]}', CANDIDATE, "叙述"
        ),
        "persona_source": GitPersonaSource(root),
        "runner": RecordingRunner(),
        "embedder": FakeEmbedder(vectors=[[1.0], [1.0], [1.0]]),
        "dream_state": FilesystemDreamState(root / ".agent-state"),
        "settings": Settings(agent_root=root, drift_mode="scalar"),
        "agent_root": root,
        "health_check": lambda: True,
        "memory_text": INITIAL_MEMORY,
        "rng": random.Random(7),
        "now": NOW,
        "captured_at": CAPTURED_AT,
    }
    defaults.update(overrides)
    return CycleDeps(**defaults)


def _run(root: Path, deps: CycleDeps, persona: Persona | None = None) -> dict[str, Any]:
    lease_db = sqlite3.connect(":memory:")
    try:
        return dict(
            run_cycle(
                persona=persona or _persona(root),
                deps=deps,
                lease_db=lease_db,
                round_id="cycle-run",
                run_id="run-1",
            )
        )
    finally:
        lease_db.close()


def _explode(name: str) -> Any:
    def boom(*_args: Any, **_kwargs: Any) -> Any:
        raise RuntimeError(f"{name} blew up")

    return boom


def _cycle_run_events(resources: FakeResources) -> list[Any]:
    return [event for event in resources.lab_events if event.metrics.get("kind") == CYCLE_RUN_KIND]


def _missing_sampler_events(resources: FakeResources) -> list[Any]:
    return [event for event in resources.lab_events if "missingSampler" in event.metrics]


@pytest.mark.parametrize(
    ("step", "sampler", "flag"),
    [
        ("run_behavior_snapshot", "behavior_snapshot", "missing_behavior_snapshot"),
        ("run_rule_check", "rule_check", "missing_rule_check"),
    ],
    ids=["behavior", "rule"],
)
def test_a_raising_sampler_emits_missing_sampler_and_still_returns_a_partial(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    step: str,
    sampler: str,
    flag: str,
) -> None:
    """Spec §4: raise → warn event with missingSampler, round continues."""
    root = tmp_path / "agent_root"
    resources = FakeResources()
    monkeypatch.setattr(nodes_module, step, _explode(step))
    factory = (
        make_behavior_snapshot_node if sampler == "behavior_snapshot" else make_rule_check_node
    )

    with caplog.at_level(logging.WARNING, logger="swil_agent.graph.nodes"):
        update = factory(_deps(root, resources=resources))({"persona": _persona(root)})

    assert update == {flag: True}
    events = _missing_sampler_events(resources)
    assert len(events) == 1
    assert events[0].outcome == "warn"
    assert events[0].metrics == {"missingSampler": sampler}
    assert resources.lab_event_usernames == [USERNAME]


def test_a_raising_sampler_still_returns_the_graph_to_logout(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Fail-soft on the round: the act still lands, personality still writes,
    logout still runs. Fail-loud on the ledger: missingSampler + card flag."""
    root = tmp_path / "agent_root"
    resources = FakeResources()
    monkeypatch.setattr(nodes_module, "run_behavior_snapshot", _explode("run_behavior_snapshot"))

    final = _run(root, _deps(root, resources=resources))

    assert final.get("outcome") is ActOutcome.LANDED_ALL
    assert final.get("written") is True
    assert final.get("missing_behavior_snapshot") is True
    missing = _missing_sampler_events(resources)
    assert [event.metrics["missingSampler"] for event in missing] == ["behavior_snapshot"]
    cards = _cycle_run_events(resources)
    assert len(cards) == 1
    assert cards[0].outcome == "warn"
    assert cards[0].metrics["missingBehaviorSnapshot"] is True
    assert cards[0].metrics["missingRuleCheck"] is False
    assert cards[0].metrics["actOutcome"] == "landed_all"
    assert cards[0].metrics["grantsDream"] is True


def test_an_offline_cycle_still_emits_a_cycle_run_card(tmp_path: Path) -> None:
    """Spec §4: one event per finished cycle, including early logout."""
    root = tmp_path / "agent_root"
    resources = FakeResources()

    final = _run(root, _deps(root, resources=resources, health_check=lambda: False))

    assert final.get("outcome") is ActOutcome.OFFLINE
    cards = _cycle_run_events(resources)
    assert len(cards) == 1
    assert cards[0].outcome == "fail"
    assert cards[0].summary == "cycle_run zenith offline"
    assert cards[0].metrics["actOutcome"] == "offline"
    assert cards[0].metrics["grantsDream"] is False
    assert cards[0].metrics["dreamAccepted"] is None
    assert cards[0].metrics["gateStatus"] == "skipped"
    assert cards[0].metrics["missingBehaviorSnapshot"] is False
    assert cards[0].metrics["missingRuleCheck"] is False
    assert resources.lab_event_usernames[-1] == USERNAME


def test_a_dead_backend_cycle_emits_a_fail_card(tmp_path: Path) -> None:
    root = tmp_path / "agent_root"
    resources = FakeResources()

    final = _run(root, _deps(root, resources=resources, backend=SilentBackend()))

    assert final.get("outcome") is ActOutcome.BACKEND_UNAVAILABLE
    cards = _cycle_run_events(resources)
    assert len(cards) == 1
    assert cards[0].outcome == "fail"
    assert cards[0].metrics["actOutcome"] == "backend_unavailable"
    assert cards[0].metrics["gateStatus"] == "skipped"


def test_an_empty_plan_cycle_emits_a_skip_card(tmp_path: Path) -> None:
    root = tmp_path / "agent_root"
    resources = FakeResources()
    deps = _deps(
        root,
        resources=resources,
        backend=ScriptedBackend('{"plan":[]}', CANDIDATE, "叙述"),
    )

    final = _run(root, deps)

    assert final.get("outcome") is ActOutcome.PLANNER_EMPTY
    cards = _cycle_run_events(resources)
    assert len(cards) == 1
    assert cards[0].outcome == "skip"
    assert cards[0].metrics["actOutcome"] == "planner_empty"
    assert cards[0].metrics["missingBehaviorSnapshot"] is False


def test_fail_open_sets_gate_status_on_the_card_and_the_dream_event(tmp_path: Path) -> None:
    """Spec §3: ungated dream → dream event gateStatus=fail_open plus the card."""
    root = tmp_path / "agent_root"
    resources = FakeResources()
    deps = _deps(root, resources=resources, embedder=FakeEmbedder(fail_always=True))

    final = _run(root, deps)

    assert final.get("written") is True
    assert final.get("verdict") is not None
    assert final["verdict"].embedder_unreachable is True
    warn = [
        event for event in resources.lab_events if event.type == "dream" and event.outcome == "warn"
    ]
    assert warn
    assert warn[0].metrics.get("gateStatus") == "fail_open"
    updated = [
        event
        for event in resources.lab_events
        if event.type == "dream" and event.summary == "personality updated"
    ]
    assert updated
    assert updated[0].metrics.get("gateStatus") == "fail_open"
    cards = _cycle_run_events(resources)
    assert len(cards) == 1
    assert cards[0].outcome == "warn"
    assert cards[0].metrics["gateStatus"] == "fail_open"
    assert cards[0].metrics["dreamAccepted"] is True


def test_a_dry_run_does_not_emit_a_cycle_run_card(tmp_path: Path) -> None:
    root = tmp_path / "agent_root"
    resources = FakeResources()

    _run(root, _deps(root, resources=resources, dry_run=True))

    assert _cycle_run_events(resources) == []
    assert _missing_sampler_events(resources) == []


def test_the_logout_card_uses_the_username_bullet_and_the_injected_clock(
    tmp_path: Path,
) -> None:
    """Directory name and Username bullet diverge; duration comes off deps.monotonic."""
    root = tmp_path / "agent_root"
    resources = FakeResources()
    ticks = iter([10.5])
    deps = _deps(root, resources=resources, monotonic=lambda: next(ticks))
    node = make_logout_node(deps)

    update = node(
        {
            "persona": _persona(root),
            "run_id": "run-7",
            "outcome": ActOutcome.LANDED_ALL,
            "attempted": 2,
            "landed": 2,
            "written": True,
            "started_monotonic": 10.0,
            "backend": "unused",
        }
    )

    assert update == {}
    cards = _cycle_run_events(resources)
    assert len(cards) == 1
    assert resources.lab_event_usernames == [USERNAME]
    assert cards[0].metrics["durationMs"] == 500
    assert cards[0].metrics["backend"] == "claude"
    assert cards[0].metrics["model"] == "opus"
    assert cards[0].metrics["attempted"] == 2
    assert cards[0].metrics["landed"] == 2


def test_a_rejected_dream_card_records_dream_accepted_false(tmp_path: Path) -> None:
    root = tmp_path / "agent_root"
    resources = FakeResources()
    node = make_logout_node(_deps(root, resources=resources))

    node(
        {
            "persona": _persona(root),
            "run_id": "run-7",
            "outcome": ActOutcome.LANDED_ALL,
            "proceeded": True,
            "written": False,
            "verdict": DreamVerdict(accepted=False, reason="Username drift"),
        }
    )

    cards = _cycle_run_events(resources)
    assert cards[0].metrics["dreamAccepted"] is False
    assert cards[0].metrics["gateStatus"] == "struct_reject"


def test_a_lab_outage_emitting_the_card_does_not_change_logout(
    tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The ledger is fail-loud when it lands; a dead events endpoint must not
    become the round's exit code. The miss itself is WARNING so a missing
    ledger is grep-able (DEBUG would drown in the round log)."""
    root = tmp_path / "agent_root"
    resources = FakeResources(lab_event_raises=RuntimeError("events down"))
    node = make_logout_node(_deps(root, resources=resources))

    with caplog.at_level(logging.WARNING, logger="swil_agent.graph.nodes"):
        update = node(
            {
                "persona": _persona(root),
                "run_id": "run-7",
                "outcome": ActOutcome.OFFLINE,
            }
        )

    assert update == {}
    assert any(
        rec.levelno == logging.WARNING and "lab event failed" in rec.message
        for rec in caplog.records
    )
