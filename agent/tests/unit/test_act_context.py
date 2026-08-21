import random
from datetime import datetime
from pathlib import Path
from typing import Any

import pytest

from swil_agent.act.context import (
    DEFAULT_CROSS_READ_PROB,
    build_context,
    choose_read_scope,
    engaged_post_ids,
    format_conversations,
    format_global_feed,
    format_notifications,
    format_thread,
    format_timeline_feed,
    last_post_line,
    posts_today,
    read_scope,
    select_thread_targets,
)
from swil_agent.api.client import ApiError
from swil_agent.config import Settings
from swil_agent.models import GLOBAL_READ_SCOPE, ActContext, Persona

NOW = datetime(2026, 8, 17, 10, 0, 0)

MEMORY = """\
2026-08-16 | post | id=aaaaaaaaaaaaaaaaaaaaaaaa | hello
2026-08-17 | post | id=bbbbbbbbbbbbbbbbbbbbbbbb | today one
2026-08-17 | like | postId=cccccccccccccccccccccccc
2026-08-17 | comment | postId=dddddddddddddddddddddddd commentId=eeeeeeeeeeeeeeeeeeeeeeee | hi
2026-08-17 | follow | @someone
"""


def _persona(backend: str = "claude", read: str | None = None) -> Persona:
    """`read` is the `Read` bullet -- the account's assigned INPUT pool.

    It defaults to `None` (absent) because 22 of the 23 roster accounts carry
    no such bullet, so that is the state every pre-existing test in this file
    is describing. `board` is deliberately NOT set here: it is the POSTING
    target and drives nothing on the read path, and a fixture that set both
    could not tell an implementation that read the right field from one that
    read the wrong one.
    """
    return Persona(username="zenith", directory=Path("/tmp/zenith"), backend=backend, read=read)


def _rng(seed: int = 0) -> random.Random:
    """An INJECTED generator for `build_context`.

    Every pre-existing test in this file passes one because the parameter is
    required, not because the test cares: a global-scope persona (the default)
    returns from `choose_read_scope` before drawing at all, so none of them
    consume a single value from it.
    """
    return random.Random(seed)


# ── memory-derived fields (contract 01 §2e/§2f) ─────────────────────────────


def test_posts_today_counts_only_todays_post_lines() -> None:
    assert posts_today(MEMORY, "2026-08-17") == 1
    assert posts_today(MEMORY, "2026-08-16") == 1
    assert posts_today(MEMORY, "2026-08-18") == 0


def test_engaged_post_ids_takes_like_and_comment_only() -> None:
    assert engaged_post_ids(MEMORY) == "cccccccccccccccccccccccc,dddddddddddddddddddddddd"


def test_engaged_post_ids_ignores_post_and_follow_lines() -> None:
    # `post` lines carry `id=`, not `postId=`, and must never be treated as engagement.
    assert "aaaaaaaaaaaaaaaaaaaaaaaa" not in engaged_post_ids(MEMORY)
    assert "bbbbbbbbbbbbbbbbbbbbbbbb" not in engaged_post_ids(MEMORY)


def test_engaged_post_ids_is_empty_without_matches() -> None:
    assert engaged_post_ids("2026-08-17 | follow | @x\n") == ""


def test_last_post_line_returns_the_last_post_entry() -> None:
    assert last_post_line(MEMORY).endswith("today one")


def test_last_post_line_falls_back_when_there_are_no_posts() -> None:
    assert last_post_line("2026-08-17 | like | postId=x\n") == "(暂无发帖记录)"


# ── feed formatters (contract 01 §2g/§2h) ───────────────────────────────────

ITEM = {
    "id": "aaaaaaaaaaaaaaaaaaaaaaaa",
    "author": {"username": "zenith", "displayName": "玄思"},
    "createdAt": "2026-08-17T10:00:00Z",
    "likeCount": 3,
    "commentCount": 2,
    "text": "x" * 300,
}


def test_global_feed_line_shape_and_220_char_cap() -> None:
    line = format_global_feed([ITEM])
    assert line.startswith("postId:aaaaaaaaaaaaaaaaaaaaaaaa | @zenith（2026-08-17）♥3 💬2: ")
    assert line.endswith("x" * 220)
    assert "x" * 221 not in line


def test_timeline_feed_line_shape_and_140_char_cap() -> None:
    line = format_timeline_feed([ITEM])
    assert line.startswith("postId:aaaaaaaaaaaaaaaaaaaaaaaa | @zenith（2026-08-17）: ")
    assert line.count("x") == 140


def test_feed_formatters_flatten_newlines_to_spaces() -> None:
    item = {**ITEM, "text": "a\nb"}
    assert "a b" in format_global_feed([item])


# ── notifications (contract 01 §2j) ───────────────────────────────────────

NOTIFICATION = {
    "id": "notif0000000000000000000",
    "type": "comment",
    "actor": {"username": "vex", "displayName": "Vex"},
    "post": {"id": "post00000000000000000000", "textPreview": "p" * 80},
    "comment": {"id": "cmnt00000000000000000000", "textPreview": "c" * 80},
}


