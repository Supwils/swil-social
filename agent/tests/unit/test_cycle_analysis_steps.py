"""The two observability steps the Python cycle used to omit (spec §15.1 row 21).

`cycle-one.sh` and `auto-run.sh` each call one sampler that Plan 3's
`swil-agent cycle` did not, and neither absence is loud -- a `/lab` series
simply goes flat, and a flat series in those two panels reads as *this agent
stopped obeying its own rules* / *its persona fidelity collapsed*, not as *not
sampled*:

| step | Bash call site | panel |
|---|---|---|
| `behavior-snapshot.sh` | `auto-run.sh:806`, act phase tail | fidelity (revealed self) |
| `rule-check.sh` | `cycle-one.sh:45`, before `dream.sh` | F4 rule adherence |

**What this file exists to catch, that no other file can.** The samplers
themselves are covered exhaustively by `test_rule_check.py` (74 tests) and
`test_behavior_snapshot.py` (38). What is untested without this file is the
WIRING: that they are called at all, from the right position, with the right
arguments, never under `--dry-run`, and that a failure in either cannot cost
the account its round.

**The ordering is the hard part and is pinned three ways.** `rule_check` must
run BEFORE the dream, because it parses rules out of `personality.md` and the
dream rewrites that file (`cycle-one.sh:39-41`, which says so). Sampling
afterwards measures the NEW rules against the OLD posts -- an answer that is
wrong and looks completely normal. An end-state assertion cannot see it, so:

  1. **Topologically** -- `test_graph_cycle.py`'s
     `test_the_act_phase_cannot_reach_the_dream_without_passing_rule_check`
     enumerates every edge into `dream`.
  2. **By recorded call sequence** -- `_trace_calls` below patches
     `graph.nodes`' own globals (standing constraint §6: a
     `from ... import` elsewhere binds at import time and never sees a spy)
     and asserts the index order.
  3. **By WHICH DOCUMENT was measured** -- the strongest, and the reason
     `run_rule_check` re-reads `personality.md` itself rather than taking a
     `Persona` (Task 1's decision). This file's fixture states one hashtag
     band in the personality (`2～3`) and a DIFFERENT one in the accepted
     dream candidate (`5～6`), over posts carrying exactly 2 tags. So the
     round's single `rule_check` event reads `2-3 ... (100%) / success`
     before the write and `5-6 ... (0%) / flagged` after it. A mutation that
     preserves the call order but reads the wrong document still dies here.

Standing constraint §4 in one line: the fixture must make the pinned value
DISCRIMINABLE. A candidate that restated the same rule would have made
observer 3 vacuous while every assertion still named the right field.
"""

from __future__ import annotations

import hashlib
import logging
import random
import sqlite3
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest

from swil_agent.analysis import behavior_snapshot as behavior_module
from swil_agent.analysis import rule_check as rule_check_module
from swil_agent.config import Settings
from swil_agent.dream.candidate import FilesystemDreamState
from swil_agent.graph import nodes as nodes_module
from swil_agent.graph.cycle import CycleConfig, run_cycle
from swil_agent.graph.nodes import (
    CycleDeps,
    make_behavior_snapshot_node,
    make_population_metric_node,
    make_rule_check_node,
)
from swil_agent.graph.state import CycleState
from swil_agent.models import ActOutcome, Persona
from swil_agent.persona.source import GitPersonaSource

from ._runners import FakeEmbedder, FakeResources, RecordingRunner, ScriptedBackend

NOW = datetime(2026, 8, 19, 10, 0, 0)
# Deliberately a different instant from `NOW`: `captured_at` and `now` are read
# from independent `date` / `date -u` calls in Bash, and a fixture where they
# coincide cannot tell `captured_at=deps.captured_at` from `captured_at=
# deps.now` -- both format to the same `capturedAt` string.
CAPTURED_AT = datetime(2026, 8, 19, 2, 0, 0, tzinfo=UTC)
SEED = 7

# Directory name and `Username` bullet differ everywhere in this file. The
# samplers take the DIRECTORY (to find `api_key.txt` and `personality.md`) and
# the `Username` BULLET (for `GET /users/{u}/posts`, `POST /agents/{u}/events`
# and `POST /agents/{u}/behavior-snapshots`), and the two really do diverge on
# this roster -- a fixture where they coincide cannot tell them apart.
DIR_NAME = "zenith_dir"
USERNAME = "zenith"

# The band the ACCOUNT states. Two tags per post satisfies it.
PERSONALITY = """# 测试

## 身份
- **Username:** zenith
- **Display Name:** 测试
- **Headline:** AI Agent
- **Bio:** 一句话
- **Follow Topics:** alpha,beta,gamma

- **AI Backend:** claude

## 行为规则
- 每帖 hashtag 2～3 个

## 发帖节律
- 自由发挥，看心情
"""

