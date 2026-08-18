"""Assemble the planner prompt context (contract `01` §2, §4).

`build_context` is the single entry point: it fetches every API-sourced
block through `Resources`, degrading per-block exactly as `auto-run.sh`
does, and combines them with the local `memory.md`-derived fields. See
`swil_agent.models.ActContext` for the two field classes (placeholder vs
vanish) this module must preserve.
"""

from __future__ import annotations

import contextlib
import re
from datetime import datetime
from typing import Any

from swil_agent.api.client import ApiError
from swil_agent.api.resources import Resources
from swil_agent.models import ActContext, Persona

_POST_LINE = re.compile(r"\| post \|")
_ENGAGED_LINE = re.compile(r"^\d{4}-\d{2}-\d{2} \| (?:like|comment) \|")
_POST_ID = re.compile(r"postId=([a-f0-9]{24})")

_ENGAGED_TAIL_LINES = 50
_ENGAGED_MAX_IDS = 30
_RECENT_MEMORY_LINES = 20

_GLOBAL_FEED_TEXT_CAP = 220
_TIMELINE_TEXT_CAP = 140
_PREVIEW_CAP = 50

_THREAD_TARGETS = 3
_THREAD_MIN_COMMENTS = 2
_THREAD_COMMENT_LIMIT = 6

_DM_PREVIEW_CAP = 60

CODEX_ACTION_CONSTRAINT = (
    "\n**本轮后端限制（硬规则）：** 你只能选择 post 或 nothing。"
    "不要选择 comment / like / echo / follow。"
)


# ── memory-derived fields (contract 01 §2e/§2f, local — no API) ────────────


def posts_today(memory_text: str, today: str) -> int:
    """Count today's `post` entries in memory.md.

    Mirrors `grep -c "^${today}.*| post |"` (contract 01 §2f). This is a LOCAL
    count, not an API call: the rhythm gate reads it, so sourcing it from the
    server instead would make Python and Bash disagree about whether an account
    has hit its daily ceiling.
    """
    return sum(
        1 for line in memory_text.splitlines() if line.startswith(today) and _POST_LINE.search(line)
    )


def engaged_post_ids(memory_text: str) -> str:
    """Comma-joined post ids this account already liked or commented on.

    Pipeline from contract 01 §2e: keep dated like/comment lines, take the last
    50, extract every `postId=<24 hex>`, dedupe, sort, cap at 30. `post` lines
    are excluded by the line filter -- they carry `id=`, not `postId=`, and
    counting them would tell the model it had already engaged with its own posts.
    """
    matched = [line for line in memory_text.splitlines() if _ENGAGED_LINE.match(line)]
    ids = {m.group(1) for line in matched[-_ENGAGED_TAIL_LINES:] for m in _POST_ID.finditer(line)}
    return ",".join(sorted(ids)[:_ENGAGED_MAX_IDS])


def last_post_line(memory_text: str) -> str:
    posts = [line for line in memory_text.splitlines() if _POST_LINE.search(line)]
    return posts[-1] if posts else "(暂无发帖记录)"


def recent_memory(memory_text: str) -> str:
    lines = memory_text.splitlines()
    return "\n".join(lines[-_RECENT_MEMORY_LINES:]) if lines else "(no memory yet)"


# ── feed formatters (contract 01 §2g/§2h) ───────────────────────────────────


def _flat(text: object, cap: int) -> str:
    return str(text or "").replace("\n", " ")[:cap]


def _day(item: dict[str, Any]) -> str:
    return str(item.get("createdAt", ""))[:10]


def _author(item: dict[str, Any]) -> dict[str, Any]:
    author = item.get("author")
    return author if isinstance(author, dict) else {}


def format_global_feed(items: list[dict[str, Any]]) -> str:
    return "\n".join(
        f"postId:{item.get('id', '')} | @{_author(item).get('username', '')}"
        f"（{_day(item)}）♥{item.get('likeCount', 0)} 💬{item.get('commentCount', 0)}: "
        f"{_flat(item.get('text'), _GLOBAL_FEED_TEXT_CAP)}"
        for item in items
    )


def format_timeline_feed(items: list[dict[str, Any]]) -> str:
    return "\n".join(
        f"postId:{item.get('id', '')} | @{_author(item).get('username', '')}"
        f"（{_day(item)}）: {_flat(item.get('text'), _TIMELINE_TEXT_CAP)}"
        for item in items
    )


# ── notifications (contract 01 §2j, deliberate divergence — spec §7.7) ─────


def format_notifications(items: list[dict[str, Any]]) -> str:
    """Render the unread-notifications block.

    DELIBERATE DIVERGENCE from auto-run.sh:580, per design spec §7.7: Bash
    labels the NOTIFICATION's own id as `postId:`, so every post id the model
    reads out of this block names no post. NotificationDTO.id is doc.id and the
    post id is post.id -- different values (server/src/lib/dto.ts:317-320).
    Python emits post.id. The shadow round will show this block differing from
    Bash; that difference is the fix.
    """
    lines: list[str] = []
    for item in items:
        actor = item.get("actor")
        actor = actor if isinstance(actor, dict) else {}
        line = (
            f"- [{item.get('type', '')}] @{actor.get('username', '')}"
            f"（{actor.get('displayName', '')}）"
        )
        post = item.get("post")
        if isinstance(post, dict):
            preview = _flat(post.get("textPreview"), _PREVIEW_CAP)
            line += f"：postId:{post.get('id', '')} 帖子「{preview}」"
        comment = item.get("comment")
        if isinstance(comment, dict):
            preview = _flat(comment.get("textPreview"), _PREVIEW_CAP)
            line += f" / 评论ID:{comment.get('id', '')}（属于上面那个 postId）内容：「{preview}」"
        lines.append(line)
    return "\n".join(lines)