def test_notification_line_uses_the_post_id_not_the_notification_id() -> None:
    r"""Matches `auto-run.sh:580`'s own `\(.post.id)` -- this is parity, not a
    divergence. `NotificationDTO.id` and `.post.id` are different values
    (`server/src/lib/dto.ts:316-320`) and Bash reads the second one too."""
    line = format_notifications([NOTIFICATION])
    assert "postId:post00000000000000000000" in line
    assert "notif0000000000000000000" not in line


def test_notification_line_truncates_previews_to_50_chars() -> None:
    line = format_notifications([NOTIFICATION])
    assert "「" + "p" * 50 + "」" in line
    assert "「" + "c" * 50 + "」" in line


def test_notification_line_omits_absent_post_and_comment_blocks() -> None:
    line = format_notifications(
        [{"type": "follow", "actor": {"username": "v", "displayName": "V"}}]
    )
    assert line == "- [follow] @v（V）"


# ── thread selection (contract 01 §2i) ──────────────────────────────────────


def test_thread_targets_skips_engaged_and_takes_top_three_by_comment_count() -> None:
    items = [
        {"id": "a" * 24, "commentCount": 9},
        {"id": "b" * 24, "commentCount": 5},
        {"id": "c" * 24, "commentCount": 7},
        {"id": "d" * 24, "commentCount": 1},
        {"id": "e" * 24, "commentCount": 3},
    ]
    # engaged = "c"*24 -> c is dropped even though its commentCount (7) would
    # otherwise place it second; remaining candidates sorted desc by
    # commentCount are a(9), b(5), e(3) -- the top three of those.
    assert select_thread_targets(items, engaged="c" * 24) == ["a" * 24, "b" * 24, "e" * 24]


def test_thread_targets_requires_at_least_two_comments() -> None:
    assert select_thread_targets([{"id": "a" * 24, "commentCount": 1}], engaged="") == []


def test_thread_targets_includes_the_exact_boundary_of_two_comments() -> None:
    """Fix round 1, finding 4: `commentCount == 2` was never exercised by any
    fixture -- mutating `_THREAD_MIN_COMMENTS` from 2 to 3 left every
    existing test green. This pins the boundary itself: exactly 2 comments
    must be included (>=, not >)."""
    assert select_thread_targets([{"id": "a" * 24, "commentCount": 2}], engaged="") == ["a" * 24]


def test_format_thread_renders_post_header_as_pretty_printed_json() -> None:
    """Ruling R13 (fix round 1): `swil.sh thread` does not render a
    human-readable summary line for the post -- it pretty-prints the jq
    object verbatim (agent/scripts/swil.sh:558):
    `jq '.data.post | {id, author: .author.username, text, likeCount,
    commentCount, echoCount, createdAt}'`. `json.dumps(obj,
    ensure_ascii=False, indent=2)` was verified against a real `jq`
    invocation on an equivalent object to produce this exact byte sequence
    -- this pins that string literally, not a paraphrase of its shape."""
    post = {
        "id": "p" * 24,
        "author": {"username": "zenith"},
        "createdAt": "2026-08-17T10:00:00Z",
        "likeCount": 5,
        "commentCount": 1,
        "echoCount": 2,
        "text": "line one\nline two",
    }
    rendered = format_thread(post, [])
    expected_json = (
        "{\n"
        f'  "id": "{"p" * 24}",\n'
        '  "author": "zenith",\n'
        '  "text": "line one\\nline two",\n'
        '  "likeCount": 5,\n'
        '  "commentCount": 1,\n'
        '  "echoCount": 2,\n'
        '  "createdAt": "2026-08-17T10:00:00Z"\n'
        "}"
    )
    assert rendered == f"=== POST {'p' * 24} ===\n{expected_json}\n=== COMMENTS (up to 6) ===\n"


def test_format_thread_post_json_uses_null_for_missing_fields_like_jq_does() -> None:
    """jq's `{likeCount}` shorthand on an object missing that key evaluates
    to `null`, not `0` -- `.get()` must not silently supply a default the
    real jq pipeline never would, or the model sees a fabricated zero where
    Bash would have shown `null`."""
    post = {"id": "p" * 24}
    rendered = format_thread(post, [])
    assert '"author": null' in rendered
    assert '"text": null' in rendered
    assert '"likeCount": null' in rendered
    assert '"commentCount": null' in rendered
    assert '"echoCount": null' in rendered
    assert '"createdAt": null' in rendered


def test_format_thread_comments_section_is_untruncated() -> None:
    post = {
        "id": "p" * 24,
        "author": {"username": "zenith"},
        "createdAt": "2026-08-17T00:00:00Z",
        "likeCount": 5,
        "commentCount": 1,
        "echoCount": 0,
        "text": "the post body",
    }
    comments = [
        {
            "id": "c" * 24,
            "author": {"username": "vex"},
            "createdAt": "2026-08-17T00:00:00Z",
            "likeCount": 1,
            "text": "y" * 500,
        }
    ]
    rendered = format_thread(post, comments)
    assert "=== COMMENTS (up to 6) ===" in rendered
    assert "y" * 500 in rendered  # not truncated, unlike the feed formatters


