"""Tests for `swil_agent.dream.candidate`: the dream cooldown gate, the
group-memory digest, the exact dream prompt, and raw-LLM-output cleanup.

`_EXPECTED_EMPTY_USER` / `_EXPECTED_POPULATED_USER` are produced the same
way `test_planner.py`'s `_EXPECTED_EMPTY` / `_EXPECTED_POPULATED` are: by
calling the real renderer and capturing its output, never retyped by hand,
so the pin itself cannot be a transcription error. The renderer's byte
layout was independently cross-checked against the real `dream.sh:580-616`
heredoc rendered under real `bash` across five scenarios (empty/group-only/
echo-only/both/archive-placeholder) during implementation -- see
`render_dream_prompt`'s docstring.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from swil_agent.dream.candidate import (
    DREAM_SYSTEM_PROMPT,
    FilesystemDreamState,
    check_cooldown,
    clean_candidate,
    group_memory_digest,
    read_echo_hint,
    render_dream_prompt,
)

from ._runners import FakeState

# ── shared fixtures / helpers ───────────────────────────────────────────────


@pytest.fixture
def state() -> FakeState:
    return FakeState()


def _n(user: str, kind: str, name: str | None = None) -> dict[str, Any]:
    """One `/notifications` item, shaped like `Resources.notifications()`'s
    real payload (contract `03` §2.2: `.actor.username`, `.actor.displayName`,
    `.type`). `name` defaults to `user.capitalize()` so
    `test_digest_strips_the_trailing_separator`'s literal expected string
    ("Alpha") falls out of the default rather than needing to be spelled out
    at every call site.
    """
    return {"actor": {"username": user, "displayName": name or user.capitalize()}, "type": kind}


# ── cooldown (contract 03 §1.3) ─────────────────────────────────────────────


def test_force_mode_never_cools_down(state: FakeState) -> None:
    state.set_last_dream(minutes_ago=1, memlines=1000)
    assert check_cooldown(state, "zenith", auto=False, memory_lines=1000).proceed is True


def test_a_first_ever_dream_proceeds(state: FakeState) -> None:
    assert check_cooldown(state, "zenith", auto=True, memory_lines=0).proceed is True


def test_within_cooldown_and_too_few_new_lines_skips(state: FakeState) -> None:
    state.set_last_dream(hours_ago=1, memlines=100)
    decision = check_cooldown(state, "zenith", auto=True, memory_lines=104)
    assert decision.proceed is False
    assert "+4 new memories" in decision.reason


def test_enough_new_lines_overrides_the_cooldown(state: FakeState) -> None:
    state.set_last_dream(hours_ago=1, memlines=100)
    decision = check_cooldown(state, "zenith", auto=True, memory_lines=108)
    assert decision.proceed is True
    assert decision.override is True


def test_an_elapsed_cooldown_proceeds_regardless_of_new_lines(state: FakeState) -> None:
    state.set_last_dream(hours_ago=13, memlines=100)
    assert check_cooldown(state, "zenith", auto=True, memory_lines=100).proceed is True


def test_undated_lines_count_toward_the_override(state: FakeState) -> None:
    # Bash uses a plain `wc -l` delta; the awk that counts DATED lines is dead
    # code (contract 03 §1.3). Any appended line counts -- including the
    # "personality consolidated" housekeeping line the previous dream wrote.
    state.set_last_dream(hours_ago=1, memlines=100)
    assert check_cooldown(state, "zenith", auto=True, memory_lines=108).proceed is True


def test_hours_are_floored_not_rounded(state: FakeState) -> None:
    state.set_last_dream(hours_ago=11.9, memlines=100)
    assert check_cooldown(state, "zenith", auto=True, memory_lines=100).proceed is False


def test_the_cooldown_boundary_at_exactly_twelve_hours_proceeds(state: FakeState) -> None:
    """`hours >= cooldown_hours` must include the boundary itself -- a
    mutation to `hours > cooldown_hours` would still pass
    `test_hours_are_floored_not_rounded` (11.9h) and
    `test_an_elapsed_cooldown_proceeds_regardless_of_new_lines` (13h), since
    neither sits ON the boundary. Uses an explicit `now` computed as exactly
    `marker_ts + 12*3600` (not `hours_ago=12` through `FakeState`'s
    `time.time()` arithmetic) so the 43200-second gap is exact, not subject
    to any timing skew between `set_last_dream` and this call. `memory_lines
    == memlines` (zero new lines) rules out the override path masking a
    tightened comparison -- if `>=` regressed to `>`, `tail_lines` (0) is
    still `< min_new_memories` (8), so this can only pass via the elapsed-
    cooldown branch itself, not by accident through the override."""
    state.set_last_dream(memlines=100)
    marker_ts = state.last_dream_ts("zenith")
    assert marker_ts is not None
    decision = check_cooldown(
        state, "zenith", auto=True, memory_lines=100, now=marker_ts + 12 * 3600
    )
    assert decision.proceed is True


def test_the_skip_reason_omits_the_log_prefix(state: FakeState) -> None:
    """`CooldownDecision.reason` is the message BODY only -- no `"SKIP
    $name — "` prefix. Mutating `check_cooldown` to prepend that prefix
    itself would break this."""
    state.set_last_dream(hours_ago=1, memlines=100)
    decision = check_cooldown(state, "zenith", auto=True, memory_lines=104)
    assert not decision.reason.startswith("SKIP")


def test_a_silently_elapsed_cooldown_carries_no_reason(state: FakeState) -> None:
    """Contract 03 §1.3: an elapsed cooldown "proceeds silently (no log
    line)" -- `reason` must stay empty, not just `proceed=True`. Mutating
    `check_cooldown` to always fill in a reason string would pass every
    other test in this file but breaks this one."""
    state.set_last_dream(hours_ago=13, memlines=100)
    decision = check_cooldown(state, "zenith", auto=True, memory_lines=100)
    assert decision.reason == ""


# ── FilesystemDreamState (the real on-disk DreamState) ──────────────────────


def test_filesystem_state_has_no_marker_for_a_never_dreamed_account(tmp_path: Path) -> None:
    fs_state = FilesystemDreamState(tmp_path)
    assert fs_state.last_dream_ts("zenith") is None
    assert fs_state.last_dream_memlines("zenith") == 0


def test_record_dream_round_trips_through_check_cooldown(tmp_path: Path) -> None:
    """Proves `record_dream`'s writes and `check_cooldown`'s reads agree on
    the same two files -- a wrong key name or a swapped write order in
    either method would desync them and this end-to-end read fails."""
    fs_state = FilesystemDreamState(tmp_path)
    fs_state.record_dream("zenith", at=1000, memlines=50)
    assert fs_state.last_dream_ts("zenith") == 1000
    assert fs_state.last_dream_memlines("zenith") == 50
    decision = check_cooldown(fs_state, "zenith", auto=True, memory_lines=54, now=1000 + 3600)
    assert decision.proceed is False
    assert "+4 new memories" in decision.reason


def test_record_dream_overwrites_a_previous_marker(tmp_path: Path) -> None:
    fs_state = FilesystemDreamState(tmp_path)
    fs_state.record_dream("zenith", at=1000, memlines=50)
    fs_state.record_dream("zenith", at=2000, memlines=75)
    assert fs_state.last_dream_ts("zenith") == 2000
    assert fs_state.last_dream_memlines("zenith") == 75


def test_record_dream_only_touches_the_named_account(tmp_path: Path) -> None:
    fs_state = FilesystemDreamState(tmp_path)
    fs_state.record_dream("zenith", at=1000, memlines=50)
    assert fs_state.last_dream_ts("liushang") is None
    assert fs_state.last_dream_memlines("liushang") == 0


def test_filesystem_state_treats_a_corrupt_marker_as_absent(tmp_path: Path) -> None:
    """A marker file that exists but does not parse as an integer (disk
    corruption, a manual edit gone wrong) must degrade to "no marker" rather
    than raising -- the same fail-open posture `check_cooldown` gives a
    never-dreamed account."""
    (tmp_path / "last_dream_zenith").write_text("not-a-number", encoding="utf-8")
    (tmp_path / "last_dream_memlines_zenith").write_text("also-not-a-number", encoding="utf-8")
    fs_state = FilesystemDreamState(tmp_path)
    assert fs_state.last_dream_ts("zenith") is None
    assert fs_state.last_dream_memlines("zenith") == 0


# ── group-memory digest (contract 03 §2.2) ──────────────────────────────────


def test_digest_sorts_by_likes_plus_double_comments() -> None:
    notifications = [
        *[_n("alpha", "like")] * 5,
        *[_n("beta", "comment")] * 3,
    ]
    assert group_memory_digest(notifications).splitlines()[0].startswith("- @beta")


def test_follows_do_not_affect_the_sort_weight() -> None:
    notifications = [*[_n("alpha", "follow")] * 9, _n("beta", "like")]
    assert group_memory_digest(notifications).splitlines()[0].startswith("- @beta")


def test_reply_and_mention_count_as_comments() -> None:
    digest = group_memory_digest([_n("alpha", "reply"), _n("alpha", "mention")])
    assert "2 条回应" in digest


def test_digest_takes_at_most_five_users() -> None:
    notifications = [_n(f"user{i}", "like") for i in range(9)]
    assert len(group_memory_digest(notifications).splitlines()) == 5


def test_digest_strips_the_trailing_separator() -> None:
    assert group_memory_digest([_n("alpha", "like")]) == "- @alpha（Alpha）：1 次点赞"


def test_an_empty_notification_list_yields_an_empty_digest() -> None:
    assert group_memory_digest([]) == ""


def test_digest_skips_a_notification_with_no_usable_username() -> None:
    """A malformed item (missing/blank `actor.username`) must be dropped,
    not crash the whole digest or fall into a `"None"`/`""`-keyed group --
    the real API always populates this field, but a defensive skip here
    matches how every other resource-consuming formatter in this codebase
    (e.g. `act/context.py`'s `_author`) treats a malformed dict."""
    notifications = [{"actor": {"displayName": "Ghost"}, "type": "like"}, _n("alpha", "like")]
    digest = group_memory_digest(notifications)
    assert digest == "- @alpha（Alpha）：1 次点赞"


def test_digest_renders_a_follow_marker_alongside_likes_and_comments() -> None:
    """`follows` is excluded from the SORT weight
    (`test_follows_do_not_affect_the_sort_weight`) but still RENDERS in the
    line -- a mutation that dropped the follow clause entirely from the
    render (as opposed to just the sort) would pass that test but fail
    this one."""
    digest = group_memory_digest([_n("alpha", "follow"), _n("alpha", "like")])
    assert digest == "- @alpha（Alpha）：1 次点赞 / 关注了你"


def test_digest_orders_ties_alphabetically_by_username() -> None:
    """jq's `group_by(.user)` sorts by username before grouping, so a tie in
    the final weight sort resolves in username order -- not in the order the
    notifications happened to arrive in. Feeding "zoo" before "alpha" (arrival
    order) with an equal weight proves the tie-break is alphabetical, not
    insertion order."""
    notifications = [_n("zoo", "like"), _n("alpha", "like")]
    assert group_memory_digest(notifications).splitlines()[0].startswith("- @alpha")


# ── the dream prompt (contract 03 §2.4) ─────────────────────────────────────


def test_the_system_prompt_is_static() -> None:
    a = render_dream_prompt(persona_text="A", recent_memory="m", archive_tail="t")[0]
    b = render_dream_prompt(persona_text="B", recent_memory="n", archive_tail="u")[0]
    assert a == b


def test_the_system_prompt_is_the_module_constant() -> None:
    assert render_dream_prompt(persona_text="A", recent_memory="m", archive_tail="t")[0] == (
        DREAM_SYSTEM_PROMPT
    )


def test_the_group_memory_section_vanishes_when_empty() -> None:
    _, user = render_dream_prompt(persona_text="p", recent_memory="m", archive_tail="t")
    assert "最近与你对话过的人" not in user


def test_the_echo_hint_section_vanishes_when_empty() -> None:
    _, user = render_dream_prompt(persona_text="p", recent_memory="m", archive_tail="t")
    assert "来自上一个梦的提醒" not in user


def test_both_optional_sections_appear_when_populated() -> None:
    _, user = render_dream_prompt(
        persona_text="p",
        recent_memory="m",
        archive_tail="t",
        group_memory="- @vex（Vex）：1 次点赞",
        echo_hint="换个话题",
    )
    assert "最近与你对话过的人" in user
    assert "来自上一个梦的提醒" in user


def test_the_archive_tail_placeholder_is_used_when_there_is_no_archive() -> None:
    _, user = render_dream_prompt(persona_text="p", recent_memory="m", archive_tail="")
    assert "(尚无历史归档)" in user


def test_a_real_archive_tail_is_used_verbatim_when_present() -> None:
    """The other side of the placeholder test -- a mutation that always
    substituted the placeholder (ignoring a real, non-empty `archive_tail`)
    would pass the previous test but fail this one."""
    _, user = render_dream_prompt(
        persona_text="p", recent_memory="m", archive_tail="2026-07-01 | dream | x"
    )
    assert "2026-07-01 | dream | x" in user
    assert "(尚无历史归档)" not in user


_EXPECTED_EMPTY_USER = """# 当前的 personality.md（你的旧自我画像）

# Zenith
- **Username:** zenith
- **AI Backend:** claude

## 发帖节律
60% 概率选择 post

---

# 最近 60 条 memory（你最近真实做过的事）

2026-08-15 | post | id=aaa text=hello
2026-08-16 | like | postId=bbb

---

# 更早的 memory 末尾（归档，可参考但不必逐条回应）

(尚无历史归档)



---

请基于以上，输出新的完整 personality.md（看上去和旧的高度相似，但有少许真实漂移和一条新的"自传成长"条目）。"""

_EXPECTED_POPULATED_USER = """# 当前的 personality.md（你的旧自我画像）

# Zenith
- **Username:** zenith
- **AI Backend:** claude

## 发帖节律
60% 概率选择 post

---

# 最近 60 条 memory（你最近真实做过的事）

2026-08-15 | post | id=aaa text=hello
2026-08-16 | like | postId=bbb

---

# 更早的 memory 末尾（归档，可参考但不必逐条回应）

2026-07-01 | dream | personality consolidated


---

# 最近与你对话过的人（来自平台未读通知）

- @vex（Vex）：3 条回应 / 2 次点赞

可以让这些人/事在「自传成长」里留下一点痕迹，但不强求。


---

# 来自上一个梦的提醒

你最近 12 条帖子的话题/语气相似度过高（pairwise variance = 0.01）。下个梦在「自传成长」里写一条关于换入口、换主题、换姿态的觉悟。

---

请基于以上，输出新的完整 personality.md（看上去和旧的高度相似，但有少许真实漂移和一条新的"自传成长"条目）。"""

_GOLDEN_PERSONA = (
    "# Zenith\n- **Username:** zenith\n- **AI Backend:** claude\n\n## 发帖节律\n60% 概率选择 post"
)
_GOLDEN_MEMORY = "2026-08-15 | post | id=aaa text=hello\n2026-08-16 | like | postId=bbb"
_GOLDEN_ARCHIVE = "2026-07-01 | dream | personality consolidated"
_GOLDEN_GROUP = "- @vex（Vex）：3 条回应 / 2 次点赞"
_GOLDEN_ECHO = (
    "你最近 12 条帖子的话题/语气相似度过高（pairwise variance = 0.01）。"
    "下个梦在「自传成长」里写一条关于换入口、换主题、换姿态的觉悟。"
)


def test_render_dream_prompt_matches_bash_byte_for_byte_when_empty() -> None:
    _, user = render_dream_prompt(
        persona_text=_GOLDEN_PERSONA, recent_memory=_GOLDEN_MEMORY, archive_tail=""
    )
    assert user == _EXPECTED_EMPTY_USER


def test_render_dream_prompt_matches_bash_byte_for_byte_when_populated() -> None:
    _, user = render_dream_prompt(
        persona_text=_GOLDEN_PERSONA,
        recent_memory=_GOLDEN_MEMORY,
        archive_tail=_GOLDEN_ARCHIVE,
        group_memory=_GOLDEN_GROUP,
        echo_hint=_GOLDEN_ECHO,
    )
    assert user == _EXPECTED_POPULATED_USER


# ── candidate cleanup (contract 03 §3) ──────────────────────────────────────


def test_cleanup_strips_a_markdown_fence() -> None:
    assert clean_candidate("```markdown\n# Name\nbody\n```") == "# Name\nbody"


def test_cleanup_strips_a_bare_md_fence() -> None:
    """The real sed pipeline (`dream.sh:644`) has THREE passes, not two --
    ` ```md ` in addition to ` ```markdown ` and ` ``` `. A mutation that
    dropped this middle pattern would still pass the `markdown`-fence test
    above."""
    assert clean_candidate("```md\n# Name\nbody\n```") == "# Name\nbody"


def test_cleanup_drops_preamble_before_the_first_heading() -> None:
    assert clean_candidate("Sure, here you go:\n\n# Name\nbody").startswith("# Name")


def test_cleanup_keeps_later_hash_headings() -> None:
    assert "## 发帖节律" in clean_candidate("# Name\n## 发帖节律\n60% 概率选择 post")


def test_cleanup_of_an_empty_response_is_empty() -> None:
    assert clean_candidate("   \n\n  ") == ""


def test_cleanup_strips_a_fence_line_that_is_not_at_an_edge() -> None:
    """`dream.sh:644`'s sed is a per-line substitution, not a
    strip-only-the-first/last-line operation -- it blanks every line that
    is EXACTLY one of the three fence markers, wherever it occurs. A
    mutation that only checked the first and last lines would pass every
    test above but fail this one."""
    candidate = clean_candidate("# Name\nbefore\n```\nafter")
    assert candidate == "# Name\nbefore\n\nafter"


# ── echo hint, consuming read (contract 03 §2.1/§2.3) ───────────────────────


def test_read_echo_hint_is_empty_when_no_flag_file_exists(tmp_path: Path) -> None:
    assert read_echo_hint(tmp_path, "zenith") == ""


def test_read_echo_hint_returns_and_consumes_the_flag(tmp_path: Path) -> None:
    flag = tmp_path / "echo_flag_zenith"
    flag.write_text("换个话题\n", encoding="utf-8")
    assert read_echo_hint(tmp_path, "zenith") == "换个话题"
    assert not flag.exists()


def test_read_echo_hint_only_consumes_the_named_account(tmp_path: Path) -> None:
    (tmp_path / "echo_flag_zenith").write_text("hint", encoding="utf-8")
    assert read_echo_hint(tmp_path, "liushang") == ""
    assert (tmp_path / "echo_flag_zenith").exists()
