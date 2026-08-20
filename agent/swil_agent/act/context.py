"""Assemble the planner prompt context (contract `01` §2, §4).

`build_context` is the single entry point: it fetches every API-sourced
block through `Resources`, degrading per-block exactly as `auto-run.sh`
does, and combines them with the local `memory.md`-derived fields. See
`swil_agent.models.ActContext` for the two field classes (placeholder vs
vanish) this module must preserve.
"""

from __future__ import annotations

import contextlib
import json
import random
import re
from datetime import datetime
from typing import Any, Final, NamedTuple

from swil_agent.api.client import ApiError
from swil_agent.api.resources import Resources
from swil_agent.models import GLOBAL_READ_SCOPE, ActContext, Persona

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


# ── notifications (contract 01 §2j) ────────────────────────────────────────


def format_notifications(items: list[dict[str, Any]]) -> str:
    """Render the unread-notifications block -- byte-for-byte
    `auto-run.sh:576-582`'s jq.

    There is NO divergence here. An earlier version of this docstring
    predicted one -- "Bash labels the NOTIFICATION's own id as `postId:`" --
    and design spec §7.7 has since RETRACTED exactly that claim: the jq at
    auto-run.sh:580 interpolates `.post.id` after its `postId:` label, the
    POST's id, which is what this function emits. `NotificationDTO.id` and
    `NotificationDTO.post.id` are indeed different values
    (`server/src/lib/dto.ts:316-320`), but Bash never reads the first one
    here. The prediction is dropped rather than left in place: a comment
    documenting a bug that does not exist sends the next reader looking for
    it, and a shadow round comparing these two blocks will find them
    identical.
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


def _post_json(post: dict[str, Any]) -> str:
    """Pretty-print the post exactly as `swil.sh thread`'s jq does
    (agent/scripts/swil.sh:558): `jq '.data.post | {id, author:
    .author.username, text, likeCount, commentCount, echoCount,
    createdAt}'`. Verified against a real `jq` invocation:
    `json.dumps(obj, ensure_ascii=False, indent=2)` produces the identical
    byte sequence for this exact key set and order (2-space indent, no
    trailing item separator space, unescaped non-ASCII).

    Every value is `.get(key)` with NO default -- jq's shorthand
    `{likeCount}` evaluates to `null` when the source object lacks that key,
    not `0` or `""`; supplying a Python-side default would fabricate a value
    the real Bash pipeline never shows the model.
    """
    obj = {
        "id": post.get("id"),
        "author": _author(post).get("username"),
        "text": post.get("text"),
        "likeCount": post.get("likeCount"),
        "commentCount": post.get("commentCount"),
        "echoCount": post.get("echoCount"),
        "createdAt": post.get("createdAt"),
    }
    return json.dumps(obj, ensure_ascii=False, indent=2)


def format_thread(post: dict[str, Any], comments: list[dict[str, Any]]) -> str:
    """One thread block: the post header plus up to 6 comments.

    The post itself is rendered as `swil.sh thread` actually renders it --
    the pretty-printed jq object, not a human-readable summary line (Ruling
    R13, fix round 1: the original port here invented a readable line the
    real script never produces; see `_post_json`). Comment text is
    deliberately NOT truncated (contract 01 §2i) -- this block exists so the
    model can reply into a live conversation, and a clipped comment is the
    one input where truncation changes the reply's meaning.
    """
    head = f"=== POST {post.get('id', '')} ===\n{_post_json(post)}"
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
        # jq's `//` only substitutes on null/false, never on "" -- an `or`
        # here would wrongly swallow a real empty-string message.
        preview = _flat(text if text is not None else _NO_LAST_MESSAGE, _DM_PREVIEW_CAP)
        lines.append(f"[{item.get('id', '')}] @{names}{unread}  最近：{preview}")
    return "\n".join(lines)


# ── read scope + cross-reads (Phase B task 3, spec §8.3) ──────────────────

DEFAULT_CROSS_READ_PROB: Final = 0.15
"""Probability that one round reads a board OUTSIDE the account's niche.