def test_format_thread_marks_replies_with_parent_id() -> None:
    post = {"id": "p" * 24, "author": {"username": "z"}, "createdAt": "2026-08-17"}
    comments = [
        {
            "id": "c" * 24,
            "author": {"username": "vex"},
            "createdAt": "2026-08-17",
            "parentId": "r" * 24,
            "text": "a reply",
        }
    ]
    rendered = format_thread(post, comments)
    assert f"↩reply→{'r' * 24}" in rendered


# ── conversations (contract 01 §2k) ─────────────────────────────────────────


def test_format_conversations_line_shape() -> None:
    """Pinned against `swil.sh dms`'s actual jq (agent/scripts/swil.sh:717-721):
    the unread marker appears only when unread, but the preview label is
    always preceded by two spaces, not one, regardless of the marker."""
    items = [
        {
            "id": "conv1",
            "participants": [{"username": "ada"}, {"username": "bob"}],
            "unread": True,
            "lastMessage": {"text": "z" * 100},
        }
    ]
    line = format_conversations(items)
    assert line.startswith("[conv1] @ada,bob ●未读  最近：")
    assert line.endswith("z" * 60)
    assert "z" * 61 not in line


def test_format_conversations_omits_unread_marker_when_read() -> None:
    items = [{"id": "conv1", "participants": [], "unread": False, "lastMessage": {"text": "hi"}}]
    line = format_conversations(items)
    assert line == "[conv1] @  最近：hi"


def test_format_conversations_falls_back_to_placeholder_without_a_last_message() -> None:
    """`swil.sh dms` uses jq's `//` fallback to a fixed placeholder string
    (`_NO_LAST_MESSAGE`) when there is no last message at all, not an empty
    string."""
    items = [{"id": "conv1", "participants": [], "unread": False, "lastMessage": None}]
    line = format_conversations(items)
    assert line.endswith("最近：（空）")


def test_format_conversations_does_not_fall_back_on_a_real_empty_string() -> None:
    """Fix round 1, finding 4: jq's `//` only substitutes on null/false,
    never on an empty string. jq's own fallback expression leaves a literal
    empty string exactly as it is -- the preview label with nothing after
    it -- and a Python `or`-based fallback (which treats `""` as falsy)
    would wrongly render the placeholder instead."""
    items = [{"id": "conv1", "participants": [], "unread": False, "lastMessage": {"text": ""}}]
    line = format_conversations(items)
    assert line == "[conv1] @  最近："


# ── build_context degradation (contract 01 §4 — the asymmetry) ─────────────


class FakeResources:
    """Duck-types `Resources`' read surface; any method can be told to raise."""

    def __init__(self) -> None:
        self._fail: set[str] = set()
        self._fail_posts: set[str] = set()
        self.recommended: list[dict[str, Any]] = []
        self.latest: list[dict[str, Any]] = []
        self.notification_items: list[dict[str, Any]] = []
        self.contacts_result: list[str] = []
        self.conversation_items: list[dict[str, Any]] = []
        self.posts: dict[str, dict[str, Any]] = {}
        self.comments: dict[str, list[dict[str, Any]]] = {}
        # Board-scoped reads (Phase B task 3). `board_lookup` mirrors
        # `Resources.get_boards()`'s slug -> id shape; only its KEYS matter to
        # the read path, but the values are real-shaped so a test that starts
        # asserting on them does not have to re-seed the fake.
        self.board_feeds: dict[str, list[dict[str, Any]]] = {}
        self.board_lookup: dict[str, str] = {}
        self.feed_global_calls: list[tuple[int, str]] = []
        self.feed_board_calls: list[tuple[str, int, str]] = []
        self.get_boards_calls = 0

    def fail(self, name: str) -> None:
        self._fail.add(name)

    def fail_post(self, post_id: str) -> None:
        self._fail_posts.add(post_id)

    def feed_global(self, limit: int, sort: str) -> list[dict[str, Any]]:
        self.feed_global_calls.append((limit, sort))
        if f"feed_global_{sort}" in self._fail:
            raise ApiError(500, "boom", None)
        return self.recommended if sort == "recommended" else self.latest

    def feed_board(self, slug: str, limit: int = 12, sort: str = "latest") -> list[dict[str, Any]]:
        self.feed_board_calls.append((slug, limit, sort))
        if f"feed_board_{slug}" in self._fail:
            raise ApiError(500, "boom", None)
        return self.board_feeds.get(slug, [])

    def get_boards(self) -> dict[str, str]:
        self.get_boards_calls += 1
        if "get_boards" in self._fail:
            raise ApiError(500, "boom", None)
        return dict(self.board_lookup)

    def notifications(self, limit: int, unread_only: bool = True) -> list[dict[str, Any]]:
        if "notifications" in self._fail:
            raise ApiError(500, "boom", None)
        return self.notification_items

    def get_post(self, post_id: str) -> dict[str, Any]:
        if post_id in self._fail_posts:
            raise ApiError(500, "boom", None)
        return self.posts.get(post_id, {"id": post_id})

    def get_comments(self, post_id: str, limit: int = 6) -> list[dict[str, Any]]:
        if post_id in self._fail_posts:
            raise ApiError(500, "boom", None)
        return self.comments.get(post_id, [])

    def contacts(self) -> list[str]:
        if "contacts" in self._fail:
            raise ApiError(500, "boom", None)
        return self.contacts_result

    def conversations(self, limit: int = 6) -> list[dict[str, Any]]:
        if "conversations" in self._fail:
            raise ApiError(500, "boom", None)
        return self.conversation_items