# The band the DREAM rewrites it to. Two tags per post violates it, so the two
# documents produce opposite verdicts over the same sample -- which is what
# makes "measured before the rewrite" observable at all.
CANDIDATE = PERSONALITY.replace("hashtag 2～3 个", "hashtag 5～6 个")

RULE_BEFORE_THE_DREAM = "hashtag count 2-3: 1/1 posts adherent (100%)"
RULE_AFTER_THE_DREAM = "hashtag count 5-6: 0/1 posts adherent (0%)"

POST_BODY = "写完了 #alpha #beta"
POSTS = [{"id": "p1", "text": POST_BODY}]

INITIAL_MEMORY = "2026-08-01 | act | did a thing\n"

# Neither equals the other, and neither equals the Bash default of 12 -- which
# is also `Resources.user_posts`' own default and both analysis modules'
# `DEFAULT_POST_LIMIT`. So a node that hardcoded any of those, or that fed the
# rule check's limit to the behaviour snapshot, is visible.
RULE_LIMIT = 5
BEHAVIOR_LIMIT = 7


def _settings(root: Path, **overrides: Any) -> Settings:
    defaults: dict[str, Any] = {
        "agent_root": root,
        "drift_mode": "scalar",
        "rule_check_post_limit": RULE_LIMIT,
        "behavior_post_limit": BEHAVIOR_LIMIT,
    }
    defaults.update(overrides)
    return Settings(**defaults)


class DerivedEmbedder:
    """Records every input AND returns a vector derived from it.

    Standing constraint §4: `FakeEmbedder` hands back its scripted vector
    whatever it was asked to embed, so a test asserting on the returned vector
    cannot tell WHICH document was embedded. Here two different texts can
    never produce the same vector, so the `embedding` that reaches the wire is
    itself evidence -- and "embed the personality instead of the posts" dies
    twice, once on `calls` and once on the payload.
    """

    def __init__(self) -> None:
        self.calls: list[list[str]] = []

    def embed(self, texts: list[str]) -> list[list[float]]:
        self.calls.append(list(texts))
        return [self.vector_for(text) for text in texts]

    @staticmethod
    def vector_for(text: str) -> list[float]:
        digest = hashlib.sha256(text.encode()).digest()
        return [float(len(text)), float(digest[0]), float(digest[1])]


def _account(root: Path, *, api_key: bool = True, personality: str = PERSONALITY) -> Path:
    directory = root / "agents" / DIR_NAME
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "personality.md").write_text(personality, encoding="utf-8")
    (directory / "memory.md").write_text(INITIAL_MEMORY, encoding="utf-8")
    if api_key:
        (directory / "api_key.txt").write_text("k-secret\n", encoding="utf-8")
    return directory


def _persona(root: Path, **kwargs: Any) -> Persona:
    return Persona(
        username=USERNAME,
        directory=_account(root, **kwargs),
        backend="claude",
        model=None,
        rhythm_text="",
        # `raw` deliberately holds the personality text as it was at LOAD
        # time. A node that scored `persona.raw` instead of re-reading the
        # file would look correct on a round with no dream and silently
        # measure a stale document on every other one.
        raw=PERSONALITY,
    )


def _resources(**kwargs: Any) -> FakeResources:
    resources = FakeResources(**kwargs)
    resources.user_post_items = [dict(item) for item in POSTS]
    return resources


def _deps(root: Path, **overrides: Any) -> CycleDeps:
    defaults: dict[str, Any] = {
        "resources": _resources(),
        "backend": ScriptedBackend(
            '{"plan":[{"action":"post","text":"你好世界"}]}', CANDIDATE, "叙述"
        ),
        "persona_source": GitPersonaSource(root),
        "runner": RecordingRunner(),
        # Three vectors, not two: the behaviour snapshot embeds FIRST (it is
        # the act phase's tail), then the scalar drift gate embeds the anchor
        # and the candidate. Equal vectors there give sim 1.0, so the dream is
        # accepted and `personality.md` really is rewritten -- which is the
        # precondition for the "which document was measured" observer.
        "embedder": FakeEmbedder(vectors=[[1.0], [1.0], [1.0]]),
        "dream_state": FilesystemDreamState(root / ".agent-state"),
        "settings": _settings(root),
        "agent_root": root,
        "health_check": lambda: True,
        "memory_text": INITIAL_MEMORY,
        "rng": random.Random(SEED),
        "now": NOW,
        "captured_at": CAPTURED_AT,
    }
    defaults.update(overrides)
    return CycleDeps(**defaults)