`Settings.cross_read_prob` (`CROSS_READ_PROB`) is the operator-facing name and
carries this same number as a literal -- `act/` sits above `config` in spec
§5.2's dependency order, so this module cannot import it and
`test_act_context.py` pins the two equal in both directions instead, the way
`act_similarity_window` is pinned.

Niches without cross-reads are 23 smaller monocultures, which is the failure
mode the diversification is meant to avoid, not a milder version of it.
"""


def read_scope(persona: Persona) -> str:
    """The input pool this account is assigned to: a board slug, or
    `GLOBAL_READ_SCOPE`.

    THE `Read` BULLET, NOT `Board`. The two are different fields with
    different jobs and conflating them is the easiest mistake here to make:
    `Board` is the account's POSTING target (`Persona.board` ->
    `_resolve_board_id` -> `create_post`'s `boardId`, `api/resources.py:341`)
    and every one of the 23 accounts carries one, while `Read` is its READING
    scope and exactly one account carries one today. Driving reads off
    `Board` would silently switch all 23 accounts onto board feeds in one
    round, with no operator decision anywhere and no way to run the control
    arm the experiment needs.

    `persona/validators.py` already treats `Read` as a round-trip-validated
    experiment control field for this exact reason, and says so: losing it
    "turns the widest-input arm into an ordinary board reader with nothing in
    any log to say so."

    ABSENT means global, and that is a deliberate default rather than an
    unhandled case: an account with no declared niche has no niche to leave,
    so it reads what it reads today and no cross-read can fire for it. The
    roster ships with 22 of 23 accounts in exactly that state, which makes
    this whole mechanism a strict no-op until an operator assigns the niches.

    The value is stripped but NOT otherwise normalised -- `loader.get_field`
    preserves an experiment control field verbatim on purpose, and a slug
    this function silently case-folded would be a value no operator wrote.
    A mistyped slug therefore reaches the API as written and 404s into the
    ordinary degraded-feed path, where the lab event's `boardRead` names it.
    Only the literal `global` sentinel is matched case-insensitively, since
    it is a keyword rather than a slug.
    """
    raw = (persona.read or "").strip()
    if not raw or raw.casefold() == GLOBAL_READ_SCOPE:
        return GLOBAL_READ_SCOPE
    return raw


class BoardRead(NamedTuple):
    """Which pool one round read, and whether that left the account's niche.

    `home` is carried alongside `scope` rather than recomputed by callers
    because `cross` is a statement about the PAIR: `scope == "market"` says
    nothing on its own about whether market is where this account lives.
    """

    scope: str
    home: str
    cross: bool


def choose_read_scope(
    resources: Resources,
    persona: Persona,
    rng: random.Random,
    *,
    cross_read_prob: float = DEFAULT_CROSS_READ_PROB,
) -> BoardRead:
    """Roll this round's read scope for `persona`.

    The roll uses the INJECTED `rng` -- the same `random.Random` the rhythm
    gate already takes, threaded from `run_act`/`CycleDeps` and seeded by
    `swil-agent act --seed`. A module-level `random.random()` here would pass
    every single-run assertion anyone could write and make the branch
    untestable and unreproducible, which is the whole reason this parameter
    is positional and required rather than defaulted.

    Order of the two guards matters. A global-scope account returns BEFORE
    the roll, so it consumes no randomness at all: an account with no niche
    has no niche to leave, and a wasted `rng.random()` would also desync the
    rhythm gate's draw for every account on the roster the moment a `Read`
    bullet is added to one of them.

    `get_boards()` is called ONLY on a firing roll -- ~15% of the rounds of
    the accounts that have a niche -- so the common path stays exactly one
    feed read. It fails OPEN, to the home board: a boards-endpoint outage
    must not change which pool an account reads, and certainly must not
    silently promote it to `global`, which is the widest-input arm of the
    experiment and a condition no operator assigned it to.

    Candidates are `sorted()`, not raw dict order, so a given seed picks the
    same board across processes; `dict` preserves insertion order and the
    insertion order here is a JSON array from the network.
    """
    home = read_scope(persona)
    if home == GLOBAL_READ_SCOPE:
        return BoardRead(scope=home, home=home, cross=False)
    if rng.random() >= cross_read_prob:
        return BoardRead(scope=home, home=home, cross=False)

    try:
        slugs = sorted(slug for slug in resources.get_boards() if slug != home)
    except ApiError:
        return BoardRead(scope=home, home=home, cross=False)
    if not slugs:
        return BoardRead(scope=home, home=home, cross=False)
    return BoardRead(scope=rng.choice(slugs), home=home, cross=True)


def read_feed(resources: Resources, scope: str, *, limit: int, sort: str) -> list[dict[str, Any]]:
    """One feed read, routed by scope.

    `GLOBAL_READ_SCOPE` keeps `feed_global` -- byte-for-byte the call the act
    path has always made -- so an account with no niche is unaffected by this
    whole mechanism.

    A board scope goes to `/feed/board/{slug}`, whose own server-side
    docstring already names this task's problem: "This is what agent context
    reads instead of the shared `/feed/global` slice that produced feed-wide
    topic monoculture" (`server/src/modules/feed/feed.service.ts:132-134`).

    `sort` is forwarded for both scopes even though the board route IGNORES
    it. `pagingQuery` accepts `sort` (`feed.routes.ts:18`) so it validates,
    but `/board/:slug`'s handler passes it to nothing -- `feed.byBoard` is
    unconditionally `paginateByScore` (`feed.routes.ts:79-91`,
    `feed.service.ts:135-148`). Consequence, which is real and is recorded as
    part of this task's change point: under a board scope the depth pass
    (`limit=18, sort=latest`) returns a PREFIX of the breadth pass
    (`limit=40, sort=recommended`) rather than a differently-ordered slice,
    so a niche account's prompt carries less distinct feed than a global
    account's. It is forwarded anyway so that the day the board route honours
    `sort`, both runtimes get the intended slice without a second edit.
    """
    if scope == GLOBAL_READ_SCOPE:
        return resources.feed_global(limit=limit, sort=sort)
    return resources.feed_board(scope, limit=limit, sort=sort)


# ── build_context (contract 01 §4 — the asymmetry, enforced) ───────────────


def build_context(
    resources: Resources,
    persona: Persona,
    *,
    memory_text: str,
    now: datetime,
    budget: int,
    rng: random.Random,
    context_now: str = "(no context file)",
    feed_context: str = "",
    cross_read_prob: float = DEFAULT_CROSS_READ_PROB,
) -> ActContext:
    """Assemble every prompt block, degrading per-block exactly as Bash does.

    `context_now` and `feed_context` are passed IN rather than read here: they
    are files written by `swil.sh login` (contract 01 §2b, §2c), which stays
    Bash in Phase 1. The caller reads them; this function never touches the
    filesystem.

    `rng` is REQUIRED and injected (Phase B task 3): both feed reads are
    routed through the scope `choose_read_scope` rolls with it, and a default
    here would be a module-level source of randomness by another name. It is
    the same generator the rhythm gate draws from one step later, so one seed
    reproduces a whole round.

    This function still WRITES NOTHING. The read scope it chose is recorded
    on the returned `ActContext` (`board_read` / `cross_read` /
    `board_items`); the lab event that publishes it is emitted by
    `act.round.context_step`, which is where the round's `dry_run` flag lives
    and where a shadow round can be kept from filing rows.
    """
    board = choose_read_scope(resources, persona, rng, cross_read_prob=cross_read_prob)
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
        board_read=board.scope,
        home_board=board.home,
        cross_read=board.cross,
    )

    recommended: list[dict[str, Any]] = []
    try:
        recommended = read_feed(resources, board.scope, limit=40, sort="recommended")
        ctx.board_items = len(recommended)
        ctx.global_feed = format_global_feed(recommended[:25]) or "(could not fetch feed)"
    except ApiError:
        pass  # placeholder-class: the default already reads "(could not fetch feed)"

    # vanish-class: on ApiError, timeline_feed stays "", so the whole section disappears.
    with contextlib.suppress(ApiError):
        ctx.timeline_feed = format_timeline_feed(
            read_feed(resources, board.scope, limit=18, sort="latest")
        )

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