@pytest.fixture
def fake_resources() -> FakeResources:
    return FakeResources()


def test_a_failed_timeline_fetch_leaves_the_field_empty(fake_resources: FakeResources) -> None:
    fake_resources.fail("feed_global_latest")
    ctx = build_context(fake_resources, _persona(), memory_text="", now=NOW, budget=5, rng=_rng())
    assert ctx.timeline_feed == ""


def test_a_failed_recommended_fetch_still_renders_a_placeholder(
    fake_resources: FakeResources,
) -> None:
    fake_resources.fail("feed_global_recommended")
    ctx = build_context(fake_resources, _persona(), memory_text="", now=NOW, budget=5, rng=_rng())
    assert ctx.global_feed == "(could not fetch feed)"


def test_a_failed_notifications_fetch_still_renders_a_placeholder(
    fake_resources: FakeResources,
) -> None:
    fake_resources.fail("notifications")
    ctx = build_context(fake_resources, _persona(), memory_text="", now=NOW, budget=5, rng=_rng())
    assert ctx.notification_context == "（暂无新互动）"


def test_a_failed_contacts_fetch_empties_both_the_text_and_the_list(
    fake_resources: FakeResources,
) -> None:
    fake_resources.fail("contacts")
    ctx = build_context(fake_resources, _persona(), memory_text="", now=NOW, budget=5, rng=_rng())
    assert ctx.contacts_list == ""
    assert ctx.contacts == []


def test_a_failed_conversations_fetch_leaves_dm_context_empty(
    fake_resources: FakeResources,
) -> None:
    """Fix round 1, finding 3: `dm_context` is the one vanish-class field that
    had no failure-path test at all -- the reviewer deleted the
    `contextlib.suppress(ApiError)` guard around its assignment in
    `build_context` and the full suite still passed, because that guard has
    no `except` line for coverage to demand and nothing exercised the
    failure path. This closes that gap; see the report's mutation proof for
    the guard-deletion reproduction."""
    fake_resources.fail("conversations")
    ctx = build_context(fake_resources, _persona(), memory_text="", now=NOW, budget=5, rng=_rng())
    assert ctx.dm_context == ""


def test_one_failing_thread_does_not_drop_the_others(fake_resources: FakeResources) -> None:
    fake_resources.recommended = [
        {
            "id": "aaaaaaaaaaaaaaaaaaaaaaaa",
            "commentCount": 5,
            "author": {"username": "a"},
            "createdAt": "2026-08-17T00:00:00Z",
            "likeCount": 1,
            "text": "post a",
        },
        {
            "id": "bbbbbbbbbbbbbbbbbbbbbbbb",
            "commentCount": 3,
            "author": {"username": "b"},
            "createdAt": "2026-08-17T00:00:00Z",
            "likeCount": 1,
            "text": "post b",
        },
    ]
    fake_resources.fail_post("bbbbbbbbbbbbbbbbbbbbbbbb")
    ctx = build_context(fake_resources, _persona(), memory_text="", now=NOW, budget=5, rng=_rng())
    assert "aaaaaaaaaaaaaaaaaaaaaaaa" in ctx.thread_context
    assert "bbbbbbbbbbbbbbbbbbbbbbbb" not in ctx.thread_context


# The tests above prove failure degrades correctly, but a `timeline_feed == ""`
# assertion is also what an implementation that never sets the field at all
# would produce -- vacuously. This test proves the success path is real: it
# is the same fixture family with nothing failed, and every block that the
# tests above show *vanishing* or *falling back* on failure is asserted to
# carry real, distinguishable content when the underlying call succeeds. If
# `build_context` stopped assigning to (say) `ctx.timeline_feed` entirely,
# this test would fail (empty string) even though every degradation test
# above would still pass.
def test_build_context_populates_every_block_on_success(fake_resources: FakeResources) -> None:
    fake_resources.recommended = [
        {
            "id": "aaaaaaaaaaaaaaaaaaaaaaaa",
            "commentCount": 5,
            "author": {"username": "a"},
            "createdAt": "2026-08-17T00:00:00Z",
            "likeCount": 1,
            "text": "recommended post",
        }
    ]
    fake_resources.latest = [
        {
            "id": "llllllllllllllllllllllll",
            "author": {"username": "l"},
            "createdAt": "2026-08-17T00:00:00Z",
            "text": "latest post",
        }
    ]
    fake_resources.notification_items = [
        {
            "type": "like",
            "actor": {"username": "v", "displayName": "V"},
            "post": {"id": "pppppppppppppppppppppppp", "textPreview": "hi"},
        }
    ]
    fake_resources.contacts_result = ["bob", "carl"]
    fake_resources.conversation_items = [
        {
            "id": "conv1",
            "participants": [{"username": "bob"}],
            "unread": True,
            "lastMessage": {"text": "hey"},
        }
    ]

    ctx = build_context(fake_resources, _persona(), memory_text="", now=NOW, budget=5, rng=_rng())
    assert "recommended post" in ctx.global_feed
    assert "latest post" in ctx.timeline_feed
    assert "pppppppppppppppppppppppp" in ctx.notification_context
    assert "aaaaaaaaaaaaaaaaaaaaaaaa" in ctx.thread_context
    assert ctx.contacts == ["bob", "carl"]
    assert ctx.contacts_list == "bob\ncarl"
    assert "hey" in ctx.dm_context