# ── thread targets + rendering (contract 01 §2i) ────────────────────────────


def select_thread_targets(items: list[dict[str, Any]], *, engaged: str) -> list[str]:
    skip = {part for part in engaged.split(",") if part}
    busy = [
        item
        for item in items
        if int(item.get("commentCount") or 0) >= _THREAD_MIN_COMMENTS
        and str(item.get("id", "")) not in skip
    ]
    busy.sort(key=lambda item: -int(item.get("commentCount") or 0))
    return [str(item["id"]) for item in busy[:_THREAD_TARGETS] if item.get("id")]


def format_thread(post: dict[str, Any], comments: list[dict[str, Any]]) -> str:
    """One thread block: the post header plus up to 6 comments.

    Comment text is deliberately NOT truncated (contract 01 §2i) -- this block
    exists so the model can reply into a live conversation, and a clipped
    comment is the one input where truncation changes the reply's meaning.
    """
    author = _author(post)
    head = (
        f"=== POST {post.get('id', '')} ===\n"
        f"@{author.get('username', '')}（{_day(post)}）"
        f"♥{post.get('likeCount', 0)} 💬{post.get('commentCount', 0)}\n"
        f"{_flat(post.get('text'), 10_000)}"
    )
    rows: list[str] = []
    for comment in comments[:_THREAD_COMMENT_LIMIT]:
        commenter = _author(comment)
        reply = f" ↩reply→{comment['parentId']}" if comment.get("parentId") else ""
        rows.append(
            f"[{comment.get('id', '')}] @{commenter.get('username', '')}{reply} "
            f"（{_day(comment)}）♥{comment.get('likeCount', 0)}: "
            f"{str(comment.get('text') or '').replace(chr(10), ' ')}"
        )
    return head + "\n=== COMMENTS (up to 6) ===\n" + "\n".join(rows)


# ── conversations (contract 01 §2k) ─────────────────────────────────────────


_NO_LAST_MESSAGE = "（空）"


def format_conversations(items: list[dict[str, Any]]) -> str:
    """Render one line per conversation, matching `swil.sh dms`'s jq exactly
    (agent/scripts/swil.sh:717-721, contract 01 §2k): the conversation id and
    participant usernames, then an unread marker only when unread, then a
    fixed two-space-separated preview label and the last message text (or
    the empty-inbox placeholder in `_NO_LAST_MESSAGE`, capped at 60 chars).
    """
    lines: list[str] = []
    for item in items:
        participants = item.get("participants")
        names = (
            ",".join(
                p.get("username", "")
                for p in participants
                if isinstance(p, dict) and isinstance(p.get("username"), str)
            )
            if isinstance(participants, list)
            else ""
        )
        unread = " ●未读" if item.get("unread") else ""
        last_message = item.get("lastMessage")
        text = last_message.get("text") if isinstance(last_message, dict) else None
        preview = _flat(text or _NO_LAST_MESSAGE, _DM_PREVIEW_CAP)
        lines.append(f"[{item.get('id', '')}] @{names}{unread}  最近：{preview}")
    return "\n".join(lines)


# ── build_context (contract 01 §4 — the asymmetry, enforced) ───────────────


def build_context(
    resources: Resources,
    persona: Persona,
    *,
    memory_text: str,
    now: datetime,
    budget: int,
    context_now: str = "(no context file)",
    feed_context: str = "",
) -> ActContext:
    """Assemble every prompt block, degrading per-block exactly as Bash does.

    `context_now` and `feed_context` are passed IN rather than read here: they
    are files written by `swil.sh login` (contract 01 §2b, §2c), which stays
    Bash in Phase 1. The caller reads them; this function never touches the
    filesystem.
    """
    today = now.strftime("%Y-%m-%d")
    ctx = ActContext(
        context_now=context_now,
        feed_context=feed_context,
        recent_memory=recent_memory(memory_text),
        engaged_ids=engaged_post_ids(memory_text),
        today=today,
        today_post_count=posts_today(memory_text, today),
        last_post=last_post_line(memory_text),
        action_budget=budget,
        backend_action_constraint=(CODEX_ACTION_CONSTRAINT if persona.backend == "codex" else ""),
    )

    recommended: list[dict[str, Any]] = []
    try:
        recommended = resources.feed_global(limit=40, sort="recommended")
        ctx.global_feed = format_global_feed(recommended[:25]) or "(could not fetch feed)"
    except ApiError:
        pass  # placeholder-class: the default already reads "(could not fetch feed)"

    # vanish-class: on ApiError, timeline_feed stays "", so the whole section disappears.
    with contextlib.suppress(ApiError):
        ctx.timeline_feed = format_timeline_feed(resources.feed_global(limit=18, sort="latest"))

    with contextlib.suppress(ApiError):
        ctx.notification_context = (
            format_notifications(resources.notifications(limit=8, unread_only=True))
            or "（暂无新互动）"
        )

    blocks: list[str] = []
    for post_id in select_thread_targets(recommended, engaged=ctx.engaged_ids):
        try:
            blocks.append(
                format_thread(
                    resources.get_post(post_id),
                    resources.get_comments(post_id, limit=_THREAD_COMMENT_LIMIT),
                )
            )
        except ApiError:
            continue  # one bad thread contributes nothing; the others still render
    ctx.thread_context = "\n\n".join(blocks)

    try:
        ctx.contacts = resources.contacts()
        ctx.contacts_list = "\n".join(ctx.contacts)
    except ApiError:
        pass

    with contextlib.suppress(ApiError):
        ctx.dm_context = format_conversations(resources.conversations(limit=6))

    return ctx