def _root(tmp_path: Path) -> Path:
    root = tmp_path / "agent_root"
    root.mkdir(parents=True, exist_ok=True)
    return root


def _run(root: Path, persona: Persona, deps: CycleDeps, **kwargs: Any) -> CycleState:
    lease_db = sqlite3.connect(":memory:")
    try:
        return run_cycle(
            persona=persona,
            deps=deps,
            lease_db=lease_db,
            round_id="analysis",
            run_id="run-1",
            **kwargs,
        )
    finally:
        lease_db.close()


# Every call `graph/nodes.py` makes that this file needs to place in time.
# Patched on `graph.nodes`' OWN globals, because that is the name each node
# resolves at call time -- a spy installed on `swil_agent.analysis.rule_check`
# would never be seen (standing constraint §6).
_TRACEABLE = (
    "execute_step",
    "finalize_step",
    "run_behavior_snapshot",
    "run_rule_check",
    "run_population_metric",
    "cooldown_step",
    "dream_step",
    "gate_step",
    "write_step",
    "snapshot_step",
)


def _trace_calls(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    """Record, in order, every traced call the node layer makes.

    `*args` as well as `**kwargs`: the two samplers take `resources`
    POSITIONALLY (`run_rule_check(resources, *, ...)`), and a keyword-only spy
    silently turns every one of those calls into a `TypeError` that the
    node's own fail-soft guard then swallows -- a trace that records nothing
    while every fail-soft test still passes.
    """
    trace: list[str] = []

    def install(name: str) -> None:
        real = getattr(nodes_module, name)

        def spy(*args: Any, **kwargs: Any) -> Any:
            trace.append(name)
            return real(*args, **kwargs)

        monkeypatch.setattr(nodes_module, name, spy)

    for name in _TRACEABLE:
        install(name)
    return trace


def _explode(name: str) -> Callable[..., Any]:
    def boom(*_args: Any, **_kwargs: Any) -> Any:
        raise RuntimeError(f"{name} blew up")

    return boom


def _rule_events(resources: FakeResources) -> list[Any]:
    return [event for event in resources.lab_events if event.type == "rule_check"]


# ── the node layer: what each sampler is handed ─────────────────────────────


def test_the_rule_check_node_samples_the_account_the_username_bullet_names(
    tmp_path: Path,
) -> None:
    """`GET /users/{u}/posts` and `POST /agents/{u}/events` take the `Username`
    BULLET, while `personality.md` and `api_key.txt` are found under the
    DIRECTORY. The two differ here, so a node that passed one for the other is
    visible rather than coincidentally right."""
    root = _root(tmp_path)
    persona = _persona(root)
    resources = _resources()
    deps = _deps(root, resources=resources)

    assert make_rule_check_node(deps)({"persona": persona}) == {}

    assert resources.user_posts_calls == [(USERNAME, RULE_LIMIT)]
    events = _rule_events(resources)
    assert len(events) == 1
    assert events[0].summary == RULE_BEFORE_THE_DREAM
    assert events[0].outcome == "success"


def test_the_rule_check_node_re_reads_the_file_rather_than_trusting_the_persona(
    tmp_path: Path,
) -> None:
    """Ruling R1's whole point, at the node.

    `persona.raw` is the text as it was when the persona was LOADED. This test
    rewrites `personality.md` underneath it, so a node scoring `persona.raw`
    (or any other cached copy) reports the band the file no longer states.
    That is exactly the failure a mis-ordered call produces in production, and
    it must be reachable without running a whole cycle.
    """
    root = _root(tmp_path)
    persona = _persona(root)
    (persona.directory / "personality.md").write_text(CANDIDATE, encoding="utf-8")
    resources = _resources()

    make_rule_check_node(_deps(root, resources=resources))({"persona": persona})

    events = _rule_events(resources)
    assert [event.summary for event in events] == [RULE_AFTER_THE_DREAM]
    assert events[0].outcome == "flagged"


def test_the_rule_check_node_honours_the_configured_post_window(tmp_path: Path) -> None:
    """`RULE_CHECK_POST_LIMIT` (rule-check.sh:25). `Settings`' field is the
    Python side of that env var; 5 is neither the Bash default (12) nor
    `Resources.user_posts`' own, so a hardcoded limit dies here."""
    root = _root(tmp_path)
    resources = _resources()
    deps = _deps(root, resources=resources, settings=_settings(root, rule_check_post_limit=3))

    make_rule_check_node(deps)({"persona": _persona(root)})

    assert resources.user_posts_calls == [(USERNAME, 3)]


def test_the_behavior_snapshot_node_embeds_the_posts_and_ships_that_vector(
    tmp_path: Path,
) -> None:
    """The input side and the wire side of the same claim.

    `DerivedEmbedder` encodes its input into the vector it returns, so
    "embedded the personality instead of the posts" dies on `calls` AND on the
    `embedding` that reached `create_behavior_snapshot`.
    """
    root = _root(tmp_path)
    persona = _persona(root)
    resources = _resources()
    embedder = DerivedEmbedder()

    assert (
        make_behavior_snapshot_node(_deps(root, resources=resources, embedder=embedder))(
            {"persona": persona}
        )
        == {}
    )

    assert embedder.calls == [[POST_BODY]]
    assert resources.user_posts_calls == [(USERNAME, BEHAVIOR_LIMIT)]
    assert len(resources.behavior_snapshots) == 1
    username, payload = resources.behavior_snapshots[0]
    assert username == USERNAME
    assert payload["embedding"] == DerivedEmbedder.vector_for(POST_BODY)
    assert payload["postCount"] == 1
    # `captured_at`, not `now`: the two are different instants in this file.
    assert payload["capturedAt"].startswith("2026-08-19T02:00:00")


def test_the_behavior_snapshot_node_is_not_the_personality_snapshot(tmp_path: Path) -> None:
    """Two different endpoints with two different bodies. `snapshot_step`
    uploads the STATED self (`personality.md`); this node uploads the REVEALED
    self (recent posts), and `/lab`'s fidelity number is the cosine between
    them -- so a node that called the personality endpoint would produce a
    fidelity of 1.0 for every account, forever."""
    root = _root(tmp_path)
    resources = _resources()

    make_behavior_snapshot_node(_deps(root, resources=resources))({"persona": _persona(root)})

    assert resources.snapshots == []
    assert len(resources.behavior_snapshots) == 1
    assert set(resources.behavior_snapshots[0][1]) == {
        "contentHash",
        "capturedAt",
        "postCount",
        "commentCount",
        "excerpt",
        "embedding",
    }


# ── fail-soft: Bash's `|| true`, at both call sites ─────────────────────────


@pytest.mark.parametrize(
    ("factory", "step", "label"),
    [
        (make_rule_check_node, "run_rule_check", "rule-check"),
        (make_behavior_snapshot_node, "run_behavior_snapshot", "behavior-snapshot"),
    ],
)
def test_a_sampler_that_raises_is_swallowed_at_the_node(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    factory: Callable[[CycleDeps], Any],
    step: str,
    label: str,
) -> None:
    """`auto-run.sh:806` and `cycle-one.sh:45` both end in `|| true`.

    These two nodes carry no retry policy and no fallback edge, so an escaping
    exception aborts the whole LangGraph run -- costing the account its dream,
    its logout record and, on a checkpointed run, a resumable thread, in order
    to record a number on a panel.

    The LABEL is asserted, not only the cause. `auto-run.log` is what an
    operator greps when a `/lab` series goes flat -- which is the entire
    scenario this plan exists to make legible -- and a WARN that names the
    wrong sampler (or none) sends them to the wrong panel. Both labels are
    swappable in one edit and were unpinned until review said so; a
    `startswith` on `<label>: <directory>` kills the swap AND a blank label,
    which a substring check would not.
    """
    root = _root(tmp_path)
    monkeypatch.setattr(nodes_module, step, _explode(step))

    with caplog.at_level(logging.WARNING, logger="swil_agent.graph.nodes"):
        update = factory(_deps(root))({"persona": _persona(root)})

    flag = "missing_rule_check" if step == "run_rule_check" else "missing_behavior_snapshot"
    assert update == {flag: True}

    messages = [record.getMessage() for record in caplog.records]
    assert any(
        message.startswith(f"{label}: {DIR_NAME} ") and f"{step} blew up" in message
        for message in messages
    ), messages
    # ...and the OTHER sampler's label never appears, so "both labels made
    # identical" is caught as well as "the two were swapped".
    other = "behavior-snapshot" if label == "rule-check" else "rule-check"
    assert not any(message.startswith(f"{other}:") for message in messages), messages


@pytest.mark.parametrize(
    "factory", [make_rule_check_node, make_behavior_snapshot_node], ids=["rule", "behavior"]
)
def test_a_sampler_does_not_swallow_a_keyboard_interrupt(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, factory: Callable[[CycleDeps], Any]
) -> None:
    """`except Exception`, not `except BaseException`. A `KeyboardInterrupt`
    or a `SystemExit` is the operator or the platform ending the run, and
    swallowing it here would carry on with the cycle while still holding both
    leases."""

    def interrupt(*_args: Any, **_kwargs: Any) -> Any:
        raise KeyboardInterrupt

    monkeypatch.setattr(nodes_module, "run_rule_check", interrupt)
    monkeypatch.setattr(nodes_module, "run_behavior_snapshot", interrupt)

    root = _root(tmp_path)
    with pytest.raises(KeyboardInterrupt):
        factory(_deps(root))({"persona": _persona(root)})


# ── --dry-run: the guard lives WITH the call ────────────────────────────────


@pytest.mark.parametrize(
    "factory", [make_rule_check_node, make_behavior_snapshot_node], ids=["rule", "behavior"]
)
def test_neither_sampler_touches_the_wire_under_dry_run(
    tmp_path: Path, factory: Callable[[CycleDeps], Any]
) -> None:
    """Standing constraint §5 and §9. Both samplers POST -- one lab event per
    parseable rule, one behaviour snapshot per round -- and neither
    `run_rule_check` nor `run_behavior_snapshot` takes a `dry_run` parameter
    to be inert under. `behavior_snapshot` in particular has NO edge-level
    protection to fall back on: the act phase runs under `--dry-run`
    (inertly) and flows straight into it, so this line is the only guard.

    Asserted on the absence of any call, reads included -- an assertion about
    writes alone would pass for a node that fetched the posts and then decided
    not to ship them, which still costs a shadow round 23 API calls.
    """
    root = _root(tmp_path)
    resources = _resources()
    embedder = DerivedEmbedder()
    deps = _deps(root, resources=resources, embedder=embedder, dry_run=True)

    assert factory(deps)({"persona": _persona(root)}) == {}

    assert resources.user_posts_calls == []
    assert resources.lab_events == []
    assert resources.behavior_snapshots == []
    assert embedder.calls == []


# ── the cycle: position, and what a mis-ordered call would measure ──────────


def test_a_full_cycle_samples_behaviour_after_the_act_and_rules_before_the_dream(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Observer 2: the recorded call sequence.

    Both positions are taken from a Bash call site rather than chosen:
    `auto-run.sh:806` puts the behaviour snapshot below every early return in
    `run_agent` (so after `finalize_step`, the last thing that round does),
    and `cycle-one.sh:45` puts the rule check between `auto-run.sh` and
    `dream.sh` -- before the COOLDOWN gate, not merely before the rewrite, so
    an account whose dream SKIPs is still sampled every round.
    """
    root = _root(tmp_path)
    trace = _trace_calls(monkeypatch)

    _run(root, _persona(root), _deps(root))

    assert trace == [
        "execute_step",
        "finalize_step",
        "run_behavior_snapshot",
        "run_rule_check",
        "cooldown_step",
        "dream_step",
        "gate_step",
        "write_step",
        "snapshot_step",
        # The cycle's tail, after `logout`. It is LAST because the population
        # vector it summarises only finishes moving when this account's own
        # snapshot has landed -- sampling before `snapshot_step` would read
        # the population as it was before this round's contribution.
        "run_population_metric",
    ]


def test_the_rule_check_measures_the_rules_that_produced_this_rounds_posts(
    tmp_path: Path,
) -> None:
    """Observer 3, and the reason the ordering matters at all.

    `cycle-one.sh:39-41`: *the rule check parses rules out of personality.md,
    and the dream rewrites personality.md. Sample first and what you measured
    is the ruleset that was actually in force while these posts were written;
    sample afterwards and you have measured the NEW rules against the OLD
    posts.*

    The fixture makes the two answers opposite: the account states `2～3`
    hashtags, the accepted dream rewrites that to `5～6`, and the sampled post
    carries exactly 2. So a cycle that sampled after the write reports this
    account as 0% adherent to a rule it had not written yet -- which is the
    2026-06 `quant` incident's exact shape, one layer up.
    """
    root = _root(tmp_path)
    resources = _resources()
    persona = _persona(root)

    final = _run(root, persona, _deps(root, resources=resources))

    assert final.get("written") is True, "the dream must land, or there is no rewrite to race"
    # The written text is the CANDIDATE up to `clean_candidate`'s trailing
    # whitespace normalisation, so the rule line is what is asserted rather
    # than the whole document -- it is the only part this test is about.
    written = (persona.directory / "personality.md").read_text(encoding="utf-8")
    assert "hashtag 5～6 个" in written and "hashtag 2～3 个" not in written

    events = _rule_events(resources)
    assert [event.summary for event in events] == [RULE_BEFORE_THE_DREAM]
    assert [event.outcome for event in events] == ["success"]
    assert events[0].metrics == {"rule": "hashtag_count", "passRate": 1.0, "checked": 1}


def test_a_cooldown_skip_is_still_sampled(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """`cycle-one.sh` calls `rule-check.sh` before `dream.sh` at all, not
    before the rewrite -- so the F4 series has one point per ROUND, not one
    per dream. An account inside its 12h cooldown is the common case, and a
    rule check placed inside the dream node's post-cooldown path would leave
    most rounds unsampled while every test that dreams stayed green."""
    root = _root(tmp_path)
    state_dir = root / ".agent-state"
    state_dir.mkdir(parents=True, exist_ok=True)
    # Seeded RELATIVE TO `NOW`, never to the wall clock: `cooldown_step` is
    # handed `deps.now`, and a marker from `time.time()` yields a negative
    # elapsed-hours value that skips for the wrong reason.
    (state_dir / f"last_dream_{DIR_NAME}").write_text(
        str(int(NOW.timestamp()) - 3600), encoding="utf-8"
    )
    (state_dir / f"last_dream_memlines_{DIR_NAME}").write_text(
        str(INITIAL_MEMORY.count("\n")), encoding="utf-8"
    )
    resources = _resources()
    trace = _trace_calls(monkeypatch)

    final = _run(root, _persona(root), _deps(root, resources=resources, auto=True))

    assert final.get("proceeded") is False
    assert "dream_step" not in trace
    assert trace.index("run_rule_check") < trace.index("cooldown_step")
    assert [event.summary for event in _rule_events(resources)] == [RULE_BEFORE_THE_DREAM]


def test_an_empty_plan_samples_the_rules_but_ships_no_behaviour_vector(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Reachability taken from where Bash puts each call, not reproduced by a
    condition of our own.

    `auto-run.sh:742-744` returns 75 on an empty plan after guardrails, above
    `:806`, so Bash ships no behaviour vector -- and in the graph that path
    routes AROUND `execute`, hence around its successor. The rule check still
    runs, because Python's dream gate is `ActResult.grants_dream` (§7.1) and
    an empty plan is the agent correctly choosing to be quiet.
    """
    root = _root(tmp_path)
    resources = _resources()
    trace = _trace_calls(monkeypatch)
    deps = _deps(
        root, resources=resources, backend=ScriptedBackend('{"plan":[]}', CANDIDATE, "叙述")
    )

    final = _run(root, _persona(root), deps)

    assert final.get("outcome") is ActOutcome.PLANNER_EMPTY
    assert "run_behavior_snapshot" not in trace
    assert resources.behavior_snapshots == []
    assert trace.index("run_rule_check") < trace.index("cooldown_step")


@pytest.mark.parametrize(
    ("label", "deps_overrides"),
    [
        ("offline", {"health_check": lambda: False}),
        ("dead backend", {"backend": ScriptedBackend("not json at all")}),
    ],
)
def test_a_round_that_never_acted_samples_nothing(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    label: str,
    deps_overrides: dict[str, Any],
) -> None:
    """The two outcomes that deny the account its dream (§7.1) are also the
    two that Bash never reaches `:806` or `cycle-one.sh:45` from -- an offline
    probe exits in Main, and a dead backend returns 75 at `auto-run.sh:719`.
    Sampling either would file a measurement about a round that did not
    happen."""
    root = _root(tmp_path)
    resources = _resources()
    trace = _trace_calls(monkeypatch)

    _run(root, _persona(root), _deps(root, resources=resources, **deps_overrides))

    assert "run_behavior_snapshot" not in trace, label
    assert "run_rule_check" not in trace, label
    assert resources.user_posts_calls == []
    assert resources.behavior_snapshots == []


def test_a_dry_cycle_neither_samples_rules_nor_ships_a_behaviour_vector(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Standing constraint §9: stage 3 is a `--dry-run` shadow round across 23
    live accounts. `rule_check` is protected twice -- the router sends a dry
    cycle from the act phase straight to logout, AND the node guards itself --
    while `behavior_snapshot` is protected once, because the act phase does
    run and flows into it. Both are asserted here through the whole graph, so
    deleting either guard reddens this test and not only a node-level one."""
    root = _root(tmp_path)
    resources = _resources()
    embedder = DerivedEmbedder()
    trace = _trace_calls(monkeypatch)

    _run(root, _persona(root), _deps(root, resources=resources, embedder=embedder, dry_run=True))

    assert trace == ["execute_step", "finalize_step"]
    assert resources.user_posts_calls == []
    assert resources.behavior_snapshots == []
    assert resources.lab_events == []
    assert embedder.calls == []


def test_loop_two_does_not_re_sample_the_rules(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The dream retry (default OFF) routes `gate -> dream`, bypassing
    `rule_check`.

    Nothing between two attempts can change either the posts or the rules, so
    a second sample would be an exact duplicate -- and a double-counted
    adherence rate is worse than a missing one: it is wrong and it looks fine.
    This is the reason the rule check is its own node rather than a call at
    the head of the dream node.
    """
    root = _root(tmp_path)
    resources = _resources()
    trace = _trace_calls(monkeypatch)
    rejected = PERSONALITY.replace(
        "- **Follow Topics:** alpha,beta,gamma", "- **Follow Topics:** alpha"
    )
    deps = _deps(
        root,
        resources=resources,
        backend=ScriptedBackend('{"plan":[{"action":"post","text":"你好世界"}]}', rejected),
    )

    _run(root, _persona(root), deps, config=CycleConfig(max_dream_attempts=2))

    assert trace.count("dream_step") == 2, "loop 2 did not retry; the test proves nothing"
    assert trace.count("run_rule_check") == 1
    assert len(_rule_events(resources)) == 1


# ── fail-soft, through the whole graph ──────────────────────────────────────


@pytest.mark.parametrize("step", ["run_rule_check", "run_behavior_snapshot"])
def test_a_sampler_failure_leaves_the_whole_round_untouched(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, step: str
) -> None:
    """The strongest form of "fail-soft": not "the exception was caught" but
    "every other effect of the round is byte-identical".

    Run twice against two freshly seeded roots -- once clean, once with the
    named sampler raising -- and compare the outcome, the tally, the dream's
    verdict, the rewritten `personality.md`, `memory.md` and the round's
    non-analysis lab events. `cycle-one.sh:43-44` promises exactly this: *a
    missing rule, a missing api_key or a network failure must not affect
    whether this round succeeded.*
    """

    def observed(root: Path, broken: bool) -> dict[str, Any]:
        resources = _resources()
        persona = _persona(root)
        with monkeypatch.context() as patch:
            if broken:
                patch.setattr(nodes_module, step, _explode(step))
            final = _run(root, persona, _deps(root, resources=resources))
        return {
            "outcome": final.get("outcome"),
            "tally": (final.get("landed"), final.get("attempted")),
            "written": final.get("written"),
            "snapshot_ok": final.get("snapshot_ok"),
            "personality": (persona.directory / "personality.md").read_text(encoding="utf-8"),
            "memory": (persona.directory / "memory.md").read_text(encoding="utf-8"),
            "events": [
                sorted(event.to_wire().items())
                for event in resources.lab_events
                if event.type != "rule_check"
                and event.metrics.get("kind") != "cycle_run"
                and "missingSampler" not in event.metrics
            ],
            "posts": [post.text for post in resources.created_posts],
        }

    clean = observed(_root(tmp_path / "clean"), broken=False)
    with_failure = observed(_root(tmp_path / "broken"), broken=True)

    assert clean["written"] is True, "the control round must dream, or it compares nothing"
    assert with_failure == clean


# ── the settings seam ───────────────────────────────────────────────────────


def test_the_two_post_limits_carry_the_scripts_own_defaults() -> None:
    """`Settings` is where the Python runtime reads `RULE_CHECK_POST_LIMIT`
    and `BEHAVIOR_POST_LIMIT`. Pinned in BOTH directions -- against each
    module's `DEFAULT_POST_LIMIT` and against the literal 12 the two scripts
    spell -- because `config.py` sits below `analysis/` in spec §5.2's
    dependency order and therefore cannot import either constant to share it.
    """
    settings = Settings()
    assert settings.rule_check_post_limit == rule_check_module.DEFAULT_POST_LIMIT
    assert settings.behavior_post_limit == behavior_module.DEFAULT_POST_LIMIT
    assert (settings.rule_check_post_limit, settings.behavior_post_limit) == (12, 12)


# ── the cycle tail: one population-cohesion sample per round ────────────────


def test_the_cycle_tail_records_exactly_one_population_cohesion_sample(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`GET /agents/homogenization` is the early-warning signal the safety
    argument for relaxing the drift gate depends on, and on 2026-08-20 it held
    three stored points in four months -- two of them on the same day. There
    was no caller: `population-metric.sh` and `swil-agent population-metric`
    both exist, and no launchd plist, script or cycle step invoked either, so
    every one of those three rows was a human remembering.

    ONE, not two: `record_population_metric` inserts a row on every call
    (`agents.population.ts`), so a second call per cycle silently doubles the
    series' sampling rate -- which is a change to what the trend MEANS, made
    by a duplicated line.
    """
    root = _root(tmp_path)
    resources = _resources()
    trace = _trace_calls(monkeypatch)

    _run(root, _persona(root), _deps(root, resources=resources))

    assert trace.count("run_population_metric") == 1
    assert resources.calls.count("record_population_metric") == 1
    # Last of everything the round does: the reading is only complete once
    # this account's own snapshot has landed.
    assert trace[-1] == "run_population_metric"


def test_an_offline_round_records_no_population_sample_but_a_dead_backend_does(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The one discrimination this node makes, and both halves of it.

    `OFFLINE` is the `$SWIL_URL/health` probe having failed, so the POST is
    guaranteed to fail too: a roster sweep against a down platform would spend
    23 connection timeouts and print 23 WARN lines about a measurement nobody
    could have taken (standing constraint §9's "23 spurious FAIL lines per
    round" in another costume).

    `BACKEND_UNAVAILABLE` is a dead LLM with a HEALTHY platform, where the
    population reading is exactly as valid as on any other round -- and it is
    the round on which cohesion is most worth having, since nothing that
    round changed any account's vectors. Asserted as a PAIR: a node that
    skipped on any non-acting outcome would pass the first assertion alone.
    """
    offline_root = _root(tmp_path / "offline")
    offline_resources = _resources()
    offline_trace = _trace_calls(monkeypatch)
    _run(
        offline_root,
        _persona(offline_root),
        _deps(offline_root, resources=offline_resources, health_check=lambda: False),
    )
    assert "run_population_metric" not in offline_trace
    assert offline_resources.calls == []

    dead_root = _root(tmp_path / "dead")
    dead_resources = _resources()
    dead_trace = _trace_calls(monkeypatch)
    _run(
        dead_root,
        _persona(dead_root),
        _deps(
            dead_root,
            resources=dead_resources,
            backend=ScriptedBackend("not json at all"),
        ),
    )
    assert dead_trace.count("run_population_metric") == 1
    assert dead_resources.calls == ["record_population_metric"]


def test_a_dry_cycle_records_no_population_sample(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Standing constraints §5 and §9. `run_population_metric` POSTs on every
    successful path and takes no `dry_run` parameter to be inert under, and
    the tail is reached from every route including the dry one -- so this line
    in the node is the only guard, and deleting it writes 23 rows into the
    homogenization series during the round whose exit criterion is that Python
    never wrote."""
    root = _root(tmp_path)
    resources = _resources()
    trace = _trace_calls(monkeypatch)

    _run(root, _persona(root), _deps(root, resources=resources, dry_run=True))

    assert "run_population_metric" not in trace
    assert resources.calls == []


def test_a_population_sample_failure_leaves_the_round_untouched(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """Fail-soft, like its two siblings and for the same reason: this node
    carries no retry policy and no fallback edge, so an escaping exception
    aborts the LangGraph run after the account has already acted, dreamt and
    logged out -- discarding a completed round to record a number on a panel.

    The label is pinned as well as the cause: `population-metric` is what an
    operator greps for when the homogenization trend stops moving, and a WARN
    naming a different sampler sends them to the wrong panel.
    """
    root = _root(tmp_path)
    monkeypatch.setattr(nodes_module, "run_population_metric", _explode("run_population_metric"))

    with caplog.at_level(logging.WARNING, logger="swil_agent.graph.nodes"):
        final = _run(root, _persona(root), _deps(root))

    assert final.get("outcome") is ActOutcome.LANDED_ALL
    assert final.get("written") is True
    messages = [record.getMessage() for record in caplog.records]
    assert any(
        message.startswith(f"population-metric: {DIR_NAME} ")
        and "run_population_metric blew up" in message
        for message in messages
    ), messages


def test_the_population_sample_does_not_swallow_a_keyboard_interrupt(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`except Exception`, not `except BaseException` -- the same line the
    other two samplers are held to. Swallowing a `KeyboardInterrupt` here
    would carry on with the cycle while still holding both leases."""

    def interrupt(*_args: Any, **_kwargs: Any) -> Any:
        raise KeyboardInterrupt

    monkeypatch.setattr(nodes_module, "run_population_metric", interrupt)

    root = _root(tmp_path)
    with pytest.raises(KeyboardInterrupt):
        make_population_metric_node(_deps(root))({"persona": _persona(root)})


def test_the_population_sample_needs_no_api_key_because_the_route_is_global(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Unlike `rule_check` and `behavior_snapshot`, which skip an account with
    no `api_key.txt` (rule-check.sh:38 / behavior-snapshot.sh's own gate),
    this node has no such check and must not grow one.

    `POST /agents/population-metric` takes no username and any authenticated
    lab account authorises it, so `deps.resources` -- whatever `resolve_auth`
    picked, Bearer or the `SWIL_PASS` session cookie -- is already sufficient.
    A key check copied from the siblings would silently stop sampling on every
    key-less account, which is the majority of the parity fixtures.
    """
    root = _root(tmp_path)
    resources = _resources()
    trace = _trace_calls(monkeypatch)

    _run(root, _persona(root, api_key=False), _deps(root, resources=resources))

    assert trace.count("run_population_metric") == 1
    assert resources.calls.count("record_population_metric") == 1