def test_build_context_passes_through_context_now_and_feed_context(
    fake_resources: FakeResources,
) -> None:
    """`context_now`/`feed_context` are RENDERED by the caller (`cli.py`, via
    `render_now_context` / `render_follow_topics_feed`); this function must
    pass them through untouched rather than re-deriving or dropping them.

    They were files `swil.sh login` wrote until 2026-08-20, when the runtime
    stopped reading a `now.md` nothing had refreshed since the Stage-5
    cutover. The seam this test pins is the same either way."""
    ctx = build_context(
        fake_resources,
        _persona(),
        memory_text="",
        now=NOW,
        budget=5,
        rng=_rng(),
        context_now="今日上下文",
        feed_context="关注话题动态",
    )
    assert ctx.context_now == "今日上下文"
    assert ctx.feed_context == "关注话题动态"


def test_build_context_derives_rhythm_fields_from_memory(fake_resources: FakeResources) -> None:
    ctx = build_context(
        fake_resources, _persona(), memory_text=MEMORY, now=NOW, budget=5, rng=_rng()
    )
    assert ctx.today == "2026-08-17"
    assert ctx.today_post_count == 1
    assert ctx.last_post.endswith("today one")
    assert ctx.engaged_ids == "cccccccccccccccccccccccc,dddddddddddddddddddddddd"
    assert ctx.action_budget == 5


def test_build_context_leaves_backend_action_constraint_empty_for_every_backend(
    fake_resources: FakeResources,
) -> None:
    """Loop-engine spec §7: the Codex post-only prompt is gone. Write-verification
    is the real fix; `ActContext.backend_action_constraint` is always `""`.
    """
    for backend in ("codex", "claude", "deepseek"):
        ctx = build_context(
            fake_resources, _persona(backend), memory_text="", now=NOW, budget=5, rng=_rng()
        )
        assert ctx.backend_action_constraint == ""


# ── read scope + cross-reads (Phase B task 3, spec §8.3) ──────────────────
#
# The roster ships with 22 of 23 accounts carrying NO `Read` bullet, so this
# whole mechanism is a strict no-op in production until an operator assigns
# the niches. Every test below that exercises the niche path therefore has to
# MANUFACTURE one in its fixture -- which is the point: the code half must be
# tested and reviewable before the data half is proposed.

HOME = "living"
OTHER_BOARDS = ("ai-governance", "life-science", "making", "market", "perception")

# `random.Random(1).random()` is 0.1344 and `random.Random(0).random()` is
# 0.8444, so at the SHIPPING probability of 0.15 seed 1 crosses and seed 0
# does not. Both are pinned by `test_the_two_branch_seeds_are_what_this_file
# _claims` below, because a test that "forces the branch" with a seed nobody
# checked is a test that silently stops forcing it.
CROSS_SEED = 1
HOME_SEED = 0


class _RecordingRandom(random.Random):
    """A `random.Random` that counts what was drawn from IT.

    Determinism assertions cannot tell an injected generator from a
    module-level `random.random()` with certainty -- they only make the
    coincidence unlikely. This makes it observable: a code path that reaches
    for the module-level generator leaves `draws` at zero.
    """

    def __init__(self, seed: int) -> None:
        super().__init__(seed)
        self.draws = 0
        self.choices = 0

    def random(self) -> float:
        self.draws += 1
        return super().random()

    def choice(self, seq):  # type: ignore[no-untyped-def, override]
        self.choices += 1
        return super().choice(seq)


def _boarded(fake: FakeResources, *, home_items: int = 3) -> FakeResources:
    """Seed a fake with every board the production roster uses.

    `home_items` posts on the home board and one on each other board, so the
    board a round actually read is visible in `ctx.board_items` as well as in
    `feed_board_calls` -- two independent witnesses of the same fact.
    """
    fake.board_lookup = {slug: f"id-{slug}" for slug in (HOME, *OTHER_BOARDS)}
    fake.board_feeds[HOME] = [{"id": f"{i:024d}", "text": f"home {i}"} for i in range(home_items)]
    for slug in OTHER_BOARDS:
        fake.board_feeds[slug] = [{"id": "b" * 24, "text": f"from {slug}"}]
    return fake


def test_the_two_branch_seeds_are_what_this_file_claims() -> None:
    """`CROSS_SEED` / `HOME_SEED` are load-bearing constants of the tests
    below, and if Python's Mersenne Twister stream ever changed under them
    they would keep passing while testing the opposite branch."""
    assert random.Random(CROSS_SEED).random() < DEFAULT_CROSS_READ_PROB
    assert random.Random(HOME_SEED).random() >= DEFAULT_CROSS_READ_PROB


# ── read_scope: WHICH bullet drives the read ──────────────────────────────


def test_the_read_scope_comes_from_the_read_bullet_not_the_board_bullet() -> None:
    """`Board` is the POSTING target and every account has one; `Read` is the
    reading scope and one account has one. An implementation that read
    `Board` here would put all 23 accounts on board feeds in a single round,
    with no operator decision anywhere -- and would still pass any test whose
    fixture set the two fields to the same value."""
    posts_to_market = Persona(
        username="zenith", directory=Path("/tmp/zenith"), board="market", read=None
    )
    assert read_scope(posts_to_market) == GLOBAL_READ_SCOPE

    reads_living = Persona(
        username="zenith", directory=Path("/tmp/zenith"), board="market", read="living"
    )
    assert read_scope(reads_living) == "living"


@pytest.mark.parametrize("raw", [None, "", "   ", "global", "Global", " GLOBAL "])
def test_absent_blank_and_global_all_mean_the_widest_input(raw: str | None) -> None:
    """Absent is the state 22 of 23 accounts are in, and it must mean exactly
    what `Read: global` means -- otherwise adding the bullet to the one
    account that has it would have changed that account's behaviour."""
    assert read_scope(_persona(read=raw)) == GLOBAL_READ_SCOPE


def test_a_slug_is_passed_through_verbatim_rather_than_normalised() -> None:
    """`Read` is a round-trip-validated experiment control field
    (`persona/validators.py`); silently case-folding it would make the value
    the runtime acts on different from the one the operator wrote and the
    validator compares."""
    assert read_scope(_persona(read="  Life-Science  ")) == "Life-Science"


# ── choose_read_scope: the roll ───────────────────────────────────────────


def test_a_cross_read_round_is_recorded_as_such(fake_resources: FakeResources) -> None:
    """Seed the RNG to force the branch; assert the board read is recorded and
    differs from the persona's home board.

    Asserted on EFFECTS as well as on the recorded fields (standing constraint
    §4): `feed_board_calls` shows both passes went to the cross board and none
    went to `living`, so an implementation that recorded a cross-read and then
    read its home board anyway is caught here rather than shipping a series
    that describes reads that never happened.

    The generator is a `_RecordingRandom` so that "`build_context` built its
    own `random.Random` instead of forwarding the injected one" is killed
    DETERMINISTICALLY. Without the draw count, a fresh generator would still
    cross-read 15% of the time and this test would merely be flaky against
    that mutation rather than fatal to it.
    """
    _boarded(fake_resources)
    rng = _RecordingRandom(CROSS_SEED)
    ctx = build_context(
        fake_resources,
        _persona(read=HOME),
        memory_text="",
        now=NOW,
        budget=5,
        rng=rng,
    )

    assert rng.draws >= 1
    assert ctx.cross_read is True
    assert ctx.board_read != HOME
    assert ctx.board_read in OTHER_BOARDS
    # The niche the round LEFT is carried separately, because `board_read` on
    # a cross-read names the away board and the home one is otherwise
    # recoverable only from `personality.md` as it stood that day.
    assert ctx.home_board == HOME
    assert [slug for slug, _, _ in fake_resources.feed_board_calls] == [ctx.board_read] * 2
    assert fake_resources.feed_global_calls == []
    assert f"from {ctx.board_read}" in ctx.global_feed


def test_the_roll_uses_the_injected_rng(fake_resources: FakeResources) -> None:
    """Two runs with the same seed take the same branch. A module-level
    random.random() passes any single-run assertion and is untestable.

    Determinism is asserted over a SEQUENCE of seeds at p=0.5, where both
    branches genuinely occur: a single seed compared against itself would
    also pass for a module-level generator whenever its two coin flips
    happened to agree. Twenty-four seeds make that coincidence ~2^-24.

    And it is asserted a second, non-probabilistic way: `_RecordingRandom`
    counts the draws taken from the generator that was passed IN, and a code
    path reaching for `random.random()` leaves that count at zero while every
    equality below can still pass by luck.
    """
    _boarded(fake_resources)
    persona = _persona(read=HOME)
    seeds = range(24)

    def run(seed: int) -> tuple[str, bool]:
        got = choose_read_scope(fake_resources, persona, random.Random(seed), cross_read_prob=0.5)
        return got.scope, got.cross

    first = [run(s) for s in seeds]
    assert first == [run(s) for s in seeds]
    # Non-degenerate: if every seed took the same branch, the equality above
    # would hold for a constant and prove nothing.
    assert {cross for _, cross in first} == {True, False}

    # The home branch is the exact pin: one draw, no pick.
    stays = _RecordingRandom(HOME_SEED)
    assert choose_read_scope(fake_resources, persona, stays, cross_read_prob=0.5).cross is False
    assert (stays.draws, stays.choices) == (1, 0)

    # The cross branch pins the PICK exactly and the draws only as ">= 1":
    # overriding `random()` on a `random.Random` subclass makes CPython route
    # `_randbelow` through `random()` instead of `getrandbits`
    # (`Random.__init_subclass__`), so `choice` adds draws of its own. That is
    # this fixture's artefact, not the code's, and pinning it would pin CPython
    # internals.
    crosses = _RecordingRandom(CROSS_SEED)
    result = choose_read_scope(fake_resources, persona, crosses, cross_read_prob=0.5)
    assert result.cross is True
    assert crosses.choices == 1
    assert crosses.draws >= 1


def test_cross_read_prob_zero_never_leaves_the_home_board(
    fake_resources: FakeResources,
) -> None:
    """The off switch has to actually be off -- this is the revert path."""
    _boarded(fake_resources)
    persona = _persona(read=HOME)

    results = [
        choose_read_scope(fake_resources, persona, random.Random(seed), cross_read_prob=0.0)
        for seed in range(50)
    ]

    assert {(r.scope, r.cross) for r in results} == {(HOME, False)}
    # And it costs nothing: an off switch that still asked the API which
    # boards exist would be off in behaviour but not in cost or in the logs.
    assert fake_resources.get_boards_calls == 0


def test_cross_read_prob_one_always_leaves_the_home_board(
    fake_resources: FakeResources,
) -> None:
    """The opposite end of the same guard. Without it, an implementation that
    ignored `cross_read_prob` entirely and never crossed would satisfy the
    zero test above."""
    _boarded(fake_resources)
    persona = _persona(read=HOME)

    results = [
        choose_read_scope(fake_resources, persona, random.Random(seed), cross_read_prob=1.0)
        for seed in range(50)
    ]

    assert {r.cross for r in results} == {True}
    assert HOME not in {r.scope for r in results}
    assert {r.scope for r in results} <= set(OTHER_BOARDS)


def test_a_global_account_draws_no_randomness_at_all(fake_resources: FakeResources) -> None:
    """The global early return sits ABOVE the roll, and that ordering is a
    contract, not a micro-optimisation: `rng` is shared with `decide_rhythm`
    one step later, so a wasted draw here would shift every global account's
    rhythm decision for a seed the day a single account gains a `Read`
    bullet."""
    _boarded(fake_resources)
    recording = _RecordingRandom(CROSS_SEED)

    got = choose_read_scope(fake_resources, _persona(), recording, cross_read_prob=1.0)

    assert got == (GLOBAL_READ_SCOPE, GLOBAL_READ_SCOPE, False)
    assert (recording.draws, recording.choices) == (0, 0)
    assert fake_resources.get_boards_calls == 0


def test_the_boards_endpoint_is_only_asked_on_a_firing_roll(
    fake_resources: FakeResources,
) -> None:
    """A home round is one feed read and nothing else."""
    _boarded(fake_resources)
    persona = _persona(read=HOME)

    choose_read_scope(fake_resources, persona, random.Random(HOME_SEED))
    assert fake_resources.get_boards_calls == 0

    choose_read_scope(fake_resources, persona, random.Random(CROSS_SEED))
    assert fake_resources.get_boards_calls == 1


def test_a_boards_outage_keeps_the_account_on_its_home_board(
    fake_resources: FakeResources,
) -> None:
    """Fail-open TO THE NICHE, never to global. Falling back to `global` would
    silently move the account into the widest-input arm of the experiment --
    the one condition an operator did not assign it to -- because a lookup
    endpoint was briefly down."""
    _boarded(fake_resources)
    fake_resources.fail("get_boards")

    got = choose_read_scope(fake_resources, _persona(read=HOME), random.Random(CROSS_SEED))

    assert got == (HOME, HOME, False)


def test_a_roster_with_only_the_home_board_cannot_cross_read(
    fake_resources: FakeResources,
) -> None:
    """`rng.choice([])` raises `IndexError`; there is nowhere else to go."""
    fake_resources.board_lookup = {HOME: "id-living"}

    got = choose_read_scope(fake_resources, _persona(read=HOME), random.Random(CROSS_SEED))

    assert got == (HOME, HOME, False)


def test_the_cross_read_pick_does_not_depend_on_board_insertion_order(
    fake_resources: FakeResources,
) -> None:
    """`get_boards()` builds its dict from a JSON array off the network, so
    dict order is response order. Sorting the candidates is what makes one
    seed reproduce one board across processes and across a server that
    reorders its `/boards` payload."""
    persona = _persona(read=HOME)
    fake_resources.board_lookup = {slug: f"id-{slug}" for slug in (HOME, *OTHER_BOARDS)}
    forward = choose_read_scope(fake_resources, persona, random.Random(CROSS_SEED))

    reversed_fake = FakeResources()
    reversed_fake.board_lookup = {slug: f"id-{slug}" for slug in reversed((HOME, *OTHER_BOARDS))}
    backward = choose_read_scope(reversed_fake, persona, random.Random(CROSS_SEED))

    assert forward.scope == backward.scope


# ── build_context: which feed the round actually reads ────────────────────


def test_an_account_with_no_read_bullet_reads_globally_exactly_as_before(
    fake_resources: FakeResources,
) -> None:
    """The no-op guarantee for 22 of 23 accounts, asserted at the wire: the
    same two `feed_global` passes, in the same order, with the same limits and
    sorts, and no board call of any kind."""
    _boarded(fake_resources)

    ctx = build_context(
        fake_resources, _persona(), memory_text="", now=NOW, budget=5, rng=_rng(CROSS_SEED)
    )

    assert fake_resources.feed_global_calls == [(40, "recommended"), (18, "latest")]
    assert fake_resources.feed_board_calls == []
    assert (ctx.board_read, ctx.home_board, ctx.cross_read) == (
        GLOBAL_READ_SCOPE,
        GLOBAL_READ_SCOPE,
        False,
    )


def test_a_niche_account_reads_its_board_on_both_passes(
    fake_resources: FakeResources,
) -> None:
    """Both passes, not just the breadth one. Leaving the depth pass on
    `/feed/global` would keep every niche account reading the shared latest
    slice, which is the input loop this task exists to break -- and the
    breadth-only version passes any test that only inspects `global_feed`."""
    _boarded(fake_resources)

    ctx = build_context(
        fake_resources,
        _persona(read=HOME),
        memory_text="",
        now=NOW,
        budget=5,
        rng=_rng(HOME_SEED),
    )

    assert fake_resources.feed_board_calls == [
        (HOME, 40, "recommended"),
        (HOME, 18, "latest"),
    ]
    assert fake_resources.feed_global_calls == []
    assert (ctx.board_read, ctx.home_board, ctx.cross_read) == (HOME, HOME, False)
    assert "home 0" in ctx.global_feed
    assert "home 0" in ctx.timeline_feed


def test_board_items_counts_the_breadth_pass_of_the_board_that_was_read(
    fake_resources: FakeResources,
) -> None:
    _boarded(fake_resources, home_items=3)

    ctx = build_context(
        fake_resources,
        _persona(read=HOME),
        memory_text="",
        now=NOW,
        budget=5,
        rng=_rng(HOME_SEED),
    )

    assert ctx.board_items == 3


def test_board_items_tells_an_empty_board_apart_from_a_failed_read(
    fake_resources: FakeResources,
) -> None:
    """`making` carried 4 posts roster-wide at the last count, so a niched
    account reading nothing is a real, expected state -- and the starvation
    risk this number exists to make visible. `0` is that state; `None` is an
    outage. Collapsing them would hide a starving account inside the noise of
    a flaky endpoint."""
    fake_resources.board_lookup = {HOME: "id-living"}
    fake_resources.board_feeds[HOME] = []
    empty = build_context(
        fake_resources,
        _persona(read=HOME),
        memory_text="",
        now=NOW,
        budget=5,
        rng=_rng(HOME_SEED),
    )
    assert empty.board_items == 0
    assert empty.global_feed == "(could not fetch feed)"

    broken = FakeResources()
    broken.board_lookup = {HOME: "id-living"}
    broken.fail(f"feed_board_{HOME}")
    failed = build_context(
        broken, _persona(read=HOME), memory_text="", now=NOW, budget=5, rng=_rng(HOME_SEED)
    )
    assert failed.board_items is None
    assert failed.global_feed == "(could not fetch feed)"
    assert failed.timeline_feed == ""
    assert failed.board_read == HOME


def test_the_cross_read_probability_reaches_the_roll_from_build_context(
    fake_resources: FakeResources,
) -> None:
    """`build_context` must PASS its `cross_read_prob` on, not drop it and let
    `choose_read_scope`'s own default apply. `HOME_SEED` draws 0.8444, which
    is above the 0.15 default and below 1.0, so the two spellings disagree
    here -- with the default forwarded silently the account would stay home."""
    _boarded(fake_resources)

    ctx = build_context(
        fake_resources,
        _persona(read=HOME),
        memory_text="",
        now=NOW,
        budget=5,
        rng=_rng(HOME_SEED),
        cross_read_prob=1.0,
    )

    assert ctx.cross_read is True
    assert ctx.board_read != HOME


def test_settings_cross_read_prob_matches_the_module_default() -> None:
    """Pinned in both directions, like `act_similarity_window`: `act/` cannot
    import `config`, so the shared number is spelled twice and only a test
    keeps the two spellings from drifting."""
    assert Settings().cross_read_prob == DEFAULT_CROSS_READ_PROB
    assert DEFAULT_CROSS_READ_PROB == 0.15
    assert Settings(cross_read_prob=0.4).cross_read_prob == 0.4


@pytest.mark.parametrize("bad", [-0.01, 1.5, 15.0])
def test_an_out_of_range_cross_read_prob_is_rejected_at_load(bad: float) -> None:
    """`CROSS_READ_PROB=15` (meaning "15%") would make every round a
    cross-read and `-1` would make none, both silently, since the value is
    read straight into a `rng.random() < prob` comparison."""
    with pytest.raises(ValueError, match="cross_read_prob"):
        Settings(cross_read_prob=bad)


def test_zero_and_one_stay_legal_cross_read_probs() -> None:
    """`0` is the documented off switch and the revert path."""
    assert Settings(cross_read_prob=0.0).cross_read_prob == 0.0
    assert Settings(cross_read_prob=1.0).cross_read_prob == 1.0


def test_a_bare_act_context_reads_as_global_rather_than_blank() -> None:
    """`ActContext` is also constructed outside `build_context` -- graph state
    carries one across a checkpoint restore. Its default must be the same
    "widest input" sentinel the read path uses, not `""`, which is a scope no
    account is ever assigned and which no consumer would recognise."""
    assert ActContext().board_read == GLOBAL_READ_SCOPE
    assert ActContext().home_board == GLOBAL_READ_SCOPE
    assert ActContext().cross_read is False
    assert ActContext().board_items is None
